import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import type { AgentState, GameAdapter } from '../src/adapter/types.ts';
import { DecisionFeedback } from '../src/brain/decision-feedback.ts';
import { learnCandidates } from '../src/brain/habits.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { simpleToMethod } from '../src/methods/learning.ts';
import type { Percept } from '../src/perception/perception.ts';
import type { Plan } from '../src/planner/plan.ts';
import { lightUserPrompt, type PlanContext } from '../src/planner/prompt.ts';
import { EventBus } from '../src/events.ts';
import { SKILLS } from '../src/skills/index.ts';
import { SkillLibrary } from '../src/skills/library.ts';

const state = (): AgentState => ({ connected: true, alive: true, observationReady: true, worldId: 'w', sessionId: 's', observationId: 1,
  username: 'player', pos: { x: 0, y: 64, z: 0 }, dim: 'overworld', hp: 20, food: 20, oxygen: 20, timeOfDay: 1000,
  isDay: true, biome: 'plains', onGround: true, inWater: false, inLava: false, inventory: [], emptySlots: 36, held: null });
const percept = (): Percept => ({ self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20, inWater: false, inLava: false },
  inventory: [], emptySlots: 36, nearby: { resources: [], passive: [], hostile: [], players: [] }, vision: null,
  time: { timeOfDay: 1000, phase: 'day' }, exploration: { visitedChunks: 1 }, learn_candidates: [] } as unknown as Percept);
const plan = (id: string): Plan => ({ id, source: 'llm', thought: '', goal: '放下木板', goalType: 'build',
  steps: [{ skill: 'use_item', args: { item: 'birch_planks', on: 'grass_block' } }], index: 1, createdAt: 0, retries: 0, abortIf: {} });

test('repeat feedback measures unchanged attempts and returns scoped evidence without declaring completion', () => {
  const feedback = new DecisionFeedback(), s = state(), v = percept();
  for (let i = 0; i < 3; i++) {
    const p = plan(`p${i}`); feedback.begin(p, s, v);
    const effect = feedback.end(p, 'succeeded', '动作已发送', s, v)!;
    assert.equal(effect.verified, false); assert.equal(effect.changed, false);
  }
  assert.equal(feedback.context(s).repeatedStepPattern?.consecutiveUnchangedAttempts, 3);
  const verified = plan('verified'); feedback.begin(verified, s, v);
  const placed = feedback.end(verified, 'succeeded', '已确认目标方块', s, v, { verified: true, changed: true, reasons: ['实际目标格已成为 birch_planks'] });
  assert.equal(placed?.verified, true);
  assert.equal(feedback.context(s).repeatedStepPattern?.consecutiveUnchangedAttempts, 0);
  const moved = plan('moved'); feedback.begin(moved, s, v);
  const end = { ...s, pos: { x: 2, y: 64, z: 0 }, inventory: [{ name: 'dirt', count: 1 }] };
  assert.equal(feedback.end(moved, 'succeeded', 'done', end, v)?.changed, true);
  assert.equal(feedback.context({ ...end, sessionId: 'new' }).repeatedStepPattern, null);
});

test('alternating attempts share an intent progress window while familiar views cannot manufacture discovery', (t) => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const feedback = new DecisionFeedback(), s = state();
  let v = percept(), serial = 0;
  v.nearby.resources = [{ block: 'stone', count: 1, nearest: 1, seen: 'now' }];
  v.vision = { view: 'known stone', visible_resources: [], remembered_resources: [] } as any;
  const next = (skill: string, intentId = 'same-intent') => ({ ...plan(`mixed-${serial++}`), binding: { intentId }, steps: [{ skill }], index: 1 });
  const attempt = (skill: string, after = v, intentId = 'same-intent') => {
    const p = next(skill, intentId); feedback.begin(p, s, v); now += 1000;
    feedback.end(p, 'succeeded', '步骤已返回', s, after); v = after;
  };
  for (const skill of ['goto', 'climb_up', 'look_around']) {
    const after = structuredClone(v); after.vision!.view = `${skill}: familiar stone from another angle`; attempt(skill, after);
  }
  assert.equal(feedback.context(s).repeatedStepPattern?.consecutiveAttempts, 1);
  assert.equal(feedback.context(s).intentProgress?.consecutiveNoProgressAttempts, 3, 'different step signatures must not hide the same stalled intent');
  const discovery = next('look_around'); feedback.begin(discovery, s, v); now += 1000;
  const novel = structuredClone(v); novel.nearby.resources.push({ block: 'coal_ore', count: 1, nearest: 2, seen: 'now' });
  feedback.context(s, novel); // Discovery can arrive from normal perception before the action ends.
  feedback.end(discovery, 'succeeded', '发现新线索', s, novel); v = novel;
  assert.equal(feedback.context(s).intentProgress?.consecutiveNoProgressAttempts, 0);
  const away = structuredClone(v); away.nearby.resources = away.nearby.resources.filter((r) => r.block !== 'coal_ore');
  attempt('look_around', away); attempt('goto', novel);
  assert.equal(feedback.context(s).intentProgress?.consecutiveNoProgressAttempts, 2, 'a familiar resource returning to view is not another discovery');
  for (const skill of ['dig', 'goto', 'climb_up', 'look_around', 'dig', 'goto']) attempt(skill);
  assert.equal(feedback.context(s).intentProgress?.consecutiveNoProgressAttempts, 8, 'the counter survives the six-entry display history');
  const move = next('goto'); feedback.begin(move, s, v); now += 1000;
  s.pos.x = 2; feedback.end(move, 'succeeded', '实际移动', s, v);
  assert.equal(feedback.context(s).intentProgress?.consecutiveNoProgressAttempts, 0);
  attempt('dig', v, 'another-intent');
  assert.equal(feedback.context(s).intentProgress?.consecutiveNoProgressAttempts, 1);
  now += 600001;
  assert.equal(feedback.context(s).intentProgress?.consecutiveNoProgressAttempts, 0);
  assert.equal(feedback.context({ ...s, sessionId: 'new-session' }).intentProgress, null);
});

test('light decisions retain the latest measured changes and repetition within a limited feedback budget', (t) => {
  const memory = new WorldMemory(null); t.after(() => memory.close());
  const feedback = new DecisionFeedback(), s = state(), v = percept();
  for (let i = 0; i < 3; i++) { const p = plan(`p${i}`); feedback.begin(p, s, v); feedback.end(p, 'succeeded', '旧成功文字'.repeat(500), s, v); }
  const ctx: PlanContext = { reason: 'no_goal', percept: v, current: null, lastFailure: null, userSuggestion: null,
    decisionFeedback: feedback.context(s) };
  const text = lightUserPrompt(ctx, memory);
  const body = JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));
  const result = body.decision_feedback;
  assert.equal(result.latestAttempt.planId, 'p2');
  assert.equal(result.repeatedStepPattern.consecutiveUnchangedAttempts, 3);
  assert.equal(result.effectEvidence.changed, false);
  assert.deepEqual(result.changes.inventoryDelta, []);
  assert.equal(result.meaning, 'measured_changes_only_not_goal_completion');
  assert.equal('recentAttempts' in result, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1800);
});

test('automatic habits require repeated verified effects and cannot fall back to an unverified macro', (t) => {
  const memory = new WorldMemory(null); t.after(() => memory.close());
  const steps = [{ skill: 'use_item', args: { item: 'birch_planks', on: 'grass_block' } }, { skill: 'use_item', args: { item: 'birch_planks', on: 'grass_block' } }];
  const record = { goal: '放木板', goalType: 'build', source: 'llm', status: 'succeeded', summary: '已发送',
    steps: ['use_item:birch_planks', 'use_item:birch_planks'], plan: steps };
  for (let i = 0; i < 3; i++) memory.recordGoal(record);
  memory.recordGoal({ ...record, effectEvidence: { verified: false, changed: false, reasons: ['未测到变化'] } });
  assert.deepEqual(learnCandidates(memory, new Set()), [], 'historical success text cannot establish actual effects');
  for (let i = 0; i < 2; i++) memory.recordGoal({ ...record, effectEvidence: { verified: true, changed: true, reasons: ['放置已核实'] } });
  assert.equal(learnCandidates(memory, new Set())[0]?.times, 2, 'real past effects remain usable without replaying the game');
  const adapter = { state, isKnownItem: () => true };
  const raw = { name: 'put_planks', description: '放下木板', steps };
  assert.equal(simpleToMethod(raw, adapter, memory).kind, 'macro', 'explicit combinations retain the existing option');
  assert.equal(simpleToMethod(raw, adapter, memory, { allowMacro: false }).kind, 'invalid', 'automatic habits need an observable postcondition');
});

test('suspended legacy habits retain their definition across loading and explicit proposals can reactivate them', (t) => {
  const memory = new WorldMemory(null); t.after(() => memory.close());
  const adapter = { state, isKnownItem: () => true } as unknown as GameAdapter;
  const library = new SkillLibrary(null, adapter, memory, new EventBus());
  const raw = { name: 'legacy_no_effect_planks', description: '习惯：反复右键但没有放下木板', steps: [
    { skill: 'use_item', args: { item: 'birch_planks', on: 'grass_block' } },
    { skill: 'use_item', args: { item: 'birch_planks', on: 'grass_block' } },
  ] };
  const name = `macro:${raw.name}`;
  t.after(() => { delete SKILLS[name]; });
  assert.equal(library.learn(raw).ok, true);
  const before = structuredClone(library.list()[0]);
  assert.ok(SKILLS[name]);
  assert.equal(library.suspend(name, '旧自动习惯没有可验收的放置成效'), true);
  assert.equal(library.suspend(name, '旧自动习惯没有可验收的放置成效'), false, 'repeated startup suspension is idempotent');
  assert.equal(SKILLS[name], undefined);
  const { disabled, ...retained } = library.list()[0];
  assert.deepEqual(retained, before, 'suspension retains the original steps, description and history');
  assert.equal(disabled?.reason, '旧自动习惯没有可验收的放置成效');
  assert.ok(disabled!.at >= before.createdAt);
  // Feed the saved JSON back through the real constructor without touching disk.
  const saved = JSON.stringify(library.list());
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs, 'readFileSync', (() => saved) as unknown as typeof fs.readFileSync);
  const loaded = new SkillLibrary('in-memory-library.json', adapter, memory, new EventBus());
  assert.deepEqual(loaded.list(), library.list());
  assert.equal(SKILLS[name], undefined, 'loading a disabled definition never registers an executable skill');
  assert.equal(library.learn({ ...raw, description: '用户明确重新提出的组合' }).ok, true);
  assert.equal(library.list()[0].disabled, undefined);
  assert.ok(SKILLS[name], 'explicit proposals can replace and reactivate the retained definition');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { ControlKnowledge, controlCatalog } from '../src/methods/controls.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { Planner } from '../src/planner/planner.ts';
import { buildLightMessages, buildMessages, type PlanContext } from '../src/planner/prompt.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('default controls describe general inputs; consulted workflows persist per world without granting effect evidence', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-controls-')), file = path.join(directory, 'controls.json');
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const before = Object.keys(SKILLS), controls = new ControlKnowledge(file);
  const basic = controlCatalog();
  for (const name of ['inspect_block', 'interact_block', 'hit_entity', 'goto']) assert.match(basic, new RegExp(`^- ${name} `, 'm'));
  for (const name of ['hunt', 'farm', 'boat', 'expedition', 'shelter', 'build']) assert.doesNotMatch(basic, new RegExp(`^- ${name} `, 'm'));
  controls.expose('world-a', ['boat', 'unstuck', 'invented_power']);
  assert.deepEqual(new ControlKnowledge(file).names('world-a'), ['boat']);
  assert.deepEqual(new ControlKnowledge(file).names('world-b'), []);
  assert.match(controlCatalog(controls.names('world-a')), /^- boat /m);
  assert.ok(SKILLS.hunt && SKILLS.build, 'display is not an execution ban');
  assert.deepEqual(Object.keys(SKILLS), before);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /verified|learned|success/);
});

test('real planner inquiry progressively exposes interfaces, while both decision tiers retain self-chosen research evidence', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), controls = new ControlKnowledge(null);
  t.after(() => memory.close()); memory.setWorld(adapter.worldId);
  const percept = new Perception(adapter, memory, bus, new Vision(adapter)).update();
  const researchContext = { source: 'method_trials', claims: 'model_hypotheses', questions: [{ question: '我还想弄清的现象', hypothesis: '待检验假设', outcomes: { unknown: 1 } }] };
  const ctx: PlanContext = { reason: 'no_goal', percept, current: null, lastFailure: null, userSuggestion: null, worldState: adapter.state(), researchContext };
  for (const messages of [buildMessages('player', ctx, memory), buildLightMessages('player', ctx, memory)]) {
    assert.match(messages[1].content, /research_context.*我还想弄清的现象/);
    assert.doesNotMatch(messages[0].content, /^- boat /m);
  }
  let calls = 0;
  const planner = new Planner({ ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 20, maxPromptTokens: 40000 } }, {
    name: 'interface-discovery-fixture', async complete(messages) {
      const call = calls++;
      if (call === 0) {
        assert.doesNotMatch(messages[0].content, /^- boat /m);
        return { latencyMs: 1, text: JSON.stringify({ kind: 'mechanics', query: 'boat' }) };
      }
      if (call === 1) assert.match(messages.at(-1)!.content, /"primitive":"boat"/);
      if (call === 2) assert.match(messages[0].content, /^- boat /m, 'the next independent request remembers the consulted interface');
      return { latencyMs: 1, text: JSON.stringify({ goal: '继续观察', steps: [{ skill: 'look_around', args: { seconds: 2 } }] }) };
    },
  }, adapter, memory, bus, null, null, undefined, controls);
  await planner.propose(ctx); await planner.propose(ctx);
  assert.equal(calls, 3);
  assert.deepEqual(adapter.actions, [], 'querying an operation must not execute it or force an exploration goal');
});

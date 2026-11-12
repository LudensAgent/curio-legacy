import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { EntityInfo } from '../src/adapter/types.ts';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Mind } from '../src/mind/mind.ts';
import { createActivity } from '../src/mind/activity.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import type { SkillResult } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 6; i++) await setImmediate(); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t: TestContext, skill: 'press_keys' | 'swim_path' | 'explore_toward') {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (c: Completion) => void; messages: ChatMessage[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'test-model', complete: (messages) => new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const self = new SelfModel(null, []);
  const mind = new Mind({ adapter, arbiter, perception, memory, bus, self, persona: '', thinker: new Thinker(planner, adapter, memory, bus, null), say() {} });
  const original = SKILLS[skill];
  SKILLS[skill] = { ...original, run: async (ctx) => new Promise<SkillResult>((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () => reject(new AbortedError('cancelled')), { once: true });
  }) };
  mind.start(1_000_000);
  t.after(() => { mind.stop(); arbiter.cancel('test end'); memory.close(); SKILLS[skill] = original; });
  return { adapter, arbiter, bus, mind, pending };
}

async function startWaterTask(t: TestContext, skill: 'press_keys' | 'swim_path') {
  const w = fixture(t, skill);
  const events: { type: string; msg: string }[] = [];
  w.bus.on('event', (e: { type: string; msg: string }) => events.push(e));
  w.adapter.inWater = true;
  const hostile: EntityInfo = { id: 7, name: 'drowned', kind: 'hostile', pos: { x: w.adapter.pos.x + 1, y: w.adapter.pos.y, z: w.adapter.pos.z }, dist: 1 };
  w.adapter.entities = [hostile];
  w.mind.tick();
  const started = w.arbiter.start({ skill, args: skill === 'press_keys' ? { keys: { jump: true }, ms: 10000 } : { mode: 'surface' } }, 'llm');
  if ('error' in started) assert.fail(started.error);
  await flush();
  return { ...w, events };
}

for (const skill of ['press_keys', 'swim_path'] as const) test(`hurt while in water does not cancel ${skill}`, async (t) => {
  const w = await startWaterTask(t, skill);
  w.bus.publish('hurt', 'P1', '受到伤害', { around: '身体碰着 water、drowned 在 1 格' });
  await sleep(850);
  assert.equal(w.arbiter.info()?.skill, skill, '人在水里时，挨打不能取消出水/换气动作');
  assert.ok(w.events.some((e) => e.type === 'notice' && /动作没停/.test(e.msg)), '仍应把挨打事实告诉心智');
});

test('hurt on dry land still stops unrelated work', async (t) => {
  const w = await startWaterTask(t, 'press_keys');
  w.adapter.inWater = false;
  w.bus.publish('hurt', 'P1', '受到伤害', { around: 'drowned 在 1 格' });
  await sleep(850);
  assert.notEqual(w.arbiter.info()?.skill, 'press_keys', '陆地上挨打仍应停下手上的事');
  assert.ok(w.events.some((e) => e.type === 'notice' && /手上的事先停了/.test(e.msg)));
});

async function startDryTask(t: TestContext) {
  const w = fixture(t, 'press_keys');
  const events: { type: string; msg: string }[] = [];
  w.bus.on('event', (e: { type: string; msg: string }) => events.push(e));
  w.adapter.inWater = false;
  w.adapter.entities = [];
  w.mind.tick();
  const started = w.arbiter.start({ skill: 'press_keys', args: { keys: { forward: true }, ms: 10000 } }, 'llm');
  if ('error' in started) assert.fail(started.error);
  await flush();
  return { ...w, events };
}

async function startDryExplore(t: TestContext) {
  const w = fixture(t, 'explore_toward');
  const events: { type: string; msg: string }[] = [];
  w.bus.on('event', (e: { type: string; msg: string }) => events.push(e));
  w.adapter.inWater = false;
  const hostile: EntityInfo = { id: 7, name: 'piglin', kind: 'hostile', pos: { x: w.adapter.pos.x + 1, y: w.adapter.pos.y, z: w.adapter.pos.z }, dist: 1 };
  w.adapter.entities = [hostile];
  w.mind.tick();
  const activity = createActivity({
    what: '沿东探索', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'explore_toward', args: { direction: 'E', distance: 96, origin: { ...w.adapter.pos } } }],
  }, '', 'llm', w.adapter.state());
  // 模拟生产里 beginStep 之后的 index：步骤正在执行时 index 指向下一步，挂起要退回它。
  activity.index = 1;
  w.mind.activity = activity;
  const started = w.arbiter.start(
    { skill: 'explore_toward', args: activity.steps[0]!.args },
    'llm', { planId: activity.id, stepId: activity.steps[0]!.id },
  );
  if ('error' in started) assert.fail(started.error);
  await flush();
  return { ...w, events, activity, task: started };
}

test('长程探索挨打时挂起会话而不是丢弃', async (t) => {
  const w = await startDryExplore(t);
  w.bus.publish('hurt', 'P1', '受到伤害', { around: 'piglin 在 1 格' });
  await sleep(850);
  assert.equal(w.arbiter.info(), null, '任务已挂起');
  assert.equal(w.mind.activity?.movementPause?.taskId, w.task.id, '保留续接凭据');
  assert.equal(w.mind.activity?.movementPause?.stepId, w.activity.steps[0]!.id, '凭据指向正在执行的步骤');
  assert.equal(w.mind.activity?.index, 0, '步骤回退到未完成的那一步');
  assert.ok(w.events.some((e) => e.type === 'notice' && /长程移动已挂起（可续接）/.test(e.msg)));
});

test('长程探索被火烧到时也挂起会话，而不是把方向推进整段丢掉', async (t) => {
  const w = await startDryExplore(t);
  w.adapter.entities = [];
  w.bus.publish('hurt', 'P1', '受到伤害', { around: '伤害类型 in_fire（站在火里）' });
  await sleep(850);
  assert.equal(w.arbiter.info(), null, '任务已挂起');
  assert.equal(w.mind.activity?.movementPause?.taskId, w.task.id, '保留续接凭据');
  assert.ok(w.events.some((e) => e.type === 'notice' && /长程移动已挂起（可续接）/.test(e.msg)));
});

test('没有怪但身上着火掉血：停下手上的移动，把伤害事实交回心智（不替它脱险）', async (t) => {
  const w = await startDryTask(t);
  w.bus.publish('hurt', 'P1', '受到伤害', { around: '身体碰着 soul_sand、身上着火' });
  await sleep(850);
  assert.notEqual(w.arbiter.info()?.skill, 'press_keys', '环境掉血也要停下手上的事');
  assert.ok(w.events.some((e) => e.type === 'notice' && /掉血.*身上着火.*手上的事先停了/.test(e.msg)));
});

test('没有怪、也没有伤害原因的挨打（来源不明）不打断', async (t) => {
  const w = await startDryTask(t);
  w.bus.publish('hurt', 'P1', '受到伤害');
  await sleep(850);
  assert.equal(w.arbiter.info()?.skill, 'press_keys');
});

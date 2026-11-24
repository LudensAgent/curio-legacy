import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { createActivity } from '../src/mind/activity.ts';
import type { Leg } from '../src/mind/excursions.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const setup = (kind: 'gather' | 'explore' | 'craft' = 'gather') => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  adapter.blocks.push({ name: 'oak_log', pos: { x: 3, y: 64, z: 0 } });
  memory.setWorld(adapter.worldId);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const plan = self.setPlan('备木头再进下界', ['备好木头', '进下界找要塞'])!;
  self.record({ id: 'r1', what: '砍橡木', kind: 'gather', outcome: 'done', summary: '带回 2 根', durationSec: 60,
    gained: { oak_log: 2 }, lost: { torch: 2, cooked_beef: 1 }, at: Date.now() - 60_000, signature: 'gather', failures: 0 });
  const activity = createActivity({ what: '砍橡木', why: '备木头', kind, repeat: 1, steps: [{ skill: 'gather', args: { block: 'oak_log', count: 8 } }] }, '', 'llm', adapter.state());
  const supplies = { foodItems: {}, foodPoints: 20, pickaxes: 1, pickaxeDurability: 100, armor: 0, armorMax: 0, blocks: 0, torches: 0, emptySlots: 20, hp: 20, hunger: 20 };
  const leg: Leg = { id: 'leg1', worldId: adapter.worldId, dim: adapter.dim, startedAt: Date.now() - 5 * 60_000, lastSampleAt: Date.now(),
    onlineMs: 5 * 60_000, unobservedMs: 0, entry: { kind: 'resume', pos: { x: 0, y: 64, z: 0 } },
    farthest: { x: 40, y: 64, z: 0, dist: 40 }, frontier: [], last: { x: 40, y: 64, z: 0 }, start: supplies, latest: supplies, hungerDrop: 0, eaten: {}, end: undefined };
  return { adapter, memory, perception, self, plan, activity, leg };
};

const messages = (s: ReturnType<typeof setup>, excursions = true) => {
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept: s.perception.update(), state: s.adapter.state(),
    self: s.self, memory: s.memory, plan: s.plan, activity: s.activity, suspended: [], lastRecord: null, noticed: [], changes: [],
    userSuggestion: null, notes: [], mySkills: [], persona: 'P', excursions: excursions ? [s.leg] : [] });
  return user.content;
};

test('采集/探索出门：给这趟在线时间、消耗和清单后面的需求，数量由 Agent 定', (t) => {
  const s = setup();
  t.after(() => s.memory.close());
  const user = messages(s);
  assert.match(user, /这次出门的账/);
  assert.match(user, /这趟已在线 5 分钟/);
  assert.match(user, /离入口最远 40 格/);
  assert.match(user, /最近消耗的消耗品/);
  assert.match(user, /清单还没做的/);
  assert.match(user, /寻找这块地方的成本已经付过/);
  assert.match(user, /眼前看得见|记得附近有/);
  assert.match(user, /资源用来支持后面的行动/);
  assert.match(user, /gather\.count 与 plan\.needs/);
  assert.match(user, /并排的事实/);
  assert.match(user, /oak_log×\d+/);
});

test('非采集/探索或没有出行时不出这次出门的账', (t) => {
  const s = setup('craft');
  t.after(() => s.memory.close());
  assert.doesNotMatch(messages(s), /这次出门的账/);
  const home = setup();
  t.after(() => home.memory.close());
  assert.doesNotMatch(messages(home, false), /这次出门的账/);
});

test('explore 也会给出门账；只靠离家>24格也会触发', (t) => {
  const s = setup('explore');
  t.after(() => s.memory.close());
  s.memory.setBase(s.adapter.dim, { x: 40, y: 64, z: 0 }, '测试基地');
  const user = messages(s, false);
  assert.match(user, /这次出门的账/);
  assert.match(user, /家「测试基地」在/);
});

test('短出行且离家近：不出出门账', (t) => {
  const s = setup();
  t.after(() => s.memory.close());
  s.memory.setBase(s.adapter.dim, { x: 10, y: 64, z: 0 }, '近处基地');
  s.leg.onlineMs = 60_000;
  assert.doesNotMatch(messages(s), /这次出门的账/);
});

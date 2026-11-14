import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('上一段采集有掉落物没进背包：下一次思考给出丢失事实与 remembered 找回入口', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const plan = self.setPlan('备好木头再进下界', ['备好木头', '进下界找要塞'])!;
  const collection = { block: 'oak_log', items: ['oak_log'], initial: 0, target: 8, final: 2, gained: 2, dug: 3,
    targetMet: false, lost: 1, skill: 'gather', at: Date.now() };
  const lastRecord = { id: 'r1', what: '砍橡木', kind: 'gather', outcome: 'stuck', summary: '砍了 3 块，2 块进背包，1 块没捡到',
    durationSec: 20, gained: { oak_log: 2 }, lost: {}, at: Date.now(), signature: 'gather', failures: 1, collection };
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '上一段活结束了', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: lastRecord as never, noticed: [], changes: [],
    userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.match(user.content, /掉落物没进背包/);
  assert.match(user.content, /pickup_items/);
  assert.match(user.content, /remembered/);
  assert.match(user.content, /别把挖掉当成拿到/);
  assert.match(user.content, /未达成/);
});

test('回执只有摘要里的丢失提示、没有 collection 时也能提醒', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const plan = self.setPlan('备好木头再进下界', ['备好木头'])!;
  const lastRecord = { id: 'r3', what: '砍橡木', kind: 'gather', outcome: 'stuck', summary: '挖了 1 块，1 块掉落物没捡到',
    durationSec: 20, gained: {}, lost: {}, at: Date.now(), signature: 'gather', failures: 1 };
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '上一段活结束了', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: lastRecord as never, noticed: [], changes: [],
    userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.match(user.content, /掉落物没捡到/);
  assert.match(user.content, /remembered/);
});

test('没有 lost 时不出现掉落恢复提醒', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const plan = self.setPlan('备好木头再进下界', ['备好木头'])!;
  const collection = { block: 'oak_log', items: ['oak_log'], initial: 0, target: 2, final: 2, gained: 2, dug: 2,
    targetMet: true, skill: 'gather', at: Date.now() };
  const lastRecord = { id: 'r2', what: '砍橡木', kind: 'gather', outcome: 'done', summary: '拿到 2 块',
    durationSec: 10, gained: { oak_log: 2 }, lost: {}, at: Date.now(), signature: 'gather', failures: 0, collection };
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '上一段活结束了', percept: perception.update(), state: adapter.state(),
    self, memory, plan, activity: null, suspended: [], lastRecord: lastRecord as never, noticed: [], changes: [],
    userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  assert.doesNotMatch(user.content, /掉落物没进背包/);
});

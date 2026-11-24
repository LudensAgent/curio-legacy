import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { ok } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('ok() 把 caveat 作为结果里独立的事实，不进摘要', () => {
  const r = ok('挖掉了 cobblestone', { cell: [0, -1, 0] }, '这格是人造建材，可能是村庄房子的一部分');
  assert.equal(r.status, 'succeeded');
  assert.equal(r.summary, '挖掉了 cobblestone');
  assert.equal(r.caveat, '这格是人造建材，可能是村庄房子的一部分');
  assert.equal(ok('挖掉了 cobblestone').caveat, undefined);
});

test('recent_action_caveats 进入决策提示词的【此刻】，不被摘要截断', (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  t.after(() => memory.close());
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const self = new SelfModel(null);
  const caveat = '这格是人造建材，可能是村庄或别人房子的一部分（不是自然地形，也不是你的矿道）；拆了可能破坏建筑';
  const [, user] = buildMindMessages({
    tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(),
    self, memory, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: 'P',
    recentActionCaveats: [{ skill: 'dig_at', args: { at: [0, -1, 0] }, caveat, position: adapter.state().pos, observed_at: new Date(now).toISOString() }],
  });
  assert.match(user.content, /recent_action_caveats/);
  assert.match(user.content, /人造建材/);
  assert.doesNotMatch(user.content, /拆不拆你自己定/);
  // 完整 caveat 以独立字段出现，不受 80/160 摘要截断影响
  assert.match(user.content, /拆了可能破坏建筑/);
});

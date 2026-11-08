import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { travelStore } from '../src/travel/store.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('记忆中的门只报当前事实与记录年龄，不断言门框还在', (t) => {
  const base = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const endpoint = travelStore(memory).observe(adapter.state(), { x: 3, y: 64, z: 0 }, 'nether_portal');
  t.mock.timers.tick(7 * 86_400_000);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const [system, user] = buildMindMessages({
    tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(), self: new SelfModel(null), memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [],
    persona: 'P', skills: [], blockAt: (p) => adapter.blockAt(p),
  });
  assert.doesNotMatch(system.content, /黑曜石框多半还在/);
  const known = JSON.parse(user.content.match(/【记得的地方】(.*)/)![1]);
  const portal = known.portals.find((p: { id: string }) => p.id === endpoint.id);
  assert.ok(portal, JSON.stringify(known.portals));
  assert.equal(portal.now, '现为 air');
  assert.equal(portal.portal_observed, '亲见门');
  assert.match(portal.recorded_ago, /7 天前/);
  assert.doesNotMatch(JSON.stringify(known.portals), /黑曜石框|门未点亮/);
  memory.close();
});

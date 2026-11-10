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

function knownPlaces(adapter: FakeAdapter, memory: WorldMemory) {
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  const [system, user] = buildMindMessages({
    tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(), self: new SelfModel(null), memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [],
    persona: 'P', skills: [], blockAt: (p) => adapter.blockAt(p),
  });
  return { system, known: JSON.parse(user.content.match(/【记得的地方】(.*)/)![1]) };
}

test('记忆中的门只报当前事实与记录年龄，不断言门框还在', (t) => {
  const base = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const endpoint = travelStore(memory).observe(adapter.state(), { x: 3, y: 64, z: 0 }, 'nether_portal');
  t.mock.timers.tick(7 * 86_400_000);
  const { system, known } = knownPlaces(adapter, memory);
  assert.doesNotMatch(system.content, /黑曜石框多半还在/);
  const portal = known.portals.find((p: { id: string }) => p.id === endpoint.id);
  assert.ok(portal, JSON.stringify(known.portals));
  assert.match(portal.now, /^记录格现为 air（区块数据，非视野所见）$/);
  assert.equal(portal.portal_observed, '亲见门');
  assert.match(portal.recorded_ago, /7 天前/);
  assert.equal(portal.from_here, '东 3格');
  assert.doesNotMatch(JSON.stringify(known.portals), /黑曜石框|门未点亮/);
  memory.close();
});

test('门列表只核对当前维度，按距离取最近的门并给出方位与高差', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const store = travelStore(memory);
  // 另一维度的同坐标门：不能拿当前维度的方块去核对它
  const nether = store.observe({ ...adapter.state(), dim: 'the_nether' }, { x: 0, y: 64, z: 5 }, 'nether_portal');
  const ids = [200, 150, 120, 100, 80].map((z) => store.observe(adapter.state(), { x: 0, y: 64 + (z === 80 ? 42 : 0), z }, 'nether_portal').id);
  adapter.blocks = [{ name: 'nether_portal', pos: { x: 0, y: 106, z: 80 } }];
  const { known } = knownPlaces(adapter, memory);
  const listed = known.portals as { id: string; from_here: string; now: string }[];
  assert.deepEqual(listed.map((p) => p.id), [ids[4], ids[3], ids[2], ids[1]]);
  assert.ok(!listed.some((p) => p.id === nether.id));
  assert.equal(listed[0]!.from_here, '南 80格，高 42 格');
  assert.equal(listed[0]!.now, '记录格仍是 nether_portal（区块数据）');
  memory.close();
});

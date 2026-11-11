import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentState } from '../src/adapter/types.ts';
import { describeLeg, ExcursionLog } from '../src/mind/excursions.ts';

const body = (over: Partial<AgentState> = {}): AgentState => ({
  connected: true, alive: true, observationReady: true, worldId: 'w1', sessionId: 's1', observationId: 1, username: 'u',
  pos: { x: 0.5, y: 70, z: 0.5 }, dim: 'the_nether', hp: 20, food: 20, oxygen: 20, timeOfDay: 0, isDay: true, biome: null,
  onGround: true, inWater: false, inLava: false, emptySlots: 10, held: null,
  inventory: [{ name: 'bread', count: 6 }, { name: 'iron_pickaxe', count: 1, durability: { left: 250, max: 250 } }, { name: 'netherrack', count: 32 }],
  ...over,
});

test('excursion log splits on dimension change and death, and measures farthest point and food eaten', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-excursions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'excursions.json');
  const log = new ExcursionLog(file);
  let now = 1_000_000;
  log.sample(body({ dim: 'overworld' }), now);
  now += 2000; log.sample(body(), now); // 穿门：主世界那段结束，下界另起一段
  assert.equal(log.legs()[0].end?.kind, 'dimension');
  assert.equal(log.legs()[1].entry.kind, 'dimension');
  for (let x = 1; x <= 20; x++) { now += 2000; log.sample(body({ pos: { x: x * 5 + 0.5, y: 70, z: 0.5 }, food: 20 - Math.floor(x / 4) }), now); }
  // 吃一个面包：物品减少与饥饿值上升差一拍也算吃掉
  now += 2000; log.sample(body({ pos: { x: 100.5, y: 70, z: 0.5 }, food: 15, inventory: [{ name: 'bread', count: 5 }] }), now);
  now += 2000; log.sample(body({ pos: { x: 100.5, y: 70, z: 0.5 }, food: 20, inventory: [{ name: 'bread', count: 5 }] }), now);
  assert.ok(log.frontierAdvancedSince('w1', 1_002_000));
  log.died('Deepseek tried to swim in lava', now + 500);
  const leg = log.legs()[1];
  assert.equal(leg.end?.kind, 'death');
  assert.equal(leg.farthest.x, 100);
  assert.equal(leg.farthest.dist, 100);
  assert.deepEqual(leg.eaten, { bread: 1 });
  assert.equal(leg.hungerDrop, 5);
  now += 5000; log.sample(body({ dim: 'overworld', pos: { x: 0.5, y: 64, z: 0.5 } }), now);
  assert.equal(log.legs()[2].entry.kind, 'respawn');
  const text = describeLeg(leg, { now, here: { x: 0.5, y: 70, z: 0.5 } });
  assert.match(text, /死亡结束（Deepseek tried to swim in lava）/);
  assert.match(text, /离入口最远处 \(100,70,0\)，离入口 100 格，在你 E 100 格/);
  assert.match(text, /吃掉 bread×1（\+5）/);
  log.save(true);
  assert.equal(new ExcursionLog(file).legs().length, 3);
});

test('unobserved gaps are not counted as online time and a dimension change during a gap is marked unknown', () => {
  const log = new ExcursionLog(null);
  let now = 0;
  log.sample(body(), now += 1000);
  log.sample(body(), now += 2000);
  log.sample(body(), now += 120_000); // 暂停/断线两分钟，同维度：续接，记为未观测
  assert.equal(log.legs().length, 1);
  assert.equal(log.legs()[0].onlineMs, 2000);
  assert.equal(log.legs()[0].unobservedMs, 120_000);
  log.sample(body({ dim: 'overworld' }), now += 60_000);
  assert.equal(log.legs()[0].end?.kind, 'unobserved');
  assert.match(describeLeg(log.legs()[0], { now }), /其间情况未知/);
});

test('prompt lists trips in this dimension and trips beyond a nearby portal, only when deliberating', async () => {
  const { EventBus } = await import('../src/events.ts');
  const { WorldMemory } = await import('../src/memory/store.ts');
  const { buildMindMessages } = await import('../src/mind/prompt.ts');
  const { SelfModel } = await import('../src/mind/self.ts');
  const { Perception } = await import('../src/perception/perception.ts');
  const { Vision } = await import('../src/perception/vision.ts');
  const { travelStore } = await import('../src/travel/store.ts');
  const { FakeAdapter } = await import('./fake-adapter.ts');
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  const here = adapter.state();
  memory.setWorld(here.worldId);
  const store = travelStore(memory);
  const nether = { ...here, dim: 'the_nether', sessionId: 'n1', observationId: here.observationId + 1 };
  const gate = store.observe(here, { x: 3, y: here.pos.y, z: 0 }, 'nether_portal');
  const far = store.observe(nether, { x: 0, y: 70, z: 0 }, 'nether_portal');
  store.record(gate.id, far.id, here, nether);

  const log = new ExcursionLog(null);
  let now = Date.now() - 30 * 60_000;
  log.sample(body({ worldId: here.worldId, pos: { x: 0.5, y: 70, z: 0.5 } }), now);
  for (let x = 1; x <= 40; x++) log.sample(body({ worldId: here.worldId, pos: { x: 0.5, y: 70, z: -x * 4 + 0.5 } }), now += 2000);
  log.died('Deepseek went up in flames', now);
  log.sample(body({ worldId: here.worldId, dim: here.dim, pos: here.pos }), now += 2000);

  const known = (tier: 'deliberate' | 'glance') => {
    const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
    const [, user] = buildMindMessages({
      tier, reason: '测试', percept: perception.update(), state: adapter.state(), self: new SelfModel(null), memory,
      activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [],
      persona: 'P', skills: [], blockAt: (p) => adapter.blockAt(p), ...(tier === 'deliberate' ? { excursions: log.legs() } : {}),
    });
    return JSON.parse(user.content.match(/【记得的地方】(.*)/)![1]);
  };
  const deliberate = known('deliberate');
  assert.equal(deliberate.my_trips_beyond_nearby_portal.length, 1);
  assert.match(deliberate.my_trips_beyond_nearby_portal[0], /^下界/);
  assert.match(deliberate.my_trips_beyond_nearby_portal[0], new RegExp(`落在门 ${far.id} 旁`));
  assert.match(deliberate.my_trips_beyond_nearby_portal[0], /离入口最远处 \(0,70,-160\)，离入口 160 格；/);
  assert.ok(deliberate.trips_note);
  assert.equal(known('glance').my_trips_beyond_nearby_portal, undefined);
  memory.close();
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentState } from '../src/adapter/types.ts';
import { describeCoverage, describeCurrentTrip, describeLeg, ExcursionLog, exploreAttemptFromReceipt, type Leg } from '../src/mind/excursions.ts';

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
  // 当前这一趟也走出一段并结束一次探索，验证 glance 能看到覆盖账本身，而不只是字段存在。
  log.sample(body({ worldId: here.worldId, dim: here.dim, pos: { x: here.pos.x + 10, y: here.pos.y, z: here.pos.z } }), now += 2000);
  log.noteExplore({ at: now, dim: here.dim, direction: 'E', requested: 32,
    start: here.pos, end: { x: here.pos.x + 10, y: here.pos.y, z: here.pos.z }, status: 'failed', stop: 'BLOCKED' });

  const known = (tier: 'deliberate' | 'glance') => {
    const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
    const [, user] = buildMindMessages({
      tier, reason: '测试', percept: perception.update(), state: adapter.state(), self: new SelfModel(null), memory,
      activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [],
      persona: 'P', skills: [], blockAt: (p) => adapter.blockAt(p), excursions: log.legs(),
    });
    return JSON.parse(user.content.match(/【记得的地方】(.*)/)![1]);
  };
  const deliberate = known('deliberate');
  assert.equal(deliberate.my_trips_beyond_nearby_portal.length, 1);
  assert.match(deliberate.my_trips_beyond_nearby_portal[0], /^下界/);
  assert.match(deliberate.my_trips_beyond_nearby_portal[0], new RegExp(`落在门 ${far.id} 旁`));
  assert.match(deliberate.my_trips_beyond_nearby_portal[0], /离入口最远处 \(0,70,-160\)，离入口 160 格；/);
  assert.ok(deliberate.trips_note);
  const glance = known('glance');
  assert.equal(glance.my_trips_beyond_nearby_portal, undefined, 'glance 不展开历史出行');
  assert.equal(glance.my_trips_in_this_dimension, undefined, 'glance 不展开本维度历史出行');
  assert.ok(glance.current_trip, 'glance 能看到当前这一趟的覆盖账');
  assert.match(glance.current_trip.by_direction[0]!, /^E 10 格/);
  assert.match(glance.current_trip.recent_explores[0]!, /^E 请求 32 格，实测推进 10 格，还差 22 格，停（BLOCKED）/);
  assert.equal(glance.current_trip.empty_slots, '10→10');
  assert.ok(glance.current_trip_note);
  memory.close();
});

test('最远到访点：认真想时列在【记得的地方】，站在起点附近时再贴到【此刻要留意】', async () => {
  const { EventBus } = await import('../src/events.ts');
  const { WorldMemory } = await import('../src/memory/store.ts');
  const { buildMindMessages } = await import('../src/mind/prompt.ts');
  const { SelfModel } = await import('../src/mind/self.ts');
  const { Perception } = await import('../src/perception/perception.ts');
  const { Vision } = await import('../src/perception/vision.ts');
  const { FakeAdapter } = await import('./fake-adapter.ts');
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const s = adapter.state();
  const reach = { dim: s.dim, origin: { x: 0, y: 64, z: 0 }, at: Date.now(), truncated: false,
    sectors: { E: { pos: { x: 236, y: 56, z: -10 }, distance: 236 }, N: { pos: { x: 0, y: 64, z: -20 }, distance: 20 } } };
  const user = (tier: 'deliberate' | 'glance', pos = s.pos) => {
    adapter.pos = pos;
    const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
    return buildMindMessages({
      tier, reason: '测试', percept: perception.update(), state: adapter.state(), self: new SelfModel(null), memory,
      activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [],
      persona: 'P', skills: [], ...(tier === 'deliberate' ? { reach } : {}),
    })[1].content;
  };
  const near = user('deliberate', { x: 0.5, y: 64, z: 0.5 });
  const known = JSON.parse(near.match(/【记得的地方】(.*)/)![1]);
  assert.equal(known.walked_farthest.by_direction.length, 1, '20 格的不列');
  assert.match(known.walked_farthest.by_direction[0], /^E 236 格 \(236,56,-10\)/);
  assert.match(near.split('【此刻要留意】')[1] ?? '', /身体站过的最远处.*E 236 格/);
  const away = user('deliberate', { x: 100.5, y: 64, z: 0.5 });
  assert.doesNotMatch(away.split('【此刻要留意】')[1] ?? '', /身体站过的最远处/, '离起点远了不再贴到末尾');
  assert.doesNotMatch(user('glance'), /walked_farthest/);
  memory.close();
});

test('方向覆盖与最近探索：按方向记最远点，并记下请求距离、实测推进、剩余与阻碍格', () => {
  const log = new ExcursionLog(null);
  let now = 1_000_000;
  log.sample(body({ pos: { x: 0.5, y: 70, z: 0.5 } }), now);
  for (let x = 1; x <= 20; x++) log.sample(body({ pos: { x: x * 4 + 0.5, y: 70, z: 0.5 } }), now += 2000);
  for (let z = 1; z <= 10; z++) log.sample(body({ pos: { x: 0.5, y: 70, z: -z * 4 + 0.5 } }), now += 2000);
  const leg = log.current('w1')!;
  assert.equal(leg.farthestByDirection?.E?.dist, 80);
  assert.equal(leg.farthestByDirection?.N?.dist, 40);
  log.noteExplore({
    at: now, dim: 'the_nether', direction: 'E', requested: 96,
    start: { x: 0.5, y: 70, z: 0.5 }, end: { x: 80.5, y: 70, z: 0.5 },
    status: 'failed', stop: 'BLOCKED：collision with netherrack', obstacle: { x: 81, y: 70, z: 0 },
  });
  // 斜向推进按单位向量投影；未知方向不记成 0 格。
  log.noteExplore({ at: now, dim: 'the_nether', direction: 'NE', requested: 100,
    start: { x: 0.5, y: 70, z: 0.5 }, end: { x: 30.5, y: 70, z: -29.5 }, status: 'succeeded' });
  assert.equal(leg.explores?.length, 2);
  assert.ok(Math.abs((leg.explores![1]!.advanced) - 42.4) < 0.2, '斜向推进是投影距离');
  const before = leg.explores!.length;
  log.noteExplore({ at: now, dim: 'the_nether', direction: 'UP', requested: 10,
    start: { x: 0.5, y: 70, z: 0.5 }, end: { x: 0.5, y: 80, z: 0.5 }, status: 'failed' });
  assert.equal(leg.explores?.length, before, '未知方向不记');
  log.noteExplore({ at: now, dim: 'overworld', direction: 'E', requested: 96,
    start: { x: 0.5, y: 70, z: 0.5 }, end: { x: 80.5, y: 70, z: 0.5 }, status: 'failed' });
  assert.equal(leg.explores?.length, before, '别的维度不记到当前这段');
  const coverage = describeCoverage(leg);
  assert.match(coverage.by_direction.join(' '), /E 80 格 \(80,70,0\)/);
  assert.match(coverage.by_direction.join(' '), /N 40 格 \(0,70,-40\)/);
  assert.match(coverage.recent_explores[0]!, /^E 请求 96 格，实测推进 80 格，还差 16 格，停（BLOCKED/);
  assert.match(coverage.recent_explores[1]!, /^NE 请求 100 格，实测推进 42.4 格，还差 57.6 格，提前停/);
  const trip = describeCurrentTrip(leg);
  assert.equal(trip.dim, '下界');
  assert.equal(trip.online_min, 1, '按实际在线时长四舍五入，不强行抬到 1 分钟');
  assert.equal(trip.empty_slots, '10→10');
});

test('成功不等于到达：提前停与走完请求距离用实测剩余区分', () => {
  const log = new ExcursionLog(null);
  const now = 2_000_000;
  log.sample(body({ pos: { x: 0.5, y: 70, z: 0.5 } }), now);
  log.noteExplore({ at: now, dim: 'the_nether', direction: 'E', requested: 96,
    start: { x: 0.5, y: 70, z: 0.5 }, end: { x: 40.5, y: 70, z: 0.5 }, status: 'succeeded', stop: 'UNTIL_SEEN' });
  log.noteExplore({ at: now, dim: 'the_nether', direction: 'S', requested: 48,
    start: { x: 40.5, y: 70, z: 0.5 }, end: { x: 40.5, y: 70, z: 48.5 }, status: 'succeeded' });
  const [early, full] = describeCoverage(log.current('w1')!).recent_explores;
  assert.match(early!, /提前停（UNTIL_SEEN）/);
  assert.doesNotMatch(early!, /到达/);
  assert.match(full!, /走完请求距离/);
});

test('探索回执解析：生产形状的 blocker.obstacle、无 find 远征、缺失回执', () => {
  const blocked = exploreAttemptFromReceipt({
    status: 'failed', failureCode: 'PATH_NOT_FOUND', at: 1, dim: 'the_nether',
    args: { origin: { x: 0.5, y: 70, z: 0.5 } },
    fallbackEnd: { x: 1, y: 2, z: 3 },
    data: { requestedDirection: 'E', requestedDistance: 96, position: { x: 40.5, y: 70, z: 0.5 },
      stop: { reason: 'BLOCKED', blocker: { cell: { x: 41, y: 70, z: 0 }, obstacle: { x: 40, y: 70, z: 0 }, reason: 'collision with netherrack' } } },
  });
  assert.ok(blocked);
  assert.deepEqual(blocked.obstacle, { x: 40, y: 70, z: 0 });
  assert.equal(blocked.stop, 'BLOCKED：collision with netherrack');
  assert.deepEqual(blocked.end, { x: 40.5, y: 70, z: 0.5 });
  const expedition = exploreAttemptFromReceipt({
    status: 'failed', failureCode: 'PATH_NOT_FOUND', at: 2, dim: 'the_nether',
    args: { direction: 'NE', distance: 200 }, fallbackEnd: { x: 0, y: 0, z: 0 },
    data: { coverage: { start: { x: 0, y: 70, z: 0 }, end: { x: 100, y: 70, z: -100 } }, stopReason: 'BLOCKED' },
  });
  assert.ok(expedition);
  assert.equal(expedition.direction, 'NE');
  assert.equal(expedition.requested, 200);
  assert.deepEqual(expedition.start, { x: 0, y: 70, z: 0 });
  assert.deepEqual(expedition.end, { x: 100, y: 70, z: -100 });
  assert.equal(expedition.stop, 'BLOCKED');
  assert.equal(exploreAttemptFromReceipt({ status: 'cancelled', at: 3, dim: 'the_nether',
    args: {}, data: {}, fallbackEnd: { x: 0, y: 0, z: 0 } }), null);
});

test('挂起与取消都记下来，挂起标成可续接而不是取消', () => {
  const log = new ExcursionLog(null);
  const now = 3_000_000;
  log.sample(body({ pos: { x: 0.5, y: 70, z: 0.5 } }), now);
  log.noteExplore({ at: now, dim: 'the_nether', direction: 'W', requested: 64,
    start: { x: 0.5, y: 70, z: 0.5 }, end: { x: -20.5, y: 70, z: 0.5 }, status: 'suspended' });
  log.noteExplore({ at: now, dim: 'the_nether', direction: 'W', requested: 64,
    start: { x: -20.5, y: 70, z: 0.5 }, end: { x: -30.5, y: 70, z: 0.5 }, status: 'cancelled' });
  const [suspended, cancelled] = describeCoverage(log.current('w1')!).recent_explores;
  assert.match(suspended!, /挂起（可续接）/);
  assert.match(cancelled!, /取消/);
});

test('旧存档没有新增字段：方向覆盖为空，不渲染 undefined', () => {
  const leg = {
    id: 'old', worldId: 'w1', dim: 'the_nether', startedAt: 0, lastSampleAt: 0, onlineMs: 5000, unobservedMs: 0,
    entry: { kind: 'resume', pos: { x: 0, y: 70, z: 0 } }, farthest: { x: 10, y: 70, z: 0, dist: 10 }, frontier: [], last: { x: 10, y: 70, z: 0 },
    start: { foodItems: {}, foodPoints: 0, pickaxes: 0, pickaxeDurability: 0, armor: 0, armorMax: 0, blocks: 0, torches: 0, hp: 20, hunger: 20 },
    latest: { foodItems: {}, foodPoints: 0, pickaxes: 0, pickaxeDurability: 0, armor: 0, armorMax: 0, blocks: 0, torches: 0, hp: 20, hunger: 20 },
    hungerDrop: 0, eaten: {},
  } as Leg;
  const coverage = describeCoverage(leg);
  assert.deepEqual(coverage, { by_direction: [], recent_explores: [] });
  const text = describeLeg(leg);
  assert.match(text, /空槽 未知→未知/);
  assert.doesNotMatch(text, /undefined/);
  const trip = describeCurrentTrip(leg);
  assert.equal(trip.online_min, 0, '只观测 5 秒就不报 1 分钟');
  assert.equal(trip.empty_slots, '未知→未知', '旧存档不补 0');
  assert.doesNotMatch(JSON.stringify(trip), /undefined/);
});

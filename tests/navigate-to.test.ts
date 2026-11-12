import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { navigateTo } from '../src/skills/movement/index.ts';
import type { SegmentReceipt } from '../src/skills/movement/segment.ts';
import type { LandingOption } from '../src/skills/types.ts';
import type { MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

function fill(
  map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[],
  properties: Record<string, string> = {},
) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now() + sequence, sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties }, pos,
    });
  }
}

/** 模拟服务器在第一步实测推进已确认后、下一步执行前把身体水平推移 dx；记录已上报的进度。 */
function driftAfterFirstStep(adapter: FakeAdapter, dx: number) {
  const fractions: number[] = [];
  let drifted = false;
  const progress = (fraction: number) => {
    fractions.push(fraction);
    if (drifted || fraction <= 0) return;
    drifted = true;
    adapter.pos = { ...adapter.pos, x: adapter.pos.x + dx };
  };
  return { progress, fractions, drifted: () => drifted };
}

function flatMap() {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 5; x++) for (let y = 64; y <= 66; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:grass_block', Array.from({ length: 7 }, (_, x) => ({ x: x - 1, y: 63, z: 0 })));
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed',
      contract: 'memory-host-contract/2',
      library: {},
      host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}

class DropWorld extends FakeAdapter {
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind === 'xyz') { this.pos = { x: target.x, y: target.y, z: target.z }; return; }
    return super.moveTo(target, opts);
  }
}

/** 第一步留下到达容差内的残差；下一步必须从实测脚位复验到原计划落点。 */
class DriftOnceWorld extends FakeAdapter {
  drifted = false;
  feetTargets: Vec3Like[] = [];
  onChange: ((pos: Vec3Like) => void) | null = null;
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    await super.moveTo(target, opts);
    if (target.kind === 'feet') {
      this.feetTargets.push({ x: target.x, y: target.y, z: target.z });
      if (!this.drifted) {
        this.drifted = true;
        this.pos = { x: target.x + 0.05, y: target.y, z: target.z };
        this.onChange?.({ ...this.pos });
      }
    }
  }
}

class BudgetRecordingWorld extends FakeAdapter {
  moveStarts: number[] = [];
  timeouts: number[] = [];
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind === 'feet') {
      this.moveStarts.push(Date.now());
      this.timeouts.push(opts.timeoutMs);
    }
    return super.moveTo(target, opts);
  }
}

/** 第一步之后通过合法 VoxelMap 观察把下一段支撑改成空气。 */
class SupportChangeWorld extends FakeAdapter {
  changed = false;
  afterFirst: (() => void) | null = null;
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    await super.moveTo(target, opts);
    if (!this.changed) {
      this.changed = true;
      this.afterFirst?.();
    }
  }
}

function setup(map: VoxelMap) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const base = makeCtx(adapter);
  const ctx = { ...base, spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

test('navigate_to 自己执行 3D walk 路线，Agent 不用手抄 move_step 坐标', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 3, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.evidenceMode, 'current');
  assert.ok((r.data?.executed as number) >= 3);
  assert.equal(Math.floor(adapter.pos.x), 3);
  assert.equal(Math.floor(adapter.pos.z), 0);
});

test('navigate_to cell 目标保留 0.01 脚高容差：同列 Y=64.03 与实测 64 不算预先到达', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 0, y: 64.03, z: 0 }, allowed: ['walk', 'step'], historical: false, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed', r.summary);
  assert.notEqual(r.data?.arrived, true, '0.03 的旧容差不得提前判到达');
  assert.equal((r.data?.requestedTarget as { y: number } | undefined)?.y, 64.03, '原请求脚高保留');
  assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 }, '没有为 0.03 的旧容差发动作');
});

test('navigate_to 起点证据过期时先观察，不扫描不能立即执行的历史候选', async (t) => {
  const map = flatMap();
  // 自身动作效果未确认（pending_effect）才是陈旧当前证据；时间与会话不使证据老化。
  for (let x = -1; x <= 5; x++) for (let y = 63; y <= 66; y++) for (let z = -1; z <= 1; z++) map.invalidatePendingEffect(DIM, { x, y, z });
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 2, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.evidenceMode, 'current', '先修复局部当前证据，不扫描历史候选');
  assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 }, 'STALE 当前证据不启动身体');
  // 没有新证据时会重新规划，直到连续多段没有进展才交回；不会启动身体。
  assert.ok((r.data?.counters as { searches: number }).searches <= 4);
  assert.equal((r.data?.lastSegment as SegmentReceipt).boundary?.status, 'STALE');
});

test('navigate_to 从 1×1 平台用显式 2 格下落到真实站立面', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 2; x++) for (let y = 60; y <= 65; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }, { x: 1, y: 61, z: 0 }]);
  const adapter = new DropWorld();
  adapter.groundY = -100;
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 63, z: 0 } }, { name: 'stone', pos: { x: 1, y: 61, z: 0 } });
  const option: LandingOption = {
    target: { x: 1.5, y: 62, z: 0.5 }, support: { pos: { x: 1, y: 61, z: 0 }, name: 'stone' },
    surface: 'ground', surfaceY: 62, drop: 2, horizontalDistance: 1, clearance: 'clear', corridor: 'clear',
    approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
    receipt: { worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, at: Date.now(), from: { ...adapter.pos }, onGround: true },
  };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  const fresh = () => ({ ...option, receipt: { ...option.receipt, at: Date.now(), from: { ...adapter.pos }, observationId: adapter.state().observationId } });
  ctx.senses.landingOptions = () => [fresh()];
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 1, y: 62, z: 0 }, allowed: ['walk', 'step', 'drop'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(adapter.pos.y), 62);
  const transitions = r.data?.transitions as { kind: string; drop: number }[] | undefined;
  assert.deepEqual(transitions?.map((transition) => [transition.kind, transition.drop]), [['drop', 2]]);
});

test('navigate_to 从 1×1 平台用 4 格下落也能执行', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 2; x++) for (let y = 58; y <= 65; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }, { x: 1, y: 59, z: 0 }]);
  const adapter = new DropWorld();
  adapter.groundY = -100;
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 63, z: 0 } }, { name: 'stone', pos: { x: 1, y: 59, z: 0 } });
  const option: LandingOption = {
    target: { x: 1.5, y: 60, z: 0.5 }, support: { pos: { x: 1, y: 59, z: 0 }, name: 'stone' },
    surface: 'ground', surfaceY: 60, drop: 4, horizontalDistance: 1, clearance: 'clear', corridor: 'clear',
    approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
    receipt: { worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 0, at: Date.now(), from: { ...adapter.pos }, onGround: true },
  };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  const fresh = () => ({ ...option, receipt: { ...option.receipt, at: Date.now(), from: { ...adapter.pos }, observationId: adapter.state().observationId } });
  ctx.senses.landingOptions = () => [fresh()];
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 1, y: 60, z: 0 }, allowed: ['walk', 'step', 'drop'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(adapter.pos.y), 60);
  assert.equal((r.data?.transitions as { drop?: number }[] | undefined)?.[0]?.drop, 4);
});

test('navigate_to 小偏差从实测脚位复验并到达原连续目标，不重锚目标或强制重搜', async (t) => {
  const map = flatMap();
  const adapter = new DriftOnceWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const target = { x: 3.5, y: 64, z: 0.5 };
  const r = await navigateTo.run(ctx, {
    to: target, allowed: ['walk', 'step'], historical: true, maxSteps: 16, maxSegments: 4, maxSearches: 6,
    allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.requestedTarget, target, '原精确脚位不被重锚');
  assert.deepEqual(adapter.pos, target, '终点不沿第一次残差漂移');
  assert.deepEqual(adapter.feetTargets, [1.5, 2.5, 3.5].map((x) => ({ x, y: 64, z: 0.5 })));
  assert.equal((r.data?.counters as { searches: number }).searches, 1);
  assert.equal(r.data?.replanCount ?? 0, 0, '容差内残差经过真实几何复验，无须重搜');
  const segment = r.data?.lastSegment as SegmentReceipt;
  assert.equal(segment.confirmed.length, 3);
  assert.deepEqual(segment.confirmed[0]!.measuredTo, { x: 1.55, y: 64, z: 0.5 });
  assert.deepEqual(segment.confirmed[1]!.measuredFrom, segment.confirmed[0]!.measuredTo, '实测偏差没有被计划点覆盖');
  assert.deepEqual(segment.confirmed.at(-1)!.measuredTo, target);
});

test('navigate_to 小偏差从实测脚位复验并到达原 cell 目标，计划落点不累计漂移', async (t) => {
  const map = flatMap();
  const adapter = new DriftOnceWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const target = { x: 3, y: 64, z: 0 };
  const r = await navigateTo.run(ctx, {
    to: target, allowed: ['walk', 'step'], historical: false, maxSteps: 16, maxSegments: 4,
    allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.requestedTarget, target);
  assert.deepEqual(adapter.pos, { x: 3.5, y: 64, z: 0.5 });
  assert.deepEqual(adapter.feetTargets, [1.5, 2.5, 3.5].map((x) => ({ x, y: 64, z: 0.5 })));
  assert.equal((r.data?.counters as { searches: number }).searches, 1);
  assert.equal(r.data?.replanCount ?? 0, 0);
  const segment = r.data?.lastSegment as SegmentReceipt;
  assert.equal(segment.confirmed.length, 3);
  assert.deepEqual(segment.confirmed[0]!.measuredTo, { x: 1.55, y: 64, z: 0.5 });
  assert.deepEqual(segment.confirmed[1]!.measuredFrom, segment.confirmed[0]!.measuredTo);
  assert.deepEqual(segment.confirmed[1]!.transition.from, { x: 1.5, y: 64, z: 0.5 }, '计划起点与实测起点分别保留');
  assert.ok(Math.abs(segment.confirmed[1]!.measuredHorizontal - 0.95) <= 1e-9);
});

test('navigate_to 已确认一步后在计划起点格列内偏移：从实测位置复验下一步几何，不重搜', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  t.after(() => ctx.memory.close());
  const drift = driftAfterFirstStep(adapter, 0.2);
  ctx.progress = drift.progress;
  const target = { x: 3, y: 64, z: 0 };
  const r = await navigateTo.run(ctx, {
    to: target, allowed: ['walk', 'step'], historical: false, maxSteps: 16, maxSegments: 4,
    allowUnknownCorridor: false,
  });
  assert.equal(drift.drifted(), true, '测试确实发生段间漂移');
  assert.ok(drift.fractions.every((f, i) => i === 0 || f >= drift.fractions[i - 1]!), `进度不倒退：${drift.fractions}`);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.requestedTarget, target, '不改原 cell 目标');
  assert.equal(r.data?.replanCount, undefined);
  assert.equal((r.data?.counters as { searches: number }).searches, 1);
  const segment = r.data?.lastSegment as SegmentReceipt;
  assert.deepEqual(segment.confirmed[1]!.measuredFrom, { x: 1.7, y: 64, z: 0.5 }, '第二步从偏移后的实测起点出发');
  assert.deepEqual(segment.confirmed[1]!.transition.from, { x: 1.5, y: 64, z: 0.5 }, '计划几何不被实测改写');
  assert.equal(Math.floor(adapter.pos.x), 3);
});

test('navigate_to 已确认一步后偏移出计划起点格列，下一步必须从实测位置重搜原目标', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  t.after(() => ctx.memory.close());
  const drift = driftAfterFirstStep(adapter, -0.6);
  ctx.progress = drift.progress;
  const target = { x: 3, y: 64, z: 0 };
  const r = await navigateTo.run(ctx, {
    to: target, allowed: ['walk', 'step'], historical: false, maxSteps: 16, maxSegments: 4,
    allowUnknownCorridor: false,
  });
  assert.equal(drift.drifted(), true, '测试确实发生段间漂移');
  assert.ok(drift.fractions.every((f, i) => i === 0 || f >= drift.fractions[i - 1]!), `被推回也不倒退：${drift.fractions}`);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.requestedTarget, target, '重搜不改原 cell 目标');
  assert.equal(r.data?.replanCount, 1);
  const replan = (r.data?.replans as { plannedStart: Vec3Like; measuredEnd: Vec3Like }[])[0]!;
  assert.deepEqual(replan.plannedStart, { x: 1.5, y: 64, z: 0.5 });
  assert.equal(Math.floor(replan.measuredEnd.x), 0, '实测已离开计划起点格列');
  const segment = r.data?.lastSegment as SegmentReceipt;
  assert.deepEqual(segment.confirmed[0]!.transition.from, replan.measuredEnd, '新路线必须从偏移后的实测起点出发');
  assert.equal(Math.floor(adapter.pos.x), 3);
});

test('隐藏的已加载客户端方块不成为已观察 blocker：导航只按合法 VoxelMap 证据判断', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  // 只改客户端加载方块，不写入 VoxelMap：这不是合法观察，不能变成新的已观察阻挡。
  adapter.blocks.push({ name: 'stone', pos: { x: 2, y: 64, z: 0 } }, { name: 'stone', pos: { x: 2, y: 65, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 4, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: false, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(adapter.pos.x), 4);
});

test('下一步支撑在当前 VoxelMap 证据里变成空气时，发出第二次控制前停止并保留已确认进展', async (t) => {
  const map = flatMap();
  const adapter = new SupportChangeWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  let seq = 10_000;
  adapter.afterFirst = () => {
    seq += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now() + seq, sequence: seq,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: 'minecraft:air', properties: {} }, pos: { x: 2, y: 63, z: 0 },
    });
  };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const visited: { x: number; z: number }[] = [];
  const move = adapter.moveTo.bind(adapter);
  adapter.moveTo = async (target, opts) => {
    if (target.kind === 'feet') visited.push({ x: Math.floor(target.x), z: Math.floor(target.z) });
    return move(target, opts);
  };
  const r = await navigateTo.run(ctx, {
    to: { x: 4, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: false, maxSteps: 8, allowUnknownCorridor: false,
  });
  // 支撑变成空气的那一格绝不踏入；用最新证据重搜后可以从旁边绕过去。
  assert.ok(!visited.some((cell) => cell.x === 2 && cell.z === 0), `踏进了失去支撑的格：${JSON.stringify(visited)}`);
});

test('navigate_to walk-only 在短 step+drop 与更长 walk 绕路并存时搜索合法 walk 图，不走越权捷径', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  const floor: { x: number; y: number; z: number }[] = [];
  const slabs: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= 4; x++) for (let z = -6; z <= 6; z++) {
    air.push({ x, y: 64, z }, { x, y: 65, z });
    floor.push({ x, y: 63, z });
  }
  // 直线 z=0 上 x=1 是一排半砖（step+drop 捷径）；z=5 处有正常 walk 绕路。
  for (let z = -4; z <= 4; z++) slabs.push({ x: 1, y: 63, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:stone', floor);
  fill(map, 'minecraft:stone_slab', slabs, { type: 'bottom' });
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 2, y: 64, z: 0 }, allowed: ['walk'], historical: false, maxSteps: 24,
    maxSegments: 4, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  const transitions = r.data?.transitions as { kind: string; to: { z: number } }[];
  assert.ok(transitions.length > 2);
  assert.ok(transitions.every((transition) => transition.kind === 'walk'), JSON.stringify(transitions.map((transition) => transition.kind)));
  assert.ok(transitions.some((transition) => Math.abs(transition.to.z) >= 4.5), '路线绕过半砖排（z=-4..4）的合法 walk 绕路');
  assert.equal(Math.floor(adapter.pos.x), 2);
});

test('navigate_to 把原 deadline 的剩余量传给身体控制：50ms 不会被扩成 1000ms', async (t) => {
  const map = flatMap();
  const adapter = new BudgetRecordingWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.speed = 100_000;
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const deadline = Date.now() + 50;
  ctx.deadline = deadline;
  const r = await navigateTo.run(ctx, {
    to: { x: 2, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: false, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.ok(adapter.timeouts.length > 0, `动作前期限已耗尽，无法验证预算：${r.summary}`);
  assert.ok(adapter.timeouts.every((timeout) => timeout <= 50), `timeout 不得扩成 1000ms：${adapter.timeouts.join(',')}`);
  assert.ok(adapter.moveStarts.every((at) => at <= deadline), 'deadline 后不得再发身体控制');
});

test('navigate_to 没有 walk/step/drop 路线时停下报边界，不移动', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:air', [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }]);
  fill(map, 'minecraft:stone', [{ x: 0, y: 63, z: 0 }]);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await navigateTo.run(ctx, {
    to: { x: 4, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /找不到可执行|边界/);
  assert.deepEqual(adapter.actions, []);
});

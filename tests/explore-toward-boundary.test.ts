import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { exploreToward } from '../src/skills/movement/explore-toward.ts';
import { advance } from '../src/skills/movement/index.ts';
import { lookAround } from '../src/skills/movement.ts';
import { activeMovementSession, clearMovementSessions } from '../src/skills/movement/session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

function fill(map: VoxelMap, name: string, cells: Vec3Like[]) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
}

/** 已知走廊 x=0..xMax（z=-1..1）；其余方向没有证据。 */
function knownCorridor(xMax: number) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Vec3Like[] = [], ground: Vec3Like[] = [];
  for (let x = 0; x <= xMax; x++) for (let z = -1; z <= 1; z++) {
    air.push({ x, y: 64, z }, { x, y: 65, z });
    ground.push({ x, y: 63, z });
  }
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:grass_block', ground);
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/1',
      library: { execute: { walk: true } }, host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}

function setup(map: VoxelMap) {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

test('先沿当前方向走到可见前沿，不为远处目标提前改走侧路', async (t) => {
  const map = knownCorridor(7);
  // 侧路完整通到目标格，直行的下一格尚未看到。横向授权很宽，也应先在东向前沿看。
  for (let x = 8; x <= 16; x++) for (const z of (x === 16 ? [0, 1] : [1])) {
    fill(map, 'minecraft:grass_block', [{ x, y: 63, z }]);
    fill(map, 'minecraft:air', [64, 65].map(y => ({ x, y, z })));
  }
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const views: Vec3Like[] = [];
  ctx.senses.observeBlocks = () => { views.push({ ...adapter.pos }); return []; };
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 16, maxLateralDrift: 16 }, adapter));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal((result.data?.stop as { reason: string }).reason, 'UNKNOWN_BOUNDARY');
  assert.deepEqual(adapter.pos, { x: 7.5, y: 64, z: 0.5 });
  assert.ok(views.length > 0 && views.every(pos => pos.x === 7.5 && pos.z === 0.5));
});

test('偏心起步可显式禁止侧移，路点不会因半格舍入跳进邻列', async (t) => {
  const { adapter, ctx } = setup(knownCorridor(18));
  t.after(() => ctx.memory.close());
  adapter.pos = { x: 0.5, y: 64, z: 0.85 };
  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 16, maxLateralDrift: 0 }, adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(adapter.pos, { x: 16.5, y: 64, z: 0.85 });
});

const argsOf = (raw: unknown, adapter: FakeAdapter) => {
  const result = exploreToward.validate(raw, adapter);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.args;
};

/**
 * 只提交 observeBlocks 实际请求的位置：名字来自测试世界的显式方块，
 * 不把未知/null 补成空气，也不替请求之外的格子生成观测。
 */
function observeRequested(adapter: FakeAdapter, map: VoxelMap) {
  const calls: Vec3Like[][] = [];
  const observeBlocks = (positions: Vec3Like[]) => {
    calls.push(positions.map((pos) => ({ ...pos })));
    return positions.flatMap((pos) => {
      const known = adapter.blockAt(pos);
      if (known === null) return [];
      const name = known.includes(':') ? known : `minecraft:${known}`;
      fill(map, name, [pos]);
      return [{
        pos: { ...pos }, name, properties: {},
        worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
      }];
    });
  };
  return { observeBlocks, calls };
}

test.beforeEach(() => clearMovementSessions());

type Counters = { observations: number; newObservedCells: number; searches: number; confirmedTransitions: number };
type Budgets = { maxObservations: number; maxObservedCells: number; maxSearches: number; maxTransitions: number };

/** 到达或被真实观察/搜索/transition 预算挡住都算诚实终态；不要求凑满 16 格。 */
function assertHonestExploration(result: Awaited<ReturnType<typeof exploreToward.run>>) {
  const counters = result.data?.counters as Counters;
  const budgets = result.data?.budget as Budgets;
  const progress = result.data?.progress as { along: number };
  assert.ok(progress.along > 0, `实测进展必须为正：${JSON.stringify(progress)}`);
  assert.ok(counters.confirmedTransitions > 0, `必须确认过真实位移：${JSON.stringify(counters)}`);
  assert.ok(counters.observations > 0, '必须实际观察过');
  assert.ok(counters.newObservedCells > 0, '必须获得过新的观测格');
  assert.ok(counters.observations <= budgets.maxObservations, `观察次数 ${counters.observations}/${budgets.maxObservations}`);
  assert.ok(counters.newObservedCells <= budgets.maxObservedCells, `新增观测格 ${counters.newObservedCells}/${budgets.maxObservedCells}`);
  // 搜索预算只约束没有带来位移的搜索。
  assert.ok((counters as Counters & { idleSearches: number }).idleSearches <= budgets.maxSearches, `无进展搜索 ${(counters as Counters & { idleSearches: number }).idleSearches}/${budgets.maxSearches}`);
  assert.ok(counters.confirmedTransitions <= budgets.maxTransitions, `确认位移 ${counters.confirmedTransitions}/${budgets.maxTransitions}`);
  if (result.status === 'succeeded') {
    assert.ok(progress.along >= 16, `到达时 along=${progress.along}`);
  } else {
    assert.equal((result.data?.stop as { reason: string }).reason, 'BUDGET_EXHAUSTED', result.summary);
    assert.ok(
      counters.observations === budgets.maxObservations
      || counters.newObservedCells === budgets.maxObservedCells
      || counters.searches === budgets.maxSearches
      || counters.confirmedTransitions === budgets.maxTransitions,
      `未到达时必须用尽一项累计预算：${JSON.stringify(counters)} / ${JSON.stringify(budgets)}`,
    );
  }
}

test('完全未观测的初始地图：先观察当前位置，再沿真实观测逐步探索', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const { observeBlocks, calls } = observeRequested(adapter, map);
  ctx.senses.observeBlocks = observeBlocks;
  t.mock.method(lookAround, 'run', async () => ({ status: 'failed', failureCode: 'NOT_FOUND', summary: '未见' }));

  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 16, segment: 16 }, adapter));

  assertHonestExploration(result);
  assert.ok(calls.length >= 1, '空地图必须先做合法观察');
  assert.ok(calls.every((positions) => positions.length <= 32), '每次观察格数有界');
});

test('未知前缀前端：分段用尽后仍观察边界，再用同一 session 续接推进', async (t) => {
  const map = knownCorridor(3);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const { observeBlocks } = observeRequested(adapter, map);
  ctx.senses.observeBlocks = observeBlocks;
  t.mock.method(lookAround, 'run', async () => ({ status: 'failed', failureCode: 'NOT_FOUND', summary: '未见' }));

  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 16, segment: 16 }, adapter));

  assertHonestExploration(result);
  const progress = result.data?.progress as { along: number };
  const counters = result.data?.counters as Counters;
  assert.ok(progress.along > 3, `必须越过最初的已知前缀：along=${progress.along}`);
  assert.ok(counters.searches > 1, '观察后应从新证据重新搜索');
  assert.deepEqual(result.data?.frozenOrigin, { x: 0.5, y: 64, z: 0.5 });
});

test('未开启探索标志的 advance 在分段上限处仍按原语义停在边界，不额外观察', async (t) => {
  const map = knownCorridor(3);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  let observations = 0;
  ctx.senses.observeBlocks = () => { observations += 1; return []; };
  const validation = advance.validate({ direction: 'E', distance: 16, maxSegments: 1, maxStepsPerSegment: 16, maxTransitions: 48 }, adapter);
  assert.ok(validation.ok, validation.ok ? '' : validation.error);

  const result = await advance.run(ctx, validation.args);

  assert.equal(result.status, 'failed', result.summary);
  assert.equal((result.data?.stop as { reason: string }).reason, 'UNKNOWN_BOUNDARY');
  assert.equal(observations, 0, '通用 advance 不因本次探索修复而自动扩大观察范围');
  assert.ok(Math.floor(adapter.pos.x) <= 3, `只走到已知前缀（实际 x=${adapter.pos.x}）`);
});

test('前沿观察没有相关新证据时停止，不重复观察或无限重搜', async (t) => {
  const map = knownCorridor(3);
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  let observations = 0;
  let searchesBeforeObservation: number | undefined;
  ctx.senses.observeBlocks = () => {
    searchesBeforeObservation ??= activeMovementSession({ worldId: WORLD, dim: DIM, sessionId: SESSION })?.counters.searches;
    observations += 1;
    return [];
  };
  t.mock.method(lookAround, 'run', async () => ({ status: 'failed', failureCode: 'NOT_FOUND', summary: '未见' }));

  const result = await exploreToward.run(ctx, argsOf({ direction: 'E', distance: 16, segment: 16 }, adapter));

  assert.equal(result.status, 'failed', result.summary);
  assert.equal((result.data?.stop as { reason: string }).reason, 'UNKNOWN_BOUNDARY');
  assert.equal((result.data?.lastObservation as { relatedChanged: boolean }).relatedChanged, false);
  assert.ok(observations >= 1 && observations <= 2, `一次定向观察最多包含一次转头重看，实际 ${observations} 次`);
  assert.equal((result.data?.counters as { observations: number }).observations, 1, 'session 只记一次定向观察，不重复');
  // 观察没有相关变化时，停下前只会绕向尚未试过的前沿点；搜索次数受绕行上限约束。
  assert.ok((result.data?.counters as { searches: number }).searches <= (searchesBeforeObservation ?? 0) + 4 * 4, '不会无限重搜');
  assert.ok(Math.floor(adapter.pos.x) <= 3, `只走到已知前缀（实际 x=${adapter.pos.x}）`);
});

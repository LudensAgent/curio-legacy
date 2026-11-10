import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { navigateTo } from '../src/skills/movement/index.ts';
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

function flatMap() {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Vec3Like[] = [];
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

class CallbackWorld extends FakeAdapter {
  onMove: ((pos: Vec3Like) => void) | null = null;
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    await super.moveTo(target, opts);
    this.onMove?.(this.pos);
  }
}

function setup(map: VoxelMap, adapter: FakeAdapter = new FakeAdapter()) {
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const ctx = { ...makeCtx(adapter, { memory }), spatial: fakeSpatial(map) };
  return { adapter, ctx, memory };
}

type Segment = {
  startStance: Vec3Like;
  endStance: Vec3Like;
  displacement: { horizontal: number; vertical: number; euclidean: number };
  distanceFromStart: number;
  newChunks: number;
  newObservedCells: number;
  observationCoverage: boolean;
  movedCells: boolean;
  arrivedAtTarget: boolean;
  remainingTarget: Vec3Like;
  remainingTransitions: number;
  bounds: { maxSteps: number; plannedTransitions: number; executed: number };
  invalidation: string | null;
  progress: { meaningful: boolean; reason: string };
};

const segmentOf = (result: { data?: Record<string, unknown> }) => result.data!.segment as Segment;

test('区域内短移动但没有新观测/新区块/到达不算探索进展', async (t) => {
  const map = flatMap();
  const { ctx } = setup(map);
  t.after(() => ctx.memory.close());
  // 走一格就停：有实测位移，但没有写入新的已观测格、没有进新区块、也没到选定目标。
  const r = await navigateTo.run(ctx, {
    to: { x: 3, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 1, allowUnknownCorridor: false,
  });
  const segment = segmentOf(r);
  assert.ok(segment.displacement.horizontal > 0, '位移仍作为实测事实报告');
  assert.equal(segment.movedCells, true);
  assert.equal(segment.newObservedCells, 0);
  assert.equal(segment.newChunks, 0);
  assert.equal(segment.observationCoverage, false);
  assert.equal(segment.arrivedAtTarget, false);
  assert.equal(segment.progress.meaningful, false, '单纯位移不算探索进展');
  assert.equal(segment.progress.reason, 'none');
});

test('到达选定站位本身算探索进展', async (t) => {
  const map = flatMap();
  const { ctx } = setup(map);
  t.after(() => ctx.memory.close());
  // 目标两格外的已观测区域：没有新观测/新区块，但到达选定站位。
  const r = await navigateTo.run(ctx, {
    to: { x: 2, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  const segment = segmentOf(r);
  assert.equal(segment.newObservedCells, 0);
  assert.equal(segment.newChunks, 0);
  assert.equal(segment.arrivedAtTarget, true);
  assert.equal(segment.progress.meaningful, true);
  assert.equal(segment.progress.reason, 'arrived_at_target');
});

test('进入新区块不是观测覆盖声明', async (t) => {
  const map = flatMap();
  const adapter = new CallbackWorld();
  const { ctx, memory } = setup(map, adapter);
  t.after(() => ctx.memory.close());
  // 模拟身体在移动中进入了一个未访问区块；VoxelMap 里没有任何新观测。
  adapter.onMove = () => { memory.visit(DIM, { x: 100, y: 64, z: 100 }); };
  const r = await navigateTo.run(ctx, {
    to: { x: 3, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 1, allowUnknownCorridor: false,
  });
  const segment = segmentOf(r);
  assert.equal(segment.newChunks, 1, '分段的 visitedChunkCount 差值来自实测');
  assert.equal(segment.newObservedCells, 0, '区块加载没有写入新的已观测格');
  assert.equal(segment.observationCoverage, false, '新区块不能冒充新观测覆盖');
  assert.notEqual(segment.progress.reason, 'new_observation');
  assert.equal(segment.progress.meaningful, true, '进入新区块按 v4 §11.3 算探索进展');
  assert.equal(segment.progress.reason, 'new_chunk');
});

test('有界分段报告实测事实、失效原因并保留原目标', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const target = { x: 4, y: 64, z: 0 };
  const first = await navigateTo.run(ctx, {
    to: target, allowed: ['walk', 'step'], historical: true, maxSteps: 2, allowUnknownCorridor: false,
  });
  assert.equal(first.status, 'failed', first.summary);
  const segment = segmentOf(first);
  assert.deepEqual(segment.startStance, { x: 0.5, y: 64, z: 0.5 });
  assert.ok(Math.abs(segment.endStance.x - 2.5) < 0.01, `实测终点 ${segment.endStance.x}`);
  assert.deepEqual(segment.remainingTarget, target, '分段预算不缩短原目的地');
  assert.equal(segment.remainingTransitions, 2);
  assert.equal(segment.displacement.horizontal, 2);
  assert.equal(segment.distanceFromStart, 2);
  assert.deepEqual(segment.bounds, { maxSteps: 2, plannedTransitions: 4, executed: 2 });
  assert.equal(segment.invalidation, 'max_steps');
  assert.equal(segment.arrivedAtTarget, false);
  assert.equal(segment.progress.meaningful, false, '没有新观测/新区块/到达时，位移本身不算探索进展');
  assert.equal(segment.progress.reason, 'none');
  assert.match(first.summary, /实测位移 2 格、新区块 0、新观测格 0/, '失败摘要也带实测分段事实');
  assert.match(first.summary, /已沿确认路线移动，未新增探索覆盖/);
  assert.doesNotMatch(first.summary, /本段无新进展/);

  // 下一段继续用同一个原目标，不因上一段的 maxSteps 截断而改目标。
  const second = await navigateTo.run(ctx, {
    to: target, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(second.status, 'succeeded', second.summary);
  const done = segmentOf(second);
  assert.deepEqual(done.remainingTarget, target);
  assert.equal(done.remainingTransitions, 0);
  assert.equal(done.invalidation, null);
  assert.equal(done.arrivedAtTarget, true);
  assert.equal(done.progress.meaningful, true);
  assert.equal(done.progress.reason, 'arrived_at_target');
  assert.match(second.summary, /实测位移 2 格、新区块 0、新观测格 0/, '成功摘要也带实测分段事实');
  assert.equal(Math.floor(adapter.pos.x), 4);
});

test('分段内新增的已观测格来自 VoxelMap 实测，可算新覆盖', async (t) => {
  const map = flatMap();
  const adapter = new CallbackWorld();
  const { ctx } = setup(map, adapter);
  t.after(() => ctx.memory.close());
  adapter.onMove = () => fill(map, 'minecraft:air', [{ x: 0, y: 70, z: 0 }]);
  const r = await navigateTo.run(ctx, {
    to: { x: 3, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 1, allowUnknownCorridor: false,
  });
  const segment = segmentOf(r);
  assert.equal(segment.newObservedCells, 1);
  assert.equal(segment.observationCoverage, true);
  assert.equal(segment.progress.meaningful, true);
  assert.equal(segment.progress.reason, 'new_observation');
});

test('提示词用有界分段探索，不再把长按 press_keys 当移动方式', () => {
  const source = readFileSync(new URL('../src/mind/prompt.ts', import.meta.url), 'utf8');
  const choose = source.slice(source.indexOf('const CHOOSE = '), source.indexOf('const PRINCIPLES = '));
  assert.ok(choose.length > 0, 'CHOOSE 段落存在');
  assert.equal(/press_keys/.test(choose), false, '选动作不再推荐 press_keys 旅行');
  assert.match(choose, /有界分段/);
  assert.match(choose, /每段结束[^；\n]*再决定下一段/);
  assert.match(choose, /进入新区块[^；\n]*不等于已看清/);
  assert.match(choose, /没有新观测、没有进入新区块、也没到达选定站位的移动不算探索进展/);
  assert.match(source, /不缩短原目标/);
  assert.match(source, /只有新观测、新区块或到达选定站位才算探索进展，单纯位移不算/);
});

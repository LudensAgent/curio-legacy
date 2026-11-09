/**
 * V4-QA-01 验收矩阵：L2/L3 路线契约（v4 §8.4 / §14.2）。
 *
 * 每个测试直接对应 `workflow/cards/V4-QA-01.md` §2 L2/L3 的一个条目，独立报告
 * PASS / FAIL / NOT_RUN。复用生产组件：`planRoute`/`walkPath`、库
 * `RoutePlanRegistryImpl`、`SharedSpatialSession` + SQLite 历史、`TraversalRecorder`、
 * `verifyLandRoute`，以及夹具 `FakeAdapter`/`makeCtx`。没有第二套注册表、
 * 规划器、复验器或执行器。
 *
 * 离线/Fake：FakeAdapter 的 `moveTo` 是连续插值；`WalkingAdapter` 提供最薄的
 * walkBody/walkTick 桥，按真实朝向逐帧推进。实机 Java 1.20.1 NOT_RUN（V4-QA-02）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  RoutePlanRegistryImpl,
  VoxelMap,
  type RoutePlanDraft,
  type RoutePlanScope,
  type Vec3Like,
} from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../src/adapter/types.ts';
import { walkLandRules } from '../src/adapter/land-rules.ts';
import { afterStep, createActivity, nextStep, noteNavigationDispatch } from '../src/mind/activity.ts';
import { verifyLandRoute } from '../src/spatial/land-search.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { TraversalRecorder } from '../src/spatial/traversal-recorder.ts';
import { clearRouteRecords, navigateTo, planRoute, walkPath } from '../src/skills/movement/index.ts';
import type { SharedSpatialSession as HostSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

const WORLD = 'acceptance-route-world';
const DIM = 'overworld';
const SESSION = 'acceptance-route-session';
const SCOPE: RoutePlanScope = { worldId: WORLD, dim: DIM, sessionId: SESSION };
const BODY = { width: 0.6, height: 1.8, pose: 'standing' as const };

function flatMap(nameAt: (x: number, y: number, z: number) => string, validityWindowMs = 60_000) {
  const map = new VoxelMap(WORLD, { validityWindowMs });
  let sequence = 0;
  const now = Date.now();
  for (let x = -1; x <= 12; x++) for (let z = -1; z <= 4; z++) for (let y = 63; y <= 65; y++) {
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: now, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: nameAt(x, y, z), properties: {} }, pos: { x, y, z },
    });
  }
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/1',
      library: { execute: { walk: true } }, host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
    attach: () => ({}), detach: () => {},
    recordWalkCorridor: (input: { fragment: { id: string }; segments: readonly unknown[] }) => ({
      status: 'written' as const, fragmentId: input.fragment.id,
      traversalIds: input.segments.map((_, index) => `offline-${index}`), stancesMarked: input.segments.length, deliveryError: null,
    }),
  } as unknown as HostSpatialSession;
}

/** 最薄 walk 身体桥：按住 forward 时每帧按真实朝向走 0.02 格。 */
class WalkingAdapter extends FakeAdapter {
  control: Record<string, boolean> = {};
  walkEntity = {
    position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false,
  };
  walkBody() {
    return {
      setControlState: (name: string, value: boolean) => { this.control[name] = value; },
      clearControlStates: () => { for (const key of Object.keys(this.control)) this.control[key] = false; },
      look: (yaw: number, pitch: number) => { this.yaw = yaw; this.pitch = pitch; },
      entity: this.walkEntity,
    };
  }
  walkTick() {
    return (signal: AbortSignal) => new Promise<typeof this.walkEntity | null>((resolve) => {
      const timer = setTimeout(() => {
        if (signal.aborted) { resolve(null); return; }
        if (this.control.forward || this.control.back) {
          const speed = this.control.sneak ? 0.01 : 0.02;
          const direction = (this.control.forward ? 1 : 0) - (this.control.back ? 1 : 0);
          const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.pos = { ...this.pos, x: this.pos.x + fx * direction * speed, z: this.pos.z + fz * direction * speed };
          this.walkEntity.position = { ...this.pos };
        }
        resolve({
          position: { ...this.walkEntity.position }, velocity: { ...this.walkEntity.velocity },
          onGround: true, isInWater: false,
        });
      }, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
  }
}

function walkingAdapter(): WalkingAdapter {
  const w = new WalkingAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return w;
}

const walk = (to: Vec3Like, source: 'auto' | 'search' | 'memory' | 'spatial' = 'search', more: Record<string, unknown> = {}) => ({
  to, mode: 'walk' as const, source, arrival: { kind: 'exact' as const }, ...more,
});

const navArgs = (to: Vec3Like, more: Record<string, unknown> = {}) => ({
  to, allowed: ['walk', 'step'] as ('walk' | 'step' | 'drop')[],
  historical: true, maxSteps: 8, allowUnknownCorridor: false, ...more,
});

const noBuild = (w: WalkingAdapter) => w.actions.every((action) => !action.startsWith('dig:') && !action.startsWith('place:'));

function setupWalking(map = flatMap((_x, y) => y === 63 ? 'stone' : 'air')) {
  clearRouteRecords();
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(map) };
  return { w, ctx, map };
}

test('L2-1 routeId 单次消费：ARRIVED 由实测身体确认，第二次拒绝' , async (t) => {
  const { w, ctx } = setupWalking();
  t.after(() => ctx.memory.close());
  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);
  const plannedSegments = (planned.data?.points as Vec3Like[]).length - 1;
  assert.ok(routeId.startsWith('rt_'), '规划签发 routeId');

  const arrived = await walkPath.run(ctx, { routeId });
  assert.equal(arrived.status, 'succeeded', arrived.summary);
  assert.equal(arrived.data?.outcome, 'ARRIVED');
  assert.equal(arrived.data?.confirmed, true);
  assert.equal(arrived.data?.confirmedSegments, plannedSegments);
  const position = arrived.data?.position as Vec3Like;
  assert.deepEqual({ ...w.pos }, { ...position }, 'ARRIVED 位置来自实测身体，不是计划终点');
  assert.equal(Math.floor(w.pos.x), 2, '身体实际移动');
  assert.equal(noBuild(w), true, '只走路线，不挖/不建');

  const positionAfter = { ...w.pos };
  const second = await walkPath.run(ctx, { routeId });
  assert.equal(second.status, 'failed');
  assert.equal(second.data?.outcome, 'INVALIDATED');
  assert.equal((second.data?.invalidation as { reason?: string } | undefined)?.reason, 'route_consumed');
  assert.deepEqual(w.pos, positionAfter, '重复 routeId 不再执行');
  assert.notEqual(w.control.forward, true, '拒绝时未按前进键');
  t.diagnostic(`L2-1 plannedSegments=${plannedSegments} confirmedSegments=${arrived.data?.confirmedSegments} arrivedWithPhysicalEvidence=1/1 reuse=route_consumed`);
});

test('L2-2 过期 routeId：route_expired，不启动身体' , async (t) => {
  const { w, ctx } = setupWalking(flatMap((_x, y) => y === 63 ? 'stone' : 'air', 300));
  t.after(() => ctx.memory.close());
  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const before = { ...w.pos };
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string } | undefined)?.reason, 'route_expired');
  assert.equal(result.data?.confirmed, false);
  assert.deepEqual(w.pos, before);
  assert.notEqual(w.control.forward, true);
  t.diagnostic('L2-2 expiredRoute rejected=true bodyStarted=false');
});

test('L2-3 作用域/会话不符：换维与 session_reset 都拒绝旧 routeId' , async (t) => {
  const { w, ctx } = setupWalking();
  t.after(() => ctx.memory.close());
  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);
  w.dim = 'the_nether';
  const before = { ...w.pos };
  const wrongDim = await walkPath.run(ctx, { routeId });
  assert.equal(wrongDim.status, 'failed');
  assert.equal(wrongDim.data?.outcome, 'INVALIDATED');
  assert.equal((wrongDim.data?.invalidation as { reason?: string } | undefined)?.reason, 'route_not_found');
  assert.deepEqual(w.pos, before);
  assert.notEqual(w.control.forward, true);

  // 新作用域重新规划后，用 session_reset 事件（sessionId 未变）作废旧 routeId。
  clearRouteRecords();
  w.dim = DIM;
  const replanned = await planRoute.run(ctx, walk({ x: 3.5, y: 64, z: 0.5 }));
  assert.equal(replanned.status, 'succeeded', replanned.summary);
  const nextId = String(replanned.data?.routeId);
  await walkPath.run(ctx, { routeId: 'warm-up' });
  w.emit('session_reset');
  const sessionReset = await walkPath.run(ctx, { routeId: nextId });
  assert.equal(sessionReset.status, 'failed');
  assert.equal((sessionReset.data?.invalidation as { reason?: string } | undefined)?.reason, 'route_not_found');
  assert.deepEqual(w.pos, before, '作用域不符与 reset 都不移动身体');
  t.diagnostic('L2-3 scopeRejects=2 wrongDim=true sessionReset=true');
});

test('L2-4 不可执行 routeId：候选计划被库注册表拒绝，规划器不签发 routeId' , async (t) => {
  const { w, ctx, map } = setupWalking();
  t.after(() => ctx.memory.close());
  const now = Date.now();
  const future = now + 10_000;
  const draft = (executable: boolean): RoutePlanDraft => ({
    backend: 'spatial_library', source: 'search',
    points: [{ x: 0.5, y: 64, z: 0.5 }],
    segments: [{ index: 0, mode: 'walk', points: [{ x: 0.5, y: 64, z: 0.5 }], cost: 0 }],
    cost: 0, confidence: executable ? 'verified' : 'candidate', executable,
    boundaries: [],
    evidence: { worldId: WORLD, dim: DIM, sessionId: SESSION, validUntil: future, ruleVersion: 'acceptance' },
    expiresAt: future, requestedTarget: { x: 0.5, y: 64, z: 0.5 }, resolvedTarget: { x: 0.5, y: 64, z: 0.5 },
    start: { x: 0.5, y: 64, z: 0.5 },
  });
  const registry = new RoutePlanRegistryImpl();
  const candidate = registry.register(draft(false));
  const refused = registry.consume(candidate.routeId, SCOPE, now);
  assert.equal('kind' in refused, true);
  assert.equal((refused as { kind?: string }).kind, 'route_not_executable', '库注册表拒绝不可执行候选');

  // 规划器对同样不可执行的当前世界不签发 routeId。
  const wallAt = Date.now() + 1;
  let wallSequence = 20_000;
  for (const x of [1, 2, 3]) for (const y of [64, 65]) for (const z of [-1, 0, 1, 2, 3, 4]) map.observe({
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: wallAt, sequence: ++wallSequence,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: 'stone', properties: {} }, pos: { x, y, z },
  });
  const wallCell = map.cellAt(DIM, 1, 64, 0);
  assert.equal(wallCell.observed, true);
  if (!wallCell.observed) assert.fail('wall cell must be observed');
  assert.equal(wallCell.evidence.observation.state.name, 'stone', '墙面证据已写入地图');
  const noRoute = await planRoute.run(ctx, walk({ x: 3, y: 64, z: 0 }));
  assert.equal(noRoute.status, 'failed', noRoute.summary);
  assert.equal(noRoute.data?.routeId, undefined, '不可执行时不返回 routeId');
  assert.equal(noRoute.data?.executable, undefined);
  assert.deepEqual(w.actions, [], '规划不移动身体');
  t.diagnostic('L2-4 nonExecutable candidateRefused=true plannerRouteIdIssued=false');
});

test('L2-5 起点不符：route_start_changed → INVALIDATED，不启动身体' , async (t) => {
  const { w, ctx } = setupWalking();
  t.after(() => ctx.memory.close());
  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  w.pos = { ...w.pos, x: w.pos.x + 0.2 };
  const drifted = { ...w.pos };
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string; segment?: number } | undefined)?.reason, 'route_start_changed');
  assert.equal((result.data?.invalidation as { segment?: number }).segment, 0);
  assert.equal((result.data?.unsupported as { reason?: string } | undefined)?.reason, 'route_start_changed');
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.confirmedSegments, 0);
  assert.deepEqual(w.pos, drifted, '起点不符不移动');
  assert.notEqual(w.control.forward, true);
  t.diagnostic('L2-5 startMismatch=0.2 rejected=true confirmedSegments=0');
});

test('L2-6 历史路线端点截断：只到已记录端点，不越过' , async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-route-'));
  const db = join(dir, 'memory.db');
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: db, timeoutMs: 5000 });
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  let sequence = 0;
  const observedAt = Date.now();
  const corridor = Array.from({ length: 7 }, (_, x) => x).flatMap((x) => [
    { pos: { x, y: 63, z: 0 }, name: 'minecraft:stone' },
    { pos: { x, y: 64, z: 0 }, name: 'minecraft:air' },
    { pos: { x, y: 65, z: 0 }, name: 'minecraft:air' },
  ]);
  svc.observe(corridor.map((cell) => ({
    worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: ++sequence,
    observedAt, pos: cell.pos, name: cell.name, properties: {}, stateComplete: true, source: 'vision',
  }) as BlockObservation));
  const recorder = new TraversalRecorder(svc, Date.now);
  for (let x = 0; x <= 6; x++) recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION, pos: { x: x + 0.5, y: 64, z: 0.5 } });
  recorder.flush();

  const adapter = walkingAdapter();
  const ctx = { ...makeCtx(adapter, { senses: { observeBlocks: observeAllBlocks(adapter) } }), spatial: svc };
  clearRouteRecords();
  // 请求 x=8，但历史只记录到 x=6；近邻查询应返回已记录端点，而不是伪造延长段。
  const memory = await planRoute.run(ctx, walk({ x: 8, y: 64, z: 0 }, 'memory'));
  assert.equal(memory.status, 'succeeded', memory.summary);
  assert.equal(memory.data?.historicalGeometry, true, '历史几何只作候选');
  assert.equal(memory.data?.executable, false, '历史几何不是当前可执行授权');
  const endpoint = memory.data?.selectedEndpoint as Vec3Like;
  assert.equal(Math.floor(endpoint.x), 6, '选定端点被截断到已记录节点');
  const points = memory.data?.points as Vec3Like[];
  assert.equal(Math.max(...points.map((point) => point.x)), 6, '拓扑点列不越过记录端点');
  assert.deepEqual(adapter.actions, [], '历史查询/规划不移动身体');
  // 显式执行也只到端点 x=6，不继续到未记录的 x=8。
  const executed = await navigateTo.run(ctx, { to: { x: 8, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 32, allowUnknownCorridor: false });
  assert.equal(executed.status, 'failed', executed.summary);
  assert.equal(Math.floor(adapter.pos.x), 6, '执行停在记录端点，不越过');
  t.diagnostic(`L2-6 requestedX=8 recordedEndpointX=${endpoint.x} executedToX=${adapter.pos.x}`);
});

test('L2-7 段失效 INVALIDATED：规划后证据失效，保留实测位置且不再移动' , async (t) => {
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const { w, ctx } = setupWalking(map);
  t.after(() => ctx.memory.close());
  const planned = await planRoute.run(ctx, walk({ x: 3.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  map.markStale(DIM, 'expired');
  const before = { ...w.pos };
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  const reason = (result.data?.invalidation as { reason?: string } | undefined)?.reason;
  assert.ok(reason === 'stale' || reason === 'route_invalidated', `段失效原因=${reason}`);
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.confirmedSegments, 0);
  assert.deepEqual(w.pos, before, '证据失效时无未测量移动');
  assert.notEqual(w.control.forward, true);
  t.diagnostic(`L2-7 segmentInvalidation=${reason} confirmedSegments=0`);
});

/** 第一段正常走完；第二段故意向 +Z 偏航并结束帧源，触发库的 deviation→PARTIAL。 */
class DeviatingAdapter extends WalkingAdapter {
  lookCount = 0;
  secondFrames = 0;
  walkBody() {
    const inner = super.walkBody();
    return { ...inner, look: (yaw: number, pitch: number) => { this.lookCount += 1; inner.look(yaw, pitch); } };
  }
  walkTick() {
    return (signal: AbortSignal) => new Promise<typeof this.walkEntity | null>((resolve) => {
      const timer = setTimeout(() => {
        if (signal.aborted) { resolve(null); return; }
        if (this.lookCount >= 2) {
          this.secondFrames += 1;
          if (this.secondFrames > 12) { resolve(null); return; }
          if (this.control.forward) {
            this.pos = { ...this.pos, z: this.pos.z + 0.02 };
            this.walkEntity.position = { ...this.pos };
          }
        } else if (this.control.forward || this.control.back) {
          const speed = this.control.sneak ? 0.01 : 0.02;
          const direction = (this.control.forward ? 1 : 0) - (this.control.back ? 1 : 0);
          const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.pos = { ...this.pos, x: this.pos.x + fx * direction * speed, z: this.pos.z + fz * direction * speed };
          this.walkEntity.position = { ...this.pos };
        }
        resolve({ position: { ...this.walkEntity.position }, velocity: { ...this.walkEntity.velocity }, onGround: true, isInWater: false });
      }, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
  }
}

test('L2-8a PARTIAL：部分确认段保留，confirmed=false 不算到达' , async (t) => {
  const w = new DeviatingAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD; w.sessionId = SESSION; w.dim = DIM;
  clearRouteRecords();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'PARTIAL', '偏离是部分进展，不是到达也不是失效');
  assert.equal(result.data?.confirmed, false);
  assert.ok((result.data?.confirmedSegments as number) >= 1, '至少确认了第一段');
  assert.equal((result.data?.invalidation as { reason?: string } | undefined)?.reason, undefined, 'PARTIAL 不是 INVALIDATED');
  const position = result.data?.position as Vec3Like;
  assert.deepEqual({ ...w.pos }, { ...position }, 'PARTIAL 保留实测末位');
  assert.ok(w.pos.z > 0.5, '第二段偏离到 +Z');
  t.diagnostic(`L2-8a PARTIAL confirmedSegments=${result.data?.confirmedSegments} positionZ=${w.pos.z.toFixed(2)}`);
});

test('L2-8b BLOCKED：当前证据阻塞，停在原地且不自动施工' , async (t) => {
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const { w, ctx } = setupWalking(map);
  t.after(() => ctx.memory.close());
  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  // 规划后第一步目的站立格变石头；+1ms 避免与建图观测同毫秒被判 STALE。
  map.observe({
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now() + 1, sequence: 30_000,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: 'stone', properties: {} }, pos: { x: 1, y: 64, z: 0 },
  });
  const before = { ...w.pos };
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'BLOCKED');
  assert.equal(result.data?.navOutcome, 'BLOCKED');
  assert.equal(result.data?.confirmed, false);
  assert.deepEqual(w.pos, before, '阻塞时不自动施工或移动');
  assert.equal(noBuild(w), true);
  assert.notEqual(w.control.forward, true);
  t.diagnostic('L2-8b BLOCKED confirmedSegments=0 bodyStarted=false');
});

test('L2-8c TIMEOUT：期限耗尽，保留实测位移与释放控制' , async (t) => {
  const { w, ctx } = setupWalking();
  t.after(() => ctx.memory.close());
  const planned = await planRoute.run(ctx, walk({ x: 4.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId), deadlineMs: Date.now() + 400 });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'TIMEOUT');
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.equal(result.data?.confirmed, false);
  assert.notEqual(w.control.forward, true, '超时后释放前进键');
  const position = result.data?.position as Vec3Like | null;
  assert.ok(position !== null && Number.isFinite(position.x), '保留有限实测位置');
  assert.ok(w.pos.x > 0.5, `期限前身体已实际移动：x=${w.pos.x.toFixed(2)}`);
  assert.ok(position.x > 0.5, '超时位置保留已走的部分位移');
  assert.ok(w.pos.x >= position.x - 0.001, '实测末位不早于库接受的最新样本');
  assert.ok(w.pos.x < 4.5, '超时位置不是计划终点');
  t.diagnostic(`L2-8c TIMEOUT confirmedSegments=${result.data?.confirmedSegments ?? 0} partialX=${w.pos.x.toFixed(2)}`);
});

test('L2-8d CANCELLED：取消保留实测位移，身体不再继续' , async (t) => {
  const { w, ctx: base } = setupWalking();
  t.after(() => base.memory.close());
  const planned = await planRoute.run(base, walk({ x: 4.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const controller = new AbortController();
  const ctx = { ...base, signal: controller.signal };
  const running = walkPath.run(ctx, { routeId: String(planned.data?.routeId), deadlineMs: Date.now() + 30_000 });
  const waitUntil = Date.now() + 5000;
  while (!(w.control.forward === true && w.pos.x > 0.51) && Date.now() < waitUntil) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(w.pos.x > 0.51, '取消前身体已实际移动');
  controller.abort('qa-cancel');
  const [result] = await Promise.all([running]);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.data?.outcome, 'CANCELLED');
  assert.equal(result.data?.confirmed, false);
  assert.notEqual(w.control.forward, true, '取消后释放前进键');
  const position = result.data?.position as Vec3Like | null;
  assert.ok(position !== null && Number.isFinite(position.x), '取消保留有限实测位置');
  assert.ok(position.x > 0.5, `取消保留已走的部分位移：x=${position.x.toFixed(2)}`);
  const frozen = { ...w.pos };
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(w.pos, frozen, '取消后身体不再继续移动');
  t.diagnostic(`L2-8d CANCELLED positionX=${position?.x.toFixed(2)} controlsReleased=true`);
});

test('L2-10 不重规划/不施工/不 pathfinder 回退：阻塞后只交回事实' , async (t) => {
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const { w, ctx } = setupWalking(map);
  t.after(() => ctx.memory.close());
  const planned = await planRoute.run(ctx, walk({ x: 3.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);
  map.observe({
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now() + 1, sequence: 40_000,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: 'stone', properties: {} }, pos: { x: 1, y: 64, z: 0 },
  });
  const result = await walkPath.run(ctx, { routeId });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'BLOCKED');
  assert.equal(noBuild(w), true, '不自动挖/放');
  assert.equal(w.actions.every((action) => action.startsWith('moveTo:') || action.startsWith('drive:')), true, '身体只收到既有移动原语');
  assert.equal(w.ridePaths.length, 0, '没有换用载具/pathfinder 路线');
  // 阻塞后同一 routeId 仍已被消费；不会静默重规划出第二条路线。
  const retried = await walkPath.run(ctx, { routeId });
  assert.equal(retried.status, 'failed');
  assert.equal((retried.data?.invalidation as { reason?: string } | undefined)?.reason, 'route_consumed');
  t.diagnostic('L2-10 blockedActions=0 newRouteIssued=false pathfinderFallback=false');
});

test('L2-9 历史路线只做候选，当前证据复验后才复用' , async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-history-'));
  const db = join(dir, 'memory.db');
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: db, timeoutMs: 5000 });
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  let sequence = 0;
  const observedAt = Date.now();
  const corridor = Array.from({ length: 5 }, (_, x) => x).flatMap((x) => [
    { pos: { x, y: 63, z: 0 }, name: 'minecraft:stone' },
    { pos: { x, y: 64, z: 0 }, name: 'minecraft:air' },
    { pos: { x, y: 65, z: 0 }, name: 'minecraft:air' },
  ]);
  svc.observe(corridor.map((cell) => ({
    worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: ++sequence,
    observedAt, pos: cell.pos, name: cell.name, properties: {}, stateComplete: true, source: 'vision',
  }) as BlockObservation));
  const recorder = new TraversalRecorder(svc, Date.now);
  for (let x = 0; x <= 4; x++) recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION, pos: { x: x + 0.5, y: 64, z: 0.5 } });
  recorder.flush();

  const query = svc.query({ kind: 'historyRoute', dim: DIM, from: { x: 0, y: 64, z: 0 }, to: { x: 4, y: 64, z: 0 }, near: 1 });
  assert.equal(query.status, 'ok');
  if (query.data?.kind !== 'historyRoute') assert.fail('expected historyRoute page');
  const history = query.data.inspection;
  assert.equal(history.status, 'FOUND');
  assert.equal(history.historicalGeometry, true, '历史只提供几何候选');
  assert.equal(history.executable, false, '历史几何不是执行授权');
  assert.equal(history.currentPassability, 'UNKNOWN', '未复验前不当当前可走');

  const points = history.points;
  const stances = points.map((point) => ({ x: Math.floor(point.x) + 0.5, y: point.y, z: Math.floor(point.z) + 0.5 }));
  const transitions = stances.slice(1).map((to, index) => ({ kind: 'walk' as const, from: { ...stances[index]! }, to, drop: 0 }));
  const verification = verifyLandRoute(svc.session.voxel, {
    worldId: WORLD, dim: DIM, sessionId: SESSION,
    body: { feet: { ...stances[0]! }, ...BODY },
    rules: walkLandRules,
  }, transitions, Date.now());
  assert.equal(verification.verdict, 'OPEN', '当前证据复验通过');
  assert.equal(verification.openPrefix, points.length - 1);

  const adapter = walkingAdapter();
  const ctx = { ...makeCtx(adapter, { senses: { observeBlocks: observeAllBlocks(adapter) } }), spatial: svc };
  clearRouteRecords();
  const spatial = await planRoute.run(ctx, walk({ x: 4, y: 64, z: 0 }, 'spatial'));
  assert.equal(spatial.status, 'succeeded', spatial.summary);
  assert.equal(spatial.data?.evidenceMode, 'current', '复验通过后才按当前证据复用');
  const steps = spatial.data?.steps as { skill: string }[];
  assert.ok(steps.length >= 1 && steps.every((step) => step.skill === 'move_step'), '只复用现有 L1 动作');
  const reused = await navigateTo.run(ctx, { to: { x: 4, y: 64, z: 0 }, allowed: ['walk', 'step'], historical: true, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(reused.status, 'succeeded', reused.summary);
  assert.equal(Math.floor(adapter.pos.x), 4);
  assert.equal(noBuild(adapter), true);
  t.diagnostic(`L2-9 historyCandidate=true revalidation=${verification.verdict} reuseSuccess=1/1 buildActions=0`);
});


/** 每帧把真实实测位置交给 TraversalRecorder，模拟 Perception 的记录职责；不喂计划点。 */
class RecordingAdapter extends WalkingAdapter {
  recorder: TraversalRecorder | null = null;
  override walkTick() {
    const tick = super.walkTick();
    return async (signal: AbortSignal) => {
      const entity = await tick(signal);
      this.recorder?.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION, pos: { ...this.pos } });
      return entity;
    };
  }
}

test('L2-11 已确认路线写 traversal；未确认路线不写' , async (t) => {
  const writes: { segments: number; last: Vec3Like }[] = [];
  const sink: Pick<HostSpatialSession, 'recordWalkCorridor'> = {
    recordWalkCorridor(input) {
      writes.push({
        segments: input.segments.length,
        last: { ...(input.fragment.polyline.at(-1) ?? { x: 0, y: 64, z: 0.5 }) },
      });
      return {
        status: 'written', fragmentId: input.fragment.id,
        traversalIds: input.segments.map((_, index) => `qa-${index}`),
        stancesMarked: input.segments.length, deliveryError: null,
        topology: { nodes: input.segments.length + 1, edges: input.segments.length, written: true },
      };
    },
  };
  const adapter = new RecordingAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD; adapter.sessionId = SESSION; adapter.dim = DIM;
  clearRouteRecords();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const recorder = new TraversalRecorder(sink, Date.now);
  adapter.recorder = recorder;

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const arrived = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(arrived.status, 'succeeded', arrived.summary);
  assert.equal(arrived.data?.outcome, 'ARRIVED');
  assert.ok((arrived.data?.confirmedSegments as number) >= 1);
  recorder.flush();
  const confirmedWrites = writes.length;
  assert.ok(confirmedWrites > 0, '确认到达的实测位移写入 recordWalkCorridor');
  assert.ok(writes.some((entry) => entry.segments > 0), '写入至少一条确认 traversal 段');
  assert.ok(writes.every((entry) => entry.last.x <= 2.6), '写入几何不含计划终点之外的位置');

  // 未确认路线：规划后当前证据阻塞，身体没有确认位移，不应产生 traversal 写入。
  writes.length = 0;
  const blockedMap = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const blockedAdapter = new RecordingAdapter();
  blockedAdapter.pos = { x: 0.5, y: 64, z: 0.5 };
  blockedAdapter.worldId = WORLD; blockedAdapter.sessionId = SESSION; blockedAdapter.dim = DIM;
  clearRouteRecords();
  const blockedCtx = { ...makeCtx(blockedAdapter), spatial: fakeSpatial(blockedMap) };
  t.after(() => blockedCtx.memory.close());
  const blockedRecorder = new TraversalRecorder(sink, Date.now);
  blockedAdapter.recorder = blockedRecorder;
  const plannedBlocked = await planRoute.run(blockedCtx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(plannedBlocked.status, 'succeeded', plannedBlocked.summary);
  blockedMap.observe({
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now() + 1, sequence: 50_000,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: 'stone', properties: {} }, pos: { x: 1, y: 64, z: 0 },
  });
  const blocked = await walkPath.run(blockedCtx, { routeId: String(plannedBlocked.data?.routeId) });
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.data?.outcome, 'BLOCKED');
  assert.equal(blocked.data?.confirmed, false);
  assert.equal(blocked.data?.confirmedSegments, 0);
  blockedRecorder.flush();
  assert.equal(writes.length, 0, '未确认/未移动的路线不写 traversal');
  t.diagnostic(`L2-11 confirmedWrites=${confirmedWrites} confirmedSegments=${arrived.data?.confirmedSegments} unconfirmedWrites=0`);
});

test('L2-12 多段 navigate_to 保留原目标/到达条件/剩余目标' , async (t) => {
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const { w, ctx } = setupWalking(map);
  t.after(() => ctx.memory.close());
  const target = { x: 5, y: 64, z: 0 };
  const doneWhen = { type: 'location_near' as const, dimension: DIM, pos: { x: 5, y: 64, z: 0 }, radius: 0.6 };
  const activity = createActivity({
    what: '分两段走到 x=5', why: '验证跨段保留原目标与到达条件', kind: 'explore', repeat: 1,
    doneWhen,
    steps: [
      { skill: 'navigate_to', args: { ...navArgs(target, { maxSteps: 2 }) } },
      { skill: 'navigate_to', args: { ...navArgs(target, { maxSteps: 8 }) } },
    ],
  }, '', 'llm', w.state());
  const nav = activity.navigation!;
  assert.deepEqual(nav.arrivalCondition, doneWhen, '开工时记录到达条件');

  const firstStep = nextStep(activity)!;
  noteNavigationDispatch(activity, activity.steps[0]!, w.state());
  const first = await navigateTo.run(ctx, navArgs(target, { maxSteps: 2 }));
  assert.equal(first.status, 'failed', first.summary);
  const firstSegment = first.data?.segment as { displacement?: { horizontal: number } };
  assert.ok((firstSegment.displacement?.horizontal ?? 0) > 0, '第一段有实测位移');
  const verdict = afterStep(activity, firstStep, first, 0, w.state());
  assert.equal(verdict.kind, 'continue', '有实测进展的段结束不算整趟失败');
  assert.deepEqual(nav.destination, target, '原目标跨段保留');
  assert.deepEqual(nav.arrivalCondition, doneWhen, '到达条件跨段保留');
  t.diagnostic(`L2-12 remaining=${JSON.stringify(nav.remaining)}`);
  assert.ok(nav.remaining.length > 0, '未到的原目标仍保留剩余目标');
  assert.ok(nav.remaining.every((point) => point.x <= target.x + 0.5), '剩余目标不越过原目的地（格心 5.5）');

  const secondStep = nextStep(activity)!;
  assert.equal(secondStep.skill, 'navigate_to');
  noteNavigationDispatch(activity, activity.steps[1]!, w.state());
  const second = await navigateTo.run(ctx, navArgs(target, { maxSteps: 8 }));
  assert.equal(second.status, 'succeeded', second.summary);
  const done = afterStep(activity, secondStep, second, 0, w.state());
  assert.equal(done.kind, 'done');
  assert.equal(nav.phase, 'arrived');
  assert.deepEqual(nav.destination, target, '到达后仍保留原目标');
  assert.deepEqual(nav.arrivalCondition, doneWhen, '到达后仍保留到达条件');
  assert.deepEqual(nav.remaining, [], '到达后剩余目标清空');
  t.diagnostic(`L2-12 segments=2 destinationX=${nav.destination?.x} arrivalCondition=kept remainingAfterArrival=${nav.remaining.length}`);
});

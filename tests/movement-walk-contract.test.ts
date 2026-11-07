import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap, type ChangeReport, type PathFragment } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { planRoute, walkPath, clearRouteRecords } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';

function flatMap(nameAt: (x: number, y: number, z: number) => string, validityWindowMs = 60_000) {
  const map = new VoxelMap(WORLD, { validityWindowMs });
  let sequence = 0;
  const now = Date.now();
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 4; z++) for (let y = 63; y <= 65; y++) {
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: now, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: nameAt(x, y, z), properties: {} }, pos: { x, y, z },
    });
  }
  return map;
}

/** 离线夹具只模拟库执行环境与只读历史；写入入口显式桩掉，记录调用但不读真实库。 */
function fakeSpatial(map: VoxelMap, fragments: Record<string, PathFragment> = {}) {
  return {
    worldId: WORLD,
    session: {
      voxel: map,
      history: {
        worldId: WORLD,
        getFragment: (id: string) => fragments[id] ?? null,
        fragments: () => ({ items: Object.values(fragments), total: Object.keys(fragments).length }),
      },
    },
    closing: false, paused: false, observationAdmitted: true,
    attach: () => ({}),
    detach: () => {},
    recordWalkCorridor: (input: { fragment: PathFragment; segments: readonly unknown[] }) => ({
      status: 'written' as const, fragmentId: input.fragment.id,
      traversalIds: input.segments.map((_, i) => `offline-${i}`), stancesMarked: input.segments.length, deliveryError: null,
    }),
  } as unknown as SharedSpatialSession;
}

/** 测试用步行身体：按住 forward 时沿当前朝向每帧走一小步。 */
class WalkingAdapter extends FakeAdapter {
  control: Record<string, boolean> = {};
  /** 测试可直接改样本位置，用来制造与 state.pos 不一致的实测偏离。 */
  walkEntity = {
    position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false,
  };
  walkBody() {
    return {
      setControlState: (name: string, value: boolean) => { this.control[name] = value; },
      clearControlStates: () => { for (const k of Object.keys(this.control)) this.control[k] = false; },
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
          const dir = (this.control.forward ? 1 : 0) - (this.control.back ? 1 : 0);
          const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.pos = { ...this.pos, x: this.pos.x + fx * dir * speed, z: this.pos.z + fz * dir * speed };
          this.walkEntity.position = { ...this.pos };
        }
        resolve({
          position: { ...this.walkEntity.position },
          velocity: { ...this.walkEntity.velocity },
          onGround: true,
          isInWater: false,
        });
      }, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
  }
}

function walkingAdapter() {
  const w = new WalkingAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return w;
}

function fragment(id: string, polyline: PathFragment['polyline'], kind: PathFragment['kind'] = 'dug'): PathFragment {
  return { id, worldId: WORLD, dim: DIM, kind, entrances: [], polyline, geometrySource: 'traversal', deepestY: polyline[0]!.y, createdAt: 1000, lastUsedAt: 1000, uses: 1 };
}

/** 捕获执行期的会话附着 receiver，模拟共享会话同步派发 ChangeReport。 */
function attachingSpatial(map: VoxelMap) {
  const captured: { receiver: ((report: ChangeReport) => void) | null } = { receiver: null };
  const spatial = {
    ...(fakeSpatial(map) as unknown as Record<string, unknown>),
    attach: (attachment: { receiver: (report: ChangeReport) => void }) => {
      captured.receiver = attachment.receiver;
      return 1;
    },
    detach: () => {},
  } as unknown as SharedSpatialSession;
  return { captured, spatial };
}

/** 帧源正常交付但身体不移动：用来确认失效必须靠转发报告，而不是最终走到目标。 */
class FrozenAdapter extends WalkingAdapter {
  walkTick() {
    return (signal: AbortSignal) => new Promise<typeof this.walkEntity | null>((resolve) => {
      const timer = setTimeout(() => {
        if (signal.aborted) { resolve(null); return; }
        resolve({
          position: { ...this.walkEntity.position },
          velocity: { ...this.walkEntity.velocity },
          onGround: true,
          isInWater: false,
        });
      }, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
  }
}

const walk = (to: { x: number; y: number; z: number }, source: 'auto' | 'search' | 'history' = 'search', more: Record<string, unknown> = {}) => ({
  to, mode: 'walk' as const, source, arrival: { kind: 'exact' as const }, ...more,
});

const assertedMoved = (w: WalkingAdapter) => assert.notEqual(w.control.forward, true, '拒绝执行时不能按前进键');

test('walk_path 单次消费 routeId，并返回完整终态信封', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);
  const pointCount = (planned.data?.points as unknown[]).length;

  const result = await walkPath.run(ctx, { routeId });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.outcome, 'ARRIVED');
  assert.equal(result.data?.navOutcome, 'ARRIVED');
  assert.equal(result.data?.confirmed, true);
  assert.equal(result.data?.routeKind, 'snapshot');
  assert.equal(result.data?.pathId, null);
  assert.equal(result.data?.backend, 'spatial_library');
  assert.equal(result.data?.confirmedSegments, pointCount - 1);
  assert.deepEqual(result.data?.remainingPoints, []);
  assert.deepEqual(result.data?.consumption, { placed: [] }, 'walk_path 不做挖/放，库的 consumption 必须只有空 placed');
  assert.deepEqual(result.data?.requestedTarget, { x: 2.5, y: 64, z: 0.5 });
  assert.deepEqual(result.data?.resolvedTarget, { x: 2.5, y: 64, z: 0.5 });
  assert.equal(result.data?.invalidation, undefined);
  assert.deepEqual(w.actions, [], '只走已规划路线，不挖/放');

  const positionAfter = { ...w.pos };
  const second = await walkPath.run(ctx, { routeId });
  assert.equal(second.status, 'failed');
  assert.equal(second.data?.outcome, 'INVALIDATED');
  assert.equal((second.data?.invalidation as { reason?: string }).reason, 'route_consumed');
  assert.equal(second.data?.confirmed, false);
  assert.deepEqual(w.pos, positionAfter, '重复 routeId 不得再次执行');
  assertedMoved(w);
});

test('候选计划 executable:false 在执行前拒绝，不写控制', async (t) => {
  const w = walkingAdapter();
  const frag = fragment('frag-candidate', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]);
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), { 'frag-candidate': frag }) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 3.5, y: 64, z: 0.5 }, 'history', { pathId: 'frag-candidate' }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  assert.equal(planned.data?.executable, false);

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'route_invalidated', '库入口把注册表拒绝映射成 route_invalidated');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_not_executable', '注册表 consume 是唯一的可执行性边界');
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.plan, null, '注册表拒绝时没有计划可报');
  assert.equal(result.data?.remainingPoints, undefined);
  assert.equal(result.data?.confirmedSegments, undefined);
  assert.deepEqual(result.data?.consumption, { placed: [] });
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 }, '拒绝执行时身体不动');
  assertedMoved(w);
});

test('过期 routeId 由注册表拒绝，不启动身体', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air', 500)) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_expired');
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 });
  assertedMoved(w);
});

test('session_reset 清空旧 routeId（route_not_found），每个适配器只订阅一次', async (t) => {
  const w = walkingAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const first = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(first.status, 'succeeded', first.summary);
  const firstWalk = await walkPath.run(ctx, { routeId: String(first.data?.routeId) });
  assert.equal(firstWalk.status, 'succeeded', firstWalk.summary);

  const listeners = (w as unknown as { listenerCount(event: string): number }).listenerCount('session_reset');
  assert.equal(listeners, 1, '每个适配器只订阅一次 session_reset');

  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const second = await planRoute.run(ctx, walk({ x: 3.5, y: 64, z: 0.5 }));
  assert.equal(second.status, 'succeeded', second.summary);
  const routeId = String(second.data?.routeId);
  const position = { ...w.pos };

  w.emit('session_reset');
  w.sessionId = `${SESSION}-2`;
  const result = await walkPath.run(ctx, { routeId });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_not_found', '旧会话 routeId 必须直接失效，而不是只在作用域校验时报错');
  assert.deepEqual(w.pos, position);
  assertedMoved(w);
  assert.equal((w as unknown as { listenerCount(event: string): number }).listenerCount('session_reset'), 1, '重复执行不得重复订阅');
});

test('session_reset 即使 sessionId 未变也立即清空 routeId（隔离监听器本身）', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  // 先触发一次 walk_path 入口，让 session_reset 监听器注册；这里不消费真实计划。
  await walkPath.run(ctx, { routeId: 'unknown-route' });
  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);

  // 只发事件、不动 state：若没有监听器，入口作用域对账会看到同一会话并放行。
  w.emit('session_reset');
  const result = await walkPath.run(ctx, { routeId });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_not_found', '监听器必须单独让旧 routeId 失效');
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 });
  assertedMoved(w);
});

test('换维度后旧 routeId 被拒绝，不跨维执行', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  w.dim = 'nether';

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_not_found');
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 });
  assertedMoved(w);
});

test('起点漂移 >0.05 返回 INVALIDATED，不启动身体', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  w.pos = { ...w.pos, x: w.pos.x + 0.2 };

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.invalidation as { reason?: string; segment?: number }).reason, 'route_start_changed');
  assert.equal((result.data?.invalidation as { segment?: number }).segment, 0);
  assert.equal((result.data?.unsupported as { reason?: string }).reason, 'route_start_changed');
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.confirmedSegments, 0);
  assert.deepEqual(w.pos, { x: 0.7, y: 64, z: 0.5 });
  assertedMoved(w);
});

test('历史路线执行用 plan.start 作为 body.feet（0.03 漂移仍可执行）', async (t) => {
  const w = walkingAdapter();
  const frag = fragment('frag-near', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]);
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), { 'frag-near': frag }) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }, 'history', { pathId: 'frag-near' }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  assert.equal(planned.data?.executable, true);
  // 规划后脚位小幅漂移（≤0.05）；执行仍应从 plan.start 出发，否则 startKnownWalkRoute 会以 wrong_start 拒绝。
  w.pos = { ...w.pos, x: w.pos.x + 0.03 };

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.outcome, 'ARRIVED');
  assert.equal(result.data?.routeKind, 'known');
  assert.equal(result.data?.pathId, 'frag-near');
  assert.equal(result.data?.confirmed, true);
  assert.equal(result.data?.confirmedSegments, 2);
  assert.deepEqual(result.data?.remainingPoints, []);
});

test('历史路线执行只用规划快照，规划后改写的 polyline 不会扩展执行几何', async (t) => {
  const w = walkingAdapter();
  const fragments: Record<string, PathFragment> = {
    'frag-short': fragment('frag-short', [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }]),
  };
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air'), fragments) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }, 'history', { pathId: 'frag-short' }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  assert.equal((planned.data?.points as unknown[]).length, 3);

  // 库的 walkPath 只执行消费到的 plan.points 快照；规划后把历史片段改写得更长，执行器也读不到新增点。
  fragments['frag-short'] = fragment('frag-short', [
    { x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 },
    { x: 3.5, y: 64, z: 0.5 }, { x: 4.5, y: 64, z: 0.5 },
  ]);
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.outcome, 'ARRIVED');
  assert.equal(result.data?.confirmedSegments, 2, '只确认规划快照内的 2 段');
  assert.deepEqual(result.data?.remainingPoints, []);
  assert.ok(w.pos.x <= 2.62, `执行不得越过规划末点 2.5：x=${w.pos.x}`);
  assert.deepEqual(w.actions, [], '只走规划快照，不挖/放');
});

test('执行中证据 TTL 失效映射为 INVALIDATED，保留实测位置', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air', 800)) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 4.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal(result.data?.navOutcome, 'FAILED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'route_invalidated');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'route_invalidated');
  assert.equal(result.data?.confirmed, false);
  const position = result.data?.position as { x: number; y: number; z: number } | null | undefined;
  assert.ok(position !== null && position !== undefined && [position.x, position.y, position.z].every((v) => Number.isFinite(v)), '失效时保留有限的实测位置');
  const segments = result.data?.confirmedSegments as number | undefined;
  assert.ok(Number.isInteger(segments) && (segments as number) >= 0, 'confirmedSegments 来自执行器终态的非负整数投影');
});

test('执行中的 ChangeReport 经宿主订阅链转发，立即让路线失效', async (t) => {
  const w = new FrozenAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const { captured, spatial } = attachingSpatial(map);
  const ctx = { ...makeCtx(w), spatial };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 4.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);

  const walking = walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  // 等到第一段真正开始（控制已写、move 在途），再派发报告。
  const waitUntil = Date.now() + 5000;
  while (!w.control.forward && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.control.forward, true, '应先进入单步移动');
  assert.ok(captured.receiver !== null, '执行期应附着共享会话 receiver');

  // 真实地图失效 + 同步派发报告；只有报告能让执行器在控制步之前失效缓存并停下。
  const report = map.markStale(DIM, 'expired');
  captured.receiver(report);

  const result = await walking;
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  const reason = (result.data?.invalidation as { reason?: string } | undefined)?.reason;
  assert.ok(reason === 'route_invalidated' || reason === 'stale', `invalidation.reason=${reason}`);
  assert.equal(result.data?.confirmed, false);
  assert.equal((result.data?.invalidation as { changes?: ChangeReport } | undefined)?.changes?.sections.length, report.sections.length, 'invalidation.changes 保留转发的那份报告');
  assert.equal(w.control.forward, false, '失效后必须松键');
});

test('段级 STALE 证据映射为 INVALIDATED，而不是没路', async (t) => {
  const w = walkingAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);
  // 规划后整段证据被标记 stale：执行器逐段复验应以 stale 终止，而不是当成世界无路。
  map.markStale(DIM, 'expired');

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal(result.data?.navOutcome, 'FAILED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'stale');
  assert.equal((result.data?.invalidation as { reason?: string }).reason, 'stale');
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.confirmedSegments, 0);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 }, '证据失效时不得移动');
  assertedMoved(w);
});

test('执行期样本取 live walkBody 实体：0 段偏离按库语义 INVALIDATED', async (t) => {
  const w = walkingAdapter();
  // 入口起始样本用 state.pos（0.5）通过库的起点复核；执行开始后改用 live 实体（0.9），
  // 尚未确认任何段就偏离起点 → 库 mapped 为 INVALIDATED/deviation，不是到达。
  w.walkEntity.position = { x: 0.9, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'INVALIDATED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'deviation');
  assert.equal((result.data?.invalidation as { reason?: string } | undefined)?.reason, 'deviation');
  assert.equal(result.data?.confirmed, false);
  assert.equal(result.data?.confirmedSegments, 0);
  assert.equal(result.data?.executionId, `exec_${String(planned.data?.routeId)}`, '宿主样本沿用库的稳定执行身份');
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 }, '0 段偏离不得移动');
});

/** 第一段正常走完；第二段开始后故意向 +Z 偏航，用帧源结束触发库的 deviation→PARTIAL。 */
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
          // 第二段：无视朝向往 +Z 走，12 帧后结束帧源，让库在无活动帧时判定 deviation。
          this.secondFrames += 1;
          if (this.secondFrames > 12) { resolve(null); return; }
          if (this.control.forward) {
            this.pos = { ...this.pos, z: this.pos.z + 0.02 };
            this.walkEntity.position = { ...this.pos };
          }
        } else if (this.control.forward || this.control.back) {
          const speed = this.control.sneak ? 0.01 : 0.02;
          const dir = (this.control.forward ? 1 : 0) - (this.control.back ? 1 : 0);
          const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.pos = { ...this.pos, x: this.pos.x + fx * dir * speed, z: this.pos.z + fz * dir * speed };
          this.walkEntity.position = { ...this.pos };
        }
        resolve({
          position: { ...this.walkEntity.position },
          velocity: { ...this.walkEntity.velocity },
          onGround: true,
          isInWater: false,
        });
      }, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
  }
}

test('已确认一段后物理实体偏离路线保留部分进展（PARTIAL，confirmed=false）', async (t) => {
  const w = new DeviatingAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);

  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'PARTIAL', '偏离是部分进展，不是到达也不是失效');
  const kind = (result.data?.problem as { kind?: string } | undefined)?.kind;
  assert.ok(kind === 'deviation' || kind === 'execution_failed', `偏离终态 kind=${kind}`);
  assert.equal(result.data?.confirmed, false);
  assert.ok((result.data?.confirmedSegments as number) >= 1, '至少确认了第一段');
  assert.equal((result.data?.invalidation as { reason?: string } | undefined)?.reason, undefined, 'PARTIAL 不是 INVALIDATED');
  assert.ok(w.pos.z > 0.5, `第二段应偏离到 +Z：z=${w.pos.z}`);
});

test('当前证据阻塞映射为 BLOCKED，不移动', async (t) => {
  const w = walkingAdapter();
  const map = flatMap((_x, y) => y === 63 ? 'stone' : 'air');
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, walk({ x: 2.5, y: 64, z: 0.5 }));
  assert.equal(planned.status, 'succeeded', planned.summary);

  // 规划后把第一步的目的站立格变成石头：执行器复验应报 blocked，不能自行挖开或绕路。
  // +1ms 避免与建图观测落在同一毫秒——同时间戳的冲突内容会被 VoxelMap 判为 STALE，掩盖阻塞事实。
  map.observe({
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now() + 1, sequence: 10_000,
    source: 'vision', evidence: 'seen', stateComplete: true,
    state: { name: 'stone', properties: {} }, pos: { x: 1, y: 64, z: 0 },
  });
  const result = await walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.outcome, 'BLOCKED');
  assert.equal(result.data?.navOutcome, 'BLOCKED');
  assert.equal((result.data?.problem as { kind?: string } | undefined)?.kind, 'blocked');
  assert.equal(result.data?.confirmed, false);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 }, '阻塞时不得自动施工或移动');
  assertedMoved(w);
});

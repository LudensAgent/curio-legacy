/**
 * 真实步行历史 producer 的定向验收：真实安装库、真实公共 walk_route 执行后端、
 * 真实 SharedSpatialSession（SQLite）与现有 prismarine 离线身体。离线夹具不连接
 * Bot/server，也不声称 live 集成通过。
 *
 * 这里验证的是：只有库终态 trace 已确认的段才写 fragment/traversal；几何用原
 * nominal 点列前缀，证据的 from/to/时间/作用域来自实际 move 与 trace；内存写入
 * 成功只表示 accepted_pending_checkpoint，失败不改写真实身体 NavResult。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Vec3 } from 'vec3';
import type { NavResult, Vec3Like } from 'curio-minecraft-3d-memory';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { walkRoute } from '../src/skills/walk-route.ts';
import type { WalkHistoryFailure, WalkHistoryOutcome } from '../src/skills/walk-route.ts';
import { walkTo } from '../src/skills/spatial-navigation.ts';
import { runSkill } from '../src/skills/types.ts';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

const WORLD = 'world';
const DIM = 'overworld';
const SESSION = 's1';
const START = { x: 0.54, y: 0, z: 0.52 };

function flatWorld() {
  return {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      const stateId = p.y <= -1 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
      const block = Block.fromStateId(stateId, 0);
      block.position = p;
      return block;
    },
  };
}

type EntityFrame = {
  position: Vec3Like;
  velocity: Vec3Like;
  onGround: boolean;
  isInWater: boolean;
  yaw: number;
  pitch: number;
};

function snapshot(entity: {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  onGround: boolean;
  isInWater: boolean;
  yaw: number;
  pitch: number;
}): EntityFrame {
  return {
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    velocity: { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z },
    onGround: entity.onGround,
    isInWater: entity.isInWater,
    yaw: entity.yaw,
    pitch: entity.pitch,
  };
}

/**
 * 真实 prismarine 物理身体，50ms 帧延迟以形成 stableMs 窗口。
 * `onFrame` 在帧交付前观察实际状态；`freezeAfterForwardFrames` 让后续帧不再交付
 * （仍由 awaitFrame 的期限/abort 有界唤醒），用于制造未确认半段。
 */
function physicsHarness(opts: {
  start?: Vec3Like;
  onFrame?: (entity: EntityFrame, control: Record<string, boolean>) => void;
  freezeAfterForwardFrames?: number;
} = {}) {
  const start = opts.start ?? START;
  const control: Record<string, boolean> = {
    forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false,
  };
  const entity = {
    position: new Vec3(start.x, start.y, start.z), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false,
    isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    yaw: 0, pitch: 0, effects: {}, attributes: {},
  };
  const bot = {
    version: '1.20.1', entity, control, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) { control[name] = value; },
    clearControlStates() { for (const key of Object.keys(control)) control[key] = false; },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
  };
  const world = flatWorld();
  const physics = Physics(data, world);
  let forwardFrames = 0;
  let frozen = false;
  const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const onAbort = () => { cleanup(); resolve(null); };
    const timer = setTimeout(() => {
      physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
      if (control.forward) forwardFrames++;
      if (opts.freezeAfterForwardFrames !== undefined && forwardFrames > opts.freezeAfterForwardFrames) {
        // 已模拟的帧不再交付；awaitFrame 的期限/abort 会中止本次等待。
        frozen = true;
        return;
      }
      const frame = snapshot(entity);
      cleanup();
      opts.onFrame?.(frame, control);
      resolve(frame);
    }, 50);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const adapter = {
    state: () => ({
      worldId: WORLD, dim: DIM, sessionId: SESSION, alive: true, connected: true, observationReady: true,
      pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    }),
    walkBody: () => ({
      setControlState: (name: string, value: boolean) => bot.setControlState(name, value),
      clearControlStates: () => bot.clearControlStates(),
      look: (yaw: number, pitch: number) => bot.look(yaw, pitch),
      entity: {
        position: entity.position, velocity: entity.velocity,
        onGround: entity.onGround, isInWater: entity.isInWater,
      },
    }),
    walkTick: () => tick,
  } as unknown as GameAdapter;
  return { adapter, entity, control, tick, frozen: () => frozen };
}

/**
 * 通过共享会话公开 observe 写入合成 typed BlockObservation 夹具；请求什么格就写什么格。
 * 这是测试构造的合成感知输入，不声称经过真实 Vision 的视锥/遮挡链。
 */
function makeSenses(svc: SharedSpatialSession) {
  let sequence = 1;
  const observeBlocks = (positions: Vec3Like[]): BlockObservation[] => {
    const observations = positions.map((p): BlockObservation => ({
      name: p.y === -1 ? 'minecraft:stone' : 'minecraft:air',
      properties: {}, stateComplete: true, pos: { x: p.x, y: p.y, z: p.z },
      worldId: WORLD, sessionId: SESSION, dimension: DIM,
      observationId: sequence++, observedAt: Date.now(), source: 'vision',
    }));
    if (observations.length > 0) svc.observe(observations);
    return observations;
  };
  const seed = (xFrom: number, xTo: number, zFrom = -2, zTo = 2): void => {
    const cells: Vec3Like[] = [];
    for (let x = xFrom; x <= xTo; x++)
      for (let z = zFrom; z <= zTo; z++)
        for (let y = -1; y <= 2; y++) cells.push({ x, y, z });
    observeBlocks(cells);
  };
  return { observeBlocks, seed };
}

function context(
  adapter: GameAdapter,
  svc: SharedSpatialSession,
  senses: { observeBlocks(positions: Vec3Like[]): BlockObservation[] },
  opts?: { signal?: AbortSignal; deadline?: number; taskId?: string },
) {
  return {
    adapter, senses, spatial: svc,
    signal: opts?.signal ?? new AbortController().signal,
    deadline: opts?.deadline ?? Date.now() + 20_000,
    taskId: opts?.taskId ?? 'history-task',
    progress() {},
    setStationaryWait() {},
  } as never;
}

type Harness = { svc: SharedSpatialSession; dir: string };

async function openHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-navigation-history-'));
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db') });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  return { svc, dir };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 主错优先的夹具清理：测试体异常原样抛出；真实的 await shutdown 与删除各自捕获次错，
 * 只有确认 close 完成且没有清理问题时才删临时目录。有主错时次错只作诊断并保留路径，
 * 不覆盖原主错；没有主错时才抛出实际清理次错。
 */
async function withHarness(t: TestContext, fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await openHarness();
  let primary: unknown;
  let failed = false;
  try {
    await fn(h);
  } catch (error) {
    failed = true;
    primary = error;
  }
  let shutdown: ShutdownResult | null = null;
  let shutdownFailed = false;
  let shutdownError: unknown = null;
  try {
    shutdown = await h.svc.shutdown();
  } catch (error) {
    shutdownFailed = true;
    shutdownError = error;
  }
  const problems: string[] = [];
  if (shutdownFailed) {
    problems.push(`shutdown threw: ${describe(shutdownError)}`);
  } else if (shutdown === null) {
    problems.push('shutdown returned no result');
  } else {
    if (shutdown.error !== null) problems.push(`save: ${describe(shutdown.error)}`);
    if (shutdown.cancelError !== null) problems.push(`cancel: ${describe(shutdown.cancelError)}`);
    if (shutdown.closeError !== null) problems.push(`close threw: ${describe(shutdown.closeError)}`);
    if (shutdown.close === null) {
      problems.push('close returned no result');
    } else {
      if (!shutdown.close.completed) problems.push('close did not complete');
      if (shutdown.close.error !== null) problems.push(`close: ${describe(shutdown.close.error)}`);
    }
  }
  if (problems.length === 0) {
    try {
      rmSync(h.dir, { recursive: true, force: true });
    } catch (error) {
      problems.push(`remove threw: ${describe(error)}`);
    }
  }
  if (problems.length > 0) {
    if (failed) {
      t.diagnostic(`fixture retained at ${h.dir}; cleanup problems after primary error: ${problems.join(' | ')}`);
    } else {
      throw new Error(`history harness close failed (fixture kept at ${h.dir}): ${problems.join(' | ')}`);
    }
  }
  if (failed) throw primary;
}

function navOf(result: { data?: Record<string, unknown> }): NavResult {
  return result.data?.nav as NavResult;
}

function historyOf(result: { data?: Record<string, unknown> }): WalkHistoryOutcome {
  return result.data?.history as WalkHistoryOutcome;
}

function historyFailureOf(result: { data?: Record<string, unknown> }): WalkHistoryFailure {
  return result.data?.historyFailure as WalkHistoryFailure;
}

test('真实两段步行保存原 nominal 前缀，并以实际 move/trace 逐段写明证据', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    const fixture = physicsHarness();
    const ctx = context(fixture.adapter, h.svc, senses, { taskId: 'task-two-segments' });
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const result = await runSkill(ctx, walkRoute, { points });

    assert.equal(result.status, 'succeeded', result.summary);
    const nav = navOf(result);
    assert.ok(nav.outcome === 'ARRIVED');
    assert.equal(nav.trace.length, 2, '两段都应经真实稳定样本确认');
    assert.equal(nav.memoryWrite, 'pending', '内存接受只投影 pending，不伪称 saved');

    const history = historyOf(result);
    assert.ok(history.status === 'accepted_pending_checkpoint');
    assert.equal(history.traversalIds.length, 2);

    const store = h.svc.session.history;
    const fragment = store.getFragment(history.fragmentId);
    assert.ok(fragment, '已确认段应写入 fragment');
    assert.equal(fragment.kind, 'walked');
    assert.equal(fragment.geometrySource, 'traversal');
    assert.deepEqual(fragment.polyline, points, '折线必须是原 nominal 点列前缀，不舍入/反转/插值');
    assert.equal(fragment.links, undefined, '不得把 nominal 前缀写成实际走过 links');

    const traversals = store.traversals({ fragmentId: history.fragmentId });
    assert.equal(traversals.total, 2);
    for (const [i, evidenceId] of history.traversalIds.entries()) {
      const evidence = store.getTraversal(evidenceId);
      assert.ok(evidence, `第 ${i} 段证据应存在`);
      const trace = nav.trace[i]!;
      assert.deepEqual(evidence.to, trace.pos, 'to 必须来自对应真实 trace');
      assert.equal(evidence.observedAt, trace.ts, '时间必须来自对应真实 trace');
      assert.equal(evidence.worldId, WORLD);
      assert.equal(evidence.dim, DIM);
      assert.equal(evidence.sessionId, SESSION);
      assert.equal(evidence.mode, 'walk');
      assert.equal(evidence.source, 'confirmed_walk_corridor');
      assert.equal(evidence.executionId, `walk-1-step-${i}`, 'executionId 保留库实际值');
      assert.equal(evidence.actionId, 'task-two-segments', 'actionId 保留父任务');
      assert.equal(evidence.fragmentId, history.fragmentId);
    }

    const first = store.getTraversal(history.traversalIds[0]!)!;
    const firstNominal = points[0]!;
    // 实际起点偏离 nominal（0.54,0.52 vs 0.5,0.5），但在原 0.12 容差内。
    const deviation = Math.hypot(first.from.x - firstNominal.x, first.from.z - firstNominal.z);
    assert.ok(deviation > 0.01, `from 必须是实测起点而非 nominal，实际偏差 ${deviation}`);
    assert.ok(deviation <= 0.12, `实测起点应在原容差内，实际偏差 ${deviation}`);
    assert.deepEqual(first.from, { x: START.x, y: first.from.y, z: START.z });

    const second = store.getTraversal(history.traversalIds[1]!)!;
    assert.deepEqual(second.from, nav.trace[0]!.pos, '下一段 from 必须是上一段确认的实测位置');
  });
});

test('同一父任务连续两次一段步行：fragment/traversal ID 不碰撞，真实字段保留', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
    const taskId = 'same-parent-task';

    const runOnce = async () => {
      const fixture = physicsHarness();
      const ctx = context(fixture.adapter, h.svc, senses, { taskId });
      const result = await runSkill(ctx, walkRoute, { points });
      assert.equal(result.status, 'succeeded', result.summary);
      return { nav: navOf(result), history: historyOf(result) };
    };

    const first = await runOnce();
    const second = await runOnce();
    assert.ok(first.history.status === 'accepted_pending_checkpoint');
    assert.ok(second.history.status === 'accepted_pending_checkpoint');
    assert.notEqual(first.history.fragmentId, second.history.fragmentId, '两次调用 fragment ID 必须不同');
    assert.notEqual(first.history.traversalIds[0], second.history.traversalIds[0], '两次调用 traversal ID 必须不同');
    assert.ok(first.history.fragmentId.includes(taskId));
    assert.ok(first.history.traversalIds[0]!.includes(taskId));

    const store = h.svc.session.history;
    const a = store.getTraversal(first.history.traversalIds[0]!)!;
    const b = store.getTraversal(second.history.traversalIds[0]!)!;
    // 两个新 loop 会复用同一库 executionId；唯一性由调用标识承担，而不是改写库值。
    assert.equal(a.executionId, 'walk-1-step-0');
    assert.equal(b.executionId, 'walk-1-step-0');
    assert.equal(a.actionId, taskId);
    assert.equal(b.actionId, taskId);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(a.to, first.nav.trace[0]!.pos);
    assert.deepEqual(b.to, second.nav.trace[0]!.pos);
  });
});

test('首段确认后下一段取消：只保存已确认前缀，未确认位移只在 nav.partial', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    const parent = new AbortController();
    let aborted = false;
    const fixture = physicsHarness({
      onFrame: (entity, control) => {
        if (!aborted && control.forward && entity.position.x > 1.75) {
          aborted = true;
          parent.abort();
        }
      },
    });
    const ctx = context(fixture.adapter, h.svc, senses, { taskId: 'cancel-prefix', signal: parent.signal });
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const result = await runSkill(ctx, walkRoute, { points });

    assert.equal(result.status, 'cancelled', result.summary);
    const nav = navOf(result);
    assert.ok(nav.outcome === 'CANCELLED');
    assert.equal(nav.trace.length, 1, '只有首段被真实确认');
    assert.ok(nav.lastPosition, '取消仍保留实际部分位移');
    assert.ok(nav.lastPosition.x > 1.5, `部分位移应已进入第二段，实际 ${nav.lastPosition.x}`);
    assert.ok(nav.lastPosition.x < 2.5 - 0.12, '部分位移不得伪报到达第二点');

    const history = historyOf(result);
    assert.ok(history.status === 'accepted_pending_checkpoint', '已确认首段是真实走廊，取消后仍应记录');
    assert.equal(history.traversalIds.length, 1);
    const store = h.svc.session.history;
    const fragment = store.getFragment(history.fragmentId)!;
    assert.deepEqual(fragment.polyline, [points[0], points[1]], '只保存已确认前缀，不含未走点');
    const traversals = store.traversals({ fragmentId: history.fragmentId });
    assert.equal(traversals.total, 1);
    assert.deepEqual(traversals.items[0]!.to, nav.trace[0]!.pos);
    assert.equal(traversals.items[0]!.observedAt, nav.trace[0]!.ts);
  });
});

test('未确认半段与零边候选均不写历史，真实末位/零控制事实保留', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    const store = h.svc.session.history;

    // 零边：原完成条件在起点成立，只做真实帧确认；trace[] 且无 fragment/traversal。
    const zeroFixture = physicsHarness();
    const zeroCtx = context(zeroFixture.adapter, h.svc, senses, { taskId: 'zero-edge' });
    const zero = await runSkill(zeroCtx, walkTo, { to: { ...START }, arrival: { kind: 'exact' } });
    assert.equal(zero.status, 'succeeded', zero.summary);
    assert.equal(zero.data?.zeroEdge, true);
    const zeroNav = navOf(zero);
    assert.ok(zeroNav.outcome === 'ARRIVED');
    assert.deepEqual(zeroNav.trace, []);
    assert.deepEqual(historyOf(zero), {
      status: 'not_recorded', traversalIds: [], reason: 'no_confirmed_segment',
    });
    assert.equal(store.fragments().total, 0);
    assert.equal(store.traversals().total, 0);

    // 已发请求但半段始终未确认：移动请求被观察，但 trace 为空，不得造 fragment/traversal。
    const halfFixture = physicsHarness({ freezeAfterForwardFrames: 2 });
    const halfCtx = context(halfFixture.adapter, h.svc, senses, {
      taskId: 'unconfirmed-half', deadline: Date.now() + 10_000,
    });
    const half = await runSkill(halfCtx, walkRoute, {
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
      deadlineMs: Date.now() + 3000,
    });
    assert.equal(half.status, 'failed', half.summary);
    const halfNav = navOf(half);
    assert.ok(halfNav.outcome === 'TIMEOUT');
    assert.deepEqual(halfNav.trace, [], '未确认半段不得进入 trace');
    assert.ok(halfNav.lastPosition, '已发生的部分位移仍保留在 nav');
    assert.ok(halfNav.lastPosition.x > START.x + 0.01);
    assert.ok(halfNav.lastPosition.x < 1.5 - 0.12);
    assert.deepEqual(historyOf(half), {
      status: 'not_recorded', traversalIds: [], reason: 'no_confirmed_segment',
    });
    assert.equal(store.fragments().total, 0);
    assert.equal(store.traversals().total, 0);
    assert.equal(halfNav.memoryWrite, undefined, '没有可保存的确认段时不伪报内存写入状态');
  });
});

test('追加证据失败：不改写身体 NavResult，historyFailure 精确保留阶段与已成功 ID', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    const store = h.svc.session.history;
    const original = store.addTraversal.bind(store);
    let calls = 0;
    store.addTraversal = (evidence) => {
      calls++;
      if (calls === 2) throw new Error('injected traversal capacity');
      return original(evidence);
    };
    try {
      const fixture = physicsHarness();
      const ctx = context(fixture.adapter, h.svc, senses, { taskId: 'write-failure' });
      const points = [
        { x: 0.5, y: 0, z: 0.5 },
        { x: 1.5, y: 0, z: 0.5 },
        { x: 2.5, y: 0, z: 0.5 },
      ];
      const result = await runSkill(ctx, walkRoute, { points });

      // 内存写入失败不改变真实身体结果。
      assert.equal(result.status, 'succeeded', result.summary);
      const nav = navOf(result);
      assert.ok(nav.outcome === 'ARRIVED');
      assert.equal(nav.confirmed, true);
      assert.equal(nav.trace.length, 2);
      assert.equal(nav.memoryWrite, 'failed');

      const history = historyOf(result);
      assert.ok(history.status === 'failed');
      assert.ok(history.fragmentId, '成功后失败仍保留已接受 fragment');
      assert.equal(history.traversalIds.length, 1, '只保留确实成功追加的证据');
      const failure = historyFailureOf(result);
      assert.equal(failure.stage, 'add_traversal');
      assert.match(failure.message, /injected traversal capacity/);
      assert.equal(failure.fragmentId, history.fragmentId);
      assert.deepEqual(failure.traversalIds, history.traversalIds);

      const fragment = store.getFragment(history.fragmentId)!;
      assert.deepEqual(fragment.polyline, points, '已接受 fragment 不回滚');
      assert.ok(store.getTraversal(history.traversalIds[0]!));
      assert.equal(store.traversals({ fragmentId: history.fragmentId }).total, 1);
    } finally {
      Reflect.deleteProperty(store, 'addTraversal');
    }
  });
});

test('关停边界：producer 见 closing 时不写历史，真实 Nav/confirmed prefix 保留', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    const parent = new AbortController();
    const shutdownState: { promise: Promise<ShutdownResult> | null } = { promise: null };
    let triggered = false;
    const fixture = physicsHarness({
      onFrame: (entity, control) => {
        if (!triggered && control.forward && entity.position.x > 1.75) {
          triggered = true;
          // 与宿主关停一样：同步置 closing，再异步收尾；旧步行随后才返回 producer。
          shutdownState.promise = h.svc.shutdown();
          parent.abort();
        }
      },
    });
    const ctx = context(fixture.adapter, h.svc, senses, { taskId: 'closing-boundary', signal: parent.signal });
    const points = [
      { x: 0.5, y: 0, z: 0.5 },
      { x: 1.5, y: 0, z: 0.5 },
      { x: 2.5, y: 0, z: 0.5 },
    ];
    const result = await runSkill(ctx, walkRoute, { points });

    assert.equal(result.status, 'cancelled', result.summary);
    const nav = navOf(result);
    assert.ok(nav.outcome === 'CANCELLED');
    assert.equal(nav.trace.length, 1, '关停前已确认的首段事实保留');
    assert.ok(nav.lastPosition, '关停前实际部分位移保留');
    assert.ok(nav.lastPosition.x > 1.5 && nav.lastPosition.x < 2.5 - 0.12);
    assert.equal(nav.memoryWrite, 'failed');

    const history = historyOf(result);
    assert.ok(history.status === 'failed');
    assert.deepEqual(history.traversalIds, []);
    const failure = historyFailureOf(result);
    assert.equal(failure.stage, 'closed');
    assert.match(failure.message, /closing/);
    assert.deepEqual(failure.traversalIds, []);

    const store = h.svc.session.history;
    assert.equal(store.fragments().total, 0, 'closing 时不得绕过服务关停直接写内存历史');
    assert.equal(store.traversals().total, 0);

    const shutdown = shutdownState.promise;
    assert.ok(shutdown !== null);
    const closed = await shutdown;
    assert.equal(closed.error, null);
    assert.equal(closed.cancelError, null);
    assert.equal(closed.closeError, null);
    assert.ok(closed.close !== null && closed.close.completed);
  });
});

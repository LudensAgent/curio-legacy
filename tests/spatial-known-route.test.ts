/**
 * walk_known_route 的定向验收：真实安装库、真实公共 walk_route 生产的历史 fragment、
 * 真实公开 startKnownWalkRoute 接缝、同一 SharedSpatialSession（SQLite）与现有
 * prismarine 离线身体。离线夹具不连接 Bot/server，也不声称 live 集成通过。
 *
 * 重点验证：选定的历史几何只是路线来源；STARTED 不是到达；实际身体位置由库的强制
 * 样本与既有 grounded 容差验证；太远时真实 deviation 失败且工具不搬移身体；确认前缀
 * 才写本次新历史，原 fragment 只读、不被当作使用成功。
 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Vec3 } from 'vec3';
import type { KnownWalkRouteStart, NavResult, PathFragment, Vec3Like } from 'curio-minecraft-3d-memory';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { walkRoute } from '../src/skills/walk-route.ts';
import type { WalkHistoryFailure, WalkHistoryOutcome } from '../src/skills/walk-route.ts';
import { walkKnownRoute } from '../src/skills/spatial-navigation.ts';
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
};

function snapshot(entity: {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  onGround: boolean;
  isInWater: boolean;
}): EntityFrame {
  return {
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    velocity: { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z },
    onGround: entity.onGround,
    isInWater: entity.isInWater,
  };
}

/**
 * 真实 prismarine 物理身体，50ms 帧延迟。`place` 是测试控制器把夹具身体放回
 * 指定位置的入口（不是导航工具的能力）；`onFrame` 在帧交付前观察实际控制与位置。
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
  let writes = 0;
  let clears = 0;
  const bot = {
    version: '1.20.1', entity, control, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) { writes++; control[name] = value; },
    clearControlStates() { clears++; for (const key of Object.keys(control)) control[key] = false; },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
  };
  const world = flatWorld();
  const physics = Physics(data, world);
  let forwardFrames = 0;
  let frames = 0;
  let frozen = false;
  const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const onAbort = () => { cleanup(); resolve(null); };
    const timer = setTimeout(() => {
      physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
      if (control.forward) forwardFrames++;
      if (opts.freezeAfterForwardFrames !== undefined && forwardFrames > opts.freezeAfterForwardFrames) {
        frozen = true;
        return;
      }
      frames++;
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
  return {
    adapter, entity, control, tick,
    place(next: Vec3Like) {
      bot.clearControlStates();
      entity.position.set(next.x, next.y, next.z);
      entity.velocity.set(0, 0, 0);
      entity.onGround = true;
      entity.isInWater = false;
      forwardFrames = 0;
      frozen = false;
    },
    writes: () => writes,
    clears: () => clears,
    frames: () => frames,
    frozen: () => frozen,
  };
}

/** 通过共享会话公开 observe 写入合成 typed 观测夹具（不声称经过真实 Vision）。 */
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

/** 只读感知：不写地图，用于保持旧 STALE 证据或让测试注入唯一一次真实变化。 */
const blindSenses = { observeBlocks: () => [] as BlockObservation[] };

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
    taskId: opts?.taskId ?? 'known-task',
    progress() {},
    setStationaryWait() {},
  } as never;
}

type Harness = { svc: SharedSpatialSession; dir: string };

async function openHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-known-route-'));
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db') });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  return { svc, dir };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 主错优先的真实清理：await shutdown 与删除次错不覆盖已捕获的主错。 */
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
    if (shutdown.close === null) problems.push('close returned no result');
    else {
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
    if (failed) t.diagnostic(`fixture retained at ${h.dir}; cleanup problems after primary error: ${problems.join(' | ')}`);
    else throw new Error(`known harness close failed (fixture kept at ${h.dir}): ${problems.join(' | ')}`);
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

function knownStartOf(result: { data?: Record<string, unknown> }): KnownWalkRouteStart {
  return result.data?.knownStart as KnownWalkRouteStart;
}

function fragment(id: string, polyline: Vec3Like[], over: Partial<PathFragment> = {}): PathFragment {
  return {
    id, worldId: WORLD, dim: DIM, kind: 'walked', entrances: [], polyline,
    geometrySource: 'legacy', deepestY: Math.min(...polyline.map((p) => p.y)),
    createdAt: 1000, lastUsedAt: 1000, uses: 1, ...over,
  };
}

const THREE_POINTS = [
  { x: 0.5, y: 0, z: 0.5 },
  { x: 1.5, y: 0, z: 0.5 },
  { x: 2.5, y: 0, z: 0.5 },
];

/** 用真实公共 walk_route 生产一条历史 fragment；返回实际生成的 ID 与快照。 */
async function produceFragment(
  h: Harness,
  senses: ReturnType<typeof makeSenses>,
  fixture: ReturnType<typeof physicsHarness>,
  taskId: string,
) {
  const result = await runSkill(context(fixture.adapter, h.svc, senses, { taskId }), walkRoute, { points: THREE_POINTS });
  assert.equal(result.status, 'succeeded', result.summary);
  const history = historyOf(result);
  assert.ok(history.status === 'accepted_pending_checkpoint');
  const stored = h.svc.session.history.getFragment(history.fragmentId);
  assert.ok(stored, 'producer 应写入真实 fragment');
  return { result, history, stored };
}

test('known 回放生产 fragment：同一 loop 真实到达，knownStart 保留原 source，history 使用新 ID', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    const fixture = physicsHarness();
    const produced = await produceFragment(h, senses, fixture, 'producer-task');
    const source = produced.stored;
    const sourceUses = source.uses;
    const sourceLastUsedAt = source.lastUsedAt;

    // 测试控制器把身体放回原首点附近（非零偏差 0.54/0.52 vs nominal 0.5/0.5，仍在原容差内）。
    fixture.place(START);
    const result = await runSkill(
      context(fixture.adapter, h.svc, senses, { taskId: 'known-replay' }),
      walkKnownRoute,
      { fragmentId: source.id },
    );

    assert.equal(result.status, 'succeeded', result.summary);
    const nav = navOf(result);
    assert.ok(nav.outcome === 'ARRIVED');
    assert.equal(nav.trace.length, source.polyline.length - 1, '每个历史段都应由真实样本确认');
    assert.ok(nav.lastPosition);

    const start = knownStartOf(result);
    assert.equal(start.kind, 'STARTED');
    if (start.kind !== 'STARTED') return;
    assert.equal(start.route.fragmentId, source.id, 'knownStart 保留选定 fragment ID');
    assert.deepEqual(start.route.points, source.polyline, '历史折线原序原样成为路线');
    assert.deepEqual(start.route.target, source.polyline[source.polyline.length - 1]);
    assert.equal(start.route.geometrySource, 'traversal', 'producer 的真实来源原样保留');
    assert.equal(start.route.kind, 'walked');
    assert.equal(start.route.parentActionId, 'known-replay');

    assert.deepEqual(result.data?.originalRequest, { fragmentId: source.id });
    assert.deepEqual(result.data?.target, source.polyline[source.polyline.length - 1]);
    assert.deepEqual(result.data?.position, nav.lastPosition, 'position 只投影实际 nav.lastPosition');
    const bodyReference = result.data?.bodyReference as { feet: Vec3Like; measured: boolean } | undefined;
    assert.ok(bodyReference);
    assert.deepEqual(bodyReference.feet, source.polyline[0], 'body.feet 只是路线几何参考');
    assert.equal(bodyReference.measured, false, '不得把 nominal 起点写成实测样本');

    const history = historyOf(result);
    assert.ok(history.status === 'accepted_pending_checkpoint');
    assert.notEqual(history.fragmentId, source.id, '本次真实回放必须写入新的 fragment ID');
    assert.equal(history.traversalIds.length, source.polyline.length - 1);
    const store = h.svc.session.history;
    for (const id of history.traversalIds) {
      assert.ok(id.includes('known-replay'), '新 traversal 归属本次父任务');
      assert.notEqual(id, produced.history.traversalIds[0]);
      const evidence = store.getTraversal(id)!;
      assert.equal(evidence.actionId, 'known-replay');
      assert.ok(evidence.executionId);
      assert.match(evidence.executionId, /^walk-\d+-step-\d+$/, '库原 executionId 原样保留');
    }

    // 读取选定历史不算使用成功：原 fragment 的时间/次数不改。
    const after = store.getFragment(source.id);
    assert.ok(after);
    assert.equal(after.uses, sourceUses);
    assert.equal(after.lastUsedAt, sourceLastUsedAt);
    assert.deepEqual(after.polyline, source.polyline);
    assert.equal(store.fragments().total, 2, '原 fragment 与本次新 fragment 分开保留');

    // 实际发生位移，且到达后全部按键释放。
    assert.ok(fixture.entity.position.x > START.x + 1, `应实际走完历史路线，实际 x=${fixture.entity.position.x}`);
    for (const key of Object.keys(fixture.control)) assert.equal(fixture.control[key], false, `到达后 ${key} 键应释放`);
  });
});

test('known 实际起点太远：按真实 deviation 失败，工具不搬移身体、不写控制', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    const fixture = physicsHarness();
    const produced = await produceFragment(h, senses, fixture, 'producer-far');

    const far = { x: 1.54, y: 0, z: 0.52 };
    fixture.place(far);
    const writesBefore = fixture.writes();
    const result = await runSkill(
      context(fixture.adapter, h.svc, senses, { taskId: 'known-far' }),
      walkKnownRoute,
      { fragmentId: produced.stored.id },
    );

    assert.equal(result.status, 'failed', result.summary);
    const nav = navOf(result);
    assert.ok(nav.outcome === 'FAILED');
    assert.equal(nav.problem.kind, 'deviation', '太远由库的真实 grounded 起点门禁判 deviation');
    assert.equal(nav.trace.length, 0);
    assert.deepEqual(nav.lastPosition, far, '只保留实测位置');
    assert.equal(fixture.entity.position.x, far.x, '工具不得 TP/连接首点');
    assert.equal(fixture.entity.position.y, far.y, '工具不得 TP/连接首点');
    assert.equal(fixture.entity.position.z, far.z, '工具不得 TP/连接首点');
    assert.equal(fixture.writes(), writesBefore, '起点门禁失败不得写任何控制');
    assert.equal(historyOf(result).status, 'not_recorded');
    assert.equal(knownStartOf(result).kind, 'STARTED', '起点偏差是执行失败，不是 helper 拒绝');
    for (const key of Object.keys(fixture.control)) assert.equal(fixture.control[key], false);
  });
});

test('known 拒绝原因原样保留：missing/wrong scope/unsupported geometry/route budget 零控制', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const store = h.svc.session.history;
    store.saveFragment(fragment('wrong-scope', [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }], { dim: 'nether' }));
    store.saveFragment(fragment('diagonal', [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }], { geometrySource: 'observed_structure' }));
    store.saveFragment(fragment('too-long', Array.from({ length: 33 }, (_, i) => ({ x: 0.5 + i, y: 0, z: 0.5 }))));

    const cases: Array<{ id: string; reason: string }> = [
      { id: 'absent', reason: 'missing_history' },
      { id: 'wrong-scope', reason: 'wrong_scope' },
      { id: 'diagonal', reason: 'unsupported_geometry' },
      { id: 'too-long', reason: 'route_budget' },
    ];

    for (const c of cases) {
      const fixture = physicsHarness();
      const senses = makeSenses(h.svc);
      const parent = new AbortController();
      const result = await runSkill(
        context(fixture.adapter, h.svc, senses, { signal: parent.signal, taskId: `reject-${c.id}` }),
        walkKnownRoute,
        { fragmentId: c.id },
      );

      assert.equal(result.status, 'failed', `${c.reason}: 应是失败而不是到达`);
      assert.equal(result.data?.stage, 'REJECTED', c.reason);
      assert.equal(result.data?.reason, c.reason, `${c.reason}: 保留公开 helper 的原 reason`);
      const start = knownStartOf(result);
      assert.equal(start.kind, 'REJECTED', c.reason);
      if (start.kind !== 'REJECTED') continue;
      assert.equal(start.reason, c.reason);
      const nav = navOf(result);
      assert.equal(nav.outcome, 'FAILED', `${c.reason}: 拒绝不是世界 BLOCKED/TIMEOUT/ARRIVED`);
      assert.equal(nav.message, start.message, '原 message 原样保留');
      assert.equal(nav.problem.kind, 'unavailable');
      assert.equal(nav.trace.length, 0);
      assert.equal(historyOf(result).status, 'not_recorded');
      assert.equal(fixture.frames(), 0, `${c.reason}: 不得订阅物理帧`);
      assert.equal(fixture.writes(), 0, `${c.reason}: 不得写控制`);
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0, `${c.reason}: 返回后无残留监听`);
      for (const key of Object.keys(fixture.control)) assert.equal(fixture.control[key], false);
    }
  });
});

test('known 旧 STALE 证据不冒充 OPEN：不启动移动、无假成功', { timeout: 10000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    h.svc.interrupt();
    h.svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    h.svc.session.history.saveFragment(fragment('stale-route', THREE_POINTS));

    const fixture = physicsHarness();
    const result = await runSkill(
      context(fixture.adapter, h.svc, blindSenses, { taskId: 'known-stale', deadline: Date.now() + 1200 }),
      walkKnownRoute,
      { fragmentId: 'stale-route', deadlineMs: Date.now() + 1200 },
    );

    assert.equal(result.status, 'failed', result.summary);
    const nav = navOf(result);
    assert.ok(nav.outcome === 'TIMEOUT' || nav.outcome === 'FAILED');
    assert.notEqual(nav.outcome, 'ARRIVED');
    assert.equal(nav.trace.length, 0, 'STALE 证据不得确认任何段');
    assert.equal(historyOf(result).status, 'not_recorded');
    assert.equal(fixture.writes(), 0, '不得对未验证 OPEN 的历史路线写控制');
    assert.equal(knownStartOf(result).kind, 'STARTED', 'helper 只负责启动；OPEN 由真实执行链判定');
  });
});

test('known 合法观察变化撤销在飞段：不冒充 OPEN，保留已确认前缀与新历史', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    h.svc.session.history.saveFragment(fragment('changed-route', THREE_POINTS));

    let changed = false;
    const fixture = physicsHarness({
      onFrame: (entity, control) => {
        if (changed || !control.forward || entity.position.x < 1.7) return;
        changed = true;
        // 测试注入一次真实方块变化（公开 observe），真实报告会同步送给活动 loop。
        h.svc.observe([{
          name: 'minecraft:air', properties: {}, stateComplete: true, pos: { x: 2, y: -1, z: 0 },
          worldId: WORLD, sessionId: SESSION, dimension: DIM,
          observationId: 7001, observedAt: Date.now(), source: 'vision',
        }]);
      },
    });
    const result = await runSkill(
      context(fixture.adapter, h.svc, blindSenses, { taskId: 'known-changed' }),
      walkKnownRoute,
      { fragmentId: 'changed-route' },
    );

    assert.ok(changed, '测试应在第二段触发一次真实观察变化');
    assert.equal(result.status, 'failed', result.summary);
    const nav = navOf(result);
    assert.notEqual(nav.outcome, 'ARRIVED', '真实观察变化不得冒充到达');
    assert.equal(nav.trace.length, 1, '只保留变化前已确认的首段');
    assert.ok(nav.lastPosition, '保留实际部分位移');
    assert.ok(nav.lastPosition.x < 2.5 - 0.12, '未确认的第二段不得伪报到达末点');
    const history = historyOf(result);
    assert.ok(history.status === 'accepted_pending_checkpoint', '已确认前缀是真实走廊，应记录本次新历史');
    assert.equal(history.traversalIds.length, 1);
    assert.equal(h.svc.session.history.getFragment(history.fragmentId)!.polyline.length, 2);
    for (const key of Object.keys(fixture.control)) assert.equal(fixture.control[key], false, `撤销后 ${key} 键应释放`);
  });
});

test('known 执行中父取消与期限：保留 partial/旧归属，监听与全部键释放', { timeout: 30000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 6);
    const producer = physicsHarness();
    const produced = await produceFragment(h, senses, producer, 'producer-cancel');
    producer.place(START);

    // 父取消：在第二段中途中止，已确认首段写成本次新历史。
    const parent = new AbortController();
    const cancelFixture = physicsHarness({
      onFrame: (entity, control) => {
        if (control.forward && entity.position.x > 1.75) parent.abort();
      },
    });
    const cancelled = await runSkill(
      context(cancelFixture.adapter, h.svc, senses, { signal: parent.signal, taskId: 'known-cancel' }),
      walkKnownRoute,
      { fragmentId: produced.stored.id },
    );
    assert.equal(cancelled.status, 'cancelled', cancelled.summary);
    const cancelNav = navOf(cancelled);
    assert.ok(cancelNav.outcome === 'CANCELLED');
    assert.equal(cancelNav.trace.length, 1);
    assert.ok(cancelNav.lastPosition);
    assert.ok(cancelNav.lastPosition.x > 1.5 && cancelNav.lastPosition.x < 2.5 - 0.12);
    const cancelHistory = historyOf(cancelled);
    assert.ok(cancelHistory.status === 'accepted_pending_checkpoint');
    assert.equal(cancelHistory.traversalIds.length, 1);
    assert.notEqual(cancelHistory.fragmentId, produced.stored.id);
    const cancelEvidence = h.svc.session.history.getTraversal(cancelHistory.traversalIds[0]!)!;
    assert.equal(cancelEvidence.actionId, 'known-cancel', '旧归属保留父任务 ID');
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
    for (const key of Object.keys(cancelFixture.control)) assert.equal(cancelFixture.control[key], false);

    // 期限：身体停止推进帧，按父期限 TIMEOUT，保留已测部分且不伪造确认段。
    const deadlineFixture = physicsHarness({ freezeAfterForwardFrames: 2 });
    const timedOut = await runSkill(
      context(deadlineFixture.adapter, h.svc, senses, { taskId: 'known-deadline', deadline: Date.now() + 2000 }),
      walkKnownRoute,
      { fragmentId: produced.stored.id, deadlineMs: Date.now() + 2000 },
    );
    assert.equal(timedOut.status, 'failed', timedOut.summary);
    const timeoutNav = navOf(timedOut);
    assert.ok(timeoutNav.outcome === 'TIMEOUT');
    assert.equal(timeoutNav.trace.length, 0, '没有经真实稳定样本确认的段');
    assert.ok(timeoutNav.lastPosition, '已发生的部分位移保留');
    assert.ok(timeoutNav.lastPosition.x < 1.5 - 0.12, '未确认半段不得伪报到达首段末点');
    assert.equal(historyOf(timedOut).status, 'not_recorded');
    assert.equal(timeoutNav.memoryWrite, undefined, '没有可保存的确认段时不伪报内存状态');
    for (const key of Object.keys(deadlineFixture.control)) assert.equal(deadlineFixture.control[key], false);
  });
});

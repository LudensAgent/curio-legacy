/**
 * 空间导航集成验收：真实注册的技能、真实 curio-minecraft-3d-memory 公共库、
 * 真实 SharedSpatialSession，以及现有代码/步骤/宏/Arbiter 分发。
 *
 * 离线夹具只提供物理帧与合成观测；不连接 Bot/server，也不声称 live 验收通过。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Vec3 } from 'vec3';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';
import type { TaskOutcome } from '../src/arbiter/arbiter.ts';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { makeBridge, setReliableSkills } from '../src/codeskills/bridge.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { glanceCatalog, moveDetails, movesCatalog } from '../src/mind/prompt.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import { SkillLibrary } from '../src/skills/library.ts';
import { recoveryContext } from '../src/skills/recovery.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import { walkKnownRoute, walkTo } from '../src/skills/spatial-navigation.ts';
import { STANCE_MOVES } from '../src/skills/stance.ts';
import { ok, runSkill, validateSkill, type Skill, type SkillCtx } from '../src/skills/types.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { walkRoute } from '../src/skills/walk-route.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { observeAllBlocks, stubSenses } from './survival-helpers.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

const WORLD = 'world';
const DIM = 'overworld';
const SESSION = 's1';
const START = { x: 0.54, y: 0, z: 0.52 };

const rec = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  return value as Record<string, unknown>;
};

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

type EntityFrame = { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; onGround: boolean; isInWater: boolean };

/** 真实 prismarine 物理身体；50ms 帧延迟用于形成库的 grounded 稳定窗口。 */
function physicsHarness(opts: { freezeAfterForwardFrames?: number } = {}) {
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = {
    position: new Vec3(START.x, START.y, START.z), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false,
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
  let frames = 0;
  const tick = (signal: AbortSignal) => new Promise<EntityFrame | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const onAbort = () => { cleanup(); resolve(null); };
    const timer = setTimeout(() => {
      physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
      if (control.forward) forwardFrames++;
      if (opts.freezeAfterForwardFrames !== undefined && forwardFrames > opts.freezeAfterForwardFrames) { cleanup(); resolve(null); return; }
      frames++;
      const frame: EntityFrame = {
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        velocity: { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z },
        onGround: entity.onGround, isInWater: entity.isInWater,
      };
      cleanup(); resolve(frame);
    }, 50);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const adapter = {
    state: () => ({
      worldId: WORLD, dim: DIM, sessionId: SESSION, alive: true, connected: true, observationReady: true,
      pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      inventory: [],
    }),
    walkBody: () => ({
      setControlState: (name: string, value: boolean) => bot.setControlState(name, value),
      clearControlStates: () => bot.clearControlStates(),
      look: (yaw: number, pitch: number) => bot.look(yaw, pitch),
      entity: { position: entity.position, velocity: entity.velocity, onGround: entity.onGround, isInWater: entity.isInWater },
    }),
    walkTick: () => tick,
  } as unknown as GameAdapter;
  return {
    adapter, entity, control,
    place(next: { x: number; y: number; z: number }) {
      bot.clearControlStates();
      entity.position.set(next.x, next.y, next.z);
      entity.velocity.set(0, 0, 0);
      entity.onGround = true;
      entity.isInWater = false;
      forwardFrames = 0;
    },
    frames: () => frames,
  };
}

/** FakeAdapter 上的脚本步行桥：稳定不动帧，供零边确认与恢复约束测试。 */
function scriptedNavAdapter() {
  const adapter = new FakeAdapter();
  adapter.worldId = WORLD; adapter.dim = DIM; adapter.sessionId = SESSION; adapter.pos = { ...START };
  const position = { ...START };
  let frames = 0, looks = 0, writes = 0;
  (adapter as unknown as { walkBody: () => unknown }).walkBody = () => ({
    setControlState() { writes++; }, clearControlStates() { writes++; }, look() {},
    entity: { position, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false },
  });
  (adapter as unknown as { walkTick: () => (signal: AbortSignal) => Promise<EntityFrame | null> }).walkTick = () => async (signal) => {
    if (signal.aborted) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (signal.aborted) return null;
    frames++;
    return { position: { ...position }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  };
  const look = adapter.look.bind(adapter);
  adapter.look = async (yaw, pitch) => { looks++; await look(yaw, pitch); };
  return { adapter, frames: () => frames, looks: () => looks, writes: () => writes };
}

function block(pos: { x: number; y: number; z: number }, name: string, observedAt: number, observationId: number, properties: Record<string, string | number | boolean> = {}): BlockObservation {
  return { name, properties, worldId: WORLD, sessionId: SESSION, dimension: DIM, source: 'vision', stateComplete: true, observedAt, observationId, pos };
}

/** 合成观测夹具：请求哪些格就写入哪些格；不声称经过真实 Vision 视锥。 */
function makeSenses(svc: SharedSpatialSession) {
  let sequence = 1;
  const observeBlocks = (positions: { x: number; y: number; z: number }[]): BlockObservation[] => {
    const observations = positions.map((p): BlockObservation => ({
      name: p.y === -1 ? 'minecraft:stone' : 'minecraft:air', properties: {}, stateComplete: true, pos: { ...p },
      worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: sequence++, observedAt: Date.now(), source: 'vision',
    }));
    if (observations.length > 0) svc.observe(observations);
    return observations;
  };
  const seed = (xFrom: number, xTo: number, zFrom = -2, zTo = 2): void => {
    const cells: { x: number; y: number; z: number }[] = [];
    for (let x = xFrom; x <= xTo; x++) for (let z = zFrom; z <= zTo; z++) for (let y = -1; y <= 2; y++) cells.push({ x, y, z });
    observeBlocks(cells);
  };
  return { observeBlocks, seed };
}

function context(adapter: GameAdapter, svc: SharedSpatialSession, senses: Pick<SkillCtx['senses'], 'observeBlocks'>, opts: { taskId?: string; deadline?: number; signal?: AbortSignal } = {}): SkillCtx {
  return {
    adapter, senses: senses as SkillCtx['senses'], spatial: svc, memory: new WorldMemory(null), bus: new EventBus(),
    signal: opts.signal ?? new AbortController().signal,
    deadline: opts.deadline ?? Date.now() + 20_000,
    taskId: opts.taskId ?? 'integration-task',
    progress() {}, setStationaryWait() {},
  } as unknown as SkillCtx;
}

async function openHarness(): Promise<{ svc: SharedSpatialSession; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-navigation-integration-'));
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db'), timeoutMs: 5000 });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  return { svc, dir };
}

async function closeHarness(svc: SharedSpatialSession, dir: string): Promise<void> {
  const shutdown: ShutdownResult = await svc.shutdown();
  assert.equal(shutdown.close?.completed, true, '真实 close 必须完成');
  assert.equal(shutdown.close?.error, null);
  assert.equal(shutdown.close?.unconfirmedRequest, false);
  assert.equal(shutdown.close?.dirty, false);
  rmSync(dir, { recursive: true, force: true });
}

async function withHarness(t: TestContext, fn: (h: { svc: SharedSpatialSession; dir: string }) => Promise<void>) {
  const h = await openHarness();
  let primary: unknown;
  let failed = false;
  try { await fn(h); } catch (e) { failed = true; primary = e; }
  try { await closeHarness(h.svc, h.dir); } catch (e) {
    if (!failed) throw e;
    t.diagnostic(`cleanup after primary failure: ${String(e)}`);
  }
  if (failed) throw primary;
}

function partialOf(promise: Promise<unknown>) {
  return promise.then(
    () => assert.fail('本应因取消而拒绝'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error).name, 'AbortedError', String((error as Error).message ?? error));
      return (error as Error & { partial?: Record<string, unknown> }).partial;
    },
  );
}

test('目录与公开契约：两个导航动作注册，静态目录只给名称+用途', () => {
  assert.equal(SKILLS.walk_to, walkTo);
  assert.equal(SKILLS.walk_known_route, walkKnownRoute);
  assert.equal(SKILLS.walk_route, walkRoute);
  assert.equal(SKILLS.spatial_query, spatialQuery);
  assert.ok(SKILLS.goto, '基础 goto 仍开放');

  const catalog = movesCatalog();
  assert.match(catalog, /walk_to（/);
  assert.match(catalog, /walk_known_route（/);
  assert.doesNotMatch(catalog, /"arrival":\{"kind":"exact"\}/);
  const glance = glanceCatalog();
  assert.match(glance, /walk_to（/);
  assert.match(glance, /walk_known_route（/);
  assert.doesNotMatch(glance, /"arrival":\{"kind":"exact"\}/);
  const details = moveDetails(['walk_to', 'walk_known_route']);
  assert.match(details, /"to":\[x,y,z\]/);
  assert.match(details, /"arrival"/);
  assert.match(details, /"fragmentId"/);
  assert.match(moveDetails(['goto']), /goto/, '完整参数仍可按需查询基础动作');

  for (const name of ['step', 'goto', 'descend', 'climb_up', 'follow_passage', 'travel', 'ride', 'walk_to', 'walk_known_route']) {
    assert.ok(STANCE_MOVES.has(name), `${name} 应计为改变站位的移动`);
  }

  const adapter = new FakeAdapter();
  const deadline = 1_720_000_000_000;
  const validated = validateSkill(walkTo, { to: [-1.25, 64, -3.75], arrival: { kind: 'near', radius: 0.125 }, deadlineMs: deadline }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  assert.deepEqual(validated.args.to, { x: -1.25, y: 64, z: -3.75 }, '小数与负数原样保留');
  assert.deepEqual(validated.args.arrival, { kind: 'near', radius: 0.125 });
  assert.equal(validated.args.deadlineMs, deadline);
  assert.equal(validateSkill(walkTo, { to: [0, 64, 0] }, adapter).ok, false, '必须显式 arrival');

  const contextValue = recoveryContext({
    skill: 'walk_to', target: { x: -1.25, y: 64, z: -3.75 }, position: { x: 0.5, y: 0, z: 0.5 },
    args: { to: [-1.25, 64, -3.75], arrival: { kind: 'near', radius: 0.125 }, deadlineMs: deadline },
  });
  assert.ok(!('error' in contextValue));
  if ('error' in contextValue) return;
  assert.deepEqual(contextValue.target, { x: -1.25, y: 64, z: -3.75 });
  assert.deepEqual(contextValue.args.to, { x: -1.25, y: 64, z: -3.75 });
  assert.deepEqual(contextValue.arrival, { kind: 'near', radius: 0.125 });
  assert.equal(contextValue.deadlineMs, deadline, '绝对期限原样保留');

  const known = recoveryContext({ skill: 'walk_known_route', target: { x: -2.5, y: 64, z: -4 }, args: { fragmentId: 'f-目标', deadlineMs: deadline } });
  assert.ok(!('error' in known));
  if ('error' in known) return;
  assert.equal(known.fragmentId, 'f-目标');
  assert.deepEqual(known.target, { x: -2.5, y: 64, z: -4 });
});

test('同一 ctx.spatial/signal/taskId/deadline 穿过真实嵌套查询与导航', { timeout: 30_000 }, async (t) => {
  await withHarness(t, async (h) => {
    const nav = scriptedNavAdapter();
    const ctx = context(nav.adapter, h.svc, stubSenses(nav.adapter), { taskId: 'nested-identity', deadline: Date.now() + 8000 });
    const observed: { spatial: unknown; signal: AbortSignal; taskId: string; deadline: number }[] = [];
    const probe: Skill = {
      name: 'nav_identity_probe', description: '只记录上下文身份', argsDoc: '{}', timeoutMs: 600_000, movement: false, readOnly: true,
      validate: () => ({ ok: true, args: {} }),
      async run(runCtx) { observed.push({ spatial: runCtx.spatial, signal: runCtx.signal, taskId: runCtx.taskId, deadline: runCtx.deadline }); return ok('probe'); },
    };
    SKILLS[probe.name] = probe;
    const code = [
      'const first = await api.act("nav_identity_probe", {});',
      `const query = await api.act("spatial_query", ${JSON.stringify({ kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] })});`,
      `const navigation = await api.act("walk_to", ${JSON.stringify({ to: [START.x, START.y, START.z], arrival: { kind: 'near', radius: 0.5 } })});`,
      'const last = await api.act("nav_identity_probe", {});',
      'return { first, query, navigation, last };',
    ].join('\n');
    const behavior = { name: 'nested-identity-code', description: '查询与零边导航', steps: [], code };
    setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
    t.after(() => { setBehaviorRegistry(null); delete SKILLS[probe.name]; });

    const result = await useSkill.run(ctx, { name: behavior.name });
    assert.equal(result.status, 'succeeded', result.summary);
    const returned = rec(result.data?.result);
    const navigation = rec(returned.navigation);
    assert.equal(navigation.ok, true, String(navigation.summary));
    assert.equal(rec(navigation.data).zeroEdge, true);
    assert.equal(rec(navigation.data).noop, true);
    assert.equal(rec(rec(navigation.data).nav).outcome, 'ARRIVED');
    assert.deepEqual(rec(rec(navigation.data).nav).trace, []);
    assert.ok(rec(rec(returned.query).data).spatialQuery, '查询结果原样保留');
    assert.equal(result.data?.noop, true, '查询与零边成功都不冒充物理效果');
    assert.equal(nav.frames() > 0, true, '零边确认走真实物理帧');

    assert.equal(observed.length, 2);
    for (const entry of observed) {
      assert.equal(entry.spatial, h.svc, '同一共享会话');
      assert.equal(entry.signal, ctx.signal, '同一取消信号');
      assert.equal(entry.taskId, ctx.taskId, '同一父 taskId');
      assert.equal(entry.deadline, ctx.deadline, '同一父期限，未重置预算');
    }

    const steps = {
      name: 'nested-identity-steps', description: '查询/零边步骤', version: 1,
      steps: [
        { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] } },
        { skill: 'walk_to', args: { to: [START.x, START.y, START.z], arrival: { kind: 'near', radius: 0.5 } } },
        { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] } },
      ],
    };
    setBehaviorRegistry({ get: (name) => name === steps.name ? steps : undefined, list: () => [{ name: steps.name }] });
    const stepped = await useSkill.run(ctx, { name: steps.name });
    assert.equal(stepped.status, 'succeeded', stepped.summary);
    assert.equal(stepped.data?.noop, true);
    const stepResults = stepped.data?.stepResults as Record<string, unknown>[];
    assert.equal(stepResults.length, 3, '查询与零边 noop 返回都保留');
    const navStep = rec(rec(stepResults[1]!.data));
    assert.equal(navStep.zeroEdge, true);
    assert.equal(navStep.noop, true);
    assert.deepEqual(rec(navStep.nav).trace, []);

    const library = new SkillLibrary(null, nav.adapter, ctx.memory, ctx.bus);
    const learned = library.learn({ name: 'zero_edge_macro', description: '连续零边确认', steps: [
      { skill: 'walk_to', args: { to: [START.x, START.y, START.z], arrival: { kind: 'near', radius: 0.5 } } },
      { skill: 'walk_to', args: { to: [START.x, START.y, START.z], arrival: { kind: 'near', radius: 0.5 } } },
    ] });
    assert.ok(learned.ok, learned.ok ? '' : learned.error);
    const fragmentsBefore = h.svc.session.history.fragments().total;
    const macro = await runSkill(ctx, SKILLS['macro:zero_edge_macro']!, {});
    assert.equal(macro.status, 'succeeded', macro.summary);
    assert.equal(macro.data?.noop, true, '宏聚合不能把零边成功变成物理移动');
    const macroSteps = macro.data?.stepResults as Record<string, unknown>[];
    assert.equal(macroSteps.length, 2, '零边 noop 成功的真实子结果不被步骤层抹掉');
    for (const entry of macroSteps) {
      const child = rec(entry.data);
      assert.equal(child.zeroEdge, true, '子 walk_to 保留零边语义');
      assert.equal(child.noop, true);
      assert.deepEqual(rec(child.nav).trace, [], '零边子结果保留空 trace');
    }
    assert.equal(h.svc.session.history.fragments().total, fragmentsBefore, '零边成功不写 history');
    assert.equal(nav.writes(), 0, '零边确认不写任何控制键');
  });
});

test('真实 walk_to → 历史查询 → walk_known_route：名义走廊与实测证据分开', { timeout: 45_000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 8);
    const fixture = physicsHarness();
    const ctx = context(fixture.adapter, h.svc, senses, { taskId: 'producer-task', deadline: Date.now() + 20_000 });

    const produced = await runSkill(ctx, walkTo, { to: { x: 2.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.5 } });
    assert.equal(produced.status, 'succeeded', produced.summary);
    const producedHistory = rec(produced.data?.history);
    assert.equal(producedHistory.status, 'accepted_pending_checkpoint');
    const fragmentId = String(producedHistory.fragmentId);
    const store = h.svc.session.history;
    const source = store.getFragment(fragmentId);
    assert.ok(source);
    const sourceUses = source.uses, sourceLastUsedAt = source.lastUsedAt;
    const traversals = store.traversals({ fragmentId });
    assert.equal(traversals.total, (producedHistory.traversalIds as string[]).length);
    assert.ok(traversals.total > 0);

    const producedNav = rec(produced.data?.nav);
    const candidate = rec(produced.data?.candidate);
    const candidatePoints = candidate.points as { x: number; y: number; z: number }[];
    assert.deepEqual(source.polyline, candidatePoints.slice(0, (producedNav.trace as unknown[]).length + 1), 'fragment 是原请求点列的已确认前缀');
    const firstTraversal = rec(store.getTraversal(String((producedHistory.traversalIds as string[])[0])));
    assert.equal(firstTraversal.actionId, 'producer-task');
    const firstTrace = rec((producedNav.trace as Record<string, unknown>[])[0]);
    assert.deepEqual(firstTraversal.to, firstTrace.pos, 'traversal.to 来自对应确认 trace');
    assert.equal(firstTraversal.observedAt, firstTrace.ts);
    assert.equal(firstTraversal.source, 'confirmed_walk_corridor');
    assert.equal(typeof firstTraversal.executionId, 'string', 'executionId 保留实际值');
    assert.equal(source.geometrySource, 'traversal');

    const queryCode = [
      `const list = await api.act("spatial_query", ${JSON.stringify({ kind: 'fragments', dim: DIM, limit: 8 })});`,
      `const geometry = await api.act("spatial_query", ${JSON.stringify({ kind: 'fragment', dim: DIM, fragmentId, field: 'polyline', offset: 0, limit: 32 })});`,
      `const evidence = await api.act("spatial_query", ${JSON.stringify({ kind: 'traversals', dim: DIM, fragmentId, limit: 8 })});`,
      'return { list, geometry, evidence };',
    ].join('\n');
    const queryBehavior = { name: 'history-query-code', description: '查询刚生产的历史', steps: [], code: queryCode };
    setBehaviorRegistry({ get: (name) => name === queryBehavior.name ? queryBehavior : undefined, list: () => [{ name: queryBehavior.name }] });
    const queried = await useSkill.run(ctx, { name: queryBehavior.name });
    assert.equal(queried.status, 'succeeded', queried.summary);
    assert.equal(queried.data?.noop, true, '纯查询成功是 noop，不贡献物理证据');
    const queryResult = rec(queried.data?.result);
    const geometry = rec(rec(rec(queryResult.geometry).data).spatialQuery);
    assert.deepEqual(rec(rec(geometry.fragment).polyline).items, source.polyline, '查询返回原几何顺序');
    const evidenceQuery = rec(rec(rec(queryResult.evidence).data).spatialQuery);
    const evidenceItem = rec((evidenceQuery.items as unknown[])[0]);
    assert.deepEqual(rec(rec(evidenceItem.record).from), firstTraversal.from);
    assert.deepEqual(rec(rec(evidenceItem.record).to), firstTraversal.to);

    // 回到选定路线首点附近（离线夹具的定位，不是导航能力），真实执行已知路线。
    fixture.place(START);
    const knownCtx = context(fixture.adapter, h.svc, senses, { taskId: 'known-replay', deadline: Date.now() + 20_000 });
    const knownCode = `return await api.act("walk_known_route", ${JSON.stringify({ fragmentId })});`;
    const knownBehavior = { name: 'known-route-code', description: '回放刚生产的历史路线', steps: [], code: knownCode };
    setBehaviorRegistry({ get: (name) => name === knownBehavior.name ? knownBehavior : undefined, list: () => [{ name: knownBehavior.name }] });
    const known = await useSkill.run(knownCtx, { name: knownBehavior.name });
    assert.equal(known.status, 'succeeded', known.summary);
    const replay = rec(rec(known.data?.result).data);
    const knownStart = rec(replay.knownStart);
    assert.equal(knownStart.kind, 'STARTED', 'STARTED 不是到达');
    const route = rec(knownStart.route);
    assert.equal(route.fragmentId, fragmentId);
    assert.deepEqual(route.points, source.polyline, '原选定 fragment ID/几何不变');
    assert.deepEqual(route.target, source.polyline[source.polyline.length - 1]);
    const replayNav = rec(replay.nav);
    assert.equal(replayNav.outcome, 'ARRIVED');
    assert.equal(replayNav.confirmed, true);
    assert.equal((replayNav.trace as unknown[]).length, source.polyline.length - 1);
    const replayHistory = rec(replay.history);
    assert.equal(replayHistory.status, 'accepted_pending_checkpoint');
    assert.notEqual(replayHistory.fragmentId, fragmentId, '本次真实执行写新 fragment');
    const bodyReference = rec(replay.bodyReference);
    assert.equal(bodyReference.measured, false, 'nominal body.feet 不是实测样本');
    assert.deepEqual(replay.originalRequest, { fragmentId });
    assert.deepEqual(replay.position, replayNav.lastPosition, 'position 只投影实际 nav.lastPosition');

    const replayFirst = rec(store.getTraversal(String((replayHistory.traversalIds as string[])[0])));
    assert.equal(replayFirst.actionId, 'known-replay');
    const replayTrace = rec((replayNav.trace as Record<string, unknown>[])[0]);
    assert.deepEqual(replayFirst.to, replayTrace.pos, '新 traversal.to 来自本次确认 trace');
    assert.equal(replayFirst.observedAt, replayTrace.ts);
    const after = store.getFragment(fragmentId);
    assert.ok(after);
    assert.equal(after.uses, sourceUses, '读取选定历史不算使用成功');
    assert.equal(after.lastUsedAt, sourceLastUsedAt);
    assert.deepEqual(after.polyline, source.polyline);
  });
});

test('恢复约束：原目标/arrival/fragment/绝对期限不可替换，正向原请求可真实运行', { timeout: 30_000 }, async (t) => {
  await withHarness(t, async (h) => {
    const nav = scriptedNavAdapter();
    const deadline = Date.now() + 60_000;
    const failure = recoveryContext({
      skill: 'walk_to', target: { x: -1.25, y: 64, z: -3.75 },
      args: { to: [-1.25, 64, -3.75], arrival: { kind: 'near', radius: 0.125 }, deadlineMs: deadline },
    });
    assert.ok(!('error' in failure));
    if ('error' in failure) return;
    const ctx = { ...context(nav.adapter, h.svc, stubSenses(nav.adapter), { taskId: 'recovery-walk' }), recovery: failure } as SkillCtx;
    const bridge = makeBridge(ctx);

    const before = { frames: nav.frames(), looks: nav.looks(), actions: nav.adapter.actions.length };
    await assert.rejects(bridge('act', ['walk_to', { to: [-1.25, 64, -3.5], arrival: { kind: 'near', radius: 0.125 } }]), /原绝对目标/);
    await assert.rejects(bridge('act', ['walk_to', { to: [-1.25, 64, -3.75], arrival: { kind: 'near', radius: 0.25 } }]), /原 arrival/);
    await assert.rejects(bridge('act', ['walk_to', { to: [-1.25, 64, -3.75], arrival: { kind: 'exact' } }]), /原 arrival/);
    await assert.rejects(bridge('act', ['walk_to', { to: [-1.25, 64, -3.75], arrival: { kind: 'near', radius: 0.125 }, deadlineMs: deadline + 1 }]), /延长原绝对期限/);
    assert.equal(nav.frames(), before.frames, '拒绝发生在任何物理帧之前');
    assert.equal(nav.looks(), before.looks, '拒绝发生在任何观测之前');
    assert.equal(nav.adapter.actions.length, before.actions, '拒绝发生在任何身体动作之前');

    // 新导航恢复不能用旧寻路/单步/按键/旧路线绕过。
    await assert.rejects(bridge('act', ['goto', { target: '-1,64,-3' }]), /不能用 goto/);
    await assert.rejects(bridge('stepTo', [0, 0, 1]), /不能用 step/);
    await assert.rejects(bridge('act', ['press_keys', { keys: { forward: true }, ms: 100 }]), /不能用 press_keys/);
    await assert.rejects(bridge('act', ['walk_route', { points: [[0.5, 0, 0.5], [1.5, 0, 0.5]] }]), /不能用 walk_route/);
    await assert.rejects(bridge('move', [{ forward: true }, 100]), /不能用 move/);
    // 其它真实注册的直接移动/导航动作同样在身体动作前被拒绝。
    const otherBypasses: [string, unknown][] = [
      ['swim_to', { xyz: [0, 0, 0] }],
      ['travel', { to: '0,0,0' }],
      ['follow_passage', { to: 'entrance' }],
      ['descend', { target: { x: 0, y: 0, z: 0 } }],
      ['climb_up', { height: 1 }],
      ['ride', { to: '0,0' }],
      ['surface', {}],
      ['dive', { xyz: [0, 0, 0] }],
    ];
    for (const [name, args] of otherBypasses) {
      await assert.rejects(bridge('act', [name, args]), new RegExp(`不能用 ${name}`), `${name} 必须在身体动作前拒绝`);
    }
    assert.equal(nav.frames(), before.frames, '新增拒绝也发生在任何物理帧之前');
    assert.equal(nav.looks(), before.looks, '新增拒绝也发生在任何观测之前');
    assert.equal(nav.adapter.actions.length, before.actions, '新增拒绝也发生在任何身体动作之前');
    const moved = await bridge('moveTo', [2, 0, 0, 0]) as { ok: boolean; error?: string };
    assert.equal(moved.ok, false);
    assert.match(moved.error ?? '', /不能用 goto/);

    // 同一原请求可以真实运行：零边确认使用真实物理帧。
    const sameFailure = recoveryContext({ skill: 'walk_to', target: { ...START }, args: { to: [START.x, START.y, START.z], arrival: { kind: 'near', radius: 0.5 }, deadlineMs: Date.now() + 30_000 } });
    assert.ok(!('error' in sameFailure));
    if ('error' in sameFailure) return;
    const sameCtx = { ...context(nav.adapter, h.svc, stubSenses(nav.adapter), { taskId: 'recovery-same' }), recovery: sameFailure } as SkillCtx;
    const framesBefore = nav.frames();
    const same = await makeBridge(sameCtx)('act', ['walk_to', { to: [START.x, START.y, START.z], arrival: { kind: 'near', radius: 0.5 } }]) as { ok: boolean; data?: Record<string, unknown> };
    assert.equal(same.ok, true);
    assert.equal(same.data?.zeroEdge, true);
    assert.ok(nav.frames() > framesBefore, '同一请求执行了真实帧');

    // 缺少原目标/路线时报告缺口，不发明目标或路线。
    const missingTargetCtx = { ...context(nav.adapter, h.svc, stubSenses(nav.adapter)), recovery: { skill: 'walk_to', args: {} } } as SkillCtx;
    await assert.rejects(makeBridge(missingTargetCtx)('act', ['walk_to', { to: [0, 0, 0], arrival: { kind: 'exact' } }]), /缺少原绝对目标/);
    const knownFailure = recoveryContext({ skill: 'walk_known_route', target: { x: 8, y: 0, z: 0 }, args: { fragmentId: 'f-a' } });
    assert.ok(!('error' in knownFailure));
    if ('error' in knownFailure) return;
    const knownCtx = { ...context(nav.adapter, h.svc, stubSenses(nav.adapter)), recovery: knownFailure } as SkillCtx;
    await assert.rejects(makeBridge(knownCtx)('act', ['walk_known_route', { fragmentId: 'f-b' }]), /原 fragmentId/);
    await assert.rejects(makeBridge(knownCtx)('act', ['walk_to', { to: [8, 0, 0], arrival: { kind: 'exact' } }]), /不能改用 walk_to/);

    // 反向：旧动作恢复不能静默切进新导航。
    const gotoRecovery = { ...context(nav.adapter, h.svc, stubSenses(nav.adapter)), recovery: { skill: 'goto', args: {}, target: { x: 2, y: 0, z: 0 } } } as SkillCtx;
    await assert.rejects(makeBridge(gotoRecovery)('act', ['walk_to', { to: [2, 0, 0], arrival: { kind: 'exact' } }]), /不能改用 walk_to/);

    // 非恢复调用保持开放：基础 moveTo/按键/goto 不被新导航限制误伤。
    const open = scriptedNavAdapter();
    const openBridge = makeBridge(context(open.adapter, h.svc, stubSenses(open.adapter)));
    assert.equal((await openBridge('moveTo', [2, 0, 0, 0]) as { ok: boolean }).ok, true);
    assert.equal((await openBridge('move', [{ forward: true }, 50]) as { ok: boolean }).ok, true);
    assert.equal((await openBridge('act', ['goto', { target: '2,0,0' }]) as { ok: boolean }).ok, true);
    assert.equal((await openBridge('act', ['swim_to', { xyz: [2, 0, 0] }]) as { ok: boolean }).ok, true, '非恢复调用仍可执行新的移动动作');

    // 宏名字本身不被一刀切：子步骤仍走同一约束。
    const library = new SkillLibrary(null, nav.adapter, ctx.memory, ctx.bus);
    const badMacro = library.learn({ name: 'recovery_bad_nav', description: '换目标的导航', steps: [
      { skill: 'walk_to', args: { to: [-1.25, 64, -3.5], arrival: { kind: 'near', radius: 0.125 } } },
      { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] } },
    ] });
    assert.ok(badMacro.ok, badMacro.ok ? '' : badMacro.error);
    const blockedMacro = await makeBridge(ctx)('act', ['macro:recovery_bad_nav', {}]) as { ok: boolean; summary: string };
    assert.equal(blockedMacro.ok, false);
    assert.match(blockedMacro.summary, /原绝对目标/);
    const goodMacro = library.learn({ name: 'recovery_query_only', description: '只查询', steps: [
      { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] } },
      { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 1, y: 0, z: 0 }] } },
    ] });
    assert.ok(goodMacro.ok, goodMacro.ok ? '' : goodMacro.error);
    const allowedMacro = await makeBridge(ctx)('act', ['macro:recovery_query_only', {}]) as { ok: boolean };
    assert.equal(allowedMacro.ok, true, '只读宏不被导航恢复一刀切禁止');
  });
});

test('可选导航失败后相对挖掘/放置被阻止，绝对目标仍可执行', { timeout: 30_000 }, async (t) => {
  await withHarness(t, async (h) => {
    const nav = scriptedNavAdapter();
    const senses = { ...stubSenses(nav.adapter), observeBlocks: observeAllBlocks(nav.adapter) };
    const ctx = context(nav.adapter, h.svc, senses, { taskId: 'stance-integration' });
    const failingNavigation = { skill: 'walk_to', args: { to: [1.5, 0, 0.52], arrival: { kind: 'exact' } }, optional: true };
    const relativeDig = { skill: 'dig_at', args: { at: [0, 0, 1], facing: 'E' } };
    const query = { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] } };

    const run = async (name: string, steps: { skill: string; args?: unknown; optional?: boolean }[]) => {
      const behavior = { name, description: name, version: 1, steps };
      setBehaviorRegistry({ get: (candidate) => candidate === name ? behavior : undefined, list: () => [{ name }] });
      return useSkill.run(ctx, { name });
    };
    t.after(() => setBehaviorRegistry(null));

    nav.adapter.actions.length = 0;
    const blockedDig = await run('optional-nav-query-dig', [failingNavigation, query, relativeDig]);
    assert.equal(blockedDig.status, 'failed', blockedDig.summary);
    assert.match(blockedDig.summary, /没到新站位/);
    assert.equal(nav.adapter.actions.filter((a) => a.startsWith('dig')).length, 0, '查询中间步骤不得清掉未解决站位事实');

    nav.adapter.inv.set('cobblestone', 4);
    const blockedPlace = await run('optional-nav-place', [failingNavigation, { skill: 'place_at', args: { at: [0, 0, 1], item: 'cobblestone', facing: 'E' } }]);
    assert.equal(blockedPlace.status, 'failed', blockedPlace.summary);
    assert.match(blockedPlace.summary, /没到新站位/);
    assert.equal(nav.adapter.actions.filter((a) => a.startsWith('place')).length, 0);

    nav.adapter.actions.length = 0;
    const absoluteDig = await run('optional-nav-absolute-dig', [failingNavigation, { skill: 'dig_at', args: { xyz: { x: 0, y: -1, z: 0 }, facing: 'E' } }]);
    assert.equal(absoluteDig.status, 'succeeded', absoluteDig.summary);
    assert.ok(nav.adapter.actions.some((a) => a.startsWith('dig:')), '显式绝对坐标动作仍可执行');

    // 真实注册的只读宏 + 之后 adapter 站位改变：相对动作被拒时仍只引用原失败步骤的实际回执。
    const changed = { x: START.x + 7, y: START.y, z: START.z + 3 };
    const driftName = 'readonly_drift_probe';
    const drift: Skill = {
      name: driftName, description: '测试用：模拟外部使站位发生变化', argsDoc: '{}', timeoutMs: 1000,
      movement: false, readOnly: true,
      validate: () => ({ ok: true, args: {} }),
      async run() { nav.adapter.pos = { ...changed }; return ok('position changed externally'); },
    };
    SKILLS[driftName] = drift;
    t.after(() => { delete SKILLS[driftName]; });
    const library = new SkillLibrary(null, nav.adapter, ctx.memory, ctx.bus);
    const readOnlyMacro = library.learn({ name: 'stance_query_macro', description: '只读查询', steps: [
      query,
      { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 1, y: 0, z: 0 }] } },
    ] });
    assert.ok(readOnlyMacro.ok, readOnlyMacro.ok ? '' : readOnlyMacro.error);
    assert.equal(SKILLS['macro:stance_query_macro']?.readOnly, true, '宏元数据真实注册为只读');
    t.after(() => { delete SKILLS['macro:stance_query_macro']; });

    nav.adapter.pos = { ...START };
    nav.adapter.actions.length = 0;
    const stanceResult = await run('optional-nav-readonly-drift-relative', [
      failingNavigation,
      { skill: 'macro:stance_query_macro' },
      { skill: driftName },
      relativeDig,
    ]);
    assert.equal(stanceResult.status, 'failed', stanceResult.summary);
    assert.match(stanceResult.summary, /没到新站位/);
    assert.ok(stanceResult.summary.includes(`(${START.x.toFixed(2)},${START.y.toFixed(2)},${START.z.toFixed(2)})`), '拒绝报告原回执站位而不是后来改变的站位');
    assert.deepEqual(nav.adapter.state().pos, changed, '拦截时 adapter 站位确实已经改变');
    const prior = rec(stanceResult.data?.priorNavigation);
    assert.equal(prior.skill, 'walk_to');
    assert.equal(prior.step, 1);
    assert.deepEqual(prior.position, { ...START });
    const priorData = rec(prior.data);
    assert.equal(priorData.stage, 'UNSUPPORTED', '保留原失败步骤的实际 stage');
    assert.deepEqual(rec(priorData.originalRequest).to, { x: 1.5, y: 0, z: 0.52 });
    assert.ok(priorData.search, '保留原 search 证据');
    assert.equal(stanceResult.data?.nav, undefined, '旧回执不冒充顶层当前 Nav');
    assert.equal(stanceResult.data?.position, undefined, '旧回执不冒充顶层当前位置');
    const keptSteps = stanceResult.data?.stepResults as Record<string, unknown>[];
    assert.ok(keptSteps.some((entry) => entry.skill === 'macro:stance_query_macro'), '保留只读宏的实际子结果');
    assert.equal(nav.adapter.actions.filter((a) => a.startsWith('dig')).length, 0, '相对挖掘未执行');

    // 绝对目标仍允许，不受站位回执影响。
    const absoluteAfterDrift = await run('optional-nav-absolute-after-drift', [
      failingNavigation,
      { skill: driftName },
      { skill: 'dig_at', args: { xyz: { x: Math.floor(changed.x), y: -1, z: Math.floor(changed.z) }, facing: 'E' } },
    ]);
    assert.equal(absoluteAfterDrift.status, 'succeeded', absoluteAfterDrift.summary);
    assert.ok(nav.adapter.actions.some((a) => a.startsWith('dig:')), '绝对坐标动作仍可执行');
  });
});

test('真实导航取消/失败保留结构化 nav/partial，查询与判定失败保留已有结果', { timeout: 60_000 }, async (t) => {
  await withHarness(t, async (h) => {
    const senses = makeSenses(h.svc);
    senses.seed(-2, 12);

    // api.act：真实执行中的取消带出 nav/partial。
    {
      const fixture = physicsHarness();
      const controller = new AbortController();
      const ctx = context(fixture.adapter, h.svc, senses, { taskId: 'cancel-act', signal: controller.signal, deadline: Date.now() + 20_000 });
      const behavior = { name: 'cancel-act-code', description: '取消中的真实导航', steps: [], code: `return await api.act("walk_to", ${JSON.stringify({ to: { x: 8.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.5 } })});` };
      setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
      const timer = setTimeout(() => controller.abort(), 800);
      try {
        const partial = await partialOf(useSkill.run(ctx, { name: behavior.name }));
        assert.ok(partial, '取消必须保留 partial');
        const nav = rec(partial.nav);
        assert.equal(nav.outcome, 'CANCELLED');
        assert.ok(rec(partial.originalRequest).to, '原请求保留');
        assert.ok(partial.position, '已确认部分位置保留');
      } finally { clearTimeout(timer); }
    }

    // 步骤：真实执行中的取消保留该步 data。
    {
      const fixture = physicsHarness();
      const controller = new AbortController();
      const ctx = context(fixture.adapter, h.svc, senses, { taskId: 'cancel-steps', signal: controller.signal, deadline: Date.now() + 20_000 });
      const behavior = { name: 'cancel-steps', description: '取消中的步骤导航', version: 1, steps: [
        { skill: 'walk_to', args: { to: { x: 8.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.5 } } },
      ] };
      setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
      const timer = setTimeout(() => controller.abort(), 800);
      try {
        const result = await useSkill.run(ctx, { name: behavior.name });
        assert.equal(result.status, 'cancelled');
        assert.equal(rec(rec(result.data).nav).outcome, 'CANCELLED');
      } finally { clearTimeout(timer); }
    }

    // api.useSkill：嵌套调用同样向父层传递真实 partial。
    {
      const fixture = physicsHarness();
      const controller = new AbortController();
      const ctx = context(fixture.adapter, h.svc, senses, { taskId: 'cancel-use-skill', signal: controller.signal, deadline: Date.now() + 20_000 });
      const child = { name: 'cancel-child', description: '嵌套取消', version: 1, steps: [
        { skill: 'walk_to', args: { to: { x: 8.54, y: 0, z: 0.52 }, arrival: { kind: 'near', radius: 0.5 } } },
      ] };
      const behavior = { name: 'cancel-use-skill-code', description: '嵌套真实导航', steps: [], code: 'return await api.useSkill("cancel-child");' };
      setBehaviorRegistry({ get: (name) => name === child.name ? child : name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }, { name: child.name }] });
      setReliableSkills(() => null);
      t.after(() => setReliableSkills(null));
      const timer = setTimeout(() => controller.abort(), 800);
      try {
        const partial = await partialOf(useSkill.run(ctx, { name: behavior.name }));
        assert.ok(partial);
        assert.equal(rec(partial.nav).outcome, 'CANCELLED');
      } finally { clearTimeout(timer); }
    }

    // 普通代码错误：原始错误为主，最近一次真实导航失败只作为上下文回执。
    {
      const nav = scriptedNavAdapter();
      const ctx = context(nav.adapter, h.svc, stubSenses(nav.adapter), { taskId: 'code-error' });
      const behavior = {
        name: 'nav-then-code-error', description: '导航失败后普通抛错', steps: [],
        code: `const r = await api.act("walk_to", ${JSON.stringify({ to: [1.5, 0, 0.52], arrival: { kind: 'exact' } })});\nthrow new Error("later code failure");`,
      };
      setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
      const result = await useSkill.run(ctx, { name: behavior.name });
      assert.equal(result.status, 'failed');
      assert.match(result.summary, /later code failure/, '后续错误保持为主错误');
      const receipt = rec(result.data?.lastNavigationFailure);
      assert.equal(receipt.childSkill, 'walk_to');
      assert.deepEqual(rec(receipt.request).to, [1.5, 0, 0.52]);
      assert.equal(rec(receipt.result).ok, false);
      const receiptData = rec(rec(receipt.result).data);
      assert.equal(receiptData.stage, 'UNSUPPORTED');
      assert.deepEqual(receiptData.target, { x: 1.5, y: 0, z: 0.52 });
      assert.ok(receiptData.search, '实际 search 证据保留');
      assert.match(String(receipt.note), /not the cause of a later code error/);

      // 嵌套 api.useSkill 的导航失败同样保留实际子回执，后续普通错误仍为主错误。
      const child = { name: 'nav-fail-child', description: '子导航失败', version: 1, steps: [
        { skill: 'walk_to', args: { to: [1.5, 0, 0.52], arrival: { kind: 'exact' } } },
      ] };
      const nestedBehavior = {
        name: 'nested-nav-then-error', description: '嵌套导航失败后抛错', steps: [],
        code: 'const r = await api.useSkill("nav-fail-child");\nthrow new Error("after nested nav");',
      };
      setBehaviorRegistry({ get: (name) => name === child.name ? child : name === nestedBehavior.name ? nestedBehavior : undefined, list: () => [{ name: child.name }, { name: nestedBehavior.name }] });
      setReliableSkills(() => null);
      t.after(() => setReliableSkills(null));
      const nestedResult = await useSkill.run(ctx, { name: nestedBehavior.name });
      assert.equal(nestedResult.status, 'failed');
      assert.match(nestedResult.summary, /after nested nav/);
      const nestedReceipt = rec(nestedResult.data?.lastNavigationFailure);
      assert.equal(nestedReceipt.childSkill, 'nav-fail-child');
      assert.equal(rec(rec(nestedReceipt.result).data).stage, 'UNSUPPORTED');
    }

    // 非可选步骤失败保留 nav/knownStart/originalRequest 结构化返回。
    {
      const nav = scriptedNavAdapter();
      const ctx = context(nav.adapter, h.svc, stubSenses(nav.adapter), { taskId: 'step-nav-failure' });
      const behavior = { name: 'step-known-missing', description: '缺失路线', version: 1, steps: [
        { skill: 'walk_known_route', args: { fragmentId: 'missing-fragment' } },
      ] };
      setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
      const result = await useSkill.run(ctx, { name: behavior.name });
      assert.equal(result.status, 'failed');
      assert.deepEqual(result.data?.originalRequest, { fragmentId: 'missing-fragment' });
      assert.ok(result.data?.knownStart, 'knownStart 原样保留');
      assert.ok(result.data?.nav, '执行 NavResult 原样保留');
    }

    // spatial_query result_too_large 穿过步骤失败，不被压成 done。
    {
      h.svc.observe([block({ x: 4, y: 0, z: 0 }, 'minecraft:stone', Date.now(), 900, { blob: 'x'.repeat(70_000) })]);
      const nav = scriptedNavAdapter();
      const ctx = context(nav.adapter, h.svc, stubSenses(nav.adapter), { taskId: 'too-large' });
      const behavior = { name: 'too-large-query', description: '超大查询', version: 1, steps: [
        { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 4, y: 0, z: 0 }] } },
      ] };
      setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
      const result = await useSkill.run(ctx, { name: behavior.name });
      assert.equal(result.status, 'failed');
      const query = rec(result.data?.spatialQuery);
      assert.equal(query.result, 'result_too_large');
      assert.equal(query.truncated, false);
      assert.ok((query.serializedBytes as number) > (query.limitBytes as number));
      assert.ok(Array.isArray(result.data?.done), '聚合 done 仍保留');
    }

    // 最终 verify 失败仍保留已收集的有界 stepResults。
    {
      const nav = scriptedNavAdapter();
      const ctx = context(nav.adapter, h.svc, stubSenses(nav.adapter), { taskId: 'verify-fail' });
      const behavior = { name: 'verify-fail-with-steps', description: '判定失败', version: 1,
        steps: [{ skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 1, y: 0, z: 0 }] } }],
        verify: 'const s = await api.state(); return "not done";' };
      setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
      const result = await useSkill.run(ctx, { name: behavior.name });
      assert.equal(result.status, 'failed');
      assert.match(result.summary, /判定没通过/);
      const steps = result.data?.stepResults as Record<string, unknown>[];
      assert.equal(steps.length, 1);
      assert.ok(rec(rec(steps[0]!.data)).spatialQuery, '判定失败仍保留先前查询结果');
    }
  });
});

test('组合失败保留真实子导航回执：代码子技能与注册宏，普通错误仍是主错误', { timeout: 30_000 }, async (t) => {
  await withHarness(t, async (h) => {
    const nav = scriptedNavAdapter();
    const ctx = context(nav.adapter, h.svc, stubSenses(nav.adapter), { taskId: 'composed-nav-receipts' });
    setReliableSkills(() => null);
    t.after(() => setReliableSkills(null));

    // 真实代码子技能：内部导航失败后普通抛错，只暴露 data.lastNavigationFailure。
    const childName = 'receipt-child-code';
    const child = {
      name: childName, description: '子技能导航失败后抛错', version: 1, steps: [],
      code: `await api.act("walk_to", ${JSON.stringify({ to: [1.5, 0, 0.52], arrival: { kind: 'exact' } })});\nthrow new Error("child ordinary error");`,
    };
    const parentName = 'receipt-parent-code';
    const parent = {
      name: parentName, description: '父技能调用子技能后抛错', version: 1, steps: [],
      code: `await api.useSkill("${childName}");\nthrow new Error("parent ordinary error");`,
    };
    setBehaviorRegistry({ get: (name) => name === childName ? child : name === parentName ? parent : undefined, list: () => [{ name: parentName }] });
    t.after(() => setBehaviorRegistry(null));

    const result = await useSkill.run(ctx, { name: parentName });
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /parent ordinary error/, '父层普通错误保持为主错误');
    const receipt = rec(result.data?.lastNavigationFailure);
    assert.equal(receipt.childSkill, 'walk_to', '保留实际子导航调用身份，而不是代码技能名');
    assert.equal(receipt.via, 'act');
    assert.deepEqual(rec(receipt.request).to, [1.5, 0, 0.52]);
    assert.equal(rec(receipt.result).ok, false);
    const receiptData = rec(rec(receipt.result).data);
    assert.equal(receiptData.stage, 'UNSUPPORTED');
    assert.ok(receiptData.search, '实际 search 证据原样保留');
    assert.match(String(receipt.note), /not the cause of a later code error/);

    // 真实注册宏：子步骤导航失败后父层普通抛错，宏的全部实际返回保留。
    const library = new SkillLibrary(null, nav.adapter, ctx.memory, ctx.bus);
    const learned = library.learn({ name: 'receipt_macro_nav', description: '导航失败的组合', steps: [
      { skill: 'walk_to', args: { to: [1.5, 0, 0.52], arrival: { kind: 'exact' } } },
      { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] } },
    ] });
    assert.ok(learned.ok, learned.ok ? '' : learned.error);
    assert.ok(SKILLS['macro:receipt_macro_nav'], '宏真实注册在 SKILLS');
    t.after(() => { delete SKILLS['macro:receipt_macro_nav']; });

    const macroParentName = 'receipt-macro-parent';
    const macroParent = {
      name: macroParentName, description: '调用失败宏后抛错', version: 1, steps: [],
      code: `await api.act("macro:receipt_macro_nav", {});\nthrow new Error("after macro");`,
    };
    setBehaviorRegistry({ get: (name) => name === macroParentName ? macroParent : undefined, list: () => [{ name: macroParentName }] });
    const macroResult = await useSkill.run(ctx, { name: macroParentName });
    assert.equal(macroResult.status, 'failed');
    assert.match(macroResult.summary, /after macro/, '宏之后的普通错误仍是主错误');
    const macroReceipt = rec(macroResult.data?.lastNavigationFailure);
    assert.equal(macroReceipt.childSkill, 'macro:receipt_macro_nav', '保留实际宏调用身份');
    assert.equal(macroReceipt.via, 'act');
    assert.deepEqual(macroReceipt.request, {});
    const macroData = rec(rec(macroReceipt.result).data);
    assert.equal(macroData.stage, 'UNSUPPORTED');
    assert.deepEqual(rec(macroData.originalRequest).to, { x: 1.5, y: 0, z: 0.52 });
    assert.ok(macroData.search, '宏子步骤的实际导航证据保留');
    assert.match(String(macroReceipt.note), /not the cause of a later code error/);
  });
});

test('Arbiter 直接分发两个导航动作与查询仍走真实注册链', { timeout: 30_000 }, async (t) => {
  await withHarness(t, async (h) => {
    const nav = scriptedNavAdapter();
    const memory = new WorldMemory(null);
    const bus = new EventBus();
    const arbiter = new Arbiter(nav.adapter, memory, bus, new Vision(nav.adapter), h.svc);
    t.after(() => { arbiter.dispose(); memory.close(); });
    const run = (skill: string, args: unknown) => new Promise<TaskOutcome | null>((resolve) => {
      const started = arbiter.start({ skill, args }, 'user');
      assert.ok(!('error' in started), 'register');
      const id = started.id;
      const timer = setTimeout(() => { arbiter.off('done', onDone); resolve(null); }, 15_000);
      const onDone = (outcome: TaskOutcome) => { if (outcome.task.id !== id) return; clearTimeout(timer); arbiter.off('done', onDone); resolve(outcome); };
      arbiter.on('done', onDone);
    });
    const zero = await run('walk_to', { to: [START.x, START.y, START.z], arrival: { kind: 'near', radius: 0.5 } });
    assert.ok(zero !== null);
    assert.equal(zero.result.status, 'succeeded', zero.result.summary);
    assert.equal(rec(zero.result.data).zeroEdge, true);
    assert.equal(rec(zero.result.data).noop, true);
    const query = await run('spatial_query', { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 0, z: 0 }] });
    assert.ok(query !== null);
    assert.equal(query.result.status, 'succeeded');
  });
});

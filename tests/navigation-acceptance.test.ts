import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CANCEL_MOVEMENT_THRESHOLD,
  acceptanceExitCode,
  captureMoveCall,
  classifyAdapterEnd,
  classifyCancellationResult,
  classifyKnownRouteResult,
  classifyPostCancelFrames,
  classifySettledFrames,
  classifyTerminalBody,
  classifyTraversalOwnership,
  classifyWalkToResult,
  controlReleaseProblems,
  fragmentProjectionMatches,
  localBodyCells,
  parseCliArgs,
  parseRconList,
  preflightBotConflict,
  validateFragmentsQuery,
  validateFragmentQuery,
  validateTraversalsQuery,
  type CapturedMove,
  type CapturedRouteSample,
  type PhysicsFrame,
} from '../scripts/navigation-acceptance.ts';
import { WalkMoveExecutor } from '../src/adapter/walk-route.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import type { SkillCtx } from '../src/skills/types.ts';
import type { ExecutableMove } from 'curio-minecraft-3d-memory';

const script = fileURLToPath(new URL('../scripts/navigation-acceptance.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const tolerance = { horizontalTolerance: 0.12, feetTolerance: 0.05 };

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ['--import', tsx, script, ...args], { cwd: path.dirname(script), env, encoding: 'utf8', timeout: 30_000 });
}

function routeSample(taskId: string, nav: Record<string, unknown>, over: Partial<CapturedRouteSample['sample']> = {}): CapturedRouteSample {
  const obs = nav.lastObservation as Record<string, unknown>;
  const sample = {
    executionId: `exec-${taskId}`, sequence: 1, worldId: String(obs.worldId), dim: String(obs.dim), sessionId: String(obs.sessionId),
    observedAt: Number(obs.observedAt), position: { ...(nav.lastPosition as { x: number; y: number; z: number }) },
    onGround: obs.onGround === true, inWater: obs.inWater === true, ...over,
  };
  return {
    taskId, delegationId: sample.executionId, accepted: true, receivedAt: 1, sample,
    returned: {
      delegationId: sample.executionId, lastPosition: { ...sample.position }, nextPointIndex: 2, activeStepIndex: null,
      resultOutcome: 'ARRIVED', resultLastPosition: { ...sample.position }, resultLastObservation: { ...obs },
    },
  };
}

test('--help exits 0 without loading config', () => {
  const env = { ...process.env, CURIO_ROOT: path.join(os.tmpdir(), 'navigation-acceptance-no-such-root') };
  const result = runCli(['--help'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /navigation-acceptance/);
  assert.match(result.stdout, /--curio=test/);
  assert.equal(result.stderr, '');
});

test('CLI rejects missing, non-test, unknown and out-of-lane arguments before runtime imports', () => {
  const root = path.join(os.tmpdir(), 'navigation-acceptance-no-such-root');
  const env = { ...process.env, CURIO_ROOT: root };
  const cases = [
    [[], /--curio=test/],
    [['--curio=live', '--start=200.5,64,216.5'], /only --curio=test/],
    [['--curio=test', '--start=200.5,64,216.5', '--unknown=1'], /unknown argument/],
    [['--curio=test', '--start=199.5,64,216.5'], /outside the reserved dry lane/],
    [['--curio=test', '--start=200.5,63,216.5'], /feet y must be 64/],
    [['--curio=test', '--start=200.5,64,218'], /outside the reserved dry lane/],
    [['--curio=test', '--start=200.5,64'], /x,y,z/],
  ] as const;
  for (const [args, pattern] of cases) {
    const result = runCli([...args], env);
    assert.notEqual(result.status, 0, `expected rejection for ${args.join(' ')}`);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr, /找不到配置文件|ENOENT/);
  }
});

test('parseCliArgs accepts only the explicit test lane start', () => {
  const parsed = parseCliArgs(['--curio=test', '--start=200.5,64,216.5']);
  assert.equal(parsed.ok, true);
  if (parsed.ok && !parsed.help) {
    assert.deepEqual(parsed.start, { x: 200.5, y: 64, z: 216.5 });
    assert.equal(parsed.startRaw, '200.5,64,216.5');
  }
  assert.equal(parseCliArgs(['--curio=test', '--start=200,64,216']).ok, true);
  assert.equal(parseCliArgs(['--curio=test', '--start=219,64,216.5']).ok, false);
});

test('walk_to requires ARRIVED, tolerance, movement and exact same-task sample evidence', () => {
  const start = { x: 200.5, y: 64, z: 216.5 };
  const target = { x: 202.5, y: 64, z: 216.5 };
  const obs = { worldId: 'world', dim: 'overworld', sessionId: 'session', observedAt: 1_000, onGround: true, inWater: false };
  const arrived = { outcome: 'ARRIVED', confirmed: true, lastPosition: { ...target }, lastObservation: obs };
  const result = { status: 'succeeded', summary: 'ok', data: { nav: arrived } };
  assert.equal(classifyWalkToResult(result, start, target, tolerance, { taskId: 't1', samples: [routeSample('t1', arrived)] }).ok, true);
  // 没有真实同任务样本不能 PASS；只靠 NavResult 不够。
  assert.equal(classifyWalkToResult(result, start, target, tolerance).ok, false);
  assert.equal(classifyWalkToResult(result, start, target, tolerance, { taskId: 't1', samples: [] }).ok, false);
  // 样本时间、作用域、任务归属或接受状态不对都不能 PASS（不再有 ±50ms 猜时）。
  const base = routeSample('t1', arrived);
  assert.equal(classifyWalkToResult(result, start, target, tolerance, { taskId: 't1', samples: [routeSample('t1', arrived, { observedAt: 1_040 })] }).ok, false);
  assert.equal(classifyWalkToResult(result, start, target, tolerance, { taskId: 't1', samples: [routeSample('t1', arrived, { sessionId: 'other' })] }).ok, false);
  assert.equal(classifyWalkToResult(result, start, target, tolerance, { taskId: 't1', samples: [{ ...base, taskId: 'other' }] }).ok, false);
  assert.equal(classifyWalkToResult(result, start, target, tolerance, { taskId: 't1', samples: [{ ...base, accepted: false }] }).ok, false);
  // 运行时容差按水平 Math.hypot：单独 x/z 都在 0.12 内，但 hypot 超了也不能算到达。
  const diagonal = { ...arrived, lastPosition: { x: target.x + 0.1, y: target.y, z: target.z + 0.1 } };
  assert.equal(classifyWalkToResult({ ...result, data: { nav: diagonal } }, start, target, tolerance, { taskId: 't1', samples: [routeSample('t1', diagonal)] }).ok, false);
  const notArrived = { ...arrived, outcome: 'PARTIAL', confirmed: false };
  assert.equal(classifyWalkToResult({ ...result, data: { nav: notArrived } }, start, target, tolerance, { taskId: 't1', samples: [routeSample('t1', notArrived)] }).ok, false);
  const noMovement = { ...arrived, lastPosition: { ...start } };
  assert.equal(classifyWalkToResult({ ...result, data: { nav: noMovement } }, start, target, tolerance, { taskId: 't1', samples: [routeSample('t1', noMovement)] }).ok, false);
});

test('known route requires original typed geometry and exact same-task samples', () => {
  const start = { x: 200.5, y: 64, z: 216.5 };
  const points = [{ ...start }, { x: 201.5, y: 64, z: 216.5 }, { x: 202.5, y: 64, z: 216.5 }];
  const obs = { worldId: 'world', dim: 'overworld', sessionId: 'session', observedAt: 2_000, onGround: true, inWater: false };
  const nav = { outcome: 'ARRIVED', confirmed: true, lastPosition: { ...points[2] }, lastObservation: obs };
  const data = { knownStart: { kind: 'STARTED', route: { points: [...points], target: { ...points[2] } } }, nav };
  const result = { status: 'succeeded', summary: 'ok', data };
  assert.equal(classifyKnownRouteResult(result, points, start, tolerance, { taskId: 't2', samples: [routeSample('t2', nav)] }).ok, true);
  assert.equal(classifyKnownRouteResult(result, points, start, tolerance).ok, false);
  const changed = { status: 'succeeded', summary: 'ok', data: { ...data, knownStart: { kind: 'STARTED', route: { points: [...points, { x: 203.5, y: 64, z: 216.5 }], target: { x: 203.5, y: 64, z: 216.5 } } } } };
  assert.equal(classifyKnownRouteResult(changed, points, start, tolerance, { taskId: 't2', samples: [routeSample('t2', nav)] }).ok, false);
  assert.equal(classifyKnownRouteResult({ ...result, data: { ...data, nav: { ...nav, outcome: 'PARTIAL', confirmed: false } } }, points, start, tolerance, { taskId: 't2', samples: [routeSample('t2', nav)] }).ok, false);
});

test('cancellation needs exact same-task partial sample, released controls and real frames', () => {
  const start = { x: 200.5, y: 64, z: 216.5 };
  const obs = { worldId: 'world', dim: 'overworld', sessionId: 'session', observedAt: 3_000, onGround: true, inWater: false };
  const nav = { outcome: 'CANCELLED', confirmed: false, lastPosition: { x: 200.8, y: 64, z: 216.5 }, lastObservation: obs };
  const result = { status: 'cancelled', summary: 'cancelled', data: { nav } };
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const sample = routeSample('t3', nav);
  assert.equal(classifyCancellationResult(result, 't3', [sample], controls, false, start).ok, true);
  assert.equal(classifyCancellationResult(result, 't3', [], controls, false, start).ok, false);
  // 旧的 ±50ms 时间容忍不再接受：时间必须精确等于被接受样本。
  assert.equal(classifyCancellationResult(result, 't3', [routeSample('t3', nav, { observedAt: 3_040 })], controls, false, start).ok, false);
  assert.equal(classifyCancellationResult(result, 't3', [{ ...sample, taskId: 'other' }], controls, false, start).ok, false);
  assert.equal(classifyCancellationResult(result, 't3', [sample], { ...controls, jump: true }, false, start).ok, false);
  assert.equal(classifyCancellationResult(result, 't3', [sample], controls, true, start).ok, false);
  const missingKey = { ...controls } as Record<string, unknown>;
  delete missingKey.sneak;
  assert.equal(classifyCancellationResult(result, 't3', [sample], missingKey, false, start).ok, false);

  // 触发取消与终态分类共用同一阈值：0.16 格的部分位移是有效的取消证据，
  // 0.10 格则不能证明真的动过。
  assert.equal(CANCEL_MOVEMENT_THRESHOLD, 0.15);
  const partial = { ...nav, lastPosition: { x: start.x + 0.16, y: start.y, z: start.z } };
  const partialResult = { status: 'cancelled', summary: 'cancelled', data: { nav: partial } };
  assert.equal(classifyCancellationResult(partialResult, 't3', [routeSample('t3', partial)], controls, false, start).ok, true);
  const tiny = { ...nav, lastPosition: { x: start.x + 0.1, y: start.y, z: start.z } };
  assert.equal(classifyCancellationResult({ status: 'cancelled', summary: 'cancelled', data: { nav: tiny } }, 't3', [routeSample('t3', tiny)], controls, false, start).ok, false);
});

test('settle and post-cancel windows reject zero frames and short frame coverage', () => {
  const frames: PhysicsFrame[] = [
    { frame: 1, at: 0, position: { x: 0, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: false } },
    { frame: 2, at: 350, position: { x: 0, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: false } },
  ];
  assert.equal(classifySettledFrames([], 300).ok, false);
  assert.equal(classifySettledFrames([frames[0]!], 300).ok, false);
  assert.equal(classifySettledFrames(frames, 300).ok, true);
  const moved = [frames[0]!, { ...frames[1]!, position: { x: 0.2, y: 64, z: 0 } }];
  assert.equal(classifySettledFrames(moved, 300).ok, false);
  // 早期残余移动后真正稳定：窗口从稳定段重新开始，必须 PASS 并返回稳定段位置。
  const earlyMotionThenStable: PhysicsFrame[] = [
    { frame: 3, at: 0, position: { x: 0, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: true } },
    { frame: 4, at: 50, position: { x: 0.2, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: true } },
    { frame: 5, at: 100, position: { x: 0.4, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: false } },
    { frame: 6, at: 450, position: { x: 0.4, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: false } },
    { frame: 7, at: 620, position: { x: 0.4, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: false } },
  ];
  const stable = classifySettledFrames(earlyMotionThenStable, 300);
  assert.equal(stable.ok, true);
  assert.deepEqual(stable.position, { x: 0.4, y: 64, z: 0 });
  // 持续移动即使持续到硬上限也不能用墙钟凑出稳定窗口。
  const persistentMotion: PhysicsFrame[] = Array.from({ length: 8 }, (_, i) => ({
    frame: 10 + i, at: i * 100, position: { x: i * 0.2, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: true },
  }));
  assert.equal(classifySettledFrames(persistentMotion, 300).ok, false);
  assert.equal(classifyPostCancelFrames([], 600).ok, false);
  assert.equal(classifyPostCancelFrames(frames, 600).ok, false, 'coverage must span the requested window');
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const long = [{ ...frames[0]!, controls }, { ...frames[1]!, at: 700, controls }];
  assert.equal(classifyPostCancelFrames(long, 600).ok, true);
  assert.equal(classifyPostCancelFrames([long[0]!, { ...long[1]!, controls: { ...controls, forward: true } }], 600).ok, false);
});

test('RCON list validates declared count, separator and duplicate bot before connection', () => {
  assert.deepEqual(parseRconList('There are 0 of a max of 20 players online:').names, []);
  assert.deepEqual(parseRconList('There are 2 of a max of 20 players online: TestBot, Alex').names, ['TestBot', 'Alex']);
  assert.throws(() => parseRconList('There are 1 of a max of 20 players online'), /separator/);
  assert.throws(() => parseRconList('There are 0 of a max of 20 players online: TestBot'), /declared 0 players/);
  assert.throws(() => parseRconList('There are 2 of a max of 20 players online: TestBot'), /declared 2 players but parsed 1/);
  assert.throws(() => parseRconList('There are 1 of a max of 20 players online: TestBot, TestBot'), /declared 1 players but parsed 2/);
  // 其他玩家可以远远旁观：解析保留他们，但不据此发任何命令或移动他们。
  const other = parseRconList('There are 3 of a max of 20 players online: TestBot, Alex, Steve');
  assert.equal(other.names.filter((n) => n === 'TestBot').length, 1);
  assert.deepEqual(other.names.filter((n) => n !== 'TestBot'), ['Alex', 'Steve']);
});

test('preflight rejects any existing configured test bot but allows other names', () => {
  assert.equal(preflightBotConflict([], 'TestBot'), null);
  assert.equal(preflightBotConflict(['Alex', 'Steve'], 'TestBot'), null, 'other players may watch');
  assert.match(preflightBotConflict(['TestBot'], 'TestBot') ?? '', /already listed before connection/);
  assert.match(preflightBotConflict(['Alex', 'TestBot', 'Steve'], 'TestBot') ?? '', /already listed before connection/);
  // 解析器保留 count/name 校验，且不据此分析或移动其他玩家。
  const parsed = parseRconList('There are 2 of a max of 20 players online: TestBot, Alex');
  assert.equal(parsed.count, 2);
  assert.deepEqual(parsed.names, ['TestBot', 'Alex']);
  assert.equal(preflightBotConflict(parsed.names, 'TestBot') !== null, true);
  assert.equal(preflightBotConflict(parsed.names, 'Nobody'), null);
});

test('terminal body must satisfy the same hypot tolerance, grounded/dry/ready scope and released controls', () => {
  const start = { x: 200.5, y: 64, z: 216.5 };
  const target = { x: 202.5, y: 64, z: 216.5 };
  const scope = { worldId: 'world', dim: 'overworld', sessionId: 'session' };
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const state = { pos: { ...target }, onGround: true, inWater: false, observationReady: true, ...scope };
  assert.equal(classifyTerminalBody({ state, controls }, target, tolerance, scope).ok, true);

  // NavResult 说 ARRIVED 但同一时刻的真实身体在容差外：不能 PASS。
  const outside = { ...state, pos: { x: target.x + 0.2, y: target.y, z: target.z } };
  assert.equal(classifyTerminalBody({ state: outside, controls }, target, tolerance, scope).ok, false);
  // 单独 x/z 都小、Math.hypot 超限也不能接受。
  const diagonal = { ...state, pos: { x: target.x + 0.1, y: target.y, z: target.z + 0.1 } };
  assert.equal(classifyTerminalBody({ state: diagonal, controls }, target, tolerance, scope).ok, false);
  assert.equal(classifyTerminalBody({ state: { ...state, onGround: false }, controls }, target, tolerance, scope).ok, false);
  assert.equal(classifyTerminalBody({ state: { ...state, inWater: true }, controls }, target, tolerance, scope).ok, false);
  assert.equal(classifyTerminalBody({ state: { ...state, observationReady: false }, controls }, target, tolerance, scope).ok, false);
  assert.equal(classifyTerminalBody({ state: { ...state, sessionId: 'other' }, controls }, target, tolerance, scope).ok, false);
  // 未释放/不可读的控制键同样失败。
  assert.equal(classifyTerminalBody({ state, controls: { ...controls, forward: true } }, target, tolerance, scope).ok, false);
  const missing = { ...controls } as Record<string, unknown>;
  delete missing.sneak;
  assert.equal(classifyTerminalBody({ state, controls: missing }, target, tolerance, scope).ok, false);
  assert.equal(controlReleaseProblems(controls).length, 0);
});

test('real spatialQuery outputs use counts for listings and full geometry for comparison', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'navigation-acceptance-query-'));
  const world = 'world-acceptance-query', dim = 'overworld', session = 's1';
  const svc = await SharedSpatialSession.open({ worldId: world, databasePath: path.join(dir, 'memory.db'), timeoutMs: 5000 });
  try {
    svc.beginSession({ worldId: world, dim, sessionId: session });
    const history = svc.session.history;
    history.saveFragment({
      id: 'f-real', worldId: world, dim, kind: 'walked', geometrySource: 'traversal',
      polyline: [{ x: 200.5, y: 64, z: 216.5 }, { x: 201.5, y: 64, z: 216.5 }, { x: 202.5, y: 64, z: 216.5 }],
      entrances: [{ x: 200.5, y: 64, z: 216.5 }, { x: 202.5, y: 64, z: 216.5 }],
      links: [{ a: { x: 200.5, y: 64, z: 216.5 }, b: { x: 201.5, y: 64, z: 216.5 } }],
      deepestY: 64, createdAt: 1000, lastUsedAt: 2000, uses: 3,
    });
    const ctx = { spatial: svc, signal: new AbortController().signal, deadline: Date.now() + 3000, taskId: 'query-test', progress() {} } as unknown as SkillCtx;

    const listingResult = await spatialQuery.run(ctx, { kind: 'fragments', dim, limit: 8 } as const);
    assert.equal(listingResult.status, 'succeeded');
    const listing = validateFragmentsQuery((listingResult.data as Record<string, unknown>).spatialQuery);
    assert.equal(listing.ok, true);
    const projection = listing.fragments.find((f) => f.id === 'f-real');
    assert.ok(projection);
    assert.equal(typeof (projection.polyline as Record<string, unknown>).points, 'number', 'listing points is a count, not an array');
    assert.equal(Array.isArray((projection.polyline as Record<string, unknown>).points), false);
    assert.equal(typeof (projection.entrances as Record<string, unknown>).points, 'number');

    const typed = history.getFragment('f-real');
    assert.ok(typed);
    assert.equal(fragmentProjectionMatches(projection, typed).ok, true);
    // 投影一旦被当成数组形状就会失败，而不是悄悄接受错误契约。
    assert.equal(fragmentProjectionMatches({ ...projection, polyline: { points: [{ x: 0, y: 0, z: 0 }] } }, typed).ok, false);

    const fragmentResult = await spatialQuery.run(ctx, { kind: 'fragment', dim, fragmentId: 'f-real', field: 'polyline', offset: 0, limit: 32 } as const);
    const points = validateFragmentQuery((fragmentResult.data as Record<string, unknown>).spatialQuery, 'f-real');
    assert.equal(points.ok, true);
    assert.deepEqual(points.points, typed.polyline);
  } finally {
    const shutdown = await svc.shutdown();
    assert.equal(shutdown.close?.completed, true);
    assert.equal(shutdown.close?.error, null);
    assert.equal(shutdown.close?.dirty, false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spatial query contracts reject missing fields and keep raw records', () => {
  assert.equal(validateFragmentsQuery({}).ok, false);
  assert.equal(validateFragmentsQuery({ fragments: [], page: { after: null, limit: 8, total: 0, returned: 0, scan: 'wrong', scanNote: 'x' } }).ok, false);
  assert.equal(validateFragmentQuery({}, 'f1').ok, false);
  assert.equal(validateFragmentQuery({ found: false, reason: 'missing' }, 'f1').ok, false);
  assert.equal(validateFragmentQuery({ found: true, fragment: { id: 'f1', polyline: { recorded: true, total: 3, offset: 0, returned: 2, items: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 1 }] } } }, 'f1').ok, false);
  assert.equal(validateTraversalsQuery({}, 'f1', { worldId: 'w', dim: 'overworld', sessionId: 's' }).ok, false);
  const record = { id: 't1', fragmentId: 'f1', from: { x: 1, y: 64, z: 1 }, to: { x: 2, y: 64, z: 1 }, worldId: 'w', dim: 'overworld', sessionId: 's', observedAt: 10, source: 'confirmed_walk' };
  assert.equal(validateTraversalsQuery({ items: [{ status: 'found', record }], page: { total: 1, returned: 1, limit: 8 } }, 'f1', { worldId: 'w', dim: 'overworld', sessionId: 's' }).ok, false);
  assert.equal(validateTraversalsQuery({ items: [{ status: 'found', record: { ...record, actionId: 't_1' } }], page: { total: 1, returned: 1, limit: 8 } }, 'f1', { worldId: 'w', dim: 'overworld', sessionId: 's' }).ok, true);
});

test('adapter end classification requires both real observations and cleanup failure stays nonzero', () => {
  assert.equal(classifyAdapterEnd(true, true, false).ok, true);
  assert.equal(classifyAdapterEnd(false, true, false).ok, false);
  assert.equal(classifyAdapterEnd(true, false, false).ok, false);
  assert.equal(classifyAdapterEnd(true, true, true).ok, false);
  assert.equal(acceptanceExitCode(null, [], []), 0);
  assert.equal(acceptanceExitCode(null, [], [{ step: 'adapter-end', error: new Error('x') }]), 1);
  assert.equal(acceptanceExitCode(null, [{ scenario: 's', problem: 'x' }], []), 1);
  assert.equal(acceptanceExitCode(new Error('fatal'), [], []), 1);
});

test('traversal ownership uses the actual walk task and real ExecutableMove requests, not sample ids', async () => {
  const sink: CapturedMove[] = [];
  const invocation = async (taskId: string, executionId: string, from: { x: number; y: number; z: number }) => {
    const controller = new AbortController();
    const controls = new Set<string>();
    const body = {
      setControlState(name: string, value: boolean) { if (value) controls.add(name); else controls.delete(name); },
      clearControlStates() { controls.clear(); },
      look() {},
      entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false },
    };
    // 真实的公开 MoveExecutor 调用：帧源结束会返回 execution_error，足以绑定请求与结果。
    const executor = new WalkMoveExecutor(body, async () => null, controller.signal);
    const request: ExecutableMove = {
      executionId, worldId: 'world', dim: 'overworld', sessionId: 'session',
      from: { ...from }, to: { x: from.x + 1, y: from.y, z: from.z },
      deadlineMs: Date.now() + 5000, timeoutMs: 1000, signal: controller.signal,
    };
    const result = await captureMoveCall(executor, request, taskId, sink);
    return { request, result };
  };

  const from = { x: 200.5, y: 64, z: 216.5 };
  const mine = await invocation('walk-1', 'walk-1-step-0', from);
  // 另一个任务复用/持有不同 executionId；它们的请求不能被借给 walk-1。
  await invocation('walk-2', 'reused-step', { x: 0, y: 64, z: 0 });
  await invocation('walk-2', 'walk-1-step-0', { x: 5, y: 64, z: 5 });
  assert.equal(sink.length, 3);
  assert.equal(sink[0]!.taskId, 'walk-1');
  assert.equal(sink[0]!.request.executionId, 'walk-1-step-0');
  assert.deepEqual(sink[0]!.request.from, from);
  assert.equal((sink[0]!.result?.failure as Record<string, unknown> | undefined)?.kind, 'execution_error');
  // move 结果没有样本；归属仍可由确定性的 onSample/trace 证据成立。
  assert.equal(sink[0]!.result?.sample, undefined);

  const tracePos = { x: 201.4, y: 64, z: 216.5 };
  const nav = {
    outcome: 'ARRIVED', confirmed: true, lastPosition: { ...tracePos },
    lastObservation: { worldId: 'world', dim: 'overworld', sessionId: 'session', observedAt: 9000, onGround: true, inWater: false },
    trace: [{ pos: { ...tracePos }, ts: 9000 }],
  };
  const base = () => ({
    actionId: 'walk-1', executionId: 'walk-1-step-0', from: { ...from }, to: { ...tracePos },
    observedAt: 9000, source: 'confirmed_walk_corridor', mode: 'walk',
  });
  assert.equal(classifyTraversalOwnership(base(), 'walk-1', sink, nav).ok, true);
  // 名义 move 目标不是确认轨迹点：不能用它替代实际观测端点。
  assert.equal(classifyTraversalOwnership({ ...base(), to: { x: mine.request.to.x, y: 64, z: 216.5 } }, 'walk-1', sink, nav).ok, false);
  assert.equal(classifyTraversalOwnership({ ...base(), observedAt: 9001 }, 'walk-1', sink, nav).ok, false);
  assert.equal(classifyTraversalOwnership({ ...base(), from: { x: 200.4, y: 64, z: 216.5 } }, 'walk-1', sink, nav).ok, false);
  // actionId 是另一个任务，或 executionId 只属于另一个任务：都不能冒充 walk-1。
  assert.equal(classifyTraversalOwnership(base(), 'walk-2', sink, nav).ok, false);
  assert.equal(classifyTraversalOwnership({ ...base(), executionId: 'reused-step' }, 'walk-1', sink, nav).ok, false);
  assert.equal(classifyTraversalOwnership({ ...base(), source: 'walk_memory' }, 'walk-1', sink, nav).ok, false);
  assert.equal(classifyTraversalOwnership({ ...base(), mode: 'ride' }, 'walk-1', sink, nav).ok, false);
  assert.equal(classifyTraversalOwnership(null, 'walk-1', sink, nav).ok, false);
});

test('local body cell batch is bounded and centered on the measured feet', () => {
  const cells = localBodyCells({ x: 200.5, y: 64, z: 216.5 }, 1);
  assert.equal(cells.length, 27);
  assert.ok(cells.some((p) => p.x === 200 && p.y === 64 && p.z === 216));
  assert.ok(cells.every((p) => Math.abs(p.x - 200) <= 1 && Math.abs(p.z - 216) <= 1 && p.y >= 63 && p.y <= 65));
});

test('script help does not create run evidence or require a config file', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'navigation-acceptance-'));
  const result = runCli(['--help'], { ...process.env, CURIO_ROOT: directory });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(directory), []);
  rmSync(directory, { recursive: true, force: true });
});

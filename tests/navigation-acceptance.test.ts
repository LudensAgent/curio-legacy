import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Vec3 } from 'vec3';
import {
  CANCEL_MOVEMENT_THRESHOLD,
  acceptanceExitCode,
  classifyAdapterEnd,
  classifyCancellationResult,
  classifyKnownRouteResult,
  classifyPostCancelFrames,
  classifySettledFrames,
  classifyTerminalBody,
  classifyTraversalOwnership,
  classifyWalkToResult,
  controlReleaseProblems,
  initialObservationFacts,
  localBodyCells,
  parseCliArgs,
  parseRconList,
  preflightBotConflict,
  validateQueryPage,
  type CapturedMove,
  type CapturedRouteSample,
  type PhysicsFrame,
} from '../scripts/navigation-acceptance.ts';
import { WalkMoveExecutor } from '../src/adapter/walk-route.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import { runSkill, type SkillCtx } from '../src/skills/types.ts';
import { walkRoute } from '../src/skills/walk-route.ts';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';
import type { ExecutableMove } from 'curio-minecraft-3d-memory';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

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

/** 本文件专用的真实 prismarine 平坦身体（y<=63 为石，脚高 64），只用于 WalkRouteExecutor 证据。 */
function acceptancePhysics() {
  const feet = { x: 200.5, y: 64, z: 216.5 };
  const world = {
    getBlock(position: { floored(): { x: number; y: number; z: number } }) {
      const p = position.floored();
      const stateId = p.y <= 63 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
      const block = Block.fromStateId(stateId, 0);
      block.position = p;
      return block;
    },
  };
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = {
    position: new Vec3(feet.x, feet.y, feet.z), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false,
    isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    yaw: 0, pitch: 0, effects: {}, attributes: {},
  };
  const bot = {
    version: '1.20.1', entity, control, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) { control[name] = value; },
    clearControlStates() { for (const key of Object.keys(control)) control[key] = false; },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
  };
  const physics = Physics(data, world);
  const tick = (signal: AbortSignal) => new Promise<{ position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; onGround: boolean; isInWater: boolean } | null>((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const onAbort = () => { cleanup(); resolve(null); };
    const timer = setTimeout(() => {
      physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
      cleanup();
      resolve({
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        velocity: { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z },
        onGround: entity.onGround, isInWater: entity.isInWater,
      });
    }, 50);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const adapter = {
    state: () => ({
      worldId: 'world', dim: 'overworld', sessionId: 's1', alive: true, connected: true, observationReady: true,
      pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    }),
    walkBody: () => ({
      setControlState: (name: string, value: boolean) => bot.setControlState(name, value),
      clearControlStates: () => bot.clearControlStates(),
      look: (yaw: number, pitch: number) => bot.look(yaw, pitch),
      entity: { position: entity.position, velocity: entity.velocity, onGround: entity.onGround, isInWater: entity.isInWater },
    }),
    walkTick: () => tick,
  } as unknown as GameAdapter;
  return { adapter, feet, cell: (p: { x: number; y: number; z: number }) => p.y === 63 ? 'minecraft:stone' : 'minecraft:air' };
}

function acceptanceSenses(svc: SharedSpatialSession, nameAt: (p: { x: number; y: number; z: number }) => string) {
  let sequence = 1;
  const observeBlocks = (positions: { x: number; y: number; z: number }[]): BlockObservation[] => {
    const observations = positions.map((p): BlockObservation => ({
      name: nameAt(p), properties: {}, worldId: 'world', sessionId: 's1', dimension: 'overworld',
      source: 'vision', stateComplete: true, observedAt: Date.now(), observationId: sequence++, pos: { ...p },
    }));
    if (observations.length > 0) svc.observe(observations);
    return observations;
  };
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = 199; x <= 205; x++) for (let z = 215; z <= 218; z++) for (let y = 62; y <= 66; y++) cells.push({ x, y, z });
  observeBlocks(cells);
  return { observeBlocks, perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };
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

test('settle and post-cancel windows require real consecutive frames, no invented gaps', () => {
  const still = (at: number, frame: number): PhysicsFrame => ({ frame, at, position: { x: 0, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: false } });
  const frames: PhysicsFrame[] = [still(0, 1), still(300, 2)];
  assert.equal(classifySettledFrames([], 300).ok, false);
  assert.equal(classifySettledFrames([frames[0]!], 300).ok, false);
  // 150ms 稳定窗口配 300ms 上限：真实三帧连续窗口成立。
  assert.equal(classifySettledFrames([still(0, 1), still(150, 2), still(300, 3)], 300).ok, true);
  // 缺失帧空档超过 max(50, stableMs) 时不能把两端当成连续稳定。
  assert.equal(classifySettledFrames([still(0, 1), still(100, 2), still(500, 3)], 300).ok, false);
  assert.equal(classifySettledFrames([still(0, 1), still(350, 2)], 300).ok, false, '单段空档超过上限');
  // 真实间隔的稳定帧：相邻间隔都在上限内，窗口自行跨越 stableMs。
  const spaced = classifySettledFrames([still(0, 1), still(300, 2), still(600, 3)], 300);
  assert.equal(spaced.ok, true);
  assert.deepEqual(spaced.position, { x: 0, y: 64, z: 0 });
  // 重复/非递增时间或帧号重置窗口，不能靠重复样本凑时长。
  assert.equal(classifySettledFrames([still(0, 1), still(250, 2), still(250, 3), still(260, 4)], 300).ok, false);
  assert.equal(classifySettledFrames([still(0, 1), still(250, 2), still(100, 3), still(260, 4)], 300).ok, false);
  const moved = [frames[0]!, { ...frames[1]!, position: { x: 0.2, y: 64, z: 0 } }];
  assert.equal(classifySettledFrames(moved, 300).ok, false);
  // 早期残余移动后真正稳定：窗口从稳定段重新开始，必须 PASS 并返回稳定段位置。
  const earlyMotionThenStable: PhysicsFrame[] = [
    { frame: 3, at: 0, position: { x: 0, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: true } },
    { frame: 4, at: 50, position: { x: 0.2, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: true } },
    { frame: 5, at: 100, position: { x: 0.4, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: false } },
    { frame: 6, at: 400, position: { x: 0.4, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: false } },
    { frame: 7, at: 700, position: { x: 0.4, y: 64, z: 0 }, onGround: true, inWater: false, controls: { forward: false } },
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

test('initial observation records actual admitted state separately from Vision output', () => {
  const cells = [{ x: 200, y: 64, z: 216 }];
  const observation = { pos: { x: 200, y: 63, z: 216 }, name: 'minecraft:grass_block' };
  // 有观测返回不等于准入；没有观测返回也不等于未准入。
  const notAdmitted = initialObservationFacts(false, cells, [observation], 1000);
  assert.equal(notAdmitted.admitted, false);
  assert.equal(notAdmitted.vision.returned, 1);
  assert.deepEqual(notAdmitted.vision.observations, [observation]);
  const admitted = initialObservationFacts(true, cells, [], 2000);
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.vision.returned, 0);
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

test('real spatialQuery returns the contract page with full recorded geometry', async () => {
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
    const envelope = listingResult.data as Record<string, unknown>;
    assert.equal(envelope.status, 'ok');
    assert.equal(envelope.contract, 'memory-host-contract/1');
    assert.equal(envelope.worldId, world);
    assert.equal(envelope.readOnly, true);
    assert.equal(envelope.executable, false);
    assert.equal(envelope.total, 1);
    const listing = envelope.data as Record<string, unknown>;
    assert.equal(listing.kind, 'fragments');
    const projection = (listing.items as Record<string, unknown>[]).find((fragment) => fragment.id === 'f-real');
    assert.ok(projection);

    // 契约返回库原样 PathFragment：完整几何数组，不再由宿主换成点数投影。
    const typed = history.getFragment('f-real');
    assert.ok(typed);
    assert.deepEqual(projection.polyline, typed.polyline);
    assert.deepEqual(projection.entrances, typed.entrances);
    assert.equal(projection.geometrySource, 'traversal');
  } finally {
    const shutdown = await svc.shutdown();
    assert.equal(shutdown.close?.completed, true);
    assert.equal(shutdown.close?.error, null);
    assert.equal(shutdown.close?.dirty, false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spatial query envelope validation keeps raw records and rejects old projections', () => {
  assert.equal(validateQueryPage({}, 'fragments').ok, false);
  const page = {
    contract: 'memory-host-contract/1', status: 'ok', readOnly: true, executable: false,
    total: 1, nextAfter: 'f1',
    data: { kind: 'fragments', items: [{ id: 'f1', polyline: [{ x: 1, y: 64, z: 1 }] }], total: 1, nextAfter: 'f1' },
  };
  const checked = validateQueryPage(page, 'fragments');
  assert.equal(checked.ok, true);
  assert.equal(checked.total, 1);
  assert.equal(checked.nextAfter, 'f1');
  assert.deepEqual(checked.items, [{ id: 'f1', polyline: [{ x: 1, y: 64, z: 1 }] }], '列表保留库原样条目');
  assert.equal(validateQueryPage({ ...page, status: 'partial' }, 'fragments').ok, false);
  assert.equal(validateQueryPage({ ...page, contract: 'memory-host-contract/0' }, 'fragments').ok, false);
  assert.equal(validateQueryPage({ ...page, data: { ...page.data, kind: 'traversals' } }, 'fragments').ok, false);
  // 旧投影（fragments/page 与 fragment/field/offset）不再被接受。
  assert.equal(validateQueryPage({ fragments: [], page: { total: 0 } }, 'fragments').ok, false);
  assert.equal(validateQueryPage({ found: true, fragment: { id: 'f1' } }, 'fragments').ok, false);
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

test('traversal ownership pairs actual task dispatch order with the corresponding confirmed trace', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'navigation-acceptance-ownership-'));
  const svc = await SharedSpatialSession.open({ worldId: 'world', databasePath: path.join(dir, 'memory.db'), timeoutMs: 5000 });
  svc.beginSession({ worldId: 'world', dim: 'overworld', sessionId: 's1' });
  const fixture = acceptancePhysics();
  const senses = acceptanceSenses(svc, fixture.cell);
  const taskId = 'walk-real';
  const sink: CapturedMove[] = [];
  const proto = WalkMoveExecutor.prototype as unknown as {
    move(this: unknown, request: ExecutableMove): Promise<{ sample?: unknown; failure?: unknown }>;
  };
  const original = proto.move;
  // 只记录实际派发请求（不依赖 move 返回样本），按真实调用顺序登记该任务归属。
  proto.move = function (this: unknown, request: ExecutableMove) {
    sink.push({
      taskId, receivedAt: Date.now(),
      request: {
        executionId: request.executionId, worldId: request.worldId, dim: request.dim, sessionId: request.sessionId,
        from: { ...request.from }, to: { ...request.to }, deadlineMs: request.deadlineMs, timeoutMs: request.timeoutMs,
      },
      result: null, error: null,
    });
    return original.call(this, request);
  };
  try {
    const points = [
      { x: 200.5, y: 64, z: 216.5 },
      { x: 201.5, y: 64, z: 216.5 },
      { x: 202.5, y: 64, z: 216.5 },
    ];
    const ctx = {
      adapter: fixture.adapter, senses, spatial: svc, signal: new AbortController().signal,
      deadline: Date.now() + 20_000, taskId, progress() {}, setStationaryWait() {},
    } as unknown as SkillCtx;
    const result = await runSkill(ctx, walkRoute, { points });
    assert.equal(result.status, 'succeeded', result.summary);
    const nav = result.data?.nav as Record<string, unknown>;
    assert.equal(nav.confirmed, true);
    const trace = nav.trace as { pos: { x: number; y: number; z: number }; ts: number }[];
    assert.equal(trace.length, 2, '两段都应由真实 onSample 确认');
    assert.equal(sink.length, 2, '真实派发两段 move 请求');
    const history = result.data?.history as { status: string; traversalIds: string[] };
    assert.equal(history.status, 'accepted_pending_checkpoint');
    assert.equal(history.traversalIds.length, 2);
    const store = svc.session.history;

    for (let i = 0; i < 2; i++) {
      const record = store.getTraversal(history.traversalIds[i]!) as unknown as Record<string, unknown>;
      assert.deepEqual(sink[i]!.request.from, record.from, '真实派发顺序与 from 一致');
      assert.equal(classifyTraversalOwnership(record, taskId, sink, nav).ok, true, `第 ${i} 段应归属成功`);
    }
    const first = store.getTraversal(history.traversalIds[0]!) as unknown as Record<string, unknown>;
    const second = store.getTraversal(history.traversalIds[1]!) as unknown as Record<string, unknown>;

    // 跨段混搭：第一段的 executionId/from，配上第二段端点/时间 → 必须拒绝。
    const swapped = { ...first, to: second.to, observedAt: second.observedAt };
    assert.equal(classifyTraversalOwnership(swapped, taskId, sink, nav).ok, false);
    // 只换端点或时间也不能借用任意其它 trace 点。
    assert.equal(classifyTraversalOwnership({ ...first, to: trace[1]!.pos }, taskId, sink, nav).ok, false);
    assert.equal(classifyTraversalOwnership({ ...first, observedAt: trace[1]!.ts }, taskId, sink, nav).ok, false);
    // 名义 move 目标不是确认轨迹点。
    assert.equal(classifyTraversalOwnership({ ...first, to: { ...sink[0]!.request.to } }, taskId, sink, nav).ok, false);
    assert.equal(classifyTraversalOwnership({ ...first, from: { x: 200.4, y: 64, z: 216.5 } }, taskId, sink, nav).ok, false);
    assert.equal(classifyTraversalOwnership({ ...first, worldId: 'other-world' }, taskId, sink, nav).ok, false);
    // 另一个任务 id / 把真实请求改归其它任务：都不能冒充本任务。
    assert.equal(classifyTraversalOwnership(first, 'other-task', sink, nav).ok, false);
    assert.equal(classifyTraversalOwnership(first, taskId, sink.map((m) => ({ ...m, taskId: 'other-task' })), nav).ok, false);
    assert.equal(classifyTraversalOwnership({ ...first, executionId: 'unknown-step' }, taskId, sink, nav).ok, false);
    assert.equal(classifyTraversalOwnership(null, taskId, sink, nav).ok, false);

    // 派发序号超出确认 trace 长度（末尾未确认半段）时不能借用已有 trace。
    const viaNav = { ...second, executionId: sink[1]!.request.executionId, to: trace[0]!.pos, observedAt: trace[0]!.ts };
    assert.equal(classifyTraversalOwnership(viaNav, taskId, sink, { ...nav, trace: [trace[0]!] }).ok, false);
    // move 返回没有样本仍能通过：本用例的 sink.result 全为 null。
    assert.equal(sink.every((move) => move.result === null), true);
  } finally {
    proto.move = original;
    const shutdown = await svc.shutdown();
    assert.equal(shutdown.close?.completed, true);
    assert.equal(shutdown.close?.error, null);
    assert.equal(shutdown.close?.dirty, false);
    rmSync(dir, { recursive: true, force: true });
  }
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

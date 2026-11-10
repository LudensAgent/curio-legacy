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
  classifyAdapterEnd,
  classifyCancellationResult,
  classifyPostCancelFrames,
  classifySettledFrames,
  classifyTerminalBody,
  classifyWalkToResult,
  controlReleaseProblems,
  initialObservationFacts,
  localBodyCells,
  parseCliArgs,
  parseRconList,
  preflightBotConflict,
  validateQueryPage,
  type PhysicsFrame,
} from '../scripts/navigation-acceptance.ts';

const script = fileURLToPath(new URL('../scripts/navigation-acceptance.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const tolerance = { horizontalTolerance: 0.12, feetTolerance: 0.05 };

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ['--import', tsx, script, ...args], { cwd: path.dirname(script), env, encoding: 'utf8', timeout: 30_000 });
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

test('navigate_to requires succeeded ARRIVED/confirmed, measured movement and runtime tolerance', () => {
  const start = { x: 200.5, y: 64, z: 216.5 };
  const target = { x: 202.5, y: 64, z: 216.5 };
  const nav = { outcome: 'ARRIVED', confirmed: true, lastPosition: { ...target } };
  const result = { status: 'succeeded', summary: 'ok', data: { nav } };
  assert.equal(classifyWalkToResult(result, start, target, tolerance).ok, true);
  // 当前 navigate_to 回执没有 data.nav 时，从真实字段构造只读视图。
  const current = { status: 'succeeded', summary: 'ok', data: { arrived: true, position: { ...target }, stop: { reason: 'ARRIVED' } } };
  assert.equal(classifyWalkToResult(current, start, target, tolerance).ok, true);
  // 运行时容差按水平 Math.hypot：单独 x/z 都在 0.12 内，但 hypot 超了也不能算到达。
  const diagonal = { ...nav, lastPosition: { x: target.x + 0.1, y: target.y, z: target.z + 0.1 } };
  assert.equal(classifyWalkToResult({ ...result, data: { nav: diagonal } }, start, target, tolerance).ok, false);
  const notArrived = { ...nav, outcome: 'PARTIAL', confirmed: false };
  assert.equal(classifyWalkToResult({ ...result, data: { nav: notArrived } }, start, target, tolerance).ok, false);
  const noMovement = { ...nav, lastPosition: { ...start } };
  assert.equal(classifyWalkToResult({ ...result, data: { nav: noMovement } }, start, target, tolerance).ok, false);
});

test('cancellation needs cancelled/unconfirmed, measured partial movement and released controls', () => {
  const start = { x: 200.5, y: 64, z: 216.5 };
  const nav = { outcome: 'CANCELLED', confirmed: false, lastPosition: { x: 200.8, y: 64, z: 216.5 } };
  const result = { status: 'cancelled', summary: 'cancelled', data: { nav } };
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  assert.equal(classifyCancellationResult(result, controls, false, start).ok, true);
  assert.equal(classifyCancellationResult(result, { ...controls, jump: true }, false, start).ok, false);
  assert.equal(classifyCancellationResult(result, controls, true, start).ok, false);
  const missingKey = { ...controls } as Record<string, unknown>;
  delete missingKey.sneak;
  assert.equal(classifyCancellationResult(result, missingKey, false, start).ok, false);

  // 触发取消与终态分类共用同一阈值：0.16 格的部分位移有效，0.10 格不能证明动过。
  assert.equal(CANCEL_MOVEMENT_THRESHOLD, 0.15);
  const partial = { ...nav, lastPosition: { x: start.x + 0.16, y: start.y, z: start.z } };
  assert.equal(classifyCancellationResult({ status: 'cancelled', summary: 'cancelled', data: { nav: partial } }, controls, false, start).ok, true);
  const tiny = { ...nav, lastPosition: { x: start.x + 0.1, y: start.y, z: start.z } };
  assert.equal(classifyCancellationResult({ status: 'cancelled', summary: 'cancelled', data: { nav: tiny } }, controls, false, start).ok, false);
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

test('spatial query envelope validation keeps raw records and rejects malformed projections', () => {
  assert.equal(validateQueryPage({}, 'nodes').ok, false);
  const page = {
    contract: 'memory-host-contract/2', status: 'ok', readOnly: true, executable: false,
    total: 1, nextAfter: 'n1',
    data: { kind: 'nodes', items: [{ id: 'n1', label: 'home' }], total: 1, nextAfter: 'n1' },
  };
  const checked = validateQueryPage(page, 'nodes');
  assert.equal(checked.ok, true);
  assert.equal(checked.total, 1);
  assert.equal(checked.nextAfter, 'n1');
  assert.deepEqual(checked.items, [{ id: 'n1', label: 'home' }], '列表保留库原样条目');
  assert.equal(validateQueryPage({ ...page, status: 'partial' }, 'nodes').ok, false);
  assert.equal(validateQueryPage({ ...page, contract: 'memory-host-contract/0' }, 'nodes').ok, false);
  assert.equal(validateQueryPage({ ...page, data: { ...page.data, kind: 'places' } }, 'nodes').ok, false);
  assert.equal(validateQueryPage({ nodes: [], page: { total: 0 } }, 'nodes').ok, false);
  assert.equal(validateQueryPage({ found: true, node: { id: 'n1' } }, 'nodes').ok, false);
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

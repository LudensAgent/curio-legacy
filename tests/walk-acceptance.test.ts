/**
 * walk-acceptance.ts 的窄测试：纯函数（场景选择器、RCON list 解析、相邻 X 路线、轨迹统计、
 * git porcelain 解析、来源元数据校验）、断言谓词（负例夹具）、WalkDiagnostics /
 * ExecutionDiagnostics 的「创建时绑定归属 + stopAll 前快照 + move/onSample 包装」，
 * 以及 ConnectionTracker / quitClient 的事件完成与超时。只测无副作用或假夹具路径，不连接服务器。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GROUNDED_ARRIVAL_DEFAULTS, RouteVerifier, VoxelMap, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type { NavResult } from 'curio-minecraft-3d-memory';
import {
  acceptedMeasurements,
  acceptedMovementBeyond,
  adjacentRouteX,
  allGroundedAt,
  allKeysReleased,
  assertEndObserved,
  assertListenerBaseline,
  assertOwnedTicksReleased,
  assertRealPartial,
  assertTimeoutAfterDeadline,
  awaitRouteStartRecord,
  blockFaceBounds,
  checkS1Return,
  checkSpatialFinalSave,
  checkSpatialReopen,
  checkTaskSegments,
  checkW4ObservationChain,
  checkW5HiddenReveal,
  classifyOldOwnerControls,
  cellEvidenceSnapshot,
  ConnectionTracker,
  dist2,
  EventSeq,
  ExecutionDiagnostics,
  foreignSampleDeliveries,
  framesSince,
  gitMeta,
  gitPorcelainPaths,
  hasPartialPosition,
  integrityMatches,
  isEmptyBlockState,
  isArrived,
  measuredCompletions,
  packageMeta,
  parseExecuteIfBlock,
  parseRconList,
  parseScenarioSelector,
  parseSetBlock,
  partialMatchesLastSample,
  pickSpatialWitness,
  mapBatchForEvidence,
  partialMatchesRecorded,
  platformEscaped,
  probeBlock,
  productionStopAllsInWindow,
  publicRouteTerminalSeq,
  quitClient,
  segmentsFollowMeasured,
  snapshotKeys,
  spatialShutdownRecord,
  summarizeTrajectory,
  TaskTracker,
  vecEqual,
  WalkDiagnostics,
  withinFootprint,
  type ActualControlEntry,
  type CellEvidenceSnapshot,
  type DeliveredSampleRecord,
  type FrameRecord,
  type MapBatchRecord,
  type MoveRecord,
  type RouteCallRecord,
  type RouteStateSnapshot,
  type RouteStatusSnapshot,
  type TickEntry,
  type VisionCallRecord,
  type WalkBridge,
} from '../scripts/walk-acceptance.ts';
import { WalkMoveExecutor, walkCollisionProvider } from '../src/adapter/walk-route.ts';
import type { TaskOutcome } from '../src/arbiter/arbiter.ts';
import { SharedSpatialSession, type ShutdownResult } from '../src/spatial/shared-session.ts';

const emptyKeys = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };

function arrivedNav(): NavResult {
  return {
    outcome: 'ARRIVED', message: 'ok', trace: [], confirmed: true,
    lastPosition: { x: 1.5, y: 0, z: 0.5 },
    lastObservation: { worldId: 'w', dim: 'd', sessionId: 's', observedAt: 1, onGround: true, inWater: false },
  };
}

function cancelledNav(partial?: { x: number; y: number; z: number }): NavResult {
  return {
    outcome: 'CANCELLED', message: 'cancelled', trace: [], confirmed: false,
    problem: { kind: 'cancelled', by: 'user', reason: 'x' },
    ...(partial ? { lastPosition: partial } : {}),
  };
}

test('parseScenarioSelector：缺省为支持的 W1/W2/W4/W5/W6/W7，自定义按序解析', () => {
  assert.deepEqual(parseScenarioSelector(undefined), ['W1', 'W2', 'W4', 'W5', 'W6', 'W7']);
  assert.deepEqual(parseScenarioSelector(''), ['W1', 'W2', 'W4', 'W5', 'W6', 'W7']);
  assert.deepEqual(parseScenarioSelector('W1,W6'), ['W1', 'W6']);
  assert.deepEqual(parseScenarioSelector(' w2 , w7 '), ['W2', 'W7']);
  assert.deepEqual(parseScenarioSelector('W4,W5'), ['W4', 'W5']);
  assert.throws(() => parseScenarioSelector('W1,W9'), /未知场景 W9/);
});

test('parseScenarioSelector：W4/W5 已支持；仍拒绝离线证据的 W3，不把全 NOT_RUN 判为通过', () => {
  assert.throws(() => parseScenarioSelector('W3'), /本轮未实现/);
  assert.throws(() => parseScenarioSelector('W1,W3'), /本轮未实现/);
});

test('parseRconList：解析已知 count/list 语法，空列表与多名均合法', () => {
  assert.deepEqual(parseRconList('There are 0 of a max of 20 players online:'), []);
  assert.deepEqual(parseRconList('There are 2 of a max of 20 players online: Alice, Bob'), ['Alice', 'Bob']);
});

test('parseRconList：畸形响应必须失败，而不是静默当空列表', () => {
  assert.throws(() => parseRconList('no online marker'), /无法解析/);
  assert.throws(() => parseRconList(''), /无法解析/);
  assert.throws(() => parseRconList('Players online: Alice'), /无法解析/);
});

test('parseRconList：声明数量与实际名字数不一致必须失败（fail closed）', () => {
  assert.throws(() => parseRconList('There are 2 of a max of 20 players online: Alice'), /在线数不一致/);
  assert.throws(() => parseRconList('There are 1 of a max of 20 players online: Alice, Bob'), /在线数不一致/);
});

test('adjacentRouteX：起点到终点逐格相邻、含终点、同 y/z', () => {
  const route = adjacentRouteX({ x: 205.5, y: 64, z: 205.5 }, { x: 207.5, y: 64, z: 205.5 });
  assert.deepEqual(route, [
    { x: 205.5, y: 64, z: 205.5 },
    { x: 206.5, y: 64, z: 205.5 },
    { x: 207.5, y: 64, z: 205.5 },
  ]);
});

test('parseExecuteIfBlock：只接受 Java 的 Test passed / Test failed，命令错误必须抛错', () => {
  assert.equal(parseExecuteIfBlock('Test passed'), 'match');
  assert.equal(parseExecuteIfBlock('Test failed'), 'mismatch');
  assert.throws(() => parseExecuteIfBlock('That position is not loaded'), /无法解析/);
  assert.throws(() => parseExecuteIfBlock('Unknown or incomplete command'), /无法解析/);
  assert.throws(() => parseExecuteIfBlock(''), /无法解析/);
});

test('parseSetBlock：只接受 1.20 真实成功反馈（无 to），截断/错误/尾缀负例必须抛错', () => {
  assert.doesNotThrow(() => parseSetBlock('Changed the block at 200, 63, 216'));
  assert.doesNotThrow(() => parseSetBlock('Changed the block at -12, -64, -3'));
  assert.throws(() => parseSetBlock('Changed the block at 200, 63, 216 to minecraft:stone'), /无法确认/, '真实成功文本没有 to');
  assert.throws(() => parseSetBlock('Changed the block at 200, 63'), /无法确认/, '截断坐标');
  assert.throws(() => parseSetBlock('That position is not loaded'), /无法确认/);
  assert.throws(() => parseSetBlock('Unknown or incomplete command'), /无法确认/);
  assert.throws(() => parseSetBlock('Changed the block at 200, 63, 216 extra'), /无法确认/, '任意尾缀');
});

test('isEmptyBlockState：air/cave_air/void_air 都是合法空格，material/unknown 是占用', () => {
  assert.equal(isEmptyBlockState('air'), true);
  assert.equal(isEmptyBlockState('cave_air'), true);
  assert.equal(isEmptyBlockState('void_air'), true);
  assert.equal(isEmptyBlockState('material'), false);
  assert.equal(isEmptyBlockState('unknown'), false);
});

test('probeBlock：实际 execute if block 命令精确判定 air / 材料 / unknown', async () => {
  const airCalls: string[] = [];
  const air = await probeBlock(async (command) => {
    airCalls.push(command);
    return command.endsWith(' minecraft:air') ? 'Test passed' : 'Test failed';
  }, { x: 200, y: 63, z: 216 }, 'minecraft:stone');
  assert.equal(air, 'air');
  assert.deepEqual(airCalls, ['execute if block 200 63 216 minecraft:air'], 'air 命中后不应继续探测');

  const caveAir = await probeBlock(async (command) => command.endsWith(' minecraft:cave_air') ? 'Test passed' : 'Test failed', { x: 201, y: 63, z: 216 }, 'minecraft:stone');
  assert.equal(caveAir, 'cave_air');
  const voidAir = await probeBlock(async (command) => command.endsWith(' minecraft:void_air') ? 'Test passed' : 'Test failed', { x: 202, y: 63, z: 216 }, 'minecraft:stone');
  assert.equal(voidAir, 'void_air');

  const materialCalls: string[] = [];
  const material = await probeBlock(async (command) => {
    materialCalls.push(command);
    return command.endsWith(' minecraft:stone') ? 'Test passed' : 'Test failed';
  }, { x: 205, y: 63, z: 205 }, 'minecraft:stone');
  assert.equal(material, 'material');
  assert.deepEqual(materialCalls, [
    'execute if block 205 63 205 minecraft:air',
    'execute if block 205 63 205 minecraft:cave_air',
    'execute if block 205 63 205 minecraft:void_air',
    'execute if block 205 63 205 minecraft:stone',
  ]);

  const unknownCalls: string[] = [];
  const unknown = await probeBlock(async (command) => {
    unknownCalls.push(command);
    return 'Test failed';
  }, { x: 220, y: 64, z: 220 }, 'minecraft:stone');
  assert.equal(unknown, 'unknown');
  assert.equal(unknownCalls.length, 4, '四项精确检查都不匹配才是 unknown');

  await assert.rejects(
    probeBlock(async () => 'That position is not loaded', { x: 200, y: 63, z: 216 }, 'minecraft:stone'),
    /无法解析/,
    '命令错误不得被当成不匹配继续写入',
  );
});

test('summarizeTrajectory：统计帧数/脚高/腾空/帧间隔', () => {
  const frames: FrameRecord[] = [
    { seq: 0, ts: 1000, dtMs: 0, x: 0.5, y: 64, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: true, inWater: false, keys: emptyKeys, ownerTaskId: 't_1', worldAgeTicks: 100 },
    { seq: 1, ts: 1050, dtMs: 50, x: 1.0, y: 64, z: 0.5, vx: 0.2, vy: 0, vz: 0, onGround: true, inWater: false, keys: { ...emptyKeys, forward: true }, ownerTaskId: 't_1', worldAgeTicks: 101 },
    { seq: 2, ts: 1100, dtMs: 50, x: 1.5, y: 64, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false, inWater: false, keys: emptyKeys, ownerTaskId: 't_1', worldAgeTicks: 102 },
  ];
  const s = summarizeTrajectory(frames);
  assert.equal(s.frameCount, 3);
  assert.equal(s.minFeetY, 64);
  assert.equal(s.airborneFrames, 1);
  assert.equal(s.allGrounded, false);
  assert.equal((s.dtMs as { min: number; max: number }).min, 50);
});

test('dist2：欧氏水平距离', () => {
  assert.equal(dist2({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
});

test('snapshotKeys：读全部 7 键为布尔', () => {
  const keys = snapshotKeys({ controlState: { ...emptyKeys, forward: true, sneak: true } });
  assert.equal(keys.forward, true);
  assert.equal(keys.sneak, true);
  assert.equal(keys.back, false);
  assert.equal(keys.jump, false);
});

test('gitPorcelainPaths：未暂存首路径保留前导空格，不被 slice 破坏', () => {
  assert.deepEqual(gitPorcelainPaths(' M scripts/walk-acceptance.ts\0'), ['scripts/walk-acceptance.ts']);
  assert.deepEqual(gitPorcelainPaths('A  scripts/foo.ts\0'), ['scripts/foo.ts']);
  assert.deepEqual(gitPorcelainPaths(' M scripts/my file.ts\0'), ['scripts/my file.ts']);
  assert.deepEqual(
    gitPorcelainPaths(' M scripts/a.ts\0A  scripts/b.ts\0?? scripts/untracked.ts\0'),
    ['scripts/a.ts', 'scripts/b.ts', 'scripts/untracked.ts'],
  );
  assert.deepEqual(gitPorcelainPaths(''), []);
});

test('gitMeta：包含提交哈希、分支与脚本指纹，不伪造 clean HEAD', () => {
  const meta = gitMeta();
  assert.match(meta.sha, /^[0-9a-f]{40}$/);
  assert.ok(meta.branch.length > 0);
  assert.match(meta.scriptFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(meta.dirtyPaths));
});

test('integrityMatches：正确字节匹配 sha512 integrity，篡改字节不匹配', () => {
  const buf = Buffer.from('the-real-artifact-bytes');
  const integrity = `sha512-${createHash('sha512').update(buf).digest('base64')}`;
  assert.equal(integrityMatches(buf, integrity), true);
  assert.equal(integrityMatches(Buffer.from('tampered'), integrity), false);
  assert.equal(integrityMatches(buf, 'sha1-deadbeef'), false, '非 sha512 integrity 不得误匹配');
});

test('packageMeta：当前可信 artifact 的来源/字节/锁/install 彼此对应', () => {
  const meta = packageMeta();
  assert.equal(meta.name, 'curio-minecraft-3d-memory');
  assert.equal(meta.version, '0.7.6');
  assert.equal(meta.lockVersion, meta.version);
  assert.equal(meta.lockResolved, meta.dependencySpec);
  assert.equal(meta.dependencySpec, 'file:vendor/curio-minecraft-3d-memory-0.7.6.tgz');
  assert.equal(meta.tgzSha256, 'f17cac0228ca381d9ac9880a9a2ddf892e0184946a6df7e22a8219c519cf5e27');
  assert.equal(meta.lockIntegrity, 'sha512-4xFyERG9B6btTDwg+Itmf/4zPoiRuOOBfSpN952NybgVzlJFEknzZ4V13C1jNJe4AklrU8mPFbHUHxIv/eXV9w==');
  assert.equal(meta.sourceHEAD, 'd0091948bc100e59d2fa98f28a9891669f670e40');
  assert.equal(meta.sourceBindingClean, true);
});

const FAKE_NAME = 'curio-minecraft-3d-memory';
const FAKE_VERSION = '0.7.5';

/** 临时目录里的完整假包：真实 crypto 计算字节哈希，便于逐项制造负例。 */
function makeFakePackage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-pkg-'));
  const tgzRel = `vendor/${FAKE_NAME}-${FAKE_VERSION}.tgz`;
  const tgzPath = path.join(dir, tgzRel);
  const bytes = Buffer.from('fake-curio-artifact-bytes');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const sourceHEAD = 'a'.repeat(40);
  const provenancePath = path.join(dir, 'vendor', `${FAKE_NAME}-${FAKE_VERSION}.provenance.json`);
  fs.mkdirSync(path.dirname(tgzPath), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', FAKE_NAME), { recursive: true });
  fs.writeFileSync(tgzPath, bytes);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [FAKE_NAME]: `file:${tgzRel}` } }));
  fs.writeFileSync(path.join(dir, 'node_modules', FAKE_NAME, 'package.json'), JSON.stringify({ name: FAKE_NAME, version: FAKE_VERSION }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    packages: {
      '': { dependencies: { [FAKE_NAME]: `file:${tgzRel}` } },
      [`node_modules/${FAKE_NAME}`]: { version: FAKE_VERSION, resolved: `file:${tgzRel}`, integrity },
    },
  }));
  fs.writeFileSync(provenancePath, JSON.stringify({
    package: { name: FAKE_NAME, version: FAKE_VERSION },
    sourceHEAD,
    artifactSHA256: createHash('sha256').update(bytes).digest('hex'),
    npmIntegrity: integrity,
    sourceBinding: { clean: true, head: sourceHEAD },
  }));
  return { dir, tgzPath, provenancePath, sourceHEAD };
}

test('packageMeta：临时假包完整时通过（证明负例不是被无关检查挡住）', () => {
  const pkg = makeFakePackage();
  try {
    assert.equal(packageMeta({ base: pkg.dir }).sourceHEAD, pkg.sourceHEAD);
  } finally {
    fs.rmSync(pkg.dir, { recursive: true, force: true });
  }
});

test('packageMeta：篡改/包名/root lock/source binding 负例都失败（不触及真实 artifact）', () => {
  const cases: Array<{ name: string; pattern: RegExp; mutate: (pkg: ReturnType<typeof makeFakePackage>) => void }> = [
    {
      name: '同版本 artifact 字节被篡改',
      pattern: /integrity（sha512）不一致/,
      mutate: (pkg) => fs.writeFileSync(pkg.tgzPath, Buffer.from('tampered-bytes-not-the-real-artifact')),
    },
    {
      name: 'installed 包名错误',
      pattern: /固定期望包名/,
      mutate: (pkg) => fs.writeFileSync(path.join(pkg.dir, 'node_modules', FAKE_NAME, 'package.json'), JSON.stringify({ name: 'other-package', version: FAKE_VERSION })),
    },
    {
      name: 'manifest 非 file:',
      pattern: /必须是 file:/,
      mutate: (pkg) => fs.writeFileSync(path.join(pkg.dir, 'package.json'), JSON.stringify({ dependencies: { [FAKE_NAME]: FAKE_VERSION } })),
    },
    {
      name: 'root lock 依赖不一致',
      pattern: /root packages/,
      mutate: (pkg) => {
        const file = path.join(pkg.dir, 'package-lock.json');
        const lock = JSON.parse(fs.readFileSync(file, 'utf8')) as { packages: Record<string, { dependencies?: Record<string, string> }> };
        lock.packages['']!.dependencies![FAKE_NAME] = 'file:vendor/other.tgz';
        fs.writeFileSync(file, JSON.stringify(lock));
      },
    },
    {
      name: 'sourceBinding.clean=false',
      pattern: /sourceBinding\.clean/,
      mutate: (pkg) => {
        const file = pkg.provenancePath;
        const prov = JSON.parse(fs.readFileSync(file, 'utf8')) as { sourceBinding: { clean: boolean } };
        prov.sourceBinding.clean = false;
        fs.writeFileSync(file, JSON.stringify(prov));
      },
    },
    {
      name: 'sourceBinding.head 不一致',
      pattern: /sourceBinding\.head/,
      mutate: (pkg) => {
        const file = pkg.provenancePath;
        const prov = JSON.parse(fs.readFileSync(file, 'utf8')) as { sourceBinding: { head: string } };
        prov.sourceBinding.head = 'b'.repeat(40);
        fs.writeFileSync(file, JSON.stringify(prov));
      },
    },
  ];
  for (const c of cases) {
    const pkg = makeFakePackage();
    try {
      c.mutate(pkg);
      assert.throws(() => packageMeta({ base: pkg.dir }), c.pattern, c.name);
    } finally {
      fs.rmSync(pkg.dir, { recursive: true, force: true });
    }
  }
});

// --- 断言谓词：负例夹具验证拒绝能力 ---

test('isArrived：只有 ARRIVED+confirmed 才算到达，取消/超时不算', () => {
  assert.equal(isArrived(arrivedNav()), true);
  assert.equal(isArrived(cancelledNav({ x: 0.5, y: 0, z: 0.5 })), false);
  assert.equal(isArrived(undefined), false);
});

test('hasPartialPosition：非到达终态保留部分位移；缺失即假', () => {
  assert.equal(hasPartialPosition(cancelledNav({ x: 0.5, y: 0, z: 0.5 })), true);
  assert.equal(hasPartialPosition(cancelledNav()), false, '缺失 lastPosition 的取消终态必须判为无部分位移');
  assert.equal(hasPartialPosition(arrivedNav()), false);
});

test('partialMatchesLastSample：部分位移须与最后已接受样本一致', () => {
  const nav = cancelledNav({ x: 1.0, y: 0, z: 0.5 });
  assert.equal(partialMatchesLastSample(nav, [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.0, y: 0, z: 0.5 }]), true);
  assert.equal(partialMatchesLastSample(nav, [{ x: 0.5, y: 0, z: 0.5 }]), false, '错位样本不得判定一致');
  assert.equal(partialMatchesLastSample(nav, []), false);
});

test('withinFootprint/platformEscaped：整数 bounds 转连续面，半宽 0.3 严格正重叠才算支撑', () => {
  const f = { xMin: 205, xMax: 206, zMin: 205, zMax: 205 }; // 真正 2×1
  assert.deepEqual(blockFaceBounds(f), { xMin: 205, xMax: 207, zMin: 205, zMax: 206 });
  assert.equal(withinFootprint({ x: 205.55, z: 205.52 }, f), true, '起点在支撑面内');
  assert.equal(withinFootprint({ x: 206.55, z: 205.52 }, f), true, '目标紧邻外边缘 x207 仍有正重叠');
  assert.equal(withinFootprint({ x: 207.29, z: 205.52 }, f), true, '身体越过边缘但仍有非零重叠');
  assert.equal(withinFootprint({ x: 207.3, z: 205.52 }, f), false, '恰好零接触不算支撑（max+1 + 半宽）');
  assert.equal(withinFootprint({ x: 207.31, z: 205.52 }, f), false, '半宽越过后零重叠被拒');
  assert.equal(withinFootprint({ x: 204.7, z: 205.52 }, f), false, 'x 下侧恰好零接触不算支撑');
  assert.equal(withinFootprint({ x: 204.71, z: 205.52 }, f), true);
  assert.equal(withinFootprint({ x: 205.55, z: 206.29 }, f), true, 'z 外边缘仍可正重叠');
  assert.equal(withinFootprint({ x: 205.55, z: 206.3 }, f), false, 'z 方向恰好零接触不算支撑');
  assert.equal(platformEscaped([{ x: 205.55, z: 205.52 }, { x: 206.55, z: 205.52 }], f), false);
  assert.equal(platformEscaped([{ x: 205.55, z: 205.52 }, { x: 207.3, z: 205.52 }], f), true);
});

test('allGroundedAt：所有帧在实测脚高且着地；腾空/脚高偏移即假', () => {
  assert.equal(allGroundedAt([{ y: 64, onGround: true }, { y: 64, onGround: true }], 64), true);
  assert.equal(allGroundedAt([{ y: 64, onGround: true }, { y: 64, onGround: false }], 64), false);
  assert.equal(allGroundedAt([{ y: 63.9, onGround: true }], 64), false);
  assert.equal(allGroundedAt([], 64), false);
});

test('framesSince：teleport/搭设帧排除在支撑断言之外（防 setup 污染）', () => {
  const frames: FrameRecord[] = [
    { seq: 0, ts: 900, dtMs: 0, x: 0, y: 64, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, inWater: false, keys: emptyKeys, ownerTaskId: null, worldAgeTicks: 1 },
    { seq: 1, ts: 1000, dtMs: 100, x: 0.5, y: 64, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, inWater: false, keys: emptyKeys, ownerTaskId: 't', worldAgeTicks: 2 },
  ];
  assert.equal(framesSince(frames, 1000).length, 1);
  assert.equal(framesSince(frames, 1000)[0]!.ownerTaskId, 't');
});

function routeSnap(o: Partial<RouteStateSnapshot> = {}): RouteStateSnapshot {
  return {
    stepCount: 1, complete: true, verdict: 'OPEN', openPrefix: 1,
    verifiedStepIndexes: [0], pendingStepIndexes: [], invalidatedCount: 0, earliestProblem: null,
    steps: [{ kind: 'verified', status: 'OPEN', problemKind: null }], ...o,
  };
}

function statusSnap(o: Partial<RouteStatusSnapshot> = {}): RouteStatusSnapshot {
  return {
    worldId: 'w', dim: 'd', sessionId: 's',
    delegationId: 'walk-1', nextPointIndex: 1, activeStepIndex: 0, lastPosition: null, result: null,
    route: routeSnap(), ...o,
  };
}

let deliverySeq = 0;
function delivery(
  pos: { x: number; y: number; z: number },
  before: RouteStatusSnapshot,
  after: RouteStatusSnapshot,
  opts: { delegationId?: string; owner?: string | null; sequence?: number; frame?: number; source?: 'frameSink' | 'direct'; sourceOwner?: string | null } = {},
): DeliveredSampleRecord {
  const delegationId = opts.delegationId ?? 'walk-1';
  const sequence = opts.sequence ?? ++deliverySeq;
  const source = opts.source ?? 'direct';
  return {
    seq: sequence, ts: sequence, frame: opts.frame ?? 0, ownerTaskId: opts.owner ?? 'task_A', delegationId,
    source, sourceOwnerTaskId: source === 'frameSink' ? (opts.sourceOwner ?? null) : null,
    sample: {
      worldId: 'w', dim: 'd', sessionId: 's', executionId: delegationId,
      pos: { ...pos }, velocity: { x: 0, y: 0, z: 0 },
      observedAt: sequence * 50, sequence, alive: true, connected: true, observationReady: true,
      onGround: true, inWater: false,
    },
    statusBefore: before, statusAfter: after,
  };
}

function moveRecord(delegationId: string, taskId: string, step: number, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): MoveRecord {
  return {
    seq: step + 1, ts: step * 50, taskId, delegationId,
    executionId: `${delegationId}-step-${step}`,
    from: { ...from }, to: { ...to }, deadlineMs: 10_000, timeoutMs: 4000, signalAborted: false,
  };
}

test('allKeysReleased/vecEqual：7 键全 false 与严格坐标相等', () => {
  assert.equal(allKeysReleased(emptyKeys), true);
  assert.equal(allKeysReleased({ ...emptyKeys, sneak: true }), false);
  assert.equal(vecEqual({ x: 1.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }), true);
  assert.equal(vecEqual({ x: 1.5, y: 64, z: 0.5 }, { x: 1.53, y: 64, z: 0.5 }), false);
  assert.equal(vecEqual(null, { x: 0, y: 0, z: 0 }), false);
});

test('checkTaskSegments：恰好 0..n-1 段且归属正确；0/1/2/额外段均失败', () => {
  const own = [
    moveRecord('walk-7', 'task_A', 0, { x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }),
    moveRecord('walk-7', 'task_A', 1, { x: 1, y: 64, z: 0 }, { x: 1, y: 64, z: 1 }),
    moveRecord('walk-7', 'task_A', 2, { x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 1 }),
  ];
  assert.equal(checkTaskSegments(own, 'walk-7', 'task_A', 3).ok, true);
  assert.equal(checkTaskSegments([], 'walk-7', 'task_A', 3).ok, false, '0 段');
  assert.equal(checkTaskSegments(own.slice(0, 1), 'walk-7', 'task_A', 3).ok, false, '1 段');
  assert.equal(checkTaskSegments(own.slice(0, 2), 'walk-7', 'task_A', 3).ok, false, '2 段');
  const extra = [...own, moveRecord('walk-7', 'task_A', 3, { x: 2, y: 64, z: 1 }, { x: 3, y: 64, z: 1 })];
  assert.equal(checkTaskSegments(extra, 'walk-7', 'task_A', 3).ok, false, '额外段');
  const wrongOwner = own.map((m) => (m.executionId.endsWith('step-1') ? { ...m, taskId: 'task_X' } : m));
  assert.equal(checkTaskSegments(wrongOwner, 'walk-7', 'task_A', 3).ok, false, '错误归属');
});

test('acceptedMeasurements：只有 lastPosition 记录该原始测量且序号单调才算接受', () => {
  const pos = { x: 1.5, y: 64, z: 0.5 };
  const accepted = delivery(pos, statusSnap(), statusSnap({ nextPointIndex: 2, lastPosition: pos }));
  assert.equal(acceptedMeasurements([accepted], 'task_A', 'walk-1').length, 1);
  const replay = delivery({ x: 1.5, y: 64, z: 0.5 }, statusSnap({ nextPointIndex: 2 }), statusSnap({ nextPointIndex: 2, lastPosition: pos }), { sequence: accepted.sample.sequence });
  assert.equal(acceptedMeasurements([accepted, replay], 'task_A', 'walk-1').length, 1, '重放序号不得再次计入');
  const foreign = delivery({ x: 2.5, y: 64, z: 0.5 }, statusSnap(), statusSnap({ lastPosition: { x: 2.5, y: 64, z: 0.5 } }), { delegationId: 'walk-2' });
  foreign.sample.executionId = 'walk-1';
  assert.equal(acceptedMeasurements([foreign], 'task_A', 'walk-2').length, 0, '错误 sample id 不得计入');
});

test('acceptedMeasurements：真实库拒绝同位置但错误 scope 的样本时不得计为被接受', () => {
  const fields = ['worldId', 'dim', 'sessionId'] as const;
  for (const field of fields) {
    const exec = new ExecutionDiagnostics(new EventSeq(), () => 'task_A', () => 1000);
    exec.wrap();
    try {
      const map = new VoxelMap('world', { validityWindowMs: 60_000 });
      const loop = new WalkRouteExecutor(map, { move: async () => ({ failure: { kind: 'cancelled' } as const }), stop: () => {} }, { now: () => 1000 });
      const status = loop.start({
        worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
        body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
        points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
        arrival: { kind: 'exact' }, shapeProvider: walkCollisionProvider,
        deadlineMs: 5000, timeoutMs: 1000,
      });
      const pos = { x: 0.5, y: 0, z: 0.5 };
      const sample = {
        worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: status.delegationId,
        pos, velocity: { x: 0, y: 0, z: 0 }, observedAt: 1000, sequence: 1,
        alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
      };
      loop.onSample(sample);
      assert.deepEqual(exec.deliveredSamples[0]!.statusAfter.lastPosition, pos, `${field}: 首个合法样本记录 P`);
      assert.equal(acceptedMeasurements(exec.deliveredSamples, 'task_A', status.delegationId).length, 1);

      // 错误 world/dim/session 但完全相同的位置 P：库因 scope_changed 拒绝并终结。
      loop.onSample({ ...sample, [field]: field === 'dim' ? 'nether' : 'other', sequence: 2 });
      const rejected = exec.deliveredSamples[1]!;
      assert.equal(rejected.statusBefore.result, null);
      assert.deepEqual(rejected.statusAfter.lastPosition, pos, `${field}: 拒绝样本不会替换 lastPosition（位置相等不能证明接受）`);
      const result = rejected.statusAfter.result;
      if (result === null || result.outcome === 'ARRIVED') throw new Error(`${field}: 错误 scope 样本必须产生失败终态`);
      assert.equal(result.outcome, 'FAILED');
      assert.equal(result.problem.kind, 'scope_changed');
      assert.equal(acceptedMeasurements(exec.deliveredSamples, 'task_A', status.delegationId).length, 1, `${field}: 错误 scope 的同位置样本不得计为接受`);
    } finally {
      exec.unwrap();
    }
  }
});

test('acceptedMovementBeyond：假夹具中仅本 task/delegation 已接受且实测位移 > 0.5 才触发', () => {
  const start = { x: 0, y: 64, z: 0 };
  const at = (x: number, after: Partial<RouteStatusSnapshot> = {}) => {
    const pos = { x, y: 64, z: 0 };
    return delivery(pos, statusSnap(), statusSnap({ lastPosition: pos, ...after }));
  };
  // 假 raw body 已越 0.5，但本 task 已接受测量仍只有 0.43：不得触发。
  const rawBodyAhead = { x: 0.6, y: 64, z: 0 };
  assert.ok(dist2(rawBodyAhead, start) > 0.5, '假 raw body 夹具确实超前');
  assert.equal(acceptedMovementBeyond([at(0.43)], 'task_A', 'walk-1', start, 0.5), undefined);
  // 别的 task 即使同名 walk-1 也不触发。
  const otherTask = delivery({ x: 1.5, y: 64, z: 0 }, statusSnap(), statusSnap({ lastPosition: { x: 1.5, y: 64, z: 0 } }), { owner: 'task_B' });
  assert.equal(acceptedMovementBeyond([otherTask], 'task_A', 'walk-1', start, 0.5), undefined);
  // 错误 scope 的样本不被 acceptedMeasurements 接受。
  const wrongScope = at(1.5);
  wrongScope.sample.worldId = 'other';
  assert.equal(acceptedMovementBeyond([wrongScope], 'task_A', 'walk-1', start, 0.5), undefined);
  // lastPosition 未记录该原始测量：未接受。
  const unaccepted = delivery({ x: 1.5, y: 64, z: 0 }, statusSnap(), statusSnap({ lastPosition: { x: 0.5, y: 64, z: 0 } }));
  assert.equal(acceptedMovementBeyond([unaccepted], 'task_A', 'walk-1', start, 0.5), undefined);
  // 本次 sample 自身令公开状态到达：before 仍为 null，但不是活跃测量。
  assert.equal(acceptedMovementBeyond([at(1.5, { result: arrivedNav() })], 'task_A', 'walk-1', start, 0.5), undefined);
  // 公开状态已离开活动步：不得触发。
  assert.equal(acceptedMovementBeyond([at(1.5, { activeStepIndex: null })], 'task_A', 'walk-1', start, 0.5), undefined);
  // 正确本 task 活跃测量 > 0.5 才触发，并保留原 sample 身份/时刻。
  const good = at(1.5);
  const hit = acceptedMovementBeyond([unaccepted, good], 'task_A', 'walk-1', start, 0.5);
  assert.equal(hit, good);
  assert.equal(hit?.sample.sequence, good.sample.sequence);
  assert.equal(hit?.sample.observedAt, good.sample.observedAt);
  assert.deepEqual(hit?.sample.pos, good.sample.pos);
});

test('partialMatchesRecorded：partial 必须匹配最后候选测量的原 time/scope/position', () => {
  const seq = ++deliverySeq;
  const rec = delivery({ x: 1.0, y: 64, z: 0.5 }, statusSnap(), statusSnap({ lastPosition: { x: 1.0, y: 64, z: 0.5 } }), { sequence: seq });
  const nav: NavResult = {
    outcome: 'CANCELLED', message: 'cancelled', trace: [], confirmed: false,
    problem: { kind: 'cancelled', by: 'user', reason: 'x' },
    lastPosition: { x: 1.0, y: 64, z: 0.5 },
    lastObservation: { worldId: 'w', dim: 'd', sessionId: 's', observedAt: rec.sample.observedAt, onGround: true, inWater: false },
  };
  assert.equal(partialMatchesRecorded(nav, [rec]), true);
  assert.equal(partialMatchesRecorded({ ...nav, lastObservation: { ...nav.lastObservation!, observedAt: nav.lastObservation!.observedAt + 1 } }, [rec]), false, '时间必须为原始测量时间');
  assert.equal(partialMatchesRecorded({ ...nav, lastObservation: { ...nav.lastObservation!, sessionId: 'other' } }, [rec]), false, 'scope 必须为原始测量 scope');
});

test('measuredCompletions/segmentsFollowMeasured：严格用实测完成点，名义点即使容差内也拒绝', () => {
  const measured1 = { x: 1.53, y: 64, z: 0.5 };
  const measured2 = { x: 2.54, y: 64, z: 0.5 };
  const d1 = delivery(measured1, statusSnap({ nextPointIndex: 1 }), statusSnap({ nextPointIndex: 2, lastPosition: measured1 }));
  const d2 = delivery(measured2, statusSnap({ nextPointIndex: 2 }), statusSnap({ nextPointIndex: 3, lastPosition: measured2 }));
  const completions = measuredCompletions([d1, d2], 'task_A', 'walk-1');
  assert.equal(completions.length, 2);
  assert.deepEqual(completions.map((c) => c.stepIndex), [0, 1]);

  const moves = [
    moveRecord('walk-1', 'task_A', 0, { x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }),
    moveRecord('walk-1', 'task_A', 1, measured1, { x: 2.5, y: 64, z: 0.5 }),
    moveRecord('walk-1', 'task_A', 2, measured2, { x: 3.5, y: 64, z: 0.5 }),
  ];
  assert.equal(segmentsFollowMeasured(moves, completions), true);

  // 负例：from 用上一段名义 to（1.5），实测是 1.53；两者差 0.03 在 arrival 0.12 内，仍必须拒绝。
  const nominal = moves.map((m, i) => (i === 1 ? { ...m, from: { x: 1.5, y: 64, z: 0.5 } } : m));
  assert.ok(Math.abs(1.5 - measured1.x) <= 0.12, '负例差异必须在 arrival tolerance 内才具有区分力');
  assert.equal(segmentsFollowMeasured(nominal, completions), false);
  assert.equal(segmentsFollowMeasured(moves, completions.slice(0, 1)), false, '缺上一段完成点必须拒绝');
});

test('classifyOldOwnerControls：取消后实际复活拒绝、接管后任何旧键拒绝、阻断的 attempt 允许', () => {
  const keys = (fwd = false) => ({ ...emptyKeys, forward: fwd });
  const entries: ActualControlEntry[] = [
    { seq: 11, ts: 11, op: 'clear', ownerTaskId: 'A', keysBefore: keys(true), keysAfter: keys(false) },
    { seq: 12, ts: 12, op: 'set', name: 'back', value: false, ownerTaskId: 'A', keysBefore: keys(false), keysAfter: keys(false) },
    { seq: 13, ts: 13, op: 'set', name: 'back', value: true, ownerTaskId: 'A', keysBefore: keys(false), keysAfter: { ...emptyKeys, back: true } },
    { seq: 14, ts: 14, op: 'set', name: 'forward', value: true, ownerTaskId: 'A', keysBefore: keys(false), keysAfter: keys(false) },
    { seq: 21, ts: 21, op: 'clear', ownerTaskId: 'A', keysBefore: keys(false), keysAfter: keys(false) },
    { seq: 22, ts: 22, op: 'set', name: 'left', value: false, ownerTaskId: 'A', keysBefore: keys(false), keysAfter: keys(false) },
    { seq: 23, ts: 23, op: 'set', name: 'forward', value: true, ownerTaskId: 'A', keysBefore: keys(false), keysAfter: keys(true) },
  ];
  const v = classifyOldOwnerControls(entries, 'A', { cancelSeq: 10, takeoverSeq: 20 });
  assert.deepEqual(v.revived.map((c) => c.seq), [13, 23], '只有 keysAfter 真的 true 才算复活（含非 forward）');
  assert.deepEqual(v.revived.map((c) => c.name), ['back', 'forward'], '非 forward 的真实复活也必须识别');
  assert.deepEqual(v.afterTakeover.map((c) => c.seq), [21, 22, 23], '接管后任何实际 set/clear 都非法');
  assert.deepEqual(v.releasedBeforeTakeover.map((c) => c.seq), [11, 12, 14], '真实复活 true 不得同时算作松键');
  assert.equal(v.releasedBeforeTakeover.some((c) => c.name === 'forward' && c.value === true && c.keysAfter.forward === false), true, '被 guard 阻断的 attempt 不得算复活');
});

test('classifyOldOwnerControls：7 键任一 keysAfter=true 都是复活；false/clear 不误报', () => {
  const names = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
  let seq = 10;
  const entries: ActualControlEntry[] = names.map((name) => ({
    seq: ++seq, ts: seq, op: 'set', name, value: true, ownerTaskId: 'A',
    keysBefore: { ...emptyKeys }, keysAfter: { ...emptyKeys, [name]: true },
  }));
  entries.push(
    { seq: ++seq, ts: seq, op: 'set', name: 'jump', value: false, ownerTaskId: 'A', keysBefore: emptyKeys, keysAfter: emptyKeys },
    { seq: ++seq, ts: seq, op: 'clear', ownerTaskId: 'A', keysBefore: { ...emptyKeys, sneak: true }, keysAfter: emptyKeys },
  );
  const v = classifyOldOwnerControls(entries, 'A', { cancelSeq: 10, takeoverSeq: 100 });
  assert.deepEqual(v.revived.map((c) => c.name), [...names]);
  assert.deepEqual(v.releasedBeforeTakeover.map((c) => c.op), ['set', 'clear'], 'false/clear 只在确实未复活时作为松键证据');
});

test('foreignSampleDeliveries：B delegation 的样本必须来自 B 的目标 owner、原 sample id 与 frameSink 来源', () => {
  const pos = { x: 0.5, y: 64, z: 0.5 };
  const good = delivery(pos, statusSnap(), statusSnap({ lastPosition: pos }), { delegationId: 'walk-2', owner: 'task_B', sequence: 40, source: 'frameSink', sourceOwner: 'task_B' });
  const oldOwner = delivery(pos, statusSnap(), statusSnap({ lastPosition: pos }), { delegationId: 'walk-2', owner: 'task_A', sequence: 41 });
  const oldId = delivery(pos, statusSnap(), statusSnap({ lastPosition: pos }), { delegationId: 'walk-2', owner: 'task_B', sequence: 42 });
  oldId.sample.executionId = 'walk-1';
  const oldSource = delivery(pos, statusSnap(), statusSnap({ lastPosition: pos }), { delegationId: 'walk-2', owner: 'task_B', sequence: 43, source: 'frameSink', sourceOwner: 'task_A' });
  const directActive = delivery(pos, statusSnap({ activeStepIndex: 0 }), statusSnap({ lastPosition: pos }), { delegationId: 'walk-2', owner: 'task_B', sequence: 44, source: 'direct' });
  const foreign = foreignSampleDeliveries([good, oldOwner, oldId, oldSource, directActive], 'walk-2', 'task_B');
  assert.deepEqual(foreign.map((r) => r.seq), [42, 43, 44], '目标 loop 内 id 被改写、来源是旧 A，或活动段来源不可确认，都必须拒绝');
  assert.equal(foreign.some((r) => r.seq === 41), false, 'A 自己 loop 的合法记录不是 B 的外来样本（同名 delegation 下按 task 隔离）');
});

test('foreignSampleDeliveries：真实 setFrameSink 回调 → onSample 驱动旧 A 样本入 B 时按来源识别', async () => {
  let current: string | null = 'task_A';
  const exec = new ExecutionDiagnostics(new EventSeq(), () => current, () => 1000);
  exec.wrap();
  try {
    const map = new VoxelMap('world', { validityWindowMs: 60_000 });
    const noMove = { move: async () => ({ failure: { kind: 'cancelled' } as const }), stop: () => {} };
    const loopA = new WalkRouteExecutor(map, noMove, { now: () => 1000 });
    const loopB = new WalkRouteExecutor(map, noMove, { now: () => 1000 });
    const startA = loopA.start({
      worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
      body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
      arrival: { kind: 'exact' }, shapeProvider: walkCollisionProvider, deadlineMs: 5000, timeoutMs: 1000,
    });
    current = 'task_B';
    const startB = loopB.start({
      worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
      body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
      arrival: { kind: 'exact' }, shapeProvider: walkCollisionProvider, deadlineMs: 5000, timeoutMs: 1000,
    });

    assert.equal(startA.delegationId, startB.delegationId, '两个真实实例的 delegation 同名（都是实例内 walk-1）');
    const entity = { position: { x: 0.5, y: 0, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
    let frames = 0;
    const body = { setControlState() {}, clearControlStates() {}, look() {}, entity };
    const executorA = new WalkMoveExecutor(body, async () => (frames++ === 0 ? entity : null), new AbortController().signal, () => 1000);
    current = 'task_A';
    // 旧 A 的公开 frameSink 回调把 payload 的 executionId 全部改写成 B，再送进 B 的 loop。
    executorA.setFrameSink(() => {
      loopB.onSample({
        worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: startB.delegationId,
        pos: { x: 0.5, y: 0, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, observedAt: 1000, sequence: 1,
        alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
      });
    });
    current = 'task_B'; // 目标 loop 此刻归属 B；来源绑定仍是创建 frameSink 时的 A
    await executorA.move({
      executionId: `${startA.delegationId}-step-0`, worldId: 'world', dim: 'overworld', sessionId: 's1',
      from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 0, z: 0.5 },
      deadlineMs: 5000, timeoutMs: 1000, signal: new AbortController().signal,
    });

    const rec = exec.deliveredSamples.find((r) => r.delegationId === startB.delegationId);
    assert.ok(rec, '必须真实经过公开 frameSink 回调进入 B 的 onSample');
    assert.equal(rec.ownerTaskId, 'task_B', '目标 loop owner 是 B');
    assert.equal(rec.sample.executionId, startB.delegationId, 'payload id 已被错写成 B');
    assert.equal(rec.source, 'frameSink');
    assert.equal(rec.sourceOwnerTaskId, 'task_A', '来源 owner 必须来自 frameSink 绑定而非 fixture 手填');
    assert.deepEqual(rec.statusAfter.lastPosition, { x: 0.5, y: 0, z: 0.5 }, 'B 的公开状态确实接受了该 payload');
    assert.deepEqual(foreignSampleDeliveries([rec], startB.delegationId, 'task_B').map((r) => r.seq), [rec.seq]);

    // 初始化直调不经过 frameSink：如实标记 direct/null，合法初始化不得误判。
    loopB.onSample({
      worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: startB.delegationId,
      pos: { x: 0.5, y: 0, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, observedAt: 1001, sequence: 2,
      alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
    });
    const direct = exec.deliveredSamples[exec.deliveredSamples.length - 1]!;
    assert.equal(direct.source, 'direct');
    assert.equal(direct.sourceOwnerTaskId, null);
    assert.equal(foreignSampleDeliveries([direct], startB.delegationId, 'task_B').length, 0, '合法初始化直调不得误失败');
  } finally {
    exec.unwrap();
  }
});

test('ExecutionDiagnostics：两个真实 loop 都 start 出同名 walk-1，候选按 task+delegation 隔离', () => {
  let current: string | null = 'task_A';
  const exec = new ExecutionDiagnostics(new EventSeq(), () => current, () => 1000);
  exec.wrap();
  try {
    const noMove = { move: async () => ({ failure: { kind: 'cancelled' } as const }), stop: () => {} };
    const loopA = new WalkRouteExecutor(new VoxelMap('world', { validityWindowMs: 60_000 }), noMove, { now: () => 1000 });
    const loopB = new WalkRouteExecutor(new VoxelMap('world', { validityWindowMs: 60_000 }), noMove, { now: () => 1000 });
    const startA = loopA.start({
      worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
      body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
      arrival: { kind: 'exact' }, shapeProvider: walkCollisionProvider, deadlineMs: 5000, timeoutMs: 1000,
    });
    current = 'task_B';
    const startB = loopB.start({
      worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
      body: { feet: { x: 10.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
      points: [{ x: 10.5, y: 0, z: 0.5 }, { x: 11.5, y: 0, z: 0.5 }],
      arrival: { kind: 'exact' }, shapeProvider: walkCollisionProvider, deadlineMs: 5000, timeoutMs: 1000,
    });
    assert.equal(startA.delegationId, 'walk-1', '真实实例的 delegation 是实例内 generation');
    assert.equal(startB.delegationId, 'walk-1', '第二个实例同样得到 walk-1，不能假设 walk-2');

    // A 用高 sequence，B 用低 sequence：独立查询不得跨任务比较单调性。
    loopA.onSample({
      worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: startA.delegationId,
      pos: { x: 0.5, y: 0, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, observedAt: 5000, sequence: 50,
      alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
    });
    loopB.onSample({
      worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: startB.delegationId,
      pos: { x: 10.5, y: 0, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, observedAt: 1000, sequence: 1,
      alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
    });
    const aAccepted = acceptedMeasurements(exec.deliveredSamples, 'task_A', startA.delegationId);
    const bAccepted = acceptedMeasurements(exec.deliveredSamples, 'task_B', startB.delegationId);
    assert.deepEqual(aAccepted.map((r) => r.sample.sequence), [50], 'A 自己的候选不因同名 B 受影响');
    assert.deepEqual(bAccepted.map((r) => r.sample.sequence), [1], 'B 的低 sequence 不因 A 的高 sequence 被拒');
    assert.deepEqual(foreignSampleDeliveries(exec.deliveredSamples, startA.delegationId, 'task_A'), [], 'A 自己 loop 的记录不是外来样本');
    assert.deepEqual(foreignSampleDeliveries(exec.deliveredSamples, startB.delegationId, 'task_B'), [], 'B 自己 loop 的记录不是外来样本');

    // 段集合同样按 task+delegation 隔离；两个任务的 step-0 executionId 完全相同。
    const aMoves = [
      moveRecord(startA.delegationId, 'task_A', 0, { x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }),
      moveRecord(startA.delegationId, 'task_A', 1, { x: 1.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }),
    ];
    const bMoves = [
      moveRecord(startB.delegationId, 'task_B', 0, { x: 10.5, y: 0, z: 0.5 }, { x: 11.5, y: 0, z: 0.5 }),
    ];
    assert.equal(checkTaskSegments([...aMoves, ...bMoves], startA.delegationId, 'task_A', 2).ok, true, 'A 的合法段不被同名 B 段污染');
    assert.equal(checkTaskSegments([...aMoves, ...bMoves], startB.delegationId, 'task_B', 1).ok, true, 'B 的合法段不被同名 A 段污染');
    assert.equal(checkTaskSegments([...aMoves, ...bMoves], startA.delegationId, 'task_A', 3).ok, false, '当前任务漏段仍必须 FAIL');
  } finally {
    exec.unwrap();
  }
});

test('measuredCompletions：同名 walk-1 下按 task+delegation 独立推进，A 高序号不拒 B 低序号', () => {
  const posA = { x: 1.5, y: 64, z: 0.5 };
  const posB = { x: 11.5, y: 64, z: 0.5 };
  const recA = delivery(posA, statusSnap({ nextPointIndex: 1 }), statusSnap({ nextPointIndex: 2, lastPosition: posA }), { owner: 'task_A', sequence: 100 });
  const recB = delivery(posB, statusSnap({ nextPointIndex: 1 }), statusSnap({ nextPointIndex: 2, lastPosition: posB }), { owner: 'task_B', sequence: 1 });
  const a = measuredCompletions([recA, recB], 'task_A', 'walk-1');
  const b = measuredCompletions([recA, recB], 'task_B', 'walk-1');
  assert.deepEqual(a.map((c) => c.sampleSequence), [100]);
  assert.deepEqual(b.map((c) => c.sampleSequence), [1], 'A 的高 sequence 不得让 B 的低 sequence 完成点被拒');
  assert.deepEqual(a.map((c) => c.pos), [posA]);
  assert.deepEqual(b.map((c) => c.pos), [posB]);
});

test('W6 stopAll 窗口：最近 body 同为 B 时，活动窗口内生产 stopAll 拒绝，真实公开终态后收尾允许', () => {
  const seq = new EventSeq();
  const controlState: MutableKeys = { ...emptyKeys };
  const raw = fakeRaw(controlState);
  const target: WalkBridge = { walkBody: () => fakeBody(raw), stopAll: () => raw.clearControlStates() };
  const diag = new WalkDiagnostics(target, () => 'task_B', () => snapshotKeys({ controlState }), seq, raw, () => 1000);
  const exec = new ExecutionDiagnostics(seq, () => 'task_B', () => 1000);
  diag.wrap();
  exec.wrap();
  try {
    target.walkBody!(); // 最近 body 归属 B
    const takeoverSeq = diag.bindings.find((b) => b.kind === 'body')!.seq;
    target.stopAll(); // B 活动窗口内：本场景没有授权 cancel/pause/disconnect
    const inWindow = diag.stopAlls[0]!;

    // 终态来自真实公开 status.result（错误 scope 的样本会终结 loop），不是预计时间。
    const loop = new WalkRouteExecutor(new VoxelMap('world', { validityWindowMs: 60_000 }), { move: async () => ({ failure: { kind: 'cancelled' } as const }), stop: () => {} }, { now: () => 1000 });
    const started = loop.start({
      worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
      body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
      arrival: { kind: 'exact' }, shapeProvider: walkCollisionProvider, deadlineMs: 5000, timeoutMs: 1000,
    });
    loop.onSample({
      worldId: 'other', dim: 'overworld', sessionId: 's1', executionId: started.delegationId,
      pos: { x: 0.5, y: 0, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, observedAt: 1000, sequence: 1,
      alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
    });
    const terminalSeq = publicRouteTerminalSeq(exec.routeCalls, exec.deliveredSamples, 'task_B', started.delegationId);
    assert.notEqual(terminalSeq, null, '必须有真实公开终态');

    target.stopAll(); // 终态后的正常 Arbiter 收尾
    const afterTerminal = diag.stopAlls[1]!;
    assert.equal(inWindow.recentBodyOwnerTaskId, 'task_B');
    assert.equal(afterTerminal.recentBodyOwnerTaskId, 'task_B', '两者最近 body owner 相同');
    assert.deepEqual(productionStopAllsInWindow(diag.stopAlls, takeoverSeq, terminalSeq!).map((s) => s.seqBefore), [inWindow.seqBefore], '活动窗口内的生产 stopAll 必须被拒');
    assert.deepEqual(productionStopAllsInWindow(diag.stopAlls, terminalSeq!, Number.POSITIVE_INFINITY).map((s) => s.seqBefore), [afterTerminal.seqBefore], '真实终态后的收尾允许');
  } finally {
    diag.unwrap();
    exec.unwrap();
  }
});

// --- WalkDiagnostics：请求/实际调用分离、创建时绑定、stopAll 前后（假夹具） ---

type MutableKeys = { [K in keyof typeof emptyKeys]: boolean };

function fakeRaw(controlState: MutableKeys) {
  return {
    setControlState(name: string, value: boolean) { controlState[name as keyof MutableKeys] = value; },
    clearControlStates() { for (const k of Object.keys(controlState) as (keyof MutableKeys)[]) controlState[k] = false; },
  };
}

function fakeBody(raw: { setControlState(name: string, value: boolean): void; clearControlStates(): void }) {
  return {
    setControlState: (name: string, value: boolean) => raw.setControlState(name, value),
    clearControlStates: () => raw.clearControlStates(),
    look() {},
    entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false },
  };
}

test('WalkDiagnostics：body 请求与实际 Bot 调用分开，归属绑定在 walkBody 创建时', () => {
  let current: string | null = 'task_A';
  const controlState: MutableKeys = { ...emptyKeys };
  const raw = fakeRaw(controlState);
  const target: WalkBridge = { walkBody: () => fakeBody(raw), stopAll: () => {} };
  const seq = new EventSeq();
  const diag = new WalkDiagnostics(target, () => current, () => snapshotKeys({ controlState }), seq, raw, () => 0);
  diag.wrap();

  const body = target.walkBody!();
  current = 'task_B'; // 创建之后换主：旧 body 的请求与实际调用仍属 task_A

  body.setControlState('forward', true);
  body.setControlState('back', false); // 原本就是 false，仍必须记录这次真实调用
  body.clearControlStates();
  body.look(0, 0);

  assert.deepEqual(diag.attempts.map((c) => c.ownerTaskId), ['task_A', 'task_A', 'task_A', 'task_A']);
  assert.deepEqual(diag.attempts.map((c) => c.op), ['set', 'set', 'clear', 'look']);
  assert.deepEqual(diag.actualControls.map((c) => c.op), ['set', 'set', 'clear']);
  assert.deepEqual(diag.actualControls.map((c) => c.ownerTaskId), ['task_A', 'task_A', 'task_A']);
  assert.equal(diag.actualControls[0]!.keysBefore.forward, false);
  assert.equal(diag.actualControls[0]!.keysAfter.forward, true);
  assert.equal(diag.actualControls[1]!.keysBefore.back, false, '原状态 false 也要记录');
  assert.equal(diag.actualControls[1]!.keysAfter.back, false);
  assert.equal(diag.actualControls[2]!.keysAfter.forward, false, 'clear 实际释放 forward');
  const allSeq = [...diag.attempts, ...diag.actualControls].map((c) => c.seq);
  assert.equal(new Set(allSeq).size, allSeq.length, 'eventSeq 在整个场景内唯一递增');
  assert.ok(diag.attempts.every((c, i) => i === 0 || c.seq > diag.attempts[i - 1]!.seq));
  assert.ok(diag.actualControls.every((c, i) => i === 0 || c.seq > diag.actualControls[i - 1]!.seq));
  assert.ok(diag.attempts[0]!.seq < diag.actualControls[0]!.seq, '请求先于对应的实际调用');
  diag.unwrap();
});

test('WalkDiagnostics：生产 stopAll 记录前后全键与 eventSeq，归属字段只表示最近 body', () => {
  const controlState: MutableKeys = { ...emptyKeys };
  const raw = fakeRaw(controlState);
  let stopped = false;
  const target: WalkBridge = {
    walkBody: () => fakeBody(raw),
    stopAll: () => { stopped = true; raw.clearControlStates(); },
  };
  const diag = new WalkDiagnostics(target, () => 'task_A', () => snapshotKeys({ controlState }), new EventSeq(), raw, () => 123);
  diag.wrap();

  target.walkBody!().setControlState('forward', true);
  target.stopAll();

  assert.equal(stopped, true);
  assert.equal(diag.stopAlls.length, 1);
  const rec = diag.stopAlls[0]!;
  assert.equal(rec.label, 'production-stopAll');
  assert.equal(rec.kind, 'production');
  assert.equal(rec.recentBodyOwnerTaskId, 'task_A', '只记录最近 body 归属，不冒充 stopAll 调用者');
  assert.equal(rec.ts, 123);
  assert.equal(rec.keysBefore.forward, true, 'before 必须在真实 stopAll 清键之前采集');
  assert.equal(rec.keysAfter.forward, false);
  assert.ok(rec.seqAfter > rec.seqBefore);
  // stopAll 内嵌的 raw.clearControlStates 真实调用者未知：不得冒充最近 body 任务，
  // 但 StopAllRecord 仍保留 recentBodyOwnerTaskId 上下文。
  assert.equal(diag.actualControls.some((c) => c.op === 'clear' && c.ownerTaskId === null), true, '嵌套 raw clear 的归属应为未知 null');
  assert.equal(diag.actualControls.some((c) => c.op === 'clear' && c.ownerTaskId === 'task_A'), false, '不得把最近 body 任务冒充 stopAll 调用者');
  diag.unwrap();
});

test('WalkDiagnostics：unwrap 恢复原实现且不清键、不调用 stopAll', () => {
  const controlState: MutableKeys = { ...emptyKeys };
  const raw = fakeRaw(controlState);
  let stopCalls = 0;
  const target: WalkBridge = { walkBody: () => fakeBody(raw), stopAll: () => { stopCalls++; } };
  const originalBody = target.walkBody;
  const originalStop = target.stopAll;
  const diag = new WalkDiagnostics(target, () => 'task_A', () => snapshotKeys({ controlState }), new EventSeq(), raw);
  diag.wrap();
  target.walkBody!().setControlState('forward', true);
  const actualBefore = diag.actualControls.length;
  diag.unwrap();
  assert.equal(target.walkBody, originalBody);
  assert.equal(target.stopAll, originalStop);
  assert.equal(controlState.forward, true, '解绑不得清新键');
  assert.equal(stopCalls, 0, '解绑不得调用 stopAll');
  assert.equal(diag.actualControls.length, actualBefore);
});

test('WalkDiagnostics：walkTick 记录等待/交付的 eventSeq 并绑定创建时归属', async () => {
  let current: string | null = 'task_A';
  const entity = { position: { x: 1, y: 64, z: 2 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  const target: WalkBridge = { walkTick: () => async () => entity, stopAll: () => {} };
  const diag = new WalkDiagnostics(target, () => current, () => snapshotKeys({ controlState: { ...emptyKeys } }), new EventSeq());
  diag.wrap();
  const tick = target.walkTick!();
  current = 'task_B';
  const got = await tick(new AbortController().signal);
  assert.equal(got, entity);
  assert.equal(diag.ticks.length, 1);
  assert.equal(diag.ticks[0]!.ownerTaskId, 'task_A');
  assert.equal(diag.ticks[0]!.delivered, true);
  assert.deepEqual(diag.ticks[0]!.pos, { x: 1, y: 64, z: 2 });
  assert.ok(diag.ticks[0]!.seqEnd > diag.ticks[0]!.seqStart);
  diag.unwrap();
});

// --- ExecutionDiagnostics：公开 start/advance/onSample/setFrameSink/move 的包装与恢复 ---

test('ExecutionDiagnostics：move 段绑定创建时任务与真实 delegation/executionId', async () => {
  const exec = new ExecutionDiagnostics(new EventSeq(), () => 'task_A', () => 0);
  const origMove = WalkMoveExecutor.prototype.move;
  const origStart = WalkRouteExecutor.prototype.start;
  const origSetFrameSink = WalkMoveExecutor.prototype.setFrameSink;
  exec.wrap();
  assert.notEqual(WalkMoveExecutor.prototype.move, origMove);

  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  const loop = new WalkRouteExecutor(map, { move: async () => ({ failure: { kind: 'cancelled' } as const }), stop: () => {} });
  const started = loop.start({
    worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
    body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
    points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
    arrival: { kind: 'exact' }, bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
    deadlineMs: Date.now() + 5000, timeoutMs: 1000,
  });

  const entity = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  const body = { setControlState() {}, clearControlStates() {}, look() {}, entity };
  const parent = new AbortController();
  const tick = () => { parent.abort(); return Promise.resolve(entity); };
  const executor = new WalkMoveExecutor(body, tick, parent.signal, () => 0);
  executor.setFrameSink(() => {});
  await executor.move({
    executionId: `${started.delegationId}-step-0`, worldId: 'w', dim: 'd', sessionId: 's',
    from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, deadlineMs: 1000, timeoutMs: 100, signal: new AbortController().signal,
  });

  assert.equal(exec.moves.length, 1);
  const m = exec.moves[0]!;
  assert.equal(m.executionId, `${started.delegationId}-step-0`);
  assert.equal(m.delegationId, started.delegationId);
  assert.equal(m.taskId, 'task_A');
  assert.deepEqual(m.from, { x: 0, y: 0, z: 0 });
  assert.deepEqual(m.to, { x: 1, y: 0, z: 0 });
  assert.equal(exec.bindings.some((b) => b.kind === 'frameSink' && b.ownerTaskId === 'task_A'), true);
  assert.equal(exec.routeCalls.filter((c) => c.op === 'start' && c.ownerTaskId === 'task_A').length, 1);

  exec.unwrap();
  assert.equal(WalkMoveExecutor.prototype.move, origMove);
  assert.equal(WalkRouteExecutor.prototype.start, origStart);
  assert.equal(WalkMoveExecutor.prototype.setFrameSink, origSetFrameSink);
});

test('ExecutionDiagnostics：onSample 保存完整原始样本与状态前后，接受需由 lastPosition 证明', () => {
  const exec = new ExecutionDiagnostics(new EventSeq(), () => 'task_A', () => 1000);
  const orig = WalkRouteExecutor.prototype.onSample;
  exec.wrap();
  assert.notEqual(WalkRouteExecutor.prototype.onSample, orig);

  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  const loop = new WalkRouteExecutor(map, { move: async () => ({ failure: { kind: 'cancelled' } as const }), stop: () => {} }, { now: () => 1000 });
  const status = loop.start({
    worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
    body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
    points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
    arrival: { kind: 'exact' }, bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
    deadlineMs: Date.now() + 5000, timeoutMs: 1000,
  });
  const delegationId = status.delegationId;
  loop.onSample({
    worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: delegationId,
    pos: { x: 0.5, y: 0, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, observedAt: 1000, sequence: 1,
    alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
  });

  assert.equal(exec.deliveredSamples.length, 1);
  const rec = exec.deliveredSamples[0]!;
  assert.equal(rec.ownerTaskId, 'task_A');
  assert.equal(rec.delegationId, delegationId);
  assert.equal(rec.sample.executionId, delegationId);
  assert.equal(rec.sample.worldId, 'world');
  assert.equal(rec.sample.dim, 'overworld');
  assert.equal(rec.sample.sessionId, 's1');
  assert.equal(rec.sample.sequence, 1);
  assert.equal(rec.sample.observedAt, 1000);
  assert.equal(rec.statusBefore.result, null);
  assert.deepEqual(rec.statusAfter.lastPosition, { x: 0.5, y: 0, z: 0.5 });
  assert.equal(acceptedMeasurements(exec.deliveredSamples, 'task_A', delegationId).length, 1);

  // 错误 sample id 只记录为交付，不能计入接受。
  loop.onSample({
    worldId: 'world', dim: 'overworld', sessionId: 's1', executionId: 'other',
    pos: { x: 1, y: 0, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, observedAt: 1100, sequence: 2,
    alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
  });
  assert.equal(exec.deliveredSamples.length, 2);
  assert.equal(acceptedMeasurements(exec.deliveredSamples, 'task_A', delegationId).length, 1);

  exec.unwrap();
  assert.equal(WalkRouteExecutor.prototype.onSample, orig);
});

test('WalkRouteExecutor 真实公开库：start 仅 pending/INCOMPLETE，真实 map 写入+observe 后才 OPEN', () => {
  const exec = new ExecutionDiagnostics(new EventSeq(), () => 'task_B', () => 1000);
  exec.wrap();
  try {
    const map = new VoxelMap('world', { validityWindowMs: 60_000, now: () => 1000 });
    const loop = new WalkRouteExecutor(map, { move: async () => ({ failure: { kind: 'cancelled' } as const }), stop: () => {} }, { now: () => 1000 });
    const start = loop.start({
      worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
      body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
      arrival: { kind: 'exact' }, bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
      deadlineMs: 5000, timeoutMs: 1000,
    });
    assert.equal(start.route.verdict, 'INCOMPLETE', 'start 只注册待验证路线');
    assert.equal(start.route.complete, false);
    assert.deepEqual(start.route.verifiedStepIndexes, []);
    assert.deepEqual(start.route.pendingStepIndexes, [0]);
    assert.equal(start.route.steps[0]!.kind, 'pending');

    let sequence = 0;
    const observation = (x: number, y: number, z: number, name: string) => ({
      worldId: 'world', dim: 'overworld', sessionId: 's1', pos: { x, y, z },
      state: { name, properties: {} }, stateComplete: true, evidence: 'seen' as const,
      observedAt: 1000, source: 'vision' as const, sequence: ++sequence,
    });
    const report = map.observeBatch({
      observations: [
        observation(0, -1, 0, 'minecraft:stone'), observation(1, -1, 0, 'minecraft:stone'),
        observation(0, 0, 0, 'minecraft:air'), observation(1, 0, 0, 'minecraft:air'),
        observation(0, 1, 0, 'minecraft:air'), observation(1, 1, 0, 'minecraft:air'),
      ],
      unobserved: [],
    });
    const verified = loop.observe(report, 16);
    assert.equal(verified.route.verdict, 'OPEN', '只有真实 observe 推进验证后才 OPEN');
    assert.equal(verified.route.complete, true);
    assert.deepEqual(verified.route.verifiedStepIndexes, [0]);
    assert.equal(verified.route.steps[0]!.kind, 'verified');
    assert.equal(verified.route.steps[0]!.kind === 'verified' ? verified.route.steps[0]!.result.status : null, 'OPEN');
    assert.equal(exec.routeCalls[0]!.ownerTaskId, 'task_B');
    assert.equal(exec.observes[0]!.ownerTaskId, 'task_B');
    assert.equal(exec.observes[0]!.statusAfter.route?.verdict, 'OPEN', 'B 归属的 observe 快照才证明 OPEN');
  } finally {
    exec.unwrap();
  }
});

test('TaskTracker：done 只在 entries 存在且未 settled 时保存一次完整结果', async () => {
  const em = new FakeEmitter();
  const tracker = new TaskTracker(em as never);
  const task = {
    id: 't_1', planVersion: 1, skill: 'walk_route', args: { points: [] }, source: 'user' as const,
    startedAt: 1, deadline: 10, progress: 0, note: '', movement: true,
  };
  const done = tracker.register(task, { points: [], deadlineMs: 10 }, { worldId: 'w', dim: 'd', sessionId: 's', alive: true, connected: true, observationReady: true });
  const outcome = {
    task, durationMs: 5,
    result: { status: 'succeeded' as const, summary: 'ok', data: { nav: arrivedNav() } },
  };
  em.emit('done', outcome);
  em.emit('done', outcome);
  const got = await done;
  assert.equal(got, outcome);
  assert.equal(tracker.outcomes.length, 1, '同一任务只保存一次');
  assert.deepEqual(tracker.outcomes[0]!.result, outcome.result);
  em.emit('done', { ...outcome, task: { ...task, id: 'unknown' } });
  assert.equal(tracker.outcomes.length, 1, '未登记任务不得写入');
  tracker.dispose();
});

// --- ConnectionTracker / quitClient：真实 end / 已观测 / 缺 end 超时 / 监听器移除 ---

class FakeEmitter {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  on(e: string, fn: (...args: unknown[]) => void) {
    let set = this.listeners.get(e);
    if (!set) { set = new Set(); this.listeners.set(e, set); }
    set.add(fn);
  }
  removeListener(e: string, fn: (...args: unknown[]) => void) {
    this.listeners.get(e)?.delete(fn);
  }
  emit(e: string, ...args: unknown[]) {
    for (const fn of [...(this.listeners.get(e) ?? [])]) fn(...args);
  }
  count(e: string): number { return this.listeners.get(e)?.size ?? 0; }
}

test('ConnectionTracker：断线即 ended，再 spawn 即恢复（connected=false 不等于 closed）', () => {
  const em = new FakeEmitter();
  const t = new ConnectionTracker(em as never);
  assert.equal(t.alreadyEnded(), false, '未断线不得判定为已结束');
  em.emit('disconnected', 'bye');
  assert.equal(t.alreadyEnded(), true);
  em.emit('spawn');
  assert.equal(t.alreadyEnded(), false, '断线后又 spawn 不得判定为已结束');
  t.dispose();
});

test('quitClient：真实断线事件 → ended=true 且移除监听器、调用 quit', async () => {
  const em = new FakeEmitter();
  const tracker = new ConnectionTracker(em as never);
  let quitCalled = false;
  const adapter = { bot: { quit: () => {} }, quit: () => { quitCalled = true; }, on: em.on.bind(em), removeListener: em.removeListener.bind(em) };
  const p = quitClient(adapter as never, tracker, 5000);
  assert.equal(quitCalled, true, 'quitClient 必须主动调用 quit');
  em.emit('disconnected', 'normal');
  const r = await p;
  assert.equal(r.ended, true);
  assert.equal(em.count('disconnected'), 1, '完成后必须移除 quitClient 自己的断线监听器（仅剩 tracker 的）');
  tracker.dispose();
});

test('quitClient：已观测到断线（connection-lifetime）→ 快返仍调用 quit 撤销计划重连', async () => {
  const em = new FakeEmitter();
  const tracker = new ConnectionTracker(em as never);
  em.emit('disconnected', 'earlier'); // 已发生过的断线
  let quitCalled = 0;
  const adapter = { bot: { quit: () => {} }, quit: () => { quitCalled++; }, on: em.on.bind(em), removeListener: em.removeListener.bind(em) };
  const r = await quitClient(adapter as never, tracker, 5000);
  assert.equal(r.ended, true);
  assert.equal(r.reason, 'already-observed end');
  assert.equal(quitCalled, 1, 'alreadyEnded 快返也必须调用 adapter.quit，取消自动重连计划');
  tracker.dispose();
});

test('quitClient：无 bot 快返仍调用 quit；不把 connected=false 当作已关闭', async () => {
  const em = new FakeEmitter();
  const tracker = new ConnectionTracker(em as never);
  let quitCalled = 0;
  const adapter = { bot: null, quit: () => { quitCalled++; }, on: em.on.bind(em), removeListener: em.removeListener.bind(em) };
  const r = await quitClient(adapter as never, tracker, 5000);
  assert.equal(r.ended, true);
  assert.equal(r.reason, 'no bot');
  assert.equal(quitCalled, 1, 'no bot 快返也必须调用 adapter.quit，撤销已排定的重连');
  tracker.dispose();
});

test('quitClient：缺真实 end → 超时 ended=false（清理失败），并移除监听器', async () => {
  const em = new FakeEmitter();
  const tracker = new ConnectionTracker(em as never);
  const adapter = { bot: { quit: () => {} }, quit: () => {}, on: em.on.bind(em), removeListener: em.removeListener.bind(em) };
  const r = await quitClient(adapter as never, tracker, 20);
  assert.equal(r.ended, false);
  assert.equal(em.count('disconnected'), 1, '超时后必须移除 quitClient 自己的监听器（仅剩 tracker 的）');
  tracker.dispose();
});

// --- W7 断言：真实 deadline / 部分位移 / pending / listener / end 的负例拒绝 ---

function tickEntry(o: Partial<TickEntry> = {}): TickEntry {
  return {
    seqStart: 1, seqEnd: 2, tsStart: 100, tsEnd: 150, diagId: 'tick-1', ownerTaskId: 'task_A', delivered: true,
    pending: false, signalAbortedAtEnd: false,
    signalAbortListenersAtStart: 0, signalAbortListenersWhilePending: 1, signalAbortListenersAtEnd: 0,
    botPhysicsTickListenersAtStart: 1, botPhysicsTickListenersWhilePending: 2, botPhysicsTickListenersAtEnd: 1,
    botEndListenersAtStart: 0, botEndListenersWhilePending: 1, botEndListenersAtEnd: 0,
    ownedAbortAdded: 1, ownedPhysicsTickAdded: 1, ownedEndAdded: 1,
    ownedAbortResidual: 0, ownedPhysicsTickResidual: 0, ownedEndResidual: 0,
    ...o,
  };
}

test('assertTimeoutAfterDeadline：早于全局 deadline 的 TIMEOUT 拒绝，超有限延迟也拒绝', () => {
  assert.doesNotThrow(() => assertTimeoutAfterDeadline(10_000, 10_000, 1500, 'W7a'), '恰好 deadline 合法');
  assert.doesNotThrow(() => assertTimeoutAfterDeadline(10_900, 10_000, 1500, 'W7a'));
  assert.throws(() => assertTimeoutAfterDeadline(9_999, 10_000, 1500, 'W7a'), /早于全局 deadline/);
  assert.throws(() => assertTimeoutAfterDeadline(11_501, 10_000, 1500, 'W7a'), /有限延迟边界/);
  assert.throws(() => assertTimeoutAfterDeadline(Number.NaN, 10_000, 1500, 'W7a'), /非有限数/);
});

test('assertRealPartial：无位移但有 lastPosition、wrong task/sample 均拒绝', () => {
  const pos = { x: 1.0, y: 64, z: 0.5 };
  const rec = delivery(pos, statusSnap(), statusSnap({ lastPosition: pos }), { owner: 'task_A', delegationId: 'walk-1', sequence: 7 });
  const nav: NavResult = {
    outcome: 'CANCELLED', message: 'x', trace: [], confirmed: false,
    problem: { kind: 'cancelled', by: 'user', reason: 'x' },
    lastPosition: { ...pos },
    lastObservation: { worldId: 'w', dim: 'd', sessionId: 's', observedAt: rec.sample.observedAt, onGround: true, inWater: false },
  };
  assert.doesNotThrow(() => assertRealPartial(nav, [rec], 'task_A', 'walk-1', { x: 0, y: 64, z: 0.5 }, 0.5, 'W7x'));
  assert.throws(
    () => assertRealPartial(nav, [rec], 'task_A', 'walk-1', { x: 1.0, y: 64, z: 0.5 }, 0.5, 'W7x'),
    /实际位移/,
    '初始位置存在但相对起点没有位移，必须拒绝',
  );
  assert.throws(
    () => assertRealPartial(nav, [rec], 'task_B', 'walk-1', { x: 0, y: 64, z: 0.5 }, 0.5, 'W7x'),
    /wrong task\/sample/,
    '别的 task 的样本不得冒充本任务测量',
  );
  const wrongId = { ...rec, sample: { ...rec.sample, executionId: 'walk-9' } };
  assert.throws(() => assertRealPartial(nav, [wrongId], 'task_A', 'walk-1', { x: 0, y: 64, z: 0.5 }, 0.5, 'W7x'), /wrong task\/sample/);
});

test('assertOwnedTicksReleased：pending 未解除、signal/physicsTick/end 监听器残留均拒绝', () => {
  const base = tickEntry();
  assert.doesNotThrow(() => assertOwnedTicksReleased([base], 'task_A', 'W7x'));
  assert.throws(() => assertOwnedTicksReleased([{ ...base, pending: true }], 'task_A', 'W7x'), /未解除/);
  assert.throws(
    () => assertOwnedTicksReleased([{ ...base, ownedAbortResidual: 1 }], 'task_A', 'W7x'),
    /残留 walkTick 监听器/,
  );
  assert.throws(
    () => assertOwnedTicksReleased([{ ...base, ownedPhysicsTickResidual: 1 }], 'task_A', 'W7x'),
    /残留 walkTick 监听器/,
  );
  assert.throws(
    () => assertOwnedTicksReleased([{ ...base, ownedEndResidual: 1 }], 'task_A', 'W7x'),
    /残留 walkTick 监听器/,
  );
  assert.doesNotThrow(
    () => assertOwnedTicksReleased([{
      ...base,
      signalAbortListenersAtEnd: base.signalAbortListenersAtStart + 5,
      botPhysicsTickListenersAtEnd: base.botPhysicsTickListenersAtStart + 5,
      botEndListenersAtEnd: base.botEndListenersAtStart + 5,
    }], 'task_A', 'W7x'),
    '全局总数变化只作诊断，不能代替 owned 归属清理而误报',
  );
  assert.doesNotThrow(
    () => assertOwnedTicksReleased([{ ...base, ownerTaskId: 'task_B', pending: true }], 'task_A', 'W7x'),
    '别的 task 的 pending 不得误判为本任务',
  );
});

test('assertEndObserved：缺 adapter.disconnected / bot.end 或早于 quit 均拒绝', () => {
  assert.doesNotThrow(() => assertEndObserved(12, 11, 10, 'W7c'), '事件顺序可因监听器注册先后而不同');
  assert.throws(() => assertEndObserved(null, 12, 10, 'W7c'), /adapter.disconnected/);
  assert.throws(() => assertEndObserved(12, null, 10, 'W7c'), /bot.end/);
  assert.throws(() => assertEndObserved(9, 12, 10, 'W7c'), /早于 quit/);
});

test('assertListenerBaseline：physicsTick/end 任一未恢复基线都拒绝', () => {
  assert.doesNotThrow(() => assertListenerBaseline({ physicsTick: 1, end: 0 }, { physicsTick: 1, end: 0 }, 'W7x'));
  assert.throws(() => assertListenerBaseline({ physicsTick: 1, end: 0 }, { physicsTick: 2, end: 0 }, 'W7x'), /监听器未恢复到基线/);
  assert.throws(() => assertListenerBaseline({ physicsTick: 1, end: 0 }, { physicsTick: 1, end: 1 }, 'W7x'), /监听器未恢复到基线/);
});

test('WalkDiagnostics：walkTick 等待期间记录真实 pending/监听器，帧交付后全部移除', async () => {
  const emitter = new EventEmitter();
  const controlState: MutableKeys = { ...emptyKeys };
  const raw = Object.assign(emitter, fakeRaw(controlState));
  const entity = { position: { x: 1, y: 64, z: 2 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  const target: WalkBridge = {
    walkTick: () => (signal) => new Promise((resolve) => {
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        emitter.removeListener('physicsTick', onTick);
        emitter.removeListener('end', onEnd);
      };
      const onTick = () => { cleanup(); resolve(entity); };
      const onAbort = () => { cleanup(); resolve(null); };
      const onEnd = () => { cleanup(); resolve(null); };
      signal.addEventListener('abort', onAbort, { once: true });
      emitter.on('physicsTick', onTick);
      emitter.once('end', onEnd);
    }),
    stopAll: () => {},
  };
  const diag = new WalkDiagnostics(target, () => 'task_A', () => snapshotKeys({ controlState }), new EventSeq(), raw);
  diag.wrap();
  const tick = target.walkTick!();
  const p = tick(new AbortController().signal);
  const entry = diag.ticks[0]!;
  assert.equal(entry.pending, true, '等待开始即记为 pending，而不是完成后才补记');
  assert.equal(entry.botPhysicsTickListenersWhilePending, entry.botPhysicsTickListenersAtStart + 1);
  assert.equal(entry.botEndListenersWhilePending, entry.botEndListenersAtStart + 1);
  assert.equal(entry.signalAbortListenersWhilePending, entry.signalAbortListenersAtStart + 1);
  emitter.emit('physicsTick');
  assert.equal(await p, entity);
  assert.equal(entry.pending, false);
  assert.equal(entry.botPhysicsTickListenersAtEnd, entry.botPhysicsTickListenersAtStart);
  assert.equal(entry.botEndListenersAtEnd, entry.botEndListenersAtStart);
  assert.equal(entry.signalAbortListenersAtEnd, entry.signalAbortListenersAtStart);
  assert.doesNotThrow(() => assertOwnedTicksReleased(diag.ticks, 'task_A', 'fake'));
  diag.unwrap();
});

function routeStart(taskId: string, delegationId: string): RouteCallRecord {
  return {
    seq: 1, ts: 1, op: 'start', ownerTaskId: taskId, delegationId,
    statusBefore: null, statusAfter: statusSnap({ delegationId }),
  };
}

function outcomeFor(taskId: string): TaskOutcome {
  return {
    task: {
      id: taskId, planVersion: 1, skill: 'walk_route', args: {}, source: 'user',
      startedAt: 1, deadline: 2, progress: 0, note: '', movement: true,
    },
    result: { status: 'failed', failureCode: 'TIMEOUT', summary: 'failed:TIMEOUT' },
    durationMs: 5,
  };
}

test('awaitRouteStartRecord：有界等待异步稍后出现的本任务真实 start（fake 数组，非 live）', async () => {
  const calls: RouteCallRecord[] = [routeStart('task_B', 'walk-9')];
  const pending = awaitRouteStartRecord(calls, 'task_A', new Promise<TaskOutcome>(() => {}), 1_000, 'W7x');
  setTimeout(() => calls.push(routeStart('task_A', 'walk-1')), 25);
  const { startCall, delegationId } = await pending;
  assert.equal(delegationId, 'walk-1');
  assert.equal(startCall.ownerTaskId, 'task_A', '别的任务的 start 不得冒充本任务');
});

test('awaitRouteStartRecord：start 前已 done 时如实失败并保留完整 TaskOutcome', async () => {
  const outcome = outcomeFor('task_A');
  await assert.rejects(
    awaitRouteStartRecord([], 'task_A', Promise.resolve(outcome), 1_000, 'W7x'),
    (e: Error) => {
      assert.match(e.message, /真实 walk_route.start 前已结束/);
      assert.match(e.message, /"task":/);
      assert.match(e.message, /"failureCode":"TIMEOUT"/);
      return true;
    },
  );
});

test('awaitRouteStartRecord：无 start 也无 done 时有界超时', async () => {
  await assert.rejects(
    awaitRouteStartRecord([], 'task_A', new Promise<TaskOutcome>(() => {}), 60, 'W7x'),
    /60ms 内未观察到本任务真实 walk_route.start/,
  );
});

test('WalkDiagnostics：pending 期他人监听器增减不误报，own 任一类漏移除仍 FAIL（fake EventEmitter/AbortSignal，非真实断线）', async () => {
  const entity = { position: { x: 1, y: 64, z: 2 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  for (const leak of ['none', 'physicsTick', 'end', 'abort'] as const) {
    const emitter = new EventEmitter();
    const controlState: MutableKeys = { ...emptyKeys };
    const raw = Object.assign(emitter, fakeRaw(controlState));
    const controller = new AbortController();
    const externalTick = () => {};
    const externalEnd = () => {};
    const externalAbort = () => {};
    emitter.on('physicsTick', externalTick);
    emitter.once('end', externalEnd);
    controller.signal.addEventListener('abort', externalAbort);
    let finish: (() => void) | undefined;
    const target: WalkBridge = {
      walkTick: () => (signal) => new Promise((resolve) => {
        const ownTick = () => {};
        const ownEnd = () => {};
        const ownAbort = () => {};
        signal.addEventListener('abort', ownAbort, { once: true });
        emitter.on('physicsTick', ownTick);
        emitter.once('end', ownEnd);
        finish = () => {
          if (leak !== 'physicsTick') emitter.removeListener('physicsTick', ownTick);
          if (leak !== 'end') emitter.removeListener('end', ownEnd);
          if (leak !== 'abort') signal.removeEventListener('abort', ownAbort);
          resolve(entity);
        };
      }),
      stopAll: () => {},
    };
    const diag = new WalkDiagnostics(target, () => 'task_A', () => snapshotKeys({ controlState }), new EventSeq(), raw);
    diag.wrap();
    const p = target.walkTick!()(controller.signal);
    const entry = diag.ticks[0]!;
    assert.equal(entry.pending, true, `${leak}: 等待开始即 pending`);
    assert.equal(entry.diagId, `tick-${entry.seqStart}`);
    assert.equal(entry.ownedAbortAdded, 1);
    assert.equal(entry.ownedPhysicsTickAdded, 1);
    assert.equal(entry.ownedEndAdded, 1);
    // pending 期间：其他监听器正常增加/移除，包含原生 once 移除。
    emitter.removeListener('physicsTick', externalTick);
    emitter.removeListener('end', externalEnd);
    controller.signal.removeEventListener('abort', externalAbort);
    if (leak === 'none') emitter.on('physicsTick', () => {});
    assert.ok(finish);
    finish();
    await p;
    assert.equal(entry.pending, false);
    if (leak === 'none') {
      assert.equal(entry.botPhysicsTickListenersAtEnd, entry.botPhysicsTickListenersAtStart, '总数巧合相同');
      assert.equal(entry.ownedPhysicsTickResidual, 0);
      assert.doesNotThrow(
        () => assertOwnedTicksReleased(diag.ticks, 'task_A', 'fake'),
        '他人监听器变化且总数巧合相同时不得误报',
      );
    } else {
      const residual = { physicsTick: entry.ownedPhysicsTickResidual, end: entry.ownedEndResidual, abort: entry.ownedAbortResidual }[leak];
      const total = { physicsTick: entry.botPhysicsTickListenersAtEnd, end: entry.botEndListenersAtEnd, abort: entry.signalAbortListenersAtEnd }[leak];
      const start = { physicsTick: entry.botPhysicsTickListenersAtStart, end: entry.botEndListenersAtStart, abort: entry.signalAbortListenersAtStart }[leak];
      assert.equal(residual, 1, `${leak}: 本 tick 自己的监听器应残留`);
      assert.equal(total, start, `${leak}: 即使全局总数巧合相同`);
      assert.throws(
        () => assertOwnedTicksReleased(diag.ticks, 'task_A', 'fake'),
        /残留 walkTick 监听器/,
        `${leak}: 自己的监听器漏移除必须 FAIL`,
      );
    }
    diag.unwrap();
  }
});

const W4_CHAIN_OK = {
  taskId: 'task_A',
  issueSeq: 10,
  initialStone: { visionSeq: 5, mapSeq: 6, mapId: 1, name: 'stone' },
  airVision: { seq: 11, name: 'air', frame: 42 },
  airBatch: { seq: 12, reportId: 7, mapId: 1, targetChanged: true, frame: 42 },
  observe: {
    enterSeq: 13, exitSeq: 15, frameEnter: 42, frameExit: 42, reportId: 7,
    statusBeforeActiveStepIndex: 0, statusBeforeOutcome: null,
    statusAfterOutcome: 'FAILED', statusAfterActiveStepIndex: null, statusAfterProblem: 'route_invalidated',
  },
  release: { seq: 14, ownerTaskId: 'task_A' },
  nextSample: { seq: 16, frame: 42 },
  laterMoveCount: 0,
  terminalOutcome: 'FAILED',
};

test('checkW4ObservationChain：合法初观测→同对象report→同帧observe内释放→同帧onSample 才 PASS', () => {
  assert.deepEqual(checkW4ObservationChain(W4_CHAIN_OK), { ok: true });
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, initialStone: null }).reason ?? '', /缺少拆支撑前/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, airVision: null }).reason ?? '', /未输出目标格air/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, airBatch: { ...W4_CHAIN_OK.airBatch, reportId: 8 } }).reason ?? '', /同一个ChangeReport/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, airBatch: { ...W4_CHAIN_OK.airBatch, seq: 11 } }).reason ?? '', /报告早于Vision/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, observe: { ...W4_CHAIN_OK.observe, statusBeforeActiveStepIndex: null } }).reason ?? '', /不在途/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, observe: { ...W4_CHAIN_OK.observe, statusBeforeOutcome: 'FAILED' } }).reason ?? '', /不在途/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, release: { seq: 15, ownerTaskId: 'task_A' } }).reason ?? '', /控制释放不在/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, release: { seq: 14, ownerTaskId: 'task_B' } }).reason ?? '', /不属于本task/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, release: null }).reason ?? '', /未捕获/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, nextSample: { seq: 14, frame: 42 } }).reason ?? '', /onSample 不晚于/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, nextSample: null }).reason ?? '', /缺少后续真实 onSample/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, nextSample: { seq: 16, frame: 43 } }).reason ?? '', /later frame/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, airBatch: { ...W4_CHAIN_OK.airBatch, frame: 43 } }).reason ?? '', /map报告与Vision/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, observe: { ...W4_CHAIN_OK.observe, frameEnter: 43 } }).reason ?? '', /loop.observe 不在/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, laterMoveCount: 1 }).reason ?? '', /后续段/);
  assert.match(checkW4ObservationChain({ ...W4_CHAIN_OK, terminalOutcome: 'ARRIVED' }).reason ?? '', /ARRIVED/);
});

const W5_EYE = { x: 217.5, y: 65.62, z: 205.52, yaw: -Math.PI / 2, pitch: -1.2 };
const W5_BEFORE_ROUTE = {
  stepCount: 4, complete: true, verdict: 'OPEN', openPrefix: 4,
  verifiedStepIndexes: [0, 1, 2, 3], pendingStepIndexes: [], invalidatedCount: 0, earliestProblem: null,
  steps: [0, 1, 2, 3].map(() => ({ kind: 'verified' as const, status: 'OPEN', problemKind: null })),
};
const W5_AFTER_ROUTE = {
  stepCount: 4, complete: true, verdict: 'BLOCKED', openPrefix: 3,
  verifiedStepIndexes: [0, 1, 2, 3], pendingStepIndexes: [], invalidatedCount: 0,
  earliestProblem: { stepIndex: 3, status: 'BLOCKED', problemKind: 'missing_support' },
  steps: [
    { kind: 'verified' as const, status: 'OPEN', problemKind: null },
    { kind: 'verified' as const, status: 'OPEN', problemKind: null },
    { kind: 'verified' as const, status: 'OPEN', problemKind: null },
    { kind: 'verified' as const, status: 'BLOCKED', problemKind: 'missing_support' },
  ],
};
const W5_CHAIN_OK = {
  taskId: 'task_A',
  delegationId: 'walk-1',
  stoneMapId: 1,
  removalSeq: 11,
  hidden: {
    startSeq: 10, startAt: 1000, responseSeq: 12, responseFrame: 39, endSeq: 30, endAt: 1300,
    views: [
      { seq: 13, frame: 40, eye: W5_EYE, targetInPositions: false, targetInFov: false, targetOutput: null },
      { seq: 14, frame: 41, eye: W5_EYE, targetInPositions: false, targetInFov: false, targetOutput: null },
    ],
    batches: [{ seq: 15, frame: 40, targetObservation: false, targetChanged: false }],
  },
  cellBefore: {
    observed: true, name: 'stone', properties: {}, observedAt: 100, sequence: 3, originObservationId: 3,
    sessionId: 's', revision: 1, freshness: 'FRESH', validUntil: 600,
    captureAt: 1000, captureSeq: 10, captureFrame: 40, body: { x: 217.5, y: 64, z: 205.52 }, eye: W5_EYE,
  },
  cellDuring: {
    observed: true, name: 'stone', properties: {}, observedAt: 100, sequence: 3, originObservationId: 3,
    sessionId: 's', revision: 1, freshness: 'FRESH', validUntil: 600,
    captureAt: 1200, captureSeq: 16, captureFrame: 41, body: { x: 217.5, y: 64, z: 205.52 }, eye: W5_EYE,
  },
  returnMove: {
    seq: 30, executionId: 'walk-1-step-2',
    from: { x: 217.55, y: 64, z: 205.52 }, to: { x: 216.55, y: 64, z: 205.52 },
  },
  reveal: {
    seq: 31, frame: 50, name: 'air', mapId: 1, observedAt: 200,
    eye: { ...W5_EYE, yaw: Math.PI / 2 }, targetInFov: true, precedingTargetOutputs: [],
  },
  revealBatch: { seq: 32, mapId: 1, reportId: 9, targetChanged: true },
  revealObserve: {
    reportId: 9, ownerTaskId: 'task_A', delegationId: 'walk-1', enterSeq: 33,
    statusBeforeOutcome: null, statusBeforeActiveStepIndex: 2,
    statusAfterOutcome: null, statusAfterActiveStepIndex: 2,
  },
  routeProof: {
    before: W5_BEFORE_ROUTE, after: W5_AFTER_ROUTE, totalSteps: 4, step3Started: false,
    moveExecutionIds: ['walk-1-step-0', 'walk-1-step-1', 'walk-1-step-2'],
    moveCount: 3, startedStepIndexes: [0, 1, 2],
  },
  terminal: {
    navPresent: true, outcome: 'FAILED', confirmed: false, problemKind: 'route_invalidated',
    lastPosition: { x: 216.55, y: 64, z: 205.52 }, allKeysReleased: true,
  },
};

test('checkW5HiddenReveal：真实隐藏窗口+返程 step2 回看+未来 step3 失效才 PASS', () => {
  assert.deepEqual(checkW5HiddenReveal(W5_CHAIN_OK), { ok: true });
  assert.match(checkW5HiddenReveal({ ...W5_CHAIN_OK, reveal: null }).reason ?? '', /只有隐藏半段/);
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      hidden: { ...W5_CHAIN_OK.hidden, views: W5_CHAIN_OK.hidden.views.map((v) => ({ ...v, frame: 40 })) },
    }).reason ?? '',
    /两个不同 physics frame/,
  );
  // response 前即使已有两帧也不能证明变化已执行后仍隐藏。
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      hidden: { ...W5_CHAIN_OK.hidden, responseSeq: 15 },
    }).reason ?? '',
    /成功 response 后至 cellDuring 前不足两个不同 physics frame/,
  );
  // response 后只有一帧。
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      hidden: { ...W5_CHAIN_OK.hidden, responseSeq: 13 },
    }).reason ?? '',
    /成功 response 后至 cellDuring 前不足两个不同 physics frame/,
  );
  // 两帧都在 response 后，但第二帧不在 cellDuring 之前。
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      cellDuring: { ...W5_CHAIN_OK.cellDuring, captureSeq: 14 },
    }).reason ?? '',
    /成功 response 后至 cellDuring 前不足两个不同 physics frame/,
  );
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      hidden: { ...W5_CHAIN_OK.hidden, views: [{ ...W5_CHAIN_OK.hidden.views[0]!, targetOutput: 'air' }, W5_CHAIN_OK.hidden.views[1]!] },
    }).reason ?? '',
    /已输出目标格/,
  );
  // 成功 response 之前的坏观察仍属于完整隐藏窗口，不能因后段证据齐全而被忽略。
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      hidden: {
        ...W5_CHAIN_OK.hidden, responseSeq: 14,
        views: [
          { ...W5_CHAIN_OK.hidden.views[0]!, seq: 13, frame: 38, targetOutput: 'stone' },
          { ...W5_CHAIN_OK.hidden.views[0]!, seq: 15, frame: 40, targetOutput: null },
          { ...W5_CHAIN_OK.hidden.views[1]!, seq: 16, frame: 41 },
        ],
      },
      cellDuring: { ...W5_CHAIN_OK.cellDuring, captureSeq: 17 },
    }).reason ?? '',
    /已输出目标格/,
  );
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      hidden: { ...W5_CHAIN_OK.hidden, views: [{ ...W5_CHAIN_OK.hidden.views[0]!, targetInPositions: true }, W5_CHAIN_OK.hidden.views[1]!] },
    }).reason ?? '',
    /候选仍包含目标格/,
  );
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      hidden: { ...W5_CHAIN_OK.hidden, views: [{ ...W5_CHAIN_OK.hidden.views[0]!, targetInFov: true }, W5_CHAIN_OK.hidden.views[1]!] },
    }).reason ?? '',
    /未排除目标 FOV/,
  );
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      hidden: { ...W5_CHAIN_OK.hidden, batches: [{ ...W5_CHAIN_OK.hidden.batches[0]!, targetObservation: true }] },
    }).reason ?? '',
    /map 输入刷新/,
  );
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      hidden: { ...W5_CHAIN_OK.hidden, batches: [{ ...W5_CHAIN_OK.hidden.batches[0]!, targetChanged: true }] },
    }).reason ?? '',
    /已含目标格/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, cellBefore: { ...W5_CHAIN_OK.cellBefore, captureSeq: 9 } }).reason ?? '',
    /baseline 早于隐藏起点/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, cellDuring: { ...W5_CHAIN_OK.cellDuring, captureAt: 1000 } }).reason ?? '',
    /capture 时刻未推进/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, cellDuring: { ...W5_CHAIN_OK.cellDuring, observedAt: 150, revision: 2 } }).reason ?? '',
    /人工刷新/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, reveal: { ...W5_CHAIN_OK.reveal, seq: 30 } }).reason ?? '',
    /返程 move 之后/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, reveal: { ...W5_CHAIN_OK.reveal, name: 'stone' } }).reason ?? '',
    /不是air/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, reveal: { ...W5_CHAIN_OK.reveal, targetInFov: false } }).reason ?? '',
    /回看真实朝向/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, reveal: { ...W5_CHAIN_OK.reveal, precedingTargetOutputs: ['air'] } }).reason ?? '',
    /未被采用/,
  );
  assert.match(checkW5HiddenReveal({ ...W5_CHAIN_OK, reveal: { ...W5_CHAIN_OK.reveal, mapId: 2 } }).reason ?? '', /同一个实际map/);
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, revealObserve: { ...W5_CHAIN_OK.revealObserve, reportId: 10 } }).reason ?? '',
    /同一对象/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, revealObserve: { ...W5_CHAIN_OK.revealObserve, ownerTaskId: 'task_B' } }).reason ?? '',
    /同一 task\/delegation/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, revealObserve: { ...W5_CHAIN_OK.revealObserve, statusBeforeActiveStepIndex: 1 } }).reason ?? '',
    /返程 step2/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, revealObserve: { ...W5_CHAIN_OK.revealObserve, statusBeforeOutcome: 'FAILED' } }).reason ?? '',
    /返程 step2/,
  );
  // before 活跃、本次合法 report 使 after 进入 FAILED 是允许顺序；终态由 terminal 断言。
  assert.deepEqual(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, revealObserve: { ...W5_CHAIN_OK.revealObserve, statusAfterOutcome: 'FAILED' } }),
    { ok: true },
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, returnMove: { ...W5_CHAIN_OK.returnMove, from: { x: 216.55, y: 64, z: 205.52 } } }).reason ?? '',
    /不是 -X 折返/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, routeProof: { ...W5_CHAIN_OK.routeProof, step3Started: true } }).reason ?? '',
    /step3 已启动/,
  );
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      routeProof: { ...W5_CHAIN_OK.routeProof, moveExecutionIds: W5_CHAIN_OK.routeProof.moveExecutionIds.slice(0, 2), moveCount: 2, startedStepIndexes: [0, 1] },
    }).reason ?? '',
    /实际 move 数/,
  );
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      routeProof: {
        ...W5_CHAIN_OK.routeProof,
        after: {
          ...W5_AFTER_ROUTE, verdict: 'OPEN', earliestProblem: null,
          steps: W5_AFTER_ROUTE.steps.map((s, i) => i === 3 ? { kind: 'verified' as const, status: 'OPEN', problemKind: null } : s),
        },
      },
    }).reason ?? '',
    /仍为 OPEN/,
  );
  // 预算内可直接重算时，pending 不能被当作「已知缺支撑」的 verified 结论。
  assert.match(
    checkW5HiddenReveal({
      ...W5_CHAIN_OK,
      routeProof: {
        ...W5_CHAIN_OK.routeProof,
        after: {
          ...W5_AFTER_ROUTE, complete: false, verdict: 'INCOMPLETE', openPrefix: 3,
          verifiedStepIndexes: [0, 1, 2], pendingStepIndexes: [3], earliestProblem: null,
          steps: [...W5_AFTER_ROUTE.steps.slice(0, 3), { kind: 'pending' as const, reason: 'invalidated' as const }],
        },
      },
    }).reason ?? '',
    /尚未重算为 verified/,
  );
  // invalidatedCount 是「当前仍失效未重算」的计数，不是累计事件数，不参与判定。
  assert.deepEqual(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, routeProof: { ...W5_CHAIN_OK.routeProof, after: { ...W5_AFTER_ROUTE, invalidatedCount: 2 } } }),
    { ok: true },
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, terminal: { ...W5_CHAIN_OK.terminal, navPresent: false } }).reason ?? '',
    /真实 Nav/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, terminal: { ...W5_CHAIN_OK.terminal, outcome: 'ARRIVED' } }).reason ?? '',
    /FAILED\/BLOCKED/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, terminal: { ...W5_CHAIN_OK.terminal, confirmed: true } }).reason ?? '',
    /confirmed/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, terminal: { ...W5_CHAIN_OK.terminal, problemKind: null } }).reason ?? '',
    /真实 problem/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, terminal: { ...W5_CHAIN_OK.terminal, lastPosition: null } }).reason ?? '',
    /lastPosition/,
  );
  assert.match(
    checkW5HiddenReveal({ ...W5_CHAIN_OK, terminal: { ...W5_CHAIN_OK.terminal, allKeysReleased: false } }).reason ?? '',
    /7 键/,
  );
});

test('W5 真实 RouteVerifier：预算内失效重算后 step3 OPEN→非OPEN 且 invalidatedCount 归零仍 PASS', () => {
  const now = 3000;
  const worldId = 'world';
  const dim = 'overworld';
  const sessionId = 's1';
  const map = new VoxelMap(worldId, { now: () => now, validityWindowMs: 60_000 });
  let sequence = 0;
  const observeCell = (x: number, y: number, z: number, name: string, observedAt = now - 1000) => map.observe({
    pos: { x, y, z }, state: { name, properties: {} }, stateComplete: true,
    evidence: 'seen', observedAt, source: 'vision', sessionId,
    sequence: ++sequence, dim, worldId,
  });
  // 完整地面 y=0，其余为 air；路线 4 步沿 +X，每步移动一格。
  for (let x = -1; x <= 6; x++) {
    for (let z = -1; z <= 1; z++) {
      for (let y = -1; y <= 3; y++) observeCell(x, y, z, y === 0 ? 'stone' : 'air');
    }
  }

  const verifier = new RouteVerifier(map, { now: () => now });
  const points = [0, 1, 2, 3, 4].map((i) => ({ x: i + 0.5, y: 1, z: 0.5 }));
  verifier.register({
    worldId, dim, sessionId, mode: 'walk',
    body: { feet: { ...points[0]! }, width: 0.6, height: 1.8, pose: 'standing' },
    shapeProvider: walkCollisionProvider, points,
  });
  const before = verifier.advance(64);
  assert.equal(before.steps.length, 4);
  assert.equal(before.steps[3]?.kind, 'verified');
  const beforeStep3 = before.steps[3];
  if (beforeStep3?.kind !== 'verified') assert.fail('拆支撑前 step3 未 verified');
  assert.equal(beforeStep3.result.status, 'OPEN');
  assert.equal(before.invalidatedCount, 0);

  // 真实 observe(path) → ChangeReport → apply 失效重算：移除 step3 使用的支撑格。
  const report = observeCell(4, 0, 0, 'air', now);
  assert.equal(report.sections.some((section) => section.invalidated), true);
  const after = verifier.apply(report, 64);
  assert.ok(after);
  assert.deepEqual(after.pendingStepIndexes, []);
  assert.equal(after.invalidatedCount, 0);
  assert.equal(after.steps[3]?.kind, 'verified');
  const afterStep3 = after.steps[3];
  if (afterStep3?.kind !== 'verified') assert.fail('拆支撑后 step3 未重算为 verified');
  assert.notEqual(afterStep3.result.status, 'OPEN');
  assert.equal(afterStep3.result.problem?.kind, 'missing_support');
  assert.equal(after.earliestProblem?.stepIndex, 3);

  const snapRoute = (s: typeof before): RouteStateSnapshot => ({
    stepCount: s.stepCount,
    complete: s.complete,
    verdict: s.verdict,
    openPrefix: s.openPrefix,
    verifiedStepIndexes: [...s.verifiedStepIndexes],
    pendingStepIndexes: [...s.pendingStepIndexes],
    invalidatedCount: s.invalidatedCount,
    earliestProblem: s.earliestProblem === null ? null : {
      stepIndex: s.earliestProblem.stepIndex,
      status: s.earliestProblem.status,
      problemKind: s.earliestProblem.problem?.kind ?? null,
    },
    steps: s.steps.map((step) => step.kind === 'verified'
      ? { kind: 'verified' as const, status: step.result.status, problemKind: step.result.problem?.kind ?? null }
      : { kind: 'pending' as const, reason: step.reason }),
  });
  // 同一次真实前后状态即可支撑 W5 判据：step3 verified OPEN → verified 非 OPEN。
  assert.deepEqual(checkW5HiddenReveal({
    ...W5_CHAIN_OK,
    routeProof: {
      before: snapRoute(before),
      after: snapRoute(after),
      totalSteps: 4,
      step3Started: false,
      moveExecutionIds: W5_CHAIN_OK.routeProof.moveExecutionIds,
      moveCount: 3,
      startedStepIndexes: [0, 1, 2],
    },
  }), { ok: true });
});

test('mapBatchForEvidence：输出JSON保留原observations/report与编号，且不含实际map对象', () => {
  const seq = new EventSeq();
  const exec = new ExecutionDiagnostics(seq, () => 'task_A', () => 1000, { frame: () => 9 });
  exec.wrap();
  try {
    const map = new VoxelMap('world', { validityWindowMs: 60_000 });
    const observation = {
      worldId: 'world', dim: 'overworld', sessionId: 's1', pos: { x: 1, y: 2, z: 3 },
      state: { name: 'stone', properties: { foo: 'bar' } }, stateComplete: true, evidence: 'seen' as const,
      observedAt: 1234, source: 'vision' as const, sequence: 77,
    };
    const report = map.observeBatch({ observations: [observation], unobserved: [{ pos: { x: 4, y: 5, z: 6 }, reason: 'occluded' as const }] });
    const saved = mapBatchForEvidence(exec.mapBatches[0]!);
    assert.equal('map' in saved, false, '不得保留临时 VoxelMap 引用');
    assert.equal(saved.mapId, exec.mapBatches[0]!.mapId);
    assert.equal(saved.mapWorldId, 'world');
    assert.equal(saved.reportId, exec.mapBatches[0]!.reportId);
    assert.equal(saved.report, report, '保留同一真实报告对象');
    assert.equal(saved.observations[0]!.sequence, 77);
    assert.equal(saved.observations[0]!.observedAt, 1234);
    assert.deepEqual(saved.observations[0]!.state.properties, { foo: 'bar' });
    const json = JSON.stringify(saved);
    assert.ok(json.includes('"sequence":77'), '原始观测字段必须落盘');
    assert.ok(json.includes('"reportId"'), '报告编号必须落盘');
    assert.ok(!json.includes('VoxelMap'), '不得序列化 VoxelMap 对象');
  } finally {
    exec.unwrap();
  }
});

test('ExecutionDiagnostics：observeBatch 返回原 ChangeReport；loop.observe 每个对象独立编号并标明来源', () => {
  const seq = new EventSeq();
  const keys = { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const exec = new ExecutionDiagnostics(seq, () => 'task_A', () => 1000, {
    frame: () => 7,
    readKeys: () => ({ ...keys }),
  });
  exec.wrap();
  try {
    const map = new VoxelMap('world', { validityWindowMs: 60_000 });
    const observation = {
      worldId: 'world', dim: 'overworld', sessionId: 's1', pos: { x: 1, y: 2, z: 3 },
      state: { name: 'stone', properties: {} }, stateComplete: true, evidence: 'seen' as const,
      observedAt: 1000, source: 'vision' as const, sequence: 1,
    };
    const report = map.observeBatch({ observations: [observation], unobserved: [] });
    assert.equal(exec.mapBatches.length, 1);
    assert.equal(exec.mapBatches[0]!.report, report, '包装必须透传并记录同一个实际 ChangeReport');
    assert.equal(exec.mapBatches[0]!.map, map, '必须捕获实际 map 引用');
    assert.equal(exec.mapBatches[0]!.frame, 7);

    const noMove = { move: async () => ({ failure: { kind: 'cancelled' } as const }), stop: () => {} };
    const loop = new WalkRouteExecutor(map, noMove, { now: () => 1000 });
    loop.start({
      worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
      body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
      arrival: { kind: 'exact' }, shapeProvider: walkCollisionProvider, deadlineMs: 5000, timeoutMs: 1000,
    });
    loop.observe(report, 64);
    const rec = exec.observes[0]!;
    assert.equal(rec.reportId, exec.mapBatches[0]!.reportId, '同对象编号必须一致');
    assert.equal(rec.report, report, '原报告对象必须原样保留');
    assert.equal(rec.mapBatchMatched, true);
    assert.equal(rec.reportSource, 'mapBatch');
    assert.equal(rec.frameEnter, 7);
    assert.deepEqual(rec.keysBefore, keys);

    // 内容相同的另一份对象不得被当成同一 report，也不得冒充 Vision/mapBatch 来源。
    const unmatched = { sections: [] };
    loop.observe(unmatched, 64);
    const firstUnmatched = exec.observes[1]!;
    assert.notEqual(firstUnmatched.reportId, null, '未匹配报告仍须有稳定编号');
    assert.notEqual(firstUnmatched.reportId, rec.reportId, '不同对象必须分配不同编号');
    assert.equal(firstUnmatched.mapBatchMatched, false);
    assert.equal(firstUnmatched.reportSource, 'unmatched');
    assert.equal(firstUnmatched.report, unmatched);

    // 同一对象再次进入保持同一编号；内容相同的新对象获得新编号。
    loop.observe(unmatched, 64);
    assert.equal(exec.observes[2]!.reportId, firstUnmatched.reportId, '同一对象编号必须稳定');
    assert.equal(exec.observes[2]!.mapBatchMatched, false);
    loop.observe({ sections: [] }, 64);
    assert.notEqual(exec.observes[3]!.reportId, firstUnmatched.reportId, '内容相同的新对象不得复用编号');
    assert.equal(exec.observes[3]!.mapBatchMatched, false);
    assert.equal(exec.observes[3]!.reportSource, 'unmatched');
  } finally {
    exec.unwrap();
  }
});

test('真实 SharedSpatialSession 暂停：生命周期报告有稳定ID且非Vision，旧loop取消/OPEN失效，证据格STALE且resume不伪复鲜', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-pause-'));
  const dbPath = path.join(dir, 'spatial.sqlite');
  const world = 'walk-pause-world';
  const dim = 'overworld';
  const now = () => 1000;
  const exec = new ExecutionDiagnostics(new EventSeq(), () => 'task_B', now, {
    frame: () => 7,
    readKeys: () => ({ ...emptyKeys }),
  });
  exec.wrap();
  let svc: SharedSpatialSession | null = null;
  let shutdownResult: ShutdownResult | null = null;
  let shutdownAwaitError: unknown = null;
  let primaryFailure: unknown = null;
  try {
    svc = await SharedSpatialSession.open({ worldId: world, databasePath: dbPath, timeoutMs: 5000, now });
    svc.beginSession({ worldId: world, dim, sessionId: 's1' });
    const map = svc.session.voxel;
    const loop = new WalkRouteExecutor(map, {
      move: async () => ({ failure: { kind: 'cancelled' } as const }),
      stop: () => {},
    }, { now });
    loop.start({
      worldId: world, dim, sessionId: 's1', mode: 'walk',
      body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
      arrival: { kind: 'exact' }, bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
      deadlineMs: 5000, timeoutMs: 1000,
    });
    svc.attach({
      receiver: (report) => loop.observe(report, 64),
      cancel: () => loop.cancel('lifecycle', 'test pause'),
    });
    let observationId = 0;
    const observation = (x: number, y: number, z: number, name: string) => ({
      worldId: world, dimension: dim, sessionId: 's1', pos: { x, y, z },
      name, properties: {}, stateComplete: true,
      observedAt: 1000, source: 'vision' as const, observationId: ++observationId,
    });
    svc.observe([
      observation(0, -1, 0, 'minecraft:stone'), observation(1, -1, 0, 'minecraft:stone'),
      observation(0, 0, 0, 'minecraft:air'), observation(1, 0, 0, 'minecraft:air'),
      observation(0, 1, 0, 'minecraft:air'), observation(1, 1, 0, 'minecraft:air'),
    ]);
    // 普通 map 批次报告仍按同一对象匹配 Vision/mapBatch 来源。
    assert.equal(exec.observes.length, 1);
    assert.equal(exec.observes[0]!.reportSource, 'mapBatch');
    assert.equal(exec.observes[0]!.mapBatchMatched, true);
    const before = loop.status();
    assert.ok(before);
    assert.equal(before.route.steps[0]?.kind, 'verified');
    assert.equal(before.route.steps[0]?.kind === 'verified' ? before.route.steps[0]!.result.status : null, 'OPEN');

    const cellBefore = cellEvidenceSnapshot(map.cellAt(dim, 0, -1, 0));
    assert.equal(cellBefore.freshness, 'FRESH');
    const observesBeforePause = exec.observes.length;
    svc.setPaused(true);
    assert.equal(svc.paused, true);

    // 生命周期报告在 loop.cancel 之后同步进入 observe：独立稳定编号，且不得冒充 Vision/mapBatch。
    assert.equal(exec.observes.length, observesBeforePause + 1);
    const lifecycle = exec.observes[observesBeforePause]!;
    assert.equal(lifecycle.ownerTaskId, 'task_B');
    assert.equal(lifecycle.mapBatchMatched, false);
    assert.equal(lifecycle.reportSource, 'unmatched');
    assert.equal(typeof lifecycle.reportId, 'number');
    assert.equal(exec.mapBatches.some((b) => b.reportId === lifecycle.reportId), false, '生命周期报告不得复用 mapBatch 编号');
    const staled = lifecycle.report.sections.flatMap((s) => s.cells).find((c) => c.pos.x === 0 && c.pos.y === -1 && c.pos.z === 0);
    assert.equal(staled?.kind, 'staled');
    assert.equal(lifecycle.statusBefore?.result?.outcome, 'CANCELLED', '暂停取消后同步进入 observe 的 statusBefore 已是 CANCELLED');

    const after = loop.status();
    assert.ok(after);
    assert.equal(after.result?.outcome, 'CANCELLED');
    const stepAfter = after.route.steps[0];
    assert.equal(stepAfter?.kind === 'verified' && stepAfter.result.status === 'OPEN', false, '生命周期报告必须使旧 OPEN 步骤失效');
    assert.equal(lifecycle.statusAfter.result?.outcome, 'CANCELLED');

    const cellAfterPause = cellEvidenceSnapshot(map.cellAt(dim, 0, -1, 0));
    assert.equal(cellAfterPause.freshness, 'STALE');
    assert.equal(cellAfterPause.name, cellBefore.name);
    assert.deepEqual(cellAfterPause.properties, cellBefore.properties);
    assert.equal(cellAfterPause.observedAt, cellBefore.observedAt);
    assert.equal(cellAfterPause.sequence, cellBefore.sequence);
    assert.equal(cellAfterPause.sessionId, cellBefore.sessionId);

    // resume 不调用 observe、不刷新证据；同一格仍 STALE，原事实保持。
    const observesBeforeResume = exec.observes.length;
    svc.setPaused(false);
    assert.equal(svc.paused, false);
    assert.equal(exec.observes.length, observesBeforeResume, 'resume 不得产生新的 loop.observe');
    const cellAfterResume = cellEvidenceSnapshot(map.cellAt(dim, 0, -1, 0));
    assert.equal(cellAfterResume.freshness, 'STALE');
    assert.equal(cellAfterResume.name, cellBefore.name);
    assert.equal(cellAfterResume.observedAt, cellBefore.observedAt);
    assert.equal(cellAfterResume.sequence, cellBefore.sequence);
    assert.equal(cellAfterResume.sessionId, cellBefore.sessionId);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    exec.unwrap();
    if (svc !== null && shutdownResult === null) {
      try { shutdownResult = await svc.shutdown(); } catch (error) { shutdownAwaitError = error; }
    }
    const shutdown = svc === null ? null : spatialShutdownRecord(shutdownResult, null, shutdownAwaitError, world);
    const shutdownOk = shutdown !== null && shutdown.ok;
    if (shutdownOk) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        const message = `关闭已确认但删除 fixture 失败：${dir}（${String(error)}）`;
        if (primaryFailure === null) throw error;
        t.diagnostic(message);
      }
    } else {
      const detail = `shutdown=${JSON.stringify(shutdown)}`
        + ` awaitError=${shutdownAwaitError instanceof Error ? shutdownAwaitError.message : String(shutdownAwaitError)}`;
      const message = `未确认关闭，保留 fixture：${dir}（${detail}）`;
      if (primaryFailure === null) throw new Error(message, { cause: shutdownAwaitError });
      t.diagnostic(message);
    }
  }
});

test('ExecutionDiagnostics：实际 Vision 返回保留完整 typed payload，不改字段、不复用诊断投影', () => {
  const returned = [{
    pos: { x: 1, y: 2, z: 3 }, name: 'minecraft:stone', properties: { variant: 7, wet: true },
    worldId: 'world', sessionId: 's1', dimension: 'overworld', observedAt: 1000, observationId: 42,
    source: 'vision' as const,
  }];
  const vision = { observeBlocks: (_positions: Array<{ x: number; y: number; z: number }>) => returned };
  const exec = new ExecutionDiagnostics(new EventSeq(), () => 'task_A', () => 1000, { vision: vision as never });
  exec.wrap();
  try {
    assert.equal(vision.observeBlocks([{ x: 1, y: 2, z: 3 }]), returned, '包装必须透传原返回数组');
    const rec = exec.visionCalls[0]!;
    assert.deepEqual(rec.payload, returned, 'typed 副本必须与实际返回完全一致');
    assert.equal(rec.payload[0]!.source, 'vision');
    assert.equal(Object.hasOwn(rec.payload[0]!, 'stateComplete'), false, '不得补 stateComplete');
    assert.equal(rec.output[0]!.stateComplete, null, '既有诊断投影语义不变');
    assert.notEqual(rec.payload, returned);
    assert.notEqual(rec.payload[0], returned[0]);
    assert.notEqual(rec.payload[0]!.pos, returned[0]!.pos);
    assert.notEqual(rec.payload[0]!.properties, returned[0]!.properties);
    (rec.payload[0]!.properties as Record<string, unknown>).changed = 'yes';
    assert.equal(Object.hasOwn(returned[0]!.properties, 'changed'), false, '副本变异不得回写实际返回');
  } finally {
    exec.unwrap();
  }
  assert.equal(vision.observeBlocks([{ x: 1, y: 2, z: 3 }]), returned, 'unwrap 必须恢复原方法');
});

test('pickSpatialWitness：只选已写入同一 svc.voxel 且 name/properties/time/sequence/scope 一致的原 payload', () => {
  const voxel = new VoxelMap('world', { validityWindowMs: 60_000, now: () => 1000 });
  const block = {
    pos: { x: 4, y: 5, z: 6 }, name: 'minecraft:stone', properties: { variant: 7 },
    worldId: 'world', sessionId: 's1', dimension: 'overworld', observedAt: 1000, observationId: 9,
    source: 'vision' as const,
  };
  const vision: VisionCallRecord = {
    seq: 3, ts: 1000, frame: 1, visionId: 1, positions: [{ ...block.pos }], eye: null,
    payload: [block],
    output: [{
      pos: { ...block.pos }, name: block.name, properties: { variant: 7 }, stateComplete: null,
      worldId: 'world', sessionId: 's1', dimension: 'overworld', observedAt: 1000, observationId: 9,
    }],
  };
  assert.equal(pickSpatialWitness([{ visionCalls: [vision], mapBatches: [] }], voxel), null, '未真正入图不得选 witness');

  // 原 payload 缺省 stateComplete 按生产归一为 false，map 侧也必须是 false 才算完整契约匹配。
  const observation = {
    worldId: 'world', dim: 'overworld', sessionId: 's1', pos: { ...block.pos },
    state: { name: 'minecraft:stone', properties: { variant: '7' } }, stateComplete: false,
    evidence: 'seen' as const, observedAt: 1000, source: 'vision' as const, sequence: 9,
  };
  const report = voxel.observeBatch({ observations: [observation], unobserved: [] });
  const stored = mapBatchForEvidence({
    seq: 4, ts: 1000, frame: 1, mapId: 1, mapWorldId: 'world', map: voxel,
    observations: [observation], unobserved: [], reportId: 1, report,
  });
  const picked = pickSpatialWitness([{ visionCalls: [vision], mapBatches: [{ ...stored, mapIsSessionVoxel: true }] }], voxel);
  assert.ok(picked);
  assert.equal(picked.block, block, '必须返回原 typed payload 记录而非投影');
  assert.equal(picked.cell.sequence, 9);
  assert.deepEqual(picked.cell.properties, { variant: '7' });

  // 同一位置但 properties 不一致的 map 证据不得把该 payload 关联成 witness。
  const otherVoxel = new VoxelMap('world', { validityWindowMs: 60_000, now: () => 1000 });
  const otherReport = otherVoxel.observeBatch({ observations: [{ ...observation, state: { name: 'minecraft:stone', properties: { variant: '8' } } }], unobserved: [] });
  const otherStored = mapBatchForEvidence({
    seq: 4, ts: 1000, frame: 1, mapId: 1, mapWorldId: 'world', map: otherVoxel,
    observations: [observation], unobserved: [], reportId: 1, report: otherReport,
  });
  assert.equal(pickSpatialWitness([{ visionCalls: [vision], mapBatches: [{ ...otherStored, mapIsSessionVoxel: true }] }], otherVoxel), null);

  // name/time/sequence/scope/properties 全同，仅 stateComplete 不匹配：不得改原 payload 补 true 过关。
  const incompleteVoxel = new VoxelMap('world', { validityWindowMs: 60_000, now: () => 1000 });
  const incompleteReport = incompleteVoxel.observeBatch({ observations: [{ ...observation, stateComplete: true }], unobserved: [] });
  const incompleteStored = mapBatchForEvidence({
    seq: 4, ts: 1000, frame: 1, mapId: 1, mapWorldId: 'world', map: incompleteVoxel,
    observations: [{ ...observation, stateComplete: true }], unobserved: [], reportId: 1, report: incompleteReport,
  });
  assert.equal(pickSpatialWitness([{ visionCalls: [vision], mapBatches: [{ ...incompleteStored, mapIsSessionVoxel: true }] }], incompleteVoxel), null);
});

test('真实 SQLite 重连边界（离线注入 typed payload，非联机）：旧 loop OPEN 失效、旧 payload 被拒且 STALE、仅新 session 请求格 FRESH，witness 不混 epoch', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-reconnect-'));
  const dbPath = path.join(dir, 'spatial.sqlite');
  const world = 'walk-reconnect-world';
  const dim = 'overworld';
  let nowValue = 1000;
  const now = () => nowValue;
  const exec = new ExecutionDiagnostics(new EventSeq(), () => null, now, { frame: () => 0, readKeys: () => ({ ...emptyKeys }) });
  exec.wrap();
  let svc: SharedSpatialSession | null = null;
  let shutdownResult: ShutdownResult | null = null;
  let shutdownAwaitError: unknown = null;
  let primaryFailure: unknown = null;
  try {
    svc = await SharedSpatialSession.open({ worldId: world, databasePath: dbPath, timeoutMs: 5000, now });
    svc.beginSession({ worldId: world, dim, sessionId: 's1' });
    const map = svc.session.voxel;
    const loop = new WalkRouteExecutor(map, {
      move: async () => ({ failure: { kind: 'cancelled' } as const }),
      stop: () => {},
    }, { now });
    loop.start({
      worldId: world, dim, sessionId: 's1', mode: 'walk',
      body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
      points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }],
      arrival: { kind: 'exact' }, bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
      deadlineMs: 5000, timeoutMs: 1000,
    });
    svc.attach({
      receiver: (report) => loop.observe(report, 64),
      cancel: () => loop.cancel('lifecycle', 'session reset'),
    });
    let observationId = 0;
    const observation = (x: number, y: number, z: number, name: string, sessionId = 's1', observedAt = 1000) => ({
      worldId: world, dimension: dim, sessionId, pos: { x, y, z },
      name, properties: {}, stateComplete: true,
      observedAt, source: 'vision' as const, observationId: ++observationId,
    });
    const oldSupport = observation(1, -1, 0, 'minecraft:stone');
    const oldOther = observation(0, -1, 0, 'minecraft:stone');
    svc.observe([
      oldOther, oldSupport,
      observation(0, 0, 0, 'minecraft:air'), observation(1, 0, 0, 'minecraft:air'),
      observation(0, 1, 0, 'minecraft:air'), observation(1, 1, 0, 'minecraft:air'),
    ]);
    const before = loop.status();
    assert.ok(before);
    const stepBefore = before.route.steps[0];
    assert.equal(stepBefore?.kind === 'verified' ? stepBefore.result.status : null, 'OPEN');
    assert.equal(cellEvidenceSnapshot(map.cellAt(dim, 1, -1, 0)).freshness, 'FRESH');

    // 新 session 经生产 beginSession 准入，旧 session 证据全部 STALE；旧 loop 收到非 Vision 生命周期报告。
    nowValue = 2000;
    svc.beginSession({ worldId: world, dim, sessionId: 's2' });
    const lifecycle = exec.observes[exec.observes.length - 1]!;
    assert.equal(lifecycle.reportSource, 'unmatched', '生命周期报告不得冒充 Vision/mapBatch');
    assert.equal(lifecycle.mapBatchMatched, false);
    const stepAfter = loop.status()?.route.steps[0];
    assert.equal(stepAfter?.kind === 'verified' && stepAfter.result.status === 'OPEN', false, '旧 OPEN 必须变非 OPEN');
    const cellBeforeReplay = cellEvidenceSnapshot(map.cellAt(dim, 1, -1, 0));
    assert.equal(cellBeforeReplay.freshness, 'STALE');

    // 旧 typed payload 原样交给生产服务：旧 session 被拒绝，目标格保持原证据/STALE。
    const replay = svc.observe([oldSupport]);
    assert.equal(replay.sections.length, 0, '旧 session payload 必须被生产服务拒绝');
    const cellAfterReplay = cellEvidenceSnapshot(map.cellAt(dim, 1, -1, 0));
    assert.equal(cellAfterReplay.freshness, 'STALE');
    assert.deepEqual(cellAfterReplay, cellBeforeReplay);

    // 只请求新 session 下的单格，另一旧格不请求：前者 FRESH，后者仍 STALE。
    const newSupport = { ...oldSupport, sessionId: 's2', observedAt: 2000, observationId: 77 };
    svc.observe([newSupport]);
    const freshCell = cellEvidenceSnapshot(map.cellAt(dim, 1, -1, 0));
    assert.equal(freshCell.freshness, 'FRESH');
    assert.equal(freshCell.sequence, 77);
    assert.equal(freshCell.sessionId, 's2');
    const untouched = cellEvidenceSnapshot(map.cellAt(dim, 0, -1, 0));
    assert.equal(untouched.freshness, 'STALE');
    assert.equal(untouched.sequence, oldOther.observationId);
    assert.equal(untouched.sessionId, 's1');

    const oldBatch = exec.mapBatches[0]!;
    const newBatch = exec.mapBatches[exec.mapBatches.length - 1]!;
    assert.notEqual(oldBatch.reportId, newBatch.reportId);
    const oldSource = {
      source: 'scenario', epoch: null,
      visionCalls: [{
        seq: oldBatch.seq - 1, ts: 1000, frame: 0, visionId: 1, positions: [{ ...oldSupport.pos }], eye: null,
        payload: [oldSupport], output: [],
      } as VisionCallRecord],
      mapBatches: [{ ...mapBatchForEvidence(oldBatch), mapIsSessionVoxel: true }],
    };
    const reconnectSource = {
      source: 'reconnect', epoch: 'reconnect-s2',
      visionCalls: [{
        seq: newBatch.seq - 1, ts: 2000, frame: 0, visionId: 2, positions: [{ ...newSupport.pos }], eye: null,
        payload: [newSupport], output: [],
      } as VisionCallRecord],
      mapBatches: [{ ...mapBatchForEvidence(newBatch), mapIsSessionVoxel: true }],
    };
    assert.equal(pickSpatialWitness([oldSource], map), null, '旧 STALE 前缀不得作为最后合法事实');
    const picked = pickSpatialWitness([oldSource, reconnectSource], map);
    assert.ok(picked);
    assert.equal(picked.source, 'reconnect');
    assert.equal(picked.epoch, 'reconnect-s2');
    assert.equal(picked.block.observationId, 77);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    exec.unwrap();
    if (svc !== null && shutdownResult === null) {
      try { shutdownResult = await svc.shutdown(); } catch (error) { shutdownAwaitError = error; }
    }
    const shutdown = svc === null ? null : spatialShutdownRecord(shutdownResult, null, shutdownAwaitError, world);
    const shutdownOk = shutdown !== null && shutdown.ok;
    if (shutdownOk) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        const message = `关闭已确认但删除 fixture 失败：${dir}（${String(error)}）`;
        if (primaryFailure === null) throw error;
        t.diagnostic(message);
      }
    } else {
      const detail = `shutdown=${JSON.stringify(shutdown)}`
        + ` awaitError=${shutdownAwaitError instanceof Error ? shutdownAwaitError.message : String(shutdownAwaitError)}`;
      const message = `未确认关闭，保留 fixture：${dir}（${detail}）`;
      if (primaryFailure === null) throw new Error(message, { cause: shutdownAwaitError });
      t.diagnostic(message);
    }
  }
});

test('spatialShutdownRecord：真实 SQLite 会话正常关停由最终 checkpoint/close 证据确认', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-acceptance-spatial-'));
  const databasePath = path.join(dir, 'spatial.sqlite');
  let spatial: SharedSpatialSession | null = null;
  let result: ShutdownResult | null = null;
  let primaryFailure: unknown = null;
  try {
    spatial = await SharedSpatialSession.open({ worldId: 'walk-acceptance-world', databasePath, timeoutMs: 5000 });
    result = await spatial.shutdown();
    const record = spatialShutdownRecord(result, null, null, 'walk-acceptance-world');
    assert.equal(record.ok, true, JSON.stringify(record));
    assert.deepEqual(record.problems, []);
    assert.equal(record.diagnostics?.checkpoint?.checkpointId, record.diagnostics?.close?.lastConfirmedCheckpointId);
    assert.equal(record.diagnostics?.close?.completed, true);
    assert.equal(record.diagnostics?.close?.dirty, false);
    assert.equal(record.diagnostics?.checkpoint?.worldId, 'walk-acceptance-world');
    assert.equal(record.diagnostics?.primarySaveError, null);
    assert.equal(record.diagnostics?.cancelError, null);
    assert.equal(record.diagnostics?.closeError, null);
    assert.ok(fs.existsSync(databasePath), '正常关停不删除本次证据 DB');

    const wrongWorld = spatialShutdownRecord(result, null, null, 'another-world');
    assert.equal(wrongWorld.ok, false, 'checkpoint 世界不符不得算成功');
    assert.ok(wrongWorld.problems.includes('checkpoint_world_mismatch'));
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    // 主流程未完成真实 shutdown 时仍尽力关闭；关闭是否可信只看实际结果。
    let cleanupError: unknown = null;
    if (spatial !== null && result === null) {
      try { result = await spatial.shutdown(); } catch (error) { cleanupError = error; }
    }
    // finally 里的 await spatial.shutdown() 异常是「等待结果」失败，不是同步调用失败。
    const shutdown = spatial === null ? null : spatialShutdownRecord(result, null, cleanupError, spatial.worldId);
    const closed = shutdown !== null && shutdown.ok;
    if (!closed) {
      const detail = shutdown === null ? 'session was not opened' : JSON.stringify(shutdown.problems);
      const message = `未确认关闭，保留 fixture：${databasePath}（${detail}）`;
      // 主错误优先；仅当没有主错误时才把未确认关闭/次关闭错误作为测试失败。
      if (primaryFailure === null) throw new Error(message, { cause: cleanupError });
      t.diagnostic(message);
    } else {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        // 只有关闭已被实际 CloseResult/分类确认后才删除；删除失败也不覆盖主错误。
        if (primaryFailure === null) throw error;
        t.diagnostic(`关闭已确认但删除 fixture 失败：${databasePath}（${String(error)}）`);
      }
    }
  }
});

test('spatialShutdownRecord：shutdown 调用/等待抛错或结果缺失都保留原始错误并判失败', () => {
  const callError = Object.assign(new Error('shutdown call failed'), { kind: 'data' });
  const missing = spatialShutdownRecord(null, callError, null, 'world');
  assert.equal(missing.ok, false);
  assert.equal(missing.diagnostics, null);
  assert.deepEqual(missing.serviceCallError, { kind: 'data', name: 'Error', message: 'shutdown call failed' });
  assert.equal(missing.serviceAwaitError, null);
  assert.ok(missing.problems.includes('shutdown_result_missing'));
  assert.ok(missing.problems.includes('shutdown_call_error'));

  const awaitError = new Error('shutdown await failed');
  const rejected = spatialShutdownRecord(null, null, awaitError, 'world');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.serviceAwaitError?.message, 'shutdown await failed');
  assert.ok(rejected.problems.includes('shutdown_await_error'));
});

test('checkS1Return：反向三段实测接续+同一svc.voxel的B新观测才通过；跨任务同名delegation/换map/无新观测均拒绝', () => {
  const map = new VoxelMap('w', { validityWindowMs: 600_000 });
  const cell = { x: 1, y: 63, z: 0 };
  const observationAt = (sequence: number, observedAt: number, variant: string) => ({
    worldId: 'w', dim: 'd', sessionId: 's', pos: { ...cell },
    state: { name: 'minecraft:stone', properties: { variant } }, stateComplete: true,
    evidence: 'seen' as const, observedAt, source: 'vision' as const, sequence,
  });
  map.observeBatch({ observations: [observationAt(10, 1000, 'x')], unobserved: [] });
  const baselineCell = cellEvidenceSnapshot(map.cellAt('d', cell.x, cell.y, cell.z));
  const beforeStartCell = cellEvidenceSnapshot(map.cellAt('d', cell.x, cell.y, cell.z));
  const visionOutput = {
    pos: { ...cell }, name: 'minecraft:stone', properties: { variant: 'y' }, stateComplete: true,
    worldId: 'w', sessionId: 's', dimension: 'd', observedAt: 2000, observationId: 11,
  };
  const report = map.observeBatch({ observations: [observationAt(11, 2000, 'y')], unobserved: [] });
  const afterCell = cellEvidenceSnapshot(map.cellAt('d', cell.x, cell.y, cell.z));
  const batch: MapBatchRecord = {
    seq: 6, ts: 1600, frame: 1, mapId: 1, mapWorldId: 'w', map,
    observations: [observationAt(11, 2000, 'y')], unobserved: [], reportId: 1, report,
  };
  const vision: VisionCallRecord = {
    seq: 5, ts: 1500, frame: 1, visionId: 1, positions: [{ ...cell }], eye: null,
    payload: [{ ...visionOutput, source: 'vision' }], output: [visionOutput],
  };

  const aRoute = [
    { x: 2.5, y: 64, z: 0.5 }, { x: 3.5, y: 64, z: 0.5 },
    { x: 3.5, y: 64, z: 1.5 }, { x: 4.5, y: 64, z: 1.5 },
  ];
  const aLast = { x: 4.55, y: 64, z: 1.52 };
  const bRoute = [aLast, { x: 3.55, y: 64, z: 1.52 }, { x: 3.55, y: 64, z: 0.52 }, { x: 2.55, y: 64, z: 0.52 }];
  const completion0 = { x: 3.56, y: 64, z: 1.52 };
  const completion1 = { x: 3.54, y: 64, z: 0.53 };
  const completion2 = { x: 2.55, y: 64, z: 0.52 };
  const samples = [
    delivery(completion0, statusSnap({ nextPointIndex: 1 }), statusSnap({ nextPointIndex: 2, lastPosition: completion0 }), { owner: 'task_B' }),
    delivery(completion1, statusSnap({ nextPointIndex: 2 }), statusSnap({ nextPointIndex: 3, lastPosition: completion1 }), { owner: 'task_B' }),
    delivery(completion2, statusSnap({ nextPointIndex: 3 }), statusSnap({ nextPointIndex: 4, lastPosition: completion2, result: null }), { owner: 'task_B' }),
  ];
  const bCompletions = measuredCompletions(samples, 'task_B', 'walk-1');
  const movesA = [
    moveRecord('walk-1', 'task_A', 0, aRoute[0]!, aRoute[1]!),
    moveRecord('walk-1', 'task_A', 1, aRoute[1]!, aRoute[2]!),
    moveRecord('walk-1', 'task_A', 2, aRoute[2]!, aRoute[3]!),
  ];
  const movesB = [
    moveRecord('walk-1', 'task_B', 0, bRoute[0]!, bRoute[1]!),
    moveRecord('walk-1', 'task_B', 1, completion0, bRoute[2]!),
    moveRecord('walk-1', 'task_B', 2, completion1, bRoute[3]!),
  ];
  const bStartStatus = statusSnap({
    delegationId: 'walk-1',
    route: routeSnap({
      stepCount: 3, openPrefix: 3, verifiedStepIndexes: [0, 1, 2], pendingStepIndexes: [],
      steps: [
        { kind: 'verified', status: 'OPEN', problemKind: null },
        { kind: 'verified', status: 'OPEN', problemKind: null },
        { kind: 'verified', status: 'OPEN', problemKind: null },
      ],
    }),
  });
  const valid = {
    taskIdA: 'task_A', taskIdB: 'task_B', aRoute, aLastCompletion: aLast,
    delegationB: 'walk-1', bRoute, bStartSeq: 0,
    bRouteStatus: { ownerTaskId: 'task_B', seq: 4, status: bStartStatus },
    bMoves: [...movesA, ...movesB], bCompletions, bMaps: [batch],
    expectedMap: map, expectedScope: { worldId: 'w', dim: 'd', sessionId: 's' },
    witnessCell: cell, baselineCell, beforeStartCell, bVision: vision, afterCell,
  };
  assert.deepEqual(checkS1Return(valid), { ok: true });

  // 同名 delegation 下只拿 A 的段/或把 B 段标成 A 都不得通过。
  assert.equal(checkS1Return({ ...valid, bMoves: movesA }).ok, false, '跨 task 同名 delegation 不得复用 A 段');
  assert.equal(checkS1Return({ ...valid, bMoves: movesB.map((m) => ({ ...m, taskId: 'task_A' })) }).ok, false, 'B 段归属必须是 B task');
  // 不能把 A 的旧 route OPEN 当作 B 的复验。
  assert.equal(checkS1Return({ ...valid, bRouteStatus: { ...valid.bRouteStatus, ownerTaskId: 'task_A' } }).ok, false, 'A 的 route 快照不得冒充 B');
  assert.equal(checkS1Return({ ...valid, bRouteStatus: { ...valid.bRouteStatus, seq: 0 } }).ok, false, 'B 起点之前的 route 快照不得复用');
  // 不是同一个 svc.voxel 实例。
  assert.equal(checkS1Return({ ...valid, bMaps: [{ ...batch, map: new VoxelMap('w') }] }).ok, false, '换 map 不得通过');
  // 没有新的合法 Vision→map 观测。
  assert.equal(checkS1Return({ ...valid, bVision: null }).ok, false, '缺 B 实际 Vision 不得通过');
  assert.equal(checkS1Return({ ...valid, afterCell: baselineCell }).ok, false, 'cellAt 未更新不得通过');
  assert.equal(checkS1Return({ ...valid, bVision: { ...vision, output: [{ ...visionOutput, observationId: 99 }] } }).ok, false, '未写入 map 的 payload 不得通过');
  // B 开始前原证据被刷新也不得通过。
  assert.equal(checkS1Return({ ...valid, beforeStartCell: afterCell }).ok, false, '原证据被刷新不得通过');
});

test('checkSpatialFinalSave/checkSpatialReopen：真实SQLite空anchor→typed事实→finalCP/close→reopen STALE，关闭失败单独诊断', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-s3-'));
  const dbPath = path.join(dir, 'spatial.sqlite');
  const world = 'walk-s3-world';
  let first: SharedSpatialSession | null = null;
  let firstResult: ShutdownResult | null = null;
  let reopened: SharedSpatialSession | null = null;
  let secondResult: ShutdownResult | null = null;
  let primaryFailure: unknown = null;
  try {
    first = await SharedSpatialSession.open({ worldId: world, databasePath: dbPath, timeoutMs: 5000 });
    const anchor = await first.checkpoint();
    const anchorState = first.getPersistenceState();
    assert.equal(anchorState.dirty, false);
    assert.equal(anchorState.lastConfirmedCheckpointId, anchor.checkpointId);

    first.beginSession({ worldId: world, dim: 'overworld', sessionId: 's1' });
    first.observe([{
      worldId: world, dimension: 'overworld', sessionId: 's1', observedAt: 1_700_000_000_123, observationId: 42,
      source: 'vision', stateComplete: true, pos: { x: 7, y: 8, z: 9 },
      name: 'minecraft:oak_door', properties: { open: 'true', half: 'upper', facing: 'east' },
    }]);
    const cell = cellEvidenceSnapshot(first.session.voxel.cellAt('overworld', 7, 8, 9));
    assert.equal(cell.observed, true);
    if (!cell.observed) assert.fail('witness cell was not written');

    firstResult = await first.shutdown();
    const proof = checkSpatialFinalSave({
      anchorCheckpointId: anchor.checkpointId,
      anchorState: {
        dirty: anchorState.dirty,
        lastConfirmedCheckpointId: anchorState.lastConfirmedCheckpointId,
        voxelRevision: anchorState.voxelRevision,
      },
      checkpoint: firstResult.checkpoint,
      state: first.getPersistenceState(),
      close: firstResult.close,
    });
    assert.deepEqual(proof, { ok: true });
    assert.notEqual(firstResult.checkpoint!.checkpointId, anchor.checkpointId);
    const firstCheckpointId = firstResult.checkpoint!.checkpointId;

    // 边界：真实 CP/revisions/close 全部成功，但 shutdown 分类含 cancelError 时 S3 门槛不得算通过。
    const shutdownOk = spatialShutdownRecord(firstResult, null, null, world);
    const cancelError = Object.assign(new Error('cancel failed'), { kind: 'data' });
    // 用真实 CP/close 结果注入 cancelError，只验证分类边界，不声称真实 worker 取消失败。
    const shutdownCancelled = spatialShutdownRecord({ ...firstResult!, cancelError }, null, null, world);
    assert.equal(shutdownOk.ok, true);
    assert.equal(shutdownCancelled.ok, false, 'cancelError 必须使 shutdown 分类失败');
    assert.ok(shutdownCancelled.problems.includes('cancel_error'));
    assert.equal(shutdownCancelled.diagnostics?.cancelError?.message, 'cancel failed');
    assert.deepEqual(checkSpatialFinalSave({
      anchorCheckpointId: anchor.checkpointId,
      anchorState: { dirty: anchorState.dirty, lastConfirmedCheckpointId: anchorState.lastConfirmedCheckpointId, voxelRevision: anchorState.voxelRevision },
      checkpoint: firstResult.checkpoint,
      state: first.getPersistenceState(),
      close: firstResult.close,
    }), { ok: true }, '原始 CP/close 事实仍成功，只有合并门槛应失败');
    assert.equal(proof.ok && shutdownCancelled.ok, false, 'S3 必须同时要求最终保存与 shutdown 分类通过');

    // 只有真实 close 已确认后才重开同一 DB；不 beginSession、不刷新。
    assert.equal(firstResult.close!.completed, true);
    reopened = await SharedSpatialSession.open({ worldId: world, databasePath: dbPath, timeoutMs: 5000 });
    const readback = cellEvidenceSnapshot(reopened.session.voxel.cellAt('overworld', 7, 8, 9));
    const witness = {
      pos: { x: 7, y: 8, z: 9 }, dim: 'overworld', worldId: world, sessionId: 's1',
      name: 'minecraft:oak_door', properties: { open: 'true', half: 'upper', facing: 'east' },
      observedAt: 1_700_000_000_123, sequence: 42,
      cell,
    };
    assert.deepEqual(checkSpatialReopen(witness, readback), { ok: true });
    assert.equal(readback.freshness, 'STALE');

    secondResult = await reopened.shutdown();
    const second = spatialShutdownRecord(secondResult, null, null, world);
    assert.equal(second.ok, true, JSON.stringify(second.problems));
    // 第二 close 是独立证据；第一 final id 仍保留在 firstResult 中。
    assert.equal(firstResult.checkpoint!.checkpointId, firstCheckpointId);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    // 两个已开服务各自记录真实 shutdown await 错误；第一次失败不得跳过第二个尝试。
    let firstAwaitError: unknown = null;
    let secondAwaitError: unknown = null;
    if (first !== null && firstResult === null) {
      try { firstResult = await first.shutdown(); } catch (error) { firstAwaitError = error; }
    }
    if (reopened !== null && secondResult === null) {
      try { secondResult = await reopened.shutdown(); } catch (error) { secondAwaitError = error; }
    }
    const firstShutdown = first === null ? null : spatialShutdownRecord(firstResult, null, firstAwaitError, world);
    const secondShutdown = reopened === null ? null : spatialShutdownRecord(secondResult, null, secondAwaitError, world);
    const firstOk = firstShutdown !== null && firstShutdown.ok;
    const secondOk = secondShutdown !== null && secondShutdown.ok;
    if (firstOk && secondOk) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        const message = `关闭已确认但删除 fixture 失败：${dir}（${String(error)}）`;
        if (primaryFailure === null) throw error;
        t.diagnostic(message);
      }
    } else {
      const detail = `first=${JSON.stringify(firstShutdown)} second=${JSON.stringify(secondShutdown)}`
        + ` firstAwait=${firstAwaitError instanceof Error ? firstAwaitError.message : String(firstAwaitError)}`
        + ` secondAwait=${secondAwaitError instanceof Error ? secondAwaitError.message : String(secondAwaitError)}`;
      const message = `未确认关闭，保留 fixture：${dir}（${detail}）`;
      if (primaryFailure === null) throw new Error(message, { cause: firstAwaitError ?? secondAwaitError });
      t.diagnostic(message);
    }
  }

  // 关闭失败诊断：用真实结果的副本注入 close 失败，只验证分类不伪造实机运行。
  const closeFailure: ShutdownResult = { ...firstResult!, close: null, closeError: new Error('close failed') };
  const failed = spatialShutdownRecord(closeFailure, null, null, world);
  assert.equal(failed.ok, false);
  assert.ok(failed.problems.includes('close_error'));
  assert.ok(failed.problems.includes('missing_close_result'));
  assert.equal(failed.serviceAwaitError, null);
  assert.equal(closeFailure.checkpoint!.checkpointId, firstResult!.checkpoint!.checkpointId, '关闭失败不得覆盖第一 final id');
});

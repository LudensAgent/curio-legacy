/**
 * walk-acceptance.ts 的窄测试：纯函数（场景选择器、RCON list 解析、相邻 X 路线、轨迹统计、
 * git porcelain 解析、来源元数据校验）、断言谓词（负例夹具）、WalkDiagnostics /
 * ExecutionDiagnostics 的「创建时绑定归属 + stopAll 前快照 + move/onSample 包装」，
 * 以及 ConnectionTracker / quitClient 的事件完成与超时。只测无副作用或假夹具路径，不连接服务器。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GROUNDED_ARRIVAL_DEFAULTS, VoxelMap, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type { NavResult } from 'curio-minecraft-3d-memory';
import {
  adjacentRouteX,
  allGroundedAt,
  ConnectionTracker,
  dist2,
  ExecutionDiagnostics,
  framesSince,
  gitMeta,
  gitPorcelainPaths,
  hasPartialPosition,
  integrityMatches,
  isArrived,
  lateForwardWritesByOwner,
  packageMeta,
  parseRconList,
  parseScenarioSelector,
  partialMatchesLastSample,
  platformEscaped,
  quitClient,
  segmentsContiguous,
  snapshotKeys,
  summarizeTrajectory,
  WalkDiagnostics,
  withinFootprint,
  type ControlEntry,
  type FrameRecord,
  type MoveRecord,
  type WalkBridge,
} from '../scripts/walk-acceptance.ts';
import { WalkMoveExecutor, walkCollisionProvider } from '../src/adapter/walk-route.ts';

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

test('parseScenarioSelector：缺省为支持的 W1/W2/W6/W7，自定义按序解析', () => {
  assert.deepEqual(parseScenarioSelector(undefined), ['W1', 'W2', 'W6', 'W7']);
  assert.deepEqual(parseScenarioSelector(''), ['W1', 'W2', 'W6', 'W7']);
  assert.deepEqual(parseScenarioSelector('W1,W6'), ['W1', 'W6']);
  assert.deepEqual(parseScenarioSelector(' w2 , w7 '), ['W2', 'W7']);
  assert.throws(() => parseScenarioSelector('W1,W9'), /未知场景 W9/);
});

test('parseScenarioSelector：拒绝本轮未实现的 W3/W4/W5，不把全 NOT_RUN 判为通过', () => {
  assert.throws(() => parseScenarioSelector('W3'), /本轮未实现/);
  assert.throws(() => parseScenarioSelector('W4'), /本轮未实现/);
  assert.throws(() => parseScenarioSelector('W5'), /本轮未实现/);
  assert.throws(() => parseScenarioSelector('W1,W4'), /本轮未实现/);
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

test('packageMeta：源元数据彼此对应，含 provenance 校验与 sourceHEAD', () => {
  const meta = packageMeta();
  assert.equal(meta.name, 'curio-minecraft-3d-memory');
  assert.equal(meta.lockVersion, meta.version);
  assert.equal(meta.lockResolved, meta.dependencySpec);
  assert.ok(meta.dependencySpec.startsWith('file:'));
  assert.match(meta.tgzSha256, /^[0-9a-f]{64}$/);
  assert.match(meta.lockIntegrity, /^sha512-/);
  assert.match(meta.sourceHEAD, /^[0-9a-f]{40}$/);
});

test('packageMeta：同版本但字节被篡改必须失败（不触及真实 tarball）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-pkg-'));
  try {
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'curio-minecraft-3d-memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { 'curio-minecraft-3d-memory': 'file:vendor/curio-minecraft-3d-memory-0.7.5.tgz' } }));
    fs.writeFileSync(path.join(dir, 'vendor', 'curio-minecraft-3d-memory-0.7.5.tgz'), Buffer.from('tampered-bytes-not-the-real-artifact'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'curio-minecraft-3d-memory', 'package.json'), JSON.stringify({ name: 'curio-minecraft-3d-memory', version: '0.7.5' }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/curio-minecraft-3d-memory': { version: '0.7.5', resolved: 'file:vendor/curio-minecraft-3d-memory-0.7.5.tgz', integrity: 'sha512-tWVuLlsXY1NvXhSr7CmTqa+ABEVKb/XVOlj3WEvA892JDA8NYtQsz+9NlpOhFWBz6MAB9EIrglOH4IVkaVfEew==' } },
    }));
    assert.throws(() => packageMeta({ base: dir }), /integrity（sha512）不一致/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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

test('withinFootprint/platformEscaped：含身体半宽 0.3 的物理支撑几何', () => {
  const f = { xMin: 205, xMax: 207, zMin: 205, zMax: 206 };
  assert.equal(withinFootprint({ x: 205.55, z: 205.5 }, f), true);
  assert.equal(withinFootprint({ x: 206.85, z: 205.5 }, f), true, '半宽 0.3 内仍算在足迹内');
  assert.equal(withinFootprint({ x: 207.35, z: 205.5 }, f), false);
  assert.equal(platformEscaped([{ x: 205.55, z: 205.5 }, { x: 206.2, z: 205.5 }], f), false);
  assert.equal(platformEscaped([{ x: 205.55, z: 205.5 }, { x: 207.5, z: 205.5 }], f), true);
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

test('lateForwardWritesByOwner：只有取消边界之后的同主 forward=true 才判复活', () => {
  const log: ControlEntry[] = [
    { ts: 10, op: 'set', name: 'forward', value: true, ownerTaskId: 'A' }, // 取消前合法
    { ts: 20, op: 'set', name: 'forward', value: true, ownerTaskId: 'B' }, // 取消后但属 B
    { ts: 25, op: 'set', name: 'forward', value: true, ownerTaskId: 'A' }, // 取消后属 A → 复活
  ];
  const late = lateForwardWritesByOwner(log, 'A', 15);
  assert.equal(late.length, 1);
  assert.equal(late[0]!.ts, 25);
});

test('segmentsContiguous：后续段从上一段实测终点接续；断档即假', () => {
  const m: MoveRecord[] = [
    { ts: 1, executionId: 'e0', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 0, z: 0.5 }, deadlineMs: 1000 },
    { ts: 2, executionId: 'e1', from: { x: 1.48, y: 0, z: 0.5 }, to: { x: 2.5, y: 0, z: 0.5 }, deadlineMs: 1000 },
  ];
  assert.equal(segmentsContiguous(m), true);
  const gap: MoveRecord[] = [
    { ts: 1, executionId: 'e0', from: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 0, z: 0.5 }, deadlineMs: 1000 },
    { ts: 2, executionId: 'e1', from: { x: 3.0, y: 0, z: 0.5 }, to: { x: 4.0, y: 0, z: 0.5 }, deadlineMs: 1000 },
  ];
  assert.equal(segmentsContiguous(gap), false);
});

// --- WalkDiagnostics：创建时绑定归属 + stopAll 前快照（假夹具） ---

function fakeBody() {
  return {
    setControlState() {},
    clearControlStates() {},
    look() {},
    entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false },
  };
}

test('WalkDiagnostics：控制写入归属绑定在 walkBody 创建时，不是写入时', () => {
  let current: string | null = 'task_A';
  const target: WalkBridge = { walkBody: fakeBody, stopAll: () => {} };
  const diag = new WalkDiagnostics(target, () => current, () => snapshotKeys({ controlState: emptyKeys }), () => 0);
  diag.wrap();

  const body = target.walkBody!();
  current = 'task_B'; // 创建之后换主：旧 body 的写入仍应记为 task_A

  body.setControlState('forward', true);
  body.clearControlStates();
  body.look(0, 0);

  assert.deepEqual(diag.controlLog.map((c) => c.ownerTaskId), ['task_A', 'task_A', 'task_A']);
  assert.deepEqual(diag.controlLog.map((c) => c.op), ['set', 'clear', 'look']);
  diag.unwrap();
});

test('WalkDiagnostics：真实 stopAll 之前采集全键快照（释放前状态），归属为创建时任务', () => {
  const controlState = { ...emptyKeys, forward: true };
  let current: string | null = 'task_A';
  let stopped = false;
  const target: WalkBridge = {
    walkBody: fakeBody,
    stopAll: () => { stopped = true; controlState.forward = false; },
  };
  const diag = new WalkDiagnostics(target, () => current, () => snapshotKeys({ controlState }), () => 123);
  diag.wrap();

  target.walkBody!();
  target.stopAll();

  assert.equal(stopped, true);
  assert.equal(diag.stopSnapshots.length, 1);
  const snap = diag.stopSnapshots[0]!;
  assert.equal(snap.label, 'pre-stopAll');
  assert.equal(snap.ownerTaskId, 'task_A');
  assert.equal(snap.ts, 123);
  assert.equal(snap.keys.forward, true, '快照必须在真实 stopAll 清键之前采集');
  assert.equal(diag.controlLog.some((c) => c.op === 'stopAll'), true);
  diag.unwrap();
});

test('WalkDiagnostics：unwrap 恢复原实现', () => {
  const target: WalkBridge = { walkBody: fakeBody, stopAll: () => {} };
  const originalBody = target.walkBody;
  const originalStop = target.stopAll;
  const diag = new WalkDiagnostics(target, () => null, () => snapshotKeys({ controlState: emptyKeys }));
  diag.wrap();
  assert.notEqual(target.walkBody, originalBody);
  diag.unwrap();
  assert.equal(target.walkBody, originalBody);
  assert.equal(target.stopAll, originalStop);
});

// --- ExecutionDiagnostics：move / onSample 公开桥的包装与恢复 ---

test('ExecutionDiagnostics：包装 move 记录 from/to/executionId，unwrap 恢复', async () => {
  const exec = new ExecutionDiagnostics(() => 0);
  const orig = WalkMoveExecutor.prototype.move;
  exec.wrap();
  assert.notEqual(WalkMoveExecutor.prototype.move, orig);

  const entity = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  const body = { setControlState() {}, clearControlStates() {}, look() {}, entity };
  const parent = new AbortController();
  const tick = () => { parent.abort(); return Promise.resolve(entity); };
  const executor = new WalkMoveExecutor(body, tick, parent.signal, () => 0);
  await executor.move({ executionId: 'walk-1-step-0', worldId: 'w', dim: 'd', sessionId: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, deadlineMs: 1000, timeoutMs: 100, signal: new AbortController().signal });

  assert.equal(exec.moves.length, 1);
  assert.equal(exec.moves[0]!.executionId, 'walk-1-step-0');
  assert.deepEqual(exec.moves[0]!.from, { x: 0, y: 0, z: 0 });
  assert.deepEqual(exec.moves[0]!.to, { x: 1, y: 0, z: 0 });

  exec.unwrap();
  assert.equal(WalkMoveExecutor.prototype.move, orig);
});

test('ExecutionDiagnostics：包装 onSample 记录委托样本（delegationId/sequence/pos），unwrap 恢复', () => {
  const exec = new ExecutionDiagnostics(() => 1000);
  const orig = WalkRouteExecutor.prototype.onSample;
  exec.wrap();
  assert.notEqual(WalkRouteExecutor.prototype.onSample, orig);

  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  const loop = new WalkRouteExecutor(map, { move: async () => ({ failure: { kind: 'cancelled' } as const }), stop: () => {} });
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

  assert.equal(exec.acceptedSamples.length, 1);
  assert.equal(exec.acceptedSamples[0]!.delegationId, delegationId);
  assert.equal(exec.acceptedSamples[0]!.sequence, 1);
  assert.deepEqual(exec.acceptedSamples[0]!.pos, { x: 0.5, y: 0, z: 0.5 });

  exec.unwrap();
  assert.equal(WalkRouteExecutor.prototype.onSample, orig);
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

test('quitClient：已观测到断线（connection-lifetime）→ 立即 ended=true 不等过去事件', async () => {
  const em = new FakeEmitter();
  const tracker = new ConnectionTracker(em as never);
  em.emit('disconnected', 'earlier'); // 已发生过的断线
  let quitCalled = false;
  const adapter = { bot: { quit: () => {} }, quit: () => { quitCalled = true; }, on: em.on.bind(em), removeListener: em.removeListener.bind(em) };
  const r = await quitClient(adapter as never, tracker, 5000);
  assert.equal(r.ended, true);
  assert.equal(r.reason, 'already-observed end');
  assert.equal(quitCalled, false, '已结束则不应再 quit');
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

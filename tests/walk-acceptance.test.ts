/**
 * walk-acceptance.ts 的窄测试：纯函数（场景选择器、RCON list 解析、相邻 X 路线、轨迹统计）、
 * 源元数据校验，以及 WalkDiagnostics 的「创建时绑定归属 / stopAll 前快照」。只测无副作用
 * 或假夹具路径，不连接服务器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adjacentRouteX,
  dist2,
  gitMeta,
  packageMeta,
  parseRconList,
  parseScenarioSelector,
  snapshotKeys,
  summarizeTrajectory,
  WalkDiagnostics,
  type FrameRecord,
  type WalkBridge,
} from '../scripts/walk-acceptance.ts';

const emptyKeys = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };

test('parseScenarioSelector：缺省为支持的 W1/W2/W6/W7，自定义按序解析', () => {
  assert.deepEqual(parseScenarioSelector(undefined), ['W1', 'W2', 'W6', 'W7']);
  assert.deepEqual(parseScenarioSelector(''), ['W1', 'W2', 'W6', 'W7']);
  assert.deepEqual(parseScenarioSelector('W1,W6'), ['W1', 'W6']);
  assert.deepEqual(parseScenarioSelector(' w2 , w7 '), ['W2', 'W7']);
  assert.throws(() => parseScenarioSelector('W1,W9'), /未知场景 W9/);
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

test('packageMeta：源元数据彼此对应，版本非静态写死', () => {
  const meta = packageMeta();
  assert.equal(meta.name, 'curio-minecraft-3d-memory');
  assert.equal(meta.lockVersion, meta.version);
  assert.equal(meta.lockResolved, meta.dependencySpec);
  assert.ok(meta.dependencySpec.startsWith('file:'));
  assert.match(meta.tgzSha256, /^[0-9a-f]{64}$/);
});

test('gitMeta：包含提交哈希、分支与脚本指纹，不伪造 clean HEAD', () => {
  const meta = gitMeta();
  assert.match(meta.sha, /^[0-9a-f]{40}$/);
  assert.ok(meta.branch.length > 0);
  assert.match(meta.scriptFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(meta.dirtyPaths));
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

  target.walkBody!(); // 绑定 lastBodyOwner = task_A
  target.stopAll();

  assert.equal(stopped, true);
  assert.equal(diag.stopSnapshots.length, 1);
  const snap = diag.stopSnapshots[0]!;
  assert.equal(snap.label, 'pre-stopAll');
  assert.equal(snap.ownerTaskId, 'task_A');
  assert.equal(snap.ts, 123);
  assert.equal(snap.keys.forward, true, '快照必须在真实 stopAll 清键之前采集');
  // stopAll 也进入控制日志，与 body 写入区分
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

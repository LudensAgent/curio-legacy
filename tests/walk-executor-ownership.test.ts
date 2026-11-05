import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutableMove } from 'curio-minecraft-3d-memory';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { WalkMoveExecutor } from '../src/adapter/walk-route.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

function recordingBody() {
  const controls: string[] = [];
  const entity = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  const body = {
    setControlState(name: string, value: boolean) { controls.push(`set:${name}:${value}`); },
    clearControlStates() { controls.push('clear'); },
    look(yaw: number, _pitch: number) { controls.push(`look:${yaw.toFixed(2)}`); },
    entity,
  };
  return { controls, body };
}

test('已取消的请求不写任何控制（控制前先检查取消）', async () => {
  const { controls, body } = recordingBody();
  const executor = new WalkMoveExecutor(body, () => Promise.resolve(body.entity), new AbortController().signal, () => 0);
  const abort = new AbortController();
  abort.abort();
  const request: ExecutableMove = { executionId: 'e1', worldId: 'w', dim: 'd', sessionId: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, deadlineMs: 1000, timeoutMs: 100, signal: abort.signal };
  const result = await executor.move(request);
  assert.equal(result.failure?.kind, 'cancelled');
  assert.deepEqual(controls, [], '已取消请求不得写 look/forward/clear');
});

test('父任务信号中止同样拦截控制写入', async () => {
  const { controls, body } = recordingBody();
  const parent = new AbortController();
  parent.abort();
  const executor = new WalkMoveExecutor(body, () => Promise.resolve(body.entity), parent.signal, () => 0);
  const request: ExecutableMove = { executionId: 'e1', worldId: 'w', dim: 'd', sessionId: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, deadlineMs: 1000, timeoutMs: 100, signal: new AbortController().signal };
  const result = await executor.move(request);
  assert.equal(result.failure?.kind, 'cancelled');
  assert.deepEqual(controls, [], '父任务已取消时不得写控制');
});

test('stop 只释放所属 executionId，旧 ID 不清理当前控制', () => {
  const { controls, body } = recordingBody();
  const executor = new WalkMoveExecutor(body, () => Promise.resolve(body.entity), new AbortController().signal, () => 0);
  executor.stop('old-id');
  assert.deepEqual(controls, [], '无活动段时旧 ID 的 stop 不得写控制');
});

test('旧段迟到的 releaseIf 不清新段归属，新段 stop 仍能释放', async () => {
  const { controls, body } = recordingBody();
  const executor = new WalkMoveExecutor(body, () => Promise.resolve(body.entity), new AbortController().signal, () => 0);
  const sig = new AbortController();
  const p = executor.move({ executionId: 'e2', worldId: 'w', dim: 'd', sessionId: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, deadlineMs: 100000, timeoutMs: 100000, signal: sig.signal });
  await new Promise((r) => setImmediate(r)); // 让 move 循环启动并写 forward
  // 旧段迟到收尾（executionId 不匹配当前段）
  (Reflect.get(executor, 'releaseIf') as (id: string) => void).call(executor, 'e1');
  executor.stop('e2'); // 新段 stop 应仍能释放前进键
  assert.ok(controls.includes('set:forward:false'), '旧段 releaseIf 清掉新段归属会导致 stop 失效');
  sig.abort();
  await p;
});

/** 宿主 epoch 绑定的身体桥：控制写入只在创建它的 epoch 内生效。 */
function epochBody(host: { epoch: number }, control: Record<string, boolean>) {
  const entity = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  const epoch = host.epoch;
  const owns = () => host.epoch === epoch;
  return {
    setControlState(name: string, value: boolean) { if (owns()) control[name] = value; },
    clearControlStates() { if (owns()) for (const k of Object.keys(control)) control[k] = false; },
    look() {},
    entity,
    controlOwnership: { owns },
  };
}

/** 挂起的物理帧：只在信号中止时结束，避免移动循环自行跑完。 */
const stalledTick = (signal: AbortSignal) => new Promise<null>((resolve) => {
  if (signal.aborted) { resolve(null); return; }
  signal.addEventListener('abort', () => resolve(null), { once: true });
});

test('宿主换主后，旧执行的迟到 stop/releaseIf 不清新任务的控制，新 stop 仍释放', async () => {
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const host = { epoch: 1 };
  const oldParent = new AbortController();
  const oldReq = new AbortController();
  const oldExec = new WalkMoveExecutor(epochBody(host, control), stalledTick, oldParent.signal, () => 0);
  const oldMove = oldExec.move({ executionId: 'old', worldId: 'w', dim: 'd', sessionId: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, deadlineMs: 100000, timeoutMs: 100000, signal: oldReq.signal });
  await new Promise((r) => setImmediate(r));
  assert.equal(control.forward, true, '旧执行先取得前进控制');

  // 新任务接管：宿主动作换主，旧身体桥整体失效。
  host.epoch = 2;
  const newParent = new AbortController();
  const newReq = new AbortController();
  const newBody = epochBody(host, control);
  const newExec = new WalkMoveExecutor(newBody, stalledTick, newParent.signal, () => 0);
  const newMove = newExec.move({ executionId: 'new', worldId: 'w', dim: 'd', sessionId: 's', from: { x: 0, y: 0, z: 0 }, to: { x: -10, y: 0, z: 0 }, deadlineMs: 100000, timeoutMs: 100000, signal: newReq.signal });
  await new Promise((r) => setImmediate(r));
  newBody.setControlState('sneak', true); // 新任务自己的附加控制

  // 旧执行迟到收尾：不得松开新任务的前进/潜行。
  oldExec.stop('old');
  (Reflect.get(oldExec, 'releaseIf') as (id: string) => void).call(oldExec, 'old');
  assert.equal(control.forward, true, '旧 stop/releaseIf 不得清掉新任务的前进键');
  assert.equal(control.sneak, true, '旧 stop/releaseIf 不得清掉新任务的潜行键');

  // 新执行自己的 stop 仍能释放全部控制。
  newExec.stop('new');
  assert.equal(control.forward, false, '新 stop 必须释放前进键');
  assert.equal(control.sneak, false, '新 stop 必须释放潜行键');

  oldReq.abort();
  newReq.abort();
  await Promise.all([oldMove, newMove]);
});

test('MineflayerAdapter.walkBody 绑定 action epoch：stopAll 后旧身体桥不能再写控制', () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const control: Record<string, boolean> = { forward: false, sneak: false };
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false },
    inventory: { slots: [] },
    setControlState(name: string, value: boolean) { control[name] = value; },
    clearControlStates() { for (const k of Object.keys(control)) control[k] = false; },
    look() {},
    pathfinder: { stop() {}, setGoal() {} },
    deactivateItem() {},
    targetDigBlock: null,
    currentWindow: null,
    isSleeping: false,
  };
  adapter.bot = bot;
  const old = adapter.walkBody();
  adapter.stopAll(); // 换主：actionEpoch 递增
  old.setControlState('forward', true);
  old.clearControlStates();
  assert.equal(control.forward, false, '旧身体桥换主后不得写控制');
  assert.equal(old.controlOwnership?.owns(), false);

  const fresh = adapter.walkBody();
  fresh.setControlState('sneak', true);
  assert.equal(control.sneak, true, '新身体桥应能写控制');
  assert.equal(fresh.controlOwnership?.owns(), true);
});

test('releaseIf 释放全部移动键（forward/back/sneak），不残留倒退或潜行', () => {
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  const body = {
    setControlState(name: string, value: boolean) { control[name] = value; },
    clearControlStates() { for (const k of Object.keys(control)) control[k] = false; },
    look() {},
    entity,
  };
  const executor = new WalkMoveExecutor(body, () => Promise.resolve(body.entity), new AbortController().signal, () => 0);
  // 模拟倒退纠偏已按下 back+sneak，然后释放：releaseIf 必须清掉全部移动键。
  control.forward = false; control.back = true; control.sneak = true;
  Reflect.set(executor, 'activeExecutionId', 'e9');
  (Reflect.get(executor, 'releaseIf') as (id: string) => void).call(executor, 'e9');
  assert.equal(control.forward, false);
  assert.equal(control.back, false, 'releaseIf 必须释放倒退键');
  assert.equal(control.sneak, false, 'releaseIf 必须释放潜行键');
});

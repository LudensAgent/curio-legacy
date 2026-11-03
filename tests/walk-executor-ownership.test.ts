import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutableMove } from 'curio-minecraft-3d-memory';
import { WalkMoveExecutor } from '../src/adapter/walk-route.ts';

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
  const executor = new WalkMoveExecutor(body, () => body.entity, () => 0);
  const abort = new AbortController();
  abort.abort();
  const request: ExecutableMove = { executionId: 'e1', worldId: 'w', dim: 'd', sessionId: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, deadlineMs: 1000, timeoutMs: 100, signal: abort.signal };
  const result = await executor.move(request);
  assert.equal(result.failure?.kind, 'cancelled');
  assert.deepEqual(controls, [], '已取消请求不得写 look/forward/clear');
});

test('stop 只释放所属 executionId，旧 ID 不清理当前控制', () => {
  const { controls, body } = recordingBody();
  const executor = new WalkMoveExecutor(body, () => body.entity, () => 0);
  executor.stop('old-id');
  assert.deepEqual(controls, [], '无活动段时旧 ID 的 stop 不得写控制');
});

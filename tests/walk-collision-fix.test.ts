import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROUNDED_ARRIVAL_DEFAULTS, VoxelMap, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type { BodySample, MoveExecutor } from 'curio-minecraft-3d-memory';
import { walkCollisionProvider } from '../src/adapter/walk-route.ts';

function mapWithBlockAt(blockPos: { x: number; y: number; z: number }) {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  for (let x = -1; x <= 3; x++) for (let z = -1; z <= 3; z++) for (let y = -1; y <= 2; y++) {
    const solid = y === -1 || (x === blockPos.x && z === blockPos.z && y === blockPos.y);
    map.observe({ worldId: 'world', dim: 'overworld', sessionId: 's1', observedAt: 1000, sequence: 1,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: solid ? { name: 'minecraft:stone', properties: {} } : { name: 'minecraft:air', properties: {} }, pos: { x, y, z } });
  }
  return map;
}

function sample(pos: { x: number; y: number; z: number }, at: number, seq: number, executionId: string): BodySample {
  return { worldId: 'world', dim: 'overworld', sessionId: 's1', executionId, pos, velocity: { x: 0, y: 0, z: 0 }, observedAt: at, sequence: seq, alive: true, connected: true, observationReady: true, onGround: true, inWater: false };
}

const noopExecutor: MoveExecutor = { move: async () => ({ failure: { kind: 'execution_error', detail: 'not used' } }), stop: () => {} };

test('相邻整块 + 0.1 偏移起点不因包围盒角落重叠误报 BLOCKED', () => {
  const map = mapWithBlockAt({ x: 1, y: 0, z: 1 });
  const loop = new WalkRouteExecutor(map, noopExecutor, { now: () => 2000 });
  const points = [{ x: 0.5, y: 0, z: 0.61 }, { x: 1.5, y: 0, z: 0.61 }];
  const started = loop.start({ worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
    body: { feet: points[0]!, width: 0.6, height: 1.8, pose: 'standing' }, points,
    arrival: { kind: 'exact' }, bodyArrival: GROUNDED_ARRIVAL_DEFAULTS, shapeProvider: walkCollisionProvider,
    deadlineMs: 30_000, timeoutMs: 4000 });
  // 实际起点偏移 0.1（z=0.71），多帧稳定后 advance。
  for (let i = 0; i < 8; i++) loop.onSample(sample({ x: 0.5, y: 0, z: 0.71 }, 2000 + i * 50, i + 1, started.delegationId));
  loop.advance(10);
  const result = loop.status()!.result;
  assert.notEqual(result?.outcome, 'BLOCKED', `扫掠碰撞不应误报：${result?.message ?? 'no result'}`);
  assert.notEqual(result?.outcome, 'FAILED', `不应失败：${result?.message ?? 'no result'}`);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WalkCorridorEvidence } from '../src/spatial/shared-session.ts';
import { TraversalRecorder } from '../src/spatial/traversal-recorder.ts';

function recorderWithCalls() {
  const calls: WalkCorridorEvidence[] = [];
  const recorder = new TraversalRecorder({
    recordWalkCorridor: (input: WalkCorridorEvidence) => {
      calls.push(input);
      return { status: 'written' as const, fragmentId: input.fragment.id, traversalIds: input.segments.map((segment) => segment.id), stancesMarked: input.segments.length, deliveryError: null };
    },
  }, () => 1000);
  return { calls, recorder };
}

const at = (x: number, y: number, z: number) => ({ x, y, z });

test('TraversalRecorder 把连续位移写成共享 fragment + segment，不按 kind 分支', () => {
  const { calls, recorder } = recorderWithCalls();
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(2.5, 64, 0.5), dug: [{ pos: at(2, 63, 0), name: 'stone', ts: 1 }] });
  recorder.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.fragment.kind, 'dug');
  assert.equal(calls[0]!.fragment.geometrySource, 'traversal');
  assert.equal(calls[0]!.fragment.polyline.length, 3);
  assert.equal(calls[0]!.segments.length, 2);
  assert.equal(calls[0]!.segments[0]!.source, 'confirmed_traversal');
  assert.equal(calls[0]!.segments[0]!.mode, 'walk');
});

test('TraversalRecorder 不把瞬移接成一条路；桥上走过标 bridge 只是来源标签', () => {
  const { calls, recorder } = recorderWithCalls();
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(30.5, 64, 0.5) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(31.5, 64, 0.5), onPlacedSupport: () => true });
  recorder.flush();
  assert.equal(calls.length, 2, '瞬移前后必须分成两个 fragment');
  assert.equal(calls[0]!.segments.length, 1);
  assert.equal(calls[1]!.fragment.kind, 'bridge');
  assert.equal(calls[1]!.segments.length, 1);
});

test('TraversalRecorder 不记录游泳/骑乘位移', () => {
  const { calls, recorder } = recorderWithCalls();
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5), inWater: true });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5), riding: true });
  recorder.flush();
  assert.equal(calls.length, 0);
});

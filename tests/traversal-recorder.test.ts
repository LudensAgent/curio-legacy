import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WalkCorridorEvidence } from '../src/spatial/shared-session.ts';
import { TraversalRecorder } from '../src/spatial/traversal-recorder.ts';

function recorderWithCalls(now: () => number = () => 1000) {
  const calls: WalkCorridorEvidence[] = [];
  const recorder = new TraversalRecorder({
    recordWalkCorridor: (input: WalkCorridorEvidence) => {
      calls.push(input);
      return { status: 'written' as const, fragmentId: input.fragment.id, traversalIds: input.segments.map((segment) => segment.id), stancesMarked: input.segments.length, deliveryError: null };
    },
  }, now);
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

test('8 点上限 flush 后新段以旧段末点为首点，并补一条 seam segment', () => {
  const { calls, recorder } = recorderWithCalls();
  for (let x = 0; x < 10; x++) recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(x, 64, 0) });
  recorder.flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.fragment.polyline.at(-1), at(7, 64, 0));
  assert.deepEqual(calls[1]!.fragment.polyline[0], at(7, 64, 0), '新段首点必须是旧段末点');
  assert.ok(calls[1]!.segments.some((segment) => segment.from.x === 7 && segment.to.x === 8), '补出 7→8 的 seam segment');
});

test('停走超过阈值后落盘当前段，并保留末点作为下一段 seam', () => {
  let now = 1000;
  const { calls, recorder } = recorderWithCalls(() => now);
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5) });
  now = 1100;
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  assert.equal(calls.length, 0, '还在走动时不提前落盘');

  now = 3000;
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  assert.equal(calls.length, 0, '停走未超过阈值不落盘');

  now = 5000;
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  assert.equal(calls.length, 1, '停走超过阈值立即写入已确认短段');
  assert.deepEqual(calls[0]!.fragment.polyline.at(-1), at(1.5, 64, 0.5));

  now = 6000;
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(2.5, 64, 0.5) });
  recorder.flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.fragment.polyline[0], at(1.5, 64, 0.5), '下一段从停走位置接上');
  assert.deepEqual(calls[1]!.segments[0]!.from, at(1.5, 64, 0.5));
  assert.deepEqual(calls[1]!.segments[0]!.to, at(2.5, 64, 0.5));
});

test('8 点 flush 后在 seam 附近停走，仍保留同一记录点的连接', () => {
  let now = 1000;
  const { calls, recorder } = recorderWithCalls(() => now);
  for (let x = 0; x < 8; x++) {
    now += 100;
    recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(x, 64, 0) });
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.fragment.polyline.at(-1), at(7, 64, 0));

  now += 100;
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(7.5, 64, 0) });
  now += 3000;
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(7.5, 64, 0) });
  assert.equal(calls.length, 1, '不足一格的抖动不单独落盘');

  now += 100;
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(8.5, 64, 0) });
  recorder.flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.fragment.polyline[0], at(7, 64, 0), '新段仍从上一个确认记录点接上');
  assert.deepEqual(calls[1]!.segments[0]!.from, at(7, 64, 0));
});

test('瞬移不把旧段末点带进新段', () => {
  const { calls, recorder } = recorderWithCalls();
  for (let x = 0; x < 8; x++) recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(x, 64, 0) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(100, 64, 0) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(101, 64, 0) });
  recorder.flush();
  assert.equal(calls[0]!.fragment.polyline.at(-1)?.x, 7);
  assert.equal(calls[1]!.fragment.polyline[0]?.x, 100, '瞬移后新段从实测位置开始，不携带旧末点');
  assert.ok(!calls[1]!.segments.some((segment) => segment.from.x === 7), '不得伪造 7→100 的 seam');
});

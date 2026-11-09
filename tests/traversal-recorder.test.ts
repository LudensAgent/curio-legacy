import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WalkCorridorEvidence } from '../src/spatial/shared-session.ts';
import { MAX_TRAVERSAL_RECEIPTS, TraversalRecorder } from '../src/spatial/traversal-recorder.ts';

function recorderWithCalls(now: () => number = () => 1000) {
  const calls: WalkCorridorEvidence[] = [];
  const recorder = new TraversalRecorder({
    recordWalkCorridor: (input: WalkCorridorEvidence) => {
      calls.push(input);
      return {
        status: 'written' as const, fragmentId: input.fragment.id,
        traversalIds: input.segments.map((segment) => segment.id),
        stancesMarked: input.segments.length, deliveryError: null,
        topology: { nodes: input.fragment.polyline.length, edges: input.segments.length, written: true },
      };
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

test('远离实测路径的 dug 不把自然洞穴行走误标为 dug', () => {
  const { calls, recorder } = recorderWithCalls();
  // 首次观测就带一条很远的挖空证据（不在本次行走附近）；不得因此把整段标成 dug。
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5), dug: [{ pos: at(50.5, 64, 50.5), name: 'stone', ts: 1 }] });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(2.5, 64, 0.5) });
  recorder.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.fragment.kind, 'walked', '远处 dug 只是无关证据，不改变这段自然行走的来源标签');
  assert.equal(calls[0]!.fragment.polyline.length, 3);
});

test('瞬移重启新段时，远处 dug 同样不重标为 dug', () => {
  const { calls, recorder } = recorderWithCalls();
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5) });
  // 瞬移触发新 run；附带一条离新段很远的 dug（离旧位置也远）。
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(30.5, 64, 0.5), dug: [{ pos: at(0.5, 64, 100.5), name: 'stone', ts: 2 }] });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(31.5, 64, 0.5) });
  recorder.flush();
  assert.equal(calls.length, 1, '瞬移前只有一个点、没有已确认 segment，不写空 fragment');
  assert.equal(calls[0]!.fragment.kind, 'walked');
});

test('未进入的挖空不写进 polyline，也不被当成走过的位置', () => {
  const { calls, recorder } = recorderWithCalls();
  const excavated = at(2, 63, 0.5);
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5), dug: [{ pos: excavated, name: 'stone', ts: 1 }] });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  recorder.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.fragment.kind, 'dug', '邻近挖空只作为来源标签');
  assert.deepEqual(calls[0]!.fragment.polyline, [at(0.5, 64, 0.5), at(1.5, 64, 0.5)], 'polyline 只含实测身体位置');
  assert.ok(!calls[0]!.fragment.polyline.some((point) => point.x === excavated.x && point.y === excavated.y && point.z === excavated.z), '未进入的挖空不得出现在 polyline');
  assert.ok(!calls[0]!.segments.some((segment) => segment.from.x === excavated.x || segment.to.x === excavated.x), '未进入的挖空不得成为 segment 端点');
});

test('dug 段的 segments 仍是 confirmed_traversal，端点等于实测位置，几何来源为 traversal', () => {
  const { calls, recorder } = recorderWithCalls();
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5), dug: [{ pos: at(1, 63, 0), name: 'stone', ts: 1 }] });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(2.5, 64, 0.5) });
  recorder.flush();
  assert.equal(calls.length, 1);
  const { fragment, segments } = calls[0]!;
  assert.equal(fragment.kind, 'dug');
  assert.equal(fragment.geometrySource, 'traversal', 'dug 不得改写几何来源');
  assert.deepEqual(fragment.polyline, [at(0.5, 64, 0.5), at(1.5, 64, 0.5), at(2.5, 64, 0.5)]);
  assert.equal(segments.length, 2);
  segments.forEach((segment, index) => {
    assert.equal(segment.source, 'confirmed_traversal');
    assert.deepEqual(segment.from, fragment.polyline[index]);
    assert.deepEqual(segment.to, fragment.polyline[index + 1]);
  });
});

test('flush 返回真实写入回执；失败回执保留阶段、已写入前缀与零拓扑计数', () => {
  const calls: WalkCorridorEvidence[] = [];
  let attempt = 0;
  const recorder = new TraversalRecorder({
    recordWalkCorridor: (input) => {
      calls.push(input);
      attempt += 1;
      if (attempt === 2) {
        return {
          status: 'failed' as const, stage: 'capacity' as const, message: 'topology cap',
          fragmentId: input.fragment.id, traversalIds: [input.segments[0]!.id],
          topology: { nodes: input.fragment.polyline.length, edges: input.segments.length, written: false },
        };
      }
      return {
        status: 'written' as const, fragmentId: input.fragment.id,
        traversalIds: input.segments.map((segment) => segment.id),
        stancesMarked: input.segments.length, deliveryError: null,
        topology: { nodes: input.fragment.polyline.length, edges: input.segments.length, written: true },
      };
    },
  }, () => 1000);

  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  const first = recorder.flush();
  assert.equal(first?.outcome.status, 'written');
  assert.equal(first?.segmentCount, 1);
  assert.deepEqual(first?.from, at(0.5, 64, 0.5));
  assert.deepEqual(first?.to, at(1.5, 64, 0.5));

  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(2.5, 64, 0.5) });
  recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(3.5, 64, 0.5) });
  const second = recorder.flush();
  assert.equal(second?.outcome.status, 'failed');
  assert.equal(second?.outcome.stage, 'capacity');
  assert.deepEqual(second?.outcome.traversalIds, [calls[1]!.segments[0]!.id], '失败只保留真实已写入前缀');
  assert.equal(second?.outcome.topology.written, false);

  assert.deepEqual(recorder.receipts().map((receipt) => receipt.sequence), [1, 2]);
  assert.equal(new TraversalRecorder({ recordWalkCorridor: () => { throw new Error('must not be called'); } }).flush(), null,
    '没有确认段时不写空回执');
});

test('sink 抛错只生成 sink_exception 回执；onFailure 抛错不改写已定稿的失败回执', () => {
  const failures: string[] = [];
  const throwing = new TraversalRecorder({
    recordWalkCorridor: () => { throw new Error('boom'); },
  }, () => 1000, (message) => failures.push(message));
  throwing.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5) });
  throwing.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  const exception = throwing.flush();
  const outcome = exception?.outcome;
  assert.ok(outcome?.status === 'failed');
  if (outcome?.status !== 'failed') assert.fail('sink throw must produce a failed receipt');
  assert.equal(outcome.stage, 'sink_exception', '只把 sink 抛错转成 recorder 侧结局');
  assert.equal(outcome.traversalIds, 'unknown', '无法知道库是否写入时不得伪造空数组');
  assert.equal(outcome.topology.nodes, 'unknown');
  assert.equal(outcome.topology.edges, 'unknown');
  assert.equal(outcome.topology.written, 'unknown', '抛错后写入状态是未知，不是未写');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /空间记忆写入异常：boom/);

  // 库已返回“历史已写、拓扑失败”的真实结果后，onFailure（bus.publish）抛错：
  // 已定稿的回执必须保留真实阶段与已写入前缀，不能被改写成异常。
  const calls: WalkCorridorEvidence[] = [];
  const prefix = new TraversalRecorder({
    recordWalkCorridor: (input) => {
      calls.push(input);
      return {
        status: 'failed' as const, stage: 'capacity' as const, message: 'topology skipped',
        fragmentId: input.fragment.id, traversalIds: [input.segments[0]!.id],
        topology: { nodes: input.fragment.polyline.length, edges: input.segments.length, written: false },
      };
    },
  }, () => 1000, () => { throw new Error('bus down'); });
  prefix.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(0.5, 64, 0.5) });
  prefix.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(1.5, 64, 0.5) });
  assert.throws(() => prefix.flush(), /bus down/);
  const kept = prefix.receipts();
  assert.equal(kept.length, 1, '回调抛错前回执已经定稿');
  assert.equal(kept[0]!.outcome.status, 'failed');
  if (kept[0]!.outcome.status !== 'failed') assert.fail('expected failed receipt');
  assert.equal(kept[0]!.outcome.stage, 'capacity');
  assert.deepEqual(kept[0]!.outcome.traversalIds, [calls[0]!.segments[0]!.id], '已写入前缀不被回调抛错改写');
  assert.equal(kept[0]!.outcome.topology.written, false);
});

test('写入回执有界保留；每次确认段都真实写入，旧回执被淘汰而最新可读', () => {
  let written = 0;
  const recorder = new TraversalRecorder({
    recordWalkCorridor: (input) => {
      written += 1;
      return {
        status: 'written' as const, fragmentId: input.fragment.id,
        traversalIds: input.segments.map((segment) => segment.id),
        stancesMarked: input.segments.length, deliveryError: null,
        topology: { nodes: input.fragment.polyline.length, edges: input.segments.length, written: true },
      };
    },
  }, () => 1000);
  for (let i = 0; i < MAX_TRAVERSAL_RECEIPTS + 4; i++) {
    recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(i * 10, 64, 0) });
    recorder.observe({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: at(i * 10 + 1, 64, 0) });
    recorder.flush();
  }
  assert.equal(written, MAX_TRAVERSAL_RECEIPTS + 4, '每次确认段都真实写入，不因回执有界而少写');
  const receipts = recorder.receipts();
  assert.equal(receipts.length, MAX_TRAVERSAL_RECEIPTS);
  assert.equal(receipts[0]!.sequence, 5);
  assert.equal(receipts.at(-1)!.sequence, MAX_TRAVERSAL_RECEIPTS + 4);
  assert.equal(recorder.receipts(2).length, 2);
  assert.equal(recorder.receipts(2).at(-1)!.sequence, MAX_TRAVERSAL_RECEIPTS + 4);
});

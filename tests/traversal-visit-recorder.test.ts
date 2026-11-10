/**
 * B5.4：普通移动只保留实测到访位。
 *
 * 这些用例驱动真实 `SharedSpatialSession`（真实 SQLite Worker），验证普通移动
 * 不新增 Fragment/traversal/拓扑节点/路线边，同时仍按实测落点标记到访位。
 * 历史几何的显式兼容写入仍由 `TraversalRecorder`/`recordWalkCorridor` 的既有测试覆盖。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import {
  MAX_TRAVERSAL_VISIT_RECEIPTS,
  TraversalVisitRecorder,
} from '../src/spatial/traversal-visit-recorder.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { DIM, FixtureClock, SESSION_1, WORLD, withSharedSession } from './fixtures/spatial-w4-w5-w7.ts';

const at = (x: number, y: number, z: number) => ({ x, y, z });

function counts(session: SharedSpatialSession) {
  const fragments = session.query({ kind: 'fragments', dim: DIM, limit: 1 });
  const traversals = session.query({ kind: 'traversals', dim: DIM });
  const nodes = session.query({ kind: 'nodes', dim: DIM });
  const edges = session.query({ kind: 'edges', dim: DIM });
  return {
    fragments: fragments.data?.kind === 'fragments' ? fragments.data.total : null,
    traversals: traversals.data?.kind === 'traversals' ? traversals.data.total : null,
    nodes: nodes.data?.kind === 'nodes' ? nodes.data.total : null,
    edges: edges.data?.kind === 'edges' ? edges.data.total : null,
  };
}

test('普通移动只标记实测到访位，不新增 Fragment/traversal/拓扑', async () => {
  const clock = new FixtureClock(0);
  await withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    const before = counts(session);
    const failures: string[] = [];
    const recorder = new TraversalVisitRecorder(session, clock.now, (message) => failures.push(message));

    for (const [index, x] of [14.5, 15.5, 16.5, 17.5].entries()) {
      clock.set(index + 1);
      recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(x, 0, 0.5), onGround: true });
    }

    assert.deepEqual(counts(session), before, '普通移动不得新增历史几何');
    for (const x of [15, 16, 17]) {
      const cell = session.session.voxel.historyAt(DIM, x, 0, 0);
      assert.equal(cell.traversed, true, `实测落点 x=${x} 必须留下到访位`);
      assert.equal(cell.explored, false, '到访不等于已观察');
    }
    assert.equal(session.session.voxel.historyAt(DIM, 14, 0, 0).traversed, false, '起点本身不算一次“走到”');
    assert.deepEqual(failures, []);
    assert.equal(recorder.receipts().length, 3, '每次确认落点一条有界回执');
    assert.ok(recorder.receipts().every((receipt) => receipt.outcome.status === 'written'));
    assert.deepEqual(recorder.receipts().map((receipt) => receipt.cell.x), [15, 16, 17]);
  });
});

test('较大下落只标记落地帧，不标记空中位置；瞬移/游泳/骑乘不产生到访', async () => {
  const clock = new FixtureClock(0);
  await withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    const recorder = new TraversalVisitRecorder(session, clock.now);
    const step = (x: number, y: number, z: number, extra: Partial<{ onGround: boolean; inWater: boolean; riding: boolean }> = {}) => {
      clock.set(clock.now() + 1);
      recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(x, y, z), onGround: true, ...extra });
    };

    // 从 y=68 下落：离地期间不标记，落地点 y=64 才标记。
    step(0.5, 68, 0.5);
    step(0.5, 65, 0.5, { onGround: false });
    step(0.5, 64, 0.5, { onGround: true });
    assert.equal(session.session.voxel.historyAt(DIM, 0, 66, 0).traversed, false, '空中位置不是到访');
    assert.equal(session.session.voxel.historyAt(DIM, 0, 65, 0).traversed, false, '空中位置不是到访');
    assert.equal(session.session.voxel.historyAt(DIM, 0, 64, 0).traversed, true, '落地帧必须标记');

    // 游泳/骑乘结束当前步行段，不标记；之后瞬移也不标记中间格。
    step(0.5, 64, 1.5, { inWater: true });
    step(0.5, 64, 2.5, { riding: true });
    step(20.5, 64, 2.5);
    assert.equal(session.session.voxel.historyAt(DIM, 0, 64, 1).traversed, false, '游泳位移不按步行标记');
    assert.equal(session.session.voxel.historyAt(DIM, 0, 64, 2).traversed, false, '骑乘位移不按步行标记');
    assert.equal(session.session.voxel.historyAt(DIM, 20, 64, 2).traversed, false, '瞬移落点不标记');
    assert.equal(session.session.voxel.historyAt(DIM, 10, 64, 2).traversed, false, '瞬移不插值中间格');
  });
});

test('Perception 的普通移动只写访问位，不新增历史几何', async () => {
  // Perception 内部使用真实 Date.now；共享会话也用同一时钟，避免未来观测时间。
  await withSharedSession(Date.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    const adapter = new FakeAdapter();
    adapter.worldId = WORLD;
    adapter.sessionId = SESSION_1;
    adapter.dim = DIM;
    adapter.pos = { x: 0.5, y: 64, z: 0.5 };
    adapter.onGround = true;
    const memory = new WorldMemory(null);
    const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter), session);
    try {
      const before = counts(session);
      perception.update();
      adapter.pos = { x: 1.5, y: 64, z: 0.5 };
      adapter.observationId += 1;
      perception.update();
      assert.deepEqual(counts(session), before, 'Perception 普通移动不得新增 Fragment/traversal/拓扑');
      assert.equal(session.session.voxel.historyAt(DIM, 1, 64, 0).traversed, true, '实测落点仍保留到访位');
      assert.deepEqual(perception.traversalReceipts().map((receipt) => receipt.cell.x), [1]);
    } finally {
      perception.stop();
      memory.close();
    }
  });
});

test('到访回执有界；拒绝与异常如实报告且不伪造已写入', () => {
  let now = 0;
  const outcomes: string[] = [];
  const rejected = new TraversalVisitRecorder({
    markTraversed: () => ({ status: 'rejected', reason: { kind: 'not_ready', detail: 'paused' } }),
  }, () => ++now, (message) => outcomes.push(message));
  const observe = (x: number, recorder: TraversalVisitRecorder) => {
    recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(x, 0, 0.5), onGround: true });
  };
  observe(0.5, rejected);
  for (let x = 1.5; x <= 20.5; x += 1) observe(x, rejected);
  assert.equal(rejected.receipts().length, MAX_TRAVERSAL_VISIT_RECEIPTS, '回执只保留有界窗口');
  assert.ok(rejected.receipts().every((receipt) => receipt.outcome.status === 'rejected'));
  assert.deepEqual(outcomes, [], 'rejected 是结构化拒绝，不是 sink 异常');

  const failures: string[] = [];
  const throwing = new TraversalVisitRecorder({
    markTraversed: () => { throw new Error('boom'); },
  }, () => ++now, (message) => failures.push(message));
  observe(0.5, throwing);
  observe(1.5, throwing);
  assert.equal(throwing.receipts().at(-1)?.outcome.status, 'failed');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /实测到访写入异常：boom/);
});

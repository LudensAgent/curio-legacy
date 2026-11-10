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
import { DIM, FixtureClock, SESSION_1, WORLD, withSharedSession } from './fixtures/shared-session.ts';

const at = (x: number, y: number, z: number) => ({ x, y, z });

function counts(session: SharedSpatialSession) {
  const summary = session.session.legacyStoreSummary;
  return {
    fragments: summary.fragments,
    traversals: summary.traversals,
    nodes: summary.nodes,
    edges: summary.edges,
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

test('下落初期的短下降帧不把空中位置写成到访', async () => {
  const clock = new FixtureClock(0);
  await withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    const recorder = new TraversalVisitRecorder(session, clock.now);
    const step = (x: number, y: number, z: number, extra: Partial<{ onGround: boolean }> = {}) => {
      clock.set(clock.now() + 1);
      recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(x, y, z), onGround: true, ...extra });
    };
    // 第一帧只下降 0.5 格，不能因此把 y=67 当成走到过。
    step(0.5, 68, 0.5);
    step(0.5, 67.5, 0.5, { onGround: false });
    step(0.5, 64, 0.5, { onGround: true });
    assert.equal(session.session.voxel.historyAt(DIM, 0, 67, 0).traversed, false, '离地短帧不是到访');
    assert.equal(session.session.voxel.historyAt(DIM, 0, 64, 0).traversed, true, '落地帧才标记');
  });
});

test('长距离连续下落按相邻采样保留落地到访；离地断开则不标记', async () => {
  const clock = new FixtureClock(0);
  await withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    const recorder = new TraversalVisitRecorder(session, clock.now);
    const step = (
      x: number, y: number, z: number,
      extra: Partial<{ onGround: boolean }> = {},
      advanceMs = 1,
    ) => {
      clock.set(clock.now() + advanceMs);
      recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(x, y, z), onGround: true, ...extra });
    };

    // 累计 36 格的真实下落，每 700ms 一个连续样本：必须标记落地格。
    step(0.5, 100, 0.5);
    for (const y of [96, 90, 82, 72]) step(0.5, y, 0.5, { onGround: false }, 700);
    step(0.5, 64, 0.5, {}, 700);
    assert.equal(session.session.voxel.historyAt(DIM, 0, 64, 0).traversed, true, '真实长下落必须保留落地到访');
    assert.equal(session.session.voxel.historyAt(DIM, 0, 96, 0).traversed, false, '空中位置不是到访');

    // 第一帧就横移瞬移：即使落地与上一帧相邻，也不能标记。
    step(0.5, 80, 0.5);
    step(100.5, 78, 0.5, { onGround: false });
    step(100.5, 76, 0.5);
    assert.equal(session.session.voxel.historyAt(DIM, 100, 76, 0).traversed, false, '下落中横移瞬移不标记');

    // 纯竖直 100 格瞬移，样本只隔 1ms：超过重力上限，不标记。
    step(200.5, 176, 0.5);
    step(200.5, 76, 0.5, { onGround: false });
    step(200.5, 76, 0.5);
    assert.equal(session.session.voxel.historyAt(DIM, 200, 76, 0).traversed, false, '超重力竖直瞬移不标记');
  });
});

test('下落期间瞬移/远距横移落地不标记目的地', async () => {
  const clock = new FixtureClock(0);
  await withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    const recorder = new TraversalVisitRecorder(session, clock.now);
    const step = (x: number, y: number, z: number, extra: Partial<{ onGround: boolean }> = {}) => {
      clock.set(clock.now() + 1);
      recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(x, y, z), onGround: true, ...extra });
    };
    step(0.5, 68, 0.5);
    step(0.5, 66, 0.5, { onGround: false });
    step(100.5, 64, 0.5, { onGround: true });
    assert.equal(session.session.voxel.historyAt(DIM, 100, 64, 0).traversed, false, '下落中的远距瞬移不是落点');

    step(100.5, 68, 0.5);
    step(100.5, 66, 0.5, { onGround: false });
    step(106.5, 64, 0.5, { onGround: true });
    assert.equal(session.session.voxel.historyAt(DIM, 106, 64, 0).traversed, false, '下落中的远距横移不是落点');
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

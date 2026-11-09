/**
 * D-V4-034：导航段 ↔ traversal 写入回执的逐段对齐（夹具级）。
 *
 * 用真实 `SharedSpatialSession`（SQLite Worker）与真实 `TraversalRecorder`，在显式段界
 * flush：每段以实测 startStance 起、逐段记录实测 moveTo 终点，再与 navigate_to 回执的
 * `segment.startStance/endStance/executed` 对比。这是可离线诚实验证的对齐；`navigate_to`
 * 自身的 `memoryWrite` 字段接线需要改 `src/skills/movement/navigate.ts`（P25-F 白名单外），
 * 本测试不伪造该字段，只断言它当前不存在。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { TraversalRecorder } from '../src/spatial/traversal-recorder.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';
import { DIM, SESSION_1, WORLD, blockObservation, withSharedSession } from './fixtures/spatial-w4-w5-w7.ts';

type Cell = { x: number; y: number; z: number };
type Segment = { startStance?: Cell; endStance?: Cell };

const navArgs = (to: Cell, maxSteps: number) => ({
  to, allowed: ['walk', 'step'] as ('walk' | 'step' | 'drop')[],
  historical: false, maxSteps, allowUnknownCorridor: false,
});

test('D-V4-034：每段 navigate_to 起止点与段界 flush 的 traversal 回执逐段对齐', async () => {
  await withSharedSession(() => Date.now(), async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    const observed: Cell[] = [];
    for (let x = -1; x <= 12; x++) for (const z of [-1, 0, 1]) {
      observed.push({ x, y: -1, z }, { x, y: 0, z }, { x, y: 1, z });
    }
    const observedAt = Date.now();
    const report = session.observe(observed.map((p, index) => blockObservation(p, p.y === -1 ? 'minecraft:stone' : 'minecraft:air', observedAt, index + 1)));
    assert.ok(report.sections.length > 0, '真实会话必须有合法观测');

    class TraceAdapter extends FakeAdapter {
      trace: Cell[] = [];
      override async moveTo(target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) {
        await super.moveTo(target, opts);
        this.trace.push({ ...this.pos });
      }
    }
    const adapter = new TraceAdapter();
    adapter.pos = { x: 0.5, y: 0, z: 0.5 };
    adapter.worldId = WORLD; adapter.sessionId = SESSION_1; adapter.dim = DIM;
    adapter.speed = 100_000; adapter.groundY = -1;
    const ctx = { ...makeCtx(adapter, { deadlineMs: 120_000 }), spatial: session };
    try {
      const receipts: { from?: Cell; to?: Cell; segmentCount?: number; traversalCount: number }[] = [];
      let previousEnd: Cell = { ...adapter.pos };
      for (const targetX of [6, 9]) {
        adapter.trace = [];
        const result = await navigateTo.run(ctx, navArgs({ x: targetX, y: 0, z: 0 }, 3));
        assert.equal(result.status, 'failed', 'maxSteps=3 是有界段界，不是到达');
        const segment = result.data?.segment as Segment;
        const executed = result.data?.executed as number;
        assert.equal(executed, 3);
        assert.deepEqual(segment.startStance, previousEnd, '段起点=上段实测终点');
        assert.equal(adapter.trace.length, executed, '每段实测 moveTo 数=确认段数');

        // 段界 flush：先记实测起点，再逐条记本段实测终点，最后显式落盘。
        const recorder = new TraversalRecorder(session, () => Date.now());
        recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: segment.startStance! });
        for (const pos of adapter.trace) recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos });
        const receipt = recorder.flush(true);
        assert.ok(receipt, '段界 flush 必须产生真实回执');
        assert.equal(receipt.outcome.status, 'written', '真实 sink 写入成功');
        assert.equal(receipt.outcome.topology.written, true);
        assert.deepEqual(receipt.from, segment.startStance, '回执起点=导航段实测起点');
        assert.deepEqual(receipt.to, segment.endStance, '回执终点=导航段实测终点');
        assert.equal(receipt.segmentCount, executed, '回执段数=导航确认段数');
        assert.equal(receipt.outcome.traversalIds.length, executed, '每条实测段各一条 traversal');

        // D-V4-034 缺口断言（不是永久契约）：navigate_to 当前不接线 memoryWrite，所以
        // 回执里没有该字段。owner 卡接线后应更新/删除此断言，而不是把“缺失”当规范。
        assert.equal(Object.hasOwn(result.data ?? {}, 'memoryWrite'), false,
          'D-V4-034 未接线：当前源码不伪造 navigation 段的 memoryWrite（接线后更新本断言）');
        receipts.push({ from: receipt.from, to: receipt.to, segmentCount: receipt.segmentCount, traversalCount: receipt.outcome.traversalIds.length });
        previousEnd = { ...segment.endStance! };
      }
      assert.equal(receipts.length, 2);
      assert.deepEqual(receipts[0]!.to, receipts[1]!.from, '段界回执首尾相接，不跳过实测 seam');
      assert.deepEqual(receipts.map((item) => item.segmentCount), [3, 3]);
      assert.deepEqual(receipts.map((item) => item.traversalCount), [3, 3]);
    } finally {
      ctx.memory.close();
    }
  });
});

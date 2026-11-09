/**
 * P25-D 证据闭环验收（D-V4-033）。
 *
 * 物理移动（BodySample）→ 实测 traversal → TraversalRecorder → 共享空间库 →
 * 合法观测 → VoxelMap → ChangeReport → 下一段规划。
 *
 * 全部用例驱动真实 `SharedSpatialSession`（真实 SQLite Worker）、真实
 * `RouteVerifier` 与真实 `WalkRouteExecutor`；只有身体 MoveExecutor 是夹具。
 * 全部是离线夹具结果，不声称真实服务器/物理运行。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RouteVerifier, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
import type { ChangeReport } from 'curio-minecraft-3d-memory';
import { TraversalRecorder, MAX_TRAVERSAL_RECEIPTS } from '../src/spatial/traversal-recorder.ts';
import type { WalkCorridorEvidence } from '../src/spatial/shared-session.ts';
import {
  BODY,
  DIM,
  FixtureClock,
  FixtureMoveExecutor,
  ROUTE_POINTS,
  SESSION_1,
  WORLD,
  blockObservation,
  bodySample,
  corridorObservations,
  routeRequest,
  withSharedSession,
} from './fixtures/spatial-w4-w5-w7.ts';

const at = (x: number, y: number, z: number) => ({ x, y, z });

function observedCell(report: ChangeReport, x: number, y: number, z: number) {
  return report.sections.some((section) => section.cells.some((cell) => (
    cell.pos.x === x && cell.pos.y === y && cell.pos.z === z
  )));
}

test('多段实测移动逐段有确认 traversal 与拓扑；新区块位移不是新覆盖，合法观测才写 VoxelMap', async () => {
  const clock = new FixtureClock(0);
  await withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    // 只观测 x=13..15（chunk 0 末尾）；x=16 起是未观测的 chunk 1。
    assert.ok(session.observe([13, 14, 15].flatMap((x) => [
      blockObservation(at(x, -1, 0), 'minecraft:stone', 0, 1 + x * 3),
      blockObservation(at(x, 0, 0), 'minecraft:air', 0, 1 + x * 3 + 1),
      blockObservation(at(x, 1, 0), 'minecraft:air', 0, 1 + x * 3 + 2),
    ])).sections.length > 0);

    const failures: string[] = [];
    const recorder = new TraversalRecorder(session, clock.now, (message) => failures.push(message));

    // 段 1：实测 14.5 → 15.5 → 16.5；16.5 已在 chunk 1，但没有任何合法观测。
    for (const [index, x] of [14.5, 15.5, 16.5].entries()) {
      clock.set(index + 1);
      recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(x, 0, 0.5) });
    }
    const first = recorder.flush(true);
    assert.equal(first?.outcome.status, 'written', '段 1 必须拿到真实写入回执');
    assert.equal(first?.segmentCount, 2);
    assert.equal(first?.outcome.traversalIds.length, 2);
    assert.equal(first?.outcome.topology.nodes, 3);
    assert.equal(first?.outcome.topology.edges, 2);
    assert.equal(first?.outcome.topology.written, true);

    // 物理移动进入新区块只留下 traversed 历史位，不是覆盖。
    const traversed = session.session.voxel.historyAt(DIM, 16, 0, 0);
    assert.equal(traversed.traversed, true, '实测站过的格必须留下 traversal 历史位');
    assert.equal(traversed.explored, false, '移动不等于观测');
    const newChunkCell = session.query({ kind: 'cells', dim: DIM, positions: [at(16, 0, 0)] });
    assert.equal(newChunkCell.status, 'ok');
    assert.ok(newChunkCell.data?.kind === 'cells');
    if (newChunkCell.data?.kind !== 'cells') assert.fail('expected cells query');
    assert.equal(newChunkCell.data.cells[0]!.observed, false, '新区块位移不得写成已观测');
    assert.equal(newChunkCell.data.cells[0]!.evidence, undefined, 'traversal 不生成方块证据');

    // 移动后的合法观测才写 VoxelMap，并同步产生 ChangeReport。
    clock.set(10);
    const observed = session.observe([blockObservation(at(16, 0, 0), 'minecraft:air', 10, 1000)]);
    assert.ok(observed.sections.length > 0);
    assert.equal(observedCell(observed, 16, 0, 0), true);
    const coveredCell = session.query({ kind: 'cells', dim: DIM, positions: [at(16, 0, 0)] });
    assert.ok(coveredCell.data?.kind === 'cells');
    if (coveredCell.data?.kind !== 'cells') assert.fail('expected cells query');
    assert.equal(coveredCell.data.cells[0]!.observed, true);
    assert.equal(coveredCell.data.cells[0]!.freshness, 'FRESH');
    // 同一新区块里没被看见的格仍是未知：覆盖按格，不按区块。
    const sameChunkUnknown = session.query({ kind: 'cells', dim: DIM, positions: [at(17, 0, 0)] });
    assert.ok(sameChunkUnknown.data?.kind === 'cells');
    if (sameChunkUnknown.data?.kind !== 'cells') assert.fail('expected cells query');
    assert.equal(sameChunkUnknown.data.cells[0]!.observed, false, '新观测不得顺带声称整块已覆盖');

    // 段 2：停走后的下一段以实测末点接上，仍逐段产生回执。
    for (const [index, x] of [17.5, 18.5].entries()) {
      clock.set(20 + index);
      recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(x, 0, 0.5) });
    }
    const second = recorder.flush(true);
    assert.equal(second?.outcome.status, 'written');
    assert.equal(second?.segmentCount, 2, '含 16.5→17.5 的 seam 段');
    assert.equal(second?.outcome.topology.nodes, 3);
    assert.ok(second!.outcome.traversalIds.length >= 2);
    // 17.5/18.5 从没被观测：走过也不等于覆盖。
    const laterCell = session.query({ kind: 'cells', dim: DIM, positions: [at(17, 0, 0), at(18, 0, 0)] });
    assert.ok(laterCell.data?.kind === 'cells');
    if (laterCell.data?.kind !== 'cells') assert.fail('expected cells query');
    assert.deepEqual(laterCell.data.cells.map((cell) => cell.observed), [false, false]);

    assert.equal(failures.length, 0);
    assert.equal(recorder.receipts().length, 2);
    assert.equal(recorder.receipts()[1]!.sequence, second!.sequence);

    // 库中确实有逐段 traversal 与拓扑。
    const traversals = session.query({ kind: 'traversals', dim: DIM });
    assert.ok(traversals.data?.kind === 'traversals');
    if (traversals.data?.kind !== 'traversals') assert.fail('expected traversals query');
    assert.equal(traversals.data.total, 4);
    assert.ok(traversals.data.items.every((item) => item.source === 'confirmed_traversal'));
    const nodes = session.query({ kind: 'nodes', dim: DIM });
    assert.ok(nodes.data?.kind === 'nodes');
    if (nodes.data?.kind !== 'nodes') assert.fail('expected nodes query');
    assert.ok(nodes.data.total >= 4, `拓扑节点必须由确认段派生（实际 ${nodes.data.total}）`);
    const edges = session.query({ kind: 'edges', dim: DIM });
    assert.ok(edges.data?.kind === 'edges');
    if (edges.data?.kind !== 'edges') assert.fail('expected edges query');
    assert.ok(edges.data.total >= 3);

    // pending checkpoint 不冒充 durable；checkpoint 后才确认。
    const pending = session.getPersistenceState();
    assert.equal(pending.dirty, true);
    assert.ok(pending.fragmentRevision > pending.confirmedFragmentRevision, 'fragment 写入仍是 pending');
    assert.ok(pending.topologyRevision > pending.confirmedTopologyRevision, '拓扑写入仍是 pending');
    await session.checkpoint();
    const confirmed = session.getPersistenceState();
    assert.equal(confirmed.dirty, false);
    assert.equal(confirmed.fragmentRevision, confirmed.confirmedFragmentRevision);
    assert.equal(confirmed.topologyRevision, confirmed.confirmedTopologyRevision);

    // 历史 traversal 不等于当前可通行。
    const history = session.query({
      kind: 'historyRoute', dim: DIM, from: at(14, 0, 0), to: at(18, 0, 0), near: 2,
    });
    assert.ok(history.data?.kind === 'historyRoute');
    if (history.data?.kind !== 'historyRoute') assert.fail('expected historyRoute query');
    assert.equal(history.data.inspection.historicalGeometry, true);
    assert.equal(history.data.inspection.executable, false, '历史路线从不是可执行授权');
    assert.equal(history.data.inspection.currentPassability, 'UNKNOWN');
  });
});

test('ChangeReport 在下一段规划前同步到达；失效即停且不写未执行的计划点', async () => {
  const clock = new FixtureClock(0);
  await withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    assert.ok(session.observe(corridorObservations(SESSION_1, 0, 1)).sections.length > 0);

    const verifier = new RouteVerifier(session.session.voxel, { now: clock.now });
    verifier.register(routeRequest());
    assert.equal(verifier.advance(8).verdict, 'OPEN');

    const body = new FixtureMoveExecutor(clock);
    const walk = new WalkRouteExecutor(session.session.voxel, body, { now: clock.now });
    const reports: ChangeReport[] = [];
    const token = session.attach({
      receiver: (report) => { reports.push(report); walk.observe(report, 8); },
      cancel: () => { walk.cancel('lifecycle', 'navigation-evidence-chain fixture cancelled'); },
    });

    const started = walk.start(routeRequest());
    walk.onSample(bodySample(started.delegationId, ROUTE_POINTS[0]!, 0, 1));
    assert.equal(walk.advance(8).activeStepIndex, 0);
    assert.equal(body.moves.length, 1);

    // 段 1 的实测移动（BodySample）→ traversal。
    const recorder = new TraversalRecorder(session, clock.now);
    recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: ROUTE_POINTS[0]! });
    clock.set(5);
    const measured = bodySample(started.delegationId, at(1.5, 0, 0.5), 5, 2);
    walk.onSample(measured);
    recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: measured.pos });
    const first = recorder.flush(true);
    assert.equal(first?.outcome.status, 'written');

    // 下一段规划前先收到真实 ChangeReport：支撑被合法观测为 air。
    clock.set(10);
    clock.tickFrame();
    const reportsBefore = reports.length;
    const support = blockObservation(at(1, -1, 0), 'minecraft:air', 10, 100);
    const report = session.observe([support]);
    assert.ok(report.sections.length > 0);
    assert.equal(reports.length, reportsBefore + 1, '报告必须在 observe 返回前同步派发');
    assert.equal(observedCell(reports.at(-1)!, 1, -1, 0), true);
    const move = body.moves[0]!;
    assert.equal(move.stopCount, 1, '当前段在报告生效的同一拍停止');

    const next = walk.advance(8);
    assert.equal(next.activeStepIndex, null);
    assert.notEqual(walk.status()!.result?.outcome, 'ARRIVED');
    assert.equal(body.moves.length, 1, '失效后不得启动下一段');
    assert.notEqual(walk.status()!.route.verdict, 'OPEN');

    // 没有执行过的计划点不得变成 traversal：只有实测 0.5→1.0 一段。
    assert.equal(recorder.receipts().length, 1);
    const traversals = session.query({ kind: 'traversals', dim: DIM });
    assert.ok(traversals.data?.kind === 'traversals');
    if (traversals.data?.kind !== 'traversals') assert.fail('expected traversals query');
    assert.equal(traversals.data.total, 1);
    assert.equal(traversals.data.items[0]!.to.x, 1, '只有实测落点被写成 traversal');
    assert.ok(traversals.data.items.every((item) => item.to.x !== ROUTE_POINTS[2]!.x), '计划终点不得冒充实测');

    session.detach(token);
  });
});

test('空间记忆写入失败如实回执；失败不回滚实测身体结果与合法观测', async () => {
  const clock = new FixtureClock(0);
  await withSharedSession(clock.now, async (session) => {
    session.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION_1 });
    assert.ok(session.observe(corridorObservations(SESSION_1, 0, 1)).sections.length > 0);

    const verifier = new RouteVerifier(session.session.voxel, { now: clock.now });
    verifier.register(routeRequest());
    assert.equal(verifier.advance(8).verdict, 'OPEN');

    const body = new FixtureMoveExecutor(clock);
    const walk = new WalkRouteExecutor(session.session.voxel, body, { now: clock.now });
    const reports: ChangeReport[] = [];
    const token = session.attach({
      receiver: (report) => { reports.push(report); walk.observe(report, 8); },
      cancel: () => { walk.cancel('lifecycle', 'navigation-evidence-chain failure fixture cancelled'); },
    });
    const started = walk.start(routeRequest());
    walk.onSample(bodySample(started.delegationId, BODY.feet, 0, 1));
    walk.advance(8);
    clock.set(5);
    const measured = bodySample(started.delegationId, at(1, 0, 0.5), 5, 2);
    walk.onSample(measured);
    const lastPosition = { ...walk.status()!.lastPosition! };
    assert.equal(lastPosition.x, 1);

    // 真实的 WalkMemoryOutcome 失败形状：sink 拒绝，身体与观测链路不受影响。
    const attempted: WalkCorridorEvidence[] = [];
    const failures: string[] = [];
    const failingSink = {
      recordWalkCorridor: (input: WalkCorridorEvidence) => {
        attempted.push(input);
        return {
          status: 'failed' as const,
          stage: 'capacity' as const,
          message: 'simulated capacity refusal',
          fragmentId: input.fragment.id,
          traversalIds: [] as string[],
          topology: { nodes: 0, edges: 0, written: false },
        };
      },
    };
    clock.set(6);
    const recorder = new TraversalRecorder(failingSink, clock.now, (message) => failures.push(message));
    recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(0.5, 0, 0.5) });
    clock.set(7);
    recorder.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(1.5, 0, 0.5) });
    const failed = recorder.flush();
    assert.equal(attempted.length, 1, '失败也必须有真实写入尝试');
    assert.equal(failed?.outcome.status, 'failed');
    assert.equal(failed?.outcome.stage, 'capacity');
    assert.deepEqual(failed?.outcome.traversalIds, [], '失败不得声称写入 traversal');
    assert.equal(failed?.outcome.topology.written, false);
    assert.equal(failures.length, 1);

    // 身体结果保持不变：不因记忆失败回滚/改写实测位置或终止当前段。
    assert.deepEqual(walk.status()!.lastPosition, lastPosition);
    assert.equal(walk.status()!.result, null);
    assert.equal(walk.status()!.activeStepIndex, 0);
    assert.equal(body.control.forward, true);

    // 合法观测仍写入并派发 ChangeReport（与记忆失败无关）。
    clock.set(10);
    const reportsBefore = reports.length;
    const observation = blockObservation(at(5, 0, 5), 'minecraft:air', 10, 200);
    const report = session.observe([observation]);
    assert.ok(report.sections.length > 0, '写入失败不得阻断合法观测');
    assert.equal(reports.length, reportsBefore + 1);
    const observed = session.query({ kind: 'cells', dim: DIM, positions: [at(5, 0, 5)] });
    assert.ok(observed.data?.kind === 'cells');
    if (observed.data?.kind !== 'cells') assert.fail('expected cells query');
    assert.equal(observed.data.cells[0]!.observed, true);

    // 下一次真实写入成功：失败不是永久状态。
    const retry = new TraversalRecorder(session, clock.now);
    retry.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(0.5, 0, 0.5) });
    clock.set(11);
    retry.observe({ worldId: WORLD, dim: DIM, sessionId: SESSION_1, pos: at(1.5, 0, 0.5) });
    const written = retry.flush();
    assert.equal(written?.outcome.status, 'written');
    assert.equal(written?.outcome.topology.written, true);
    assert.ok(retry.receipts().length <= MAX_TRAVERSAL_RECEIPTS);

    session.detach(token);
  });
});

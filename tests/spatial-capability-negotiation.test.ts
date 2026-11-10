/**
 * B1 能力协商验收（契约 §2.3/§13.1）：启动即读取库能力报告并记录契约版本；
 * `false` 是契约事实，宿主不得调用对应接口，也不得回退到更宽的旧后端。
 *
 * 用真实 SQLite 共享会话读取库自己的报告；再用受控替换的报告验证门禁拒绝
 * 时确实没有调用库写入（历史位保持未标记）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeCapabilities } from 'curio-minecraft-3d-memory';
import type { MemoryHostCapabilities, SpatialQueryResult } from 'curio-minecraft-3d-memory';
import {
  capabilityGate,
  capabilitySummary,
  readHostCapabilities,
} from '../src/spatial/capabilities.ts';
import type { HostCapabilityReport } from '../src/spatial/capabilities.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';

const WORLD = 'world-caps';
const DIM = 'overworld';

/** 受控能力报告：独立副本，不污染共享会话启动时记录的真实报告。 */
function forcedReport(library: MemoryHostCapabilities, overrides: Partial<{ [K in keyof MemoryHostCapabilities['memory']]: boolean }>): HostCapabilityReport {
  const libraryWithOverrides = { ...library, memory: { ...library.memory, ...overrides } };
  const composed = composeCapabilities(libraryWithOverrides);
  return {
    owner: 'host_composed', contract: library.contract,
    library: libraryWithOverrides,
    host: { checkpoint: true, flush: true, close: true },
    effective: composed.effective,
    overclaims: composed.overclaims,
  };
}

async function openShared(): Promise<{ svc: SharedSpatialSession; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-caps-'));
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db') });
  return { svc, dir };
}

async function closeShared(svc: SharedSpatialSession, dir: string): Promise<void> {
  const shutdown = await svc.shutdown();
  assert.equal(shutdown.close?.completed, true, '真实 close 必须完成');
  assert.equal(shutdown.close?.error, null);
  rmSync(dir, { recursive: true, force: true });
}

test('启动时读取并记录库能力报告与契约版本，宿主生命周期单独标注', async () => {
  const { svc, dir } = await openShared();
  try {
    const report = svc.capabilities();
    assert.equal(report.owner, 'host_composed');
    assert.equal(report.contract, 'memory-host-contract/1');
    // 库报告原样：生产组合只有 voxel + facts，观测写入可用，旧路线写入/查询不可用。
    assert.equal(report.library.memory.markTraversed, true);
    assert.equal(report.library.memory.markModified, true);
    assert.equal(report.library.memory.saveFragment, false);
    assert.equal(report.library.memory.addTraversal, false);
    assert.equal(report.library.query.nodes, true);
    assert.equal(report.library.query.fragments, false);
    assert.equal(report.library.query.historyRoute, false);
    // containerContents 恒为 false（宿主账本职责），不是可协商项。
    assert.equal(report.library.query.containerContents, false);
    // 持久化生命周期由共享会话拥有，不冒充库 memory 能力。
    assert.deepEqual(report.host, { checkpoint: true, flush: true, close: true });

    // 与直接查询同一份事实；启动只读取一次，不在运行中重新协商。
    const direct = svc.query({ kind: 'capabilities' });
    assert.equal(direct.status, 'ok');
    assert.deepEqual(report.library, direct.data?.kind === 'capabilities' ? direct.data.capabilities : null);
    assert.equal(svc.capabilities(), report, '报告在启动时记录一次，读取不产生新协商');

    const summary = capabilitySummary(report);
    assert.equal(summary.contract, 'memory-host-contract/1');
    assert.equal(summary.owner, 'host_composed');
    assert.deepEqual(summary.host, { checkpoint: true, flush: true, close: true });
    assert.ok(summary.library.query.includes('containerContents'), '摘要只列 false 键，保留容器内容边界');
    assert.ok(summary.library.memory.every((name) => name !== 'markTraversed'), '可用能力不进 false 摘要');
  } finally {
    await closeShared(svc, dir);
  }
});

test('能力门禁：false 时拒绝写入且不调用库，历史位保持未标记', async () => {
  const { svc, dir } = await openShared();
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: 's1' });

    // 模拟库把 markTraversed 报为 false（真实 store 不会返回它）；用独立副本，
    // 不污染启动时记录的真实报告。
    const forced = forcedReport(svc.capabilities().library, { markTraversed: false });
    const recorded = svc.capabilities();
    (svc as unknown as { capabilityReport: HostCapabilityReport }).capabilityReport = forced;

    assert.equal(capabilityGate(forced)('memory', 'markTraversed'), false);
    const result = svc.markTraversed(DIM, { x: 0, y: 64, z: 0 });
    assert.equal(result.status, 'rejected');
    if (result.status !== 'rejected') return;
    assert.equal(result.reason.kind, 'capability_unavailable');
    assert.deepEqual(svc.session.voxel.historyAt(DIM, 0, 64, 0), {
      explored: false, traversed: false, modified: false, risk: false, stale: false,
    }, '能力 false 时不得调用库写入（没有回退到更宽的后端）');

    // 旧的 `MemoryIngest` 投影已随路线写链退役：实例上不再有 ingest 入口，
    // 也就不存在绕过门禁继续写的第二条路径。
    assert.equal('ingest' in svc, false, '退役的 ingest 投影不应再出现在共享会话上');
    assert.equal(svc.session.voxel.historyAt(DIM, 1, 64, 0).traversed, false);
    // 结束前恢复原报告，避免影响 close 流程。
    (svc as unknown as { capabilityReport: HostCapabilityReport }).capabilityReport = recorded;
  } finally {
    await closeShared(svc, dir);
  }
});

test('markStale 能力 false：生命周期边界不调用库，返回值如实 rejected', async () => {
  const { svc, dir } = await openShared();
  try {
    svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: 's1' });
    const real = svc.session.voxel.markStale.bind(svc.session.voxel);
    let calls = 0;
    svc.session.voxel.markStale = (...args) => { calls += 1; return real(...args); };
    const recorded = svc.capabilities();
    (svc as unknown as { capabilityReport: HostCapabilityReport }).capabilityReport =
      forcedReport(recorded.library, { markStale: false });

    const result = svc.markStale(DIM, 'unloaded');
    assert.equal(result.status, 'rejected', '不得把未应用的 STALE 写成 written');
    if (result.status === 'rejected') assert.equal(result.reason.kind, 'capability_unavailable');
    assert.equal(svc.lastCapabilityRejection()?.kind, 'capability_unavailable');

    const before = calls;
    const interrupted = svc.interrupt();
    assert.deepEqual(interrupted.sections, []);
    assert.equal(calls, before, 'interrupt 不得在能力 false 时调用库 markStale');
    const paused = svc.setPaused(true);
    assert.deepEqual(paused.sections, []);
    assert.equal(calls, before, 'setPaused 同样不调用库');
    assert.equal(svc.lastCapabilityRejection()?.kind, 'capability_unavailable');

    (svc as unknown as { capabilityReport: HostCapabilityReport }).capabilityReport = recorded;
  } finally {
    await closeShared(svc, dir);
  }
});

test('读取失败或契约版本不符时拒绝启动，不把缺失当成全 false', () => {
  const unavailable = {
    query: (): SpatialQueryResult => ({
      status: 'unsupported', contract: 'memory-host-contract/1', worldId: WORLD,
      computedAt: 1, readOnly: true, executable: false,
      problem: { kind: 'unsupported', query: 'capabilities', detail: 'not implemented' },
    }),
  };
  assert.throws(() => readHostCapabilities(unavailable), /capabilities are unavailable/);

  const wrongContract = {
    query: (): SpatialQueryResult => ({
      status: 'ok', contract: 'memory-host-contract/1', worldId: WORLD,
      computedAt: 1, readOnly: true, executable: false,
      data: {
        kind: 'capabilities',
        capabilities: { contract: 'memory-host-contract/2' } as unknown as MemoryHostCapabilities,
      },
    }),
  };
  assert.throws(() => readHostCapabilities(wrongContract), /not memory-host-contract\/1/);
});

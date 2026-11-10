/**
 * B1 冷库缓存性能探针（非实机验收）。
 *
 * 真实 SQLite + 真实 manual `SharedSpatialSession` + 真实导航搜索/保存链路；
 * 身体用 FakeAdapter。覆盖：首次冷读 512 格、热缓存再次访问、中途 checkpoint
 * 后继续、跨冷区往返、相关体素变化后的重新规划。
 *
 * 只测量事实：每次调用的搜索次数、执行段数、工作集累计加载/命中/淘汰、加载
 * 字节与耗时、保存 ACK 延迟、停留字节、事件循环最大滞后和内存。数字写入
 * docs/v0.11.0-batch5-cache-benchmark.md；本文件不做脆弱的性能阈值断言。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { BlockObservation, Vec3Like } from '../src/adapter/types.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import type { Senses, SkillResult } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'cache-bench-world';
const DIM = 'overworld';
const SESSION = 'cache-bench-session';
const X_MAX = 512;

interface LegMetrics {
  name: string;
  calls: number;
  transitions: number;
  searches: number;
  stopReasons: string[];
  wallMs: number;
  loadSections: number;
  hitSections: number;
  evictedSections: number;
  loadBytes: number;
  loadMs: number;
  residentSections: number;
  residentBytes: number;
  maxEventLoopLagMs: number;
  lastSearch?: { nodesExpanded: number; edgesEvaluated: number; durationMs: number; maxSyncSliceMs: number };
  checkpointAckMs?: number;
  checkpointResidentAfter?: number;
  rejectionCounts: Record<string, number>;
  residencyFailures: string[];
  resultStatus: string;
}

function observationFor(adapter: FakeAdapter, pos: Vec3Like, id: number, observedAt: number): BlockObservation {
  const name = adapter.blockAt(pos);
  return {
    worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: id,
    observedAt, pos: { ...pos }, name, properties: {}, stateComplete: true, source: 'vision',
  };
}

/** 一条 x=-1..X_MAX+1 的走廊；支撑 y=63，身体 y=64/65。 */
async function seedCorridor(dbPath: string): Promise<void> {
  const session = await openSpatialSession({ databasePath: dbPath, worldId: WORLD });
  const adapter = new FakeAdapter();
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  const observedAt = Date.now() - 60_000;
  let id = 0;
  try {
    session.voxel.beginSession(SESSION);
    for (let x = -1; x <= X_MAX + 1; x++) {
      for (let z = -1; z <= 1; z++) {
        for (let y = 63; y <= 65; y++) {
          session.voxel.observe({
            worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt, sequence: ++id,
            source: 'vision', evidence: 'seen', stateComplete: true,
            state: { name: adapter.blockAt({ x, y, z }).replace(/^minecraft:/, ''), properties: {} },
            pos: { x, y, z },
          });
        }
      }
    }
    await session.checkpoint();
  } finally {
    await session.close();
  }
}

function fakeAdapter(): FakeAdapter {
  const adapter = new FakeAdapter();
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.onGround = true;
  adapter.speed = 100_000;
  return adapter;
}

function observeAhead(adapter: FakeAdapter, shared: SharedSpatialSession, nextId: () => number): Partial<Senses> {
  return {
    observeBlocks: (positions: Vec3Like[]): BlockObservation[] => {
      const now = Date.now();
      const blocks = positions.map((pos) => observationFor(adapter, pos, nextId(), now));
      shared.observe(blocks);
      return blocks;
    },
  };
}

async function viewAhead(
  adapter: FakeAdapter,
  shared: SharedSpatialSession,
  senses: Partial<Senses>,
  direction: 1 | -1,
): Promise<void> {
  const feetX = Math.floor(adapter.pos.x);
  const cells: Vec3Like[] = [];
  if (direction === 1) {
    for (let x = feetX - 1; x <= feetX + 40; x++) for (const y of [63, 64, 65]) cells.push({ x, y, z: 0 });
  } else {
    for (let x = feetX - 40; x <= feetX + 1; x++) for (const y of [63, 64, 65]) cells.push({ x, y, z: 0 });
  }
  const feet = { x: Math.floor(adapter.pos.x), y: Math.floor(adapter.pos.y), z: Math.floor(adapter.pos.z) };
  cells.push(feet, { ...feet, y: feet.y + 1 }, { ...feet, y: feet.y - 1 });
  senses.observeBlocks!(cells);
  // 生产 Perception 的 handoff 会让非驻留证据排队加载；这里同样结算，避免把
  // “测试没跑 handoff”误判为导航不能读取当前证据。
  await shared.drainObservations({ deadline: Date.now() + 10_000 });
}

async function navigateLeg(
  name: string,
  shared: SharedSpatialSession,
  adapter: FakeAdapter,
  target: Vec3Like,
  options: { checkpointAfterCalls?: number; maxCalls?: number } = {},
): Promise<LegMetrics> {
  let nextId = 1_000_000;
  const senses = observeAhead(adapter, shared, () => nextId++);
  const deadlineMs = 180_000;
  const ctx = { ...makeCtx(adapter, { deadlineMs, senses }), spatial: shared };
  const base = {
    to: target, allowed: ['walk', 'step'] as ('walk' | 'step')[],
    historical: true, maxSteps: 64, maxSegments: 1, maxTransitions: 1024,
    maxSearches: 32, maxObservations: 8, maxObservedCells: 512,
  };
  const before = shared.workingSetStats();
  const beforeCounters = { ...before.counters };
  let maxLag = 0;
  let previous = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - previous - 5);
    previous = now;
  }, 5);
  lagTimer.unref?.();

  let sessionId: string | undefined;
  let calls = 0;
  let transitions = 0;
  let searches = 0;
  let previousSearches = 0;
  let lastCumulative = 0;
  let result: SkillResult | null = null;
  let lastSearch: LegMetrics['lastSearch'];
  let checkpointAckMs: number | undefined;
  let checkpointResidentAfter: number | undefined;
  const stopReasons: string[] = [];
  const residencyFailures: string[] = [];
  let checkpointed = false;
  const started = performance.now();

  try {
    while (calls < (options.maxCalls ?? 64)) {
      calls += 1;
      await viewAhead(adapter, shared, senses, target.x < adapter.pos.x ? -1 : 1);
      const validated = navigateTo.validate({ ...base, ...(sessionId === undefined ? {} : { sessionId }) }, adapter);
      assert.ok(validated.ok, validated.ok ? '' : validated.error);
      result = await navigateTo.run(ctx, validated.args);
      const data = result.data as Record<string, unknown> | undefined;
      const counters = data?.counters as { searches?: number } | undefined;
      if (typeof counters?.searches === 'number') {
        searches += Math.max(0, counters.searches - previousSearches);
        previousSearches = counters.searches;
      }
      const stats = (data?.lastSearch as { stats?: LegMetrics['lastSearch'] } | undefined)?.stats;
      if (stats !== undefined) lastSearch = { ...stats };
      const cumulative = Number(data?.executed ?? 0);
      if (Number.isInteger(cumulative) && cumulative >= lastCumulative) {
        transitions += cumulative - lastCumulative;
        lastCumulative = cumulative;
      }
      const stop = (data?.stop as { reason?: string; detail?: string } | undefined)?.reason;
      if (stop !== undefined) stopReasons.push(stop);
      if (stop === 'RESIDENCY_NOT_READY' && residencyFailures.length < 3) {
        residencyFailures.push(String((data?.stop as { detail?: string } | undefined)?.detail ?? data?.lastSegment ?? ''));
      }
      // 只有“同一 session 累计预算”耗尽才是真实终态；单次调用 maxSteps 用尽仍可续接。
      const stopDetail = String((data?.stop as { detail?: string } | undefined)?.detail ?? '');
      if (stop === 'BUDGET_EXHAUSTED' && stopDetail.includes('累计')) break;

      if (!checkpointed && options.checkpointAfterCalls !== undefined && calls >= options.checkpointAfterCalls) {
        checkpointed = true;
        const ackStart = performance.now();
        await shared.checkpoint();
        checkpointAckMs = Math.round((performance.now() - ackStart) * 1000) / 1000;
        checkpointResidentAfter = shared.workingSetStats().residentSections;
        await shared.drainObservations({ deadline: Date.now() + 10_000 });
      }

      if (result.status === 'succeeded') break;
      const continuation = data?.continuation as { canContinue?: boolean; sessionId?: string } | undefined;
      if (continuation?.canContinue !== true || continuation.sessionId === undefined) break;
      sessionId = continuation.sessionId;
      if (result.status === 'cancelled') break;
    }
  } finally {
    clearInterval(lagTimer);
  }

  const after = shared.workingSetStats();
  const counters = after.counters;
  return {
    name,
    calls,
    transitions,
    searches,
    stopReasons,
    wallMs: Math.round(performance.now() - started),
    loadSections: counters.loadedSections - beforeCounters.loadedSections,
    hitSections: counters.alreadyResidentSections - beforeCounters.alreadyResidentSections,
    evictedSections: counters.evictedSections - beforeCounters.evictedSections,
    loadBytes: counters.loadBytes - beforeCounters.loadBytes,
    loadMs: counters.loadMs - beforeCounters.loadMs,
    residentSections: after.residentSections,
    residentBytes: after.residentBytes,
    maxEventLoopLagMs: Math.round(maxLag * 100) / 100,
    ...(lastSearch === undefined ? {} : { lastSearch }),
    ...(checkpointAckMs === undefined ? {} : { checkpointAckMs }),
    ...(checkpointResidentAfter === undefined ? {} : { checkpointResidentAfter }),
    rejectionCounts: { ...after.rejections },
    residencyFailures,
    resultStatus: result?.status ?? 'none',
  };
}

test('manual cold/warm 512-cell navigation and cache accounting', { timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-bench-'));
  const dbPath = join(dir, 'memory.db');
  let shared: SharedSpatialSession | null = null;
  try {
    await seedCorridor(dbPath);
    shared = await SharedSpatialSession.open({
      worldId: WORLD,
      databasePath: dbPath,
      voxelLoading: 'manual',
      voxelValidityWindowMs: 10_000,
      // 上限需容纳单段路线依赖；80 驻留 / 60 保存目标仍能让 512 格路线发生换出。
      residencyLimits: { maxResidentSections: 80 },
      timeoutMs: 5000,
    });
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    const adapter = fakeAdapter();

    const cold = await navigateLeg('cold-outbound', shared, adapter, { x: X_MAX, y: 64, z: 0 }, {
      checkpointAfterCalls: 3,
    });
    const warmReturn = await navigateLeg('warm-return', shared, adapter, { x: 0, y: 64, z: 0 });
    const coldAgain = await navigateLeg('cross-cold-outbound', shared, adapter, { x: X_MAX, y: 64, z: 0 });

    // 相关体素变化：把返回路径上的一格改成石头，重新规划并观察搜索/加载成本。
    const changed = { x: X_MAX - 4, y: 64, z: 0 };
    adapter.blocks.push({ name: 'stone', pos: { ...changed } });
    shared.observe([observationFor(adapter, changed, 9_000_000, Date.now())]);
    const replan = await navigateLeg('after-voxel-change', shared, adapter, { x: X_MAX - 8, y: 64, z: 0 }, {
      maxCalls: 8,
    });

    const summary = {
      finalX: Math.floor(adapter.pos.x),
      legs: [cold, warmReturn, coldAgain, replan],
      memory: process.memoryUsage(),
    };
    console.log(`CACHE_BENCH ${JSON.stringify(summary)}`);
    assert.equal(cold.resultStatus, 'succeeded', `冷读 512 格应到达：${cold.stopReasons.join(',')}`);
    assert.ok(cold.transitions >= 500, `冷读应执行几乎整段：${cold.transitions}`);
    assert.ok(cold.loadSections > 0, '冷读必须真实加载已保存页面');
    assert.ok(warmReturn.hitSections > 0 || coldAgain.hitSections > 0, '再次访问应命中已有驻留页面');
  } finally {
    await shared?.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

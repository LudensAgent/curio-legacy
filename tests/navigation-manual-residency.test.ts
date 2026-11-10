/**
 * B7：manual 驻留下的导航加载与执行期保护。
 *
 * 真实 `SharedSpatialSession` + `FakeAdapter`。保存后 `checkpoint()` 会换出全部
 * 未 pin 的冷页；导航必须先按库报告的 unavailableSections 加载、并在执行期间
 * 持有 lease，才能跨保存继续复验。这里也固定“pinned 页面不被保存后换出”的
 * 契约，防止把导航正确性建立在“页面碰巧还在内存”上。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { acquireRouteResidency, releaseRouteResidency } from '../src/spatial/skill-residency.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { searchLandRouteAsync } from '../src/spatial/land-search.ts';
import { cellGoal } from '../src/skills/movement/goal.ts';
import { walkLandRules } from '../src/adapter/land-rules.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'manual-nav-world';
const DIM = 'overworld';
const SESSION = 'manual-nav-session';
const START_KEY = { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 4 };

function observation(x: number, y: number, z: number, name: string, id: number, observedAt: number): BlockObservation {
  return {
    worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: id,
    observedAt, pos: { x, y, z }, name, properties: {}, stateComplete: true, source: 'vision',
  };
}

/** 一条 x=0..xMax 的新鲜平坦走廊：支撑 y=63，身体 y=64/65。 */
function corridor(xMax: number, observedAt: number): BlockObservation[] {
  let id = 0;
  return Array.from({ length: xMax + 1 }, (_, x) => [
    observation(x, 63, 0, 'minecraft:grass_block', ++id, observedAt),
    observation(x, 64, 0, 'minecraft:air', ++id, observedAt),
    observation(x, 65, 0, 'minecraft:air', ++id, observedAt),
  ]).flat();
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

async function withManualSession(
  run: (shared: SharedSpatialSession, adapter: FakeAdapter, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'manual-nav-'));
  const shared = await SharedSpatialSession.open({
    worldId: WORLD,
    databasePath: join(dir, 'memory.db'),
    voxelLoading: 'manual',
    timeoutMs: 5000,
  });
  try {
    await run(shared, fakeAdapter(), dir);
  } finally {
    const shutdown = await shared.shutdown();
    const clean = shutdown.error === null
      && shutdown.close !== null
      && shutdown.close.completed
      && shutdown.close.error === null
      && !shutdown.close.unconfirmedRequest;
    if (clean) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('manual 导航在保存后换出的地图上加载页面并找到历史候选；下一步重新加载', { timeout: 60_000 }, async () => {
  await withManualSession(async (shared, adapter) => {
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    shared.observe(corridor(32, Date.now()));
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0);
    await shared.checkpoint();
    // 保存后按容量目标保留热页；这里显式换出起点页，验证导航能从冷页重新加载，
    // 而不是依赖“保存恰好把页面清空”的旧行为。
    shared.session.unloadSections([START_KEY]);
    assert.equal(shared.session.sectionResidency(START_KEY).residency, 'not_resident', '起点页应已换出');

    const ctx = { ...makeCtx(adapter, { deadlineMs: 55_000 }), spatial: shared };
    const base = {
      to: { x: 32, y: 64, z: 0 }, allowed: ['walk'] as ('walk' | 'step' | 'drop' | 'ladder')[],
      historical: true, maxSteps: 16, maxSegments: 1, maxTransitions: 128,
      maxSearches: 32, maxObservations: 2, maxObservedCells: 64,
    };
    const run = async (sessionId?: string) => {
      const validated = navigateTo.validate({ ...base, ...(sessionId === undefined ? {} : { sessionId }) }, adapter);
      assert.ok(validated.ok, validated.ok ? '' : validated.error);
      const result = await navigateTo.run(ctx, validated.args);
      const data = result.data as Record<string, unknown> | undefined;
      return {
        result,
        planned: Number(data?.plannedTransitions ?? 0),
        evidenceMode: data?.evidenceMode,
        stop: (data?.stop as { reason?: string } | undefined)?.reason,
        continuation: data?.continuation as { canContinue?: boolean; sessionId?: string } | undefined,
      };
    };

    // 起点页已换出。导航按需加载，重新加载的页是 STALE；到达仍需当前观察。
    // 再独立查询同一批已加载页面，以确认保存的几何仍能提供历史候选。
    const first = await run();
    assert.notEqual(first.stop, 'NO_PATH', `未驻留页面被当成无路：${first.result.summary}`);
    assert.equal(first.stop, 'UNKNOWN_BOUNDARY');
    assert.equal(first.planned, 0, '旧起点先补当前证据，不能先移动');
    assert.equal(first.evidenceMode, 'current');
    assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 });
    assert.equal(shared.session.sectionResidency(START_KEY).residency, 'resident', '导航应已加载所需页面');
    assert.equal(shared.workingSetStats().pinnedLeases, 0, '本段结束后不得遗留 pin lease');
    const remembered = await searchLandRouteAsync(shared.session.voxel, {
      worldId: WORLD, dim: DIM, sessionId: SESSION,
      body: { feet: adapter.pos, width: 0.6, height: 1.8, pose: 'standing' },
      goal: cellGoal(base.to, base.to.y, base.to), allowed: ['walk'], rules: walkLandRules,
      evidenceMode: 'remembered', maxDrop: 4,
    });
    assert.equal(remembered.status, 'FOUND', '已加载页面仍提供历史候选');
    assert.equal(remembered.transitions.length, 32);
    assert.equal(first.continuation?.canContinue, true, `导航应可续接：${first.result.summary}`);
    assert.ok(first.continuation?.sessionId !== undefined);

    // 第二份委托前真实保存并显式换出；导航必须重新加载，而不是复用已不驻留的页面。
    await shared.checkpoint();
    shared.session.unloadSections([START_KEY]);
    assert.equal(shared.session.sectionResidency(START_KEY).residency, 'not_resident');
    const second = await run(first.continuation.sessionId);
    assert.notEqual(second.stop, 'NO_PATH', `换出后再次把未驻留当成无路：${second.result.summary}`);
    assert.equal(second.stop, 'UNKNOWN_BOUNDARY');
    assert.equal(second.planned, 0);
    assert.deepEqual(adapter.pos, { x: 0.5, y: 64, z: 0.5 });
    assert.equal(shared.session.sectionResidency(START_KEY).residency, 'resident', '第二次委托应重新加载所需页面');
    assert.equal(shared.workingSetStats().pinnedLeases, 0);
  });
});

test('pinned 页面不被换出，释放后才能淘汰', { timeout: 30_000 }, async () => {
  await withManualSession(async (shared) => {
    shared.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    shared.observe(corridor(4, Date.now()));
    const drained = await shared.drainObservations({ deadline: Date.now() + 5000 });
    assert.equal(drained.pending.observations, 0);
    await shared.checkpoint();
    // 保存后按容量目标可能保留热页；显式换出以验证按需加载路径。
    shared.session.unloadSections([START_KEY]);
    assert.equal(shared.session.sectionResidency(START_KEY).residency, 'not_resident');

    const residency = await acquireRouteResidency(shared, [START_KEY], { deadline: Date.now() + 5000 });
    assert.equal(residency.status, 'ready');
    if (residency.status !== 'ready') assert.fail('已保存 Section 应能按需加载');
    try {
      await shared.checkpoint();
      const protectedUnload = shared.session.unloadSections([START_KEY]);
      assert.deepEqual(protectedUnload.unloaded, [], 'pinned 页面不能被换出');
      assert.equal(protectedUnload.rejected[0]?.reason, 'pinned');
      assert.equal(shared.session.sectionResidency(START_KEY).residency, 'resident');
    } finally {
      releaseRouteResidency(shared, residency);
    }
    const released = shared.session.unloadSections([START_KEY]);
    assert.equal(released.unloaded.length, 1, '释放后才能淘汰');
    assert.equal(shared.session.sectionResidency(START_KEY).residency, 'not_resident');
  });
});

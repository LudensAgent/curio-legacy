/**
 * 第四批宿主侧：资源来源格版本链路与 places 分页接线。
 *
 * 版本来自共享体素图的实际 CellEvidence.revision；缺失时是显式缺口，不用
 * Date.now/0 填充。同版本的新观察也能刷新时间；替换/移除仍走撤销。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContainerLedger } from '../src/memory/container-ledger.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { SpatialSemanticStore } from '../src/spatial/semantic-store.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import type { SkillCtx, SkillResult } from '../src/skills/types.ts';
import { VoxelMap, type PlaceFact } from 'curio-minecraft-3d-memory';
import { EventBus } from '../src/events.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { BlockObservation } from '../src/adapter/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { semanticMemory } from './semantic-fixture.ts';

const D = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });

function assertCleanClose(result: ShutdownResult): void {
  assert.ok(result.close !== null);
  assert.equal(result.close.completed, true);
  assert.equal(result.close.error, null);
  assert.equal(result.close.unconfirmedRequest, false);
}

function ctxFor(spatial: SharedSpatialSession): SkillCtx {
  return {
    get adapter(): never { throw new Error('spatial_query must not touch ctx.adapter'); },
    get senses(): never { throw new Error('spatial_query must not touch ctx.senses'); },
    get memory(): never { throw new Error('spatial_query must not touch ctx.memory'); },
    get bus(): never { throw new Error('spatial_query must not touch ctx.bus'); },
    spatial,
    signal: new AbortController().signal,
    deadline: Date.now() + 3000,
    taskId: 'resource-source-version-test',
    progress(): never { throw new Error('spatial_query must not report progress'); },
  } as unknown as SkillCtx;
}

function rec(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function items(result: SkillResult): Record<string, unknown>[] {
  const data = rec(rec(result.data).data);
  assert.ok(Array.isArray(data.items));
  return data.items.map((item) => rec(item));
}

test('同格同资源允许同版本的新时间，拒绝旧版本、旧时间与缺失时间', () => {
  const { memory, stores } = semanticMemory('source-version-updates');
  const pos = at(4, 40, 4);
  memory.addLandmark('resource', 'iron_ore', D, pos, 1, {
    sourceCellVersion: 7,
    observedAt: 1_000,
  });
  const id = memory.landmarks().find((landmark) => landmark.kind === 'resource')!.id;
  assert.equal(stores.facts.resources().items[0]?.sourceCellVersion, 7);

  // Same state keeps its cell version, but the new sighting time is real.
  memory.addLandmark('resource', 'iron_ore', D, pos, 1, {
    sourceCellVersion: 7,
    observedAt: 2_000,
  });
  assert.equal(stores.facts.resources().items[0]?.observedAt, 2_000);
  assert.equal(stores.facts.resources().items.length, 1);

  // Older version: ignore even with a later wall-clock observation.
  memory.addLandmark('resource', 'iron_ore', D, pos, 1, {
    sourceCellVersion: 5,
    observedAt: 3_000,
  });
  assert.equal(stores.facts.resources().items[0]?.sourceCellVersion, 7);
  assert.equal(stores.facts.resources().items[0]?.observedAt, 2_000);

  // Newer version: update version and real observation time; the near index follows.
  memory.addLandmark('resource', 'iron_ore', D, pos, 1, {
    sourceCellVersion: 9,
    observedAt: 4_000,
  });
  assert.equal(stores.facts.resources().items[0]?.sourceCellVersion, 9);
  assert.equal(stores.facts.resources().items[0]?.observedAt, 4_000);
  assert.equal(memory.resourceLandmarksAround(D, pos, 2)[0]?.ts, 4_000);

  // The explicit refresh entry applies the same rule and rejects a gap (no version).
  assert.equal(memory.refreshResourceSource(id, { sourceCellVersion: 9 }), null);
  memory.refreshResourceSource(id, { sourceCellVersion: 11, observedAt: 5_000 });
  assert.equal(stores.facts.resources().items[0]?.sourceCellVersion, 11);
  assert.equal(memory.refreshResourceSource(id, { sourceCellVersion: 12, observedAt: 4_999 }), null);
  assert.equal(memory.refreshResourceSource(id, { sourceCellVersion: 12 }), null);
  assert.equal(stores.facts.resources().items[0]?.sourceCellVersion, 11);
  assert.equal(stores.facts.resources().items[0]?.observedAt, 5_000, '不能用当前时间替换缺失或旧的观察时间');
});

test('真实体素同格刷新保持版本，邻格聚类不能把来源版本写到原锚点', () => {
  const worldId = 'resource-real-voxel';
  const { memory, stores } = semanticMemory(worldId);
  const voxel = new VoxelMap(worldId);
  voxel.beginSession('s1');
  const observe = (pos: { x: number; y: number; z: number }, observedAt: number, name = 'iron_ore') => {
    voxel.observe({ worldId, dim: D, sessionId: 's1', observedAt, sequence: observedAt,
      source: 'vision', evidence: 'seen', stateComplete: true, pos,
      state: { name, properties: {} } });
    const cell = voxel.cellAt(D, pos.x, pos.y, pos.z);
    assert.ok(cell.observed);
    return { sourceCellVersion: cell.evidence.revision, observedAt: cell.evidence.observation.observedAt };
  };
  const a = at(4, 40, 4), b = at(5, 40, 4);
  const first = observe(a, 1_000);
  memory.addLandmark('resource', 'iron_ore', D, a, 24, first);
  const refreshed = observe(a, 2_000);
  assert.equal(refreshed.sourceCellVersion, first.sourceCellVersion, '同状态观察不会改变 CellEvidence.revision');
  memory.addLandmark('resource', 'iron_ore', D, a, 24, refreshed);
  const saved = stores.facts.resources().items[0]!;
  assert.equal(saved.observedAt, 2_000);
  observe(b, 2_500, 'stone');
  const neighbor = observe(b, 3_000);
  assert.ok(neighbor.sourceCellVersion > first.sourceCellVersion);
  memory.addLandmark('resource', 'iron_ore', D, b, 24, neighbor);
  assert.deepEqual(stores.facts.resources().items, [saved], '24格聚类保留A，B的版本/时间不能污染A');
  memory.addLandmark('resource', 'iron_ore', D, b, 24);
  assert.deepEqual(stores.facts.resources().items, [saved], '无版本旧调用同样不能刷新邻格');
});

test('资源证据只关联已接受的同名、同时间、同作用域体素；暴露邻面保留缺口', (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const adapter = new FakeAdapter();
  const pos = at(3, 64, 0);
  adapter.blocks.push({ name: 'iron_ore', pos });
  const { memory } = semanticMemory(adapter.worldId);
  const voxel = new VoxelMap(adapter.worldId, { now: () => now, validityWindowMs: 1000 });
  voxel.beginSession(adapter.sessionId);
  const spatial = { session: { voxel } } as SharedSpatialSession;
  const vision = new Vision(adapter);
  const perception = new Perception(adapter, memory, new EventBus(), vision, spatial);
  const observed: BlockObservation = { worldId: adapter.worldId, dimension: D, sessionId: adapter.sessionId,
    observationId: 1, observedAt: now, source: 'vision', name: 'iron_ore', properties: {}, pos };
  const accept = (value: BlockObservation) => voxel.observe({ worldId: value.worldId, dim: value.dimension,
    sessionId: value.sessionId, observedAt: value.observedAt, sequence: value.observationId,
    source: 'vision', evidence: 'seen', stateComplete: true, pos: value.pos,
    state: { name: value.name, properties: {} } });
  accept(observed);
  assert.ok(perception['resourceEvidence'](observed).sourceCellVersion !== undefined);
  now += 2000;
  const current = { ...observed, observedAt: now, observationId: 2 };
  assert.equal(perception['resourceEvidence'](current).sourceCellVersion, undefined, '过期缓存不是本次尚未应用的观察');
  assert.equal(perception['resourceEvidence'](current).observedAt, now, '缺版本仍保留实际所见时间');
  assert.equal(perception['resourceEvidence']({ ...observed, name: 'diamond_ore' }).sourceCellVersion, undefined);
  assert.equal(perception['resourceEvidence']({ ...observed, sessionId: 'another-session' }).sourceCellVersion, undefined);
  assert.equal(perception['resourceEvidence']({ ...observed, worldId: 'another-world' }).sourceCellVersion, undefined);
  assert.equal(perception['resourceEvidence']({ ...observed, dimension: 'the_nether' }).sourceCellVersion, undefined);
  accept(current);
  assert.ok(perception['resourceEvidence'](current).sourceCellVersion !== undefined);
  now += 1;
  assert.equal(vision.expose(pos), 'iron_ore');
  const exposed = vision.seenEvidence(pos);
  assert.ok(exposed !== null);
  assert.equal(exposed.observedAt, now);
  const evidence = perception['resourceEvidence'](exposed);
  assert.equal(evidence.sourceCellVersion, undefined, 'expose没有同步写入体素时不能借用上一条已接受证据');
  memory.addLandmark('resource', exposed.name, D, pos, 24, evidence);
  assert.equal(memory.resourceIndexStatus().withoutSourceVersion, 1);
  assert.equal(memory.landmarks()[0]?.ts, now);
  now += 3001;
  assert.equal(vision.seenEvidence(pos), null, '读取不会把旧视野时间刷新');
  vision.expose(pos);
  adapter.sessionId = 'next-session';
  assert.equal(vision.seenEvidence(pos), null, '换会话后不提供旧视野的证据');
});

test('替换/确认移除立即撤销默认视图与近邻索引，历史仍可按 includeGone 读取', () => {
  const { memory, stores } = semanticMemory('source-version-gone');
  const pos = at(8, 40, 8);
  memory.addLandmark('resource', 'iron_ore', D, pos, 1, { sourceCellVersion: 7 });
  memory.markGone('iron_ore', D, pos, 'stone');

  assert.equal(memory.landmarks().some((landmark) => landmark.label === 'iron_ore'), false);
  assert.equal(memory.resourceLandmarksAround(D, pos, 2).length, 0);
  assert.equal(stores.facts.resources().items.length, 0);
  const history = stores.facts.resources({ includeGone: true }).items[0];
  assert.equal(history?.revoked, true);
  assert.equal(history?.sourceCellVersion, 7, '撤销保留来源格版本，不改写历史');
});

test('resourceIndexStatus 明确报告缺少来源格版本的缺口', () => {
  const { memory } = semanticMemory('source-version-gap');
  memory.addLandmark('resource', 'iron_ore', D, at(0, 40, 0), 1, { sourceCellVersion: 7 });
  memory.addLandmark('resource', 'coal_ore', D, at(2, 40, 0), 1);
  const status = memory.resourceIndexStatus();
  assert.equal(status.resourceAnchors, 2);
  assert.equal(status.withSourceVersion, 1);
  assert.equal(status.withoutSourceVersion, 1);
  assert.equal(status.complete, false);
});

test('真实 SharedSpatialSession 保存/重开保留版本，迟到 ACK 不清除更新后的 anchor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resource-source-version-'));
  const dbs = join(dir, 'memory.db');
  const worldId = 'source-version-persist';
  const pos = at(1, 40, 1);
  let svc = await SharedSpatialSession.open({
    worldId,
    databasePath: dbs,
    voxelLoading: 'manual',
    timeoutMs: 5000,
  });
  try {
    svc.beginSession({ worldId, dim: D, sessionId: 's1' });
    const semantic = new SpatialSemanticStore(
      { facts: svc.session.facts, ledger: svc.session.ledger },
      new ContainerLedger(null, worldId),
      { worldId },
    );
    const observe = (observedAt: number) => {
      svc.session.voxel.observe({ worldId, dim: D, sessionId: 's1', observedAt, sequence: observedAt,
        source: 'vision', evidence: 'seen', stateComplete: true, pos,
        state: { name: 'iron_ore', properties: { test: String(observedAt) } } });
      const cell = svc.session.voxel.cellAt(D, pos.x, pos.y, pos.z);
      assert.ok(cell.observed);
      return { sourceCellVersion: cell.evidence.revision, observedAt: cell.evidence.observation.observedAt };
    };
    const landmark = semantic.addLandmark('resource', 'iron_ore', D, pos, 1, observe(1_000));
    assert.ok(landmark !== null);
    await svc.checkpoint();
    const confirmed = svc.session.facts.confirmedRevision;

    // A newer same-cell observation after the save; a delayed ACK must not roll it back.
    const updated = observe(2_000);
    semantic.refreshResourceSource(landmark.id, updated);
    svc.session.facts.confirmRevision(confirmed);
    assert.equal(svc.session.facts.resources().items[0]?.sourceCellVersion, updated.sourceCellVersion);
    assert.equal(svc.session.facts.resources().items[0]?.observedAt, 2_000);
    await svc.checkpoint();

    // An uncommitted revocation must already win over the saved page: the index
    // and the default query stop returning it before the next save.
    semantic.markGone('iron_ore', D, pos, 'stone');
    assert.equal(svc.session.facts.resources().items.length, 0);
    assert.equal(semantic.resourceLandmarksAround(D, pos, 2).length, 0);
    assert.equal(svc.session.facts.resources({ includeGone: true }).items[0]?.revoked, true);
    await svc.checkpoint();

    const shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    svc = await SharedSpatialSession.open({
      worldId,
      databasePath: dbs,
      voxelLoading: 'manual',
      timeoutMs: 5000,
    });
    const reopened = new SpatialSemanticStore(
      { facts: svc.session.facts, ledger: svc.session.ledger },
      new ContainerLedger(null, worldId),
      { worldId },
    );
    const restored = reopened.stores.facts.resources({ worldId, includeGone: true }).items[0];
    assert.equal(restored?.sourceCellVersion, updated.sourceCellVersion);
    assert.equal(restored?.observedAt, 2_000);
    assert.equal(restored?.revoked, true);
    const second = await svc.shutdown();
    assertCleanClose(second);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } finally {
    if (svc.session.lifecycle === 'open') await svc.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('spatial_query places：三页翻页、过滤与 total，pageSource 标明内存事实', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'places-query-'));
  const worldId = 'places-query-world';
  const svc = await SharedSpatialSession.open({
    worldId,
    databasePath: join(dir, 'memory.db'),
    timeoutMs: 5000,
  });
  try {
    svc.beginSession({ worldId, dim: D, sessionId: 's1' });
    const place = (id: string, label: string, kind: 'base' | 'place', source: 'agent' | 'program'): PlaceFact => ({
      id,
      kind,
      label,
      worldId,
      dim: D,
      location: { kind: 'exact', pos: at(0, 64, 0) },
      observedAt: 1_000,
      source: { source },
      gone: false,
    });
    for (const fact of [
      place('p1', 'home', 'base', 'agent'),
      place('p2', 'mine', 'base', 'program'),
      place('p3', 'home', 'place', 'program'),
      place('p4', 'home', 'place', 'agent'),
      place('p5', 'field', 'place', 'program'),
    ]) svc.session.facts.upsertPlace(fact);

    const collected: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const result = await spatialQuery.run(ctxFor(svc), {
        kind: 'places', dim: D, limit: 2, ...(after === undefined ? {} : { after }),
      });
      assert.equal(result.status, 'succeeded', result.summary);
      const envelope = rec(result.data);
      assert.equal(envelope.status, 'ok');
      assert.equal(envelope.total, 5);
      assert.equal(rec(envelope.data).pageSource, 'memory');
      collected.push(...items(result).map((item) => String(item.id)));
      after = typeof envelope.nextAfter === 'string' ? envelope.nextAfter : undefined;
      pages += 1;
    } while (after !== undefined);
    assert.equal(pages, 3);
    assert.deepEqual(collected, ['p1', 'p2', 'p3', 'p4', 'p5']);

    const bases = await spatialQuery.run(ctxFor(svc), { kind: 'places', tag: 'base' });
    assert.equal(rec(bases.data).total, 2);
    assert.deepEqual(items(bases).map((item) => item.id), ['p1', 'p2']);

    const homeAgent = await spatialQuery.run(ctxFor(svc), { kind: 'places', label: 'home', source: 'agent' });
    assert.equal(rec(homeAgent.data).total, 2);
    assert.deepEqual(items(homeAgent).map((item) => item.id), ['p1', 'p4']);
  } finally {
    const shutdown = await svc.shutdown();
    assertCleanClose(shutdown);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

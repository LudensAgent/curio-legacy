/**
 * V4-UG-02：历史 dug 路线查询 → 当前证据复验 → 按所选端点执行 → 阻挡停下 →
 * 显式 mine_cell 清障 → 重新观察/规划继续。全部走现有库 `historyRoute`、
 * `land-search`、`move_step/descend_to` 与 `mine_cell`，不新增平行记忆或自动施工。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { clearRouteRecords, mineCell, navigateTo, planRoute } from '../src/skills/movement/index.ts';
import { SKILLS } from '../src/skills/index.ts';
import { runSkill, validateSkill } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
const at = (x: number, y: number, z: number) => ({ x, y, z });
let sequence = 0;

function observe(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[]) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
}

/** 历史通道：x=0..5、脚高 64、两格净空；全部证据先标 STALE，逼出历史候选。 */
function staleCorridor() {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  for (let x = -1; x <= 6; x++) observe(map, 'minecraft:air', [at(x, 64, 0), at(x, 65, 0)]);
  observe(map, 'minecraft:stone', Array.from({ length: 8 }, (_, index) => at(index - 1, 63, 0)));
  map.markStale(DIM, 'expired');
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    // 显式 mine_cell 的写入归属在这里不是被测对象；只提供最小成功回执，不写第二套记忆。
    markModified: () => ({ status: 'written' as const, report: { sections: [] }, deliveryError: null }),
    capabilities: () => ({
      owner: 'host_composed',
      contract: 'memory-host-contract/1',
      library: { execute: { walk: true } },
      host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}

function setup(map: VoxelMap, pos = at(0.5, 64, 0.5)) {
  const adapter = new FakeAdapter();
  adapter.pos = { ...pos };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  return { adapter, ctx };
}

const runSteps = async (ctx: ReturnType<typeof setup>['ctx'], steps: { xyz: [number, number, number] }[]) => {
  for (const step of steps) {
    // 这是 Agent 显式清障：接受侧后方未知邻格的风险属于委托本身，测试里显式声明。
    const validated = validateSkill(mineCell, { xyz: step.xyz, facing: 'E', allowUnknownAdjacent: true }, ctx.adapter);
    assert.equal(validated.ok, true, JSON.stringify(validated));
    const result = await runSkill(ctx, mineCell, validated.args);
    assert.equal(result.status, 'succeeded', result.summary);
  }
};

test('真实共享库 historyRoute 提供历史 dug 几何；plan_route memory 保持 UNKNOWN 且多格 leg 不是一步 move_step', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'history-route-reuse-'));
  const svc = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db'), timeoutMs: 5000 });
  t.after(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  const p0 = at(0.5, 64, 0.5), p5 = at(5.5, 64, 0.5), p6 = at(6.5, 64, 0.5);
  svc.session.history.saveFragment({
    id: 'f-dug', worldId: WORLD, dim: DIM, kind: 'dug', geometrySource: 'traversal',
    polyline: [p0, p6], entrances: [], deepestY: 64, createdAt: 1000, lastUsedAt: 2000, uses: 1,
  });
  svc.session.history.addTraversal({
    id: 't-long', fragmentId: 'f-dug', from: p0, to: p5, worldId: WORLD, dim: DIM,
    sessionId: SESSION, observedAt: 1000, source: 'confirmed_walk', mode: 'walk',
  });
  svc.session.history.addTraversal({
    id: 't-short', fragmentId: 'f-dug', from: p5, to: p6, worldId: WORLD, dim: DIM,
    sessionId: SESSION, observedAt: 1000, source: 'confirmed_walk', mode: 'walk',
  });
  svc.session.topology.saveNode({ id: 'n0', kind: 'place', source: 'agent', tag: 'base', label: 'entry', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: p0 } });
  svc.session.topology.saveNode({ id: 'n1', kind: 'place', source: 'agent', tag: 'base', label: 'mid', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: p5 } });
  svc.session.topology.saveNode({ id: 'n2', kind: 'place', source: 'agent', tag: 'resource', label: 'deep', worldId: WORLD, dim: DIM, location: { kind: 'exact', pos: p6 } });
  svc.session.topology.saveEdge({ id: 'e0', from: 'n0', to: 'n1', type: 'CAVE_PASSAGE', basis: 'traversed', fragmentId: 'f-dug', evidenceIds: ['t-long'] });
  svc.session.topology.saveEdge({ id: 'e1', from: 'n1', to: 'n2', type: 'HORIZONTAL', basis: 'traversed', fragmentId: 'f-dug', evidenceIds: ['t-short'] });

  const adapter = new FakeAdapter();
  adapter.pos = { ...p0 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  const ctx = { ...makeCtx(adapter), spatial: svc };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const r = await planRoute.run(ctx, { to: at(6, 64, 0), mode: 'walk', source: 'memory', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'memory');
  assert.equal(r.data?.executable, false);
  assert.equal(r.data?.currentPassability, 'UNKNOWN');
  assert.equal(r.data?.historicalGeometry, true);
  assert.equal(r.data?.routeId, undefined);

  const legs = r.data?.legs as {
    transition: string; maxSpan: number; oneCellHop: boolean;
    executable: boolean; currentPassability: string; historicalGeometry: boolean;
  }[];
  assert.deepEqual(legs.map((leg) => leg.transition), ['walk', 'walk']);
  assert.equal(legs[0]!.maxSpan, 5, '长 leg 跨 5 格');
  assert.equal(legs[0]!.oneCellHop, false, '多格历史 leg 不能被当成一步');
  assert.equal(legs[0]!.executable, false);
  assert.equal(legs[0]!.currentPassability, 'UNKNOWN');
  assert.equal(legs[0]!.historicalGeometry, true);
  assert.equal(legs[1]!.maxSpan, 1);
  assert.equal(legs[1]!.oneCellHop, true);
  assert.deepEqual(r.data?.selectedEndpoint, p6, '端点就是选定的历史末尾');
  assert.match(r.summary, /跨多格/);
  assert.match(r.summary, /不是一步 move_step/);
  assert.match(r.summary, /plan_route source:"search"/);
  assert.match(r.summary, /只到你选定的端点/);
  assert.match(r.summary, /第1段 walk/);
  assert.deepEqual(adapter.actions, [], '历史规划只读，不移动也不挖');

  // 库原始查询也必须保持历史标记，而不是被 Curio 提升为当前可走。
  const raw = svc.query({ kind: 'historyRoute', dim: DIM, from: p0, to: p6, near: 5 });
  assert.equal(raw.status, 'ok');
  const inspection = (raw.data as { kind: string; inspection: { status: string; historicalGeometry: boolean; executable: boolean; currentPassability: string } }).inspection;
  assert.equal(inspection.status, 'FOUND');
  assert.equal(inspection.historicalGeometry, true);
  assert.equal(inspection.executable, false);
  assert.equal(inspection.currentPassability, 'UNKNOWN');
});

test('历史通道遇 blocker：停在 blocker 前，返回实测位置/已确认段/剩余段/blocker，不自动挖', async (t) => {
  const map = staleCorridor();
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'stone', pos: at(2, 64, 0) }, { name: 'stone', pos: at(2, 65, 0) });
  t.after(() => ctx.memory.close());

  const r = await navigateTo.run(ctx, {
    to: at(4, 64, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed', r.summary);
  assert.match(r.summary, /没有继续执行/);
  assert.equal(Math.floor(adapter.pos.x), 1, '停在 blocker 前，最后实测位置在 x=1');
  assert.equal(r.data?.executed, 1);
  assert.equal(r.data?.confirmedSegments, 1);
  assert.equal((r.data?.remaining as unknown[]).length, 3, '剩余段包含 blocker 段及其后');
  assert.deepEqual(r.data?.lastMeasuredPosition, { ...adapter.pos });
  const blocker = r.data?.blocker as {
    index: number; status: string; problem: string; cell?: { x: number; y: number; z: number };
  } | null;
  assert.equal(blocker?.index, 1);
  assert.equal(blocker?.status, 'BLOCKED');
  assert.equal(blocker?.problem, 'TARGET_BLOCKED');
  assert.deepEqual(blocker?.cell, at(2, 64, 0));
  assert.ok(!adapter.actions.some((action) => action.startsWith('dig')), 'navigate_to 不自动挖');

  // Agent 显式清障（两格塞满的通道需要两次 mine_cell），再重新观察同一格。
  await runSteps(ctx, [{ xyz: [2, 64, 0] }, { xyz: [2, 65, 0] }]);
  observe(map, 'minecraft:air', [at(2, 64, 0), at(2, 65, 0)]);

  const again = await navigateTo.run(ctx, {
    to: at(4, 64, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(again.status, 'succeeded', again.summary);
  assert.equal(again.data?.evidenceMode, 'historical');
  assert.equal(Math.floor(adapter.pos.x), 4, '到达选定端点');
  const transitions = again.data?.transitions as { to: { x: number } }[];
  assert.equal(Math.floor(transitions.at(-1)!.to.x), 4, '不越过选定端点');
  assert.equal(Math.floor(adapter.pos.x), 4, '通道再长也不越过 target');
});

test('历史候选第一段就是 blocker：不启动身体，实测位置不变', async (t) => {
  const map = staleCorridor();
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'stone', pos: at(1, 64, 0) }, { name: 'stone', pos: at(1, 65, 0) });
  t.after(() => ctx.memory.close());
  const before = { ...adapter.pos };

  const r = await navigateTo.run(ctx, {
    to: at(3, 64, 0), allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.executed, 0);
  assert.equal(r.data?.confirmedSegments, 0);
  assert.deepEqual(r.data?.lastMeasuredPosition, before);
  assert.equal((r.data?.remaining as unknown[]).length, 3);
  assert.equal((r.data?.blocker as { index?: number } | null)?.index, 0);
  assert.deepEqual(adapter.pos, before, '第一段非 OPEN 时不启动身体');
  assert.ok(!adapter.actions.some((action) => action.startsWith('moveTo') || action.startsWith('dig')));
});

test('plan_route source:"spatial" 暴露历史候选的逐段复验前缀与 blocker 槽位，且 steps 不越过端点', async (t) => {
  const map = staleCorridor();
  const { adapter, ctx } = setup(map);
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 64, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.evidenceMode, 'historical');
  const verification = r.data?.verification as { verdict?: string; openPrefix?: number; transitions: unknown[] } | undefined;
  assert.equal(r.data?.verifiedOpenSegments, verification?.openPrefix);
  assert.ok('blocker' in (r.data ?? {}), '历史候选暴露 blocker 槽位');
  assert.equal((verification?.transitions.length ?? 0) > 0, true, '逐段复验覆盖整条候选');
  assert.notEqual(verification?.verdict, 'OPEN');
  const steps = r.data?.steps as { skill: string; args: Record<string, unknown> }[];
  assert.ok(steps.length > 0);
  assert.ok(steps.every((step) => !!SKILLS[step.skill]), '步骤只使用现有动作');
  const transitions = r.data?.transitions as { to: { x: number } }[];
  assert.equal(Math.floor(transitions.at(-1)!.to.x), 3, '候选只到选定端点');
  assert.deepEqual(adapter.actions, [], '只读规划不移动');
});

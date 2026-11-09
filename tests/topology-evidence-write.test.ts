/**
 * C-EVID-02 拓扑证据写回验收：已确认 walk_path 通道写入无语义路由节点与有向边，
 * 只写 basis:'traversed' 的真实 traversal 证据；重走幂等、无自动反向边、容量
 * 失败关闭、能力 false 不调用库、拓扑失败不改 ARRIVED/PARTIAL、remember_place
 * 不入图。modes 只使用库实际支持的 MoveMode（walk/drop/climb/ladder/swim），
 * 不用库会拒绝的 land/boat。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeCapabilities } from 'curio-minecraft-3d-memory';
import type { MemoryHostCapabilities, NodePage, PathFragment } from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../src/adapter/types.ts';
import type { HostCapabilityReport } from '../src/spatial/capabilities.ts';
import type { SharedSpatialSession, WalkCorridorSegment } from '../src/spatial/shared-session.ts';
import { SharedSpatialSession as SharedSession } from '../src/spatial/shared-session.ts';
import { clearRouteRecords, planRoute, walkPath } from '../src/skills/movement/index.ts';
import { rememberPlace } from '../src/skills/observation.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import type { SkillCtx, SkillResult } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

const WORLD = 'topology-evidence-world';
const DIM = 'overworld';
const SESSION = 'topology-evidence-session';

/** 真实共享会话 + 一条平坦干燥走廊（支撑 y=63，脚位 y=64）。 */
async function openEvidenceSession(): Promise<{ svc: SharedSpatialSession; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'topology-evidence-'));
  const svc = await SharedSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db') });
  svc.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  const observedAt = Date.now();
  let sequence = 0;
  const cells: BlockObservation[] = [];
  for (let x = -1; x <= 6; x++) for (let z = -1; z <= 5; z++) for (let y = 63; y <= 65; y++) {
    cells.push({
      name: y === 63 ? 'minecraft:stone' : 'minecraft:air',
      properties: {}, worldId: WORLD, sessionId: SESSION, dimension: DIM,
      source: 'vision', stateComplete: true, observedAt, observationId: ++sequence,
      pos: { x, y, z },
    });
  }
  svc.observe(cells);
  return { svc, dir };
}

async function closeEvidenceSession(svc: SharedSpatialSession, dir: string): Promise<void> {
  const shutdown = await svc.shutdown();
  assert.equal(shutdown.close?.completed, true);
  rmSync(dir, { recursive: true, force: true });
}

/** 按住 forward 时沿当前朝向每帧小步移动的测试身体（与 walk_path 契约测试一致）。 */
class WalkingAdapter extends FakeAdapter {
  control: Record<string, boolean> = {};
  walkEntity = {
    position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false,
  };
  walkBody() {
    return {
      setControlState: (name: string, value: boolean) => { this.control[name] = value; },
      clearControlStates: () => { for (const k of Object.keys(this.control)) this.control[k] = false; },
      look: (yaw: number, pitch: number) => { this.yaw = yaw; this.pitch = pitch; },
      entity: this.walkEntity,
    };
  }
  walkTick() {
    return (signal: AbortSignal) => new Promise<typeof this.walkEntity | null>((resolve) => {
      const timer = setTimeout(() => {
        if (signal.aborted) { resolve(null); return; }
        if (this.control.forward || this.control.back) {
          const speed = this.control.sneak ? 0.01 : 0.02;
          const dir = (this.control.forward ? 1 : 0) - (this.control.back ? 1 : 0);
          const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.pos = { ...this.pos, x: this.pos.x + fx * dir * speed, z: this.pos.z + fz * dir * speed };
          this.walkEntity.position = { ...this.pos };
        }
        resolve({ position: { ...this.walkEntity.position }, velocity: { ...this.walkEntity.velocity }, onGround: true, isInWater: false });
      }, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
  }
  rewind(pos: { x: number; y: number; z: number }): void {
    this.pos = { ...pos };
    this.walkEntity.position = { ...pos };
  }
}

function walkingAdapter(pos = { x: 0.5, y: 64, z: 0.5 }): WalkingAdapter {
  const w = new WalkingAdapter();
  w.pos = { ...pos };
  w.walkEntity.position = { ...pos };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return w;
}

const walk = (to: { x: number; y: number; z: number }) => ({
  to, mode: 'walk' as const, source: 'search' as const, arrival: { kind: 'exact' as const },
});

async function runWalk(ctx: SkillCtx, to: { x: number; y: number; z: number }): Promise<SkillResult> {
  const planned = await planRoute.run(ctx, walk(to));
  assert.equal(planned.status, 'succeeded', planned.summary);
  return walkPath.run(ctx, { routeId: String(planned.data?.routeId) });
}

function nodesOf(svc: SharedSpatialSession): NodePage {
  const result = svc.query({ kind: 'nodes', dim: DIM, limit: 100 });
  assert.equal(result.status, 'ok');
  assert.equal(result.data?.kind, 'nodes');
  return result.data;
}

function edgesOf(svc: SharedSpatialSession) {
  const result = svc.query({ kind: 'edges', dim: DIM, limit: 100 });
  assert.equal(result.status, 'ok');
  assert.equal(result.data?.kind, 'edges');
  return result.data;
}

/** spatial_query 技能只应触碰 ctx.spatial；其余访问一律失败。 */
function ctxFor(spatial: SharedSpatialSession): SkillCtx {
  return {
    get adapter(): never { throw new Error('spatial_query must not touch ctx.adapter'); },
    get senses(): never { throw new Error('spatial_query must not touch ctx.senses'); },
    get memory(): never { throw new Error('spatial_query must not touch ctx.memory'); },
    get bus(): never { throw new Error('spatial_query must not touch ctx.bus'); },
    spatial,
    signal: new AbortController().signal,
    deadline: Date.now() + 3000,
    taskId: 'topology-evidence-test',
    progress(): never { throw new Error('spatial_query must not report progress'); },
  } as unknown as SkillCtx;
}

function corridorFragment(id: string, points: { x: number; y: number; z: number }[]): PathFragment {
  return {
    id, worldId: WORLD, dim: DIM, kind: 'walked', entrances: [],
    polyline: points, geometrySource: 'traversal', deepestY: Math.min(...points.map((p) => p.y)),
    createdAt: 1000, lastUsedAt: 1000, uses: 1,
  };
}

function corridorSegments(points: { x: number; y: number; z: number }[], fragmentId: string): WalkCorridorSegment[] {
  return points.slice(0, -1).map((from, i) => ({
    id: `${fragmentId}:seg-${i}`, fragmentId, from: { ...from }, to: { ...points[i + 1]! },
    worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: 1000 + i,
    source: 'confirmed_walk_path', executionId: 'exec_test', mode: 'walk' as const,
  }));
}

function forcedReport(
  library: MemoryHostCapabilities,
  overrides: Partial<{ [K in keyof MemoryHostCapabilities['memory']]: boolean }>,
): HostCapabilityReport {
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

test('y 变化边类型与合法 modes：STAIRCASE/walk、DROP/drop、CLIMB/climb', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    const points = [
      { x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 0 },
      { x: 2, y: 63, z: 0 }, { x: 3, y: 65, z: 0 },
    ];
    const outcome = svc.recordWalkCorridor({
      fragment: corridorFragment('walk:vertical', points),
      segments: corridorSegments(points, 'walk:vertical'),
    });
    assert.equal(outcome.status, 'written');
    const edges = edgesOf(svc).items;
    const byType = new Map(edges.map((edge) => [edge.type, edge]));
    assert.deepEqual(byType.get('STAIRCASE')?.modes, ['walk']);
    assert.deepEqual(byType.get('DROP')?.modes, ['drop']);
    assert.deepEqual(byType.get('CLIMB')?.modes, ['climb']);
    assert.equal(edges.every((edge) => edge.basis === 'traversed' && edge.directed === true), true);
    assert.equal(edges.every((edge) => (edge.type as string) !== 'BRIDGE' && (edge.type as string) !== 'SWIM'), true);
    const nodes = nodesOf(svc).items;
    assert.equal(nodes.find((node) => node.id === `walk:${DIM}:1,65,0`)?.kind, 'vertical_junction');
    assert.equal(nodes.find((node) => node.id === `walk:${DIM}:2,63,0`)?.kind, 'vertical_junction');
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('容量超过每通道 8 节点：保留历史前缀、跳过拓扑并报告 capacity', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    // 9 段每段换轴：10 节点/8 个中间节点，超过 8 节点上限。
    const points = [
      { x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 1, y: 64, z: 1 },
      { x: 2, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }, { x: 3, y: 64, z: 2 },
      { x: 3, y: 64, z: 3 }, { x: 4, y: 64, z: 3 }, { x: 4, y: 64, z: 4 },
      { x: 5, y: 64, z: 4 },
    ];
    const outcome = svc.recordWalkCorridor({
      fragment: corridorFragment('walk:capacity', points),
      segments: corridorSegments(points, 'walk:capacity'),
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.status === 'failed' ? outcome.stage : null, 'capacity');
    if (outcome.status !== 'failed') return;
    assert.equal(outcome.fragmentId, 'walk:capacity');
    assert.equal(outcome.traversalIds.length, 9, '历史 traversal 前缀如实保留');
    assert.match(outcome.message, /history written.*topology skipped/);
    assert.equal(svc.query({ kind: 'fragments' }).total, 1, '容量失败不回退既有历史写入');
    assert.equal(svc.query({ kind: 'traversals' }).total, 9);
    assert.equal(svc.query({ kind: 'nodes' }).total, 0, '不静默丢弃部分节点');
    assert.equal(svc.query({ kind: 'edges' }).total, 0);
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('空段通道只保存 fragment，不写 traversal/拓扑且不抛错', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    const outcome = svc.recordWalkCorridor({
      fragment: corridorFragment('walk:empty', [{ x: 0, y: 64, z: 0 }]),
      segments: [],
    });
    assert.equal(outcome.status, 'written');
    assert.deepEqual(outcome.traversalIds, []);
    assert.equal(svc.query({ kind: 'fragments' }).total, 1);
    assert.equal(svc.query({ kind: 'traversals' }).total, 0);
    assert.equal(svc.query({ kind: 'nodes' }).total, 0);
    assert.equal(svc.query({ kind: 'edges' }).total, 0);
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('节点 kind 不虚构 turn：同类型直行中间 place、真实方向变化 turn', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    const straight = [{ x: 10, y: 64, z: 0 }, { x: 11, y: 64, z: 0 }, { x: 12, y: 64, z: 0 }];
    assert.equal(svc.recordWalkCorridor({
      fragment: corridorFragment('walk:straight', straight),
      segments: corridorSegments(straight, 'walk:straight'),
    }).status, 'written');
    assert.equal(nodesOf(svc).items.find((node) => node.id === `walk:${DIM}:11,64,0`)?.kind, 'place');

    const turn = [{ x: 20, y: 64, z: 0 }, { x: 21, y: 64, z: 0 }, { x: 21, y: 64, z: 1 }];
    assert.equal(svc.recordWalkCorridor({
      fragment: corridorFragment('walk:turn', turn),
      segments: corridorSegments(turn, 'walk:turn'),
    }).status, 'written');
    assert.equal(nodesOf(svc).items.find((node) => node.id === `walk:${DIM}:21,64,0`)?.kind, 'turn');
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('能力 false：recordNode/upsertEdge 门禁不调用库、不回退（直调写入入口）', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();
  const recorded = svc.capabilities();
  const report = svc as unknown as { capabilityReport: HostCapabilityReport };

  try {
    report.capabilityReport = forcedReport(recorded.library, { recordNode: false });
    const rejected = svc.recordWalkCorridor({
      fragment: corridorFragment('walk:cap-false', [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }]),
      segments: corridorSegments([{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }], 'walk:cap-false'),
    });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.status === 'failed' ? rejected.stage : null, 'capability_unavailable');
    const nodeRejection = svc.lastCapabilityRejection();
    assert.equal(nodeRejection?.kind === 'capability_unavailable' ? nodeRejection.method : null, 'recordNode');
    assert.equal(svc.query({ kind: 'fragments' }).total, 0);
    assert.equal(svc.query({ kind: 'nodes' }).total, 0);

    report.capabilityReport = forcedReport(recorded.library, { upsertEdge: false });
    const rejectedEdge = svc.recordWalkCorridor({
      fragment: corridorFragment('walk:cap-false-edge', [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }]),
      segments: corridorSegments([{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }], 'walk:cap-false-edge'),
    });
    assert.equal(rejectedEdge.status, 'failed');
    assert.equal(rejectedEdge.status === 'failed' ? rejectedEdge.stage : null, 'capability_unavailable');
    const edgeRejection = svc.lastCapabilityRejection();
    assert.equal(edgeRejection?.kind === 'capability_unavailable' ? edgeRejection.method : null, 'upsertEdge');

    // 能力恢复后仍可正常走：上面的拒绝没有污染会话。
    report.capabilityReport = recorded;
    const result = await runWalk(ctx, { x: 2.5, y: 64, z: 0.5 });
    assert.equal(result.data?.outcome, 'ARRIVED');
  } finally {
    report.capabilityReport = recorded;
  }
});

test('共享节点在同一格被再次经过：cell 规范不移动节点，外部边与历史都保留', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    const base = [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }];
    assert.equal(svc.recordWalkCorridor({
      fragment: corridorFragment('walk:external-base', base),
      segments: corridorSegments(base, 'walk:external-base'),
    }).status, 'written');
    const before = edgesOf(svc).items.map((edge) => edge.id).sort();

    // 实测精确位置在既有节点同 floor 格内抖动（0.2 vs 0），不是另一个节点。
    // 原子写入按 cell 规范存储，节点位置不变，因此不会因为外部边而失败。
    const overlapping = [{ x: 0.2, y: 64, z: 0 }, { x: 0, y: 64, z: 1 }];
    const outcome = svc.recordWalkCorridor({
      fragment: corridorFragment('walk:shared-node', overlapping),
      segments: corridorSegments(overlapping, 'walk:shared-node'),
    });
    assert.equal(outcome.status, 'written');
    if (outcome.status === 'written') {
      assert.equal(outcome.traversalIds.length, 1);
    }
    const after = edgesOf(svc).items.map((edge) => edge.id).sort();
    for (const id of before) assert.ok(after.includes(id), `外部边 ${id} 未被删除`);
    assert.equal(after.length, before.length + 1, '新通道新增一条边，没有覆盖旧边');
    assert.deepEqual(svc.session.topology.getNode(`walk:${DIM}:0,64,0`)?.location, {
      kind: 'exact', pos: { x: 0, y: 64, z: 0 },
    }, '共享节点位置保持整数格，不因实测抖动改写');
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('remember_place 命名地标不进拓扑图；nodes 不增加', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } }), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();

  assert.equal(nodesOf(svc).total, 0);
  const result = await rememberPlace.run(ctx, { label: 'home', target: { x: 0, y: 63, z: 0 } });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(result.data?.landmark !== undefined, '宿主 memory/landmarks 仍记录命名地标');
  assert.equal(nodesOf(svc).total, 0, '名字语义不入拓扑图，避免双真相源');
});

test('spatial_query 宿主能力上报与真实接线一致：recordNode/upsertEdge 为 true', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  t.after(async () => { await closeEvidenceSession(svc, dir); });
  const result = await spatialQuery.run(ctxFor(svc), { kind: 'capabilities' });
  assert.equal(result.status, 'succeeded', result.summary);
  const envelope = result.data as { hostComposed: { memory: Record<string, boolean> }; data: { capabilities: { memory: Record<string, boolean> } } };
  assert.equal(envelope.hostComposed.memory.recordNode, true);
  assert.equal(envelope.hostComposed.memory.upsertEdge, true);
  assert.equal(envelope.data.capabilities.memory.recordNode, true, '库实际能力也是 true');
  assert.equal(envelope.data.capabilities.memory.upsertEdge, true);
});


function fragmentIds(svc: SharedSpatialSession): Set<string> {
  const ids = new Set<string>();
  for (let after: string | undefined; ;) {
    const result = svc.query({ kind: 'fragments', limit: 100, ...(after === undefined ? {} : { after }) });
    if (result.data?.kind !== 'fragments') assert.fail(`expected fragments page, got ${result.data?.kind}`);
    for (const f of result.data.items) ids.add(f.id);
    if (result.data.nextAfter === undefined) return ids;
    after = result.data.nextAfter;
  }
}

/** 两点一段的通道；at 同时作 createdAt/lastUsedAt，决定“最旧”。 */
function writeStep(svc: SharedSpatialSession, id: string, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, at: number) {
  const points = [from, to];
  return svc.recordWalkCorridor({
    fragment: { ...corridorFragment(id, points), createdAt: at, lastUsedAt: at },
    segments: corridorSegments(points, id),
  });
}

test('路径片段写满：先忘每格别处也有、已无边引用的重复片段，独有的旧路保留', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    // 最旧的一段独有路径（模拟走到过的最远处），之后是 499 对“同一对格子走了两遍”。
    assert.equal(writeStep(svc, 'far', { x: 500, y: 64, z: 0 }, { x: 501, y: 64, z: 0 }, 1).status, 'written');
    for (let i = 0; i < 499; i++) {
      writeStep(svc, `old:${i}`, { x: 0, y: 64, z: i }, { x: 1, y: 64, z: i }, 10 + i);
      writeStep(svc, `new:${i}`, { x: 0, y: 64, z: i }, { x: 1, y: 64, z: i }, 10_000 + i);
    }
    assert.equal(writeStep(svc, 'filler', { x: 600, y: 64, z: 0 }, { x: 601, y: 64, z: 0 }, 20_000).status, 'written');
    assert.equal(svc.query({ kind: 'fragments' }).total, 1000);
    const edgesBefore = svc.query({ kind: 'edges' }).total ?? 0;

    const outcome = writeStep(svc, 'next', { x: 700, y: 64, z: 0 }, { x: 701, y: 64, z: 0 }, 30_000);
    assert.equal(outcome.status, 'written', '写满后仍能写入新路径');
    assert.deepEqual(outcome.forgotten, { fragments: 50, redundant: 50, edges: 0, nodes: 0 });
    assert.equal(svc.query({ kind: 'fragments' }).total, 951);
    const ids = fragmentIds(svc);
    assert.equal(ids.has('far'), true, '独有的最旧路径不因为旧就被忘');
    assert.equal(ids.has('old:0') || ids.has('old:49'), false, '先忘最旧的重复片段');
    assert.equal(ids.has('new:0'), true);
    assert.equal(svc.query({ kind: 'edges' }).total, edgesBefore + 1, '重复片段已无边引用，拓扑不丢');
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('路径片段写满且没有重复：按最久未用忘，连同它的边和孤立通道节点', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    for (let i = 0; i < 1000; i++) writeStep(svc, `u:${i}`, { x: 0, y: 64, z: 3 * i }, { x: 1, y: 64, z: 3 * i }, 10 + i);
    assert.equal(svc.query({ kind: 'fragments' }).total, 1000);
    const outcome = writeStep(svc, 'next', { x: 700, y: 64, z: 0 }, { x: 701, y: 64, z: 0 }, 30_000);
    assert.equal(outcome.status, 'written');
    assert.deepEqual(outcome.forgotten, { fragments: 50, redundant: 0, edges: 50, nodes: 100 });
    const ids = fragmentIds(svc);
    assert.equal(ids.has('u:49'), false);
    assert.equal(ids.has('u:50'), true);
    assert.equal(svc.query({ kind: 'edges' }).total, 951);
    assert.equal(svc.query({ kind: 'nodes' }).total, 2 * 951);
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

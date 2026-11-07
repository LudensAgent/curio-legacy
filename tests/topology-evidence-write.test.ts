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
  return {
    owner: 'host_composed', contract: library.contract,
    library: { ...library, memory: { ...library.memory, ...overrides } },
    host: { checkpoint: true, flush: true, close: true },
  };
}

test('确认段写拓扑：起点/终点节点 + HORIZONTAL 有向边（traversed, modes walk, 真实 evidence）', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();

  const result = await runWalk(ctx, { x: 2.5, y: 64, z: 0.5 });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.outcome, 'ARRIVED');
  assert.equal(result.data?.memoryWrite, 'pending');
  const memory = result.data?.memory as { status: string; fragmentId: string; traversalIds: string[] };
  assert.equal(memory.status, 'written');
  assert.equal(memory.traversalIds.length, 2);

  const nodes = nodesOf(svc);
  // 库要求每条边引用的 traversal 端点与边节点逐值相等，所以每个确认段的实测端点
  // 都是一个节点；仍不做每格/每方块节点。
  assert.equal(nodes.total, 3, '起点 + 段边界 + 终点');
  assert.deepEqual(nodes.items.map((node) => node.id).sort(), [
    `walk:${DIM}:0,64,0`,
    `walk:${DIM}:1,64,0`,
    `walk:${DIM}:2,64,0`,
  ]);
  assert.equal(nodes.items.every((node) => node.label === `walk:${memory.fragmentId}`), true, 'label 无语义名');
  assert.equal(nodes.items.find((node) => node.id === `walk:${DIM}:0,64,0`)?.kind, 'entrance');
  assert.equal(nodes.items.find((node) => node.id === `walk:${DIM}:2,64,0`)?.kind, 'place');
  assert.equal(nodes.items.find((node) => node.id === `walk:${DIM}:1,64,0`)?.kind, 'place', '同类型直行中间节点不虚构 turn');

  const edges = edgesOf(svc);
  assert.equal(edges.total, 2, '每个确认段一条有向边（端点必须与真实 traversal 逐值相等）');
  assert.equal(edges.items.every((edge) => edge.type === 'HORIZONTAL'), true);
  assert.equal(edges.items.every((edge) => edge.basis === 'traversed'), true);
  assert.equal(edges.items.every((edge) => edge.directed === true), true, '默认有向；不自动生成反向边');
  assert.equal(edges.items.every((edge) => JSON.stringify(edge.modes) === '["walk"]'), true);
  assert.equal(edges.items.every((edge) => edge.fragmentId === memory.fragmentId), true);
  const evidence = edges.items.flatMap((edge) => edge.evidenceIds).sort();
  assert.deepEqual(evidence, [...memory.traversalIds].sort(), 'evidence 是本次确认段真实 traversal id');
  assert.deepEqual(edges.items.map((edge) => [edge.from, edge.to]), [
    [`walk:${DIM}:0,64,0`, `walk:${DIM}:1,64,0`],
    [`walk:${DIM}:1,64,0`, `walk:${DIM}:2,64,0`],
  ]);

  const components = svc.query({ kind: 'components', dim: DIM });
  assert.equal(components.status, 'ok');
  assert.equal(components.data?.kind, 'components');
  if (components.data?.kind === 'components') {
    assert.ok(components.data.report.components >= 1, '拓扑分量非空');
    assert.equal(components.data.report.groups.some((group) => group.length === 3), true);
  }
});

test('同一条路重走：节点/边数量不增加，边重绑本次真实 traversal 证据', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();

  const first = await runWalk(ctx, { x: 2.5, y: 64, z: 0.5 });
  assert.equal(first.data?.outcome, 'ARRIVED');
  const beforeNodes = nodesOf(svc).total;
  const beforeEdges = edgesOf(svc).total;
  const firstEvidence = (first.data?.memory as { traversalIds: string[] }).traversalIds;

  w.rewind({ x: 0.5, y: 64, z: 0.5 });
  clearRouteRecords();
  const second = await runWalk(ctx, { x: 2.5, y: 64, z: 0.5 });
  assert.equal(second.data?.outcome, 'ARRIVED');
  const secondEvidence = (second.data?.memory as { traversalIds: string[] }).traversalIds;
  assert.notDeepEqual(secondEvidence, firstEvidence, '第二次执行有新的真实 traversal');

  assert.equal(nodesOf(svc).total, beforeNodes, '重走不新增节点');
  assert.equal(edgesOf(svc).total, beforeEdges, '重走不新增边');
  const edges = edgesOf(svc).items;
  assert.deepEqual(edges.flatMap((edge) => edge.evidenceIds).sort(), [...secondEvidence].sort(), '边重绑到本次真实 traversal，不是旧证据');
  assert.equal(edges.every((edge) => edge.fragmentId === (second.data?.memory as { fragmentId: string }).fragmentId), true);
});

test('只走反向不亲历正向：只有反向 traversed 边，没有自动正向边', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter({ x: 2.5, y: 64, z: 0.5 });
  const ctx = { ...makeCtx(w), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();

  const result = await runWalk(ctx, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(result.data?.outcome, 'ARRIVED', result.summary);

  const edges = edgesOf(svc);
  assert.ok(edges.total >= 1, '反向确认至少产生一条有向边');
  assert.equal(edges.items.every((edge) => edge.basis === 'traversed'), true);
  assert.equal(edges.items.some((edge) => edge.from === `walk:${DIM}:0,64,0` && edge.to === `walk:${DIM}:2,64,0`), false, '不得自动生成正向边');
  assert.equal(edges.items.every((edge) => {
    const fromX = Number(edge.from.split(':').at(-1)!.split(',')[0]);
    const toX = Number(edge.to.split(':').at(-1)!.split(',')[0]);
    return fromX >= toX;
  }), true, '只写本次反向走过的方向');
  assert.equal(nodesOf(svc).items.some((node) => node.id === `walk:${DIM}:2,64,0`), true);
  assert.equal(nodesOf(svc).items.some((node) => node.id === `walk:${DIM}:0,64,0`), true);
});

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

test('walk_path 端到端：记忆能力 false 时仍 ARRIVED，memoryWrite=failed', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();
  const recorded = svc.capabilities();
  const report = svc as unknown as { capabilityReport: HostCapabilityReport };
  report.capabilityReport = forcedReport(recorded.library, { recordNode: false });
  try {
    const result = await runWalk(ctx, { x: 2.5, y: 64, z: 0.5 });
    assert.equal(result.data?.outcome, 'ARRIVED', '记忆能力缺失不得改写已确认的身体结果');
    assert.equal(result.data?.memoryWrite, 'failed');
    const memory = result.data?.memory as { status: string; stage: string; traversalIds: string[] };
    assert.equal(memory.status, 'failed');
    assert.equal(memory.stage, 'capability_unavailable');
    assert.deepEqual(memory.traversalIds, [], '能力门禁在读入历史前失败，不虚报前缀');
    const position = result.data?.position as { x: number } | null;
    assert.ok(position !== null && Math.abs(position.x - 2.5) <= 0.3, '身体仍到达目标附近');
    assert.equal(svc.query({ kind: 'fragments' }).total, 0, '能力 false 时连历史也不写');
  } finally {
    report.capabilityReport = recorded;
  }
});

test('walk_path 端到端：容量 failed 不改 ARRIVED，memoryWrite=failed', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const spatial = Object.create(svc) as SharedSpatialSession;
  spatial.recordWalkCorridor = (input) => ({
    status: 'failed', stage: 'capacity',
    message: 'history written; topology skipped (test stub)',
    fragmentId: input.fragment.id, traversalIds: [],
  });
  const ctx = { ...makeCtx(w), spatial };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();

  const result = await runWalk(ctx, { x: 2.5, y: 64, z: 0.5 });
  assert.equal(result.data?.outcome, 'ARRIVED', '容量失败不得改写已确认的身体结果');
  assert.equal(result.data?.memoryWrite, 'failed');
  const memory = result.data?.memory as { status: string; stage: string; message: string };
  assert.equal(memory.status, 'failed');
  assert.equal(memory.stage, 'capacity');
  assert.match(memory.message, /history written/);
  const position = result.data?.position as { x: number } | null;
  assert.ok(position !== null && Math.abs(position.x - 2.5) <= 0.3, '身体仍到达目标附近');
  assert.ok(Math.abs(w.pos.x - 2.5) <= 0.3, '身体动作序列未被记忆失败改写');
});

test('共享节点被外部边引用：拓扑写入前失败关闭，不删除外部边', async () => {
  const { svc, dir } = await openEvidenceSession();
  try {
    const base = [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }];
    assert.equal(svc.recordWalkCorridor({
      fragment: corridorFragment('walk:external-base', base),
      segments: corridorSegments(base, 'walk:external-base'),
    }).status, 'written');
    const before = edgesOf(svc).items.map((edge) => edge.id).sort();

    // 新通道起始实测位置与既有节点同 floor 格但精确位置不同，且其边不属于本次计划。
    const overlapping = [{ x: 0.2, y: 64, z: 0 }, { x: 0, y: 64, z: 1 }];
    const outcome = svc.recordWalkCorridor({
      fragment: corridorFragment('walk:shared-node', overlapping),
      segments: corridorSegments(overlapping, 'walk:shared-node'),
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.status === 'failed' ? outcome.stage : null, 'topology_write');
    if (outcome.status === 'failed') {
      assert.match(outcome.message, /external edge/);
      assert.match(outcome.message, /topology was not changed/);
      assert.equal(outcome.traversalIds.length, 1, '历史前缀仍按序写入');
    }
    assert.deepEqual(edgesOf(svc).items.map((edge) => edge.id).sort(), before, '外部边未被删除');
    assert.deepEqual(svc.session.topology.getNode(`walk:${DIM}:0,64,0`)?.location, {
      kind: 'exact', pos: { x: 0, y: 64, z: 0 },
    }, '外部节点位置未被改写');
  } finally {
    await closeEvidenceSession(svc, dir);
  }
});

test('拓扑写入异常：ARRIVED 不变，memoryWrite 如实 failed(topology_write)，traversal 前缀保留', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();
  svc.session.topology.saveEdge = () => { throw new Error('topology store full'); };

  const result = await runWalk(ctx, { x: 2.5, y: 64, z: 0.5 });
  assert.equal(result.data?.outcome, 'ARRIVED', '拓扑失败不得改写身体结果');
  assert.equal(result.data?.memoryWrite, 'failed', '不得把失败写成 pending/saved');
  const memory = result.data?.memory as { status: string; stage: string; message: string; traversalIds: string[] };
  assert.equal(memory.status, 'failed');
  assert.equal(memory.stage, 'topology_write');
  assert.match(memory.message, /topology store full/);
  assert.match(memory.message, /prefix semantics/, '披露可能保留的拓扑前缀');
  assert.equal(memory.traversalIds.length, 2, '已写入的 traversal 前缀如实保留');
  assert.equal(svc.query({ kind: 'traversals' }).total, 2);
  assert.equal(svc.query({ kind: 'edges' }).total, 0);
});

/** 第一段正常走完；第二段开始后故意向 +Z 偏航，触发库的 deviation→PARTIAL。 */
class DeviatingAdapter extends WalkingAdapter {
  lookCount = 0;
  secondFrames = 0;
  walkBody() {
    const inner = super.walkBody();
    return { ...inner, look: (yaw: number, pitch: number) => { this.lookCount += 1; inner.look(yaw, pitch); } };
  }
  walkTick() {
    return (signal: AbortSignal) => new Promise<typeof this.walkEntity | null>((resolve) => {
      const timer = setTimeout(() => {
        if (signal.aborted) { resolve(null); return; }
        if (this.lookCount >= 2) {
          this.secondFrames += 1;
          if (this.secondFrames > 12) { resolve(null); return; }
          if (this.control.forward) {
            this.pos = { ...this.pos, z: this.pos.z + 0.02 };
            this.walkEntity.position = { ...this.pos };
          }
        } else if (this.control.forward || this.control.back) {
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
}

test('拓扑写入异常：PARTIAL 不变，memoryWrite 仍如实 failed', async (t) => {
  const { svc, dir } = await openEvidenceSession();
  const w = new DeviatingAdapter();
  w.rewind({ x: 0.5, y: 64, z: 0.5 });
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  const ctx = { ...makeCtx(w), spatial: svc };
  t.after(async () => { ctx.memory.close(); await closeEvidenceSession(svc, dir); });
  clearRouteRecords();
  svc.session.topology.saveEdge = () => { throw new Error('topology store full'); };

  const result = await runWalk(ctx, { x: 2.5, y: 64, z: 0.5 });
  assert.equal(result.data?.outcome, 'PARTIAL', result.summary);
  assert.equal(result.data?.memoryWrite, 'failed');
  assert.equal((result.data?.memory as { status: string; stage: string }).status, 'failed');
  assert.equal((result.data?.memory as { status: string; stage: string }).stage, 'topology_write');
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { walkLandRules } from '../src/adapter/land-rules.ts';
import { searchLandRoute, searchLandRouteAsync, summarizeBoundaries, verifyLandRoute } from '../src/spatial/land-search.ts';

const WORLD = 'world', DIM = 'overworld', SESSION = 's1';
let sequence = 0;
const at = (x: number, y: number, z: number) => ({ x, y, z });

function fill(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[], properties: Record<string, string> = {}) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: 1000 + sequence, sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties }, pos,
    });
  }
}

function fillBox(map: VoxelMap, name: string, min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) {
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) cells.push(at(x, y, z));
  fill(map, name, cells);
}

function body(feet: { x: number; y: number; z: number }) {
  return { feet, width: 0.6, height: 1.8, pose: 'standing' as const };
}

function request(feet: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, overrides: Record<string, unknown> = {}) {
  return { worldId: WORLD, dim: DIM, sessionId: SESSION, body: body(feet), to, rules: walkLandRules, ...overrides };
}

test('3D 搜索：平地同高路线 FOUND，walk 段可复验 OPEN', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(5, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0), at(4, -1, 0)]);
  const feet = at(0.5, 0, 0.5);
  const result = searchLandRoute(map, request(feet, at(3.5, 0, 0.5)), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.stats));
  assert.ok(result.transitions.length >= 3);
  assert.ok(result.transitions.every((transition) => transition.kind === 'walk'));
  const verification = verifyLandRoute(map, request(feet, at(3.5, 0, 0.5)), result.transitions, 2000);
  assert.equal(verification.verdict, 'OPEN');
  assert.equal(verification.openPrefix, result.transitions.length);
});

test('3D 搜索：1 格台阶 FOUND 且带 step 过渡', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 3, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(1, 0, 0)]);
  const feet = at(0.5, 0, 0.5);
  const result = searchLandRoute(map, request(feet, at(1.5, 1, 0.5)), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries.slice(0, 4)));
  assert.deepEqual(result.transitions.map((transition) => transition.kind), ['step']);
  assert.equal(result.transitions[0]!.drop, 0);
  assert.equal(verifyLandRoute(map, request(feet, at(1.5, 1, 0.5)), result.transitions, 2000).verdict, 'OPEN');
});

test('3D 搜索：2 格安全下落 FOUND 且带 drop 过渡', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 4, 1));
  fill(map, 'minecraft:stone', [at(0, 1, 0), at(0, -1, 0), at(1, -1, 0)]);
  const feet = at(0.5, 2, 0.5);
  const result = searchLandRoute(map, request(feet, at(1.5, 0, 0.5), { maxDrop: 4 }), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries.slice(0, 4)));
  assert.deepEqual(result.transitions.map((transition) => transition.kind), ['drop']);
  assert.equal(result.transitions[0]!.drop, 2);
  assert.equal(verifyLandRoute(map, request(feet, at(1.5, 0, 0.5)), result.transitions, 2000).verdict, 'OPEN');
});

type PrefixFacts = {
  endpoint: { x: number; y: number; z: number };
  points: unknown[];
  transitions: { kind: string; to: { x: number; y: number; z: number } }[];
  distanceToTarget: number;
  atTarget: boolean;
  atStart: boolean;
};
type BoundaryFacts = {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  kind: string;
  status: string;
  direction: string;
  reason?: string;
};

test('3D 搜索：有限已知地图返回最远可达 approach 前缀与 UNKNOWN 边界方向，不把未知当可走', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(0, 0, 0), at(3, 1, 0));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(10.5, 0, 0.5)), 2000);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.transitions.length, 0, 'UNKNOWN 边界不能进入可执行 transitions');
  const prefix = result.prefix as PrefixFacts | undefined;
  assert.ok(prefix, '搜索失败时也必须给出可达前缀事实');
  assert.equal(prefix.atTarget, false, '前缀不是到达');
  assert.equal(prefix.atStart, false);
  assert.equal(Math.floor(prefix.endpoint.x), 3, '最远可达 approach 是已知走廊末端');
  assert.equal(prefix.transitions.length, 3);
  assert.ok(prefix.points.length === prefix.transitions.length + 1);
  assert.ok(prefix.transitions.every((transition) => transition.kind === 'walk'));
  assert.ok(prefix.distanceToTarget > 0);
  const boundaries = result.boundaries as BoundaryFacts[];
  const unknownEast = boundaries.find((boundary) => boundary.status === 'UNKNOWN' && boundary.direction === 'E');
  assert.ok(unknownEast, '未知列边界必须带位置和方向');
  assert.equal(Math.floor(unknownEast.from.x), 3);
  assert.equal(Math.floor(unknownEast.to.x), 4);
  assert.ok(unknownEast.reason);
  const summary = summarizeBoundaries(result.boundaries);
  assert.equal(summary.observationMayResolve, true, 'UNKNOWN 边界可能由额外观察解决');
  assert.equal(summary.needsExplicitActionOrOtherRoute, false, '纯未知边界不需要挖/建');
  assert.ok((summary.counts.UNKNOWN ?? 0) > 0);
});

test('3D 搜索：已观测阻挡边界分类为 BLOCKED，前缀停在 blocker 前', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(0, 0, 0), at(3, 1, 0));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  // x=4 整列已观测为实心：这是“已观测阻挡”，不是缺少证据。
  fill(map, 'minecraft:stone', [at(4, 0, 0), at(4, 1, 0), at(4, 2, 0)]);
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(10.5, 0, 0.5)), 2000);
  const prefix = result.prefix as PrefixFacts | undefined;
  assert.ok(prefix);
  assert.equal(Math.floor(prefix.endpoint.x), 3, '可走到 blocker 前，而不是停在起点');
  assert.ok(prefix.transitions.every((transition) => Math.floor(transition.to.x) <= 3));
  const blocked = (result.boundaries as BoundaryFacts[]).find((boundary) => boundary.status === 'BLOCKED');
  assert.ok(blocked, '已观测阻挡必须以 BLOCKED 边界暴露');
  assert.equal(blocked.direction, 'E');
  const summary = summarizeBoundaries(result.boundaries);
  assert.equal(summary.needsExplicitActionOrOtherRoute, true, 'BLOCKED 边界需要显式动作/其他路线');
  assert.ok((summary.counts.BLOCKED ?? 0) > 0);
});

test('3D 搜索：未知区域只报缺口，不伪造路线；重复搜索稳定', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:stone', [at(0, -1, 0)]);
  const req = request(at(0.5, 0, 0.5), at(3.5, 0, 0.5));
  const result = searchLandRoute(map, req, 2000);
  const again = searchLandRoute(map, req, 2000);
  assert.equal(result.status, 'UNKNOWN');
  assert.ok(result.transitions.length === 0);
  assert.ok(result.boundaries.length > 0);
  // UNKNOWN/INCOMPLETE 不能出现在 transitions 里被当成可走；边界必须原样暴露。
  assert.ok(result.boundaries.every((boundary) => boundary.status === 'UNKNOWN'));
  assert.ok(result.stats.unknownEdges > 0);
  assert.deepEqual(again.transitions, result.transitions);
  assert.deepEqual(again.boundaries, result.boundaries);
  assert.equal(again.stats.unknownEdges, result.stats.unknownEdges);
  assert.equal(result.stats.snapshotCount, 0);
});

test('3D 搜索：火不当作可走格子', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(0, 0, 0), at(3, 2, 0));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0), at(0, 0, 1), at(1, 0, 1), at(2, 0, 1), at(3, 0, 1), at(0, 0, -1), at(1, 0, -1), at(2, 0, -1), at(3, 0, -1), at(0, 1, 1), at(1, 1, 1), at(2, 1, 1), at(3, 1, 1), at(0, 1, -1), at(1, 1, -1), at(2, 1, -1), at(3, 1, -1)]);
  fill(map, 'minecraft:fire', [at(1, 0, 0)]);
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(2.5, 0, 0.5)), 2000);
  assert.notEqual(result.status, 'FOUND');
  const direct = verifyLandRoute(map, request(at(0.5, 0, 0.5), at(2.5, 0, 0.5)), [
    { kind: 'walk', from: at(0.5, 0, 0.5), to: at(1.5, 0, 0.5), drop: 0 },
  ], 2000);
  assert.equal(direct.verdict, 'BLOCKED');
  assert.match(direct.transitions[0]!.reason ?? '', /fire/);
});

test('3D 搜索：预算在目标入队后停止时 prefix.atTarget 如实为 true', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(0, 0, 0), at(2, 1, 0));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0)]);
  // 目标在 x=2；边预算允许把目标压入队列，但在继续评估 x=1 的反向边时耗尽。
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(2.5, 0, 0.5), { maxEdges: 2 }), 2000);
  assert.equal(result.status, 'BUDGET_EXHAUSTED');
  assert.equal(result.stats.cancelReason, 'edges');
  const prefix = result.prefix as PrefixFacts | undefined;
  assert.ok(prefix);
  assert.equal(prefix.atTarget, true, '目标已入队且是解析目标，前缀端点就是目标');
  assert.equal(prefix.transitions.length, 2);
});

test('3D 搜索：预算不足明确报 BUDGET_EXHAUSTED', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(5, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0), at(4, -1, 0)]);
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(3.5, 0, 0.5), { maxNodes: 1 }), 2000);
  assert.equal(result.status, 'BUDGET_EXHAUSTED');
});

test('3D 搜索：0.5 半砖顶面生成 step，不要求整数脚高', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0)]);
  fill(map, 'minecraft:stone_slab', [at(1, 0, 0)], { type: 'bottom' });
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(1.5, 0.5, 0.5)), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries));
  assert.deepEqual(result.transitions.map((transition) => transition.kind), ['step']);
  assert.equal(result.transitions[0]!.to.y, 0.5);
});

test('3D 搜索：允许 0 < drop < 1 从半砖/箱顶走出', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
  fill(map, 'minecraft:stone_slab', [at(0, 0, 0)], { type: 'top' });
  fill(map, 'minecraft:stone_slab', [at(1, 0, 0)], { type: 'bottom' });
  const result = searchLandRoute(map, request(at(0.5, 1, 0.5), at(1.5, 0.5, 0.5)), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries));
  assert.deepEqual(result.transitions.map((transition) => transition.kind), ['drop']);
  assert.equal(result.transitions[0]!.drop, 0.5);
});

test('3D 搜索：起点偏心贴角时按格心规划，不把身体 AABB 的斜角碰撞当成无路', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-2, 0, -2), at(4, 2, 2));
  const floor: { x: number; y: number; z: number }[] = [];
  for (let x = -2; x <= 4; x++) for (let z = -2; z <= 2; z++) floor.push(at(x, -1, z));
  fill(map, 'minecraft:stone', floor);
  // 四个斜角方块：身体站在格内偏左后侧时，0.6 宽的身体会同时擦到它们；
  // 真实的人先回到格心再迈步，规划也必须按格心评估第一步。
  fill(map, 'minecraft:stone', [at(-1, 0, -1), at(1, 0, -1), at(-1, 0, 1), at(1, 0, 1)]);
  const result = searchLandRoute(map, request(at(0.25, 0, 0.25), at(3.5, 0, 0.5)), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries));
  assert.ok(result.transitions.length >= 3);
  assert.equal(result.points[0]?.x, 0.5, '规划起点归一到当前格心');
  assert.equal(result.points[0]?.z, 0.5, '规划起点归一到当前格心');
});

test('3D 搜索：目标 y 不在真实站立顶面时吸附到最近顶面', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0)]);
  fill(map, 'minecraft:stone_slab', [at(1, 0, 0)], { type: 'bottom' });
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(1.5, 0, 0.5)), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries));
  assert.equal(result.resolvedTarget.y, 0.5, '目标列真实脚高是半砖顶面');
  assert.equal(result.transitions[0]!.to.y, 0.5);
});

test('3D 搜索：0.875 雪层/灵魂沙/箱子顶都可作为真实脚高', () => {
  for (const [name, properties] of [
    ['minecraft:snow', { layers: '8' }],
    ['minecraft:soul_sand', {}],
    ['minecraft:chest', { type: 'single', facing: 'north' }],
  ] as const) {
    const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
    fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
    fill(map, 'minecraft:stone', [at(0, -1, 0)]);
    fill(map, name, [at(1, 0, 0)], properties);
    const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(1.5, 0.875, 0.5)), 2000);
    assert.equal(result.status, 'FOUND', `${name}: ${JSON.stringify(result.boundaries)}`);
    assert.equal(result.resolvedTarget.y, 0.875, name);
    assert.deepEqual(result.transitions.map((transition) => transition.kind), ['step'], name);
    assert.equal(result.transitions[0]!.to.y, 0.875, name);
  }
});

test('3D 搜索：传送门方块旁的箱子顶出口可站立；目标不是传送门方块本身', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 3, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0)]);
  fill(map, 'minecraft:chest', [at(1, 0, 0)], { type: 'single', facing: 'north' });
  fill(map, 'minecraft:nether_portal', [at(2, 0, 0)], { axis: 'x' });
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(1.5, 0.875, 0.5)), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries));
  assert.equal(result.resolvedTarget.y, 0.875);
  assert.equal(result.transitions[0]!.to.y, 0.875);
});

test('3D 搜索：历史模式用过期体素给出候选路线，严格模式仍报 UNKNOWN', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  const feet = at(0.5, 0, 0.5);
  map.markStale(DIM, 'expired');
  const strict = searchLandRoute(map, request(feet, at(3.5, 0, 0.5)), 2000);
  assert.equal(strict.status, 'UNKNOWN');
  assert.equal(strict.transitions.length, 0, 'STALE 不当可走');
  assert.equal(strict.executable, false);
  assert.equal(strict.stats.snapshotCount, 0);
  const historical = searchLandRoute(map, request(feet, at(3.5, 0, 0.5), { allowStale: true }), 2000);
  assert.equal(historical.status, 'FOUND');
  assert.equal(historical.evidenceMode, 'historical');
  assert.equal(historical.assurance, 'historical_geometry');
  assert.ok(historical.transitions.length > 0);
  assert.notEqual(historical.verification?.verdict, 'OPEN', '历史路线必须暴露它不是当前已验证的 OPEN 路线');
});

test('3D 复验：证据被标陈旧后不再 OPEN', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  const feet = at(0.5, 0, 0.5);
  const result = searchLandRoute(map, request(feet, at(2.5, 0, 0.5)), 2000);
  assert.equal(result.status, 'FOUND');
  map.markStale(DIM, 'observation_gap');
  const verification = verifyLandRoute(map, request(feet, at(2.5, 0, 0.5)), result.transitions, 2000);
  assert.equal(verification.verdict, 'STALE');
  assert.equal(verification.openPrefix, 0);
});

test('3D 搜索：时间预算到点后返回 BUDGET_EXHAUSTED/time，不继续扫完整张图', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const N = 80;
  for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
    fill(map, 'minecraft:stone', [at(x, -1, z)]);
    fill(map, 'minecraft:air', [at(x, 0, z), at(x, 1, z)]);
  }
  const t0 = Date.now();
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(N - 0.5, 0, N - 0.5), {
    maxSearchMs: 15,
    maxNodes: 100_000,
    maxEdges: 1_000_000,
  }), 2000);
  assert.equal(result.status, 'BUDGET_EXHAUSTED');
  assert.equal(result.stats.cancelReason, 'time');
  assert.equal(result.stats.maxSearchMs, 15);
  assert.ok(result.stats.durationMs >= 10 && result.stats.durationMs < 2000, `durationMs=${result.stats.durationMs}`);
  assert.ok(Date.now() - t0 < 2000, '时间预算不得退化成完整搜索');
});

test('3D 搜索：signal 在边评估之间也能停止并保留 cancelReason=signal', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const N = 40;
  for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
    fill(map, 'minecraft:stone', [at(x, -1, z)]);
    fill(map, 'minecraft:air', [at(x, 0, z), at(x, 1, z)]);
  }
  const controller = new AbortController();
  controller.abort();
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(N - 0.5, 0, N - 0.5), {
    signal: controller.signal,
    maxNodes: 100_000,
    maxEdges: 1_000_000,
  }), 2000);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.stats.cancelReason, 'signal');
});

test('分片搜索：异步入口按时间片让出事件循环，结果与同步一致', async () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(6, 2, 1));
  fill(map, 'minecraft:stone', [0, 1, 2, 3, 4, 5].map((x) => at(x, -1, 0)));
  const feet = at(0.5, 0, 0.5), to = at(5.5, 0, 0.5);
  // 可推进的时钟：每次读取前进 10ms，确保分片阈值被触发，且不靠真实耗时。
  let t = 0;
  const clock = () => (t += 10);
  const sliced = await searchLandRouteAsync(map, request(feet, to, { maxSearchMs: 1e9, clock }), 2000);
  assert.equal(sliced.status, 'FOUND', JSON.stringify(sliced.stats));
  assert.ok(sliced.stats.yieldCount > 0, '长搜索应真实让出事件循环');
  assert.ok(sliced.stats.maxSyncSliceMs >= 8, `切片长度应可观测：${sliced.stats.maxSyncSliceMs}`);
  const sync = searchLandRoute(map, request(feet, to), 2000);
  assert.equal(sync.status, sliced.status);
  assert.equal(sync.transitions.length, sliced.transitions.length);

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await searchLandRouteAsync(map, request(feet, to, { signal: aborted.signal }), 2000);
  assert.equal(cancelled.status, 'CANCELLED');
});


test('异步分片：长搜索会 yield，最长同步片远小于总时长', async () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const N = 120;
  for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
    fill(map, 'minecraft:stone', [at(x, -1, z)]);
    fill(map, 'minecraft:air', [at(x, 0, z), at(x, 1, z)]);
  }
  const req = request(at(0.5, 0, 0.5), at(N - 0.5, 0, N - 0.5), {
    maxNodes: 2048, maxEdges: 8192, maxSearchMs: 2000,
  });
  const t0 = performance.now();
  const result = await searchLandRouteAsync(map, req, 2000);
  const total = performance.now() - t0;
  assert.equal(result.status, 'BUDGET_EXHAUSTED');
  assert.ok(result.stats.yieldCount > 0, `yieldCount=${result.stats.yieldCount}`);
  assert.ok(result.stats.maxSyncSliceMs < 80, `maxSyncSliceMs=${result.stats.maxSyncSliceMs}, total=${total}`);
  assert.ok(total > result.stats.maxSyncSliceMs * 3, `total=${total}, slice=${result.stats.maxSyncSliceMs}`);
});

test('3D 搜索：同输入重复搜索的转移/边界与计数器稳定，且不产生 Section 快照', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(13, 2, 1));
  fill(map, 'minecraft:stone', Array.from({ length: 13 }, (_, x) => at(x, -1, 0)));
  const req = request(at(0.5, 0, 0.5), at(11.5, 0, 0.5));
  const first = searchLandRoute(map, req, 2000);
  const second = searchLandRoute(map, req, 2000);
  assert.equal(first.status, 'FOUND', JSON.stringify(first.stats));
  assert.deepEqual(second.points, first.points);
  assert.deepEqual(second.transitions, first.transitions);
  assert.deepEqual(second.boundaries, first.boundaries);
  for (const key of [
    'nodesExpanded', 'edgesEvaluated', 'openEdges', 'blockedEdges', 'unknownEdges',
    'staleEdges', 'unsupportedEdges', 'visitedSections', 'sectionReads', 'snapshotCount', 'cloneCount',
  ] as const) {
    assert.equal(second.stats[key], first.stats[key], key);
  }
  assert.equal(first.stats.snapshotCount, 0);
  assert.equal(second.stats.snapshotCount, 0);
});

test('异步与同步入口对同一地图给出相同状态和节点/边计数', async () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  for (let x = 0; x < 16; x++) for (let z = 0; z < 4; z++) {
    fill(map, 'minecraft:stone', [at(x, -1, z)]);
    fill(map, 'minecraft:air', [at(x, 0, z), at(x, 1, z)]);
  }
  const req = request(at(0.5, 0, 0.5), at(15.5, 0, 0.5), { maxNodes: 2048, maxEdges: 8192 });
  const sync = searchLandRoute(map, req, 2000);
  const asyncResult = await searchLandRouteAsync(map, req, 2000);
  assert.equal(asyncResult.status, sync.status);
  assert.deepEqual(asyncResult.points, sync.points);
  assert.deepEqual(asyncResult.transitions, sync.transitions);
  assert.equal(asyncResult.stats.nodesExpanded, sync.stats.nodesExpanded);
  assert.equal(asyncResult.stats.edgesEvaluated, sync.stats.edgesEvaluated);
  assert.equal(asyncResult.stats.snapshotCount, 0);
});

test('贴着已观测岩浆的站位只加代价：有平行路时绕开岩浆边，没有别的路仍可走', () => {
  // z=0 一排紧贴 z=-1 的岩浆，z=1 一排离岩浆一格；起点与终点都在 z=0。
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, 0), at(8, 2, 2));
  fillBox(map, 'minecraft:stone', at(-1, -1, 0), at(8, -1, 2));
  fillBox(map, 'minecraft:lava', at(-1, -1, -1), at(8, 0, -1));
  const feet = at(0.5, 0, 0.5), goal = at(7.5, 0, 0.5);
  const result = searchLandRoute(map, request(feet, goal), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.stats));
  const middle = result.transitions.slice(1, -1).map((t) => Math.floor(t.to.z));
  assert.ok(middle.some((z) => z >= 1), `中段应离开岩浆边：${JSON.stringify(result.transitions.map((t) => t.to))}`);

  const narrow = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(narrow, 'minecraft:air', at(-1, 0, 0), at(8, 2, 0));
  fillBox(narrow, 'minecraft:stone', at(-1, -1, 0), at(8, -1, 0));
  fillBox(narrow, 'minecraft:lava', at(-1, -1, -1), at(8, 0, -1));
  const only = searchLandRoute(narrow, request(feet, goal), 2000);
  assert.equal(only.status, 'FOUND', '唯一的路仍可走，不因岩浆邻格禁止');
});

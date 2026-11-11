import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { walkLandRules } from '../src/adapter/land-rules.ts';
import { feetGoal, goalOf } from '../src/skills/movement/goal.ts';
import { searchLandRoute, searchLandRouteAsync, summarizeBoundaries, verifyLandRoute, verifyLandRouteBounded, type LandSearchRequest } from '../src/spatial/land-search.ts';

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

/** 让已观察格进入真实陈旧：自身动作效果未确认（pending_effect）。时间、会话与生命周期不使证据老化。 */
function invalidateBox(map: VoxelMap, min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) {
  for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) map.invalidatePendingEffect(DIM, at(x, y, z));
}

function body(feet: { x: number; y: number; z: number }) {
  return { feet, width: 0.6, height: 1.8, pose: 'standing' as const };
}

function request(
  feet: { x: number; y: number; z: number }, goal: ReturnType<typeof goalOf>,
  overrides: Partial<Omit<LandSearchRequest, 'worldId' | 'dim' | 'sessionId' | 'body' | 'goal' | 'rules'>> = {},
): LandSearchRequest {
  return { worldId: WORLD, dim: DIM, sessionId: SESSION, body: body(feet), goal, rules: walkLandRules, ...overrides };
}

type BoundaryFacts = { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; status: string; direction: string; reason?: string };
type PrefixFacts = { endpoint: { x: number; y: number; z: number }; points: unknown[]; transitions: { kind: string }[]; atTarget: boolean; atStart: boolean };

test('格目标：平地同高路线 FOUND，walk 段可复验 OPEN', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(5, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0), at(4, -1, 0)]);
  const feet = at(0.5, 0, 0.5);
  const goal = goalOf(at(3, 0, 0));
  const result = searchLandRoute(map, request(feet, goal), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries.slice(0, 4)));
  assert.equal(result.target.x, 3.5, '格目标落在起点同一格内偏移上');
  assert.ok(result.transitions.length >= 3);
  assert.ok(result.transitions.every((transition) => transition.kind === 'walk'));
  const verification = verifyLandRoute(map, request(feet, goal), result.transitions, 2000);
  assert.equal(verification.verdict, 'OPEN');
  assert.equal(verification.openPrefix, result.transitions.length);
});

test('格目标：非格心负坐标起点仍走到目标格，不把起点或终点格心化', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-63, 0, -44), at(-56, 2, -40));
  const floor: { x: number; y: number; z: number }[] = [];
  for (let x = -63; x <= -56; x++) for (let z = -44; z <= -40; z++) floor.push(at(x, -1, z));
  fill(map, 'minecraft:stone', floor);
  const feet = at(-61.3, 0, -42.7);
  const goal = goalOf(at(-58, 0, -40));
  const result = searchLandRoute(map, request(feet, goal), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries.slice(0, 4)));
  assert.deepEqual(result.points[0], feet, '起点保持实测连续位置，不归一到格心');
  assert.deepEqual(result.target, { x: -57.3, y: 0, z: -39.7 });
  assert.equal(Math.floor(result.target.x), -58);
  assert.equal(Math.floor(result.target.z), -40);
  assert.equal(result.points.at(-1)?.x, -57.3);
});

test('格目标：1 格台阶 FOUND 且带 step 过渡', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 3, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(1, 0, 0)]);
  const feet = at(0.5, 0, 0.5);
  const goal = goalOf(at(1, 1, 0));
  const result = searchLandRoute(map, request(feet, goal), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries.slice(0, 4)));
  assert.deepEqual(result.transitions.map((transition) => transition.kind), ['step']);
  assert.equal(result.transitions[0]!.drop, 0);
  assert.equal(verifyLandRoute(map, request(feet, goal), result.transitions, 2000).verdict, 'OPEN');
});

test('格目标：2 格安全下落 FOUND 且带 drop 过渡', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 4, 1));
  fill(map, 'minecraft:stone', [at(0, 1, 0), at(0, -1, 0), at(1, -1, 0)]);
  const feet = at(0.5, 2, 0.5);
  const goal = goalOf(at(1, 0, 0));
  const result = searchLandRoute(map, request(feet, goal, { maxDrop: 4 }), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries.slice(0, 4)));
  assert.deepEqual(result.transitions.map((transition) => transition.kind), ['drop']);
  assert.equal(result.transitions[0]!.drop, 2);
  assert.equal(verifyLandRoute(map, request(feet, goal), result.transitions, 2000).verdict, 'OPEN');
});

test('格目标不吸附：请求脚高不是真实支撑面时如实不 FOUND，target 保留原脚高', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0)]);
  fill(map, 'minecraft:stone_slab', [at(1, 0, 0)], { type: 'bottom' });
  const feet = at(0.5, 0, 0.5);
  const goal = goalOf(at(1, 0, 0));
  const result = searchLandRoute(map, request(feet, goal), 2000);
  assert.notEqual(result.status, 'FOUND', '脚高 0 不是这一列的真实可站立面，不能吸附到 0.5');
  assert.equal(result.target.y, 0, '目标脚高原样保留');
});

test('精确连续目标离格：非起点格点偏移返回 UNSUPPORTED，不居中逼近', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(4, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  const feet = at(0.5, 0, 0.5);
  const goal = feetGoal(at(2.2, 0, 0.5));
  const result = searchLandRoute(map, request(feet, goal), 2000);
  assert.equal(result.status, 'UNSUPPORTED');
  assert.match(result.reason, /lattice|unsupported|outside/i);
  assert.deepEqual(result.target, { x: 2.2, y: 0, z: 0.5 });
});

test('证据不足：有限已知地图返回当前证据前缀与 UNKNOWN 边界方向，不把未知当可走', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(0, 0, 0), at(3, 1, 0));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), goalOf(at(10, 0, 0))), 2000);
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.transitions.length, 0, 'INSUFFICIENT_EVIDENCE 不产生可执行路线');
  const prefix = result.prefix as PrefixFacts | undefined;
  assert.ok(prefix, '搜索失败时也必须给出当前证据可达前缀事实');
  assert.equal(prefix.atTarget, false, '前缀不是到达');
  assert.equal(prefix.atStart, false);
  assert.equal(Math.floor(prefix.endpoint.x), 3, '最远可达 approach 是已知走廊末端');
  assert.equal(prefix.transitions.length, 3);
  assert.equal(prefix.points.length, 4);
  const boundaries = result.boundaries as BoundaryFacts[];
  const unknownEast = boundaries.find((boundary) => boundary.status === 'UNKNOWN' && boundary.direction === 'E');
  assert.ok(unknownEast, '未知列边界必须带位置和方向');
  assert.equal(Math.floor(unknownEast.from.x), 3);
  assert.equal(Math.floor(unknownEast.to.x), 4);
  assert.ok(unknownEast.reason);
  const summary = summarizeBoundaries(result.boundaries);
  assert.equal(summary.observationMayResolve, true);
  assert.equal(summary.needsExplicitActionOrOtherRoute, false);
});

test('已观测阻挡：整段评估范围都有观测时，实心墙报 BLOCKED/NO_PATH_IN_MEMORY，前缀停在 blocker 前', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  // 整列/整面都观测成实心；走廊只留 x=0..3,z=0 的净空，避免把未观察的支撑范围误判成未知。
  fillBox(map, 'minecraft:stone', at(-1, -6, -1), at(5, 2, 1));
  fillBox(map, 'minecraft:air', at(0, 0, 0), at(3, 1, 0));
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), goalOf(at(10, 0, 0))), 2000);
  assert.equal(result.status, 'NO_PATH_IN_MEMORY');
  const prefix = result.prefix as PrefixFacts | undefined;
  assert.ok(prefix);
  assert.equal(Math.floor(prefix.endpoint.x), 3, '可走到 blocker 前，而不是停在起点');
  const blocked = (result.boundaries as BoundaryFacts[]).find((boundary) => boundary.status === 'BLOCKED');
  assert.ok(blocked, '已观测阻挡必须以 BLOCKED 边界暴露');
  assert.equal(blocked.direction, 'E');
  assert.equal(summarizeBoundaries(result.boundaries).needsExplicitActionOrOtherRoute, true);
});

test('未知区域只报缺口，不伪造路线；重复搜索稳定', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:stone', [at(0, -1, 0)]);
  const req = request(at(0.5, 0, 0.5), goalOf(at(3, 0, 0)));
  const result = searchLandRoute(map, req, 2000);
  const again = searchLandRoute(map, req, 2000);
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.transitions.length === 0);
  assert.ok(result.boundaries.length > 0);
  assert.ok(result.boundaries.every((boundary) => boundary.status === 'UNKNOWN' || boundary.status === 'INCOMPLETE'));
  assert.ok(result.stats.staleReads === 0);
  assert.deepEqual(again.transitions, result.transitions);
  assert.deepEqual(again.boundaries, result.boundaries);
});

test('节点预算：BUDGET_EXHAUSTED 保留 budget 原因与当前证据前缀', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(5, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0), at(4, -1, 0)]);
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), goalOf(at(3, 0, 0)), { maxNodes: 1 }), 2000);
  assert.equal(result.status, 'BUDGET_EXHAUSTED');
  assert.equal(result.budget, 'nodes');
  assert.ok(result.prefix, '节点预算停止不是取消，仍给当前证据前缀');
});

test('半砖/雪层/灵魂沙/箱子顶作为真实脚高：请求同一脚高即 FOUND，step 落到实际顶面', () => {
  for (const [name, properties, foot] of [
    ['minecraft:stone_slab', { type: 'bottom' }, 0.5],
    ['minecraft:snow', { layers: '8' }, 0.875],
    ['minecraft:soul_sand', {}, 0.875],
    ['minecraft:chest', { type: 'single', facing: 'north' }, 0.875],
  ] as const) {
    const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
    fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
    fill(map, 'minecraft:stone', [at(0, -1, 0)]);
    fill(map, name, [at(1, 0, 0)], properties);
    const result = searchLandRoute(map, request(at(0.5, 0, 0.5), goalOf(at(1, foot, 0))), 2000);
    assert.equal(result.status, 'FOUND', `${name}: ${JSON.stringify(result.boundaries.slice(0, 4))}`);
    assert.deepEqual(result.transitions.map((transition) => transition.kind), ['step'], name);
    assert.equal(result.transitions[0]!.to.y, foot, name);
  }
});

test('历史候选：remembered 给出候选路线并附当前证据逐段复验，当前搜索仍报 INSUFFICIENT_EVIDENCE', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  const feet = at(0.5, 0, 0.5);
  const goal = goalOf(at(3, 0, 0));
  invalidateBox(map, at(-1, -1, -1), at(3, 2, 1));
  const strict = searchLandRoute(map, request(feet, goal), 2000);
  assert.equal(strict.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(strict.transitions.length, 0);
  assert.ok(strict.prefix === undefined || (strict.prefix.atStart && strict.prefix.transitions.length === 0), '当前搜索只给当前证据前缀，不给历史路线');
  const historical = searchLandRoute(map, request(feet, goal, { evidenceMode: 'remembered' }), 2000);
  assert.equal(historical.status, 'FOUND');
  assert.equal(historical.evidenceMode, 'historical');
  assert.equal(historical.assurance, 'historical_geometry');
  assert.ok(historical.transitions.length > 0);
  assert.equal(historical.verification, undefined, '普通搜索返回不隐式做整条路线复验');
  const verification = verifyLandRoute(map, request(feet, goal), historical.transitions, 2000);
  assert.notEqual(verification.verdict, 'OPEN', '历史路线必须暴露它不是当前已验证的 OPEN 路线');
  assert.equal(verification.transitions.length, historical.transitions.length);
});

test('当前证据复验：证据被标陈旧后不再 OPEN；危险方块以 BLOCKED 暴露', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  const feet = at(0.5, 0, 0.5);
  const goal = goalOf(at(2, 0, 0));
  const result = searchLandRoute(map, request(feet, goal), 2000);
  assert.equal(result.status, 'FOUND');
  map.markStale(DIM, 'observation_gap');
  assert.equal(verifyLandRoute(map, request(feet, goal), result.transitions, 2000).verdict, 'OPEN', '观察间隙不使证据老化');
  invalidateBox(map, at(-1, -1, -1), at(3, 2, 1));
  const verification = verifyLandRoute(map, request(feet, goal), result.transitions, 2000);
  assert.equal(verification.verdict, 'STALE');
  assert.equal(verification.openPrefix, 0);

  const fire = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(fire, 'minecraft:air', at(0, 0, 0), at(3, 2, 0));
  fill(fire, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  fill(fire, 'minecraft:fire', [at(1, 0, 0)]);
  const direct = verifyLandRoute(fire, request(at(0.5, 0, 0.5), goalOf(at(2, 0, 0))), [
    { kind: 'walk', from: at(0.5, 0, 0.5), to: at(1.5, 0, 0.5), drop: 0 },
  ], 2000);
  assert.equal(direct.verdict, 'BLOCKED');
  assert.match(direct.transitions[0]!.reason ?? '', /fire/);
  const fireSearch = searchLandRoute(fire, request(at(0.5, 0, 0.5), goalOf(at(2, 0, 0))), 2000);
  assert.notEqual(fireSearch.status, 'FOUND', '火格不能成为搜索候选');
  assert.ok((fireSearch.policy?.rejectedEdges ?? 0) > 0, '火格由宿主 edge policy 拒绝');
});

test('有界当前证据复验：共享 deadline 只检查部分时标 INCOMPLETE，未检查段不冒充 OPEN', async () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(5, 1, 1));
  fillBox(map, 'minecraft:stone', at(-1, -1, -1), at(5, -1, 1));
  const transitions = [0, 1, 2, 3].map((index) => ({
    kind: 'walk' as const,
    from: at(0.5 + index, 0, 0.5),
    to: at(1.5 + index, 0, 0.5),
    drop: 0,
  }));
  // 本文件的观察时间戳是 1000+sequence；复验 clock 固定到 2000，期限也使用同一时钟。
  const clock = () => 2000;
  const expired = await verifyLandRouteBounded(map, request(at(0.5, 0, 0.5), goalOf(at(4, 0, 0))), transitions, {
    deadlineMs: clock() - 1, now: clock,
  });
  assert.equal(expired.verdict, 'INCOMPLETE');
  assert.equal(expired.coverage?.complete, false);
  assert.equal(expired.transitions.length, 0);
  const complete = await verifyLandRouteBounded(map, request(at(0.5, 0, 0.5), goalOf(at(4, 0, 0))), transitions, {
    deadlineMs: clock() + 5000, yieldEvery: 2, now: clock,
  });
  assert.equal(complete.verdict, 'OPEN');
  assert.equal(complete.coverage?.complete, true);
  assert.equal(complete.transitions.length, transitions.length);
});

test('宿主 edge policy：水边有平行干燥路线时绕开，不把风险边当可走', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, 0), at(5, 1, 1));
  fillBox(map, 'minecraft:stone', at(-1, -1, 0), at(5, -1, 1));
  fill(map, 'minecraft:water', [at(2, 0, 0), at(2, 1, 0)]);
  const goal = goalOf(at(4, 0, 0));
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), goal), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.boundaries.slice(0, 4)));
  assert.equal(result.verification, undefined, '普通搜索返回不隐式重算整条路线');
  assert.ok((result.policy?.rejectedEdges ?? 0) > 0, JSON.stringify(result.policy));
  assert.ok(result.transitions.every((transition) => !(Math.floor(transition.to.x) === 2 && Math.floor(transition.to.z) === 0)), '路线不穿过水格');
  assert.ok(result.transitions.some((transition) => Math.floor(transition.to.z) === 1), '选择干燥平行路线');
  // 单步当前证据复验仍把水格标成风险，而不是已经可执行。
  const verification = verifyLandRoute(map, request(at(1.5, 0, 0.5), goalOf(at(4, 0, 0))), [
    { kind: 'walk', from: at(1.5, 0, 0.5), to: at(2.5, 0, 0.5), drop: 0 },
  ], 2000);
  assert.equal(verification.transitions[0]!.status, 'BLOCKED');
  assert.equal(verification.transitions[0]!.risk, true, '风险策略拒绝明确标为 risk，而不是伪造碰撞');
  assert.equal(verification.transitions[0]!.problem, undefined);
  assert.match(verification.transitions[0]!.reason ?? '', /hazard/);
});

test('宿主 edge policy：没有干燥路线时交回 UNSUPPORTED 与 policy 事实，不伪造已观察 BLOCKED', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:stone', at(-1, -6, -1), at(5, 2, 1));
  fillBox(map, 'minecraft:air', at(0, 0, 0), at(4, 1, 0));
  fill(map, 'minecraft:water', [at(2, 0, 0), at(2, 1, 0)]);
  // 只保留同高 walk 图：不生成落入下方实心石的真实 drop 候选，
  // 失败就只能来自 policy 拒绝，而不是被误当成观察到的地形 blocker。
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), goalOf(at(4, 0, 0)), {
    allowed: ['walk'], maxDrop: 0,
  }), 2000);
  assert.equal(result.status, 'UNSUPPORTED', JSON.stringify(result.boundaries.slice(0, 8)));
  assert.deepEqual(result.transitions, []);
  assert.ok((result.policy?.rejectedEdges ?? 0) > 0);
  assert.match(result.policy?.firstRejection?.reason ?? '', /hazard|water/);
  assert.equal(result.prefix?.knownBlockerAhead, undefined, 'policy 拒绝不是已观察地形 blocker');
  const waterBoundary = result.boundaries.find((boundary) => Math.floor(boundary.to.x) === 2 && Math.floor(boundary.to.z) === 0);
  assert.equal(waterBoundary, undefined, 'policy 拒绝不进入边界列表');
});

test('宿主 edge policy：贴已观测岩浆的站位加代价；有平行路时绕开，唯一路仍可走', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, 0), at(8, 1, 2));
  fillBox(map, 'minecraft:stone', at(-1, -1, 0), at(8, -1, 2));
  fillBox(map, 'minecraft:lava', at(-1, -1, -1), at(8, 0, -1));
  const feet = at(0.5, 0, 0.5), goal = at(7, 0, 0);
  const result = searchLandRoute(map, request(feet, goalOf(goal)), 2000);
  assert.equal(result.status, 'FOUND', JSON.stringify(result.stats));
  assert.equal(result.policy?.rejectedEdges ?? 0, 0, '岩浆邻格只加代价，不拒绝');
  const middle = result.transitions.slice(1, -1).map((transition) => Math.floor(transition.to.z));
  assert.ok(middle.some((z) => z >= 1), `中段应离开岩浆边：${JSON.stringify(result.transitions.map((transition) => transition.to))}`);

  const narrow = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(narrow, 'minecraft:air', at(-1, 0, 0), at(8, 1, 0));
  fillBox(narrow, 'minecraft:stone', at(-1, -1, 0), at(8, -1, 0));
  fillBox(narrow, 'minecraft:lava', at(-1, -1, -1), at(8, 0, -1));
  const only = searchLandRoute(narrow, request(feet, goalOf(goal)), 2000);
  assert.equal(only.status, 'FOUND', '唯一的路仍可走，不因岩浆邻格禁止');
});

test('信号取消：CANCELLED，不返回可执行路线或前缀', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const N = 40;
  for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
    fill(map, 'minecraft:stone', [at(x, -1, z)]);
    fill(map, 'minecraft:air', [at(x, 0, z), at(x, 1, z)]);
  }
  const controller = new AbortController();
  controller.abort();
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), goalOf(at(N - 1, 0, N - 1)), { signal: controller.signal }), 2000);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.prefix, undefined);
});

test('分片搜索：异步入口真实让出事件循环，取消不再等完整搜索', async () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(6, 2, 1));
  fill(map, 'minecraft:stone', [0, 1, 2, 3, 4, 5].map((x) => at(x, -1, 0)));
  const feet = at(0.5, 0, 0.5), goal = goalOf(at(5, 0, 0));
  let t = 0;
  const clock = () => (t += 10);
  const sliced = await searchLandRouteAsync(map, request(feet, goal, { maxSearchMs: 1e9, clock }), 2000);
  assert.equal(sliced.status, 'FOUND', JSON.stringify(sliced.stats));
  assert.ok(sliced.stats.yieldCount > 0, '长搜索应真实让出事件循环');
  const sync = searchLandRoute(map, request(feet, goal), 2000);
  assert.equal(sync.status, sliced.status);
  assert.equal(sync.transitions.length, sliced.transitions.length);

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await searchLandRouteAsync(map, request(feet, goal, { signal: aborted.signal }), 2000);
  assert.equal(cancelled.status, 'CANCELLED');
});

test('分片搜索：依赖 Section 在搜索中途变化时作废旧结果，用最新地图重跑', { timeout: 5000 }, async () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(6, 2, 1));
  fill(map, 'minecraft:stone', [0, 1, 2, 3, 4, 5].map((x) => at(x, -1, 0)));
  // 搜索先登记 Section 依赖、再从 sectionRef 读取。只在真实读到目标
  // Section (cx=0, cz=0, sy=0) 之后安排一次观察；setTimeout 使它发生在
  // 下一片真实让出事件循环时，写入的正是已登记依赖的同一个 Section，
  // 因此搜索必须作废而不是返回旧结果。更低的 sy（如支撑 sy=-1）不算。
  const readSectionRef = map.sectionRef.bind(map);
  let scheduled = false;
  map.sectionRef = (dim, x, y, z) => {
    const sameSection = dim === DIM
      && Math.floor(x / 16) === 0 && Math.floor(y / 16) === 0 && Math.floor(z / 16) === 0;
    if (!scheduled && sameSection) {
      scheduled = true;
      setTimeout(() => {
        sequence += 1;
        map.observe({
          worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence,
          source: 'vision', evidence: 'seen', stateComplete: true,
          state: { name: 'minecraft:air', properties: {} }, pos: at(0, 4, 0),
        });
      }, 0);
    }
    return readSectionRef(dim, x, y, z);
  };
  const result = await searchLandRouteAsync(map, request(at(0.5, 0, 0.5), goalOf(at(5, 0, 0)), {
    maxSearchMs: 5000, maxWorkPerSlice: 1,
  }), 2000);
  assert.equal(result.invalidatedAttempts, 1, '中途变化的那次搜索不能直接返回旧结果');
  assert.equal(result.status, 'FOUND', JSON.stringify(result.stats));
  assert.ok(result.transitions.length > 0);
});

test('分片搜索：持续被新观测作废时重跑次数有界，最终如实返回 INVALIDATED', { timeout: 5000 }, async () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(6, 2, 1));
  fill(map, 'minecraft:stone', [0, 1, 2, 3, 4, 5].map((x) => at(x, -1, 0)));
  const readSectionRef = map.sectionRef.bind(map);
  let writes = 0, pending = false;
  map.sectionRef = (dim, x, y, z) => {
    if (!pending && dim === DIM && Math.floor(x / 16) === 0 && Math.floor(y / 16) === 0 && Math.floor(z / 16) === 0) {
      pending = true;
      // setImmediate 排在搜索本片结束后的下一次让出之前，写入必然发生在搜索途中。
      setImmediate(() => {
        pending = false;
        writes += 1;
        sequence += 1;
        // 每次写入都是此前没观察过的新格，变化会作废依赖这个 Section 的搜索。
        map.observe({
          worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence,
          source: 'vision', evidence: 'seen', stateComplete: true,
          state: { name: 'minecraft:air', properties: {} }, pos: at(writes, 8, 0),
        });
      });
    }
    return readSectionRef(dim, x, y, z);
  };
  const result = await searchLandRouteAsync(map, request(at(0.5, 0, 0.5), goalOf(at(5, 0, 0)), {
    maxSearchMs: 5000, maxWorkPerSlice: 1,
  }), 2000);
  assert.equal(result.status, 'INVALIDATED', JSON.stringify(result.stats));
  assert.equal(result.invalidatedAttempts, 3);
  assert.equal(result.transitions.length, 0);
});

test('危险策略检查身体扫过的全部格子：斜向不擦过拐角的火，偏心贴着火走也拒绝', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 1, 3));
  fillBox(map, 'minecraft:stone', at(-1, -1, -1), at(3, -1, 3));
  fill(map, 'minecraft:fire', [at(1, 0, 0)]);
  const diagonal = searchLandRoute(map, request(at(0.5, 0, 0.5), goalOf(at(1, 0, 1)), { allowed: ['walk'], maxDrop: 0 }), 2000);
  assert.equal(diagonal.status, 'FOUND', JSON.stringify(diagonal.boundaries.slice(0, 3)));
  assert.ok(diagonal.transitions.every((transition) => transition.from.x === transition.to.x || transition.from.z === transition.to.z),
    '拐角 (1,0,0) 有火：不走斜线，改走另一侧');
  assert.ok(diagonal.points.every((p) => !(Math.floor(p.x) === 1 && Math.floor(p.z) === 0)));
  // 身体在格内偏东 0.3：沿 z 方向走时身体会碰到东侧 (1,0,1) 的火。
  fill(map, 'minecraft:fire', [at(1, 0, 1)]);
  const verification = verifyLandRoute(map, request(at(0.8, 0, 0.5), goalOf(at(0, 0, 2))), [
    { kind: 'walk', from: at(0.8, 0, 0.5), to: at(0.8, 0, 1.5), drop: 0 },
  ], 2000);
  assert.equal(verification.transitions[0]!.status, 'BLOCKED');
  assert.match(verification.transitions[0]!.reason ?? '', /fire/);
});

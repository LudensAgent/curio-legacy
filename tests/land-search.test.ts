import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { walkLandRules } from '../src/adapter/land-rules.ts';
import { searchLandRoute, verifyLandRoute } from '../src/spatial/land-search.ts';

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

test('3D 搜索：未知区域只报缺口，不伪造路线', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:stone', [at(0, -1, 0)]);
  const result = searchLandRoute(map, request(at(0.5, 0, 0.5), at(3.5, 0, 0.5)), 2000);
  assert.notEqual(result.status, 'FOUND');
  assert.ok(result.transitions.length === 0);
  assert.ok(result.boundaries.length > 0);
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

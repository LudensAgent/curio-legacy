import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateLandTransition, resolveLandLimits, VoxelMap, type LandTransition } from 'curio-minecraft-3d-memory';
import { walkLandRules, walkClimbProvider } from '../src/adapter/land-rules.ts';
import { walkCollisionProvider } from '../src/adapter/walk-route.ts';

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

function fillBox(map: VoxelMap, name: string, min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }, properties: Record<string, string> = {}) {
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) cells.push(at(x, y, z));
  fill(map, name, cells, properties);
}

function evaluate(map: VoxelMap, transition: LandTransition) {
  return evaluateLandTransition(map, {
    worldId: WORLD, dim: DIM, sessionId: SESSION,
    body: { feet: { ...transition.from }, width: 0.6, height: 1.8, pose: 'standing' },
    transition,
  }, walkLandRules, 2000, resolveLandLimits());
}

test('walkCollisionProvider 解析真实 1.20.1 blockstate 形状，未知方块仍报能力缺口', () => {
  const stone = walkCollisionProvider.resolve({ name: 'minecraft:stone', properties: {} }, at(0, 0, 0), { cell: () => ({ kind: 'unknown' }) as never });
  assert.equal(stone.kind, 'shape');
  assert.equal(stone.kind === 'shape' ? stone.shape.boxes.length : 0, 1);

  const netherrack = walkCollisionProvider.resolve({ name: 'minecraft:netherrack', properties: {} }, at(0, 0, 0), { cell: () => ({ kind: 'unknown' }) as never });
  assert.equal(netherrack.kind, 'shape', '下界岩必须可解析');

  const slab = walkCollisionProvider.resolve({ name: 'minecraft:oak_slab', properties: { type: 'bottom' } }, at(0, 0, 0), { cell: () => ({ kind: 'unknown' }) as never });
  assert.equal(slab.kind, 'shape');
  assert.equal(slab.kind === 'shape' ? slab.shape.supportFaces[0]?.top : null, 0.5);

  const air = walkCollisionProvider.resolve({ name: 'minecraft:air', properties: {} }, at(0, 0, 0), { cell: () => ({ kind: 'unknown' }) as never });
  assert.equal(air.kind, 'shape');
  assert.deepEqual(air.kind === 'shape' ? air.shape.boxes : null, []);

  const unknown = walkCollisionProvider.resolve({ name: 'minecraft:not_a_real_block', properties: {} }, at(0, 0, 0), { cell: () => ({ kind: 'unknown' }) as never });
  assert.equal(unknown.kind, 'unsupported_shape');
});

test('land step：1 格上行 OPEN，头顶被堵 BLOCKED', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(2, 3, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(1, 0, 0)]);
  const step: LandTransition = { kind: 'step', from: at(0.5, 0, 0.5), to: at(1.5, 1, 0.5) };
  const open = evaluate(map, step);
  assert.equal(open.status, 'OPEN', open.reason?.detail);

  fill(map, 'minecraft:stone', [at(1, 2, 0)]);
  const blocked = evaluate(map, step);
  assert.equal(blocked.status, 'BLOCKED');
});

test('land drop：2 格安全下落 OPEN，并报告 fall 事实', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(2, 3, 1));
  fill(map, 'minecraft:stone', [at(0, 1, 0), at(0, -1, 0), at(1, -1, 0)]);
  const drop: LandTransition = { kind: 'drop', from: at(0.5, 2, 0.5), to: at(1.5, 0, 0.5) };
  const result = evaluate(map, drop);
  assert.equal(result.status, 'OPEN', result.reason?.detail);
  assert.ok(result.hazards?.some((hazard) => hazard.kind === 'fall'));
});

test('land jump：平跳 OPEN', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(2, 3, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0)]);
  const jump: LandTransition = { kind: 'jump', from: at(0.5, 0, 0.5), to: at(1.5, 0, 0.5) };
  const result = evaluate(map, jump);
  assert.equal(result.status, 'OPEN', result.reason?.detail);
});

test('land ladder：连续梯子列 OPEN，非攀爬方块不伪造梯子', () => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(1, 5, 1));
  fill(map, 'minecraft:ladder', [at(0, 0, 0), at(0, 1, 0), at(0, 2, 0), at(0, 3, 0)], { facing: 'north' });
  const ladder: LandTransition = { kind: 'ladder', from: at(0.5, 0, 0.5), to: at(0.5, 3, 0.5) };
  const open = evaluate(map, ladder);
  assert.equal(open.status, 'OPEN', open.reason?.detail);
  assert.equal(open.provider?.kind, 'climb');

  const nonClimb = walkClimbProvider.resolve({ cell: at(0, 0, 0), state: { name: 'minecraft:stone', properties: {} }, body: { feet: at(0, 0, 0), width: 0.6, height: 1.8, pose: 'standing' } }, { cell: () => ({ kind: 'unknown' }) as never });
  assert.deepEqual(nonClimb, { kind: 'regions', regions: [] });
});

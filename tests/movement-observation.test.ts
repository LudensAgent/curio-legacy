import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { verifyLandRoute } from '../src/spatial/land-search.ts';
import { walkLandRules } from '../src/adapter/land-rules.ts';
import { boundaryProbeCells, observeBoundary } from '../src/skills/movement/observation.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const boundary = {
  from: { x: -504.58, y: 105, z: -291.56 },
  to: { x: -504.58, y: 104.9375, z: -292.56 },
  kind: 'drop' as const, status: 'STALE' as const,
  reason: 'required evidence is marked stale', direction: 'N' as const,
};
const key = (pos: Vec3Like) => `${pos.x},${pos.y},${pos.z}`;

test('探测搜索实际缺支撑的深度，优先请求近期前方漏看的地面', () => {
  const from = { x: -464.4197, y: 93, z: -306.4966 }, to = { ...from, x: from.x + 1 };
  const target = { x: -464, z: -307 };
  const cells = boundaryProbeCells({ ...boundary, from, to, kind: 'walk', direction: 'E',
    supportColumn: { minY: 88, maxY: 94 } }, 3, undefined, [],
    (p) => p.x === target.x && p.z === target.z && p.y <= 90).cells;
  assert.deepEqual(cells.map(p => p.y), [90, 89, 88]);
  assert.ok(cells.every(p => p.x === target.x && p.z === target.z));
});

test('boundary probes cover fractional headroom and every column touched by the standing body', () => {
  const from = { x: 0.2, y: 63.9375, z: 0.2 };
  const to = { ...from, x: 1.2 };
  const cells = boundaryProbeCells({ ...boundary, from, to, kind: 'walk', direction: 'E' }).cells;
  const keys = new Set(cells.map(key));
  for (const x of [-1, 0, 1]) for (const z of [-1, 0]) for (const y of [63, 64, 65]) {
    assert.ok(keys.has(`${x},${y},${z}`), `missing actual body/support cell ${x},${y},${z}`);
  }
  assert.ok(cells.length <= 32, 'physical coverage remains inside the observation budget');
});

test('a zero-width corridor still observes the physical body of an authorized off-center stance', () => {
  const from = { x: 0.2, y: 63.5, z: 0.5 }, to = { ...from, z: -0.5 };
  const cells = boundaryProbeCells({ ...boundary, from, to, kind: 'walk' }, 32, {
    origin: from, bearing: { x: 0, z: -1 }, maxLateral: 0,
  }).cells;
  const keys = new Set(cells.map(key));
  for (const x of [-1, 0]) for (const z of [-1, 0]) for (const y of [63, 64, 65]) {
    assert.ok(keys.has(`${x},${y},${z}`), `authorized body cell ${x},${y},${z} must remain observable`);
  }
  assert.ok(cells.every((cell) => cell.x === -1 || cell.x === 0), 'does not authorize terrain outside the body footprint');
});

test('exact body contact at a column boundary does not include the untouched neighbor', () => {
  const from = { x: 0.3, y: 64, z: 0.5 }, to = { ...from, z: -0.5 };
  const cells = boundaryProbeCells({ ...boundary, from, to, kind: 'walk' }, 32, {
    origin: from, bearing: { x: 0, z: -1 }, maxLateral: 0,
  }).cells;
  assert.ok(cells.every((cell) => cell.x === 0 && cell.y >= 63 && cell.y <= 65));
  assert.ok(cells.some((cell) => key(cell) === '0,63,0'), 'the original integer stance support is included');
});

test('step probes include headroom above the original column before horizontal movement', () => {
  const from = { x: 0.5, y: 64, z: 0.5 }, to = { x: 1.5, y: 65, z: 0.5 };
  const cells = boundaryProbeCells({ ...boundary, from, to, kind: 'step', direction: 'E' }).cells;
  assert.ok(cells.some((cell) => key(cell) === '0,66,0'), 'rising at the original column sweeps the head through y=66');
});

test('drop probes cover the destination column from the original height through landing', () => {
  const from = { x: 0.5, y: 66, z: 0.5 }, to = { x: 1.5, y: 62, z: 0.5 };
  const cells = boundaryProbeCells({ ...boundary, from, to, kind: 'drop', direction: 'E' }).cells;
  const keys = new Set(cells.map(key));
  for (let y = 61; y <= 67; y++) assert.ok(keys.has(`1,${y},0`), `drop destination sweep requires y=${y}`);
  assert.ok(cells.length <= 32);
});

function setup() {
  const adapter = new FakeAdapter();
  adapter.pos = { ...boundary.from };
  const map = new VoxelMap(adapter.worldId, { validityWindowMs: 60_000 });
  const ctx = { ...makeCtx(adapter), spatial: {
    worldId: adapter.worldId, session: { voxel: map },
  } as unknown as SharedSpatialSession };
  let sequence = 0;
  const observe = (pos: Vec3Like, observedAt = Date.now(), name = 'minecraft:air') => {
    map.observe({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
      observedAt, sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos });
    return { pos, name, properties: {}, stateComplete: true,
      worldId: adapter.worldId, sessionId: adapter.sessionId, dimension: adapter.dim,
      observationId: sequence, observedAt, source: 'vision' as const };
  };
  return { adapter, map, ctx, observe };
}

test('a four-block drop spanning two axes refreshes its stale sweep cells within 32 visual probes', async (t) => {
  const { adapter, map, ctx, observe } = setup();
  t.after(() => ctx.memory.close());
  const from = { x: 0.05, y: 64, z: 0.05 }, to = { x: 1.05, y: 60, z: 0.05 };
  adapter.pos = from;
  const edge = { ...boundary, from, to, direction: 'E' as const };
  const stale = new Set(['1,65,-1', '1,65,0']);
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 55; y <= 68; y++) {
    const pos = { x, y, z };
    // Only the trailing column supports the starting stance; the overlapping
    // column is clear for the full drop to the lower platform.
    const solid = y <= 59 || x === -1 && y === 63;
    observe(pos, Date.now() - 1000, solid ? 'minecraft:stone' : 'minecraft:air');
  }
  // Staleness comes only from an own action's unconfirmed effect, not from age.
  for (const cell of stale) {
    const [x, y, z] = cell.split(',').map(Number);
    map.invalidatePendingEffect(adapter.dim, { x: x!, y: y!, z: z! });
  }
  const check = () => verifyLandRoute(map, {
    worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
    body: { feet: from, width: 0.6, height: 1.8, pose: 'standing' }, rules: walkLandRules,
  }, [{ kind: 'drop', from, to, drop: 4 }], Date.now()).transitions[0]!.status;
  assert.equal(check(), 'STALE');
  let turns = 0;
  t.mock.method(adapter, 'look', async () => { turns++; });
  ctx.senses.observeBlocks = (cells) => {
    assert.ok(cells.length <= 32);
    return turns === 0 ? [] : cells.filter((cell) => stale.has(key(cell))).map((cell) => observe(cell));
  };
  const result = await observeBoundary(ctx, { boundary: edge, maxCells: 32 });
  assert.equal(turns, 1);
  assert.deepEqual(new Set(result.relatedCells.map(key)), stale);
  assert.equal(check(), 'OPEN', 'the actual drop sweep is proved only after both visible headroom cells are refreshed');
  const fresh = await observeBoundary(ctx, { boundary: edge, maxCells: 32 });
  assert.equal(fresh.turned, false, 'fresh sweep evidence does not cause another turn');
  assert.equal(turns, 1);
});

test('seeing fresh nearby cells still turns once toward the unresolved boundary cell', async (t) => {
  const { adapter, map, ctx, observe } = setup();
  t.after(() => ctx.memory.close());
  const cells = boundaryProbeCells(boundary).cells;
  cells.forEach((cell) => observe(cell, Date.now() - 1000));
  // Only the cell whose own-action effect is unconfirmed is stale.
  const stale = cells[1]!;
  map.invalidatePendingEffect(adapter.dim, stale);
  let reads = 0;
  const looks: { yaw: number; pitch: number }[] = [];
  t.mock.method(adapter, 'look', async (yaw: number, pitch: number) => { looks.push({ yaw, pitch }); });
  ctx.senses.observeBlocks = () => {
    reads += 1;
    return looks.length ? [observe(stale)] : [observe(cells[0]!)];
  };

  const result = await observeBoundary(ctx, { boundary, maxCells: 32 });

  assert.equal(reads, 2, 'fresh cells in view must not suppress a turn toward the missing evidence');
  assert.equal(looks.length, 1, 'frontier observation stays bounded to one turn');
  const eye = adapter.eye()!;
  const dx = stale.x + 0.5 - eye.x, dy = stale.y + 0.5 - eye.y, dz = stale.z + 0.5 - eye.z;
  assert.equal(looks[0]!.yaw, Math.atan2(-dx, -dz));
  assert.equal(looks[0]!.pitch, Math.atan2(dy, Math.hypot(dx, dz)));
  assert.equal(result.turned, true);
  assert.deepEqual(result.relatedCells, [stale]);
});

test('refreshing pending-effect evidence with unchanged content enables replanning', async (t) => {
  const { adapter, map, ctx, observe } = setup();
  t.after(() => ctx.memory.close());
  const cells = boundaryProbeCells(boundary).cells;
  cells.forEach((cell) => observe(cell));
  const expired = { x: -505, y: 104, z: -293 };
  // A separate cell whose old observation is aged but still current; only the
  // pending effect of an own action makes it stale.
  const expiredBoundary = { ...boundary, to: { x: -510.58, y: 104.9375, z: -292.56 } };
  expired.x = Math.floor(expiredBoundary.to.x);
  observe(expired, Date.now() - 61_000);
  map.invalidatePendingEffect(adapter.dim, expired);
  const before = map.cellAt('overworld', expired.x, expired.y, expired.z);
  assert.ok(before.observed);
  ctx.senses.observeBlocks = () => [observe(expired)];

  const result = await observeBoundary(ctx, { boundary: expiredBoundary, maxCells: 32 });
  const after = map.cellAt('overworld', expired.x, expired.y, expired.z);
  assert.ok(after.observed);
  assert.equal(after.evidence.observation.state.name, before.evidence.observation.state.name, 'content unchanged');
  assert.equal(after.evidence.freshness, 'FRESH');
  assert.equal(result.relatedChanged, true, 'pending-effect-to-current is new usable evidence');
  assert.ok(result.relatedCells.some((cell) => key(cell) === key(expired)));
});

test('refreshing still-current unchanged evidence neither turns nor authorizes a new search', async (t) => {
  const { adapter, ctx, observe } = setup();
  t.after(() => ctx.memory.close());
  const cells = boundaryProbeCells(boundary).cells;
  cells.forEach((cell) => observe(cell, Date.now() - 1000));
  let turns = 0;
  t.mock.method(adapter, 'look', async () => { turns += 1; });
  ctx.senses.observeBlocks = () => cells.map((cell) => observe(cell));

  const result = await observeBoundary(ctx, { boundary, maxCells: 32 });

  assert.equal(turns, 0);
  assert.equal(result.relatedChanged, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { primitiveSkills } from '../src/skills/primitives.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const dig = primitiveSkills.find((skill) => skill.name === 'dig_at')!;
const step = primitiveSkills.find((skill) => skill.name === 'step')!;
const place = primitiveSkills.find((skill) => skill.name === 'place_at')!;

function setup() {
  const world = new TestWorld();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  // These feedback tests assume every requested cell has been observed.
  const ctx = makeCtx(world, { senses: { observeBlocks: (positions) => positions.map((pos) => ({
    name: world.blockAt(pos), pos, properties: {}, worldId: world.worldId, sessionId: world.sessionId,
    dimension: world.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) } });
  return { world, ctx };
}

test('dig reports its world target before the relative-cell result: north frame, backward target is south', async (t) => {
  const { world, ctx } = setup();
  t.after(() => ctx.memory.close());
  world.setBlock({ x: 0, y: 64, z: 1 }, 'dirt');
  const parsed = dig.validate({ at: [-1, 0, 0], facing: 'N' }, world);
  assert.ok(parsed.ok);
  const result = await dig.run(ctx, parsed.args);
  assert.equal(result.status, 'succeeded');
  assert.match(result.summary.slice(0, 80), /^目标南方 \(0,64,1\)；坐标前=N；挖掉了 \[-1,0,0\] 的 dirt/);
  assert.equal(world.blockAt({ x: 0, y: 64, z: 1 }), 'air');
  assert.deepEqual(result.data?.targetFrom, { x: 0, y: 64, z: 0 });
  assert.deepEqual(result.data?.targetCell, { x: 0, y: 64, z: 1 });
  assert.equal(result.data?.coordinateFacing, 'N');
});

test('step direction is measured from its starting feet, even after movement changes the position and view', async (t) => {
  const { world, ctx } = setup();
  t.after(() => ctx.memory.close());
  const parsed = step.validate({ to: [0, 0, 1], facing: 'N' }, world);
  assert.ok(parsed.ok);
  const result = await step.run(ctx, parsed.args);
  assert.equal(result.status, 'succeeded');
  assert.match(result.summary.slice(0, 80), /^目标东方 \(1,64,0\)；坐标前=N；站到了 \[0,0,1\]/);
  assert.deepEqual(result.data?.targetFrom, { x: 0, y: 64, z: 0 });
  assert.deepEqual(result.data?.position, { x: 1.5, y: 64, z: 0.5 });
  assert.deepEqual(result.data?.targetCell, { x: 1, y: 64, z: 0 });
});

test('blocked steps identify the target without claiming that the body reached it', async (t) => {
  const { world, ctx } = setup();
  t.after(() => ctx.memory.close());
  world.setBlock({ x: 0, y: 64, z: -1 }, 'stone');
  world.setBlock({ x: 0, y: 65, z: -1 }, 'stone');
  const parsed = step.validate({ to: [1, 0, 0], facing: 'N' }, world);
  assert.ok(parsed.ok);
  const result = await step.run(ctx, parsed.args);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.match(result.summary.slice(0, 80), /^目标北方 \(0,64,-1\)；坐标前=N；迈不到 \[1,0,0\]/);
  assert.equal(result.data?.movementNotAttempted, true);
  assert.deepEqual(result.data?.position, { x: 0.5, y: 64, z: 0.5 });
  assert.deepEqual(world.actions, []);
});

test('placement reports the diagonal target, independently of its coordinate reference axis', async (t) => {
  const { world, ctx } = setup();
  t.after(() => ctx.memory.close());
  world.inv.set('dirt', 1);
  const parsed = place.validate({ at: [1, 0, 1], facing: 'E', item: 'dirt' }, world);
  assert.ok(parsed.ok);
  const result = await place.run(ctx, parsed.args);
  assert.equal(result.status, 'succeeded');
  assert.match(result.summary.slice(0, 80), /^目标东南方 \(1,64,1\)；坐标前=E；/);
  assert.match(result.summary, /\[1,0,1\]/);
  assert.equal(world.blockAt({ x: 1, y: 64, z: 1 }), 'dirt');
});

test('absolute targets stay fixed while the reported direction uses the position at execution', async (t) => {
  const { world, ctx } = setup();
  t.after(() => ctx.memory.close());
  const parsed = dig.validate({ xyz: [0, 64, 1], facing: 'W' }, world);
  assert.ok(parsed.ok);
  world.pos = { x: 1.5, y: 64, z: 0.5 };
  const result = await dig.run(ctx, parsed.args);
  assert.equal(result.status, 'succeeded');
  assert.match(result.summary.slice(0, 80), /^目标西南方 \(0,64,1\)；坐标前=W；/);
  assert.deepEqual(result.data?.targetFrom, { x: 1, y: 64, z: 0 });
  assert.deepEqual(result.data?.targetCell, { x: 0, y: 64, z: 1 });
  assert.equal(result.data?.noop, true);
});

test('vertical targets and placing in the original foot cell do not invent a horizontal direction', async (t) => {
  const { world, ctx } = setup();
  t.after(() => ctx.memory.close());
  const above = dig.validate({ at: [0, 2, 0], facing: 'S' }, world);
  assert.ok(above.ok);
  const cleared = await dig.run(ctx, above.args);
  assert.match(cleared.summary.slice(0, 80), /^目标正上2格 \(0,66,0\)；坐标前=S；/);
  world.inv.set('dirt', 1);
  const pillar = place.validate({ at: [0, 0, 0], facing: 'W', item: 'dirt' }, world);
  assert.ok(pillar.ok);
  const placed = await place.run(ctx, pillar.args);
  assert.equal(placed.status, 'succeeded');
  assert.match(placed.summary.slice(0, 80), /^目标原脚格 \(0,64,0\)；坐标前=W；原地垫了一块/);
  assert.deepEqual(placed.data?.targetCell, { x: 0, y: 64, z: 0 });
  assert.deepEqual(placed.data?.position, { x: 0.5, y: 65, z: 0.5 });
});

test('water-exit feedback uses the actual landing height selected by the existing executor', async (t) => {
  const { world, ctx } = setup();
  t.after(() => ctx.memory.close());
  world.inWater = true;
  world.setBlock({ x: 0, y: 64, z: 0 }, 'water');
  world.setBlock({ x: 0, y: 64, z: -1 }, 'stone');
  const parsed = step.validate({ to: [1, 0, 0], facing: 'N' }, world);
  assert.ok(parsed.ok);
  const result = await step.run(ctx, parsed.args);
  assert.equal(result.status, 'succeeded');
  assert.match(result.summary.slice(0, 80), /^目标北方、上1格 \(0,65,-1\)；坐标前=N；从水里爬上了岸 \[1,1,0\]/);
  assert.deepEqual(result.data?.targetCell, { x: 0, y: 65, z: -1 });
  assert.deepEqual(result.data?.targetFrom, { x: 0, y: 64, z: 0 });
});

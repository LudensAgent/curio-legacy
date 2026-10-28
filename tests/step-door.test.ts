import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepTo } from '../src/skills/primitives.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('step checks the door collision shape at the destination and delegates the route', async (t) => {
  const world = new FakeAdapter();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  const door = [{ x: 0, y: 65, z: -1 }, { x: 0, y: 66, z: -1 }];
  world.blocks.push({ name: 'grass_block', pos: { x: 0, y: 64, z: -1 } }, ...door.map((pos) => ({ name: 'oak_door', pos })));
  door.forEach((p) => world.blockProperties.set(`${p.x},${p.y},${p.z}`, { open: true }));
  const originalOptics = world.blockOptics.bind(world);
  let centralCollision = false;
  t.mock.method(world, 'blockOptics', (x, y, z) => door.some((p) => p.x === x && p.y === y && p.z === z)
    ? { name: 'oak_door', kind: 'solid', shapes: [[0, 0, 0, centralCollision ? 0.4 : 0.1875, 1, 1]] } : originalOptics(x, y, z));
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  const move = t.mock.method(world, 'moveTo', world.moveTo.bind(world));
  centralCollision = true;
  const blocked = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(blocked.status, 'failed');
  assert.equal(move.mock.callCount(), 0);
  centralCollision = false;
  door.forEach((p) => world.blockProperties.set(`${p.x},${p.y},${p.z}`, {}));
  const unknown = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(unknown.status, 'failed');
  assert.equal(move.mock.callCount(), 0);
  door.forEach((p) => world.blockProperties.set(`${p.x},${p.y},${p.z}`, { open: false }));
  const closed = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(closed.status, 'succeeded', closed.summary);
  assert.equal(move.mock.callCount(), 1);
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  door.forEach((p) => world.blockProperties.set(`${p.x},${p.y},${p.z}`, { open: true }));
  const result = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(move.mock.callCount(), 2);
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  move.mock.mockImplementation(async () => { throw new Error('No path: route blocked'); });
  const blockedRoute = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(blockedRoute.status, 'failed');
  assert.match(blockedRoute.summary, /route blocked/);
});

test('step does not call an unseen cell an obstruction to dig', async (t) => {
  const world = new FakeAdapter();
  world.pos = { x: 0.5, y: 60, z: 0.5 };
  const ctx = makeCtx(world, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const result = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /未看清的格子.*无法确认/);
  assert.doesNotMatch(result.summary, /dig_at|会碰头/);
});

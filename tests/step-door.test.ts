import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepTo } from '../src/skills/primitives.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

test('step treats an open door as passable and a closed or unknown door as blocked', async (t) => {
  const world = new FakeAdapter();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  const door = [{ x: 0, y: 65, z: -1 }, { x: 0, y: 66, z: -1 }];
  world.blocks.push({ name: 'grass_block', pos: { x: 0, y: 64, z: -1 } }, ...door.map((pos) => ({ name: 'oak_door', pos })));
  const ctx = makeCtx(world, { senses: { observeBlocks: observeAllBlocks(world) } });
  t.after(() => ctx.memory.close());
  const move = t.mock.method(world, 'moveTo', world.moveTo.bind(world));
  // 门打开：可穿行
  door.forEach((p) => world.blockProperties.set(`${p.x},${p.y},${p.z}`, { open: true }));
  const open = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(open.status, 'succeeded', open.summary);
  assert.equal(move.mock.callCount(), 1);
  // 门状态未知：当作堵住，不硬闯
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  door.forEach((p) => world.blockProperties.set(`${p.x},${p.y},${p.z}`, {}));
  const unknown = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(unknown.status, 'failed');
  assert.equal(move.mock.callCount(), 1);
  // 门关着：堵住
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  door.forEach((p) => world.blockProperties.set(`${p.x},${p.y},${p.z}`, { open: false }));
  const closed = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(closed.status, 'failed', closed.summary);
  assert.equal(move.mock.callCount(), 1);
  // 打开的门、但路线被别的障碍挡住：如实报错
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  door.forEach((p) => world.blockProperties.set(`${p.x},${p.y},${p.z}`, { open: true }));
  move.mock.mockImplementation(async () => { throw new Error('No path: route blocked'); });
  const blockedRoute = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(blockedRoute.status, 'failed');
  assert.match(blockedRoute.summary, /route blocked/);
});

test('step reports a real loaded blocker without digging or guessing from vision', async (t) => {
  const world = new FakeAdapter();
  world.pos = { x: 0.5, y: 60, z: 0.5 };
  const ctx = makeCtx(world, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const dig = t.mock.method(world, 'dig', async () => ({ ok: true }));
  const result = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /实心方块|会碰头|身体被占住/);
  assert.doesNotMatch(result.summary, /未看清/);
  assert.equal(dig.mock.callCount(), 0);
});

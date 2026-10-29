import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { goTo } from '../src/skills/movement.ts';
import { constrainRecoveryAction } from '../src/skills/recovery.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const require = createRequire(import.meta.url);

test('goto preserves explicit terrain restrictions and rejects inconsistent combinations', () => {
  const adapter = new TestWorld();
  for (const args of [{ dig: true, place: false }, { dig: true, tower: false }, { place: true, tower: true }]) {
    const result = goTo.validate({ target: '2,64,0', ...args }, adapter);
    assert.equal(result.ok, true);
    if (result.ok) for (const [key, value] of Object.entries(args)) assert.equal((result.args as Record<string, unknown>)[key], value);
  }
  for (const args of [{ place: false, tower: true }, { tower: true }, { dig: true, place: false, tower: true }, { place: 'false' }]) {
    assert.equal(goTo.validate({ target: '2,64,0', ...args }, adapter).ok, false);
  }
});

test('goto forwards independent terrain permissions to its movement call', async (t) => {
  for (const [args, expected] of [
    [{ dig: true }, [true, true, true]],
    [{ dig: true, place: false }, [true, false, false]],
    [{ dig: true, tower: false }, [true, true, false]],
    [{ place: true }, [false, true, false]],
    [{ place: true, tower: true }, [false, true, true]],
  ] as const) {
    const adapter = new TestWorld();
    adapter.pos = { x: 0.5, y: 64, z: 0.5 };
    const ctx = makeCtx(adapter);
    t.after(() => ctx.memory.close());
    const calls: Record<string, unknown>[] = [];
    t.mock.method(adapter, 'moveTo', async (_target, options) => { calls.push(options as unknown as Record<string, unknown>); adapter.pos = { x: 2.5, y: 64, z: 0.5 }; });
    const result = await goTo.run(ctx, { target: '2,64,0', ...args });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.deepEqual([!!calls[0].allowTerrainChanges, calls[0].allowPlace, calls[0].allowTower], expected);
  }
});

test('moveTo retains legacy permissions but independently disables scaffolding and towers', async () => {
  const registry = require('minecraft-data')('1.20.1'), { Movements } = require('mineflayer-pathfinder');
  let selected: any;
  const bot: any = { registry, game: { dimension: 'overworld' }, entity: { position: new Vec3(2.5, 64, 0.5) }, inventory: { items: () => [] },
    pathfinder: { setMovements: (m: unknown) => { selected = m; }, goto: async () => {} } };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = registry;
  (adapter as any).connectedFlag = true; (adapter as any).normalMovements = new Movements(bot);
  (adapter as any).normalMovements.allow1by1towers = true;
  const opts = { signal: new AbortController().signal, timeoutMs: 1000 };
  for (const [permissions, dig, place, tower] of [
    [{ allowTerrainChanges: true }, true, true, true],
    [{ allowTerrainChanges: true, allowPlace: false, allowTower: false }, true, false, false],
    [{ allowTerrainChanges: true, allowPlace: true, allowTower: false }, true, true, false],
    [{ allowPlace: true, allowTower: true }, false, true, true],
  ] as const) {
    await adapter.moveTo({ kind: 'xz', x: 2, z: 0, range: 1 }, { ...opts, ...permissions });
    assert.equal(selected.blocksCantBreak.has(registry.blocksByName.stone.id), !dig);
    assert.equal(selected.scafoldingBlocks.length > 0, place);
    assert.equal(selected.allow1by1towers, tower);
  }
});

test('recovery cannot restore restrictions omitted by a nested goto or place a pillar', (t) => {
  const adapter = new TestWorld(), ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  ctx.recovery = { skill: 'goto', args: { target: '2,64,0', dig: true, place: false }, target: { x: 2, y: 64, z: 0 } };
  const nested = constrainRecoveryAction(ctx, 'goto', { target: '2,64,0', dig: true });
  assert.equal(nested.place, false);
  assert.equal(nested.tower, false);
  assert.throws(() => constrainRecoveryAction(ctx, 'goto', { target: '2,64,0', dig: true, place: true }), /没有授权放置/);
  ctx.recovery = { skill: 'goto', args: { target: '2,64,0', dig: true, tower: false }, target: { x: 2, y: 64, z: 0 } };
  assert.throws(() => constrainRecoveryAction(ctx, 'place_at', { at: [0, 0, 0], item: 'stone' }), /没有授权搭柱/);
  assert.doesNotThrow(() => constrainRecoveryAction(ctx, 'place_at', { at: [0, 0, 0], item: 'torch' }));
});

test('a known pillar blockage ends goto without trying an old passage or doors', async (t) => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 40, z: 0.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  ctx.memory.setWorld(adapter.worldId);
  ctx.memory.savePassage({ id: 'p', worldId: adapter.worldId, dim: adapter.dim, entrances: [], deepestY: 40, dug: 12, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [0, 3, 6, 9, 12].map((x) => ({ x, y: 40, z: 0 })) });
  let calls = 0;
  t.mock.method(adapter, 'moveTo', async (target, options) => {
    calls++;
    assert.deepEqual(target, { kind: 'near', pos: { x: 12, y: 40, z: 0 }, range: 0 });
    assert.equal(options.allowPlace, true);
    assert.equal(options.allowTower, false);
    const error = new Error('No path: 原地搭柱头顶跳跃空间受阻，未放置方块');
    error.name = 'PillarClearanceError';
    throw error;
  });
  const result = await goTo.run(ctx, { target: '12,40,0', dig: true, tower: false });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /原地搭柱头顶跳跃空间受阻/);
});

test('goto preserves placement restrictions when historical passage points are nearby', async (t) => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 40, z: 0.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  ctx.memory.setWorld(adapter.worldId);
  ctx.memory.savePassage({ id: 'p', worldId: adapter.worldId, dim: adapter.dim, entrances: [], deepestY: 40, dug: 12, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [0, 3, 6, 9, 12].map((x) => ({ x, y: 40, z: 0 })) });
  const calls: { allowPlace?: boolean; allowTower?: boolean }[] = [];
  const original = adapter.moveTo.bind(adapter);
  t.mock.method(adapter, 'moveTo', async (target, options) => { calls.push(options); await original(target, options); });
  const result = await goTo.run(ctx, { target: '12,40,0', dig: true, place: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(calls.length, 1);
  for (const call of calls) assert.deepEqual([call.allowPlace, call.allowTower], [false, false]);
});

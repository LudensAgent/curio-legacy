import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import minecraftData from 'minecraft-data';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { GameAdapter, GuiContainerObservation, GuiResult, Vec3Like } from '../src/adapter/types.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { breakCell } from '../src/skills/body.ts';
import { useGui } from '../src/skills/gui.ts';
import { mineCell } from '../src/skills/movement/primitives.ts';
import { AbortedError } from '../src/util.ts';
import { TestWorld, makeCtx } from './survival-helpers.ts';

const require = createRequire(import.meta.url);
const registry = minecraftData('1.20.1'), ItemType = require('prismarine-item')('1.20.1') as typeof Item;
const pos = { x: 1, y: 64, z: 0 };

function guiWorld(run: NonNullable<GameAdapter['useGui']>) {
  const world = Object.assign(new TestWorld(), { useGui: run });
  world.setBlock(pos, 'chest');
  const ctx = makeCtx(world, { senses: { observeBlocks: (positions) => positions.map((p) => ({ name: world.blockAt(p) ?? 'air', properties: {}, pos: p,
    worldId: world.worldId, dimension: world.dim, sessionId: world.sessionId, observationId: 1, observedAt: Date.now(), source: 'vision' })) } });
  ctx.memory.setWorld(world.worldId);
  return { world, ctx };
}

function containerFixture(blockName = 'chest') {
  const slots: (Item | null)[] = Array.from({ length: 63 }, () => null);
  const window = { id: 7, type: 'minecraft:generic_9x3', inventoryStart: 27, slots, selectedItem: null as Item | null,
    containerItems: () => slots.slice(0, 27).filter((item): item is Item => item !== null), close() {} };
  const playerSlots: (Item | null)[] = Array.from({ length: 46 }, () => null);
  const block = { name: blockName, position: new Vec3(pos.x, pos.y, pos.z) };
  const inventory = { slots: playerSlots, selectedItem: null, items: () => slots.slice(27).filter((item): item is Item => item !== null) };
  const bot = Object.assign(new EventEmitter(), {
    game: { dimension: 'overworld' }, entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0 }, inventory,
    _client: { write() {} },
    blockAt: (p: Vec3Like) => p.y === pos.y ? block : { name: 'air', boundingBox: 'empty' },
    async openBlock() { return window; }, async openContainer() { return window; }, closeWindow() {}, async _syncWindow() {},
    async clickWindow(slot: number, button: number, mode: number) {
      if (mode === 1) {
        const [start, end] = slot < 27 ? [27, 63] : [0, 27];
        const destination = slots.findIndex((item, at) => at >= start && at < end && item === null);
        if (destination >= 0) { slots[destination] = slots[slot]; slots[slot] = null; }
      } else {
        assert.equal(mode, 0); assert.equal(button, 0);
        const previous = slots[slot]; slots[slot] = window.selectedItem; window.selectedItem = previous;
      }
    },
  });
  const adapter = new MineflayerAdapter({ ...config, ui: { pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 } }, new EventBus());
  adapter.bot = bot; adapter.mcData = registry; Reflect.set(adapter, 'connectedFlag', true);
  adapter.moveTo = async () => {};
  const item = (name: string, count: number) => new ItemType(registry.itemsByName[name].id, count);
  return { adapter, bot, window, slots, item };
}

test('generic GUI memory records confirmed transfers even when a later operation fails', async (t) => {
  const observation: GuiContainerObservation = { block: 'chest', before: [], after: [{ name: 'diamond', count: 2 }], put: [{ name: 'diamond', count: 2 }], took: [] };
  const { ctx } = guiWorld(async () => ({ ok: false, reason: 'NO_ITEM:coal', done: ['first operation completed'], container: observation }));
  t.after(() => ctx.memory.close());
  const result = await useGui.run(ctx, { target: pos, ops: [{ put: { item: 'diamond', count: 64, slot: 0 } }, { put: { item: 'coal', slot: 1 } }] });
  assert.equal(result.status, 'failed');
  const contents = ctx.memory.chests()[0].contents;
  assert.ok(contents.items.some((entry) => entry.name === 'diamond' && entry.count === 2));
  assert.ok(!contents.items.some((entry) => entry.name === 'coal'));
});

test('generic GUI preserves confirmed partial memory on cancellation and ignores unobserved requests', async (t) => {
  const observation: GuiContainerObservation = { block: 'barrel', before: [{ name: 'coal', count: 10 }], after: [{ name: 'coal', count: 7 }], put: [], took: [{ name: 'coal', count: 3 }] };
  const { ctx } = guiWorld(async (_target, _ops, _signal, opts) => {
    opts?.onContainer?.(observation);
    throw new AbortedError('cancelled after an acknowledged click');
  });
  t.after(() => ctx.memory.close());
  await assert.rejects(useGui.run(ctx, { target: pos, ops: [{ take: { slot: 0 } }] }), { name: 'AbortedError' });
  assert.equal(ctx.memory.chests()[0].contents.items.find((entry) => entry.name === 'coal')?.count, 7);
  assert.equal(ctx.memory.chests()[0].block, 'barrel', '记录容器类型');
  const refused = guiWorld(async (): Promise<GuiResult> => ({ ok: false, reason: 'NOT_OPENABLE', done: [] }));
  t.after(() => refused.ctx.memory.close());
  await useGui.run(refused.ctx, { target: pos, ops: [{ put: { item: 'diamond', slot: 0 } }] });
  assert.equal(refused.ctx.memory.chests().length, 0);
});

test('adapter GUI observes generic chest windows and raw shift clicks rather than requested counts', async () => {
  const f = containerFixture(), observations: GuiContainerObservation[] = [];
  f.slots[27] = f.item('diamond', 2);
  const result = await f.adapter.useGui(pos, [{ click: { slot: 27, button: 0, mode: 1 } }, { put: { item: 'coal', slot: 1, count: 64 } }], new AbortController().signal,
    { onContainer: (observation) => observations.push(observation) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_ITEM:coal');
  assert.deepEqual(result.container?.before, []);
  assert.deepEqual(result.container?.after, [{ name: 'diamond', count: 2 }]);
  assert.deepEqual(result.container?.put, [{ name: 'diamond', count: 2 }]);
  assert.deepEqual(result.container?.took, []);
  assert.equal(observations.length, 1);
});

test('adapter GUI does not make position-specific inventory memories for ender chests', async () => {
  const f = containerFixture('ender_chest'), observations: GuiContainerObservation[] = [];
  f.slots[0] = f.item('diamond', 2);
  const result = await f.adapter.useGui(pos, [], new AbortController().signal, { onContainer: (observation) => observations.push(observation) });
  assert.equal(result.ok, true);
  assert.equal(result.container, undefined);
  assert.deepEqual(observations, []);
  assert.equal(result.view?.slots[0].count, 2, 'the live window remains fully observable');
});

test('adapter GUI reports an acknowledged deposit when cancelled before the next operation', async () => {
  const f = containerFixture(), controller = new AbortController(), observations: GuiContainerObservation[] = [];
  f.slots[27] = f.item('diamond', 2);
  f.bot._syncWindow = async () => {
    if (f.slots[0]?.name === 'diamond') setTimeout(() => controller.abort('stop after deposit'), 0);
  };
  await assert.rejects(f.adapter.useGui(pos, [{ put: { item: 'diamond', slot: 0 } }, { put: { item: 'coal', slot: 1 } }], controller.signal,
    { onContainer: (observation) => observations.push(observation) }), { name: 'AbortedError' });
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0].put, [{ name: 'diamond', count: 2 }]);
  assert.deepEqual(observations[0].after, [{ name: 'diamond', count: 2 }]);
});

test('dedicated chest adapter reports acknowledged partial deposits for shulker boxes', async () => {
  const f = containerFixture('blue_shulker_box');
  f.slots[27] = f.item('diamond', 10);
  Object.assign(f.window, { async deposit() { f.slots[0] = f.item('diamond', 2); f.slots[27] = f.item('diamond', 8); } });
  const result = await f.adapter.useChest(pos, [{ name: 'diamond', count: 10 }], [], new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(result.moved, 2);
  assert.deepEqual(result.container?.put, [{ name: 'diamond', count: 2 }]);
  assert.deepEqual(result.contents, [{ name: 'diamond', count: 2 }]);
});

test('dedicated chest holds its opening and result once while depositing a whole stack in one transfer', async () => {
  const f = containerFixture(), times: Record<string, number> = {}, calls: number[] = [];
  Reflect.get(f.adapter, 'cfg').ui = { pacingMs: 0, openHoldMs: 45, closeHoldMs: 60 };
  f.slots[27] = f.item('diamond', 64);
  f.bot.openBlock = async () => { times.open = Date.now(); return f.window; };
  f.bot.openContainer = async () => f.bot.openBlock();
  f.window.close = () => { times.close = Date.now(); };
  Object.assign(f.window, { async deposit(_type: number, _metadata: null, count: number) {
    times.transfer = Date.now(); calls.push(count);
    f.slots[0] = f.slots[27]; f.slots[27] = null;
  } });
  Reflect.get(f.adapter, 'installUiPacing').call(f.adapter, f.bot);
  const result = await f.adapter.useChest(pos, [{ name: 'diamond', count: 64 }], [], new AbortController().signal);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [64]);
  assert.ok(times.transfer - times.open >= 40, 'the viewer can see the opened chest before the transfer');
  assert.ok(times.close - times.transfer >= 55, 'the viewer can see the result before the chest closes');
});

test('dedicated chest adapter preserves an acknowledged first transfer when the next is cancelled', async () => {
  const f = containerFixture(), observations: GuiContainerObservation[] = [];
  f.slots[27] = f.item('diamond', 10); f.slots[28] = f.item('coal', 3);
  Object.assign(f.window, { async deposit(type: number) {
    if (type === registry.itemsByName.coal.id) throw new AbortedError('stop before second transfer');
    f.slots[0] = f.item('diamond', 2); f.slots[27] = f.item('diamond', 8);
  } });
  await assert.rejects(f.adapter.useChest(pos, [{ name: 'diamond', count: 10 }, { name: 'coal', count: 3 }], [], new AbortController().signal,
    { onContainer: (observation) => observations.push(observation) }), { name: 'AbortedError' });
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0].put, [{ name: 'diamond', count: 2 }]);
});

test('dig_at clears only the removed chest and its impressions, leaving an adjacent chest intact', async (t) => {
  const world = new TestWorld(), ctx = makeCtx(world, { senses: { observeBlocks: (positions) => positions.map((p) => ({ name: world.blockAt(p) ?? 'air', properties: {}, pos: p,
    worldId: world.worldId, dimension: world.dim, sessionId: world.sessionId, observationId: 1, observedAt: Date.now(), source: 'vision' })) } });
  t.after(() => ctx.memory.close()); ctx.memory.setWorld(world.worldId);
  const next = { ...pos, z: 1 };
  [pos, next].forEach((p) => {
    world.setBlock(p, 'chest'); ctx.memory.addLandmark('discovery', '我的箱子', world.dim, p, 0);
    ctx.memory.noteChestUse(world.dim, p, { put: [{ name: 'coal', count: 2 }] });
  });
  ctx.memory.addLandmark('waypoint', '装矿石的（chest）', world.dim, pos, 0);
  world.dig = async (p) => { world.setBlock(p, 'air'); world.inv.set('chest', 1); return { ok: true }; };
  const result = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E', own: true });
  assert.equal(result.status, 'succeeded');
  assert.equal(ctx.memory.chestAt(world.dim, pos), undefined);
  assert.ok(ctx.memory.chestAt(world.dim, next));
  assert.deepEqual(ctx.memory.landmarks().map((landmark) => landmark.pos), [next]);
});

test('basic dig leaves memory on refusal, and records confirmed removal even when subsequently cancelled', async (t) => {
  const world = new TestWorld(), ctx = makeCtx(world);
  t.after(() => ctx.memory.close()); ctx.memory.setWorld(world.worldId);
  world.setBlock(pos, 'furnace'); ctx.memory.addLandmark('discovery', '我的熔炉', world.dim, pos);
  ctx.memory.setFurnace({ dim: world.dim, pos, block: 'furnace', input: { name: 'iron_ore', count: 2 }, output: null, fuel: null, burning: false });
  world.dig = async () => ({ ok: false, reason: 'OUT_OF_REACH' });
  await assert.rejects(breakCell(ctx, pos, true), /OUT_OF_REACH/);
  assert.equal(ctx.memory.landmarks().length, 1); assert.equal(ctx.memory.furnaces().length, 1);
  world.dig = async (p) => { world.setBlock(p, 'air'); throw new AbortedError('cancelled after confirmed removal'); };
  await assert.rejects(breakCell(ctx, pos, true), { name: 'AbortedError' });
  assert.equal(ctx.memory.landmarks().length, 0); assert.equal(ctx.memory.furnaces().length, 0);
});

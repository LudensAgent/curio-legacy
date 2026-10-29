import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.20.1');
const Item = require('prismarine-item')(registry), { createWindow } = require('prismarine-windows')(registry), { Vec3 } = require('vec3');
const stone = registry.itemsByName.cobblestone.id;

function fixture(ui = { pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 }) {
  const inventory = createWindow(0, 'minecraft:inventory', ''), clicks: number[][] = [], dropped: { count: number; nbt: unknown }[] = [];
  const bot: any = { inventory, currentWindow: null, entity: { position: new Vec3(0, 64, 0), yaw: 0 }, game: { dimension: 'overworld' }, _syncWindow: async () => {} };
  bot.clickWindow = async (slot: number, button: number, mode: number) => {
    await bot.beforeWindowClick?.(slot, button, mode);
    const source = slot === -999 ? inventory.selectedItem : inventory.slots[slot];
    const previous = slot === -999 ? inventory.selectedItem?.count : inventory.slots[slot]?.count;
    const data = source?.nbt;
    inventory.acceptClick({ slot, mouseButton: button, mode, item: slot === -999 ? null : inventory.slots[slot] });
    const after = slot === -999 ? inventory.selectedItem?.count : inventory.slots[slot]?.count;
    if (slot === -999 || mode === 4) dropped.push({ count: previous - (after ?? 0), nbt: data });
    clicks.push([slot, button, mode]);
  };
  const adapter = new MineflayerAdapter({ ...config, ui }, new EventBus());
  adapter.bot = bot; adapter.mcData = registry; Reflect.set(adapter, 'connectedFlag', true);
  const put = (slot: number, count: number, nbt: unknown = null) => inventory.updateSlot(slot, new Item(stone, count, 0, nbt));
  const fill = () => { for (let slot = 9; slot <= 44; slot++) if (!inventory.slots[slot]) inventory.updateSlot(slot, new Item(registry.itemsByName.dirt.id, 64)); };
  return { adapter, inventory, bot, clicks, dropped, put, fill };
}

test('window holds apply once to a whole-stack toss, without splitting the stack', async () => {
  const f = fixture({ pacingMs: 0, openHoldMs: 40, closeHoldMs: 50 });
  f.put(9, 64);
  const times: Record<string, number> = {};
  f.adapter.on('inventory_open', () => { times.open = Date.now(); });
  f.adapter.on('inventory_close', () => { times.close = Date.now(); });
  const acceptClick = f.inventory.acceptClick.bind(f.inventory);
  f.inventory.acceptClick = (...args: Parameters<typeof acceptClick>) => { times.click = Date.now(); return acceptClick(...args); };
  const result = await f.adapter.tossItem('cobblestone', 64, new AbortController().signal);
  assert.equal(result.tossed, 64);
  assert.deepEqual(f.dropped.map((item) => item.count), [64]);
  assert.deepEqual(f.clicks, [[9, 1, 4]]);
  assert.ok(times.click - times.open >= 35);
  assert.ok(times.close - times.click >= 45);
});

test('one complete identical stack is preferred over a partial stack for a 64-item request', async () => {
  const f = fixture(); f.put(9, 1); f.put(10, 64); f.fill();
  const presentation: string[] = [];
  f.adapter.on('inventory_open', () => presentation.push('open'));
  f.adapter.on('inventory_close', () => presentation.push('close'));
  const result = await f.adapter.tossItem('cobblestone', 64, new AbortController().signal);
  assert.equal(result.tossed, 64); assert.deepEqual(f.clicks, [[10, 1, 4]]);
  assert.equal(f.inventory.slots[9].count, 1); assert.equal(f.inventory.slots[10], null);
  assert.deepEqual(f.dropped.map((x) => x.count), [64]);
  assert.deepEqual(presentation, ['open', 'close']);
});

test('partial stack is split and discarded once, including in a full inventory', async () => {
  for (const count of [32, 63, 40]) {
    const f = fixture(); f.put(9, 64); f.fill();
    const result = await f.adapter.tossItem('cobblestone', count, new AbortController().signal, undefined, { sourceSlot: 9 });
    assert.equal(result.tossed, count); assert.equal(f.inventory.slots[9].count, 64 - count);
    assert.equal(f.inventory.selectedItem, null); assert.deepEqual(f.dropped.map((x) => x.count), [count]);
    assert.ok(f.clicks.length < count, `${count}: ${f.clicks.length} clicks`);
  }
});

test('small partial quantities are discarded as one exact stack', async () => {
  for (const count of [2, 10]) {
    const f = fixture(); f.put(9, 64); f.fill();
    const result = await f.adapter.tossItem('cobblestone', count, new AbortController().signal, undefined, { sourceSlot: 9 });
    assert.equal(result.tossed, count); assert.equal(f.inventory.slots[9].count, 64 - count);
    assert.equal(f.inventory.selectedItem, null); assert.deepEqual(f.dropped.map((x) => x.count), [count]);
    assert.equal(f.clicks.filter(([slot]) => slot === -999).length, 1);
  }
});

test('bulk selection preserves the original NBT-specific requested quantities', async () => {
  const f = fixture();
  const a = { type: 'compound', value: { variant: { type: 'string', value: 'a' } } };
  const b = { type: 'compound', value: { variant: { type: 'string', value: 'b' } } };
  f.put(9, 1, a); f.put(10, 64, b); f.put(11, 64, a); f.fill();
  const result = await f.adapter.tossItem('cobblestone', 40, new AbortController().signal);
  assert.equal(result.tossed, 40); assert.deepEqual(f.dropped.map((x) => [x.count, x.nbt]), [[1, a], [39, b]]);
  assert.equal(f.inventory.slots[10].count, 25); assert.equal(f.inventory.slots[11].count, 64);
});

test('cancel during splitting restores the same source even with no empty inventory slot', async () => {
  for (const stopAt of [1, 2]) {
    const f = fixture(); f.put(9, 64); f.fill();
    const controller = new AbortController(), click = f.bot.clickWindow;
    f.bot.clickWindow = async (...args: number[]) => { await click(...args); if (f.clicks.length === stopAt) controller.abort(); };
    await assert.rejects(f.adapter.tossItem('cobblestone', 63, controller.signal, undefined, { sourceSlot: 9 }), { name: 'AbortedError' });
    await Reflect.get(f.adapter, 'interactionReady').call(f.adapter);
    assert.equal(f.inventory.selectedItem, null); assert.equal(f.inventory.slots[9].count, 64);
    assert.deepEqual(f.dropped, []);
  }
});

test('a cancelled split is not repaired until its in-flight click has finished', async () => {
  const f = fixture(); f.put(9, 64); f.fill();
  const controller = new AbortController(), click = f.bot.clickWindow;
  let release: () => void = () => {}, started: () => void = () => {};
  const clickStarted = new Promise<void>((resolve) => { started = resolve; });
  const waitForAck = new Promise<void>((resolve) => { release = resolve; });
  f.bot.clickWindow = async (...args: number[]) => { await click(...args); if (f.clicks.length === 1) { started(); await waitForAck; } };
  const pending = f.adapter.tossItem('cobblestone', 32, controller.signal, undefined, { sourceSlot: 9 });
  await clickStarted; controller.abort();
  await assert.rejects(pending, { name: 'AbortedError' });
  const ready = Reflect.get(f.adapter, 'interactionReady').call(f.adapter);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.clicks.length, 1, 'recovery did not race the in-flight click');
  assert.equal(f.inventory.selectedItem.count, 32);
  release(); await ready;
  assert.equal(f.inventory.selectedItem, null); assert.equal(f.inventory.slots[9].count, 64);
  assert.deepEqual(f.dropped, []);
});

test('rollback before the final toss cannot discard an unconfirmed cursor', async () => {
  const f = fixture(); f.put(9, 64); f.fill();
  let syncs = 0;
  f.bot._syncWindow = async () => { if (++syncs === 1) { f.inventory.selectedItem = null; f.put(9, 64); } };
  await assert.rejects(f.adapter.tossItem('cobblestone', 32, new AbortController().signal, undefined, { sourceSlot: 9 }), /TOSS_STATE_CHANGED/);
  await Reflect.get(f.adapter, 'interactionReady').call(f.adapter);
  assert.deepEqual(f.dropped, []); assert.equal(f.inventory.slots[9].count, 64);
});

test('server rollback after a bulk toss is not reported as a confirmed discard', async () => {
  const f = fixture(); f.put(9, 64); f.fill();
  let syncs = 0;
  f.bot._syncWindow = async () => { if (++syncs === 2) { f.inventory.selectedItem = null; f.put(9, 64); } };
  const result = await f.adapter.tossItem('cobblestone', 32, new AbortController().signal, undefined, { sourceSlot: 9 });
  assert.equal(result.ok, false); assert.equal(result.tossed, 0); assert.equal(result.reason, 'TOSS_NOT_CONFIRMED');
  assert.equal(f.inventory.slots[9].count, 64);
});

test('a changed source cannot be overwritten during recovery and blocks subsequent inventory work', async () => {
  const f = fixture(); f.put(9, 64); f.fill();
  const controller = new AbortController(), click = f.bot.clickWindow;
  f.bot.clickWindow = async (...args: number[]) => { await click(...args); if (f.clicks.length === 1) { f.inventory.updateSlot(9, new Item(registry.itemsByName.dirt.id, 64)); controller.abort(); } };
  await assert.rejects(f.adapter.tossItem('cobblestone', 32, controller.signal, undefined, { sourceSlot: 9 }), { name: 'AbortedError' });
  await assert.rejects(f.adapter.tossItem('cobblestone', 1, new AbortController().signal), /INTERACTION_DIRTY/);
  assert.equal(f.inventory.slots[9].name, 'dirt'); assert.equal(f.inventory.selectedItem.count, 32); assert.deepEqual(f.dropped, []);
});

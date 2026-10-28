import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import minecraftData from 'minecraft-data';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { useGui as guiSkill } from '../src/skills/gui.ts';

const require = createRequire(import.meta.url);
const registry = minecraftData('1.20.1'), ItemType = require('prismarine-item')('1.20.1') as typeof Item;
const flush = () => setImmediate();

function fixture(type = 'anvil', inventoryStart = 3) {
  const slots: (Item | null)[] = Array.from({ length: inventoryStart + 36 }, () => null);
  const playerSlots: (Item | null)[] = Array.from({ length: 46 }, () => null);
  const window = { id: 7, type: `minecraft:${type}`, inventoryStart, slots, selectedItem: null as Item | null };
  const inventory = { id: 0, type: 'minecraft:inventory', inventoryStart: 9, slots: playerSlots, selectedItem: null as Item | null,
    items: () => playerSlots.slice(9, 45).filter((item): item is Item => item !== null), emptySlotCount: () => playerSlots.slice(9, 45).filter((item) => !item).length };
  let active: Pick<typeof window, 'slots' | 'selectedItem'> = inventory;
  let texts = ['旧文字\n\n\n', '背面\n\n\n'];
  const position = new Vec3(2, 64, 0), block = { name: type, position, getSignText: () => texts };
  const packets: { name: string; data: Record<string, unknown> }[] = [], clicks: number[][] = [], opens: number[] = [], syncs: number[] = [];
  let onWrite = (_name: string, _data: Record<string, unknown>) => {};
  const entities: Record<number, { id: number; name: string; position: Vec3 }> = {};
  const bot = Object.assign(new EventEmitter(), {
    game: { dimension: 'overworld' }, entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0 }, entities,
    vehicle: null as { id: number } | null, inventory, quickBarSlot: 0,
    get heldItem() { return playerSlots[36]; },
    _client: { write(name: string, data: Record<string, unknown>) { packets.push({ name, data }); onWrite(name, data); } },
    blockAt: () => block,
    async openBlock() { active = window; return window; },
    async openEntity(entity: { id: number }) { opens.push(entity.id); active = window; return window; },
    closeWindow() {},
    async _syncWindow(current: { id: number }) { syncs.push(current.id); },
    async clickWindow(slot: number, button: number, mode: number) {
      clicks.push([slot, button, mode]);
      assert.equal(mode, 0);
      if (button === 0) { const item = active.slots[slot]; active.slots[slot] = active.selectedItem; active.selectedItem = item; }
      else {
        assert.ok(active.selectedItem);
        const held = active.selectedItem;
        const previous = active.slots[slot];
        active.slots[slot] = new ItemType(held.type, (previous?.count ?? 0) + 1, held.metadata, held.nbt ?? undefined);
        held.count--;
        if (!held.count) active.selectedItem = null;
      }
    },
    async activateBlock() { bot.emit('signOpen', block); },
    updateSign(_block: unknown, text: string, back: boolean) {
      bot._client.write('update_sign', { location: position, isFrontText: !back, lines: text.split('\n') });
    },
    getEquipmentDestSlot: () => 36,
    async equip(item: Item) { playerSlots[36] = item; if (item.slot !== 36) playerSlots[item.slot] = null; },
    clearControlStates() {}, deactivateItem() {}, pathfinder: { stop() {}, setGoal() {} },
  });
  // Object.assign evaluates getters, so keep the held item tied to actual slots.
  Object.defineProperty(bot, 'heldItem', { get: () => playerSlots[36] });
  const adapter = new MineflayerAdapter({ ...config, ui: { pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 } }, new EventBus());
  adapter.bot = bot; adapter.mcData = registry; Reflect.set(adapter, 'connectedFlag', true);
  adapter.moveTo = async () => {};
  const item = (name: string, slot: number, count = 1) => { const value = new ItemType(registry.itemsByName[name].id, count); value.slot = slot; return value; };
  return { adapter, bot, window, playerSlots, position, block, packets, clicks, opens, syncs, item,
    onWrite(handler: typeof onWrite) { onWrite = handler; },
    serverSign(lines: string[], back = false) { texts[back ? 1 : 0] = lines.join('\n'); },
  };
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  return async () => {
    // Each step allows an awaited click/settle/check to schedule its next wait.
    for (let i = 0; i < 10; i++) { await flush(); t.mock.timers.tick(250); }
    await flush();
  };
}

test('anvil rename requires an acknowledged output name and reports a preview before output collection', async (t) => {
  const advance = clock(t), signal = new AbortController().signal;
  for (const accepted of [false, true]) {
    const f = fixture();
    f.window.slots[0] = f.item('diamond_pickaxe', 0);
    f.onWrite((name, data) => {
      if (name !== 'name_item' || !accepted) return;
      const output = f.item('diamond_pickaxe', 2); output.customName = String(data.name); f.window.slots[2] = output;
    });
    const pending = f.adapter.useGui(f.position, [{ rename: '采集工具' }], signal);
    await advance(); const result = await pending;
    assert.equal(result.ok, accepted, result.reason);
    if (accepted) assert.match(result.done.join('；'), /预览.*仍需取出/);
    else { assert.equal(result.reason, 'RENAME_NOT_CONFIRMED'); assert.deepEqual(result.done, []); }
  }
});

test('GUI put selects the requested source NBT stack and raw clicks expose actual cursor changes', async (t) => {
  const advance = clock(t), f = fixture('brewing_stand', 5);
  const poison = f.item('potion', 5), healing = f.item('potion', 6);
  poison.nbt = { type: 'compound', value: { Potion: { type: 'string', value: 'minecraft:poison' } } };
  healing.nbt = { type: 'compound', value: { Potion: { type: 'string', value: 'minecraft:healing' } } };
  f.window.slots[5] = poison; f.window.slots[6] = healing;
  const pending = f.adapter.useGui(f.position, [{ put: { item: 'potion', slot: 0, sourceSlot: 6 } }, { click: { slot: 0, button: 0, mode: 0 } }], new AbortController().signal);
  await advance(); const result = await pending;
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(f.clicks, [[6, 0, 0], [0, 0, 0], [0, 0, 0]]);
  assert.deepEqual(f.syncs, [7, 7, 7], 'every predicted click must be synchronized with the server');
  assert.equal(f.window.slots[5], poison, 'the other same-name stack must remain untouched');
  assert.deepEqual(result.view?.cursor?.nbt, { Potion: 'minecraft:healing' });
  assert.deepEqual(result.view?.slots.find((slot) => slot.slot === 5)?.nbt, { Potion: 'minecraft:poison' });
});

test('GUI take confirms output against the open window inventory', async (t) => {
  const advance = clock(t), f = fixture('brewing_stand', 5);
  f.window.slots[0] = f.item('potion', 0);
  f.bot.clickWindow = async (slot, button, mode) => {
    assert.deepEqual([slot, button, mode], [0, 0, 1]);
    f.window.slots[5] = f.window.slots[0];
    f.window.slots[0] = null;
  };
  const pending = f.adapter.useGui(f.position, [{ take: { slot: 0 } }], new AbortController().signal);
  await advance(); const result = await pending;
  assert.equal(result.ok, true, result.reason);
  assert.match(result.done[0], /potion×1/);
  assert.equal(f.playerSlots[9], null, 'the player inventory is not yet copied from the open window');
});

test('raw GUI clicks fail when neither slots nor cursor actually change', async (t) => {
  const advance = clock(t), f = fixture();
  f.bot.clickWindow = async () => {};
  const pending = f.adapter.useGui(f.position, [{ click: { slot: 3, button: 0, mode: 0 } }], new AbortController().signal);
  await advance(); const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CLICK_NOT_CONFIRMED');
});

test('GUI click confirmation rejects optimistic slot changes that the server synchronization rolls back', async (t) => {
  const advance = clock(t), f = fixture();
  const original = f.item('bread', 3);
  f.window.slots[3] = original;
  f.bot._syncWindow = async () => {
    assert.equal(f.window.slots[3], null, 'the local prediction already picked up the item');
    assert.equal(f.window.selectedItem, original);
    f.window.slots[3] = original;
    f.window.selectedItem = null;
  };
  const pending = f.adapter.useGui(f.position, [{ click: { slot: 3, button: 0, mode: 0 } }], new AbortController().signal);
  await advance(); const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CLICK_NOT_CONFIRMED');
  assert.equal(result.view?.cursor, null);
  assert.equal(result.view?.slots.find((slot) => slot.slot === 3)?.name, 'bread');
});

test('GUI validation rejects modes and buttons unsupported by the installed window implementation', () => {
  const { adapter } = fixture();
  for (const click of [{ slot: 9, button: 0, mode: 5 }, { slot: 9, button: 0, mode: 6 }, { slot: 9, button: 40, mode: 2 }]) {
    assert.equal(guiSkill.validate({ target: 'inventory', ops: [{ click }] }, adapter).ok, false, JSON.stringify(click));
  }
  for (const click of [{ slot: 9, button: 0, mode: 0 }, { slot: 9, button: 1, mode: 1 }, { slot: 9, button: 8, mode: 2 }, { slot: 9, button: 2, mode: 3 }, { slot: 9, button: 1, mode: 4 }]) {
    assert.equal(guiSkill.validate({ target: 'inventory', ops: [{ click }] }, adapter).ok, true, JSON.stringify(click));
  }
});

test('player inventory and entity containers can be opened through the same GUI primitive', async (t) => {
  const advance = clock(t), f = fixture('generic_9x3', 27), signal = new AbortController().signal;
  const lifecycle: string[] = [];
  f.adapter.on('inventory_open', () => lifecycle.push('open'));
  f.adapter.on('inventory_close', () => lifecycle.push('close'));
  f.playerSlots[9] = f.item('bread', 9, 2);
  let pending = f.adapter.useGui('inventory', [{ click: { slot: 9, button: 0, mode: 0 } }], signal);
  await advance(); const inventory = await pending;
  assert.equal(inventory.ok, true, inventory.reason);
  assert.equal(inventory.view?.type, 'inventory');
  assert.equal(inventory.view?.cursor?.name, 'bread');
  assert.deepEqual(lifecycle, ['open', 'close']);
  f.bot.inventory.selectedItem = null;
  f.bot.entities[22] = { id: 22, name: 'chest_minecart', position: new Vec3(2, 64, 0) };
  pending = f.adapter.useGui({ entityId: 22 }, [], signal);
  await advance(); const entity = await pending;
  assert.equal(entity.ok, true, entity.reason);
  assert.deepEqual(f.opens, [22]);
  assert.deepEqual(lifecycle, ['open', 'close'], 'entity windows use Mineflayer window events');
});

test('mounted horse inventory uses the inventory-open entity action and requires the chosen mount', async (t) => {
  const advance = clock(t), f = fixture('horse', 2), signal = new AbortController().signal;
  f.bot.entities[23] = { id: 23, name: 'horse', position: new Vec3(1, 64, 0) };
  const refused = await f.adapter.useGui({ entityId: 23 }, [], signal);
  assert.equal(refused.reason, 'MOUNT_REQUIRED');
  f.bot.vehicle = { id: 23 };
  f.adapter.moveTo = async () => { throw new Error('RIDING'); };
  f.onWrite((name) => { if (name === 'entity_action') f.bot.emit('windowOpen', f.window); });
  const pending = f.adapter.useGui({ entityId: 23 }, [], signal);
  await advance(); const result = await pending;
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(f.packets.find((packet) => packet.name === 'entity_action')?.data, { entityId: 1, actionId: 6, jumpBoost: 0 });
  assert.deepEqual(f.opens, []);
});

test('beacon selection sends its own packet and requires real payment consumption', async (t) => {
  const advance = clock(t), signal = new AbortController().signal;
  for (const consume of [false, true]) {
    const f = fixture('beacon', 1);
    f.window.slots[0] = f.item('iron_ingot', 0);
    f.onWrite((name) => { if (name === 'set_beacon_effect' && consume) f.window.slots[0] = null; });
    const pending = f.adapter.useGui(f.position, [{ beacon: { primary: 1, secondary: null } }], signal);
    await advance(); const result = await pending;
    assert.equal(result.ok, consume, result.reason);
    assert.deepEqual(f.packets.map((packet) => packet.name), ['set_beacon_effect']);
    assert.deepEqual(f.packets[0].data, { primary_effect: 1, secondary_effect: null });
    if (!consume) assert.equal(result.reason, 'BEACON_NOT_CONFIRMED');
  }
});

test('sign reads both sides and writing waits for the server block text to change', async (t) => {
  const advance = clock(t), signal = new AbortController().signal;
  for (const acknowledged of [false, true]) {
    const f = fixture('oak_sign'), lines = ['实验结果', '第二行', '', ''];
    assert.deepEqual((await f.adapter.signText(f.position, signal, { back: true })).lines, ['背面', '', '', '']);
    f.onWrite((name) => { if (name === 'update_sign' && acknowledged) f.serverSign(lines, true); });
    const pending = f.adapter.signText(f.position, signal, { lines, back: true });
    await advance(); const result = await pending;
    assert.equal(result.ok, acknowledged, result.reason);
    assert.equal(f.packets[0]?.name, 'update_sign');
    assert.equal(f.packets[0]?.data.isFrontText, false);
    if (acknowledged) assert.deepEqual(result.lines, lines);
    else assert.equal(result.reason, 'SIGN_NOT_CONFIRMED');
  }
});

test('book editing sends edit_book and requires server NBT instead of trusting a local helper', async (t) => {
  const advance = clock(t), signal = new AbortController().signal;
  for (const acknowledged of [false, true]) {
    const f = fixture(), pages = ['第一页', '第二页'];
    f.playerSlots[9] = f.item('writable_book', 9);
    f.onWrite((name) => {
      if (name !== 'edit_book' || !acknowledged) return;
      const written = f.item('written_book', 36);
      written.nbt = { type: 'compound', value: {
        title: { type: 'string', value: '实验记录' }, pages: { type: 'list', value: { type: 'string', value: pages.map((text) => JSON.stringify({ text })) } },
      } };
      f.playerSlots[36] = written;
    });
    const pending = f.adapter.editBook(9, pages, signal, '实验记录');
    await advance(); const result = await pending;
    assert.equal(result.ok, acknowledged, result.reason);
    assert.deepEqual(f.packets.filter((packet) => packet.name === 'edit_book').map((packet) => packet.data), [{ hand: 0, pages, title: '实验记录' }]);
    if (!acknowledged) { assert.equal(result.reason, 'BOOK_NOT_CONFIRMED'); assert.equal(f.playerSlots[36]?.nbt, null); }
  }
});

test('cancellation while opening a GUI or sign editor prevents late mutation packets', async () => {
  const f = fixture(), controller = new AbortController();
  let resume!: () => void;
  f.bot.openBlock = async () => { await new Promise<void>((resolve) => { resume = resolve; }); return f.window; };
  const pending = f.adapter.useGui(f.position, [{ rename: '不得迟到' }], controller.signal);
  await flush();
  controller.abort('replaced');
  await assert.rejects(pending, { name: 'AbortedError' });
  resume(); await flush();
  assert.deepEqual(f.packets, []);

  const sign = fixture('oak_sign'), cancelled = new AbortController();
  sign.bot.activateBlock = async () => {};
  const editing = sign.adapter.signText(sign.position, cancelled.signal, { lines: ['不得迟到'] });
  await flush(); cancelled.abort('replaced');
  await assert.rejects(editing, { name: 'AbortedError' });
  sign.bot.emit('signOpen', sign.block); await flush();
  assert.deepEqual(sign.packets, []);
  assert.equal(sign.bot.listenerCount('signOpen'), 0);
});

test('cancellation while equipping a book cannot send a late edit_book packet', async () => {
  const f = fixture(), controller = new AbortController();
  f.playerSlots[9] = f.item('writable_book', 9);
  let resume!: () => void;
  f.bot.equip = async (item) => { await new Promise<void>((resolve) => { resume = resolve; }); f.playerSlots[36] = item; };
  const pending = f.adapter.editBook(9, ['不得迟到'], controller.signal);
  await flush(); controller.abort('replaced');
  await assert.rejects(pending, { name: 'AbortedError' });
  resume(); await flush();
  assert.deepEqual(f.packets, []);
});

test('cancellation during GUI synchronization prevents its delayed packet and subsequent edits', async (t) => {
  const advance = clock(t), f = fixture(), controller = new AbortController();
  f.window.slots[3] = f.item('bread', 3);
  let resume!: () => void;
  f.bot._syncWindow = async () => {
    await new Promise<void>((resolve) => { resume = resolve; });
    f.bot._client.write('window_click', { windowId: 7, stateId: -1 });
  };
  const pending = f.adapter.useGui(f.position, [{ click: { slot: 3, button: 0, mode: 0 } }, { rename: '不得迟到' }], controller.signal);
  await advance();
  assert.equal(typeof resume, 'function', 'operation must await server synchronization');
  controller.abort('replaced');
  await assert.rejects(pending, { name: 'AbortedError' });
  resume(); await flush();
  assert.deepEqual(f.packets, []);
});

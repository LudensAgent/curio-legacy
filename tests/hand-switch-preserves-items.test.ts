import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import minecraftData from 'minecraft-data';
import type { Block } from 'prismarine-block';
import type { Item } from 'prismarine-item';
import type { Window, WindowsExports } from 'prismarine-windows';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const registry = minecraftData('1.20.1');
const BlockType = require('prismarine-block')('1.20.1') as typeof Block;
const ItemType = require('prismarine-item')('1.20.1') as typeof Item;
const { createWindow } = require('prismarine-windows')('1.20.1') as WindowsExports;
const injectInventory = require('mineflayer/lib/plugins/simple_inventory') as (bot: object) => void;

function fixture() {
  const inventory = createWindow(0, 'minecraft:inventory', '');
  const clicks: { slot: number; mouseButton: number; mode: number }[] = [];
  const dropped: Item[] = [], used: (string | null)[] = [];
  const dirt = BlockType.fromStateId(registry.blocksByName.dirt.defaultState, 0);
  dirt.position = new Vec3(1, 64, 0);
  const bot = {
    inventory, currentWindow: null as Window | null, quickBarSlot: 0,
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, isInWater: false, effects: {} },
    game: { dimension: 'overworld' },
    _client: { write: (_name: string, _packet: object) => {} },
    _syncWindow: async (_window: Window) => {},
    get heldItem(): Item | null { return inventory.slots[36 + bot.quickBarSlot]; },
    supportFeature: (_name: string) => false,
    updateHeldItem: () => {},
    blockAt: (_position: Vec3) => dirt,
    canDigBlock: (_block: Block) => true,
    dig: async (_block: Block, _forceLook: boolean) => { used.push(bot.heldItem?.name ?? null); },
    stopDigging: () => {},
    clickWindow: async (slot: number, mouseButton: number, mode: number) => {
      if (slot === -999 && inventory.selectedItem) dropped.push(inventory.selectedItem);
      const click = { slot, mouseButton, mode, item: slot === -999 ? null : inventory.slots[slot] };
      clicks.push({ slot, mouseButton, mode });
      inventory.acceptClick(click, 0);
    },
    moveSlotItem: async (source: number, destination: number) => {
      await bot.clickWindow(source, 0, 0);
      await bot.clickWindow(destination, 0, 0);
      if (inventory.selectedItem) await bot.clickWindow(source, 0, 0);
    },
    closeWindow: async (_window: Window) => {},
    equip: async (_item: Item, _destination: string) => {},
    unequip: async (_destination: string) => {},
    tossStack: async (_item: Item) => {},
    setQuickBarSlot: (_slot: number) => {},
  };
  injectInventory(bot);
  const put = (slot: number, name: string) => {
    const item = new ItemType(registry.itemsByName[name].id, 1);
    inventory.updateSlot(slot, item);
    return item;
  };
  Array.from({ length: 36 }, (_, index) => index + 9).forEach((slot) => put(slot, 'diamond_sword'));
  const sword = inventory.slots[36]!;
  sword.durabilityUsed = 17;
  const adapter = new MineflayerAdapter({ ...config, ui: { ...config.ui, openHoldMs: 0, closeHoldMs: 0 } }, new EventBus());
  adapter.bot = bot; adapter.mcData = registry;
  Reflect.set(adapter, 'connectedFlag', true);
  const dig = () => adapter.dig(dirt.position, new AbortController().signal);
  return { adapter, bot, inventory, clicks, dropped, used, put, sword, dig };
}

for (const material of ['dirt', 'cobblestone']) {
  test(`automatic dirt digging switches to existing ${material} in a full inventory without dropping the sword`, async () => {
    const w = fixture();
    w.put(37, material);
    const result = await w.dig();
    assert.equal(result.ok, true);
    assert.deepEqual(w.used, [material]);
    assert.equal(w.inventory.slots[36], w.sword);
    assert.equal(w.sword.slot, 36);
    assert.equal(w.sword.durabilityUsed, 17);
    assert.deepEqual(w.dropped, []);
    assert.ok(w.clicks.every((click) => click.slot !== -999));
    assert.equal(w.inventory.selectedItem, null);
  });
}

test('automatic dirt digging swaps a main-inventory replacement into the full hotbar without losing the sword', async () => {
  const w = fixture();
  const material = w.put(9, 'dirt');
  const result = await w.dig();
  assert.equal(result.ok, true);
  assert.deepEqual(w.used, ['dirt']);
  assert.equal(w.bot.heldItem, material);
  assert.equal(w.inventory.slots[9], w.sword);
  assert.equal(w.inventory.items().filter((item) => item === w.sword).length, 1);
  assert.equal(w.inventory.items().length, 36);
  assert.equal(w.sword.durabilityUsed, 17);
  assert.deepEqual(w.dropped, []);
  assert.ok(w.clicks.length > 0, 'the replacement requires an inventory swap');
  assert.ok(w.clicks.every((click) => click.slot !== -999));
  assert.equal(w.inventory.selectedItem, null);
});

test('automatic dirt digging stops when inventory synchronization rolls back the replacement', async () => {
  const w = fixture();
  const material = w.put(9, 'dirt');
  let synchronized = false;
  w.bot._syncWindow = async (window: Window) => {
    assert.equal(window, w.inventory);
    assert.equal(w.bot.heldItem, material, 'local clicks initially predicted a successful swap');
    window.updateSlot(36, w.sword);
    window.updateSlot(9, material);
    synchronized = true;
  };
  const result = await w.dig();
  assert.equal(synchronized, true);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /EQUIP_NOT_CONFIRMED/);
  assert.deepEqual(w.used, []);
  assert.equal(w.bot.heldItem, w.sword);
  assert.equal(w.inventory.slots[9], material);
  assert.equal(w.sword.durabilityUsed, 17);
  assert.deepEqual(w.dropped, []);
  assert.ok(w.clicks.every((click) => click.slot !== -999));
});

for (const emptySlot of [9, 37]) {
  test(`automatic dirt digging can empty its hand through vacant slot ${emptySlot} without losing the sword`, async () => {
    const w = fixture();
    w.inventory.slots[emptySlot] = null;
    const result = await w.dig();
    assert.equal(result.ok, true);
    assert.deepEqual(w.used, [null]);
    assert.equal(w.inventory.slots[emptySlot === 9 ? 9 : 36], w.sword);
    assert.equal(w.sword.durabilityUsed, 17);
    assert.equal(w.inventory.items().filter((item) => item === w.sword).length, 1);
    assert.deepEqual(w.dropped, []);
    assert.ok(w.clicks.every((click) => click.slot !== -999));
    assert.equal(w.inventory.selectedItem, null);
  });
}

test('automatic dirt digging stops when every inventory slot contains a durable item', async () => {
  const w = fixture();
  const result = await w.dig();
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /INVENTORY_FULL/);
  assert.deepEqual(w.used, []);
  assert.equal(w.bot.heldItem, w.sword);
  assert.equal(w.inventory.slots[36], w.sword);
  assert.equal(w.sword.durabilityUsed, 17);
  assert.deepEqual(w.dropped, []);
  assert.deepEqual(w.clicks, []);
});

test('automatic dirt digging still selects an available shovel before a harmless held item', async () => {
  const w = fixture();
  w.put(37, 'dirt');
  w.put(38, 'iron_shovel');
  const result = await w.dig();
  assert.equal(result.ok, true);
  assert.deepEqual(w.used, ['iron_shovel']);
  assert.equal(w.inventory.slots[36], w.sword);
  assert.equal(w.sword.durabilityUsed, 17);
  assert.deepEqual(w.dropped, []);
});

test('Mineflayer unequip refuses a full inventory without turning it into a toss', async () => {
  const w = fixture();
  await assert.rejects(w.bot.unequip('hand'), /INVENTORY_FULL/);
  assert.equal(w.bot.heldItem, w.sword);
  assert.equal(w.inventory.slots[36], w.sword);
  assert.equal(w.sword.durabilityUsed, 17);
  assert.deepEqual(w.dropped, []);
  assert.deepEqual(w.clicks, []);
});

test('Mineflayer unequip preserves a cursor item when placing it into an empty slot is not confirmed', async (t) => {
  const w = fixture();
  w.inventory.slots[9] = null;
  const clickWindow = w.bot.clickWindow;
  t.mock.method(w.bot, 'clickWindow', async (slot: number, mouseButton: number, mode: number) => {
    if (slot === 9) {
      w.clicks.push({ slot, mouseButton, mode });
      return; // The inventory never acknowledges placing the cursor stack.
    }
    await clickWindow(slot, mouseButton, mode);
  });
  await assert.rejects(w.bot.unequip('hand'), /UNEQUIP_NOT_CONFIRMED/);
  assert.equal(w.inventory.selectedItem, w.sword);
  assert.equal(w.inventory.slots[36], null);
  assert.equal(w.sword.durabilityUsed, 17);
  assert.deepEqual(w.dropped, []);
  assert.deepEqual(w.clicks, [{ slot: 36, mouseButton: 0, mode: 0 }, { slot: 9, mouseButton: 0, mode: 0 }]);
});

test('explicit Mineflayer tossStack still drops the requested sword', async () => {
  const w = fixture();
  await w.bot.tossStack(w.sword);
  assert.deepEqual(w.dropped, [w.sword]);
  assert.equal(w.inventory.slots[36], null);
  assert.equal(w.bot.heldItem, null);
  assert.equal(w.inventory.selectedItem, null);
  assert.deepEqual(w.clicks, [{ slot: 36, mouseButton: 0, mode: 0 }, { slot: -999, mouseButton: 0, mode: 0 }]);
});

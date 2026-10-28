import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { InventorySlot } from '../src/adapter/types.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { holdItem, inspectInventory, tossItem } from '../src/skills/hands.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

type SlotItem = {
  slot: number; name: string; type: number; metadata: number; count: number;
  durabilityUsed?: number; enchants?: { name: string; lvl: number }[]; customName?: string; nbt?: unknown;
};

// Slot movement is optimistic; _syncWindow accepts or rolls back that prediction.
function slotFixture() {
  const slots: (SlotItem | null)[] = Array.from({ length: 46 }, () => null);
  const pick = (slot: number, enchant: string, damage: number): SlotItem => ({ slot, name: 'diamond_pickaxe', type: 700, metadata: 0, count: 1,
    durabilityUsed: damage, enchants: [{ name: enchant, lvl: 1 }],
    nbt: { type: 'compound', value: { enchant: { type: 'string', value: enchant }, Damage: { type: 'int', value: damage } } } });
  slots[9] = pick(9, 'silk_touch', 200);
  slots[36] = pick(36, 'fortune', 1);
  const clicks: number[][] = [], moves: number[][] = [], unequipped: string[] = [], uses: SlotItem[] = [], syncs: unknown[] = [];
  const destination = (to: string) => ({ hand: 36, 'off-hand': 45, head: 5, torso: 6, legs: 7, feet: 8 }[to]);
  const move = (from: number, to: number) => {
    const source = slots[from], previous = slots[to];
    slots[to] = source ? { ...source, slot: to } : null;
    slots[from] = previous ? { ...previous, slot: from } : null;
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0 }, game: { dimension: 'overworld' },
    quickBarSlot: 0,
    get heldItem() { return slots[36 + bot.quickBarSlot]; },
    inventory: { slots, items: () => slots.slice(9, 45).filter((item): item is SlotItem => item !== null), emptySlotCount: () => slots.slice(9, 45).filter((item) => !item).length },
    async _syncWindow(window: unknown) { syncs.push(window); },
    getEquipmentDestSlot: (to: string) => destination(to),
    async equip(item: SlotItem, to: string) { const target = destination(to); assert.notEqual(target, undefined); move(item.slot, target!); },
    async unequip(to: string) { unequipped.push(to); const target = destination(to); assert.notEqual(target, undefined); const empty = slots.findIndex((item, slot) => slot >= 9 && slot <= 44 && !item); assert.ok(empty >= 9); move(target!, empty); },
    async moveSlotItem(from: number, to: number) { moves.push([from, to]); move(from, to); },
    setQuickBarSlot(index: number) { bot.quickBarSlot = index; },
    async clickWindow(slot: number, button: number, mode: number) {
      clicks.push([slot, button, mode]);
      assert.equal(mode, 4);
      const item = slots[slot];
      assert.ok(item);
      if (button === 1 || item.count === 1) slots[slot] = null;
      else slots[slot] = { ...item, count: item.count - 1 };
    },
    async toss() { assert.fail('exact source selection must never fall back to tossing by item type'); },
    activateItem() { const held = slots[36 + bot.quickBarSlot]; assert.ok(held); uses.push(held); },
  };
  const adapter = new MineflayerAdapter({ ...config, ui: { ...config.ui, openHoldMs: 0, closeHoldMs: 0 } }, new EventBus());
  adapter.bot = bot;
  adapter.mcData = { itemsByName: { diamond_pickaxe: { maxDurability: 1561 } } };
  Reflect.set(adapter, 'connectedFlag', true);
  return { adapter, bot, slots, clicks, moves, unequipped, uses, syncs };
}

test('real adapter inventory observation retains slot identity, full enchantments and simplified NBT', () => {
  const { adapter, slots } = slotFixture();
  slots[9]!.customName = '采集';
  slots[10] = { slot: 10, name: 'potion', type: 701, metadata: 0, count: 1, nbt: { type: 'compound', value: { Potion: { type: 'string', value: 'minecraft:poison' } } } };
  slots[11] = { slot: 11, name: 'written_book', type: 702, metadata: 0, count: 1, nbt: { type: 'compound', value: { title: { type: 'string', value: '实验' }, pages: { type: 'list', value: { type: 'string', value: ['{"text":"结果"}'] } } } } };
  slots[12] = { slot: 12, name: 'filled_map', type: 703, metadata: 0, count: 1, nbt: { type: 'compound', value: { map: { type: 'int', value: 42 } } } };
  const observed = adapter.inventorySlots();
  assert.deepEqual(observed.find((item) => item.slot === 9), { slot: 9, name: 'diamond_pickaxe', count: 1, durability: { left: 1361, max: 1561 }, enchants: ['silk_touch 1'], customName: '采集', nbt: { enchant: 'silk_touch', Damage: 200 } });
  assert.deepEqual(observed.find((item) => item.slot === 36)?.enchants, ['fortune 1']);
  assert.deepEqual(observed.find((item) => item.slot === 10)?.nbt, { Potion: 'minecraft:poison' });
  assert.deepEqual(observed.find((item) => item.slot === 11)?.nbt, { title: '实验', pages: ['{"text":"结果"}'] });
  assert.deepEqual(observed.find((item) => item.slot === 12)?.nbt, { map: 42 });
});

test('real adapter equips the selected lower-durability tool and verifies identity instead of a same-name substitute', async () => {
  const { adapter, bot, syncs } = slotFixture(), signal = new AbortController().signal;
  assert.equal((await adapter.equipItem('diamond_pickaxe', 'hand', signal, { sourceSlot: 9 })).ok, true);
  assert.deepEqual(syncs, [bot.inventory]);
  assert.deepEqual(bot.heldItem?.enchants, [{ name: 'silk_touch', lvl: 1 }]);
  const substituted = slotFixture();
  substituted.bot.equip = async () => {};
  const result = await substituted.adapter.equipItem('diamond_pickaxe', 'hand', signal, { sourceSlot: 9 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EQUIP_NOT_CONFIRMED');
  const changed = await substituted.adapter.equipItem('potion', 'hand', signal, { sourceSlot: 9 });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'SOURCE_ITEM_CHANGED');
});

test('server rollback of optimistic equip and hotbar movement cannot be reported as successful', async () => {
  const signal = new AbortController().signal;
  for (const operation of ['equip', 'hotbar', 'unequip']) {
    const f = slotFixture(), original = f.slots.slice();
    f.bot._syncWindow = async () => { original.forEach((item, slot) => { f.slots[slot] = item; }); };
    const result = operation === 'equip' ? await f.adapter.equipItem('diamond_pickaxe', 'hand', signal, { sourceSlot: 9 })
      : operation === 'hotbar' ? await f.adapter.arrangeHotbar('diamond_pickaxe', 0, signal, { sourceSlot: 9 })
      : await f.adapter.equipItem(null, 'hand', signal);
    assert.equal(result.ok, false, operation);
    assert.equal(result.reason, operation === 'equip' ? 'EQUIP_NOT_CONFIRMED' : operation === 'hotbar' ? 'HOTBAR_NOT_CONFIRMED' : 'UNEQUIP_NOT_CONFIRMED');
    assert.deepEqual(f.bot.heldItem?.enchants, [{ name: 'fortune', lvl: 1 }]);
  }
});

test('real adapter replaces a same-name hotbar item with the requested source slot and selects it', async () => {
  const { adapter, bot, moves } = slotFixture();
  const result = await adapter.arrangeHotbar('diamond_pickaxe', 0, new AbortController().signal, { sourceSlot: 9 });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(moves, [[9, 36]]);
  assert.deepEqual(bot.heldItem?.enchants, [{ name: 'silk_touch', lvl: 1 }]);
});

test('inventory clicks expose one virtual window for equip, unequip, toss and hotbar moves', async () => {
  for (const operation of ['equip', 'unequip', 'toss', 'hotbar']) {
    const f = slotFixture(), events: string[] = [];
    f.adapter.on('inventory_open', () => events.push('open'));
    f.adapter.on('inventory_close', () => events.push('close'));
    const originalPacing = async () => { events.push('paced'); };
    (f.bot as any).beforeWindowClick = originalPacing;
    const equip = f.bot.equip, unequip = f.bot.unequip, click = f.bot.clickWindow, move = f.bot.moveSlotItem;
    f.bot.equip = async (...args) => { await (f.bot as any).beforeWindowClick(9, 0, 0); await equip(...args); };
    f.bot.unequip = async (...args) => { await (f.bot as any).beforeWindowClick(36, 0, 0); await unequip(...args); };
    f.bot.clickWindow = async (...args) => { await (f.bot as any).beforeWindowClick(...args); await click(...args); };
    f.bot.moveSlotItem = async (...args) => { await (f.bot as any).beforeWindowClick(args[0], 0, 0); await move(...args); };
    const signal = new AbortController().signal;
    const result = operation === 'equip' ? await f.adapter.equipItem('diamond_pickaxe', 'hand', signal, { sourceSlot: 9 })
      : operation === 'unequip' ? await f.adapter.equipItem(null, 'hand', signal)
      : operation === 'toss' ? await f.adapter.tossItem('diamond_pickaxe', 1, signal, undefined, { sourceSlot: 9 })
      : await f.adapter.arrangeHotbar('diamond_pickaxe', 0, signal, { sourceSlot: 9 });
    assert.equal(result.ok, true, operation);
    assert.deepEqual(events, ['open', 'paced', 'close'], operation);
    assert.equal((f.bot as any).beforeWindowClick, originalPacing);
  }
});

test('inventory presentation closes after a failed click and never opens for a hotbar-only equip', async () => {
  const f = slotFixture(), events: string[] = [];
  f.adapter.on('inventory_open', () => events.push('open'));
  f.adapter.on('inventory_close', () => events.push('close'));
  f.bot.equip = async () => { await (f.bot as any).beforeWindowClick(9, 0, 0); throw new Error('click failed'); };
  await assert.rejects(f.adapter.equipItem('diamond_pickaxe', 'hand', new AbortController().signal, { sourceSlot: 9 }), /click failed/);
  assert.deepEqual(events, ['open', 'close']);
  events.length = 0;
  f.bot.equip = async () => {};
  await f.adapter.equipItem('diamond_pickaxe', 'hand', new AbortController().signal, { sourceSlot: 36 });
  assert.deepEqual(events, []);
});

test('cancelling during the inventory opening hold closes the virtual window', async () => {
  const f = slotFixture(), controller = new AbortController(), events: string[] = [];
  Reflect.get(f.adapter, 'cfg').ui.openHoldMs = 1000;
  f.adapter.on('inventory_open', () => { events.push('open'); controller.abort(); });
  f.adapter.on('inventory_close', () => events.push('close'));
  f.bot.equip = async () => { await (f.bot as any).beforeWindowClick(9, 0, 0); };
  await assert.rejects(f.adapter.equipItem('diamond_pickaxe', 'hand', controller.signal, { sourceSlot: 9 }));
  assert.deepEqual(events, ['open', 'close']);
});

test('real adapter tosses only the selected NBT stack, including partial counts, without spilling to same-name slots', async () => {
  const { adapter, slots, clicks } = slotFixture(), signal = new AbortController().signal;
  slots[10] = { slot: 10, name: 'potion', type: 701, metadata: 0, count: 3, nbt: { type: 'compound', value: { Potion: { type: 'string', value: 'minecraft:poison' } } } };
  slots[11] = { slot: 11, name: 'potion', type: 701, metadata: 0, count: 5, nbt: { type: 'compound', value: { Potion: { type: 'string', value: 'minecraft:healing' } } } };
  const partial = await adapter.tossItem('potion', 1, signal, undefined, { sourceSlot: 10 });
  assert.equal(partial.ok, true, partial.reason);
  assert.equal(partial.tossed, 1);
  assert.equal(slots[10]?.count, 2);
  const remaining = await adapter.tossItem('potion', 20, signal, undefined, { sourceSlot: 10 });
  assert.equal(remaining.tossed, 2, 'count is bounded to the selected stack');
  assert.equal(slots[10], null);
  assert.equal(slots[11]?.count, 5);
  assert.deepEqual(clicks, [[10, 0, 4], [10, 1, 4]]);
  const gone = await adapter.tossItem('potion', null, signal, undefined, { sourceSlot: 10 });
  assert.equal(gone.ok, false);
  assert.equal(slots[11]?.count, 5, 'a stale source must not choose another potion');
});

test('server rollback of an optimistic toss reports zero discarded items', async () => {
  const f = slotFixture(), signal = new AbortController().signal;
  const original = f.slots[9];
  f.bot._syncWindow = async () => { assert.equal(f.slots[9], null); f.slots[9] = original; };
  const result = await f.adapter.tossItem('diamond_pickaxe', null, signal, undefined, { sourceSlot: 9 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOSS_NOT_CONFIRMED');
  assert.equal(result.tossed, 0);
  assert.equal(f.slots[9], original);
});

test('useItem preserves the explicitly held potion NBT instead of selecting the first same-name stack', async () => {
  const f = slotFixture();
  f.slots[9] = { slot: 9, name: 'potion', type: 701, metadata: 0, count: 1, nbt: { type: 'compound', value: { Potion: { type: 'string', value: 'minecraft:poison' } } } };
  const healing: SlotItem = { slot: 36, name: 'potion', type: 701, metadata: 0, count: 1, nbt: { type: 'compound', value: { Potion: { type: 'string', value: 'minecraft:healing' } } } };
  f.slots[36] = healing;
  const result = await f.adapter.useItem('potion', new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(f.uses.map((item) => item.nbt), [healing.nbt]);
  assert.equal(f.slots[9]?.name, 'potion');
});

test('real adapter clears hands and armor without authorizing an implicit drop when inventory is full', async () => {
  const { adapter, bot, slots, unequipped } = slotFixture(), signal = new AbortController().signal;
  slots[5] = { slot: 5, name: 'diamond_helmet', type: 704, metadata: 0, count: 1 };
  assert.equal((await adapter.equipItem(null, 'hand', signal)).ok, true);
  assert.equal(bot.heldItem, null);
  assert.equal((await adapter.equipItem(null, 'head', signal)).ok, true);
  assert.equal(slots[5], null);
  assert.deepEqual(unequipped, ['hand', 'head']);
  for (let slot = 9; slot < 45; slot++) slots[slot] = { slot, name: 'stone', type: 1, metadata: 0, count: 64 };
  const full = await adapter.equipItem(null, 'hand', signal);
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'INVENTORY_FULL');
  assert.deepEqual(unequipped, ['hand', 'head']);
  assert.equal(slots[36]?.count, 64);
});

test('real adapter exact toss also supports occupied armor and off-hand slots excluded from inventory totals', async () => {
  const { adapter, slots, clicks } = slotFixture(), signal = new AbortController().signal;
  slots[5] = { slot: 5, name: 'diamond_helmet', type: 704, metadata: 0, count: 1 };
  slots[45] = { slot: 45, name: 'shield', type: 705, metadata: 0, count: 1 };
  const armor = await adapter.tossItem('diamond_helmet', null, signal, undefined, { sourceSlot: 5 });
  assert.equal(armor.ok, true, armor.reason);
  assert.equal(armor.tossed, 1);
  const offHand = await adapter.tossItem('shield', null, signal, undefined, { sourceSlot: 45 });
  assert.equal(offHand.ok, true, offHand.reason);
  assert.equal(offHand.tossed, 1);
  assert.deepEqual(clicks, [[5, 1, 4], [45, 1, 4]]);
});

test('inspect_inventory keeps separate same-name tools and readable potion, book and map metadata', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const slots: InventorySlot[] = [
    { slot: 9, name: 'diamond_pickaxe', count: 1, customName: '采集', enchants: ['silk_touch 1'], durability: { left: 900, max: 1561 } },
    { slot: 10, name: 'diamond_pickaxe', count: 1, enchants: ['fortune 3'], durability: { left: 1500, max: 1561 } },
    { slot: 11, name: 'potion', count: 1, nbt: { Potion: 'minecraft:poison' } },
    { slot: 12, name: 'written_book', count: 1, nbt: { title: '实验', author: '玩家', pages: ['{"text":"结果"}'] } },
    { slot: 13, name: 'filled_map', count: 1, nbt: { map: 42 } },
    { slot: 45, name: 'shield', count: 1 },
  ];
  ctx.adapter.inventorySlots = () => slots;
  const result = await inspectInventory.run(ctx, {});
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(result.data?.slots, slots, 'observation must retain item identity instead of name totals');
  assert.match(result.summary, /9: diamond_pickaxe.*采集.*silk_touch 1/);
  assert.match(result.summary, /10: diamond_pickaxe.*fortune 3/);
});

test('hold_item sourceSlot chooses a different same-name tool even when that name is already held or worn', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter), calls: { item: string | null; to: string; sourceSlot?: number }[] = [];
  t.after(() => ctx.memory.close());
  const original = adapter.state();
  adapter.state = () => ({ ...original, held: 'diamond_pickaxe', equipment: [{ slot: 'head', name: 'diamond_helmet' }] });
  ctx.adapter.equipItem = async (item, to, _signal, opts) => { calls.push({ item, to, ...opts }); return { ok: true }; };
  const held = await holdItem.run(ctx, { item: 'diamond_pickaxe', to: 'hand', sourceSlot: 9 });
  const worn = await holdItem.run(ctx, { item: 'diamond_helmet', to: 'head', sourceSlot: 10 });
  assert.equal(held.status, 'succeeded', held.summary);
  assert.equal(worn.status, 'succeeded', worn.summary);
  assert.deepEqual(calls, [
    { item: 'diamond_pickaxe', to: 'hand', sourceSlot: 9 },
    { item: 'diamond_helmet', to: 'head', sourceSlot: 10 },
  ]);
});

test('hold_item keeps the selected source separate from the target hotbar slot and reports a changed source', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter), calls: { item: string; target: number; sourceSlot?: number }[] = [];
  t.after(() => ctx.memory.close());
  ctx.adapter.arrangeHotbar = async (item, target, _signal, opts) => {
    calls.push({ item, target, ...opts });
    return { ok: false, reason: 'SOURCE_SLOT_CHANGED' };
  };
  const parsed = holdItem.validate({ item: 'diamond_pickaxe', sourceSlot: 11, slot: 2 }, adapter);
  assert.ok(parsed.ok);
  const result = await holdItem.run(ctx, parsed.args);
  assert.deepEqual(calls, [{ item: 'diamond_pickaxe', target: 2, sourceSlot: 11 }]);
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /SOURCE_SLOT_CHANGED/);
});

test('hold_item null explicitly clears a hand or removes armor, and propagates a refused unequip', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter), cleared: string[] = [];
  t.after(() => ctx.memory.close());
  ctx.adapter.equipItem = async (item, to) => {
    assert.equal(item, null);
    cleared.push(to);
    return to === 'head' ? { ok: false, reason: 'INVENTORY_FULL' } : { ok: true };
  };
  const parsed = holdItem.validate({ item: null, to: 'off-hand' }, adapter);
  assert.ok(parsed.ok);
  assert.equal((await holdItem.run(ctx, parsed.args)).status, 'succeeded');
  const refused = await holdItem.run(ctx, { item: null, to: 'head' });
  assert.equal(refused.status, 'failed');
  assert.match(refused.summary, /INVENTORY_FULL/);
  assert.deepEqual(cleared, ['off-hand', 'head']);
});

test('toss_item passes the exact source slot and name constraint without silently discarding another stack', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter), calls: { item: string; count: number | null; sourceSlot?: number }[] = [];
  t.after(() => ctx.memory.close());
  ctx.adapter.tossItem = async (item, count, _signal, _face, opts) => {
    calls.push({ item, count, sourceSlot: opts?.sourceSlot });
    return { ok: false, reason: 'SOURCE_SLOT_CHANGED', tossed: 0 };
  };
  const parsed = tossItem.validate({ item: 'potion', sourceSlot: 15, count: 1 }, adapter);
  assert.ok(parsed.ok);
  const result = await tossItem.run(ctx, parsed.args);
  assert.deepEqual(calls, [{ item: 'potion', count: 1, sourceSlot: 15 }]);
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /SOURCE_SLOT_CHANGED/);
});

test('source slot selection validates its boundary and cannot be combined with clearing an equipment slot', () => {
  const adapter = new FakeAdapter();
  for (const sourceSlot of [-1, 0, 4, 46, 9.5, '9', null]) {
    assert.equal(holdItem.validate({ item: 'diamond_pickaxe', sourceSlot }, adapter).ok, false);
    assert.equal(tossItem.validate({ item: 'diamond_pickaxe', sourceSlot }, adapter).ok, false);
  }
  assert.equal(holdItem.validate({ item: null, sourceSlot: 9 }, adapter).ok, false);
  assert.equal(holdItem.validate({ item: null, slot: 0 }, adapter).ok, false);
  assert.equal(holdItem.validate({}, adapter).ok, false);
  assert.equal(holdItem.validate({ item: 'diamond_pickaxe', sourceSlot: 9, slot: 0 }, adapter).ok, true);
  assert.equal(tossItem.validate({ item: 'diamond_pickaxe', sourceSlot: 45 }, adapter).ok, true);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { Attention } from '../src/mind/attention.ts';

const data = (await import('minecraft-data')).default('1.20.1');
const adapter = () => { const a = new MineflayerAdapter(config, new EventBus()); a.mcData = data; return a; };
const keys = (n: string) => data.entitiesByName[n].metadataKeys as string[];
const md = (n: string, values: Record<string, unknown>) => { const k = keys(n); const out: unknown[] = []; for (const [key, v] of Object.entries(values)) out[k.indexOf(key)] = v; return out; };

test('一眼看得出的生物特征：羊毛颜色和剪没剪、幼崽、村民职业、驯服、带电', () => {
  const a = adapter() as any;
  assert.equal(a.traitsOf({ name: 'sheep', metadata: md('sheep', { wool: 15 }) }, keys('sheep')), '黑色');
  assert.equal(a.traitsOf({ name: 'sheep', metadata: md('sheep', { wool: 0x10, baby: true }) }, keys('sheep')), '幼崽、白色、已剪毛');
  assert.equal(a.traitsOf({ name: 'villager', metadata: md('villager', { villager_data: { villagerType: 0, villagerProfession: 5, level: 2 } }) }, keys('villager')), '农民 2 级');
  assert.equal(a.traitsOf({ name: 'wolf', metadata: md('wolf', { flags: 0x04 }) }, keys('wolf')), '已驯服');
  assert.equal(a.traitsOf({ name: 'creeper', metadata: md('creeper', { is_powered: true }) }, keys('creeper')), '带电（爆炸更猛）');
  assert.equal(a.traitsOf({ name: 'cow', metadata: [] }, keys('cow')), undefined);
});

test('状态效果按中文名、等级和剩余秒数给出', () => {
  const a = adapter() as any;
  const poison = Object.values<any>(data.effects).find((e) => e.name === 'Poison').id;
  assert.deepEqual(a.effectsOf({ entity: { effects: { [poison]: { id: poison, amplifier: 1, duration: 200 } } } }), [{ name: '中毒（掉血到半颗心为止）', level: 2, seconds: 10 }]);
});

test('注意到：身上多了状态效果、工具快磨坏了', () => {
  const att = new Attention();
  const p = (effects: string[], left: number) => ({ time: { timeOfDay: 3000, phase: 'day' }, self: { food: 20, hp: 20, inWater: false }, emptySlots: 5, effects,
    inventory: [{ name: 'stone_pickaxe', count: 1, durability: { left, max: 131 } }], nearby: { hostile: [], resources: [] }, light: null } as any);
  att.fromPercept(p([], 100));
  const n = att.fromPercept(p(['中毒（掉血到半颗心为止）'], 10));
  assert.ok(n.some((x) => x.key.startsWith('effect:') && x.level === 'reconsider'));
  assert.ok(n.some((x) => x.key === 'worn:stone_pickaxe'));
});

import { holdItem, tossItem } from '../src/skills/hands.ts';

const handsCtx = (inv: { name: string; count: number }[], extra: Record<string, unknown> = {}) => {
  const state: any = { pos: { x: 0, y: 64, z: 0 }, inventory: inv, held: null, equipment: [], hotbar: Array(9).fill(null) };
  const calls: unknown[][] = [];
  const adapter: any = {
    isKnownItem: (n: string) => ['gold_ingot', 'torch', 'shield', 'wheat'].includes(n),
    state: () => state,
    moveTo: async () => ({ ok: true }),
    async tossItem(name: string, count: number | null, _s: unknown, face?: unknown) {
      calls.push(['toss', name, count, face]);
      const it = state.inventory.find((i: any) => i.name === name); const n = count ?? it.count; it.count -= n; return { ok: true, tossed: n };
    },
    async equipItem(name: string, to: string) { calls.push(['equip', name, to]); if (to === 'hand') state.held = name; else state.equipment = [{ slot: to, name }]; return { ok: true }; },
    async arrangeHotbar(name: string, i: number) { calls.push(['hotbar', name, i]); state.hotbar[i] = name; state.held = name; return { ok: true }; },
    ...extra,
  };
  const piglin = { id: 7, name: 'piglin', kind: 'neutral', pos: { x: 1, y: 64, z: 1 }, dist: 1.4 };
  const senses: any = { refresh() {}, perceivedEntities: () => [piglin] };
  return { ctx: { adapter, senses, signal: new AbortController().signal, progress() {}, deadline: Date.now() + 30000 } as any, calls, state };
};

test('toss_item：朝看得见的猪灵扔金锭，按背包变化报告数量', async () => {
  const { ctx, calls } = handsCtx([{ name: 'gold_ingot', count: 5 }]);
  const v = tossItem.validate({ item: 'gold_ingot', count: 2, to: 'piglin' }, ctx.adapter);
  assert.ok(v.ok);
  const r = await tossItem.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(calls[0], ['toss', 'gold_ingot', 2, { x: 1, y: 64, z: 1 }]);
  assert.match(r.summary, /还剩 3/);
  assert.equal((await tossItem.run(ctx, { item: 'gold_ingot', count: 1, to: 'villager' })).failureCode, 'NOT_FOUND');
});

test('hold_item：副手、快捷栏格子，参数检查', async () => {
  const { ctx, calls } = handsCtx([{ name: 'torch', count: 16 }, { name: 'shield', count: 1 }]);
  assert.equal((await holdItem.run(ctx, { item: 'torch', to: 'off-hand' })).status, 'succeeded');
  assert.equal((await holdItem.run(ctx, { item: 'shield', to: 'hand', slot: 0 })).status, 'succeeded');
  assert.deepEqual(calls, [['equip', 'torch', 'off-hand'], ['hotbar', 'shield', 0]]);
  assert.equal(holdItem.validate({ item: 'torch', to: 'off-hand', slot: 1 }, ctx.adapter).ok, false);
  assert.equal(holdItem.validate({ item: 'torch', slot: 9 }, ctx.adapter).ok, false);
});

// ---------------------------------------------------------------- 通用界面 / 交易
const Vec3 = (await import('vec3')).Vec3;
const guiBot = (type: string, size: number, inv: Record<number, [string, number]>) => {
  const slots: any[] = Array(size + 36).fill(null);
  for (const [k, [name, count]] of Object.entries(inv)) slots[size + Number(k)] = { name, count, type: data.itemsByName[name].id };
  const w: any = { id: 3, type: `minecraft:${type}`, slots, selectedItem: null };
  const clicks: number[][] = [];
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' }, entities: {},
    inventory: { slots: [], get selectedItem() { return w.selectedItem; }, items: () => slots.slice(size).filter(Boolean), emptySlotCount: () => 10 },
    blockAt: (p: any) => ({ name: type === 'anvil' ? 'anvil' : type, position: p }),
    async openBlock() { return w; },
    closeWindow() { w.closed = true; },
    _syncWindow: async () => ({}),
    _client: { write: (name: string, body: any) => clicks.push([name === 'name_item' ? -2 : -1, body.enchantment ?? 0, 0]) },
    async clickWindow(slot: number, button: number, mode: number) {
      clicks.push([slot, button, mode]);
      const at = slots[slot];
      if (mode === 1) { if (!at) return; const free = slots.findIndex((s, i) => i >= size && !s); slots[free] = at; slots[slot] = null; return; }
      const cur = w.selectedItem;
      if (button === 1 && cur) {
        if (at && at.name !== cur.name) return;
        slots[slot] = { ...cur, count: (at?.count ?? 0) + 1 }; cur.count--; if (!cur.count) w.selectedItem = null; return;
      }
      if (cur && at && at.name === cur.name) { at.count += cur.count; w.selectedItem = null; return; }
      w.selectedItem = at; slots[slot] = cur;
    },
  };
  const a = adapter() as any; a.bot = bot; a.connectedFlag = true; a.moveTo = async () => {};
  return { a, w, clicks, slots };
};

test('use_gui 适配层：按格子放 1 个/全部，shift 取出产物，点按钮；格子上标出用途', async () => {
  const { a, w, clicks, slots } = guiBot('anvil', 3, { 0: ['iron_sword', 1], 1: ['iron_ingot', 5] });
  const r = await a.useGui({ x: 1, y: 64, z: 0 }, [{ put: { item: 'iron_sword', slot: 0 } }, { put: { item: 'iron_ingot', slot: 1, count: 2 } }], new AbortController().signal);
  assert.equal(r.ok, true, r.reason);
  assert.equal(slots[0].name, 'iron_sword');
  assert.equal(slots[1].count, 2);
  assert.equal(slots[3 + 1].count, 3, '剩下的铁锭放回原处');
  assert.equal(w.selectedItem, null);
  assert.equal(w.closed, true);
  assert.deepEqual(r.view.slots.map((s: any) => s.role).slice(0, 3), ['要修/改名的物品', '材料或附魔书', '产物（消耗经验）']);
  assert.deepEqual(clicks, [[3, 0, 0], [0, 0, 0], [4, 0, 0], [1, 1, 0], [1, 1, 0], [4, 0, 0]]);
  slots[2] = { name: 'iron_sword', count: 1, type: data.itemsByName.iron_sword.id };
  const t = await a.useGui({ x: 1, y: 64, z: 0 }, [{ take: { slot: 2 } }], new AbortController().signal);
  assert.equal(t.ok, true, t.reason);
  assert.match(t.done.join(' '), /取出 iron_sword×1/);
  // 点了按钮界面里什么都没变：不能说成“点了按钮”就算数
  const noop = await a.useGui({ x: 1, y: 64, z: 0 }, [{ button: 1 }], new AbortController().signal);
  assert.equal(noop.ok, false);
  assert.match(noop.reason, /BUTTON_NO_EFFECT/);
  const bad = await a.useGui({ x: 1, y: 64, z: 0 }, [{ take: { slot: 0 } }, { put: { item: 'diamond', slot: 1 } }], new AbortController().signal);
  assert.equal(bad.ok, false);
});

test('附魔台：选项出来再点，物品真的带上附魔才算成；经验不够时说清要几级、身上几级', async () => {
  const { a, w, slots } = guiBot('enchantment', 2, { 0: ['iron_pickaxe', 1], 1: ['lapis_lazuli', 5] });
  w.enchantments = [{ level: 0, expected: { enchant: -1, level: -1 } }, { level: 0, expected: { enchant: -1, level: -1 } }, { level: 0, expected: { enchant: -1, level: -1 } }];
  a.bot.experience = { level: 10 };
  a.itemEnchants = (it: any) => it?.ench;
  a.bot._client.write = (_: string, body: any) => {
    if (a.bot.experience.level < w.enchantments[body.enchantment].level) return;
    slots[0] = { ...slots[0], ench: ['efficiency 2'] }; slots[1].count -= body.enchantment + 1; a.bot.experience.level -= body.enchantment + 1;
  };
  const orig = a.bot.clickWindow;
  a.bot.clickWindow = async (...args: any[]) => { await orig(...args); if (slots[0] && slots[1]) w.enchantments.forEach((e: any, i: number) => { e.level = [3, 8, 30][i]; }); };
  const r = await a.useGui({ x: 1, y: 64, z: 0 }, [{ put: { item: 'iron_pickaxe', slot: 0 } }, { put: { item: 'lapis_lazuli', slot: 1 } }, { button: 2 }], new AbortController().signal);
  assert.equal(r.ok, false);
  assert.match(r.reason, /需 30 级，身上 10 级/);
  slots[0] = null; slots[1] = null; slots[2] = { name: 'iron_pickaxe', count: 1, type: data.itemsByName.iron_pickaxe.id }; slots[3] = { name: 'lapis_lazuli', count: 5, type: data.itemsByName.lapis_lazuli.id };
  w.enchantments.forEach((e: any) => { e.level = 0; });
  const ok = await a.useGui({ x: 1, y: 64, z: 0 }, [{ put: { item: 'iron_pickaxe', slot: 0 } }, { put: { item: 'lapis_lazuli', slot: 1 } }, { button: 1 }], new AbortController().signal);
  assert.equal(ok.ok, true, ok.reason);
  assert.match(ok.done.join(' '), /附魔成功：iron_pickaxe 得到 efficiency 2/);
});

test('trade 适配层：先看交易表，按序号交易并按背包变化确认', async () => {
  const id = (n: string) => data.itemsByName[n].id;
  const inv = new Map<number, number>([[id('emerald'), 3], [id('wheat'), 40]]);
  const trades: any[] = [
    { inputItem1: { name: 'wheat', count: 20, type: id('wheat') }, inputItem2: null, outputItem: { name: 'emerald', count: 1, type: id('emerald') }, nbTradeUses: 0, maximumNbTradeUses: 16, tradeDisabled: false },
    { inputItem1: { name: 'emerald', count: 1, type: id('emerald') }, inputItem2: null, outputItem: { name: 'bread', count: 6, type: id('bread') }, nbTradeUses: 12, maximumNbTradeUses: 12, tradeDisabled: true },
  ];
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    entities: { 9: { isValid: true, position: new Vec3(1, 64, 1) } },
    inventory: { slots: [], selectedItem: null, items: () => [...inv].filter(([, n]) => n > 0).map(([type, count]) => ({ type, count, name: data.items[type].name })) },
    async openVillager() { return { trades, inventoryStart: 3, inventoryEnd: 39, get slots() { return [null, null, null, ...bot.inventory.items()]; }, close() {} }; },
    async trade(_v: any, i: number, times: number) { const t = trades[i]; inv.set(t.inputItem1.type, inv.get(t.inputItem1.type)! - t.inputItem1.count * times); inv.set(t.outputItem.type, (inv.get(t.outputItem.type) ?? 0) + times); },
    async _syncWindow() {},
  };
  const a = adapter() as any; a.bot = bot; a.connectedFlag = true; a.moveTo = async () => {};
  const look = await a.tradeWith(9, null, 1, new AbortController().signal);
  assert.equal(look.ok, true);
  assert.deepEqual(look.trades.map((t: any) => [t.give, t.get, t.disabled]), [[['wheat×20'], 'emerald×1', false], [['emerald×1'], 'bread×6', true]]);
  const r = await a.tradeWith(9, 0, 5, new AbortController().signal);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.traded, 2, '小麦只够两次');
  assert.match((await a.tradeWith(9, 1, 1, new AbortController().signal)).reason, /TRADE_LOCKED/);
});

test('trade 适配层：按现价（涨价/打折后）算能做几次；流浪商人也能打开交易界面', async () => {
  const id = (n: string) => data.itemsByName[n].id;
  const inv = new Map<number, number>([[id('emerald'), 10]]);
  const trades: any[] = [
    { inputItem1: { name: 'emerald', count: 1, type: id('emerald') }, hasItem2: false, realPrice: 4, outputItem: { name: 'bread', count: 6, type: id('bread') }, nbTradeUses: 0, maximumNbTradeUses: 12, tradeDisabled: false },
  ];
  let opened: any = null;
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    entities: { 9: { isValid: true, name: 'wandering_trader', entityType: 999, position: new Vec3(1, 64, 1) } },
    inventory: { slots: [], selectedItem: null, items: () => [...inv].filter(([, n]) => n > 0).map(([type, count]) => ({ type, count, name: data.items[type].name })) },
    async openVillager(e: any) { opened = e; return { trades, inventoryStart: 3, inventoryEnd: 39, get slots() { return [null, null, null, ...bot.inventory.items()]; }, close() {} }; },
    async trade(_v: any, i: number, times: number) { const t = trades[i]; inv.set(t.inputItem1.type, inv.get(t.inputItem1.type)! - t.realPrice * times); inv.set(t.outputItem.type, (inv.get(t.outputItem.type) ?? 0) + t.outputItem.count * times); },
    async _syncWindow() {},
  };
  const a = adapter() as any; a.bot = bot; a.connectedFlag = true; a.moveTo = async () => {};
  const look = await a.tradeWith(9, null, 1, new AbortController().signal);
  assert.equal(look.ok, true, look.reason);
  assert.equal(opened.entityType, data.entitiesByName.villager.id, '借村民的类型号打开');
  assert.deepEqual(look.trades[0].give, ['emerald×4（原价 1）']);
  const r = await a.tradeWith(9, 0, 5, new AbortController().signal);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.traded, 2, '10 个绿宝石按现价 4 只够两次');
});

test('trade 用窗口中的实时背包确认批次，关闭前 bot.inventory 仍可能是旧值', async () => {
  const emerald = data.itemsByName.emerald.id, bread = data.itemsByName.bread.id;
  const inventory = [{ type: emerald, name: 'emerald', count: 6, metadata: 0 }];
  const slots: any[] = [null, null, null, { ...inventory[0] }, null];
  const trades = [{ inputItem1: { type: emerald, name: 'emerald', count: 2, metadata: 0 }, realPrice: 2,
    hasItem2: false, outputItem: { type: bread, name: 'bread', count: 3, metadata: 0 }, nbTradeUses: 0, maximumNbTradeUses: 12 }];
  const window = { trades, slots, inventoryStart: 3, inventoryEnd: 5, close() {} };
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    entities: { 9: { isValid: true, name: 'villager', position: new Vec3(1, 64, 1) } },
    inventory: { slots: [], selectedItem: null, items: () => inventory },
    async openVillager() { return window; },
    async trade(_v: any, _index: number, times: number) {
      slots[3].count -= times * 2;
      slots[4] = { type: bread, name: 'bread', count: times * 3, metadata: 0 };
    },
    async _syncWindow(actual: unknown) { assert.equal(actual, window); },
  };
  const a = adapter() as any; a.bot = bot; a.connectedFlag = true;
  const r = await a.tradeWith(9, 0, 3, new AbortController().signal);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.traded, 3);
  assert.equal(inventory[0].count, 6, '测试保留旧的 bot.inventory');
});

test('trade 不把被服务器撤销的预测库存当作成功交易', async () => {
  const emerald = data.itemsByName.emerald.id, bread = data.itemsByName.bread.id;
  const slots: any[] = [null, null, null, { type: emerald, name: 'emerald', count: 2, metadata: 0 }, null];
  const trades = [{ inputItem1: { type: emerald, name: 'emerald', count: 2, metadata: 0 }, realPrice: 2,
    hasItem2: false, outputItem: { type: bread, name: 'bread', count: 3, metadata: 0 }, nbTradeUses: 0, maximumNbTradeUses: 12 }];
  const window = { trades, slots, inventoryStart: 3, inventoryEnd: 5, close() {} };
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    entities: { 9: { isValid: true, name: 'villager', position: new Vec3(1, 64, 1) } },
    inventory: { slots: [], selectedItem: null, items: () => [] },
    async openVillager() { return window; },
    async trade() { slots[3] = null; slots[4] = { type: bread, name: 'bread', count: 3, metadata: 0 }; },
    async _syncWindow(actual: unknown) {
      assert.equal(actual, window);
      slots[3] = { type: emerald, name: 'emerald', count: 2, metadata: 0 }; slots[4] = null;
    },
  };
  const a = adapter() as any; a.bot = bot; a.connectedFlag = true;
  const r = await a.tradeWith(9, 0, 1, new AbortController().signal);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'TRADE_NOT_CONFIRMED');
  assert.equal(r.traded, 0);
});

import { trade as tradeSkill, useGui } from '../src/skills/gui.ts';

test('use_gui / trade 参数检查', () => {
  const ad: any = { isKnownItem: (n: string) => ['iron_ingot', 'anvil'].includes(n), resolveBlockNames: () => [] };
  const v = useGui.validate({ target: 'anvil', ops: [{ put: { item: 'iron_ingot', slot: 1, count: 2 } }, { take: 2 }, { button: 0 }, { rename: '老伙计' }] }, ad);
  assert.ok(v.ok, (v as any).error);
  assert.deepEqual((v as any).args.ops, [{ put: { item: 'iron_ingot', slot: 1, count: 2 } }, { take: { slot: 2 } }, { button: 0 }, { rename: '老伙计' }]);
  assert.equal(useGui.validate({ target: 'anvil', ops: [{ put: { item: 'iron_ingot' } }] }, ad).ok, false);
  assert.equal(useGui.validate({ target: 'anvil', ops: [{ jump: 1 }] }, ad).ok, false);
  assert.deepEqual((tradeSkill.validate({}, ad) as any).args, { who: 'villager', index: null, times: 1 });
  assert.equal(tradeSkill.validate({ times: 99 }, ad).ok, false);
});

test('睡村民占着的床：先点一下把村民叫醒，再躺上去；指定了哪张就睡哪张', async () => {
  const beds = new Map<string, { occupied: boolean }>([['3,64,0', { occupied: true }], ['-2,64,0', { occupied: false }]]);
  const blk = (x: number, y: number, z: number) => {
    const st = beds.get(`${x},${y},${z}`);
    return st ? { name: 'white_bed', position: new Vec3(x, y, z), getProperties: () => ({ occupied: st.occupied, part: 'head', facing: 'north' }) } : { name: 'air', position: new Vec3(x, y, z) };
  };
  let slept: any = null; const clicks: string[] = [];
  const bot: any = {
    entity: { position: new Vec3(0.5, 64, 0.5) }, game: { dimension: 'overworld' }, isSleeping: false,
    blockAt: (p: any) => blk(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    findBlock: () => null,
    async activateBlock(b: any) { clicks.push(`${b.position.x}`); beds.get(`${b.position.x},64,0`)!.occupied = false; },
    async sleep(b: any) { if (b.getProperties().occupied) throw new Error('the bed is occupied'); slept = b.position.x; },
  };
  const a = adapter() as any; a.bot = bot; a.connectedFlag = true; a.moveTo = async () => {}; a.currentDimension = () => 'overworld';
  const r = await a.sleepInBed(new AbortController().signal, { at: { x: 3, y: 64, z: 0 } });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(clicks, ['3'], '先点一下占着的那张');
  assert.equal(slept, 3, '睡的是指定的那张，不是旁边空着的');
});

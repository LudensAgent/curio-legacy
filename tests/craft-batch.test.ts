import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const data = (await import('minecraft-data')).default('1.20.1');
const id = (n: string) => data.itemsByName[n].id;

/** 一个最小的背包窗口：0 产物、1-4 合成格、9-44 背包；shift 点产物时按“每格里最少的那堆”一次合成完 */
function rig(inv: Record<string, number>, result: { name: string; count: number }, freeSlots = 30) {
  const slots: any[] = new Array(46).fill(null);
  let k = 9;
  for (const [name, count] of Object.entries(inv)) {
    let left = count; const stack = data.itemsByName[name].stackSize;
    while (left > 0) { const c = Math.min(stack, left); slots[k++] = { name, type: id(name), count: c, stackSize: stack }; left -= c; }
  }
  const window: any = { slots, inventoryStart: 9, inventoryEnd: 45, selectedItem: null };
  const clicks: string[] = [];
  const bot: any = {
    inventory: Object.assign(window, { items: () => slots.slice(9, 45).filter(Boolean), emptySlotCount: () => slots.slice(9, 45).filter((x) => !x).length }),
    async _syncWindow() {},
    async transfer(o: any) {
      clicks.push(`put ${o.count}@${o.destStart}`);
      let need = o.count;
      for (let i = 9; i < 45 && need > 0; i++) {
        const it = slots[i]; if (!it || it.type !== o.itemType) continue;
        const t = Math.min(need, it.count); it.count -= t; need -= t; if (!it.count) slots[i] = null;
      }
      const cur = slots[o.destStart];
      slots[o.destStart] = { ...(cur ?? { name: data.items[o.itemType].name, type: o.itemType, count: 0, stackSize: data.items[o.itemType].stackSize }), count: (cur?.count ?? 0) + o.count - need };
      slots[0] = { name: result.name, type: id(result.name), count: result.count };
    },
    async clickWindow(slot: number, _b: number, mode: number) {
      clicks.push(`click ${slot} mode${mode}`);
      if (slot === 0 && mode === 1) {
        const grid = [1, 2, 3, 4].filter((i) => slots[i]);
        let n = Math.min(...grid.map((i) => slots[i].count));
        n = Math.min(n, freeSlots * Math.floor(data.itemsByName[result.name].stackSize / result.count));
        for (const i of grid) { slots[i].count -= n; if (!slots[i].count) slots[i] = null; }
        let out = n * result.count;
        for (let i = 9; i < 45 && out > 0; i++) if (!slots[i]) { const c = Math.min(out, data.itemsByName[result.name].stackSize); slots[i] = { name: result.name, type: id(result.name), count: c }; out -= c; }
        slots[0] = null;
      } else if (mode === 1 && slots[slot]) {
        const it = slots[slot]; slots[slot] = null;
        for (let i = 9; i < 45; i++) if (!slots[i]) { slots[i] = it; break; }
      }
    },
  };
  const a = new MineflayerAdapter(config, new EventBus()) as any;
  a.mcData = data; a.bot = bot; a.connectedFlag = true;
  return { a, clicks, slots };
}

const recipe = (shape: string[][], result: string, count: number) => ({
  inShape: shape.map((row) => row.map((n) => ({ id: n ? id(n) : -1 }))), result: { id: id(result), count },
});

test('一次把料按格放齐，shift 点产物做完一整批，而不是一个一个点', async () => {
  const { a, clicks } = rig({ oak_planks: 40 }, { name: 'stick', count: 4 });
  const made = await a.craftBatch(recipe([['oak_planks'], ['oak_planks']], 'stick', 4), 16, null, new AbortController().signal);
  assert.equal(made, 16);
  assert.equal(a.invCount(id('stick')), 64);
  assert.deepEqual(clicks.filter((c) => c.startsWith('put')), ['put 16@1', 'put 16@3']);
  assert.equal(clicks.filter((c) => c === 'click 0 mode1').length, 1, '产物只点一次');
});

test('整批合成在材料摆齐后停一次，再一次取走整批产物', async () => {
  const { a, clicks } = rig({ oak_planks: 40 }, { name: 'stick', count: 4 });
  a.cfg = { ...config, ui: { pacingMs: 0, openHoldMs: 40, closeHoldMs: 0 } };
  const times: Record<string, number> = {};
  const sync = a.bot._syncWindow, click = a.bot.clickWindow;
  a.bot._syncWindow = async () => { if (!times.placed) times.placed = Date.now(); return sync(); };
  a.bot.clickWindow = async (...args: number[]) => { if (args[0] === 0) times.output = Date.now(); return click(...args); };
  const made = await a.craftBatch(recipe([['oak_planks'], ['oak_planks']], 'stick', 4), 16, null, new AbortController().signal);
  assert.equal(made, 16);
  assert.deepEqual(clicks.filter((c) => c.startsWith('put')), ['put 16@1', 'put 16@3']);
  assert.equal(clicks.filter((c) => c === 'click 0 mode1').length, 1);
  assert.ok(times.output - times.placed >= 35);
});

test('一批的上限按料的单组上限：鸡蛋一格最多放 16 个', async () => {
  const { a, clicks } = rig({ egg: 32, sugar: 32 }, { name: 'pumpkin_pie', count: 1 });
  const made = await a.craftBatch(recipe([['egg', 'sugar']], 'pumpkin_pie', 1), 30, null, new AbortController().signal);
  assert.equal(made, 16, '要 30 次，一批只能 16 次（剩下的由下一批做）');
  assert.ok(clicks.includes('put 16@1') && clicks.includes('put 16@2'));
});

test('产物背包放不下：服务器做到放满为止，剩下的料收回背包', async () => {
  const { a, slots } = rig({ oak_planks: 40 }, { name: 'stick', count: 4 }, 0);
  const made = await a.craftBatch(recipe([['oak_planks'], ['oak_planks']], 'stick', 4), 16, null, new AbortController().signal);
  assert.equal(made, 0);
  assert.equal([1, 2, 3, 4].filter((i) => slots[i]).length, 0, '合成格清空');
  assert.equal(a.invCount(id('oak_planks')), 40, '料一个不少地回到背包');
});

test('背包放不下时停止批量合成，不再用逐个合成重复尝试', async () => {
  const { a } = rig({ oak_planks: 40 }, { name: 'stick', count: 4 }, 0);
  const r = { ...recipe([['oak_planks'], ['oak_planks']], 'stick', 4), delta: [{ id: id('oak_planks'), count: -2 }] };
  let fallback = 0;
  a.bot.recipesFor = () => [r];
  a.bot.craft = async () => { fallback++; };
  const made = await a.craftUpTo(id('stick'), 64, null, new AbortController().signal);
  assert.equal(made, 0);
  assert.equal(fallback, 0);
});

test('产物点击后同步失败时不重试合成，避免重复消耗材料', async () => {
  const { a } = rig({ oak_planks: 40 }, { name: 'stick', count: 4 });
  const r = { ...recipe([['oak_planks'], ['oak_planks']], 'stick', 4), delta: [{ id: id('oak_planks'), count: -2 }] };
  let syncs = 0, fallback = 0;
  a.bot.recipesFor = () => [r];
  a.bot.craft = async () => { fallback++; };
  a.bot._syncWindow = async () => { if (++syncs === 2) throw new Error('sync failed'); };
  await assert.rejects(a.craftUpTo(id('stick'), 64, null, new AbortController().signal), /sync failed/);
  assert.equal(a.invCount(id('stick')), 64);
  assert.equal(fallback, 0);
});

test('合成格显示了其他产物时不拿取', async () => {
  const { a } = rig({ oak_planks: 2 }, { name: 'torch', count: 4 });
  const made = await a.craftBatch(recipe([['oak_planks'], ['oak_planks']], 'stick', 4), 1, null, new AbortController().signal);
  assert.equal(made, 0);
  assert.equal(a.invCount(id('torch')), 0);
  assert.equal(a.invCount(id('oak_planks')), 2);
});

test('背包合成在打开界面停留时被取消，观察端仍收到关闭事件', async () => {
  const { a } = rig({ oak_planks: 2 }, { name: 'stick', count: 4 });
  a.cfg = { ...config, ui: { ...config.ui, openHoldMs: 10000, closeHoldMs: 0 } };
  const events: string[] = [], controller = new AbortController();
  a.on('inventory_open', () => { events.push('open'); controller.abort(); });
  a.on('inventory_close', () => events.push('close'));
  await assert.rejects(a.craftBatch(recipe([['oak_planks'], ['oak_planks']], 'stick', 4), 1, null, controller.signal));
  assert.deepEqual(events, ['open', 'close']);
});

test('公开合成在背包满时不会把混合木板配方当作备用重试', async () => {
  const { a } = rig({ oak_planks: 40 }, { name: 'stick', count: 4 }, 0);
  const r = { ...recipe([['oak_planks'], ['oak_planks']], 'stick', 4), delta: [{ id: id('oak_planks'), count: -2 }] };
  let mixed = 0;
  a.bot.entity = {};
  a.bot.recipesFor = () => [r];
  a.bot.recipesAll = () => [r];
  a.mixedPlanksRecipe = () => { mixed++; return r; };
  const result = await a.craft('stick', 64, new AbortController().signal);
  assert.equal(result.crafted, 0);
  assert.equal(result.reason, 'MISSING_MATERIALS');
  assert.equal(mixed, 0);
});


test('逐个合成的工作台在打开和关闭前停留，并恢复钩子', async () => {
  const { a } = rig({ oak_planks: 2 }, { name: 'stick', count: 4 });
  a.cfg = { ...config, ui: { ...config.ui, pacingMs: 0, openHoldMs: 100, closeHoldMs: 100 } };
  a.bot = Object.assign(new EventEmitter(), a.bot);
  a.interactionReady = async () => {};
  const beforeClick = async () => {};
  a.bot.beforeWindowClick = beforeClick;
  let openedAt = 0, clickedAt = 0, closeRequestedAt = 0, closedAt = 0;
  const closeWindow = () => { closedAt = Date.now(); };
  a.bot.closeWindow = closeWindow;
  a.bot.craft = async () => {
    openedAt = Date.now();
    a.bot.emit('windowOpen', { type: 'minecraft:crafting' });
    await a.bot.beforeWindowClick(1, 0, 0);
    clickedAt = Date.now();
    closeRequestedAt = Date.now();
    await a.bot.closeWindow({});
  };
  await a.craftOnce(recipe([['oak_planks'], ['oak_planks']], 'stick', 4), {}, new AbortController().signal);
  assert.ok(clickedAt - openedAt >= 80, `首击等待了 ${clickedAt - openedAt}ms`);
  assert.ok(closedAt - closeRequestedAt >= 80, `关窗前等待了 ${closedAt - closeRequestedAt}ms`);
  assert.equal(a.bot.beforeWindowClick, beforeClick);
  assert.equal(a.bot.closeWindow, closeWindow);
  assert.equal(a.bot.listenerCount('windowOpen'), 0);
});


test('agent-selected batch size limits each recipe group without changing the requested total', async () => {
  const { a, clicks } = rig({ oak_planks: 40 }, { name: 'stick', count: 4 });
  a.cfg = { ...config, ui: { pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 } };
  a.bot = Object.assign(new EventEmitter(), a.bot, { entity: {} });
  const r = { ...recipe([['oak_planks'], ['oak_planks']], 'stick', 4), delta: [{ id: id('oak_planks'), count: -2 }] };
  a.bot.recipesFor = () => [r];
  a.bot.recipesAll = () => [r];
  const batches: number[] = [];
  a.bot.on('observerCraft', (count: number) => batches.push(count));
  const result = await a.craft('stick', 40, new AbortController().signal, { batchSize: 4 });
  assert.equal(result.crafted, 40);
  assert.deepEqual(batches, [16, 16, 8]);
  assert.deepEqual(clicks.filter((c) => c.startsWith('put')), ['put 4@1', 'put 4@3', 'put 4@1', 'put 4@3', 'put 2@1', 'put 2@3']);
  assert.equal(clicks.filter((c) => c === 'click 0 mode1').length, 3);
});

test('server-confirmed partial output is shown instead of planned batch quantity', async () => {
  const { a } = rig({ oak_planks: 40 }, { name: 'stick', count: 4 });
  a.cfg = { ...config, ui: { pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 } };
  a.bot = Object.assign(new EventEmitter(), a.bot);
  const batches: number[] = [];
  a.bot.on('observerCraft', (count: number) => batches.push(count));
  let syncs = 0;
  a.bot._syncWindow = async () => {
    if (++syncs === 2) {
      const output = a.bot.inventory.items().find((item: { type: number }) => item.type === id('stick'));
      output.count = 12;
    }
  };
  await a.craftBatch(recipe([['oak_planks'], ['oak_planks']], 'stick', 4), 16, null, new AbortController().signal);
  assert.deepEqual(batches, [12]);
});

test('fallback crafting also honors the selected recipe batch size', async () => {
  const { a } = rig({ oak_planks: 40 }, { name: 'stick', count: 4 });
  const r = { ...recipe([['oak_planks'], ['oak_planks']], 'stick', 4), delta: [{ id: id('oak_planks'), count: -2 }] };
  a.bot.recipesFor = () => [r];
  a.bot.transfer = undefined;
  let made = 0;
  const calls: number[] = [];
  a.invCount = (type: number) => type === id('stick') ? made : 40;
  a.craftOnce = async (_recipe: unknown, _table: unknown, _signal: AbortSignal, times: number) => { calls.push(times); made += times * 4; };
  assert.equal(await a.craftUpTo(id('stick'), 40, null, new AbortController().signal, 4), 40);
  assert.deepEqual(calls, [4, 4, 2]);
});

test('背包放不下产物时在点格子前如实报出，不等 20 秒界面超时；用光整叠材料空出的槽照算', async () => {
  // 36 格全满：8 块木板做箱子，木板只用掉半叠，空不出槽，箱子放不下
  const full: Record<string, number> = { oak_planks: 40 };
  for (const n of ['stone', 'dirt', 'cobblestone', 'gravel', 'sand', 'andesite', 'diorite', 'granite', 'netherrack', 'deepslate', 'tuff', 'calcite',
    'basalt', 'blackstone', 'end_stone', 'clay', 'moss_block', 'mud', 'snow_block', 'soul_sand', 'soul_soil', 'terracotta', 'packed_ice', 'obsidian',
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'crimson_stem', 'warped_stem', 'cobbled_deepslate']) full[n] = 64;
  const chest = { ...recipe([['oak_planks', 'oak_planks', 'oak_planks'], ['oak_planks', null as any, 'oak_planks'], ['oak_planks', 'oak_planks', 'oak_planks']], 'chest', 1), delta: [{ id: id('oak_planks'), count: -8 }, { id: id('chest'), count: 1 }] };
  const { a, clicks } = rig(full, { name: 'chest', count: 1 }, 0);
  assert.equal(a.bot.inventory.emptySlotCount(), 0);
  await assert.rejects(a.craftBatch(chest, 1, {}, new AbortController().signal), /^Error: INVENTORY_FULL/);
  assert.equal(clicks.length, 0, '没有点任何格子');
  // 正好用光一整叠的材料会空出一格：这时放得下，不拦
  const exact = { ...chest, delta: [{ id: id('oak_planks'), count: -8 }, { id: id('chest'), count: 1 }] };
  const { a: b } = rig({ ...full, oak_planks: 8 }, { name: 'chest', count: 1 }, 0);
  assert.equal(b.craftResultShort(exact, 1), null);
});

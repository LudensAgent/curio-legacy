import assert from 'node:assert/strict';
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeTools } from '../src/skills/merge.ts';

const MAX: Record<string, number> = { stone_pickaxe: 131, shield: 336, iron_chestplate: 240 };
type Station = 'crafting_table' | 'anvil';

/** 只实现 merge_tools 用到的那几个接口：界面里的两格输入 + 取产物，按游戏规则算耐久 */
function fixture(initial: { name: string; left: number; slot?: number }[], station: Station = 'crafting_table') {
  const items = initial.map((it, i) => ({ slot: it.slot ?? 9 + i, name: it.name, left: it.left }));
  const maxOf = (name: string) => MAX[name] ?? 100;
  let guiCalls = 0;
  const adapter = {
    async useGui(_target: unknown, ops: any[]) {
      guiCalls++;
      const grid: typeof items = [];
      for (const op of ops) {
        if ('put' in op) {
          // 合成台界面里背包第 9 槽是第 10 槽；铁砧/砂轮是第 3 槽
          const playerSlot = station === 'crafting_table' ? op.put.sourceSlot - 1 : op.put.sourceSlot + 6;
          const at = items.findIndex((it) => it.slot === playerSlot && it.name === op.put.item);
          if (at < 0) return { ok: false, reason: `NO_ITEM:${op.put.item}`, done: [] };
          grid.push(...items.splice(at, 1));
        } else if ('take' in op) {
          if (grid.length !== 2) return { ok: false, reason: 'NO_RESULT', done: [] };
          const [a, b] = grid;
          const max = maxOf(a.name);
          const left = Math.min(max, a.left + b.left + Math.floor(max * (station === 'anvil' ? 12 : 5) / 100));
          const slot = Array.from({ length: 36 }, (_, i) => 9 + i).find((s) => !items.some((it) => it.slot === s))!;
          items.push({ slot, name: a.name, left });
        }
      }
      return { ok: true, done: [] };
    },
    inventorySlots: () => items.map((it) => ({ slot: it.slot, name: it.name, count: 1, durability: { left: it.left, max: maxOf(it.name) } })),
    state: () => {
      const inv = new Map<string, { name: string; count: number; durability: { left: number; max: number }; durabilities: number[] }>();
      for (const it of items) {
        const cur = inv.get(it.name) ?? { name: it.name, count: 0, durability: { left: it.left, max: maxOf(it.name) }, durabilities: [] };
        cur.count++;
        if (it.left < cur.durability.left) cur.durability = { left: it.left, max: maxOf(it.name) };
        cur.durabilities = [...cur.durabilities, it.left].sort((a, b) => b - a);
        inv.set(it.name, cur);
      }
      return { pos: { x: 0, y: 64, z: 0 }, dim: 'overworld', worldId: 'test', inventory: [...inv.values()], equipment: [] };
    },
  };
  const ctx = {
    adapter,
    senses: {
      knownBlocks: (kinds: string[]) => kinds.includes(station) ? [{ name: station, pos: { x: 1, y: 64, z: 1 }, dist: 1 }] : [],
      refresh() {},
      markSweep() {},
    },
    memory: { landmarks: () => [] },
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    taskId: 't',
    progress() {},
  };
  return { ctx: ctx as any, items, calls: () => guiCalls };
}

test('merge_tools：两件耐久相加超过满耐久时默认不合并，并说清净亏', async () => {
  const w = fixture([{ name: 'stone_pickaxe', left: 131 }, { name: 'stone_pickaxe', left: 35 }]);
  const r = await mergeTools.run(w.ctx, { item: 'stone_pickaxe', station: 'crafting_table', count: 1, allow_loss: false });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'WOULD_WASTE');
  assert.match(r.summary, /合计耐久 166 → 131（净丢 35）/);
  assert.equal(w.calls(), 0);
  assert.equal(w.items.length, 2);
});

test('merge_tools：allow_loss 才执行净亏合并，并把耐久损失记进结果', async () => {
  const w = fixture([{ name: 'stone_pickaxe', left: 131 }, { name: 'stone_pickaxe', left: 35 }]);
  const r = await mergeTools.run(w.ctx, { item: 'stone_pickaxe', station: 'crafting_table', count: 1, allow_loss: true });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.data?.merged, 1);
  assert.equal(r.data?.durabilityBefore, 166);
  assert.equal(r.data?.durabilityAfter, 131);
  assert.equal(r.data?.durabilityLost, 35);
  assert.equal(w.items.length, 1);
  assert.equal(w.items[0].left, 131);
});

test('merge_tools：两件之和没有超过满耐久时正常合并并报告增量', async () => {
  const w = fixture([{ name: 'stone_pickaxe', left: 100 }, { name: 'stone_pickaxe', left: 20 }]);
  const r = await mergeTools.run(w.ctx, { item: 'stone_pickaxe', station: 'crafting_table', count: 1, allow_loss: false });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.data?.durabilityLost, 0);
  assert.equal(r.data?.durabilityAfter, 126);
  assert.match(r.summary, /合计耐久 120 → 126（\+6）/);
});

test('merge_tools：优先合耐久最低的两件，而不是把完好那件跟快坏的合掉', async () => {
  const w = fixture([
    { name: 'stone_pickaxe', left: 131, slot: 9 },
    { name: 'stone_pickaxe', left: 100, slot: 10 },
    { name: 'stone_pickaxe', left: 20, slot: 11 },
  ]);
  const r = await mergeTools.run(w.ctx, { item: 'stone_pickaxe', station: 'crafting_table', count: 2, allow_loss: false });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.data?.merged, 1);
  assert.deepEqual(w.items.map((it) => it.left).sort((a, b) => a - b), [126, 131]);
});

test('merge_tools：现有把数已经不超过 count 时不合并，也不报失败', async () => {
  const w = fixture([{ name: 'stone_pickaxe', left: 100 }, { name: 'stone_pickaxe', left: 20 }]);
  const r = await mergeTools.run(w.ctx, { item: 'stone_pickaxe', station: 'crafting_table', count: 2, allow_loss: false });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.data?.merged, 0);
  assert.equal(w.calls(), 0);
});

test('merge_tools：铁砧按满耐久的 12% 计算奖励', async () => {
  const w = fixture([{ name: 'shield', left: 150 }, { name: 'shield', left: 100 }], 'anvil');
  const r = await mergeTools.run(w.ctx, { item: 'shield', station: 'anvil', count: 1, allow_loss: false });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.data?.durabilityAfter, 290);
});

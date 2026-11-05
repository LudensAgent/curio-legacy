import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GuiOp, GuiResult, GuiTarget } from '../src/adapter/types.ts';
import { throwIfAborted } from '../src/util.ts';
import { mergeTools } from '../src/skills/merge.ts';
import { validateSkill } from '../src/skills/types.ts';
import { TestWorld, makeCtx } from './survival-helpers.ts';

const MAX: Record<string, number> = { iron_pickaxe: 250, stone_pickaxe: 131 };
const maxOf = (name: string) => MAX[name] ?? 100;

/** 模拟合并：按 sourceSlot 取两件，按工作台规则（两件之和 + 满耐久5%）算产物；把数两把 → 一把 */
class MergeWorld extends TestWorld {
  mergeCalls = 0;
  gears: { name: string; left: number; slot: number }[] = [];
  add(name: string, left: number) {
    const slot = Array.from({ length: 36 }, (_, i) => 9 + i).find((s) => !this.gears.some((g) => g.slot === s))!;
    this.gears.push({ name, left, slot });
    this.inv.set(name, (this.inv.get(name) ?? 0) + 1);
  }
  inventorySlots() {
    return this.gears.map((g) => ({ slot: g.slot, name: g.name, count: 1, durability: { left: g.left, max: maxOf(g.name) } }));
  }
  async useGui(_target: GuiTarget, ops: GuiOp[], signal: AbortSignal): Promise<GuiResult> {
    throwIfAborted(signal);
    const puts = ops.filter((o): o is Extract<GuiOp, { put: unknown }> => 'put' in o);
    const take = ops.find((o) => 'take' in o);
    if (puts.length !== 2 || !take) return { ok: false, reason: 'NO_MERGE_OPS', done: [] };
    const picked = puts.map((o) => this.gears.find((g) => g.name === o.put.item && g.slot === o.put.sourceSlot! - 1));
    if (picked.some((g) => !g)) return { ok: false, reason: 'NO_ITEM', done: [] };
    const [a, b] = picked as { name: string; left: number; slot: number }[];
    this.gears = this.gears.filter((g) => g !== a && g !== b);
    const max = maxOf(a.name);
    this.gears.push({ name: a.name, left: Math.min(max, a.left + b.left + Math.floor(max * 5 / 100)), slot: a.slot });
    this.inv.set(a.name, (this.inv.get(a.name) ?? 0) - 1);
    this.mergeCalls++;
    return { ok: true, done: [`merge:${a.name}`] };
  }
}

test('validate 解析 station 默认值、别名和 count 上限', () => {
  const world = new TestWorld();
  const a = validateSkill(mergeTools, { item: 'iron_pickaxe' }, world);
  assert.equal(a.ok, true);
  if (a.ok) {
    assert.equal(a.args.item, 'iron_pickaxe');
    assert.equal(a.args.station, 'crafting_table');
    assert.equal(a.args.count, 1);
  }
  const b = validateSkill(mergeTools, { item: 'minecraft:iron_pickaxe', station: 'anvil', count: 99 }, world);
  assert.equal(b.ok, true);
  if (b.ok) {
    assert.equal(b.args.item, 'iron_pickaxe');
    assert.equal(b.args.station, 'anvil');
    assert.equal(b.args.count, 64);
  }
});

test('三把同名工具合并到只剩一把', async () => {
  const world = new MergeWorld();
  world.add('iron_pickaxe', 50);
  world.add('iron_pickaxe', 40);
  world.add('iron_pickaxe', 30);
  world.setBlock({ x: 1, y: 64, z: 0 }, 'crafting_table');
  const r = await mergeTools.run(makeCtx(world), { item: 'iron_pickaxe', station: 'crafting_table', count: 1 });
  assert.equal(r.status, 'succeeded');
  assert.match(r.summary, /合并了 2 次/);
  assert.equal(world.mergeCalls, 2);
  assert.equal(world.inv.get('iron_pickaxe'), 1);
  assert.equal(r.data?.remaining, 1);
});

test('保留多把时合并到指定把数', async () => {
  const world = new MergeWorld();
  [10, 15, 20, 25, 30].forEach((left) => world.add('stone_pickaxe', left));
  world.setBlock({ x: 1, y: 64, z: 0 }, 'crafting_table');
  const r = await mergeTools.run(makeCtx(world), { item: 'stone_pickaxe', station: 'crafting_table', count: 2 });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.data?.remaining, 2);
  assert.equal(world.mergeCalls, 3);
});

test('不足两把直接报 MISSING_MATERIALS，不调界面', async () => {
  const world = new MergeWorld();
  world.inv.set('iron_pickaxe', 1);
  const r = await mergeTools.run(makeCtx(world), { item: 'iron_pickaxe', station: 'crafting_table', count: 1 });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'MISSING_MATERIALS');
  assert.equal(world.mergeCalls, 0);
});

test('一件穿在身上、一件在背包：说清要先脱下来才能合并，不调界面', async () => {
  const world = new MergeWorld();
  world.inv.set('iron_chestplate', 1);
  world.equipped.set('torso', 'iron_chestplate');
  const r = await mergeTools.run(makeCtx(world), { item: 'iron_chestplate', station: 'crafting_table', count: 1 });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'MISSING_MATERIALS');
  assert.match(r.summary, /穿在身上（torso）/);
  assert.match(r.summary, /hold_item \{"item":null,"to":"torso"\}/);
  assert.equal(world.mergeCalls, 0);
});

test('附近没有工作站报 NOT_FOUND', async () => {
  const world = new MergeWorld();
  world.inv.set('iron_pickaxe', 3);
  const r = await mergeTools.run(makeCtx(world), { item: 'iron_pickaxe', station: 'crafting_table', count: 1 });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'NOT_FOUND');
  assert.equal(world.mergeCalls, 0);
});

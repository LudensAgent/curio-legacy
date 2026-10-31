import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GuiOp, GuiResult, GuiTarget } from '../src/adapter/types.ts';
import { throwIfAborted } from '../src/util.ts';
import { mergeTools } from '../src/skills/merge.ts';
import { validateSkill } from '../src/skills/types.ts';
import { TestWorld, makeCtx } from './survival-helpers.ts';

/** 模拟合并：ops 含 put 和 take 时，把对应工具的把数减一（两把 → 一把） */
class MergeWorld extends TestWorld {
  mergeCalls = 0;
  async useGui(_target: GuiTarget, ops: GuiOp[], signal: AbortSignal): Promise<GuiResult> {
    throwIfAborted(signal);
    const put = ops.find((o): o is Extract<GuiOp, { put: unknown }> => 'put' in o);
    const take = ops.find((o): o is Extract<GuiOp, { take: unknown }> => 'take' in o);
    if (!put || !take) return { ok: false, reason: 'NO_MERGE_OPS', done: [] };
    const item = put.put.item;
    this.inv.set(item, (this.inv.get(item) ?? 0) - 1);
    this.mergeCalls++;
    return { ok: true, done: [`merge:${item}`] };
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
  world.inv.set('iron_pickaxe', 3);
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
  world.inv.set('stone_pickaxe', 5);
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

test('附近没有工作站报 NOT_FOUND', async () => {
  const world = new MergeWorld();
  world.inv.set('iron_pickaxe', 3);
  const r = await mergeTools.run(makeCtx(world), { item: 'iron_pickaxe', station: 'crafting_table', count: 1 });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'NOT_FOUND');
  assert.equal(world.mergeCalls, 0);
});

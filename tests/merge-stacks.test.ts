import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionResult } from '../src/adapter/types.ts';
import { throwIfAborted } from '../src/util.ts';
import { mergeStacks } from '../src/skills/merge.ts';
import { validateSkill } from '../src/skills/types.ts';
import { TestWorld, makeCtx } from './survival-helpers.ts';

/** 模拟适配器的 mergeStacks：直接回一个预设结果 */
class MergeStacksWorld extends TestWorld {
  next: ActionResult & { merged: number; freed: number } = { ok: true, merged: 3, freed: 2 };
  calls: (string | undefined)[] = [];
  async mergeStacks(signal: AbortSignal, item?: string): Promise<ActionResult & { merged: number; freed: number }> {
    throwIfAborted(signal);
    this.calls.push(item);
    return this.next;
  }
}

test('validate：不写 item 整理所有，写别名解析成标准名', () => {
  const world = new TestWorld();
  const a = validateSkill(mergeStacks, {}, world);
  assert.equal(a.ok, true);
  if (a.ok) assert.deepEqual(a.args, {});
  const b = validateSkill(mergeStacks, { item: 'minecraft:cobblestone' }, world);
  assert.equal(b.ok, true);
  if (b.ok) assert.equal(b.args.item, 'cobblestone');
});

test('validate：未知物品报错', () => {
  const world = new TestWorld();
  const a = validateSkill(mergeStacks, { item: 'item123' }, world);
  assert.equal(a.ok, false);
});

test('run：腾出空槽时如实报告合并次数和腾出格数，并把 item 透传给适配器', async () => {
  const world = new MergeStacksWorld();
  const r = await mergeStacks.run(makeCtx(world), { item: 'cobblestone' });
  assert.equal(r.status, 'succeeded');
  assert.match(r.summary, /合并了 3 次/);
  assert.match(r.summary, /腾出 2 格/);
  assert.deepEqual(world.calls, ['cobblestone']);
  assert.equal(r.data?.freed, 2);
});

test('run：没有腾出空槽时说明散叠不多或已满叠', async () => {
  const world = new MergeStacksWorld();
  world.next = { ok: true, merged: 0, freed: 0 };
  const r = await mergeStacks.run(makeCtx(world), {});
  assert.equal(r.status, 'succeeded');
  assert.match(r.summary, /没有腾出空槽/);
  assert.deepEqual(world.calls, [undefined]);
});

test('run：适配器失败时透传失败', async () => {
  const world = new MergeStacksWorld();
  world.next = { ok: false, reason: 'NO_CLICK', merged: 0, freed: 0 };
  const r = await mergeStacks.run(makeCtx(world), {});
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /NO_CLICK/);
});

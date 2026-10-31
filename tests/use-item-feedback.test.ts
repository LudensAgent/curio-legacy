import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionResult } from '../src/adapter/types.ts';
import { useItem } from '../src/skills/actions.ts';
import { TestWorld, makeCtx } from './survival-helpers.ts';

/** 模拟适配器的 useItemOn：回预设结果，不做真实改动，专测 use_item 的反馈措辞 */
class FeedbackWorld extends TestWorld {
  useItemOnResult: ActionResult = { ok: true, effectEvidence: { verified: true, changed: true, reasons: ['方块变了：(2,63,0) water→air', '背包：bucket -1、water_bucket +1'] } };
  override async useItemOn(): Promise<ActionResult> {
    return this.useItemOnResult;
  }
}

test('装水成功时把实际变化（water_bucket +1）写进反馈，而不是只说 bucket 少了', async () => {
  const w = new FeedbackWorld();
  w.inv.set('bucket', 4);
  w.setBlock({ x: 2, y: 63, z: 0 }, 'water');
  const r = await useItem.run(makeCtx(w), { item: 'bucket', on: 'water' });
  assert.equal(r.status, 'succeeded');
  assert.match(r.summary, /water_bucket \+1/);
});

test('装水失败时给出「只能从源方块取、流动的取不了」的指引', async () => {
  const w = new FeedbackWorld();
  w.useItemOnResult = { ok: false, reason: 'NO_EFFECT:目标方块、邻格和背包均未变化' };
  w.inv.set('bucket', 4);
  w.setBlock({ x: 2, y: 63, z: 0 }, 'water');
  const r = await useItem.run(makeCtx(w), { item: 'bucket', on: 'water' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /只能从源方块取/);
});

test('非装流体的失败不追加取水指引', async () => {
  const w = new FeedbackWorld();
  w.useItemOnResult = { ok: false, reason: 'NO_EFFECT:目标方块、邻格和背包均未变化' };
  w.inv.set('flint_and_steel', 1);
  w.setBlock({ x: 2, y: 63, z: 0 }, 'stone');
  const r = await useItem.run(makeCtx(w), { item: 'flint_and_steel', on: 'stone' });
  assert.equal(r.status, 'failed');
  assert.doesNotMatch(r.summary, /只能从源方块取/);
});

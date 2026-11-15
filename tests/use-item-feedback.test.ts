import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionResult, Vec3Like } from '../src/adapter/types.ts';
import { useItem } from '../src/skills/actions.ts';
import { TestWorld, makeCtx } from './survival-helpers.ts';

/** 模拟适配器的 useItemOn：回预设结果，不做真实改动，专测 use_item 的反馈措辞 */
class FeedbackWorld extends TestWorld {
  useItemOnResult: ActionResult = { ok: true, effectEvidence: { verified: true, changed: true, reasons: ['方块变了：(2,63,0) water→air', '背包：bucket -1、water_bucket +1'] } };
  override async useItemOn(): Promise<ActionResult> {
    return this.useItemOnResult;
  }
}

/** 模拟坐标点火走的 useBlockAt；只测 use_item 的契约与反馈，不跑真实交互 */
class IgniteWorld extends TestWorld {
  useBlockAtCalls = 0;
  useBlockAtResult: ActionResult = { ok: true, effectEvidence: { verified: true, changed: true, reasons: ['方块变了：(0,64,2) air→nether_portal'] } };
  override async useBlockAt(): Promise<ActionResult> {
    this.useBlockAtCalls++;
    return this.useBlockAtResult;
  }
}

test('坐标点火对着空气格：BAD_ARGS，不执行右键，并把六邻事实说清楚', async () => {
  const w = new IgniteWorld();
  w.inv.set('flint_and_steel', 1);
  w.setBlock({ x: 0, y: 63, z: 2 }, 'obsidian');
  w.setBlock({ x: 0, y: 65, z: 2 }, 'netherrack');
  const r = await useItem.run(makeCtx(w), { item: 'flint_and_steel', on: { x: 0, y: 64, z: 2 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.equal(w.useBlockAtCalls, 0);
  assert.match(r.summary, /现在是 air/);
  assert.match(r.summary, /\(0,65,2\)=netherrack/);
});

test('坐标点火 fire_charge 同样拒绝空气格', async () => {
  const w = new IgniteWorld();
  w.inv.set('fire_charge', 1);
  const r = await useItem.run(makeCtx(w), { item: 'fire_charge', on: { x: 0, y: 64, z: 2 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.equal(w.useBlockAtCalls, 0);
});

test('门框内腔被占：NO_EFFECT 映射为 EFFECT_NOT_CONFIRMED，回执带点击格与六邻', async () => {
  const w = new IgniteWorld();
  w.inv.set('flint_and_steel', 1);
  w.setBlock({ x: 0, y: 63, z: 2 }, 'obsidian');
  w.useBlockAtResult = {
    ok: false,
    reason: 'NO_EFFECT:目标方块、邻格和背包均未变化',
    effectEvidence: { verified: true, changed: false, reasons: ['点击格与六邻：(0,63,2)=obsidian、(0,64,2)=air、(0,65,2)=netherrack', '目标、邻格和背包均未变化'] },
  };
  const r = await useItem.run(makeCtx(w), { item: 'flint_and_steel', on: { x: 0, y: 63, z: 2 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.match(r.summary, /点击格与六邻/);
  assert.match(r.summary, /netherrack/);
  assert.equal(w.useBlockAtCalls, 1);
});

test('点火成功后回执报告实际方块变化，而不只是点击格', async () => {
  const w = new IgniteWorld();
  w.inv.set('flint_and_steel', 1);
  w.setBlock({ x: 0, y: 63, z: 2 }, 'obsidian');
  const r = await useItem.run(makeCtx(w), { item: 'flint_and_steel', on: { x: 0, y: 63, z: 2 } });
  assert.equal(r.status, 'succeeded');
  assert.match(r.summary, /air→nether_portal/);
  assert.equal(w.useBlockAtCalls, 1);
});

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

test('装水只选源方块：附近只有流动水时报没有源', async () => {
  const w = new FeedbackWorld();
  w.inv.set('bucket', 4);
  w.setBlock({ x: 2, y: 63, z: 0 }, 'water');
  const ctx = makeCtx(w, {
    senses: {
      observeBlocks: (positions: Vec3Like[]) => positions.map((pos) => ({
        pos, name: 'water', properties: { level: 1 },
        worldId: w.worldId, sessionId: w.sessionId, dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
      })),
    },
  });
  const r = await useItem.run(ctx, { item: 'bucket', on: 'water' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'NOT_FOUND');
  assert.match(r.summary, /都是流动的/);
});

test('右键成功后在目标格记一条近期观察，下一次按名字查找不用再扫描', async () => {
  const w = new FeedbackWorld();
  w.inv.set('stone_hoe', 1);
  w.setBlock({ x: 2, y: 63, z: 0 }, 'grass_block');
  const exposed: Vec3Like[] = [];
  const ctx = makeCtx(w, {
    senses: {
      knownBlocks: () => [{ name: 'grass_block', pos: { x: 2, y: 63, z: 0 }, dist: 2 }],
      expose: (pos) => { exposed.push(pos); return 'farmland'; },
    },
  });
  const r = await useItem.run(ctx, { item: 'stone_hoe', on: 'grass_block' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(exposed, [{ x: 2, y: 63, z: 0 }]);
});

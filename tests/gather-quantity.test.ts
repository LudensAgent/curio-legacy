import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionResult, Vec3Like } from '../src/adapter/types.ts';
import { dropItemsOf } from '../src/methods/shortfall.ts';
import { gather } from '../src/skills/work.ts';
import { AbortedError, throwIfAborted } from '../src/util.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

/** 可控掉落物的采集世界：挖掉一块后按 dropsFor 增加背包物品，并记录实际挖了几块。 */
class DropWorld extends TestWorld {
  digs: Vec3Like[] = [];
  dropsFor: (block: string) => string[] = () => [];

  override async dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult> {
    throwIfAborted(signal);
    const name = this.blockAt(pos);
    if (!name || name === 'air') return { ok: false, reason: 'NO_BLOCK' };
    this.digs.push({ ...pos });
    this.setBlock(pos, 'air');
    for (const item of this.dropsFor(name)) this.inv.set(item, (this.inv.get(item) ?? 0) + 1);
    return { ok: true };
  }
}

const placeOre = (w: DropWorld, ...xs: number[]) => {
  for (const x of xs) w.setBlock({ x, y: 64, z: 0 }, 'iron_ore');
};

test('count 是背包目标总数：raw_iron 已有 2、目标 3，只再挖 1 块且回执按实际掉落物记账', async () => {
  const w = new DropWorld();
  w.inv.set('raw_iron', 2);
  w.dropsFor = (block) => block === 'iron_ore' ? ['raw_iron'] : [];
  placeOre(w, 1, 2);
  const ctx = makeCtx(w);
  try {
    const result = await gather.run(ctx, { block: 'iron_ore', count: 3 });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.deepEqual(result.data?.collection, {
      block: 'iron_ore', items: ['raw_iron'], initial: 2, target: 3, final: 3, gained: 1, dug: 1, targetMet: true,
    });
    assert.equal(w.digs.length, 1, '达到目标总数后不再多挖');
    assert.equal(result.data?.dug, 1);
    assert.match(result.summary, /raw_iron/);
    assert.doesNotMatch(result.summary, /采集了 1 个 iron_ore/, '不能把挖掉的方块当成采到的物品名');
  } finally { ctx.memory.close(); }
});

test('背包里已有 12 个、目标 6：不挖任何方块，回执说明目标已满足而不是矿采完了', async () => {
  const w = new DropWorld();
  w.inv.set('raw_iron', 12);
  placeOre(w, 1);
  const ctx = makeCtx(w);
  try {
    const result = await gather.run(ctx, { block: 'iron_ore', count: 6 });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.deepEqual(result.data?.collection, {
      block: 'iron_ore', items: ['raw_iron'], initial: 12, target: 6, final: 12, gained: 0, dug: 0, targetMet: true,
    });
    assert.equal(w.digs.length, 0);
    assert.match(result.summary, /raw_iron/);
    assert.match(result.summary, /12→12/);
    assert.match(result.summary, /目标 6/);
    assert.match(result.summary, /实得 \+0/);
    assert.match(result.summary, /挖了 0 块/);
    assert.doesNotMatch(result.summary, /采完了|没有矿|矿采完/);
  } finally { ctx.memory.close(); }
});

test('省略 count 时目标总数仍是 4', () => {
  const w = new DropWorld();
  const ctx = makeCtx(w);
  try {
    const v = gather.validate({ block: 'iron_ore' }, w);
    assert.ok(v.ok);
    assert.equal(v.args.count, 4);
  } finally { ctx.memory.close(); }
});

test('挖到的是无关物品时不能算作目标：实得 0，达到丢失上限后如实报失败', async () => {
  const w = new DropWorld();
  w.inv.set('raw_iron', 2);
  w.dropsFor = () => ['dirt'];
  placeOre(w, 1, 2, 3);
  const ctx = makeCtx(w);
  try {
    const result = await gather.run(ctx, { block: 'iron_ore', count: 3 });
    assert.equal(result.status, 'failed', result.summary);
    const collection = result.data?.collection as Record<string, unknown>;
    assert.equal(collection.initial, 2);
    assert.equal(collection.target, 3);
    assert.equal(collection.final, 2);
    assert.equal(collection.gained, 0, '无关拾取不能计入目标物品');
    assert.equal(collection.dug, 3);
    assert.equal(collection.lost, 3);
    assert.equal(collection.targetMet, false);
    assert.equal(result.data?.dug, 0, '顶层的 dug 仍是实际计入的采集数，不是挖掉的方块数');
    assert.match(result.summary, /目标物品都没进背包/);
  } finally { ctx.memory.close(); }
});

test('一块掉多个目标物品时，达到目标总数就停，不再为凑方块数多挖', async () => {
  const w = new DropWorld();
  w.dropsFor = (block) => block === 'iron_ore' ? ['raw_iron', 'raw_iron', 'raw_iron'] : [];
  placeOre(w, 1, 2, 3);
  const ctx = makeCtx(w);
  try {
    const result = await gather.run(ctx, { block: 'iron_ore', count: 3 });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.deepEqual(result.data?.collection, {
      block: 'iron_ore', items: ['raw_iron'], initial: 0, target: 3, final: 3, gained: 3, dug: 1, targetMet: true,
    });
    assert.equal(w.digs.length, 1, '一次多掉落已满足目标，不再挖第二块');
  } finally { ctx.memory.close(); }
});

test('部分采集：实得 1 但掉落一直没进背包，到上限后返回真实的部分结果', async () => {
  const w = new DropWorld();
  let digs = 0;
  w.dropsFor = () => ++digs === 1 ? ['raw_iron'] : ['dirt'];
  placeOre(w, 1, 2, 3, 4);
  const ctx = makeCtx(w);
  try {
    const result = await gather.run(ctx, { block: 'iron_ore', count: 3 });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.deepEqual(result.data?.collection, {
      block: 'iron_ore', items: ['raw_iron'], initial: 0, target: 3, final: 1, gained: 1, dug: 4, targetMet: false, lost: 3,
    });
    assert.equal(result.data?.dug, 1);
    assert.match(result.summary, /未达成/);
    assert.match(result.summary, /实得 \+1/);
  } finally { ctx.memory.close(); }
});

test('走到目标前已经捡够目标物品：不再为剩余数量多挖一块', async () => {
  const w = new DropWorld();
  w.inv.set('raw_iron', 1);
  w.dropsFor = () => ['raw_iron'];
  placeOre(w, 2, 3);
  const move = w.moveTo.bind(w);
  let pickedOnTheWay = false;
  w.moveTo = async (target, opts) => {
    await move(target, opts);
    if (!pickedOnTheWay && target.kind === 'reach_block') { pickedOnTheWay = true; w.inv.set('raw_iron', 3); }
  };
  const ctx = makeCtx(w);
  try {
    const result = await gather.run(ctx, { block: 'iron_ore', count: 3 });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.deepEqual(result.data?.collection, {
      block: 'iron_ore', items: ['raw_iron'], initial: 1, target: 3, final: 3, gained: 2, dug: 0, targetMet: true,
    });
    assert.equal(w.digs.length, 0, '途中捡够目标后不再挖');
  } finally { ctx.memory.close(); }
});

test('拾取阶段取消：保留取消错误，并把当前采集回执挂到 partial', async () => {
  const w = new DropWorld();
  w.dropsFor = () => ['raw_iron'];
  placeOre(w, 1);
  w.collectNearbyDrops = async () => { throw new AbortedError('cancelled during pickup'); };
  const ctx = makeCtx(w);
  try {
    await assert.rejects(gather.run(ctx, { block: 'iron_ore', count: 3 }), (error: unknown) => {
      const e = error as Error & { partial?: Record<string, unknown> };
      assert.equal(e.name, 'AbortedError', '不能把取消吞成成功');
      assert.equal(e.partial?.dug, 1);
      const collection = e.partial?.collection as Record<string, unknown>;
      assert.equal(collection.gained, 1);
      assert.equal(collection.dug, 1);
      assert.equal(collection.target, 3);
      assert.equal(collection.targetMet, false);
      return true;
    });
  } finally { ctx.memory.close(); }
});

test('目标物品没进背包时拾取取消：collection.dug 记实际挖掉，legacy dug 不冒充已取得', async () => {
  const w = new DropWorld();
  w.inv.set('raw_iron', 1);
  w.dropsFor = () => ['dirt']; // 当前块没有目标物品进背包
  placeOre(w, 1);
  w.collectNearbyDrops = async () => { throw new AbortedError('cancelled during pickup'); };
  const ctx = makeCtx(w);
  try {
    await assert.rejects(gather.run(ctx, { block: 'iron_ore', count: 3 }), (error: unknown) => {
      const e = error as Error & { partial?: Record<string, unknown> };
      assert.equal(e.name, 'AbortedError', '不能把取消吞成成功');
      assert.equal(e.partial?.dug, 0, '没进背包的当前块不算 legacy 产出');
      const collection = e.partial?.collection as Record<string, unknown>;
      assert.equal(collection.dug, 1, 'collection.dug 仍是实际挖掉块数');
      assert.equal(collection.initial, 1);
      assert.equal(collection.final, 1);
      assert.equal(collection.gained, 0);
      assert.equal(collection.targetMet, false);
      return true;
    });
  } finally { ctx.memory.close(); }
});

test('已有成功采集后，下一段移动取消仍保留当前采集回执', async () => {
  const w = new DropWorld();
  w.dropsFor = () => ['raw_iron'];
  placeOre(w, 2, 3);
  const move = w.moveTo.bind(w);
  let reaches = 0;
  w.moveTo = async (target, opts) => {
    if (target.kind === 'reach_block') { reaches++; if (reaches >= 2) throw new AbortedError('cancelled during move'); }
    await move(target, opts);
  };
  const ctx = makeCtx(w);
  try {
    await assert.rejects(gather.run(ctx, { block: 'iron_ore', count: 3 }), (error: unknown) => {
      const e = error as Error & { partial?: Record<string, unknown> };
      assert.equal(e.name, 'AbortedError', '移动取消仍保持取消语义');
      assert.equal(e.partial?.dug, 1);
      const collection = e.partial?.collection as Record<string, unknown>;
      assert.equal(collection.dug, 1);
      assert.equal(collection.initial, 0);
      assert.equal(collection.final, 1);
      assert.equal(collection.gained, 1);
      assert.equal(collection.targetMet, false);
      return true;
    });
  } finally { ctx.memory.close(); }
});

test('for 配方模式：目标物按配方缺的原材料记，回执给出实得与缺口', async () => {
  const w = new DropWorld();
  w.inv.set('raw_iron', 1);
  w.dropsFor = (block) => block === 'iron_ore' ? ['raw_iron'] : [];
  placeOre(w, 1, 2, 3);
  const ctx = makeCtx(w);
  try {
    // 一把铁镐需要 3 个铁锭 = 3 个 raw_iron；已有 1 个，只缺 2 个。
    assert.deepEqual(dropItemsOf('iron_ore'), ['raw_iron']);
    const result = await gather.run(ctx, { block: 'iron_ore', count: 8, for: { item: 'iron_pickaxe', count: 1 } });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.deepEqual(result.data?.collection, {
      block: 'iron_ore', items: ['raw_iron'], initial: 1, target: 3, final: 3, gained: 2, dug: 2, targetMet: true,
    });
    assert.equal(w.digs.length, 2, '只补配方缺口，不按 count=8 多挖');
    assert.match(result.summary, /iron_pickaxe/);
  } finally { ctx.memory.close(); }
});

test('挖到矿但掉落没进包时，回执带上仍记得的掉落坐标和脚下高差', async () => {
  const w = new DropWorld();
  w.dropsFor = () => [];
  placeOre(w, 1, 2, 3);
  let asked = 0;
  const ctx = makeCtx(w, { senses: {
    recentDrops: (maxAgeMs = 0) => { asked = maxAgeMs; return [{ id: 7, name: 'raw_iron', pos: { x: w.digs.length, y: 58, z: 0 }, ageMs: 5000 }]; },
  } });
  try {
    const result = await gather.run(ctx, { block: 'iron_ore', count: 3 });
    assert.equal(result.status, 'failed', result.summary);
    assert.equal(asked, 300_000, '采集回执也看五分钟内的掉落记录');
    assert.match(result.summary, /raw_iron \(1,58,0\)/);
    assert.match(result.summary, /在脚下 6 格/);
    const collection = result.data?.collection as Record<string, unknown>;
    assert.deepEqual(collection.lostDrops, [
      { name: 'raw_iron', pos: { x: 1, y: 58, z: 0 }, ageMs: 5000 },
      { name: 'raw_iron', pos: { x: 2, y: 58, z: 0 }, ageMs: 5000 },
      { name: 'raw_iron', pos: { x: 3, y: 58, z: 0 }, ageMs: 5000 },
    ], '三次丢失的坐标累积，不只保留最后一次');
  } finally { ctx.memory.close(); }
});

test('后续成功只捡到新挖方块自己的掉落时，不会把仍丢失的旧掉落误报成已找回', async () => {
  const w = new DropWorld();
  w.dropsFor = () => w.digs.length >= 3 ? ['raw_iron'] : [];
  placeOre(w, 1, 2, 3);
  const ctx = makeCtx(w, { senses: {
    recentDrops: () => [
      { id: 1, name: 'raw_iron', pos: { x: 1, y: 58, z: 0 }, ageMs: 5000 },
      { id: 2, name: 'raw_iron', pos: { x: 2, y: 58, z: 0 }, ageMs: 5000 },
    ],
  } });
  try {
    const result = await gather.run(ctx, { block: 'iron_ore', count: 3 });
    assert.equal(result.status, 'succeeded', result.summary);
    const collection = result.data?.collection as Record<string, unknown>;
    assert.equal(collection.lost, 2);
    assert.equal((collection.lostDrops as unknown[]).length, 2);
    assert.match(result.summary, /raw_iron \(1,58,0\)/);
  } finally { ctx.memory.close(); }
});

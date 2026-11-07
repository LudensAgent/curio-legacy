import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionResult, Vec3Like } from '../src/adapter/types.ts';
import { useItem } from '../src/skills/actions.ts';
import { saplingSoilFor, saplingSoilText } from '../src/perception/surroundings.ts';
import { placeCell } from '../src/skills/movement/primitives.ts';
import { sleep } from '../src/util.ts';
import { TestWorld, makeCtx, observeAllBlocks } from './survival-helpers.ts';

/** 树苗只能种在有效土壤上：桩复用生产规则 saplingSoilFor，place_cell 走适配器真实放置路径。 */
class SoilWorld extends TestWorld {
  override async placeBlockAt(pos: Vec3Like, itemNames: string[], signal: AbortSignal): Promise<ActionResult> {
    await sleep(10, signal);
    const name = itemNames.find((n) => (this.inv.get(n) ?? 0) > 0);
    if (!name) return { ok: false, reason: 'NO_ITEM' };
    if (this.blockAt(pos) !== 'air') return { ok: true };
    if (/(_sapling$)|^mangrove_propagule$/.test(name)) {
      const soil = this.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z }) ?? 'unknown';
      if (!saplingSoilFor(name).has(soil)) return { ok: false, reason: 'BAD_SUPPORT:' + name + ' 只能种在' + saplingSoilText(name) + '上，正下方是 ' + soil };
    }
    this.setBlock(pos, name);
    this.inv.set(name, (this.inv.get(name) ?? 1) - 1);
    return { ok: true };
  }
}

test('place_cell 把树苗种在相邻的有效土壤上，并按实际方块确认、扣除一棵', async (t) => {
  assert.ok(saplingSoilFor('mangrove_propagule').has('clay'), '红树苗的土壤规则来自生产函数');
  assert.equal(saplingSoilFor('oak_sapling').has('clay'), false, '普通树苗不接受黏土');
  const w = new SoilWorld();
  w.pos = { x: 1.5, y: 64, z: 1.5 };
  w.setBlock({ x: 1, y: 63, z: 0 }, 'grass_block');
  w.inv.set('oak_sapling', 2);
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  const r = await placeCell.run(c, { at: [1, 0, 0], facing: 'N', item: 'oak_sapling' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'oak_sapling');
  assert.equal(w.inv.get('oak_sapling'), 1);
});

test('place_cell 种在石头/黏土等非土壤上如实失败，且不放置、不消耗', async (t) => {
  for (const [soil, sapling] of [['stone', 'oak_sapling'], ['clay', 'oak_sapling'], ['stone', 'mangrove_propagule']] as const) {
    const w = new SoilWorld();
    w.pos = { x: 1.5, y: 64, z: 1.5 };
    w.setBlock({ x: 1, y: 63, z: 0 }, soil);
    w.inv.set(sapling, 1);
    const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
    t.after(() => c.memory.close());
    const r = await placeCell.run(c, { at: [1, 0, 0], facing: 'N', item: sapling });
    assert.equal(r.status, 'failed', sapling + ' on ' + soil + ': ' + r.summary);
    assert.match(r.summary, /BAD_SUPPORT/, sapling + ' on ' + soil + ' 要带出适配器的土壤原因');
    assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'air', '没有种下');
    assert.equal(w.inv.get(sapling), 1, '失败不消耗树苗');
  }
});

test('use_item 对坐标种树苗给出 place_cell / 土壤方块名的明确指引', async (t) => {
  const w = new TestWorld();
  w.inv.set('oak_sapling', 1);
  const c = makeCtx(w);
  t.after(() => c.memory.close());
  const r = await useItem.run(c, { item: 'oak_sapling', on: { x: 0, y: 64, z: -1 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /place_cell/);
  assert.match(r.summary, /grass_block/);
  assert.doesNotMatch(r.summary, /只支持满桶|打火石/, '不应落到桶/点火专用的报错');
  assert.equal(w.inv.get('oak_sapling'), 1, '未种下不应消耗树苗');
});

/** 模拟适配器对土壤右键种树苗：在目标土壤正上方生成树苗并扣物品，同时记录收到的参数。 */
class PlantingWorld extends TestWorld {
  lastCall: { item: string; target: { kind: 'block'; pos: Vec3Like } | { kind: 'self' } } | null = null;
  override async useItemOn(
    item: string,
    target: { kind: 'block'; pos: Vec3Like } | { kind: 'self' },
    signal: AbortSignal,
  ): Promise<ActionResult & { spawned?: string; placed?: Vec3Like }> {
    this.lastCall = { item, target };
    if (target.kind === 'block' && /_sapling$/.test(item)) {
      const dest = { x: target.pos.x, y: target.pos.y + 1, z: target.pos.z };
      if (this.blockAt(dest) !== 'air') return { ok: false, reason: 'BLOCKED' };
      if (!['grass_block', 'dirt'].includes(this.blockAt(target.pos))) return { ok: false, reason: 'BAD_SUPPORT' };
      this.setBlock(dest, item);
      this.inv.set(item, (this.inv.get(item) ?? 1) - 1);
      return { ok: true, placed: dest, effectEvidence: { verified: true, changed: true, reasons: [`${item} 已出现在 ${dest.x},${dest.y},${dest.z}`] } };
    }
    return super.useItemOn(item, target, signal);
  }
}

test('use_item 手持树苗对看得见的草方块右键能种下并确认落点', async (t) => {
  const w = new PlantingWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('oak_sapling', 1);
  w.setBlock({ x: 0, y: 63, z: -1 }, 'grass_block');
  const c = makeCtx(w);
  t.after(() => c.memory.close());
  const r = await useItem.run(c, { item: 'oak_sapling', on: 'grass_block' });
  assert.equal(r.status, 'succeeded', r.summary);
  // use_item 必须把命中的土壤方块作为 block 目标交给适配器（真实适配器据此在顶面放置）。
  assert.deepEqual(w.lastCall, { item: 'oak_sapling', target: { kind: 'block', pos: { x: 0, y: 63, z: -1 } } });
  assert.deepEqual(r.data?.placed, { x: 0, y: 64, z: -1 });
  assert.match(r.summary, /oak_sapling 已出现在 0,64,-1/);
  assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'oak_sapling');
  assert.equal(w.inv.get('oak_sapling'), 0);
});

test('use_item 对坐标种红树苗同样给出树苗指引', async (t) => {
  const w = new TestWorld();
  w.inv.set('mangrove_propagule', 1);
  const c = makeCtx(w);
  t.after(() => c.memory.close());
  const r = await useItem.run(c, { item: 'mangrove_propagule', on: { x: 0, y: 64, z: -1 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /place_cell/);
  assert.match(r.summary, /mangrove_propagule/);
  assert.equal(w.inv.get('mangrove_propagule'), 1);
});

/** 模拟适配器对非土壤目标的确定性拒绝（真实适配器在 placeItemAgainst 之前做同样检查）。 */
class BadSupportWorld extends TestWorld {
  override async useItemOn(
    item: string,
    _target: { kind: 'block'; pos: Vec3Like } | { kind: 'self' },
  ): Promise<ActionResult> {
    return { ok: false, reason: `BAD_SUPPORT:${item} 不能种在 stone 上，只能种在草方块/泥土等土壤上`, effectEvidence: { verified: true, changed: false, reasons: [] } };
  }
}

test('use_item 把适配器的 BAD_SUPPORT 反馈成 BAD_ARGS 而不是泛化执行错误', async (t) => {
  const w = new BadSupportWorld();
  w.inv.set('oak_sapling', 1);
  w.setBlock({ x: 0, y: 63, z: -1 }, 'stone');
  const c = makeCtx(w);
  t.after(() => c.memory.close());
  const r = await useItem.run(c, { item: 'oak_sapling', on: 'stone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /BAD_SUPPORT/);
  assert.match(r.summary, /stone/);
});

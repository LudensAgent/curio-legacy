import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionResult, Vec3Like } from '../src/adapter/types.ts';
import { useItem } from '../src/skills/actions.ts';
import { placeAt } from '../src/skills/primitives.ts';
import { TestWorld, makeCtx, observeAllBlocks } from './survival-helpers.ts';

test('place_at 把树苗种在相邻的有效土壤上，并按实际方块确认', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('oak_sapling', 2);
  // 面朝北，[1,0,0] = (0,64,-1)，正下方 (0,63,-1) 是默认草方块。
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  const r = await placeAt.run(c, { at: [1, 0, 0], facing: 'N', item: 'oak_sapling' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'oak_sapling');
  assert.equal(w.inv.get('oak_sapling'), 1, '成功放置应消耗一个树苗');
});

test('place_at 拒绝种在空气/石头下方，并明确报出下方方块', async (t) => {
  for (const below of ['air', 'stone'] as const) {
    const w = new TestWorld();
    w.pos = { x: 0.5, y: 64, z: 0.5 };
    w.inv.set('oak_sapling', 1);
    w.setBlock({ x: 0, y: 63, z: -1 }, below);
    const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
    t.after(() => c.memory.close());
    const r = await placeAt.run(c, { at: [1, 0, 0], facing: 'N', item: 'oak_sapling' });
    assert.equal(r.status, 'failed', `${below}: ${r.summary}`);
    assert.equal(r.failureCode, 'BAD_ARGS');
    assert.match(r.summary, new RegExp(`正下方 \\(0,63,-1\\) 是 ${below}`));
    assert.match(r.summary, /树苗只能种在/);
    assert.equal(r.data?.support, below);
    assert.doesNotMatch(r.summary, /悬空|看不见那个面/, '土壤错误不应落进泛化放置反馈');
    assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'air', '失败不应放置');
    assert.equal(w.inv.get('oak_sapling'), 1, '失败不应消耗树苗');
  }
});

/** 下方土壤有效，但放置面看不见/够不到：模拟真实适配器返回具体细节。 */
class NoFaceWorld extends TestWorld {
  override async placeBlockAt(): Promise<ActionResult> {
    return { ok: false, reason: 'NO_REFERENCE', detail: '(0,64,-1) 有 1 个相邻实心方块，但从当前眼睛位置到这些面的视线被挡或超出 4.4 格；先退后一步或侧移换个角度，让目标格和相邻方块的面进入视野再放' };
  }
}

test('place_at 土壤有效但看不到/够不到面时保留适配器细节，不回退成“悬空”', async (t) => {
  const w = new NoFaceWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('oak_sapling', 1);
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  const r = await placeAt.run(c, { at: [1, 0, 0], facing: 'N', item: 'oak_sapling' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /视线被挡或超出 4\.4 格/);
  assert.match(r.summary, /退后一步或侧移/);
  assert.doesNotMatch(r.summary, /四周已看清|悬空/);
});

test('use_item 对坐标种树苗给出 place_at / 土壤方块名的明确指引', async (t) => {
  const w = new TestWorld();
  w.inv.set('oak_sapling', 1);
  const c = makeCtx(w);
  t.after(() => c.memory.close());
  const r = await useItem.run(c, { item: 'oak_sapling', on: { x: 0, y: 64, z: -1 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /place_at/);
  assert.match(r.summary, /grass_block/);
  assert.doesNotMatch(r.summary, /只支持满桶|打火石/, '不应落到桶/点火专用的报错');
  assert.equal(w.inv.get('oak_sapling'), 1, '未种下不应消耗树苗');
});

/** 模拟适配器对土壤右键种树苗：在目标土壤正上方生成树苗并扣物品。 */
class PlantingWorld extends TestWorld {
  override async useItemOn(
    item: string,
    target: { kind: 'block'; pos: Vec3Like } | { kind: 'self' },
    signal: AbortSignal,
  ): Promise<ActionResult & { spawned?: string; placed?: Vec3Like }> {
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
  assert.deepEqual(r.data?.placed, { x: 0, y: 64, z: -1 });
  assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'oak_sapling');
  assert.equal(w.inv.get('oak_sapling'), 0);
});

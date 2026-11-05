import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionResult, Vec3Like } from '../src/adapter/types.ts';
import { useItem } from '../src/skills/actions.ts';
import { placeAt, primitiveSkills } from '../src/skills/primitives.ts';
import type { SkillCtx, SkillResult } from '../src/skills/types.ts';
import { TestWorld, makeCtx, observeAllBlocks } from './survival-helpers.ts';

/** primitiveSkills 里的 place_at 带 withAbsolute 包装（xyz → 相对格），单独取出并收窄参数类型。 */
const placeAtAbsolute = primitiveSkills.find((skill) => skill.name === 'place_at') as unknown as {
  run(ctx: SkillCtx, args: { at: [number, number, number]; facing: 'N'; item: string; xyz?: Vec3Like }): Promise<SkillResult>;
};

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

test('place_at [0,0,0] 的树苗按普通放置种在脚下，不走原地垫高', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('oak_sapling', 1);
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  const r = await placeAt.run(c, { at: [0, 0, 0], facing: 'N', item: 'oak_sapling' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 64, z: 0 }), 'oak_sapling', '树苗应种在自己脚这一格');
  assert.equal(w.pos.y, 64, '没有被垫高一格');
  assert.doesNotMatch(r.summary, /原地垫高|站高/, '树苗不是垫柱材料');
});

test('place_at 绝对坐标 xyz 用目标格正下方做土壤检查并种下', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('oak_sapling', 1);
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  // (0,64,-1) 正下方 (0,63,-1) 是默认草方块；withAbsolute 应换算成相对 [1,0,0] 并对这一格做支撑检查。
  const r = await placeAtAbsolute.run(c, { at: [0, 0, 0], facing: 'N', item: 'oak_sapling', xyz: { x: 0, y: 64, z: -1 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.targetCell, { x: 0, y: 64, z: -1 });
  assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'oak_sapling');
  assert.equal(w.blockAt({ x: 0, y: 63, z: -1 }), 'grass_block', '支撑格保持原样');

  // 同一绝对目标格换成石头下方：支撑检查必须落到 (0,63,-1)，而不是换算前的占位 [0,0,0] 或其他格子。
  const bad = new TestWorld();
  bad.pos = { x: 0.5, y: 64, z: 0.5 };
  bad.inv.set('oak_sapling', 1);
  bad.setBlock({ x: 0, y: 63, z: -1 }, 'stone');
  const badCtx = makeCtx(bad, { senses: { observeBlocks: observeAllBlocks(bad) } });
  t.after(() => badCtx.memory.close());
  const failed = await placeAtAbsolute.run(badCtx, { at: [0, 0, 0], facing: 'N', item: 'oak_sapling', xyz: { x: 0, y: 64, z: -1 } });
  assert.equal(failed.status, 'failed');
  assert.match(failed.summary, /正下方 \(0,63,-1\) 是 stone/);
  assert.equal(bad.blockAt({ x: 0, y: 64, z: -1 }), 'air');
});

test('place_at 把红树苗 mangrove_propagule 按树苗规则种在泥上', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('mangrove_propagule', 1);
  w.setBlock({ x: 0, y: 63, z: -1 }, 'mud');
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  const r = await placeAt.run(c, { at: [1, 0, 0], facing: 'N', item: 'mangrove_propagule' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'mangrove_propagule');
});

test('place_at 红树苗可以种在黏土上（clay 只对红树苗有效）', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('mangrove_propagule', 1);
  w.setBlock({ x: 0, y: 63, z: -1 }, 'clay');
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  const r = await placeAt.run(c, { at: [1, 0, 0], facing: 'N', item: 'mangrove_propagule' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'mangrove_propagule');
});

test('place_at 普通树苗在黏土上仍失败并明确报支撑', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('oak_sapling', 1);
  w.setBlock({ x: 0, y: 63, z: -1 }, 'clay');
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  const r = await placeAt.run(c, { at: [1, 0, 0], facing: 'N', item: 'oak_sapling' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /正下方 \(0,63,-1\) 是 clay/);
  assert.match(r.summary, /普通树苗不能种在黏土上/);
  assert.equal(w.inv.get('oak_sapling'), 1);
});

test('place_at 红树苗种在石头下同样明确报支撑错误', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('mangrove_propagule', 1);
  w.setBlock({ x: 0, y: 63, z: -1 }, 'stone');
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  const r = await placeAt.run(c, { at: [1, 0, 0], facing: 'N', item: 'mangrove_propagule' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /正下方 \(0,63,-1\) 是 stone/);
  assert.match(r.summary, /mangrove_propagule/);
  assert.doesNotMatch(r.summary, /悬空|看不见那个面/);
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
    assert.match(r.summary, /只能种在/);
    assert.equal(r.data?.support, below);
    assert.doesNotMatch(r.summary, /悬空|看不见那个面/, '土壤错误不应落进泛化放置反馈');
    assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'air', '失败不应放置');
    assert.equal(w.inv.get('oak_sapling'), 1, '失败不应消耗树苗');
  }
});

/** 下方土壤有效，但放置面看不见/够不到：模拟真实适配器返回具体细节。 */
class NoFaceWorld extends TestWorld {
  override async placeBlockAt(): Promise<ActionResult> {
    return { ok: false, reason: 'NO_REFERENCE', detail: '(0,64,-1) 有 1 个相邻实心方块，但从当前眼睛位置到这些面的视线被挡或超出 4.4 格；调整站位（靠近或侧移）让目标面和相邻方块进入视野/交互距离再放' };
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
  assert.match(r.summary, /调整站位（靠近或侧移）/);
  assert.match(r.summary, /交互距离/);
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
  assert.match(r.summary, /place_at/);
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

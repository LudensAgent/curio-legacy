import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { moveStep, mineCell, placeCell, placeSupport, pillarOne } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

const visibleTargets = (w: FakeAdapter) => (positions: Vec3Like[]) => positions.flatMap((pos) => {
  const name = w.blockAt(pos);
  return name === null ? [] : [{
    name, pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  }];
});

function flat() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  return w;
}

function pocket() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 60, z: 0.5 };
  w.removed.add('0,60,0');
  w.removed.add('0,61,0');
  return w;
}

/** 记录这次挖掘实际请求的工具/手持选项；held 模拟主手当前物品。 */
class ToolWorld extends FakeAdapter {
  heldTool: string | null = null;
  digOpts: { tool?: string | null; handOnly?: boolean }[] = [];
  equipAttempts: string[] = [];
  /** 这些工具能挖开但采不到掉落（例如石斧挖下界岩） */
  breakOnly = new Set<string>();
  override state() { return { ...super.state(), held: this.heldTool }; }
  override async equipItem(name: string, destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet', signal: AbortSignal) {
    this.equipAttempts.push(name);
    return super.equipItem(name, destination, signal);
  }
  override async dig(pos: Vec3Like, signal: AbortSignal, opts?: { tool?: string | null; handOnly?: boolean }) {
    this.digOpts.push({ ...(opts ?? {}) });
    // 模拟旧适配器的自动换手：只有 tool/handOnly 都没传时才向背包要工具；mine_cell 不应触发。
    if (!opts?.tool && !opts?.handOnly) {
      const tool = [...this.inv.keys()].find((n) => /_pickaxe$/.test(n));
      if (tool) await this.equipItem(tool, 'hand', signal);
    }
    const tool = opts?.tool;
    if (tool && (this.inv.get(tool) ?? 0) <= 0) return { ok: false, reason: `TOOL_MISSING: 背包里没有 ${tool}` };
    const r = await super.dig(pos, signal);
    if (r.ok && tool && this.breakOnly.has(tool)) return { ...r, noDrop: true, digMs: 456 };
    // 模拟空手挖石头的真实结果：能挖开，但什么都不掉。
    return opts?.handOnly && !this.heldTool ? { ...r, noDrop: true, digMs: 123 } : r;
  }
}

/** 挖掉后立刻在目标格放回一块下落方块，模拟沙砾/沙子回填。 */
class BackfillWorld extends FakeAdapter {
  backfill: string | null = null;
  override async dig(pos: Vec3Like, signal: AbortSignal) {
    const r = await super.dig(pos, signal);
    if (r.ok && this.backfill) {
      this.blocks.push({ name: this.backfill, pos: { ...pos } });
      this.removed.delete(`${pos.x},${pos.y},${pos.z}`);
    }
    return r;
  }
}

/** 可配置的垫高：rise>1 模拟多升了一格；placeSupportBlock=false 模拟只报成功但没留下支撑。 */
class PillarWorld extends FakeAdapter {
  rise = 1;
  placeSupportBlock = true;
  override async pillarUp(itemNames: string[], signal: AbortSignal) {
    if (!this.placeSupportBlock) {
      const item = itemNames.find((n) => (this.inv.get(n) ?? 0) > 0);
      if (!item) return { ok: false, reason: 'NO_ITEM' };
      this.inv.set(item, this.inv.get(item)! - 1);
      this.pos = { ...this.pos, y: Math.floor(this.pos.y) + 1 };
      return { ok: true, y: Math.floor(this.pos.y) };
    }
    const r = await super.pillarUp(itemNames, signal);
    if (r.ok && this.rise > 1) this.pos = { ...this.pos, y: this.pos.y + (this.rise - 1) };
    return r;
  }
}

function pillarPocket<T extends FakeAdapter>(w: T): T {
  w.pos = { x: 0.5, y: 60, z: 0.5 };
  w.removed.add('0,60,0');
  w.removed.add('0,61,0');
  w.removed.add('0,62,0');
  w.inv.set('cobblestone', 2);
  return w;
}

function stoneAtFeet<T extends FakeAdapter>(w: T): T {
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  return w;
}

test('move_step 同层：站到相邻格，按实际脚高验收', async (t) => {
  const w = flat();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const v = moveStep.validate({ to: [1, 0, 0], facing: 'E' }, w);
  assert.ok(v.ok, !v.ok ? v.error : '');
  const r = await moveStep.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(w.pos.x), 1);
  assert.equal(Math.floor(w.pos.y), 64);
});

test('move_step 下一级：只接受正好低 1 格的目标脚高', async (t) => {
  const w = flat();
  w.removed.add('1,63,0');
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const ok = await moveStep.run(ctx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(ok.status, 'succeeded', ok.summary);
  assert.equal(Math.floor(w.pos.y), 63);
});

test('move_step 支持半砖的分数脚高（相对和绝对 xyz）', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  w.blockProperties.set('1,63,0', { type: 'bottom' });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const relative = await moveStep.run(ctx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(relative.status, 'succeeded', relative.summary);
  assert.equal(w.pos.y, 63.5);

  const w2 = flat();
  w2.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  w2.blockProperties.set('1,63,0', { type: 'bottom' });
  const ctx2 = makeCtx(w2);
  t.after(() => ctx2.memory.close());
  const absolute = await moveStep.run(ctx2, { at: [0, 0, 0], facing: 'N', xyz: { x: 1, y: 63.5, z: 0 } });
  assert.equal(absolute.status, 'succeeded', absolute.summary);
  assert.equal(w2.pos.y, 63.5);
});

test('move_step 不自动改落点：目标列下方多格才有地面时拒绝', async (t) => {
  const w = flat();
  for (const key of ['1,63,0', '1,62,0']) w.removed.add(key);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.movementNotAttempted, true);
  assert.match(r.summary, /descend_to|可站立面/);
});

test('move_step 绝对脚高与真实支撑不符时拒绝，不悄悄改落点', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  w.blockProperties.set('1,63,0', { type: 'bottom' });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const before = { ...w.pos };
  const r = await moveStep.run(ctx, { at: [0, 0, 0], facing: 'E', xyz: { x: 1, y: 64, z: 0 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.movementNotAttempted, true);
  assert.equal(r.data?.actualSupport, 63.5);
  assert.deepEqual(w.pos, before);
});

test('move_step 文档与实际半格/落差规则一致', async (t) => {
  // 文档必须写清实际接受的规则：上一级 0.5–1 格（半砖提示 [1,1,0]），下一级支撑顶面低 0.5–1 格。
  assert.match(moveStep.description, /0\.5[–-]1/);
  assert.match(moveStep.description, /\[1,1,0\]/);
  assert.match(moveStep.argsDoc, /\[1,1,0\]/);
  assert.match(moveStep.argsDoc, /0\.5[–-]1/);

  const up = flat();
  up.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 64, z: 0 } });
  up.blockProperties.set('1,64,0', { type: 'bottom' });
  const upCtx = makeCtx(up);
  t.after(() => upCtx.memory.close());
  const rise = await moveStep.run(upCtx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(rise.status, 'succeeded', rise.summary);
  assert.equal(up.pos.y, 64.5, '向上半格用 [1,1,0]');

  const down = flat();
  down.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  down.blockProperties.set('1,63,0', { type: 'bottom' });
  const downCtx = makeCtx(down);
  t.after(() => downCtx.memory.close());
  const drop = await moveStep.run(downCtx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(drop.status, 'succeeded', drop.summary);
  assert.equal(down.pos.y, 63.5, '下一级按支撑顶面可低 0.5 格');

  const same = flat();
  same.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  same.blockProperties.set('1,63,0', { type: 'bottom' });
  const sameCtx = makeCtx(same);
  t.after(() => sameCtx.memory.close());
  const level = await moveStep.run(sameCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(level.status, 'failed', '同层脚高必须一致');

  const low = flat();
  low.blocks.push({ name: 'snow', pos: { x: 1, y: 64, z: 0 } });
  low.blockProperties.set('1,64,0', { layers: 2 });
  const lowCtx = makeCtx(low);
  t.after(() => lowCtx.memory.close());
  const notEnough = await moveStep.run(lowCtx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(notEnough.status, 'failed', '上一级不足 0.5 格不算迈上台阶');

  const high = flat();
  high.blocks.push({ name: 'snow', pos: { x: 1, y: 63, z: 0 } });
  high.blockProperties.set('1,63,0', { layers: 6 });
  const highCtx = makeCtx(high);
  t.after(() => highCtx.memory.close());
  const tooHigh = await moveStep.run(highCtx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(tooHigh.status, 'failed', '下一级落差不足 0.5 格不算下一级');
});

test('move_step 同列向上只能沿梯子', () => {
  const w = flat();
  const bad = moveStep.validate({ to: [0, 1, 0], facing: 'E' }, w);
  assert.equal(bad.ok, false);
  w.blocks.push({ name: 'ladder', pos: { x: 0, y: 64, z: 0 } });
  const good = moveStep.validate({ to: [0, 1, 0], facing: 'E' }, w);
  assert.ok(good.ok, !good.ok ? good.error : '');
});

test('mine_cell：只挖指定格，液体邻格默认拒绝，wet 显式接受', async (t) => {
  const w = pocket();
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 60, z: -1 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 0, y: 60, z: -1 }), 'air');

  w.blocks.push({ name: 'stone', pos: { x: 0, y: 60, z: -2 }, });
  w.blocks.push({ name: 'water', pos: { x: 0, y: 60, z: -3 } });
  ctx.senses.observeBlocks = visibleTargets(w);
  const wet = await mineCell.run(ctx, { at: [2, 0, 0], facing: 'N' });
  assert.equal(wet.status, 'failed');
  assert.match(wet.summary, /water/);
});

test('mine_cell 不做未观察的推测：目标看不见时返回未知且不挖', async (t) => {
  const w = pocket();
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 60, z: -1 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(w.blockAt({ x: 0, y: 60, z: -1 }), 'stone', '未观察的格子不能被挖');
  assert.equal(r.data?.unknown, true);
});

test('place_cell：放置请求的材料，已有不同材料只报占用', async (t) => {
  const w = flat();
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const ok = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(ok.status, 'succeeded', ok.summary);
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'cobblestone');
  const again = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(again.status, 'succeeded');
  assert.equal(again.data?.noop, true);
  const wrong = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'dirt' });
  assert.equal(wrong.status, 'failed');
  assert.match(wrong.summary, /占据/);
});

test('place_support：已有可站立顶面不消耗材料；空支撑格才放', async (t) => {
  const w = flat();
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const existing = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(existing.status, 'succeeded', existing.summary);
  assert.equal(existing.data?.noop, true);
  assert.equal(w.inv.get('cobblestone'), 2);

  w.removed.add('1,63,0');
  const placed = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(placed.status, 'succeeded', placed.summary);
  assert.equal(w.blockAt({ x: 1, y: 63, z: 0 }), 'cobblestone');
  assert.equal(w.inv.get('cobblestone'), 1);
});

test('place_support 支持脚下方两格', async (t) => {
  const w = flat();
  w.removed.add('1,62,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -2, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 1, y: 62, z: 0 }), 'cobblestone');
});

test('pillar_one：垫高一级；头顶受阻时返回具体失败', async (t) => {
  const w = pocket();
  w.removed.add('0,62,0');
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await pillarOne.run(ctx, {});
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(w.pos.y), 61);
  assert.equal(w.blockAt({ x: 0, y: 60, z: 0 }), 'cobblestone');

  w.blocks.push({ name: 'stone', pos: { x: 0, y: 62, z: 0 } });
  const blocked = await pillarOne.run(ctx, {});
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.summary, /头顶|跳跃空间/);
});

test('mine_cell：相对和绝对 xyz 同样校验 tool，只用指定或当前手持工具', async (t) => {
  const badRel = mineCell.validate({ at: [1, 0, 0], facing: 'E', tool: 'Iron Pickaxe' }, flat());
  const badAbs = mineCell.validate({ xyz: [1, 64, 0], facing: 'E', tool: 'Iron Pickaxe' }, flat());
  assert.equal(badRel.ok, false);
  assert.equal(badAbs.ok, false, '绝对 xyz 分支也要校验 tool');
  const goodAbs = mineCell.validate({ xyz: [1, 64, 0], facing: 'E', tool: 'iron_pickaxe' }, flat());
  assert.ok(goodAbs.ok, !goodAbs.ok ? goodAbs.error : '');
  assert.equal(goodAbs.args.tool, 'iron_pickaxe');

  const heldWorld = stoneAtFeet(new ToolWorld());
  heldWorld.heldTool = 'wooden_pickaxe';
  heldWorld.inv.set('wooden_pickaxe', 1);
  heldWorld.inv.set('iron_pickaxe', 1);
  const heldCtx = makeCtx(heldWorld, { senses: { observeBlocks: visibleTargets(heldWorld) } });
  t.after(() => heldCtx.memory.close());
  const held = await mineCell.run(heldCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(held.status, 'succeeded', held.summary);
  assert.deepEqual(heldWorld.digOpts, [{ handOnly: true }], '没指定 tool 时只准用当前手持');
  assert.deepEqual(heldWorld.equipAttempts, [], '不能换成背包里更快的铁镐');
  assert.equal(heldWorld.heldTool, 'wooden_pickaxe');
  assert.equal(held.data?.noDrop, false, '手持工具挖石头应当有掉落事实');

  const emptyWorld = stoneAtFeet(new ToolWorld());
  emptyWorld.heldTool = null;
  emptyWorld.inv.set('iron_pickaxe', 1);
  const emptyCtx = makeCtx(emptyWorld, { senses: { observeBlocks: visibleTargets(emptyWorld) } });
  t.after(() => emptyCtx.memory.close());
  const empty = await mineCell.run(emptyCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(empty.status, 'succeeded', empty.summary);
  assert.deepEqual(emptyWorld.digOpts, [{ handOnly: true }], '空手时也要明确只要当前手持');
  assert.deepEqual(emptyWorld.equipAttempts, [], '空手时不能从背包自选/自动装备工具');
  assert.equal(empty.data?.noDrop, true, '空手挖石头成功回执必须带 noDrop 事实');
  assert.equal(empty.data?.digMs, 123, '适配器返回的实测耗时也要带回');
  assert.doesNotMatch(empty.summary, /进了背包|已获得/);

  const explicitWorld = stoneAtFeet(new ToolWorld());
  explicitWorld.heldTool = 'wooden_pickaxe';
  explicitWorld.inv.set('wooden_pickaxe', 1);
  explicitWorld.inv.set('iron_pickaxe', 1);
  const explicitCtx = makeCtx(explicitWorld, { senses: { observeBlocks: visibleTargets(explicitWorld) } });
  t.after(() => explicitCtx.memory.close());
  const explicit = await mineCell.run(explicitCtx, { at: [0, 0, 0], facing: 'E', xyz: { x: 1, y: 64, z: 0 }, tool: 'iron_pickaxe' });
  assert.equal(explicit.status, 'succeeded', explicit.summary);
  assert.deepEqual(explicitWorld.digOpts, [{ tool: 'iron_pickaxe' }], '指定的工具优先于手持');
  assert.deepEqual(explicitWorld.equipAttempts, [], '显式工具由适配器只装这一把');

  const missingWorld = stoneAtFeet(new ToolWorld());
  const missingCtx = makeCtx(missingWorld, { senses: { observeBlocks: visibleTargets(missingWorld) } });
  t.after(() => missingCtx.memory.close());
  const missing = await mineCell.run(missingCtx, { at: [1, 0, 0], facing: 'E', tool: 'iron_pickaxe' });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.failureCode, 'TOOL_MISSING');
  assert.deepEqual(missingWorld.digOpts, [{ tool: 'iron_pickaxe' }]);
  assert.equal(missingWorld.actions.some((a) => a.startsWith('craft:')), false, '缺工具不能自动造');
  assert.equal(missingWorld.blockAt({ x: 1, y: 64, z: 0 }), 'stone');
});

test('mine_cell：指定工具采不到掉落时照样挖开并回报 noDrop，不自动换工具', async (t) => {
  const w = new ToolWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'netherrack', pos: { x: 1, y: 64, z: 0 } });
  w.inv.set('stone_axe', 1);
  w.inv.set('iron_pickaxe', 1);
  w.breakOnly.add('stone_axe');
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E', tool: 'stone_axe' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.noDrop, true, '采不到掉落是事实，不是拒绝挖开的理由');
  assert.equal(r.data?.digMs, 456);
  assert.deepEqual(w.digOpts, [{ tool: 'stone_axe' }], '只用调用者指定的工具');
  assert.deepEqual(w.equipAttempts, [], '背包里有镐也不能自动换用');
  assert.equal(w.actions.some((a) => a.startsWith('craft:')), false, '缺工具不能自动造');
});

test('mine_cell [0,-1,0] 挖脚部支撑格：下半砖/床/雪层/整块', async (t) => {
  const cases: { label: string; name: string; properties: Record<string, string | number | boolean>; footY: number }[] = [
    { label: '下半砖', name: 'stone_slab', properties: { type: 'bottom' }, footY: 63.5 },
    { label: '床', name: 'red_bed', properties: { part: 'foot', facing: 'north' }, footY: 63.5625 },
    { label: '雪层', name: 'snow', properties: { layers: 3 }, footY: 63.375 },
    { label: '整块', name: 'grass_block', properties: {}, footY: 64 },
  ];
  const target = { x: 0, y: 63, z: 0 };
  for (const c of cases) {
    const w = new FakeAdapter();
    w.pos = { x: 0.5, y: c.footY, z: 0.5 };
    w.blocks.push({ name: c.name, pos: { ...target } });
    w.blockProperties.set('0,63,0', c.properties);
    const ctx = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
    t.after(() => ctx.memory.close());
    const r = await mineCell.run(ctx, { at: [0, -1, 0], facing: 'N' });
    assert.equal(r.status, 'succeeded', `${c.label}：${r.summary}`);
    assert.equal(w.blockAt(target), 'air', `${c.label}：脚部支撑格应被挖掉`);
    assert.equal(w.blockAt({ x: 0, y: 62, z: 0 }), 'stone', `${c.label}：不能挖到支撑格下面那格`);
    assert.deepEqual(r.data?.targetCell, target, `${c.label}：回执目标格`);
  }
});

test('pillar_one 用实际 yaw 报朝向；成功要求精确 +1 和实测支撑', async (t) => {
  const success = pillarPocket(new PillarWorld());
  success.yaw = Math.PI / 2; // 面朝西
  const successCtx = makeCtx(success);
  t.after(() => successCtx.memory.close());
  const r = await pillarOne.run(successCtx, {});
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.facing, 'W');
  assert.equal((r.data?.local as { facing?: string } | undefined)?.facing, 'W');
  assert.deepEqual(r.data?.support, { pos: { x: 0, y: 60, z: 0 }, name: 'cobblestone' });

  const high = pillarPocket(new PillarWorld());
  high.yaw = Math.PI / 2;
  high.rise = 2;
  const highCtx = makeCtx(high);
  t.after(() => highCtx.memory.close());
  const over = await pillarOne.run(highCtx, {});
  assert.equal(over.status, 'failed');
  assert.equal(over.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(over.data?.facing, 'W');

  const floating = pillarPocket(new PillarWorld());
  floating.yaw = Math.PI / 2;
  floating.placeSupportBlock = false;
  const floatingCtx = makeCtx(floating);
  t.after(() => floatingCtx.memory.close());
  const air = await pillarOne.run(floatingCtx, {});
  assert.equal(air.status, 'failed');
  assert.equal(air.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(air.data?.facing, 'W');

  const blocked = pillarPocket(new PillarWorld());
  blocked.yaw = Math.PI / 2;
  blocked.blocks.push({ name: 'stone', pos: { x: 0, y: 62, z: 0 } });
  const blockedCtx = makeCtx(blocked);
  t.after(() => blockedCtx.memory.close());
  const no = await pillarOne.run(blockedCtx, {});
  assert.equal(no.status, 'failed');
  assert.equal(no.data?.facing, 'W');
  assert.equal((no.data?.local as { facing?: string } | undefined)?.facing, 'W');
});

test('mine_cell 目标被下落方块回填时返回 EFFECT_NOT_CONFIRMED 和事实', async (t) => {
  const w = new BackfillWorld();
  w.pos = { x: 0.5, y: 60, z: 0.5 };
  w.removed.add('0,60,0');
  w.removed.add('0,61,0');
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 60, z: -1 } });
  w.backfill = 'sand';
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(r.data?.was, 'stone');
  assert.equal(r.data?.now, 'sand');
  assert.deepEqual(r.data?.target, { x: 0, y: 60, z: -1 });
});

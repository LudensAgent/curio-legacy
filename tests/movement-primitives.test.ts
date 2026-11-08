import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { footSurfaceY, supportTop } from '../src/perception/geometry.ts';
import { facingOfYaw, feetCell, toWorld } from '../src/perception/local.ts';
import { toRel } from '../src/skills/movement/coordinates.ts';
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

/** 挖掉中心支撑，但身体 AABB 还压在相邻方块边缘上：脚高不变。 */
class EdgeSupportWorld extends FakeAdapter {
  override async dig(pos: Vec3Like, _signal: AbortSignal) {
    const name = this.nameAt(pos.x, pos.y, pos.z);
    if (name === 'air') return { ok: false, reason: 'NO_BLOCK' };
    this.blocks = this.blocks.filter((b) => !(b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z));
    this.removed.add(`${pos.x},${pos.y},${pos.z}`);
    return { ok: true };
  }
}

/** 挖掉支撑后模拟身体的真实结果：落到某处，或仍悬在空中。 */
class DigFallWorld extends FakeAdapter {
  afterDig: { pos: Vec3Like; onGround: boolean } | null = null;
  override async dig(pos: Vec3Like, signal: AbortSignal) {
    const r = await super.dig(pos, signal);
    if (r.ok && this.afterDig) {
      this.pos = { ...this.afterDig.pos };
      this.onGround = this.afterDig.onGround;
      this.afterDig = null;
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

/** 服务端背包回执延迟/丢失：方块确实放下，但客户端背包暂时没有减少。 */
class NoInventoryDecrementWorld extends FakeAdapter {
  override async placeBlockAt(pos: Vec3Like, itemNames: string[], signal: AbortSignal) {
    const before = new Map(itemNames.map((name) => [name, this.inv.get(name) ?? 0]));
    const r = await super.placeBlockAt(pos, itemNames, signal);
    before.forEach((count, name) => { if ((this.inv.get(name) ?? 0) < count) this.inv.set(name, count); });
    return r;
  }
}

/** 背包预检看得到材料，但放置时服务端确认已经没有了。 */
class StaleInventoryWorld extends FakeAdapter {
  override async placeBlockAt(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: 'NO_ITEM' };
  }
}

/** 放置回执 ok、目标格也确实有方块，但放下的不是请求材料。 */
class WrongBlockPlaceWorld extends FakeAdapter {
  override async placeBlockAt(pos: Vec3Like) {
    if (this.blockAt(pos) !== 'air') return { ok: true };
    this.removed.delete(`${pos.x},${pos.y},${pos.z}`);
    this.blocks.push({ name: 'dirt', pos: { ...pos } });
    return { ok: true };
  }
}

/** 垫高成功但背包回执尚未扣减。 */
class LaggedPillarWorld extends FakeAdapter {
  override async pillarUp(itemNames: string[], signal: AbortSignal) {
    const before = new Map(itemNames.map((name) => [name, this.inv.get(name) ?? 0]));
    const r = await super.pillarUp(itemNames, signal);
    before.forEach((count, name) => { if ((this.inv.get(name) ?? 0) < count) this.inv.set(name, count); });
    return r;
  }
}

/** 垫高回执成功、脚高 +1，但实际放下的是别的方块。 */
class WrongMaterialPillarWorld extends FakeAdapter {
  override async pillarUp() {
    const f = { x: Math.floor(this.pos.x), y: Math.floor(this.pos.y), z: Math.floor(this.pos.z) };
    this.removed.delete(`${f.x},${f.y},${f.z}`);
    this.blocks.push({ name: 'dirt', pos: f });
    this.pos = { ...this.pos, y: f.y + 1 };
    return { ok: true, y: f.y + 1 };
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

/**
 * 真实适配器的 blockAt/blockStateAt 会把坐标取整到方块格（prismarine-world 的行为）。
 * FakeAdapter 默认按精确键查询，会把分数脚高误当成“那一格未加载”；这里显式模拟取整，
 * 用来覆盖绝对 xyz 的 y 是脚高、不是格坐标的情况。
 */
class FlooringWorld extends FakeAdapter {
  private cellOf(pos: Vec3Like) {
    return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  }
  override blockAt(pos: Vec3Like) {
    return super.blockAt(this.cellOf(pos));
  }
  override blockStateAt(pos: Vec3Like) {
    return super.blockStateAt(this.cellOf(pos));
  }
}

test('坐标契约：facing 的 yaw→方向→世界格一致，负坐标不取整到 0', () => {
  assert.equal(facingOfYaw(0), 'N');
  assert.equal(facingOfYaw(Math.PI / 2), 'W');
  assert.equal(facingOfYaw(Math.PI), 'S');
  assert.equal(facingOfYaw(-Math.PI / 2), 'E');
  assert.equal(facingOfYaw(-Math.PI), 'S', '绕回负半轴仍按南');
  const feet = { x: -3, y: 64, z: -2 };
  assert.deepEqual(feetCell({ x: -0.5, y: 64, z: -0.5 }), { x: -1, y: 64, z: -1 }, '负坐标 floor 到更小的格');
  assert.deepEqual(toWorld(feet, 'N', [1, 0, 0]), { x: -3, y: 64, z: -3 });
  assert.deepEqual(toWorld(feet, 'E', [1, 0, 0]), { x: -2, y: 64, z: -2 });
  assert.deepEqual(toWorld(feet, 'S', [1, 0, 0]), { x: -3, y: 64, z: -1 });
  assert.deepEqual(toWorld(feet, 'W', [1, 0, 0]), { x: -4, y: 64, z: -2 });
  // 右方向随朝向旋转：北→东、东→南、南→西、西→北（-z 方向）
  assert.deepEqual(toWorld(feet, 'N', [0, 0, 1]), { x: -2, y: 64, z: -2 });
  assert.deepEqual(toWorld(feet, 'E', [0, 0, 1]), { x: -3, y: 64, z: -1 });
  assert.deepEqual(toWorld(feet, 'S', [0, 0, 1]), { x: -4, y: 64, z: -2 });
  assert.deepEqual(toWorld(feet, 'W', [0, 0, 1]), { x: -3, y: 64, z: -3 });
  assert.deepEqual(toRel(feet, 'W', { x: -4, y: 65, z: -3 }), [1, 1, 1]);
  assert.deepEqual(toRel(feet, 'E', toWorld(feet, 'E', [1, 1, -1])), [1, 1, -1]);
});

test('脚高按碰撞顶面解析：半砖/雪层/楼梯/灵魂沙/箱子，不按整数格高', () => {
  const cell = { x: 3, y: 70, z: -2 };
  const key = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
  const cases: { name: string; properties: Record<string, string | number | boolean>; top: number }[] = [
    { name: 'stone_slab', properties: { type: 'bottom' }, top: 0.5 },
    { name: 'stone_slab', properties: { type: 'top' }, top: 1 },
    { name: 'snow', properties: { layers: 8 }, top: 0.875 },
    { name: 'stone_stairs', properties: { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: false }, top: 1 },
    { name: 'soul_sand', properties: {}, top: 0.875 },
    { name: 'chest', properties: { facing: 'north', type: 'single', waterlogged: false }, top: 0.875 },
  ];
  cases.forEach(({ name, properties, top }) => {
    assert.equal(supportTop(name, properties), top, `${name} 的碰撞顶面`);
    const states = new Map([[key(cell), { name, properties }]]);
    assert.equal(footSurfaceY(cell, (p) => states.get(key(p)) ?? null), cell.y + top, `${name} 的站立脚高`);
  });
  // 脚格里的薄层高于下方完整地面时取薄层顶面，而不是整数格顶
  const layered = new Map<string, { name: string; properties: Record<string, string | number | boolean> }>([
    [key(cell), { name: 'snow', properties: { layers: 8 } }],
    [key({ ...cell, y: cell.y - 1 }), { name: 'stone', properties: {} }],
  ]);
  assert.equal(footSurfaceY(cell, (p) => layered.get(key(p)) ?? null), cell.y + 0.875);
});

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

test('move_step 绝对 xyz 的 y 是脚高：分数脚高按脚所在格解析支撑，不按格顶再算一次', async (t) => {
  // 真实适配器会把 (1,63.5,0) 取整到方块格 (1,63,0)；脚高 63.5 应解析到该格半砖的顶面 63.5，
  // 而不是把 63.5 当格坐标后算出 64.0。
  const w = new FlooringWorld();
  w.groundY = -100;
  w.pos = { x: 0.5, y: 63.5, z: 0.5 };
  [{ x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 }].forEach((cell) => {
    w.blocks.push({ name: 'stone_slab', pos: cell });
    w.blockProperties.set(`${cell.x},${cell.y},${cell.z}`, { type: 'bottom' });
  });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [0, 0, 0], facing: 'E', xyz: { x: 1, y: 63.5, z: 0 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.pos.y, 63.5, '按实测脚高验收，不取整');
  assert.equal(Math.floor(w.pos.x), 1);
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 63, z: 0 }, '回执的目标格是脚所在方块格');
  assert.match(r.summary, /63\.50/);
});

test('move_step 绝对 xyz 的 ±1 高度差按实测脚高判断，不拿脚下格底当脚高', () => {
  const w = flat();
  w.pos = { x: 0.5, y: 63.5, z: 0.5 }; // 脚站在半砖顶面，脚下格底是 63
  // 目标脚高 64.5：与实测脚高差 1.0，应通过校验（旧实现按 63 算成 1.5 而拒绝）。
  const up = moveStep.validate({ xyz: { x: 1, y: 64.5, z: 0 } }, w);
  assert.ok(up.ok, !up.ok ? up.error : '');
  // 目标脚高 65.0：实际高差 1.5，仍必须拒绝，不能为了让单步成功而放宽到 1.5。
  const tooHigh = moveStep.validate({ xyz: { x: 1, y: 65, z: 0 } }, w);
  assert.equal(tooHigh.ok, false);
  // 目标脚高 62.5：实际落差 1.0，应通过；62.0 的实际落差 1.5 必须拒绝。
  const down = moveStep.validate({ xyz: { x: 1, y: 62.5, z: 0 } }, w);
  assert.ok(down.ok, !down.ok ? down.error : '');
  const tooLow = moveStep.validate({ xyz: { x: 1, y: 62, z: 0 } }, w);
  assert.equal(tooLow.ok, false);
});

test('move_step 绝对 xyz 的 x/z 必须是整数方块列，分数点不静默当同列', () => {
  const w = flat();
  // 0.9 仍在当前列内；旧实现把它当成合法“相邻一步”，run 却按格心验收，可能零移动也报成功。
  const sameColumn = moveStep.validate({ xyz: { x: 0.9, y: 64, z: 0 } }, w);
  assert.equal(sameColumn.ok, false);
  assert.match(!sameColumn.ok ? sameColumn.error : '', /整数/);
  const fracZ = moveStep.validate({ xyz: { x: 0, y: 64, z: 0.9 } }, w);
  assert.equal(fracZ.ok, false);
  const integer = moveStep.validate({ xyz: { x: 1, y: 64, z: 0 } }, w);
  assert.ok(integer.ok, !integer.ok ? integer.error : '');
});

test('move_step 负坐标：相对和绝对目标落在正确的方块列', async (t) => {
  const west = flat();
  const westCtx = makeCtx(west);
  t.after(() => westCtx.memory.close());
  const r = await moveStep.run(westCtx, { at: [1, 0, 0], facing: 'W' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(west.pos.x), -1);
  assert.equal(Math.floor(west.pos.z), 0);

  const north = flat();
  const northCtx = makeCtx(north);
  t.after(() => northCtx.memory.close());
  const n = await moveStep.run(northCtx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(n.status, 'succeeded', n.summary);
  assert.equal(Math.floor(north.pos.x), 0);
  assert.equal(Math.floor(north.pos.z), -1);

  const abs = flat();
  const absCtx = makeCtx(abs);
  t.after(() => absCtx.memory.close());
  const a = await moveStep.run(absCtx, { at: [0, 0, 0], facing: 'W', xyz: { x: -1, y: 64, z: 0 } });
  assert.equal(a.status, 'succeeded', a.summary);
  assert.equal(Math.floor(abs.pos.x), -1);
});

test('move_step 从半格脚高出发：同层 0 格、上下 0.5 格都按实际支撑顶面执行', async (t) => {
  const same = new FlooringWorld();
  same.groundY = -100;
  same.pos = { x: 0.5, y: 63.5, z: 0.5 };
  [0, 1].forEach((x) => {
    same.blocks.push({ name: 'stone_slab', pos: { x, y: 63, z: 0 } });
    same.blockProperties.set(`${x},63,0`, { type: 'bottom' });
  });
  const sameCtx = makeCtx(same);
  t.after(() => sameCtx.memory.close());
  const level = await moveStep.run(sameCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(level.status, 'succeeded', level.summary);
  assert.equal(same.pos.y, 63.5, '同层脚高不变');

  const down = new FlooringWorld();
  down.groundY = -100;
  down.pos = { x: 0.5, y: 63.5, z: 0.5 };
  down.blocks.push({ name: 'stone_slab', pos: { x: 0, y: 63, z: 0 } });
  down.blockProperties.set('0,63,0', { type: 'bottom' });
  down.blocks.push({ name: 'stone', pos: { x: 1, y: 62, z: 0 } }); // 顶面 63：低 0.5 格
  const downCtx = makeCtx(down);
  t.after(() => downCtx.memory.close());
  const lower = await moveStep.run(downCtx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(lower.status, 'succeeded', lower.summary);
  assert.equal(down.pos.y, 63);

  const up = new FlooringWorld();
  up.groundY = -100;
  up.pos = { x: 0.5, y: 63.5, z: 0.5 };
  up.blocks.push({ name: 'stone_slab', pos: { x: 0, y: 63, z: 0 } });
  up.blockProperties.set('0,63,0', { type: 'bottom' });
  up.blocks.push({ name: 'stone', pos: { x: 1, y: 63, z: 0 } }); // 顶面 64：高 0.5 格
  const upCtx = makeCtx(up);
  t.after(() => upCtx.memory.close());
  const higher = await moveStep.run(upCtx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(higher.status, 'succeeded', higher.summary);
  assert.equal(up.pos.y, 64);
});

test('move_step 连续 20 次相对迈步不漂移、不残留方向', async (t) => {
  const w = flat();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  for (let i = 0; i < 20; i++) {
    const v = moveStep.validate({ to: [1, 0, 0], facing: 'E' }, w);
    assert.ok(v.ok, !v.ok ? v.error : `第 ${i + 1} 次校验`);
    const r = await moveStep.run(ctx, (v as { ok: true; args: { at: [number, number, number]; facing: 'E' } }).args);
    assert.equal(r.status, 'succeeded', `第 ${i + 1} 次：${r.summary}`);
    assert.equal(Math.floor(w.pos.y), 64);
  }
  assert.equal(Math.floor(w.pos.x), 20);
  assert.equal(Math.floor(w.pos.z), 0);
});

test('move_step 不自动改落点：目标列下方多格才有地面时拒绝', async (t) => {
  const w = flat();
  for (const key of ['1,63,0', '1,62,0']) w.removed.add(key);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS', '超出单步范围是能力边界，不是普通无路');
  assert.equal(r.data?.unsupportedGeometry, true);
  assert.equal(r.data?.movementNotAttempted, true);
  assert.match(r.summary, /descend_to|可站立面/);
  const remediation = r.data?.remediation as { assess?: boolean; landing?: Vec3Like; drop?: number; descend?: { target?: Vec3Like } } | undefined;
  assert.equal(remediation?.assess, true);
  assert.deepEqual(remediation?.landing, { x: 1, y: 62, z: 0 });
  assert.equal(remediation?.drop, 2);
  assert.deepEqual(remediation?.descend?.target, { x: 1, y: 62, z: 0 }, '给出可复制给 descend_to 的同一落点');
  assert.deepEqual((remediation as { stairs?: { mode?: string } } | undefined)?.stairs?.mode, 'stairs');
  assert.match(r.summary, /assess_landings/);
  assert.match(r.summary, /excavate_run/);
});

test('move_step 绝对分数脚高：回落差按请求脚高计算，不按目标格整数 y', async (t) => {
  const w = new FlooringWorld();
  w.groundY = -100;
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 63, z: 0 } }); // 当前支撑顶面 64
  w.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 62, z: 0 } });
  w.blockProperties.set('1,62,0', { type: 'bottom' }); // 落点脚高 62.5
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [0, 0, 0], facing: 'E', xyz: { x: 1, y: 64.9, z: 0 } });
  assert.equal(r.status, 'failed');
  const landing = r.data?.landing as { y?: number; drop?: number } | undefined;
  assert.equal(landing?.y, 62.5);
  assert.ok(Math.abs((landing?.drop ?? 0) - 2.4) < 1e-6, `实际落差应由请求脚高 64.9 到 62.5：${JSON.stringify(landing)}`);
  assert.match(r.summary, /2\.40/);
  assert.equal(r.data?.unsupportedGeometry, true);
  assert.deepEqual((r.data?.remediation as { descend?: { target?: Vec3Like } } | undefined)?.descend?.target, { x: 1, y: 62.5, z: 0 });
});

test('move_step 遇到 2 格以上高差时给出 excavate_run 阶梯交接', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 65, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /excavate_run/);
  assert.match(r.summary, /stairs_up/);
  const stairs = (r.data?.remediation as { stairs?: { mode?: string; direction?: string; steps?: number } } | undefined)?.stairs;
  assert.equal(stairs?.mode, 'stairs_up');
  assert.equal(stairs?.direction, 'east');
  assert.ok((stairs?.steps ?? 0) >= 1);
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
  assert.match(r.summary, /63\.50/);
  assert.deepEqual((r.data as any)?.remediation?.xyz, { x: 1, y: 63.5, z: 0 });
  assert.deepEqual(w.pos, before);
});

test('move_step 预检给出同一相邻格的准确修正，不自动改目标', async (t) => {
  // 同层请求，但目标实际高一格：返回 [1,1,0]，而不是笼统的“下落用 [1,-1,0]”。
  const up = flat();
  up.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const upCtx = makeCtx(up);
  t.after(() => upCtx.memory.close());
  const rise = await moveStep.run(upCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(rise.status, 'failed');
  assert.equal(rise.failureCode, 'BAD_ARGS');
  assert.equal(rise.data?.movementNotAttempted, true);
  assert.match(rise.summary, /\[1,1,0\]/);
  assert.deepEqual((rise.data as any)?.remediation?.at, [1, 1, 0]);
  assert.deepEqual(up.pos, { x: 0.5, y: 64, z: 0.5 }, '未执行迈步');

  // 同层请求，但目标实际低一格：返回 [1,-1,0]。
  const down = flat();
  down.removed.add('1,63,0');
  const downCtx = makeCtx(down);
  t.after(() => downCtx.memory.close());
  const drop = await moveStep.run(downCtx, { at: [1, 0, 0], facing: 'E' });
  assert.match(drop.summary, /\[1,-1,0\]/);
  assert.deepEqual((drop.data as any)?.remediation?.at, [1, -1, 0]);

  // 上一级请求，但目标其实是同层：返回 [1,0,0]。
  const level = flat();
  const levelCtx = makeCtx(level);
  t.after(() => levelCtx.memory.close());
  const flatStep = await moveStep.run(levelCtx, { at: [1, 1, 0], facing: 'E' });
  assert.match(flatStep.summary, /\[1,0,0\]/);
  assert.deepEqual((flatStep.data as any)?.remediation?.at, [1, 0, 0]);
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

test('place_cell：看不清名称时按实际方块状态确认，回执不写未观察的名称', async (t) => {
  const w = new NoInventoryDecrementWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.observed, false);
  assert.equal(r.data?.placed, null, '没有看清就不能写实际方块名');
  assert.equal(r.data?.consumed, 0);
  assert.equal(r.data?.consumptionVerified, false);
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'cobblestone');
});

test('place_cell：实际方块与请求不符时失败，不因放置回执 ok 当成功', async (t) => {
  const w = new WrongBlockPlaceWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(r.data?.placed, null, '未看清时不泄漏实际名称');
  assert.match(r.summary, /本次未看清名称/);
});

test('place_cell：看得见请求材料时成功，但背包未回执不能写成消耗 0', async (t) => {
  const w = new NoInventoryDecrementWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.consumed, 0);
  assert.equal(r.data?.consumptionVerified, false);
  assert.match(r.summary, /材料消耗未确认/);
  assert.doesNotMatch(r.summary, /消耗 0 块/);
});

test('place_support：几何确认但背包回执未减少时，不把消耗写成 0 块', async (t) => {
  const w = new NoInventoryDecrementWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 1, y: 63, z: 0 }), 'cobblestone');
  assert.equal(r.data?.consumed, 0);
  assert.equal(r.data?.consumptionVerified, false);
  assert.match(r.summary, /材料消耗未确认/);
  assert.doesNotMatch(r.summary, /消耗 0 块/);
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

test('place_support：材料在放置时已不可用，按 MISSING_MATERIALS 报告而不是参数问题', async (t) => {
  const w = new StaleInventoryWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'MISSING_MATERIALS');
  assert.match(r.summary, /NO_ITEM/);
});

test('place_support 能从 1×1 平台侧面补出下一级支撑', async (t) => {
  const w = new FakeAdapter();
  w.groundY = -100;
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 63, z: 0 } });
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 1, y: 63, z: 0 }), 'cobblestone');
  assert.equal(w.inv.get('cobblestone'), 0);
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

test('pillar_one：材料回执延迟时保留 +1 事实但标记消耗未确认', async (t) => {
  const w = pillarPocket(new LaggedPillarWorld());
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await pillarOne.run(ctx, {});
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.climbed, 1);
  assert.equal(r.data?.consumed, 0);
  assert.equal(r.data?.consumptionVerified, false);
  assert.match(r.summary, /材料消耗未确认/);
  assert.doesNotMatch(r.summary, /消耗 0 块/);
});

test('pillar_one：实际垫的方块不属于本次材料时不算成功', async (t) => {
  const w = pillarPocket(new WrongMaterialPillarWorld());
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await pillarOne.run(ctx, { item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.match(r.summary, /dirt/);
  assert.equal((r.data?.support as { name?: string } | undefined)?.name, 'dirt');
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

test('mine_cell 挖脚下支撑：身体跨格被相邻块托住时如实返回剩余支撑', async (t) => {
  const w = new EdgeSupportWorld();
  w.pos = { x: 0.816, y: 64, z: 0.5 }; // 中心在 0 列，AABB 有 0.116 压进相邻的 1 列
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [0, -1, 0], facing: 'E', fall: true });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.onGround, true);
  const supports = r.data?.supports as { pos: Vec3Like; name: string }[];
  assert.ok(supports.some((s) => s.pos.x === 1 && s.pos.y === 63 && s.pos.z === 0 && s.name === 'grass_block'), JSON.stringify(supports));
  assert.match(r.summary, /托着|支撑/);

  // 目标已空也不再说一句“本来就是空的”就走：重复挖同一格时继续报告身体支撑事实。
  const again = await mineCell.run(ctx, { at: [0, -1, 0], facing: 'E', fall: true });
  assert.equal(again.status, 'succeeded');
  assert.equal(again.data?.noop, true);
  const againSupports = again.data?.supports as { pos: Vec3Like; name: string }[];
  assert.ok(againSupports.some((s) => s.pos.x === 1 && s.pos.y === 63 && s.pos.z === 0), JSON.stringify(againSupports));
  assert.match(again.summary, /托着|已触地/);
});

test('mine_cell 挖脚下支撑：身体还在空中时明确报告未确认落地', async (t) => {
  const w = new DigFallWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.afterDig = { pos: { x: 0.5, y: 63.08, z: 0.5 }, onGround: false };
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) }, deadlineMs: 300 });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [0, -1, 0], facing: 'E', fall: true });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.pendingFall, true);
  assert.match(r.summary, /仍在空中|尚未确认落地/);
});

test('mine_cell 挖脚下支撑：落地后回报实际落点与落差', async (t) => {
  const w = new DigFallWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.afterDig = { pos: { x: 0.5, y: 63, z: 0.5 }, onGround: true };
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [0, -1, 0], facing: 'E', fall: true });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.onGround, true);
  assert.match(r.summary, /落到 y=63\.00/);
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

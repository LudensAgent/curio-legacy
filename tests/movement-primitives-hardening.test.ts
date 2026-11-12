/**
 * P0 加固回归：脚下挖掘风险门禁、放置效果核对、异常后的部分效果、
 * move_step 起点/几何/环境分派，以及 pillar_one 的显式材料与未知朝向。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionResult, MoveOpts, MoveTarget, PlacementFaceAttempt, Vec3Like } from '../src/adapter/types.ts';
import { l1Primitives, L1_MANIFEST, mineCell, moveStep, pillarOne, placeCell, placeSupport, PRIMITIVE_PROBLEM_KINDS } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

function flat() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  return w;
}

const problemKind = (result: { data?: Record<string, unknown> }) => (result.data?.problem as { kind?: string } | undefined)?.kind;

test('mine_cell 挖脚下支撑：2 格落差必须显式 fall，1 格落差不需要', async (t) => {
  const drop2 = flat();
  drop2.removed.add('0,62,0'); // 支撑格 (0,63,0) 下面是空气，再下一格才是石头
  const ctx = makeCtx(drop2, { senses: { observeBlocks: observeAllBlocks(drop2) } });
  t.after(() => ctx.memory.close());
  const denied = await mineCell.run(ctx, { at: [0, -1, 0], facing: 'N' });
  assert.equal(denied.status, 'failed');
  assert.equal(problemKind(denied), 'FALL_RISK_UNAUTHORIZED');
  assert.equal(denied.data?.requiresFall, true);
  assert.equal(denied.data?.drop, 2);
  assert.equal(drop2.blockAt({ x: 0, y: 63, z: 0 }), 'grass_block', '未经授权不得挖');

  const consented = await mineCell.run(ctx, { at: [0, -1, 0], facing: 'N', fall: true });
  assert.equal(consented.status, 'succeeded', consented.summary);
  assert.deepEqual(consented.data?.effect, { confirmed: true, kind: 'block_removed' });
  assert.equal(drop2.blockAt({ x: 0, y: 63, z: 0 }), 'air');

  const drop1 = flat();
  const oneCtx = makeCtx(drop1, { senses: { observeBlocks: observeAllBlocks(drop1) } });
  t.after(() => oneCtx.memory.close());
  const allowed = await mineCell.run(oneCtx, { at: [0, -1, 0], facing: 'N' });
  assert.equal(allowed.status, 'succeeded', '下方一格是实心落点属于单步落差，不需要 fall');
  assert.equal(allowed.data?.requiresFall, false);
});

test('mine_cell 挖脚下支撑：下方是水时必须写 wet', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'water', pos: { x: 0, y: 62, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [0, -1, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(problemKind(r), 'LIQUID_RISK_UNAUTHORIZED');
  assert.equal(r.data?.requiresLiquid, 'water');
  assert.match(r.summary, /wet:true/);
  assert.equal(w.blockAt({ x: 0, y: 63, z: 0 }), 'grass_block');
});

test('mine_cell 适配器抛错但目标格已空：按已确认效果结算并保留异常', async (t) => {
  class DigThenThrow extends FakeAdapter {
    override async dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult> {
      await super.dig(pos, signal);
      throw new Error('TIMEOUT: 挖掘回执超时');
    }
  }
  const w = new DigThenThrow();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => ctx.memory.close());
  const r = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.reconciled, true);
  assert.match(String(r.data?.adapterError), /TIMEOUT/);
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'air');
});

test('mine_cell 未加载的邻格默认阻止挖掘，显式授权后才挖', async (t) => {
  let targetPresent = true;
  const w = new (class extends FakeAdapter {
    override blockAt(pos: Vec3Like): string {
      if (pos.x === 1 && pos.y === 64 && pos.z === 0) return targetPresent ? 'stone' : 'air';
      return null as unknown as string;
    }
    override async dig(pos: Vec3Like, signal: AbortSignal) {
      const result = await super.dig(pos, signal);
      if (pos.x === 1 && pos.y === 64 && pos.z === 0) targetPresent = false;
      return result;
    }
  })();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const targetOnly = (positions: Vec3Like[]) => positions
    .filter((p) => p.x === 1 && p.y === 64 && p.z === 0)
    .map((p) => ({
      name: 'stone', pos: p, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
      dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
    }));
  const ctx = makeCtx(w, { senses: { observeBlocks: targetOnly } });
  t.after(() => ctx.memory.close());
  const denied = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(denied.status, 'failed');
  assert.equal(problemKind(denied), 'UNKNOWN_ADJACENT_UNAUTHORIZED');
  const unknown = denied.data?.unknownAdjacent as [number, number, number][];
  assert.ok(Array.isArray(unknown) && unknown.length > 0, '未加载的邻格要单独列出');
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'stone', '未授权时不能挖');

  const allowed = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E', allowUnknownAdjacent: true });
  assert.equal(allowed.status, 'succeeded', allowed.summary);
  assert.deepEqual(allowed.data?.unknownAdjacent, unknown);
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'air');
});

test('mine_cell 绝对坐标文档也列出 tool', () => {
  assert.match(mineCell.argsDoc, /\{"xyz":\[x,y,z\][^}]*"tool"/);
});

test('place_cell 以权威方块状态核对材料，视觉快照为空也不能把错误材料当成功', async (t) => {
  class PlacesDirt extends FakeAdapter {
    override async placeBlockAt(pos: Vec3Like, names: string[], signal: AbortSignal): Promise<ActionResult & { attemptedFaces?: PlacementFaceAttempt[] }> {
      const r = await super.placeBlockAt(pos, names, signal);
      if (!r.ok) return r;
      this.blocks = this.blocks.filter((b) => !(b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z));
      this.blocks.push({ name: 'dirt', pos: { ...pos } });
      return r;
    }
  }
  const w = new PlacesDirt();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(r.data?.placed, 'dirt');
  assert.equal(problemKind(r), 'EFFECT_MISMATCH');
});

test('place_cell 回执失败但世界已放下请求材料：按效果确认', async (t) => {
  class FailedReceipt extends FakeAdapter {
    calls = 0;
    override async placeBlockAt(pos: Vec3Like, names: string[], signal: AbortSignal) {
      this.calls += 1;
      const r = await super.placeBlockAt(pos, names, signal);
      return { ...r, ok: false, reason: 'TIMEOUT' };
    }
  }
  const w = new FailedReceipt();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.adapterReason, 'TIMEOUT');
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'cobblestone');
  assert.equal(w.calls, 1, '效果已确认时不再重试');
  assert.equal(r.data?.consumed, 1);
});

test('place_cell 适配器抛错但世界已放下：确认效果并保留异常', async (t) => {
  class ThrowAfterPlace extends FakeAdapter {
    override async placeBlockAt(pos: Vec3Like, names: string[], signal: AbortSignal): Promise<ActionResult & { attemptedFaces?: PlacementFaceAttempt[] }> {
      await super.placeBlockAt(pos, names, signal);
      throw new Error('TIMEOUT: 放置回执超时');
    }
  }
  const w = new ThrowAfterPlace();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.reconciled, true);
  assert.match(String(r.data?.adapterError), /TIMEOUT/);
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'cobblestone');
});

test('place_cell 返回净消耗与库存核对字段', async (t) => {
  const w = flat();
  w.inv.set('cobblestone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.consumed, 1);
  assert.deepEqual(r.data?.inventory, { item: 'cobblestone', before: 2, after: 1, consumed: 1, inventoryDelta: 1, inventorySync: 'confirmed', verified: true });
  assert.deepEqual(r.data?.effect, { confirmed: true, kind: 'block_placed' });
});

test('place_support 回执失败但世界已形成支撑：不再换站位重试', async (t) => {
  class FailedReceiptSupport extends FakeAdapter {
    places = 0;
    override async placeBlockAt(pos: Vec3Like, names: string[], signal: AbortSignal) {
      this.places += 1;
      await super.placeBlockAt(pos, names, signal);
      return { ok: false, reason: 'TIMEOUT' };
    }
  }
  const w = new FailedReceiptSupport();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.places, 1, '世界已形成支撑后不得继续换站位');
  assert.equal(w.actions.some((a) => a.startsWith('moveTo:')), false);
  assert.equal(r.data?.consumed, 1);
  assert.deepEqual(r.data?.effect, { confirmed: true, kind: 'support_formed' });
});

test('place_support 回执成功但世界没变：不得成功，也不再换站位', async (t) => {
  class OkWithoutEffect extends FakeAdapter {
    override async placeBlockAt(_pos: Vec3Like, _names: string[], _signal: AbortSignal) {
      return { ok: true };
    }
  }
  const w = new OkWithoutEffect();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(w.actions.some((a) => a.startsWith('moveTo:')), false);
  assert.equal(r.data?.movement && (r.data.movement as { attempted: boolean }).attempted, false);
});

test('place_support 目标格变成非支撑方块：停止并报告已发生变化', async (t) => {
  class PlacesTorch extends FakeAdapter {
    places = 0;
    override async placeBlockAt(pos: Vec3Like, _names: string[], _signal: AbortSignal) {
      this.places += 1;
      this.inv.set('cobblestone', (this.inv.get('cobblestone') ?? 0) - 1);
      this.blocks = this.blocks.filter((b) => !(b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z));
      this.blocks.push({ name: 'torch', pos: { ...pos } });
      return { ok: true };
    }
  }
  const w = new PlacesTorch();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(r.data?.placementEffect, 'changed_without_support');
  assert.equal(w.places, 1, '不得继续消耗更多材料');
  assert.equal(w.actions.some((a) => a.startsWith('moveTo:')), false);
});

test('place_support 换站位成功后把身体移动作为一等结果返回', async (t) => {
  class FailThenPlace extends FakeAdapter {
    places = 0;
    override async placeBlockAt(pos: Vec3Like, names: string[], signal: AbortSignal) {
      this.places += 1;
      if (this.places === 1) return { ok: false, reason: 'NO_REFERENCE' };
      return super.placeBlockAt(pos, names, signal);
    }
  }
  const w = new FailThenPlace();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  const movement = r.data?.movement as { attempted: boolean; changed: boolean; start: Vec3Like; end: Vec3Like };
  assert.equal(movement.attempted, true);
  assert.equal(movement.changed, true);
  assert.notDeepEqual(movement.start, movement.end);
});

test('place_support 模糊失败后等待同步，再按实际支撑结算', async (t) => {
  class LatePlace extends FakeAdapter {
    places = 0;
    override async placeBlockAt(pos: Vec3Like, names: string[], signal: AbortSignal) {
      this.places += 1;
      // 回执先失败，世界状态稍后才出现放置结果：不能立即判死并去换站位。
      await new Promise((resolve) => setTimeout(resolve, 100));
      await super.placeBlockAt(pos, names, signal);
      return { ok: false, reason: 'TIMEOUT' };
    }
  }
  const w = new LatePlace();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.places, 1, '世界已形成支撑后不得继续换站位');
  assert.equal(w.actions.some((a) => a.startsWith('moveTo:')), false);
});

test('place_support 换站位移动异常且身体已移动：停止，不按旧起点继续', async (t) => {
  class PartialMove extends FakeAdapter {
    moves = 0;
    override async placeBlockAt(_pos: Vec3Like, _names: string[], _signal: AbortSignal) {
      return { ok: false, reason: 'NO_REFERENCE' };
    }
    override async moveTo(_target: MoveTarget, _opts: MoveOpts) {
      this.moves += 1;
      this.pos = { ...this.pos, x: this.pos.x + 0.4 };
      throw new Error('TIMEOUT: 换站位超时');
    }
  }
  const w = new PartialMove();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(problemKind(r), 'STANCE_MOVE_PARTIAL');
  assert.equal(w.moves, 1, '身体已偏离旧起点后不得继续尝试候选站位');
  assert.equal((r.data?.movement as { changed?: boolean } | undefined)?.changed, true);
  assert.deepEqual(r.data?.stanceMove, { from: { x: 0.5, y: 64, z: 0.5 }, to: { x: 0.9, y: 64, z: 0.5 } });
});

test('move_step validate 后起点变化：run 拒绝旧计划', async (t) => {
  const w = flat();
  const validated = moveStep.validate({ to: [1, 0, 0], facing: 'E' }, w);
  assert.ok(validated.ok, !validated.ok ? validated.error : '');
  w.pos = { x: 1.5, y: 64, z: 0.5 }; // 已跨到原目标列
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, validated.args);
  assert.equal(r.status, 'failed');
  assert.equal(problemKind(r), 'START_CHANGED');
  assert.equal(r.data?.movementNotAttempted, true);
  assert.deepEqual(w.pos, { x: 1.5, y: 64, z: 0.5 }, '不执行旧计划');
});

test('move_step 起点在同一脚格内连续漂移也拒绝旧计划', async (t) => {
  const w = flat();
  const validated = moveStep.validate({ to: [1, 0, 0], facing: 'E' }, w);
  assert.ok(validated.ok, !validated.ok ? validated.error : '');
  w.pos = { x: 0.85, y: 64, z: 0.5 }; // 脚格仍是 (0,64,0)
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, validated.args);
  assert.equal(r.status, 'failed');
  assert.equal(problemKind(r), 'START_CHANGED');
  const drift = r.data?.positionDrift as number;
  assert.ok(drift > 0.3, `漂移应被算出：${drift}`);
  assert.deepEqual(w.pos, { x: 0.85, y: 64, z: 0.5 }, '不执行旧计划');
  assert.equal(w.actions.some((a) => a.startsWith('moveTo:')), false);
});

test('move_step 等待落地超时后拒绝执行，不把超时当稳定', async (t) => {
  const w = flat();
  w.onGround = false;
  const ctx = makeCtx(w, { deadlineMs: 100 });
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(problemKind(r), 'BODY_NOT_STABLE');
  assert.equal(r.data?.movementNotAttempted, true);
  assert.equal(w.actions.some((a) => a.startsWith('moveTo:')), false);
});

test('方块元语的 xyz 必须是整数格坐标', () => {
  const w = flat();
  assert.equal(mineCell.validate({ xyz: { x: 1.5, y: 64, z: 0 } }, w).ok, false);
  assert.equal(mineCell.validate({ xyz: { x: 1, y: 64.5, z: 0 } }, w).ok, false);
  assert.equal(placeCell.validate({ xyz: { x: 1.5, y: 64, z: 0 }, item: 'cobblestone' }, w).ok, false);
  assert.equal(placeSupport.validate({ xyz: { x: 1, y: 63.5, z: 0 }, item: 'cobblestone' }, w).ok, false);
  assert.ok(mineCell.validate({ xyz: { x: 1, y: 64, z: 0 } }, w).ok);
  assert.ok(placeCell.validate({ xyz: { x: 1, y: 64, z: 0 }, item: 'cobblestone' }, w).ok);
  assert.ok(placeSupport.validate({ xyz: { x: 1, y: 63, z: 0 }, item: 'cobblestone' }, w).ok);
});

test('move_step 绝对 xyz 的 y 是脚高：回执目标格是脚所在方块格', async (t) => {
  // 真实适配器会把 (1,63.5,0) 取整到方块格；这里模拟同样的读取语义。
  class FlooringWorld extends FakeAdapter {
    override blockAt(pos: Vec3Like) {
      return super.blockAt({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
    }
    override blockStateAt(pos: Vec3Like) {
      return super.blockStateAt({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
    }
  }
  const w = new FlooringWorld();
  w.groundY = -100;
  w.pos = { x: 0.5, y: 63.5, z: 0.5 };
  for (const cell of [{ x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 }]) {
    w.blocks.push({ name: 'stone_slab', pos: cell });
    w.blockProperties.set(`${cell.x},${cell.y},${cell.z}`, { type: 'bottom' });
  }
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [0, 0, 0], facing: 'E', xyz: { x: 1, y: 63.5, z: 0 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.pos.y, 63.5);
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 0 }, '目标格是身体所在格（半砖上面那格），不是分数脚高');
  assert.equal(r.data?.targetFoot, 63.5);
});

test('move_step 绝对 xyz 的 x/z 必须是整数方块列', () => {
  const w = flat();
  assert.equal(moveStep.validate({ xyz: { x: 0.9, y: 64, z: 0 } }, w).ok, false);
  assert.equal(moveStep.validate({ xyz: { x: 0, y: 64, z: 0.9 } }, w).ok, false);
  assert.ok(moveStep.validate({ xyz: { x: 1, y: 64, z: 0 } }, w).ok);
});

test('move_step 负坐标按脚格换算，不偏移一格', async (t) => {
  const w = flat();
  w.pos = { x: -0.5, y: 64, z: -0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(w.pos.x), 0);
  assert.equal(Math.floor(w.pos.z), -1);
  assert.deepEqual(r.data?.effect, { confirmed: true, kind: 'movement' });
});

test('move_step 把相邻一步的扫掠/跳跃/落地交给适配器 adjacentStep', async (t) => {
  class RecordingWorld extends FakeAdapter {
    targets: MoveTarget[] = [];
    opts: MoveOpts[] = [];
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      this.targets.push(target);
      this.opts.push(opts);
      return super.moveTo(target, opts);
    }
  }
  const w = new RecordingWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.targets[0]?.kind, 'xyz');
  assert.equal(w.opts[0]?.adjacentStep, true, '单步由适配器的身体控制完成，不另起整段寻路');
  assert.equal(w.opts[0]?.maxDropDown, undefined);
});

test('move_step 身体空间有未加载格时不当作空旷', async (t) => {
  class UnloadedHead extends FakeAdapter {
    // FakeAdapter 的测试世界总是返回方块名；这里显式模拟区块未加载（GameAdapter 允许 null）。
    override blockAt(pos: Vec3Like): string {
      return (pos.x === 1 && pos.y === 65 && pos.z === 0 ? null : super.blockAt(pos)) as unknown as string;
    }
  }
  const w = new UnloadedHead();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(problemKind(r), 'UNKNOWN_GEOMETRY');
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 });
});

test('move_step 在岩浆中明确拒绝，不进入普通步行等待', async (t) => {
  const w = flat();
  w.inLava = true;
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(problemKind(r), 'UNSUPPORTED_ENVIRONMENT');
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 });
});

test('move_step 几何失败给出结构化 problem.kind', async (t) => {
  const noSupport = flat();
  noSupport.groundY = -100;
  const noCtx = makeCtx(noSupport);
  t.after(() => noCtx.memory.close());
  const miss = await moveStep.run(noCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(miss.status, 'failed');
  assert.equal(problemKind(miss), 'NO_SUPPORT');

  const head = flat();
  head.blocks.push({ name: 'stone', pos: { x: 1, y: 65, z: 0 } });
  const headCtx = makeCtx(head);
  t.after(() => headCtx.memory.close());
  const blocked = await moveStep.run(headCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(blocked.status, 'failed');
  assert.equal(problemKind(blocked), 'HEAD_BLOCKED');
});

test('pillar_one 需要显式 item，eye 不可用时朝向返回 null 而不是北', async (t) => {
  const w = flat();
  assert.equal(pillarOne.validate({}, w).ok, false);
  assert.equal(pillarOne.validate({ item: 'Iron Pickaxe' }, w).ok, false);
  assert.equal(pillarOne.validate({ item: 'oak_boat' }, w).ok, false);
  assert.ok(pillarOne.validate({ item: 'any' }, w).ok);

  const dark = new FakeAdapter();
  dark.pos = { x: 0.5, y: 60, z: 0.5 };
  dark.removed.add('0,60,0');
  dark.removed.add('0,61,0');
  dark.removed.add('0,62,0');
  dark.inv.set('cobblestone', 1);
  dark.connected = false; // eye() 返回 null
  const ctx = makeCtx(dark);
  t.after(() => ctx.memory.close());
  const r = await pillarOne.run(ctx, { item: 'any' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.facing, null);
  assert.equal('local' in (r.data ?? {}), false, '朝向未知时不能给出伪装的局部坐标');
  assert.equal(r.data?.consumed, 1);
  assert.equal((r.data?.inventory as { verified?: boolean } | undefined)?.verified, true);
  assert.deepEqual(r.data?.effect, { confirmed: true, kind: 'movement' });
});

test('pillar_one 适配器抛错但世界已垫高：按已确认效果结算并保留异常', async (t) => {
  class PillarThenThrow extends FakeAdapter {
    override async pillarUp(itemNames: string[], signal: AbortSignal): ReturnType<FakeAdapter['pillarUp']> {
      await super.pillarUp(itemNames, signal);
      throw new Error('TIMEOUT: 垫高回执超时');
    }
  }
  const w = new PillarThenThrow();
  w.pos = { x: 0.5, y: 60, z: 0.5 };
  w.removed.add('0,60,0');
  w.removed.add('0,61,0');
  w.removed.add('0,62,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await pillarOne.run(ctx, { item: 'any' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.reconciled, true);
  assert.match(String(r.data?.adapterError), /TIMEOUT/);
  assert.deepEqual(r.data?.effect, { confirmed: true, kind: 'movement' });
});

test('place_support 每次尝试都带结构化 problem.kind', async (t) => {
  class AlwaysNoReference extends FakeAdapter {
    override async placeBlockAt(_pos: Vec3Like, _names: string[], _signal: AbortSignal) {
      return { ok: false, reason: 'NO_REFERENCE' };
    }
  }
  const w = new AlwaysNoReference();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  const attempts = r.data?.attempts as { problem?: { kind?: string } }[];
  assert.ok(attempts.length > 0);
  assert.ok(attempts.every((a) => a.problem?.kind === 'NO_REFERENCE'), JSON.stringify(attempts));
});

test('回执带执行关联字段，便于把观测与动作对上号', async (t) => {
  const w = flat();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.actionId, 'move_step');
  assert.match(String(r.data?.executionId), /[:]move_step:\d+$/);
  assert.equal(typeof r.data?.sequence, 'number');
});

test('L1 manifest 覆盖每个基础动作，且效果/失败码都有声明', () => {
  assert.equal(L1_MANIFEST.length, l1Primitives.length);
  const problems = new Set<string>(PRIMITIVE_PROBLEM_KINDS);
  for (const contract of L1_MANIFEST) {
    assert.ok(contract.args.length > 0, `${contract.name} 缺少 args`);
    assert.ok(contract.effects.length > 0, `${contract.name} 缺少 effects`);
    assert.ok(contract.problems.length > 0, `${contract.name} 缺少 problems`);
    for (const kind of contract.problems) assert.ok(problems.has(kind), `${contract.name} 声明了未知 problem ${kind}`);
  }
  assert.deepEqual(L1_MANIFEST.map((c) => c.name).sort(), ['mine_cell', 'move_step', 'pillar_one', 'place_cell', 'place_support']);
});

test('place_cell 占用分类使用 TARGET_OCCUPIED，而不是 PATH_NOT_FOUND 语义', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(problemKind(r), 'TARGET_OCCUPIED');
});

test('move_step 两格高整块墙：返回真实阻挡，不给必败的上一级修正', async (t) => {
  const w = flat();
  w.pos = { x: 0.5, y: 79, z: 0.5 };
  w.groundY = 78;
  // 相邻列 y79、y80 都是完整方块：y80 只是表面候选，不是可站立脚高。
  w.blocks.push({ name: 'obsidian', pos: { x: 1, y: 79, z: 0 } }, { name: 'obsidian', pos: { x: 1, y: 80, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.movementNotAttempted, true);
  assert.equal(problemKind(r), 'TARGET_BLOCKED');
  assert.equal(r.data?.surfaceCandidateY, 80);
  assert.equal(r.data?.standableFootY, null);
  assert.equal(r.data?.remediation, undefined, '被占的候选脚高不能作为脚高修正建议');
  assert.deepEqual(w.pos, { x: 0.5, y: 79, z: 0.5 });
});

test('move_step 一格台阶：相对写法锁定同一列，按经身体净空检查的实际脚高执行', async (t) => {
  const w = flat();
  w.pos = { x: 0.5, y: 79, z: 0.5 };
  w.groundY = 78;
  w.blocks.push({ name: 'cobblestone', pos: { x: 1, y: 79, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.pos.y, 80);
  assert.deepEqual(r.data?.requestedAt, [1, 0, 0]);
  assert.deepEqual(r.data?.resolvedAt, [1, 1, 0]);
  assert.equal(r.data?.standableFootY, 80);
  assert.match(r.summary, /上一级/);
});

test('move_step 落点有岩浆时默认拒绝，allowHazard 显式接受后才迈', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'lava', pos: { x: 1, y: 64, z: 1 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(problemKind(r), 'HAZARD_RISK_UNAUTHORIZED');
  assert.equal(r.data?.movementNotAttempted, true);
  assert.deepEqual((r.data?.hazards as { cell: Vec3Like; name: string; where: string }[])[0], { cell: { x: 1, y: 64, z: 1 }, name: 'lava', where: 'adjacent' });
  assert.match(r.summary, /allowHazard/);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: 0.5 });

  const v = moveStep.validate({ to: [1, 0, 0], facing: 'E', allowHazard: true }, w);
  if (!v.ok) assert.fail(v.error);
  assert.equal(v.args.allowHazard, true);
  const allowed = await moveStep.run(ctx, v.args);
  assert.equal(allowed.status, 'succeeded', allowed.summary);
  assert.equal(allowed.data?.allowHazard, true);
});

test('move_step 支撑是岩浆块、身体格是火时同样按危险拒绝', async (t) => {
  const magma = flat();
  magma.blocks.push({ name: 'magma_block', pos: { x: 1, y: 63, z: 0 } });
  const magmaCtx = makeCtx(magma);
  t.after(() => magmaCtx.memory.close());
  const onMagma = await moveStep.run(magmaCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(problemKind(onMagma), 'HAZARD_RISK_UNAUTHORIZED');
  assert.equal((onMagma.data?.hazards as { where: string }[])[0]?.where, 'support');

  const fire = flat();
  fire.blocks.push({ name: 'fire', pos: { x: 1, y: 64, z: 0 } });
  const fireCtx = makeCtx(fire);
  t.after(() => fireCtx.memory.close());
  const inFire = await moveStep.run(fireCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(problemKind(inFire), 'HAZARD_RISK_UNAUTHORIZED');
  assert.equal((inFire.data?.hazards as { where: string }[])[0]?.where, 'body');
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import type { Block } from 'prismarine-block';
import type { ActionResult, PlacementFaceAttempt, Vec3Like } from '../src/adapter/types.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { placeCell, placeSupport } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const require = createRequire(import.meta.url);
const registry: any = require('minecraft-data')('1.20.1');
const BlockClass = require('prismarine-block')('1.20.1') as typeof Block;

function flat() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  return w;
}

/** 当前站位永远放不上，用来看 place_support 的失败回执和边缘潜行分派。 */
class EdgeWorld extends FakeAdapter {
  edgeCalls: Vec3Like[] = [];
  edgeMode: 'ok' | 'no_ref' = 'ok';
  override async placeBlockAt(_pos: Vec3Like, _items: string[], _signal: AbortSignal): Promise<ActionResult & { attemptedFaces?: PlacementFaceAttempt[] }> {
    return { ok: false, reason: 'NO_REFERENCE', detail: '直接放置时四周没有可点的参照面', attemptedFaces: [] };
  }
  async sneakPlaceAt(target: Vec3Like, itemNames: string[], _signal: AbortSignal): Promise<ActionResult & { placed?: Vec3Like; stance?: Vec3Like; attemptedFaces?: PlacementFaceAttempt[] }> {
    this.edgeCalls.push({ ...target });
    // 模拟适配器潜行到边缘再退回：返回的边缘站位不同于调用后的身体位置。
    const stance = { x: this.pos.x + 0.6, y: this.pos.y, z: this.pos.z };
    if (this.edgeMode === 'no_ref') {
      return { ok: false, reason: 'EDGE_NO_REFERENCE:目标格同层没有实心参照方块', stance, attemptedFaces: [] };
    }
    const name = itemNames.find((n) => (this.inv.get(n) ?? 0) > 0);
    if (!name) return { ok: false, reason: 'NO_ITEM', stance, attemptedFaces: [] };
    this.inv.set(name, this.inv.get(name)! - 1);
    this.removed.delete(`${target.x},${target.y},${target.z}`);
    this.blocks = this.blocks.filter((b) => !(b.pos.x === target.x && b.pos.y === target.y && b.pos.z === target.z));
    this.blocks.push({ name, pos: { ...target } });
    return { ok: true, placed: { ...target }, stance, attemptedFaces: [{ ref: { x: 0, y: target.y, z: 0 }, face: [1, 0, 0] }] };
  }
}

/** 每次放置都因“只在脚下有参照面”失败；用于 place_cell 的站位提示。 */
class CellNoReferenceWorld extends FakeAdapter {
  override async placeBlockAt(_pos: Vec3Like, _items: string[], _signal: AbortSignal): Promise<ActionResult & { attemptedFaces?: PlacementFaceAttempt[] }> {
    return {
      ok: false,
      reason: 'NO_REFERENCE',
      detail: '(0,63,0) 命中的不是请求的那一面（可能斜穿）',
      attemptedFaces: [{ ref: { x: 0, y: 63, z: 0 }, face: [1, 0, 0], reason: 'FACE_NOT_CLICKABLE:视线被挡或超出交互距离' }],
    };
  }
}

/** 每次放置都失败，并带回结构化参照面事实。 */
class FaceFailWorld extends FakeAdapter {
  override async placeBlockAt(_pos: Vec3Like, _items: string[], _signal: AbortSignal): Promise<ActionResult & { attemptedFaces?: PlacementFaceAttempt[] }> {
    return {
      ok: false,
      reason: 'NO_REFERENCE',
      detail: '(1,63,0) 有 1 个相邻实心方块，但视线被挡',
      attemptedFaces: [{ ref: { x: 0, y: 62, z: 0 }, face: [1, 0, 0], reason: 'FACE_NOT_CLICKABLE:视线被挡或超出交互距离' }],
    };
  }
}

test('place_support 必须显式给 item；缺省不再默认自选 any', () => {
  const missing = placeSupport.validate({ at: [1, -1, 0], facing: 'E' }, flat());
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.error : '', /item/);
  const any = placeSupport.validate({ at: [1, -1, 0], facing: 'E', item: 'any' }, flat());
  assert.ok(any.ok, !any.ok ? any.error : '');
  const known = placeSupport.validate({ at: [1, -1, 0], facing: 'E', item: 'cobblestone' }, flat());
  assert.ok(known.ok, !known.ok ? known.error : '');
  const unknown = placeSupport.validate({ at: [1, -1, 0], facing: 'E', item: 'Iron Pickaxe' }, flat());
  assert.equal(unknown.ok, false);
});

test('place_support 成功回执返回可核对的净消耗（指定材料）', async (t) => {
  const w = flat();
  w.inv.set('cobblestone', 2);
  w.removed.add('1,63,0');
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.consumed, 1);
  assert.deepEqual(r.data?.materials, ['cobblestone']);
  assert.equal(w.inv.get('cobblestone'), 1);

  const again = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(again.status, 'succeeded', again.summary);
  assert.equal(again.data?.consumed, 0, '已有支撑时不再消耗材料');
});

test('place_support 的 any 按显式目标材料集合计算净消耗', async (t) => {
  const w = flat();
  w.inv.set('dirt', 3);
  w.inv.set('cobblestone', 2);
  w.removed.add('1,63,0');
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'any' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.consumed, 1);
  assert.deepEqual([...(r.data?.materials as string[])], ['dirt', 'cobblestone']);
  const total = [...w.inv.values()].reduce((n, v) => n + v, 0);
  assert.equal(total, 4, '5 块里真实少了 1 块');
  assert.equal(w.blockAt({ x: 1, y: 63, z: 0 }), 'dirt');
});

test('place_support 失败回执带实际站位、参照面和替代动作', async (t) => {
  const w = new FaceFailWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS', '参照面不成立是参数/站位问题，不是“没有路”');
  assert.match(r.summary, /相邻实心方块|视线被挡/, '参照面细节必须进摘要，不能只留在 data');
  const attempts = r.data?.attempts as { stance: string; position: Vec3Like; attemptedFaces?: PlacementFaceAttempt[] }[];
  assert.ok(Array.isArray(attempts) && attempts.length >= 1);
  assert.equal(attempts[0].stance, 'current');
  assert.deepEqual(attempts[0].position, { x: 0.5, y: 64, z: 0.5 });
  assert.deepEqual(attempts[0].attemptedFaces, [{ ref: { x: 0, y: 62, z: 0 }, face: [1, 0, 0], reason: 'FACE_NOT_CLICKABLE:视线被挡或超出交互距离' }]);
  assert.equal(r.data?.consumed, 0);
  assert.deepEqual(r.data?.materials, ['cobblestone']);
  const remediation = r.data?.remediation as { alternatives: string[] };
  assert.ok(remediation.alternatives.some((a) => a.includes('descend_to')));
  assert.ok(remediation.alternatives.some((a) => a.includes('place_cell')));
  assert.match(r.summary, /NO_REFERENCE/);
});

test('place_support 未观察到的占格名称不补全，如实说未看清', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'torch', pos: { x: 1, y: 64, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.occupied, null);
  assert.equal(r.data?.observed, false);
  assert.doesNotMatch(r.summary, /torch/);
  assert.match(r.summary, /未看清/);

  const support = flat();
  const supportCtx = makeCtx(support, { senses: { observeBlocks: () => [] } });
  t.after(() => supportCtx.memory.close());
  const existing = await placeSupport.run(supportCtx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(existing.status, 'succeeded', existing.summary);
  assert.equal(existing.data?.already, null);
  assert.equal(existing.data?.observed, false);
  assert.doesNotMatch(existing.summary, /grass_block/);
  assert.match(existing.summary, /未看清/);
});

test('place_cell 未观察到的占用方块不把内部名当成看见', async (t) => {
  const w = flat();
  w.blocks.push({ name: 'torch', pos: { x: 1, y: 64, z: 0 } });
  const hidden = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => hidden.memory.close());
  const unseen = await placeCell.run(hidden, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(unseen.status, 'failed');
  assert.equal(unseen.data?.occupied, null);
  assert.equal(unseen.data?.unknown, true);
  assert.doesNotMatch(unseen.summary, /torch/);
  assert.match(unseen.summary, /未看清/);

  const seenCtx = makeCtx(w);
  t.after(() => seenCtx.memory.close());
  const seen = await placeCell.run(seenCtx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(seen.status, 'failed');
  assert.equal(seen.data?.occupied, 'torch');
  assert.match(seen.summary, /torch/);
});

test('place_support 脚下方两格：边缘潜行可完成并返回净消耗', async (t) => {
  const w = new EdgeWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,62,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -2, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(w.edgeCalls, [{ x: 1, y: 62, z: 0 }], '两格下也交给边缘潜行，而不是静默放弃');
  assert.equal(w.blockAt({ x: 1, y: 62, z: 0 }), 'cobblestone');
  assert.equal(r.data?.consumed, 1);
  assert.equal(r.data?.placed, 'cobblestone');
});

test('place_support 脚下方两格没有同层参照面时如实失败并给替代动作', async (t) => {
  const w = new EdgeWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,62,0');
  w.inv.set('cobblestone', 1);
  w.edgeMode = 'no_ref';
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -2, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.deepEqual(w.edgeCalls, [{ x: 1, y: 62, z: 0 }]);
  const attempts = r.data?.attempts as { stance: string; reason?: string; position?: Vec3Like; endPosition?: Vec3Like }[];
  const edgeAttempt = attempts.find((a) => a.stance === 'edge');
  assert.ok(edgeAttempt && /EDGE_NO_REFERENCE/.test(edgeAttempt.reason ?? ''));
  assert.deepEqual(edgeAttempt.position, { x: 1.1, y: 64, z: 0.5 }, '尝试站位用适配器报告的边缘位置');
  assert.deepEqual(edgeAttempt.endPosition, { x: 0.5, y: 64, z: 0.5 }, '调用后已退回格心，单独记录');
  assert.match(r.summary, /EDGE_NO_REFERENCE/);
  assert.equal(r.data?.consumed, 0);
  const remediation = r.data?.remediation as { alternatives: string[] };
  assert.ok(remediation.alternatives.some((a) => a.includes('descend_to')));
  assert.ok(remediation.alternatives.some((a) => a.includes('place_cell')));
});

test('place_support 三格下不走边缘潜行，不扩成自动施工', async (t) => {
  const w = new EdgeWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,61,0');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [0, 0, 0], facing: 'E', xyz: { x: 1, y: 61, z: 0 }, item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.deepEqual(w.edgeCalls, []);
  assert.match(r.summary, /\(1,61,0\)/, '摘要要写实际目标格，不能是调用方占位用的 [0,0,0]');
  assert.doesNotMatch(r.summary, /\[0,0,0\]/);
  assert.match(r.summary, /脚下 3 格/, '超出脚下 1–2 格时要说明补支撑的几何范围');
});

test('place_support 目标水平相距 2 格时说明贴边放置不适用，而不是只报 NO_REFERENCE', async (t) => {
  const w = new FaceFailWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [2, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /水平相距 2 格/);
  assert.match(r.summary, /只支持水平相邻格/);
});

test('place_support 失败摘要列出每个站位的短原因，edge 失败不被 detail 挤掉', async (t) => {
  const w = new EdgeWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,62,0');
  w.inv.set('cobblestone', 1);
  w.edgeMode = 'no_ref';
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -2, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /current:NO_REFERENCE/);
  assert.match(r.summary, /edge:EDGE_NO_REFERENCE/);
  assert.ok(r.summary.length < 320, `失败摘要要能在心智的截断窗口内读到 edge：${r.summary.length}`);
});

test('place_cell 在脚下相邻格只能看到自己踩着的侧面时，点明 place_support 可贴边放', async (t) => {
  const w = new CellNoReferenceWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.groundY = 62; // 目标 (1,63,0) 是空气，且身体仍站在脚格高度
  w.inv.set('netherrack', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'netherrack' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /place_support/, '要让心智知道换用会贴边放置的技能，而不是只反复“靠近/侧移”');
  assert.match(r.summary, /不换站位/);
});

/** 真实 MineflayerAdapter + 最小 fake bot：只模拟服务器放置/装备/移动，几何走真实实现。 */
function realAdapterFixture() {
  const cells = new Map<string, Block>();
  const inventory = new Map<string, number>();
  const equipCalls: string[] = [];
  const air = (pos: Vec3) => Object.assign(BlockClass.fromStateId(registry.blocksByName.air.defaultState, 0), { position: pos.floored() });
  const put = (name: string, pos: Vec3) => {
    const block = BlockClass.fromStateId(registry.blocksByName[name].defaultState, 0);
    block.position = pos.floored();
    cells.set(block.position.toString(), block);
    return block;
  };
  const blockAt = (pos: Vec3) => cells.get(pos.floored().toString()) ?? air(pos);
  const bot: any = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, yaw: 0, pitch: 0, onGround: true, isInWater: false, effects: {} },
    inventory: {
      items: () => [...inventory].filter(([, n]) => n > 0)
        .map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id, enchants: [] })),
    },
    heldItem: null as { name: string; type: number } | null,
    blockAt,
    canDigBlock: () => true,
    async equip(item: { name: string; type: number }) { equipCalls.push(item.name); bot.heldItem = item; },
    async lookAt(point: Vec3) {
      const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0));
      bot.entity.yaw = Math.atan2(-delta.x, -delta.z);
      bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    },
    setControlState(name: string, value: boolean) {
      if (name === 'forward' && value) bot.entity.position = new Vec3(1.1, bot.entity.position.y, bot.entity.position.z);
    },
    clearControlStates() {},
    deactivateItem() {},
    async placeBlock(ref: { position: Vec3 }, face: Vec3) { put('cobblestone', ref.position.plus(face)); },
    async dig() {},
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot;
  adapter.mcData = registry;
  Reflect.set(adapter, 'connectedFlag', true);
  return { adapter, bot, inventory, put, equipCalls };
}

test('真实适配器 sneakPlaceAt：脚下一格点支撑块侧面', async () => {
  const f = realAdapterFixture();
  f.put('stone', new Vec3(0, 63, 0));
  f.inventory.set('cobblestone', 1);
  const r = await f.adapter.sneakPlaceAt({ x: 1, y: 63, z: 0 }, ['cobblestone'], new AbortController().signal);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.placed, { x: 1, y: 63, z: 0 });
  assert.deepEqual(r.attemptedFaces, [{ ref: { x: 0, y: 63, z: 0 }, face: [1, 0, 0] }]);
  assert.equal(f.bot.blockAt(new Vec3(1, 63, 0)).name, 'cobblestone');
  assert.deepEqual(f.equipCalls, ['cobblestone']);
  assert.ok(r.stance && Math.abs(r.stance.x - 1.1) < 0.01);
});

test('真实适配器 sneakPlaceAt：脚下方两格点支撑块下方同层侧面', async () => {
  const f = realAdapterFixture();
  f.put('stone', new Vec3(0, 63, 0));
  f.put('stone', new Vec3(0, 62, 0));
  f.inventory.set('cobblestone', 1);
  const r = await f.adapter.sneakPlaceAt({ x: 1, y: 62, z: 0 }, ['cobblestone'], new AbortController().signal);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.placed, { x: 1, y: 62, z: 0 });
  assert.deepEqual(r.attemptedFaces, [{ ref: { x: 0, y: 62, z: 0 }, face: [1, 0, 0] }]);
  assert.equal(f.bot.blockAt(new Vec3(1, 62, 0)).name, 'cobblestone');
});

test('真实适配器 sneakPlaceAt：脚下方两格没有同层参照时如实 EDGE_NO_REFERENCE', async () => {
  const f = realAdapterFixture();
  f.put('stone', new Vec3(0, 63, 0));
  f.inventory.set('cobblestone', 1);
  const r = await f.adapter.sneakPlaceAt({ x: 1, y: 62, z: 0 }, ['cobblestone'], new AbortController().signal);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /^EDGE_NO_REFERENCE/);
  assert.deepEqual(r.attemptedFaces, []);
  assert.equal(f.bot.blockAt(new Vec3(1, 62, 0)).name, 'air');
  assert.deepEqual(f.equipCalls, []);
});

test('真实适配器 sneakPlaceAt：从格子后半部起步，按潜行速度也能挪到边缘外侧再放', async (t) => {
  const f = realAdapterFixture();
  f.put('stone', new Vec3(0, 63, 0));
  f.inventory.set('cobblestone', 1);
  const bot = f.bot;
  // 身体偏在背离目标的一侧：要潜行约 1.05 格才越过东侧边缘。
  bot.entity.position = new Vec3(0.05, 64, 0.5);
  bot.look = async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  let forward = false;
  bot.setControlState = (name: string, value: boolean) => { if (name === 'forward') forward = value; };
  bot.clearControlStates = () => { forward = false; };
  // 潜行速度约 1.3 格/秒。
  const timer = setInterval(() => {
    if (!forward) return;
    const p = bot.entity.position;
    bot.entity.position = new Vec3(p.x - Math.sin(bot.entity.yaw) * 0.013, p.y, p.z - Math.cos(bot.entity.yaw) * 0.013);
  }, 10);
  t.after(() => clearInterval(timer));
  const r = await f.adapter.sneakPlaceAt({ x: 1, y: 63, z: 0 }, ['cobblestone'], new AbortController().signal);
  assert.equal(r.ok, true, r.reason);
  assert.equal(f.bot.blockAt(new Vec3(1, 63, 0)).name, 'cobblestone');
});

test('真实适配器 sneakPlaceAt advance：放置后朝原目标方向前进，不沿参照面视线倒退', async (t) => {
  const f = realAdapterFixture();
  f.put('stone', new Vec3(0, 63, 0));
  f.inventory.set('cobblestone', 1);
  const bot = f.bot;
  // 让身体按键按 yaw 真正移动，并复刻 mineflayer 放置时“看向被点面中心”的转头行为。
  bot.look = async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  let forward = false;
  bot.setControlState = (name: string, value: boolean) => { if (name === 'forward') forward = value; };
  bot.clearControlStates = () => { forward = false; };
  const timer = setInterval(() => {
    if (!forward) return;
    const p = bot.entity.position;
    bot.entity.position = new Vec3(p.x - Math.sin(bot.entity.yaw) * 0.02, p.y, p.z - Math.cos(bot.entity.yaw) * 0.02);
  }, 10);
  t.after(() => clearInterval(timer));
  bot.placeBlock = async (ref: { position: Vec3 }, face: Vec3) => {
    f.put('cobblestone', ref.position.plus(face));
    const point = ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0));
    bot.entity.yaw = Math.atan2(-delta.x, -delta.z);
    bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
  };
  const r = await f.adapter.sneakPlaceAt({ x: 1, y: 63, z: 0 }, ['cobblestone'], new AbortController().signal, { advance: true });
  assert.equal(r.ok, true, r.reason);
  // 放置后视线被转向参照面，若不重新瞄准原方向，前进键会把身体带回旧方块。
  assert.ok(bot.entity.position.x > 1, `前进方向应朝东：x=${bot.entity.position.x.toFixed(2)}`);
});

test('真实适配器 dig handOnly：空手不从背包装备工具，并返回 noDrop 事实', async () => {
  const f = realAdapterFixture();
  f.put('stone', new Vec3(1, 64, 0));
  f.inventory.set('iron_pickaxe', 1);
  const r = await f.adapter.dig({ x: 1, y: 64, z: 0 }, new AbortController().signal, { handOnly: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.noDrop, true);
  assert.deepEqual(f.equipCalls, []);
  assert.equal(f.bot.heldItem, null);
});

test('真实适配器 dig handOnly：手持木镐时只用木镐，不换成包里的铁镐', async () => {
  const f = realAdapterFixture();
  f.put('stone', new Vec3(1, 64, 0));
  f.inventory.set('wooden_pickaxe', 1);
  f.inventory.set('iron_pickaxe', 1);
  f.bot.heldItem = { name: 'wooden_pickaxe', type: registry.itemsByName.wooden_pickaxe.id };
  const r = await f.adapter.dig({ x: 1, y: 64, z: 0 }, new AbortController().signal, { handOnly: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.noDrop, undefined);
  assert.deepEqual(f.equipCalls, []);
  assert.equal(f.bot.heldItem?.name, 'wooden_pickaxe');
});

test('真实适配器 dig 默认行为不变：没传 handOnly 时仍自动装备最合适工具', async () => {
  const f = realAdapterFixture();
  f.put('stone', new Vec3(1, 64, 0));
  f.inventory.set('iron_pickaxe', 1);
  const r = await f.adapter.dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(f.equipCalls, ['iron_pickaxe']);
  assert.equal(f.bot.heldItem?.name, 'iron_pickaxe');
});

/** 放置已经发生，但适配器仍返回失败（超时/回执丢失）：世界状态才是效果证据。 */
class PlacedThenFailWorld extends FakeAdapter {
  override async placeBlockAt(pos: Vec3Like, items: string[], signal: AbortSignal): Promise<ActionResult> {
    const placed = await super.placeBlockAt(pos, items, signal);
    return placed.ok ? { ok: false, reason: 'TIMEOUT: 回执丢失' } : placed;
  }
}

test('place_cell：适配器回执失败但世界已放置时，以权威方块状态结算成功', async (t) => {
  const w = new PlacedThenFailWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('stone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'stone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'stone');
  assert.match(String(r.data?.adapterReason ?? ''), /TIMEOUT/);
});

test('place_support：适配器回执失败但目标格已形成支撑时，不再换站位重复放置', async (t) => {
  const w = new PlacedThenFailWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.inv.set('stone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'stone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(w.blockAt({ x: 1, y: 63, z: 0 }), 'stone');
  assert.equal(w.inv.get('stone'), 1, '只消耗一块，不因回执失败重复放置');
});

/** 换站位移动已经产生部分位移后抛错：旧起点生成的候选站位不再成立。 */
class PartialStanceWorld extends FakeAdapter {
  override async placeBlockAt(): Promise<ActionResult> {
    return { ok: false, reason: 'NO_REFERENCE' };
  }
  override async moveTo(): Promise<void> {
    this.pos = { x: this.pos.x + 0.25, y: this.pos.y, z: this.pos.z };
    throw new Error('MOVE_INTERRUPTED');
  }
}

test('place_support：换站位移动部分发生后不按旧起点继续', async (t) => {
  const w = new PartialStanceWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('stone', 2);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await placeSupport.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'stone' });
  assert.equal(r.status, 'failed');
  assert.equal((r.data?.problem as { kind?: string } | undefined)?.kind, 'STANCE_MOVE_PARTIAL');
  assert.equal(w.inv.get('stone'), 2, '没有发生放置消耗');
});

test('any 只用土石类填充方块：背包里只有原木和金块时报缺口并列出 any 不会动用的方块', async () => {
  const { pillarOne } = await import('../src/skills/movement/primitives.ts');
  const { FakeAdapter } = await import('./fake-adapter.ts');
  const adapter = new FakeAdapter();
  adapter.inv.set('oak_log', 12);
  adapter.inv.set('gold_block', 60);
  (adapter as unknown as { pillarUp: () => Promise<{ ok: boolean }> }).pillarUp = async () => { throw new Error('不应放置'); };
  const r = await pillarOne.run({ adapter, signal: new AbortController().signal, deadline: Date.now() + 5000, progress() {} } as never, { item: 'any' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'MISSING_MATERIALS');
  assert.match(r.summary, /oak_log×12/);
  assert.match(r.summary, /gold_block×60/);
  assert.match(r.summary, /any 不会用它们/);
});

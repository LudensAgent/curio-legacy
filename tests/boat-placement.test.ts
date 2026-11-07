import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { useItem } from '../src/skills/actions.ts';
import { interactBlock } from '../src/skills/block-interaction.ts';
import { planBoatRoute } from '../src/skills/vehicles.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { TestWorld, makeCtx } from './survival-helpers.ts';

const require = createRequire(import.meta.url), Vec3 = require('vec3').Vec3;
const { RaycastIterator } = require('prismarine-world').iterators;

// ------------------------------------------------------------------ C 未动：划船水域判定保持原样
test('boat_path 水域判定不变：海带格仍算可划水面（本卡不统一放船/划船口径）', () => {
  const a = new FakeAdapter();
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) a.blocks.push({ name: 'kelp_plant', pos: { x, y: 63, z } });
  for (let x = 2; x <= 5; x++) for (let z = -1; z <= 1; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  a.pos = { x: 0.5, y: 63.9, z: 0.5 };
  const ctx = makeCtx(a, { senses: { knownBlocks: () => [], observeBlocks: () => [] } });
  const route = planBoatRoute(ctx, a.pos, { x: 4.5, z: 0.5 }, {});
  assert.ok(route, '船起点在海带格上：按 BOAT_FLUID 口径仍应识别为水面');
  assert.equal(route.reach, 'water');
});

// ------------------------------------------------------------------ A1 口径
test('use_item 描述不再把船/筏指向 interact_block 坐标，并给出实际入口', () => {
  assert.doesNotMatch(useItem.description, /要对准确定的那一格用 interact_block/);
  assert.doesNotMatch(useItem.description, /interact_block（写坐标）/);
  assert.match(useItem.description, /interact_block 只对可见方块右键并拒绝船\/筏/);
  assert.match(useItem.description, /on 写坐标当前也不支持船\/筏/);
  assert.match(useItem.description, /interact \{"entity":"boat"\}/);
  assert.match(useItem.argsDoc, /船\/筏写 water，坐标形式不支持船\/筏/);
});

test('坐标写船返回准确 BAD_ARGS，并与 interact_block 拒绝文案共用同一指引', async (t) => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.inv.set('oak_boat', 1);
  const r = await useItem.run(ctx, { item: 'oak_boat', on: { x: 0, y: 64, z: 2 } });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /on 写坐标当前不支持放船\/筏/, '不能落进“只支持桶/点火”的泛化报错');
  assert.doesNotMatch(r.summary, /对其他物品请写方块名或 "self"/);

  const refused = interactBlock.validate({ target: 'oak_boat' }, w);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  for (const fragment of [
    '是船/筏（实体，不是方块）',
    '不能用 interact_block 右键',
    '坐上去用 interact {"entity":"boat"}',
    '放船用 use_item {"item":"oak_boat","on":"water"}',
  ]) {
    assert.ok(r.summary.includes(fragment), `use_item BAD_ARGS 缺少对齐片段：${fragment}`);
    assert.ok(refused.error.includes(fragment), `interact_block 拒绝文案缺少对齐片段：${fragment}`);
  }
});

// ------------------------------------------------------------------ B 预检/归因
/**
 * 只模拟 use_item 链路需要的数据包与已确认状态；不跑物理/game loop。
 * world.raycast 用真实 RaycastIterator 迭代，并像 mineflayer 的 WorldSync 一样把 (block, iterator)
 * 交给生产侧的 boatSurface matcher：液面形状与命中判定都由生产代码决定，测试不复制一份。
 * 默认眼位 (0.5,63.62,0.5) 即“人在水里”时的高度（脚 62），目标水面 (3,62,0)。
 */
function boatFixture(opts: { feetY?: number; item?: string; blockers?: { name: string; pos: any }[] } = {}) {
  const item = opts.item ?? 'oak_boat';
  const registry = require('minecraft-data')('1.20.1'), cells = new Map<string, any>();
  let count = 1;
  const put = (name: string, position: any, properties: Record<string, unknown> = {}, shapes: number[][] = []) => cells.set(position.toString(), {
    name, position, shapes, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => properties,
  });
  const water = new Vec3(3, 62, 0);
  put('water', water, { level: 0 });
  for (const blocker of opts.blockers ?? []) put(blocker.name, blocker.pos, {}, [[0, 0, 0, 1, 1, 1]]);
  const writes: string[] = [], looks: any[] = [];
  const feet = new Vec3(0.5, opts.feetY ?? 62, 0.5), eye = feet.offset(0, 1.62, 0);
  const blockAt = (p: any) => {
    // RaycastIterator.next() 返回的是 {x,y,z,face} 普通对象，不一定是 Vec3；按整数格取块。
    const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    return cells.get(position.toString()) ?? { name: 'air', position, shapes: [], boundingBox: 'empty', getProperties: () => ({}) };
  };
  const bot: any = {
    game: { dimension: 'overworld' },
    entity: { position: feet, yaw: 0, pitch: 0, eyeHeight: 1.62 },
    entities: {},
    inventory: { items: () => count ? [{ name: item, type: registry.itemsByName[item].id, count }] : [], emptySlotCount: () => 20 },
    blockAt,
    async equip(held: any) { bot.heldItem = held; },
    clearControlStates() {}, deactivateItem() {}, pathfinder: { stop() {}, setGoal() {} },
    waitForTicks: async () => {},
    supportFeature: () => false, _genericPlace: async () => {}, swingArm: () => {},
    _client: { write(name: string) { writes.push(name); } },
    world: {
      raycast: (from: any, dir: any, range: number, matcher: any) => {
        const ray = new RaycastIterator(from, dir, range);
        for (let pos = from; pos; pos = ray.next()) {
          const candidate = blockAt(pos);
          if (matcher(candidate, ray)) return candidate;
        }
        return null;
      },
    },
  };
  bot.lookAt = async (point: any) => {
    looks.push(point);
    const d = point.minus(eye), flat = Math.hypot(d.x, d.z);
    bot.entity.yaw = Math.atan2(-d.x, -d.z);
    bot.entity.pitch = Math.atan2(d.y, flat);
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = registry; (adapter as any).connectedFlag = true;
  adapter.moveTo = async () => {};
  return { adapter, bot, water, writes, looks, count: () => count, consume: () => { count--; }, setBlock: put };
}

/** 模拟服务器接受：第一次 use_item 就扣船并冒出实体，避免成功用例空等 3 秒。 */
function acceptFirstUse(f: ReturnType<typeof boatFixture>) {
  f.bot._client.write = async (name: string) => {
    f.writes.push(name);
    f.consume();
    f.bot.entities[88] = { id: 88, name: 'boat', position: f.water.clone().offset(0.5, 0.9, 0.5) };
  };
}

test('放船预检：水中眼位（脚 62，眼 63.62）瞄准真实 8/9 液面可命中并放置', async () => {
  const f = boatFixture();
  acceptFirstUse(f);
  const result = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: f.water }, new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.spawned, 'boat');
  assert.equal(f.writes.length, 1, '只对委托的目标水面发送一次 use_item');
  assert.equal(f.count(), 0, '背包里的船减少');
  assert.ok(f.looks.every((p: any) => p.distanceTo(f.water.offset(0.5, 0.85, 0.5)) < 1e-9),
    '瞄点必须低于 8/9 液面（原 y+1.0 会 MISS）');
});

test('放船预检：岸上眼位（脚 63）瞄准真实水面仍可命中并放置', async () => {
  const f = boatFixture({ feetY: 63 });
  acceptFirstUse(f);
  const result = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: f.water }, new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.writes.length, 1);
});

test('放船预检：无 raycast 能力时回退只做位置/眼位校验，并如实标注视线未验证', async () => {
  // 模拟没有 world.raycast 的适配器：只能退回 canClickPlacementFace 的距离/眼位口径。
  const f = boatFixture();
  delete (f.bot.world as any).raycast;
  acceptFirstUse(f);
  const result = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: f.water }, new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.writes.length, 1, '回退校验通过后仍按委托发送一次 use_item');
  const reasons = result.effectEvidence?.reasons?.join('；') ?? '';
  assert.match(reasons, /无 raycast 能力：仅通过位置\/眼位回退校验（视线未验证）后发送使用动作 1 次/);
  assert.doesNotMatch(reasons, /视线预检通过/, '没有 raycast 时不得声称视线预检通过');
});

test('放船预检：射线先命中非水方块（石头）时不发 use_item、不空转重试，并报告已观察事实', async () => {
  // 石头挡在眼睛(0.5,63.62,0.5)与目标水面(3,62,0)之间：y 63 的整格会先被射线进入。
  const f = boatFixture({ blockers: [{ name: 'stone', pos: new Vec3(2, 63, 0) }] });
  const started = Date.now();
  const result = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: f.water }, new AbortController().signal);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /^NO_PLACEMENT_FACE/);
  assert.equal(f.writes.length, 0, '预检失败不能在发送 use_item 后才暴露');
  assert.ok(elapsed < 500, `预检失败应立即返回，实际等待 ${elapsed}ms`);
  const reasons = result.effectEvidence?.reasons?.join('；') ?? '';
  assert.match(reasons, /视线未命中目标水面/);
  assert.match(reasons, /目标格 \(3\.0,62\.0,0\.0\) 是 water/);
  assert.match(reasons, /实测位置/);
  assert.match(reasons, /眼位/);
  assert.match(reasons, /inWater=/);
  assert.equal(result.effectEvidence?.changed, false);
});

test('放船预检：目标水面上方被方块遮挡时 miss，不发送 use_item', async () => {
  const f = boatFixture({ feetY: 63, blockers: [{ name: 'stone', pos: new Vec3(3, 63, 0) }] });
  const result = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: f.water }, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /^NO_PLACEMENT_FACE/);
  assert.equal(f.writes.length, 0);
});

test('放船重试轮预检失败：头句按已发送次数说明本轮未发送，不再谎称从未发送', async () => {
  const f = boatFixture();
  // 第一次发送后服务器没有回应；随后视线被石头挡住，第二轮预检失败。
  f.bot._client.write = (name: string) => {
    f.writes.push(name);
    f.setBlock('stone', new Vec3(2, 63, 0), {}, [[0, 0, 0, 1, 1, 1]]);
  };
  const result = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: f.water }, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.equal(f.writes.length, 1, '第一轮已发送；第二轮预检失败不得再发');
  assert.match(result.reason ?? '', /^NO_PLACEMENT_FACE/);
  assert.match(result.reason ?? '', /此前已发送 1 次使用动作均未确认新船实体，本轮未发送/);
  assert.doesNotMatch(result.reason ?? '', /，未发送使用动作$/, '重试轮不能沿用“未发送使用动作”的头句');
  assert.match(result.effectEvidence?.reasons?.join('；') ?? '', /视线未命中目标水面，此前已发送 1 次使用动作/);
});

test('放船服务器未接受：ENTITY_NOT_SPAWNED 归因列出使用次数、背包前后与实体事实', async () => {
  const f = boatFixture();
  const result = await f.adapter.useItemOn('oak_boat', { kind: 'block', pos: f.water }, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /^ENTITY_NOT_SPAWNED/);
  assert.equal(f.writes.length, 3, '预检通过但未确认时重试有界（≤3）');
  assert.equal(result.effectEvidence?.changed, false);
  const reasons = result.effectEvidence?.reasons?.join('；') ?? '';
  assert.match(reasons, /视线预检通过后发送使用动作 3 次/);
  assert.match(reasons, /背包 oak_boat 数量 1→1/);
  assert.match(reasons, /没有出现新船实体/);
});

// ------------------------------------------------------------------ 未改划船语义
test('boat_path 水路判定未变：船仍按原口径把 1 格宽缝隙判为不可通过', () => {
  // 与 tests/boat-route.test.ts 同一地形；本卡不得改变 planBoatRoute/BOAT_FLUID 判定。
  const a = new FakeAdapter();
  for (let x = 0; x <= 20; x++) for (let z = -5; z <= 5; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  for (let z = -5; z <= 5; z++) if (z !== 0) a.blocks.push({ name: 'stone', pos: { x: 10, y: 63, z } }, { name: 'stone', pos: { x: 10, y: 64, z } });
  a.pos = { x: 5.5, y: 63.9, z: 0.5 };
  const ctx = makeCtx(a, { senses: { knownBlocks: () => [], observeBlocks: () => [] } });
  const route = planBoatRoute(ctx, a.pos, { x: 15.5, z: 0.5 }, {});
  assert.equal(route?.reach, 'partial', '1 格宽缝隙挤不过去，应仍报 partial');
  assert.ok(route?.waypoints.every((w) => !(Math.floor(w.x) === 10 && Math.floor(w.z) === 0)), '不应把 1 格宽的缝当成水路');
});

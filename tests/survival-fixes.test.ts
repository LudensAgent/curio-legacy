import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reflex } from '../src/brain/reflex.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { placeTorch } from '../src/skills/light.ts';
import { surface } from '../src/skills/movement.ts';
import { hunt } from '../src/skills/survival.ts';
import { eat, gather, gatherTargetRisk } from '../src/skills/work.ts';
import { dig } from '../src/skills/body.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

// ------------------------------------------------------------ gather 不往水边/出过事的地方钻
test('gather 跳过挨着水的石头，挖干燥露天的那块', async () => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.setBlock({ x: 3, y: 64, z: 0 }, 'stone'); // 近，但挨着水
  w.setBlock({ x: 4, y: 64, z: 0 }, 'water');
  w.setBlock({ x: 0, y: 64, z: 6 }, 'stone'); // 远一点，干燥
  const ctx = makeCtx(w);
  try {
    assert.equal(gatherTargetRisk(ctx, { name: 'stone', pos: { x: 3, y: 64, z: 0 } }, 64), 'wet');
    assert.equal(gatherTargetRisk(ctx, { name: 'stone', pos: { x: 0, y: 64, z: 6 } }, 64), null);
    const r = await gather.run(ctx, { block: 'stone', count: 1 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(w.blockAt({ x: 0, y: 64, z: 6 }), 'air');
    assert.equal(w.blockAt({ x: 3, y: 64, z: 0 }), 'stone', '挨着水的那块没动');
    assert.match(r.summary, /为安全跳过了 1 处挨着水/);
  } finally { ctx.memory.close(); }
});

test('gather：深坑挨水的石头算 deep；树和沙子不因水/危险区跳过；大量不安全候选逐批检查', async () => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const memory = new WorldMemory(null);
  const ctx = makeCtx(w, { memory });
  try {
    w.setBlock({ x: 10, y: 55, z: 10 }, 'stone');
    w.setBlock({ x: 12, y: 54, z: 10 }, 'water');
    assert.equal(gatherTargetRisk(ctx, { name: 'stone', pos: { x: 10, y: 55, z: 10 } }, 64), 'deep');
    // 一棵树挨着水、甚至在危险区域里都没关系（树长在水面以上）；沙子本来就在水边
    w.setBlock({ x: 5, y: 64, z: 5 }, 'oak_log'); w.setBlock({ x: 6, y: 64, z: 5 }, 'water');
    w.setBlock({ x: -5, y: 64, z: 0 }, 'sand'); w.setBlock({ x: -6, y: 64, z: 0 }, 'water');
    assert.equal(gatherTargetRisk(ctx, { name: 'sand', pos: { x: -5, y: 64, z: 0 } }, 64), null);
    memory.addHazard({ dim: 'overworld', pos: { x: 5, y: 64, z: 5 }, kind: 'drowning' });
    assert.equal(gatherTargetRisk(ctx, { name: 'oak_log', pos: { x: 5, y: 64, z: 5 } }, 64), null);
    w.setBlock({ x: 4, y: 64, z: 7 }, 'stone');
    assert.equal(gatherTargetRisk(ctx, { name: 'stone', pos: { x: 4, y: 64, z: 7 } }, 64), 'hazard');
    // 很多不安全的候选：逐批检查，最后说明为什么不挖
    w.setBlock({ x: 10, y: 55, z: 10 }, 'air');
    for (let i = 0; i < 40; i++) w.setBlock({ x: 20 + i, y: 64, z: 20 }, 'stone');
    for (let i = 0; i < 40; i++) w.setBlock({ x: 20 + i, y: 64, z: 21 }, 'water');
    w.setBlock({ x: 4, y: 64, z: 7 }, 'air');
    w.pos = { x: 40.5, y: 64, z: 23.5 };
    memory.addHazard({ dim: 'overworld', pos: { x: 40, y: 63, z: 23 }, kind: 'drowning' }); // 别就地往下挖
    const r = await gather.run(ctx, { block: 'stone', count: 2 });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'NOT_FOUND');
    assert.match(r.summary, /都不安全.*处挨着水/);
  } finally { memory.close(); }
});

// ------------------------------------------------------------ surface：只做一次有界上浮，不挖顶/不找气穴/不寻岸
function submerged(feetY: number) {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 6;
  w.pos = { x: 0.5, y: feetY, z: 0.5 };
  return w;
}

test('surface 只做一次有界上浮：不挖顶、不找气穴、不寻岸、不换目标', async () => {
  const w = submerged(60);
  w.setBlock({ x: 0, y: 62, z: 0 }, 'stone'); // 头顶封住，但 surface 不看也不挖
  let digs = 0, moves = 0, swims = 0;
  const realSwim = w.swimTo.bind(w);
  w.swimTo = async (target: any, signal: AbortSignal, opts?: any) => { swims++; return realSwim(target, signal, opts); };
  w.dig = async () => { digs++; return { ok: true }; };
  w.moveTo = async () => { moves++; };
  const ctx = makeCtx(w, { deadlineMs: 3000 });
  try {
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'failed', r.summary);
    assert.equal(digs, 0, '不得挖开头顶');
    assert.equal(moves, 0, '不得寻路到岸/换目标');
    assert.equal(swims, 1, '只做一次上浮委托');
    assert.equal(r.data?.landed, false);
    assert.equal(r.data?.surfaced, false);
  } finally { ctx.memory.close(); }
});

test('surface 浮出水面但未站稳时报告 surfaced=true、landed=false', async () => {
  const w = submerged(64);
  w.swimTo = async () => { w.inWater = true; w.oxygen = 20; return { ok: true, landed: false, surfaced: true, oxygen: 20 }; };
  const ctx = makeCtx(w);
  try {
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(r.data?.surfaced, true);
    assert.equal(r.data?.landed, false);
  } finally { ctx.memory.close(); }
});

test('surface 上浮失败时保留实际位置与氧气，不谎称上岸', async () => {
  const w = submerged(60);
  w.swimTo = async () => { w.pos = { ...w.pos, y: w.pos.y + 1 }; return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: w.oxygen }; };
  const ctx = makeCtx(w);
  try {
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'failed');
    assert.equal(r.data?.landed, false);
    assert.equal(r.data?.surfaced, false);
    assert.deepEqual(r.data?.pos, w.pos);
    assert.equal(r.data?.oxygen, w.oxygen);
  } finally { ctx.memory.close(); }
});

test('surface 拒绝旧的 escape 参数，不再接受自动挖顶/寻岸', () => {
  const w = new TestWorld();
  const v = surface.validate({ escape: 'shore' }, w);
  assert.equal(v.ok, false);
  assert.match(v.error, /escape/);
});

// ------------------------------------------------------------ 火把 / 吃 / 打鱼
test('place_torch：半空中或泡在水里时立刻说明原因，不去找位置', async () => {
  const w = new TestWorld();
  w.inv.set('torch', 4);
  w.pos = { x: 0.5, y: 66, z: 0.5 }; w.onGround = false;
  const ctx = makeCtx(w);
  try {
    let r = await placeTorch.run(ctx, { count: 1 });
    assert.equal(r.status, 'failed'); assert.match(r.summary, /半空/);
    w.onGround = true; w.inWater = true;
    r = await placeTorch.run(ctx, { count: 1 });
    assert.equal(r.status, 'failed'); assert.match(r.summary, /水里/);
    assert.ok(!w.actions.some((a) => a.startsWith('place:')));
  } finally { ctx.memory.close(); }
});

test('eat：没有吃的时列出可行的替代办法', async () => {
  const w = new TestWorld();
  w.inv.set('beef', 2);
  const ctx = makeCtx(w);
  try {
    const r = await eat.run(ctx, {});
    assert.equal(r.failureCode, 'NO_FOOD');
    assert.match(r.summary, /smelt/); assert.match(r.summary, /hunt/); assert.match(r.summary, /forage/);
  } finally { ctx.memory.close(); }
});

test('hunt：可以指定打鱼，但只打浅水里的鱼', async () => {
  const w = new TestWorld();
  assert.equal(hunt.validate({ animal: 'cod' }, w).ok, true);
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  // 深水里的鱼：在脚下 6 格
  for (let y = 56; y <= 63; y++) w.setBlock({ x: 3, y, z: 0 }, 'water');
  w.entities.push({ id: 7, name: 'cod', kind: 'passive', pos: { x: 3.5, y: 57, z: 0.5 }, dist: 0 });
  const ctx = makeCtx(w);
  try {
    let r = await hunt.run(ctx, { animal: 'cod', count: 1 });
    assert.equal(r.status, 'failed'); assert.match(r.summary, /深水/);
    assert.ok(!w.actions.some((a) => a.startsWith('attack')));
    // 浅水里的鱼（水面下 1 格）
    w.entities = [{ id: 8, name: 'cod', kind: 'passive', pos: { x: 2.5, y: 63, z: 0.5 }, dist: 0 }];
    w.setBlock({ x: 2, y: 63, z: 0 }, 'water');
    r = await hunt.run(ctx, { animal: 'cod', count: 1 });
    assert.ok(w.actions.includes('attack:8'), r.summary);
  } finally { ctx.memory.close(); }
});

test('swim_path surface 不因低氧或封顶升级成挖顶/寻岸：始终只做一次上浮委托', async () => {
  const w = submerged(60);
  w.oxygen = 10;
  for (let y = 60; y <= 70; y++) w.setBlock({ x: 0, y, z: 0 }, 'water');
  const swims: string[] = [];
  w.swimTo = async (target: any) => {
    swims.push(target ? 'shore' : 'up');
    return { ok: false, landed: false, surfaced: false, oxygen: w.oxygen };
  };
  const moves: string[] = [];
  w.moveTo = async (t: any) => { moves.push(t.kind); };
  const ctx = makeCtx(w, { senses: { nearestLand: () => ({ dir: 'E', dist: 6, pos: { x: 6, y: 63, z: 0 } }) } });
  try {
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'failed', r.summary);
    assert.deepEqual(moves, [], '不得升级为让寻路往岸上走');
    assert.deepEqual(swims, ['up'], '只向上浮，从不向岸游');
  } finally { ctx.memory.close(); }
});

// ------------------------------------------------------------ 光照：露天白天不插火把，读不到就不算暗
test('光照：露天白天读出 0 当作数据不可信；地下有顶的暗处才算暗；自动插火把不在露天触发', async () => {
  const { measureLight } = await import('../src/skills/light.ts');
  const w = new TestWorld();
  w.light = 0; // 模拟光照数据没下发：天光、方块光都读成 0
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  let m = measureLight(w, w.pos, 1000, true);
  assert.equal(m.sky, true); assert.equal(m.level, null);
  // 站在水里：脚那格是水，不拿来读
  w.setBlock({ x: 0, y: 64, z: 0 }, 'water');
  m = measureLight(w, w.pos, 1000, true);
  assert.equal(m.level, null);
  // 地下洞穴：头顶有石头
  const cave = new TestWorld();
  cave.pos = { x: 0.5, y: 50, z: 0.5 };
  cave.setBlock({ x: 0, y: 50, z: 0 }, 'air'); cave.setBlock({ x: 0, y: 51, z: 0 }, 'air');
  m = measureLight(cave, cave.pos, 1000, true);
  assert.equal(m.sky, false); assert.equal(m.level, 0);
  // 反射：露天白天光照读成 0 也不插
  const bus = new EventBus();
  const started: any[] = [];
  const arbiter: any = { paused: false, info: () => null, start: (step: any) => { started.push(step); return {}; }, cancel() {} };
  w.removed.clear(); w.blocks = []; w.inv.set('torch', 8);
  const habits = () => ({ torch_every: 8 });
  new Reflex(w, arbiter, bus, { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} }, { habits }).tick();
  assert.ok(!started.some((s) => s.skill === 'place_torch'), '露天不插');
  cave.inv.set('torch', 8);
  new Reflex(cave, arbiter, bus, { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} }, { habits }).tick();
  assert.ok(started.some((s) => s.skill === 'place_torch'), '地下暗处才插');
});

test('swim_path surface 给 LLM 用：不在水里时直接说明已在干地上；gather 的 for 写错不让整步作废', async () => {
  const { SKILLS, LLM_HIDDEN } = await import('../src/skills/index.ts');
  assert.ok(!LLM_HIDDEN.has('swim_path') && SKILLS.swim_path);
  const w = new TestWorld();
  const ctx = makeCtx(w);
  try {
    const r = await SKILLS.swim_path.run(ctx, { mode: 'surface' });
    assert.equal(r.status, 'succeeded'); assert.match(r.summary, /干地/);
    const v = gather.validate({ block: 'log', count: 3, for: { item: '小木屋木料' } }, w);
    assert.ok(v.ok);
    if (!v.ok) return;
    assert.equal(v.args.for, undefined); assert.equal(v.args.count, 3); assert.match(v.args.note ?? '', /已忽略/);
    w.setBlock({ x: 2, y: 64, z: 0 }, 'oak_log');
    const g = await gather.run(ctx, v.args);
    assert.match(g.summary, /已忽略/);
  } finally { ctx.memory.close(); }
});

// ------------------------------------------------------------ 第三轮：走着进水、自动做镐、沙滩避难、门材料
test('gather：走向目标时进了水 → 停止采集并说清，不自动换干燥目标', async () => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.setBlock({ x: 6, y: 64, z: 0 }, 'coal_ore'); // 看着干燥，实际要游过去
  w.setBlock({ x: 0, y: 64, z: 9 }, 'coal_ore');
  w.setBlock({ x: 4, y: 63, z: 0 }, 'water'); w.setBlock({ x: 4, y: 62, z: 0 }, 'water'); // 半路是两格深的水
  const move = w.moveTo.bind(w);
  w.moveTo = async (t: any, o: any) => { if (t.kind === 'reach_block' && t.pos.x === 6) { w.inWater = true; w.pos = { x: 4.5, y: 63, z: 0.5 }; return; } return move(t, o); };
  const ctx = makeCtx(w, { senses: { nearestLand: () => ({ dir: 'W', dist: 5, pos: { x: 1, y: 63, z: 0 } }) } });
  try {
    const r = await gather.run(ctx, { block: 'coal_ore', count: 1 });
    assert.equal(r.status, 'failed', r.summary);
    assert.match(r.summary, /进入水中，已停止采集/);
    assert.equal(w.blockAt({ x: 6, y: 64, z: 0 }), 'coal_ore', '没挖到要下水的');
    assert.equal(w.blockAt({ x: 0, y: 64, z: 9 }), 'coal_ore', '也不自动换去挖干燥的');
  } finally { ctx.memory.close(); }
});

test('gather：挖石头没镐子时，木料够也只是说清楚能显式做什么镐（不自动造）', async () => {
  const w = new TestWorld();
  w.canHarvest = () => (w.inv.get('wooden_pickaxe') ?? 0) > 0;
  w.setBlock({ x: -3, y: 64, z: -6 }, 'stone');
  const ctx = makeCtx(w);
  try {
    let r = await gather.run(ctx, { block: 'stone', count: 1 });
    assert.equal(r.failureCode, 'TOOL_MISSING');
    assert.match(r.summary, /手上没有能挖 stone 的镐子（需要 wooden_pickaxe 以上）/);
    w.inv.set('oak_log', 3);
    r = await gather.run(ctx, { block: 'stone', count: 1 });
    assert.equal(r.failureCode, 'TOOL_MISSING', '不自动造镐，由心智显式选择');
    assert.match(r.summary, /可先显式 craft wooden_pickaxe/);
    assert.ok(!w.actions.includes('craft:wooden_pickaxe'));
  } finally { ctx.memory.close(); }
});

test('shelter：沙滩上挖不了坑就走到附近的草地挖；周围都挖不了就用方块围起来', async () => {
  const { shelter } = await import('../src/skills/survival.ts');
  const beach = (r: number) => {
    const w = new TestWorld();
    w.pos = { x: 0.5, y: 64, z: 0.5 };
    for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) for (let y = 60; y <= 63; y++) w.setBlock({ x, y, z }, y === 60 ? 'gravel' : 'sand');
    w.inv.set('cobblestone', 16);
    return w;
  };
  let w = beach(2);
  let ctx = makeCtx(w);
  try {
    const r = await shelter.run(ctx, { until: 'day' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.match(r.summary, /原地挖不了，走到/);
  } finally { ctx.memory.close(); }
  w = beach(14);
  ctx = makeCtx(w);
  try {
    const r = await shelter.run(ctx, { until: 'day' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(r.data?.enclosure, true);
    for (const p of [{ x: 1, y: 64, z: 0 }, { x: -1, y: 65, z: 0 }, { x: 0, y: 66, z: 0 }]) assert.equal(w.blockAt(p), 'cobblestone');
  } finally { ctx.memory.close(); }
});

test('建筑 spec：门写成木料时换成同木种的门，认不出就用橡木门', async () => {
  const { normalizeSpec } = await import('../src/building/spec.ts');
  assert.equal(normalizeSpec({ palette: { door: 'spruce_planks' } }).palette.door, 'spruce_door');
  assert.equal(normalizeSpec({ palette: { door: 'dark_oak_log' } }).palette.door, 'dark_oak_door');
  assert.equal(normalizeSpec({ palette: { door: 'iron_door' } }).palette.door, 'oak_door');
});

test('dig：没有镐也能空手挖开石头（慢、不掉东西），但不自动造镐', async () => {
  const w = new TestWorld();
  w.canHarvest = () => (w.inv.get('wooden_pickaxe') ?? 0) > 0;
  // 像真的身体一样：没有对应的镐也挖得掉，只是什么都不掉
  const realDig = w.dig.bind(w);
  w.dig = async (pos: any, signal: AbortSignal) => {
    const hand = !w.canHarvest();
    const before = new Map(w.inv);
    const r = await realDig(pos, signal);
    if (hand && r.ok) { w.inv.clear(); for (const [k, v] of before) w.inv.set(k, v); return { ...r, noDrop: true, digMs: 7500 }; }
    return r;
  };
  const p = w.state().pos;
  const above = (n: number) => ({ x: Math.floor(p.x), y: Math.floor(p.y) + 2 + n, z: Math.floor(p.z) });
  w.setBlock(above(0), 'stone');
  const ctx = makeCtx(w);
  try {
    let r = await dig.run(ctx, { dir: 'up', blocks: 1 });
    assert.equal(r.status, 'succeeded', `没有镐、没有工作台：空手挖开（${r.summary}）`);
    assert.ok(!w.actions.includes('craft:wooden_pickaxe'), '就地动作不为了合成走开');
    assert.ok(!w.inv.get('cobblestone'), '空手挖不掉东西');
    w.setBlock(above(0), 'stone');
    w.inv.set('oak_log', 3);
    w.setBlock({ x: Math.floor(p.x) + 1, y: Math.floor(p.y), z: Math.floor(p.z) }, 'crafting_table');
    r = await dig.run(ctx, { dir: 'up', blocks: 1 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(!w.actions.includes('craft:wooden_pickaxe'), '不自动造镐，由心智显式选择');
  } finally { ctx.memory.close(); }
});

// ------------------------------------------------------------ 第四轮评审
test('shelter：站在水里不就地围墙', async () => {
  const { shelter } = await import('../src/skills/survival.ts');
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++) for (let y = 60; y <= 63; y++) w.setBlock({ x, y, z }, 'sand');
  w.inv.set('cobblestone', 16);
  w.setBlock({ x: 0, y: 64, z: 0 }, 'water'); // 脚下这格是浅水
  const ctx = makeCtx(w);
  try {
    const r = await shelter.run(ctx, { until: 'day' });
    assert.equal(r.status, 'failed'); assert.match(r.summary, /水里/);
    assert.ok(!w.actions.some((a) => a.startsWith('place:')));
  } finally { ctx.memory.close(); }
});

test('shelter：小间进水、岩浆或空气不足时如实停止，不替角色拆墙', async () => {
  const { shelter } = await import('../src/skills/survival.ts');
  for (const hazard of ['water', 'lava', 'oxygen'] as const) {
    const w = new TestWorld();
    w.pos = { x: 0.5, y: 64, z: 0.5 };
    for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++) for (let y = 60; y <= 63; y++) w.setBlock({ x, y, z }, 'sand');
    w.inv.set('cobblestone', 16);
    w.isDay = false;
    const state = w.state.bind(w);
    w.state = () => {
      const s = state();
      if (w.blockAt({ x: 0, y: 66, z: 0 }) !== 'cobblestone') return s;
      return { ...s, inWater: hazard === 'water', inLava: hazard === 'lava', oxygen: hazard === 'oxygen' ? 15 : 20 };
    };
    const ctx = makeCtx(w, { deadlineMs: 20000 });
    try {
      const r = await shelter.run(ctx, { until: 'day' });
      assert.equal(r.status, 'failed');
      assert.match(r.summary, hazard === 'water' ? /小间里进了水/ : hazard === 'lava' ? /小间里有岩浆/ : /氧气不足/);
      assert.doesNotMatch(r.summary, /拆开|出来了/);
      assert.equal(r.data?.placed, 9);
      assert.deepEqual(r.data?.position, w.pos);
      assert.equal(w.blockAt({ x: 1, y: 65, z: 0 }), 'cobblestone');
      assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'cobblestone');
      assert.ok(!w.actions.some((a) => a.startsWith('dig:')), `${hazard}: ${w.actions.join(',')}`);
    } finally { ctx.memory.close(); }
  }
});

test('place_torch：模型明确要插时白天露天也插；只有反射顺手插才跳过', async () => {
  const w = new TestWorld();
  w.inv.set('torch', 4);
  const ctx = makeCtx(w);
  try {
    let r = await placeTorch.run(ctx, { count: 1, auto: true });
    assert.match(r.summary, /露天/);
    assert.ok(!w.actions.some((a) => a === 'place:torch'));
    r = await placeTorch.run(ctx, placeTorch.validate({ count: 1 }, w).ok ? { count: 1 } : { count: 1 });
    assert.ok(w.actions.includes('place:torch'), r.summary);
  } finally { ctx.memory.close(); }
});

test('gather：蹚过一格深的小水洼不算“下了水”', async () => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: -20.5 };
  w.setBlock({ x: 3, y: 64, z: -20 }, 'coal_ore');
  w.setBlock({ x: 1, y: 64, z: -20 }, 'water'); // 一格深的水洼：脚泡水、头在外面
  const move = w.moveTo.bind(w);
  w.moveTo = async (t: any, o: any) => { if (t.kind === 'reach_block') { w.inWater = true; w.pos = { x: 1.5, y: 64, z: -19.5 }; await move(t, o); w.inWater = false; return; } return move(t, o); };
  const ctx = makeCtx(w);
  try {
    const r = await gather.run(ctx, { block: 'coal_ore', count: 1 });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(w.blockAt({ x: 3, y: 64, z: -20 }), 'air');
  } finally { ctx.memory.close(); }
});

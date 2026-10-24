import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reflex } from '../src/brain/reflex.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { placeTorch } from '../src/skills/light.ts';
import { findAirPocket, surface } from '../src/skills/movement.ts';
import { hunt } from '../src/skills/survival.ts';
import { eat, gather, gatherTargetRisk } from '../src/skills/work.ts';
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

// ------------------------------------------------------------ surface：头顶封住 / 开阔水面 / 水洞气穴
function submerged(feetY: number) {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 6;
  w.pos = { x: 0.5, y: feetY, z: 0.5 };
  return w;
}

test('surface：水下头顶是石头 → 先往上挖开，再上浮换气', async () => {
  const w = submerged(60);
  w.setBlock({ x: 0, y: 60, z: 0 }, 'water'); w.setBlock({ x: 0, y: 61, z: 0 }, 'water'); // y=62 默认是石头
  const ctx = makeCtx(w);
  try {
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    const dig = w.actions.indexOf('dig:stone'), swim = w.actions.findIndex((a) => a.startsWith('swim:'));
    assert.ok(dig >= 0 && swim > dig, w.actions.join(' '));
    assert.equal(w.blockAt({ x: 0, y: 62, z: 0 }), 'air');
  } finally { ctx.memory.close(); }
});

test('surface：开阔水面不挖东西，直接上浮', async () => {
  const w = submerged(64);
  w.setBlock({ x: 0, y: 64, z: 0 }, 'water');
  const ctx = makeCtx(w);
  try {
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(!w.actions.some((a) => a.startsWith('dig:')), w.actions.join(' '));
    assert.equal(w.actions[0], 'swim:up');
  } finally { ctx.memory.close(); }
});

test('surface：头顶挖不动时，沿连通的水道游向最近的气穴', async () => {
  const w = submerged(58);
  for (const p of [[0, 58, 0], [0, 59, 0], [1, 59, 0], [2, 59, 0], [3, 59, 0], [3, 60, 0]]) w.setBlock({ x: p[0], y: p[1], z: p[2] }, 'water');
  for (let y = 61; y <= 63; y++) w.setBlock({ x: 3, y, z: 0 }, 'air'); // 竖井通到地面
  w.dig = async () => ({ ok: false, reason: 'TOOL_MISSING' });
  const ctx = makeCtx(w);
  try {
    const pocket = findAirPocket(ctx);
    assert.deepEqual(pocket?.pos, { x: 3, y: 61, z: 0 });
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    assert.deepEqual(r.data?.pocket, { x: 3, y: 61, z: 0 });
  } finally { ctx.memory.close(); }
});

test('reflex：同一处 surface 失败过就换打法（找气穴/往上挖 → 寻路上岸）', () => {
  const w = submerged(58);
  const bus = new EventBus();
  const started: any[] = [];
  const arbiter: any = { paused: false, info: () => null, start: (step: any) => { started.push(step); return {}; }, cancel() {} };
  const reflex = new Reflex(w, arbiter, bus, { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} });
  assert.deepEqual(reflex.drowningStep(), { skill: 'surface' });
  bus.publish('task_end', 'P1', 'surface failed', { skill: 'surface', status: 'failed' });
  reflex.tick();
  assert.deepEqual(started.at(-1), { skill: 'surface', args: { escape: 'dig' } });
  bus.publish('task_end', 'P1', 'surface failed', { skill: 'surface', status: 'failed' });
  assert.deepEqual(reflex.drowningStep(), { skill: 'surface', args: { escape: 'shore' } });
  // 换个地方就重新按常规来
  w.pos = { x: 30.5, y: 58, z: 0.5 };
  assert.deepEqual(reflex.drowningStep(), { skill: 'surface' });
  bus.publish('task_end', 'P1', 'ok', { skill: 'surface', status: 'succeeded' });
  w.pos = { x: 0.5, y: 58, z: 0.5 };
  assert.deepEqual(reflex.drowningStep(), { skill: 'surface' });
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

test('surface：一次上浮里就升级打法——游两次没上岸、上浮也换不到气，就让寻路往岸上走（不等死了再换）', async () => {
  const w = submerged(60);
  w.oxygen = 10;
  for (let y = 60; y <= 70; y++) w.setBlock({ x: 0, y, z: 0 }, 'water');
  const swims: string[] = [];
  w.swimTo = async (target) => { swims.push(target ? 'shore' : 'up'); w.oxygen = Math.max(0, w.oxygen - 1); return { ok: false, landed: false, oxygen: w.oxygen }; };
  const moves: string[] = [];
  w.moveTo = async (t: any) => { moves.push(t.kind); w.inWater = false; w.oxygen = 20; };
  const ctx = makeCtx(w, { senses: { nearestLand: () => ({ dir: 'E', dist: 6, pos: { x: 6, y: 63, z: 0 } }) } });
  try {
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    assert.deepEqual(moves, ['near']);
    assert.deepEqual(swims, ['shore', 'shore', 'up'], '游两次 → 原地上浮一次 → 寻路上岸');
  } finally { ctx.memory.close(); }
});

test('surface：游进气穴后头在空气里就原地换气，不再找别的气穴游走', async () => {
  const w = submerged(58);
  for (const p of [[0, 58, 0], [0, 59, 0], [1, 59, 0], [2, 59, 0], [3, 59, 0], [3, 60, 0]]) w.setBlock({ x: p[0], y: p[1], z: p[2] }, 'water');
  w.setBlock({ x: 3, y: 61, z: 0 }, 'air');
  w.dig = async () => ({ ok: false, reason: 'TOOL_MISSING' });
  const swims: string[] = [];
  w.swimTo = async (target) => {
    swims.push(target ? `${target.x},${target.y},${target.z}` : 'up');
    if (target) w.pos = { x: target.x, y: target.y - 1.62, z: target.z };
    else w.oxygen = 20;
    return { ok: false, landed: false, oxygen: w.oxygen };
  };
  const ctx = makeCtx(w, { deadlineMs: 3000 });
  try {
    await surface.run(ctx, { escape: 'dig' });
    const last = swims.lastIndexOf('3.5,61,0.5');
    assert.ok(last >= 0, swims.join(' '));
    assert.equal(swims[last + 1], 'up', swims.join(' '));
  } finally { ctx.memory.close(); }
});

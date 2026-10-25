import assert from 'node:assert/strict';
import { test } from 'node:test';
import { facingOfYaw, localMap, toWorld } from '../src/perception/local.ts';
import { digAt, placeAt, stepTo } from '../src/skills/primitives.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

/** 地下 60 层挖出一个刚够站人的小空腔 */
function pocket() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 60, z: 0.5 };
  (w as any).removed.add('0,60,0'); (w as any).removed.add('0,61,0');
  return w;
}

test('局部坐标：[前,上,右] 按朝向换算；yaw 换成 N/E/S/W', () => {
  assert.deepEqual(toWorld({ x: 0, y: 60, z: 0 }, 'N', [1, 1, 0]), { x: 0, y: 61, z: -1 });
  assert.deepEqual(toWorld({ x: 0, y: 60, z: 0 }, 'E', [1, 0, 1]), { x: 1, y: 60, z: 1 });
  assert.equal(facingOfYaw(0), 'N');
  assert.equal(facingOfYaw(Math.PI), 'S');
  assert.equal(facingOfYaw(-Math.PI / 2), 'E');
  assert.equal(facingOfYaw(Math.PI / 2), 'W');
});

test('身边方块图不透视：只看得见和身体连通的空气格及贴着它们的方块', () => {
  const w = pocket();
  w.blocks.push({ name: 'gravel', pos: { x: 0, y: 61, z: -1 } });
  const m = localMap(w, w.pos, 'N');
  assert.equal(m.layers['u+1'][1][2], 'G', '前方头高那格是沙砾');
  assert.equal(m.legend.G, 'gravel');
  assert.equal(m.layers['u+0'][2][2], 'Y');
  assert.equal(m.layers['u+0'][0][2], '?', '隔着石头的格子看不见');
  assert.equal(m.layers['u+3'][2][2], '?');
});

test('LLM 自己组合原子动作：挖开头顶和前上方两格、迈上去，重复几轮就是一道回到地面的阶梯', async (t) => {
  const w = pocket();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const routine = [
    digAt.validate({ at: [0, 2, 0], facing: 'N' }, w),
    digAt.validate({ at: [1, 1, 0], facing: 'N' }, w),
    digAt.validate({ at: [1, 2, 0], facing: 'N' }, w),
    stepTo.validate({ to: [1, 1, 0], facing: 'N' }, w),
  ];
  for (const v of routine) assert.ok(v.ok, !v.ok ? v.error : '');
  for (let round = 0; round < 8 && w.pos.y < 64; round++) {
    for (const [i, v] of routine.entries()) {
      const skill = [digAt, digAt, digAt, stepTo][i] as any;
      const r = await skill.run(ctx, (v as any).args);
      assert.notEqual(r.status, 'failed', r.summary);
      assert.ok(r.data?.local, '每一步都带回新的身边方块图');
    }
  }
  assert.equal(w.pos.y, 64, '站到了地面上');
  assert.ok(w.pos.z < -3, '是一路往北上去的');
});

test('原子动作如实回报做不到的原因，不替模型做决定', async (t) => {
  const w = pocket();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const step = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(step.status, 'failed');
  assert.match(step.summary, /目标格是 stone/);
  w.blocks.push({ name: 'water', pos: { x: 0, y: 62, z: -1 } });
  const wet = await digAt.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(wet.status, 'failed');
  assert.match(wet.summary, /water/);
  assert.equal(digAt.validate({ at: [0, 1, 0] }, w).ok, false, '自己站的格子不用挖');
  assert.equal(stepTo.validate({ to: [2, 0, 0] }, w).ok, false, 'step 只走相邻一格');
});

test('原地垫高：头顶空了才跳得起来；背包没方块就说清楚', async (t) => {
  const w = pocket();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const none = await placeAt.run(ctx, { at: [0, 0, 0], facing: 'N', item: 'any' });
  assert.equal(none.failureCode, 'MISSING_MATERIALS');
  w.inv.set('cobblestone', 4);
  const blocked = await placeAt.run(ctx, { at: [0, 0, 0], facing: 'N', item: 'any' });
  assert.match(blocked.summary, /头顶上方是 stone/);
  await digAt.run(ctx, { at: [0, 2, 0], facing: 'N' });
  const up = await placeAt.run(ctx, { at: [0, 0, 0], facing: 'N', item: 'any' });
  assert.equal(up.status, 'succeeded', up.summary);
  assert.equal(Math.floor(w.pos.y), 61);
});

test('原子动作认模型常用的几种坐标写法：at / to / pos、字符串、{f,u,r}', () => {
  const w = pocket();
  for (const raw of [{ at: [1, 1, 0] }, { pos: [1, 1, 0] }, { offset: '1,1,0' }, { at: { f: 1, u: 1, r: 0 } }]) {
    const v = digAt.validate({ ...raw, facing: 'N' }, w);
    assert.ok(v.ok && (v.args as any).at.join() === '1,1,0', JSON.stringify(raw));
  }
  const s = stepTo.validate({ pos: [1, 1, 0], facing: 'N' }, w);
  assert.ok(s.ok, !s.ok ? s.error : '');
  const bad = digAt.validate({ where: 'front' }, w);
  assert.ok(!bad.ok && /"at":\[前,上,右\]/.test(bad.error));
});

test('step 能走下 1–3 格的小坎，也能踩上薄雪', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  (w as any).removed.add('0,63,-1'); (w as any).removed.add('0,62,-1');
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /走下了 2 格/);

  const w2 = new FakeAdapter();
  w2.pos = { x: 0.5, y: 64, z: 0.5 };
  (w2 as any).removed.add('0,63,-1');
  w2.blocks.push({ name: 'snow', pos: { x: 0, y: 63, z: -1 } });
  const ctx2 = makeCtx(w2);
  t.after(() => ctx2.memory.close());
  const r2 = await stepTo.run(ctx2, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r2.status, 'succeeded', r2.summary);
});

test('坐标直接写成 args 数组也认；往脚下挖多格会被告知重复 dig_at [0,-1,0]', async () => {
  const { normalizeStep } = await import('../src/planner/plan.ts');
  assert.deepEqual(normalizeStep({ skill: 'dig_at', args: [0, 2, 0] }), { skill: 'dig_at', args: { at: [0, 2, 0] } });
  assert.deepEqual(normalizeStep({ skill: 'place_at', args: [0, 3, 0, 'dirt'] }), { skill: 'place_at', args: { at: [0, 3, 0], item: 'dirt' } });
  const v = digAt.validate({ at: [0, -2, 0] }, new FakeAdapter());
  assert.ok(!v.ok && /重复 dig_at \[0,-1,0\]/.test(v.error));
});

test('自己在哪：坑底能认出几格深，树下认得出是地表', async () => {
  const { whereAmI } = await import('../src/perception/perception.ts');
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 62, z: 0.5 };
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { (w as any).removed.add(`${dx},63,${dz}`); (w as any).removed.add(`${dx},62,${dz}`); }
  const pit = whereAmI(w, { pos: w.pos }, { block: null, up: null, covered: 'open' });
  assert.equal(pit.kind, 'pit');
  assert.equal(pit.depth, 2);
  const flat = new FakeAdapter();
  const tree = whereAmI(flat, { pos: flat.pos }, { block: 'spruce_leaves', up: 4, covered: 'canopy' });
  assert.equal(tree.kind, 'surface');
  assert.match(tree.text, /树叶/);
});

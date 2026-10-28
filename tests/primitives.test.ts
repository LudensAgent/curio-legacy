import assert from 'node:assert/strict';
import { test } from 'node:test';
import { facingOfYaw, localMap, toWorld } from '../src/perception/local.ts';
import { digAt, placeAt, stepTo } from '../src/skills/primitives.ts';
import { dig } from '../src/skills/body.ts';
import { makeBridge } from '../src/codeskills/bridge.ts';
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
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => positions.flatMap((pos) => {
    const name = w.blockAt(pos);
    return name === null ? [] : [{ name, pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
      dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const }];
  }) } });
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
  assert.match(step.summary, /目标格是 未看清的格子/, 'physical obstruction does not identify an unobserved block');
  w.blocks.push({ name: 'water', pos: { x: 0, y: 62, z: -1 } });
  const wet = await digAt.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(wet.status, 'failed');
  assert.match(wet.summary, /water/);
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
  assert.match(blocked.summary, /头顶上方是 未看清的格子/);
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

test('step 保持指定高度，显式选择下一级才下行，也能踩上薄雪', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  (w as any).removed.add('0,63,-1');
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', w.moveTo.bind(w));
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.equal(move.mock.callCount(), 0, '无目标高度支撑时不向低处改选落点');
  (w as any).removed.add('0,62,-1');
  const deeper = await stepTo.run(ctx, { at: [1, -1, 0], facing: 'N' });
  assert.equal(deeper.failureCode, 'PATH_NOT_FOUND', '指定下一级也不能自动改成下两级');
  assert.equal(move.mock.callCount(), 0);
  (w as any).removed.delete('0,62,-1');
  const down = await stepTo.run(ctx, { at: [1, -1, 0], facing: 'N' });
  assert.equal(down.status, 'succeeded', down.summary);
  assert.equal(Math.floor(w.pos.y), 63);

  const w2 = new FakeAdapter();
  w2.pos = { x: 0.5, y: 64, z: 0.5 };
  (w2 as any).removed.add('0,63,-1');
  w2.blocks.push({ name: 'snow', pos: { x: 0, y: 63, z: -1 } });
  const ctx2 = makeCtx(w2);
  t.after(() => ctx2.memory.close());
  const r2 = await stepTo.run(ctx2, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r2.status, 'succeeded', r2.summary);
});

test('step 不把实际落到其他高度当作到达目标', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 0.5, y: 63, z: -0.5 }; });
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.match(r.summary, /实际在 \(0,63,-1\)/);
});

test('坐标直接写成 args 数组也认；往脚下挖多格会被告知重复 dig_at [0,-1,0]', async () => {
  const { normalizeStep } = await import('../src/planner/plan.ts');
  assert.deepEqual(normalizeStep({ skill: 'dig_at', args: [0, 2, 0] }), { skill: 'dig_at', args: { at: [0, 2, 0] } });
  assert.deepEqual(normalizeStep({ skill: 'place_at', args: [0, 3, 0, 'dirt'] }), { skill: 'place_at', args: { at: [0, 3, 0], item: 'dirt' } });
  const v = digAt.validate({ at: [0, -2, 0] }, new FakeAdapter());
  assert.ok(!v.ok && /重复 dig_at \[0,-1,0\]/.test(v.error));
});

test('自己在哪：站在自己盖的小屋里是“屋里”不是“坑里”，还说得出门在哪；贴着屋外墙不算屋里', async () => {
  const { whereAmI } = await import('../src/perception/perception.ts');
  // 5×5 小屋：墙 y=64..66，屋顶 y=67，门开在北墙中间（z=-2）
  const hut = () => {
    const w = new FakeAdapter();
    const cells = new Map<string, string>();
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
      cells.set(`${x},67,${z}`, 'oak_planks');
      if (Math.max(Math.abs(x), Math.abs(z)) === 2) for (let y = 64; y <= 66; y++) cells.set(`${x},${y},${z}`, 'oak_planks');
    }
    cells.set('0,64,-2', 'oak_door'); cells.set('0,65,-2', 'oak_door');
    for (const [k, name] of cells) { const [x, y, z] = k.split(',').map(Number); w.blocks.push({ name, pos: { x, y, z } }); }
    const ownBuilt = (pos: { x: number; y: number; z: number }, block: string) => cells.get(`${pos.x},${pos.y},${pos.z}`) === block ? { name: '白桦小舍' } : null;
    return { w, ownBuilt };
  };
  const { w, ownBuilt } = hut();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const inside = whereAmI(w, { pos: w.pos }, { block: 'oak_planks', up: 3, covered: 'roof' }, { ownBuilt });
  assert.equal(inside.kind, 'indoors');
  assert.equal(inside.building, '白桦小舍');
  assert.match(inside.text, /自己盖的「白桦小舍」屋里.*这不是坑.*门在 N 边 2 格/);
  // 别人的房子（不是自己盖的）：认得出是屋里，但不说是自己的
  const theirs = whereAmI(w, { pos: w.pos }, { block: 'oak_planks', up: 3, covered: 'roof' });
  assert.equal(theirs.kind, 'indoors');
  assert.doesNotMatch(theirs.text, /自己盖的/);
  // 屋外贴着南墙站：不是屋里
  const out = hut();
  out.w.pos = { x: 0.5, y: 64, z: 3.5 };
  const outside = whereAmI(out.w, { pos: out.w.pos }, { block: null, up: null, covered: 'open' }, { ownBuilt: out.ownBuilt });
  assert.notEqual(outside.kind, 'indoors');
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

test('dig_at 自己站的两格不算写错，说明一下就好', async (t) => {
  const w = new FakeAdapter();
  assert.ok(digAt.validate({ at: [0, 1, 0] }, w).ok);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await digAt.run(ctx, { at: [0, 1, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded');
  assert.match(r.summary, /\[0,2,0\]/);
});

test('dig_at 液体邻格默认不挖；wet:true 与 lava:true 分别授权进水和进岩浆', async (t) => {
  const w = pocket();
  // 前方那格（0,60,-1）是石头，它再往前一格（0,60,-2）是水
  w.blocks.push({ name: 'water', pos: { x: 0, y: 60, z: -2 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  let r = await digAt.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /\[2,0,0\] 是 water/);
  assert.match(r.summary, /wet/);
  r = await digAt.run(ctx, { at: [1, 0, 0], facing: 'N', wet: true });
  assert.equal(r.status, 'succeeded', r.summary);
  w.blocks.push({ name: 'lava', pos: { x: 0, y: 61, z: -2 } });
  r = await digAt.run(ctx, { at: [1, 1, 0], facing: 'N', wet: true });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /岩浆/);
  r = await digAt.run(ctx, { at: [1, 1, 0], facing: 'N', wet: true, lava: true });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(w.actions.includes('dig:stone'));
});

test('dig_at with a nearby table and materials does not create a tool by default', async (t) => {
  const adapter = new FakeAdapter();
  adapter.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } }, { name: 'crafting_table', pos: { x: 1, y: 64, z: 1 } });
  adapter.inv.set('oak_planks', 8); adapter.inv.set('stick', 4);
  adapter.canHarvest = () => !!adapter.inv.get('wooden_pickaxe');
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const result = await digAt.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(adapter.actions, ['dig:stone']);
  assert.equal(adapter.inv.get('wooden_pickaxe'), undefined);
});

test('explicit lava permission reaches dig validation and the code skill bridge', async (t) => {
  for (const mode of ['dig', 'bridge']) {
    const adapter = new FakeAdapter();
    adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 66, z: 0 } }, { name: 'lava', pos: { x: 1, y: 66, z: 0 } });
    const ctx = makeCtx(adapter);
    t.after(() => ctx.memory.close());
    if (mode === 'dig') {
      const blocked = dig.validate({ dir: 'up', blocks: 1 }, adapter);
      assert.ok(blocked.ok);
      assert.equal((await dig.run(ctx, blocked.args)).status, 'failed');
      const allowed = dig.validate({ dir: 'up', blocks: 1, lava: true }, adapter);
      assert.ok(allowed.ok);
      assert.equal((await dig.run(ctx, allowed.args)).status, 'succeeded');
    } else {
      const bridge = makeBridge(ctx);
      assert.equal((await bridge('digAt', [0, 66, 0]) as { ok: boolean }).ok, false);
      assert.equal((await bridge('digAt', [0, 66, 0, { lava: true }]) as { ok: boolean }).ok, true);
    }
    assert.deepEqual(adapter.actions, ['dig:stone']);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { facingOfYaw, localMap, toWorld } from '../src/perception/local.ts';
import { digAt, placeAt, primitiveSkills, stepTo } from '../src/skills/primitives.ts';
import { dig } from '../src/skills/body.ts';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

/** 地下 60 层挖出一个刚够站人的小空腔 */
function pocket() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 60, z: 0.5 };
  (w as any).removed.add('0,60,0'); (w as any).removed.add('0,61,0');
  return w;
}

/** These mechanics tests explicitly assume the requested target is visible. */
const visibleTargets = (w: FakeAdapter) => (positions: Vec3Like[]) => positions.flatMap((pos) => {
  const name = w.blockAt(pos);
  return name === null ? [] : [{ name, pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const }];
});

test('局部坐标：[前,上,右] 按朝向换算；yaw 换成 N/E/S/W', () => {
  assert.deepEqual(toWorld({ x: 0, y: 60, z: 0 }, 'N', [1, 1, 0]), { x: 0, y: 61, z: -1 });
  assert.deepEqual(toWorld({ x: 0, y: 60, z: 0 }, 'E', [1, 0, 1]), { x: 1, y: 60, z: 1 });
  assert.equal(facingOfYaw(0), 'N');
  assert.equal(facingOfYaw(Math.PI), 'S');
  assert.equal(facingOfYaw(-Math.PI / 2), 'E');
  assert.equal(facingOfYaw(Math.PI / 2), 'W');
});

test('身边方块图只显示当前观察，连通但未看见的格子仍是未知', () => {
  const w = pocket();
  w.blocks.push({ name: 'gravel', pos: { x: 0, y: 61, z: -1 } });
  const m = localMap(w, w.pos, 'N', (positions) => positions.filter((pos) => pos.x === 0 && pos.y === 61 && pos.z === -1)
    .map((pos) => ({ pos, name: 'gravel' })));
  assert.equal(m.layers['u+1'][3][4], 'G', '前方头高那格是沙砾');
  assert.equal(m.legend.G, 'gravel');
  assert.equal(m.source, 'current_vision');
  assert.equal(m.layers['u+0'][4][4], 'Y');
  assert.equal(m.layers['u+0'][2][4], '?', '隔着石头的格子看不见');
  assert.equal(m.layers['u+3'][4][4], '?');
  const fallback = localMap({ blockAt: () => { throw new Error('local map must not read hidden blocks'); } }, w.pos, 'N');
  assert.equal(fallback.layers['u+1'][3][4], '?', '缺少视觉后端也不能退回读取隐藏世界');
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
  ctx.senses.observeBlocks = visibleTargets(w);
  w.blocks.push({ name: 'water', pos: { x: 0, y: 62, z: -1 } });
  const wet = await digAt.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(wet.status, 'failed');
  assert.match(wet.summary, /water/);
  assert.equal(stepTo.validate({ to: [2, 0, 0] }, w).ok, false, 'step 只走相邻一格');
});

test('step 落点检查失败后，转头或视野变化不会自动重试同一动作', async (t) => {
  const w = pocket();
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const activity = createActivity({ what: '迈上台阶', why: '', kind: 'other', repeat: 1,
    steps: [{ skill: 'step', args: { at: [1, 1, 0], facing: 'N' } }] }, '', 'llm', w.state());
  const step = nextStep(activity)!;
  activity.stepStart = { pos: { ...w.state().pos }, view: '先前视野' };
  w.removed.add('0,60,-1');
  w.removed.add('0,61,-1');
  w.removed.add('0,62,-1');
  w.removed.add('0,63,-1');
  const result = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.match(result.summary, /目标格脚下 .*是 air/);
  assert.equal(result.data?.movementNotAttempted, true);
  const percept = { self: { around: '转头后的视野' }, nearby: { resources: [] } } as unknown as import('../src/perception/perception.ts').Percept;
  assert.equal(afterStep(activity, step, result, 100, w.state(), percept).kind, 'stuck');
  assert.ok(!activity.adaptations.some((item) => item.startsWith('retry:')));
});

test('原地垫高：头顶空了才跳得起来；背包没方块就说清楚', async (t) => {
  const w = pocket();
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const none = await placeAt.run(ctx, { at: [0, 0, 0], facing: 'N', item: 'any' });
  assert.equal(none.failureCode, 'MISSING_MATERIALS');
  w.inv.set('cobblestone', 4);
  const blocked = await placeAt.run(ctx, { at: [0, 0, 0], facing: 'N', item: 'any' });
  assert.match(blocked.summary, /头顶跳跃空间受阻/);
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
  // 薄雪是能踩的薄层，但一层雪顶面只有 0.125 高：平走 [1,0,0] 会把脚高从 64 降到 63.125，
  // 那不是“保持高度”的平走，必须显式下一级 [1,-1,0] 才能站上去。
  const flat = await stepTo.run(ctx2, { at: [1, 0, 0], facing: 'N' });
  assert.equal(flat.status, 'failed', flat.summary);
  assert.match(flat.summary, /支撑面在 y=63\.13/);
  const r2 = await stepTo.run(ctx2, { at: [1, -1, 0], facing: 'N' });
  assert.equal(r2.status, 'succeeded', r2.summary);
  assert.equal(Math.floor(w2.pos.y), 63);
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

test('站在半砖上：向下挖 [0,-1,0] 挖到脚下的半砖本身，不是它下面的空气', async (t) => {
  const w = new FakeAdapter();
  w.groundY = 62; // y63 是空气（半砖下面没有紧贴的方块），y62 是草方块：挖掉半砖后落 2 格，安全
  w.pos = { x: 0.5, y: 64.5, z: 0.5 }; // 脚在 64.5 = 站在 y64 的下半砖上
  w.blocks.push({ name: 'oak_slab', pos: { x: 0, y: 64, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await digAt.run(ctx, { at: [0, -1, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /oak_slab/);
  assert.ok(w.actions.includes('dig:oak_slab'), `真的挖到了脚下的半砖（实际动作 ${w.actions.join(',')}）`);
  assert.equal(w.blockAt({ x: 0, y: 64, z: 0 }), 'air', '半砖被挖掉，人才落得下去');
});

test('dig_at [0,-1,0] 脚下有安全落点时照挖支撑块', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 }; // 站在 y63 的草方块上，下面 y62 是石头（1 格落差，安全）
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await digAt.run(ctx, { at: [0, -1, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /grass_block/);
  assert.ok(w.actions.includes('dig:grass_block'));
});

test('dig_at [0,-1,0] 脚下支撑下面是深坑（落差超过 3 格）时拒绝，不拆自己的支撑', async (t) => {
  const w = new FakeAdapter();
  w.groundY = 63;
  w.pos = { x: 0.5, y: 64, z: 0.5 }; // 站在 y63 的草方块上
  w.removed.add('0,62,0'); w.removed.add('0,61,0'); w.removed.add('0,60,0'); w.removed.add('0,59,0'); // 下面掏空成深坑
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await digAt.run(ctx, { at: [0, -1, 0], facing: 'N' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /落差|掉血/);
  assert.ok(!w.actions.includes('dig:grass_block'), '没有挖掉脚下的支撑');
});

test('dig_at 液体邻格默认不挖；wet:true 与 lava:true 分别授权进水和进岩浆', async (t) => {
  const w = pocket();
  // 前方那格（0,60,-1）是石头，它再往前一格（0,60,-2）是水
  w.blocks.push({ name: 'water', pos: { x: 0, y: 60, z: -2 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
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
  const ctx = makeCtx(adapter, { senses: { observeBlocks: visibleTargets(adapter) } });
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
    const ctx = makeCtx(adapter, { senses: { observeBlocks: visibleTargets(adapter) } });
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

test('absolute dig_at keeps its world cell instead of re-interpreting it as a support dig', async (t) => {
  const w = new FakeAdapter();
  w.groundY = 63; // y63 是草方块，站在 y64 的下半砖上
  w.pos = { x: 0.5, y: 64.5, z: 0.5 };
  w.blocks.push({ name: 'oak_slab', pos: { x: 0, y: 64, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const dig = primitiveSkills.find((skill) => skill.name === 'dig_at')!;
  const parsed = dig.validate({ xyz: [0, 63, 0], facing: 'N' }, w);
  assert.ok(parsed.ok, !parsed.ok ? parsed.error : '');
  const r = await dig.run(ctx, parsed.args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(w.actions.includes('dig:grass_block'), `挖到绝对坐标 (0,63,0)（实际 ${w.actions.join(',')}）`);
  assert.ok(!w.actions.includes('dig:oak_slab'), '没有把绝对坐标重解释成挖脚下的半砖');
  assert.equal(w.blockAt({ x: 0, y: 64, z: 0 }), 'oak_slab', '脚下的半砖仍在');
});

test('place_at already holds the requested block: idempotent success without material', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'dirt', pos: { x: 0, y: 64, z: -1 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await placeAt.run(ctx, { at: [1, 0, 0], facing: 'N', item: 'dirt' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.noop, true);
  assert.equal(r.data?.placed, undefined, '没有虚报本次发生了放置');
  assert.deepEqual(w.actions, [], '没有真正放置');
});

test('place_at reports a wrong-material occupant instead of treating any solid as success', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 64, z: -1 } });
  w.inv.set('dirt', 1);
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const r = await placeAt.run(ctx, { at: [1, 0, 0], facing: 'N', item: 'dirt' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /已被 stone 占据/);
  assert.equal(w.inv.get('dirt'), 1, '没有消耗材料');
  assert.deepEqual(w.actions, [], '没有放置动作');
});

test('place_at does not treat an unobserved block as already satisfied', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'diamond_block', pos: { x: 0, y: 64, z: -1 } }); // 墙后，看不见
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } }); // 遮挡：什么都看不见
  t.after(() => ctx.memory.close());
  const r = await placeAt.run(ctx, { at: [1, 0, 0], facing: 'N', item: 'diamond_block' });
  assert.equal(r.status, 'failed', '未观察到的已占位格不能报幂等成功');
  assert.equal(r.data?.already, undefined, '不泄露未观察方块名');
  assert.equal(r.data?.placed, undefined);
});

test('place_at [0,0,0] on a half-slab still pillars instead of short-circuiting', async (t) => {
  const w = new FakeAdapter();
  w.groundY = 62;
  w.pos = { x: 0.5, y: 64.5, z: 0.5 }; // 站在 y64 的下半砖上
  w.blocks.push({ name: 'oak_slab', pos: { x: 0, y: 64, z: 0 } });
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w, { senses: { observeBlocks: visibleTargets(w) } });
  t.after(() => ctx.memory.close());
  const pillar = t.mock.method(w, 'pillarUp', async (names: string[]) => {
    w.inv.set(names[0], (w.inv.get(names[0]) ?? 1) - 1);
    w.pos = { ...w.pos, y: 65.5 };
    return { ok: true, y: 65 };
  });
  const r = await placeAt.run(ctx, { at: [0, 0, 0], facing: 'N', item: 'any' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(pillar.mock.callCount(), 1, '搭柱被调用，而非被幂等检查截断');
});

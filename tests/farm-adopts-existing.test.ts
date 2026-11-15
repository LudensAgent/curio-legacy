import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('farm 没有登记田时接管脚边空耕地，并按 size 扩建播种', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'farmland', pos: { x: 2, y: 63, z: 0 } }, { name: 'farmland', pos: { x: 2, y: 63, z: 1 } });
  w.inv.set('wheat_seeds', 4);
  w.inv.set('stone_hoe', 1);
  const ctx = makeCtx(w, { senses: { recognizedAt: (pos) => w.blockAt(pos) } });
  t.after(() => ctx.memory.close());
  const v = SKILLS.farm.validate({ crop: 'wheat', size: 4 }, w);
  assert.ok(v.ok);
  const r = await SKILLS.farm.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  const farms = ctx.memory.farms();
  assert.equal(farms.length, 1, '应把已有耕地登记成一块田');
  const cells = farms[0]!.cells.map((c) => `${c.x},${c.y},${c.z}`).sort();
  assert.ok(cells.includes('2,63,0') && cells.includes('2,63,1'), '接管的空耕地必须在田里');
  assert.equal(cells.length, 4, 'size 4 应在田边扩建到 4 格，而不是停在 2 格');
  assert.equal(w.inv.get('wheat_seeds'), 0, '四格都种上，种子消耗四粒');
  assert.equal(w.crops.size, 4);
  assert.match(r.summary, /农田 4 格/);
});

test('已有作物的耕地不算空耕地：不接管、不收割别人的作物', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push(
    { name: 'farmland', pos: { x: 2, y: 63, z: 0 } },
    { name: 'wheat', pos: { x: 2, y: 64, z: 0 } },
    { name: 'farmland', pos: { x: 2, y: 63, z: 1 } },
    { name: 'farmland', pos: { x: 2, y: 63, z: 2 } },
  );
  w.inv.set('wheat_seeds', 4);
  const ctx = makeCtx(w, { senses: { recognizedAt: (pos) => w.blockAt(pos) } });
  t.after(() => ctx.memory.close());
  const v = SKILLS.farm.validate({ crop: 'wheat', size: 4 }, w);
  assert.ok(v.ok);
  const r = await SKILLS.farm.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  const cells = ctx.memory.farms()[0]?.cells ?? [];
  assert.ok(cells.every((c) => !(c.x === 2 && c.z === 0)), '有作物的耕地不被接管');
  assert.ok(cells.some((c) => c.x === 2 && c.z === 1));
});

test('脚边没有耕地时仍按原来的开垦流程走（不凭空接管）', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('wheat_seeds', 2);
  w.inv.set('stone_hoe', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const v = SKILLS.farm.validate({ crop: 'wheat', size: 4 }, w);
  assert.ok(v.ok);
  const r = await SKILLS.farm.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  const cells = ctx.memory.farms()[0]?.cells ?? [];
  assert.ok(cells.length >= 2);
  assert.ok(cells.every((c) => w.blockAt(c) === 'farmland'), '开垦出的格子应已变成耕地');
});

test('已有田小于 size 时在田边扩建，不把 size 当成只在首次开田生效', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('wheat_seeds', 9);
  w.inv.set('stone_hoe', 1);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  ctx.memory.addFarm({ id: 'farm_test', dim: 'overworld', crop: 'wheat', cells: [{ x: 2, y: 63, z: 0 }], plantedAt: Date.now(), harvests: 0 });
  const r = await SKILLS.farm.run(ctx, { crop: 'wheat', size: 9 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(ctx.memory.farms()[0]!.cells.length, 9, '应从 1 格扩到 9 格');
  assert.match(r.summary, /农田 9 格/);
  assert.doesNotMatch(r.summary, /请求 9 格/);
});

test('没有可执行动作时回报农田规模、作物与干湿/水源事实，不笼统说“没成熟”', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 65, z: 0.5 };
  w.blocks.push({ name: 'farmland', pos: { x: 2, y: 64, z: 0 } }, { name: 'wheat', pos: { x: 2, y: 65, z: 0 } });
  w.blocks.push({ name: 'water', pos: { x: 5, y: 64, z: 0 } });
  w.blockProperties.set('2,64,0', { moisture: 0 });
  w.crops.set('2,65,0', { age: 0, crop: 'wheat' });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  ctx.memory.addFarm({ id: 'farm_test', dim: 'overworld', crop: 'wheat', cells: [{ x: 2, y: 64, z: 0 }], plantedAt: Date.now(), harvests: 0 });
  const r = await SKILLS.farm.run(ctx, { crop: 'wheat', size: 4 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /农田 1 格/);
  assert.match(r.summary, /作物 1/);
  assert.match(r.summary, /干 1/);
  assert.match(r.summary, /4 格内有水 1\/1/);
  assert.match(r.summary, /请求 4 格，实际 1 格/);
  assert.doesNotMatch(r.summary, /还没成熟/);
});

test('扩建没有锄头时回报请求/实际缺口与 NO_HOE，不假装扩建成功', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'farmland', pos: { x: 2, y: 63, z: 0 } });
  w.inv.set('wheat_seeds', 9);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  ctx.memory.addFarm({ id: 'farm_test', dim: 'overworld', crop: 'wheat', cells: [{ x: 2, y: 63, z: 0 }], plantedAt: Date.now(), harvests: 0 });
  const r = await SKILLS.farm.run(ctx, { crop: 'wheat', size: 4 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(ctx.memory.farms()[0]!.cells.length, 1, '没有锄头不能扩建');
  assert.match(r.summary, /请求 4 格，实际 1 格/);
  assert.match(r.summary, /NO_HOE/);
});

test('湿润的耕地不再报干燥/水源；其他非作物方块不冒充作物', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 65, z: 0.5 };
  w.blocks.push({ name: 'farmland', pos: { x: 2, y: 64, z: 0 } }, { name: 'torch', pos: { x: 2, y: 65, z: 0 } });
  w.blockProperties.set('2,64,0', { moisture: 7 });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  ctx.memory.addFarm({ id: 'farm_test', dim: 'overworld', crop: 'wheat', cells: [{ x: 2, y: 64, z: 0 }], plantedAt: Date.now(), harvests: 0 });
  const r = await SKILLS.farm.run(ctx, { crop: 'wheat', size: 4 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /其他方块 1/);
  assert.match(r.summary, /湿润 1/);
  assert.doesNotMatch(r.summary, /干 1/);
  assert.doesNotMatch(r.summary, /4 格内有水/);
});

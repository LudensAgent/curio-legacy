import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('farm 没有登记田时接管脚边已有耕地并播种，不另开新地', async (t) => {
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
  assert.deepEqual(farms[0]!.cells.map((c) => `${c.x},${c.y},${c.z}`).sort(), ['2,63,0', '2,63,1']);
  assert.equal(w.inv.get('wheat_seeds'), 2, '两格都种上，种子消耗两粒');
  assert.equal(w.crops.size, 2);
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

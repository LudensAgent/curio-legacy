import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileDesign, DESIGN_EXAMPLE } from '../src/building/design.ts';
import { compileBuilding, materialCost, normalizeSpec } from '../src/building/spec.ts';
import { planScaffolding } from '../src/building/scaffold.ts';
import { build } from '../src/skills/build.ts';
import { InstantBuildWorld, makeCtx } from './survival-helpers.ts';

const example = () => JSON.parse(DESIGN_EXAMPLE);

test('字符画设计编译成方块清单：地板、门（朝外、上半格自动）、窗、室内留空', () => {
  const d = compileDesign(example());
  assert.equal(d.width, 5); assert.equal(d.depth, 5); assert.equal(d.height, 3);
  const at = (x: number, y: number, z: number) => d.components.find((c) => c.pos.x === x && c.pos.y === y && c.pos.z === z);
  assert.equal(at(0, -1, 0)?.phase, 'foundation');
  assert.deepEqual(at(2, 0, 0)?.properties, { facing: 'north', half: 'lower', hinge: 'left', open: false });
  assert.equal(at(2, 1, 0)?.properties.half, 'upper', '门的上半格自动补上');
  assert.equal(at(1, 1, 0)?.name, 'glass');
  assert.equal(at(2, 0, 2)?.name, 'torch');
  assert.ok(d.clearances.some((p) => p.x === 1 && p.y === 0 && p.z === 1), '室内留空');
  assert.ok(d.clearances.some((p) => p.x === 2 && p.z === -1), '门前留出通道');
  assert.equal(at(2, 2, 2)?.phase, 'roof');
});

test('设计校验：未定义字符、会掉落的方块、没有门/门洞都说清楚', () => {
  const bad = example(); bad.layers[1][0] = 'PPXPP';
  assert.throws(() => compileDesign(bad), /没在 legend 里定义的字符「X」/);
  const sand = example(); sand.legend.C = 'sand';
  assert.throws(() => compileDesign(sand), /会掉落/);
  const closed = example(); closed.layers[1][0] = 'PPPPP'; closed.layers[2][0] = 'PPPPP';
  assert.throws(() => compileDesign(closed), /要能进出/);
});

test('模型自己的设计：选址、整地、施工、验收一路走通', async () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++) w.setBlock({ x, y: 63, z }, 'grass_block');
  const spec = normalizeSpec({ name: '我的小木屋', design: example() });
  assert.equal(spec.layout, 'custom');
  const bp = compileBuilding(spec);
  for (const [name, count] of Object.entries(materialCost([...bp.cells, ...planScaffolding(bp)]))) w.inv.set(name, count + 8);
  const ctx = makeCtx(w);
  try {
    const v = build.validate({ spec: { name: '我的小木屋', design: example() } }, w);
    if (!v.ok) throw new Error(v.error);
    const r = await build.run(ctx, v.args);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(w.actions.includes('place:oak_planks') && w.actions.includes('place:glass'));
  } finally { ctx.memory.close(); }
});

test('不给设计直接 build：要求自己设计，并给出字符画模板', () => {
  const v = build.validate({ blueprint: 'hut' }, new InstantBuildWorld());
  assert.equal(v.ok, false);
  assert.match((v as any).error, /自己设计.*design.*legend.*layers/);
});

test('设计提示：屋顶没盖住、外墙有洞、屋里没光都会指出来（不拦着盖）', () => {
  assert.deepEqual(compileDesign(example()).warnings, [], '示例设计是完整的');
  const open = example(); open.layers[3] = ['PPPPP', 'P...P', 'P...P', 'P...P', 'PPPPP'].map((r) => r.replace(/\./g, ' '));
  assert.match(compileDesign(open).warnings.join('；'), /屋顶有 9\/9 格没盖住/);
  const holey = example(); holey.layers[1][2] = ' .T.P';
  assert.match(compileDesign(holey).warnings.join('；'), /外墙在人站立的高度有 1 个空洞/);
  const dark = example(); dark.layers[1][2] = 'P...P';
  assert.match(compileDesign(dark).warnings.join('；'), /没有光源/);
});

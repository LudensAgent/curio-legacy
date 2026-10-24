import assert from 'node:assert/strict';
import { test } from 'node:test';
import { footprintBounds, surveyBuildSite } from '../src/building/site.ts';
import { compileBuilding, materialCost, normalizeSpec, rotatePosition } from '../src/building/spec.ts';
import { planScaffolding } from '../src/building/scaffold.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { build, buildingArchiveFor, stalledFailures, terrainProblem } from '../src/skills/build.ts';
import { rememberStation } from '../src/skills/stations.ts';
import { InstantBuildWorld, makeCtx } from './survival-helpers.ts';

const spec = normalizeSpec({});
const footprint = (origin: { x: number; y: number; z: number }, rotation: 0 | 90 | 180 | 270) => {
  const b = footprintBounds(spec), out: { x: number; z: number }[] = [];
  for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) out.push(rotatePosition({ x, y: 0, z }, origin, rotation));
  return out;
};
const pool = (w: InstantBuildWorld, r: number) => { for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) w.setBlock({ x, y: 63, z }, 'water'); };

test('选址：避开水塘，挑一块干燥平整的空地', () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  pool(w, 4);
  const memory = new WorldMemory(null);
  try {
    const s = surveyBuildSite(w, memory, spec, { radius: 24 });
    assert.ok(s.best, JSON.stringify(s.rejected));
    assert.equal(s.best!.origin.y, 64);
    for (const c of footprint(s.best!.origin, s.best!.rotation)) assert.notEqual(w.blockAt({ x: c.x, y: 63, z: c.z }), 'water');
    assert.ok(s.rejected.wet > 0);
    // 危险区域里的地块也不选
    memory.addHazard({ dim: 'overworld', pos: { x: s.best!.origin.x + 2, y: 64, z: s.best!.origin.z + 2 }, kind: 'drowning' });
    const again = surveyBuildSite(w, memory, spec, { radius: 24 });
    assert.ok(again.best && again.rejected.hazard > 0);
  } finally { memory.close(); }
});

test('build 不给 origin：附近都是水时 NOT_FOUND 并说明原因和方向', async () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  pool(w, 40);
  const ctx = makeCtx(w);
  try {
    const v = build.validate({ blueprint: 'hut' }, w);
    assert.ok(v.ok);
    if (!v.ok) return;
    const r = await build.run(ctx, v.args);
    assert.equal(r.failureCode, 'NOT_FOUND');
    assert.match(r.summary, /附近 24 格内没有够平（或整得平）又不挨水的 5×5 空地/);
    assert.ok(!w.actions.some((a) => a.startsWith('place:')));
  } finally { ctx.memory.close(); }
});

test('build 不自动接着盖地基有问题的工地，换块地另起', async () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  const archive = buildingArchiveFor(ctx.memory);
  try {
    const bad = archive.design({ worldId: w.worldId, dimension: 'overworld', origin: { x: 2, y: 64, z: 2 }, rotation: 0, spec, materials: materialCost(compileBuilding(spec).cells) });
    archive.inspect(bad.id, { at: Date.now(), complete: false, checked: 1, defects: [{ cellId: '0,-2,0', pos: { x: 2, y: 62, z: 2 }, kind: 'terrain', expected: '地基', actual: 'water' }], functions: {} });
    assert.match(terrainProblem(archive.get(bad.id)!) ?? '', /water/);
    const v = build.validate({ blueprint: 'hut' }, w);
    if (!v.ok) throw new Error(v.error);
    const r = await build.run(ctx, v.args);
    assert.notEqual(r.data?.projectId, bad.id);
    assert.match(r.summary, /不在那里接着盖，换了块地另起/);
    // 纯缺料的失败不算停滞；动了手却没进展的才算
    const id = String(r.data?.projectId);
    assert.equal(r.failureCode, 'MISSING_MATERIALS');
    assert.equal(stalledFailures(archive.get(id)!), 0);
    for (let i = 0; i < 3; i++) archive.noteAttempt(id, true);
    assert.equal(stalledFailures(archive.get(id)!), 3);
    archive.noteAttempt(id, null);
    assert.equal(stalledFailures(archive.get(id)!), 3);
    archive.noteAttempt(id, false);
    assert.equal(stalledFailures(archive.get(id)!), 0);
  } finally { ctx.memory.close(); }
});

test('占地里自己的工作台：先收进背包，盖完放回房子旁边', async () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  try {
    ctx.memory.setWorld(w.worldId);
    const origin = { x: 3, y: 64, z: 3 };
    const table = rotatePosition({ x: 2, y: 0, z: 2 }, origin, 0);
    w.setBlock(table, 'crafting_table');
    rememberStation(ctx, 'crafting_table', table);
    const bp = compileBuilding(spec);
    for (const [name, count] of Object.entries(materialCost([...bp.cells, ...planScaffolding(bp)]))) w.inv.set(name, count + 4);
    const v = build.validate({ blueprint: 'hut', origin, rotation: 0 }, w);
    if (!v.ok) throw new Error(v.error);
    const r = await build.run(ctx, v.args);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.match(r.summary, /crafting_table 先收进了背包，盖完放回了房子旁边/);
    assert.ok(w.blocks.some((b) => b.name === 'crafting_table'));
    assert.ok(ctx.memory.landmarks().some((l) => l.label === '我的工作台'));
  } finally { ctx.memory.close(); }
});

test('选址：扫描起点就在山体/地下的列不算地表', () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 }; // 地下：上方 10 格仍是石头
  const memory = new WorldMemory(null);
  try {
    const s = surveyBuildSite(w, memory, spec, { radius: 8 });
    assert.equal(s.best, null);
    assert.ok(s.rejected.unknown > 0);
  } finally { memory.close(); }
});

test('给了 origin 但那块地挨水：就近改址并说明；同 origin 的地基坏工地不续建', async () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  ctx.memory.setWorld(w.worldId);
  const archive = buildingArchiveFor(ctx.memory);
  try {
    const origin = { x: 3, y: 64, z: 3 };
    for (let x = 0; x <= 6; x++) for (let z = 0; z <= 6; z++) w.setBlock({ x, y: 63, z }, 'water');
    const bad = archive.design({ worldId: w.worldId, dimension: 'overworld', origin, rotation: 0, spec, materials: materialCost(compileBuilding(spec).cells) });
    archive.inspect(bad.id, { at: Date.now(), complete: false, checked: 1, defects: [{ cellId: 's', pos: origin, kind: 'terrain', expected: '地面', actual: 'air' }], functions: {} });
    const v = build.validate({ blueprint: 'hut', origin, rotation: 0 }, w);
    if (!v.ok) throw new Error(v.error);
    const r = await build.run(ctx, v.args);
    assert.notEqual(r.data?.projectId, bad.id);
    assert.match(r.summary, /原定位置不合适（挨着水/);
    const moved = r.data?.origin as { x: number; y: number; z: number };
    assert.ok(moved && (moved.x !== 3 || moved.z !== 3));
    for (const c of footprint(moved, r.data?.rotation as 0)) assert.notEqual(w.blockAt({ x: c.x, y: 63, z: c.z }), 'water');
  } finally { ctx.memory.close(); }
});

test('附近没有现成平地：挑整地量最少的坡地，铲平后照样盖成', async () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  // 四周是水，只有一块 9×12 的小岛；岛的东边一列高出两格（坡地）
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) {
    const island = x >= -3 && x <= 5 && z >= -6 && z <= 5;
    if (!island) w.setBlock({ x, y: 63, z }, 'water');
    else if (x >= 4) { w.setBlock({ x, y: 64, z }, 'dirt'); w.setBlock({ x, y: 65, z }, 'grass_block'); }
  }
  const ctx = makeCtx(w);
  try {
    const s = surveyBuildSite(w, ctx.memory, spec, { radius: 24 });
    assert.ok(s.best, JSON.stringify(s.rejected));
    assert.equal(s.best!.origin.y, 64);
    assert.ok(s.best!.cut > 0, JSON.stringify(s.best));
    const bp = compileBuilding(spec);
    for (const [name, count] of Object.entries(materialCost([...bp.cells, ...planScaffolding(bp)]))) w.inv.set(name, count + 8);
    const v = build.validate({ blueprint: 'hut' }, w);
    if (!v.ok) throw new Error(v.error);
    const r = await build.run(ctx, v.args);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.match(r.summary, /没有现成的平地.*铲掉约 \d+ 块/);
    assert.match(r.summary, /整地清掉了 .*(dirt|grass_block)/);
  } finally { ctx.memory.close(); }
});

test('选址：要填的坑深度不超过 maxFoundationDepth', async () => {
  const { checkSiteAt } = await import('../src/building/site.ts');
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.setBlock({ x: 5, y: 63, z: 5 }, 'air'); w.setBlock({ x: 5, y: 62, z: 5 }, 'air'); // 低两格的坑
  const memory = new WorldMemory(null);
  try {
    assert.equal(checkSiteAt(w, memory, { ...spec, maxFoundationDepth: 4 }, { x: 3, y: 64, z: 3 }, 0).ok, true);
    assert.equal(checkSiteAt(w, memory, { ...spec, maxFoundationDepth: 1 }, { x: 3, y: 64, z: 3 }, 0).ok, false);
  } finally { memory.close(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { parseMakeWay, planMakeWay } from '../src/skills/movement/make-way.ts';

const W = 'w', D = 'overworld';
function world() {
  const map = new VoxelMap(W, { validityWindowMs: 1e12 });
  let sequence = 0;
  const put = (x: number, y: number, z: number, name: string) => map.observe({
    // 后写的观测时间更晚：同一毫秒内同一格内容不同会被库判成观测矛盾（conflict）。
    worldId: W, dim: D, sessionId: 's', observedAt: Date.now() + sequence, sequence: ++sequence, source: 'vision', evidence: 'seen',
    stateComplete: true, state: { name, properties: {} }, pos: { x, y, z },
  });
  return { map, put };
}
/** 一条 z=0 的通道：x 从 0 到 len，地面 y=63，身体两格 y=64..65，两侧与头顶是石头。 */
function corridor(len: number) {
  const w = world();
  for (let x = -1; x <= len; x++) {
    w.put(x, 63, 0, 'stone');
    for (const y of [64, 65]) w.put(x, y, 0, x === -1 ? 'stone' : 'air');
    w.put(x, 66, 0, 'stone');
    for (const z of [-1, 1]) for (const y of [63, 64, 65, 66]) w.put(x, y, z, 'stone');
  }
  return w;
}
const any = () => true;

test('正前方是已知的墙：允许挖时规划挖开脚、头两格穿过；不允许挖时没有路线', async () => {
  const w = corridor(8);
  for (const y of [64, 65]) w.put(4, y, 0, 'stone');
  const dig = await planMakeWay(w.map, D, { x: 0, y: 64, z: 0 }, { x: 8.5, y: 64, z: 0.5 }, { dig: {}, maxEdits: 16 }, any);
  assert.ok(dig !== null);
  const dug = dig.flatMap((step) => step.dig);
  assert.deepEqual(dug.map((c) => `${c.x},${c.y},${c.z}`).sort(), ['4,64,0', '4,65,0'], JSON.stringify(dig));
  assert.equal(dig.at(-1)!.to.x >= 7, true);
  assert.equal(await planMakeWay(w.map, D, { x: 0, y: 64, z: 0 }, { x: 8.5, y: 64, z: 0.5 }, { maxEdits: 16 }, any), null);
});

test('前方一格缺口：允许放置时补一块支撑走过去', async () => {
  const w = corridor(8);
  w.put(4, 63, 0, 'air');
  for (let y = 55; y <= 62; y++) w.put(4, y, 0, 'air');
  const plan = await planMakeWay(w.map, D, { x: 0, y: 64, z: 0 }, { x: 8.5, y: 64, z: 0.5 }, { place: { item: 'cobblestone' }, maxEdits: 16 }, any);
  assert.ok(plan !== null);
  assert.deepEqual(plan.filter((s) => s.place).map((s) => s.place), [{ x: 4, y: 63, z: 0 }]);
});

test('困在 1×1 深两格的坑里：允许放置时原地垫高一次，再迈上一级出去', async () => {
  const w = world();
  // 地面 y=63，坑底 y=61（脚在 y=62），四周坑壁 y=61..63 是泥土，上方开阔。
  for (let x = -2; x <= 4; x++) for (let z = -2; z <= 2; z++) {
    w.put(x, 63, z, x === 0 && z === 0 ? 'air' : 'dirt');
    for (const y of [64, 65, 66]) w.put(x, y, z, 'air');
  }
  w.put(0, 61, 0, 'dirt'); w.put(0, 62, 0, 'air');
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) w.put(x, 62, z, 'dirt');
  const plan = await planMakeWay(w.map, D, { x: 0, y: 62, z: 0 }, { x: 3.5, y: 64, z: 0.5 }, { place: { item: 'cobblestone' }, maxEdits: 16 }, any);
  assert.ok(plan !== null);
  assert.equal(plan.filter((s) => s.kind === 'pillar').length, 1, JSON.stringify(plan));
  assert.equal(plan[0]!.kind, 'pillar');
  assert.equal(plan.at(-1)!.to.y, 64);
});

test('紧挨液体的墙不挖；已知可绕行时不挖', async () => {
  const w = corridor(8);
  for (const y of [64, 65]) w.put(4, y, 0, 'stone');
  w.put(4, 64, 1, 'lava');
  const plan = await planMakeWay(w.map, D, { x: 0, y: 64, z: 0 }, { x: 8.5, y: 64, z: 0.5 }, { dig: {}, maxEdits: 16 }, any);
  const nearLava = (c: { x: number; y: number; z: number }) => Math.abs(c.x - 4) + Math.abs(c.y - 64) + Math.abs(c.z - 1) <= 1;
  assert.ok(plan === null || plan.flatMap((s) => s.dig).every((c) => !nearLava(c)), `不挖紧挨岩浆的格：${JSON.stringify(plan)}`);
  const open = corridor(8);
  assert.equal(await planMakeWay(open.map, D, { x: 0, y: 64, z: 0 }, { x: 8.5, y: 64, z: 0.5 }, { dig: {}, maxEdits: 16 }, any), null, '普通路线就能走，不需要开路');
});

test('parseMakeWay：只有写了 dig/place 才授权；参数非法时拒绝', () => {
  assert.deepEqual(parseMakeWay({}), { ok: true, value: undefined });
  assert.deepEqual(parseMakeWay({ dig: true }), { ok: true, value: { dig: {}, maxEdits: 16 } });
  assert.deepEqual(parseMakeWay({ dig: 'iron_pickaxe', place: 'cobblestone', maxEdits: 8 }), { ok: true, value: { dig: { tool: 'iron_pickaxe' }, place: { item: 'cobblestone' }, maxEdits: 8 } });
  assert.equal(parseMakeWay({ place: '' }).ok, false);
  assert.equal(parseMakeWay({ maxEdits: 4 }).ok, false);
  assert.equal(parseMakeWay({ dig: true, maxEdits: 99 }).ok, false);
});

test('坑底长着树苗：同时授权 dig 时先打掉树苗再垫高；只授权 place 时不在这格垫高', async () => {
  const w = world();
  for (let x = -2; x <= 4; x++) for (let z = -2; z <= 2; z++) {
    w.put(x, 63, z, x === 0 && z === 0 ? 'air' : 'dirt');
    for (const y of [64, 65, 66]) w.put(x, y, z, 'air');
  }
  w.put(0, 61, 0, 'dirt'); w.put(0, 62, 0, 'birch_sapling');
  // 坑壁是挖不动的黑曜石：只能原地垫高出去。
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) for (const y of [62, 63]) w.put(x, y, z, 'obsidian');
  const both = await planMakeWay(w.map, D, { x: 0, y: 62, z: 0 }, { x: 3.5, y: 64, z: 0.5 }, { dig: {}, place: { item: 'cobblestone' }, maxEdits: 16 }, any);
  assert.ok(both !== null);
  assert.equal(both[0]!.kind, 'pillar');
  assert.deepEqual(both[0]!.dig[0], { x: 0, y: 62, z: 0 }, '先打掉脚格里的树苗');
  const placeOnly = await planMakeWay(w.map, D, { x: 0, y: 62, z: 0 }, { x: 3.5, y: 64, z: 0.5 }, { place: { item: 'cobblestone' }, maxEdits: 16 }, any);
  assert.ok(placeOnly === null || placeOnly.every((s) => !(s.kind === 'pillar' && s.to.y === 63 && s.to.x === 0 && s.to.z === 0)), '树苗占着的格放不进方块');
});

test('桥头：前方是缺口、缺口上方一格有方块（高出两格）——授权 place 时原地垫高一格再迈上去；只授权 dig 时没有路线', async () => {
  const w = world();
  // 桥：z=0 的 x=0..3，桥面 y=68（脚在 69）；x=4 一列 y=68、69 空，y=70 是下界岩（站上去脚在 71）；四周下方是空的。
  for (let x = -1; x <= 6; x++) for (let z = -1; z <= 1; z++) for (let y = 60; y <= 74; y++) {
    const bridge = z === 0 && x >= 0 && x <= 3 && y === 68;
    const ledge = x >= 4 && y === 70;
    w.put(x, y, z, bridge || ledge ? 'netherrack' : 'air');
  }
  const target = { x: 6.5, y: 71, z: 0.5 };
  const placed = await planMakeWay(w.map, D, { x: 3, y: 69, z: 0 }, target, { place: { item: 'netherrack' }, maxEdits: 16 }, any);
  assert.ok(placed !== null);
  assert.equal(placed[0]!.kind, 'pillar', JSON.stringify(placed));
  assert.deepEqual(placed[1]!.to, { x: 4, y: 71, z: 0 }, '垫高后迈上缺口上方那块');
  assert.equal(await planMakeWay(w.map, D, { x: 3, y: 69, z: 0 }, target, { dig: {}, maxEdits: 16 }, any), null, '只能挖时上不去');
});

test('往看不见的岩体里挖：授权 dig 时路线穿过墙后未知格，第一步只挖已看见的墙面；没授权 dig 不进未知', async () => {
  const w = world();
  // 通道 x=0..3（脚 y=64），x=4 的墙面看见了，x>=5 全是未知。
  for (let x = -1; x <= 3; x++) {
    w.put(x, 63, 0, 'netherrack');
    for (const y of [64, 65]) w.put(x, y, 0, x === -1 ? 'netherrack' : 'air');
    w.put(x, 66, 0, 'netherrack');
    for (const z of [-1, 1]) for (const y of [63, 64, 65, 66]) w.put(x, y, z, 'netherrack');
  }
  for (const y of [64, 65]) w.put(4, y, 0, 'netherrack');
  const plan = await planMakeWay(w.map, D, { x: 0, y: 64, z: 0 }, { x: 12.5, y: 64, z: 0.5 }, { dig: {}, maxEdits: 16 }, any);
  assert.ok(plan !== null, '应规划出穿进岩体的路线');
  const firstEdit = plan.find((s) => s.dig.length > 0)!;
  assert.deepEqual(firstEdit.dig.map((c) => `${c.x},${c.y}`).sort(), ['4,64', '4,65'], '第一处只挖已看见的墙面');
  assert.ok(plan.at(-1)!.to.x >= 8, `路线延伸进未知岩体：${JSON.stringify(plan.at(-1))}`);
  assert.equal(await planMakeWay(w.map, D, { x: 0, y: 64, z: 0 }, { x: 12.5, y: 64, z: 0.5 }, { place: { item: 'netherrack' }, maxEdits: 16 }, any), null);
});

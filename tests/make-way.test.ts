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

test('授权 dig 时火/灵魂火可以打掉再走；没授权时火仍然是拒绝格', async () => {
  const w = corridor(8);
  for (const y of [64, 65]) { w.put(4, y, 0, 'fire'); w.put(5, y, 0, 'soul_fire'); }
  const start = { x: 0, y: 64, z: 0 }, target = { x: 8.5, y: 64, z: 0.5 };
  const dig = await planMakeWay(w.map, D, start, target, { dig: {}, maxEdits: 16 }, any);
  assert.ok(dig !== null);
  const dug = dig.flatMap((step) => step.dig).map((c) => `${c.x},${c.y},${c.z}`).sort();
  assert.deepEqual(dug, ['4,64,0', '4,65,0', '5,64,0', '5,65,0'], JSON.stringify(dig));
  assert.equal(dig.at(-1)!.to.x >= 7, true);
  assert.equal(await planMakeWay(w.map, D, start, target, { maxEdits: 16 }, any), null, '没授权 dig 时不规划穿火');
});

test('父任务取消或期限已到时，开路规划不再继续搜索', async () => {
  const w = corridor(8);
  for (const y of [64, 65]) w.put(4, y, 0, 'stone');
  const start = { x: 0, y: 64, z: 0 }, target = { x: 8.5, y: 64, z: 0.5 };
  assert.ok(await planMakeWay(w.map, D, start, target, { dig: {}, maxEdits: 16 }, any) !== null);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await planMakeWay(w.map, D, start, target, { dig: {}, maxEdits: 16 }, any, { signal: aborted.signal }), null, '取消后不再搜索');
  assert.equal(await planMakeWay(w.map, D, start, target, { dig: {}, maxEdits: 16 }, any, { deadlineMs: Date.now() - 1 }), null, '期限已过不再搜索');
});

test('开路只规划 move_step 能执行的一格落差；两格下落交回 Agent 选下行方式', async () => {
  const w = world();
  // x=0 脚高 64（地面 63）；x=1 是两格深的下落（地面 61，脚高 62）；x=2 是必须挖开的墙。
  for (const x of [0, 1, 2, 3, 4]) for (const z of [-1, 1]) for (const y of [61, 62, 63, 64, 65, 66]) w.put(x, y, z, 'stone');
  for (const x of [0, 2, 3, 4]) w.put(x, 66, 0, 'stone');
  w.put(0, 63, 0, 'stone'); for (const y of [64, 65]) w.put(0, y, 0, 'air');
  w.put(1, 61, 0, 'stone'); for (const y of [62, 63, 64, 65]) w.put(1, y, 0, 'air');
  for (const y of [62, 63, 64, 65]) w.put(2, y, 0, 'stone');
  for (const x of [3, 4]) { w.put(x, 61, 0, 'stone'); for (const y of [62, 63, 64, 65]) w.put(x, y, 0, 'air'); }
  const plan = await planMakeWay(w.map, D, { x: 0, y: 64, z: 0 }, { x: 4.5, y: 62, z: 0.5 }, { dig: {}, maxEdits: 16 }, (cell) => cell.z === 0);
  assert.equal(plan, null, '不能把两格下落规划成 move_step 再在执行时被拒');
});

test('开路仍可规划一格下落，并用 move_step 迈下', async () => {
  const w = world();
  // x=0 脚高 64；x=1 脚高 63（一格下落）；x=2 是必须挖开的墙；目标 x=4 脚高 63。
  for (const x of [0, 1, 2, 3, 4]) for (const z of [-1, 1]) for (const y of [61, 62, 63, 64, 65, 66]) w.put(x, y, z, 'stone');
  for (const x of [0, 1, 2, 3, 4]) w.put(x, 66, 0, 'stone');
  w.put(0, 63, 0, 'stone'); for (const y of [64, 65]) w.put(0, y, 0, 'air');
  w.put(1, 62, 0, 'stone'); for (const y of [63, 64, 65]) w.put(1, y, 0, 'air');
  w.put(2, 62, 0, 'stone'); for (const y of [63, 64, 65]) w.put(2, y, 0, 'stone');
  for (const x of [3, 4]) { w.put(x, 62, 0, 'stone'); for (const y of [63, 64, 65]) w.put(x, y, 0, 'air'); }
  const plan = await planMakeWay(w.map, D, { x: 0, y: 64, z: 0 }, { x: 4.5, y: 63, z: 0.5 }, { dig: {}, maxEdits: 16 }, (cell) => cell.z === 0);
  assert.ok(plan !== null, '一格下落仍应能规划');
  assert.equal(plan[0]!.kind, 'move');
  assert.deepEqual(plan[0]!.to, { x: 1, y: 63, z: 0 }, JSON.stringify(plan));
  assert.ok(plan.some((step) => step.dig.length > 0), '后续仍能规划挖开挡路的墙');
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

test('岩浆湖边：开路不规划落点旁边是岩浆的站位（move_step 会拒绝），改走不邻岩浆的格', async () => {
  const w = world();
  // 3 格宽的岩石地面 z=-1..1，x=0..8；z=-2 一排是岩浆（湖边）。x=4 整排是墙，z=0/1 的墙另外加厚到 x=5：
  // 只看挖的格数，挖紧挨岩浆的 z=-1 最省；但那里落点旁边是岩浆，move_step 会拒绝。
  for (let x = -1; x <= 9; x++) for (let z = -2; z <= 2; z++) {
    w.put(x, 63, z, z === -2 ? 'lava' : 'netherrack');
    for (const y of [64, 65]) w.put(x, y, z, z === -2 ? 'lava' : z === 2 || x === -1 ? 'netherrack' : 'air');
    w.put(x, 66, z, 'netherrack');
  }
  for (const z of [-1, 0, 1]) for (const y of [64, 65]) w.put(4, y, z, 'netherrack');
  for (const z of [0, 1]) for (const y of [64, 65]) w.put(5, y, z, 'netherrack');
  // 墙格本身旁边不是岩浆（可以挖），但墙两侧 z=-1 的落脚点紧挨岩浆。
  for (const y of [63, 64, 65]) w.put(4, y, -2, 'netherrack');
  const plan = await planMakeWay(w.map, D, { x: 0, y: 64, z: 1 }, { x: 8.5, y: 64, z: 0.5 }, { dig: {}, maxEdits: 16 }, any);
  assert.ok(plan !== null);
  const nearLava = (c: { x: number; z: number }) => c.z === -1;
  assert.ok(plan.every((s) => !nearLava(s.to)), `不站紧挨岩浆的 z=-1 一排：${JSON.stringify(plan.map((s) => s.to))}`);
});

test('岩浆湖：授权 place 时在湖面上逐格补支撑搭桥过去；只授权 dig 时过不去', async () => {
  const w = world();
  // 岸 x=0..1，湖 x=2..6（y=63 是岩浆面），对岸 x=7..9；脚高 y=64。
  for (let x = -1; x <= 9; x++) for (let z = -2; z <= 2; z++) {
    const lake = x >= 2 && x <= 6;
    w.put(x, 63, z, lake ? 'lava' : 'netherrack');
    w.put(x, 62, z, lake ? 'lava' : 'netherrack');
    for (const y of [64, 65, 66]) w.put(x, y, z, 'air');
  }
  const target = { x: 8.5, y: 64, z: 0.5 };
  const plan = await planMakeWay(w.map, D, { x: 1, y: 64, z: 0 }, target, { place: { item: 'netherrack' }, maxEdits: 16 }, any);
  assert.ok(plan !== null);
  assert.deepEqual(plan.filter((s) => s.place).map((s) => s.place!.x), [2, 3, 4, 5, 6], '湖面每格补一块');
  // 只授权 dig：可以从湖两侧看不见的岩体里挖过去，但绝不站到岩浆上方。
  const digOnly = await planMakeWay(w.map, D, { x: 1, y: 64, z: 0 }, target, { dig: {}, maxEdits: 16 }, any);
  assert.ok(digOnly === null || digOnly.every((s) => !(s.to.x >= 2 && s.to.x <= 6 && Math.abs(s.to.z) <= 2)), JSON.stringify(digOnly?.map((s) => s.to)));
});

test('普通路线失败后，搜索到一条不改方块、只走过去的更近路线也要返回', async () => {
  const w = corridor(8);
  const plan = await planMakeWay(w.map, D, { x: 0, y: 64, z: 0 }, { x: 8.5, y: 64, z: 0.5 }, { dig: {}, place: { item: 'cobblestone' }, maxEdits: 16, allowPlainRoute: true }, any);
  assert.ok(plan !== null, '只走过去的路线不能因为“没有挖/放”被丢掉');
  assert.ok(plan.every((step) => step.dig.length === 0 && step.place === undefined && step.kind !== 'pillar'));
  assert.ok(plan.at(-1)!.to.x >= 7, `应当真的走近目标，实际 ${JSON.stringify(plan.at(-1))}`);
});

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

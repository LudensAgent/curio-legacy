import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vision } from '../src/perception/vision.ts';
import { explore, resetSearches } from '../src/skills/movement.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

/** 走到哪就把沿途区块记成去过（像真实游玩时 perception 做的那样） */
class Walker extends TestWorld {
  biomeName = 'plains';
  visits: ((pos: { x: number; y: number; z: number }) => void) | null = null;
  override state() { return { ...super.state(), biome: this.biomeName }; }
  override async moveTo(t: any, o: any) {
    const from = { ...this.pos };
    await super.moveTo(t, o);
    const steps = Math.ceil(Math.hypot(this.pos.x - from.x, this.pos.z - from.z) / 8);
    for (let i = 1; i <= steps; i++) this.visits?.({ x: from.x + (this.pos.x - from.x) * i / steps, y: 64, z: from.z + (this.pos.z - from.z) * i / steps });
  }
}

function world() {
  resetSearches();
  const w = new Walker();
  const ctx = makeCtx(w, { deadlineMs: 120_000 });
  ctx.memory.setWorld(w.worldId);
  w.visits = (pos) => ctx.memory.visit('overworld', pos);
  ctx.memory.visit('overworld', w.pos);
  return { w, ctx };
}

test('找同一样东西：越找不到走得越远，并在结果里报告这趟搜寻的进展', async (t) => {
  const { w, ctx } = world(); t.after(() => ctx.memory.close());
  let r = await explore.run(ctx, { direction: 'E', distance: 48, until: 'log' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /为找 log 这趟已经走了 \d+ 格/);
  const x1 = w.pos.x;
  r = await explore.run(ctx, { direction: 'E', distance: 48, until: 'oak_log|birch_log' });
  assert.ok(w.pos.x - x1 >= 90, `第二趟应走得更远：${w.pos.x - x1}`);
  assert.match(r.summary, /这趟已经走了 1\d\d 格/, '同一种东西（各种木头）算同一趟搜寻');
});

test('掉头走回已经搜过的路线时，改往离它最近、还没去过的方向', async (t) => {
  const { w, ctx } = world(); t.after(() => ctx.memory.close());
  await explore.run(ctx, { direction: 'E', distance: 64, until: 'log' });
  const r = await explore.run(ctx, { direction: 'W', distance: 48, until: 'log' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /W 方向这一路大多已经走过（没看到 log），改往 (NW|SW|N|S)/);
  assert.ok(Math.abs(w.pos.z) > 40, `应偏离走过的那条东西向路线，去新的地方：${JSON.stringify(w.pos)}`);
});

test('auto 时认准上一趟的大方向，不来回折返', async (t) => {
  const { w, ctx } = world(); t.after(() => ctx.memory.close());
  await explore.run(ctx, { direction: 'N', distance: 48, until: 'log' });
  const z1 = w.pos.z;
  await explore.run(ctx, { direction: 'AUTO', distance: 48, until: 'log' });
  assert.ok(w.pos.z < z1 - 40, `应继续往北（-Z）：${z1} → ${w.pos.z}`);
});

test('沙漠里找木头：直接走远，并提示一直朝一个方向走到沙漠边缘', async (t) => {
  const { w, ctx } = world(); t.after(() => ctx.memory.close());
  w.biomeName = 'desert';
  const r = await explore.run(ctx, { direction: 'S', distance: 48, until: 'log' });
  assert.ok(w.pos.z >= 150, `沙漠里一趟就走远：${w.pos.z}`);
  assert.match(r.summary, /desert 里几乎没有树：沿同一方向一直走到群系边缘/);
});

test('找到目标后这趟搜寻结束，下次重新开始计算', async (t) => {
  const { w, ctx } = world(); t.after(() => ctx.memory.close());
  const vision = new Vision(w);
  ctx.senses.observeBlocks = vision.observeBlocks.bind(vision);
  await explore.run(ctx, { direction: 'E', distance: 48, until: 'log' });
  w.setBlock({ x: Math.floor(w.pos.x) + 3, y: 64, z: Math.floor(w.pos.z) }, 'oak_log');
  const found = await explore.run(ctx, { direction: 'E', distance: 48, until: 'log' });
  assert.match(found.summary, /不用走远/);
  w.setBlock({ x: Math.floor(w.pos.x) + 3, y: 64, z: Math.floor(w.pos.z) }, 'air');
  const r = await explore.run(ctx, { direction: 'N', distance: 48, until: 'log' });
  assert.match(r.summary, /这趟已经走了 \d{2} 格/, '新的一趟从头计');
});

test('死亡复活/传送后不接着算上一趟搜寻', async (t) => {
  const { w, ctx } = world(); t.after(() => ctx.memory.close());
  await explore.run(ctx, { direction: 'E', distance: 48, until: 'log' });
  w.pos = { x: -300, y: 64, z: 300 }; // 复活到很远的地方
  const r = await explore.run(ctx, { direction: 'N', distance: 48, until: 'log' });
  assert.match(r.summary, /这趟已经走了 \d{2} 格，离开始找的地方 \d{2} 格/, `应从新位置重新计：${r.summary}`);
});

test('眼前一片水：改往旁边的陆路走，而不是下水', async (t) => {
  const { w, ctx } = world(); t.after(() => ctx.memory.close());
  for (let x = 10; x <= 70; x++) for (let z = -6; z <= 6; z++) w.setBlock({ x, y: 63, z }, 'water');
  const r = await explore.run(ctx, { direction: 'E', distance: 48 });
  assert.match(r.summary, /E 方向眼前是一片水，改往 (NE|SE|N|S) 走陆路/);
});

test('决策里有身边八个方向去过多少的粗略地图', async () => {
  const { exploredAround } = await import('../src/planner/prompt.ts');
  const { WorldMemory } = await import('../src/memory/store.ts');
  const m = new WorldMemory(null); m.setWorld('w');
  try {
    for (let x = 0; x <= 140; x += 8) m.visit('overworld', { x, y: 64, z: 0 });
    const map = exploredAround(m, 'overworld', [0, 64, 0]);
    assert.equal(map.E, '大多去过');
    assert.equal(map.W, '没去过');
  } finally { m.close(); }
});

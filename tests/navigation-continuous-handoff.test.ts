import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import { voxelNavigationFixture } from './voxel-navigation-fixture.ts';

/** 记录每次 feet 派发是否要求停稳；只有原目的地需要完整刹停。 */
function recordHandoffs(adapter: ReturnType<typeof voxelNavigationFixture>['adapter']) {
  const handoffs: { x: number; y: number; z: number; settle: boolean; passColumn: boolean }[] = [];
  const move = adapter.moveTo.bind(adapter);
  Object.assign(adapter, { settleMovement: async () => {} });
  adapter.moveTo = async (target: MoveTarget, opts: MoveOpts) => {
    if (target.kind === 'feet') handoffs.push({ x: target.x, y: target.y, z: target.z, settle: opts.settleAtTarget !== false, passColumn: opts.passColumn === true });
    return move(target, opts);
  };
  return handoffs;
}

function observe(map: ReturnType<typeof voxelNavigationFixture>['map'], adapter: ReturnType<typeof voxelNavigationFixture>['adapter'],
  cells: { x: number; y: number; z: number; name: string }[]) {
  let sequence = 50_000;
  for (const { x, y, z, name } of cells) map.observe({
    worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId, observedAt: Date.now(), sequence: ++sequence,
    source: 'vision', evidence: 'seen', stateComplete: true, state: { name: `minecraft:${name}`, properties: {} }, pos: { x, y, z },
  });
}

test('开阔地斜向目标走斜线，中间点不停车，只有终点停稳', async (t) => {
  const { adapter, map, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  // 把 3 格宽的走廊扩成 8×8 平地。
  observe(map, adapter, Array.from({ length: 10 }, (_, x) => x - 1).flatMap((x) => Array.from({ length: 10 }, (_, z) => z - 1)
    .flatMap((z) => [63, 64, 65].map((y) => ({ x, y, z, name: y === 63 ? 'stone' : 'air' })))));
  const handoffs = recordHandoffs(adapter);
  const r = await navigateTo.run(ctx, { to: { x: 5, y: 64, z: 5 }, allowed: ['walk'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(handoffs.length, 5, '五步斜线，不走 10 步锯齿');
  assert.ok(handoffs.every((step, index) => index === 0 || step.x - handoffs[index - 1]!.x === 1 && step.z - handoffs[index - 1]!.z === 1));
  assert.deepEqual(handoffs.map((step) => step.settle), [false, false, false, false, true]);
  assert.deepEqual([Math.floor(adapter.pos.x), Math.floor(adapter.pos.z)], [5, 5]);
});

test('转弯与一格下落都不停车：转弯进入脚位窗即转向，直行与下落按格列交接', async (t) => {
  // 走廊只到 x=3；x=4..8 是此前没观察过的低一格地面，形成一格落差。
  const { adapter, map, ctx } = voxelNavigationFixture(3);
  t.after(() => ctx.memory.close());
  observe(map, adapter, Array.from({ length: 5 }, (_, i) => i + 4).flatMap((x) => [-1, 0, 1].flatMap((z) => [62, 63, 64, 65]
    .map((y) => ({ x, y, z, name: y === 62 ? 'stone' : 'air' })))));
  const handoffs = recordHandoffs(adapter);
  const r = await navigateTo.run(ctx, { to: { x: 7, y: 63, z: 1 }, allowed: ['walk', 'drop'], historical: false, maxSteps: 16, allowUnknownCorridor: false });
  assert.equal(r.status, 'succeeded', r.summary);
  const drop = handoffs.findIndex((step) => step.y === 63);
  assert.ok(drop > 0, '路线包含一格下落');
  assert.equal(handoffs[drop]!.settle, false, '一格下落不停车');
  assert.equal(handoffs[drop]!.passColumn, true, '下落按落进目标格列交接');
  const headings = handoffs.slice(1).map((step, index) => `${Math.sign(step.x - handoffs[index]!.x)},${Math.sign(step.z - handoffs[index]!.z)}`);
  assert.ok(new Set(headings).size > 1, `路线有转向：${headings.join(' ')}`);
  assert.ok(handoffs.slice(0, -1).every((step) => !step.settle), '只有原目的地停稳');
  assert.equal(handoffs.at(-1)!.settle, true);
  assert.deepEqual([Math.floor(adapter.pos.x), adapter.pos.y, Math.floor(adapter.pos.z)], [7, 63, 1]);
});

test('身体没按计划落位但站在地上：从实测位置重新规划一次后继续到达', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  const move = adapter.moveTo.bind(adapter);
  let failed = false;
  adapter.moveTo = async (target: MoveTarget, opts: MoveOpts) => {
    if (!failed && target.kind === 'feet' && Math.floor(target.x) === 3) {
      failed = true;
      adapter.pos = { x: 2.8, y: 64, z: 0.5 };
      throw new Error('TIMEOUT: 连续脚位没有在期限内站稳');
    }
    return move(target, opts);
  };
  const r = await navigateTo.run(ctx, { to: { x: 6, y: 64, z: 0 }, allowed: ['walk'], historical: false, maxSteps: 16, maxSegments: 4, allowUnknownCorridor: false });
  assert.equal(failed, true);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.replanCount, 1);
  assert.equal(Math.floor(adapter.pos.x), 6);
});

test('同一站位再次执行偏差时如实停下，不无限重试', async (t) => {
  const { adapter, ctx } = voxelNavigationFixture(8);
  t.after(() => ctx.memory.close());
  const move = adapter.moveTo.bind(adapter);
  let attempts = 0;
  adapter.moveTo = async (target: MoveTarget, opts: MoveOpts) => {
    if (target.kind === 'feet' && Math.floor(target.x) === 3) {
      attempts += 1;
      adapter.pos = { x: 2.8, y: 64, z: 0.5 };
      throw new Error('TIMEOUT: 连续脚位没有在期限内站稳');
    }
    return move(target, opts);
  };
  const r = await navigateTo.run(ctx, { to: { x: 6, y: 64, z: 0 }, allowed: ['walk'], historical: false, maxSteps: 16, maxSegments: 8, allowUnknownCorridor: false });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(attempts, 2, '偏差后只重新规划一次');
  assert.match(r.summary, /同一站位已重新规划过一次/);
});

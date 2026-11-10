import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTarget } from '../src/skills/movement/index.ts';
import { cellGoal, feetGoal, goalOf, goalReached, stanceFor, targetKindOf } from '../src/skills/movement/goal.ts';
import { findStation } from '../src/skills/stations.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const DIM = 'overworld';
const STATION = { x: 4, y: 64, z: 0 };

test('目标语义：整数 x/z 是格目标，分数 x/z 是精确连续脚位；完成谓词不同', () => {
  assert.equal(targetKindOf({ x: 3, y: 64, z: -2 }), 'cell');
  assert.equal(targetKindOf({ x: 3.5, y: 64, z: -2.5 }), 'feet');

  const cell = goalOf({ x: 3, y: 64, z: -2 });
  assert.equal(cell.kind, 'cell');
  const stance = stanceFor(cell, { x: 0.1, y: 64, z: -2.7 });
  assert.ok(Math.abs(stance.x - 3.1) <= 1e-12 && stance.y === 64 && Math.abs(stance.z + 1.7) <= 1e-12,
    `格目标落到起点同一格内偏移：${JSON.stringify(stance)}`);
  assert.equal(goalReached(cell, { x: 3.8, y: 64, z: -1.2 }, true), true, '脚仍在该格 + 脚高在容差内即满足格目标');
  assert.equal(goalReached(cell, { x: 4.1, y: 64, z: -1.2 }, true), false, '离开目标格不算到达');
  assert.equal(goalReached(cell, { x: 3.8, y: 64.03, z: -1.2 }, true), false, 'cell 目标保留 0.01 脚高容差，0.03 不算到达');
  assert.equal(goalReached(cell, { x: 3.8, y: 64.005, z: -1.2 }, true), true, 'cell 目标在 0.01 内仍可到达');
  assert.equal(goalReached(cell, { x: 3.8, y: 64, z: -1.2 }, false), false, '悬空不算到达');

  const feet = feetGoal({ x: 3.1, y: 64, z: -1.7 });
  assert.equal(goalReached(feet, { x: 3.8, y: 64, z: -1.2 }, true), false, '同一格内但离开精确脚位不算到达');
  assert.equal(goalReached(feet, { x: 3.16, y: 64.03, z: -1.66 }, true), true, '声明精度内视为到达');
  assert.equal(goalReached(feet, { x: 3.1, y: 64, z: -1.7 }, false), false, '悬空不算到达');

  const candidate = cellGoal({ x: 3, z: -2 }, 63.5, { x: 3, y: 63.5, z: -2 });
  assert.equal(candidate.kind === 'cell' ? candidate.footY : null, 63.5, '候选语义可显式给出真实脚高');
});

const observationAt = (adapter: FakeAdapter, pos: { x: number; y: number; z: number }, name: string) => ({
  pos, name, properties: {}, worldId: adapter.worldId, sessionId: adapter.sessionId,
  dimension: DIM, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
});

test('resolve_target 的工作站名只查记忆，不观察也不遗忘', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  ctx.memory.setWorld(adapter.worldId);
  ctx.memory.addLandmark('discovery', '我的工作台', DIM, STATION);
  let knownCalls = 0, observeCalls = 0;
  ctx.senses.knownBlocks = () => { knownCalls++; return [{ name: 'crafting_table', pos: STATION, dist: 4 }]; };
  // 现场看到的是 air：旧实现会把它当作“工作台没了”，删除记忆地标。
  ctx.senses.observeBlocks = () => { observeCalls++; return [observationAt(adapter, STATION, 'air')]; };

  const r = await resolveTarget.run(ctx, { target: 'crafting_table' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'station');
  assert.deepEqual(r.data?.target, STATION);
  assert.match(r.summary, /记得的/);
  assert.equal(knownCalls, 0, 'read-only 路径不得调用 senses.knownBlocks');
  assert.equal(observeCalls, 0, 'read-only 路径不得调用 senses.observeBlocks');
  assert.equal(ctx.memory.landmarks().length, 1, 'read-only 路径不得删除记忆地标');
});

test('findStation 默认行为不变：仍观察并遗忘已确认不存在的地标', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  ctx.memory.setWorld(adapter.worldId);
  ctx.memory.addLandmark('discovery', '我的工作台', DIM, STATION);
  ctx.senses.knownBlocks = () => [];
  ctx.senses.observeBlocks = () => [observationAt(adapter, STATION, 'air')];

  assert.equal(findStation(ctx, ['crafting_table'], 160), null);
  assert.equal(ctx.memory.landmarks().length, 0);
});

test('resolve_target 在 validate 阶段拒绝缺少有限 x/y/z 或 x/z 的对象', () => {
  const adapter = new FakeAdapter();
  for (const target of [{ x: 1 }, { x: 1, z: 2, y: Number.NaN }, { x: 1, y: 2, z: Number.POSITIVE_INFINITY }, { x: '1', y: 2, z: 3 }, [1, 2, 3]]) {
    const v = resolveTarget.validate({ target }, adapter);
    assert.equal(v.ok, false, `应拒绝 ${JSON.stringify(target)}`);
  }
  const horizontal = resolveTarget.validate({ target: { x: 1, z: 2 } }, adapter);
  assert.equal(horizontal.ok, true);
  const full = resolveTarget.validate({ target: { x: 1, y: 63, z: 2 } }, adapter);
  assert.equal(full.ok, true);
});

test('resolve_target 保留合法的 x,z-only 对象行为', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const horizontal = await resolveTarget.run(ctx, { target: { x: 1, z: 2 } as { x: number; y: number; z: number } });
  assert.equal(horizontal.status, 'succeeded', horizontal.summary);
  assert.deepEqual(horizontal.data?.target, { x: 1, y: 64, z: 2 });
  assert.equal(horizontal.data?.horizontalOnly, true);

  const full = await resolveTarget.run(ctx, { target: { x: 1, y: 63, z: 2 } });
  assert.deepEqual(full.data?.target, { x: 1, y: 63, z: 2 });
  assert.equal(full.data?.horizontalOnly, undefined);
});

test('resolve_target 的说明如实写清工作站只查记忆，不观察不遗忘', () => {
  assert.match(resolveTarget.description, /工作站名只查记忆/);
  assert.match(resolveTarget.description, /不现场观察也不删除过时地标/);
  assert.match(resolveTarget.argsDoc, /工作站名来自记忆，不观察、不遗忘/);
});

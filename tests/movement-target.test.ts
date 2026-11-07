import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTarget } from '../src/skills/movement/index.ts';
import { findStation } from '../src/skills/stations.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const DIM = 'overworld';
const STATION = { x: 4, y: 64, z: 0 };

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

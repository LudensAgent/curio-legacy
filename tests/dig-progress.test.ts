import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { dig } from '../src/skills/body.ts';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const require = createRequire(import.meta.url);

test('downward digging reports excavated blocks but fails if the body did not reach the next cell', async (t) => {
  const world = new TestWorld();
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  t.mock.method(world, 'dig', async (pos) => { world.setBlock(pos, 'air'); return { ok: true }; });
  t.mock.method(world, 'moveTo', async () => { world.pos = { x: 1.2, y: 63.6, z: 0 }; throw new Error('No path'); });
  const result = await dig.run(ctx, { dir: 'down', blocks: 3 });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.deepEqual(result.data?.dug, ['grass_block']);
  assert.equal(result.data?.walked, 0);
  assert.deepEqual(result.data?.targetCell, { x: 0, y: 63, z: 0 });
  assert.deepEqual(result.data?.position, { x: 1.2, y: 63.6, z: 0 });
  assert.equal((result.data?.effectEvidence as { changed: boolean }).changed, true);
  assert.match(result.summary, /挖掉 1 格，确认到达下一级 0 次/);
});

test('downward digging preserves earlier excavation and descent when the next block cannot be dug', async (t) => {
  const world = new TestWorld();
  world.setBlock({ x: 0, y: 62, z: 0 }, 'bedrock');
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  t.mock.method(world, 'dig', async (pos) => { world.setBlock(pos, 'air'); return { ok: true }; });
  t.mock.method(world, 'moveTo', async () => { world.pos = { x: 0, y: 63, z: 0 }; });
  const result = await dig.run(ctx, { dir: 'down', blocks: 3 });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'BAD_ARGS');
  assert.deepEqual(result.data?.dug, ['grass_block']);
  assert.equal(result.data?.walked, 1);
  assert.match(result.summary, /确认到达下一级 1 次.*基岩/);
});

test('a partial downward dig reports its real stopping point and repeated stops return control to the mind', async (t) => {
  const world = new TestWorld();
  world.setBlock({ x: 0, y: 61, z: 0 }, 'air');
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  t.mock.method(world, 'dig', async (pos) => { world.setBlock(pos, 'air'); return { ok: true }; });
  t.mock.method(world, 'moveTo', async () => { world.pos = { x: 0, y: 63, z: 0 }; });
  const result = await dig.run(ctx, { dir: 'down', blocks: 6 });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.data?.partialStop, { pos: { x: 0, y: 62, z: 0 }, below: 'air', completed: 1, requested: 6 });
  assert.match(result.summary, /确认到达下一级 1 次/);
  const a = createActivity({ what: '下矿', why: '', kind: 'explore', repeat: 6, steps: [{ skill: 'goto', args: { target: '0,64,0' } }, { skill: 'dig', args: { dir: 'down', blocks: 6 } }] }, '', 'llm', world.state());
  for (let i = 0; i < 3; i++) {
    const go = nextStep(a)!;
    assert.equal(afterStep(a, go, { status: 'succeeded', summary: '到了入口' }, 10, world.state()).kind, 'continue');
    const step = nextStep(a)!;
    const verdict = afterStep(a, step, result, 10, world.state());
    assert.equal(verdict.kind, i === 2 ? 'stuck' : 'continue');
    if (verdict.kind === 'stuck') assert.match(verdict.why, /连续 3 轮.*同一处/);
  }
});

test('partial downward digs at new locations do not count as the same repeated stop', () => {
  const world = new TestWorld();
  const a = createActivity({ what: '下矿', why: '', kind: 'explore', repeat: 4, steps: [{ skill: 'dig', args: { dir: 'down', blocks: 6 } }] }, '', 'llm', world.state());
  for (let i = 0; i < 4; i++) {
    const result = { status: 'succeeded' as const, summary: '部分完成', data: { partialStop: { pos: { x: 0, y: 62 - i, z: 0 }, below: 'air', completed: 1, requested: 6 } } };
    assert.notEqual(afterStep(a, nextStep(a)!, result, 10, world.state()).kind, 'stuck');
  }
});

test('directional dig cannot report progress when the installed Pathfinder resolves an empty path', async (t) => {
  const world = new TestWorld();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  const bot = new EventEmitter() as EventEmitter & { pathfinder: { setGoal(goal: unknown): void } };
  bot.pathfinder = { setGoal(goal) { bot.emit('goal_updated', goal); bot.emit('path_update', { status: 'noPath', path: [] }); } };
  const goto = require('mineflayer-pathfinder/lib/goto');
  t.mock.method(world, 'moveTo', async () => { await goto(bot, {}); });
  const result = await dig.run(ctx, { dir: 'E', blocks: 6 });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.equal(result.data?.walked, 0);
  assert.deepEqual(result.data?.dug, []);
  assert.equal((result.data?.effectEvidence as { changed: boolean }).changed, false);
  assert.deepEqual(result.data?.targetCell, { x: 1, y: 64, z: 0 });
  assert.deepEqual(result.data?.position, { x: 0.5, y: 64, z: 0.5 });
  assert.match(result.summary, /没有进入目标格/);
});

test('directional dig reports actual excavation and completed steps when a later step cannot be entered', async (t) => {
  const world = new TestWorld();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  world.setBlock({ x: 2, y: 65, z: 0 }, 'stone');
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  t.mock.method(world, 'dig', async (pos) => { world.setBlock(pos, 'air'); return { ok: true }; });
  let calls = 0;
  t.mock.method(world, 'moveTo', async () => { if (++calls === 1) world.pos = { x: 1.5, y: 64, z: 0.5 }; });
  const result = await dig.run(ctx, { dir: 'E', blocks: 3 });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.equal(result.data?.walked, 1);
  assert.deepEqual(result.data?.dug, ['stone']);
  assert.equal((result.data?.effectEvidence as { changed: boolean }).changed, true);
  assert.deepEqual(result.data?.targetCell, { x: 2, y: 64, z: 0 });
  assert.deepEqual(result.data?.position, { x: 1.5, y: 64, z: 0.5 });
  assert.equal(calls, 2);
  assert.match(result.summary, /前进 1 格.*挖了 stone.*没有进入目标格/);
});

test('the code skill bridge preserves a failed movement and its actual progress', async (t) => {
  const world = new TestWorld();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  t.mock.method(world, 'moveTo', async () => {});
  const result = await makeBridge(ctx)('act', ['dig', { dir: 'E', blocks: 2 }]) as { ok: boolean; code: string; data: { walked: number; targetCell: unknown } };
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PATH_NOT_FOUND');
  assert.equal(result.data.walked, 0);
  assert.deepEqual(result.data.targetCell, { x: 1, y: 64, z: 0 });
});

test('a digging failure after actual progress retains the dug blocks and verified walking', async (t) => {
  const world = new TestWorld();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  world.setBlock({ x: 1, y: 65, z: 0 }, 'stone');
  world.setBlock({ x: 2, y: 65, z: 0 }, 'bedrock');
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  t.mock.method(world, 'dig', async (pos) => { world.setBlock(pos, 'air'); return { ok: true }; });
  t.mock.method(world, 'moveTo', async () => { world.pos = { x: 1.5, y: 64, z: 0.5 }; });
  const result = await dig.run(ctx, { dir: 'E', blocks: 2 });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'BAD_ARGS');
  assert.equal(result.data?.walked, 1);
  assert.deepEqual(result.data?.dug, ['stone']);
  assert.match(result.summary, /前进 1 格.*挖了 stone.*基岩/);
});

test('actual arrival is counted even when the pathfinder reports an error after reaching the cell', async (t) => {
  const world = new TestWorld();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  t.mock.method(world, 'moveTo', async () => { world.pos = { x: 1.5, y: 64, z: 0.5 }; throw new Error('No path'); });
  const result = await dig.run(ctx, { dir: 'E', blocks: 1 });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data?.walked, 1);
});

test('a cancelled movement is not treated as a successful or failed completed dig', async (t) => {
  const world = new TestWorld();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  t.mock.method(world, 'moveTo', async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortedError' }); });
  await assert.rejects(dig.run(ctx, { dir: 'E', blocks: 1 }), { name: 'AbortedError' });
});

test('step skill preserves the effects of a partially failed dig', async (t) => {
  const world = new TestWorld();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  world.setBlock({ x: 1, y: 65, z: 0 }, 'stone');
  const ctx = makeCtx(world);
  t.after(() => { setBehaviorRegistry(null); ctx.memory.close(); });
  t.mock.method(world, 'dig', async (pos) => { world.setBlock(pos, 'air'); return { ok: true }; });
  t.mock.method(world, 'moveTo', async () => {});
  const definition = { name: 'partial-dig', description: 'dig', steps: [{ skill: 'dig', args: { dir: 'E', blocks: 1 } }] };
  setBehaviorRegistry({ get: () => definition, list: () => [definition] });
  const result = await useSkill.run(ctx, { name: definition.name });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.data?.dug, ['stone']);
  assert.equal(result.data?.walked, 0);
  assert.equal((result.data?.effectEvidence as { verified: boolean; changed: boolean }).verified, true);
  assert.equal((result.data?.effectEvidence as { changed: boolean }).changed, true);
});

test('code skill ignoring a partial dig failure still recognizes its real effects', async (t) => {
  const world = new TestWorld();
  world.pos = { x: 0.5, y: 64, z: 0.5 };
  world.setBlock({ x: 1, y: 65, z: 0 }, 'stone');
  const ctx = makeCtx(world);
  t.after(() => { setBehaviorRegistry(null); ctx.memory.close(); });
  t.mock.method(world, 'dig', async (pos) => { world.setBlock(pos, 'air'); return { ok: true }; });
  t.mock.method(world, 'moveTo', async () => {});
  const definition = { name: 'partial-dig-code', description: 'dig', steps: [], code: "await api.act('dig', { dir: 'E', blocks: 1 }); return 'done';" };
  setBehaviorRegistry({ get: () => definition, list: () => [definition] });
  const result = await useSkill.run(ctx, { name: definition.name });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.notEqual(result.data?.noop, true);
  assert.equal(world.blockAt({ x: 1, y: 65, z: 0 }), 'air');
});

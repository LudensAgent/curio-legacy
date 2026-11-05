import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dismount, ride } from '../src/skills/actions.ts';
import { SKILLS } from '../src/skills/index.ts';
import { followPassage, goTo } from '../src/skills/movement.ts';
import { travel } from '../src/skills/overland.ts';
import { walkKnownRoute, walkTo } from '../src/skills/spatial-navigation.ts';
import { validateSkill } from '../src/skills/types.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const record = (value: unknown) => value as Record<string, unknown>;

test('direction targets over the single-request limit are rejected explicitly, never shortened', () => {
  const a = new TestWorld();
  for (const raw of [{ target: 'W 500' }, { target: 'E 1500' }]) {
    const result = validateSkill(goTo, raw, a);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /超过单次上限 200 格.*不会被缩短/);
  }
  for (const raw of [{ to: 'W 500' }, { to: 'E 1500' }]) {
    const result = validateSkill(travel, raw, a);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /超过单次上限 200 格.*不会被缩短/);
  }
  assert.equal(validateSkill(goTo, { target: 'W 200' }, a).ok, true, 'the documented limit itself stays usable');
  assert.equal(validateSkill(travel, { to: 'E 200' }, a).ok, true, 'the documented limit itself stays usable');
});

test('library entries reject unsupported targets/shapes instead of falling back to legacy movement', () => {
  const a = new TestWorld();
  assert.equal(validateSkill(walkTo, { to: [0, 64, 0] }, a).ok, false, 'arrival must be explicit');
  assert.equal(validateSkill(walkTo, { to: [0, 64, 0], arrival: { kind: 'anywhere' } }, a).ok, false, 'unknown arrival mode is rejected');
  assert.equal(validateSkill(walkTo, { to: [0, 64, 0], arrival: { kind: 'near', radius: 0 } }, a).ok, false, 'non-positive near radius is rejected');
  assert.equal(validateSkill(walkKnownRoute, { fragmentId: '' }, a).ok, false, 'a known route needs its own fragment id');
});

test('goto resolves a direction target once and reports the original request and backend', async (t) => {
  const a = new TestWorld();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  const validated = validateSkill(goTo, { target: 'E 200', headingOrigin: { x: 0.5, y: 64, z: 0.5 } }, a);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  // 第二次校验（Arbiter/重试）保留首次冻结的起点，不按新站位重算。
  a.pos = { x: 100.5, y: 70, z: 0.5 };
  assert.deepEqual(validateSkill(goTo, validated.args, a), validated);
  t.mock.method(a, 'moveTo', async (target: any) => {
    if (target.kind === 'near') a.pos = { ...target.pos };
    else a.pos = { x: target.x, y: 64, z: target.z };
  });
  const result = await goTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(record(result.data?.originalRequest), { target: 'E 200', headingOrigin: { x: 0.5, y: 64, z: 0.5 } });
  assert.deepEqual(result.data?.resolvedTarget, { x: 201, y: 64, z: 1 }, 'the frozen origin keeps the full 200 blocks, not a silent projection');
  assert.equal(result.data?.backend, 'pathfinder');
});

test('travel freezes a direction origin at first validation instead of re-reading a new position', async (t) => {
  const a = new TestWorld();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  const first = validateSkill(travel, { to: 'E 20' }, a);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.args.headingOrigin, { x: 0.5, y: 64, z: 0.5 });
  // 重试时身体已经走远；同一份参数必须仍指向首次校验算出的落点。
  a.pos = { x: 100.5, y: 64, z: 0.5 };
  assert.deepEqual(validateSkill(travel, first.args, a), first);
  const ctx = makeCtx(a, { deadlineMs: 6000 });
  t.after(() => ctx.memory.close());
  t.mock.method(a, 'moveTo', async () => {});
  const result = await travel.run(ctx, first.args);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.data?.resolvedTarget, { x: 21, z: 1 }, 'the retry keeps the original direction origin');
  assert.deepEqual(record(result.data?.originalRequest).headingOrigin, { x: 0.5, y: 64, z: 0.5 });
});

test('travel keeps the original request, resolved target and backend after a normal land trip', async (t) => {
  const a = new TestWorld();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  const validated = validateSkill(travel, { to: '5,64,0' }, a);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const result = await travel.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(record(result.data?.originalRequest), { to: '5,64,0' });
  assert.deepEqual(result.data?.resolvedTarget, { x: 5, y: 64, z: 0 });
  assert.equal(result.data?.backend, 'land_water_plan');
});

test('a swimTo that reports landed on the original bank does not complete the water leg', async (t) => {
  const a = new TestWorld();
  // 一条横贯搜索范围的河：x=10..12；对岸出口是 x=13。
  for (let x = 10; x <= 12; x++) for (let z = -60; z <= 60; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  // swimTo 只报“在某个干地站稳了”，身体仍停在原岸：这不是到达指定出口。
  t.mock.method(a, 'swimTo', async () => ({ ok: true, landed: true, surfaced: true, oxygen: 20 }));
  const validated = validateSkill(travel, { to: '16,64,0' }, a);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const result = await travel.run(ctx, validated.args);
  assert.equal(result.status, 'failed', result.summary);
  assert.match(result.summary, /没到指定岸/);
  assert.deepEqual(record(result.data?.originalRequest), { to: '16,64,0' });
});

test('ride does not turn a body-reported block near the endpoint into arrival', async (t) => {
  const a = new TestWorld();
  for (let x = 0; x <= 20; x++) for (let z = -3; z <= 3; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  a.pos = { x: 16.5, y: 64, z: 0.5 };
  a.riding = 'boat';
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  // 身体在离终点约一格处被挡住；旧包装层曾按 ≤1.8 把 arrived 改成 true。
  t.mock.method(a, 'ride', async () => ({ ok: true, arrived: false, blocked: true, moved: 1.2 }));
  const result = await ride.run(ctx, { to: { x: 18, z: 0 }, distance: 48 });
  assert.equal(result.data?.arrived, false, 'navigation arrival stays false');
  assert.doesNotMatch(result.summary, /到了目标附近/);
  assert.equal(result.data?.backend, 'vehicle_ride');
  assert.deepEqual(record(result.data?.originalRequest), { to: { x: 18, z: 0 }, distance: 48 });
});

test('dismount confirms the riding state instead of trusting the adapter ok flag alone', async (t) => {
  const a = new TestWorld();
  a.riding = 'oak_boat';
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  const result = await dismount.run(ctx, {});
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.riding, null);
  assert.equal(result.data?.from, 'oak_boat');
  assert.match(result.summary, /现在站在/);

  a.riding = 'oak_boat';
  t.mock.method(a, 'dismount', async () => ({ ok: true }));
  const unconfirmed = await dismount.run(ctx, {});
  assert.equal(unconfirmed.status, 'failed');
  assert.equal(unconfirmed.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(unconfirmed.data?.riding, 'oak_boat');
});

test('follow_passage keeps its own backend and request when the recorded route cannot be walked', async (t) => {
  const a = new TestWorld();
  a.pos = { x: 50, y: 30, z: 0 };
  const memory = new WorldMemory(null);
  memory.setWorld(a.worldId);
  memory.savePassage({ id: 'branch', worldId: a.worldId, dim: a.dim, kind: 'dug', entrances: [], deepestY: 40, dug: 4, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 2, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 10, y: 40, z: 0 }] });
  const ctx = makeCtx(a, { memory });
  t.after(() => memory.close());
  t.mock.method(a, 'moveTo', async () => { throw new Error('No path'); });
  const result = await followPassage.run(ctx, { to: 'entrance' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.deepEqual(record(result.data?.originalRequest), { to: 'entrance' });
  assert.equal(result.data?.backend, 'pathfinder_waypoints');
  assert.deepEqual(result.data?.resolvedTarget, { x: 2, y: 40, z: 0 });
});

test('a code skill preserves a failed goto receipt with its original request and backend', async (t) => {
  assert.ok(SKILLS.goto, 'goto stays registered as a composable base action');
  const a = new TestWorld();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  t.mock.method(a, 'moveTo', async () => { throw new Error('No path'); });
  const behavior = {
    name: 'wp5-code-goto', description: '导航失败后普通抛错', version: 1, steps: [] as { skill: string; args?: unknown }[],
    code: 'await api.act("goto", {target: "5,64,0"});\nthrow new Error("after goto");',
  };
  setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
  t.after(() => setBehaviorRegistry(null));
  const result = await useSkill.run(ctx, { name: behavior.name });
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /after goto/, 'the later code error remains the main error');
  const receipt = record(result.data?.lastNavigationFailure);
  assert.equal(receipt.childSkill, 'goto');
  const navData = record(record(receipt.result).data);
  assert.deepEqual(record(navData.originalRequest), { target: '5,64,0' });
  assert.equal(navData.backend, 'pathfinder');
});

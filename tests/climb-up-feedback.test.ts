import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter, MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import { climbUp } from '../src/skills/body.ts';
import type { SkillCtx } from '../src/skills/types.ts';

test('climb_up preserves explicit false through validation and rejects acknowledged movement without an actual ascent', async () => {
  let moves = 0;
  const adapter = {
    state: () => ({ pos: { x: 0.5, y: 77, z: 0.5 }, inventory: [{ name: 'cobblestone', count: 8 }] }),
    blockAt: () => 'air', lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo(target: MoveTarget, opts: MoveOpts) { moves++; assert.equal(target.kind, 'xyz'); assert.equal(opts.allowTerrainChanges, true); },
  } as unknown as GameAdapter;
  for (const raw of [{ untilSky: false }, { until_sky: false }]) {
    const parsed = climbUp.validate(raw, adapter);
    assert.ok(parsed.ok); assert.equal(parsed.args.untilSky, false); assert.equal(parsed.args.height, 3);
    assert.deepEqual(climbUp.validate(parsed.args, adapter), parsed, 'arbiter validation must keep the normalized stop flags');
  }
  const parsed = climbUp.validate({ height: 3, untilSky: false, untilExit: true }, adapter);
  assert.ok(parsed.ok);
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} } } as unknown as SkillCtx;
  const result = await climbUp.run(ctx, parsed.args);
  assert.equal(moves, 1, 'visible sky must not stop an exit-only climb before its first attempt');
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, 'STUCK');
  assert.equal(result.data?.climbed, 0); assert.equal(result.data?.goalReached, false);
  assert.deepEqual(result.data?.exits, []);
  assert.equal((result.data?.effectEvidence as any).changed, false);
  assert.match(result.summary, /未实际爬升/);
});

test('climb_up timeout keeps only confirmed height and the retry uses the remaining budget', async () => {
  let pos = { x: 0.5, y: 64, z: 0.5 }, onGround = true, climbs = 0;
  const controller = new AbortController();
  const budget = { height: 3, spent: 0, startY: 64 };
  const adapter = {
    state: () => ({ pos: { ...pos }, onGround, inventory: [{ name: 'dirt', count: 8 }] }),
    blockAt: () => 'air', lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo() {
      climbs++;
      if (climbs === 1) { pos = { ...pos, y: 65 }; return; }
      pos = { ...pos, y: 66 }; // 第二格跳到半空时被取消/超时，不算确认爬升
      onGround = false;
      controller.abort('TIMEOUT');
    },
  } as unknown as GameAdapter;
  const ctx = { adapter, signal: controller.signal, deadline: Date.now() + 10_000, senses: { refresh() {} }, make: false, climb: budget } as unknown as SkillCtx;
  await assert.rejects(climbUp.run(ctx, { height: 3, untilSky: false }), (error: Error & { partial?: Record<string, unknown> }) => {
    assert.equal(budget.spent, 1, '只入账已确认的 1 格');
    assert.equal(error.partial?.spent, 1, '取消/超时保留累计消耗');
    assert.equal(error.partial?.climbed, 1, '半空的一格不算净进展');
    assert.equal(error.partial?.goalReached, false);
    return true;
  });
  // 同一份账本重试：最多再爬 2 格，不重新获得完整 3 格。
  onGround = true; pos = { x: 0.5, y: 65, z: 0.5 };
  let moves = 0;
  (adapter as unknown as { moveTo: () => Promise<void> }).moveTo = async () => { moves++; pos = { ...pos, y: pos.y + 1 }; };
  const retry = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} }, make: false, climb: budget } as unknown as SkillCtx;
  const result = await climbUp.run(retry, { height: 3, untilSky: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(moves, 2, '补剩余 2 格');
  assert.equal(budget.spent, 3);
});

test('climb_up says plainly when its stop condition already holds instead of reporting a failed climb', async () => {
  let moves = 0;
  const adapter = {
    state: () => ({ pos: { x: 0.5, y: 77, z: 0.5 }, inventory: [{ name: 'dirt', count: 8 }] }),
    blockAt: () => 'air', lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo() { moves++; },
  } as unknown as GameAdapter;
  const parsed = climbUp.validate({ until_sky: true }, adapter);
  assert.ok(parsed.ok);
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} } } as unknown as SkillCtx;
  const result = await climbUp.run(ctx, parsed.args);
  assert.equal(result.status, 'succeeded');
  assert.equal(moves, 0);
  assert.equal(result.data?.alreadySatisfied, true);
  assert.match(result.summary, /"height":2/);
});

test('climb_up falls back to explicit pillar placement when pathfinding throws before an ascent', async () => {
  let pos = { x: 0.5, y: 64, z: 0.5 };
  let moves = 0;
  let pillars = 0;
  const adapter = {
    state: () => ({ pos: { ...pos }, onGround: true, inventory: [{ name: 'dirt', count: 8 }] }),
    blockAt: () => 'air', lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo() { moves++; throw new Error('No path: 寻路结束但尚未到达目标'); },
    async pillarUp() { pillars++; pos = { ...pos, y: pos.y + 1 }; return { ok: true, y: pos.y }; },
  } as unknown as GameAdapter;
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} } } as unknown as SkillCtx;
  const result = await climbUp.run(ctx, { height: 1, untilSky: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(moves, 1, 'pathfinder was asked once before the fallback');
  assert.equal(pillars, 1, 'a real path error gets one explicit pillar attempt');
  assert.equal(result.data?.climbed, 1);
  assert.equal(pos.y, 65);
});

test('climb_up falls back to explicit pillar placement when pathfinder reports completion without an ascent', async () => {
  let pos = { x: 0.5, y: 64, z: 0.5 };
  let moves = 0;
  let pillars = 0;
  const adapter = {
    state: () => ({ pos: { ...pos }, onGround: true, inventory: [{ name: 'dirt', count: 8 }] }),
    blockAt: () => 'air', lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo() { moves++; },
    async pillarUp() { pillars++; pos = { ...pos, y: pos.y + 1 }; return { ok: true, y: pos.y }; },
  } as unknown as GameAdapter;
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} } } as unknown as SkillCtx;
  const result = await climbUp.run(ctx, { height: 1, untilSky: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(moves, 1, 'pathfinder was asked once');
  assert.equal(pillars, 1, 'explicit pillar placement is the bounded fallback');
  assert.equal(result.data?.climbed, 1);
  assert.equal(pos.y, 65);
});

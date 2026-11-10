import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter, MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import { climbUp } from '../src/skills/body.ts';
import type { SkillCtx } from '../src/skills/types.ts';

test('climb_up preserves explicit false through validation and rejects acknowledged placement without a measured rise', async () => {
  let pillars = 0, moves = 0;
  const adapter = {
    state: () => ({ pos: { x: 0.5, y: 77, z: 0.5 }, onGround: true, inventory: [{ name: 'cobblestone', count: 8 }] }),
    blockAt: () => 'air', lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo() { moves++; },
    async pillarUp() { pillars++; return { ok: true }; },
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
  assert.equal(pillars, 1, 'explicit pillar placement is the primary ascent, not a pathfinder fallback');
  assert.equal(moves, 0, 'climb_up no longer delegates terrain changes to moveTo');
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
    async moveTo() { throw new Error('climb_up must not use pathfinder terrain changes'); },
    async pillarUp() {
      climbs++;
      if (climbs === 1) { pos = { ...pos, y: 65 }; return { ok: true, y: 65 }; }
      pos = { ...pos, y: 66 }; // 第二格跳到半空时被取消/超时，不算确认爬升
      onGround = false;
      controller.abort('TIMEOUT');
      return { ok: true, y: 66 };
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
  let pillars = 0;
  (adapter as unknown as { pillarUp: () => Promise<{ ok: boolean; y: number }> }).pillarUp = async () => {
    pillars++;
    pos = { ...pos, y: pos.y + 1 };
    return { ok: true, y: pos.y };
  };
  const retry = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} }, make: false, climb: budget } as unknown as SkillCtx;
  const result = await climbUp.run(retry, { height: 3, untilSky: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(pillars, 2, '补剩余 2 格');
  assert.equal(budget.spent, 3);
});

test('climb_up aborts the explicit pillar at the absolute deadline and keeps the confirmed partial rise', async () => {
  let pos = { x: 0.5, y: 64, z: 0.5 }, onGround = true, pillarCalls = 0, pillarStartedAt = 0, abortedAt = 0;
  const adapter = {
    state: () => ({ pos: { ...pos }, onGround, inventory: [{ name: 'dirt', count: 8 }] }),
    blockAt: () => 'air', lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo() { throw new Error('climb_up must not delegate to moveTo'); },
    async pillarUp(_names: string[], signal: AbortSignal) {
      pillarCalls++;
      // 真实垫高先产生确认高度，再在适配器内部继续耗时；期限必须能打断这段等待。
      pos = { ...pos, y: 65 }; onGround = true;
      pillarStartedAt = Date.now();
      await new Promise((_, reject) => {
        const safety = setTimeout(() => reject(new Error('test safety timeout')), 3000);
        const onAbort = () => { clearTimeout(safety); abortedAt = Date.now(); reject(Object.assign(new Error('deadline'), { name: 'AbortedError' })); };
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      });
      return { ok: true };
    },
  } as unknown as GameAdapter;
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 1200, senses: { refresh() {} } } as unknown as SkillCtx;
  await assert.rejects(climbUp.run(ctx, { height: 1, untilSky: false }), (error: Error & { partial?: Record<string, unknown> }) => {
    assert.equal(error.name, 'AbortedError');
    assert.equal(pillarCalls, 1, '期限到期后不再发起下一次垫高');
    assert.equal(error.partial?.climbed, 1, '已确认的 1 格在取消回执里保留');
    assert.deepEqual(error.partial?.position, { x: 0.5, y: 65, z: 0.5 });
    return true;
  });
  assert.ok(abortedAt > 0 && abortedAt - pillarStartedAt >= 800, `pillar signal aborted near the absolute deadline (${abortedAt - pillarStartedAt}ms)`);
  assert.ok(abortedAt - pillarStartedAt < 2500, 'the deadline did not wait for the fake operation to finish on its own');
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

test('climb_up on a ladder asks only for the explicit ladder transition, never terrain-changing movement', async () => {
  let pos = { x: 0.5, y: 64, z: 0.5 };
  const calls: { target: MoveTarget; opts: MoveOpts }[] = [];
  let pillars = 0;
  const adapter = {
    state: () => ({ pos: { ...pos }, onGround: false, inventory: [{ name: 'dirt', count: 8 }] }),
    blockAt: (p: { x: number; y: number; z: number }) => p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65) ? 'ladder' : 'air',
    lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo(target: MoveTarget, opts: MoveOpts) {
      calls.push({ target, opts });
      pos = { x: 0.5, y: 65, z: 0.5 };
    },
    async pillarUp() { pillars++; return { ok: true }; },
  } as unknown as GameAdapter;
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} } } as unknown as SkillCtx;
  const result = await climbUp.run(ctx, { height: 1, untilSky: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(pillars, 0, 'ladder ascent must not pillar');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target, { kind: 'ladder', x: 0, y: 65, z: 0 });
  assert.equal(calls[0].opts.allowTerrainChanges, undefined);
  assert.equal(calls[0].opts.allowPlace, undefined);
  assert.equal(calls[0].opts.allowTower, undefined);
});

test('climb_up uses explicit pillar placement as the primary ascent', async () => {
  let pos = { x: 0.5, y: 64, z: 0.5 }, pillars = 0, moves = 0;
  const adapter = {
    state: () => ({ pos: { ...pos }, onGround: true, inventory: [{ name: 'dirt', count: 8 }] }),
    blockAt: () => 'air', lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo() { moves++; },
    async pillarUp() { pillars++; pos = { ...pos, y: pos.y + 1 }; return { ok: true, y: pos.y }; },
  } as unknown as GameAdapter;
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} } } as unknown as SkillCtx;
  const result = await climbUp.run(ctx, { height: 1, untilSky: false });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(pillars, 1);
  assert.equal(moves, 0, 'no implicit pathfinder move or fallback');
  assert.equal(result.data?.climbed, 1);
  assert.equal(pos.y, 65);
});

test('climb_up digs the reported blocked clearance cell once and surfaces the pillar detail if it still blocks', async () => {
  let pos = { x: 0.5, y: 64, z: 0.5 }, pillars = 0;
  const digs: { x: number; y: number; z: number }[] = [];
  const adapter = {
    state: () => ({ pos: { ...pos }, onGround: true, inventory: [{ name: 'dirt', count: 8 }] }),
    blockAt: (p: { x: number; y: number; z: number }) => p.x === 0 && p.y === 67 && p.z === 0 ? 'stone' : 'air',
    lightAt: () => ({ block: 0, sky: 15 }),
    async dig(p: { x: number; y: number; z: number }) { digs.push(p); return { ok: true }; },
    async pillarUp() {
      pillars++;
      return {
        ok: false, reason: 'NOT_PLACED:头顶跳跃空间受阻',
        clearanceDetail: '头顶跳跃空间受阻；要跳起来得先把这几格都挖空（方块名未确认）：(0,67,0)',
        clearance: { at: [0, 3, 0] as [number, number, number], facing: 'N' },
      };
    },
  } as unknown as GameAdapter;
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} }, memory: { worldId: 'test-world', markGone() {} } } as unknown as SkillCtx;
  const result = await climbUp.run(ctx, { height: 1, untilSky: false });
  assert.equal(result.status, 'failed');
  assert.deepEqual(digs, [{ x: 0, y: 67, z: 0 }], '明确授权的清障只挖报告的那一格');
  assert.equal(pillars, 2, '清障后只重试一次垫高');
  assert.equal(result.data?.failureCause, 'PILLAR_CLEARANCE');
  assert.deepEqual(result.data?.pillarClearance, { at: [0, 3, 0], facing: 'N' }, 'structured clearance fact survives');
  assert.match(String(result.data?.clearanceDetail), /\(0,67,0\)/);
  assert.match(result.summary, /头顶跳跃空间受阻/);
  assert.match(result.summary, /\(0,67,0\)/, 'actual pillar clearance detail is not swallowed');
});

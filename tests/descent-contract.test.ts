import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentState, MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import { descend } from '../src/skills/descent.ts';
import type { LandingOption, SkillCtx } from '../src/skills/types.ts';

// Receipt and transaction contract only: no game, navigation or falling simulation.
test('descend requires fresh local geometry, sufficient health or observed water depth, and sends one bounded non-destructive move', async () => {
  function fixture(surface: 'ground' | 'water' = 'ground') {
    const state = { connected: true, alive: true, observationReady: true, observationId: 5, sessionId: 'session', worldId: 'world', dim: 'overworld',
      pos: { x: 0.5, y: 70, z: 0.5 }, hp: 20, onGround: true, inWater: false, inLava: false } as AgentState;
    const option: LandingOption = { target: { x: 1.5, y: surface === 'water' ? 63 : 64, z: 0.5 }, support: { pos: { x: 1, y: 63, z: 0 }, name: surface === 'water' ? 'water' : 'stone' },
      surface, surfaceY: 64, drop: 6, horizontalDistance: 1, clearance: 'clear', corridor: 'clear', approach: 'adjacent', waterDepth: surface === 'water' ? 2 : 'unknown', unknowns: [],
      receipt: { worldId: state.worldId, sessionId: state.sessionId, dimension: state.dim, observationId: 6, at: Date.now(), from: { ...state.pos } } };
    const calls: { target: MoveTarget; opts: MoveOpts }[] = [];
    const ctx = { adapter: { state: () => structuredClone(state), async moveTo(target: MoveTarget, opts: MoveOpts) {
      calls.push({ target, opts }); state.pos = { ...option.target }; state.inWater = surface === 'water'; state.onGround = !state.inWater;
    } }, senses: { refresh() {}, landingOptions: () => [option] }, signal: new AbortController().signal, deadline: Date.now() + 3000 } as unknown as SkillCtx;
    return { state, option, calls, ctx };
  }
  const ground = fixture(), parsed = descend.validate({ target: ground.option.target }, ground.ctx.adapter);
  assert.ok(parsed.ok);
  const delegated = descend.validate({ target: ground.option.target, allowUnknownCorridor: true }, ground.ctx.adapter);
  assert.ok(delegated.ok); assert.equal(delegated.args.allowUnknownCorridor, true);
  assert.equal(descend.validate({ target: ground.option.target, allowUnknownCorridor: 'yes' }, ground.ctx.adapter).ok, false);
  const actual = await descend.run(ground.ctx, parsed.args);
  assert.equal(actual.status, 'succeeded'); assert.deepEqual(actual.data?.position, ground.option.target);
  assert.equal(ground.calls.length, 1);
  assert.deepEqual(ground.calls[0].target, { kind: 'xyz', ...ground.option.target });
  assert.equal(ground.calls[0].opts.maxDropDown, 7, 'native solid landings count the support block too');
  assert.equal(ground.calls[0].opts.allowTerrainChanges, false); assert.equal(ground.calls[0].opts.constructionSafe, true);
  assert.equal(ground.calls[0].opts.allowSwimming, false);

  const stale = fixture(); stale.option.receipt.at -= 2000;
  assert.equal((await descend.run(stale.ctx, { target: stale.option.target })).status, 'failed'); assert.equal(stale.calls.length, 0);
  const unsafe = fixture(); unsafe.state.hp = 8;
  assert.equal((await descend.run(unsafe.ctx, { target: unsafe.option.target })).failureCode, 'LOW_HP'); assert.equal(unsafe.calls.length, 0);
  const occluded = fixture(); occluded.option.corridor = 'unknown';
  const unknown = await descend.run(occluded.ctx, { target: occluded.option.target });
  assert.equal(unknown.status, 'failed'); assert.match(unknown.summary, /落体通道未看清/);
  assert.match(unknown.summary, /allowUnknownCorridor:true/);
  assert.deepEqual(unknown.data?.geometry, { clearance: 'clear', corridor: 'unknown', approach: 'adjacent', unknowns: [] });
  assert.equal(occluded.calls.length, 0);
  const accepted = await descend.run(occluded.ctx, { target: occluded.option.target, allowUnknownCorridor: true });
  assert.equal(accepted.status, 'succeeded', accepted.summary);
  assert.equal(accepted.data?.corridor, 'unknown');
  assert.equal(accepted.data?.unknownCorridorAccepted, true);
  assert.equal(occluded.calls.length, 1, 'an explicit delegation executes the selected landing');
  const blocked = fixture(); blocked.option.clearance = 'blocked';
  const obstruction = await descend.run(blocked.ctx, { target: blocked.option.target });
  assert.match(obstruction.summary, /落点净空观察到阻挡/); assert.equal(blocked.calls.length, 0);
  const shallow = fixture('water'); shallow.option.waterDepth = 'unknown';
  assert.equal((await descend.run(shallow.ctx, { target: shallow.option.target })).status, 'failed'); assert.equal(shallow.calls.length, 0);
  const water = fixture('water'), wet = await descend.run(water.ctx, { target: water.option.target });
  assert.equal(wet.status, 'succeeded'); assert.equal(wet.data?.inWater, true); assert.match(wet.summary, /尚未确认上岸/);
  assert.equal(water.calls[0].opts.maxDropDown, 7); assert.equal(water.calls[0].opts.allowSwimming, true);
});

test('descend verifies the selected ground support with the shared collision shape, not an integer foot guess', async () => {
  const state = { connected: true, alive: true, observationReady: true, observationId: 5, sessionId: 'session', worldId: 'world', dim: 'overworld',
    pos: { x: 0.5, y: 70, z: 0.5 }, hp: 20, onGround: true, inWater: false, inLava: false } as AgentState;
  const option: LandingOption = { target: { x: 1.5, y: 64, z: 0.5 }, support: { pos: { x: 1, y: 63, z: 0 }, name: 'oak_slab' },
    surface: 'ground', surfaceY: 64, drop: 6, horizontalDistance: 1, clearance: 'clear', corridor: 'clear', approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
    receipt: { worldId: state.worldId, sessionId: state.sessionId, dimension: state.dim, observationId: 6, at: Date.now(), from: { ...state.pos } } };
  let calls = 0;
  const ctx = { adapter: { state: () => structuredClone(state), blockStateAt: () => ({ name: 'oak_slab', properties: { type: 'bottom' } }),
    async moveTo() { calls++; } }, senses: { refresh() {}, landingOptions: () => [option] }, signal: new AbortController().signal, deadline: Date.now() + 3000 } as unknown as SkillCtx;
  const result = await descend.run(ctx, { target: option.target });
  assert.equal(result.status, 'failed', result.summary);
  assert.match(result.summary, /支撑面按碰撞形状在 y=63\.50/);
  assert.equal(calls, 0, '没有按整数 64 假着陆');
});

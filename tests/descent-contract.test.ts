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
    const ctx = { adapter: { state: () => structuredClone(state),
      blockAt: (p: { x: number; y: number; z: number }) => surface === 'water' ? 'air'
        : (p.x === option.support.pos.x && p.y === option.support.pos.y && p.z === option.support.pos.z ? 'stone' : 'air'),
      async moveTo(target: MoveTarget, opts: MoveOpts) {
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
  assert.equal(ground.calls[0].opts.allowSwimming, false);

  const stale = fixture(); stale.option.receipt.at -= 2000;
  assert.equal((await descend.run(stale.ctx, { target: stale.option.target })).status, 'failed'); assert.equal(stale.calls.length, 0);
  const wrong = fixture();
  const missing = await descend.run(wrong.ctx, { target: { x: 9, y: 60, z: 9 } });
  assert.equal(missing.status, 'failed');
  assert.match(missing.summary, /2 格内可见落点|选择的落点当前不可见/);
  assert.ok(Array.isArray(missing.data?.available) && (missing.data.available as unknown[]).length > 0, '失败时列出当前可复制的落点');
  assert.equal(wrong.calls.length, 0);
  const unsafe = fixture(); unsafe.state.hp = 4; // 6 格落差约 3 点伤，4 血不够保留余量
  assert.equal((await descend.run(unsafe.ctx, { target: unsafe.option.target })).failureCode, 'LOW_HP'); assert.equal(unsafe.calls.length, 0);
  // 1–3 格原版不摔伤：低血也不应把 2 格落差估成 ceil(2)+2 点而拒绝。
  const safeLow = fixture(); safeLow.state.hp = 1.59;
  safeLow.option.target = { x: 1.5, y: 68, z: 0.5 }; safeLow.option.surfaceY = 68; safeLow.option.drop = 2;
  safeLow.option.support = { pos: { x: 1, y: 67, z: 0 }, name: 'stone' };
  const safe = await descend.run(safeLow.ctx, { target: safeLow.option.target });
  assert.equal(safe.status, 'succeeded', safe.summary);
  assert.equal(safeLow.calls.length, 1);
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

test('descend only accepts arrival in the selected column and exact foot height', async () => {
  function fixture(end: { x: number; y: number; z: number }, opts: { supportAfter?: string; bodyBlocked?: boolean } = {}) {
    const state = { connected: true, alive: true, observationReady: true, observationId: 5, sessionId: 'session', worldId: 'world', dim: 'overworld',
      pos: { x: 0.5, y: 70, z: 0.5 }, hp: 20, onGround: true, inWater: false, inLava: false } as AgentState;
    const option: LandingOption = { target: { x: 1.5, y: 64, z: 0.5 }, support: { pos: { x: 1, y: 63, z: 0 }, name: 'stone' },
      surface: 'ground', surfaceY: 64, drop: 6, horizontalDistance: 1, clearance: 'clear', corridor: 'clear', approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
      receipt: { worldId: state.worldId, sessionId: state.sessionId, dimension: state.dim, observationId: 6, at: Date.now(), from: { ...state.pos } } };
    const ctx = { adapter: { state: () => structuredClone(state),
      blockAt: (p: { x: number; y: number; z: number }) => opts.bodyBlocked && p.x === 1 && p.y === 65 && p.z === 0 ? 'stone'
        : p.x === 1 && p.y === 63 && p.z === 0 ? opts.supportAfter ?? 'stone' : 'air',
      async moveTo() {
        state.pos = { ...end }; state.onGround = true; state.inWater = false;
      } }, senses: { refresh() {}, landingOptions: () => [option] }, signal: new AbortController().signal, deadline: Date.now() + 5000 } as unknown as SkillCtx;
    return { option, ctx };
  }
  // 身体中心离目标中心 0.6 格，已在相邻列：旧实现按欧氏距离会接受。
  const adjacent = fixture({ x: 2.1, y: 64, z: 0.5 });
  const wrongColumn = await descend.run(adjacent.ctx, { target: adjacent.option.target });
  assert.equal(wrongColumn.status, 'failed', wrongColumn.summary);
  assert.equal(wrongColumn.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual((wrongColumn.data as { arrival?: { satisfied?: boolean } } | undefined)?.arrival?.satisfied, false);
  assert.deepEqual((wrongColumn.data as { position?: unknown } | undefined)?.position, { x: 2.1, y: 64, z: 0.5 });
  // 在同一列但脚高低 0.2 格：旧实现 0.3 容差会当成功。
  const lower = fixture({ x: 1.5, y: 63.8, z: 0.5 });
  const wrongFoot = await descend.run(lower.ctx, { target: lower.option.target });
  assert.equal(wrongFoot.status, 'failed', wrongFoot.summary);
  assert.equal(wrongFoot.failureCode, 'EFFECT_NOT_CONFIRMED');
  // 位置对，但落地后支撑被换掉：重新采样支撑顶面必须失败。
  const lostSupport = fixture({ x: 1.5, y: 64, z: 0.5 }, { supportAfter: 'air' });
  const noSupport = await descend.run(lostSupport.ctx, { target: lostSupport.option.target });
  assert.equal(noSupport.status, 'failed', noSupport.summary);
  assert.equal(noSupport.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal((noSupport.data as { arrival?: { measured?: { supportAfter?: unknown } } } | undefined)?.arrival?.measured?.supportAfter, false);
  // 位置对，但落地后头格被方块占据：落地后的身体空间必须重新确认。
  const blockedBody = fixture({ x: 1.5, y: 64, z: 0.5 }, { bodyBlocked: true });
  const noSpace = await descend.run(blockedBody.ctx, { target: blockedBody.option.target });
  assert.equal(noSpace.status, 'failed', noSpace.summary);
  assert.equal(noSpace.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal((noSpace.data as { arrival?: { measured?: { bodySpace?: unknown } } } | undefined)?.arrival?.measured?.bodySpace, 'blocked');
});

test('descend verifies the selected ground support with the shared collision shape, not an integer foot guess', async () => {
  const state = { connected: true, alive: true, observationReady: true, observationId: 5, sessionId: 'session', worldId: 'world', dim: 'overworld',
    pos: { x: 0.5, y: 70, z: 0.5 }, hp: 20, onGround: true, inWater: false, inLava: false } as AgentState;
  const option: LandingOption = { target: { x: 1.5, y: 64, z: 0.5 }, support: { pos: { x: 1, y: 63, z: 0 }, name: 'oak_slab' },
    surface: 'ground', surfaceY: 64, drop: 6, horizontalDistance: 1, clearance: 'clear', corridor: 'clear', approach: 'adjacent', waterDepth: 'unknown', unknowns: [],
    receipt: { worldId: state.worldId, sessionId: state.sessionId, dimension: state.dim, observationId: 6, at: Date.now(), from: { ...state.pos } } };
  let calls = 0;
  const ctx = { adapter: { state: () => structuredClone(state), blockStateAt: () => ({ name: 'oak_slab', properties: { type: 'bottom' } }),
    blockAt: () => 'air', async moveTo() { calls++; } }, senses: { refresh() {}, landingOptions: () => [option] }, signal: new AbortController().signal, deadline: Date.now() + 3000 } as unknown as SkillCtx;
  const result = await descend.run(ctx, { target: option.target });
  assert.equal(result.status, 'failed', result.summary);
  assert.match(result.summary, /支撑面按碰撞形状在 y=63\.50/);
  assert.equal(calls, 0, '没有按整数 64 假着陆');
});

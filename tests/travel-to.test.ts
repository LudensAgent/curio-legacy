import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter, MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { SKILLS } from '../src/skills/index.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import type { SkillCtx } from '../src/skills/types.ts';

function harness(options: { blocked?: (goal: MoveTarget, from: Vec3Like) => boolean; dug?: { pos: Vec3Like; name: string; ts: number }[] } = {}) {
  let pos: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
  const calls: { target: MoveTarget; opts: MoveOpts; from: Vec3Like }[] = [];
  const adapter = {
    state: () => ({ pos: { ...pos }, dim: 'overworld', worldId: 'w', alive: true, connected: true, riding: null }),
    async moveTo(target: MoveTarget, opts: MoveOpts) {
      calls.push({ target, opts, from: { ...pos } });
      if (options.blocked?.(target, pos)) throw new Error('No path: 寻路结束但尚未到达目标');
      if (target.kind === 'xz') pos = { x: target.x + 0.5, y: pos.y, z: target.z + 0.5 };
      else if (target.kind === 'near') pos = { x: target.pos.x + 0.5, y: target.pos.y, z: target.pos.z + 0.5 };
    },
    recentDug: (since: number) => (options.dug ?? []).filter((d) => d.ts > since),
    recentPlaced: () => [],
  } as unknown as GameAdapter;
  const memory = { visitedChunkCount: 0, lastDeath: () => null, findLandmark: (q: string) => q === 'base' ? { label: '家', dim: 'overworld', pos: { x: 30, y: 64, z: 0 } } : undefined };
  const ctx = { adapter, memory, signal: new AbortController().signal, deadline: Date.now() + 60_000, progress() {} } as unknown as SkillCtx;
  return { adapter, ctx, calls, at: () => pos };
}

function argsOf(raw: unknown, adapter: GameAdapter) {
  const parsed = travelTo.validate(raw, adapter);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return parsed.args;
}

test('travel_to 注册为显式辅助；方向目标冻结起点且校验幂等，超限拒绝不缩短', () => {
  assert.equal(SKILLS.travel_to, travelTo);
  const { adapter } = harness();
  const parsed = travelTo.validate({ to: 'E 150' }, adapter);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args.to, { heading: 'E', distance: 150, origin: { x: 0.5, y: 64, z: 0.5 } });
  assert.deepEqual(travelTo.validate(parsed.args, adapter), parsed, '规范化参数再校验不变');
  assert.equal(parsed.args.allowDig, false); assert.equal(parsed.args.allowPlace, false); assert.equal(parsed.args.allowSwim, true);
  const over = travelTo.validate({ to: 'N 300' }, adapter);
  assert.ok(!over.ok && /不会被缩短/.test(over.error));
  const tower = travelTo.validate({ to: '10,10', allowTower: true }, adapter);
  assert.ok(!tower.ok && /allowPlace/.test(tower.error));
  const coords = travelTo.validate({ to: '10,70,-5' }, adapter);
  assert.ok(coords.ok); assert.deepEqual(coords.args.to, { x: 10, y: 70, z: -5 });
  assert.ok(!travelTo.validate({ to: 'x', avoid: ['Bad Name'] }, adapter).ok);
});

test('travel_to 按 ≤24 格分跳执行并实测到达；默认不挖不放、绕开伤身方块，回执不含路径格', async () => {
  const { ctx, calls, at } = harness();
  const result = await travelTo.run(ctx, argsOf({ to: { x: 60, z: 0 } }, ctx.adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(calls.length >= 3, `60 格至少分 3 跳，实际 ${calls.length}`);
  for (const { target, from } of calls) {
    const x = target.kind === 'xz' ? target.x : target.kind === 'near' ? target.pos.x : NaN;
    assert.ok(Math.abs(x - from.x) <= 24.5, '每跳不超过 24 格');
  }
  const opts = calls[0].opts;
  assert.equal(opts.allowTerrainChanges, undefined); assert.equal(opts.allowPlace, false); assert.equal(opts.allowTower, false);
  assert.ok(opts.avoid?.includes('magma_block'));
  assert.equal(result.data?.backend, 'pathfinder');
  assert.equal((result.data?.nav as { outcome: string }).outcome, 'ARRIVED');
  assert.ok(Math.abs(at().x - 60.5) < 1);
  assert.equal(JSON.stringify(result.data).includes('"path"'), false, '不回报规划路径');
});

test('travel_to 正前方走不通时偏转绕行；都走不通时只报辅助没找到，不描述未见地形', async () => {
  const detour = harness({ blocked: (goal, from) => goal.kind === 'xz' && Math.abs(goal.z - Math.floor(from.z)) < 1 && from.x < 1 });
  const ok = await travelTo.run(detour.ctx, argsOf({ to: '40,0' }, detour.adapter));
  assert.equal(ok.status, 'succeeded', ok.summary);
  assert.ok((ok.data?.detours as number) >= 1);

  const wall = harness({ blocked: () => true });
  const failed = await travelTo.run(wall.ctx, argsOf({ to: '40,0' }, wall.adapter));
  assert.equal(failed.status, 'failed'); assert.equal(failed.failureCode, 'PATH_NOT_FOUND');
  assert.equal(failed.data?.stopReason, 'NO_ROUTE');
  assert.match(failed.summary, /不描述没看见的地形/);
  assert.equal((failed.data?.nav as { outcome: string }).outcome, 'NO_PATH');
});

test('travel_to 施工授权透传到寻路，回执逐项列出挖掉的方块；未知地标不移动', async () => {
  const t0 = Date.now();
  const h = harness({ dug: [{ pos: { x: 3, y: 64, z: 0 }, name: 'stone', ts: t0 + 60_000 }] });
  const r = await travelTo.run(h.ctx, argsOf({ to: 'base', allowDig: true }, h.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(h.calls[0].opts.allowTerrainChanges, true);
  assert.deepEqual((r.data?.sideEffects as { dug: unknown[] }).dug, [{ pos: { x: 3, y: 64, z: 0 }, name: 'stone' }]);
  assert.match(r.summary, /挖掉 1 块/);

  const none = harness();
  const missing = await travelTo.run(none.ctx, argsOf({ to: '不存在的地方' }, none.adapter));
  assert.equal(missing.failureCode, 'NOT_FOUND');
  assert.equal(none.calls.length, 0);
});

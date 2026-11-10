import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter, MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { SKILLS } from '../src/skills/index.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import type { SkillCtx } from '../src/skills/types.ts';

function harness(options: { blocked?: (goal: MoveTarget, from: Vec3Like, opts: MoveOpts) => boolean; fail?: (goal: MoveTarget, from: Vec3Like, opts: MoveOpts) => Error | undefined; dug?: { pos: Vec3Like; name: string; ts: number }[]; fallInAfter?: number } = {}) {
  let pos: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
  let inWater = false, moves = 0;
  const calls: { target: MoveTarget; opts: MoveOpts; from: Vec3Like }[] = [];
  const adapter = {
    state: () => ({ pos: { ...pos }, dim: 'overworld', worldId: 'w', alive: true, connected: true, riding: null, inWater, oxygen: inWater ? 12 : 20 }),
    async moveTo(target: MoveTarget, opts: MoveOpts) {
      calls.push({ target, opts, from: { ...pos } });
      if (options.fallInAfter !== undefined && ++moves > options.fallInAfter) inWater = true;
      const failure = options.fail?.(target, pos, opts);
      if (failure) throw failure;
      if (options.blocked?.(target, pos, opts)) throw Object.assign(new Error('No path: 寻路结束但尚未到达目标'), { name: 'NoPath' });
      if (target.kind === 'xz') {
        const y = target.footY ? Math.min(target.footY[1], Math.max(target.footY[0], Math.floor(pos.y))) : pos.y;
        pos = { x: target.x + 0.5, y, z: target.z + 0.5 };
      } else if (target.kind === 'near') pos = { x: target.pos.x + 0.5, y: target.pos.y, z: target.pos.z + 0.5 };
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
  assert.equal(parsed.args.allowDig, false); assert.equal(parsed.args.allowPlace, false); assert.equal(parsed.args.allowSwim, false, '默认不下水');
  const over = travelTo.validate({ to: 'N 300' }, adapter);
  assert.ok(!over.ok && /不会被缩短/.test(over.error));
  const tower = travelTo.validate({ to: '10,10', allowTower: true }, adapter);
  assert.ok(!tower.ok && /allowPlace/.test(tower.error));
  const coords = travelTo.validate({ to: '10,70,-5' }, adapter);
  assert.ok(coords.ok); assert.deepEqual(coords.args.to, { x: 10, y: 70, z: -5 });
  assert.ok(!travelTo.validate({ to: 'x', avoid: ['Bad Name'] }, adapter).ok);
});

test('travel_to 超出直接寻路范围时按 ≤24 格分跳执行并实测到达；默认不挖不放、绕开伤身方块，回执不含路径格', async () => {
  const { ctx, calls, at } = harness();
  const result = await travelTo.run(ctx, argsOf({ to: { x: 150, z: 0 } }, ctx.adapter));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(calls.length >= 4, `150 格先分跳、进入 64 格后直达，实际 ${calls.length}`);
  for (const { target, from } of calls) {
    const x = target.kind === 'xz' ? target.x : target.kind === 'near' ? target.pos.x : NaN;
    // 中间跳不超过 24 格；进入 64 格后最后一跳直接以真实终点为目标
    assert.ok(x === 150 ? 150 - from.x <= 64 : Math.abs(x - from.x) <= 24.5, `跳长超限：${from.x} → ${x}`);
  }
  const opts = calls[0].opts;
  assert.equal(opts.allowTerrainChanges, undefined); assert.equal(opts.allowPlace, false); assert.equal(opts.allowTower, false);
  assert.ok(opts.avoid?.includes('magma_block'));
  assert.equal(opts.allowSwimming, false, '默认不下水，寻路器排除水格');
  assert.equal(opts.searchRadius, 48, '单跳绕路有上限');
  assert.equal(opts.lavaEdgeCost, 10, '默认离岩浆边远一点');
  assert.equal(result.data?.backend, 'pathfinder');
  assert.equal((result.data?.nav as { outcome: string }).outcome, 'ARRIVED');
  assert.ok(Math.abs(at().x - 150.5) < 1);
  assert.equal(JSON.stringify(result.data).includes('"path"'), false, '不回报规划路径');
});

test('travel_to 64 格内直接以真实目标寻路；来回绕回之前到过的位置就停下并说明', async () => {
  const direct = harness();
  await travelTo.run(direct.ctx, argsOf({ to: { x: 60, z: 0 } }, direct.adapter));
  assert.deepEqual(direct.calls[0]!.target, { kind: 'xz', x: 60, z: 0, range: 2 }, '不先走一个随身体漂移的中间点');

  // 两条洞道之间来回：每一跳都真的走了 10 格，但总在 A、B 两处之间摆。
  let flip = 1;
  const sway = harness();
  const move = sway.adapter.moveTo.bind(sway.adapter);
  sway.adapter.moveTo = (async (_target: MoveTarget, opts: MoveOpts) => {
    flip = -flip;
    return move({ kind: 'xz', x: 0, z: flip * 5, range: 1 }, opts);
  }) as typeof sway.adapter.moveTo;
  const r = await travelTo.run(sway.ctx, argsOf({ to: { x: 60, z: 0 } }, sway.adapter));
  assert.equal(r.data?.stopReason, 'NO_PROGRESS');
  assert.ok(r.data?.revisited, '回执标出回到的位置');
  assert.match(r.summary, /又回到之前到过的/);
  assert.ok(sway.calls.length <= 3, `识别到回访就停，不再绕满 ${sway.calls.length}`);
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

test('travel_to 先试不施工，只有明确 noPath 才按原施工授权重试，并逐项列出副作用', async () => {
  const t0 = Date.now();
  const h = harness({ dug: [{ pos: { x: 3, y: 64, z: 0 }, name: 'stone', ts: t0 + 60_000 }],
    blocked: (_goal, _from, opts) => opts.allowTerrainChanges !== true });
  const r = await travelTo.run(h.ctx, argsOf({ to: 'base', allowDig: true }, h.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].opts.allowTerrainChanges, false, '第一次搜索不施工');
  assert.equal(h.calls[1].opts.allowTerrainChanges, true, '只有 noPath 后才使用授权施工');
  assert.equal(r.data?.constructionRetries, 1);
  assert.deepEqual((r.data?.sideEffects as { dug: unknown[] }).dug, [{ pos: { x: 3, y: 64, z: 0 }, name: 'stone' }]);
  assert.match(r.summary, /挖掉 1 块/);

  const none = harness();
  const missing = await travelTo.run(none.ctx, argsOf({ to: '不存在的地方' }, none.adapter));
  assert.equal(missing.failureCode, 'NOT_FOUND');
  assert.equal(none.calls.length, 0);
});


test('垂直高差不掩盖真实失败：单跳超时/未知错误优先于 VERTICAL_GAP', async () => {
  const timeout = harness({ fail: () => Object.assign(new Error('TIMEOUT: 单跳'), { name: 'Timeout' }) });
  const t = await travelTo.run(timeout.ctx, argsOf({ to: { x: 2, y: 10, z: 0 }, allowDig: true }, timeout.adapter));
  assert.equal(t.data?.stopReason, 'TIMEOUT', t.summary);
  assert.equal(t.failureCode, 'TIMEOUT');
  assert.notEqual((t.data?.nav as { outcome: string }).outcome, 'NO_PATH');
  assert.equal(t.data?.timeoutSource, 'hop');
  assert.match(t.summary, /单跳寻路\/执行超时/);
  assert.doesNotMatch(t.summary, /用完 180 秒/);
  assert.ok(timeout.calls.every(({ opts }) => opts.allowTerrainChanges !== true));

  const unknown = harness({ fail: () => new Error('No path: 普通错误文本') });
  const u = await travelTo.run(unknown.ctx, argsOf({ to: { x: 2, y: 10, z: 0 }, allowDig: true }, unknown.adapter));
  assert.equal(u.data?.stopReason, 'ERROR', u.summary);
  assert.equal(u.failureCode, 'ERROR');
  assert.notEqual((u.data?.nav as { outcome: string }).outcome, 'NO_PATH');
  assert.ok(unknown.calls.every(({ opts }) => opts.allowTerrainChanges !== true));
});

test('整体预算耗尽时用真实 elapsed 报 TIMEOUT，不虚报等待时长', async () => {
  const h = harness();
  (h.ctx as { deadline: number }).deadline = Date.now() + 1;
  const r = await travelTo.run(h.ctx, argsOf({ to: '30,0' }, h.adapter));
  assert.equal(r.data?.stopReason, 'TIMEOUT');
  assert.equal(r.data?.timeoutSource, 'budget');
  assert.equal(h.calls.length, 0);
  assert.match(r.summary, /整体移动预算到点，实际已进行 \d+ 秒/);
  assert.doesNotMatch(r.summary, /用完 180 秒/);
});

test('混合候选失败按当前轮聚合：正向 NoPath、偏转 Timeout 不能宣称整体无路', async () => {
  let calls = 0;
  const h = harness({ fail: () => ++calls === 1
    ? Object.assign(new Error('No path: 正向'), { name: 'NoPath' })
    : Object.assign(new Error('TIMEOUT: 偏转'), { name: 'Timeout' }) });
  const r = await travelTo.run(h.ctx, argsOf({ to: '30,0' }, h.adapter));
  assert.equal(r.data?.stopReason, 'TIMEOUT', r.summary);
  assert.equal(r.failureCode, 'TIMEOUT');
  assert.equal(r.data?.primaryFailureKind, 'NO_PATH');
  assert.deepEqual((r.data?.candidateFailureKinds as string[]).sort(), ['NO_PATH', 'TIMEOUT']);
  assert.notEqual((r.data?.nav as { outcome: string }).outcome, 'NO_PATH');
});

test('TimeoutError 与 Timeout 同类识别；普通错误仍不是 NoPath', async () => {
  const h = harness({ fail: () => Object.assign(new Error('aborted while waiting'), { name: 'TimeoutError' }) });
  const r = await travelTo.run(h.ctx, argsOf({ to: '30,0', allowDig: true, allowPlace: true }, h.adapter));
  assert.equal(r.data?.stopReason, 'TIMEOUT');
  assert.equal(r.failureCode, 'TIMEOUT');
  assert.ok(h.calls.every(({ opts }) => opts.allowTerrainChanges !== true));
});

test('超时、NOT_CONFIRMED、取消不升级施工；明确 noPath 才升级', async () => {
  const notNoPath: [string, Error, string, string][] = [
    ['timeout', Object.assign(new Error('TIMEOUT: 超时'), { name: 'Timeout' }), 'TIMEOUT', 'TIMEOUT'],
    ['not confirmed', new Error('NOT_CONFIRMED: 还没到'), 'NOT_CONFIRMED', 'EFFECT_NOT_CONFIRMED'],
    ['plain No path text', new Error('No path: 普通错误，不是库的 NoPath 标记'), 'ERROR', 'ERROR'],
    ['pillar clearance', Object.assign(new Error('No path: 原地搭柱头顶空间受阻'), { name: 'PillarClearanceError' }), 'ERROR', 'ERROR'],
    ['goal changed', Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' }), 'ERROR', 'ERROR'],
    ['path stopped', Object.assign(new Error('Path was stopped before it could be completed!'), { name: 'PathStopped' }), 'ERROR', 'ERROR'],
  ];
  for (const [label, error, stopReason, code] of notNoPath) {
    const h = harness({ fail: () => error });
    const r = await travelTo.run(h.ctx, argsOf({ to: '30,0', allowDig: true, allowPlace: true }, h.adapter));
    assert.equal(r.data?.stopReason, stopReason, label);
    assert.equal(r.failureCode, code, label);
    assert.ok(h.calls.every(({ opts }) => opts.allowTerrainChanges !== true && opts.allowPlace !== true), label);
    assert.equal(h.calls.filter(({ opts }) => opts.allowTerrainChanges === true).length, 0, label);
  }

  const controller = new AbortController();
  const cancelled = harness({ fail: () => { controller.abort(); return Object.assign(new Error('cancelled'), { name: 'AbortedError' }); } });
  await assert.rejects(() => travelTo.run({ ...cancelled.ctx, signal: controller.signal }, argsOf({ to: '30,0', allowDig: true }, cancelled.adapter)), { name: 'AbortedError' });
  assert.ok(cancelled.calls.every(({ opts }) => opts.allowTerrainChanges !== true));

  const explicit = harness();
  const r = await travelTo.run(explicit.ctx, argsOf({ to: '30,0', allowDig: true }, explicit.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(explicit.calls[0]?.opts.allowTerrainChanges, false, '授权施工时仍先按不施工直接寻路');
});

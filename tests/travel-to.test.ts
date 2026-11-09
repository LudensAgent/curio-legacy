import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter, MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { SKILLS } from '../src/skills/index.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import type { SkillCtx } from '../src/skills/types.ts';

function harness(options: { blocked?: (goal: MoveTarget, from: Vec3Like) => boolean; dug?: { pos: Vec3Like; name: string; ts: number }[]; fallInAfter?: number } = {}) {
  let pos: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
  let inWater = false, moves = 0;
  const calls: { target: MoveTarget; opts: MoveOpts; from: Vec3Like }[] = [];
  const adapter = {
    state: () => ({ pos: { ...pos }, dim: 'overworld', worldId: 'w', alive: true, connected: true, riding: null, inWater, oxygen: inWater ? 12 : 20 }),
    async moveTo(target: MoveTarget, opts: MoveOpts) {
      calls.push({ target, opts, from: { ...pos } });
      if (options.fallInAfter !== undefined && ++moves > options.fallInAfter) inWater = true;
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

test('travel_to via:history 按自己走过的历史路线路点分跳；路点走不通就放弃剩余历史路点并列出', async () => {
  const points = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 20.5 }, { x: 30.5, y: 64, z: 20.5 }, { x: 60.5, y: 64, z: 0.5 }];
  const query = () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } });
  const viaHistory = harness();
  (viaHistory.ctx as { spatial?: unknown }).spatial = { query };
  const r = await travelTo.run(viaHistory.ctx, argsOf({ to: '60,0', via: 'history' }, viaHistory.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(viaHistory.calls.some(({ target }) => target.kind === 'near' && target.pos.z === 20), '先朝历史路点走');
  const history = r.data?.history as { found: boolean; waypoints: number; reached: number; oldestAgeMs: number };
  assert.equal(history.found, true);
  assert.ok(history.reached >= 2 && history.oldestAgeMs >= 60_000);

  const stale = harness({ blocked: (goal) => goal.kind === 'near' && goal.pos.x === 30 });
  (stale.ctx as { spatial?: unknown }).spatial = { query };
  const s = await travelTo.run(stale.ctx, argsOf({ to: '60,0', via: 'history' }, stale.adapter));
  assert.equal(s.status, 'succeeded', s.summary);
  assert.deepEqual((s.data?.history as { abandonedAt: Vec3Like }).abandonedAt, { x: 30.5, y: 64, z: 20.5 });
  assert.match(s.summary, /已放弃剩余历史路点/);

  const none = harness();
  const d = await travelTo.run(none.ctx, argsOf({ to: '30,0', via: 'history' }, none.adapter));
  assert.equal(d.status, 'succeeded');
  assert.match(d.summary, /没有可用的历史路线/);
});

test('travel_to via:history 拓扑没有路线时沿记录过的路径片段（旧矿道 links）走，竖直阶梯的路点不被水平距离吞掉', async () => {
  // 旧 passage：从 (0,64,0) 往东 4 格，再沿 x=4 螺旋下到 y=40
  const cells = [...Array.from({ length: 5 }, (_, i) => ({ x: i, y: 64, z: 0 })), ...Array.from({ length: 24 }, (_, i) => ({ x: 4, y: 63 - i, z: i % 2 }))];
  const links = cells.slice(1).map((b, i) => ({ a: cells[i]!, b }));
  const fragment = { id: 'psg_old', worldId: 'w', dim: 'overworld', kind: 'dug', entrances: [], polyline: [cells[0]!, cells.at(-1)!], geometrySource: 'legacy', links, deepestY: 40, createdAt: 1, lastUsedAt: 1, uses: 1 };
  const query = (q: { kind: string }) => q.kind === 'fragments'
    ? { status: 'ok', data: { kind: 'fragments', items: [fragment] } }
    : { status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'ENDPOINT_NOT_RECORDED', points: [], segments: [], message: '' } } };
  const h = harness();
  (h.ctx as { spatial?: unknown }).spatial = { query };
  const r = await travelTo.run(h.ctx, argsOf({ to: { x: 4, y: 40, z: 1 }, via: 'history' }, h.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  const history = r.data?.history as { found: boolean; source: string; fragments: string[]; waypoints: number };
  assert.equal(history.source, 'path_fragments');
  assert.deepEqual(history.fragments, ['psg_old']);
  assert.ok(history.waypoints >= 3, `竖直段也有路点：${history.waypoints}`);
  assert.ok(h.calls.filter(({ target }) => target.kind === 'near' && target.pos.x === 4 && target.pos.y < 64).length >= 2, '沿阶梯逐段下行');
  assert.match(r.summary, /记录过的路径片段/);

  const pick = harness();
  (pick.ctx as { spatial?: unknown }).spatial = { query };
  const f = await travelTo.run(pick.ctx, argsOf({ to: { x: 4, y: 40, z: 1 }, via: { fragment: 'psg_old' } }, pick.adapter));
  assert.equal((f.data?.history as { source: string }).source, 'path_fragments');

  const missing = harness();
  (missing.ctx as { spatial?: unknown }).spatial = { query };
  const m = await travelTo.run(missing.ctx, argsOf({ to: { x: 4, y: 40, z: 1 }, via: { fragment: 'nope' } }, missing.adapter));
  assert.equal(m.status, 'failed');
  assert.equal(missing.calls.length, 0, '指定的片段不存在就不移动');
  assert.equal(travelTo.validate({ to: '1,2', via: { fragment: '' } }, h.adapter).ok, false);
});

test('travel_to 剩余主要是高差时不做水平偏转绕圈，直接报目标在下方多少格', async () => {
  const h = harness({ blocked: () => true });
  const r = await travelTo.run(h.ctx, argsOf({ to: { x: 3, y: 10, z: 0 } }, h.adapter));
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.stopReason, 'VERTICAL_GAP');
  assert.equal(h.calls.length, 1, '只试正前方一跳，不按水平坐标偏转');
  assert.match(r.summary, /目标在下方 54 格/);
});

test('travel_to 已加载范围内的三维目标直接以真实目标寻路，不先走一个只按水平方向定的中间点', async () => {
  const h = harness();
  await travelTo.run(h.ctx, argsOf({ to: { x: 40, y: 87, z: 0 }, range: 3 }, h.adapter));
  assert.deepEqual(h.calls[0]!.target, { kind: 'near', pos: { x: 40, y: 87, z: 0 }, range: 3 });
});

test('travel_to 超出直接寻路范围的三维目标：中间跳限制终点高度，不让一跳带着下到矿道', async () => {
  const h = harness();
  await travelTo.run(h.ctx, argsOf({ to: { x: 100, y: 87, z: 0 }, range: 3 }, h.adapter));
  const hop = h.calls[0]!.target;
  assert.equal(hop.kind, 'xz');
  // 出发 y64、目标 y87：高差 23，允许最多再多一次行走下落（4 格）
  assert.deepEqual(hop.kind === 'xz' ? hop.footY : null, [87 - 27, 87 + 27]);
  const flat = harness();
  await travelTo.run(flat.ctx, argsOf({ to: { x: 40, z: 0 } }, flat.adapter));
  const free = flat.calls[0]!.target;
  assert.equal(free.kind === 'xz' ? free.footY : 'not-xz', undefined, '只给水平坐标的目标不约束高度');
});

test('travel_to 沿历史片段遇到竖井走不通时，放弃路点并说明是多少格的直上直下段', async () => {
  const cells = [...Array.from({ length: 4 }, (_, i) => ({ x: i, y: 64, z: 0 })), ...Array.from({ length: 24 }, (_, i) => ({ x: 3, y: 63 - i, z: 0 }))];
  const fragment = { id: 'shaft', worldId: 'w', dim: 'overworld', kind: 'dug', entrances: [], polyline: [cells[0]!], geometrySource: 'legacy',
    links: cells.slice(1).map((b, i) => ({ a: cells[i]!, b })), deepestY: 40, createdAt: 1, lastUsedAt: 1, uses: 1 };
  const query = (q: { kind: string }) => q.kind === 'fragments'
    ? { status: 'ok', data: { kind: 'fragments', items: [fragment] } }
    : { status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'ENDPOINT_NOT_RECORDED', points: [], segments: [], message: '' } } };
  const h = harness({ blocked: (goal) => goal.kind === 'near' && goal.pos.y < 60 });
  (h.ctx as { spatial?: unknown }).spatial = { query };
  const r = await travelTo.run(h.ctx, argsOf({ to: { x: 3, y: 40, z: 0 }, via: { fragment: 'shaft' } }, h.adapter));
  assert.equal(r.status, 'failed');
  const history = r.data?.history as { abandonedAt: Vec3Like; verticalRun: number };
  assert.ok(history.verticalRun > 4, JSON.stringify(history));
  assert.match(r.summary, /直上直下的竖直段/);
  assert.ok(h.calls.filter(({ target }) => target.kind === 'xz').length === 0, '高差为主，不做水平偏转');
});

test('travel_to 不下水时限制单跳绕路；授权游泳时不加上限（水格代价高，加了等于不让游）', async () => {
  const dry = harness();
  await travelTo.run(dry.ctx, argsOf({ to: '30,0' }, dry.adapter));
  assert.equal(dry.calls[0].opts.searchRadius, 48);
  const wet = harness();
  await travelTo.run(wet.ctx, argsOf({ to: '30,0', allowSwim: true }, wet.adapter));
  assert.equal(wet.calls[0].opts.searchRadius, undefined);
  assert.equal(wet.calls[0].opts.allowSwimming, undefined);
});

test('travel_to 没授权下水却掉进水里：立刻停下报 IN_WATER 与氧气，不再继续分跳', async () => {
  const h = harness({ fallInAfter: 1 });
  const r = await travelTo.run(h.ctx, argsOf({ to: '100,0' }, h.adapter));
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.stopReason, 'IN_WATER');
  assert.equal(r.failureCode, 'STUCK');
  assert.match(r.summary, /进了水，已停下，氧气 12\/20/);
  assert.equal(h.calls.length, 2, '掉进水的那一跳之后不再发新的寻路');
});

test('travel_to allowHazard:true 时不额外加岩浆边代价', async () => {
  const h = harness();
  await travelTo.run(h.ctx, argsOf({ to: '30,0', allowHazard: true }, h.adapter));
  assert.equal(h.calls[0].opts.lavaEdgeCost, undefined);
});

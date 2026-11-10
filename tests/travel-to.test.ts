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

test('travel_to via:history 按自己走过的历史路线路点分跳；路点走不通就停在实测进度并报该路点', async () => {
  const points = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 20.5 }, { x: 30.5, y: 64, z: 20.5 }, { x: 60.5, y: 64, z: 0.5 }];
  const query = () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } });
  const viaHistory = harness();
  (viaHistory.ctx as { spatial?: unknown }).spatial = { query };
  const r = await travelTo.run(viaHistory.ctx, argsOf({ to: '60,0', via: 'history' }, viaHistory.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(viaHistory.calls.some(({ target }) => target.kind === 'xz' && target.range === 0 && target.z === 20), '先朝历史路点走');
  const history = r.data?.history as { found: boolean; waypoints: number; reached: number; oldestAgeMs: number };
  assert.equal(history.found, true);
  assert.ok(history.reached >= 2 && history.oldestAgeMs >= 59_000, JSON.stringify(history));

  const stale = harness({ blocked: (goal) => goal.kind === 'xz' && goal.range === 0 && goal.x === 30 && goal.z === 20 });
  (stale.ctx as { spatial?: unknown }).spatial = { query };
  const s = await travelTo.run(stale.ctx, argsOf({ to: '60,0', via: 'history' }, stale.adapter));
  assert.equal(s.status, 'failed', s.summary);
  assert.equal(s.data?.stopReason, 'HISTORY_STOPPED');
  assert.deepEqual((s.data?.history as { failedAt: Vec3Like }).failedAt, { x: 30.5, y: 64, z: 20.5 });
  assert.match(s.summary, /没有丢下剩余路点改挖新通道/);
  assert.ok(stale.calls.every(({ opts }) => opts.allowTerrainChanges === undefined || opts.allowTerrainChanges === false), '跟随历史路点时不施工');

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
  assert.ok(h.calls.filter(({ target }) => target.kind === 'xz' && target.range === 0 && target.x === 4 && (target.footY?.[0] ?? 64) < 64).length >= 2, '沿阶梯逐段下行');
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

test('travel_to 直走没到时回报记录里有没有沿走过的路通往目标，不自动改走历史路线', async () => {
  const cells = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 64, z: 0 }));
  const links = cells.slice(1).map((b, i) => ({ a: cells[i]!, b }));
  const fragment = { id: 'psg_walk', worldId: 'w', dim: 'overworld', kind: 'walked', entrances: [], polyline: [cells[0]!, cells.at(-1)!], geometrySource: 'legacy', links, deepestY: 64, createdAt: 1, lastUsedAt: 1, uses: 1 };
  const query = (q: { kind: string }) => q.kind === 'fragments' ? { status: 'ok', data: { kind: 'fragments', items: [fragment] } } : { status: 'ok', data: null };
  const h = harness({ blocked: () => true });
  (h.ctx as { spatial?: unknown }).spatial = { query };
  const r = await travelTo.run(h.ctx, argsOf({ to: { x: 29, z: 0 }, via: 'direct' }, h.adapter));
  assert.equal(r.status, 'failed');
  assert.ok(h.calls.every(({ target }) => target.kind !== 'near'), '明确写 direct 时没有擅自沿历史路点走');
  assert.deepEqual((r.data?.recordedRoute as { fragments: string[] }).fragments, ['psg_walk']);
  assert.match(r.summary, /记录里有从你附近出发.*via:"history" 会沿它走/);

  const none = harness({ blocked: () => true });
  (none.ctx as { spatial?: unknown }).spatial = { query: () => ({ status: 'ok', data: { kind: 'fragments', items: [] } }) };
  const n = await travelTo.run(none.ctx, argsOf({ to: { x: 29, z: 0 }, via: 'direct' }, none.adapter));
  assert.equal(n.data?.recordedRoute, undefined);
  assert.doesNotMatch(n.summary, /记录里有从你附近/);
});

test('travel_to 不写 via 时按 auto：记录路线算上离路代价更省就按它的路点走，不省就直接走', async () => {
  const cells = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 64, z: 0 }));
  const links = cells.slice(1).map((b, i) => ({ a: cells[i]!, b }));
  const road = { id: 'psg_walk', worldId: 'w', dim: 'overworld', kind: 'walked', entrances: [], polyline: [cells[0]!, cells.at(-1)!], geometrySource: 'legacy', links, deepestY: 64, createdAt: 1, lastUsedAt: 1, uses: 1 };
  const spatialWith = (items: unknown[]) => ({ query: (q: { kind: string }) => q.kind === 'fragments' ? { status: 'ok', data: { kind: 'fragments', items } } : { status: 'ok', data: null } });
  const parsed = travelTo.validate({ to: { x: 29, z: 0 } }, harness().adapter);
  assert.ok(parsed.ok && parsed.args.via === 'auto', '默认 auto');

  const along = harness();
  (along.ctx as { spatial?: unknown }).spatial = spatialWith([road]);
  const r = await travelTo.run(along.ctx, argsOf({ to: { x: 29, z: 0 } }, along.adapter));
  assert.equal((r.data?.history as { found: boolean }).found, true);
  assert.ok(along.calls.some(({ target }) => target.kind === 'xz' && target.range === 0), '按记录的路点分跳');

  // 记录方向与目标相反：沿它走不省，直接走，不被带偏。
  const backwards = Array.from({ length: 30 }, (_, i) => ({ x: -i, y: 64, z: 0 }));
  const away = { ...road, id: 'psg_away', polyline: [backwards[0]!, backwards.at(-1)!], links: backwards.slice(1).map((b, i) => ({ a: backwards[i]!, b })) };
  const direct = harness();
  (direct.ctx as { spatial?: unknown }).spatial = spatialWith([away]);
  const d = await travelTo.run(direct.ctx, argsOf({ to: { x: 29, z: 0 } }, direct.adapter));
  assert.equal((d.data?.history as { found: boolean }).found, false);
  assert.ok(direct.calls.every(({ target }) => target.kind !== 'near'), '不按反方向的记录路点走');
});

test('auto 实际使用 U 形长旧路连接相距很近的两端，不因直线更短而退回直穿', async () => {
  const u = [
    ...Array.from({ length: 26 }, (_, i) => ({ x: i, y: 64, z: 0 })),
    ...Array.from({ length: 10 }, (_, i) => ({ x: 25, y: 64, z: i + 1 })),
    ...Array.from({ length: 26 }, (_, i) => ({ x: 25 - i, y: 64, z: 10 })),
  ];
  const fragment = { id: 'u_road', worldId: 'w', dim: 'overworld', kind: 'walked', entrances: [], polyline: [u[0]!],
    geometrySource: 'legacy', links: u.slice(1).map((b, i) => ({ a: u[i]!, b })), deepestY: 64, createdAt: 1, lastUsedAt: 1, uses: 1 };
  const h = harness();
  (h.ctx as { spatial?: unknown }).spatial = { query: (q: { kind: string }) => q.kind === 'fragments' ? { status: 'ok', data: { kind: 'fragments', items: [fragment] } } : { status: 'ok', data: null } };
  const r = await travelTo.run(h.ctx, argsOf({ to: { x: 0, z: 10 } }, h.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  const history = r.data?.history as { found: boolean; status: string; points: number };
  assert.equal(history.found, true);
  assert.equal(history.status, 'FOUND');
  assert.ok(history.points > 40, `沿真实 U 形记录走，实际 ${history.points} 点`);
  assert.ok(h.calls[0]?.target.kind === 'xz' && h.calls[0].target.range === 0, '从实际记录锚点沿旧路走');
});

test('auto 用同一 3D 口径保留垂直/斜向 PARTIAL 旧路，不因水平距离为零就下矿直挖', async () => {
  const vertical = Array.from({ length: 25 }, (_, i) => ({ x: 0, y: 64 - i, z: 0 }));
  const vf = { id: 'stairs_down', worldId: 'w', dim: 'overworld', kind: 'dug', entrances: [], polyline: [vertical[0]!],
    geometrySource: 'legacy', links: vertical.slice(1).map((b, i) => ({ a: vertical[i]!, b })), deepestY: 40, createdAt: 1, lastUsedAt: 1, uses: 1 };
  const verticalH = harness();
  (verticalH.ctx as { spatial?: unknown }).spatial = { query: (q: { kind: string }) => q.kind === 'fragments' ? { status: 'ok', data: { kind: 'fragments', items: [vf] } } : { status: 'ok', data: null } };
  const vr = await travelTo.run(verticalH.ctx, argsOf({ to: { x: 0, y: 10, z: 0 } }, verticalH.adapter));
  assert.equal(vr.status, 'succeeded', vr.summary);
  const vh = vr.data?.history as { found: boolean; status: string; targetRecorded: boolean };
  assert.equal(vh.found, true);
  assert.equal(vh.status, 'PARTIAL');
  assert.equal(vh.targetRecorded, false);
  assert.ok(verticalH.calls.some(({ target }) => target.kind === 'xz' && target.range === 0 && (target.footY?.[0] ?? 64) < 50), '沿旧阶梯下降到下层');

  const diagonal = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 64 - i, z: i }));
  const df = { id: 'diag_down', worldId: 'w', dim: 'overworld', kind: 'dug', entrances: [], polyline: [diagonal[0]!],
    geometrySource: 'legacy', links: diagonal.slice(1).map((b, i) => ({ a: diagonal[i]!, b })), deepestY: 45, createdAt: 1, lastUsedAt: 1, uses: 1 };
  const diagonalH = harness();
  (diagonalH.ctx as { spatial?: unknown }).spatial = { query: (q: { kind: string }) => q.kind === 'fragments' ? { status: 'ok', data: { kind: 'fragments', items: [df] } } : { status: 'ok', data: null } };
  const dr = await travelTo.run(diagonalH.ctx, argsOf({ to: { x: 22, y: 40, z: 22 } }, diagonalH.adapter));
  assert.equal(dr.status, 'succeeded', dr.summary);
  assert.equal((dr.data?.history as { found: boolean }).found, true);
});

test('travel_to/explore_toward 的 tool 原样交给寻路挖掘；需要 allowDig、背包里得有', async () => {
  const h = harness({ blocked: (_goal, _from, opts) => opts.allowTerrainChanges !== true });
  (h.adapter as { state: () => unknown }).state = ((orig) => () => ({ ...(orig() as object), inventory: [{ name: 'stone_pickaxe', count: 1 }] }))(h.adapter.state.bind(h.adapter));
  await travelTo.run(h.ctx, argsOf({ to: { x: 10, z: 0 }, allowDig: true, tool: 'stone_pickaxe' }, h.adapter));
  assert.equal(h.calls[0]!.opts.digTool, undefined, '无施工搜索不指定挖掘工具');
  assert.equal(h.calls[1]!.opts.digTool, 'stone_pickaxe');
  assert.equal(h.calls[1]!.opts.allowTerrainChanges, true);
  assert.match(String((travelTo.validate({ to: '10,0', tool: 'stone_pickaxe' }, h.adapter) as { error?: string }).error), /需要同时写 allowDig:true/);
  assert.match(String((travelTo.validate({ to: '10,0', allowDig: true, tool: 'iron_pickaxe' }, h.adapter) as { error?: string }).error), /TOOL_MISSING/);
  const plain = harness();
  await travelTo.run(plain.ctx, argsOf({ to: { x: 10, z: 0 }, allowDig: true }, plain.adapter));
  assert.equal(plain.calls[0]!.opts.digTool, undefined, '不写就不指定，按身体的工具选择规则');
  assert.equal(plain.calls[0]!.opts.allowTerrainChanges, false, '纯步行能走就不升级施工');
  assert.equal(plain.calls.length, 1);
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
  const h = harness({ blocked: (goal) => goal.kind === 'xz' && goal.range === 0 && (goal.footY?.[0] ?? 64) < 60 });
  (h.ctx as { spatial?: unknown }).spatial = { query };
  const r = await travelTo.run(h.ctx, argsOf({ to: { x: 3, y: 40, z: 0 }, via: { fragment: 'shaft' } }, h.adapter));
  assert.equal(r.status, 'failed');
  const history = r.data?.history as { failedAt: Vec3Like; verticalRun: number };
  assert.ok(history.failedAt, JSON.stringify(history));
  assert.ok(history.verticalRun > 4, JSON.stringify(history));
  assert.match(r.summary, /直上直下的竖直段/);
  assert.ok(h.calls.filter(({ target }) => target.kind === 'xz' && target.range !== 0).length === 0, '高差为主，不做水平偏转');
});

test('travel_to 不下水时限制单跳绕路；授权游泳时不加上限（水格代价高，加了等于不让游）', async () => {
  const dry = harness();
  await travelTo.run(dry.ctx, argsOf({ to: '30,0' }, dry.adapter));
  assert.equal(dry.calls[0].opts.searchRadius, 48);
  const wet = harness();
  await travelTo.run(wet.ctx, argsOf({ to: '30,0', allowSwim: true }, wet.adapter));
  assert.equal(wet.calls[0].opts.searchRadius, undefined);
  assert.equal(wet.calls[0].opts.allowSwimming, undefined);
  // 授权了施工时，纯步行试探仍不人为裁剪 searchRadius：已加载区块里走得通的绕路不能被 48 格上限误报 noPath。
  for (const extra of [{ allowDig: true }, { allowPlace: true }]) {
    const h = harness();
    await travelTo.run(h.ctx, argsOf({ to: '30,0', ...extra }, h.adapter));
    assert.equal(h.calls[0].opts.searchRadius, undefined, JSON.stringify(extra));
    assert.equal(h.calls[0].opts.allowTerrainChanges, false);
  }
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

test('历史路点按顺序实际到达才推进：回头弯和三维更近的后续点都不能跳过必经点', async () => {
  const queryFor = (points: Vec3Like[]) => () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } });
  const bendPoints = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 20.5 }, { x: 4.5, y: 64, z: 0.5 }, { x: 60.5, y: 64, z: 0.5 }];
  const bend = harness();
  (bend.ctx as { spatial?: unknown }).spatial = { query: queryFor(bendPoints) };
  const r = await travelTo.run(bend.ctx, argsOf({ to: '60,0', via: 'history' }, bend.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(bend.calls.find(({ target }) => target.kind === 'xz' && target.range === 0)?.target, { kind: 'xz', x: 0, z: 20, range: 0, footY: [64, 65] });

  const threeD = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 20.5 }, { x: 0.5, y: 70, z: 10.5 }];
  const down = harness();
  (down.ctx as { spatial?: unknown }).spatial = { query: queryFor(threeD) };
  const d = await travelTo.run(down.ctx, argsOf({ to: { x: 0, y: 70, z: 10 }, via: 'history' }, down.adapter));
  assert.equal(d.status, 'succeeded', d.summary);
  assert.deepEqual(down.calls.find(({ target }) => target.kind === 'xz' && target.range === 0)?.target, { kind: 'xz', x: 0, z: 20, range: 0, footY: [64, 65] }, '三维更近的后续点不能跳过先记录的路点');
});

test('历史路点用精确脚格目标：小位移拐点不丢，平行隔墙和上下重叠矿道不能提前跳过', async () => {
  const queryFor = (points: Vec3Like[]) => () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } });

  // 3 格后的 90° 拐点：按 8 格抽稀会被丢掉，必须作为精确路点保留。
  const smallCorner = [{ x: 0.5, y: 64, z: 0.5 }, { x: 3.5, y: 64, z: 0.5 }, { x: 3.5, y: 64, z: 1.5 }, { x: 20.5, y: 64, z: 1.5 }];
  const cornerH = harness();
  (cornerH.ctx as { spatial?: unknown }).spatial = { query: queryFor(smallCorner) };
  await travelTo.run(cornerH.ctx, argsOf({ to: '20,1', via: 'history' }, cornerH.adapter));
  const historyTargets = (h: typeof cornerH) => h.calls.flatMap(({ target }) => target.kind === 'xz' && target.range === 0 ? [{ x: target.x, z: target.z, footY: target.footY }] : []);
  assert.ok(historyTargets(cornerH).some((p) => p.x === 3 && p.z === 0), '小位移拐点要保留');
  assert.ok(historyTargets(cornerH).some((p) => p.x === 3 && p.z === 1));

  // 平行隔墙：身体在 x=0 走廊，路点 x=2 只隔一堵墙；旧 range/3 格会提前宣布经过。
  const walled = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 5.5 }, { x: 2.5, y: 64, z: 5.5 }, { x: 2.5, y: 64, z: 10.5 }];
  const wallH = harness();
  (wallH.ctx as { spatial?: unknown }).spatial = { query: queryFor(walled) };
  await travelTo.run(wallH.ctx, argsOf({ to: '2,10', via: 'history' }, wallH.adapter));
  assert.ok(historyTargets(wallH).some((p) => p.x === 2 && p.z === 5), '不能因为隔墙 2 格就跳过另一侧路点');

  // 上下重叠矿道：同一 x/z，下一记录点高 2 格；不能按欧氏距离近提前跳过。
  const stacked = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 5.5 }, { x: 0.5, y: 68, z: 5.5 }];
  const stackH = harness();
  (stackH.ctx as { spatial?: unknown }).spatial = { query: queryFor(stacked) };
  await travelTo.run(stackH.ctx, argsOf({ to: { x: 0, y: 68, z: 5 }, via: 'history' }, stackH.adapter));
  assert.ok(historyTargets(stackH).some((p) => p.x === 0 && p.z === 5 && p.footY?.[0] === 68), '上层矿道必须作为独立脚高路点');
});

test('到达身后 1 格的首个历史拐点立即推进并算进展，不判循环', async () => {
  const points = [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 10.5 }];
  const h = harness();
  (h.ctx as { spatial?: unknown }).spatial = { query: () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } }) };
  const r = await travelTo.run(h.ctx, argsOf({ to: '1,10', via: 'history' }, h.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(((r.data?.history as { reached: number }).reached ?? 0) >= 1);
});

test('连续 1 格历史拐点/阶梯到达后依次推进，不因回访半径误停', async () => {
  const points = [
    { x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 1.5 },
    { x: 2.5, y: 64, z: 1.5 }, { x: 2.5, y: 64, z: 2.5 }, { x: 3.5, y: 64, z: 2.5 },
    { x: 3.5, y: 64, z: 3.5 }, { x: 4.5, y: 64, z: 3.5 }, { x: 4.5, y: 64, z: 4.5 }, { x: 5.5, y: 64, z: 5.5 },
  ];
  const h = harness();
  (h.ctx as { spatial?: unknown }).spatial = { query: () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } }) };
  const r = await travelTo.run(h.ctx, argsOf({ to: '5,5', via: 'history', range: 1 }, h.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  const history = r.data?.history as { reached: number; waypoints: number };
  assert.equal(history.reached, history.waypoints);
});

test('最终历史路点到达时 reached 不少计：1/1 与 5/5', async () => {
  const one = [{ x: 0.5, y: 64, z: 0.5 }, { x: 2.5, y: 64, z: 0.5 }];
  const oneH = harness();
  (oneH.ctx as { spatial?: unknown }).spatial = { query: () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points: one, segments: [{ evidence: { observedAt: Date.now() - 60_000 } }], message: '' } } }) };
  const oneR = await travelTo.run(oneH.ctx, argsOf({ to: '2,0', via: 'history', range: 1 }, oneH.adapter));
  const oneHistory = oneR.data?.history as { reached: number; waypoints: number };
  assert.equal(oneHistory.waypoints, 1);
  assert.equal(oneHistory.reached, 1);

  const many = [{ x: 0.5, y: 64, z: 0.5 }, ...Array.from({ length: 5 }, (_, i) => ({ x: 0.5, y: 64, z: 20.5 + i * 20 }))];
  const manyH = harness();
  (manyH.ctx as { spatial?: unknown }).spatial = { query: () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points: many, segments: many.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } }) };
  const manyR = await travelTo.run(manyH.ctx, argsOf({ to: '0,100', via: 'history' }, manyH.adapter));
  const manyHistory = manyR.data?.history as { reached: number; waypoints: number };
  assert.equal(manyHistory.waypoints, 5);
  assert.equal(manyHistory.reached, 5);
});

test('历史路点没有到达时，A/B 往返会及时止损；合法绕远但向路点推进仍继续', async () => {
  const points = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 20.5 }, { x: 60.5, y: 64, z: 0.5 }];
  const query = () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } });
  let flip = 1;
  const loop = harness();
  (loop.ctx as { spatial?: unknown }).spatial = { query };
  loop.adapter.moveTo = (async (target: MoveTarget, opts: MoveOpts) => {
    loop.calls.push({ target, opts, from: { x: 0.5, y: 64, z: 0.5 } });
    flip = -flip;
    (loop.adapter as unknown as { state: () => Record<string, unknown> }).state = () => ({
      pos: flip > 0 ? { x: 0.5, y: 64, z: 10.5 } : { x: 10.5, y: 64, z: 10.5 },
      dim: 'overworld', worldId: 'w', alive: true, connected: true, riding: null, inWater: false, oxygen: 20,
    });
  }) as typeof loop.adapter.moveTo;
  const l = await travelTo.run(loop.ctx, argsOf({ to: '60,0', via: 'history' }, loop.adapter));
  assert.equal(l.data?.stopReason, 'NO_PROGRESS');
  assert.ok(loop.calls.length <= 4, `同一未到路点往返不应一直豁免，实际 ${loop.calls.length} 跳`);
  assert.equal((l.data?.history as { reached: number }).reached, 0);

  const detourPoints = [{ x: 0.5, y: 64, z: 0.5 }, { x: 20.5, y: 64, z: 0.5 }, { x: -20.5, y: 64, z: 0.5 }];
  const detour = harness();
  (detour.ctx as { spatial?: unknown }).spatial = { query: () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points: detourPoints, segments: detourPoints.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } }) };
  const d = await travelTo.run(detour.ctx, argsOf({ to: '-20,0', via: 'history' }, detour.adapter));
  assert.equal(d.status, 'succeeded', d.summary);
  assert.ok(((d.data?.history as { reached: number }).reached ?? 0) >= 1);
});

test('跟随旧路时即使 allowDig/allowPlace=true 也全程不用施工', async () => {
  const points = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 20.5 }, { x: 30.5, y: 64, z: 20.5 }];
  const h = harness();
  (h.ctx as { spatial?: unknown }).spatial = { query: () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } }) };
  const r = await travelTo.run(h.ctx, argsOf({ to: '30,20', via: 'history', allowDig: true, allowPlace: true }, h.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(h.calls.every(({ opts }) => opts.allowTerrainChanges !== true && opts.allowPlace !== true && opts.allowTower !== true));
  assert.equal(r.data?.constructionRetries, 0);
});

test('跟随旧路失败时不转施工，保留失败路点和实测进度', async () => {
  const points = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 20.5 }, { x: 30.5, y: 64, z: 20.5 }];
  const h = harness({ blocked: (goal) => goal.kind === 'xz' && goal.range === 0 && goal.x === 30 && goal.z === 20 });
  (h.ctx as { spatial?: unknown }).spatial = { query: () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } }) };
  const r = await travelTo.run(h.ctx, argsOf({ to: '30,20', via: 'history', allowDig: true, allowPlace: true }, h.adapter));
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.stopReason, 'HISTORY_STOPPED');
  assert.equal(r.data?.constructionRetries, 0);
  assert.ok(h.calls.every(({ opts }) => opts.allowTerrainChanges !== true && opts.allowPlace !== true));
  assert.deepEqual((r.data?.history as { failedAt: Vec3Like }).failedAt, { x: 30.5, y: 64, z: 20.5 });
  assert.ok(((r.data?.history as { reached: number }).reached ?? 0) >= 1, '保留已经到达的路点数');
  assert.match(r.summary, /没有丢下剩余路点改挖新通道/);
});

test('历史失败按真实异常分类：普通 No path 文本/超时/未确认不映射成无路', async () => {
  const points = [{ x: 0.5, y: 64, z: 0.5 }, { x: 0.5, y: 64, z: 20.5 }];
  const query = () => ({ status: 'ok', data: { kind: 'historyRoute', inspection: { status: 'FOUND', points, segments: points.slice(1).map(() => ({ evidence: { observedAt: Date.now() - 60_000 } })), message: '' } } });
  const cases: [string, Error, string, string][] = [
    ['plain text', new Error('No path: 普通错误'), 'ERROR', 'ERROR'],
    ['timeout', Object.assign(new Error('TIMEOUT'), { name: 'Timeout' }), 'TIMEOUT', 'TIMEOUT'],
    ['not confirmed', new Error('NOT_CONFIRMED: 没站稳'), 'NOT_CONFIRMED', 'EFFECT_NOT_CONFIRMED'],
  ];
  for (const [label, error, kind, code] of cases) {
    const h = harness({ fail: (goal) => goal.kind === 'xz' && goal.range === 0 ? error : undefined });
    (h.ctx as { spatial?: unknown }).spatial = { query };
    const r = await travelTo.run(h.ctx, argsOf({ to: '0,20', via: 'history' }, h.adapter));
    assert.equal(r.status, 'failed', label);
    assert.equal(r.failureCode, code, label);
    assert.equal((r.data?.history as { failedKind: string }).failedKind, kind, label);
    assert.equal(r.data?.constructionRetries, 0, label);
  }
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
  const r = await travelTo.run(explicit.ctx, argsOf({ to: '30,0', via: 'direct', allowDig: true }, explicit.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(explicit.calls[0]?.opts.allowTerrainChanges, true, 'via:direct 是显式按既有授权直接寻路');
});

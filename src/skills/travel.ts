import type { Vec3Like } from '../adapter/types.ts';
import { travelStore, type PortalEndpoint } from '../travel/store.ts';
import { dist3, sleep, throwIfAborted } from '../util.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const TERRAIN = new Set(['dirt', 'grass_block', 'stone', 'cobblestone', 'deepslate', 'netherrack', 'sand', 'gravel']);
/** 传送门记进常规记忆（地标）时用的中文名 */
const PORTAL_LABEL: Record<PortalEndpoint['kind'], string> = { nether_portal: '下界门', end_portal: '末地门', end_gateway: '末地折跃门' };

function visiblePortal(ctx: SkillCtx, positions: Vec3Like[], kinds: string[]) {
  for (let offset = 0; offset < positions.length; offset += 32) {
    const portal = ctx.senses.observeBlocks?.(positions.slice(offset, offset + 32)).find((block) => kinds.includes(block.name));
    if (portal) return portal;
  }
  return undefined;
}

/** 把当前世界已记录的门列成一行，供 agent 自己挑（不替它改选目标） */
function knownPortals(store: ReturnType<typeof travelStore>, worldId: string) {
  return store.snapshot(worldId).endpoints.map((e) => `${e.id}（${e.dim} ${e.pos.x},${e.pos.y},${e.pos.z}）`).join('；') || '（还没有记录任何门）';
}

export const buildPortal: Skill<{ origin: Vec3Like; axis: 'x' | 'z' }> = {
  name: 'build_portal',
  description: '在身边用 10 块黑曜石建最小下界门并用打火石点燃；逐块验收，记录实际门位置。需要少量施工支撑块。',
  argsDoc: '{"origin"?:{"x":number,"y":number,"z":number},"axis"?:"x"|"z"}',
  timeoutMs: 180000, movement: true,
  validate(raw, adapter) {
    const value = obj(raw);
    const here = adapter.state().pos;
    const origin = value.origin ?? { x: Math.floor(here.x) + 3, y: Math.floor(here.y) - 1, z: Math.floor(here.z) };
    if (![origin.x, origin.y, origin.z].every(Number.isInteger) || dist3(origin, here) > 24) return { ok: false, error: 'origin 必须是 24 格内的整数坐标' };
    if (value.axis !== undefined && value.axis !== 'x' && value.axis !== 'z') return { ok: false, error: 'axis 必须是 x 或 z' };
    return { ok: true, args: { origin, axis: value.axis ?? 'x' } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    const state = adapter.state();
    if (state.dim === 'the_end') return fail('WRONG_DIMENSION', '末地不能激活下界门');
    if (!adapter.useBlockAt) return fail('ERROR', '适配器没有方块交互能力');
    if (!state.inventory.some((i) => i.name === 'flint_and_steel' && i.count > 0)) return fail('MISSING_MATERIALS', '缺少打火石');
    const at = (u: number, y: number): Vec3Like => ({ x: args.origin.x + (args.axis === 'x' ? u : 0), y: args.origin.y + y, z: args.origin.z + (args.axis === 'z' ? u : 0) });
    const frame = [[1, 0], [2, 0], ...[1, 2, 3].flatMap((y) => [[0, y], [3, y]]), [1, 4], [2, 4]].map(([u, y]) => at(u, y));
    const needed = frame.filter((p) => adapter.blockAt(p) !== 'obsidian').length;
    const partialLabel = `未完成的下界门框（axis=${args.axis}）`;
    // 这里已经摆过黑曜石（部分/完整门框）：无论这次缺不缺料都先记下位置，回来能补全；点着后清掉
    if (needed < frame.length) ctx.memory.addLandmark('discovery', partialLabel, state.dim, args.origin, 1);
    if ((state.inventory.find((i) => i.name === 'obsidian')?.count ?? 0) < needed) return fail('MISSING_MATERIALS', `还缺 ${needed} 块黑曜石用于门框（背包现有 ${state.inventory.find((i) => i.name === 'obsidian')?.count ?? 0} 块；之前失败的门框上可能还摆着黑曜石，先用钻石镐挖回来凑数）`);
    for (let y = 1; y <= 4; y++) for (let u = 0; u <= 3; u++) {
      const name = adapter.blockAt(at(u, y));
      const isFrame = frame.some((p) => dist3(p, at(u, y)) === 0);
      if (!name || (!AIR.has(name) && !(isFrame && name === 'obsidian'))) return fail('BAD_ARGS', '门框或内部空间被占用，换一个已观察到的空地');
    }
    // 这次要开始立框（新开工），也记下：中途失败/被中断都能回同一处补全
    ctx.memory.addLandmark('discovery', partialLabel, state.dim, args.origin, 1);
    let placed = 0;
    const place = async (pos: Vec3Like, name: string) => {
      throwIfAborted(signal);
      await adapter.moveTo({ kind: 'place_block', pos }, { signal, timeoutMs: 20000 });
      const result = await adapter.placeBlockAt(pos, [name], signal);
      if (!result.ok || adapter.blockAt(pos) !== name) throw new Error(result.reason ?? `PLACEMENT_MISMATCH:${name}`);
    };
    try {
      for (const u of [1, 2]) {
        const pos = at(u, 0);
        const name = adapter.blockAt(pos);
        if (name === 'obsidian') continue;
        if (name && !AIR.has(name)) {
          if (!TERRAIN.has(name)) return fail('BAD_ARGS', `门底部包含受保护方块 ${name}`);
          await adapter.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 20000 });
          const result = await adapter.dig(pos, signal);
          if (!result.ok) return fail('ERROR', `无法准备门底：${result.reason}`);
        }
      }
      const scaffold = () => adapter.state().inventory.find((i) => ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate'].includes(i.name) && i.count > 0)?.name;
      // 斜坡/坑地上底座悬空：给底座 4 列从实心地往上垫到 y=-1，让底座方块有处可贴
      for (let u = 0; u <= 3; u++) {
        let solid: number | null = null;
        for (let yy = 0; yy >= -8; yy--) {
          const n = adapter.blockAt(at(u, yy));
          if (n === null) continue;
          if (!AIR.has(n)) { solid = yy; break; }
        }
        if (solid === null) return fail('NOT_FOUND', `底座第 ${u} 列下方 8 格都是空的（太陡或悬空），换一块更平的地再立门`);
        for (let yy = solid + 1; yy <= -1; yy++) {
          const m = scaffold();
          if (!m) return fail('MISSING_MATERIALS', '底座悬空，缺脚手架方块（圆石/泥土）垫平');
          await place(at(u, yy), m);
        }
      }
      for (const [u, y] of [[0, 0], [3, 0]]) {
        const pos = at(u, y);
        const current = adapter.blockAt(pos);
        if (!current) return fail('NOT_FOUND', '支撑位置尚未加载');
        if (AIR.has(current)) { const material = scaffold(); if (!material) return fail('MISSING_MATERIALS', '缺少施工支撑块'); await place(pos, material); }
      }
      for (const pos of frame.slice(0, 8)) {
        if (adapter.blockAt(pos) !== 'obsidian') { await place(pos, 'obsidian'); placed++; }
        ctx.progress(placed / 11, '门框逐块验收');
      }
      const material = scaffold();
      if (!material) return fail('MISSING_MATERIALS', '门顶施工需要一块支撑材料', { placed });
      await place(at(0, 4), material);
      for (const pos of frame.slice(8)) { if (adapter.blockAt(pos) !== 'obsidian') { await place(pos, 'obsidian'); placed++; } }
      if (frame.some((pos) => adapter.blockAt(pos) !== 'obsidian')) return fail('ERROR', '门框实际方块未通过验收', { placed });
      const ignited = await adapter.useBlockAt(at(1, 0), 'flint_and_steel', signal);
      if (!ignited.ok) return fail('ERROR', `无法点燃门：${ignited.reason}`, { placed });
      for (let tries = 0; tries < 10; tries++) {
        if (adapter.blockAt(at(1, 1)) === 'nether_portal') {
          const portal = travelStore(ctx.memory).observe(adapter.state(), at(1, 1), 'nether_portal');
          ctx.memory.addLandmark('discovery', `下界门 ${portal.id}`, state.dim, portal.pos, 4);
          for (const l of ctx.memory.landmarks()) {
            if (l.label === partialLabel && l.dim === state.dim && dist3(l.pos, args.origin) <= 1) ctx.memory.removeLandmark(l.id);
          }
          return ok(`下界门已点燃并验收：${portal.id}`, { portalId: portal.id, placed, obsidianFrame: frame });
        }
        await sleep(200, signal);
      }
      return fail('ERROR', '门框存在但没有观察到激活后的传送门', { placed });
    } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `建门中断：${(error as Error).message}`, { placed }); }
  },
};

export const observePortal: Skill<{}> = {
  name: 'observe_portal', description: '记录亲眼见过且当前能核对的下界门或末地门；不会猜测另一端的位置。', argsDoc: '{}', timeoutMs: 15000, movement: false,
  validate: () => ({ ok: true, args: {} }),
  async run(ctx) {
    ctx.senses.refresh();
    const state = ctx.adapter.state();
    const kinds = ['nether_portal', 'end_portal', 'end_gateway'];
    // 先扫当前视野里看得见的门（记忆可能因死亡/换维度而失效，眼前看得见的才是此刻能核对的），再看记忆里的门位置重验
    const here = state.pos;
    const feet = { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) };
    // 身体高两格，直接站在门下时门方块可能在脚上方第 2–3 格；只扫 ±1 会漏掉“头顶上的门”。
    // 这里扩大扫描窗口，但仍由 observeBlocks 要求本次视野证据，不透视。
    const around = [-2, -1, 0, 1, 2].flatMap((dx) => [-1, 0, 1, 2, 3].flatMap((dy) => [-2, -1, 0, 1, 2].map((dz) =>
      ({ x: Math.floor(here.x) + dx, y: Math.floor(here.y) + dy, z: Math.floor(here.z) + dz }))));
    // 刚传送到门里时，门方块就在脚下/身上，视锥可能正好看不到它；只核对身体真正占据的脚/头两格，
    // 不把旁边一格的方块当“亲眼见过”（那会绕过视觉边界）。
    const touching = [feet, { ...feet, y: feet.y + 1 }]
      .map((pos) => ({ pos, name: ctx.adapter.blockAt(pos) }))
      .filter((b): b is { pos: Vec3Like; name: string } => !!b.name && kinds.includes(b.name));
    const portal = visiblePortal(ctx, around, kinds)
      ?? visiblePortal(ctx, ctx.senses.knownBlocks(kinds, 8).map((block) => block.pos), kinds)
      ?? touching[0];
    if (!portal) return fail('NOT_FOUND', '附近没有已观察并能核对的传送门');
    // 身体 AABB 压着的门方块才是“我在门里”的触觉事实；优先用适配器按 AABB 算出的字段，
    // 拿不到时退回脚/头两格（end_gateway 不靠身体接触触发，不算）。
    const bodyPortal = state.bodyPortal ?? [feet, { ...feet, y: feet.y + 1 }]
      .map((pos) => ctx.adapter.blockAt(pos))
      .find((name): name is string => name === 'nether_portal' || name === 'end_portal');
    const endpoint = travelStore(ctx.memory).observe(state, portal.pos, portal.name as PortalEndpoint['kind']);
    // 也记进常规记忆（地标），让 recall / places 能找回来，不只是 travelStore 里的一份；下界门在下界这一端尤其要靠它记住
    ctx.memory.addLandmark('discovery', `${PORTAL_LABEL[endpoint.kind]} ${endpoint.id}`, state.dim, endpoint.pos, 4);
    // 门外站位是按门几何算出来的候选点（没站过、没验证），只作为事实回报给心智，不替它写进地标记忆。
    const stance = ctx.adapter.portalStance?.(portal.pos);
    const bodyNote = bodyPortal ? `；身体现在与门方块 ${bodyPortal} 重叠` : '';
    const stanceNote = stance ? `；按门几何算出的门外站位 (${stance.x},${stance.y},${stance.z})，未站过` : '';
    return ok(`记录传送门 ${endpoint.id}${bodyNote}${stanceNote}`, { portalId: endpoint.id, endpoint, ...(stance ? { stance } : {}), ...(bodyPortal ? { bodyPortal } : {}) });
  },
};

async function traverse(ctx: SkillCtx, endpoint: PortalEndpoint) {
  const { adapter, signal } = ctx;
  const state = adapter.state();
  if (endpoint.kind === 'end_gateway') return fail('BAD_ARGS', '末地折跃门使用 use_end_gateway 技能与末影珍珠');
  if (endpoint.dim !== state.dim) return fail('WRONG_DIMENSION', `门在 ${endpoint.dim}，没有跨维度自动寻路`);
  if (!endpoint.portalObserved) return fail('NOT_FOUND', '该端只有到达位置，尚未观察到可返回的门');
  if (!adapter.enterPortalAt) return fail('ERROR', '适配器没有传送门进入能力');
  try {
    const nowBlock = adapter.blockAt(endpoint.pos);
    if (nowBlock !== endpoint.kind) {
      const unlit = endpoint.kind === 'nether_portal' && (AIR.has(nowBlock ?? '') || nowBlock === 'torch' || nowBlock === 'wall_torch');
      return fail('NOT_FOUND', unlit ? `门方块现在是 ${nowBlock}，多半只是被熄灭，黑曜石框还在` : '记忆中的传送门已改变或尚未加载');
    }
    ctx.setStationaryWait?.(true);
    const result = await adapter.enterPortalAt(endpoint.pos, signal);
    throwIfAborted(signal);
    // 把身体实际经历的时间线写给心智：它需要知道“开始就在门里 / 出去多久 / 在门里待了多久”，
    // 才能判断该不该先离开门再进，而不是只看到一个超时码。
    const timeline = result.transition
      ? [
          result.transition.startedInPortal ? '开始时身体已在门方块里' : '开始时不在门方块里',
          ...(result.transition.exitMs !== null ? [`退出门 ${(result.transition.exitMs / 1000).toFixed(1)}s`] : []),
          ...(result.transition.outsideMs !== null ? [`门外停留 ${(result.transition.outsideMs / 1000).toFixed(1)}s 后重新进入`] : []),
          result.transition.entered
            ? (result.transition.insideMs > 0 ? `在门方块里连续 ${(result.transition.insideMs / 1000).toFixed(1)}s` : '进入过门方块，结束时已不在门里')
            : '没有进入门方块',
          `维度 ${result.transition.endDim}`,
        ].join('；')
      : '';
    if (!result.ok || !result.from || !result.to) return fail('ERROR', `传送未验收（${result.reason}）${timeline ? `：${timeline}` : ''}`, { ...(result.transition ? { transition: result.transition } : {}), portalReason: result.reason });
    const to = result.to;
    if (!to.observationReady || to.dim === state.dim || to.worldId !== state.worldId || to.sessionId === state.sessionId) return fail('ERROR', '没有获得新维度的有效观察');
    // Arrival is a fact; a nearby return portal still requires fresh sight.
    const positions = [-2, -1, 0, 1, 2].flatMap((dx) => [-1, 0, 1].flatMap((dy) => [-2, -1, 0, 1, 2].map((dz) => ({
      x: Math.floor(to.pos.x) + dx, y: Math.floor(to.pos.y) + dy, z: Math.floor(to.pos.z) + dz,
    }))));
    const observed = visiblePortal(ctx, positions, [endpoint.kind]);
    const store = travelStore(ctx.memory);
    const destination = store.observe(to, observed?.pos ?? to.pos, endpoint.kind, !!observed);
    store.record(endpoint.id, destination.id, result.from, to);
    const roundTripVerified = store.snapshot(to.worldId).routes.some((r) => r.fromId === endpoint.id && r.toId === destination.id && r.returnVerified);
    ctx.memory.setWorld(to.worldId);
    const stand = result.stand ?? to;
    const leftPortal = result.leftPortal;
    // 只有确认身体已离开门方块（或适配器不检查）才记“门外站位”地标；仍在门里时不写 waypoint，
    // 避免把门方块本身标成可回去的落脚点。事实文字仍如实说明“到达后仍在门方块里”。
    if (leftPortal !== false) {
      const waypointLabel = leftPortal === undefined ? `传送到达 ${destination.id}` : `传送到达 ${destination.id} 门外站位`;
      ctx.memory.addLandmark('waypoint', waypointLabel, to.dim, stand.pos, 3);
    }
    const settleNote = leftPortal === undefined ? '' : leftPortal ? '；已离开门口' : '；到达后仍在门方块里';
    const dwellNote = result.transition && result.transition.insideMs > 0 ? `；门内停留 ${(result.transition.insideMs / 1000).toFixed(1)}s 后切换` : '';
    return ok(`已通过实际传送到达 ${to.dim}，记录两端位置；返程入口 ${destination.id}${observed ? '' : ' 尚需寻找'}${roundTripVerified ? '；往返已验证' : ''}${dwellNote}${settleNote}`, { fromId: endpoint.id, toId: destination.id, from: result.from, to, stand: result.stand, leftPortal, transition: result.transition, roundTripVerified });
  } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `传送失败：${(error as Error).message}（门离你约 ${Math.round(dist3(state.pos, endpoint.pos))} 格，在 ${endpoint.pos.x},${endpoint.pos.y},${endpoint.pos.z}）`); } finally { ctx.setStationaryWait?.(false); }
}

export const travelPortal: Skill<{ portalId: string }> = {
  name: 'travel_portal', description: '进入一个已观察的传送门，等待实际维度切换和新出生观察后记录真实出口；到达下界另一侧后会尝试把身体挪出目的地门方块（最多约 4 秒，leftPortal 如实报告）。', argsDoc: '{"portalId":"portal_id"}', timeoutMs: 100000, movement: true,
  validate(raw) { const portalId = String(obj(raw).portalId ?? '').trim(); return portalId ? { ok: true, args: { portalId } } : { ok: false, error: '缺少 portalId' }; },
  async run(ctx, args) { const store = travelStore(ctx.memory); const worldId = ctx.adapter.state().worldId; const endpoint = store.get(args.portalId, worldId); return endpoint ? traverse(ctx, endpoint) : fail('NOT_FOUND', `没有传送门 ${args.portalId}；当前世界记得的门：${knownPortals(store, worldId)}`); },
};

export const recallPortal: Skill<{ returnId: string }> = {
  name: 'recall_portal', description: '从当前维度中已实际观察的返程门返回；反向穿越成功后才标记已验证往返。', argsDoc: '{"returnId":"portal_id"}', timeoutMs: 100000, movement: true,
  validate(raw) { const returnId = String(obj(raw).returnId ?? '').trim(); return returnId ? { ok: true, args: { returnId } } : { ok: false, error: '缺少 returnId' }; },
  async run(ctx, args) { const store = travelStore(ctx.memory); const worldId = ctx.adapter.state().worldId; const endpoint = store.get(args.returnId, worldId); return endpoint ? traverse(ctx, endpoint) : fail('NOT_FOUND', `没有返程门 ${args.returnId}；当前世界记得的门：${knownPortals(store, worldId)}`); },
};

export const activateEndPortal: Skill<{}> = {
  name: 'activate_end_portal', description: '只给已观察到的现成末地门框放末影之眼；逐框核对 eye 属性，确认真实末地门出现后记录。', argsDoc: '{}', timeoutMs: 120000, movement: true,
  validate: () => ({ ok: true, args: {} }),
  async run(ctx) {
    const { adapter, senses, signal } = ctx;
    if (!adapter.blockStateAt || !adapter.useBlockAt) return fail('ERROR', '适配器缺少门框状态或交互能力');
    senses.refresh();
    const frames = senses.knownBlocks(['end_portal_frame'], 32);
    if (frames.length < 12) return fail('NOT_FOUND', '尚未实际观察到完整的 12 个末地门框');
    // A valid ring has a 3x3 interior and three inward-facing frames per side.
    let ring: typeof frames = [];
    let center: Vec3Like | null = null;
    for (const candidate of frames) {
      for (let dx = -2; dx <= 2 && !center; dx++) for (let dz = -2; dz <= 2 && !center; dz++) {
        const c = { x: candidate.pos.x + dx, y: candidate.pos.y, z: candidate.pos.z + dz };
        const expected = [-1, 0, 1].flatMap((offset) => [
          { pos: { x: c.x + offset, y: c.y, z: c.z - 2 }, facing: 'south' }, { pos: { x: c.x + offset, y: c.y, z: c.z + 2 }, facing: 'north' },
          { pos: { x: c.x - 2, y: c.y, z: c.z + offset }, facing: 'east' }, { pos: { x: c.x + 2, y: c.y, z: c.z + offset }, facing: 'west' },
        ]);
        if (expected.every((e) => frames.some((f) => dist3(f.pos, e.pos) === 0) && adapter.blockStateAt!(e.pos)?.properties.facing === e.facing)) { center = c; ring = expected.map((e) => frames.find((f) => dist3(f.pos, e.pos) === 0)!); }
      }
      if (center) break;
    }
    if (!center) return fail('NOT_FOUND', '已知门框未形成朝内的完整末地门环');
    const missing = ring.filter((frame) => ![true, 'true'].includes(adapter.blockStateAt!(frame.pos)?.properties.eye as any));
    const eyes = adapter.state().inventory.find((i) => i.name === 'ender_eye')?.count ?? 0;
    if (eyes < missing.length) return fail('MISSING_MATERIALS', `末地门还需要 ${missing.length} 颗末影之眼`);
    for (const frame of missing) {
      const result = await adapter.useBlockAt(frame.pos, 'ender_eye', signal);
      await sleep(150, signal);
      if (!result.ok || ![true, 'true'].includes(adapter.blockStateAt(frame.pos)?.properties.eye as any)) return fail('ERROR', '未确认末影之眼已经装入门框');
    }
    for (let retry = 0; retry < 10; retry++) {
      if (adapter.blockAt(center) === 'end_portal') {
        const endpoint = travelStore(ctx.memory).observe(adapter.state(), center, 'end_portal');
        return ok('实际末地门已激活', { portalId: endpoint.id });
      }
      await sleep(200, signal);
    }
    return fail('ERROR', '未观察到激活后的末地门，不能报告已完成');
  },
};

export const useEndGateway: Skill<{ portalId?: string }> = {
  name: 'use_end_gateway', description: '向实际观察到的末地折跃门投掷末影珍珠；只有同一存活会话的真实远距离位移才记录外岛到达及返程点。', argsDoc: '{"portalId"?:"已观察的折跃门 id"}', timeoutMs: 45000, movement: true,
  validate(raw) { const id = obj(raw).portalId; return id === undefined || typeof id === 'string' ? { ok: true, args: { portalId: id } } : { ok: false, error: 'portalId 必须为字符串' }; },
  async run(ctx, args) {
    const { adapter, signal, senses } = ctx;
    throwIfAborted(signal);
    const initial = adapter.state();
    if (initial.dim !== 'the_end') return fail('WRONG_DIMENSION', '末地折跃门只在末地使用');
    if (!adapter.useItem) return fail('ERROR', '适配器没有物品使用能力');
    if (initial.hp < 8 || !initial.inventory.some((i) => i.name === 'ender_pearl' && i.count > 0)) return fail('MISSING_MATERIALS', '需要末影珍珠且生命至少 8 点');
    const store = travelStore(ctx.memory);
    senses.refresh();
    const known = args.portalId ? store.get(args.portalId, initial.worldId) : undefined;
    const seen = !args.portalId ? visiblePortal(ctx, senses.knownBlocks(['end_gateway'], 64).map((block) => block.pos), ['end_gateway']) : undefined;
    const endpoint = known ?? (seen ? store.observe(initial, seen.pos, 'end_gateway') : undefined);
    if (!endpoint || endpoint.kind !== 'end_gateway' || !endpoint.portalObserved || endpoint.dim !== initial.dim) return fail('NOT_FOUND', '没有当前维度已观察到的折跃门');
    try {
      if (adapter.blockAt(endpoint.pos) !== 'end_gateway') return fail('NOT_FOUND', '折跃门已经改变或尚未加载');
      const sameSession = (state: ReturnType<typeof adapter.state>) => state.alive && state.connected && state.worldId === initial.worldId && state.dim === initial.dim && state.sessionId === initial.sessionId;
      const pearlCount = (state: ReturnType<typeof adapter.state>) => state.inventory.find((item) => item.name === 'ender_pearl')?.count ?? 0;
      const floorY = Math.floor(initial.pos.y);
      const stands = [{ x: -3, z: 0 }, { x: 3, z: 0 }, { x: 0, z: -3 }, { x: 0, z: 3 }].map((offset) => ({ x: endpoint.pos.x + offset.x + 0.5, y: floorY, z: endpoint.pos.z + offset.z + 0.5 })).filter((stand) => {
        const foot = { x: Math.floor(stand.x), y: stand.y, z: Math.floor(stand.z) }, support = adapter.blockAt({ ...foot, y: foot.y - 1 });
        return !!support && (TERRAIN.has(support) || ['end_stone', 'obsidian', 'bedrock', 'cobbled_deepslate'].includes(support) || support.endsWith('_planks')) && AIR.has(adapter.blockAt(foot) ?? '') && AIR.has(adapter.blockAt({ ...foot, y: foot.y + 1 }) ?? '');
      }).sort((left, right) => dist3(left, initial.pos) - dist3(right, initial.pos));
      const aim = { x: endpoint.pos.x + 0.5, y: endpoint.pos.y + 0.5, z: endpoint.pos.z + 0.5 };
      let from: ReturnType<typeof adapter.state> | null = null;
      let lastAttemptAt = 0;
      // A body directly beneath the gateway is not a valid launch proof. Keep
      // a supported side pose instead of letting a range-3 goal move beneath it.
      for (const stand of stands) {
        throwIfAborted(signal);
        if (Date.now() >= ctx.deadline - 50) break;
        try { await adapter.moveTo({ kind: 'near', pos: stand, range: 0.3 }, { signal, timeoutMs: Math.max(1, Math.min(12000, ctx.deadline - Date.now())), constructionSafe: true }); }
        catch (error) { if (isAbort(error)) throw error; continue; }
        const reached = adapter.state();
        if (!sameSession(reached)) return fail('ERROR', '投掷站位移动中观察会话中断');
        if (Math.hypot(reached.pos.x - stand.x, reached.pos.z - stand.z) > 0.9 || Math.abs(reached.pos.y - stand.y) > 0.6) continue;
        const result = await adapter.useItem('ender_pearl', signal, { aim });
        throwIfAborted(signal);
        if (!result.ok && result.reason === 'BLOCKED_AIM') continue;
        if (!result.ok) return fail('ERROR', `珍珠投掷失败：${result.reason}`);
        from = reached; lastAttemptAt = Date.now(); break;
      }
      if (!from) return fail('NOT_FOUND', '没有可达、有支撑且射线畅通的侧方投掷站位');
      const pearlsBefore = pearlCount(from);
      let throwAttempts = 1, pearlConsumed = false;
      const deadline = Math.min(ctx.deadline, Date.now() + 10000);
      for (let tick = 0; tick < 50 && Date.now() < deadline; tick++) {
        await sleep(Math.max(1, Math.min(200, deadline - Date.now())), signal);
        const to = adapter.state();
        if (!sameSession(to)) return fail('ERROR', '折跃过程会话中断，不能确认到达');
        if (pearlCount(to) < pearlsBefore) pearlConsumed = true;
        if (to.observationReady && dist3(from.pos, to.pos) >= 48) {
          const positions = [-3, -2, -1, 0, 1, 2, 3].flatMap((dx) => [-2, -1, 0, 1, 2].flatMap((dy) => [-3, -2, -1, 0, 1, 2, 3].map((dz) => ({
            x: Math.floor(to.pos.x) + dx, y: Math.floor(to.pos.y) + dy, z: Math.floor(to.pos.z) + dz,
          }))));
          const returnPos = visiblePortal(ctx, positions, ['end_gateway'])?.pos;
          const destination = store.observe(to, returnPos ?? to.pos, 'end_gateway', !!returnPos);
          store.recordGateway(endpoint.id, destination.id, from, to);
          ctx.memory.addLandmark('waypoint', `折跃后实际到达 ${destination.id}`, to.dim, to.pos, 3);
          return ok('已确认末地折跃后的实际位置并记录返程观察', { fromId: endpoint.id, toId: destination.id, from, to, returnPortalObserved: !!returnPos, throwAttempts, pearlConsumed });
        }
        // A use packet during vanilla's item cooldown can be ignored. Retry
        // only an unconsumed use after >1s; a consumed pearl is never replayed.
        if (!pearlConsumed && throwAttempts < 3 && Date.now() - lastAttemptAt >= 1200 && Date.now() < deadline - 200) {
          const retry = await adapter.useItem('ender_pearl', signal, { aim });
          throwIfAborted(signal);
          if (!retry.ok) return fail('ERROR', `珍珠重试失败：${retry.reason}`);
          throwAttempts++; lastAttemptAt = Date.now();
        }
      }
      return fail('TIMEOUT', '没有观察到折跃的真实远距离位移，不能宣称到达外岛', { throwAttempts, pearlConsumed, pearlsBefore, pearlsAfter: pearlCount(adapter.state()) });
    } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `折跃中断：${(error as Error).message}`); }
  },
};

export const travelSkills = { build_portal: buildPortal, observe_portal: observePortal, travel_portal: travelPortal, recall_portal: recallPortal, activate_end_portal: activateEndPortal, use_end_gateway: useEndGateway };

import type { Vec3Like } from '../adapter/types.ts';
import { travelStore, type PortalEndpoint } from '../travel/store.ts';
import { dist3, sleep, throwIfAborted } from '../util.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const TERRAIN = new Set(['dirt', 'grass_block', 'stone', 'cobblestone', 'deepslate', 'netherrack', 'sand', 'gravel']);

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
    if ((state.inventory.find((i) => i.name === 'obsidian')?.count ?? 0) < needed) return fail('MISSING_MATERIALS', `还缺 ${needed} 块黑曜石用于门框`);
    for (let y = 1; y <= 4; y++) for (let u = 0; u <= 3; u++) {
      const name = adapter.blockAt(at(u, y));
      const isFrame = frame.some((p) => dist3(p, at(u, y)) === 0);
      if (!name || (!AIR.has(name) && !(isFrame && name === 'obsidian'))) return fail('BAD_ARGS', '门框或内部空间被占用，换一个已观察到的空地');
    }
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
    const portal = ctx.senses.knownBlocks(['nether_portal', 'end_portal', 'end_gateway'], 8).find((p) => ctx.adapter.blockAt(p.pos) === p.name);
    if (!portal) return fail('NOT_FOUND', '附近没有已观察并能核对的传送门');
    const endpoint = travelStore(ctx.memory).observe(state, portal.pos, portal.name as PortalEndpoint['kind']);
    return ok(`记录传送门 ${endpoint.id}`, { portalId: endpoint.id, endpoint });
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
    await adapter.moveTo({ kind: 'near', pos: endpoint.pos, range: 2 }, { signal, timeoutMs: 60000 });
    if (adapter.blockAt(endpoint.pos) !== endpoint.kind) return fail('NOT_FOUND', '记忆中的传送门已改变或尚未加载');
    const result = await adapter.enterPortalAt(endpoint.pos, signal);
    throwIfAborted(signal);
    if (!result.ok || !result.from || !result.to) return fail('ERROR', `传送未验收：${result.reason}`);
    const to = result.to;
    if (!to.observationReady || to.dim === state.dim || to.worldId !== state.worldId || to.sessionId === state.sessionId) return fail('ERROR', '没有获得新维度的有效观察');
    // Only the loaded blocks around the actual arrival position are inspected.
    // An End arrival platform is not automatically a return portal.
    let observed: Vec3Like | null = null;
    for (let dx = -2; dx <= 2 && !observed; dx++) for (let dy = -1; dy <= 1 && !observed; dy++) for (let dz = -2; dz <= 2 && !observed; dz++) {
      const pos = { x: Math.floor(to.pos.x) + dx, y: Math.floor(to.pos.y) + dy, z: Math.floor(to.pos.z) + dz };
      if (adapter.blockAt(pos) === endpoint.kind) observed = pos;
    }
    const store = travelStore(ctx.memory);
    const destination = store.observe(to, observed ?? to.pos, endpoint.kind, !!observed);
    store.record(endpoint.id, destination.id, result.from, to);
    ctx.memory.setWorld(to.worldId);
    ctx.memory.addLandmark('waypoint', `传送到达 ${destination.id}`, to.dim, to.pos, 3);
    return ok(`已通过实际传送到达 ${to.dim}，记录两端位置；返程入口 ${destination.id}${observed ? '' : ' 尚需寻找'}`, { fromId: endpoint.id, toId: destination.id, from: result.from, to, transition: true });
  } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `传送失败：${(error as Error).message}`); }
}

export const travelPortal: Skill<{ portalId: string }> = {
  name: 'travel_portal', description: '进入一个已观察的传送门，等待实际维度切换和新出生观察后记录真实出口。', argsDoc: '{"portalId":"portal_id"}', timeoutMs: 100000, movement: true,
  validate(raw) { const portalId = String(obj(raw).portalId ?? '').trim(); return portalId ? { ok: true, args: { portalId } } : { ok: false, error: '缺少 portalId' }; },
  async run(ctx, args) { const endpoint = travelStore(ctx.memory).get(args.portalId, ctx.adapter.state().worldId); return endpoint ? traverse(ctx, endpoint) : fail('NOT_FOUND', '没有该世界的传送门记录'); },
};

export const recallPortal: Skill<{ returnId: string }> = {
  name: 'recall_portal', description: '从当前维度中已实际观察的返程门返回；反向穿越成功后才标记已验证往返。', argsDoc: '{"returnId":"portal_id"}', timeoutMs: 100000, movement: true,
  validate(raw) { const returnId = String(obj(raw).returnId ?? '').trim(); return returnId ? { ok: true, args: { returnId } } : { ok: false, error: '缺少 returnId' }; },
  async run(ctx, args) { const endpoint = travelStore(ctx.memory).get(args.returnId, ctx.adapter.state().worldId); return endpoint ? traverse(ctx, endpoint) : fail('NOT_FOUND', '没有返程门记录'); },
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
    const initial = adapter.state();
    if (initial.dim !== 'the_end') return fail('WRONG_DIMENSION', '末地折跃门只在末地使用');
    if (!adapter.useItem) return fail('ERROR', '适配器没有物品使用能力');
    if (initial.hp < 8 || !initial.inventory.some((i) => i.name === 'ender_pearl' && i.count > 0)) return fail('MISSING_MATERIALS', '需要末影珍珠且生命至少 8 点');
    const store = travelStore(ctx.memory);
    senses.refresh();
    const known = args.portalId ? store.get(args.portalId, initial.worldId) : undefined;
    const seen = !args.portalId ? senses.knownBlocks(['end_gateway'], 64).find((b) => adapter.blockAt(b.pos) === 'end_gateway') : undefined;
    const endpoint = known ?? (seen ? store.observe(initial, seen.pos, 'end_gateway') : undefined);
    if (!endpoint || endpoint.kind !== 'end_gateway' || !endpoint.portalObserved || endpoint.dim !== initial.dim) return fail('NOT_FOUND', '没有当前维度已观察到的折跃门');
    try {
      await adapter.moveTo({ kind: 'near', pos: endpoint.pos, range: 3 }, { signal, timeoutMs: 20000 });
      if (adapter.blockAt(endpoint.pos) !== 'end_gateway') return fail('NOT_FOUND', '折跃门已经改变或尚未加载');
      const from = adapter.state();
      const dx = endpoint.pos.x + 0.5 - from.pos.x, dz = endpoint.pos.z + 0.5 - from.pos.z, dy = endpoint.pos.y + 0.5 - from.pos.y - 1.62;
      await adapter.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
      const result = await adapter.useItem('ender_pearl', signal);
      if (!result.ok) return fail('ERROR', `珍珠投掷失败：${result.reason}`);
      const deadline = Math.min(ctx.deadline, Date.now() + 10000);
      for (let tick = 0; tick < 50 && Date.now() < deadline; tick++) {
        await sleep(200, signal);
        const to = adapter.state();
        if (!to.alive || !to.connected || to.worldId !== from.worldId || to.dim !== from.dim || to.sessionId !== from.sessionId) return fail('ERROR', '折跃过程会话中断，不能确认到达');
        if (to.observationReady && dist3(from.pos, to.pos) >= 48) {
          let returnPos: Vec3Like | null = null;
          for (let dx = -3; dx <= 3 && !returnPos; dx++) for (let dy = -2; dy <= 2 && !returnPos; dy++) for (let dz = -3; dz <= 3 && !returnPos; dz++) {
            const pos = { x: Math.floor(to.pos.x) + dx, y: Math.floor(to.pos.y) + dy, z: Math.floor(to.pos.z) + dz };
            if (adapter.blockAt(pos) === 'end_gateway') returnPos = pos;
          }
          const destination = store.observe(to, returnPos ?? to.pos, 'end_gateway', !!returnPos);
          store.recordGateway(endpoint.id, destination.id, from, to);
          ctx.memory.addLandmark('waypoint', `折跃后实际到达 ${destination.id}`, to.dim, to.pos, 3);
          return ok('已确认末地折跃后的实际位置并记录返程观察', { fromId: endpoint.id, toId: destination.id, from, to, returnPortalObserved: !!returnPos });
        }
      }
      return fail('TIMEOUT', '没有观察到折跃的真实远距离位移，不能宣称到达外岛');
    } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `折跃中断：${(error as Error).message}`); }
  },
};

export const travelSkills = { build_portal: buildPortal, observe_portal: observePortal, travel_portal: travelPortal, recall_portal: recallPortal, activate_end_portal: activateEndPortal, use_end_gateway: useEndGateway };

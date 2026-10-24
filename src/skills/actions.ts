import { DIRS } from '../perception/perception.ts';
import { dist3, sleep } from '../util.ts';
import { sighted, yawOfDir } from './movement.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';
import { resolveItemAlias } from './work.ts';
import { isStation, rememberStation } from './stations.ts';

/**
 * 通用基础动作：相当于玩家的“右键”和“方向键”。
 * 它们本身不代表任何玩法；造船过河、提水灭火、骑马赶路、喂动物繁殖……都由 LLM 用常识自己组合。
 */

const AIRISH = new Set(['air', 'cave_air', 'void_air']);
const dirOk = (dir: string | undefined, from: { x: number; z: number }, to: { x: number; z: number }) => {
  if (!dir || !DIRS[dir]) return true;
  const want = yawOfDir(DIRS[dir][0], DIRS[dir][1]);
  const got = Math.atan2(-(to.x - from.x), -(to.z - from.z));
  const d = Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)));
  return d <= Math.PI / 3;
};

// ------------------------------------------------------------------ use_item
export const useItem: Skill<{ item: string; on: string; dir?: string }> = {
  name: 'use_item',
  description: '手持物品右键：对着看得见的方块、水面或岩浆（on 写方块名），或对自己（on:"self"）',
  argsDoc: '{"item": "<物品名>", "on"?: "self | water | lava | <方块名>", "dir"?: "N|NE|E|SE|S|SW|W|NW"}',
  timeoutMs: 30000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const name = String(a.item ?? '').trim().replace(/^minecraft:/, '');
    const item = resolveItemAlias(name, adapter);
    if (!item) return { ok: false, error: `未知物品：${name}` };
    const on = typeof a.on === 'string' && a.on.trim() ? a.on.trim().toLowerCase() : 'self';
    const dir = typeof a.dir === 'string' ? a.dir.toUpperCase() : undefined;
    if (dir && !DIRS[dir]) return { ok: false, error: `dir 必须是 ${Object.keys(DIRS).join('/')}` };
    return { ok: true, args: { item, on, ...(dir ? { dir } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    if (!adapter.useItemOn) return fail('ERROR', '当前适配器不支持使用物品');
    const s = adapter.state();
    if (!s.inventory.some((i) => i.name === args.item)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item}`);
    try {
      if (args.on === 'self') {
        const r = await adapter.useItemOn(args.item, { kind: 'self' }, signal);
        return r.ok ? ok(`使用了 ${args.item}`, { effectEvidence: r.effectEvidence }) : fail('ERROR', `使用 ${args.item} 失败：${r.reason}`, { effectEvidence: r.effectEvidence });
      }
      senses.refresh();
      const names = new Set([args.on, ...adapter.resolveBlockNames(args.on)]);
      const fluid = args.on === 'water' || args.on === 'lava';
      // 只用看得见的方块；液体要选表面（上面是空气）的那一格
      const hits = senses.knownBlocks([...names], 32)
        .filter((h) => !fluid || AIRISH.has(adapter.blockAt({ x: h.pos.x, y: h.pos.y + 1, z: h.pos.z }) ?? 'air'))
        .filter((h) => dirOk(args.dir, s.pos, h.pos))
        .sort((a, b) => a.dist - b.dist);
      const target = hits[0];
      if (!target) return fail('NOT_FOUND', `看不见可以对着用的 ${args.on}${args.dir ? `（${args.dir} 方向）` : ''}`);
      if (dist3(adapter.state().pos, target.pos) > 4.2) {
        ctx.progress(0.3, `走到 ${target.name} 旁边`);
        await adapter.moveTo({ kind: 'near', pos: target.pos, range: 3 }, { signal, timeoutMs: Math.max(5000, ctx.deadline - Date.now() - 5000) });
      }
      const before = adapter.state().inventory.find((i) => i.name === args.item)?.count ?? 0;
      const r = await adapter.useItemOn(args.item, { kind: 'block', pos: target.pos }, signal);
      if (!r.ok) return fail(codeFromError({ message: r.reason }), `对着 ${target.name} 使用 ${args.item} 失败：${r.reason}`, { target: target.name, pos: target.pos, effectEvidence: r.effectEvidence });
      const after = adapter.state().inventory.find((i) => i.name === args.item)?.count ?? 0;
      // 自己放下的工作台/熔炉记住位置，下次复用
      if (isStation(args.item) && r.placed) rememberStation(ctx, args.item, r.placed);
      const location = r.placed ? `，确认放置在 ${r.placed.x},${r.placed.y},${r.placed.z}（本次只放置这一块）` : '';
      return ok(`对着 ${target.name} 使用了 ${args.item}${location}${r.spawned ? `，放出了 ${r.spawned}` : ''}${after < before ? `（背包里的 ${args.item} 少了 ${before - after} 个）` : ''}`,
        { target: target.name, pos: r.placed ?? target.pos, effectEvidence: r.effectEvidence, ...(r.placed ? { placed: r.placed } : {}), ...(r.spawned ? { spawned: r.spawned } : {}) });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `使用 ${args.item} 出错：${(e as Error).message}`);
    }
  },
};

// ------------------------------------------------------------------ interact
export const interact: Skill<{ entity: string; with?: string }> = {
  name: 'interact',
  description: '右键看得见的实体：载具/坐骑会坐上去；可手持物品（with）对生物使用',
  argsDoc: '{"entity": "<实体名，如 boat、horse、cow、villager>", "with"?: "<手持物品>"}',
  timeoutMs: 30000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const entity = String(a.entity ?? '').trim().toLowerCase();
    if (!entity) return { ok: false, error: 'entity 不能为空' };
    let withItem: string | undefined;
    if (a.with !== undefined && a.with !== null && String(a.with).trim()) {
      const it = resolveItemAlias(String(a.with).trim(), adapter);
      if (!it) return { ok: false, error: `未知物品：${String(a.with)}` };
      withItem = it;
    }
    return { ok: true, args: { entity, ...(withItem ? { with: withItem } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    if (!adapter.interactEntity) return fail('ERROR', '当前适配器不支持与实体交互');
    if (args.with && !adapter.state().inventory.some((i) => i.name === args.with)) return fail('MISSING_MATERIALS', `背包里没有 ${args.with}`);
    const match = (n: string) => n === args.entity || n.endsWith(`_${args.entity}`) || n.replace(/^player:/, '') === args.entity;
    const find = () => { senses.refresh(); return senses.perceivedEntities(32).filter((e) => e.kind !== 'item' && match(e.name)).sort((a, b) => a.dist - b.dist)[0]; };
    let target = find();
    // 刚放下的船/刚出现的实体要过一会儿才看得到：稍等再看两次
    for (let i = 0; !target && i < 2; i++) { await sleep(250, signal); target = find(); }
    if (!target) return fail('NOT_FOUND', `看不见 ${args.entity}`);
    try {
      if (target.dist > 3) {
        ctx.progress(0.3, `走近 ${target.name}`);
        await adapter.moveTo({ kind: 'follow_entity', entityId: target.id, range: 2 }, { signal, timeoutMs: 15000 });
      }
      const r = await adapter.interactEntity(target.id, args.with ?? null, signal);
      if (!r.ok) return fail('ERROR', `和 ${target.name} 交互失败：${r.reason}`);
      return ok(r.mounted ? `坐上了 ${r.mounted}` : `对 ${target.name}${args.with ? ` 使用了 ${args.with}` : ' 右键交互'}`, { entity: target.name, ...(r.mounted ? { mounted: r.mounted } : {}) });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `和 ${target.name} 交互出错：${(e as Error).message}`);
    }
  },
};

// ------------------------------------------------------------------ dismount
export const dismount: Skill<{}> = {
  name: 'dismount',
  description: '从正在乘坐的东西上下来',
  argsDoc: '{}',
  timeoutMs: 8000,
  movement: false,
  validate() { return { ok: true, args: {} }; },
  async run(ctx) {
    if (!ctx.adapter.dismount) return fail('ERROR', '当前适配器不支持下载具');
    if (!ctx.adapter.state().riding) return fail('BAD_ARGS', '现在没有在乘坐任何东西');
    const r = await ctx.adapter.dismount(ctx.signal);
    return r.ok ? ok('下来了') : fail('ERROR', `下不来：${r.reason}`);
  },
};

// ------------------------------------------------------------------ ride
export const ride: Skill<{ direction?: string; to?: { x: number; z: number }; distance: number; until?: string }> = {
  name: 'ride',
  description: '操控正在乘坐的东西朝方向或坐标前进，靠岸/遇障碍停下，until 看见即停',
  argsDoc: '{"direction"?: "N|NE|E|SE|S|SW|W|NW", "to"?: "x,z", "distance"?: 8-240, "until"?: "<方块/生物>"}',
  timeoutMs: 120000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const direction = typeof a.direction === 'string' ? a.direction.toUpperCase() : undefined;
    if (direction && !DIRS[direction]) return { ok: false, error: `direction 必须是 ${Object.keys(DIRS).join('/')}` };
    let to: { x: number; z: number } | undefined;
    if (typeof a.to === 'string') {
      const m = a.to.match(/^\s*(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)\s*$/);
      if (!m) return { ok: false, error: 'to 的格式是 "x,z"' };
      to = { x: +m[1], z: +m[2] };
    }
    if (!direction && !to) return { ok: false, error: '需要 direction 或 to' };
    const until = typeof a.until === 'string' && a.until.trim() ? a.until.trim().toLowerCase().slice(0, 80) : undefined;
    return { ok: true, args: { ...(direction ? { direction } : {}), ...(to ? { to } : {}), distance: clampInt(a.distance, 8, 240, 48), ...(until ? { until } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    if (!adapter.ride) return fail('ERROR', '当前适配器不支持操控载具');
    const s = adapter.state();
    if (!s.riding) return fail('BAD_ARGS', '现在没有在乘坐任何东西（先用 interact 坐上去）');
    const [dx, dz] = args.direction ? DIRS[args.direction] : [0, 0];
    const target = args.to ?? { x: s.pos.x + dx * args.distance, z: s.pos.z + dz * args.distance };
    let seen: { what: string; dist: number } | null = null;
    try {
      const r = await adapter.ride(target, signal, {
        timeoutMs: Math.max(3000, ctx.deadline - Date.now() - 2000),
        stop: () => { if (!args.until) return false; ctx.senses.refresh(); seen = sighted(ctx, args.until); return !!seen; },
      });
      const moved = Math.round(r.moved);
      if (!r.ok) return fail(r.reason === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR', `乘坐 ${s.riding} 前进失败：${r.reason}（走了 ${moved} 格）`, { moved });
      const f = seen as { what: string; dist: number } | null;
      if (f) return ok(`乘坐 ${s.riding} 前进 ${moved} 格，看见 ${f.what}（${f.dist} 格外），停下`, { moved, found: f.what });
      if (r.arrived) return ok(`乘坐 ${s.riding} 到了目标附近（${moved} 格）`, { moved, arrived: true });
      if (r.blocked) return ok(`乘坐 ${s.riding} 前进 ${moved} 格后前方靠岸/有障碍，停下了`, { moved, blocked: true });
      return ok(`乘坐 ${s.riding} 前进了 ${moved} 格`, { moved });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `乘坐出错：${(e as Error).message}`);
    }
  },
};

export const actionSkills = [useItem, interact, dismount, ride];

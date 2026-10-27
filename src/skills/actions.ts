import { DIRS } from '../perception/perception.ts';
import { dist3, sleep, throwIfAborted } from '../util.ts';
import type { EntityInfo } from '../adapter/types.ts';
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
  description: '手持物品右键：对着看得见的方块、水面或岩浆（on 写方块名），或对自己（on:"self"）；对生物用东西（喂、剪、挤奶）是 interact',
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
      if (!target) {
        // on 写的是生物（牛、猪、羊……）不是方块：拿着东西右键生物就是 interact
        const creature = !fluid && senses.perceivedEntities(32).some((e) => e.kind !== 'item' && e.perception !== 'heard' && matchesEntity(e.name, args.on));
        if (creature) return interact.run(ctx, { entity: args.on, with: args.item });
        return fail('NOT_FOUND', `看不见可以对着用的 ${args.on}${args.dir ? `（${args.dir} 方向）` : ''}${fluid ? '' : '（on 只认方块；对生物用东西写 interact {"entity":…,"with":…}）'}`);
      }
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
const matchesEntity = (n: string, want: string) => n === want || n.endsWith(`_${want}`) || n.replace(/^player:/, '') === want;
/** 拿着某样东西右键后确实起了作用的生物：同样东西再对同一只用一般没用（已经在求偶、已经剪过毛），下次先换一只 */
const servedWith = new Map<string, number>();
const SERVED_MS = 5 * 60_000;

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
    const now = Date.now();
    for (const [k, t] of servedWith) if (now - t > SERVED_MS) servedWith.delete(k);
    const served = (e: EntityInfo) => !!args.with && servedWith.has(`${e.id}:${args.with}`);
    const find = () => {
      senses.refresh();
      return senses.perceivedEntities(32).filter((e) => e.kind !== 'item' && matchesEntity(e.name, args.entity))
        .sort((a, b) => Number(served(a)) - Number(served(b)) || a.dist - b.dist)[0];
    };
    let target = find();
    // 刚放下的船/刚出现的实体要过一会儿才看得到：稍等再看两次
    for (let i = 0; !target && i < 2; i++) { await sleep(250, signal); target = find(); }
    if (!target) return fail('NOT_FOUND', `看不见 ${args.entity}`);
    try {
      if (target.dist > 3) {
        ctx.progress(0.3, `走近 ${target.name}`);
        await adapter.moveTo({ kind: 'follow_entity', entityId: target.id, range: 2 }, { signal, timeoutMs: 15000 });
      }
      const who = `${target.name}${target.traits ? `（${target.traits}）` : ''}`;
      const again = served(target) ? '；看得见的同类里只剩这只刚才已经用过' : '';
      const r = await adapter.interactEntity(target.id, args.with ?? null, signal);
      if (!r.ok && /^NO_EFFECT/.test(String(r.reason))) return fail('EFFECT_NOT_CONFIRMED', `拿着 ${args.with} 右键了 ${who}，背包和它都没有反应${again}`, { entity: target.name, entityId: target.id, pos: target.pos, effectEvidence: r.effectEvidence });
      if (!r.ok) return fail('ERROR', `和 ${who} 交互失败：${r.reason}`, { entity: target.name, pos: target.pos });
      if (args.with && r.effectEvidence?.changed) servedWith.set(`${target.id}:${args.with}`, Date.now());
      const seen = r.effectEvidence?.reasons?.length ? `：${r.effectEvidence.reasons.join('，')}` : '';
      return ok(r.mounted ? `坐上了 ${r.mounted}` : `对 ${who}${args.with ? ` 使用了 ${args.with}${seen}` : ' 右键交互'}`,
        { entity: target.name, entityId: target.id, pos: target.pos, ...(r.mounted ? { mounted: r.mounted } : {}), ...(r.effectEvidence ? { effectEvidence: r.effectEvidence } : {}) });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `和 ${target.name} 交互出错：${(e as Error).message}`);
    }
  },
};

// ------------------------------------------------------------------ hit_entity
export const hitEntity: Skill<{ entity: string | number; hits: number }> = {
  name: 'hit_entity',
  description: '对指定可见实体有限次左键；复核距离与遮挡，报告生命变化、附近掉落及背包实增；离开视野不等于击败或已回收',
  argsDoc: '{"entity":"<实体名>" | <实体ID>, "hits"?:1-8}',
  timeoutMs: 25000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw), target = a.entity ?? a.entityId;
    const entity = typeof target === 'string' ? target.trim().toLowerCase() : target;
    if (typeof entity !== 'string' && (!Number.isInteger(entity) || entity < 0) || typeof entity === 'string' && (!entity || entity.length > 80)) return { ok: false, error: 'entity 必须是实体名或非负整数ID' };
    const hits = a.hits ?? 1;
    if (!Number.isInteger(hits) || hits < 1 || hits > 8) return { ok: false, error: 'hits 必须为 1-8 的整数' };
    return { ok: true, args: { entity, hits } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const visible = () => { senses.refresh(); return senses.perceivedEntities(16).filter((e) => e.perception !== 'heard'); };
    const matches = (e: EntityInfo) => e.kind !== 'item' && (typeof args.entity === 'number' ? e.id === args.entity : e.name.toLowerCase() === args.entity || e.name.toLowerCase().replace(/^player:/, '') === args.entity || e.name.toLowerCase().endsWith(`_${args.entity}`));
    let target = visible().filter(matches).sort((a, b) => a.dist - b.dist)[0];
    if (!target) return fail('NOT_FOUND', `当前看不见实体 ${args.entity}；仅听见或记住的位置不能用来左键`);
    const targetId = target.id, name = target.name;
    const aim = (e: EntityInfo) => ({ ...e.pos, y: e.pos.y + (e.height ?? 1.6) * 0.85 });
    const eye = () => adapter.eye() ?? { ...adapter.state().pos, y: adapter.state().pos.y + 1.62 };
    const withinReach = (e: EntityInfo) => dist3(eye(), aim(e)) <= 3;
    const clearReach = (e: EntityInfo) => {
      const from = eye(), to = aim(e), distance = dist3(from, to);
      // Check only the short segment to an already visible target. Optical
      // visibility through glass alone does not make a legal melee path.
      for (let d = 0.1; d < distance; d += 0.2) {
        const k = d / Math.max(0.01, distance), p = { x: Math.floor(from.x + (to.x - from.x) * k), y: Math.floor(from.y + (to.y - from.y) * k), z: Math.floor(from.z + (to.z - from.z) * k) };
        const block = adapter.blockAt(p);
        if (!block || !/^(air|cave_air|void_air|water|bubble_column|short_grass|grass|tall_grass|fern|large_fern|vine|torch|wall_torch)$/.test(block)) return false;
      }
      return true;
    };
    let sent = 0, healthDrops = 0, lastPos = target.pos, stopped = '';
    try {
      throwIfAborted(signal);
      if (!withinReach(target)) {
        await adapter.moveTo({ kind: 'follow_entity', entityId: targetId, range: 1.8 }, { signal, timeoutMs: Math.max(1, Math.min(12000, ctx.deadline - Date.now() - 6000)), constructionSafe: true, allowSwimming: false });
        await sleep(180, signal);
      }
      const before = new Map(adapter.state().inventory.map((item) => [item.name, item.count]));
      const oldDrops = new Set(visible().filter((e) => e.kind === 'item').map((e) => e.id));
      for (; sent < args.hits && Date.now() < ctx.deadline - 650;) {
        throwIfAborted(signal);
        const current = visible().find((e) => e.id === targetId && e.kind !== 'item');
        if (!current) { stopped = '目标离开视野，是否被破坏尚不确定'; break; }
        target = current;
        if (!withinReach(target)) { stopped = '目标超出近身距离'; break; }
        if (!clearReach(target)) { stopped = '目标与身体之间有遮挡或未知方块'; break; }
        lastPos = target.pos;
        const beforeHp = target.hp;
        if (!(await adapter.attack(targetId, signal))) { stopped = '底层没有发送左键'; break; }
        sent++;
        await sleep(650, signal);
        const after = visible().find((e) => e.id === targetId);
        if (typeof beforeHp === 'number' && typeof after?.hp === 'number' && after.hp < beforeHp) healthDrops++;
      }
      throwIfAborted(signal);
      const now = visible(), targetVisible = now.some((e) => e.id === targetId);
      if (!targetVisible && !stopped) stopped = '目标离开视野，是否被破坏尚不确定';
      if (sent < args.hits && !stopped) stopped = '本次时间预算已用完';
      const drops = now.filter((e) => e.kind === 'item' && !oldDrops.has(e.id) && dist3(e.pos, lastPos) <= 3).map((e) => ({ id: e.id, name: e.name.replace(/^item:/, ''), count: e.count ?? 1 }));
      const gained = adapter.state().inventory.map((item) => ({ name: item.name, count: item.count - (before.get(item.name) ?? 0) })).filter((item) => item.count > 0);
      const reasons = [...(healthDrops ? [`观察到 ${healthDrops} 次生命值下降`] : []), ...(drops.length ? [`目标附近出现掉落物 ${drops.map((e) => e.name).join('、')}`] : []), ...(gained.length ? [`背包实增 ${gained.map((e) => `${e.name}×${e.count}`).join('、')}`] : [])];
      const data = { targetId, entity: name, sent, healthDrops, targetVisible, drops, gained, defeatVerified: false,
        effectEvidence: { verified: reasons.length > 0 || sent === 0, changed: reasons.length > 0, reasons: reasons.length ? reasons : [stopped || '只确认发送左键，没有观察到实际效果'] } };
      const summary = `对 ${name} 发送了 ${sent}/${args.hits} 次左键${reasons.length ? `；${reasons.join('；')}` : '；命中效果未确认'}${stopped ? `；${stopped}` : ''}；没有据此认定已击败或已回收`;
      return reasons.length ? ok(summary, data) : fail('EFFECT_NOT_CONFIRMED', summary, data);
    } catch (error) {
      if (isAbort(error)) throw error;
      return fail(codeFromError(error), `对 ${name} 左键失败：${(error as Error).message}`, { targetId, sent });
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
  outcomeBoundary: true,
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

export const actionSkills = [useItem, interact, hitEntity, dismount, ride];

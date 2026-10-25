import type { AgentState, GameAdapter } from '../adapter/types.ts';
import { facingOfYaw, feetCell, toWorld, type Facing } from '../perception/local.ts';
import { AIR_BLOCKS, isSoftBlock, LIQUID_BLOCKS } from '../perception/surroundings.ts';
import { measureLight } from '../skills/light.ts';
import type { Senses } from '../skills/types.ts';

/**
 * 触发条件：模型自己写的“什么时候该这么做”。只能说身体此刻感觉得到的事（看见/听见的怪、身边的方块、
 * 自己的状态、刚才哪个动作失败了），没有透视，也不能执行任意代码。
 *
 *   {"hp_below":8,"hostile":{"name":"skeleton","within":16},"night":true}
 *   {"after_failure":{"skill":"goto","code":["PATH_NOT_FOUND","STUCK"]},"cell":{"at":[1,0,0],"is":"solid"}}
 *
 * 并列的键都成立才算成立；any / all / not 用来组合。
 */
export type CellIs = 'air' | 'open' | 'solid' | 'liquid' | string;
export interface CellCheck { at: [number, number, number]; is: CellIs | CellIs[] }

export interface Predicate {
  hp_below?: number; food_below?: number; oxygen_below?: number;
  in_water?: boolean; in_lava?: boolean; on_ground?: boolean; night?: boolean; dark?: boolean;
  hostile?: { name?: string[]; within: number; fusing?: boolean };
  no_hostile_within?: number;
  has?: { item: string; count: number };
  lacks?: string;
  doing?: string[]; not_doing?: string[];
  cell?: CellCheck[];
  after_failure?: { skill?: string[]; code?: string[] };
  /** 最近几秒内挨过打 */
  hurt_within?: number;
  /** 身边的掩体：sealed 四面和头顶都封住｜pit 四面封住头顶空｜open 空地 */
  cover?: ('sealed' | 'pit' | 'open')[];
  /** 死后掉在地上、还没捡回的东西（同一维度）：可以限定离这里多远以内、还剩多少秒以上 */
  dropped_items?: { within?: number; left_above?: number };
  /** 只在这些维度生效（overworld / the_nether / the_end） */
  dim?: string[];
  any?: Predicate[]; all?: Predicate[]; not?: Predicate;
}

/** 判断时身体能感觉到的一切 */
export interface Sense {
  state: AgentState;
  hostiles: { name: string; dist: number; fusing?: boolean }[];
  lightLevel: number | null;
  facing: Facing;
  cell(rel: [number, number, number]): string | null;
  /** 正在做的（非填充）动作 */
  doing: string | null;
  /** 恢复类技能：刚才失败的那个动作 */
  failure?: { skill: string; code?: string };
  /** 距上次挨打多少毫秒（不知道为 Infinity） */
  hurtAgoMs: number;
  cover: 'sealed' | 'pit' | 'open';
  /** 死后掉在地上还没捡回的东西（同一维度才有） */
  deathDrop?: { dist: number; leftS: number; count: number } | null;
}

export const PREDICATE_KEYS = ['hp_below', 'food_below', 'oxygen_below', 'in_water', 'in_lava', 'on_ground', 'night', 'dark', 'hostile', 'no_hostile_within',
  'has', 'lacks', 'doing', 'not_doing', 'cell', 'after_failure', 'hurt_within', 'cover', 'dropped_items', 'dim', 'any', 'all', 'not'] as const;

const NAME = /^[a-z0-9_*]{2,60}$/;
const list = (v: unknown): string[] | null => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split('|') : null;
  if (!arr) return null;
  const out = arr.map((x) => String(x).trim().toLowerCase().replace(/^minecraft:/, '')).filter(Boolean);
  return out.length && out.length <= 12 && out.every((x) => NAME.test(x)) ? out : null;
};
const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** 校验并规范化；写错时返回中文说明（交给下一次思考） */
export function validatePredicate(raw: unknown, depth = 0): Predicate | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '条件必须是 JSON 对象' };
  if (depth > 3) return { error: '条件嵌套太深（最多 3 层）' };
  const o = raw as Record<string, any>;
  const out: Predicate = {};
  for (const key of Object.keys(o)) {
    if (!(PREDICATE_KEYS as readonly string[]).includes(key)) return { error: `不认识的条件 "${key}"；能用：${PREDICATE_KEYS.join(' ')}` };
  }
  for (const k of ['hp_below', 'food_below', 'oxygen_below'] as const) if (o[k] !== undefined) {
    if (!num(o[k], 0.5, 21)) return { error: `${k} 要写 1–20 的数` };
    out[k] = o[k];
  }
  for (const k of ['in_water', 'in_lava', 'on_ground', 'night', 'dark'] as const) if (o[k] !== undefined) {
    if (typeof o[k] !== 'boolean') return { error: `${k} 要写 true/false` };
    out[k] = o[k];
  }
  if (o.hostile !== undefined) {
    const h = typeof o.hostile === 'string' ? { name: o.hostile, within: 8 } : o.hostile;
    if (!h || typeof h !== 'object') return { error: 'hostile 写 {"name"?:"skeleton","within":8,"fusing"?:true}' };
    const within = h.within ?? h.dist ?? h.distance ?? 8;
    if (!num(within, 1, 32)) return { error: 'hostile.within 要写 1–32 格' };
    const names = h.name === undefined ? undefined : list(h.name);
    if (h.name !== undefined && !names) return { error: 'hostile.name 要写生物名，比如 "skeleton" 或 ["zombie","husk"]' };
    out.hostile = { within, ...(names ? { name: names } : {}), ...(typeof h.fusing === 'boolean' ? { fusing: h.fusing } : {}) };
  }
  if (o.no_hostile_within !== undefined) {
    if (!num(o.no_hostile_within, 1, 32)) return { error: 'no_hostile_within 要写 1–32 格' };
    out.no_hostile_within = o.no_hostile_within;
  }
  if (o.has !== undefined) {
    const h = typeof o.has === 'string' ? { item: o.has, count: 1 } : o.has;
    if (!h || typeof h.item !== 'string' || !NAME.test(h.item) || !(h.count === undefined || num(h.count, 1, 2304))) return { error: 'has 写物品名，或 {"item":"cobblestone","count":4}；可用 * 通配（"*_planks"）' };
    out.has = { item: h.item, count: h.count ?? 1 };
  }
  if (o.lacks !== undefined) {
    if (typeof o.lacks !== 'string' || !NAME.test(o.lacks)) return { error: 'lacks 写物品名（可用 * 通配）' };
    out.lacks = o.lacks;
  }
  for (const k of ['doing', 'not_doing'] as const) if (o[k] !== undefined) {
    const v = list(o[k]);
    if (!v) return { error: `${k} 写动作名或动作名数组` };
    out[k] = v;
  }
  if (o.cell !== undefined) {
    const cells = Array.isArray(o.cell) ? o.cell : [o.cell];
    if (!cells.length || cells.length > 8) return { error: 'cell 最多写 8 格' };
    out.cell = [];
    for (const c of cells) {
      const at = Array.isArray(c?.at) ? c.at : typeof c?.at === 'string' ? c.at.split(/[,\s]+/).map(Number) : null;
      if (!at || at.length !== 3 || !at.every((n: unknown) => Number.isInteger(n)) || Math.abs(at[0]) > 3 || Math.abs(at[2]) > 3 || at[1] < -3 || at[1] > 4) return { error: 'cell.at 写 [前,上,右]，前后左右 ±3、上下 -3..4' };
      const is = list(c.is);
      if (!is) return { error: 'cell.is 写 air|open|solid|liquid 或方块名（可用 * 通配）' };
      out.cell.push({ at: at as [number, number, number], is: is.length === 1 ? is[0] : is });
    }
  }
  if (o.after_failure !== undefined) {
    const f = o.after_failure === true ? {} : o.after_failure;
    if (!f || typeof f !== 'object') return { error: 'after_failure 写 {"skill"?:"goto","code"?:["PATH_NOT_FOUND","STUCK"]}' };
    const skill = f.skill === undefined ? undefined : list(f.skill);
    const code = f.code === undefined ? undefined : (Array.isArray(f.code) ? f.code : String(f.code).split('|')).map((x: unknown) => String(x).trim().toUpperCase()).filter(Boolean);
    if (f.skill !== undefined && !skill) return { error: 'after_failure.skill 写动作名' };
    if (code && (!code.length || code.some((c: string) => !/^[A-Z_]{3,40}$/.test(c)))) return { error: 'after_failure.code 写失败码，例如 PATH_NOT_FOUND、STUCK、TOOL_MISSING' };
    out.after_failure = { ...(skill ? { skill } : {}), ...(code ? { code } : {}) };
  }
  if (o.hurt_within !== undefined) {
    if (!num(o.hurt_within, 0.5, 60)) return { error: 'hurt_within 写秒数（0.5–60）：最近几秒内挨过打' };
    out.hurt_within = o.hurt_within;
  }
  if (o.cover !== undefined) {
    const c = (Array.isArray(o.cover) ? o.cover : String(o.cover).split('|')).map((x: unknown) => String(x).trim());
    if (!c.length || c.some((x: string) => !['sealed', 'pit', 'open'].includes(x))) return { error: 'cover 写 sealed（四面和头顶都封住）|pit（坑里）|open（空地）' };
    out.cover = c as Predicate['cover'];
  }
  if (o.dim !== undefined) {
    const d = list(o.dim);
    if (!d) return { error: 'dim 写维度名或数组：overworld / the_nether / the_end' };
    out.dim = d;
  }
  if (o.dropped_items !== undefined) {
    const d = o.dropped_items === true ? {} : o.dropped_items;
    if (!d || typeof d !== 'object') return { error: 'dropped_items 写 true，或 {"within":格数,"left_above":秒数}' };
    if ((d as any).within !== undefined && !num((d as any).within, 1, 2000)) return { error: 'dropped_items.within 写 1–2000 格' };
    if ((d as any).left_above !== undefined && !num((d as any).left_above, 0, 300)) return { error: 'dropped_items.left_above 写 0–300 秒（掉落物 5 分钟后消失）' };
    out.dropped_items = { ...((d as any).within !== undefined ? { within: (d as any).within } : {}), ...((d as any).left_above !== undefined ? { left_above: (d as any).left_above } : {}) };
  }
  for (const k of ['any', 'all'] as const) if (o[k] !== undefined) {
    if (!Array.isArray(o[k]) || !o[k].length || o[k].length > 6) return { error: `${k} 写 1–6 个条件的数组` };
    const parts: Predicate[] = [];
    for (const p of o[k]) { const v = validatePredicate(p, depth + 1); if ('error' in v) return v; parts.push(v); }
    out[k] = parts;
  }
  if (o.not !== undefined) {
    const v = validatePredicate(o.not, depth + 1);
    if ('error' in v) return v;
    out.not = v;
  }
  if (!Object.keys(out).length) return { error: '条件是空的' };
  return out;
}

const glob = (pattern: string, name: string) => pattern.includes('*')
  ? new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name)
  : pattern === name;

function cellIs(name: string | null, is: CellIs): boolean {
  if (name === null) return false;
  const air = AIR_BLOCKS.has(name), liquid = LIQUID_BLOCKS.has(name), open = air || isSoftBlock(name);
  if (is === 'air') return air;
  if (is === 'open') return open && !liquid;
  if (is === 'liquid') return liquid;
  if (is === 'solid') return !open && !liquid;
  return glob(is, name);
}

/** 是否只在“某个动作失败”时才有意义（恢复类） */
export function isRecovery(p: Predicate): boolean {
  return !!p.after_failure || !!p.all?.some(isRecovery);
}

export function evalPredicate(p: Predicate, s: Sense): boolean {
  const st = s.state;
  if (p.hp_below !== undefined && !(st.hp < p.hp_below)) return false;
  if (p.food_below !== undefined && !(st.food < p.food_below)) return false;
  if (p.oxygen_below !== undefined && !(st.inWater && st.oxygen < p.oxygen_below)) return false;
  if (p.in_water !== undefined && st.inWater !== p.in_water) return false;
  if (p.in_lava !== undefined && st.inLava !== p.in_lava) return false;
  if (p.on_ground !== undefined && (st.onGround !== false) !== p.on_ground) return false;
  if (p.night !== undefined && !st.isDay !== p.night) return false;
  if (p.dark !== undefined && ((s.lightLevel !== null && s.lightLevel <= 7) !== p.dark)) return false;
  if (p.hostile && !s.hostiles.some((h) => h.dist <= p.hostile!.within && (!p.hostile!.name || p.hostile!.name.some((n) => glob(n, h.name)))
    && (p.hostile!.fusing === undefined || !!h.fusing === p.hostile!.fusing))) return false;
  if (p.no_hostile_within !== undefined && s.hostiles.some((h) => h.dist <= p.no_hostile_within!)) return false;
  if (p.has && st.inventory.filter((i) => glob(p.has!.item, i.name)).reduce((n, i) => n + i.count, 0) < p.has.count) return false;
  if (p.lacks && st.inventory.some((i) => i.count > 0 && glob(p.lacks!, i.name))) return false;
  if (p.doing && !(s.doing && p.doing.includes(s.doing))) return false;
  if (p.not_doing && s.doing && p.not_doing.includes(s.doing)) return false;
  if (p.cell && !p.cell.every((c) => { const n = s.cell(c.at); return (Array.isArray(c.is) ? c.is : [c.is]).some((is) => cellIs(n, is)); })) return false;
  if (p.after_failure) {
    const f = s.failure;
    if (!f || (p.after_failure.skill && !p.after_failure.skill.includes(f.skill)) || (p.after_failure.code && !p.after_failure.code.includes(String(f.code ?? '')))) return false;
  }
  if (p.hurt_within !== undefined && !(s.hurtAgoMs <= p.hurt_within * 1000)) return false;
  if (p.cover && !p.cover.includes(s.cover)) return false;
  if (p.dim && !p.dim.includes(st.dim)) return false;
  if (p.dropped_items) {
    const d = s.deathDrop;
    if (!d || !d.count) return false;
    if (p.dropped_items.within !== undefined && d.dist > p.dropped_items.within) return false;
    if (p.dropped_items.left_above !== undefined && d.leftS <= p.dropped_items.left_above) return false;
  }
  if (p.all && !p.all.every((q) => evalPredicate(q, s))) return false;
  if (p.any && !p.any.some((q) => evalPredicate(q, s))) return false;
  if (p.not && evalPredicate(p.not, s)) return false;
  return true;
}

/** 从适配器和感官凑出此刻的感觉（不透视：怪只认看见/听见的，方块只看身边） */
export function senseNow(adapter: Pick<GameAdapter, 'state' | 'blockAt' | 'eye'> & Partial<Pick<GameAdapter, 'lightAt'>>, senses: Pick<Senses, 'perceivedEntities'>,
  doing: string | null, failure?: Sense['failure'], hurtAgoMs = Infinity): Sense {
  const state = adapter.state();
  let facing: Facing = 'N';
  try { const eye = adapter.eye?.(); if (eye) facing = facingOfYaw(eye.yaw); } catch { /* 朝向暂不可用 */ }
  let hostiles: Sense['hostiles'] = [];
  try { hostiles = senses.perceivedEntities(32).filter((e) => e.kind === 'hostile').map((e) => ({ name: e.name, dist: e.dist, ...(e.fusing ? { fusing: true } : {}) })); } catch { /* 感官暂不可用 */ }
  let lightLevel: number | null = null;
  try { if (adapter.lightAt) lightLevel = measureLight(adapter as Pick<GameAdapter, 'blockAt' | 'lightAt'>, state.pos, state.timeOfDay, state.isDay).level; } catch { /* 光照读不到 */ }
  const feet = feetCell(state.pos);
  const cache = new Map<string, string | null>();
  const cell = (rel: [number, number, number]) => {
    const k = rel.join(',');
    if (!cache.has(k)) { try { cache.set(k, adapter.blockAt(toWorld(feet, facing, rel))); } catch { cache.set(k, null); } }
    return cache.get(k) ?? null;
  };
  return {
    state, hostiles, lightLevel, facing, doing, ...(failure ? { failure } : {}), hurtAgoMs, cell,
    get cover() { return coverOf(cell); },
  };
}

/** 掩体：四面（脚和头的高度）都是实心方块就是坑里/洞里；头顶也封上就是完全藏好了 */
export function coverOf(cell: (rel: [number, number, number]) => string | null): 'sealed' | 'pit' | 'open' {
  const solid = (rel: [number, number, number]) => cellIs(cell(rel), 'solid');
  const walls = ([[1, 0], [-1, 0]] as const).every(([f]) => solid([f, 0, 0]) && solid([f, 1, 0])) && ([1, -1] as const).every((r) => solid([0, 0, r]) && solid([0, 1, r]));
  if (!walls) return 'open';
  return solid([0, 2, 0]) ? 'sealed' : 'pit';
}

/**
 * 条件说的是不是“眼下的危险”：近处的怪、刚挨打、血少、岩浆、快憋死。
 * 只有这种技能可以打断心智手上的事；饿了、天黑、背包缺东西这类“该做某事了”的技能，等手上的事做完再接手。
 * （not 里的不算：“没有怪的时候”恰恰不是危险）
 */
export function isThreat(p: Predicate | undefined): boolean {
  if (!p) return false;
  if (p.hostile || p.hurt_within !== undefined || p.hp_below !== undefined || p.in_lava || p.oxygen_below !== undefined) return true;
  return !!p.any?.some(isThreat) || !!p.all?.some(isThreat);
}

/** 只留“处境”的部分（去掉正在做什么、刚才哪个动作失败）：用来判断触发它的情况解除了没有 */
export function situationOf(p: Predicate): Predicate | null {
  const { doing: _d, not_doing: _n, after_failure: _f, any, all, not, ...rest } = p;
  const out: Predicate = { ...rest };
  if (any) { const xs = any.map(situationOf).filter((x): x is Predicate => !!x); if (xs.length) out.any = xs; }
  if (all) { const xs = all.map(situationOf).filter((x): x is Predicate => !!x); if (xs.length) out.all = xs; }
  if (not) { const x = situationOf(not); if (x) out.not = x; }
  return Object.keys(out).length ? out : null;
}

/** 给模型看的条件说明（一行） */
export function describePredicate(p: Predicate): string {
  return JSON.stringify(p).slice(0, 220);
}

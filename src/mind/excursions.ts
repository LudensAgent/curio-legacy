import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, Vec3Like } from '../adapter/types.ts';
import { dirName } from '../perception/perception.ts';
import { FOOD_VALUE } from '../skills/food.ts';
import { PLACEABLE } from '../skills/survival.ts';

/**
 * 出行记录：按在线观测把身体的经历切成一段段（换维度、死亡、长时间未观测就分段），
 * 记下入口、身体站过的最远脚格、终点、怎么结束，以及背包消耗品与饥饿值的实测变化。
 *
 * 只记发生过的事：带多少、往哪走、走不走旧路都由 Agent 自己掂量。
 * 没观测到的时段（暂停、断线、进程重启）单独累计为“未观测”，不算进在线时长，也不推测其间发生了什么。
 */

const MAX_LEGS = 40;
/** 采样节流：Mind 每 250ms 一拍，出行记录每秒采一次就够 */
const SAMPLE_MS = 1000;
/** 两次采样隔得比这久，就当作这段时间没观测到 */
const GAP_MS = 15_000;
/** 最远点每推进这么多格记一个前沿检查点（给无进展判断用；更细的抖动不算推进） */
const FRONTIER_STEP = 8;
const ARMOR_SLOTS = new Set(['head', 'torso', 'legs', 'feet']);

export interface Supplies {
  foodItems: Record<string, number>; foodPoints: number;
  pickaxes: number; pickaxeDurability: number;
  armor: number; armorMax: number;
  blocks: number; torches: number; /** 旧存档没有这个字段；没有时按未知处理，不补 0 */ emptySlots?: number; hp: number; hunger: number;
}

export type Dir8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

/** 一次朝某方向推进的实测结果；只记程序实际观测到的起点、终点与停止原因。 */
export interface ExploreAttempt {
  at: number; direction: Dir8; requested: number;
  advanced: number; remaining: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'suspended';
  stop?: string;
  obstacle?: Vec3Like;
}

/** 交给 ExcursionLog 的一次探索回执；由任务回执解析或测试直接构造。 */
export interface ExploreRecord {
  at: number; dim: string; direction: string; requested: number; start: Vec3Like; end: Vec3Like;
  status: ExploreAttempt['status']; stop?: string; obstacle?: Vec3Like;
}

const DIR8_VECTORS: Record<Dir8, readonly [number, number]> = {
  N: [0, -1], NE: [Math.SQRT1_2, -Math.SQRT1_2], E: [1, 0], SE: [Math.SQRT1_2, Math.SQRT1_2],
  S: [0, 1], SW: [-Math.SQRT1_2, Math.SQRT1_2], W: [-1, 0], NW: [-Math.SQRT1_2, -Math.SQRT1_2],
};
const DIR_ORDER = Object.keys(DIR8_VECTORS) as Dir8[];
/** 一次探索回执里最多回放几条；只影响提示词长度，不改变记录本身。 */
const RECENT_EXPLORES = 3;

export type LegEnd =
  | { kind: 'dimension'; to: string }
  | { kind: 'death'; cause: string }
  /** 未观测期间结束：再观测到时已换了维度/世界，或这段记录之后再没回来 */
  | { kind: 'unobserved'; to?: string };

export interface Leg {
  id: string; worldId: string; dim: string;
  startedAt: number; lastSampleAt: number;
  onlineMs: number; unobservedMs: number;
  entry: { kind: 'dimension' | 'respawn' | 'resume'; pos: Vec3Like; from?: string };
  /** 离入口水平最远、身体站稳过的脚格 */
  farthest: Vec3Like & { dist: number };
  /** 最远点每推进 FRONTIER_STEP 格的时间点 */
  frontier: number[];
  /** 按 8 方向分别记的、离入口最远的站稳脚格（旧存档没有这个字段） */
  farthestByDirection?: Partial<Record<Dir8, Vec3Like & { dist: number; at: number }>>;
  /** 这段出行里结束过的探索委托（最近 24 次；旧存档没有这个字段） */
  explores?: ExploreAttempt[];
  last: Vec3Like;
  start: Supplies; latest: Supplies;
  /** 饥饿值累计下降的点数 */
  hungerDrop: number;
  /** 背包里减少、同时饥饿值上升的食物（判定为吃掉） */
  eaten: Record<string, number>;
  end?: LegEnd & { at: number; pos: Vec3Like };
}

const foot = (p: Vec3Like) => ({ x: Math.floor(p.x), y: Math.floor(p.y + 0.05), z: Math.floor(p.z) });

function suppliesOf(s: AgentState): Supplies {
  const count = (re: RegExp) => s.inventory.filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0);
  const foodItems: Record<string, number> = {};
  for (const i of s.inventory) if (FOOD_VALUE[i.name]) foodItems[i.name] = (foodItems[i.name] ?? 0) + i.count;
  const picks = s.inventory.filter((i) => i.name.endsWith('_pickaxe'));
  const armor = (s.equipment ?? []).filter((e) => ARMOR_SLOTS.has(e.slot) && e.durabilityRemaining !== undefined);
  return {
    foodItems, foodPoints: Object.entries(foodItems).reduce((n, [k, v]) => n + v * FOOD_VALUE[k].points, 0),
    pickaxes: picks.reduce((n, i) => n + i.count, 0),
    pickaxeDurability: picks.reduce((n, i) => n + (i.durabilities?.length ? i.durabilities.reduce((a, b) => a + b, 0) : (i.durability?.left ?? 0)), 0),
    armor: armor.reduce((n, e) => n + e.durabilityRemaining!, 0), armorMax: armor.reduce((n, e) => n + (e.durabilityMax ?? 0), 0),
    blocks: s.inventory.filter((i) => PLACEABLE.includes(i.name)).reduce((n, i) => n + i.count, 0), torches: count(/^torch$/),
    emptySlots: s.emptySlots, hp: Math.round(s.hp * 10) / 10, hunger: s.food,
  };
}

export class ExcursionLog {
  private data: { version: 1; legs: Leg[] } = { version: 1, legs: [] };
  private prev: { food: number; items: Record<string, number> } | null = null;
  /** 上一拍减少、还没对上饥饿值上升的食物（吃东西时物品和饥饿值的更新可能差一拍） */
  private pendingDrops: Record<string, number> = {};
  private respawning = false;
  private lastSampleAt = 0;
  private dirty = false;
  private savedAt = 0;

  constructor(private file: string | null) {
    if (!file || !fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; legs?: Leg[] };
    if (raw.version === 1 && Array.isArray(raw.legs)) this.data.legs = raw.legs;
  }

  legs(): readonly Leg[] { return this.data.legs; }

  private open(worldId: string) {
    const leg = this.data.legs.at(-1);
    return leg && !leg.end && leg.worldId === worldId ? leg : undefined;
  }

  private close(leg: Leg, end: LegEnd, at: number) {
    leg.end = { ...end, at, pos: { ...leg.last } };
    this.prev = null;
    this.pendingDrops = {};
    this.dirty = true;
    this.save(true);
  }

  private begin(s: AgentState, now: number, entry: Leg['entry']['kind'], from?: string) {
    const pos = foot(s.pos), supplies = suppliesOf(s);
    this.data.legs = [...this.data.legs, {
      id: `leg_${now.toString(36)}`, worldId: s.worldId, dim: s.dim, startedAt: now, lastSampleAt: now, onlineMs: 0, unobservedMs: 0,
      entry: { kind: entry, pos, ...(from ? { from } : {}) }, farthest: { ...pos, dist: 0 }, frontier: [], farthestByDirection: {}, explores: [], last: pos,
      start: supplies, latest: supplies, hungerDrop: 0, eaten: {},
    }].slice(-MAX_LEGS);
    this.respawning = false;
    this.dirty = true;
    this.save(true);
  }

  /** 在线观测的一拍（只在观测就绪、没暂停时调用）。 */
  sample(s: AgentState, now = Date.now()) {
    if (!s.alive || now - this.lastSampleAt < SAMPLE_MS) return;
    this.lastSampleAt = now;
    const stale = this.data.legs.at(-1);
    if (stale && !stale.end && stale.worldId !== s.worldId) this.close(stale, { kind: 'unobserved' }, stale.lastSampleAt);
    const leg = this.open(s.worldId);
    if (!leg) { this.begin(s, now, this.respawning ? 'respawn' : 'resume'); return; }
    const gap = now - leg.lastSampleAt;
    leg.lastSampleAt = now;
    if (gap > GAP_MS) {
      leg.unobservedMs += gap;
      this.prev = null;
      this.pendingDrops = {};
      if (leg.dim !== s.dim) { this.close(leg, { kind: 'unobserved', to: s.dim }, now - gap); this.begin(s, now, 'resume'); return; }
    } else if (leg.dim !== s.dim) {
      this.close(leg, { kind: 'dimension', to: s.dim }, now);
      this.begin(s, now, 'dimension', leg.dim);
      return;
    } else leg.onlineMs += gap;

    if (s.onGround) {
      const pos = foot(s.pos);
      leg.last = pos;
      const dx = pos.x - leg.entry.pos.x, dz = pos.z - leg.entry.pos.z;
      const dist = Math.round(Math.hypot(dx, dz));
      if (dist > leg.farthest.dist) {
        if (Math.floor(dist / FRONTIER_STEP) > Math.floor(leg.farthest.dist / FRONTIER_STEP)) leg.frontier = [...leg.frontier, now].slice(-64);
        leg.farthest = { ...pos, dist };
      }
      if (dist > 0) {
        const dir = dirName(dx, dz) as Dir8;
        const previous = leg.farthestByDirection?.[dir];
        if (!previous || dist > previous.dist) {
          leg.farthestByDirection = { ...(leg.farthestByDirection ?? {}), [dir]: { ...pos, dist, at: now } };
        }
      }
    }
    const supplies = suppliesOf(s);
    if (this.prev) {
      if (s.food < this.prev.food) leg.hungerDrop += this.prev.food - s.food;
      const drops = Object.fromEntries(Object.entries(this.prev.items).flatMap(([k, v]) => v > (supplies.foodItems[k] ?? 0) ? [[k, v - (supplies.foodItems[k] ?? 0)] as const] : []));
      if (s.food > this.prev.food) {
        for (const [k, v] of [...Object.entries(this.pendingDrops), ...Object.entries(drops)]) leg.eaten[k] = (leg.eaten[k] ?? 0) + v;
        this.pendingDrops = {};
      } else this.pendingDrops = drops;
    }
    this.prev = { food: s.food, items: supplies.foodItems };
    leg.latest = supplies;
    this.dirty = true;
    this.save();
  }

  /**
   * 记一次已结束的探索委托：方向、请求距离、实测沿方向推进了多少、离请求还差多少、停在哪。
   * 只记程序拿到的任务回执与实测位置；为什么停、要不要继续由 Agent 判断。
   */
  noteExplore(input: ExploreRecord) {
    const leg = this.data.legs.at(-1);
    if (!leg || leg.end || leg.dim !== input.dim) return;
    const direction = input.direction.toUpperCase();
    if (!Object.hasOwn(DIR8_VECTORS, direction)) return; // 未知方向不记成 0 格推进
    const [vx, vz] = DIR8_VECTORS[direction as Dir8];
    // 带符号：沿请求方向后退就记负数，不把反向位移抹成 0。
    const advanced = (input.end.x - input.start.x) * vx + (input.end.z - input.start.z) * vz;
    leg.explores = [...(leg.explores ?? []), {
      at: input.at, direction: direction as Dir8, requested: input.requested,
      advanced: Math.round(advanced * 10) / 10, remaining: Math.round((input.requested - advanced) * 10) / 10,
      status: input.status, ...(input.stop ? { stop: input.stop.slice(0, 60) } : {}), ...(input.obstacle ? { obstacle: input.obstacle } : {}),
    }].slice(-24);
    this.dirty = true;
  }

  /** 游戏判定死亡：这段到此结束，复活后的下一拍另起一段。 */
  died(cause: string, now = Date.now()) {
    const leg = this.data.legs.at(-1);
    if (leg && !leg.end) this.close(leg, { kind: 'death', cause }, now);
    this.respawning = true;
  }

  /** 当前还没结束的一段（只读）。 */
  current(worldId: string): Readonly<Leg> | undefined { return this.open(worldId); }

  /** 当前这段从 since 之后，离入口的最远点是否又推进了至少一个检查点（FRONTIER_STEP 格）。 */
  frontierAdvancedSince(worldId: string, since: number): boolean {
    const leg = this.open(worldId);
    return !!leg && leg.startedAt <= since && leg.frontier.some((t) => t > since);
  }

  save(force = false) {
    if (!this.file || !this.dirty) return;
    const now = Date.now();
    if (!force && now - this.savedAt < 30_000) return;
    this.savedAt = now;
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

/**
 * 从任务回执解析一次探索记录。任务回执的 data 是各技能自定的形状：
 * explore_toward 用 requestedDirection/requestedDistance/origin/position/stop，
 * expedition 用 coverage.start/end；缺字段就返回 null，不补默认值。
 */
export function exploreAttemptFromReceipt(input: {
  status: ExploreAttempt['status']; failureCode?: string;
  data: Record<string, unknown>; args: Record<string, unknown>; fallbackEnd: Vec3Like;
  at: number; dim: string;
}): ExploreRecord | null {
  const vec = (value: unknown): Vec3Like | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const p = value as Record<string, unknown>;
    return typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number'
      ? { x: p.x, y: p.y, z: p.z } : undefined;
  };
  const coverage = input.data.coverage as { start?: unknown; end?: unknown } | undefined;
  const direction = typeof input.data.requestedDirection === 'string' ? input.data.requestedDirection
    : typeof input.args.direction === 'string' ? input.args.direction : undefined;
  const requested = typeof input.data.requestedDistance === 'number' ? input.data.requestedDistance
    : typeof input.args.distance === 'number' ? input.args.distance : undefined;
  const start = vec(input.args.origin) ?? vec(coverage?.start);
  if (!direction || requested === undefined || start === undefined) return null;
  const stop = input.data.stop as {
    reason?: unknown;
    blocker?: { obstacle?: unknown; cell?: unknown; reason?: unknown };
  } | undefined;
  const obstacle = vec(stop?.blocker?.obstacle) ?? vec(stop?.blocker?.cell);
  const stopText = typeof stop?.reason === 'string'
    ? `${stop.reason}${typeof stop.blocker?.reason === 'string' ? `：${stop.blocker.reason}` : ''}`
    : typeof input.data.stopReason === 'string' ? input.data.stopReason
      : input.status === 'failed' ? input.failureCode : undefined;
  return {
    at: input.at, dim: input.dim, direction, requested, start,
    end: vec(input.data.position) ?? vec(coverage?.end) ?? input.fallbackEnd,
    status: input.status, ...(stopText ? { stop: stopText } : {}), ...(obstacle ? { obstacle } : {}),
  };
}

const DIM_ZH: Record<string, string> = { overworld: '主世界', the_nether: '下界', the_end: '末地' };
const at3 = (p: Vec3Like) => `(${p.x},${p.y},${p.z})`;
const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} 分钟`;
const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000);
  return m < 1 ? '刚才' : m < 90 ? `${m} 分钟前` : m < 48 * 60 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};

/**
 * 一段出行的事实句。here 给出（同维度）时附上最远点相对现在的方位；portalNear 把入口对上已登记的门。
 * 措辞只陈述测到的量，不评价够不够、该不该。
 */
export function describeLeg(leg: Leg, opts: { now?: number; here?: Vec3Like; portalNear?: (pos: Vec3Like) => string | null } = {}): string {
  const now = opts.now ?? Date.now();
  const portal = opts.portalNear?.(leg.entry.pos) ?? null;
  const entry = `${leg.entry.kind === 'dimension' ? `从${DIM_ZH[leg.entry.from ?? ''] ?? leg.entry.from ?? '别的维度'}过来`
    : leg.entry.kind === 'respawn' ? '死亡后复活' : '恢复观测时'}${portal ? `，落在门 ${portal} 旁` : ''}`;
  const far = leg.farthest;
  const fromHere = opts.here ? (() => {
    const dx = far.x + 0.5 - opts.here!.x, dz = far.z + 0.5 - opts.here!.z, d = Math.round(Math.hypot(dx, dz));
    return d ? `，在你 ${dirName(dx, dz)} ${d} 格` : '，就在你这里';
  })() : '';
  const end = leg.end;
  const ending = !end ? `还在这一段，现在 ${at3(leg.last)}`
    : end.kind === 'death' ? `${ago(end.at, now)}死亡结束（${end.cause}），死时最后站稳处 ${at3(end.pos)}`
      : end.kind === 'dimension' ? `${ago(end.at, now)}从 ${at3(end.pos)} 去了${DIM_ZH[end.to] ?? end.to}`
        : `最后观测在 ${at3(end.pos)}，之后未观测${end.to ? `，再观测到时已在${DIM_ZH[end.to] ?? end.to}` : ''}（其间情况未知）`;
  const a = leg.start, b = leg.latest;
  // 旧存档没有空槽：按未知显示，不补 0 假装观测过。
  const slots = `、空槽 ${a.emptySlots ?? '未知'}→${b.emptySlots ?? '未知'}`;
  const eaten = Object.entries(leg.eaten);
  const eatenText = eaten.length
    ? `，吃掉 ${eaten.map(([k, v]) => `${k}×${v}`).join('、')}（+${eaten.reduce((n, [k, v]) => n + v * (FOOD_VALUE[k]?.points ?? 0), 0)}）` : '，没观测到吃东西';
  const span = end ? '' : '至今';
  return [
    `${DIM_ZH[leg.dim] ?? leg.dim}，${ago(leg.startedAt, now)}开始，${span}在线观测 ${minutes(leg.onlineMs)}${leg.unobservedMs > GAP_MS ? `（另有 ${minutes(leg.unobservedMs)}未观测，其间情况未知）` : ''}`,
    `入口 ${at3(leg.entry.pos)}（${entry}）`,
    `身体站过的离入口最远处 ${at3(far)}，离入口 ${far.dist} 格${fromHere}`,
    ending,
    `饥饿值累计降 ${leg.hungerDrop} 点${eatenText}`,
    `${end ? '出发→结束' : '出发→现在'}：背包食物 ${a.foodPoints}→${b.foodPoints} 饥饿点${slots}、镐 ${a.pickaxes}→${b.pickaxes} 把（耐久合计 ${a.pickaxeDurability}→${b.pickaxeDurability}）、身上护甲耐久 ${a.armor}→${b.armor}、土石类填充方块 ${a.blocks}→${b.blocks}、火把 ${a.torches}→${b.torches}`,
  ].join('；');
}

/**
 * 当前这一趟的覆盖事实：按方向的最远站稳点，以及最近几次探索的实际推进/剩余/停止点。
 * 只回放程序测到的数字，不判断该继续哪个方向。
 */
export function describeCoverage(leg: Leg) {
  const byDirection = DIR_ORDER.flatMap((dir) => {
    const point = leg.farthestByDirection?.[dir];
    return point ? [`${dir} ${point.dist} 格 ${at3(point)}`] : [];
  });
  const recentExplores = (leg.explores ?? []).slice(-RECENT_EXPLORES).map((e) => {
    // 程序状态 succeeded 不等于到达目标：走到请求距离才算“走完请求距离”，
    // UNTIL_SEEN 等提前停止仍如实标成“提前停”。
    const outcome = e.status === 'suspended' ? '挂起（可续接）'
      : e.status === 'cancelled' ? '取消'
        : e.status === 'failed' ? '停'
          : e.remaining <= 0 ? '走完请求距离' : '提前停';
    return `${e.direction} 请求 ${e.requested} 格，实测推进 ${e.advanced} 格${e.remaining > 0 ? `，还差 ${e.remaining} 格` : ''}，${outcome}${e.stop ? `（${e.stop}）` : ''}${e.obstacle ? ` @${at3(e.obstacle)}` : ''}`;
  });
  return { by_direction: byDirection, recent_explores: recentExplores };
}

/** 当前这一趟的紧凑事实：入口、在线时长、最远点、各方向最远与最近探索。 */
export function describeCurrentTrip(leg: Leg) {
  return {
    dim: DIM_ZH[leg.dim] ?? leg.dim,
    online_min: Math.round(leg.onlineMs / 60_000),
    entry: at3(leg.entry.pos),
    farthest: `${leg.farthest.dist} 格 ${at3(leg.farthest)}`,
    ...describeCoverage(leg),
    empty_slots: `${leg.start.emptySlots ?? '未知'}→${leg.latest.emptySlots ?? '未知'}`,
  };
}

export const LEG_NOTE = '程序按在线观测记下的身体经历：换维度、死亡或长时间未观测就分段；最远处和终点是当时站稳过的脚格，现在能不能走通未确认，坐标可以直接作为移动目标；消耗是背包与饥饿值的实测变化（吃掉=食物减少且饥饿值同时上升），不含箱子';

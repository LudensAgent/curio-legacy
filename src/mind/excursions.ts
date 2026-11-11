import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, Vec3Like } from '../adapter/types.ts';
import { dirName } from '../perception/perception.ts';
import { FOOD_VALUE } from '../skills/food.ts';

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
const BLOCKS = /^(cobblestone|cobbled_deepslate|stone|dirt|netherrack|deepslate|blackstone|basalt|andesite|diorite|granite|tuff|.*_planks)$/;
const ARMOR_SLOTS = new Set(['head', 'torso', 'legs', 'feet']);

export interface Supplies {
  foodItems: Record<string, number>; foodPoints: number;
  pickaxes: number; pickaxeDurability: number;
  armor: number; armorMax: number;
  blocks: number; torches: number; hp: number; hunger: number;
}

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
    blocks: count(BLOCKS), torches: count(/^torch$/), hp: Math.round(s.hp * 10) / 10, hunger: s.food,
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
      entry: { kind: entry, pos, ...(from ? { from } : {}) }, farthest: { ...pos, dist: 0 }, frontier: [], last: pos,
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
      const dist = Math.round(Math.hypot(pos.x - leg.entry.pos.x, pos.z - leg.entry.pos.z));
      if (dist > leg.farthest.dist) {
        if (Math.floor(dist / FRONTIER_STEP) > Math.floor(leg.farthest.dist / FRONTIER_STEP)) leg.frontier = [...leg.frontier, now].slice(-64);
        leg.farthest = { ...pos, dist };
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

  /** 游戏判定死亡：这段到此结束，复活后的下一拍另起一段。 */
  died(cause: string, now = Date.now()) {
    const leg = this.data.legs.at(-1);
    if (leg && !leg.end) this.close(leg, { kind: 'death', cause }, now);
    this.respawning = true;
  }

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
    `${end ? '出发→结束' : '出发→现在'}：背包食物 ${a.foodPoints}→${b.foodPoints} 饥饿点、镐 ${a.pickaxes}→${b.pickaxes} 把（耐久合计 ${a.pickaxeDurability}→${b.pickaxeDurability}）、身上护甲耐久 ${a.armor}→${b.armor}、垫路方块 ${a.blocks}→${b.blocks}、火把 ${a.torches}→${b.torches}`,
  ].join('；');
}

export const LEG_NOTE = '程序按在线观测记下的身体经历：换维度、死亡或长时间未观测就分段；最远处和终点是当时站稳过的脚格，现在能不能走通未确认，坐标可以直接作为移动目标；消耗是背包与饥饿值的实测变化（吃掉=食物减少且饥饿值同时上升），不含箱子';

import { durationText, realSecondsToTicks, TICKS_PER_GAME_HOUR } from './time.ts';
export { durationText, realSecondsToTicks, TICKS_PER_GAME_HOUR } from './time.ts';
import { isSoftBlock, surroundings, type ExitOptions, type Surroundings } from './surroundings.ts';
import { isContainerLandmark, qtyWord, rememberedStock } from '../memory/chest-memory.ts';
import { facingOfYaw, localMap } from './local.ts';
import type { GameAdapter, InvItem, Vec3Like } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { dist3, effectiveLight, round1, lightAround } from '../util.ts';
import { torchCount } from '../skills/light.ts';
import { interactiveName, INTERACTIVE_BLOCKS, NOTABLE, type Vision, type VisionSummary } from './vision.ts';
import { type Drive, type Stock } from '../brain/drives.ts';
import { PassageTracker } from '../memory/passages.ts';
import { isResourceBlock, oreKind } from '../memory/ore-spots.ts';
import { EffectWatch } from '../brain/effects.ts';
import { efficiencyInsights, type EfficiencyInsight } from '../brain/efficiency.ts';
import { learnCandidates, reflectionDue } from '../brain/habits.ts';

export const DIRS: Record<string, [number, number]> = {
  N: [0, -1], NE: [0.707, -0.707], E: [1, 0], SE: [0.707, 0.707],
  S: [0, 1], SW: [-0.707, 0.707], W: [-1, 0], NW: [-0.707, -0.707],
};

const DANGER = new Set(['lava', 'spawner']);
const STRUCTURE_HINT = new Set(['chest', 'bell', 'hay_block', 'spawner', 'furnace']);
/** 功能方块地标的标签（'工作台' 或 '我的工作台'）：拆掉/消失后也要从记忆里清掉 */
const INTERACTIVE_LABELS = new Set(Object.values(INTERACTIVE_BLOCKS));
const stationLabel = (label: string): string | undefined => {
  const zh = label.startsWith('我的') ? label.slice(2) : label;
  return INTERACTIVE_LABELS.has(zh) ? zh : undefined;
};

export interface Percept {
  ts: number;
  connected: boolean;
  observation?: { ready: boolean; worldId: string; sessionId: string; id: number };
  /** can_sleep：只有夜里（或雷雨）才能上床睡觉，白天 sleep 会失败 */
  time: { timeOfDay: number; phase: 'day' | 'dusk' | 'night' | 'dawn'; isDay?: boolean; can_sleep?: boolean; day?: number; weather?: string };
  self: { pos: [number, number, number]; dim: string; hp: number; food: number; biome: string | null; inWater: boolean; inLava: boolean; held: string | null; onGround?: boolean; riding?: string | null; equipment?: { slot: string; name: string }[]; around?: string;
    contacts?: Pick<ReturnType<typeof surroundings>, 'support' | 'feet' | 'head'>;
    sky_visible?: boolean | null; depth_below_surface?: number | null; exits?: ExitOptions;
    /** 一句话说清自己在哪：地表 / 屋里 / 坑里（几格深）/ 地下 / 水里 */
    where?: { kind: WhereKind; text: string; depth?: number; building?: string };
    /** 抬头看到的第一个方块（只看正上方这一列，第一个实心方块之后的看不见）：分清“被树冠遮住”和“在地下” */
    overhead?: { block: string | null; up: number | null; covered: 'open' | 'canopy' | 'roof' | 'rock' };
    /** 身边的方块图（以脚为原点的 [前,上,右]，不透视），配合 dig_at/step/place_at 说出确切的格子 */
    local?: ReturnType<typeof localMap> };
  inventory: InvItem[];
  /** 身上的状态效果（名字） */
  effects?: string[];
  emptySlots: number;
  /** 只包含看见/听见/记得的东西（没有透视） */
  nearby: {
    hostile: { name: string; dist: number; how: 'seen' | 'heard'; fusing?: boolean; traits?: string }[];
    passive: string[];
    players: string[];
    /** 看得见的 + 记得的资源方块 */
    resources: { block: string; count: number; nearest: number; dir?: string; seen: 'now' | 'memory' }[];
  };
  vision: VisionSummary | null;
  /** 死亡掉落记录：剩余秒数是按正常 TPS 且持续加载估算的现实秒，不代表物品当前状态 */
  death_recovery: { dir: string; dist: number; lost: string; seconds_left: number } | null;
  /** 看见过但还没去过的有趣东西（好奇心候选） */
  curiosities: { what: string; dir: string; dist: number }[];
  objective: string | null;
  /** 游玩欲望（按强度排序） */
  drives: Drive[];
  stock: Stock | null;
  /** 亮度感知：脚下的实际亮度、是否会刷怪、视野里有多少看不清 */
  light: {
    here: number;
    block: number;
    sky: number;
    level: 'bright' | 'dim' | 'dark';
    mob_spawn_risk: boolean;
    dark_view_pct: number;
    underground: boolean;
    torches: number;
  } | null;
  /** 仓储：记得的箱子与里面存了什么 */
  storage: { chests: number; nearest: number | null; stored: string; source?: 'fuzzy_recollection'; availability?: 'unconfirmed_until_opened'; oldestObservedAt?: number; ageSeconds?: number } | null;
  /** 农田：作物、格数、成熟数量（离得近时才能看清） */
  farms: { crop: string; cells: number; dist: number; mature: number | null; minutes_since_planted: number }[];
  /** 自己开了头、要等它自己变化的事（熔炉里烧着的东西……）：离开时的样子 + 现在看得见的样子 */
  waiting_on?: string[];
  /** 最近反复成功的同一套步骤（可以 learn_skill 学成技能） */
  learn_candidates: { steps: string; times: number }[];
  /** 是否该反思一下（在 lesson 字段写经验） */
  reflection_due: boolean;
  /** 效率洞察：最近的采集速度，以及换哪把工具能快多少（偷懒的依据） */
  efficiency: EfficiencyInsight[];
  exploration: {
    visitedChunks: number;
    noveltyByDir: Record<string, number>;
    base: { dist: number; dir: string } | null;
  };
}

export function phaseOf(t: number): Percept['time']['phase'] {
  if (t < 12000) return 'day';
  if (t < 13800) return 'dusk';
  if (t < 22200) return 'night';
  return 'dawn';
}

/** 这里实际是什么天气：雨落在干燥群系不下、在冷的群系变成雪（原版按群系温度）；雷雨时天光暗，白天也会刷怪 */
const DRY = /desert|savanna|badlands/;
const COLD = /snowy|frozen|ice_spikes|grove|jagged_peaks|frozen_peaks/;
export function weatherHere(weather: string, biome: string | null): string {
  if (weather === 'clear') return '晴';
  const b = biome ?? '';
  const fall = DRY.test(b) ? '（这里干燥，不落雨）' : COLD.test(b) ? '（这里冷，下的是雪）' : '';
  return weather === 'thunder' ? `雷雨${fall}：天很暗，白天也会刷怪，会打雷；雷雨时随时能上床睡` : `下雨${fall}`;
}

/** 离天黑 / 天亮还有几分钟（现实时间；正常 20 TPS 时现实 1 分钟 = 1200 刻），给心智一个“时间感” */
export function clockOf(timeOfDay: number): { toDusk: number | null; toDawn: number | null } {
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  const min = (ticks: number) => Math.max(0, Math.round(ticks / 120) / 10);
  return t < 12000 ? { toDusk: min(12000 - t), toDawn: null } : { toDusk: null, toDawn: min(t < 23000 ? 23000 - t : 24000 + 23000 - t) };
}

/**
 * 游戏钟点：给心智的时间感一律用游戏里的钟点说，不用现实分钟。
 * “离天黑 2 分钟”在人听来是一眨眼，于是它太阳还高高的就收工挖坑、干等；正常速度下现实 2 分钟是游戏白天的五分之一，
 * 够砍二三十根木头。换成“下午 4 点，晚上 7 点天黑”，人对钟点的直觉正好和游戏里的比例对得上。
 * 0 刻 = 早上 6 点，1000 刻 = 1 小时（现实约 50 秒）；18 点日落，约 18 点半能睡，19 点天黑开始刷怪，5 点天亮。
 */
export const SUNSET_TICK = 12000;
export const SLEEP_TICK = 12542;
export const DARK_TICK = 13000;
export const DAWN_TICK = 23000;

const tod24 = (t: number) => ((t % 24000) + 24000) % 24000;
/** 从 from 往后数到 to 还有多少刻（跨午夜） */
export const ticksUntil = (from: number, to: number) => (tod24(to) - tod24(from) + 24000) % 24000;

/** 钟点的说法：“下午 3 点”“晚上 6 点半”“凌晨 2 点” */
export function clockText(timeOfDay: number): string {
  const totalMin = Math.round(((tod24(timeOfDay) / TICKS_PER_GAME_HOUR + 6) % 24) * 60 / 30) * 30;
  const h = Math.floor(totalMin / 60) % 24, half = totalMin % 60 === 30;
  const part = h === 0 ? '半夜' : h < 5 ? '凌晨' : h < 8 ? '早上' : h < 11 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : h < 19 ? '傍晚' : '晚上';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${part} ${h12} 点${half ? '半' : ''}`;
}

/** 太阳在哪：像人抬头看天 */
export function sunText(timeOfDay: number): string {
  const t = tod24(timeOfDay);
  if (t < 1500) return '太阳刚升起不久';
  if (t < 4500) return '太阳还在东边';
  if (t < 7500) return '太阳很高';
  if (t < 10500) return '太阳偏西';
  if (t < SUNSET_TICK) return '太阳快挨着地平线了';
  if (t < DARK_TICK) return '太阳在落山';
  if (t < DAWN_TICK) return '天黑着';
  return '东边天开始亮了';
}

/** 一句话的时间感，给【身体】用：几点、太阳在哪、离天黑 / 能睡 / 天亮还有多久（都是游戏时间） */
export function timeSense(timeOfDay: number, opts: { canSleep?: boolean } = {}): string {
  const t = tod24(timeOfDay);
  const head = `${clockText(t)}，${sunText(t)}`;
  if (t < SUNSET_TICK) return `${head}；离天黑（晚上 7 点，开始刷怪）还有${durationText(ticksUntil(t, DARK_TICK))}`;
  if (t < DARK_TICK) return `${head}；${opts.canSleep ? '已经能睡觉，' : `${durationText(ticksUntil(t, SLEEP_TICK))}后能睡觉，`}${durationText(ticksUntil(t, DARK_TICK))}后天黑刷怪`;
  return `${head}；离天亮（早上 5 点）还有${durationText(ticksUntil(t, DAWN_TICK))}${opts.canSleep ? '，能睡觉' : ''}`;
}

/** 原版：12542–23459 刻之间才能睡觉；雷雨时任何时候都能睡 */
export function canSleepAt(timeOfDay: number, weather?: string): boolean {
  if (weather === 'thunder') return true;
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  return t >= 12542 && t <= 23459;
}

export function dirName(dx: number, dz: number): string {
  const ang = (Math.atan2(dx, -dz) * 180) / Math.PI; // 0 = 北(-Z)
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(((ang + 360) % 360) / 45) % 8];
}

/**
 * 感知摘要器：每次先让 Vision 扫描一遍视野，再把“看见/听见/记得”的东西压缩成 LLM 可读的 JSON。
 * 新发现（首次看见的方块/实体/群系）只在真正看见时触发。
 */
export type WhereKind = 'surface' | 'indoors' | 'pit' | 'underground' | 'water' | 'unknown';
/** 这一格是不是自己盖的房子的一部分（由 main 接上 skills/build.ts 的 ownBuildingAt，感知层不直接依赖建造） */
export type OwnBuiltLookup = (pos: Vec3Like, block: string) => { name: string } | null;

export class Perception {
  /** 判断“围着我的是不是自己盖的墙”，用来区分屋里和坑里 */
  ownBuilt?: OwnBuiltLookup;
  /** 跟着身体记自己挖过的通道（矿道、台阶井） */
  private passages: PassageTracker;
  private lastDugAt = 0;
  /** 第一次拿到某个物品时回调（heldBefore 是之前拿到过的物品） */
  onNewItem?: (item: string, heldBefore: Set<string>) => void;
  private latest: Percept | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastVisionBody: { scope: string; pos: Vec3Like } | null = null;
  private surfaceScope = '';
  /** Only surface heights stood on and observed in this session; never hidden terrain. */
  private surfaceColumns = new Map<string, { y: number; at: number }>();

  constructor(private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus, private vision: Vision) {
    this.passages = new PassageTracker(memory);
    // 做完的事有没有留住：扔掉的东西被捡回来了，身体当场就知道
    const effects = new EffectWatch(bus);
    adapter.on?.('recollected', (r: { item: string; count: number }) => effects.recollected(r.item, r.count));
  }

  observeBlocks(positions: Vec3Like[]) { return this.vision.observeBlocks(positions); }

  /** 上次亲眼看到熔炉时火亮没亮：亮→灭是一次“状态转换”，值得注意 */
  private furnaceLit = new Map<string, boolean>();

  /**
   * 熔炉里留着的东西：记得放了什么、什么时候离开的；看得见熔炉时对照火亮不亮。
   * 火灭了、原料还在 → 多半燃料没了；火灭了、原料没了 → 烧完了，成品在等着取。
   */
  private waitingOn(dim: string, here: Vec3Like): string[] {
    const recs = this.memory.furnaces(dim);
    if (!recs.length) return this.dropsWaiting(here);
    const seen = new Map(this.vision.observeBlocks(recs.filter((r) => dist3(r.pos, here) <= 48).map((r) => r.pos)).map((o) => [`${o.pos.x},${o.pos.y},${o.pos.z}`, o]));
    const out: { d: number; text: string }[] = [];
    for (const r of recs) {
      const key = `${r.pos.x},${r.pos.y},${r.pos.z}`, d = Math.round(dist3(r.pos, here));
      const at = `熔炉 (${key}) ${d}格`;
      const o = seen.get(key);
      if (o && !/^(furnace|blast_furnace|smoker)$/.test(o.name)) { this.memory.forgetFurnace(dim, r.pos); this.furnaceLit.delete(key); continue; }
      const elapsed = Math.max(0, (Date.now() - r.ts) / 1000);
      const inside = [r.input ? `没烧的 ${r.input.name}×${r.input.count}` : '', r.output ? `烧好的 ${r.output.name}×${r.output.count}` : ''].filter(Boolean).join('、');
      const left = `${elapsed < 1 ? '刚才' : `${durationText(realSecondsToTicks(elapsed))}前（游戏时间，按正常运行速度估算）`}离开时里面有 ${inside}${r.why === 'out_of_fuel' ? '（当时燃料就烧完了）' : r.why === 'stalled' ? '（当时卡住不动）' : ''}`;
      let now = '';
      if (o) {
        const lit = String(o.properties?.lit) === 'true';
        const before = this.furnaceLit.get(key) ?? r.burning;
        this.furnaceLit.set(key, lit);
        now = lit ? '；现在看过去火还亮着，在烧' : r.input ? '；现在看过去火灭了：原料没烧完，燃料多半用完了' : '；现在看过去火灭了：烧完了，成品在等着取';
        if (before && !lit) this.bus.publish('process_changed', 'P2', `${at}的火灭了：${r.input ? `里面的 ${r.input.name} 多半没烧完，燃料用完了` : '东西烧完了'}，要的话回去取（collect_furnace）`, { kind: 'furnace', pos: r.pos });
      } else if (r.burning && r.input) {
        // 看不见：按原版一件 10 秒估一下，只是估计
        const doneBy = r.ts + r.input.count * 10_000;
        now = Date.now() > doneBy ? '；按正常运行速度估算可能烧完了（燃料够且区块持续加载的话），没亲眼看到' : '；按正常运行速度估算可能还在烧，没亲眼看到';
      }
      out.push({ d, text: `${at}：${left}${now}` });
    }
    return [...out.sort((a, b) => a.d - b.d).slice(0, 4).map((x) => x.text), ...this.dropsWaiting(here)];
  }

  /**
   * 地上见过、还没捡的东西：出生时间和区块加载情况未知，按正常 TPS 估算仅供参考。
   * 第一次看到不到 45 现实秒的不提；自己扔掉的不提。
   */
  private dropWarned = new Set<string>();
  private dropsWaiting(here: Vec3Like): string[] {
    if (this.dropWarned.size > 200) this.dropWarned.clear();
    const all = this.vision.dropsSeen?.() ?? [];
    const groups: { name: string; pos: Vec3Like; count: number; firstMs: number; visible: boolean }[] = [];
    for (const d of all) {
      if (d.firstMs < 45_000 || this.adapter.isDiscarded?.(d.name, d.pos)) continue;
      const g = groups.find((x) => x.name === d.name && dist3(x.pos, d.pos) <= 3);
      if (g) { g.count += d.count ?? 1; g.firstMs = Math.max(g.firstMs, d.firstMs); g.visible ||= d.visible; } else groups.push({ name: d.name, pos: d.pos, count: d.count ?? 1, firstMs: d.firstMs, visible: d.visible });
    }
    const inv = this.adapter.state().inventory;
    const have = (n: string) => inv.filter((i) => i.name === n).reduce((t, i) => t + i.count, 0);
    return groups.sort((a, b) => b.firstMs - a.firstMs).slice(0, 3).map((g) => {
      const left = Math.max(0, Math.round((300_000 - g.firstMs) / 60_000 * 10) / 10);
      const at = `(${Math.round(g.pos.x)},${Math.round(g.pos.y)},${Math.round(g.pos.z)}) ${Math.round(dist3(g.pos, here))}格`;
      const key = `${g.name}@${Math.round(g.pos.x)},${Math.round(g.pos.z)}`;
      // 快消失了、背包里又没多少的东西：值得注意一下（要不要回去捡由它自己判断）
      if (left <= 2 && have(g.name) < 16 && !this.dropWarned.has(key)) {
        this.dropWarned.add(key);
        this.bus.publish('process_changed', 'P2', `地上的 ${g.name}×${g.count} ${at}已见过一段时间；掉落物存在 6000 个实体刻后消失，出生时间和加载情况未知`, { kind: 'drop', pos: key });
      }
      return `地上的 ${g.name}×${g.count} ${at}：约 ${durationText(realSecondsToTicks(g.firstMs / 1000)).replace(/^约 /, '')}前第一次看到（按正常 TPS 折算的游戏时间）${g.visible ? '，现在看得见' : '，现在不在视野里'}；出生时间和区块加载情况未知，无法确定何时消失`;
    });
  }

  start(intervalMs = 700) {
    this.timer = setInterval(() => {
      try {
        this.update();
      } catch (e: any) {
        this.bus.publish('perception_error', 'P1', String(e?.message ?? e));
      }
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): Percept {
    const state = this.adapter.state();
    const observation = this.latest?.observation;
    if (!observation || observation.ready !== state.observationReady || observation.worldId !== state.worldId || observation.sessionId !== state.sessionId || this.latest?.self.dim !== state.dim) return this.update();
    return this.latest!;
  }

  /** 由 main 注入：已经学会的技能对应的步骤签名（避免重复提示） */
  knownSkillSigs?: () => Set<string>;

  private storageInfo(dim: string, here: { x: number; z: number }): Percept['storage'] {
    const chests = this.memory.chests().filter((c) => c.dim === dim);
    if (!chests.length) return null;
    const nearest = Math.min(...chests.map((c) => Math.round(Math.hypot(c.pos.x - here.x, c.pos.z - here.z))));
    // 记得的是印象（放过/见过什么、大概多少），不是库存清单
    const stock = rememberedStock(chests, this.memory.chestClock(this.adapter.state().worldDay));
    const oldestObservedAt = Math.min(...chests.map((chest) => chest.ts));
    return { chests: chests.length, nearest, stored: stock.slice(0, 14).map((x) => `${x.item}${x.qty ? `（${qtyWord(x.qty)}）` : ''}${x.confidence === 'vague' ? '?' : ''}`).join('、') || '（记不得放过什么）',
      source: 'fuzzy_recollection', availability: 'unconfirmed_until_opened', oldestObservedAt,
      ageSeconds: Math.max(0, Math.round((Date.now() - oldestObservedAt) / 1000)) };
  }

  private farmInfo(dim: string, here: { x: number; z: number }): Percept['farms'] {
    return this.memory.farms().filter((f) => f.dim === dim && f.cells.length).map((f) => {
      const dist = Math.round(Math.hypot(f.cells[0].x - here.x, f.cells[0].z - here.z));
      let mature: number | null = null;
      if (dist <= 48) {
        let observed = 0;
        mature = 0;
        for (const c of f.cells) {
          const a = this.adapter.cropAge({ x: c.x, y: c.y + 1, z: c.z });
          if (a) observed++;
          if (a && a.age >= a.max) mature++;
        }
        if (observed !== f.cells.length) mature = null;
      }
      return { crop: f.crop, cells: f.cells.length, dist, mature, minutes_since_planted: Math.round((Date.now() - f.plantedAt) / 60000) };
    });
  }

  private lightInfo(s: ReturnType<GameAdapter['state']>): Percept['light'] {
    const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y), z = Math.floor(s.pos.z);
    const l = lightAround(this.adapter, x, y, z);
    if (!l) return null;
    const here = effectiveLight(l, s.timeOfDay);
    const comp = this.vision.composition;
    const total = Object.values(comp).reduce((a, b) => a + b, 0) || 1;
    return {
      here,
      block: l.block,
      sky: l.sky,
      level: here >= 10 ? 'bright' : here >= 4 ? 'dim' : 'dark',
      // 1.18+：方块光为 0 且足够暗时会刷敌对生物
      mob_spawn_risk: l.block === 0 && here <= 7,
      dark_view_pct: Math.round(((comp.dark ?? 0) / total) * 100),
      underground: l.sky <= 4,
      torches: torchCount(s.inventory),
    };
  }

  /** 抬头看：正上方这一列从头顶起第一个实心方块（看不穿它，也不推测它上面有什么） */
  private overheadInfo(s: ReturnType<GameAdapter['state']>): NonNullable<Percept['self']['overhead']> {
    const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y), z = Math.floor(s.pos.z);
    for (let up = 2; up <= 24; up++) {
      const name = this.adapter.blockAt({ x, y: y + up, z });
      if (name === null) return { block: null, up: null, covered: 'open' };
      if (isSoftBlock(name)) continue;
      const covered = /(_leaves|_log|_wood|vine|mushroom_block|azalea|mangrove_roots)$/.test(name) ? 'canopy'
        : /(planks|glass|_slab|_stairs|wool|terracotta|bricks|concrete|_door|_trapdoor|fence)/.test(name) ? 'roof' : 'rock';
      return { block: name, up, covered };
    }
    return { block: null, up: null, covered: 'open' };
  }

  private bodyEnvironment(s: ReturnType<GameAdapter['state']>, contact: Surroundings | null, light: Percept['light']) {
    const scope = `${s.worldId}:${s.sessionId}:${s.dim}`;
    if (scope !== this.surfaceScope) { this.surfaceScope = scope; this.surfaceColumns.clear(); }
    if (!contact) return { sky_visible: null, depth_below_surface: null };
    const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y), z = Math.floor(s.pos.z), now = Date.now();
    const opaque = (name: string | null) => name !== null && !isSoftBlock(name) && !/(glass|leaves|ice|water|lava|bubble_column)/.test(name);
    // A missing sky ray alone says nothing when looking down. A fresh overhead
    // surface or a touched opaque ceiling can establish that this column is covered.
    const ceiling = opaque(contact.above) || [...this.vision.visibleNow.values()].some((b) => b.pos.x === x && b.pos.z === z && b.pos.y > y + 1 && opaque(b.name));
    const observedSky = (this.vision.composition.sky ?? 0) > 0;
    const confirmedSky = observedSky && (s.dim === 'the_end' || s.dim === 'overworld' && (light?.sky ?? 0) > 0);
    const skyVisible = s.dim === 'the_nether' ? false : confirmedSky ? true : ceiling ? false : null;
    for (const [key, surface] of this.surfaceColumns) if (now - surface.at > 10 * 60_000) this.surfaceColumns.delete(key);
    const key = `${x},${z}`;
    // Full local skylight plus a visible sky and touched footing is an exposed
    // surface estimate. Preserve a previously observed higher surface on descent.
    if (s.dim === 'overworld' && skyVisible && !ceiling && light?.sky === 15 && s.onGround && opaque(contact.below)) {
      const previous = this.surfaceColumns.get(key);
      if (!previous || s.pos.y >= previous.y) this.surfaceColumns.set(key, { y: s.pos.y, at: now });
      if (this.surfaceColumns.size > 256) this.surfaceColumns.delete(this.surfaceColumns.keys().next().value!);
    }
    const surface = this.surfaceColumns.get(key);
    return { sky_visible: skyVisible, depth_below_surface: surface ? round1(Math.max(0, surface.y - s.pos.y)) : null };
  }

  /** 自己挖掉了矿：那一处记下的矿点就没了（同一片矿脉里还看得见的，下一次看见时会重新记） */
  private forgetMinedOre(s: { dim: string }, dug: { pos: Vec3Like; name: string }[]) {
    for (const d of dug) {
      if (!isResourceBlock(d.name)) continue;
      for (const l of this.memory.landmarks()) {
        if (l.kind === 'resource' && l.dim === s.dim && oreKind(l.label) === oreKind(d.name)
          && Math.hypot(l.pos.x - d.pos.x, l.pos.y - d.pos.y, l.pos.z - d.pos.z) <= 3) this.memory.removeLandmark(l.id);
      }
    }
  }

  /**
   * 同种生物按实际所见的位置分群；一次短暂目击也留下历史线索。
   * 没看见不证明离开或消失，旧点只由已有的历史时间规则控制召回。
   */
  private noteHerds(s: { dim: string; pos: Vec3Like }, seen: { name: string; kind: string; pos: Vec3Like; traits?: string; how?: string }[]) {
    const groups = seen.filter((e) => e.kind === 'passive' && e.how !== 'heard')
      .reduce<{ name: string; list: typeof seen }[]>((groups, e) => {
        const joined = groups.filter((g) => g.name === e.name && g.list.some((other) => Math.hypot(other.pos.x - e.pos.x, other.pos.y - e.pos.y, other.pos.z - e.pos.z) < 32));
        return [...groups.filter((g) => !joined.includes(g)), { name: e.name, list: [e, ...joined.flatMap((g) => g.list)] }];
      }, []);
    for (const { name, list } of groups) {
      const c = { x: list.reduce((a, e) => a + e.pos.x, 0) / list.length, y: list.reduce((a, e) => a + e.pos.y, 0) / list.length, z: list.reduce((a, e) => a + e.pos.z, 0) / list.length };
      const tally = new Map<string, number>();
      for (const e of list) for (const t of (e.traits ?? '').split('、').filter(Boolean)) tally.set(t, (tally.get(t) ?? 0) + 1);
      const detail = [...tally].map(([t, n]) => `${t}×${n}`).join('、').slice(0, 60);
      this.memory.noteHerd(name, s.dim, c, list.length, detail || undefined);
    }
  }

  private vanishedCheckAt = 0;
  /** Only fresh sight can contradict a remembered resource, hazard or functional block. */
  private forgetVanishedOre(s: { dim: string; pos: Vec3Like }) {
    if (Date.now() - this.vanishedCheckAt < 2000) return;
    this.vanishedCheckAt = Date.now();
    // 记着的矿点、岩浆这类危险点：走近了、亲眼看那一格（视线真的够得着）已经不是它了——
    // 岩浆被水浇成了黑曜石、被舀走、矿被挖了——就忘掉，免得一直惦记一处早就没了的东西
    const watched = this.memory.landmarks().filter((l) => l.dim === s.dim && (l.kind === 'resource' ? isResourceBlock(l.label)
      : l.kind === 'danger' ? DANGER.has(l.label) : isContainerLandmark(l.label) || stationLabel(l.label) !== undefined)
      && Math.hypot(l.pos.x - s.pos.x, l.pos.y - s.pos.y, l.pos.z - s.pos.z) <= this.vision.effectiveRange());
    const boxes = this.memory.chests(s.dim).filter((c) => !watched.some((l) => dist3(l.pos, c.pos) < .1)
      && dist3(c.pos, s.pos) <= this.vision.effectiveRange());
    if (!watched.length && !boxes.length) return;
    // 先取刚扫到的表面，再专门看一眼这些格子（视线够得着才算看见）
    const glimpsed = new Map(watched.map((l) => [l.id, this.vision.seenAt(l.pos)]));
    const positions = [...watched, ...boxes].map((l) => l.pos);
    const seen = new Map(Array.from({ length: Math.ceil(positions.length / 32) }, (_, i) => this.vision.observeBlocks(positions.slice(i * 32, (i + 1) * 32))).flat()
      .map((o) => [`${o.pos.x},${o.pos.y},${o.pos.z}`, o]));
    for (const l of watched) {
      const observed = seen.get(`${l.pos.x},${l.pos.y},${l.pos.z}`);
      const now = observed?.name ?? glimpsed.get(l.id);
      if (isContainerLandmark(l.label)) {
        if (now && !isContainerLandmark(now)) {
          this.memory.removeLandmark(l.id);
          this.memory.forgetChest(s.dim, l.pos);
          this.memory.markGone(l.label, s.dim, l.pos, now);
        }
        continue;
      }
      const zh = stationLabel(l.label);
      if (zh !== undefined) {
        if (now && interactiveName(now) !== zh) {
          this.memory.removeLandmark(l.id);
          this.memory.markGone(l.label, l.dim, l.pos, now);
        }
        continue;
      }
      const flowing = l.kind === 'resource' && l.label === 'lava' && observed?.name === 'lava'
        && observed.properties.level !== undefined && Number(observed.properties.level) !== 0;
      if (flowing || now && oreKind(now) !== oreKind(l.label) && !(l.label === 'lava' && /lava/.test(now))) {
        this.memory.removeLandmark(l.id);
        this.memory.markGone(l.label, l.dim, l.pos, flowing ? 'lava（流动，非源方块）' : now!);
      }
    }
    for (const c of boxes) {
      const now = seen.get(`${c.pos.x},${c.pos.y},${c.pos.z}`)?.name;
      if (now && !isContainerLandmark(now)) {
        this.memory.forgetChest(s.dim, c.pos);
        this.memory.markGone('箱子', s.dim, c.pos, now);
      }
    }
  }

  /** 自己挖的通道洞口：亲眼看那一格已变成实心（被封/塌了），就把这个洞口从记录里去掉；最后一个洞口也没了就整条通道作废 */
  private forgetSealedEntrances(s: { dim: string; pos: Vec3Like }) {
    const recs = this.memory.passages(s.dim);
    const near = recs.flatMap((r) => r.entrances.map((e) => ({ id: r.id, e })))
      .filter(({ e }) => Math.hypot(e.x - s.pos.x, e.y - s.pos.y, e.z - s.pos.z) <= this.vision.effectiveRange());
    if (!near.length) return;
    const positions = near.map(({ e }) => e);
    const seen = new Map(Array.from({ length: Math.ceil(positions.length / 32) }, (_, i) => this.vision.observeBlocks(positions.slice(i * 32, (i + 1) * 32))).flat()
      .map((o) => [`${o.pos.x},${o.pos.y},${o.pos.z}`, o]));
    for (const { id, e } of near) {
      const o = seen.get(`${e.x},${e.y},${e.z}`);
      if (!o) continue; // 没看见（遮挡/未加载）：不猜，留着
      if (isSoftBlock(o.name) || o.name === 'water' || o.name === 'lava' || o.name === 'bubble_column') continue; // 还空着/是水：洞口还在
      const rec = this.memory.passages(s.dim).find((r) => r.id === id);
      if (!rec) continue;
      rec.entrances = rec.entrances.filter((p) => !(p.x === e.x && p.y === e.y && p.z === e.z));
      if (rec.entrances.length) this.memory.savePassage(rec);
      else this.memory.forgetPassage(id);
      this.memory.markGone('矿口', s.dim, e, o.name);
    }
  }

  update(): Percept {
    const s = this.adapter.state();
    this.memory.setWorld(s.worldId);
    const priorFrame = this.vision.frame;
    this.vision.refresh();
    const scope = `${s.worldId}:${s.sessionId}:${s.dim}`;
    const previous = this.lastVisionBody;
    if (this.vision.frame && this.vision.frame === priorFrame && (!previous || previous.scope !== scope ||
      previous.pos.x !== s.pos.x || previous.pos.y !== s.pos.y || previous.pos.z !== s.pos.z)) this.vision.scan();
    this.lastVisionBody = { scope, pos: { ...s.pos } };
    const v = this.vision;
    const here = s.pos;

    if (s.connected && s.alive && s.observationReady) {
      if (this.memory.visit(s.dim, s.pos)) this.bus.publish('new_chunk', 'P3', `进入未访问区块（累计 ${this.memory.visitedChunkCount}）`);
      if (s.biome && this.memory.markSeen('biomes', s.biome)) {
        this.bus.publish('discovery', 'P2', `首次进入生物群系：${s.biome}`, { category: 'biome', name: s.biome });
        this.memory.addLandmark('discovery', `biome:${s.biome}`, s.dim, s.pos);
      }
      // 拿到过的物品记进记忆：配方知识由此解锁（原版配方书的规则）
      let heldBefore: Set<string> | null = null;
      for (const it of s.inventory) {
        if (this.memory.hasSeen('items', it.name)) continue;
        heldBefore ??= this.memory.heldItems();
        this.memory.markSeen('items', it.name);
        this.onNewItem?.(it.name, heldBefore);
      }
      for (const b of v.visibleNow.values()) {
        if (!NOTABLE.has(b.name)) continue;
        if (this.memory.markSeen('blocks', b.name)) {
          this.bus.publish('discovery', 'P2', `首次看见方块：${b.name}（${Math.round(b.dist)} 格外）`, { category: 'block', name: b.name, pos: b.pos });
        }
        // 岩浆既危险又是资源（浇水成黑曜石、当燃料）：两样都记
        if (DANGER.has(b.name)) this.memory.addLandmark('danger', b.name, s.dim, b.pos);
        // 岩浆只把源头记成资源（浇水能变黑曜石、能舀）；流动的岩浆只算危险
        const level = b.name === 'lava' ? this.adapter.blockStateAt?.(b.pos)?.properties.level : undefined;
        if (b.name === 'lava' && level !== undefined && Number(level) !== 0) {
          for (const l of this.memory.landmarks().filter((l) => l.kind === 'resource' && l.label === 'lava' && l.dim === s.dim
            && l.pos.x === b.pos.x && l.pos.y === b.pos.y && l.pos.z === b.pos.z)) this.memory.removeLandmark(l.id);
        }
        if (isResourceBlock(b.name) && (b.name !== 'lava' || level !== undefined && Number(level) === 0)) this.memory.addLandmark('resource', b.name, s.dim, b.pos);
        if (DANGER.has(b.name) || isResourceBlock(b.name)) continue;
        if (interactiveName(b.name)) {
          // 看见的功能方块记成地标（自己放下的已记为“我的X”，附近有就不重复记）
          const zh = interactiveName(b.name)!;
          const container = isContainerLandmark(b.name);
          const mine = this.memory.landmarks().some((l) => l.label === `我的${zh}` && l.dim === s.dim && Math.hypot(l.pos.x - b.pos.x, l.pos.y - b.pos.y, l.pos.z - b.pos.z) <= (container ? 0.1 : 2));
          if (!mine) this.memory.addLandmark('discovery', zh, s.dim, b.pos, container ? 0.1 : 6);
        } else if (STRUCTURE_HINT.has(b.name)) this.memory.addLandmark('discovery', b.name, s.dim, b.pos);
      }
      this.forgetVanishedOre(s);
      this.forgetSealedEntrances(s);
      for (const e of v.seen) {
        if (e.kind === 'item' || e.kind === 'other') continue;
        const key = e.kind === 'player' ? 'player' : e.name;
        if (this.memory.markSeen('entities', key)) this.bus.publish('discovery', 'P2', `首次看见实体：${e.name}`, { category: 'entity', name: e.name });
      }
      this.noteHerds(s, v.seen);
    }

    const vs = s.connected && s.observationReady ? v.summary(here) : null;
    const noveltyByDir: Record<string, number> = {};
    for (const [d, [dx, dz]] of Object.entries(DIRS)) {
      noveltyByDir[d] = round1(this.memory.novelty(s.dim, s.pos.x + dx * 48, s.pos.z + dz * 48));
    }
    const base = this.memory.base(s.dim);
    const baseInfo =
      base && base.dim === s.dim
        ? { dist: Math.round(Math.hypot(base.pos.x - s.pos.x, base.pos.z - s.pos.z)), dir: dirName(base.pos.x - s.pos.x, base.pos.z - s.pos.z) }
        : null;

    // ---- 死亡掉落物：现实时间只能估算；未观察到消失时保留记录
    let deathRecovery: Percept['death_recovery'] = null;
    const d = this.memory.lastDeath();
    if (d && d.lost.length && s.connected && s.observationReady) {
      const left = Math.max(0, Math.round((d.ts + 300_000 - Date.now()) / 1000));
      const dist = Math.hypot(d.pos.x - here.x, d.pos.z - here.z);
      if (d.dim === s.dim) {
        deathRecovery = {
          dir: dirName(d.pos.x - here.x, d.pos.z - here.z),
          dist: Math.round(dist),
          lost: d.lost.slice(0, 8).map((i) => `${i.name}×${i.count}`).join('、'),
          seconds_left: left,
        };
      }
    }

    // ---- 好奇心候选：记得但没去过的结构/稀有资源
    const visited = (p: { x: number; z: number }) => this.memory.chunkVisits(s.dim, p.x, p.z) > 0;
    const curiosities = this.memory
      .landmarks()
      .filter((l) => l.dim === s.dim && (l.kind === 'discovery' || l.kind === 'resource') && !l.label.startsWith('biome:') && !visited(l.pos))
      .map((l) => ({ what: l.label, dir: dirName(l.pos.x - here.x, l.pos.z - here.z), dist: Math.round(Math.hypot(l.pos.x - here.x, l.pos.z - here.z)) }))
      .filter((c) => c.dist > 8)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 6);

    const passiveCount = new Map<string, number>();
    // 同一种、同样特征的合在一起数：“sheep(白色) x2”“villager(农民 2 级)”
    for (const e of v.seen.filter((x) => x.kind === 'passive')) { const k = (e as any).traits ? `${e.name}(${(e as any).traits})` : e.name; passiveCount.set(k, (passiveCount.get(k) ?? 0) + 1); }

    const contact = s.connected && s.alive && s.observationReady ? surroundings(this.adapter, s.pos) : null;
    const light = s.connected && s.alive && s.observationReady ? this.lightInfo(s) : null;
    const overhead = s.connected && s.alive && s.observationReady ? this.overheadInfo(s) : null;
    // 树冠下天光也会很弱，但人一抬头就知道是树叶，不会以为自己在地下
    const where = overhead && contact ? whereAmI(this.adapter, s, overhead, { ownBuilt: this.ownBuilt }) : null;
    if (where) {
      try {
        const dug = this.adapter.recentDug?.(this.lastDugAt) ?? [];
        if (dug.length) this.lastDugAt = dug[dug.length - 1].ts;
        this.forgetMinedOre(s, dug);
        const place = where.kind === 'surface' || where.kind === 'indoors' ? 'surface' : where.kind === 'underground' ? 'underground' : 'other';
        this.passages.observe({ worldId: s.worldId, dim: s.dim, pos: s.pos, place }, dug);
      } catch { /* 记不下来不影响感知 */ }
    }
    if (light && overhead && (overhead.covered === 'canopy' || overhead.covered === 'open')) {
      light.underground = false;
      // 白天头顶露天或只隔着树叶：天光至少 13–15。读到很暗，多半是客户端的天光数据没更新（刚加载的区块、刚挖开的格子），
      // 不能据此说“周围很暗”——人一抬头就看得见天亮着
      const floor = overhead.covered === 'open' ? 15 : 13;
      // 雷雨时天光本来就暗（最多 10 左右），白天也会刷怪：不做这个“其实很亮”的修正
      if (s.isDay && s.weather !== 'thunder' && where?.kind === 'surface' && light.here < 10 && light.block < floor) {
        light.here = Math.max(light.here, floor);
        light.sky = Math.max(light.sky, floor);
        light.level = 'bright';
        light.mob_spawn_risk = false;
      }
    }
    const environment = this.bodyEnvironment(s, contact, light);
    this.latest = {
      ts: Date.now(),
      connected: s.connected,
      observation: { ready: s.observationReady, worldId: s.worldId, sessionId: s.sessionId, id: s.observationId },
      time: { timeOfDay: s.timeOfDay, phase: phaseOf(s.timeOfDay), isDay: s.isDay, can_sleep: canSleepAt(s.timeOfDay, s.weather), ...(s.worldDay !== undefined ? { day: s.worldDay } : {}), ...(s.weather ? { weather: weatherHere(s.weather, s.biome) } : {}) },
      self: {
        pos: [round1(s.pos.x), round1(s.pos.y), round1(s.pos.z)],
        dim: s.dim,
        hp: round1(s.hp),
        food: s.food,
        biome: s.biome,
        inWater: s.inWater,
        inLava: s.inLava,
        held: s.held,
        onGround: s.onGround,
        ...(s.riding !== undefined ? { riding: s.riding } : {}),
        ...(s.equipment ? { equipment: s.equipment.map(({ slot, name }) => ({ slot, name })) } : {}),
        // 身边一圈（脚下、头顶、四个方向能不能走）：判断被困、往哪能出去
        ...(contact ? { around: contact.text.replace(/看得见天空|看不见天空/, environment.sky_visible === true ? '看得见天空'
            : overhead?.covered === 'canopy' ? `头顶 ${overhead.up} 格是 ${overhead.block}（被树冠遮住，人在地表，不是地下）`
            : overhead?.covered === 'roof' ? `头顶 ${overhead.up} 格是 ${overhead.block}（屋顶/搭出来的遮挡）`
            : environment.sky_visible === false ? `头顶被 ${overhead?.block ?? '方块'} 遮挡` : '天空可见性尚未确认'),
          contacts: { support: contact.support, feet: contact.feet, head: contact.head } } : {}),
        ...environment,
        ...(overhead ? { overhead } : {}),
        ...(where ? { where } : {}),
        ...((() => { const eye = this.adapter.eye(); return contact && eye ? { local: localMap(this.adapter, s.pos, facingOfYaw(eye.yaw), this.observeBlocks.bind(this)) } : {}; })()),
        ...(contact ? { exits: contact.exitOptions } : {}),
      },
      inventory: [...s.inventory.reduce((items, item) => { const cur = items.get(item.name); items.set(item.name, cur ? { ...cur, count: cur.count + item.count } : { ...item }); return items; }, new Map<string, typeof s.inventory[number]>()).values()]
        .sort((a, b) => b.count - a.count),
      emptySlots: s.emptySlots,
      ...(s.effects?.length ? { effects: s.effects.map((e) => e.name) } : {}),
      nearby: {
        hostile: [...v.seen, ...v.heard]
          .filter((e) => e.kind === 'hostile')
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 6)
          .map((e) => ({ name: e.name, dist: round1(e.dist), how: e.how, ...(e.fusing ? { fusing: true } : {}), ...((e as any).traits && e.how === 'seen' ? { traits: (e as any).traits } : {}) })),
        passive: [...passiveCount].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).slice(0, 8),
        players: v.seen.filter((e) => e.kind === 'player').map((e) => e.name.replace('player:', '')),
        resources: vs
          ? [
              ...vs.visible_resources.map((r) => ({ block: r.block, count: r.count, nearest: r.nearest, dir: r.dir, seen: 'now' as const })),
              ...vs.remembered_resources.map((r) => ({ block: r.block, count: r.count, nearest: r.nearest, dir: r.dir, seen: 'memory' as const })),
            ].slice(0, 16)
          : [],
      },
      vision: vs,
      death_recovery: deathRecovery,
      curiosities,
      objective: this.memory.objective()?.text ?? null,
      drives: [],
      stock: null,
      efficiency: s.connected ? efficiencyInsights(this.adapter, this.memory, s.inventory) : [],
      light,
      storage: this.storageInfo(s.dim, here),
      farms: s.observationReady ? this.farmInfo(s.dim, here) : [],
      waiting_on: s.observationReady ? this.waitingOn(s.dim, { x: s.pos.x, y: s.pos.y, z: s.pos.z }) : [],
      learn_candidates: learnCandidates(this.memory, this.knownSkillSigs?.() ?? new Set()).map((c) => ({ steps: c.signature, times: c.times })),
      reflection_due: reflectionDue(this.memory),
      exploration: { visitedChunks: this.memory.visitedChunkCount, noveltyByDir, base: baseInfo },
    };
    return this.latest;
  }
}

/** 人砌出来的方块：围着自己的“高地面”如果是这些，多半是墙，不是坑壁（圆石、泥土不算：挖坑垫脚也用它们） */
const MAN_MADE = /(_planks|_stairs|_slab|glass|_pane|_door|_trapdoor|_fence|_fence_gate|_wall|bricks|_wool|terracotta|concrete|smooth_stone|chiseled_|polished_)$/;

/**
 * 自己在哪：看头顶，再看身边两格外那一圈的地面比脚下高多少（站在坑里一眼就看得出四周比自己高），
 * 只看露在外面的地表，不透视。
 * 那一圈“高出来的”如果是自己盖的房子的墙（或者人砌的方块），就是在屋里，不是在坑里：
 * 站在 5×5 的小屋中间，两格外正好是墙，以前会被当成“4 格深的坑”，它就在自家屋里垫高、挖台阶、想拆屋顶出去。
 */
export function whereAmI(adapter: Pick<GameAdapter, 'blockAt'>, s: { pos: { x: number; y: number; z: number }; inWater?: boolean },
  overhead: { block: string | null; up: number | null; covered: 'open' | 'canopy' | 'roof' | 'rock' },
  opts: { ownBuilt?: OwnBuiltLookup } = {}): { kind: WhereKind; text: string; depth?: number; building?: string } {
  const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y), z = Math.floor(s.pos.z);
  if (s.inWater) return { kind: 'water', text: '在水里' };
  const own = (pos: Vec3Like, block: string) => { try { return opts.ownBuilt?.(pos, block) ?? null; } catch { return null; } };
  // 头顶第一块实心方块：是自己的屋顶就算在屋里（屋顶用石头盖，overhead 也会说是 rock）
  let roof: { block: string; owner: { name: string } | null } | null = null;
  for (let h = 2; h <= 8 && !roof; h++) {
    const b = adapter.blockAt({ x, y: y + h, z });
    if (b === null) break;
    if (!isSoftBlock(b)) roof = { block: b, owner: own({ x, y: y + h, z }, b) };
  }
  if (overhead.covered === 'rock' && !roof?.owner) return { kind: 'underground', text: `在地下：头顶 ${overhead.up} 格是 ${overhead.block}` };
  // 两格外一圈：每列地表比脚下高几格（列顶被挡住就不算）
  const cols: { rise: number; block: string; owner: { name: string } | null }[] = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
    const top = adapter.blockAt({ x: x + dx, y: y + 6, z: z + dz });
    if (top === null || !isSoftBlock(top)) continue;
    for (let h = 5; h >= -3; h--) {
      const n = adapter.blockAt({ x: x + dx, y: y + h, z: z + dz });
      if (n === null) break;
      if (isSoftBlock(n) || /(_leaves|_log|_wood)$/.test(n)) continue;
      // 那列能站的高度比我脚下高多少；高出来的那一列从脚边往上是什么（墙还是土）
      const wallAt = { x: x + dx, y: y + Math.min(h, 1), z: z + dz };
      const wall = h >= 1 ? adapter.blockAt(wallAt) ?? n : n;
      cols.push({ rise: h + 1, block: wall, owner: h >= 1 ? own(wallAt, wall) ?? own({ x: x + dx, y: y + h, z: z + dz }, n) : null });
      break;
    }
  }
  const rises = cols.map((c) => c.rise);
  const high = cols.filter((c) => c.rise >= 2);
  const sky = overhead.covered === 'canopy' ? `，头顶 ${overhead.up} 格是树叶` : overhead.covered === 'roof' || overhead.covered === 'rock' ? `，头顶 ${overhead.up} 格是 ${overhead.block}` : '，头顶露天';
  const enclosed = rises.length >= 8 && high.length >= rises.length * 0.75;
  // 屋里：头顶是自己的屋顶、身边也有自己的墙；或者四周基本围住了、围着的一半以上是自己的墙。
  // 不能只数有几列是墙：站在自家屋外贴着墙、在屋角，那一圈里也有不少列是自己的墙和屋顶
  const ownWalls = high.filter((c) => c.owner);
  const building = roof?.owner?.name ?? ownWalls[0]?.owner?.name;
  const manMade = high.filter((c) => MAN_MADE.test(c.block)).length;
  if (building && ((roof?.owner && ownWalls.length >= 2) || (enclosed && ownWalls.length >= Math.max(2, high.length * 0.5)))) {
    return { kind: 'indoors', building, text: `在自己盖的「${building}」屋里（四周是墙${roof?.owner ? '，头顶是屋顶' : sky}）：这不是坑，别垫高、别挖墙和屋顶；${doorText(adapter, x, y, z)}` };
  }
  if (enclosed && manMade >= high.length * 0.6) {
    return { kind: 'indoors', text: `在一间有墙围着的屋子里（墙是 ${high.find((c) => MAN_MADE.test(c.block))!.block}${sky}）：这不是坑，别垫高、别挖墙；${doorText(adapter, x, y, z)}` };
  }
  if (enclosed) {
    const sorted = [...rises].sort((a, b) => a - b);
    const depth = sorted[Math.floor(sorted.length / 2)];
    return { kind: 'pit', depth, text: `在一个约 ${depth} 格深的坑里（四周地面比脚下高${sky}）` };
  }
  return { kind: 'surface', text: `在地表${sky}` };
}

/** 屋里找门：脚边 4 格内最近的一扇门在哪个方向 */
function doorText(adapter: Pick<GameAdapter, 'blockAt'>, x: number, y: number, z: number): string {
  let best: { dx: number; dz: number; d: number } | null = null;
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -1; dy <= 1; dy++) {
    const b = adapter.blockAt({ x: x + dx, y: y + dy, z: z + dz });
    if (!b || !/_door$/.test(b) || /trapdoor/.test(b)) continue;
    const d = Math.hypot(dx, dz);
    if (!best || d < best.d) best = { dx, dz, d };
  }
  if (!best) return '出去要走门；没看到门的话，在墙上开一格（dig_at 写 "own":true），出去再补上';
  return `出去走门：门在 ${dirName(best.dx, best.dz)} 边 ${Math.max(1, Math.round(best.d))} 格（门能直接走过，goto 过去就行）`;
}

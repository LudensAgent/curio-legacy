import fs from 'node:fs';
import path from 'node:path';
import type { AgentState } from '../adapter/types.ts';
import type { AgentEvent, EventBus } from '../events.ts';

/**
 * 学习曲线：给它的玩法打分，看它是不是在变好。
 *
 * 四个分项（0–100），加权成总分：
 * - 进度 20%：里程碑按权重累计，只增不减（「广度」地板，不会因为退步而回落）；
 * - 生存 25%：按「活跃时长」走 S 形曲线——活着、连着、没暂停才累积，暂停/离线/纯发呆不涨分；
 * - 学习 30%：技能与窍门的成功率（Laplace 平滑 + 置信度加权，小样本往 50% 收缩）+「越学越快」的进步速率；
 * - 效率 25%：最近半小时动作成功率与卡住比例（同样置信度加权）；样本不足返回 null，总分按 0 计、仪表盘显示「—」。
 *
 * 另外按“每一条命”记从复活到各个里程碑用了几分钟：同样从空手开始，越来越快就是学到了东西——这是最直接的学习曲线。
 */
/**
 * 里程碑：大致沿着原版成就（Advancements）的路线排，权重越往后越高。
 * - item：背包里出现这样的物品就算达成（每条命都会重新经过，能算“这条命用了几分钟”）；
 * - adv：游戏自己播报的成就名（服务器发的是英文名），收到就算达成；
 * - 其他（活过一晚、睡过一觉、盖好房子、进下界/末地、打死怪、种地、钓鱼）由事件和状态认。
 */
export interface Milestone { key: string; label: string; group: string; weight: number; item?: RegExp; adv?: string[] }
export const MILESTONES: Milestone[] = [
  // 起步（Minecraft / Stone Age / Getting an Upgrade）
  { key: 'log', label: '原木', group: '起步', weight: 2, item: /_(log|stem)$/ },
  { key: 'crafting_table', label: '工作台（Minecraft）', group: '起步', weight: 3, item: /^crafting_table$/, adv: ['Minecraft'] },
  { key: 'wooden_pickaxe', label: '木镐', group: '起步', weight: 3, item: /^wooden_pickaxe$/ },
  { key: 'cobblestone', label: '圆石（石器时代）', group: '起步', weight: 3, item: /^(cobblestone|cobbled_deepslate|blackstone)$/, adv: ['Stone Age'] },
  { key: 'stone_pickaxe', label: '石镐（获得升级）', group: '起步', weight: 4, item: /^stone_pickaxe$/, adv: ['Getting an Upgrade'] },
  { key: 'sword', label: '武器', group: '起步', weight: 2, item: /_(sword)$/ },
  { key: 'furnace', label: '熔炉', group: '起步', weight: 3, item: /^furnace$/ },
  { key: 'coal', label: '煤/木炭', group: '起步', weight: 2, item: /^(coal|charcoal)$/ },
  { key: 'torch', label: '火把', group: '起步', weight: 3, item: /^torch$/ },
  // 活下来（Sweet Dreams / Monster Hunter）
  { key: 'cooked_food', label: '熟食', group: '活下来', weight: 3, item: /^(cooked_|baked_potato$|bread$)/ },
  { key: 'survive_night', label: '活过一晚', group: '活下来', weight: 5 },
  { key: 'bed', label: '床', group: '活下来', weight: 4, item: /_bed$/ },
  { key: 'slept', label: '睡过一觉（甜蜜的梦）', group: '活下来', weight: 4, adv: ['Sweet Dreams'] },
  { key: 'kill_hostile', label: '打死怪物（怪物猎人）', group: '活下来', weight: 3, adv: ['Monster Hunter'] },
  { key: 'shelter', label: '盖好房子', group: '活下来', weight: 10 },
  { key: 'chest', label: '箱子', group: '活下来', weight: 2, item: /^chest$/ },
  // 过日子（A Seedy Place / Fishy Business / The Parrots and the Bats）
  { key: 'plant_seed', label: '种地（开荒垦地）', group: '过日子', weight: 3, adv: ['A Seedy Place'] },
  { key: 'fish', label: '钓到鱼（腥味十足的生意）', group: '过日子', weight: 3, adv: ['Fishy Business'] },
  { key: 'breed', label: '繁殖动物（我从哪儿来？）', group: '过日子', weight: 3, adv: ['The Parrots and the Bats'] },
  { key: 'bread', label: '面包', group: '过日子', weight: 2, item: /^bread$/ },
  { key: 'trade', label: '村民交易（一个不错的交易）', group: '过日子', weight: 3, adv: ['What a Deal!'] },
  { key: 'bee', label: '养蜂取蜜', group: '过日子', weight: 3, item: /^(honey_bottle|honeycomb|beehive)$/, adv: ['Bee Our Guest', 'Wax On'] },
  // 铁器时代（Acquire Hardware / Suit Up / Hot Stuff / Isn't It Iron Pick / Not Today, Thank You / Ice Bucket Challenge）
  { key: 'iron_ingot', label: '铁锭（来硬的）', group: '铁器', weight: 6, item: /^iron_ingot$/, adv: ['Acquire Hardware'] },
  { key: 'iron_pickaxe', label: '铁镐（这不是铁镐么）', group: '铁器', weight: 6, item: /^iron_pickaxe$/, adv: ["Isn't It Iron Pick"] },
  { key: 'iron_armor', label: '铁甲（整装上阵）', group: '铁器', weight: 6, item: /^iron_(helmet|chestplate|leggings|boots)$/, adv: ['Suit Up'] },
  { key: 'shield', label: '盾牌', group: '铁器', weight: 3, item: /^shield$/, adv: ['Not Today, Thank You'] },
  { key: 'bucket', label: '铁桶', group: '铁器', weight: 3, item: /^bucket$/ },
  { key: 'lava_bucket', label: '岩浆桶（热腾腾的）', group: '铁器', weight: 4, item: /^lava_bucket$/, adv: ['Hot Stuff'] },
  { key: 'obsidian', label: '黑曜石（冰桶挑战）', group: '铁器', weight: 5, item: /^obsidian$/, adv: ['Ice Bucket Challenge'] },
  // 钻石与附魔（Diamonds! / Cover Me with Diamonds / Enchanter）
  { key: 'diamond', label: '钻石（钻石！）', group: '钻石', weight: 8, item: /^diamond$/, adv: ['Diamonds!'] },
  { key: 'diamond_pickaxe', label: '钻石镐', group: '钻石', weight: 6, item: /^diamond_pickaxe$/ },
  { key: 'diamond_armor', label: '钻石甲（用钻石包裹我）', group: '钻石', weight: 6, item: /^diamond_(helmet|chestplate|leggings|boots)$/, adv: ['Cover Me with Diamonds'] },
  { key: 'enchanting_table', label: '附魔台（附魔师）', group: '钻石', weight: 6, item: /^enchanting_table$/, adv: ['Enchanter'] },
  { key: 'netherite', label: '下界合金（远古残骸）', group: '钻石', weight: 7, item: /^(netherite_ingot|netherite_scrap|ancient_debris)$/, adv: ['Hidden in the Depths'] },
  // 下界与末地（We Need to Go Deeper / Into Fire / Eye Spy / The End? / Free the End）
  { key: 'nether', label: '进入下界（勇往直下）', group: '下界与末地', weight: 8, adv: ['We Need to Go Deeper'] },
  { key: 'blaze_rod', label: '烈焰棒（与火共舞）', group: '下界与末地', weight: 5, item: /^blaze_rod$/, adv: ['Into Fire'] },
  { key: 'ender_eye', label: '末影之眼', group: '下界与末地', weight: 5, item: /^ender_eye$/ },
  { key: 'stronghold', label: '找到要塞（隔墙有眼）', group: '下界与末地', weight: 6, adv: ['Eye Spy'] },
  { key: 'end', label: '进入末地（结束了？）', group: '下界与末地', weight: 8, adv: ['The End?'] },
  { key: 'dragon', label: '击败末影龙（解放末地）', group: '下界与末地', weight: 15, adv: ['Free the End'] },
  { key: 'end_city', label: '末地城（潜影贝）', group: '下界与末地', weight: 6, item: /^(shulker_shell|shulker_box)$/, adv: ['The City at the End of the Game'] },
  { key: 'elytra', label: '鞘翅（天空的极限）', group: '下界与末地', weight: 8, item: /^elytra$/, adv: ["Sky's the Limit"] },
  { key: 'purpur', label: '紫珀', group: '下界与末地', weight: 4, item: /^(purpur_block|purpur_pillar|end_rod)$/ },
  // 海洋（海龟、海晶石、潮涌核心、三叉戟）
  { key: 'turtle', label: '海龟（海龟蛋/鳞甲）', group: '海洋', weight: 4, item: /^(turtle_egg|turtle_helmet|scute)$/ },
  { key: 'prismarine', label: '海晶石/守卫者', group: '海洋', weight: 5, item: /^(prismarine|prismarine_bricks|dark_prismarine|prismarine_shard|prismarine_crystals|sea_lantern)$/ },
  { key: 'conduit', label: '潮涌核心（海底神殿）', group: '海洋', weight: 5, item: /^(heart_of_the_sea|conduit)$/, adv: ['Moskstraumen'] },
  { key: 'trident', label: '三叉戟', group: '海洋', weight: 4, item: /^trident$/, adv: ['A Throwaway Joke'] },
  // 建筑与红石（信标、凋零、红石机关）
  { key: 'beacon', label: '信标', group: '建筑与红石', weight: 6, item: /^beacon$/, adv: ['Bring Home the Beacon'] },
  { key: 'wither', label: '凋零（下界之星）', group: '建筑与红石', weight: 6, item: /^nether_star$/, adv: ['Withering Heights'] },
  { key: 'redstone', label: '红石机关', group: '建筑与红石', weight: 3, item: /^(redstone_block|observer|dispenser|dropper|sticky_piston|piston|repeater|comparator)$/ },
  // 酿造
  { key: 'brewing', label: '酿造台（药水）', group: '酿造', weight: 5, item: /^brewing_stand$/, adv: ['Local Brewery'] },
];
const TOTAL_WEIGHT = MILESTONES.reduce((n, m) => n + m.weight, 0);
const ADV_KEY = new Map(MILESTONES.flatMap((m) => (m.adv ?? []).map((a) => [a.toLowerCase(), m.key] as const)));
/** 每条命都会重新经过、最能看出“熟练度”的几个 */
export const LIFE_MILESTONES = ['crafting_table', 'stone_pickaxe', 'furnace', 'torch', 'bed', 'shelter'];

export interface Life { n: number; start: number; end?: number; cause?: string; reached: Record<string, number>; nights: number; activeMs?: number }
export interface Sample { t: number; total: number; progress: number; survival: number; learning: number; efficiency: number | null }
interface Data { version: 1; world: string; startedAt: number; ever: Record<string, number>; lives: Life[]; samples: Sample[]; deaths: number[];
  /** 游戏播报过的所有成就（含不在里程碑表里的） */
  advancements?: { title: string; at: number }[] }

export interface LearningInput { skills: { ok: number; fail: number; disabled?: boolean }[]; knowHow: { wins: number; losses: number }[]; housesComplete: number }

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** 活了多久 → 0..1 的 S 形曲线：中点是一个游戏日（20 分钟），坡度 6 分钟（10 分钟约 0.16，40 分钟约 0.97） */
export const LIFE_MIDPOINT_MIN = 20, LIFE_SLOPE_MIN = 6;
export const lifeCurve = (minutes: number) => 1 / (1 + Math.exp(-(minutes - LIFE_MIDPOINT_MIN) / LIFE_SLOPE_MIN));
/** Laplace 成功率（Beta(1,1) 后验均值）：把小数量的成功率往 50% 收缩——0/0 → 50、1/0 → 67、50/50 → 98。 */
const laplaceRate = (ok: number, fail: number) => (ok + 1) / (ok + fail + 2);
/** 置信度：样本量 n 多大才信这个成功率（5 次信一半、25 次信 83%）。 */
const conf = (n: number) => n / (n + 5);
/** 中位数（比较早期/近期到达里程碑的用时）。 */
const medianOf = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
/** 若干 [成功,失败] 记录合成一个 0..100 的置信度加权成功率；全都没有样本时返回 null。 */
function confidenceMean(rows: { ok: number; fail: number }[]): number | null {
  const withData = rows.filter((r) => r.ok + r.fail > 0);
  if (!withData.length) return null;
  let wsum = 0, vsum = 0;
  for (const r of withData) { const w = conf(r.ok + r.fail); wsum += w; vsum += w * laplaceRate(r.ok, r.fail) * 100; }
  return vsum / wsum;
}
/** 单条记录的成功率（效率分用），没样本时返回 null。 */
const weightedRate = (ok: number, fail: number) => confidenceMean([{ ok, fail }]);
/** 把若干 [值(0..100|null), 权重] 合成 0..100；null 按 0 计，缺数据就不贡献分。 */
const blend = (...parts: [number | null, number][]) => clamp(parts.reduce((s, [v, w]) => s + (v ?? 0) * w, 0));

export interface ProgressBranch { group: string; done: number; total: number; next: string[] }

export class Scorecard {
  data: Data;
  private actions: { t: number; ok: boolean }[] = [];
  private attempts: { t: number; stuck: boolean }[] = [];
  private wasDay: boolean | null = null;
  private dirty = false;
  private lastSampleAt: number | null = null;
  private listener = (ev: AgentEvent) => this.onEvent(ev);

  constructor(private bus: EventBus, private state: () => AgentState, private file: string | null, private learning: () => LearningInput, private paused: () => boolean = () => false) {
    this.data = { version: 1, world: '', startedAt: Date.now(), ever: {}, lives: [], samples: [], deaths: [] };
    if (file && fs.existsSync(file)) { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d?.version === 1) this.data = { ...this.data, ...d }; } catch { /* 坏了就重新记 */ } }
  }

  start(intervalMs = 30_000) {
    this.bus.on('event', this.listener);
    const t = setInterval(() => { this.sample(); this.flush(); }, intervalMs);
    t.unref?.();
  }
  stop() { this.bus.off('event', this.listener); this.flush(); }

  private life(now = Date.now()): Life {
    let l = this.data.lives.at(-1);
    if (!l || l.end) { l = { n: (l?.n ?? 0) + 1, start: now, reached: {}, nights: 0, activeMs: 0 }; this.data.lives.push(l); if (this.data.lives.length > 200) this.data.lives.shift(); this.dirty = true; }
    return l;
  }

  /** 达成一个里程碑：这条命第一次、整个存档第一次都记下 */
  reach(key: string, now = Date.now()) {
    const l = this.life(now);
    if (l.reached[key] === undefined) { l.reached[key] = Math.round((now - l.start) / 1000); this.dirty = true; }
    if (this.data.ever[key] === undefined) {
      this.data.ever[key] = now; this.dirty = true;
      const m = MILESTONES.find((x) => x.key === key);
      if (m) this.bus.publish('milestone', 'P2', `新的里程碑：${m.label}`, { key });
    }
  }

  private checkItems(names: string[], now = Date.now()) {
    for (const m of MILESTONES) if (m.item && names.some((n) => m.item!.test(n))) this.reach(m.key, now);
  }

  private onEvent(ev: AgentEvent) {
    const d = (ev.data ?? {}) as Record<string, any>;
    if (ev.type === 'death') {
      const l = this.life(ev.ts);
      l.end = ev.ts; l.cause = String(d.message ?? d.cause ?? '').slice(0, 80);
      this.data.deaths = [...this.data.deaths.filter((t) => ev.ts - t < 24 * 3600_000), ev.ts];
      this.dirty = true;
    } else if (ev.type === 'spawn') {
      this.life(ev.ts);
    } else if (ev.type === 'item_new' && typeof d.item === 'string') {
      this.checkItems([d.item], ev.ts);
    } else if (ev.type === 'task_end') {
      const src = String(d.source ?? '');
      if (src === 'filler') return;
      if (src !== 'reflex') this.actions = [...this.actions.filter((a) => ev.ts - a.t < 30 * 60_000), { t: ev.ts, ok: d.status === 'succeeded' }];
      // 合成出来马上放下的工作台、熔炉在背包里待不住：从合成结果里认
      const made = String(d.summary ?? '').match(/合成了 \d+ 个 ([a-z0-9_]+)/)?.[1];
      if (made) this.checkItems([made], ev.ts);
      if (d.status === 'succeeded') {
        if (d.skill === 'sleep') this.reach('slept', ev.ts);
        else if (d.skill === 'farm' && /种|播|plant/i.test(String(d.summary ?? ''))) this.reach('plant_seed', ev.ts);
        else if (d.skill === 'fish' && /钓到|caught/i.test(String(d.summary ?? ''))) this.reach('fish', ev.ts);
        else if (['defend', 'hit_entity', 'ranged_defend'].includes(String(d.skill)) && /打死|击杀|杀死|打败|消灭|killed|slain/i.test(String(d.summary ?? ''))) this.reach('kill_hostile', ev.ts);
      }
      try { this.checkItems(this.state().inventory.map((i) => i.name), ev.ts); } catch { /* 状态暂不可用 */ }
    } else if (ev.type === 'game_message' && d.kind === 'advancement_self') {
      // 游戏自己播报的成就：最可靠
      const title = ev.msg.match(/\[([^\]]+)\]/)?.[1]?.trim();
      if (title) {
        const list = (this.data.advancements ??= []);
        if (!list.some((a) => a.title === title)) { list.push({ title, at: ev.ts }); this.dirty = true; }
        const key = ADV_KEY.get(title.toLowerCase());
        if (key) this.reach(key, ev.ts);
      }
    } else if (ev.type === 'attempt_end') {
      this.attempts = [...this.attempts.filter((a) => ev.ts - a.t < 30 * 60_000), { t: ev.ts, stuck: d.outcome === 'stuck' }];
    }
  }

  /** 定时取样：背包、昼夜、算分 */
  sample(now = Date.now()) {
    let s: AgentState | null = null;
    try { s = this.state(); } catch { /* 状态暂不可用 */ }
    if (s?.connected && s.alive) {
      if (this.data.world !== s.worldId) this.data.world = s.worldId;
      this.checkItems(s.inventory.map((i) => i.name), now);
      if (this.wasDay === false && s.isDay) { const l = this.life(now); l.nights++; this.reach('survive_night', now); }
      if (/nether/.test(s.dim)) this.reach('nether', now);
      if (/the_end|^end$/.test(s.dim)) this.reach('end', now);
      this.wasDay = s.isDay;
    }
    // 累计「活跃时长」：只有活着、连着、没暂停才算生存时间；暂停/离线不累积，两次取样间隔太长（进程被挂起）也不计。
    const cur = this.data.lives.at(-1);
    if (cur && !cur.end && this.lastSampleAt !== null) {
      const dt = now - this.lastSampleAt;
      if (s?.connected && s.alive && !this.paused() && dt > 0 && dt < 120_000) cur.activeMs = (cur.activeMs ?? 0) + dt;
    }
    this.lastSampleAt = now;
    const learn = this.learning();
    if (learn.housesComplete > 0) this.reach('shelter', now);
    const sc = this.scores(now, learn);
    this.data.samples.push({ t: now, ...sc });
    if (this.data.samples.length > 2000) this.data.samples = this.data.samples.filter((_, i) => i % 2 === 0); // 太多就隔一个丢一个，保留整条曲线的形状
    this.dirty = true;
    return sc;
  }

  scores(now = Date.now(), learn = this.learning()) {
    // 进度：里程碑按权重累计，只增不减（广度，是地板）；表外成就并入里程碑表，不再单独加分。
    const progress = clamp(MILESTONES.filter((m) => this.data.ever[m.key] !== undefined).reduce((n, m) => n + m.weight, 0) / TOTAL_WEIGHT * 100);

    // 生存：按「活跃时长」走 S 形曲线（活着、连着、没暂停才累积，见 sample()），刚复活几乎不得分、撑过一个游戏日得一半；
    // 当前这条命占六成，最近几条已结束的命的中位数占四成（稳定活得久才高）。
    const cur = this.data.lives.at(-1);
    const curMin = cur && !cur.end ? (cur.activeMs ?? 0) / 60000 : 0;
    const ended = this.data.lives.filter((l) => l.end).slice(-5).map((l) => (l.activeMs ?? 0) / 60000);
    const median = ended.length ? medianOf(ended) : curMin;
    const survival = clamp(100 * (0.6 * lifeCurve(curMin) + 0.4 * lifeCurve(median)));

    // 学习：技能与窍门的成功率（Laplace 平滑 + 置信度加权，小样本往 50% 收缩），加「越学越快」的进步速率。
    const skillScore = confidenceMean(learn.skills.filter((k) => !k.disabled).map((k) => ({ ok: k.ok, fail: k.fail })));
    const knowHowScore = confidenceMean(learn.knowHow.map((k) => ({ ok: k.wins, fail: k.losses })));
    const learning = blend([skillScore, 0.45], [knowHowScore, 0.25], [this.learningTrend(), 0.30]);

    // 效率：最近半小时动作成功率 + 卡住比例，同样置信度加权；样本不足返回 null，总分按 0 计、仪表盘显示「—」。
    const acts = this.actions.filter((a) => now - a.t < 30 * 60_000);
    const tries = this.attempts.filter((a) => now - a.t < 30 * 60_000);
    const ok = acts.filter((a) => a.ok).length, fail = acts.filter((a) => !a.ok).length;
    const actionRate = acts.length ? weightedRate(ok, fail) : null;
    const stuckRate = tries.length ? tries.filter((a) => a.stuck).length / tries.length : null;
    const efficiency = actionRate === null && stuckRate === null
      ? null
      : clamp(0.6 * (actionRate ?? 50) + 0.4 * (stuckRate === null ? 50 : (1 - stuckRate) * 100));

    const total = clamp(progress * 0.20 + survival * 0.25 + learning * 0.30 + (efficiency ?? 0) * 0.25);
    return { total, progress, survival, learning, efficiency };
  }

  /** 进步速率：每条命到达同一个里程碑的用时，后半段比前半段快了多少（0..100，50 = 没变化）；没有可比历史时返回 null。 */
  private learningTrend(): number | null {
    const speedups: number[] = [];
    for (const key of LIFE_MILESTONES) {
      const times = this.data.lives.filter((l) => l.reached[key] !== undefined).map((l) => l.reached[key]!);
      if (times.length < 2) continue;
      const mid = Math.floor(times.length / 2);
      const early = medianOf(times.slice(0, mid)), recent = medianOf(times.slice(mid));
      if (early > 0) speedups.push(Math.max(-1, Math.min(1, (early - recent) / early)));
    }
    if (!speedups.length) return null;
    return clamp(50 + 50 * speedups.reduce((a, b) => a + b, 0) / speedups.length);
  }

  /** 给心智看的进度事实：已达成多少、每个分支各达成几项、还没碰过的（只作方向参考，不是硬目标；怎么推进由心智定）。 */
  progressFacts(): { reached: number; total: number; done: string[]; next: string | null; branches: ProgressBranch[] } {
    const reached = MILESTONES.filter((m) => this.data.ever[m.key] !== undefined);
    const next = MILESTONES.find((m) => this.data.ever[m.key] === undefined);
    // 按分支归组：让心智看到“哪一类已经玩过、哪一类还没碰”，而不是只有一根主线上的下一个。
    const byGroup = new Map<string, Milestone[]>();
    for (const m of MILESTONES) { const g = byGroup.get(m.group) ?? []; g.push(m); byGroup.set(m.group, g); }
    const branches: ProgressBranch[] = [...byGroup].map(([group, list]) => ({
      group,
      done: list.filter((m) => this.data.ever[m.key] !== undefined).length,
      total: list.length,
      next: list.filter((m) => this.data.ever[m.key] === undefined).slice(0, 2).map((m) => m.label),
    }));
    return { reached: reached.length, total: MILESTONES.length, done: reached.slice(-4).map((m) => m.label), next: next?.label ?? null, branches };
  }

  flush() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data)); fs.renameSync(this.file + '.tmp', this.file); } catch { this.dirty = true; }
  }

  /** 给控制台：当前分数、曲线（最多 240 个点）、里程碑、每条命的用时 */
  summary(now = Date.now()) {
    const samples = this.data.samples;
    const step = Math.max(1, Math.ceil(samples.length / 240));
    const curve = samples.filter((_, i) => i % step === 0 || i === samples.length - 1);
    const lives = this.data.lives.slice(-30).map((l) => ({ n: l.n, minutes: Math.round(((l.end ?? now) - l.start) / 6000) / 10, alive: !l.end, cause: l.cause ?? null, nights: l.nights,
      reached: Object.fromEntries(LIFE_MILESTONES.filter((k) => l.reached[k] !== undefined).map((k) => [k, Math.round(l.reached[k] / 6) / 10])) }));
    return {
      now: this.scores(now), curve, startedAt: this.data.startedAt,
      milestones: MILESTONES.map((m) => ({ key: m.key, label: m.label, group: m.group, weight: m.weight, at: this.data.ever[m.key] ?? null })),
      advancements: (this.data.advancements ?? []).slice(-40),
      lifeMilestones: LIFE_MILESTONES.map((k) => ({ key: k, label: MILESTONES.find((m) => m.key === k)!.label })),
      lives, deathsLastHour: this.data.deaths.filter((t) => now - t < 3600_000).length,
    };
  }
}

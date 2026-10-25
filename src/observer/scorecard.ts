import fs from 'node:fs';
import path from 'node:path';
import type { AgentState } from '../adapter/types.ts';
import type { AgentEvent, EventBus } from '../events.ts';

/**
 * 学习曲线：给它的玩法打分，看它是不是在变好。
 *
 * 四个分项（0–100），加权成总分：
 * - 进度 40%：游戏里的里程碑（原木 → 工作台 → 木镐 → 石镐 → 熔炉 → 火把 → 床 → 盖好房子 → 铁器 → 钻石…），按权重累计，只增不减；
 * - 生存 20%：最近一小时死了几次；
 * - 学习 25%：用得上、成功率过半的技能有几份，被事实验证过的窍门有几条，技能平均成功率；
 * - 效率 15%：最近半小时动作的成功率、卡住的比例。
 *
 * 另外按“每一条命”记从复活到各个里程碑用了几分钟：同样从空手开始，越来越快就是学到了东西——这是最直接的学习曲线。
 */
export interface Milestone { key: string; label: string; weight: number; item?: RegExp }
export const MILESTONES: Milestone[] = [
  { key: 'log', label: '原木', weight: 3, item: /_(log|stem)$/ },
  { key: 'crafting_table', label: '工作台', weight: 3, item: /^crafting_table$/ },
  { key: 'wooden_pickaxe', label: '木镐', weight: 4, item: /^wooden_pickaxe$/ },
  { key: 'cobblestone', label: '圆石', weight: 3, item: /^(cobblestone|cobbled_deepslate)$/ },
  { key: 'stone_pickaxe', label: '石镐', weight: 6, item: /^stone_pickaxe$/ },
  { key: 'stone_sword', label: '武器', weight: 3, item: /_(sword)$/ },
  { key: 'furnace', label: '熔炉', weight: 4, item: /^furnace$/ },
  { key: 'coal', label: '煤/木炭', weight: 4, item: /^(coal|charcoal)$/ },
  { key: 'torch', label: '火把', weight: 4, item: /^torch$/ },
  { key: 'cooked_food', label: '熟食', weight: 4, item: /^(cooked_|baked_potato$|bread$)/ },
  { key: 'survive_night', label: '活过一晚', weight: 6 },
  { key: 'bed', label: '床', weight: 6, item: /_bed$/ },
  { key: 'slept', label: '睡过一觉', weight: 5 },
  { key: 'shelter', label: '盖好房子', weight: 12 },
  { key: 'iron_ingot', label: '铁锭', weight: 7, item: /^iron_ingot$/ },
  { key: 'iron_pickaxe', label: '铁镐', weight: 8, item: /^iron_pickaxe$/ },
  { key: 'iron_armor', label: '铁甲', weight: 6, item: /^iron_(helmet|chestplate|leggings|boots)$/ },
  { key: 'diamond', label: '钻石', weight: 8, item: /^diamond$/ },
];
const TOTAL_WEIGHT = MILESTONES.reduce((n, m) => n + m.weight, 0);
/** 每条命都会重新经过、最能看出“熟练度”的几个 */
export const LIFE_MILESTONES = ['crafting_table', 'stone_pickaxe', 'furnace', 'torch', 'bed', 'shelter'];

export interface Life { n: number; start: number; end?: number; cause?: string; reached: Record<string, number>; nights: number }
export interface Sample { t: number; total: number; progress: number; survival: number; learning: number; efficiency: number }
interface Data { version: 1; world: string; startedAt: number; ever: Record<string, number>; lives: Life[]; samples: Sample[]; deaths: number[] }

export interface LearningInput { skills: { ok: number; fail: number; disabled?: boolean }[]; knowHow: { wins: number; losses: number }[]; housesComplete: number }

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export class Scorecard {
  data: Data;
  private actions: { t: number; ok: boolean }[] = [];
  private attempts: { t: number; stuck: boolean }[] = [];
  private wasDay: boolean | null = null;
  private dirty = false;
  private listener = (ev: AgentEvent) => this.onEvent(ev);

  constructor(private bus: EventBus, private state: () => AgentState, private file: string | null, private learning: () => LearningInput) {
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
    if (!l || l.end) { l = { n: (l?.n ?? 0) + 1, start: now, reached: {}, nights: 0 }; this.data.lives.push(l); if (this.data.lives.length > 200) this.data.lives.shift(); this.dirty = true; }
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
      if (d.skill === 'sleep' && d.status === 'succeeded') this.reach('slept', ev.ts);
      try { this.checkItems(this.state().inventory.map((i) => i.name), ev.ts); } catch { /* 状态暂不可用 */ }
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
      this.wasDay = s.isDay;
    }
    const learn = this.learning();
    if (learn.housesComplete > 0) this.reach('shelter', now);
    const sc = this.scores(now, learn);
    this.data.samples.push({ t: now, ...sc });
    if (this.data.samples.length > 2000) this.data.samples = this.data.samples.filter((_, i) => i % 2 === 0); // 太多就隔一个丢一个，保留整条曲线的形状
    this.dirty = true;
    return sc;
  }

  scores(now = Date.now(), learn = this.learning()) {
    const progress = clamp(MILESTONES.filter((m) => this.data.ever[m.key] !== undefined).reduce((n, m) => n + m.weight, 0) / TOTAL_WEIGHT * 100);
    const deathsLastHour = this.data.deaths.filter((t) => now - t < 3600_000).length;
    const survival = clamp(100 * Math.exp(-0.6 * deathsLastHour));
    const used = learn.skills.filter((k) => k.ok + k.fail >= 2 && !k.disabled);
    const useful = used.filter((k) => k.ok / (k.ok + k.fail) >= 0.5).length;
    const rate = used.length ? used.reduce((n, k) => n + k.ok / (k.ok + k.fail), 0) / used.length : 0;
    const verified = learn.knowHow.filter((k) => k.wins >= 1 && k.wins > k.losses).length;
    const learning = clamp(Math.min(useful * 15, 60) + Math.min(verified * 4, 20) + rate * 20);
    const acts = this.actions.filter((a) => now - a.t < 30 * 60_000), tries = this.attempts.filter((a) => now - a.t < 30 * 60_000);
    const okRate = acts.length >= 5 ? acts.filter((a) => a.ok).length / acts.length : null;
    const stuckRate = tries.length >= 3 ? tries.filter((a) => a.stuck).length / tries.length : null;
    const efficiency = okRate === null && stuckRate === null ? 50 : clamp((okRate ?? 0.5) * 70 + (1 - (stuckRate ?? 0.5)) * 30);
    const total = clamp(progress * 0.4 + survival * 0.2 + learning * 0.25 + efficiency * 0.15);
    return { total, progress, survival, learning, efficiency };
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
      milestones: MILESTONES.map((m) => ({ key: m.key, label: m.label, weight: m.weight, at: this.data.ever[m.key] ?? null })),
      lifeMilestones: LIFE_MILESTONES.map((k) => ({ key: k, label: MILESTONES.find((m) => m.key === k)!.label })),
      lives, deathsLastHour: this.data.deaths.filter((t) => now - t < 3600_000).length,
    };
  }
}

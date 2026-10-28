import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, EntityInfo, Vec3Like } from '../adapter/types.ts';
import type { AgentEvent, EventBus } from '../events.ts';

/**
 * 收获账本：给做过的一切记投入产出、记东西出现在哪——不针对哪一种东西，木头、食物、矿、怪物掉落都一样记。
 *
 * - 投入产出：每段活结束时记下花了多少（时间、动作次数、失败、走了多远、掉了多少血）、得到了什么；
 *   按“得到的东西”汇总：拿到一个平均花多少、早先和最近比是变省还是变费、最省的那几次是怎么做的。
 * - 出现在哪：看见值得注意的方块和生物、东西进背包时，记下高度、生物群系、维度、刚做的动作；
 *   按东西汇总成分布（多在哪个高度段、哪些群系、靠什么动作拿到）。
 * - 效率信号：某样东西这次拿得比它自己平时明显费劲或明显省事——相对它自己历史的统计离群，
 *   不是固定阈值——交给造技能的去对比“这次哪里做得不一样”。
 *
 * 心智想事时能按关键词想起这本账；回顾时整本账的摘要一起交给造技能的。
 */

const BUCKET = 8;
const MAX_EPISODES = 400;
const MAX_SEEN_KEYS = 12_000;

export interface Dist { n: number; y: Record<string, number>; biome: Record<string, number>; dim: Record<string, number>; via?: Record<string, number>; last: number }
export interface Episode {
  at: number; what: string; kind: string; signature: string; outcome: string;
  sec: number; actions: number; failures: number; walked: number; hpLost: number; gained: Record<string, number>;
  /** 这段活里身体用过的技能（名字@版本） */
  skills?: string[];
}
interface LedgerData { version: 1; seen: Record<string, Dist>; got: Record<string, Dist>; episodes: Episode[]; seenKeys: string[] }

export interface LedgerSignal { item: string; direction: 'slow' | 'fast'; ratio: number; usualSec: number; thisSec: number; episode: Episode }

/** 心智和造技能的看到的账（只读） */
export interface LedgerView { names(): string[]; describe(name: string): string; digest(n?: number): string[]; skillEffect(name: string): string; aliases(name: string): string[]; huntTally(): HuntTally }

/** 打猎的账：为了肉走了多远、打了多少 */
export interface HuntTally { trips: number; animals: number; walked: number; recentWalked: number | null; lastAt: number | null }
/** 动物身上掉的生肉：一块肉算一只（鸡掉 1，牛猪羊 1–3 都按 1 只估，宁可少算） */
const RAW_MEAT = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit']);

export interface ItemStats {
  item: string; episodes: number; units: number; perUnitSec: number;
  earlySec: number | null; recentSec: number | null; trend: 'better' | 'worse' | 'flat' | null;
  best: { what: string; signature: string; perUnitSec: number }[]; totalSec: number;
}

export interface Sight { blocks: { name: string; pos: Vec3Like }[]; entities: EntityInfo[] }

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (x: number) => Math.round(x * 10) / 10;
const fmtSec = (s: number) => s >= 120 ? `${r1(s / 60)} 现实分钟` : `${Math.round(s)} 现实秒`;
const top = (rec: Record<string, number> | undefined, n: number) => Object.entries(rec ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);

/** 一段活里某样东西“分到”的花费：几样东西一起得到就平分时间，再除以得到的个数 */
export function perUnit(ep: Episode, item: string): number {
  const kinds = Object.keys(ep.gained).length || 1;
  return ep.sec / kinds / Math.max(1, ep.gained[item] ?? 1);
}

/** 高度分布说成一句话：大致范围（去掉两头各一成）和最多的那一段 */
export function describeDist(d: Dist | undefined): string {
  if (!d || !d.n) return '';
  const ys = Object.entries(d.y).map(([k, v]) => [Number(k), v] as const).sort((a, b) => a[0] - b[0]);
  const total = ys.reduce((s, [, v]) => s + v, 0);
  let acc = 0, lo = ys[0][0], hi = ys[ys.length - 1][0];
  for (const [k, v] of ys) { if (acc < total * 0.1) lo = k; acc += v; if (acc >= total * 0.9) { hi = k; break; } }
  const mode = ys.reduce((a, b) => (b[1] > a[1] ? b : a));
  const parts = [`Y ${lo}~${hi + BUCKET - 1}${ys.length > 1 ? `（最多在 ${mode[0]}~${mode[0] + BUCKET - 1}）` : ''}`];
  const biomes = top(d.biome, 2).filter(([b]) => b && b !== 'unknown');
  if (biomes.length) parts.push(biomes.map(([b, v]) => `${b} ${Math.round((v / d.n) * 100)}%`).join('、'));
  const dims = top(d.dim, 3);
  if (dims.length > 1 || (dims[0] && dims[0][0] !== 'overworld')) parts.push(dims.map(([k]) => k).join('/'));
  if (d.via) { const v = top(d.via, 2); if (v.length) parts.push(`靠 ${v.map(([k]) => k).join('、')}`); }
  return parts.join('，');
}

export class Ledger implements LedgerView {
  data: LedgerData;
  onSignal?: (s: LedgerSignal) => void;
  private seenKeys: Set<string>;
  private cur = { actions: 0, failures: 0, walked: 0, hpLost: 0 };
  private lastPos: Vec3Like | null = null;
  private lastHp: number | null = null;
  private lastInv: Map<string, number> | null = null;
  private lastSkill: { name: string; at: number } | null = null;
  private ticks = 0;
  private dirty = false;
  private savedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private listener = (ev: AgentEvent) => this.onEvent(ev);

  constructor(private file: string | null, private bus: EventBus, private state: () => AgentState, private sight: () => Sight = () => ({ blocks: [], entities: [] }),
    /** 这段时间里身体用过哪些技能（名字@版本），用来算“用了这个技能拿东西是快了还是慢了” */
    private skillsUsed: (from: number, to: number) => string[] = () => []) {
    this.data = { version: 1, seen: {}, got: {}, episodes: [], seenKeys: [] };
    if (file) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerData;
        if (raw?.version === 1) this.data = { ...this.data, ...raw };
      } catch { /* 第一次运行，没有账本 */ }
    }
    this.seenKeys = new Set(this.data.seenKeys);
  }

  start(tickMs = 2000) {
    this.bus.on('event', this.listener);
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }
  stop() { this.bus.off('event', this.listener); if (this.timer) clearInterval(this.timer); this.timer = null; this.save(true); }

  // ---------------------------------------------------------------- 记账
  tick(now = Date.now()) {
    let s: AgentState;
    try { s = this.state(); } catch { return; }
    if (!s.connected || !s.alive) { this.lastPos = null; this.lastHp = null; this.lastInv = null; return; }
    if (this.lastPos) {
      const d = Math.hypot(s.pos.x - this.lastPos.x, s.pos.y - this.lastPos.y, s.pos.z - this.lastPos.z);
      if (d < 30) this.cur.walked += d; // 更远的是传送、重生，不算走的
    }
    this.lastPos = { ...s.pos };
    if (this.lastHp !== null && s.hp < this.lastHp) this.cur.hpLost += this.lastHp - s.hp;
    this.lastHp = s.hp;
    const inv = new Map<string, number>();
    for (const i of s.inventory) inv.set(i.name, (inv.get(i.name) ?? 0) + i.count);
    if (this.lastInv) {
      const via = this.lastSkill && now - this.lastSkill.at < 6000 ? this.lastSkill.name : undefined;
      for (const [name, n] of inv) {
        const before = this.lastInv.get(name) ?? 0;
        if (n > before) this.note('got', name, n - before, s, via, now);
      }
    }
    this.lastInv = inv;
    if (++this.ticks % 3 === 0) this.look(s, now);
    this.save();
  }

  private look(s: AgentState, now: number) {
    let v: Sight;
    try { v = this.sight(); } catch { return; }
    for (const b of v.blocks) {
      const key = `${s.dim}:${b.name}@${Math.floor(b.pos.x)},${Math.floor(b.pos.y)},${Math.floor(b.pos.z)}`;
      if (this.remember(key)) this.note('seen', b.name, 1, s, undefined, now, b.pos.y);
    }
    for (const e of v.entities) {
      if (e.perception === 'heard' || e.kind === 'item' || e.name.startsWith('player')) continue;
      if (this.remember(`${s.sessionId}:e${e.id}`)) this.note('seen', e.name, 1, s, undefined, now, e.pos.y);
    }
  }

  private remember(key: string): boolean {
    if (this.seenKeys.has(key)) return false;
    this.seenKeys.add(key);
    this.data.seenKeys.push(key);
    if (this.data.seenKeys.length > MAX_SEEN_KEYS) {
      for (const k of this.data.seenKeys.splice(0, this.data.seenKeys.length - MAX_SEEN_KEYS)) this.seenKeys.delete(k);
    }
    return true;
  }

  note(book: 'seen' | 'got', name: string, units: number, s: Pick<AgentState, 'pos' | 'biome' | 'dim'>, via?: string, now = Date.now(), y = s.pos.y) {
    const d = (this.data[book][name] ??= { n: 0, y: {}, biome: {}, dim: {}, last: 0 });
    const b = String(Math.floor(y / BUCKET) * BUCKET);
    d.n += units;
    d.y[b] = (d.y[b] ?? 0) + units;
    d.biome[s.biome ?? 'unknown'] = (d.biome[s.biome ?? 'unknown'] ?? 0) + units;
    d.dim[s.dim] = (d.dim[s.dim] ?? 0) + units;
    if (via) { d.via ??= {}; d.via[via] = (d.via[via] ?? 0) + units; }
    d.last = now;
    this.dirty = true;
  }

  private onEvent(ev: AgentEvent) {
    const d = (ev.data ?? {}) as Record<string, any>;
    if (ev.type === 'task_end' && d.source !== 'filler') {
      this.cur.actions++;
      if (d.status === 'failed') this.cur.failures++;
      if (d.skill) this.lastSkill = { name: String(d.skill), at: ev.ts };
    } else if (ev.type === 'attempt_end') {
      this.closeEpisode({
        what: String(d.what ?? ev.msg.match(/「([^」]*)」/)?.[1] ?? ''), kind: String(d.kind ?? ''), signature: String(d.how || d.signature || ''),
        outcome: String(d.outcome ?? ''), sec: Number(d.durationSec) || 0, gained: (d.gained ?? {}) as Record<string, number>,
      }, ev.ts);
    }
  }

  closeEpisode(e: { what: string; kind: string; signature: string; outcome: string; sec: number; gained: Record<string, number> }, at = Date.now()): Episode {
    let skills: string[] = [];
    try { skills = [...new Set(this.skillsUsed(at - e.sec * 1000 - 2000, at + 1000))].slice(0, 12); } catch { /* 技能统计暂不可用 */ }
    const ep: Episode = { at, ...e, gained: Object.fromEntries(Object.entries(e.gained).filter(([, v]) => v > 0)),
      actions: this.cur.actions, failures: this.cur.failures, walked: Math.round(this.cur.walked), hpLost: r1(this.cur.hpLost), ...(skills.length ? { skills } : {}) };
    this.cur = { actions: 0, failures: 0, walked: 0, hpLost: 0 };
    const prior = this.data.episodes;
    this.data.episodes = [...prior, ep].slice(-MAX_EPISODES);
    this.dirty = true;
    const sig = this.judge(ep, prior);
    if (sig) {
      this.bus.publish('ledger_signal', 'P2', `拿 ${sig.item} ${sig.direction === 'slow' ? '比平时费劲' : '比平时省事'}：这次每个 ${fmtSec(sig.thisSec)}，平时 ${fmtSec(sig.usualSec)}`, { ...sig, episode: undefined, what: ep.what });
      try { this.onSignal?.(sig); } catch { /* 下游出错不影响记账 */ }
    }
    this.save();
    return ep;
  }

  /**
   * 这次拿某样东西是不是明显偏离它自己的平时：对“每个花多少秒”取对数，和它最近二十次比；
   * 超出平时波动两倍才算（波动有个下限，免得前几次碰巧差不多就对一点点变化大惊小怪）。只报偏得最多的一样。
   */
  judge(ep: Episode, prior: Episode[]): LedgerSignal | null {
    let best: LedgerSignal | null = null, bestZ = 0;
    for (const item of Object.keys(ep.gained)) {
      const xs = prior.filter((p) => p.gained[item]).slice(-20).map((p) => Math.log(Math.max(1, perUnit(p, item))));
      if (xs.length < 4) continue;
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.max(0.35, Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length));
      const x = Math.log(Math.max(1, perUnit(ep, item)));
      const z = (x - mean) / sd;
      if (Math.abs(z) > 2 && Math.abs(z) > bestZ) {
        bestZ = Math.abs(z);
        best = { item, direction: z > 0 ? 'slow' : 'fast', ratio: r1(Math.exp(x - mean)), usualSec: r1(Math.exp(mean)), thisSec: r1(Math.exp(x)), episode: ep };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- 看账
  stats(item: string): ItemStats | null {
    const eps = this.data.episodes.filter((e) => e.gained[item]);
    if (!eps.length) return null;
    const costs = eps.map((e) => perUnit(e, item));
    const third = Math.floor(eps.length / 3);
    const earlySec = eps.length >= 6 ? median(costs.slice(0, third)) : null;
    const recentSec = eps.length >= 6 ? median(costs.slice(-third)) : null;
    const trend = earlySec && recentSec ? (recentSec < earlySec * 0.8 ? 'better' : recentSec > earlySec * 1.25 ? 'worse' : 'flat') : null;
    const best = eps.map((e, i) => ({ what: e.what, signature: e.signature, perUnitSec: r1(costs[i]) })).sort((a, b) => a.perUnitSec - b.perUnitSec)
      .filter((b, i, all) => all.findIndex((x) => x.signature === b.signature) === i).slice(0, 2);
    return { item, episodes: eps.length, units: eps.reduce((s, e) => s + e.gained[item], 0), perUnitSec: r1(median(costs)), earlySec: earlySec && r1(earlySec), recentSec: recentSec && r1(recentSec), trend, best,
      totalSec: Math.round(eps.reduce((s, e) => s + e.sec / Object.keys(e.gained).length, 0)) };
  }

  /**
   * 一个技能对收获效率的影响：同一样东西，用了它的那几段活和没用它的比，每个花多少；按版本分开。
   * 没得比（从没在不用它时拿过同样东西）就只说用它时的花费。
   */
  skillEffect(name: string): string {
    const uses = (e: Episode) => !!e.skills?.some((s) => s === name || s.startsWith(`${name}@`));
    const withIt = this.data.episodes.filter((e) => uses(e) && Object.keys(e.gained).length);
    if (!withIt.length) {
      const any = this.data.episodes.filter(uses);
      return any.length ? `用过它的 ${any.length} 段活都没得到东西` : '';
    }
    const items = top(withIt.reduce((acc, e) => { for (const k of Object.keys(e.gained)) acc[k] = (acc[k] ?? 0) + 1; return acc; }, {} as Record<string, number>), 3);
    const parts = items.map(([item]) => {
      const w = withIt.filter((e) => e.gained[item]).map((e) => perUnit(e, item));
      const wo = this.data.episodes.filter((e) => e.gained[item] && !uses(e)).map((e) => perUnit(e, item));
      return `${item} 用它时每个 ${fmtSec(median(w))}（${w.length} 次）${wo.length >= 2 ? `，不用它时 ${fmtSec(median(wo))}（${wo.length} 次）` : ''}`;
    });
    const vers = top(withIt.reduce((acc, e) => { for (const s of e.skills ?? []) if (s.startsWith(`${name}@`)) { const v = s.slice(name.length + 1); acc[v] = (acc[v] ?? 0) + 1; } return acc; }, {} as Record<string, number>), 4);
    if (vers.length > 1) {
      const [item] = items[0];
      const byV = vers.map(([v]) => {
        const xs = withIt.filter((e) => e.gained[item] && e.skills?.includes(`${name}@${v}`)).map((e) => perUnit(e, item));
        return xs.length ? `${v} 每个 ${fmtSec(median(xs))}（${xs.length} 次）` : '';
      }).filter(Boolean);
      if (byV.length > 1) parts.push(`按版本（${item}）：${byV.join('、')}`);
    }
    return parts.join('；');
  }

  /** 这样东西是在什么活里拿到的（活的名字多是中文，按关键词想起账时靠它把“挖铁矿”和 raw_iron 连起来） */
  aliases(name: string): string[] {
    return [...new Set(this.data.episodes.filter((e) => e.gained[name]).slice(-8).map((e) => e.what))];
  }

  /** 用过技能的经历有多少段（整理技能时用来判断效果证据够不够） */
  skillEpisodes(): number { return this.data.episodes.filter((e) => e.skills?.length).length; }

  names(): string[] { return [...new Set([...Object.keys(this.data.got), ...Object.keys(this.data.seen)])]; }

  /** 一样东西的账，一句话 */
  describe(name: string): string {
    const parts: string[] = [];
    const st = this.stats(name);
    if (st) {
      const trend = st.trend === 'better' ? `，在变省（早先 ${fmtSec(st.earlySec!)} → 最近 ${fmtSec(st.recentSec!)}）` : st.trend === 'worse' ? `，在变费劲（早先 ${fmtSec(st.earlySec!)} → 最近 ${fmtSec(st.recentSec!)}）` : '';
      parts.push(`${st.episodes} 段活拿到 ${st.units} 个，每个约 ${fmtSec(st.perUnitSec)}${trend}`);
      const best = st.best.filter((b) => b.signature);
      if (best.length) parts.push(`最省的做法：${best.map((b) => `「${b.what.slice(0, 30)}」${b.signature.slice(0, 80)}（每个 ${fmtSec(b.perUnitSec)}）`).join('；')}`);
    }
    const got = describeDist(this.data.got[name]);
    if (got && !st) parts.push(`进过背包 ${this.data.got[name].n} 个`);
    if (got) parts.push(`拿到时 ${got}`);
    const seen = this.data.seen[name];
    if (seen?.n) parts.push(`见过 ${seen.n} 处：${describeDist(seen)}`);
    return parts.length ? `${name}：${parts.join('；')}` : '';
  }

  /** 整本账的摘要：花时间最多的东西排前面，再加上“白忙”的比例 */
  digest(n = 10): string[] {
    const items = Object.keys(this.data.got).map((k) => this.stats(k)).filter((s): s is ItemStats => !!s).sort((a, b) => b.totalSec - a.totalSec).slice(0, n);
    const lines = items.map((s) => this.describe(s.item));
    const recent = this.data.episodes.slice(-30);
    if (recent.length >= 5) {
      const idle = recent.filter((e) => !Object.keys(e.gained).length && e.kind !== 'rest');
      const total = recent.reduce((s, e) => s + e.sec, 0) || 1;
      const idleSec = idle.reduce((s, e) => s + e.sec, 0);
      if (idle.length) {
        const kinds = top(idle.reduce((acc, e) => { acc[e.kind || '其他'] = (acc[e.kind || '其他'] ?? 0) + e.sec; return acc; }, {} as Record<string, number>), 3);
        lines.push(`最近 ${recent.length} 段活里有 ${idle.length} 段什么也没得到，占时间 ${Math.round((idleSec / total) * 100)}%（多是 ${kinds.map(([k, v]) => `${k} ${fmtSec(v)}`).join('、')}）`);
      }
    }
    const seen = top(Object.fromEntries(Object.entries(this.data.seen).filter(([k]) => !this.data.got[k]).map(([k, v]) => [k, v.n])), 5);
    if (seen.length) lines.push(`见过但还没拿过：${seen.map(([k]) => `${k}（${describeDist(this.data.seen[k])}）`).join('；')}`);
    return lines.filter(Boolean);
  }

  /** 打猎的账：hunt 过几次、大概打了几只、每次为了肉走多远（最近 3 次平均） */
  huntTally(): HuntTally {
    const hunts = this.data.episodes.filter((e) => /\bhunt\b/.test(e.signature) || Object.keys(e.gained).some((k) => RAW_MEAT.has(k)));
    const animals = hunts.reduce((n, e) => n + Object.entries(e.gained).filter(([k]) => RAW_MEAT.has(k)).reduce((m, [, v]) => m + Math.max(1, Math.ceil(v / 2)), 0), 0);
    const recent = hunts.slice(-3);
    return { trips: hunts.length, animals, walked: hunts.reduce((n, e) => n + e.walked, 0),
      recentWalked: recent.length ? Math.round(recent.reduce((n, e) => n + e.walked, 0) / recent.length) : null, lastAt: hunts.at(-1)?.at ?? null };
  }

  /** 给控制台看 */
  summary(n = 14) {
    const items = Object.keys(this.data.got).map((k) => this.stats(k)).filter((s): s is ItemStats => !!s).sort((a, b) => b.totalSec - a.totalSec).slice(0, n)
      .map((s) => ({ ...s, where: describeDist(this.data.got[s.item]), seen: this.data.seen[s.item]?.n ?? 0 }));
    const seen = top(Object.fromEntries(Object.entries(this.data.seen).map(([k, v]) => [k, v.n])), n).map(([k, v]) => ({ name: k, n: v, where: describeDist(this.data.seen[k]) }));
    const recent = this.data.episodes.slice(-30);
    const total = recent.reduce((s, e) => s + e.sec, 0);
    const idle = recent.filter((e) => !Object.keys(e.gained).length && e.kind !== 'rest').reduce((s, e) => s + e.sec, 0);
    return { items, seen, episodes: this.data.episodes.length, idleShare: total ? Math.round((idle / total) * 100) : null };
  }

  save(force = false) {
    if (!this.file || !this.dirty) return;
    const now = Date.now();
    if (!force && now - this.savedAt < 30_000) return;
    this.savedAt = now;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch { this.dirty = true; }
  }
}

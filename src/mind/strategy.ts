import type { AgentEvent } from '../events.ts';
import type { BuildNote } from './home.ts';
import type { AgendaItem } from './types.ts';

/**
 * 策略层的事实：像人回头看这几天“日子是怎么过的”——夜里在哪过、怎么死的、哪些目标试了很多次没成、盖房花了多少工夫、游戏进度到哪了。
 * 只记发生过的事，不给结论；回想时交给模型，让它自己找出反复出现的大麻烦，想出新的玩法（比如出门带上什么、换个地方住、先去弄什么东西）。
 */
export interface DeathNote { at: number; cause: string; phase: string; bedDist: number | null; doing: string }
export interface NightNote { at: number; how: 'bed' | 'outside'; farthestFromBed: number | null; died: boolean; doing: string[] }

export class StrategyLog {
  deaths: DeathNote[] = [];
  nights: NightNote[] = [];
  private night: { slept: boolean; died: boolean; far: number | null; doing: Set<string> } | null = null;
  private phase = '';

  onEvent(ev: AgentEvent, ctx: { phase: string; bedDist: number | null; doing: string }) {
    if (ev.type === 'death') {
      const d = (ev.data ?? {}) as Record<string, unknown>;
      this.deaths = [...this.deaths, { at: ev.ts, cause: String(d.message ?? d.cause ?? ev.msg).replace(/^死亡 @ \([^)]*\)，?/, '').slice(0, 80), phase: ctx.phase, bedDist: ctx.bedDist, doing: ctx.doing.slice(0, 40) }].slice(-40);
      if (this.night) this.night.died = true;
    } else if (ev.type === 'task_end' && /\] sleep → succeeded/.test(ev.msg) && this.night) this.night.slept = true;
  }

  /** 每拍：天色和离床多远（夜里记下离床最远的距离；熬到天亮记一笔这晚怎么过的） */
  onTick(phase: string, bedDist: number | null, doing: string | undefined, now = Date.now()) {
    const dark = phase === 'night' || phase === 'dusk';
    if (dark && !this.night) this.night = { slept: false, died: false, far: null, doing: new Set() };
    if (dark && this.night) {
      if (bedDist !== null) this.night.far = Math.max(this.night.far ?? 0, bedDist);
      if (doing && this.night.doing.size < 6) this.night.doing.add(doing.slice(0, 30));
    }
    if (!dark && this.night && (this.phase === 'night' || this.phase === 'dawn' || this.phase === 'dusk')) {
      const n = this.night;
      this.nights = [...this.nights, { at: now, how: n.slept ? 'bed' as const : 'outside' as const, farthestFromBed: n.far, died: n.died, doing: [...n.doing] }].slice(-20);
      this.night = null;
    }
    this.phase = phase;
  }

  facts(input: { agenda: AgendaItem[]; builds: BuildNote[]; skills?: { total: number; forged: number; retired: number }; supply?: string | null }, now = Date.now()): string[] {
    const out: string[] = [];
    const nights = this.nights.slice(-8);
    if (nights.length) {
      const bed = nights.filter((n) => n.how === 'bed').length, died = nights.filter((n) => n.died).length;
      const far = nights.filter((n) => n.how === 'outside' && n.farthestFromBed !== null).map((n) => n.farthestFromBed!);
      out.push(`最近 ${nights.length} 个夜晚：睡床 ${bed} 次，在外面熬 ${nights.length - bed} 次${far.length ? `（那几晚离床最远 ${Math.max(...far)} 格）` : ''}，夜里死了 ${died} 次；熬夜时在做：${[...new Set(nights.filter((n) => n.how === 'outside').flatMap((n) => n.doing))].slice(0, 5).join('、') || '—'}`);
    }
    const deaths = this.deaths.filter((d) => now - d.at < 6 * 3600_000);
    if (deaths.length) {
      const by = new Map<string, number>();
      for (const d of deaths) by.set(d.cause, (by.get(d.cause) ?? 0) + 1);
      const farBed = deaths.filter((d) => d.bedDist !== null && d.bedDist > 64).length;
      out.push(`最近 6 小时死了 ${deaths.length} 次：${[...by].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${c}×${n}`).join('；')}；夜里/黄昏死的 ${deaths.filter((d) => d.phase === 'night' || d.phase === 'dusk').length} 次，离床 64 格以外死的 ${farBed} 次；死时在做：${[...new Set(deaths.map((d) => d.doing).filter(Boolean))].slice(0, 4).join('、')}`);
    }
    const heavy = input.agenda.filter((a) => a.kind === 'goal' && a.attempts >= 20).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
    if (heavy.length) out.push(`花了很多段活的目标：${heavy.map((a) => `「${a.text.slice(0, 24)}」${a.attempts} 段→${a.status === 'done' ? '做成' : a.status === 'dropped' ? '放下了' : '还在做'}`).join('；')}`);
    if (input.builds.length) {
      const b = input.builds;
      out.push(`盖房：${b.length} 座作品，${b.filter((x) => x.status === 'complete').length} 座收工/盖好，验收合计 ${b.reduce((n, x) => n + x.attempts, 0)} 次；没收工的：${b.filter((x) => x.status !== 'complete').map((x) => `${x.name}还差${x.missing}处`).slice(0, 3).join('、') || '无'}`);
    }
    if (input.skills) out.push(`身体技能：现有 ${input.skills.total} 个（这段时间新写 ${input.skills.forged}、收起 ${input.skills.retired}）`);
    if (input.supply) out.push(input.supply);
    return out;
  }
}

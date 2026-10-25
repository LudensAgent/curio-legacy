import type { AgentState } from '../adapter/types.ts';
import type { AgentEvent, EventBus } from '../events.ts';
import type { SkillBook } from '../knowledge/skillbook.ts';
import type { BehaviorEngine } from '../mind/behaviors.ts';
import type { ChatMessage } from '../planner/llm.ts';
import { extractJson } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import { API_DOC } from './bridge.ts';

/**
 * 造技能：从“刚才出的事”里总结出一份新技能（或者重写管这件事却没做好的旧技能）。
 *
 * 主心智在被追、快死、卡住的时候忙着保命，几乎不可能顺手写出一段正确的代码；
 * 所以出了事（死了、同一类事反复卡住、被怪追着甩不掉）之后，单独发一次后台 LLM 请求，
 * 拿着事发前后的经过专门写技能。写下的技能校验通过就立刻生效，和心智自己写的一样记成败、在后台改进。
 *
 * 不能太频繁：同一时间只造一份，两次至少隔 gapMs，每小时最多 maxPerHour 次；
 * 排不上的事只留最新的一件，等能造了再造。
 */
export type ForgeKind = 'death' | 'stuck' | 'cornered';
export interface SmithOptions { gapMs: number; maxPerHour: number; stuckRepeats: number; stuckWindowMs: number }
export const DEFAULT_SMITH: SmithOptions = { gapMs: 10 * 60_000, maxPerHour: 3, stuckRepeats: 3, stuckWindowMs: 15 * 60_000 };

interface Incident { kind: ForgeKind; at: number; headline: string; lines: string[]; context: Record<string, unknown> }

const KEEP = new Set(['task_start', 'task_end', 'hurt', 'notice', 'reflex', 'reflex_gaveup', 'instinct', 'thought', 'attempt_end', 'activity_start', 'activity_adjust',
  'death', 'death_items', 'game_message', 'body_adapt', 'stuck', 'skill_written', 'skill_forged', 'skill_disabled']);
const KIND_LABEL: Record<ForgeKind, string> = { death: '死亡', stuck: '反复卡在同一件事上', cornered: '被怪追着甩不掉' };

export class SkillSmith {
  busy: { kind: ForgeKind; startedAt: number } | null = null;
  readonly opts: SmithOptions;
  private recent: AgentEvent[] = [];
  private stucks: { at: number; msg: string }[] = [];
  private lastAt = 0;
  private starts: number[] = [];
  private pending: Incident | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listener = (ev: AgentEvent) => this.onEvent(ev);
  /** 造过的（给控制台看） */
  history: { at: number; kind: ForgeKind; result: string }[] = [];

  constructor(private planner: Pick<Planner, 'complete' | 'autonomous' | 'noteInvalid'>, private engine: BehaviorEngine, private book: SkillBook | null,
    private bus: EventBus, private state: () => AgentState, opts: Partial<SmithOptions> = {}) {
    this.opts = { ...DEFAULT_SMITH, ...opts };
  }

  start() {
    this.bus.on('event', this.listener);
    this.timer = setInterval(() => this.tryPending(), 30_000);
    this.timer.unref?.();
  }
  stop() { this.bus.off('event', this.listener); if (this.timer) clearInterval(this.timer); this.timer = null; }

  private onEvent(ev: AgentEvent) {
    if (KEEP.has(ev.type) && !(ev.type === 'task_start' && /\[filler\]/.test(ev.msg)) && !(ev.type === 'task_end' && /\[filler\]/.test(ev.msg))) {
      this.recent.push(ev);
      if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
    }
    if (ev.type === 'death') {
      // 等游戏的死亡播报和掉落清单到了再造
      setTimeout(() => this.report('death', ev.ts, ev.msg, 75_000), 3000).unref?.();
    } else if (ev.type === 'reflex_gaveup') {
      this.report('cornered', ev.ts, ev.msg, 45_000);
    } else if (ev.type === 'attempt_end' && (ev.data as any)?.outcome === 'stuck') {
      const now = ev.ts;
      this.stucks = [...this.stucks.filter((s) => now - s.at < this.opts.stuckWindowMs), { at: now, msg: ev.msg }];
      if (this.stucks.length >= this.opts.stuckRepeats) {
        const msgs = this.stucks.map((s) => s.msg);
        this.stucks = [];
        this.report('stuck', now, `${this.opts.stuckRepeats} 次卡住：${msgs.map((m) => m.slice(0, 60)).join(' / ')}`, this.opts.stuckWindowMs);
      }
    }
  }

  /** 记下一件事；能造就马上在后台造，不能就留着（只留最新的一件） */
  report(kind: ForgeKind, at: number, headline: string, windowMs: number) {
    const lines = this.recent.filter((e) => e.ts >= at - windowMs && e.ts <= at + 5000).slice(-90)
      .map((e) => `[${((e.ts - at) / 1000).toFixed(0)}s] ${e.type} ${e.msg.replace(/\s+/g, ' ').slice(0, 170)}`);
    let st: AgentState | null = null;
    try { st = this.state(); } catch { /* 状态暂不可用 */ }
    const incident: Incident = { kind, at, headline: headline.slice(0, 300), lines,
      context: st ? { hp: Math.round(st.hp * 10) / 10, food: st.food, isDay: st.isDay, dim: st.dim, inventory: st.inventory.slice(0, 20).map((i) => `${i.name}×${i.count}`) } : {} };
    if (!this.consider(incident)) this.pending = kind === 'death' || !this.pending || this.pending.kind !== 'death' ? incident : this.pending;
  }

  private tryPending() { if (this.pending && this.consider(this.pending)) this.pending = null; }

  /** 限频之内就开始造（后台进行），返回是否开始了 */
  private consider(incident: Incident, now = Date.now()): boolean {
    if (!this.planner.autonomous || this.busy) return false;
    if (now - this.lastAt < this.opts.gapMs) return false;
    this.starts = this.starts.filter((t) => now - t < 3600_000);
    if (this.starts.length >= this.opts.maxPerHour) return false;
    this.busy = { kind: incident.kind, startedAt: now };
    this.lastAt = now;
    this.starts.push(now);
    this.bus.publish('skill_forge_start', 'P2', `在后台从刚才的${KIND_LABEL[incident.kind]}里总结技能`, { kind: incident.kind });
    void this.forge(incident)
      .then((r) => { this.history = [...this.history, { at: Date.now(), kind: incident.kind, result: r }].slice(-20); })
      .catch((e) => {
        const why = String((e as Error)?.message ?? e).slice(0, 200);
        this.history = [...this.history, { at: Date.now(), kind: incident.kind, result: `出错：${why}` }].slice(-20);
        this.bus.publish('skill_forge_failed', 'P2', `总结技能没成：${why}`);
      })
      .finally(() => { this.busy = null; });
    return true;
  }

  messages(incident: Incident): ChatMessage[] {
    const guide = this.book?.get('writing-skills')?.body ?? '';
    const system = `你是 Minecraft 机器人 Curio 的“身体技能工程师”。下面是它刚刚经历的一段事（${KIND_LABEL[incident.kind]}）。
判断：如果身体当时有一个技能，能不能避免这件事或者处理得更好？能，就写出这个技能——写下就立刻生效，下次遇到同类情况身体会自己做。
要求：
- 针对这一类情况，不是只对这一次；触发条件只写身体当时感觉得到的事（血量、看见的怪、身边的方块、刚失败的动作、是否挨打、是否在坑里）。
- 需要计算（找路、挑方向、挑落脚点、判断要不要打）就写代码技能（code）；简单固定的几步可以写 steps。
- existing_skills 里已经有管这件事的技能、只是没做好：用同一个名字重写它，别重复造。
- 不是技能能解决的（纯属运气、应该由思考决定的取舍、缺的是材料不是做法）：输出 {"none":true,"why":"…"}。

写技能的说明：
${guide}

代码技能能用的 api：
${API_DOC}

只输出一个 JSON 对象：{"skill":{"name":…,"description":…,"when":…,"code"或"steps":…,"priority":…}} 或 {"none":true,"why":"…"}。`;
    const user = {
      what_happened: `${KIND_LABEL[incident.kind]}：${incident.headline}`,
      episode: incident.lines,
      now: incident.context,
      existing_skills: this.engine.overview(),
    };
    return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }];
  }

  private async forge(incident: Incident): Promise<string> {
    const messages = this.messages(incident);
    const signal = AbortSignal.timeout(10 * 60_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = await this.planner.complete(messages, { label: `skill:总结（${KIND_LABEL[incident.kind]}）`, tier: 'full', signal, attempt, maxTokensScale: 2 });
      let raw: Record<string, any>;
      try { raw = extractJson(c.text) as Record<string, any>; } catch (e) {
        this.planner.noteInvalid('总结技能', (e as Error).message);
        messages.push({ role: 'user', content: '刚才的回复不是合法 JSON，请只输出一个 JSON 对象。' });
        continue;
      }
      if (raw.none) {
        const why = String(raw.why ?? '').slice(0, 160);
        this.bus.publish('skill_forge_none', 'P3', `看了刚才的${KIND_LABEL[incident.kind]}，没有写技能：${why}`, { kind: incident.kind });
        return `不写：${why}`;
      }
      const w = this.engine.write(raw.skill ?? raw);
      if (!w.ok) {
        messages.push({ role: 'assistant', content: c.text.slice(0, 6000) }, { role: 'user', content: `这个技能存不下：${w.error}。改正后只输出 JSON。` });
        continue;
      }
      const desc = this.engine.get(w.name)?.description ?? '';
      this.bus.publish('skill_forged', 'P2', `从刚才的${KIND_LABEL[incident.kind]}里${w.created ? '总结出新技能' : '改写了技能'}「${w.name}」：${desc}`, { name: w.name, kind: incident.kind, mode: w.mode, created: w.created });
      return `${w.created ? '新技能' : '改写'} ${w.name}`;
    }
    throw new Error('三次都没写出能存下的技能');
  }
}

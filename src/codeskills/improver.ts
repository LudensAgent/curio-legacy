import type { EventBus } from '../events.ts';
import type { BehaviorEngine } from '../mind/behaviors.ts';
import type { LedgerView } from '../mind/ledger.ts';
import type { ChatMessage } from '../planner/llm.ts';
import { extractJson } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';
import { API_DOC } from './bridge.ts';
import { compileCheck } from './sandbox.ts';

/**
 * 代码技能的后台改进：一份代码技能在游戏里反复失败（或心智主动要求）时，单独发一次 LLM 请求，
 * 拿着代码、出错的行和最近几次 api 调用去改，改好的版本校验后立刻换上（旧版本留着，新版本更差会自动退回）。
 *
 * 像建筑师一样在后台进行，不打断游玩；而且不能太频繁：
 * - 同一时间只改一份；两次改进之间至少隔 globalGapMs；同一份技能至少隔 perSkillGapMs（主动要求时 requestGapMs）；
 * - 每小时最多 maxPerHour 次；因为失败而改，需要当前版本至少失败 minFailures 次、且失败占一半以上。
 *
 * 除了“老失败”和“自己要求”，还有“能用但费劲”（slow）：收获账本显示用它时拿东西比不用它、或比旧版本慢，
 * 由整理技能的那一步发现后交过来。改的时候也总把它对收获效率的影响一起给模型看。
 */
export type ImproveWhy = 'failures' | 'requested' | 'slow';
const WHY_TEXT = (why: ImproveWhy, note?: string) => why === 'requested' ? `机器人自己觉得要改：${note ?? ''}` : why === 'slow' ? `能用但费劲：${note ?? '用它时拿东西比不用它或比旧版本慢'}` : '最近几次运行大多失败';
export interface ImproverOptions { globalGapMs: number; perSkillGapMs: number; requestGapMs: number; minFailures: number; maxPerHour: number }
/** 默认不限频（模型便宜）：每次改进后新版本要重新攒够失败才会再改，本身就不会连着改 */
export const DEFAULT_IMPROVER: ImproverOptions = { globalGapMs: 0, perSkillGapMs: 20 * 60_000, requestGapMs: 5 * 60_000, minFailures: 2, maxPerHour: Infinity };
/** 刚换上（改进、退回）的版本至少跑这么久、这么多次，才因为失败去改它：每个版本都要攒够经验才知道好坏 */
export const MIN_VERSION_AGE_MS = 15 * 60_000;

const numbered = (code: string) => code.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');

export class CodeImprover {
  busy: { name: string; startedAt: number } | null = null;
  private lastAt = 0;
  private perSkill = new Map<string, number>();
  private starts: number[] = [];
  private opts: ImproverOptions;
  /** 收获账本：这个技能用了以后拿东西是快了还是慢了（按版本） */
  ledger: LedgerView | null = null;
  private waiting: { name: string; why: ImproveWhy; note?: string }[] = [];

  constructor(private planner: Pick<Planner, 'complete' | 'autonomous' | 'noteInvalid'>, private engine: BehaviorEngine, private bus: EventBus, opts: Partial<ImproverOptions> = {}) {
    this.opts = { ...DEFAULT_IMPROVER, ...opts };
  }

  /** 看看要不要改；要改就在后台开始，立刻返回。返回不改的原因（null = 已开始） */
  consider(name: string, why: ImproveWhy, note?: string, now = Date.now()): string | null {
    if (!this.planner.autonomous) return '没有模型';
    const b = this.engine.get(name);
    if (!b?.code) return '不是代码技能';
    if (this.busy) {
      // 自己要求的、整理时发现费劲的：排队等这份改完再改（老失败的会再触发，不用排）
      if (why !== 'failures' && this.busy.name !== name && !this.waiting.some((w) => w.name === name)) { this.waiting.push({ name, why, note }); return `排队：正在改「${this.busy.name}」`; }
      return `正在改「${this.busy.name}」`;
    }
    if (now - this.lastAt < this.opts.globalGapMs) return '离上次改进太近';
    this.starts = this.starts.filter((t) => now - t < 3600_000);
    if (this.starts.length >= this.opts.maxPerHour) return '这一小时改得够多了';
    if (now - (this.perSkill.get(name) ?? 0) < (why === 'failures' ? this.opts.perSkillGapMs : this.opts.requestGapMs)) return '这份技能刚改过';
    if (why === 'failures') {
      const st = this.engine.statsOf(name);
      const per = st?.byVersion?.[String(b.version ?? 1)];
      if (!per || per.fail < this.opts.minFailures || per.fail < per.ok) return '失败还不够多';
      // 代码本身报错（某一行抛错）可以马上修；只是“做了没成”的，刚换上的版本先多跑一阵
      const codeBroke = /第 \d+ 行|SyntaxError|TypeError|ReferenceError/.test(st?.recent?.at(-1)?.summary ?? st?.lastError ?? '');
      if (st?.swappedAt && now - st.swappedAt < MIN_VERSION_AGE_MS && !codeBroke) return '这一版刚换上不久';
    }
    this.busy = { name, startedAt: now };
    this.lastAt = now;
    this.perSkill.set(name, now);
    this.starts.push(now);
    this.bus.publish('skill_improve_start', 'P2', `在后台改进代码技能「${name}」v${b.version ?? 1}（${WHY_TEXT(why, note)}）`, { name });
    void this.improve(name, why, note).catch((e) => this.bus.publish('skill_improve_failed', 'P2', `改进「${name}」没成：${String((e as Error)?.message ?? e).slice(0, 200)}`, { name }))
      .finally(() => {
        this.busy = null;
        const w = this.waiting.shift();
        if (w) this.consider(w.name, w.why, w.note);
      });
    return null;
  }

  private messages(name: string, why: ImproveWhy, note?: string): ChatMessage[] {
    const b = this.engine.get(name)!;
    const st = this.engine.statsOf(name);
    const runs = (st?.recent ?? []).slice(-5).map((r) => ({ when_min_ago: Math.round((Date.now() - r.at) / 60000), version: r.version, ok: r.ok, result: r.summary,
      ...(r.line ? { line: r.line } : {}), ...(r.args ? { args: r.args } : {}), ...(r.trace?.length ? { last_api_calls: r.trace } : {}), ...(r.logs?.length ? { logs: r.logs } : {}) }));
    const system = `你在维护一个 Minecraft 机器人自己写的“代码技能”：一段在沙箱里运行的 JavaScript，通过 api 操作游戏。
根据它在游戏里实际运行的记录改进代码：修掉出错的地方，处理记录里暴露出来的情况（比如路被挡、方块读不到、动作失败），让它更可靠；
如果它能用但费劲（harvest_effect 显示用它时拿东西更慢），就让它更省：少走冤枉路、少做无用的动作、先看再动、一次做完。保持用途不变，代码保持简短清楚。
${API_DOC}
只输出一个 JSON 对象：{"code":"改好的完整函数体","change":"一句话说改了什么"}；如果失败不是代码的问题（比如本来就不该在那种情况下用），输出 {"keep":true,"why":"…"}。`;
    const user = {
      skill: { name, description: b.description, mode: b.mode, version: b.version ?? 1, ...(b.when ? { when: b.when } : {}) },
      why: WHY_TEXT(why, note),
      ...(this.effect(name) ? { harvest_effect: this.effect(name) } : {}),
      stats: st?.byVersion ?? {},
      recent_runs: runs,
    };
    return [{ role: 'system', content: system }, { role: 'user', content: `${JSON.stringify(user)}\n\n现在的代码（行号只是给你看的）：\n${numbered(b.code!)}` }];
  }

  private effect(name: string): string { try { return this.ledger?.skillEffect(name) ?? ''; } catch { return ''; } }

  private async improve(name: string, why: ImproveWhy, note?: string) {
    const messages = this.messages(name, why, note);
    const signal = AbortSignal.timeout(10 * 60_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = await this.planner.complete(messages, { label: `skill:改进 ${name}`, tier: 'full', signal, attempt, maxTokensScale: 2 });
      let raw: Record<string, any>;
      try { raw = extractJson(c.text) as Record<string, any>; } catch (e) {
        this.planner.noteInvalid(`改进 ${name}`, (e as Error).message);
        messages.push({ role: 'user', content: '刚才的回复不是合法 JSON，请只输出一个 JSON 对象。' });
        continue;
      }
      if (raw.keep) { this.bus.publish('skill_improve_kept', 'P3', `看了「${name}」的记录，代码先不改：${String(raw.why ?? '').slice(0, 160)}`, { name }); return; }
      const code = typeof raw.code === 'string' ? raw.code.replace(/\r\n/g, '\n') : '';
      const bad = compileCheck(code);
      if (bad) { messages.push({ role: 'assistant', content: c.text.slice(0, 2000) }, { role: 'user', content: `代码过不了检查：${bad}。改正后只输出 JSON。` }); continue; }
      if (code.trim() === this.engine.get(name)?.code?.trim()) { this.bus.publish('skill_improve_kept', 'P3', `「${name}」的代码没有变化`, { name }); return; }
      const change = String(raw.change ?? '改进了代码').slice(0, 120);
      const r = this.engine.replaceCode(name, code, change);
      if (!r.ok) throw new Error(r.error);
      this.bus.publish('skill_improved', 'P2', `代码技能「${name}」升级到 v${r.version}：${change}`, { name, version: r.version, change });
      return;
    }
    throw new Error('两次都没拿到能用的代码');
  }
}

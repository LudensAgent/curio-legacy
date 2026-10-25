import type { EventBus } from '../events.ts';
import type { BehaviorEngine } from '../mind/behaviors.ts';
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
 */
export interface ImproverOptions { globalGapMs: number; perSkillGapMs: number; requestGapMs: number; minFailures: number; maxPerHour: number }
export const DEFAULT_IMPROVER: ImproverOptions = { globalGapMs: 20 * 60_000, perSkillGapMs: 60 * 60_000, requestGapMs: 30 * 60_000, minFailures: 2, maxPerHour: 2 };

const numbered = (code: string) => code.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');

export class CodeImprover {
  busy: { name: string; startedAt: number } | null = null;
  private lastAt = 0;
  private perSkill = new Map<string, number>();
  private starts: number[] = [];
  private opts: ImproverOptions;

  constructor(private planner: Pick<Planner, 'complete' | 'autonomous' | 'noteInvalid'>, private engine: BehaviorEngine, private bus: EventBus, opts: Partial<ImproverOptions> = {}) {
    this.opts = { ...DEFAULT_IMPROVER, ...opts };
  }

  /** 看看要不要改；要改就在后台开始，立刻返回。返回不改的原因（null = 已开始） */
  consider(name: string, why: 'failures' | 'requested', note?: string, now = Date.now()): string | null {
    if (!this.planner.autonomous) return '没有模型';
    const b = this.engine.get(name);
    if (!b?.code) return '不是代码技能';
    if (this.busy) return `正在改「${this.busy.name}」`;
    if (now - this.lastAt < this.opts.globalGapMs) return '离上次改进太近';
    this.starts = this.starts.filter((t) => now - t < 3600_000);
    if (this.starts.length >= this.opts.maxPerHour) return '这一小时改得够多了';
    if (now - (this.perSkill.get(name) ?? 0) < (why === 'requested' ? this.opts.requestGapMs : this.opts.perSkillGapMs)) return '这份技能刚改过';
    if (why === 'failures') {
      const per = this.engine.statsOf(name)?.byVersion?.[String(b.version ?? 1)];
      if (!per || per.fail < this.opts.minFailures || per.fail < per.ok) return '失败还不够多';
    }
    this.busy = { name, startedAt: now };
    this.lastAt = now;
    this.perSkill.set(name, now);
    this.starts.push(now);
    this.bus.publish('skill_improve_start', 'P2', `在后台改进代码技能「${name}」v${b.version ?? 1}（${why === 'requested' ? `自己要求：${note ?? ''}` : '最近老失败'}）`, { name });
    void this.improve(name, why, note).catch((e) => this.bus.publish('skill_improve_failed', 'P2', `改进「${name}」没成：${String((e as Error)?.message ?? e).slice(0, 200)}`, { name }))
      .finally(() => { this.busy = null; });
    return null;
  }

  private messages(name: string, why: string, note?: string): ChatMessage[] {
    const b = this.engine.get(name)!;
    const st = this.engine.statsOf(name);
    const runs = (st?.recent ?? []).slice(-5).map((r) => ({ when_min_ago: Math.round((Date.now() - r.at) / 60000), version: r.version, ok: r.ok, result: r.summary,
      ...(r.line ? { line: r.line } : {}), ...(r.args ? { args: r.args } : {}), ...(r.trace?.length ? { last_api_calls: r.trace } : {}), ...(r.logs?.length ? { logs: r.logs } : {}) }));
    const system = `你在维护一个 Minecraft 机器人自己写的“代码技能”：一段在沙箱里运行的 JavaScript，通过 api 操作游戏。
根据它在游戏里实际运行的记录改进代码：修掉出错的地方，处理记录里暴露出来的情况（比如路被挡、方块读不到、动作失败），让它更可靠。保持用途不变，代码保持简短清楚。
${API_DOC}
只输出一个 JSON 对象：{"code":"改好的完整函数体","change":"一句话说改了什么"}；如果失败不是代码的问题（比如本来就不该在那种情况下用），输出 {"keep":true,"why":"…"}。`;
    const user = {
      skill: { name, description: b.description, mode: b.mode, version: b.version ?? 1, ...(b.when ? { when: b.when } : {}) },
      why: why === 'requested' ? `机器人自己觉得要改：${note ?? ''}` : '最近几次运行大多失败',
      stats: st?.byVersion ?? {},
      recent_runs: runs,
    };
    return [{ role: 'system', content: system }, { role: 'user', content: `${JSON.stringify(user)}\n\n现在的代码（行号只是给你看的）：\n${numbered(b.code!)}` }];
  }

  private async improve(name: string, why: string, note?: string) {
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

import type { EventBus } from '../events.ts';
import type { SkillBook } from '../knowledge/skillbook.ts';
import type { BehaviorEngine } from '../mind/behaviors.ts';
import type { ChatMessage } from '../planner/llm.ts';
import { extractJson } from '../planner/plan.ts';
import type { Planner } from '../planner/planner.ts';

/**
 * 整理技能：技能多了以后像人整理笔记一样定期理一理。
 * - 长期用不上的（写下很久了、一直没触发过或很久没用）：收起来，不再占提示词、不再参与竞争；
 * - 说的是同一件事、触发条件重叠、常常抢着接手的：后台请一次模型合并成一份、调整谁先上、收起多余的。
 * 收起不是删除：文件和成败都还在，同名重写就恢复。合并和调优先级很少做（有新技能或冲突时，至少隔 gapMs）。
 */
export interface CuratorOptions { checkMs: number; unusedMs: number; gapMs: number; minSkills: number }
export const DEFAULT_CURATOR: CuratorOptions = { checkMs: 10 * 60_000, unusedMs: 6 * 3600_000, gapMs: 60 * 60_000, minSkills: 4 };

export class SkillCurator {
  busy = false;
  lastRun = 0;
  private lastSignature = '';
  private conflictSeen = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  readonly opts: CuratorOptions;
  history: { at: number; result: string }[] = [];

  constructor(private planner: Pick<Planner, 'complete' | 'autonomous' | 'noteInvalid'>, private engine: BehaviorEngine, private book: SkillBook | null,
    private bus: EventBus, opts: Partial<CuratorOptions> = {}) {
    this.opts = { ...DEFAULT_CURATOR, ...opts };
  }

  start() { this.timer = setInterval(() => void this.check(), this.opts.checkMs); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private active() { return this.engine.list().filter((b) => b.source === 'self' && !this.engine.statsOf(b.name)?.retired); }

  /** 收起长期用不上的自己写的技能（不需要模型） */
  retireUnused(now = Date.now()): string[] {
    const out: string[] = [];
    for (const b of this.active()) {
      const st = this.engine.statsOf(b.name);
      const written = this.book?.get(b.name)?.updatedAt ?? now;
      const last = Math.max(written, st?.lastAt ?? 0);
      if (now - last >= this.opts.unusedMs) {
        const why = st?.fired ? `${Math.round((now - last) / 3600_000)} 小时没用上` : `写下 ${Math.round((now - written) / 3600_000)} 小时一次都没用上`;
        if (this.engine.retire(b.name, why)) out.push(b.name);
      }
    }
    return out;
  }

  /** 定时检查：先收起用不上的；技能够多、而且有新技能或冲突，才请模型合并 */
  async check(now = Date.now()): Promise<string | null> {
    if (this.busy) return null;
    const retired = this.retireUnused(now);
    const skills = this.active();
    const signature = skills.map((b) => `${b.name}@${this.book?.get(b.name)?.updatedAt ?? 0}`).sort().join('|');
    // 冲突只看上次整理之后新增的
    const conflicted = skills.some((b) => Object.values(this.engine.statsOf(b.name)?.conflicts ?? {}).reduce((n, v) => n + v, 0) - (this.conflictSeen.get(b.name) ?? 0) >= 3);
    if (!this.planner.autonomous || skills.length < this.opts.minSkills || now - this.lastRun < this.opts.gapMs || (signature === this.lastSignature && !conflicted)) {
      return retired.length ? `收起 ${retired.join('、')}` : null;
    }
    this.busy = true;
    this.lastRun = now;
    for (const b of skills) this.conflictSeen.set(b.name, Object.values(this.engine.statsOf(b.name)?.conflicts ?? {}).reduce((n, v) => n + v, 0));
    this.lastSignature = signature;
    this.bus.publish('skill_curate_start', 'P3', `在后台整理技能（${skills.length} 份）`);
    try {
      const r = await this.curate();
      // 整理本身改写了技能：记下整理后的样子，免得下一轮把自己的改动当成“有新技能”
      this.lastSignature = this.active().map((b) => `${b.name}@${this.book?.get(b.name)?.updatedAt ?? 0}`).sort().join('|');
      this.history = [...this.history, { at: Date.now(), result: r }].slice(-10);
      return r;
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 160);
      this.history = [...this.history, { at: Date.now(), result: `出错：${why}` }].slice(-10);
      this.bus.publish('skill_curate_failed', 'P2', `整理技能没成：${why}`);
      return null;
    } finally { this.busy = false; }
  }

  messages(): ChatMessage[] {
    const skills = this.active().map((b) => {
      const st = this.engine.statsOf(b.name);
      return { name: b.name, description: b.description, mode: b.mode, priority: b.priority, ...(b.when ? { when: b.when } : {}),
        kind: b.code ? `代码 v${b.version ?? 1}（${b.code.length} 字符）` : `${b.steps.length} 步`,
        uses: st ? { ok: st.ok, fail: st.fail, fired: st.fired } : { ok: 0, fail: 0, fired: 0 },
        ...(st?.conflicts && Object.keys(st.conflicts).length ? { clashed_with: st.conflicts } : {}), ...(b.code ? { code: b.code.slice(0, 2500) } : { steps: b.steps }) };
    });
    const system = `你在整理 Minecraft 机器人 Curio 自己写的技能（会动手的技能：条件成立时自动做、动作失败时先试、或被调用）。像人整理笔记一样：
- 说的是同一件事、触发条件大面积重叠的：合并成一份更好的（merge：from 写被合并的名字，skill 写合并后的完整技能，可以沿用其中一个名字）。合并时保留各自真正管用的部分（看 uses 的成败）。
- 常常同时满足条件抢着接手的（clashed_with）：调整优先级（priority：更管用、更要紧的高），或者收窄某个的触发条件（用 merge 重写它）。
- 明显没用、被别的技能完全覆盖的：收起（retire）。
- 没有要整理的就输出 {"ok":true}。不要为了整理而整理。
技能格式和写法与原来相同（when / steps 或 code / priority / cooldown_s / args）。
只输出一个 JSON 对象：{"merge":[{"from":["a","b"],"skill":{…}}],"priority":[{"name":"…","priority":1-90}],"retire":[{"name":"…","why":"…"}]} 或 {"ok":true}`;
    return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ skills }) }];
  }

  private async curate(): Promise<string> {
    const messages = this.messages();
    const names = new Set(this.active().map((b) => b.name));
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = await this.planner.complete(messages, { label: 'skill:整理', tier: 'full', signal: AbortSignal.timeout(10 * 60_000), attempt, maxTokensScale: 2 });
      let raw: Record<string, any>;
      try { raw = extractJson(c.text) as Record<string, any>; } catch (e) {
        this.planner.noteInvalid('整理技能', (e as Error).message);
        messages.push({ role: 'user', content: '刚才的回复不是合法 JSON，请只输出一个 JSON 对象。' });
        continue;
      }
      if (raw.ok === true && !raw.merge && !raw.retire && !raw.priority) return '不用整理';
      const done: string[] = [], errors: string[] = [];
      for (const m of Array.isArray(raw.merge) ? raw.merge.slice(0, 4) : []) {
        const from = (Array.isArray(m?.from) ? m.from : []).map(String).filter((n: string) => names.has(n));
        const w = this.engine.write(m?.skill);
        if (!w.ok) { errors.push(`合并 ${from.join('+')} 没存下：${w.error}`); continue; }
        for (const n of from) if (n !== w.name) this.engine.retire(n, `合并进 ${w.name}`);
        done.push(`${from.join('+')} → ${w.name}`);
        this.bus.publish('skill_merged', 'P2', `整理技能：${from.join('、')} 合并成「${w.name}」`, { from, into: w.name });
      }
      for (const p of Array.isArray(raw.priority) ? raw.priority.slice(0, 8) : []) {
        if (names.has(String(p?.name)) && Number.isFinite(Number(p?.priority)) && this.engine.setPriority(String(p.name), Number(p.priority))) done.push(`${p.name} 优先级 ${p.priority}`);
      }
      for (const r of Array.isArray(raw.retire) ? raw.retire.slice(0, 8) : []) {
        if (names.has(String(r?.name)) && this.engine.retire(String(r.name), String(r?.why ?? '整理时收起'))) done.push(`收起 ${r.name}`);
      }
      if (errors.length && !done.length && attempt === 0) { messages.push({ role: 'assistant', content: c.text.slice(0, 6000) }, { role: 'user', content: `${errors.join('；')}。改正后只输出 JSON。` }); continue; }
      return done.length ? done.join('；') : errors.join('；') || '没有可用的整理';
    }
    throw new Error('两次都没拿到能用的整理结果');
  }
}

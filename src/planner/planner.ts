import type { GameAdapter } from '../adapter/types.ts';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';
import type { JsonlWriter } from '../log.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { LlmProvider } from './llm.ts';
import { extractJson, ruleProposal, validatePlan, type Plan } from './plan.ts';
import { buildMessages, type PlanContext } from './prompt.ts';

export interface LlmStats {
  provider: string;
  calls: number;
  ok: number;
  errors: number;
  invalid: number;
  budgetFallbacks: number;
  latencies: number[];
  lastLatencyMs: number | null;
  lastError: string | null;
  inFlightSince: number | null;
  callsLastHour: number;
  maxCallsPerHour: number;
}

/**
 * LLM 规划器：只负责“提案”。
 * 输出必须通过 JSON 解析 + 技能白名单 + 参数校验；失败时把错误回传模型重试一次。
 */
export class Planner {
  private window: number[] = [];
  stats: LlmStats;

  constructor(
    private cfg: Config,
    private provider: LlmProvider,
    private adapter: GameAdapter,
    private memory: WorldMemory,
    private bus: EventBus,
    private writer: JsonlWriter | null,
  ) {
    this.stats = {
      provider: provider.name,
      calls: 0,
      ok: 0,
      errors: 0,
      invalid: 0,
      budgetFallbacks: 0,
      latencies: [],
      lastLatencyMs: null,
      lastError: null,
      inFlightSince: null,
      callsLastHour: 0,
      maxCallsPerHour: cfg.llm.maxCallsPerHour,
    };
  }

  private prune() {
    const cutoff = Date.now() - 3600_000;
    this.window = this.window.filter((t) => t > cutoff);
    this.stats.callsLastHour = this.window.length;
  }

  budgetOk() {
    this.prune();
    return this.window.length < this.cfg.llm.maxCallsPerHour;
  }

  rulePlan(ctx: PlanContext): Plan {
    const v = validatePlan(ruleProposal(ctx.percept, this.memory, ctx.reason === 'prefetch' ? ctx.current : null), this.adapter, 'rule');
    if (v.ok) {
      v.plan.reason = ctx.reason;
      v.plan.requestedAt = Date.now();
      return v.plan;
    }
    // 理论上不会发生；兜底为探索
    const fb = validatePlan({ goal: '随便走走', steps: [{ skill: 'wander' }] }, this.adapter, 'rule');
    if (fb.ok) return fb.plan;
    throw new Error(`rule plan invalid: ${v.error}`);
  }

  async propose(ctx: PlanContext): Promise<Plan> {
    if (!this.budgetOk()) {
      this.stats.budgetFallbacks++;
      this.bus.publish('llm_budget', 'P1', `LLM 每小时调用已达上限 ${this.cfg.llm.maxCallsPerHour}，改用规则目标`);
      return this.rulePlan(ctx);
    }
    const messages = buildMessages(this.cfg.persona, ctx, this.memory, this.cfg.vision?.hFov ?? 100);
    this.stats.inFlightSince = Date.now();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        this.window.push(Date.now());
        this.stats.calls++;
        const promptChars = messages.reduce((a, m) => a + m.content.length, 0);
        let text = '';
        let latencyMs = 0;
        let usage: unknown;
        let finishReason: string | undefined;
        try {
          const c = await this.provider.complete(messages, AbortSignal.timeout(this.cfg.llm.timeoutMs + this.cfg.llm.fakeDelayMs + 1000), ctx);
          ({ text, latencyMs, usage, finishReason } = c);
        } catch (e: any) {
          this.stats.errors++;
          this.stats.lastError = String(e?.message ?? e);
          this.writer?.write({ ts: Date.now(), reason: ctx.reason, provider: this.provider.name, ok: false, error: this.stats.lastError, promptChars });
          throw e;
        }
        this.stats.lastLatencyMs = latencyMs;
        this.stats.latencies.push(latencyMs);
        if (this.stats.latencies.length > 100) this.stats.latencies.shift();

        let error = '';
        const truncated = finishReason === 'length';
        try {
          const v = validatePlan(extractJson(text), this.adapter, 'llm');
          if (v.ok) {
            v.plan.reason = ctx.reason;
            v.plan.requestedAt = this.stats.inFlightSince ?? Date.now();
            this.stats.ok++;
            this.writer?.write({ ts: Date.now(), reason: ctx.reason, provider: this.provider.name, ok: true, latencyMs, usage, finishReason, promptChars, output: text.slice(0, 2000), attempt });
            return v.plan;
          }
          error = v.error;
        } catch (e: any) {
          error = truncated
            ? `输出被截断（finish_reason=length，已用 ${(usage as any)?.completion_tokens ?? '?'} tokens，可调大 LLM_MAX_TOKENS）`
            : text.trim() === ''
              ? '模型返回了空内容'
              : `JSON 解析失败：${e?.message ?? e}`;
        }
        this.stats.invalid++;
        this.stats.lastError = error;
        this.bus.publish('llm_invalid', 'P1', `模型输出无效（第 ${attempt + 1} 次）：${error}`);
        this.writer?.write({ ts: Date.now(), reason: ctx.reason, provider: this.provider.name, ok: false, invalid: true, error, latencyMs, usage, finishReason, output: text.slice(0, 2000), attempt });
        if (truncated || text.trim() === '') {
          // 截断或空内容：不回填半截输出，直接要求更短的回答
          messages.push({ role: 'user', content: '刚才的回复为空或被截断。请直接输出一个简短的 JSON 对象（thought 不超过 40 字，steps 不超过 3 步），不要输出其他内容。' });
        } else {
          messages.push({ role: 'assistant', content: text.slice(0, 2000) });
          messages.push({ role: 'user', content: `上一个输出无效：${error}。请只输出一个符合格式的 JSON 对象。` });
        }
      }
      throw new Error('INVALID_PLAN');
    } finally {
      this.stats.inFlightSince = null;
    }
  }
}

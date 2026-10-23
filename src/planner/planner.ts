import type { GameAdapter } from '../adapter/types.ts';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';
import type { JsonlWriter } from '../log.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { MemoryRecall } from '../memory/types.ts';
import { validateIntentDecision } from '../intentions/decision.ts';
import type { LlmProvider } from './llm.ts';
import { setImmediate } from 'node:timers/promises';
import { extractJson, ruleProposal, validatePlan, type Plan } from './plan.ts';
import { buildMessages, boundedJson, enforcePromptBudget, type PlanContext } from './prompt.ts';

export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 用量未返回或字段不完整的调用次数；累计值只包含已知用量。 */
  unreportedCalls: number;
}

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
  tokenUsage: LlmTokenUsage;
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
    private memoryRecall?: MemoryRecall,
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
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, unreportedCalls: 0 },
    };
  }

  /** 只在本次启动内累计，与每小时预算和最近调用列表的保留窗口无关。 */
  private recordUsage(usage: unknown) {
    const u = usage as Record<string, unknown> | null | undefined;
    const count = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
    const prompt = count(u?.prompt_tokens);
    const completion = count(u?.completion_tokens);
    const total = count(u?.total_tokens);
    const sum = this.stats.tokenUsage;
    sum.promptTokens += prompt ?? 0;
    sum.completionTokens += completion ?? 0;
    sum.totalTokens += total ?? ((prompt ?? 0) + (completion ?? 0));
    if (prompt == null || completion == null) sum.unreportedCalls++;
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

  get autonomous() { return this.cfg.llm.provider !== 'mock' && this.provider.name !== 'mock'; }

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

  async propose(ctx: PlanContext, signal?: AbortSignal): Promise<Plan> {
    signal?.throwIfAborted();
    if (!this.budgetOk()) {
      this.stats.budgetFallbacks++;
      this.bus.publish('llm_budget', 'P1', `LLM 每小时调用已达上限 ${this.cfg.llm.maxCallsPerHour}${this.autonomous ? '，保留意图并等待' : '，兼容模式使用规则目标'}`);
      if (this.autonomous) throw new Error('LLM_BUDGET_EXHAUSTED');
      return this.rulePlan(ctx);
    }
    const maxPrompt = Math.min(this.cfg.llm.maxPromptTokens ?? 128000,
      (this.cfg.llm.contextWindowTokens ?? 1000000) - Math.max(0, this.cfg.llm.maxTokens));
    // Each decision starts from current facts, never a growing chat transcript.
    // Historical retrieval runs only when the model asks for a relevant memory.
    ctx = { ...ctx, memoryAvailable: !!this.memoryRecall };
    await setImmediate(undefined, { signal });
    let messages;
    try {
      messages = buildMessages(this.cfg.persona, ctx, this.memory, this.cfg.vision?.hFov ?? 100, maxPrompt, this.cfg.llm.visionInput, {
        contextWindowTokens: this.cfg.llm.contextWindowTokens, compactAtRatio: this.cfg.llm.compactAtRatio, maxOutputTokens: this.cfg.llm.maxTokens,
      });
      await setImmediate(undefined, { signal });
    } catch (error) {
      if (!signal?.aborted) {
        this.stats.errors++;
        this.stats.lastError = String((error as Error)?.message ?? error);
      }
      throw error;
    }
    const recalled = new Map((ctx.memoryContext?.memories ?? []).map((entry) => [entry.id, entry]));
    const maxRecall = Math.max(0, Math.min(2, this.cfg.llm.maxRecallRounds ?? 2));
    let recalls = 0;
    let invalid = 0;
    this.stats.inFlightSince = Date.now();
    try {
      for (let attempt = 0; invalid < 2; attempt++) {
        signal?.throwIfAborted();
        if (!this.budgetOk()) throw new Error('LLM_BUDGET_EXHAUSTED');
        enforcePromptBudget(messages, maxPrompt);
        this.window.push(Date.now());
        this.stats.calls++;
        const promptChars = messages.reduce((a, m) => a + m.content.length, 0);
        let text = '';
        let latencyMs = 0;
        let usage: unknown;
        let finishReason: string | undefined;
        try {
          const timeout = AbortSignal.timeout(this.cfg.llm.timeoutMs + this.cfg.llm.fakeDelayMs + 1000);
          const c = await this.provider.complete(messages, signal ? AbortSignal.any([signal, timeout]) : timeout, ctx);
          ({ text, latencyMs, usage, finishReason } = c);
        } catch (e: any) {
          this.stats.tokenUsage.unreportedCalls++;
          this.stats.errors++;
          this.stats.lastError = String(e?.message ?? e);
          this.writer?.write({ ts: Date.now(), reason: ctx.reason, provider: this.provider.name, ok: false, error: this.stats.lastError, promptChars });
          throw e;
        }
        // 无效输出和重试同样消耗 token，在计划校验之前统计每次返回。
        this.recordUsage(usage);
        signal?.throwIfAborted();
        this.stats.lastLatencyMs = latencyMs;
        this.stats.latencies.push(latencyMs);
        if (this.stats.latencies.length > 100) this.stats.latencies.shift();

        let error = '';
        const truncated = finishReason === 'length';
        try {
          const raw = extractJson(text) as Record<string, any>;
          if (raw?.kind === 'recall') {
            if (recalls >= maxRecall) throw new Error('回想轮次已用完，请根据已知信息给出计划或暂缓');
            if (!ctx.worldState) throw new Error('当前会话没有可信世界范围，无法回想位置');
            recalls++;
            if (!this.memoryRecall) throw new Error('没有连接只读记忆服务，请根据已有信息决策');
            const records = Array.isArray(raw.ids) && raw.ids.length
              ? raw.ids.slice(0, 12).flatMap((id: unknown) => typeof id === 'string' && recalled.has(id) ? [recalled.get(id)!] : [])
              : (await this.memoryRecall.recall(ctx, String(raw.query ?? '').slice(0, 600))).memories;
            signal?.throwIfAborted();
            for (const record of records) if (recalled.size < 40 || recalled.has(record.id)) recalled.set(record.id, record);
            messages.push({ role: 'assistant', content: text.slice(0, 1200) });
            messages.push({ role: 'user', content: `只读记忆查询结果（历史记录，不代表当前事实）：${boundedJson(records, 4000)}。剩余回想轮数：${maxRecall - recalls}。` });
            this.writer?.write({ ts: Date.now(), reason: 'recall', provider: this.provider.name, ok: true, latencyMs, usage, promptChars, attempt });
            continue;
          }
          const v = validatePlan(raw, this.adapter, 'llm');
          if (v.ok) {
            if (this.autonomous) {
              const decision = validateIntentDecision(raw.decision, this.memory, this.adapter);
              if (!decision.ok) throw new Error(decision.error);
              v.plan.decision = decision.decision;
            }
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
              : `输出格式或协议校验失败：${e?.message ?? e}`;
        }
        this.stats.invalid++;
        invalid++;
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

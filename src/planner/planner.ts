import type { GameAdapter } from '../adapter/types.ts';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';
import type { JsonlWriter } from '../log.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { MemoryRecall } from '../memory/types.ts';
import { normalizeDecision, validateIntentDecision } from '../intentions/decision.ts';
import type { LlmProvider } from './llm.ts';
import { setImmediate } from 'node:timers/promises';
import { queryMechanics } from '../methods/mechanics.ts';
import type { LlmTrace } from './llm-trace.ts';
import type { RecipeBook } from '../methods/recipes.ts';
import { extractJson, ruleProposal, validatePlan, type Plan } from './plan.ts';
import { buildLightMessages, buildMessages, boundedJson, enforcePromptBudget, type PlanContext } from './prompt.ts';

export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 用量未返回或字段不完整的调用次数；累计值只包含已知用量。 */
  unreportedCalls: number;
  /** 输入中命中服务端前缀缓存的 token 数（DeepSeek: prompt_cache_hit_tokens；OpenAI: prompt_tokens_details.cached_tokens） */
  cachedPromptTokens?: number;
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
  /** 小决策 / 完整决策次数，以及小决策升级为完整决策的次数 */
  tiers: { light: number; full: number; escalated: number };
  /** 两级决策各自的累计耗时（用于对比平均延迟） */
  tierLatency: { light: { sum: number; n: number }; full: { sum: number; n: number } };
}

/**
 * LLM 规划器：只负责“提案”。
 * 输出必须通过 JSON 解析 + 技能白名单 + 参数校验；失败时把错误回传模型重试一次。
 */
export class Planner {
  private window: number[] = [];
  stats: LlmStats;
  /** 配方记忆（模型按需分级查询） */
  recipeBook?: RecipeBook;

  constructor(
    private cfg: Config,
    private provider: LlmProvider,
    private adapter: GameAdapter,
    private memory: WorldMemory,
    private bus: EventBus,
    private writer: JsonlWriter | null,
    private trace: LlmTrace | null = null,
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
      tiers: { light: 0, full: 0, escalated: 0 },
      tierLatency: { light: { sum: 0, n: 0 }, full: { sum: 0, n: 0 } },
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
    const cached = count(u?.prompt_cache_hit_tokens) ?? count((u?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
    if (cached != null) sum.cachedPromptTokens = (sum.cachedPromptTokens ?? 0) + cached;
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
    const full = () => buildMessages(this.cfg.persona, ctx, this.memory, this.cfg.vision?.hFov ?? 100, maxPrompt, this.cfg.llm.visionInput, {
      contextWindowTokens: this.cfg.llm.contextWindowTokens, compactAtRatio: this.cfg.llm.compactAtRatio, maxOutputTokens: this.cfg.llm.maxTokens,
    });
    let tier: 'light' | 'full' = ctx.tier === 'light' && this.autonomous ? 'light' : 'full';
    try {
      messages = tier === 'light' ? buildLightMessages(this.cfg.persona, ctx, this.memory) : full();
      this.stats.tiers[tier]++;
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
    let recipeQueries = 0;
    let mechanicsQueries = 0;
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
        const traceId = this.trace?.begin({ reason: tier === 'light' ? `${ctx.reason}·小决策` : ctx.reason, attempt, provider: this.provider.name }, messages) ?? '';
        const onDelta = this.trace ? (d: { content?: string; reasoning?: string }) => this.trace!.delta(traceId, d) : undefined;
        const requestedAt = Date.now();
        try {
          const timeout = AbortSignal.timeout(this.cfg.llm.timeoutMs + this.cfg.llm.fakeDelayMs + 1000);
          const c = await this.provider.complete(messages, signal ? AbortSignal.any([signal, timeout]) : timeout, ctx, onDelta);
          ({ text, latencyMs, usage, finishReason } = c);
        } catch (e: any) {
          this.stats.tokenUsage.unreportedCalls++;
          this.stats.errors++;
          this.stats.lastError = String(e?.message ?? e);
          const failedLatencyMs = Date.now() - requestedAt;
          this.trace?.end(traceId, { status: 'error', error: this.stats.lastError, latencyMs: failedLatencyMs });
          this.writer?.write({ ts: Date.now(), reason: ctx.reason, tier, provider: this.provider.name, ok: false, error: this.stats.lastError, latencyMs: failedLatencyMs, promptChars });
          throw e;
        }
        // 无效输出和重试同样消耗 token，在计划校验之前统计每次返回。
        this.recordUsage(usage);
        signal?.throwIfAborted();
        this.stats.lastLatencyMs = latencyMs;
        this.stats.tierLatency[tier].sum += latencyMs;
        this.stats.tierLatency[tier].n++;
        this.stats.latencies.push(latencyMs);
        if (this.stats.latencies.length > 100) this.stats.latencies.shift();

        let error = '';
        const truncated = finishReason === 'length';
        try {
          const raw = extractJson(text) as Record<string, any>;
          if (raw?.kind === 'need_full_context') {
            // 小决策里模型觉得需要改方向或更多背景：立刻改发完整请求（不算无效输出）
            if (tier !== 'light') throw new Error('已经是完整上下文，请直接给出计划');
            tier = 'full';
            // 让调用方知道最终是哪一档答的（执行层按档统计响应时间，决定提前多久开始想）
            ctx.tier = 'full';
            this.stats.tiers.escalated++;
            this.stats.tiers.full++;
            this.trace?.end(traceId, { status: 'ok', text, latencyMs, usage, finishReason });
            this.bus.publish('llm_escalate', 'P3', `小决策升级为完整决策：${String(raw.reason ?? '').slice(0, 80)}`);
            messages = full();
            continue;
          }
          if (raw?.kind === 'recipes') {
            // 配方是记忆的一部分：只读查询，不占游戏动作；先看类别，再看具体物品
            if (!this.recipeBook) throw new Error('当前没有配方记忆，请根据已知信息给出计划');
            if (recipeQueries >= 3) throw new Error('本次决策的配方查询已用完，请根据已知信息给出计划');
            recipeQueries++;
            const result = this.recipeBook.query(raw, ctx.percept.inventory);
            messages.push({ role: 'assistant', content: text.slice(0, 600) });
            messages.push({ role: 'user', content: `配方记忆查询结果（只含你已经知道的配方）：${JSON.stringify(result).slice(0, 4000)}。剩余配方查询：${3 - recipeQueries}。请继续：可以再查，或给出计划。` });
            this.trace?.end(traceId, { status: 'ok', text, latencyMs, usage, finishReason });
            this.writer?.write({ ts: Date.now(), reason: 'recipes', tier, provider: this.provider.name, ok: true, latencyMs, usage, promptChars, attempt, query: { category: raw.category, item: raw.item } });
            this.bus.publish('recipe_query', 'P3', `查配方：${raw.item ? `物品 ${raw.item}` : `类别 ${raw.category ?? '（列出类别）'}`}`);
            continue;
          }
          if (raw?.kind === 'mechanics') {
            if (mechanicsQueries >= 2) throw new Error('本次机制/动作接口查询已用完，请依据已知接口选择一个可验证的小尝试');
            mechanicsQueries++;
            const result = queryMechanics(String(raw.query ?? '').slice(0, 300), 6);
            // Novel combinations need deliberate reasoning, even when this
            // request began as the next routine step of an existing intention.
            if (tier === 'light') {
              tier = 'full'; ctx.tier = 'full';
              this.stats.tiers.escalated++; this.stats.tiers.full++;
              messages = full();
              this.bus.publish('llm_escalate', 'P3', '查询可用机制后，保留当前意图并思考新的组合方法');
            }
            messages.push({ role: 'assistant', content: text.slice(0, 600) });
            messages.push({ role: 'user', content: `可用动作接口（只读能力说明，不是现场事实，也没有替你选择玩法）：${JSON.stringify(result).slice(0, 6500)}。剩余查询 ${2 - mechanicsQueries} 次。请联系当前障碍、背包和预期效果，自选已有方法或用 experiment_method 提出一个有验收条件的有限组合试验；允许比较替代办法，不能把预计效果当成已经发生。` });
            this.trace?.end(traceId, { status: 'ok', text, latencyMs, usage, finishReason });
            this.writer?.write({ ts: Date.now(), reason: 'mechanics', tier, provider: this.provider.name, ok: true, latencyMs, usage, promptChars, query: raw.query });
            this.bus.publish('mechanics_query', 'P3', `查询可组合的动作机制：${String(raw.query ?? '通用操作').slice(0, 100)}`);
            continue;
          }
          if (tier === 'light' && Array.isArray(raw.steps) && raw.steps.some((step: any) => step?.skill === 'experiment_method' || String(step?.skill ?? '').startsWith('trial:'))) {
            tier = 'full'; ctx.tier = 'full';
            this.stats.tiers.escalated++; this.stats.tiers.full++;
            messages = full();
            messages.push({ role: 'assistant', content: text.slice(0, 6000) });
            messages.push({ role: 'user', content: '你提出了候选机制试验，尚未执行。请先基于完整当前事实核对假设、可用动作、材料与可观测验收条件，再给出最终有限试验计划或修订选择；保留原意图，不把候选或预计产出当成已掌握的事实。' });
            this.trace?.end(traceId, { status: 'ok', text, latencyMs, usage, finishReason });
            this.bus.publish('llm_escalate', 'P3', '候选机制试验在执行前转入完整推理');
            continue;
          }
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
            this.trace?.end(traceId, { status: 'ok', text, latencyMs, usage, finishReason });
            this.writer?.write({ ts: Date.now(), reason: 'recall', tier, provider: this.provider.name, ok: true, latencyMs, usage, promptChars, attempt });
            continue;
          }
          const v = validatePlan(raw, this.adapter, 'llm');
          if (v.ok) {
            if (this.autonomous) {
              // 意图记账是辅助信息：能纠正的就地纠正；项目条件不合法就只丢掉项目，不让整轮决策作废
              const { decision: normalized, notes } = normalizeDecision(raw.decision, raw, this.memory);
              let decision = validateIntentDecision(normalized, this.memory, this.adapter);
              if (!decision.ok && normalized.project !== undefined) {
                notes.push(`项目定义无效（${decision.error}），本轮只执行计划不建项目`);
                const { project: _drop, ...rest } = normalized;
                decision = validateIntentDecision(rest, this.memory, this.adapter);
              }
              if (!decision.ok && normalized.preferences !== undefined) {
                notes.push(`偏好记录无效（${decision.error}），已忽略`);
                const { preferences: _drop, project: _p, ...rest } = normalized;
                decision = validateIntentDecision(rest, this.memory, this.adapter);
              }
              if (!decision.ok) throw new Error(decision.error);
              // 小决策本来就不写 decision（默认接着当前意图），这不是格式错误，不用报
              const real = ctx.tier === 'light' ? notes.filter((n) => !/未给出 decision/.test(n)) : notes;
              if (real.length) this.bus.publish('decision_normalized', 'P3', `已纠正决策格式：${real.join('；')}`);
              v.plan.decision = decision.decision;
            }
            v.plan.reason = ctx.reason;
            v.plan.requestedAt = this.stats.inFlightSince ?? Date.now();
            this.stats.ok++;
            this.trace?.end(traceId, { status: 'ok', text, latencyMs, usage, finishReason });
            this.writer?.write({ ts: Date.now(), reason: ctx.reason, tier, provider: this.provider.name, ok: true, latencyMs, usage, finishReason, promptChars, output: text.slice(0, 2000), attempt });
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
        this.trace?.end(traceId, { status: 'invalid', text, latencyMs, usage, finishReason, error });
        this.bus.publish('llm_invalid', 'P1', `模型输出无效（第 ${attempt + 1} 次）：${error}`);
        this.writer?.write({ ts: Date.now(), reason: ctx.reason, tier, provider: this.provider.name, ok: false, invalid: true, error, latencyMs, usage, finishReason, output: text.slice(0, 2000), attempt });
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

import type { GameAdapter } from '../adapter/types.ts';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';
import type { JsonlWriter } from '../log.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { MemoryRecall } from '../memory/types.ts';
import type { ChatMessage, LlmProvider } from './llm.ts';
import { ControlKnowledge } from '../methods/controls.ts';
import type { LlmTrace } from './llm-trace.ts';
import type { RecipeBook } from '../methods/recipes.ts';
import { enforcePromptBudget } from './prompt.ts';

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
    private controls = new ControlKnowledge(null),
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

  /**
   * 一次通用的模型调用（心智层使用）：共享每小时预算、调用统计、JSONL 日志和控制台的 LLM 调用面板。
   * 只负责把文字拿回来；解析、校验和重试由调用方决定。
   */
  async complete(messages: ChatMessage[], opts: { label: string; tier?: 'light' | 'full'; signal?: AbortSignal; attempt?: number; maxTokensScale?: number }): Promise<{ text: string; latencyMs: number; finishReason?: string }> {
    const signal = opts.signal;
    signal?.throwIfAborted();
    if (!this.budgetOk()) {
      this.stats.budgetFallbacks++;
      this.bus.publish('llm_budget', 'P1', `LLM 每小时调用已达上限 ${this.cfg.llm.maxCallsPerHour}，先凭习惯继续玩`);
      throw new Error('LLM_BUDGET_EXHAUSTED');
    }
    const maxPrompt = Math.min(this.cfg.llm.maxPromptTokens ?? 128000,
      (this.cfg.llm.contextWindowTokens ?? 1000000) - Math.max(0, this.cfg.llm.maxTokens));
    enforcePromptBudget(messages, maxPrompt);
    const tier = opts.tier ?? 'full';
    this.window.push(Date.now());
    this.stats.calls++;
    this.stats.tiers[tier]++;
    const promptChars = messages.reduce((a, m) => a + m.content.length, 0);
    const traceId = this.trace?.begin({ reason: opts.label, attempt: opts.attempt ?? 0, provider: this.provider.name }, messages) ?? '';
    const onDelta = this.trace ? (d: { content?: string; reasoning?: string }) => this.trace!.delta(traceId, d) : undefined;
    const requestedAt = Date.now();
    this.stats.inFlightSince = requestedAt;
    try {
      const scale = opts.maxTokensScale && opts.maxTokensScale > 1 ? Math.min(8, opts.maxTokensScale) : 1;
      const timeout = AbortSignal.timeout(this.cfg.llm.timeoutMs * scale + this.cfg.llm.fakeDelayMs + 1000);
      const c = await this.provider.complete(messages, signal ? AbortSignal.any([signal, timeout]) : timeout, { tier, ...(scale > 1 ? { maxTokensScale: scale } : {}) }, onDelta);
      this.recordUsage(c.usage);
      this.stats.lastLatencyMs = c.latencyMs;
      this.stats.tierLatency[tier].sum += c.latencyMs;
      this.stats.tierLatency[tier].n++;
      this.stats.latencies.push(c.latencyMs);
      if (this.stats.latencies.length > 100) this.stats.latencies.shift();
      this.trace?.end(traceId, { status: 'ok', text: c.text, latencyMs: c.latencyMs, usage: c.usage, finishReason: c.finishReason });
      this.writer?.write({ ts: Date.now(), reason: opts.label, tier, provider: this.provider.name, ok: true, latencyMs: c.latencyMs, usage: c.usage, finishReason: c.finishReason, promptChars, output: c.text.slice(0, 2000) });
      return { text: c.text, latencyMs: c.latencyMs, finishReason: c.finishReason };
    } catch (e: any) {
      if (!signal?.aborted) {
        this.stats.tokenUsage.unreportedCalls++;
        this.stats.errors++;
        this.stats.lastError = String(e?.message ?? e);
      }
      this.trace?.end(traceId, { status: 'error', error: String(e?.message ?? e), latencyMs: Date.now() - requestedAt });
      this.writer?.write({ ts: Date.now(), reason: opts.label, tier, provider: this.provider.name, ok: false, error: String(e?.message ?? e), latencyMs: Date.now() - requestedAt, promptChars });
      throw e;
    } finally {
      this.stats.inFlightSince = null;
    }
  }

  /** 心智层的输出没通过校验：计入无效输出统计 */
  noteInvalid(label: string, error: string) {
    this.stats.invalid++;
    this.stats.lastError = error;
    this.bus.publish('llm_invalid', 'P1', `模型输出无效（${label}）：${error}`);
  }

  /** 心智层的只读查询需要的记忆接口 */
  get recall(): MemoryRecall | undefined { return this.memoryRecall; }
  get controlKnowledge(): ControlKnowledge { return this.controls; }
}

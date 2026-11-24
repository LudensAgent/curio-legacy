import type { Planner } from '../planner/planner.ts';
import { costOf, isPeak, priceFor } from '../planner/pricing.ts';

/**
 * 观察者 HUD 与控制台用的 LLM 用量：上传（输入）/ 下载（输出）token、缓存命中、最近一分钟的速率、在用的模型和真实花费。
 *
 * 花费 = 每次调用当时按价格表（含 DeepSeek 高峰价）算好的累计值；升级前就存在 run-stats 里的用量没有逐次价格，
 * 按闲时价补估（只差在高峰时段那部分会少算一点）。认不出价格的模型不算钱，全都认不出时 cost 为 null。
 * 这里只算游戏（规划器）的用量；Hindsight 记忆服务的用量由下面的 MemorySpend 单独算，再用 withMemory 合并。
 */
export interface LlmSpend {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  inputRate: number;
  outputRate: number;
  cost: number | null;
  currency: string | null;
  peak: boolean | null;
  model: string;
}

export function llmSpend(planners: readonly (Planner | null | undefined)[], opts: { holidays?: readonly string[]; now?: number } = {}): LlmSpend {
  const now = opts.now ?? Date.now();
  const unique = [...new Set(planners.filter((p): p is Planner => !!p))];
  let input = 0, output = 0, cached = 0, cachedKnown = false, inRate = 0, outRate = 0;
  let cost = 0, priced = false, peakRule = false;
  const currencies = new Set<string>();
  for (const p of unique) {
    const u = p.stats.tokenUsage;
    input += u.promptTokens;
    output += u.completionTokens;
    if (u.cachedPromptTokens != null) { cached += u.cachedPromptTokens; cachedKnown = true; }
    const rate = p.usageRate(now);
    inRate += rate.input;
    outRate += rate.output;
    if (!p.price) continue;
    priced = true;
    currencies.add(p.price.currency);
    if (p.price.peak) peakRule = true;
    cost += u.cost ?? 0;
    // 升级前的累计用量：按闲时价补估
    const restPrompt = Math.max(0, u.promptTokens - (u.costedPromptTokens ?? 0));
    const restCached = Math.min(restPrompt, Math.max(0, (u.cachedPromptTokens ?? 0) - (u.costedCachedTokens ?? 0)));
    const restCompletion = Math.max(0, u.completionTokens - (u.costedCompletionTokens ?? 0));
    if (restPrompt || restCompletion) cost += costOf({ promptTokens: restPrompt, cachedPromptTokens: restCached, completionTokens: restCompletion }, p.price, false);
  }
  // 主心智在前；写代码的模型不一样时接在后面
  const model = [...new Set(unique.map((p) => p.model).filter(Boolean))].join(' + ').slice(0, 64);
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cachedKnown ? cached : null,
    inputRate: inRate,
    outputRate: outRate,
    cost: priced && currencies.size === 1 ? cost : null,
    currency: priced && currencies.size === 1 ? [...currencies][0] : null,
    peak: peakRule ? isPeak(now, opts.holidays ?? []) : null,
    model,
  };
}

/**
 * 记忆服务（Hindsight）自己调 LLM 的用量：结构上只要一个 snapshot()，不依赖具体实现。
 * output 是“看得见的输出”，推理 token 单独在 thoughts 里，计费时两者都算输出。
 */
export interface MemoryUsageSource {
  snapshot(): { total: { input: number; cached: number; output: number; thoughts: number }; models: readonly string[] };
}

export interface MemorySpendSample {
  memoryInputTokens: number;
  memoryOutputTokens: number;
  memoryCachedInputTokens: number;
  memoryCost: number | null;
  memoryModel: string | null;
  currency: string | null;
  /** 价格有高峰规则 */
  peakRule: boolean;
}

/**
 * 记忆用量是定时读回来的累计数，所以花费按“这次比上次多了多少 × 读到时的价格”逐段累加（高峰价按读到时算）。
 * 刚启动时已有的累计（上次运行留下的）没有逐段时间，按闲时价补估一次。
 */
export class MemorySpend {
  private last: { input: number; cached: number; output: number } | null = null;
  private cost = 0;
  private model: string | null = null;

  constructor(private source: MemoryUsageSource, private opts: { price?: string; holidays?: readonly string[] } = {}) {}

  sample(now = Date.now()): MemorySpendSample {
    const snap = this.source.snapshot();
    const t = { input: snap.total.input, cached: snap.total.cached, output: snap.total.output + snap.total.thoughts };
    this.model = snap.models.at(-1) ?? this.model;
    const price = this.model ? priceFor(this.model, this.opts.price) : this.opts.price ? priceFor('', this.opts.price) : null;
    if (price) {
      const first = this.last === null;
      const d = first ? t : { input: t.input - this.last!.input, cached: t.cached - this.last!.cached, output: t.output - this.last!.output };
      // 计数器只增不减；变小说明读回了别的存档，从现在重新对齐
      if (d.input >= 0 && d.output >= 0 && (d.input || d.output)) {
        this.cost += costOf({ promptTokens: d.input, cachedPromptTokens: Math.max(0, Math.min(d.input, d.cached)), completionTokens: d.output },
          price, !first && isPeak(now, this.opts.holidays ?? []));
      }
      this.last = t;
    }
    return {
      memoryInputTokens: t.input, memoryOutputTokens: t.output, memoryCachedInputTokens: t.cached,
      memoryCost: price ? this.cost : null, memoryModel: this.model, currency: price?.currency ?? null, peakRule: !!price?.peak,
    };
  }
}

/** 游戏 + 记忆：cost 是合计，memoryCost 是其中记忆那部分；币种不一致时不合计 */
export type CombinedSpend = LlmSpend & Partial<Omit<MemorySpendSample, 'peakRule' | 'currency'>>;

export function withMemory(game: LlmSpend, memory: MemorySpendSample | null | undefined, now = Date.now(), holidays: readonly string[] = []): CombinedSpend {
  if (!memory) return game;
  const { peakRule, currency, ...fields } = memory;
  const sameCurrency = !game.currency || !currency || game.currency === currency;
  const cost = !sameCurrency ? null : game.cost == null && memory.memoryCost == null ? null : (game.cost ?? 0) + (memory.memoryCost ?? 0);
  return {
    ...game, ...fields,
    cost,
    currency: game.currency ?? currency,
    peak: game.peak ?? (peakRule ? isPeak(now, holidays) : null),
  };
}

import type { Planner } from '../planner/planner.ts';
import { costOf, isPeak } from '../planner/pricing.ts';

/**
 * 直播 HUD 用的 LLM 用量：上传（输入）/ 下载（输出）token、缓存命中、最近一分钟的速率、在用的模型和真实花费。
 *
 * 花费 = 每次调用当时按价格表（含 DeepSeek 高峰价）算好的累计值；升级前就存在 run-stats 里的用量没有逐次价格，
 * 按闲时价补估（只差在高峰时段那部分会少算一点）。认不出价格的模型不算钱，全都认不出时 cost 为 null。
 * 不含 Hindsight 记忆服务和直播侧边聊天自己调的 LLM（它们不经过这里的规划器）。
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

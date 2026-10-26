/**
 * 模型价格：把每次调用返回的用量换算成真实花费（直播 HUD 和控制台显示用）。
 *
 * - 输入分“缓存命中”和“未命中”两档，输出单独一档（推理 token 已经算在输出里）。
 * - DeepSeek 有高峰价：北京时间周一到周五 9:00–12:00、14:00–18:00 价格翻倍，其余时间（含周末、法定节假日）为闲时价。
 *   法定节假日没法自动判断，用 LLM_PRICE_HOLIDAYS=2026-10-01,2026-10-02 这样列出来按闲时价算。
 * - 内置表只认得 DeepSeek 当前在售的模型；别的模型用 LLM_PRICE / CODER_LLM_PRICE 写价格（每百万 token：命中,未命中,输出[,币种]），
 *   写了就以它为准、不再套高峰规则。认不出、也没写价格的模型不算钱（HUD 显示“—”），绝不瞎估。
 * 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing （2026-10，单位 元/百万 tokens，闲时价）
 */

export interface ModelPrice {
  /** 每百万 token 的价格 */
  hit: number;
  miss: number;
  output: number;
  currency: string;
  /** 高峰时段乘数（null = 没有高峰价） */
  peak: { multiplier: number } | null;
}

const DEEPSEEK_PEAK = { multiplier: 2 };
const BUILTIN: [RegExp, Omit<ModelPrice, 'currency'>][] = [
  // 旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 已下线，请求由 V4.1-Flash 处理、按 Flash 计费
  [/^deepseek-(v4(\.1)?-)?flash(-vision-exp)?$/i, { hit: 0.02, miss: 1, output: 4, peak: DEEPSEEK_PEAK }],
  [/^deepseek-v4-pro$/i, { hit: 0.15, miss: 4.5, output: 13.5, peak: DEEPSEEK_PEAK }],
];

/** "命中,未命中,输出[,币种]"，例如 "0.02,1,4" 或 "0.5,2,8,USD" */
export function parsePriceOverride(raw: string | undefined): ModelPrice | null {
  if (!raw?.trim()) return null;
  const parts = raw.split(/[,，\s]+/).filter(Boolean);
  const [hit, miss, output] = parts.slice(0, 3).map(Number);
  if (![hit, miss, output].every((n) => Number.isFinite(n) && n >= 0)) return null;
  const currency = parts[3] && /^[A-Za-z]{3}$/.test(parts[3]) ? parts[3].toUpperCase() : 'CNY';
  return { hit, miss, output, currency, peak: null };
}

export function priceFor(model: string, override?: string): ModelPrice | null {
  const custom = parsePriceOverride(override);
  if (custom) return custom;
  const hit = BUILTIN.find(([re]) => re.test(model.trim()));
  return hit ? { ...hit[1], currency: 'CNY' } : null;
}

/** 北京时间的日期和钟点（不依赖机器时区） */
function beijing(now: number) {
  const d = new Date(now + 8 * 3600_000);
  return { day: d.getUTCDay(), hour: d.getUTCHours() + d.getUTCMinutes() / 60, date: d.toISOString().slice(0, 10) };
}

/** 现在是不是 DeepSeek 的高峰时段 */
export function isPeak(now = Date.now(), holidays: readonly string[] = []): boolean {
  const t = beijing(now);
  if (t.day === 0 || t.day === 6 || holidays.includes(t.date)) return false;
  return (t.hour >= 9 && t.hour < 12) || (t.hour >= 14 && t.hour < 18);
}

export interface UsageForCost { promptTokens: number; cachedPromptTokens?: number; completionTokens: number }

/** 一次（或一批）调用的花费；cached 不知道时全按未命中算（宁可高估，不会少算） */
export function costOf(usage: UsageForCost, price: ModelPrice, peak: boolean): number {
  const cached = Math.min(usage.promptTokens, Math.max(0, usage.cachedPromptTokens ?? 0));
  const base = (cached * price.hit + (usage.promptTokens - cached) * price.miss + usage.completionTokens * price.output) / 1e6;
  return base * (peak && price.peak ? price.peak.multiplier : 1);
}

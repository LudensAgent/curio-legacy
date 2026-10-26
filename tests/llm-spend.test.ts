import assert from 'node:assert/strict';
import test from 'node:test';
import { costOf, isPeak, parsePriceOverride, priceFor } from '../src/planner/pricing.ts';
import { llmSpend } from '../src/observer/llm-spend.ts';
import type { Planner } from '../src/planner/planner.ts';

// 2026-10-26 是周一；北京时间 = UTC+8
const at = (iso: string) => Date.parse(iso);

test('DeepSeek peak hours: weekdays 9-12 and 14-18 Beijing time, holidays and weekends are off-peak', () => {
  assert.equal(isPeak(at('2026-10-26T06:30:00Z')), true, '周一 14:30');
  assert.equal(isPeak(at('2026-10-26T04:30:00Z')), false, '周一 12:30 午休');
  assert.equal(isPeak(at('2026-10-26T01:00:00Z')), true, '周一 9:00');
  assert.equal(isPeak(at('2026-10-26T10:00:00Z')), false, '周一 18:00');
  assert.equal(isPeak(at('2026-10-25T06:30:00Z')), false, '周日');
  assert.equal(isPeak(at('2026-10-26T06:30:00Z'), ['2026-10-26']), false, '节假日');
});

test('prices: built-in DeepSeek models, overrides and unknown models', () => {
  const flash = priceFor('deepseek-flash')!;
  assert.deepEqual([flash.hit, flash.miss, flash.output, flash.currency], [0.02, 1, 4, 'CNY']);
  assert.equal(priceFor('deepseek-v4-flash')!.miss, 1, '旧名按 Flash 计费');
  assert.equal(priceFor('deepseek-v4-pro')!.output, 13.5);
  assert.equal(priceFor('gpt-4o-mini'), null);
  assert.deepEqual(parsePriceOverride('0.5, 2, 8, usd'), { hit: 0.5, miss: 2, output: 8, currency: 'USD', peak: null });
  assert.equal(parsePriceOverride('abc'), null);
  assert.equal(priceFor('deepseek-flash', '1,1,1')!.peak, null, '写了价格就不再套高峰规则');
  // 100 万命中 + 100 万未命中 + 100 万输出 = 0.02 + 1 + 4
  const usage = { promptTokens: 2_000_000, cachedPromptTokens: 1_000_000, completionTokens: 1_000_000 };
  assert.equal(costOf(usage, flash, false).toFixed(4), '5.0200');
  assert.equal(costOf(usage, flash, true).toFixed(4), '10.0400');
});

function fakePlanner(model: string, tokenUsage: Record<string, number>, rate = { input: 0, output: 0 }) {
  return { model, price: priceFor(model), stats: { tokenUsage: { unreportedCalls: 0, totalTokens: 0, ...tokenUsage } }, usageRate: () => rate } as unknown as Planner;
}

test('spend sums planners, backfills pre-upgrade usage at off-peak price and names the models', () => {
  const main = fakePlanner('deepseek-flash', { promptTokens: 3_000_000, completionTokens: 1_000_000, cachedPromptTokens: 2_000_000,
    cost: 1, costedPromptTokens: 1_000_000, costedCachedTokens: 0, costedCompletionTokens: 0 }, { input: 1200, output: 300 });
  const coder = fakePlanner('deepseek-v4-pro', { promptTokens: 0, completionTokens: 0 });
  const s = llmSpend([main, coder, main], { now: at('2026-10-25T06:30:00Z') });
  assert.equal(s.inputTokens, 3_000_000);
  assert.equal(s.outputTokens, 1_000_000);
  assert.equal(s.cachedInputTokens, 2_000_000);
  assert.equal(s.inputRate, 1200);
  // 已算 1 元 + 补估：200 万命中 0.04 + 0 未命中 + 100 万输出 4
  assert.equal(s.cost!.toFixed(4), '5.0400');
  assert.equal(s.currency, 'CNY');
  assert.equal(s.peak, false);
  assert.equal(s.model, 'deepseek-flash + deepseek-v4-pro');
  assert.equal(llmSpend([fakePlanner('gpt-4o', { promptTokens: 5, completionTokens: 5 })]).cost, null, '认不出价格就不算钱');
});

test('memory spend accrues per sample at the current price and merges with game spend', async () => {
  const { MemorySpend, withMemory } = await import('../src/observer/llm-spend.ts');
  let total = { input: 2_000_000, cached: 1_000_000, output: 500_000, thoughts: 500_000 };
  const meter = new MemorySpend({ snapshot: () => ({ total, models: ['deepseek-flash'] }) });
  const weekend = at('2026-10-25T06:30:00Z'), peak = at('2026-10-26T06:30:00Z');
  // 启动时已有的累计按闲时价：100 万命中 0.02 + 100 万未命中 1 + 100 万输出 4
  assert.equal(meter.sample(peak).memoryCost!.toFixed(4), '5.0200');
  total = { input: 3_000_000, cached: 1_000_000, output: 1_000_000, thoughts: 500_000 };
  // 新增 100 万未命中 + 50 万输出，高峰价 ×2：(1 + 2) × 2 = 6
  const s = meter.sample(peak);
  assert.equal(s.memoryCost!.toFixed(4), '11.0200');
  assert.equal(s.memoryOutputTokens, 1_500_000);
  assert.equal(s.memoryModel, 'deepseek-flash');
  const game = llmSpend([fakePlanner('deepseek-flash', { promptTokens: 1, completionTokens: 0, cost: 1, costedPromptTokens: 1, costedCachedTokens: 0, costedCompletionTokens: 0 })], { now: weekend });
  const merged = withMemory(game, s, weekend);
  assert.equal(merged.cost!.toFixed(4), '12.0200');
  assert.equal(merged.memoryCost!.toFixed(4), '11.0200');
  assert.equal(merged.inputTokens, 1, 'game traffic stays separate');
  assert.equal(merged.memoryInputTokens, 3_000_000);
  assert.equal(withMemory(game, null), game);
});

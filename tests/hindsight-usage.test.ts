import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { absorb, HindsightUsage, parseHindsightMetrics, type HindsightUsageState } from '../src/memory/hindsight-usage.ts';
import { RunStats } from '../src/observer/run-stats.ts';

const metrics = (n: { in: number; cached: number; out: number; th: number; calls: number; consIn?: number; failed?: number }) => `
# HELP hindsight_llm_tokens_input_tokens_total Number of input tokens for LLM calls
# TYPE hindsight_llm_tokens_input_tokens_total counter
hindsight_llm_tokens_input_tokens_total{model="deepseek-flash",provider="openai",scope="memory",success="true",token_bucket="5k-10k"} ${n.in}
hindsight_llm_tokens_input_tokens_total{model="deepseek-flash",provider="openai",scope="consolidation",success="true",token_bucket="10k-50k"} ${n.consIn ?? 0}
hindsight_llm_tokens_cached_input_tokens_total{model="deepseek-flash",provider="openai",scope="memory",success="true",token_bucket="1k-5k"} ${n.cached}
hindsight_llm_tokens_output_tokens_total{model="deepseek-flash",provider="openai",scope="memory",success="true",token_bucket="500-1k"} ${n.out}
hindsight_llm_tokens_thoughts_tokens_total{model="deepseek-flash",provider="openai",scope="memory",success="true",token_bucket="1k-5k"} ${n.th}
hindsight_llm_calls_total_calls_total{model="deepseek-flash",provider="openai",scope="memory",success="true"} ${n.calls}
hindsight_llm_calls_total_calls_total{model="deepseek-flash",provider="openai",scope="memory",success="false"} ${n.failed ?? 0}
hindsight_llm_duration_seconds_bucket{le="1.0",scope="memory"} 3
hindsight_operation_duration_seconds_count{operation="retain"} 9
`;

const fresh = (): HindsightUsageState => ({ byScope: {}, lastRaw: {}, baseline: null, models: [] });

test('parses token and call counters with their scope, ignores other metrics', () => {
  const s = parseHindsightMetrics(metrics({ in: 1000, cached: 400, out: 50, th: 300, calls: 2, failed: 1 }));
  assert.deepEqual(s.map((x) => [x.field, x.scope, x.success, x.value]), [
    ['input', 'memory', true, 1000], ['input', 'consolidation', true, 0], ['cached', 'memory', true, 400],
    ['output', 'memory', true, 50], ['thoughts', 'memory', true, 300], ['calls', 'memory', true, 2], ['calls', 'memory', false, 1],
  ]);
});

test('first reading only sets a baseline; later readings add the difference', () => {
  const st = fresh();
  assert.equal(absorb(st, parseHindsightMetrics(metrics({ in: 1000, cached: 400, out: 50, th: 300, calls: 2 })), 1), 0);
  assert.deepEqual(st.baseline, { at: 1, tokens: 1750 });
  assert.deepEqual(st.byScope, {});
  const added = absorb(st, parseHindsightMetrics(metrics({ in: 3000, cached: 1400, out: 150, th: 900, calls: 5, consIn: 2000, failed: 1 })));
  assert.equal(added, 2000 + 100 + 600 + 2000);
  assert.deepEqual(st.byScope.memory, { calls: 4, failed: 1, input: 2000, cached: 1000, output: 100, thoughts: 600 });
  assert.equal(st.byScope.consolidation.input, 2000);
  assert.deepEqual(st.models, ['deepseek-flash']);
});

test('a container restart (counter went down) counts the new value whole', () => {
  const st = fresh();
  absorb(st, parseHindsightMetrics(metrics({ in: 5000, cached: 0, out: 100, th: 0, calls: 3 })));
  absorb(st, parseHindsightMetrics(metrics({ in: 800, cached: 0, out: 20, th: 0, calls: 1 })));
  assert.equal(st.byScope.memory.input, 800);
  assert.equal(st.byScope.memory.calls, 1);
});

test('totals survive a Curio restart through run-stats.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-usage-'));
  const file = path.join(dir, 'run-stats.json');
  let body = metrics({ in: 1000, cached: 0, out: 10, th: 0, calls: 1 });
  const fakeFetch = (async () => new Response(body)) as unknown as typeof fetch;
  const metricsStub = { counters: {}, distance: 0, startedAt: Date.now() } as any;
  const planner = { stats: { calls: 0, ok: 0, errors: 0, invalid: 0, budgetFallbacks: 0, tokenUsage: { totalTokens: 100 }, tiers: {}, tierLatency: {} } } as any;

  const a = new HindsightUsage({ baseUrl: 'http://x', fetch: fakeFetch });
  const rsA = new RunStats(file, metricsStub, { main: planner }, { memoryLlm: a });
  await a.poll();
  body = metrics({ in: 4000, cached: 0, out: 40, th: 0, calls: 4 });
  await a.poll();
  assert.equal(a.totalTokens(), 3030);
  assert.equal(rsA.totalTokens(), 3130);
  rsA.save();

  // 重启：容器还在跑，计数器继续涨
  body = metrics({ in: 6000, cached: 0, out: 60, th: 0, calls: 6 });
  const b = new HindsightUsage({ baseUrl: 'http://x', fetch: fakeFetch });
  new RunStats(file, { counters: {}, distance: 0, startedAt: Date.now() } as any, { main: null }, { memoryLlm: b });
  await b.poll();
  assert.equal(b.totalTokens(), 3030 + 2020);
  assert.equal(b.snapshot().total.calls, 5);
  assert.equal(b.snapshot().baseline?.tokens, 1010);
});

test('an unreachable service is reported, not thrown', async () => {
  const u = new HindsightUsage({ baseUrl: 'http://x', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
  await u.poll();
  const s = u.snapshot();
  assert.equal(s.ok, false);
  assert.match(s.error ?? '', /ECONNREFUSED/);
  assert.equal(s.total.tokens, 0);
});

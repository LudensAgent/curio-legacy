/**
 * Hindsight 记忆服务自己调 LLM（抽取事实、整理观察、反思）花掉的 token。
 *
 * 这些调用不经过 Curio，本地日志里没有；Hindsight 在 /metrics（Prometheus 文本）里按用途记了累计数：
 *   hindsight_llm_tokens_input / _output / _cached_input / _thoughts、hindsight_llm_calls_total
 *   标签 scope = memory（写入时抽取事实）| consolidation（合并观察）| reflect | answer，success = true|false
 * 这里定时读一次，按“比上次多了多少”累加进本次测试的总数（存进 run-stats.json，重启 Curio 不清零）。
 *
 * - 容器重启后计数器从 0 开始：某条序列比上次小，就把现在的值整个当增量。
 * - 本次测试第一次读到时，容器里已经有的数不算进来（不知道是不是这次测试的），只记成 baseline 给人看。
 * - output 只是“看得见的输出”，推理 token 单独在 thoughts 里；计费的输出 = output + thoughts。
 */

export interface UsageBucket { calls: number; failed: number; input: number; cached: number; output: number; thoughts: number }
export interface HindsightUsageState {
  /** 本次测试累计（按 scope） */
  byScope: Record<string, UsageBucket>;
  /** 每条 Prometheus 序列上次读到的原始值 */
  lastRaw: Record<string, number>;
  /** 第一次接上时容器里已经有的 token（没算进 byScope） */
  baseline: { at: number; tokens: number } | null;
  /** 最近见到的模型（标签 model） */
  models: string[];
}
export interface HindsightUsageSnapshot {
  enabled: true;
  ok: boolean;
  error: string | null;
  lastPollAt: number | null;
  total: UsageBucket & { tokens: number };
  byScope: Record<string, UsageBucket>;
  models: string[];
  baseline: { at: number; tokens: number } | null;
}

type Field = keyof Omit<UsageBucket, 'failed'>;
const METRICS: [RegExp, Field][] = [
  [/^hindsight_llm_tokens_cached_input(?:_[a-z]+)*_total$/, 'cached'],
  [/^hindsight_llm_tokens_thoughts(?:_[a-z]+)*_total$/, 'thoughts'],
  [/^hindsight_llm_tokens_input(?:_[a-z]+)*_total$/, 'input'],
  [/^hindsight_llm_tokens_output(?:_[a-z]+)*_total$/, 'output'],
  [/^hindsight_llm_calls(?:_[a-z]+)*_total$/, 'calls'],
];

export interface MetricSample { field: Field; key: string; scope: string; success: boolean; model: string | null; value: number }

/** 解析 Prometheus 文本里和 LLM 用量有关的行 */
export function parseHindsightMetrics(text: string): MetricSample[] {
  const out: MetricSample[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/);
    if (!m) continue;
    const field = METRICS.find(([re]) => re.test(m[1]))?.[1];
    if (!field) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value) || value < 0) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? '').slice(1, -1).matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2];
    out.push({ field, key: `${m[1]}${m[2] ?? ''}`, scope: labels.scope || 'other', success: labels.success !== 'false', model: labels.model || null, value });
  }
  return out;
}

const empty = (): UsageBucket => ({ calls: 0, failed: 0, input: 0, cached: 0, output: 0, thoughts: 0 });
export const bucketTokens = (b: UsageBucket) => b.input + b.output + b.thoughts;

/** 把一次读数并进累计：返回新增的 token 数 */
export function absorb(state: HindsightUsageState, samples: MetricSample[], now = Date.now()): number {
  const first = Object.keys(state.lastRaw).length === 0 && state.baseline === null;
  let added = 0;
  let baseline = 0;
  for (const s of samples) {
    const prev = state.lastRaw[s.key];
    state.lastRaw[s.key] = s.value;
    if (s.model && !state.models.includes(s.model)) state.models = [...state.models, s.model].slice(-4);
    if (first) { if (s.field !== 'calls') baseline += s.value; continue; }
    // 新出现的序列从 0 算起；变小了说明容器重启过，计数器从 0 重新开始
    const delta = prev === undefined || s.value < prev ? s.value : s.value - prev;
    if (!delta) continue;
    const b = (state.byScope[s.scope] ??= empty());
    if (s.field === 'calls') { b.calls += delta; if (!s.success) b.failed += delta; continue; }
    b[s.field] += delta;
    if (s.field !== 'cached') added += delta;
  }
  if (first) state.baseline = { at: now, tokens: Math.round(baseline) };
  return added;
}

export class HindsightUsage {
  private state: HindsightUsageState = { byScope: {}, lastRaw: {}, baseline: null, models: [] };
  private timer: NodeJS.Timeout | null = null;
  private lastPollAt: number | null = null;
  private error: string | null = null;
  private polling = false;

  constructor(private opts: { baseUrl: string; apiKey?: string; everyMs?: number; timeoutMs?: number; fetch?: typeof fetch }) {}

  start() {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.everyMs ?? 30_000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl}/metrics`, {
        headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const samples = parseHindsightMetrics(await res.text());
      if (!samples.length) throw new Error('/metrics 里没有 hindsight_llm_* 计数（Hindsight 版本不对，或还没调用过 LLM）');
      absorb(this.state, samples);
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.lastPollAt = Date.now();
      this.polling = false;
    }
  }

  /** 存进 run-stats.json 的部分 */
  dump(): HindsightUsageState { return structuredClone(this.state); }
  /** 读回上次存的（重启 Curio 后接着加） */
  load(saved: unknown) {
    const s = saved as Partial<HindsightUsageState> | null;
    if (!s || typeof s !== 'object') return;
    this.state = { byScope: s.byScope ?? {}, lastRaw: s.lastRaw ?? {}, baseline: s.baseline ?? null, models: s.models ?? [] };
  }

  totalTokens(): number { return Object.values(this.state.byScope).reduce((n, b) => n + bucketTokens(b), 0); }

  snapshot(): HindsightUsageSnapshot {
    const total = empty();
    for (const b of Object.values(this.state.byScope)) for (const k of Object.keys(total) as (keyof UsageBucket)[]) total[k] += b[k];
    return { enabled: true, ok: !this.error && this.lastPollAt !== null, error: this.error, lastPollAt: this.lastPollAt,
      total: { ...total, tokens: bucketTokens(total) }, byScope: structuredClone(this.state.byScope), models: this.state.models, baseline: this.state.baseline };
  }
}

import fs from 'node:fs';
import path from 'node:path';
import type { LlmStats } from '../planner/planner.ts';
import type { Metrics } from './metrics.ts';

/**
 * 一次测试（一个存档、一份数据目录）从头到尾的累计数字：死亡、LLM 调用次数和 token、任务成败、走了多远、累计运行时长……
 * 重启 Agent 不清零（直播时数字要连贯）；清空记忆或重置世界会连数据目录一起清掉，那就是新的一次测试，从零开始。
 *
 * 做法：定时把计数器存进 DATA_DIR/run-stats.json，启动时读回来接着加。
 */
type Counters = Metrics['counters'];
type PlannerTotals = Pick<LlmStats, 'calls' | 'ok' | 'errors' | 'invalid' | 'budgetFallbacks' | 'tokenUsage' | 'tiers' | 'tierLatency'>;
interface Saved {
  version: 1;
  startedAt: number;
  savedAt: number;
  uptimeSec: number;
  distance: number;
  counters: Counters;
  planners: Record<string, PlannerTotals>;
  /** 不经过 Curio 自己的 LLM 统计、但也算在这次测试里的用量（比如 Hindsight 记忆服务） */
  extras?: Record<string, unknown>;
}

/** 额外的累计来源：自己管怎么存、怎么读回，以及算进总 token 的数 */
export interface RunStatsExtra { dump(): unknown; load(saved: unknown): void; totalTokens?(): number }

const PLANNER_KEYS = ['calls', 'ok', 'errors', 'invalid', 'budgetFallbacks', 'tokenUsage', 'tiers', 'tierLatency'] as const;

/** 把 saved 里的数字加回 target 里同名的位置（嵌套对象逐层加；target 没有的键照搬） */
export function addInto(target: Record<string, any>, saved: Record<string, any>) {
  for (const [k, v] of Object.entries(saved ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) target[k] = (typeof target[k] === 'number' ? target[k] : 0) + v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) addInto((target[k] ??= {}), v);
  }
}

export class RunStats {
  private saved: Saved | null = null;
  private timer: NodeJS.Timeout | null = null;
  private exitHook = () => this.save();
  /** 这次进程启动时，已经累计了多少（读回来的） */
  readonly previous: { uptimeSec: number; startedAt: number } = { uptimeSec: 0, startedAt: Date.now() };

  constructor(private file: string, private metrics: Metrics, private planners: Record<string, { stats: LlmStats } | null | undefined>,
    private extras: Record<string, RunStatsExtra | null | undefined> = {}) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Saved;
      if (raw?.version === 1) this.saved = raw;
    } catch { /* 新的一次测试 */ }
    const s = this.saved;
    if (!s) return;
    // 接着上次的数加：进程里已经开始计的（启动这几秒）也保留
    addInto(metrics.counters as unknown as Record<string, any>, s.counters as unknown as Record<string, any>);
    metrics.distance += s.distance ?? 0;
    (metrics as unknown as { startedAt: number }).startedAt -= (s.uptimeSec ?? 0) * 1000;
    for (const [name, p] of Object.entries(planners)) {
      const prev = s.planners?.[name];
      if (!p || !prev) continue;
      const pick: Record<string, unknown> = {};
      for (const k of PLANNER_KEYS) pick[k] = prev[k];
      addInto(p.stats as unknown as Record<string, any>, pick);
    }
    for (const [name, x] of Object.entries(extras)) {
      if (x && s.extras?.[name] !== undefined) { try { x.load(s.extras[name]); } catch { /* 旧格式读不了就从零记 */ } }
    }
    this.previous.uptimeSec = s.uptimeSec ?? 0;
    this.previous.startedAt = s.startedAt ?? Date.now();
  }

  start(everyMs = 10_000) {
    this.timer = setInterval(() => this.save(), everyMs);
    this.timer.unref?.();
    process.once('exit', this.exitHook);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    process.off('exit', this.exitHook);
    this.save();
  }

  snapshot(): Saved {
    const m = this.metrics;
    const planners: Record<string, PlannerTotals> = {};
    for (const [name, p] of Object.entries(this.planners)) {
      if (!p) continue;
      const pick: Record<string, unknown> = {};
      for (const k of PLANNER_KEYS) pick[k] = structuredClone(p.stats[k]);
      planners[name] = pick as unknown as PlannerTotals;
    }
    const uptimeSec = Math.round((Date.now() - (m as unknown as { startedAt: number }).startedAt) / 1000);
    const extras: Record<string, unknown> = {};
    for (const [name, x] of Object.entries(this.extras)) if (x) extras[name] = x.dump();
    return { version: 1, startedAt: this.previous.startedAt, savedAt: Date.now(), uptimeSec, distance: Math.round(m.distance), counters: structuredClone(m.counters), planners,
      ...(Object.keys(extras).length ? { extras } : {}) };
  }

  /** 所有模型加起来用了多少 token（直播叠层用），含 Hindsight 记忆服务这类额外来源 */
  totalTokens(): number {
    return Object.values(this.planners).reduce((n, p) => n + (p?.stats.tokenUsage.totalTokens ?? 0), 0)
      + Object.values(this.extras).reduce((n, x) => n + (x?.totalTokens?.() ?? 0), 0);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 1));
      fs.renameSync(tmp, this.file);
    } catch { /* 存不下不影响游玩 */ }
  }
}

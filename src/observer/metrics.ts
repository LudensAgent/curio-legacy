import type { GameAdapter } from '../adapter/types.ts';
import type { Arbiter } from '../arbiter/arbiter.ts';
import type { Executive } from '../brain/executive.ts';
import type { Reflex } from '../brain/reflex.ts';
import type { AgentEvent, EventBus } from '../events.ts';
import type { Planner } from '../planner/planner.ts';

type Cat = 'task' | 'filler' | 'reflex' | 'idle' | 'paused' | 'offline';

interface Sample {
  t: number;
  cat: Cat;
  llm: boolean;
}

/**
 * 连贯性 / 自主性指标（对应设计文档第 13 章）。每秒采样一次角色在做什么。
 * 关键指标：
 * - idle10m：最近 10 分钟“没有任何任务”的秒数（目标 < 60）
 * - llmContinuity：LLM 思考期间角色仍在执行任务/填充/反射的比例（目标 ≥ 95%）
 */
export class Metrics {
  private samples: Sample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private lastPos: { x: number; y: number; z: number } | null = null;
  distance = 0;
  counters = {
    tasks: { succeeded: 0, failed: 0, cancelled: 0 },
    failCodes: {} as Record<string, number>,
    goals: { succeeded: 0, failed: 0, other: 0 },
    discoveries: 0,
    deaths: 0,
    plansLlm: 0,
    plansRule: 0,
  };

  constructor(
    private adapter: GameAdapter,
    private arbiter: Arbiter,
    private executive: Executive,
    private planner: Planner,
    private reflex: Reflex,
    bus: EventBus,
  ) {
    bus.on('event', (ev: AgentEvent) => this.onEvent(ev));
  }

  start() {
    this.timer = setInterval(() => this.sample(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private onEvent(ev: AgentEvent) {
    const d = ev.data ?? {};
    if (ev.type === 'task_end' && d.status && !String(ev.msg).startsWith('[filler]')) {
      const st = d.status as 'succeeded' | 'failed' | 'cancelled';
      this.counters.tasks[st]++;
      if (d.failureCode) this.counters.failCodes[String(d.failureCode)] = (this.counters.failCodes[String(d.failureCode)] ?? 0) + 1;
    } else if (ev.type === 'goal_end') {
      if (d.status === 'succeeded') this.counters.goals.succeeded++;
      else if (d.status === 'failed') this.counters.goals.failed++;
      else this.counters.goals.other++;
    } else if (ev.type === 'discovery') this.counters.discoveries++;
    else if (ev.type === 'death') this.counters.deaths++;
    else if (ev.type === 'plan') {
      if (String(ev.msg).startsWith('[rule]')) this.counters.plansRule++;
      else this.counters.plansLlm++;
    }
  }

  sample() {
    const s = this.adapter.state();
    const cur = this.arbiter.info();
    let cat: Cat;
    if (!s.connected || !s.alive) cat = 'offline';
    else if (this.executive.paused) cat = 'paused';
    else if (!cur) cat = 'idle';
    else if (cur.source === 'filler') cat = 'filler';
    else if (cur.source === 'reflex') cat = 'reflex';
    else cat = 'task';
    this.samples.push({ t: Date.now(), cat, llm: this.executive.inFlight });
    if (this.samples.length > 3600) this.samples.shift();
    if (s.connected && s.alive) {
      if (this.lastPos) {
        const d = Math.hypot(s.pos.x - this.lastPos.x, s.pos.z - this.lastPos.z);
        if (d < 20) this.distance += d; // 忽略传送/重生
      }
      this.lastPos = s.pos;
    }
  }

  snapshot() {
    const now = Date.now();
    const win = this.samples.filter((x) => now - x.t <= 600_000);
    const byCat: Record<Cat, number> = { task: 0, filler: 0, reflex: 0, idle: 0, paused: 0, offline: 0 };
    for (const x of win) byCat[x.cat]++;
    const llmSamples = this.samples.filter((x) => x.llm && x.cat !== 'offline' && x.cat !== 'paused');
    const llmActive = llmSamples.filter((x) => x.cat === 'task' || x.cat === 'filler' || x.cat === 'reflex').length;
    const lat = [...this.planner.stats.latencies].sort((a, b) => a - b);
    const t = this.counters.tasks;
    const done = t.succeeded + t.failed;
    return {
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      window10m: byCat,
      idle10m: byCat.idle,
      llmContinuity: llmSamples.length ? llmActive / llmSamples.length : null,
      llmThinkingSec: llmSamples.length,
      taskSuccessRate: done ? t.succeeded / done : null,
      tasks: t,
      failCodes: this.counters.failCodes,
      goals: this.counters.goals,
      plans: { llm: this.counters.plansLlm, rule: this.counters.plansRule },
      discoveries: this.counters.discoveries,
      deaths: this.counters.deaths,
      distance: Math.round(this.distance),
      stuck: this.reflex.stuckCount,
      reflexTriggers: this.reflex.triggers,
      blockedActions: this.arbiter.blockedActions,
      llm: {
        ...this.planner.stats,
        latencies: undefined,
        avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        p95LatencyMs: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null,
      },
    };
  }
}

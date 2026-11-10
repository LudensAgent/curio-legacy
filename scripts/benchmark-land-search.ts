/**
 * Repeatable land-search event-loop baseline (task plan §9).
 *
 * Builds synthetic observed VoxelMaps, runs the same strict + historical
 * `searchLandRoute` passes the host uses, and measures:
 *   - search duration and node/edge counts
 *   - how late a `setTimeout(0)` callback fires (the synchronous block)
 *
 * This is a deterministic proxy for `event_loop_stall`, not a live game run.
 * Run: npx tsx scripts/benchmark-land-search.ts
 */
import { performance } from 'node:perf_hooks';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { walkLandRules } from '../src/adapter/land-rules.ts';
import { goalOf } from '../src/skills/movement/goal.ts';
import { searchLandRoute, searchLandRouteAsync } from '../src/spatial/land-search.ts';

const WORLD = 'bench-world', DIM = 'overworld', SESSION = 'bench-session';
const REPEATS = Number(process.env.REPEATS ?? 5);
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 2500);

interface Scenario { label: string; n: number; stepped: boolean; stale: boolean }

function build(n: number, stepped: boolean, stale: boolean): { map: VoxelMap; height: (x: number, z: number) => number } {
  const map = new VoxelMap(WORLD, { validityWindowMs: stale ? 1 : 10 * 60_000 });
  const observedAt = Date.now() - (stale ? 2000 : 0);
  let sequence = 0;
  const height = (x: number, z: number) => stepped ? ((x * 7 + z * 11) % 3) - 1 : 0;
  for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
    const h = height(x, z);
    for (let y = -3; y <= 3; y++) {
      map.observe({
        worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt, sequence: ++sequence,
        source: 'vision', evidence: 'seen', stateComplete: true,
        state: { name: y <= h ? 'minecraft:stone' : 'minecraft:air', properties: {} },
        pos: { x, y, z },
      });
    }
  }
  return { map, height };
}

async function run(scenario: Scenario): Promise<Record<string, unknown>> {
  const { map, height } = build(scenario.n, scenario.stepped, scenario.stale);
  const feet = { x: 0.5, y: height(0, 0) + 1, z: 0.5 };
  const to = { x: scenario.n - 0.5, y: height(scenario.n - 1, scenario.n - 1) + 1, z: scenario.n - 0.5 };
  const body = { feet, width: 0.6, height: 1.8, pose: 'standing' as const };
  const samples: {
    totalMs: number; timerDelayMs: number; strictMs: number; historicalMs: number;
    nodes: number; edges: number; sectionsRead: number; surfaceReads: number;
    status: string; budget: string | null; routeKey: string;
  }[] = [];
  const asyncSamples: {
    totalMs: number; timerDelayMs: number; yields: number; maxSyncSliceMs: number;
    status: string; budget: string | null; historical: string | null;
    nodes: number; edges: number; sectionsRead: number; surfaceReads: number;
  }[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const deadlineMs = Date.now() + BUDGET_MS;
    const request = { worldId: WORLD, dim: DIM, sessionId: SESSION, body, goal: goalOf(to), rules: walkLandRules, maxNodes: 2048, maxEdges: 8192, deadlineMs };
    let timerAt = 0;
    setTimeout(() => { timerAt = performance.now(); }, 0);
    const t0 = performance.now();
    const strict = searchLandRoute(map, request);
    const tStrict = performance.now();
    const historical = strict.status === 'FOUND' ? null : searchLandRoute(map, { ...request, evidenceMode: 'remembered' as const });
    const t1 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const t2 = performance.now();
    samples.push({
      totalMs: t1 - t0, timerDelayMs: (timerAt || t2) - t0,
      strictMs: tStrict - t0, historicalMs: t1 - tStrict,
      nodes: strict.stats.nodesExpanded, edges: strict.stats.edgesEvaluated,
      sectionsRead: strict.stats.sectionsRead, surfaceReads: strict.stats.surfaceReads,
      status: strict.status, budget: strict.budget ?? null,
      routeKey: JSON.stringify({ points: strict.points, transitions: strict.transitions, boundaries: strict.boundaries }),
    });

    // The async entry yields around its bounded compute slice. Measure the longest
    // interval between 1ms timer ticks during the sliced search.
    let asyncTimerDelay = 0;
    let asyncLastTick = performance.now();
    const timer = setInterval(() => {
      const at = performance.now();
      asyncTimerDelay = Math.max(asyncTimerDelay, at - asyncLastTick);
      asyncLastTick = at;
    }, 1);
    const asyncDeadline = Date.now() + BUDGET_MS;
    const a0 = performance.now();
    const asyncStrict = await searchLandRouteAsync(map, { ...request, deadlineMs: asyncDeadline });
    const asyncHistorical = asyncStrict.status === 'FOUND'
      ? null : await searchLandRouteAsync(map, { ...request, evidenceMode: 'remembered', deadlineMs: asyncDeadline });
    const a1 = performance.now();
    clearInterval(timer);
    asyncSamples.push({
      totalMs: a1 - a0, timerDelayMs: asyncTimerDelay,
      yields: asyncStrict.stats.yieldCount, maxSyncSliceMs: asyncStrict.stats.maxSyncSliceMs,
      status: asyncStrict.status, budget: asyncStrict.budget ?? null,
      historical: asyncHistorical?.status ?? null,
      nodes: asyncStrict.stats.nodesExpanded, edges: asyncStrict.stats.edgesEvaluated,
      sectionsRead: asyncStrict.stats.sectionsRead, surfaceReads: asyncStrict.stats.surfaceReads,
    });
  }
  // Deterministic strict result: every repeat must take the same route and
  // truthful counters. status/budget are deliberately excluded — the strict
  // deadline is wall-clock based, so a loaded machine can legitimately stop
  // on a time budget. A mismatch is reported as budget noise when a repeat
  // hit the time budget, otherwise as a search regression.
  const signature = (sample: (typeof samples)[number]) => JSON.stringify({
    routeKey: sample.routeKey, nodes: sample.nodes, edges: sample.edges,
    sectionsRead: sample.sectionsRead, surfaceReads: sample.surfaceReads,
  });
  const expected = signature(samples[0]!);
  const mismatch = samples.findIndex((sample) => signature(sample) !== expected);
  const budgetStopped = samples.some((sample) => sample.budget === 'time');
  if (mismatch !== -1) {
    const stops = samples.map((sample) => `${sample.status}/${sample.budget ?? '-'}`).join(', ');
    throw new Error(budgetStopped
      ? `budget/deadline exhaustion during repeats (${scenario.label}: ${stops}); routes not comparable, not a search regression`
      : `non-deterministic strict result at repeat ${mismatch} in ${scenario.label} (${stops})`);
  }
  const pct = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  };
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    scenario: scenario.label,
    n: scenario.n,
    repeats: REPEATS,
    budgetMs: BUDGET_MS,
    // Offline synthetic VoxelMap; timings are a proxy, not a live-server run.
    synthetic: true,
    checks: { strictDeterministic: true },
    status: samples[0]!.status,
    budget: samples[0]!.budget,
    nodes: samples[0]!.nodes,
    edges: samples[0]!.edges,
    sectionsRead: samples[0]!.sectionsRead,
    surfaceReads: samples[0]!.surfaceReads,
    searchMs: { p50: round(pct(samples.map((s) => s.totalMs), 0.5)), p95: round(pct(samples.map((s) => s.totalMs), 0.95)) },
    strictMs: { p50: round(pct(samples.map((s) => s.strictMs), 0.5)), p95: round(pct(samples.map((s) => s.strictMs), 0.95)) },
    historicalMs: { p50: round(pct(samples.map((s) => s.historicalMs), 0.5)), p95: round(pct(samples.map((s) => s.historicalMs), 0.95)) },
    timerDelayMs: { p50: round(pct(samples.map((s) => s.timerDelayMs), 0.5)), p95: round(pct(samples.map((s) => s.timerDelayMs), 0.95)) },
    async: {
      status: asyncSamples[0]!.status,
      budget: asyncSamples[0]!.budget,
      historical: asyncSamples[0]!.historical,
      yields: asyncSamples[0]!.yields,
      maxSyncSliceMs: asyncSamples[0]!.maxSyncSliceMs,
      nodes: asyncSamples[0]!.nodes,
      edges: asyncSamples[0]!.edges,
      sectionsRead: asyncSamples[0]!.sectionsRead,
      surfaceReads: asyncSamples[0]!.surfaceReads,
      totalMs: { p50: round(pct(asyncSamples.map((s) => s.totalMs), 0.5)), p95: round(pct(asyncSamples.map((s) => s.totalMs), 0.95)) },
      timerDelayMs: { p50: round(pct(asyncSamples.map((s) => s.timerDelayMs), 0.5)), p95: round(pct(asyncSamples.map((s) => s.timerDelayMs), 0.95)) },
    },
  };
}

const scenarios: Scenario[] = [
  { label: 'flat-120', n: 120, stepped: false, stale: false },
  { label: 'stepped-120', n: 120, stepped: true, stale: false },
  { label: 'stepped-120-stale', n: 120, stepped: false, stale: true },
  { label: 'stepped-240', n: 240, stepped: true, stale: false },
];
for (const scenario of scenarios) console.log(JSON.stringify(await run(scenario)));

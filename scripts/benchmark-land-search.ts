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
import { searchLandRoute } from '../src/spatial/land-search.ts';

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
    nodes: number; edges: number; visitedSections: number; sectionReads: number;
    snapshotCount: number; cloneCount: number; status: string; cancelReason: string | null;
  }[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const deadlineMs = Date.now() + BUDGET_MS;
    const request = { worldId: WORLD, dim: DIM, sessionId: SESSION, body, to, rules: walkLandRules, maxNodes: 2048, maxEdges: 8192, deadlineMs };
    let timerAt = 0;
    setTimeout(() => { timerAt = performance.now(); }, 0);
    const t0 = performance.now();
    const strict = searchLandRoute(map, request);
    const tStrict = performance.now();
    const historical = strict.status === 'FOUND' ? null : searchLandRoute(map, { ...request, allowStale: true });
    const t1 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const t2 = performance.now();
    samples.push({
      totalMs: t1 - t0, timerDelayMs: (timerAt || t2) - t0,
      strictMs: tStrict - t0, historicalMs: t1 - tStrict,
      nodes: strict.stats.nodesExpanded, edges: strict.stats.edgesEvaluated,
      visitedSections: strict.stats.visitedSections, sectionReads: strict.stats.sectionReads,
      snapshotCount: strict.stats.snapshotCount, cloneCount: strict.stats.cloneCount,
      status: strict.status, cancelReason: strict.stats.cancelReason,
    });
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
    status: samples[0]!.status,
    cancelReason: samples[0]!.cancelReason,
    nodes: samples[0]!.nodes,
    edges: samples[0]!.edges,
    visitedSections: samples[0]!.visitedSections,
    sectionReads: samples[0]!.sectionReads,
    snapshotCount: samples[0]!.snapshotCount,
    cloneCount: samples[0]!.cloneCount,
    searchMs: { p50: round(pct(samples.map((s) => s.totalMs), 0.5)), p95: round(pct(samples.map((s) => s.totalMs), 0.95)) },
    strictMs: { p50: round(pct(samples.map((s) => s.strictMs), 0.5)), p95: round(pct(samples.map((s) => s.strictMs), 0.95)) },
    historicalMs: { p50: round(pct(samples.map((s) => s.historicalMs), 0.5)), p95: round(pct(samples.map((s) => s.historicalMs), 0.95)) },
    timerDelayMs: { p50: round(pct(samples.map((s) => s.timerDelayMs), 0.5)), p95: round(pct(samples.map((s) => s.timerDelayMs), 0.95)) },
  };
}

const scenarios: Scenario[] = [
  { label: 'flat-120', n: 120, stepped: false, stale: false },
  { label: 'stepped-120', n: 120, stepped: true, stale: false },
  { label: 'stepped-120-stale', n: 120, stepped: false, stale: true },
  { label: 'stepped-240', n: 240, stepped: true, stale: false },
];
for (const scenario of scenarios) console.log(JSON.stringify(await run(scenario)));

import type { ActivityOutcome } from './types.ts';

/**
 * Independent progress ledger (batch 3).
 *
 * Progress belongs to the goal, not to one activity name or method. The ledger
 * keeps measured space/movement/execution/cost/item facts across activities so a
 * new method or a renamed activity does not erase the trend. It records facts;
 * whether they mean progress is still the Agent's judgement.
 */
export type ProgressRegion = string;

export type ProgressEntry = {
  targetId: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  spatial: {
    newChunks: number;
    visitedCells: number;
    /** Farthest measured horizontal distance from the first position seen in each dimension. */
    farthest: number;
    farthestByDim: Record<string, number>;
    originByDim: Record<string, { x: number; y: number; z: number }>;
    repeatVisits: number;
    /** Bounded chunk keys already visited for this target. */
    regions: ProgressRegion[];
    /** Last activity's end region: continuing from there is not a revisit. */
    lastEndRegion?: ProgressRegion;
  };
  movement: {
    /** Sum of measured activity start→end horizontal displacement; not total route length. */
    pathLength: number;
    /** Distance from this dimension's origin to the latest measured end. */
    netDisplacement: number;
    activities: number;
  };
  execution: {
    completed: number;
    attempted: number;
    blocked: number;
    interrupted: number;
    reasons: Record<string, number>;
  };
  cost: {
    onlineSec: number;
    itemsLost: Record<string, number>;
    hp?: number;
    food?: number;
  };
  items: {
    explicitTargets: Record<string, number>;
    sideProducts: Record<string, number>;
  };
  last: {
    at: number;
    outcome: ActivityOutcome;
    completion?: string;
    stopReason?: string;
    failedCode?: string | null;
    result: string;
  };
};

export type ProgressLedger = { version: 1; entries: Record<string, ProgressEntry> };

export const emptyProgressLedger = (): ProgressLedger => ({ version: 1, entries: {} });

export type ProgressInput = {
  targetId: string;
  label: string;
  at: number;
  dim: string;
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  outcome: ActivityOutcome;
  completion?: string;
  stopReason?: string;
  failedCode?: string | null;
  summary: string;
  durationSec: number;
  newChunks?: number | null;
  visitedCells?: number;
  gained: Readonly<Record<string, number>>;
  lost: Readonly<Record<string, number>>;
  targets?: readonly string[];
  acquired?: boolean | null;
  hpDelta?: number;
  foodDelta?: number;
};

/** 目标可以是具体物品、类别（log/wood）或简称；只做包含匹配，不推断未点名的资源。 */
export function hitsResourceTarget(name: string, targets: readonly string[]): boolean {
  const item = name.replace(/^minecraft:/, '');
  return !targets.length || targets.some((target) => item === target || item.endsWith(`_${target}`) || item.includes(target)
    // 矿石方块与它的产物：iron_ore 也匹配 raw_iron。
    || target.endsWith('_ore') && item === `raw_${target.slice(0, -4)}`);
}

const regionOf = (dim: string, pos: { x: number; z: number }) => `${dim}:${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`;
const flatDistance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const addCounts = (base: Readonly<Record<string, number>>, extra: Readonly<Record<string, number>>) => {
  const next = { ...base };
  for (const [name, count] of Object.entries(extra)) next[name] = (next[name] ?? 0) + count;
  return next;
};
const emptyEntry = (input: ProgressInput): ProgressEntry => ({
  targetId: input.targetId, label: input.label, createdAt: input.at, updatedAt: input.at,
  spatial: {
    newChunks: 0, visitedCells: 0, farthest: 0, farthestByDim: {},
    originByDim: { [input.dim]: { ...input.start } }, repeatVisits: 0,
    regions: [regionOf(input.dim, input.start)], lastEndRegion: regionOf(input.dim, input.start),
  },
  movement: { pathLength: 0, netDisplacement: 0, activities: 0 },
  execution: { completed: 0, attempted: 0, blocked: 0, interrupted: 0, reasons: {} },
  cost: { onlineSec: 0, itemsLost: {} },
  items: { explicitTargets: {}, sideProducts: {} },
  last: { at: input.at, outcome: input.outcome, result: input.summary.slice(0, 200) },
});

/** Apply one finished activity to the ledger. Other targets are left untouched. */
export function applyProgress(ledger: ProgressLedger, input: ProgressInput): ProgressLedger {
  const previous = ledger.entries[input.targetId] ?? emptyEntry(input);
  const region = regionOf(input.dim, input.end);
  const startRegion = regionOf(input.dim, input.start);
  // 接着上一段结束的位置继续不算重复到访；从别处走回旧区块才算。
  const repeated = previous.spatial.regions.includes(region) && previous.spatial.lastEndRegion !== startRegion;
  const regions = [...new Set([...previous.spatial.regions, startRegion, region])].slice(-512);
  const origin = previous.spatial.originByDim[input.dim] ?? { ...input.start };
  const farthest = Math.max(previous.spatial.farthestByDim[input.dim] ?? 0, flatDistance(origin, input.end), flatDistance(origin, input.start));
  const farthestByDim = { ...previous.spatial.farthestByDim, [input.dim]: farthest };
  const targets = input.targets ?? [];
  const gainedNames = Object.fromEntries(Object.entries(input.gained).map(([name, count]) => [name.replace(/^minecraft:/, ''), count]));
  const thisTargets = targets.length
    ? Object.fromEntries(targets.map((target) => {
      const count = Object.entries(gainedNames).filter(([name]) => hitsResourceTarget(name, [target])).reduce((n, [, c]) => n + c, 0);
      return [target, count];
    }))
    : {};
  const thisSide = Object.fromEntries(Object.entries(gainedNames).filter(([name]) => !targets.some((target) => hitsResourceTarget(name, [target]))));
  const explicitTargets = addCounts(previous.items.explicitTargets, thisTargets);
  const sideProducts = addCounts(previous.items.sideProducts, thisSide);
  const reason = input.stopReason ?? input.failedCode ?? (input.outcome === 'done' ? undefined : input.outcome);
  const execution = {
    ...previous.execution,
    ...(input.outcome === 'done' ? { completed: previous.execution.completed + 1 } : {}),
    ...(input.completion === 'attempt' ? { attempted: previous.execution.attempted + 1 } : {}),
    ...(input.outcome === 'stuck' ? { blocked: previous.execution.blocked + 1 } : {}),
    ...(input.outcome === 'interrupted' || input.outcome === 'replaced' || input.outcome === 'abandoned' ? { interrupted: previous.execution.interrupted + 1 } : {}),
    reasons: reason ? addCounts(previous.execution.reasons, { [reason]: 1 }) : previous.execution.reasons,
  };
  const entry: ProgressEntry = {
    ...previous,
    label: input.label || previous.label,
    updatedAt: input.at,
    spatial: {
      ...previous.spatial,
      newChunks: previous.spatial.newChunks + Math.max(0, input.newChunks ?? 0),
      visitedCells: previous.spatial.visitedCells + Math.max(0, input.visitedCells ?? 0),
      farthest: Math.max(previous.spatial.farthest, farthest),
      farthestByDim, originByDim: { ...previous.spatial.originByDim, [input.dim]: origin },
      repeatVisits: previous.spatial.repeatVisits + (repeated ? 1 : 0),
      regions, lastEndRegion: region,
    },
    movement: {
      pathLength: previous.movement.pathLength + flatDistance(input.start, input.end),
      netDisplacement: flatDistance(origin, input.end),
      activities: previous.movement.activities + 1,
    },
    execution,
    cost: {
      onlineSec: previous.cost.onlineSec + Math.max(0, input.durationSec),
      itemsLost: addCounts(previous.cost.itemsLost, input.lost),
      ...(input.hpDelta !== undefined || previous.cost.hp !== undefined ? { hp: (previous.cost.hp ?? 0) + (input.hpDelta ?? 0) } : {}),
      ...(input.foodDelta !== undefined || previous.cost.food !== undefined ? { food: (previous.cost.food ?? 0) + (input.foodDelta ?? 0) } : {}),
    },
    items: { explicitTargets, sideProducts },
    last: {
      at: input.at, outcome: input.outcome, result: input.summary.slice(0, 200),
      ...(input.completion ? { completion: input.completion } : {}),
      ...(reason ? { stopReason: reason } : {}),
      ...(input.failedCode ? { failedCode: input.failedCode } : {}),
    },
  };
  return { ...ledger, entries: { ...ledger.entries, [input.targetId]: entry } };
}

/** Compact projection for the prompt; details remain queryable through the ledger. */
export function progressSummary(entry: ProgressEntry | undefined) {
  if (!entry) return null;
  return {
    target: entry.label,
    farthest: Math.round(entry.spatial.farthest * 10) / 10,
    new_chunks: entry.spatial.newChunks,
    repeat_visits: entry.spatial.repeatVisits,
    net_displacement: Math.round(entry.movement.netDisplacement * 10) / 10,
    activities: entry.movement.activities,
    ...(Object.keys(entry.execution.reasons).length ? { stop_reasons: entry.execution.reasons } : {}),
    ...(Object.keys(entry.items.explicitTargets).length ? { targets_gained: entry.items.explicitTargets } : {}),
    ...(Object.keys(entry.items.sideProducts).length ? { side_products: entry.items.sideProducts } : {}),
    last: `${entry.last.outcome}${entry.last.stopReason ? `/${entry.last.stopReason}` : ''}：${entry.last.result.slice(0, 80)}`,
  };
}

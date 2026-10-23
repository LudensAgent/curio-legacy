import { createHash } from 'node:crypto';
import type { AgentState } from '../adapter/types.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { Percept } from '../perception/perception.ts';
import type { Plan } from '../planner/plan.ts';

type Scope = Pick<AgentState, 'worldId' | 'dim' | 'sessionId'>;
interface Snapshot {
  at: number;
  scope: Scope;
  pos: AgentState['pos'];
  observationReady: boolean;
  inventory: Record<string, number>;
  knownResourceTypes: string[];
  visibleResourceTypes: string[];
  rememberedResourceTypes: string[];
  inWater: boolean;
  vitals: Pick<AgentState, 'hp' | 'food' | 'oxygen' | 'inLava' | 'onGround'>;
  biome: string | null;
  view: string | null;
  visitedChunks: number;
}

const scopeOf = ({ worldId, dim, sessionId }: AgentState): Scope => ({ worldId, dim, sessionId });
const samePlaceScope = (a: Scope, b: Scope) => a.worldId === b.worldId && a.dim === b.dim;
const sameScope = (a: Scope, b: Scope) => samePlaceScope(a, b) && a.sessionId === b.sessionId;
const unique = (values: string[]) => [...new Set(values)].sort();
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const patternKey = (steps: Step[]) => createHash('sha256').update(JSON.stringify(canonical(steps))).digest('hex');
const describeSteps = (steps: Step[]) => steps.slice(0, 5).map(({ skill, args }) => {
  const serialized = JSON.stringify(args ?? {});
  return { skill, args: serialized.length <= 300 ? JSON.parse(serialized) : { preview: serialized.slice(0, 300), truncated: true } };
});
const setChanges = (before: string[], after: string[]) => ({
  added: after.filter((name) => !before.includes(name)), removed: before.filter((name) => !after.includes(name)),
});

function snapshot(state: AgentState, percept: Percept): Snapshot {
  const inventory = new Map<string, number>();
  for (const item of state.inventory) inventory.set(item.name, (inventory.get(item.name) ?? 0) + item.count);
  const nearby = percept.nearby.resources.filter((item) => item.count > 0);
  const visible = percept.vision?.visible_resources.filter((item) => item.count > 0) ?? [];
  const remembered = percept.vision?.remembered_resources.filter((item) => item.count > 0) ?? [];
  return {
    at: Date.now(), scope: scopeOf(state), pos: { ...state.pos }, observationReady: state.observationReady,
    inventory: Object.fromEntries([...inventory].sort(([a], [b]) => a.localeCompare(b))),
    knownResourceTypes: unique([...nearby, ...visible, ...remembered].map((item) => item.block)),
    visibleResourceTypes: unique([...nearby.filter((item) => item.seen === 'now'), ...visible].map((item) => item.block)),
    rememberedResourceTypes: unique([...nearby.filter((item) => item.seen === 'memory'), ...remembered].map((item) => item.block)),
    inWater: state.inWater, vitals: { hp: state.hp, food: state.food, oxygen: state.oxygen, inLava: state.inLava, onGround: state.onGround },
    biome: state.biome, view: percept.vision?.view ?? null,
    visitedChunks: percept.exploration.visitedChunks,
  };
}

function compare(before: Snapshot, after: Snapshot) {
  const comparable = sameScope(before.scope, after.scope);
  const items = unique([...Object.keys(before.inventory), ...Object.keys(after.inventory)]);
  const dx = after.pos.x - before.pos.x, dy = after.pos.y - before.pos.y, dz = after.pos.z - before.pos.z;
  return {
    scopeChanged: !comparable,
    movement: comparable ? { delta: { x: dx, y: dy, z: dz }, distance: Math.hypot(dx, dy, dz) } : null,
    inventoryDelta: items.map((item) => ({ item, before: before.inventory[item] ?? 0, after: after.inventory[item] ?? 0,
      delta: (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0) })).filter((item) => item.delta !== 0),
    resourceTypeChanges: samePlaceScope(before.scope, after.scope) ? {
      known: setChanges(before.knownResourceTypes, after.knownResourceTypes),
      visible: setChanges(before.visibleResourceTypes, after.visibleResourceTypes),
    } : null,
    water: { before: before.inWater, after: after.inWater },
    biome: { before: before.biome, after: after.biome },
    view: { before: before.view, after: after.view },
  };
}

interface Attempt {
  planId: string;
  goal: string;
  status: string;
  summary: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  stepsStarted: ReturnType<typeof describeSteps>;
  before: Snapshot;
  after: Snapshot;
  changes: ReturnType<typeof compare>;
}

/** Supplies observations about attempts; deciding what to pursue remains the model's job. */
export class DecisionFeedback {
  private scope: Scope | null = null;
  private scopeChange: { at: number; from: Scope; to: Scope } | null = null;
  private active: { planId: string; goal: string; before: Snapshot } | null = null;
  private latestObservation: Snapshot | null = null;
  private recent: { attempt: Attempt; pattern: string }[] = [];

  private observeScope(state: AgentState) {
    const next = scopeOf(state);
    if (this.scope && !sameScope(this.scope, next)) {
      this.scopeChange = { at: Date.now(), from: this.scope, to: next };
      this.recent = [];
    }
    this.scope = next;
  }

  begin(plan: Plan, state: AgentState, percept: Percept) {
    this.observeScope(state);
    this.latestObservation = snapshot(state, percept);
    this.active = { planId: plan.id, goal: plan.goal.slice(0, 240), before: this.latestObservation };
  }

  end(plan: Plan, status: string, summary: string, state: AgentState, percept: Percept) {
    this.observeScope(state);
    if (this.active?.planId !== plan.id) return; // Missing baseline is not evidence of no change.
    const before = this.active.before, after = snapshot(state, percept);
    this.latestObservation = after;
    const steps = plan.steps.slice(0, Math.max(0, Math.min(plan.steps.length, Math.floor(plan.index))));
    const attempt: Attempt = {
      planId: plan.id, goal: this.active.goal, status, summary: summary.slice(0, 500),
      startedAt: before.at, endedAt: after.at, durationMs: Math.max(0, after.at - before.at),
      stepsStarted: describeSteps(steps), before, after, changes: compare(before, after),
    };
    this.recent.push({ attempt, pattern: patternKey(steps) });
    if (this.recent.length > 6) this.recent.shift();
    this.active = null;
  }

  context(state: AgentState, percept?: Percept) {
    this.observeScope(state);
    if (percept) this.latestObservation = snapshot(state, percept);
    const observation = this.latestObservation && sameScope(this.latestObservation.scope, this.scope!) ? this.latestObservation : null;
    const recent = this.recent.filter(({ attempt }) => samePlaceScope(attempt.after.scope, this.scope!));
    const latest = recent.at(-1);
    let streak = 0;
    if (latest) for (let i = recent.length - 1; i >= 0; i--) {
      const entry = recent[i];
      if (entry.pattern !== latest.pattern || !sameScope(entry.attempt.before.scope, this.scope!)
        || !sameScope(entry.attempt.after.scope, this.scope!)) break;
      streak++;
    }
    return structuredClone({
      scope: this.scope,
      scopeChange: this.scopeChange,
      currentState: {
        hp: state.hp, food: state.food, oxygen: state.oxygen, inWater: state.inWater, inLava: state.inLava, onGround: state.onGround,
        pos: { ...state.pos }, observationReady: state.observationReady,
        resources: observation ? { observedAt: observation.at, visibleTypes: observation.visibleResourceTypes, rememberedTypes: observation.rememberedResourceTypes } : null,
      },
      activeAttempt: this.active && sameScope(this.active.before.scope, this.scope!)
        ? { planId: this.active.planId, goal: this.active.goal, startedAt: this.active.before.at, before: this.active.before } : null,
      recentAttempts: recent.map(({ attempt }) => attempt),
      repeatedStepPattern: latest && streak > 0 ? { steps: latest.attempt.stepsStarted, consecutiveAttempts: streak } : null,
    });
  }
}

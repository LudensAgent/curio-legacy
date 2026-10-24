import { createHash } from 'node:crypto';
import type { AgentState, EffectEvidence } from '../adapter/types.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { Percept } from '../perception/perception.ts';
import type { Plan } from '../planner/plan.ts';

type Scope = Pick<AgentState, 'worldId' | 'dim' | 'sessionId'>;
const INTENT_PROGRESS_WINDOW_MS = 10 * 60_000;
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
    newChunks: comparable ? Math.max(0, after.visitedChunks - before.visitedChunks) : null,
    vitalsChanged: comparable ? JSON.stringify(before.vitals) !== JSON.stringify(after.vitals) : null,
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
  effectEvidence?: EffectEvidence;
}

/** No measured difference is a bounded observation, not proof that the world never changed. */
function unchanged(attempt: Attempt): boolean {
  const c = attempt.changes;
  return attempt.before.observationReady && attempt.after.observationReady && !c.scopeChanged
    && !(attempt.effectEvidence?.verified && attempt.effectEvidence.changed)
    && (c.movement?.distance ?? Infinity) < 0.75 && !c.inventoryDelta.length && c.newChunks === 0 && c.vitalsChanged === false
    && !c.resourceTypeChanges?.known.added.length && !c.resourceTypeChanges?.known.removed.length
    && c.water.before === c.water.after && c.biome.before === c.biome.after && c.view.before === c.view.after;
}

/** Supplies observations about attempts; deciding what to pursue remains the model's job. */
export class DecisionFeedback {
  private scope: Scope | null = null;
  private scopeChange: { at: number; from: Scope; to: Scope } | null = null;
  private active: { planId: string; goal: string; before: Snapshot; progressObserved?: boolean } | null = null;
  private latestObservation: Snapshot | null = null;
  private recent: { attempt: Attempt; pattern: string }[] = [];
  private intentWindow: { intentId: string; anchor: Snapshot; seenResourceTypes: Set<string>; consecutiveNoProgressAttempts: number;
    since: number | null; lastAttemptAt: number | null; lastProgressAt: number | null } | null = null;

  private observeScope(state: AgentState) {
    const next = scopeOf(state);
    if (this.scope && !sameScope(this.scope, next)) {
      this.scopeChange = { at: Date.now(), from: this.scope, to: next };
      this.recent = [];
      this.intentWindow = null;
    }
    this.scope = next;
  }

  begin(plan: Plan, state: AgentState, percept: Percept) {
    this.observeScope(state);
    this.latestObservation = snapshot(state, percept);
    const intentId = plan.binding?.intentId;
    if (!intentId) this.intentWindow = null;
    else if (this.intentWindow?.intentId !== intentId) this.intentWindow = { intentId, anchor: this.latestObservation,
      seenResourceTypes: new Set(this.latestObservation.knownResourceTypes), consecutiveNoProgressAttempts: 0,
      since: null, lastAttemptAt: null, lastProgressAt: null };
    this.observeIntentEvidence(this.latestObservation);
    this.active = { planId: plan.id, goal: plan.goal.slice(0, 240), before: this.latestObservation };
  }

  /** Turning back toward familiar terrain is not new evidence; discovery is remembered across alternating plans. */
  private observeIntentEvidence(observation: Snapshot, effect?: EffectEvidence): boolean {
    const window = this.intentWindow;
    if (!window) return false;
    if (window.lastAttemptAt !== null && observation.at - window.lastAttemptAt > INTENT_PROGRESS_WINDOW_MS) {
      window.consecutiveNoProgressAttempts = 0; window.since = null;
    }
    if (!observation.observationReady) return false;
    if (!window.anchor.observationReady || !sameScope(window.anchor.scope, observation.scope)) {
      window.anchor = observation; window.seenResourceTypes = new Set(observation.knownResourceTypes);
      window.consecutiveNoProgressAttempts = 0; window.since = null;
      return false;
    }
    const changes = compare(window.anchor, observation);
    const discovered = observation.knownResourceTypes.some((name) => !window.seenResourceTypes.has(name));
    for (const name of observation.knownResourceTypes) window.seenResourceTypes.add(name);
    const progressed = !!(effect?.verified && effect.changed) || (changes.movement?.distance ?? 0) >= .75
      || !!changes.inventoryDelta.length || (changes.newChunks ?? 0) > 0 || discovered;
    if (progressed) {
      window.consecutiveNoProgressAttempts = 0; window.since = null;
      window.lastProgressAt = observation.at; window.anchor = observation;
      if (this.active) this.active.progressObserved = true;
    }
    return progressed;
  }

  end(plan: Plan, status: string, summary: string, state: AgentState, percept: Percept, effectEvidence?: EffectEvidence) {
    this.observeScope(state);
    if (this.active?.planId !== plan.id) return; // Missing baseline is not evidence of no change.
    const before = this.active.before, after = snapshot(state, percept);
    this.latestObservation = after;
    const changes = compare(before, after);
    const valid = before.observationReady && after.observationReady && !changes.scopeChanged;
    const reasons: string[] = [];
    if (valid && (changes.movement?.distance ?? 0) >= 0.75) reasons.push(`实际移动了 ${changes.movement!.distance.toFixed(1)} 格`);
    if (valid && changes.inventoryDelta.length) reasons.push(`背包实际变化：${changes.inventoryDelta.slice(0, 3).map((item) => `${item.item} ${item.delta > 0 ? '+' : ''}${item.delta}`).join('、')}`);
    if (valid && effectEvidence?.verified && effectEvidence.changed) reasons.push(...(effectEvidence.reasons.length ? effectEvidence.reasons : ['技能已通过实际世界观测确认变化']).slice(0, 3).map((reason) => reason.slice(0, 120)));
    const measuredEffect: EffectEvidence = { verified: reasons.length > 0, changed: reasons.length > 0,
      reasons: reasons.length ? reasons : [valid ? '本轮未测到位移、库存或已验证的世界变化；这不证明世界没有变化' : '缺少同一会话的有效前后观测，无法验证实际效果'] };
    const steps = plan.steps.slice(0, Math.max(0, Math.min(plan.steps.length, Math.floor(plan.index))));
    const attempt: Attempt = {
      planId: plan.id, goal: this.active.goal, status, summary: summary.slice(0, 500),
      startedAt: before.at, endedAt: after.at, durationMs: Math.max(0, after.at - before.at),
      stepsStarted: describeSteps(steps), before, after, changes, effectEvidence: measuredEffect,
    };
    this.recent.push({ attempt, pattern: patternKey(steps) });
    if (this.recent.length > 6) this.recent.shift();
    const progressed = this.observeIntentEvidence(after, measuredEffect) || this.active.progressObserved === true;
    if (this.intentWindow && this.intentWindow.intentId === plan.binding?.intentId && valid && steps.length && ['succeeded', 'failed'].includes(status)) {
      if (!progressed) {
        this.intentWindow.consecutiveNoProgressAttempts++;
        this.intentWindow.since ??= before.at;
      }
      this.intentWindow.lastAttemptAt = after.at;
    }
    this.active = null;
    return measuredEffect;
  }

  context(state: AgentState, percept?: Percept) {
    this.observeScope(state);
    if (percept) { this.latestObservation = snapshot(state, percept); this.observeIntentEvidence(this.latestObservation); }
    if (this.intentWindow?.lastAttemptAt != null && Date.now() - this.intentWindow.lastAttemptAt > INTENT_PROGRESS_WINDOW_MS) {
      this.intentWindow.consecutiveNoProgressAttempts = 0; this.intentWindow.since = null;
    }
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
    let unchangedStreak = 0;
    for (let i = recent.length - 1; latest && i >= recent.length - streak; i--) {
      if (!unchanged(recent[i].attempt)) break;
      unchangedStreak++;
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
      intentProgress: this.intentWindow ? { intentId: this.intentWindow.intentId,
        consecutiveNoProgressAttempts: this.intentWindow.consecutiveNoProgressAttempts, since: this.intentWindow.since,
        lastAttemptAt: this.intentWindow.lastAttemptAt, lastProgressAt: this.intentWindow.lastProgressAt, windowMs: INTENT_PROGRESS_WINDOW_MS } : null,
      repeatedStepPattern: latest && streak > 0 ? { steps: latest.attempt.stepsStarted, consecutiveAttempts: streak,
        consecutiveUnchangedAttempts: unchangedStreak } : null,
    });
  }
}

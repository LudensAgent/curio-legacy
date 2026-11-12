import type { Vec3Like } from '../adapter/types.ts';
import type { MovementFailure, MovementTruth } from '../skills/movement/contract.ts';

/**
 * Activity/result/progress/experience/plan contract (batch 0).
 *
 * These are the shapes later batches will write into receipts and prompt facts.
 * They intentionally keep the original delegation, the activity acceptance and
 * the observed effects separate: a completed activity does not prove the
 * delegation completed, and a local action effect does not prove a strategy.
 */

export type StepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
export type ActivityState = 'planned' | 'running' | 'paused' | 'completed' | 'unmet' | 'blocked' | 'cancelled' | 'replaced';
export type DelegationOutcome = 'completed' | 'partial' | 'blocked' | 'cancelled' | 'timeout' | 'budget' | 'residency' | 'unknown';

export type StepTruth = {
  /** Stable within one activity; adjust edits by this id, not by array position. */
  stepId: string;
  skill: string;
  args: Record<string, unknown>;
  state: StepState;
  /** What was asked of this step (distance/target/block), when applicable. */
  request?: unknown;
  /** What is actually confirmed while it runs. */
  progress?: unknown;
};

export type DoneWhenTruth = {
  /** Human-readable contract; the raw condition lives on the activity. */
  spec: string;
  /** `between_steps` means it cannot cancel the step that is still running. */
  evaluatedAt: 'between_steps';
  satisfied: boolean;
  actual: unknown;
};

export type ActivityTruth = {
  activityId: string;
  outcomeId?: string;
  methodId?: string;
  state: ActivityState;
  steps: readonly StepTruth[];
  doneWhen?: DoneWhenTruth;
  acceptance?: { conditions: unknown; satisfied: boolean; evidence: unknown };
  /** Present when the activity delegates a navigation/movement action. */
  delegation?: MovementTruth;
  continueEffect?: string;
  stopEffect?: string;
  originalIntent?: {
    goal: unknown;
    dim: string;
    frozenOrigin?: Vec3Like;
    authorization?: unknown;
    budget?: unknown;
    remaining?: unknown;
  };
};

export type ResultTruth = {
  effects: {
    moved: boolean;
    dug: readonly Vec3Like[];
    placed: readonly { name: string; pos: Vec3Like }[];
    interacted: readonly string[];
  };
  costs: {
    itemsGained: Readonly<Record<string, number>>;
    itemsLost: Readonly<Record<string, number>>;
    durability?: number;
    food?: number;
    hp?: number;
    onlineMs?: number;
  };
  acceptance: { conditions: unknown; actual: unknown; satisfied: boolean };
  delegation: DelegationOutcome;
  /** Goals/parts that this run did not confirm either way. */
  unknown: readonly string[];
};

export type ProgressLedgerEntry = {
  /** Stable outcome id, aligned with PlanTruth outcomes. */
  targetId: string;
  spatial: {
    newChunks: number;
    newObservedCells: number;
    farthest?: number;
    repeatVisits: number;
  };
  movement: {
    pathLength: number;
    netDisplacement: number;
    alongIntent?: number;
  };
  execution: {
    completed: number;
    blocked: number;
    interrupted: number;
    reasons: Readonly<Record<string, number>>;
  };
  cost: {
    onlineMs: number;
    durability?: number;
    blocks?: number;
    food?: number;
    hp?: number;
  };
  items: {
    explicitTargets: Readonly<Record<string, number>>;
    sideProducts: Readonly<Record<string, number>>;
  };
};

export type ExperienceTruth = {
  id: string;
  claim: string;
  version: number;
  conditions: unknown;
  /** Activity/step/result refs that actually support this claim. */
  evidence: readonly string[];
  /** What this claim verified and what remains unverified. */
  verified: readonly string[];
  unverified: readonly string[];
  counterexamples: readonly { ref: string; why: string }[];
  limits: readonly string[];
  applications: readonly { ref: string; outcome: string; at: number }[];
};

export type PlanTruth = {
  outcomes: readonly {
    outcomeId: string;
    text: string;
    status: 'open' | 'done' | 'dropped';
    evidence?: unknown;
  }[];
  methods: readonly {
    methodId: string;
    outcomeId: string;
    text: string;
    status: 'active' | 'paused' | 'dropped';
    attempts: number;
    stopReasons: Readonly<Record<string, number>>;
  }[];
  attempts: readonly {
    methodId: string;
    where?: Vec3Like;
    whatHappened: string;
    whyStopped?: string;
    at: number;
  }[];
};

/** A movement failure is a fact, never an automatic decision. */
export type MovementFailureFact = {
  failure: MovementFailure;
  detail: string;
  at: number;
};

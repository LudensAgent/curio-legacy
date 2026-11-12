import type { Vec3Like } from '../../adapter/types.ts';
import type { LandSearchStatus } from '../../spatial/land-search.ts';
import type { SegmentOutcome } from './segment.ts';
import type { StopReason } from './session.ts';

/**
 * Movement contract (batch 0).
 *
 * One place to name *why* a movement stopped, so search, segment, coordinator
 * and body control do not each invent their own "no path" vocabulary. The
 * mapping here is descriptive; callers still own execution and the Agent still
 * owns the decision. Batch 2 wires these values into receipts/prompt facts.
 */
export type MovementFailure =
  /** Current evidence is missing/unobserved: observe more before concluding. */
  | 'NO_PATH_EVIDENCE'
  /** Recorded geometry has no walk/step/drop route (observed, not an evidence gap). */
  | 'NO_PATH_GEOMETRY'
  /** Authorization/policy/allowed-kind/corridor excludes otherwise open edges. */
  | 'DELEGATION_RESTRICTION'
  /** Body control cannot complete an already-proven transition (step/jump/ladder/drop). */
  | 'BODY_CAPABILITY'
  /** Search/step/observation/material/deadline budget was exhausted. */
  | 'BUDGET'
  /** Required cold section is not resident/loading/load-failed. */
  | 'RESIDENCY'
  /** Evidence changed while searching; the candidate is stale, not terrain. */
  | 'INVALIDATED'
  /** A bounded number of segments produced no confirmed movement or related evidence. */
  | 'NO_PROGRESS'
  | 'CANCELLED'
  | 'TIMEOUT'
  /** Search and verification disagree under the same evidence/position/authorization. */
  | 'CONFLICT'
  /** Target cannot be resolved (portal/landmark/death/support/height). */
  | 'TARGET_UNRESOLVED'
  | 'SCOPE_CHANGED'
  | 'INTENT_MISMATCH'
  | 'SUPERSEDED'
  /** A real execution/program error that is not classified yet. */
  | 'UNKNOWN';

export type SearchFailureContext = {
  policyRejectedEdges?: number;
  corridorLimited?: boolean;
  unavailableSections?: number;
};

export type SegmentFailureContext = {
  /** `undefined` until Batch 2 threads the library problem kind through receipts. */
  problemKind?: string;
  policyRejectedEdges?: number;
  disallowed?: boolean;
  modeGap?: boolean;
};

const SEARCH_FAILURE: Record<LandSearchStatus, MovementFailure | null> = {
  FOUND: null,
  INSUFFICIENT_EVIDENCE: 'NO_PATH_EVIDENCE',
  NO_PATH_IN_MEMORY: 'NO_PATH_GEOMETRY',
  UNSUPPORTED: 'TARGET_UNRESOLVED',
  INVALIDATED: 'INVALIDATED',
  BUDGET_EXHAUSTED: 'BUDGET',
  CANCELLED: 'CANCELLED',
};

/** Map one library search terminal state. Context refines UNSUPPORTED without hiding it. */
export function movementFailureOfSearch(status: LandSearchStatus, context: SearchFailureContext = {}): MovementFailure | null {
  if (status !== 'UNSUPPORTED') return SEARCH_FAILURE[status];
  if ((context.policyRejectedEdges ?? 0) > 0 || context.corridorLimited === true) return 'DELEGATION_RESTRICTION';
  if ((context.unavailableSections ?? 0) > 0) return 'RESIDENCY';
  return 'TARGET_UNRESOLVED';
}

const SEGMENT_FAILURE: Record<SegmentOutcome, MovementFailure | null> = {
  reached_waypoint: null,
  sighting: null,
  partial_prefix: null,
  replan: null,
  unknown_boundary: 'NO_PATH_EVIDENCE',
  blocked: 'NO_PATH_GEOMETRY',
  no_path: 'NO_PATH_GEOMETRY',
  invalidated: 'INVALIDATED',
  corridor_exhausted: 'DELEGATION_RESTRICTION',
  lateral_authorization: 'DELEGATION_RESTRICTION',
  unsupported: 'TARGET_UNRESOLVED',
  physical_failure: 'BODY_CAPABILITY',
  disallowed: 'DELEGATION_RESTRICTION',
  search_budget: 'BUDGET',
  residency_not_ready: 'RESIDENCY',
  cancelled: 'CANCELLED',
  timeout: 'TIMEOUT',
};

/** Map one segment outcome. Body/policy/target sub-kinds refine `unsupported`. */
export function movementFailureOfSegment(outcome: SegmentOutcome, context: SegmentFailureContext = {}): MovementFailure | null {
  if (outcome !== 'unsupported') return SEGMENT_FAILURE[outcome];
  if (context.disallowed === true || context.modeGap === true || (context.policyRejectedEdges ?? 0) > 0) return 'DELEGATION_RESTRICTION';
  if (context.problemKind === 'UNSUPPORTED_ENVIRONMENT') return 'BODY_CAPABILITY';
  return 'TARGET_UNRESOLVED';
}

const STOP_FAILURE: Record<StopReason, MovementFailure | null> = {
  DISTANCE_MET: null,
  REGION_ENTERED: null,
  UNTIL_SEEN: null,
  ARRIVED: null,
  UNKNOWN_BOUNDARY: 'NO_PATH_EVIDENCE',
  BLOCKED: 'NO_PATH_GEOMETRY',
  TARGET_UNRESOLVED: 'TARGET_UNRESOLVED',
  ROUTE_INVALIDATED: 'INVALIDATED',
  NO_PATH: 'NO_PATH_GEOMETRY',
  RESIDENCY_NOT_READY: 'RESIDENCY',
  PHYSICAL_FAILURE: 'BODY_CAPABILITY',
  ACTION_FAILURE: 'UNKNOWN',
  MODE_GAP: 'DELEGATION_RESTRICTION',
  NO_PROGRESS: 'NO_PROGRESS',
  LATERAL_DRIFT: 'DELEGATION_RESTRICTION',
  DETOUR_TOO_LARGE: 'DELEGATION_RESTRICTION',
  BUDGET_EXHAUSTED: 'BUDGET',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  SCOPE_CHANGED: 'SCOPE_CHANGED',
  INTENT_MISMATCH: 'INTENT_MISMATCH',
  SUPERSEDED: 'SUPERSEDED',
};

/** Map a coordinator/session stop reason. Success reasons map to null. */
export function movementFailureOfStop(reason: StopReason): MovementFailure | null {
  return STOP_FAILURE[reason];
}

/**
 * Classify a body-control error/message. Only already-known error shapes are
 * classified; everything else stays UNKNOWN instead of becoming "no path".
 */
export function movementFailureOfError(error: unknown): MovementFailure {
  const name = String((error as { name?: unknown } | null)?.name ?? '');
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? '');
  if (name === 'AbortedError' || /aborted|cancell?ed/i.test(message)) return 'CANCELLED';
  if (/TIMEOUT|TimeoutError|deadline/i.test(message)) return 'TIMEOUT';
  if (/CHECKPOINT_PASSED|NOT_CONFIRMED|EFFECT_NOT_CONFIRMED|STATE_UNCHANGED|INVENTORY_UNCHANGED|NO_PLACEMENT_FACE|LOW_HP/i.test(message)) return 'BODY_CAPABILITY';
  if (/CORRIDOR_VIOLATION|PORTAL_CELL|NAVIGATION_UNAVAILABLE|MODE_GAP|BAD_ARGS/i.test(message)) return 'DELEGATION_RESTRICTION';
  if (/NOT_CONNECTED|WRONG_DIMENSION/i.test(message)) return 'SCOPE_CHANGED';
  return 'UNKNOWN';
}

/** Transition as the search, verification and execution should describe it. */
export type TransitionTruth = {
  kind: 'walk' | 'step' | 'drop' | 'jump' | 'ladder';
  from: Vec3Like;
  to: Vec3Like;
  drop: number;
  /** Present when the transition came from a bounded search. */
  cost?: number;
  hazards?: readonly unknown[];
};

/** Shared frozen delegation facts; callers may carry extra evidence in later batches. */
export type MovementTruth = {
  scope: { worldId: string; dim: string; sessionId: string };
  target: {
    kind: 'coords' | 'landmark' | 'portal' | 'death' | 'direction' | 'feet';
    request: Vec3Like | string;
    dim: string;
    frozenOrigin?: Vec3Like;
  };
  arrival?: { radius: number; metric: '3d' | 'horizontal'; coordinates?: 'continuous' | 'cell' };
  authorization: { allowedKinds: readonly TransitionTruth['kind'][]; historical: boolean; dig?: boolean; place?: string; maxEdits?: number };
  rulesVersion: string;
  policyVersion?: string;
  budget: { steps: number; searches: number; observations: number; observedCells: number; transitions: number; deadline: number };
  progress?: { confirmedTransitions: number; pathLength: number; horizontal: number; vertical: number; net: number; farthest?: number };
  status: 'searching' | 'executing' | 'blocked' | 'cancelled' | 'completed' | 'partial' | 'conflict';
  stop?: { failure: MovementFailure; detail: string; at: number; boundary?: unknown; transition?: TransitionTruth };
};

import type { Vec3Like } from '../adapter/types.ts';

export type Condition =
  | { type: 'inventory_min'; item: string; count: number }
  | { type: 'location_near'; dimension: string; pos: Vec3Like; radius: number; landmarkId?: string }
  | { type: 'self_state'; field: 'held' | 'riding'; equals: string | null }
  | { type: 'self_state'; field: 'inWater' | 'inLava' | 'onGround'; equals: boolean }
  | { type: 'sky_visible'; equals: boolean }
  | { type: 'underground'; equals: boolean }
  | { type: 'equipment'; slot: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'; item: string | null }
  | { type: 'block_state'; dimension: string; pos: Vec3Like; name?: string; properties?: Record<string, string | number | boolean> }
  | { type: 'all_of'; conditions: Condition[] };

export type EvidenceStatus = 'satisfied' | 'unsatisfied' | 'unknown';

export interface Evidence {
  id: string;
  projectId: string;
  revision: number;
  milestoneId?: string;
  condition: Condition;
  sessionId: string;
  observationId: string | number;
  worldId: string;
  ts: number;
  source: 'adapter.state' | 'adapter.state+vision';
  actual: unknown;
  status: EvidenceStatus;
  reason?: string;
}

export interface Milestone {
  id: string;
  title: string;
  condition: Condition;
  completedAt?: number;
  evidenceId?: string;
}

export type ProjectStatus = 'undecomposed' | 'active' | 'paused' | 'deferred' | 'blocked' | 'completed' | 'cancelled';
export type PauseReason = 'user' | 'reflex' | 'disconnected' | 'death' | 'dead' | 'restart' | 'model_unavailable' | 'world_changed';

export interface Project {
  id: string;
  intentId: string;
  title: string;
  revision: number;
  worldId: string;
  status: ProjectStatus;
  successCondition: Condition;
  milestones: Milestone[];
  currentMilestone: number;
  noProgressAttempts: number;
  pauseReasons: PauseReason[];
  checkpoint: { ts: number; reason: string; observationId?: string | number; evidenceId?: string };
  lastEvidenceId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSpec {
  intentId: string;
  title: string;
  successCondition: Condition;
  milestones?: { id?: string; title: string; condition: Condition }[];
}

/** Identity only: routine observations do not change the specification revision. */
export interface Binding {
  intentId?: string;
  projectId?: string;
  revision?: number;
  milestoneId?: string;
}

export interface ConditionResult {
  status: EvidenceStatus;
  actual: unknown;
  reason?: string;
}

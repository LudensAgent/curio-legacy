export type IntentStatus = 'open' | 'active' | 'deferred' | 'ended';

export interface Preference {
  id: string;
  text: string;
  source: 'user' | 'inferred';
  support: string[];
  counterexamples: string[];
  adjustmentReason: string;
  createdAt: number;
  updatedAt: number;
}

export interface Intent {
  id: string;
  text: string;
  whyNow: string;
  context: string[];
  tradeoffs: string[];
  status: IntentStatus;
  createdAt: number;
  updatedAt: number;
  endReason?: string;
  source: 'model' | 'user' | 'legacy';
}

export type DecisionKind = 'begin' | 'continue' | 'change_method' | 'revise' | 'defer' | 'abandon' | 'complete';

/** A choice or subjective assessment. It never substitutes for world evidence. */
export interface Decision {
  id: string;
  kind: DecisionKind;
  reason: string;
  context: string[];
  intentId?: string;
  projectId?: string;
  ts: number;
}

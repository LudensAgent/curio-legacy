export interface MemoryEpisode {
  id: string;
  ts: number;
  worldId: string;
  dimension: string;
  kind: 'experience' | 'inference';
  source: string;
  text: string;
}

export interface MemoryEntry {
  id: string;
  text: string;
  source: string;
  observedAt?: string;
  mentionedAt?: string;
  kind?: string;
  worldId?: string;
  dimension?: string;
  historical?: boolean;
}

export interface RecallRequest {
  query: string;
  worldId: string;
  dimension: string;
  /** Optional sink for a bounded server-side request id when the backend response exposes one. */
  onRequestId?: (id: string | undefined) => void;
}

/** Body-free memory service failure: the error type and HTTP status are enough to diagnose, the body is never kept. */
export interface RecallFailure {
  type: string;
  status?: number;
}

/** Additive, body-free recall observability. Kept out of `MemoryContext` so the context byte budget is unchanged. */
export interface RecallDiagnostics {
  backend: 'local' | 'hindsight' | 'unavailable';
  /** Bounded server-supplied id from the opt-in recall trace; omitted when the response has none. */
  requestId?: string;
  elapsedMs: number;
  /** True only when a remote attempt failed and local recall answered instead. */
  degraded: boolean;
  /** Memories returned by the retrieval that produced this context, before the JSON byte budget. */
  hits: number;
  /** IDs selected into `MemoryContext.memories` (what a consumer may inject; not proof it reached the prompt). */
  memoryIds: string[];
  /** Bounded reason slugs for trimmed/dropped memories (budget, dedup, scope, ...), never memory text. */
  dropped: string[];
  error?: RecallFailure;
  /** Why the remote backend was not used even though it was enabled. */
  fallback?: 'empty' | 'cooldown' | 'in_flight';
}

export interface MemoryContext {
  source: 'local' | 'hindsight' | 'unavailable';
  query: string;
  memories: MemoryEntry[];
}

export interface MemoryBackend {
  retain(episode: MemoryEpisode, signal: AbortSignal): Promise<void>;
  recall(request: RecallRequest, signal: AbortSignal): Promise<MemoryEntry[]>;
  /** 删除整个专属 bank，并确认没有可读取的记忆。 */
  clear(signal: AbortSignal): Promise<void>;
}

export interface MemorySettings {
  provider: 'local' | 'hindsight';
  worldId: string;
  agentId: string;
  baseUrl: string;
  apiKey: string;
  bankId: string;
  timeoutMs: number;
  retainTimeoutMs?: number;
  maxContextBytes: number;
}

export interface MemoryRecall {
  recall(context: {
    percept: { self: { dim: string; pos: [number, number, number] }; objective: string | null; nearby: unknown };
    lastFailure: unknown;
    userSuggestion: string | null;
  }, query?: string): Promise<MemoryContext>;
}

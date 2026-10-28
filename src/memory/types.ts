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

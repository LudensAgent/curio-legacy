import { HindsightClient, HindsightError, createClient, createConfig, sdk, type Client, type RecallResult } from '@vectorize-io/hindsight-client';
import type { MemoryBackend, MemoryEntry, MemoryEpisode, MemorySettings, RecallRequest } from './types.ts';

const MAX_RESULTS = 8;
const MAX_TEXT = 800;

function scopeTags(worldId: string, dimension: string): string[] {
  if (!worldId.trim() || !dimension.trim()) throw new Error('Memory recall requires a world and dimension');
  return [`world:${worldId}`, `dimension:${dimension}`];
}

function bounded(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Keep SDK response bodies (which may contain server configuration) out of logs. */
function requestError(operation: string, error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted();
  const status = error instanceof HindsightError ? error.statusCode : undefined;
  throw new Error(`Hindsight ${operation} failed${status ? ` (HTTP ${status})` : ''}`);
}

/** Hindsight stores the long history; only a bounded, scoped recollection leaves this adapter. */
export class HindsightBackend implements MemoryBackend {
  private readonly client: HindsightClient;
  private readonly rawClient: Client;
  private readonly bankId: string;

  constructor(settings: Pick<MemorySettings, 'baseUrl' | 'apiKey' | 'bankId'>) {
    if (!settings.bankId.trim()) throw new Error('Hindsight requires a dedicated memory bank');
    this.bankId = settings.bankId;
    this.client = new HindsightClient({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey || undefined,
      userAgent: 'minecraftllm/0.3.0',
      // The caller owns the timeout/fallback policy; do not add hidden retry delays.
      maxAttempts: 1,
    });
    this.rawClient = createClient(createConfig({
      baseUrl: settings.baseUrl,
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
    }));
  }

  async retain(episode: MemoryEpisode, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const observedAt = new Date(episode.ts).toISOString();
    const scope = scopeTags(episode.worldId, episode.dimension);
    const interpretation = episode.kind === 'inference'
      ? 'Agent inference or hypothesis. It may be wrong; do not promote it to an observed fact.'
      : 'First-person gameplay experience, limited to what the agent observed or did.';
    try {
      const result = await this.client.retain(this.bankId, `${interpretation}\n${episode.text.slice(0, 8000)}`, {
        async: false,
        signal,
        timestamp: observedAt,
        documentId: episode.id,
        updateMode: 'replace',
        context: `${episode.kind}; source=${episode.source}; world=${episode.worldId}; dimension=${episode.dimension}`,
        metadata: {
          episode_id: episode.id,
          source: episode.source,
          kind: episode.kind,
          observed_at: observedAt,
          world_id: episode.worldId,
          dimension: episode.dimension,
        },
        tags: [...scope, `source:${episode.source}`, `kind:${episode.kind}`, `time:${observedAt}`],
        // Consolidate across episodes inside this world/dimension, never across worlds.
        observationScopes: [scope],
      });
      signal.throwIfAborted();
      if (!result.success || result.async) throw new Error('Synchronous retention was not completed');
    } catch (error) {
      requestError('retain', error, signal);
    }
  }

  async recall(request: RecallRequest, signal: AbortSignal): Promise<MemoryEntry[]> {
    signal.throwIfAborted();
    const scope = scopeTags(request.worldId, request.dimension);
    try {
      const response = await this.client.recall(this.bankId, request.query.slice(0, 1200), {
        signal,
        budget: 'low',
        maxTokens: 1200,
        tags: scope,
        tagsMatch: 'all_strict',
        preferObservations: true,
        includeEntities: false,
        includeChunks: false,
        includeSourceFacts: false,
      });
      signal.throwIfAborted();
      if (!Array.isArray(response.results)) throw new Error('Invalid memory response');
      const seen = new Set<string>();
      return response.results
        // Recheck the isolation boundary even if a proxy/server ignores tags_match.
        .filter(result => Array.isArray(result.tags) && scope.every(tag => result.tags!.includes(tag)))
        .filter(result => typeof result.id === 'string' && !!result.id && typeof result.text === 'string' && !!result.text.trim())
        .filter(result => !seen.has(result.id) && !!seen.add(result.id))
        .slice(0, MAX_RESULTS)
        .map(result => this.entry(result));
    } catch (error) {
      return requestError('recall', error, signal);
    }
  }

  private entry(result: RecallResult): MemoryEntry {
    const metadata = result.metadata;
    const observedAt = metadata?.observed_at || result.occurred_start || result.mentioned_at;
    return {
      id: bounded(result.id, 160),
      text: bounded(result.text, MAX_TEXT),
      source: bounded(metadata?.source || result.document_id || 'hindsight:consolidation', 160),
      ...(observedAt ? { observedAt: bounded(observedAt, 64) } : {}),
      // Consolidated observations are interpretations, not fresh gameplay evidence.
      kind: result.type === 'observation' || metadata?.kind === 'inference' || result.tags?.includes('kind:inference')
        ? 'inference'
        : metadata?.kind === 'experience' || result.type === 'experience' ? 'experience' : 'inference',
    };
  }

  async clear(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      // The high-level SDK deleteBank loses HTTP status. The official generated
      // primitive preserves it, so only a real 404 can count as already absent.
      const deleted = await sdk.deleteBank({ client: this.rawClient, path: { bank_id: this.bankId }, signal });
      signal.throwIfAborted();
      if (deleted.response?.status !== 404 && (!deleted.response?.ok || deleted.data?.success !== true)) {
        throw new HindsightError('Bank deletion failed', deleted.response?.status);
      }

      // Read-only bank listing does not recreate the deleted bank. Search is a
      // substring search, so inspect every returned page and compare exact IDs.
      const limit = 100;
      for (let offset = 0; offset < 10000; offset += limit) {
        const listed = await sdk.listBanks({
          client: this.rawClient,
          query: { q: this.bankId, limit, offset },
          signal,
        });
        signal.throwIfAborted();
        if (!listed.response?.ok || !Array.isArray(listed.data?.banks)) {
          throw new HindsightError('Bank deletion verification failed', listed.response?.status);
        }
        if (listed.data.banks.some(bank => bank.bank_id === this.bankId)) {
          throw new Error('Memory bank still exists after deletion');
        }
        if (listed.data.banks.length < limit) return;
      }
      throw new Error('Bank deletion could not be fully verified');
    } catch (error) {
      requestError('clear', error, signal);
    }
  }
}

/**
 * 角色档案用的 bank 操作：整份导出成 zip、从 zip 恢复到一个还不存在的 bank、检查和清除 bank。
 * 导出不调 LLM；恢复时服务端要重新算向量（不调 LLM 抽取事实），在后台跑，这里等它做完。
 */
export function hindsightBankOps(settings: Pick<MemorySettings, 'baseUrl' | 'apiKey'>, opts: { timeoutMs?: number } = {}) {
  const client = new HindsightClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey || undefined, userAgent: 'minecraftllm/0.3.0', maxAttempts: 1 });
  const raw = createClient(createConfig({ baseUrl: settings.baseUrl, headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {} }));
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  return {
    async remove(bankId: string): Promise<void> {
      await new HindsightBackend({ ...settings, bankId }).clear(AbortSignal.timeout(timeoutMs));
    },
    async exists(bankId: string): Promise<boolean> {
      const limit = 100;
      for (let offset = 0; offset < 10000; offset += limit) {
        const listed = await sdk.listBanks({ client: raw, query: { q: bankId, limit, offset }, signal: AbortSignal.timeout(30_000) });
        if (!listed.response?.ok || !Array.isArray(listed.data?.banks)) throw new HindsightError('Bank listing failed', listed.response?.status);
        if (listed.data.banks.some((bank) => bank.bank_id === bankId)) return true;
        if (listed.data.banks.length < limit) return false;
      }
      return false;
    },
    async exportTo(bankId: string, file: string): Promise<number> {
      const bytes = await client.exportBank(bankId, { includeData: true, includeBankConfig: true, includeHistory: false, timeoutMs, signal: AbortSignal.timeout(timeoutMs + 30_000) });
      const fs = await import('node:fs');
      fs.writeFileSync(file, bytes);
      return bytes.byteLength;
    },
    async importFrom(file: string, bankId: string): Promise<void> {
      const fs = await import('node:fs');
      const archive = new Blob([fs.readFileSync(file)], { type: 'application/zip' });
      const operationId = await client.importBank(bankId, archive, { targetBankId: bankId, includeData: true, includeBankConfig: true, signal: AbortSignal.timeout(120_000) });
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const st = await sdk.getOperationStatus({ client: raw, path: { bank_id: bankId, operation_id: operationId }, signal: AbortSignal.timeout(30_000) });
        const status = st.data?.status;
        if (status === 'completed') return;
        if (status === 'failed' || status === 'cancelled' || status === 'not_found') throw new Error(`Hindsight 恢复没成（${status}）`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error('Hindsight 恢复超时（还在后台跑的话，过一会儿再看）');
    },
  };
}

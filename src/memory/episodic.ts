import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentState } from '../adapter/types.ts';
import { EventBus, type AgentEvent } from '../events.ts';
import type { WorldMemory } from './store.ts';
import { registerMemoryBackend } from './registry.ts';
import type { MemoryBackend, MemoryContext, MemoryEntry, MemoryEpisode, MemoryRecall, MemorySettings } from './types.ts';

type RecallContext = Parameters<MemoryRecall['recall']>[0];
interface PendingEpisode { episode: MemoryEpisode; attempts: number; nextAttemptAt: number }
interface Candidate { entry: MemoryEntry; ts: number; dimension?: string; worldId?: string; searchText?: string }
interface HistoricalScope { id?: string; worldId?: string; dimension?: string }
interface MemoryExtensions {
  currentIntent?: () => { text: string } | undefined;
  lessons?: (limit?: number) => { ts: number; text: string }[];
}
const EXPERIENCE_EVENTS = new Set(['discovery', 'death', 'attempt_end', 'goal_end', 'built']);
const INFERENCE_EVENTS = new Set(['lesson', 'objective', 'skill_learned']);
const ARCHIVE_WINDOW = 2000;
const ARCHIVE_TAIL_BYTES = 8 * 1024 * 1024;
const LEGACY_WARNING = '[legacy; world unknown; verify coordinates/resources in the current world] ';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

// Chinese bigrams retain useful associations without requiring another model call.
function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) ?? [];
  return new Set(words.flatMap((word) => /\p{Script=Han}/u.test(word)
    ? Array.from({ length: Math.max(1, word.length - 1) }, (_, i) => word.slice(i, i + 2)) : [word]));
}

/** Associative recall supplements authoritative WorldMemory; remembered claims are historical evidence. */
export class EpisodicMemory implements MemoryRecall {
  private readonly archiveFile: string;
  private readonly outboxFile: string;
  private archive: MemoryEpisode[] = [];
  private archiveIds = new Set<string>();
  private queue: PendingEpisode[] = [];
  private started = false;
  private generation = 0;
  private timer: NodeJS.Timeout | null = null;
  private drainingGeneration: number | null = null;
  private controllers = new Set<AbortController>();
  private recallGeneration: number | null = null;
  private nextRecallAt = 0;
  private recallFailures = 0;
  private lastWarningAt = 0;
  private registered = false;
  private writable = true;
  private lastError: string | null = null;
  private listener = (event: AgentEvent) => this.observe(event);

  constructor(
    private settings: MemorySettings,
    private memory: WorldMemory,
    private bus: EventBus,
    private getState: () => AgentState,
    private dataDir: string,
    private backend?: MemoryBackend,
  ) {
    const namespace = hash(`${settings.worldId}\n${settings.agentId}`).slice(0, 24);
    const backendNamespace = hash(`${namespace}\n${settings.baseUrl}\n${settings.bankId}`).slice(0, 24);
    this.archiveFile = path.join(dataDir, 'memory', `episodes-${namespace}.jsonl`);
    this.outboxFile = path.join(dataDir, 'memory', `outbox-${backendNamespace}.json`);
    this.load();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.generation++;
    this.bus.on('event', this.listener);
    this.scheduleDrain();
  }

  /** Stop is synchronous: the game never waits for a memory service to shut down. */
  stop(): void {
    this.started = false;
    this.generation++;
    this.bus.off('event', this.listener);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.persistQueue();
  }

  snapshot() {
    return { provider: this.settings.provider, started: this.started, queued: this.queue.length,
      archived: this.archive.length, lastError: this.lastError };
  }

  private warn(message: string): void {
    this.lastError = message;
    if (Date.now() - this.lastWarningAt < 60_000) return;
    this.lastWarningAt = Date.now();
    this.bus.publish('memory_status', 'P2', message);
  }

  private load(): void {
    try {
      if (fs.existsSync(this.archiveFile)) {
        // Keep startup I/O and the local working set bounded; the complete journal stays on disk.
        const file = fs.openSync(this.archiveFile, 'r');
        let tail: string;
        let offset = 0;
        try {
          const length = fs.fstatSync(file).size;
          offset = Math.max(0, length - ARCHIVE_TAIL_BYTES);
          const buffer = Buffer.alloc(Math.min(length, ARCHIVE_TAIL_BYTES));
          fs.readSync(file, buffer, 0, buffer.length, offset);
          tail = buffer.toString('utf8');
        } finally { fs.closeSync(file); }
        if (offset > 0) tail = tail.slice(tail.indexOf('\n') + 1);
        this.archive = tail.split(/\r?\n/).filter(Boolean).slice(-ARCHIVE_WINDOW).map((line) => JSON.parse(line));
        if (this.archive.some((episode) => !this.validEpisode(episode))) throw new Error('Invalid episode archive');
        this.archiveIds = new Set(this.archive.map((episode) => episode.id));
      }
      if (fs.existsSync(this.outboxFile)) {
        const saved = JSON.parse(fs.readFileSync(this.outboxFile, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.items) || saved.items.some((p: PendingEpisode) =>
          !this.validEpisode(p.episode) || !Number.isFinite(p.attempts) || p.attempts < 0 || !Number.isFinite(p.nextAttemptAt))) {
          throw new Error('Invalid memory outbox');
        }
        this.queue = saved.items;
      }
    } catch {
      // Preserve corrupt files for inspection instead of silently overwriting undelivered history.
      this.writable = false;
      this.queue = [];
      this.warn('记忆归档或待写队列无法读取；本次使用本地结构化记忆，保留原文件。');
    }
  }

  private validEpisode(episode: MemoryEpisode): boolean {
    return !!episode && typeof episode.id === 'string' && Number.isFinite(episode.ts)
      && typeof episode.worldId === 'string' && typeof episode.dimension === 'string'
      && ['experience', 'inference'].includes(episode.kind) && typeof episode.source === 'string' && typeof episode.text === 'string';
  }

  private persistQueue(): boolean {
    if (!this.writable || !this.remoteEnabled()) return false;
    try {
      fs.mkdirSync(path.dirname(this.outboxFile), { recursive: true });
      fs.writeFileSync(this.outboxFile + '.tmp', JSON.stringify({ version: 1, items: this.queue }), 'utf8');
      fs.renameSync(this.outboxFile + '.tmp', this.outboxFile);
      return true;
    } catch {
      this.warn('记忆待写队列未能保存；暂缓远程写入，继续本地回忆。');
      return false;
    }
  }

  private remoteEnabled(): boolean { return this.settings.provider === 'hindsight' && !!this.backend; }

  private observe(event: AgentEvent): void {
    if (!this.started || (!EXPERIENCE_EVENTS.has(event.type) && !INFERENCE_EVENTS.has(event.type))) return;
    try {
      const state = this.getState();
      // A configured save identity can differ from the adapter's host:port identity.
      const worldId = this.settings.worldId;
      const kind = INFERENCE_EVENTS.has(event.type) ? 'inference' : 'experience';
      const position = [state.pos.x, state.pos.y, state.pos.z].map(Math.round);
      const detail = event.data ? JSON.stringify(event.data).slice(0, 3000) : '';
      const text = `${event.msg.slice(0, 4000)} @ ${state.dim} ${position.join(',')}${detail ? `\n${detail}` : ''}`;
      const episode: MemoryEpisode = {
        id: `mc-${hash(JSON.stringify([this.settings.agentId, worldId, state.dim, event.ts, event.type, text]))}`,
        ts: event.ts, worldId, dimension: state.dim, kind, source: event.type, text,
      };
      if (this.archiveIds.has(episode.id)) return;
      this.archive.push(episode);
      this.archiveIds.add(episode.id);
      if (this.archive.length > ARCHIVE_WINDOW) this.archiveIds.delete(this.archive.shift()!.id);
      if (this.writable) {
        try {
          fs.mkdirSync(path.dirname(this.archiveFile), { recursive: true });
          fs.appendFileSync(this.archiveFile, JSON.stringify(episode) + '\n', 'utf8');
        } catch { this.warn('经历归档未能保存；本次经历仅暂存于内存。'); }
      }
      // 远程记忆（Hindsight）每存一段都要用 LLM 抽取事实、合并观察，记忆越大越贵：
      // 几秒钟就顺利做完的小活只留在本地归档里，远程只存卡住、放弃、做了一分钟以上的，以及发现、死亡、建成
      const d = (event.data ?? {}) as Record<string, unknown>;
      const notable = event.type !== 'attempt_end' || d.outcome !== 'done' || Number(d.durationSec ?? 0) >= 60;
      if (this.remoteEnabled() && this.writable && notable) {
        this.queue.push({ episode: detail.length > 800 ? { ...episode, text: `${event.msg.slice(0, 4000)} @ ${state.dim} ${position.join(',')}\n${detail.slice(0, 800)}` } : episode, attempts: 0, nextAttemptAt: 0 });
        if (this.persistQueue()) this.scheduleDrain();
      }
    } catch { this.warn('记忆事件处理失败；游戏继续运行。'); }
  }

  private scheduleDrain(): void {
    if (!this.started || !this.writable || !this.remoteEnabled() || !this.queue.length || this.drainingGeneration === this.generation) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, this.queue[0].nextAttemptAt - Date.now());
    this.timer = setTimeout(() => { this.timer = null; void this.drain(this.generation); }, Math.min(delay, 2_147_483_647));
    this.timer.unref?.();
  }

  private async drain(generation: number): Promise<void> {
    if (!this.started || generation !== this.generation || !this.queue.length || !this.backend) return;
    this.drainingGeneration = generation;
    const pending = this.queue[0];
    try {
      // A failed disk write must never turn the remote service into the only copy of an episode.
      if (!this.persistQueue()) throw new Error('Memory outbox is not durable');
      if (!this.registered) {
        registerMemoryBackend(this.dataDir, { baseUrl: this.settings.baseUrl, bankId: this.settings.bankId });
        this.registered = true;
      }
      await this.request((signal) => this.backend!.retain(pending.episode, signal), this.settings.retainTimeoutMs ?? 60_000);
      if (!this.started || generation !== this.generation) return;
      this.queue.shift();
      this.persistQueue();
    } catch {
      if (!this.started || generation !== this.generation) return;
      pending.attempts++;
      pending.nextAttemptAt = Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(9, pending.attempts - 1));
      this.persistQueue();
      this.warn('记忆服务暂不可用；经历已进入待写队列，稍后重试。');
    } finally {
      if (this.drainingGeneration === generation) this.drainingGeneration = null;
      if (this.started && generation === this.generation) this.scheduleDrain();
    }
  }

  /** A race also bounds clients that ignore AbortSignal. Every late rejection is handled by Promise.race. */
  private async request<T>(call: (signal: AbortSignal) => Promise<T>, timeoutMs = this.settings.timeoutMs): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abortHandler = () => reject(new Error('Memory request cancelled'));
      controller.signal.addEventListener('abort', abortHandler, { once: true });
      timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    });
    try { return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return call(controller.signal); }), cancelled]); }
    finally {
      if (timer) clearTimeout(timer);
      if (abortHandler) controller.signal.removeEventListener('abort', abortHandler);
      this.controllers.delete(controller);
    }
  }

  private query(context: RecallContext, explicit?: string): string {
    const extensions = this.memory as WorldMemory & MemoryExtensions;
    const parts = [explicit, extensions.currentIntent?.()?.text, context.percept.objective, context.userSuggestion];
    if (context.lastFailure) parts.push(`recent failure: ${JSON.stringify(context.lastFailure)}`);
    parts.push(`nearby resources and situation: ${JSON.stringify(context.percept.nearby)}`);
    return parts.filter(Boolean).join('\n').slice(0, 1800);
  }

  private local(query: string, dimension: string): MemoryEntry[] {
    const m = this.memory;
    const extensions = m as WorldMemory & MemoryExtensions;
    const records: Candidate[] = [
      ...m.recentNotes(60).map((note, i) => {
        const n = note as typeof note & HistoricalScope;
        return { entry: { id: n.id ?? `note:${n.ts}:${i}`, text: `${n.worldId ? '' : LEGACY_WARNING}${n.text}`, source: `${n.worldId ? '' : 'legacy:'}note:${n.kind}`, kind: n.worldId ? n.kind : 'inference', observedAt: new Date(n.ts).toISOString() }, ts: n.ts, dimension: n.dimension, worldId: n.worldId, searchText: n.text };
      }),
      ...(extensions.lessons?.(40) ?? []).map((l, i) => ({ entry: { id: `lesson:${l.ts}:${i}`, text: LEGACY_WARNING + l.text, source: 'legacy:model reflection', kind: 'inference', observedAt: new Date(l.ts).toISOString() }, ts: l.ts, searchText: l.text })),
      ...m.recentGoals(100).map((goal, i) => {
        const g = goal as typeof goal & HistoricalScope;
        return { entry: { id: g.id ?? `goal:${g.ts}:${i}`, text: `${g.worldId ? '' : LEGACY_WARNING}${g.goal} [${g.status}] ${g.summary}`, source: `${g.worldId ? '' : 'legacy:'}goal_end`, kind: g.worldId ? 'experience' : 'inference', observedAt: new Date(g.ts).toISOString() }, ts: g.ts, worldId: g.worldId, dimension: g.dimension, searchText: `${g.goal} ${g.summary}` };
      }),
      ...m.landmarks().map((landmark) => {
        const l = landmark as typeof landmark & HistoricalScope;
        return { entry: { id: `landmark:${l.id}`, text: l.worldId
          ? `${l.label} @ ${l.dim} ${JSON.stringify(l.pos)} (historical location; verify on arrival)`
          : `${l.label} (legacy observation; world and location unverified)`,
        source: l.worldId ? 'landmark' : 'legacy:landmark', kind: l.worldId ? 'experience' : 'inference', observedAt: new Date(l.ts).toISOString() }, ts: l.ts, worldId: l.worldId, dimension: l.dim, searchText: l.label };
      }),
      ...this.archive.map((e) => ({ entry: { id: e.id, text: e.text, source: e.source, kind: e.kind, observedAt: new Date(e.ts).toISOString() }, ts: e.ts, worldId: e.worldId, dimension: e.dimension })),
    ];
    const q = terms(query);
    const now = Date.now();
    const seen = new Set<string>();
    return records.filter((r) => (!r.worldId || r.worldId === this.settings.worldId) && (!r.dimension || r.dimension === dimension))
      .map((r) => {
        const overlap = [...terms(r.searchText ?? r.entry.text)].filter((t) => q.has(t)).length;
        return { ...r, overlap, score: overlap * 10 + 1 / (1 + Math.max(0, now - r.ts) / 86_400_000) };
      })
      .filter((r) => !q.size || r.overlap > 0)
      .sort((a, b) => b.score - a.score)
      .filter((r) => { if (seen.has(r.entry.text)) return false; seen.add(r.entry.text); return true; })
      .slice(0, 20).map((r) => r.entry);
  }

  /** JSON byte budget includes the query, provenance, and all other returned metadata. */
  private bounded(source: MemoryContext['source'], query: string, memories: MemoryEntry[]): MemoryContext {
    const budget = Math.max(64, this.settings.maxContextBytes);
    const result: MemoryContext = { source, query: query.slice(0, 1800), memories: [] };
    while (Buffer.byteLength(result.query, 'utf8') > Math.floor(budget / 4)) result.query = result.query.slice(0, Math.floor(result.query.length / 2));
    while (bytes(result) > budget && result.query.length) result.query = result.query.slice(0, Math.floor(result.query.length / 2));
    for (const candidate of memories) {
      if (!candidate || typeof candidate.text !== 'string' || typeof candidate.id !== 'string' || typeof candidate.source !== 'string') continue;
      const entry: MemoryEntry = { id: candidate.id.slice(0, 200), text: candidate.text.slice(0, 6000), source: candidate.source.slice(0, 100) };
      if (typeof candidate.observedAt === 'string') entry.observedAt = candidate.observedAt.slice(0, 50);
      if (typeof candidate.kind === 'string') entry.kind = candidate.kind.slice(0, 30);
      result.memories.push(entry);
      while (bytes(result) > budget && entry.text.length) entry.text = entry.text.slice(0, Math.floor(entry.text.length * 0.75));
      if (!entry.text.length || bytes(result) > budget) result.memories.pop();
    }
    return result;
  }

  async recall(context: RecallContext, explicitQuery?: string): Promise<MemoryContext> {
    let query = '';
    try {
      query = this.query(context, explicitQuery);
      const dimension = context.percept.self.dim;
      if (this.started && this.remoteEnabled() && this.recallGeneration !== this.generation && Date.now() >= this.nextRecallAt) {
        const generation = this.generation;
        this.recallGeneration = generation;
        try {
          const memories = await this.request((signal) => this.backend!.recall({ query, worldId: this.settings.worldId, dimension }, signal));
          if (generation === this.generation && this.started) {
            this.recallFailures = 0;
            this.nextRecallAt = 0;
            if (memories.length) return this.bounded('hindsight', query, memories);
          }
        } catch {
          if (generation === this.generation) {
            this.recallFailures++;
            this.nextRecallAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(6, this.recallFailures - 1));
            this.warn('记忆检索暂不可用；使用当前情境相关的本地回忆。');
          }
        } finally { if (this.recallGeneration === generation) this.recallGeneration = null; }
      }
      return this.bounded('local', query, this.local(query, dimension));
    } catch {
      return this.bounded('unavailable', query, []);
    }
  }
}

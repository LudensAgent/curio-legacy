import fs from 'node:fs';
import path from 'node:path';
import type { Vec3Like } from '../adapter/types.ts';
import { applyContents, type ChestContents, type ChestRecord, type ChestUse, type Clock } from './chest-memory.ts';
import type { FurnaceRecord } from './store.ts';

/**
 * The host-owned exact container ledger.
 *
 * The spatial library stores anchors and reachability evidence only; it does not
 * interpret inventories (`containerContents` is a permanent host_ledger gap).
 * Chest contents, opening counters and furnace state therefore live here, next
 * to the non-spatial WorldMemory facts, and are joined to library nodes by the
 * node id / dimension / position recorded on each entry.
 */
export interface ContainerEntry extends ChestRecord {
  worldId: string;
  /** Spatial anchor node this ledger row belongs to. */
  nodeId?: string;
}

export interface FurnaceEntry extends FurnaceRecord {
  worldId: string;
  nodeId?: string;
}

interface LedgerData {
  version: 1;
  chestOps: Record<string, number>;
  chests: Record<string, ContainerEntry>;
  furnaces: Record<string, FurnaceEntry>;
}

const empty = (): LedgerData => ({ version: 1, chestOps: {}, chests: {}, furnaces: {} });
const clone = <T>(value: T): T => structuredClone(value);

export class ContainerLedger {
  private data: LedgerData = empty();
  private dirty = false;
  private readonly worldId: string;

  constructor(private readonly file: string | null, worldId: string) {
    this.worldId = worldId;
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LedgerData>;
        this.data = {
          version: 1,
          chestOps: parsed.chestOps && typeof parsed.chestOps === 'object' ? { ...parsed.chestOps } : {},
          chests: parsed.chests && typeof parsed.chests === 'object' ? { ...parsed.chests } : {},
          furnaces: parsed.furnaces && typeof parsed.furnaces === 'object' ? { ...parsed.furnaces } : {},
        };
      } catch {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
        this.data = empty();
      }
    }
  }

  get world(): string { return this.worldId; }

  private key(dim: string, pos: Vec3Like) {
    return `${this.worldId}:${dim}:${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
  }

  chestClock(day?: number): Clock {
    return { day, now: Date.now(), op: this.data.chestOps[this.worldId] ?? 0 };
  }

  noteChestUse(dim: string, pos: Vec3Like, use: ChestUse, nodeId?: string): ContainerEntry {
    const k = this.key(dim, pos);
    const now = use.now ?? Date.now();
    const entry = this.data.chests[k] ?? {
      worldId: this.worldId,
      dim,
      pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      block: use.block ?? 'chest',
      uses: 0,
      ts: now,
      contents: { items: [], observedAt: 0, possiblyStale: true },
    };
    entry.worldId = this.worldId;
    entry.dim = dim;
    entry.pos = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
    if (nodeId) entry.nodeId = nodeId;
    this.data.chestOps[this.worldId] = (this.data.chestOps[this.worldId] ?? 0) + 1;
    applyContents(entry, use, { ...this.chestClock(use.day), now });
    this.data.chests[k] = entry;
    this.dirty = true;
    return clone(entry);
  }

  /** Import one exact host record during cutover/normalization. */
  importChest(entry: ContainerEntry) {
    this.data.chests[this.key(entry.dim, entry.pos)] = clone({ ...entry, worldId: this.worldId });
    this.dirty = true;
  }

  setChestOps(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) return;
    this.data.chestOps[this.worldId] = value;
    this.dirty = true;
  }

  get chestOps(): number {
    return this.data.chestOps[this.worldId] ?? 0;
  }

  forgetChest(dim: string, pos: Vec3Like) {
    if (delete this.data.chests[this.key(dim, pos)]) this.dirty = true;
  }

  /**
   * Mark known container contents as possibly changed after an unobserved session
   * or world progression. This preserves the last exact items, counts, position
   * and observedAt; it only flags current validity, never decays or empties them.
   */
  markContentsPossiblyStale(): number {
    let marked = 0;
    for (const entry of Object.values(this.data.chests)) {
      if (entry.worldId !== this.worldId || entry.contents === undefined || entry.contents.observedAt <= 0) continue;
      if (entry.contents.possiblyStale === true) continue;
      entry.contents = { ...entry.contents, possiblyStale: true };
      marked += 1;
      this.dirty = true;
    }
    return marked;
  }

  chests(dim?: string): ContainerEntry[] {
    return Object.values(this.data.chests)
      .filter((entry) => entry.worldId === this.worldId && (!dim || entry.dim === dim))
      .map(clone);
  }

  chestAt(dim: string, pos: Vec3Like): ContainerEntry | undefined {
    const entry = this.data.chests[this.key(dim, pos)];
    return entry?.worldId === this.worldId ? clone(entry) : undefined;
  }

  setFurnace(rec: Omit<FurnaceRecord, 'worldId' | 'ts'> & { ts?: number }, nodeId?: string): FurnaceEntry | null {
    const k = this.key(rec.dim, rec.pos);
    if (!rec.input && !rec.output) {
      if (delete this.data.furnaces[k]) this.dirty = true;
      return null;
    }
    const entry: FurnaceEntry = {
      ...rec,
      worldId: this.worldId,
      pos: { x: Math.round(rec.pos.x), y: Math.round(rec.pos.y), z: Math.round(rec.pos.z) },
      ts: rec.ts ?? Date.now(),
      ...(nodeId ? { nodeId } : {}),
    };
    this.data.furnaces[k] = entry;
    this.dirty = true;
    return clone(entry);
  }

  /** Import one furnace state during cutover/normalization. */
  importFurnace(entry: FurnaceEntry) {
    this.data.furnaces[this.key(entry.dim, entry.pos)] = clone({ ...entry, worldId: this.worldId });
    this.dirty = true;
  }

  forgetFurnace(dim: string, pos: Vec3Like) {
    if (delete this.data.furnaces[this.key(dim, pos)]) this.dirty = true;
  }

  furnaces(dim?: string): FurnaceEntry[] {
    return Object.values(this.data.furnaces)
      .filter((entry) => entry.worldId === this.worldId && (!dim || entry.dim === dim))
      .map(clone);
  }

  snapshot(): LedgerData {
    return clone(this.data);
  }

  restore(snapshot: LedgerData) {
    this.data = clone(snapshot);
    this.dirty = true;
  }

  clear() {
    this.data = empty();
    this.dirty = true;
  }

  flush() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 1));
    fs.renameSync(temporary, this.file);
    this.dirty = false;
  }

  close() {
    this.flush();
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentState } from '../adapter/types.js';

export const GAME_DAY_TICKS = 24_000;

type WorldTicks = { totalTicks: number; dimensions: Map<string, number> };
type Sample = { worldId: string; sessionId: string; dim: string; age: number; at: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isTicks = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Only observed, uninterrupted server ticks count as experienced game time. */
export class ObservedGameClock {
  readonly loadError: string | null = null;
  private worlds = new Map<string, WorldTicks>();
  private activeWorld: string | null = null;
  private sample: Sample | null = null;

  constructor(private file: string | null = null) {
    if (!file || !existsSync(file)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.worlds)) throw new Error('invalid game-clock snapshot');
      // Validate the entire disk boundary before adopting any of its totals.
      const worlds = Object.entries(raw.worlds).map(([worldId, value]): [string, WorldTicks] => {
        if (!worldId || !isRecord(value) || !isTicks(value.totalTicks) || !isRecord(value.dimensions)) {
          throw new Error('invalid game-clock world totals');
        }
        const dimensions = Object.entries(value.dimensions).map(([dim, ticks]): [string, number] => {
          if (!dim || !isTicks(ticks)) throw new Error('invalid game-clock dimension total');
          return [dim, ticks];
        });
        return [worldId, { totalTicks: value.totalTicks, dimensions: new Map(dimensions) }];
      });
      this.worlds = new Map(worlds);
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  /** The last validly observed world remains available through pauses/disconnects. */
  get worldId(): string | null { return this.activeWorld; }

  /** Lifecycle events can break continuity even between periodic observations. */
  resetBaseline(): void { this.sample = null; }

  observe(state: AgentState, paused: boolean, now = Date.now()): void {
    if (!state.connected || !state.alive || !state.observationReady) {
      this.resetBaseline();
      return;
    }
    this.activeWorld = state.worldId;
    const age = state.worldAgeTicks;
    if (paused || !isTicks(age) || !Number.isFinite(now)) {
      this.resetBaseline();
      return;
    }
    const previous = this.sample;
    this.sample = { worldId: state.worldId, sessionId: state.sessionId, dim: state.dim, age, at: now };
    // A missing interval, a new session or a dimension crossing cannot be reconstructed.
    if (!previous || previous.worldId !== state.worldId || previous.sessionId !== state.sessionId || previous.dim !== state.dim
      || now < previous.at || now - previous.at > 5_000 || age < previous.age) return;
    const elapsed = age - previous.age;
    const world = this.worlds.get(state.worldId) ?? { totalTicks: 0, dimensions: new Map<string, number>() };
    world.totalTicks += elapsed;
    world.dimensions.set(state.dim, (world.dimensions.get(state.dim) ?? 0) + elapsed);
    this.worlds.set(state.worldId, world);
  }

  ticks(dim?: string): number {
    const world = this.activeWorld === null ? undefined : this.worlds.get(this.activeWorld);
    return (dim === undefined ? world?.totalTicks : world?.dimensions.get(dim)) ?? 0;
  }

  snapshot() {
    return {
      version: 1 as const,
      worlds: Object.fromEntries([...this.worlds].map(([worldId, world]): [string, { totalTicks: number; dimensions: Record<string, number> }] => [worldId, {
        totalTicks: world.totalTicks,
        dimensions: Object.fromEntries(world.dimensions),
      }])),
    };
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8');
  }
}

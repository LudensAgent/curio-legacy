import type { GameAdapter, InvItem } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { round1 } from '../util.ts';
import { NOTABLE, type Vision, type VisionSummary } from './vision.ts';

export const DIRS: Record<string, [number, number]> = {
  N: [0, -1], NE: [0.707, -0.707], E: [1, 0], SE: [0.707, 0.707],
  S: [0, 1], SW: [-0.707, 0.707], W: [-1, 0], NW: [-0.707, -0.707],
};

const DANGER = new Set(['lava', 'spawner']);
const STRUCTURE_HINT = new Set(['chest', 'bell', 'hay_block', 'spawner', 'furnace']);

export interface Percept {
  ts: number;
  connected: boolean;
  time: { timeOfDay: number; phase: 'day' | 'dusk' | 'night' | 'dawn' };
  self: { pos: [number, number, number]; dim: string; hp: number; food: number; biome: string | null; inWater: boolean; inLava: boolean; held: string | null };
  inventory: InvItem[];
  emptySlots: number;
  /** 只包含看见/听见/记得的东西（没有透视） */
  nearby: {
    hostile: { name: string; dist: number; how: 'seen' | 'heard' }[];
    passive: string[];
    players: string[];
    /** 看得见的 + 记得的资源方块 */
    resources: { block: string; count: number; nearest: number; dir?: string; seen: 'now' | 'memory' }[];
  };
  vision: VisionSummary | null;
  exploration: {
    visitedChunks: number;
    noveltyByDir: Record<string, number>;
    base: { dist: number; dir: string } | null;
  };
}

export function phaseOf(t: number): Percept['time']['phase'] {
  if (t < 12000) return 'day';
  if (t < 13800) return 'dusk';
  if (t < 22200) return 'night';
  return 'dawn';
}

export function dirName(dx: number, dz: number): string {
  const ang = (Math.atan2(dx, -dz) * 180) / Math.PI; // 0 = 北(-Z)
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(((ang + 360) % 360) / 45) % 8];
}

/**
 * 感知摘要器：每次先让 Vision 扫描一遍视野，再把“看见/听见/记得”的东西压缩成 LLM 可读的 JSON。
 * 新发现（首次看见的方块/实体/群系）只在真正看见时触发。
 */
export class Perception {
  private latest: Percept | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus, private vision: Vision) {}

  start(intervalMs = 700) {
    this.timer = setInterval(() => {
      try {
        this.update();
      } catch (e: any) {
        this.bus.publish('perception_error', 'P1', String(e?.message ?? e));
      }
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): Percept {
    return this.latest ?? this.update();
  }

  update(): Percept {
    const s = this.adapter.state();
    if (s.connected) this.vision.refresh();
    const v = this.vision;
    const here = s.pos;

    if (s.connected && s.alive) {
      if (this.memory.visit(s.dim, s.pos)) this.bus.publish('new_chunk', 'P3', `进入未访问区块（累计 ${this.memory.visitedChunkCount}）`);
      if (s.biome && this.memory.markSeen('biomes', s.biome)) {
        this.bus.publish('discovery', 'P2', `首次进入生物群系：${s.biome}`, { category: 'biome', name: s.biome });
        this.memory.addLandmark('discovery', `biome:${s.biome}`, s.dim, s.pos);
      }
      for (const b of v.visibleNow.values()) {
        if (!NOTABLE.has(b.name)) continue;
        if (this.memory.markSeen('blocks', b.name)) {
          this.bus.publish('discovery', 'P2', `首次看见方块：${b.name}（${Math.round(b.dist)} 格外）`, { category: 'block', name: b.name, pos: b.pos });
        }
        if (DANGER.has(b.name)) this.memory.addLandmark('danger', b.name, s.dim, b.pos);
        else if (STRUCTURE_HINT.has(b.name)) this.memory.addLandmark('discovery', b.name, s.dim, b.pos);
        else if (b.name.endsWith('_ore')) this.memory.addLandmark('resource', b.name, s.dim, b.pos);
      }
      for (const e of v.seen) {
        if (e.kind === 'item' || e.kind === 'other') continue;
        const key = e.kind === 'player' ? 'player' : e.name;
        if (this.memory.markSeen('entities', key)) this.bus.publish('discovery', 'P2', `首次看见实体：${e.name}`, { category: 'entity', name: e.name });
      }
    }

    const vs = s.connected ? v.summary(here) : null;
    const noveltyByDir: Record<string, number> = {};
    for (const [d, [dx, dz]] of Object.entries(DIRS)) {
      noveltyByDir[d] = round1(this.memory.novelty(s.dim, s.pos.x + dx * 48, s.pos.z + dz * 48));
    }
    const base = this.memory.base();
    const baseInfo =
      base && base.dim === s.dim
        ? { dist: Math.round(Math.hypot(base.pos.x - s.pos.x, base.pos.z - s.pos.z)), dir: dirName(base.pos.x - s.pos.x, base.pos.z - s.pos.z) }
        : null;

    const passiveCount = new Map<string, number>();
    for (const e of v.seen.filter((x) => x.kind === 'passive')) passiveCount.set(e.name, (passiveCount.get(e.name) ?? 0) + 1);

    this.latest = {
      ts: Date.now(),
      connected: s.connected,
      time: { timeOfDay: s.timeOfDay, phase: phaseOf(s.timeOfDay) },
      self: {
        pos: [Math.round(s.pos.x), Math.round(s.pos.y), Math.round(s.pos.z)],
        dim: s.dim,
        hp: round1(s.hp),
        food: s.food,
        biome: s.biome,
        inWater: s.inWater,
        inLava: s.inLava,
        held: s.held,
      },
      inventory: [...s.inventory].sort((a, b) => b.count - a.count).slice(0, 24),
      emptySlots: s.emptySlots,
      nearby: {
        hostile: [...v.seen, ...v.heard]
          .filter((e) => e.kind === 'hostile')
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 6)
          .map((e) => ({ name: e.name, dist: round1(e.dist), how: e.how })),
        passive: [...passiveCount].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).slice(0, 8),
        players: v.seen.filter((e) => e.kind === 'player').map((e) => e.name.replace('player:', '')),
        resources: vs
          ? [
              ...vs.visible_resources.map((r) => ({ block: r.block, count: r.count, nearest: r.nearest, dir: r.dir, seen: 'now' as const })),
              ...vs.remembered_resources.map((r) => ({ block: r.block, count: r.count, nearest: r.nearest, dir: r.dir, seen: 'memory' as const })),
            ].slice(0, 16)
          : [],
      },
      vision: vs,
      exploration: { visitedChunks: this.memory.visitedChunkCount, noveltyByDir, base: baseInfo },
    };
    return this.latest;
  }
}

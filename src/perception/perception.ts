import type { GameAdapter, InvItem } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { round1 } from '../util.ts';

export const DIRS: Record<string, [number, number]> = {
  N: [0, -1], NE: [0.707, -0.707], E: [1, 0], SE: [0.707, 0.707],
  S: [0, 1], SW: [-0.707, 0.707], W: [-1, 0], NW: [-0.707, -0.707],
};

const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
const ORES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald'].flatMap((o) => [`${o}_ore`, `deepslate_${o}_ore`]);
const INTERESTING = [
  ...LOGS, ...ORES,
  'crafting_table', 'chest', 'furnace', 'lava', 'spawner', 'bell', 'hay_block', 'sugar_cane',
  'pumpkin', 'melon', 'obsidian', 'clay', 'sand', 'gravel',
];
const DANGER = new Set(['lava', 'spawner']);
const STRUCTURE_HINT = new Set(['chest', 'bell', 'hay_block', 'spawner', 'furnace']);

export interface Percept {
  ts: number;
  connected: boolean;
  time: { timeOfDay: number; phase: 'day' | 'dusk' | 'night' | 'dawn' };
  self: { pos: [number, number, number]; dim: string; hp: number; food: number; biome: string | null; inWater: boolean; inLava: boolean; held: string | null };
  inventory: InvItem[];
  emptySlots: number;
  nearby: {
    hostile: { name: string; dist: number }[];
    passive: string[];
    players: string[];
    resources: { block: string; count: number; nearest: number }[];
  };
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
  return names[(Math.round(((ang + 360) % 360) / 45) % 8)];
}

/**
 * 感知摘要器：把结构化游戏状态压缩成 LLM 可读的紧凑 JSON，并在扫描时发现“新事物”。
 * 不使用截图：所有信息来自协议层（方块、实体、背包、时间）。
 */
export class Perception {
  private latest: Percept | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus) {}

  start(intervalMs = 2000) {
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
    const ents = s.connected ? this.adapter.nearbyEntities(24) : [];
    const blocks = s.connected ? this.adapter.findBlocks(INTERESTING, 32, 256) : [];

    // 聚合资源
    const res = new Map<string, { count: number; nearest: number; pos: { x: number; y: number; z: number } }>();
    for (const b of blocks) {
      const r = res.get(b.name);
      if (!r) res.set(b.name, { count: 1, nearest: b.dist, pos: b.pos });
      else {
        r.count++;
        if (b.dist < r.nearest) {
          r.nearest = b.dist;
          r.pos = b.pos;
        }
      }
    }

    if (s.connected && s.alive) {
      if (this.memory.visit(s.dim, s.pos)) this.bus.publish('new_chunk', 'P3', `进入未访问区块（累计 ${this.memory.visitedChunkCount}）`);
      if (s.biome && this.memory.markSeen('biomes', s.biome)) {
        this.bus.publish('discovery', 'P2', `首次进入生物群系：${s.biome}`, { category: 'biome', name: s.biome });
        this.memory.addLandmark('discovery', `biome:${s.biome}`, s.dim, s.pos);
      }
      for (const [name, r] of res) {
        if (this.memory.markSeen('blocks', name)) {
          this.bus.publish('discovery', 'P2', `首次发现方块：${name}（${Math.round(r.nearest)} 格外）`, { category: 'block', name, pos: r.pos });
        }
        if (DANGER.has(name)) this.memory.addLandmark('danger', name, s.dim, r.pos);
        else if (STRUCTURE_HINT.has(name)) this.memory.addLandmark('discovery', name, s.dim, r.pos);
        else if (name.endsWith('_ore')) this.memory.addLandmark('resource', name, s.dim, r.pos);
      }
      for (const e of ents) {
        if (e.kind === 'item' || e.kind === 'other') continue;
        const key = e.kind === 'player' ? 'player' : e.name;
        if (this.memory.markSeen('entities', key)) {
          this.bus.publish('discovery', 'P2', `首次遇到实体：${e.name}`, { category: 'entity', name: e.name });
        }
      }
    }

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
    for (const e of ents.filter((x) => x.kind === 'passive')) passiveCount.set(e.name, (passiveCount.get(e.name) ?? 0) + 1);

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
        hostile: ents.filter((e) => e.kind === 'hostile').slice(0, 6).map((e) => ({ name: e.name, dist: round1(e.dist) })),
        passive: [...passiveCount].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).slice(0, 8),
        players: ents.filter((e) => e.kind === 'player').map((e) => e.name.replace('player:', '')),
        resources: [...res]
          .map(([block, r]) => ({ block, count: r.count, nearest: Math.round(r.nearest) }))
          .sort((a, b) => a.nearest - b.nearest)
          .slice(0, 14),
      },
      exploration: { visitedChunks: this.memory.visitedChunkCount, noveltyByDir, base: baseInfo },
    };
    return this.latest;
  }
}

import { surroundings } from './surroundings.ts';
import type { GameAdapter, InvItem, Vec3Like } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { effectiveLight, round1, lightAround } from '../util.ts';
import { torchCount } from '../skills/light.ts';
import { interactiveName, NOTABLE, type Vision, type VisionSummary } from './vision.ts';
import { computeDrives, type Drive, type Stock } from '../brain/drives.ts';
import { efficiencyInsights, type EfficiencyInsight } from '../brain/efficiency.ts';
import { learnCandidates, reflectionDue } from '../brain/habits.ts';

export const DIRS: Record<string, [number, number]> = {
  N: [0, -1], NE: [0.707, -0.707], E: [1, 0], SE: [0.707, 0.707],
  S: [0, 1], SW: [-0.707, 0.707], W: [-1, 0], NW: [-0.707, -0.707],
};

const DANGER = new Set(['lava', 'spawner']);
const STRUCTURE_HINT = new Set(['chest', 'bell', 'hay_block', 'spawner', 'furnace']);

export interface Percept {
  ts: number;
  connected: boolean;
  observation?: { ready: boolean; worldId: string; sessionId: string; id: number };
  /** can_sleep：只有夜里（或雷雨）才能上床睡觉，白天 sleep 会失败 */
  time: { timeOfDay: number; phase: 'day' | 'dusk' | 'night' | 'dawn'; isDay?: boolean; can_sleep?: boolean };
  self: { pos: [number, number, number]; dim: string; hp: number; food: number; biome: string | null; inWater: boolean; inLava: boolean; held: string | null; onGround?: boolean; riding?: string | null; equipment?: { slot: string; name: string }[]; around?: string };
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
  /** 死亡后掉落物还在（5 分钟内）时出现：在哪、丢了什么、还剩多少秒消失 */
  death_recovery: { dir: string; dist: number; lost: string; seconds_left: number } | null;
  /** 看见过但还没去过的有趣东西（好奇心候选） */
  curiosities: { what: string; dir: string; dist: number }[];
  objective: string | null;
  /** 游玩欲望（按强度排序） */
  drives: Drive[];
  stock: Stock | null;
  /** 亮度感知：脚下的实际亮度、是否会刷怪、视野里有多少看不清 */
  light: {
    here: number;
    block: number;
    sky: number;
    level: 'bright' | 'dim' | 'dark';
    mob_spawn_risk: boolean;
    dark_view_pct: number;
    underground: boolean;
    torches: number;
  } | null;
  /** 仓储：记得的箱子与里面存了什么 */
  storage: { chests: number; nearest: number | null; stored: string; source?: 'historical_chest_snapshot'; availability?: 'unconfirmed_until_opened'; oldestObservedAt?: number; ageSeconds?: number } | null;
  /** 农田：作物、格数、成熟数量（离得近时才能看清） */
  farms: { crop: string; cells: number; dist: number; mature: number | null; minutes_since_planted: number }[];
  /** 最近反复成功的同一套步骤（可以 learn_skill 学成技能） */
  learn_candidates: { steps: string; times: number }[];
  /** 是否该反思一下（在 lesson 字段写经验） */
  reflection_due: boolean;
  /** 效率洞察：最近的采集速度，以及换哪把工具能快多少（偷懒的依据） */
  efficiency: EfficiencyInsight[];
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

/** 原版：12542–23459 刻之间才能睡觉（不考虑雷雨） */
export function canSleepAt(timeOfDay: number): boolean {
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  return t >= 12542 && t <= 23459;
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
  /** 第一次拿到某个物品时回调（heldBefore 是之前拿到过的物品） */
  onNewItem?: (item: string, heldBefore: Set<string>) => void;
  private latest: Percept | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus, private vision: Vision) {}

  observeBlocks(positions: Vec3Like[]) { return this.vision.observeBlocks(positions); }

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
    const state = this.adapter.state();
    const observation = this.latest?.observation;
    if (!observation || observation.ready !== state.observationReady || observation.worldId !== state.worldId || observation.sessionId !== state.sessionId || this.latest?.self.dim !== state.dim) return this.update();
    return this.latest!;
  }

  /** 由 main 注入：已经学会的技能对应的步骤签名（避免重复提示） */
  knownSkillSigs?: () => Set<string>;

  private storageInfo(dim: string, here: { x: number; z: number }): Percept['storage'] {
    const chests = this.memory.chests().filter((c) => c.dim === dim);
    if (!chests.length) return null;
    const nearest = Math.min(...chests.map((c) => Math.round(Math.hypot(c.pos.x - here.x, c.pos.z - here.z))));
    const stored = new Map<string, number>();
    for (const chest of chests) for (const item of chest.items) stored.set(item.name, (stored.get(item.name) ?? 0) + item.count);
    const totals = [...stored].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const oldestObservedAt = Math.min(...chests.map((chest) => chest.ts));
    return { chests: chests.length, nearest, stored: totals.slice(0, 14).map(([n, c]) => `${n}×${c}`).join('、') || '（空）',
      source: 'historical_chest_snapshot', availability: 'unconfirmed_until_opened', oldestObservedAt,
      ageSeconds: Math.max(0, Math.round((Date.now() - oldestObservedAt) / 1000)) };
  }

  private farmInfo(dim: string, here: { x: number; z: number }): Percept['farms'] {
    return this.memory.farms().filter((f) => f.dim === dim && f.cells.length).map((f) => {
      const dist = Math.round(Math.hypot(f.cells[0].x - here.x, f.cells[0].z - here.z));
      let mature: number | null = null;
      if (dist <= 48) {
        let observed = 0;
        mature = 0;
        for (const c of f.cells) {
          const a = this.adapter.cropAge({ x: c.x, y: c.y + 1, z: c.z });
          if (a) observed++;
          if (a && a.age >= a.max) mature++;
        }
        if (observed !== f.cells.length) mature = null;
      }
      return { crop: f.crop, cells: f.cells.length, dist, mature, minutes_since_planted: Math.round((Date.now() - f.plantedAt) / 60000) };
    });
  }

  private lightInfo(s: ReturnType<GameAdapter['state']>): Percept['light'] {
    const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y), z = Math.floor(s.pos.z);
    const l = lightAround(this.adapter, x, y, z);
    if (!l) return null;
    const here = effectiveLight(l, s.timeOfDay);
    const comp = this.vision.composition;
    const total = Object.values(comp).reduce((a, b) => a + b, 0) || 1;
    return {
      here,
      block: l.block,
      sky: l.sky,
      level: here >= 10 ? 'bright' : here >= 4 ? 'dim' : 'dark',
      // 1.18+：方块光为 0 且足够暗时会刷敌对生物
      mob_spawn_risk: l.block === 0 && here <= 7,
      dark_view_pct: Math.round(((comp.dark ?? 0) / total) * 100),
      underground: l.sky <= 4,
      torches: torchCount(s.inventory),
    };
  }

  update(): Percept {
    const s = this.adapter.state();
    this.memory.setWorld(s.worldId);
    this.vision.refresh();
    const v = this.vision;
    const here = s.pos;

    if (s.connected && s.alive && s.observationReady) {
      if (this.memory.visit(s.dim, s.pos)) this.bus.publish('new_chunk', 'P3', `进入未访问区块（累计 ${this.memory.visitedChunkCount}）`);
      if (s.biome && this.memory.markSeen('biomes', s.biome)) {
        this.bus.publish('discovery', 'P2', `首次进入生物群系：${s.biome}`, { category: 'biome', name: s.biome });
        this.memory.addLandmark('discovery', `biome:${s.biome}`, s.dim, s.pos);
      }
      // 拿到过的物品记进记忆：配方知识由此解锁（原版配方书的规则）
      let heldBefore: Set<string> | null = null;
      for (const it of s.inventory) {
        if (this.memory.hasSeen('items', it.name)) continue;
        heldBefore ??= this.memory.heldItems();
        this.memory.markSeen('items', it.name);
        this.onNewItem?.(it.name, heldBefore);
      }
      for (const b of v.visibleNow.values()) {
        if (!NOTABLE.has(b.name)) continue;
        if (this.memory.markSeen('blocks', b.name)) {
          this.bus.publish('discovery', 'P2', `首次看见方块：${b.name}（${Math.round(b.dist)} 格外）`, { category: 'block', name: b.name, pos: b.pos });
        }
        if (DANGER.has(b.name)) this.memory.addLandmark('danger', b.name, s.dim, b.pos);
        else if (interactiveName(b.name)) {
          // 看见的功能方块记成地标（自己放下的已记为“我的X”，附近有就不重复记）
          const zh = interactiveName(b.name)!;
          const mine = this.memory.landmarks().some((l) => l.label === `我的${zh}` && l.dim === s.dim && Math.hypot(l.pos.x - b.pos.x, l.pos.y - b.pos.y, l.pos.z - b.pos.z) <= 2);
          if (!mine) this.memory.addLandmark('discovery', zh, s.dim, b.pos, 6);
        } else if (STRUCTURE_HINT.has(b.name)) this.memory.addLandmark('discovery', b.name, s.dim, b.pos);
        else if (b.name.endsWith('_ore')) this.memory.addLandmark('resource', b.name, s.dim, b.pos);
      }
      for (const e of v.seen) {
        if (e.kind === 'item' || e.kind === 'other') continue;
        const key = e.kind === 'player' ? 'player' : e.name;
        if (this.memory.markSeen('entities', key)) this.bus.publish('discovery', 'P2', `首次看见实体：${e.name}`, { category: 'entity', name: e.name });
      }
    }

    const vs = s.connected && s.observationReady ? v.summary(here) : null;
    const noveltyByDir: Record<string, number> = {};
    for (const [d, [dx, dz]] of Object.entries(DIRS)) {
      noveltyByDir[d] = round1(this.memory.novelty(s.dim, s.pos.x + dx * 48, s.pos.z + dz * 48));
    }
    const base = this.memory.base(s.dim);
    const baseInfo =
      base && base.dim === s.dim
        ? { dist: Math.round(Math.hypot(base.pos.x - s.pos.x, base.pos.z - s.pos.z)), dir: dirName(base.pos.x - s.pos.x, base.pos.z - s.pos.z) }
        : null;

    // ---- 死亡掉落物：物品在地上 5 分钟后消失
    let deathRecovery: Percept['death_recovery'] = null;
    const d = this.memory.lastDeath();
    if (d && d.lost.length && s.connected && s.observationReady) {
      const left = Math.round((d.ts + 300_000 - Date.now()) / 1000);
      const dist = Math.hypot(d.pos.x - here.x, d.pos.z - here.z);
      if (left <= 0) {
        this.memory.clearDeath();
        this.bus.publish('death_items', 'P1', '死亡掉落物已经消失（超过 5 分钟）');
      } else if (d.dim === s.dim) {
        const itemsNear = v.seen.some((e) => e.kind === 'item' && Math.hypot(e.pos.x - d.pos.x, e.pos.z - d.pos.z) < 10);
        if (dist < 4 && !itemsNear) {
          this.memory.clearDeath();
          this.bus.publish('death_items', 'P2', '回到了死亡地点，附近已经没有掉落物（已捡回或被冲走）');
        } else {
          deathRecovery = {
            dir: dirName(d.pos.x - here.x, d.pos.z - here.z),
            dist: Math.round(dist),
            lost: d.lost.slice(0, 8).map((i) => `${i.name}×${i.count}`).join('、'),
            seconds_left: left,
          };
        }
      }
    }

    // ---- 好奇心候选：记得但没去过的结构/稀有资源
    const visited = (p: { x: number; z: number }) => this.memory.chunkVisits(s.dim, p.x, p.z) > 0;
    const curiosities = this.memory
      .landmarks()
      .filter((l) => l.dim === s.dim && (l.kind === 'discovery' || l.kind === 'resource') && !l.label.startsWith('biome:') && !visited(l.pos))
      .map((l) => ({ what: l.label, dir: dirName(l.pos.x - here.x, l.pos.z - here.z), dist: Math.round(Math.hypot(l.pos.x - here.x, l.pos.z - here.z)) }))
      .filter((c) => c.dist > 8)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 6);

    const passiveCount = new Map<string, number>();
    for (const e of v.seen.filter((x) => x.kind === 'passive')) passiveCount.set(e.name, (passiveCount.get(e.name) ?? 0) + 1);

    this.latest = {
      ts: Date.now(),
      connected: s.connected,
      observation: { ready: s.observationReady, worldId: s.worldId, sessionId: s.sessionId, id: s.observationId },
      time: { timeOfDay: s.timeOfDay, phase: phaseOf(s.timeOfDay), isDay: s.isDay, can_sleep: canSleepAt(s.timeOfDay) },
      self: {
        pos: [Math.round(s.pos.x), Math.round(s.pos.y), Math.round(s.pos.z)],
        dim: s.dim,
        hp: round1(s.hp),
        food: s.food,
        biome: s.biome,
        inWater: s.inWater,
        inLava: s.inLava,
        held: s.held,
        onGround: s.onGround,
        ...(s.riding !== undefined ? { riding: s.riding } : {}),
        ...(s.equipment ? { equipment: s.equipment.map(({ slot, name }) => ({ slot, name })) } : {}),
        // 身边一圈（脚下、头顶、四个方向能不能走）：判断被困、往哪能出去
        ...(s.connected && s.alive ? { around: surroundings(this.adapter, s.pos).text } : {}),
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
      death_recovery: deathRecovery,
      curiosities,
      objective: this.memory.objective()?.text ?? null,
      drives: [],
      stock: null,
      efficiency: s.connected ? efficiencyInsights(this.adapter, this.memory, s.inventory) : [],
      light: s.observationReady ? this.lightInfo(s) : null,
      storage: this.storageInfo(s.dim, here),
      farms: s.observationReady ? this.farmInfo(s.dim, here) : [],
      learn_candidates: learnCandidates(this.memory, this.knownSkillSigs?.() ?? new Set()).map((c) => ({ steps: c.signature, times: c.times })),
      reflection_due: reflectionDue(this.memory),
      exploration: { visitedChunks: this.memory.visitedChunkCount, noveltyByDir, base: baseInfo },
    };
    const { drives, stock } = computeDrives(this.latest, this.memory);
    this.latest.drives = drives;
    this.latest.stock = stock;
    return this.latest;
  }
}

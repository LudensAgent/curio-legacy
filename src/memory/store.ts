import fs from 'node:fs';
import path from 'node:path';
import type { EffectEvidence, Vec3Like } from '../adapter/types.ts';
import { dist3, shortId } from '../util.ts';
import { reservationsFor } from '../projects/reservations.ts';
import type { Decision, Intent, Preference } from '../intentions/types.ts';
import type { Evidence, PauseReason, Project } from '../projects/types.ts';
import { applyContents, chestLocation, isContainerLandmark, migrateChest, recall, type ChestRecall, type ChestRecord, type ChestContents, type ChestUse, type Clock } from './chest-memory.ts';
import type { SemanticSnapshot, SpatialMemoryBackend } from './spatial-backend.ts';

export type { ChestRecord, ChestRecall, ChestContents, ChestUse } from './chest-memory.ts';

export type LandmarkKind = 'base' | 'resource' | 'danger' | 'discovery' | 'death' | 'waypoint' | 'herd';

export interface Landmark {
  id: string;
  kind: LandmarkKind;
  label: string;
  dim: string;
  pos: Vec3Like;
  ts: number;
  /** Selection metadata, independent of the last actual observation time. */
  primary?: boolean;
  worldId?: string;
  /** herd（不主动攻击的生物出没点）：上次看见几只、外观（羊的颜色等） */
  count?: number;
  detail?: string;
  /** Recall-only location projection; historical container areas are not exact interaction targets. */
  radius?: number;
  precise?: boolean;
  observedAt?: number;
}

export interface GoalRecord {
  id?: string;
  worldId?: string;
  dimension?: string;
  ts: number;
  goal: string;
  goalType: string;
  source: string;
  status: string;
  summary: string;
  durationSec?: number;
  /** 计划步骤签名，例如 ["gather:log", "craft:wooden_pickaxe"]，用于发现可以学成技能的重复套路 */
  steps?: string[];
  plan?: { skill: string; args?: unknown }[];
  /** 实测动作成效，与任务返回 succeeded、目标是否完成分别记录。 */
  effectEvidence?: EffectEvidence;
}

/**
 * 自己挖出来的一条通道（台阶井、矿道、脱困挖的洞都算）：从地表钻下去、在地下一路挖着走、再回到地表，记成一条。
 * 只记亲身走过的点（脚下的位置），不透视；这些是历史线索，不保证点间或当前地形仍可通行。
 */
export interface PassageRecord {
  id: string;
  worldId?: string;
  dim: string;
  /** 'dug' = 自己挖出来的通道（台阶井/矿道）；'walked' = 只是走进去的天然洞穴，只用于原路返回；'bridge' = 自己搭的桥/路（连续放下的方块） */
  kind?: 'dug' | 'walked' | 'bridge';
  /** 从地表钻下去的地方（可能有好几个口），不知道就空着 */
  entrances: Vec3Like[];
  /** 沿途脚下的点，每隔几格记一个 */
  path: Vec3Like[];
  /** 亲自一步步走过的相邻格对（无瞬移、Chebyshev 相邻）：真实可走的边，passageRoute 优先沿这些边走，有它就不用 hop/link 几何推断 */
  links?: { a: Vec3Like; b: Vec3Like }[];
  deepestY: number;
  /** 这条通道里自己挖掉了多少格 */
  dug: number;
  /** 沿途挖到的矿 */
  ores: Record<string, number>;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
  /** 被当前工作集淘汰、移入历史归档的时间；live 记录没有这个字段 */
  archivedAt?: number;
}

/**
 * 自己留在熔炉（烟熏炉、高炉）里的东西：放进去要等着烧，离开以后它不会自己回到背包。
 * 记下离开那一刻里面有什么、烧到哪了，之后路过时对照看得见的样子（亮着/灭了）提醒自己回来取
 */
export interface FurnaceRecord {
  worldId?: string;
  dim: string;
  pos: Vec3Like;
  block: string;
  input: { name: string; count: number } | null;
  output: { name: string; count: number } | null;
  fuel: { name: string; count: number } | null;
  /** 离开时还在烧（火苗亮着） */
  burning: boolean;
  /** 停下来的原因：燃料用完 / 卡住 / 被打断离开 */
  why?: string;
  ts: number;
}

export interface GoneSpot { worldId?: string; dim: string; label: string; pos: Vec3Like; now: string; ts: number }

export interface FarmRecord {
  worldId?: string;
  id: string;
  dim: string;
  crop: string;
  cells: Vec3Like[]; // 耕地位置
  plantedAt: number;
  harvests: number;
}

/** 一次挖掘的耗时记录：用来发现“空手砍树太慢，该做斧头了” */
export interface DigRecord {
  ts: number;
  block: string;
  tool: string | null;
  ms: number;
}

export interface SkillStat {
  runs: number;
  ok: number;
  fail: number;
  cancelled: number;
  failCodes: Record<string, number>;
}

/** 记忆中的每条笔记都标注类型：fact（程序验证）/ inference（LLM 推断）/ hypothesis（待验证） */
export interface Note {
  id?: string;
  worldId?: string;
  dimension?: string;
  ts: number;
  kind: 'fact' | 'inference' | 'hypothesis';
  text: string;
  /** 写下笔记时所在位置（让“这里/附近”有参照） */
  pos?: Vec3Like;
}

/**
 * 危险区域：在这里出过事（淹死、掉岩浆、摔死、被怪打死……）。由程序根据真实死亡/伤害记录，
 * 不由模型编造；寻路/采集据此绕开，提示词里作为“我在这里吃过亏”的经验。
 */
export type HazardKind = 'drowning' | 'lava' | 'fall' | 'mob' | 'explosion' | 'starvation' | 'suffocation' | 'unknown';
export interface Hazard {
  id: string;
  worldId?: string;
  dim: string;
  pos: Vec3Like;
  /** 影响半径（格），同一处反复出事会变大 */
  radius: number;
  kind: HazardKind;
  /** 在这里出事的次数 */
  count: number;
  /** 出事时在做什么（技能名 + 关键参数），用于“做 X 时别来这里” */
  during?: string;
  note?: string;
  firstTs: number;
  ts: number;
}

/** 经验教训：model=模型反思写下的推断；observed=程序根据真实经历（死亡、反复失败）写下的 */
export interface Lesson {
  ts: number;
  text: string;
  worldId?: string;
  source?: 'model' | 'observed';
  /** 程序写的经验按 key 更新（同一处第 3 次淹死时替换“淹死过 2 次”那条） */
  key?: string;
}

export interface DeathRecord {
  worldId?: string;
  ts: number;
  dim: string;
  pos: Vec3Like;
  /** 死前背包；复活后与当前背包比较得出真正丢失的物品 */
  lost: { name: string; count: number }[];
  cause?: string;
  /** 游戏的死亡播报原文（比推测的死因可靠） */
  message?: string;
}

interface MemoryData {
  version: number;
  lastDeath: DeathRecord | null;
  /** 每个 world 最近几次死亡（数组，最新在末尾）；旧版只有单条对象，加载时归一成数组 */
  deaths: Record<string, DeathRecord[]>;
  /** 跨计划的长期目标（由 LLM 设定/更新） */
  objective: { text: string; ts: number } | null;
  digs: DigRecord[];
  chests: Record<string, ChestRecord>;
  /** 开过多少次箱子：箱子印象按“中间又开过几次别的箱子”淡化 */
  chestOps?: number;
  furnaces?: Record<string, FurnaceRecord>;
  /** 亲眼看到已经没了的资源/危险点：别处的文字记忆（窍门、议程、回想）里还写着那个坐标时，要能指出来 */
  gone?: GoneSpot[];
  passages?: PassageRecord[];
  /** 超过 live 工作集上限后保留的历史通道；显式查询/路由可读，不参与每 tick 的通行扫描 */
  passageArchive?: PassageRecord[];
  farms: FarmRecord[];
  lessons: Lesson[];
  hazards: Hazard[];
  visitedChunks: Record<string, number>;
  seen: { blocks: Record<string, number>; entities: Record<string, number>; biomes: Record<string, number>; items?: Record<string, number> };
  landmarks: Landmark[];
  skillStats: Record<string, SkillStat>;
  goals: GoalRecord[];
  notes: Note[];
  worldId: string;
  preferences: Preference[];
  intents: Intent[];
  decisions: Decision[];
  projects: Project[];
  evidence: Evidence[];
  runtimePauseReasons: PauseReason[];
}

/** v2：地标只来自 Vision 亲眼所见。v1 的早期版本用 findBlocks（穿墙）写过矿物地标，加载时清掉 */
const MEMORY_VERSION = 4;
/** 地标总量软上限：超过后按价值阶梯淘汰；base 与「我的X」设施永不淘汰，总量仍由各自上限约束 */
const LANDMARK_CAP = 200;
/** discovery 同 label 上限：压住「73 个工作台」这类冗余，只留最近的一批 */
const DISCOVERY_LABEL_CAP = 8;
/** 开挖入口/进度 waypoint 上限：恢复点只留最近几个，避免每次开挖都净增两条 */
export const EXCAVATION_WAYPOINT_CAP = 8;
/** live 通道工作集上限：每 tick/提示词只处理最近用过的这些，历史记录移入 archive */
export const PASSAGE_LIVE_CAP = 24;
/** 历史通道归档上限：足够保留一个世界的旧矿道，同时避免 JSON 无界增长 */
export const PASSAGE_ARCHIVE_CAP = 512;
/** 归档里的 bridge 是程序从放置方块推导出来的，数量会随每次搭桥膨胀；单独限量，避免挤掉真正走过的旧矿道 */
export const PASSAGE_BRIDGE_ARCHIVE_CAP = 64;
/** 自己放置的方块（路、桥、门框、脚手架…）LRU 上限：环境变量可调；超出淘汰最久未用的 */
const PLACED_BLOCKS_CAP = (() => {
  const raw = process.env.PLACED_BLOCKS_CAP;
  const n = raw ? Number(raw) : 4096;
  return Number.isInteger(n) && n > 0 ? n : 4096;
})();
/** 空间哈希格边长（格）：queryPlacedNear 只扫附近格子 */
const PLACED_CELL = 16;

const empty = (): MemoryData => ({
  version: MEMORY_VERSION,
  lastDeath: null,
  deaths: {},
  objective: null,
  digs: [],
  chests: {},
  farms: [],
  lessons: [],
  hazards: [],
  visitedChunks: {},
  seen: { blocks: {}, entities: {}, biomes: {}, items: {} },
  landmarks: [],
  skillStats: {},
  goals: [],
  notes: [],
  worldId: 'default',
  preferences: [],
  intents: [],
  decisions: [],
  projects: [],
  evidence: [],
  runtimePauseReasons: [],
});

/**
 * MVP 世界记忆：一个 JSON 文件，进程重启后可恢复。
 * 下一阶段替换为 SQLite（设计文档第 16 章），接口保持不变。
 */
export class WorldMemory {
  private data: MemoryData;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private lastChunk = '';
  private transactionDepth = 0;
  /** 自己放置的方块：位置 → { 方块名, 最近使用 }；byCell 是空间哈希（不落盘） */
  private placedByPos = new Map<string, { name: string; at: number }>();
  private placedByCell = new Map<string, Set<string>>();
  private placedClock = 0;
  private placedDirty = false;
  private placedTimer: NodeJS.Timeout | null = null;
  /** Production semantic persistence; when present, JSON keeps only non-spatial facts. */
  private spatial: SpatialMemoryBackend | null = null;

  constructor(private file: string | null) {
    this.data = empty();
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.data = { ...empty(), ...parsed, version: parsed.version ?? 1 };
        this.migrate();
        this.dedupeOwnTwins();
        this.dropBedBases();
        this.recoverProjects();
        this.applyPatch(file);
        this.trimPassageArchive();
      } catch {
        fs.copyFileSync(file, file + '.corrupt-' + Date.now());
        this.data = empty();
      }
    }
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.timer = setInterval(() => this.flush(), 10000);
      this.timer.unref?.();
      this.flush();
      this.loadPlaced(file + '.placed');
      this.placedTimer = setInterval(() => this.flushPlaced(), 30000);
      this.placedTimer.unref?.();
    }
  }

  private placedKey(x: number, y: number, z: number) { return `${x},${y},${z}`; }
  private placedCell(x: number, y: number, z: number) {
    return `${Math.floor(x / PLACED_CELL)},${Math.floor(y / PLACED_CELL)},${Math.floor(z / PLACED_CELL)}`;
  }
  private placedInsert(key: string, cell: string) {
    let set = this.placedByCell.get(cell);
    if (!set) { set = new Set(); this.placedByCell.set(cell, set); }
    set.add(key);
  }
  private placedDelete(key: string, cell: string) {
    const set = this.placedByCell.get(cell);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) this.placedByCell.delete(cell);
  }

  private loadPlaced(file: string) {
    if (!fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entries: Record<string, { name: string; at: number }> = parsed?.byPos ?? {};
      let maxAt = 0;
      for (const [key, v] of Object.entries(entries)) {
        if (typeof v?.name !== 'string' || typeof v?.at !== 'number') continue;
        this.placedByPos.set(key, { name: v.name, at: v.at });
        if (v.at > maxAt) maxAt = v.at;
        const [x, y, z] = key.split(',').map(Number);
        this.placedInsert(key, this.placedCell(x, y, z));
      }
      this.placedClock = maxAt + 1;
      this.evictPlaced();
    } catch { /* 放置记录坏了就不加载，不影响主记忆 */ }
  }

  /** LRU：超出上限淘汰最久未用（at 最小）的 */
  private evictPlaced() {
    while (this.placedByPos.size > PLACED_BLOCKS_CAP) {
      let worstKey: string | null = null;
      let worstAt = Infinity;
      for (const [key, v] of this.placedByPos) if (v.at < worstAt) { worstAt = v.at; worstKey = key; }
      if (worstKey === null) break;
      const [x, y, z] = worstKey.split(',').map(Number);
      this.placedDelete(worstKey, this.placedCell(x, y, z));
      this.placedByPos.delete(worstKey);
    }
  }

  private touch() {
    this.dirty = true;
  }

  get dataDirectory(): string | null { return this.file ? path.dirname(this.file) : null; }
  get worldId(): string { return this.data.worldId; }

  /**
   * Bind semantic persistence to the spatial store. From this point the spatial
   * store is the authority at rest: load its records now, and write every later
   * change back through it instead of the JSON file.
   */
  attachSpatial(backend: SpatialMemoryBackend, opts: { allowEmptyStore?: boolean } = {}) {
    const snapshot = backend.load();
    const storeRecords = snapshot.passages.length + snapshot.passageArchive.length + snapshot.landmarks.length
      + Object.keys(snapshot.chests).length + Object.keys(snapshot.furnaces).length + snapshot.farms.length
      + snapshot.hazards.length + snapshot.gone.length + snapshot.placed.length + Object.keys(snapshot.visitedChunks).length;
    const legacyRecords = (this.data.passages?.length ?? 0) + (this.data.passageArchive?.length ?? 0) + this.data.landmarks.length
      + Object.keys(this.data.chests ?? {}).length + Object.keys(this.data.furnaces ?? {}).length + this.data.farms.length
      + this.data.hazards.length + (this.data.gone?.length ?? 0) + this.placedByPos.size + Object.keys(this.data.visitedChunks).length;
    if (!opts.allowEmptyStore && storeRecords === 0 && legacyRecords > 0) {
      throw new Error('空间记忆库为空，但本地 JSON 仍有空间数据；先运行空间迁移，不能静默丢弃旧数据');
    }
    this.spatial = backend;
    this.applySemanticSnapshot(snapshot);
    // Force one JSON rewrite so old spatial keys are removed from the local file.
    this.dirty = true;
  }

  /** Test/diagnostic seam: the attached semantic backend, if any. */
  get spatialBackend(): SpatialMemoryBackend | null { return this.spatial; }

  /** Write the current semantic projection through the attached backend now. */
  syncSpatial() {
    if (this.spatial) this.spatial.save(this.semanticSnapshot());
  }

  private applySemanticSnapshot(snapshot: SemanticSnapshot) {
    this.data.worldId = snapshot.worldId;
    this.data.passages = snapshot.passages;
    this.data.passageArchive = snapshot.passageArchive;
    this.data.landmarks = snapshot.landmarks;
    this.data.chests = snapshot.chests;
    this.data.chestOps = snapshot.chestOps;
    this.data.furnaces = snapshot.furnaces;
    this.data.gone = snapshot.gone;
    this.data.farms = snapshot.farms;
    this.data.hazards = snapshot.hazards;
    this.data.visitedChunks = snapshot.visitedChunks;
    this.placedByPos.clear();
    this.placedByCell.clear();
    this.placedClock = 0;
    for (const entry of snapshot.placed) {
      const key = this.placedKey(entry.pos.x, entry.pos.y, entry.pos.z);
      this.placedByPos.set(key, { name: entry.name, at: entry.at });
      this.placedInsert(key, this.placedCell(entry.pos.x, entry.pos.y, entry.pos.z));
      this.placedClock = Math.max(this.placedClock, entry.at);
    }
    this.lastChunk = '';
    this.dirty = false;
    this.placedDirty = false;
  }

  private semanticSnapshot(): SemanticSnapshot {
    return {
      worldId: this.worldId,
      passages: structuredClone(this.data.passages ?? []),
      passageArchive: structuredClone(this.data.passageArchive ?? []),
      landmarks: structuredClone(this.data.landmarks),
      chests: structuredClone(this.data.chests ?? {}),
      chestOps: this.data.chestOps ?? 0,
      furnaces: structuredClone(this.data.furnaces ?? {}),
      gone: structuredClone(this.data.gone ?? []),
      farms: structuredClone(this.data.farms ?? []),
      hazards: structuredClone(this.data.hazards ?? []),
      placed: [...this.placedByPos].map(([key, value]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { pos: { x, y, z }, name: value.name, at: value.at };
      }),
      visitedChunks: { ...this.data.visitedChunks },
    };
  }

  private diskData(): MemoryData {
    if (!this.spatial) return this.data;
    return {
      ...this.data,
      passages: [],
      passageArchive: [],
      landmarks: [],
      chests: {},
      chestOps: 0,
      furnaces: {},
      gone: [],
      farms: [],
      hazards: [],
      visitedChunks: {},
    };
  }

  setWorld(worldId: string) {
    if (!worldId || worldId === this.data.worldId) return;
    if (this.spatial) {
      this.spatial.selectWorld(worldId);
      this.applySemanticSnapshot(this.spatial.load());
      this.dirty = true;
      return;
    }
    if (this.data.worldId === 'default') {
      for (const l of this.data.landmarks) l.worldId ??= worldId;
      for (const c of Object.values(this.data.chests)) c.worldId ??= worldId;
      for (const f of this.data.farms) f.worldId ??= worldId;
      if (this.data.lastDeath && !this.data.lastDeath.worldId) {
        this.data.lastDeath.worldId = worldId;
        const existing = this.data.deaths[worldId];
        this.data.deaths[worldId] = Array.isArray(existing) ? [...existing, this.data.lastDeath].slice(-3) : [this.data.lastDeath];
      }
      this.data.visitedChunks = Object.fromEntries(Object.entries(this.data.visitedChunks).map(([key, count]) => [key.startsWith('default:') ? `${worldId}:${key.slice('default:'.length)}` : `${worldId}:${key}`, count]));
      for (const category of ['blocks', 'entities', 'biomes'] as const) {
        this.data.seen[category] = Object.fromEntries(Object.entries(this.data.seen[category]).map(([name, ts]) => [`${worldId}:${name.startsWith('default:') ? name.slice('default:'.length) : name}`, ts]));
      }
    }
    this.data.worldId = worldId;
    this.lastChunk = '';
    this.touch();
  }

  /** Commit related identity/state changes together through the existing atomic file replacement. */
  transaction<T>(fn: () => T): T {
    const snapshot = this.transactionDepth === 0 ? structuredClone(this.data) : null;
    const wasDirty = this.dirty;
    let succeeded = false;
    this.transactionDepth++;
    try { const result = fn(); succeeded = true; return result; }
    catch (error) { if (snapshot) { this.data = snapshot; this.dirty = wasDirty; } throw error; }
    finally {
      this.transactionDepth--;
      if (!this.transactionDepth) {
        this.flush();
        if (succeeded) reservationsFor(this).reconcile(this.data.projects);
      }
    }
  }

  private checkpoint() { this.touch(); if (!this.transactionDepth) this.flush(); }

  /** 清理旧版本留下的“透视”数据 */
  private migrate() {
    // 箱子：旧版模糊印象 → 直接丢弃内容，只留箱子身份；内容等下次打开再精确补上（不看版本号，旧样子就转）
    for (const [k, c] of Object.entries(this.data.chests ?? {})) {
      if (!c || (c as ChestRecord).contents) continue;
      this.data.chests[k] = migrateChest(c as any);
      this.touch();
    }
    // 死亡记录：旧版一个 world 只存一条对象，现改成按 world 存最近若干条（数组）
    for (const [k, v] of Object.entries(this.data.deaths ?? {})) {
      if (!Array.isArray(v)) this.data.deaths[k] = v ? [v] : [];
    }
    const version = this.data.version ?? 1;
    if (version >= MEMORY_VERSION) return;
    if (version < 2) {
    const before = this.data.landmarks.length;
    this.data.landmarks = this.data.landmarks.filter(
      (l) => l.kind === 'base' || l.kind === 'waypoint' || l.label.startsWith('biome:') || l.label.startsWith('我的') || l.label === '火把',
    );
    this.migrated = before - this.data.landmarks.length;
    // “首次见过”的方块也可能是穿墙得来的，重新计
    this.data.seen.blocks = {};
    }
    if (version < 4) {
      // 一次性把膨胀的地标压回健康：discovery 每 label 留最近 8、开挖入口/进度 waypoint 只留最近 8
      const capGroup = (keep: (l: Landmark) => boolean, cap: number) => {
        const groups = new Map<string, Landmark[]>();
        for (const l of this.data.landmarks) if (keep(l)) {
          const key = `${l.worldId ?? 'default'}|${l.dim}|${l.label}`;
          (groups.get(key) ?? groups.set(key, []).get(key)!).push(l);
        }
        const drop = new Set<Landmark>();
        for (const list of groups.values()) {
          list.sort((a, b) => b.ts - a.ts);
          for (const l of list.slice(cap)) drop.add(l);
        }
        if (drop.size) this.data.landmarks = this.data.landmarks.filter((l) => !drop.has(l));
      };
      capGroup((l) => l.kind === 'discovery', DISCOVERY_LABEL_CAP);
      capGroup((l) => l.kind === 'waypoint' && l.label.startsWith('实际开挖'), EXCAVATION_WAYPOINT_CAP);
    }
    // A legacy objective is a suggestion to revisit, never a fabricated project.
    if (this.data.objective?.text && !this.data.intents.some((i) => i.source === 'legacy')) {
      this.data.intents.push({
        id: shortId('int_'), text: this.data.objective.text, whyNow: '从旧 objective 迁移，等待回顾',
        context: [], tradeoffs: [], source: 'legacy', status: 'open',
        createdAt: this.data.objective.ts, updatedAt: Date.now(),
      });
    }
    this.data.version = MEMORY_VERSION;
    this.touch();
  }

  private recoverProjects() {
    // A process restart restores records/checkpoints, never an in-flight action cursor.
    for (const project of this.data.projects) {
      if (['active', 'paused', 'blocked'].includes(project.status)) {
        if (!project.pauseReasons.includes('restart')) project.pauseReasons.push('restart');
        if (project.status !== 'blocked') project.status = 'paused';
        project.checkpoint = { ...project.checkpoint, ts: Date.now(), reason: 'process_restart' };
        this.touch();
      }
    }
  }
  /**
   * 运行中改不了记忆文件（进程会定时写回、覆盖掉）：要人工纠正时，把改动写进同目录的 memory-patch.json，
   * 下次启动读记忆时套用一次，然后改名成 memory-patch.applied-<时间>.json。
   * 格式：{"removeLandmarks":["id"…], "removeChests":["键"…], "setChests":[箱子记录…], "removeFurnaces":["键"…], "markGone":[{label,dim,pos,now}…], "selectBase":"基地 id"（改首选基地/家）, "archivePassages":[历史通道记录…]}
   */
  patched: string[] = [];
  private applyPatch(file: string) {
    const pf = path.join(path.dirname(file), 'memory-patch.json');
    if (!fs.existsSync(pf)) return;
    try {
      const p = JSON.parse(fs.readFileSync(pf, 'utf8')) as { removeLandmarks?: string[]; removeChests?: string[]; setChests?: (Partial<ChestRecord> & { items?: { name: string; count: number }[] })[]; removeFurnaces?: string[]; markGone?: { label: string; dim: string; pos: Vec3Like; now?: string }[]; selectBase?: string; archivePassages?: PassageRecord[] };
      const ids = new Set(p.removeLandmarks ?? []);
      const before = this.data.landmarks.length;
      this.data.landmarks = this.data.landmarks.filter((l) => !ids.has(l.id));
      if (before !== this.data.landmarks.length) this.patched.push(`删了 ${before - this.data.landmarks.length} 个地标`);
      for (const k of p.removeChests ?? []) if (this.data.chests?.[k]) { delete this.data.chests[k]; this.patched.push(`删了箱子 ${k}`); }
      for (const c of p.setChests ?? []) {
        if (!c?.pos || !c.dim) continue;
        const rec = migrateChest({ ...c, worldId: c.worldId ?? this.data.worldId });
        if (Array.isArray(c.items)) rec.contents = { items: c.items.filter((i) => i.count > 0).map((i) => ({ name: i.name, count: i.count })), observedAt: Date.now(), day: c.day };
        (this.data.chests ??= {})[`${c.worldId ?? this.data.worldId}:${c.dim}:${c.pos.x},${c.pos.y},${c.pos.z}`] = rec;
        this.patched.push(`写入箱子 (${c.pos.x},${c.pos.y},${c.pos.z})`);
      }
      for (const k of p.removeFurnaces ?? []) if (this.data.furnaces?.[k]) { delete this.data.furnaces[k]; this.patched.push(`删了熔炉 ${k}`); }
      for (const g of p.markGone ?? []) if (g?.pos && g.label && g.dim) { this.markGone(g.label, g.dim, g.pos, g.now ?? '别的东西'); this.patched.push(`记下 (${g.pos.x},${g.pos.y},${g.pos.z}) 的 ${g.label} 已经没了`); }
      if (typeof p.selectBase === 'string' && p.selectBase) {
        const target = this.data.landmarks.find((l) => this.inWorld(l) && l.kind === 'base' && l.id === p.selectBase);
        if (target) {
          for (const l of this.data.landmarks) if (this.inWorld(l) && l.kind === 'base' && l.dim === target.dim) l.primary = l.id === target.id;
          this.patched.push(`首选基地（家）改成 ${target.label}`);
        } else this.patched.push(`没找到基地 ${p.selectBase}，首选没改`);
      }
      let archived = 0;
      for (const rec of p.archivePassages ?? []) {
        if (!rec || typeof rec.id !== 'string' || typeof rec.dim !== 'string' || !Array.isArray(rec.path) || rec.path.length === 0
          || !rec.path.every((v) => v && [v.x, v.y, v.z].every((n) => typeof n === 'number' && Number.isFinite(n)))) {
          this.patched.push('跳过一条格式不完整的历史通道归档记录');
          continue;
        }
        this.archivePassage(rec);
        archived++;
      }
      if (archived) this.patched.push(`归档 ${archived} 条历史通道`);
      this.touch();
      fs.renameSync(pf, path.join(path.dirname(file), `memory-patch.applied-${Date.now()}.json`));
    } catch (e) {
      this.patched.push(`memory-patch.json 没套用：${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
  }

  /** 迁移时清掉的地标数（main 启动时报告） */
  migrated = 0;

  flush() {
    if (!this.file || !this.dirty || this.transactionDepth) return;
    this.syncSpatial();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.diskData(), null, 1));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  // ------------------------------------------------ 自己放置的方块（LRU + 空间哈希）

  /** 放置成功时记一笔：同一格再放会更新方块名。 */
  putPlaced(pos: Vec3Like, name: string) {
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    const key = this.placedKey(x, y, z);
    const cell = this.placedCell(x, y, z);
    const prev = this.placedByPos.get(key);
    this.placedByPos.set(key, { name, at: this.placedClock++ });
    if (!prev) this.placedInsert(key, cell);
    this.placedDirty = true;
    this.evictPlaced();
  }

  /** 挖掉时移除：不是自己放的格是无害 no-op。 */
  removePlaced(pos: Vec3Like) {
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    const key = this.placedKey(x, y, z);
    if (!this.placedByPos.delete(key)) return;
    this.placedDelete(key, this.placedCell(x, y, z));
    this.placedDirty = true;
  }

  /** 这一格是不是自己放的；是则返回方块名，否则 null。O(1)。 */
  getPlaced(pos: Vec3Like): string | null {
    return this.placedByPos.get(this.placedKey(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)))?.name ?? null;
  }

  /** 附近自己放的方块（按 3D 距离 ≤ radius），只扫空间哈希里的附近格子。 */
  queryPlacedNear(pos: Vec3Like, radius: number): { pos: Vec3Like; name: string; dist: number }[] {
    const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
    const cr = Math.ceil(radius / PLACED_CELL);
    const cx0 = Math.floor(fx / PLACED_CELL), cy0 = Math.floor(fy / PLACED_CELL), cz0 = Math.floor(fz / PLACED_CELL);
    const out: { pos: Vec3Like; name: string; dist: number }[] = [];
    for (let dcx = -cr; dcx <= cr; dcx++) for (let dcy = -cr; dcy <= cr; dcy++) for (let dcz = -cr; dcz <= cr; dcz++) {
      const set = this.placedByCell.get(`${cx0 + dcx},${cy0 + dcy},${cz0 + dcz}`);
      if (!set) continue;
      for (const key of set) {
        const v = this.placedByPos.get(key);
        if (!v) continue;
        const [x, y, z] = key.split(',').map(Number);
        const dist = Math.hypot(x - fx, y - fy, z - fz);
        if (dist > radius) continue;
        v.at = this.placedClock++; // 正在用：刷新 LRU，不淘汰
        out.push({ pos: { x, y, z }, name: v.name, dist });
      }
    }
    return out;
  }

  /** 全部自己放下的方块（位置 + 方块名）：检测桥/路这类自建连续结构时枚举用。 */
  placedBlocks(): { pos: Vec3Like; name: string }[] {
    const out: { pos: Vec3Like; name: string }[] = [];
    for (const [key, v] of this.placedByPos) {
      const [x, y, z] = key.split(',').map(Number);
      out.push({ pos: { x, y, z }, name: v.name });
    }
    return out;
  }

  private flushPlaced() {
    if (this.spatial) return; // placed ledger is saved through the spatial store
    if (!this.file || !this.placedDirty) return;
    const byPos: Record<string, { name: string; at: number }> = {};
    for (const [key, v] of this.placedByPos) byPos[key] = v;
    const tmp = this.file + '.placed.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ byPos }));
    fs.renameSync(tmp, this.file + '.placed');
    this.placedDirty = false;
  }

  // ------------------------------------------------ 空间记忆 / 新颖性
  static chunkKey(dim: string, x: number, z: number) {
    return `${dim}:${Math.floor(x / 16)}:${Math.floor(z / 16)}`;
  }

  /** 进入一个区块时调用；返回是否首次访问。同一区块内重复调用不累加。 */
  visit(dim: string, pos: Vec3Like): boolean {
    const key = `${this.worldId}:${WorldMemory.chunkKey(dim, pos.x, pos.z)}`;
    if (key === this.lastChunk) return false;
    this.lastChunk = key;
    const first = !this.data.visitedChunks[key];
    this.data.visitedChunks[key] = (this.data.visitedChunks[key] ?? 0) + 1;
    this.touch();
    return first;
  }

  chunkVisits(dim: string, x: number, z: number): number {
    return this.data.visitedChunks[`${this.worldId}:${WorldMemory.chunkKey(dim, x, z)}`] ?? 0;
  }

  get visitedChunkCount() {
    return Object.keys(this.data.visitedChunks).filter((key) => key.startsWith(`${this.worldId}:`)).length;
  }

  /** 计数式新颖性：1/sqrt(n+1)，取目标点周围 3x3 区块平均。 */
  novelty(dim: string, x: number, z: number): number {
    let s = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) s += 1 / Math.sqrt(this.chunkVisits(dim, x + dx * 16, z + dz * 16) + 1);
    return s / 9;
  }

  markSeen(cat: 'blocks' | 'entities' | 'biomes' | 'items', name: string): boolean {
    const key = `${this.worldId}:${name}`;
    const bucket = (this.data.seen[cat] ??= {});
    if (bucket[key]) return false;
    bucket[key] = Date.now();
    this.touch();
    return true;
  }

  hasSeen(cat: 'blocks' | 'entities' | 'biomes' | 'items', name: string): boolean {
    return !!this.data.seen[cat]?.[`${this.worldId}:${name}`];
  }

  /** 当前世界里拿到过（进过背包）的物品：配方知识由此解锁，像原版配方书一样 */
  heldItems(): Set<string> {
    const prefix = `${this.worldId}:`;
    return new Set(Object.keys(this.data.seen.items ?? {}).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  }

  seenCount() {
    const s = this.data.seen;
    const count = (values: Record<string, number>) => Object.keys(values).filter((key) => key.startsWith(`${this.worldId}:`)).length;
    return { blocks: count(s.blocks), entities: count(s.entities), biomes: count(s.biomes) };
  }

  // ------------------------------------------------ 地标
  addLandmark(kind: LandmarkKind, label: string, dim: string, pos: Vec3Like, dedupeRadius = 24): Landmark | null {
    const radius = kind === 'discovery' && isContainerLandmark(label) ? 0.1 : dedupeRadius;
    const near = this.data.landmarks.find(
      (l) => this.inWorld(l) && l.kind === kind && l.label === label && l.dim === dim && dist3(l.pos, pos) < radius,
    );
    if (near) { near.ts = Date.now(); this.touch(); return null; }
    // 同一格的“工作台”和“我的工作台”只留一个：自己的那个
    if (kind === 'discovery') {
      const own = label.startsWith('我的') ? null : this.data.landmarks.find((l) => this.inWorld(l) && l.kind === 'discovery' && l.label === `我的${label}` && l.dim === dim && dist3(l.pos, pos) <= (isContainerLandmark(label) ? 0.1 : 2));
      if (own) { own.ts = Date.now(); this.touch(); return null; }
      if (label.startsWith('我的')) this.dropPlainTwins(label, dim, pos);
    }
    const lm: Landmark = {
      id: shortId(kind.slice(0, 3) + '_'),
      kind,
      label,
      dim,
      pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      ts: Date.now(),
      worldId: this.worldId,
    };
    this.data.landmarks.push(lm);
    // 设施/发现类同 label 限流：同世界同维同 label 超过上限就挤掉最旧，避免「73 个工作台」这类冗余无限堆积
    if (kind === 'discovery') {
      const same = this.data.landmarks.filter((l) => this.inWorld(l) && l.kind === 'discovery' && l.dim === dim && l.label === label);
      if (same.length > DISCOVERY_LABEL_CAP) {
        const oldest = same.sort((a, b) => a.ts - b.ts)[0];
        this.data.landmarks = this.data.landmarks.filter((l) => l !== oldest);
      }
    }
    this.evictOverCap(lm);
    this.touch();
    return lm;
  }

  /**
   * 超过容量时按价值从低到高淘汰一条最旧的现有地标：herd/danger/death → resource → waypoint → 非「我的」非容器的 discovery。
   * base 与「我的X」设施/容器永不淘汰——设施由上面的 label 限流约束、base 有 64 上限，总量因此有界；
   * 四档都为空（只剩 base + 「我的X」设施）时允许暂时超限，不淘汰、不失败，不会因为「放不下」拒绝记录。
   */
  private evictOverCap(exclude: Landmark) {
    if (this.data.landmarks.length <= LANDMARK_CAP) return;
    const pool = this.data.landmarks.filter((l) => this.inWorld(l) && l !== exclude);
    const tier = (accept: (l: Landmark) => boolean) => pool.filter(accept).sort((a, b) => a.ts - b.ts)[0];
    const candidate = tier((l) => ['herd', 'danger', 'death'].includes(l.kind))
      ?? tier((l) => l.kind === 'resource')
      ?? tier((l) => l.kind === 'waypoint')
      ?? tier((l) => l.kind === 'discovery' && !l.label.startsWith('我的') && !isContainerLandmark(l.label));
    if (!candidate) return;
    this.data.landmarks.splice(this.data.landmarks.indexOf(candidate), 1);
  }

  /** Containers only dedupe in the same cell; existing multi-block station rules remain unchanged. */
  private dropPlainTwins(ownLabel: string, dim: string, pos: Vec3Like, worldId = this.worldId) {
    const plain = ownLabel.slice('我的'.length);
    const radius = isContainerLandmark(plain) ? 0.1 : 2;
    const before = this.data.landmarks.length;
    this.data.landmarks = this.data.landmarks.filter((l) => !((l.worldId ?? 'default') === worldId && l.kind === 'discovery' && l.label === plain && l.dim === dim && dist3(l.pos, pos) <= radius));
    if (this.data.landmarks.length !== before) this.touch();
  }

  /**
   * 以前每睡一觉就在床边记一个没名字的“基地 N”，床收走了也不删，越攒越多，“回基地”也被带到最后睡过的地方。
   * 读档时清掉：同一世界、同一维度里没名字的基地只留编号最小的那个（出生点），起了名字的（自己定的、盖房记的）都留着；
   * 首选基地被清掉了，就改选最近确认过的有名字的基地。
   */
  private dropBedBases() {
    const unnamed = (l: Landmark) => l.kind === 'base' && /^基地 \d+$/.test(l.label);
    const num = (l: Landmark) => Number(l.label.replace(/\D/g, '')) || Infinity;
    const groups = new Map<string, Landmark[]>();
    for (const l of this.data.landmarks) if (l.kind === 'base') {
      const k = `${l.worldId ?? 'default'}|${l.dim}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(l);
    }
    let changed = false;
    for (const bases of groups.values()) {
      const auto = bases.filter(unnamed).sort((a, b) => num(a) - num(b));
      if (auto.length <= 1) continue;
      const drop = new Set(auto.slice(1));
      this.data.landmarks = this.data.landmarks.filter((l) => !drop.has(l));
      changed = true;
      const left = bases.filter((l) => !drop.has(l));
      if (!left.some((l) => l.primary)) {
        const pick = left.filter((l) => !unnamed(l)).sort((a, b) => b.ts - a.ts)[0] ?? left[0];
        for (const l of left) l.primary = l === pick;
      }
    }
    if (changed) this.touch();
  }

  /** 读档时把以前留下的成对地标（“工作台”+“我的工作台”）合并掉 */
  private dedupeOwnTwins() {
    for (const l of [...this.data.landmarks]) if (l.kind === 'discovery' && l.label.startsWith('我的')) this.dropPlainTwins(l.label, l.dim, l.pos, l.worldId ?? 'default');
  }

  /**
   * 记一个基地。select 决定要不要把它设为该维度的首选（“家”）：
   * 不传时只有该维度还没有首选基地才设首选——盖好一个前哨、畜栏不等于搬家，搬家要自己 base_memory select 决定。
   */
  setBase(dim: string, pos: Vec3Like, label?: string, opts: { select?: boolean } = {}): Landmark {
    if (typeof dim !== 'string' || !dim || !pos || [pos.x, pos.y, pos.z].some((n) => !Number.isFinite(n))) throw new Error('基地需要实际维度与有限坐标');
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 100)) throw new Error('基地名称需要 1–100 字符');
    const hadPrimary = this.data.landmarks.some((l) => this.inWorld(l) && l.kind === 'base' && l.dim === dim && l.primary);
    let base = this.data.landmarks.filter((l) => this.inWorld(l) && l.kind === 'base' && l.dim === dim && dist3(l.pos, pos) <= 4).sort((a, b) => dist3(a.pos, pos) - dist3(b.pos, pos))[0];
    if (!base) {
      if (this.bases().length >= 64) throw new Error('当前世界已保存 64 个基地，需要先人工回顾，不能静默丢弃旧基地');
      if (this.data.landmarks.length >= 200) {
        const disposable = this.data.landmarks.map((landmark, index) => ({ landmark, index })).filter(({ landmark }) => ['herd', 'resource', 'danger', 'death'].includes(landmark.kind)).sort((a, b) => a.landmark.ts - b.landmark.ts)[0];
        if (!disposable) throw new Error('地标档案已满；保留所有重要地点，无法新增基地');
        this.data.landmarks.splice(disposable.index, 1);
      }
      base = { id: shortId('base_'), kind: 'base', label: label?.trim() ?? `基地 ${this.bases(dim).length + 1}`, worldId: this.worldId, dim, pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, ts: Date.now() };
      this.data.landmarks.push(base);
    } else {
      base.pos = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
      base.ts = Date.now();
      if (label !== undefined) base.label = label.trim();
    }
    const select = opts.select ?? !hadPrimary;
    if (select) return this.selectBase(base.id);
    this.touch();
    return structuredClone(base);
  }

  private inWorld(record: { worldId?: string }): boolean { return (record.worldId ?? 'default') === this.worldId; }

  base(dim?: string): Landmark | undefined {
    const bases = this.bases(dim);
    return bases.find((l) => l.primary) ?? bases[0];
  }

  bases(dim?: string): Landmark[] {
    return structuredClone(this.data.landmarks.filter((l) => this.inWorld(l) && l.kind === 'base' && (!dim || l.dim === dim)));
  }

  selectBase(id: string): Landmark {
    const index = this.data.landmarks.findIndex((l) => this.inWorld(l) && l.kind === 'base' && l.id === id);
    if (index < 0) throw new Error('只能选择当前世界中实际记得的基地');
    const selected = this.data.landmarks[index];
    for (const base of this.data.landmarks) if (this.inWorld(base) && base.kind === 'base' && base.dim === selected.dim) base.primary = base.id === id;
    // Ordering records the selection among dimensions; observation timestamps stay intact.
    this.data.landmarks.splice(index, 1);
    this.data.landmarks.unshift(selected);
    this.checkpoint();
    return structuredClone(selected);
  }

  findLandmark(q: string, dim?: string): Landmark | undefined {
    const s = q.trim().toLowerCase();
    if (s === 'base' || s === '基地') return this.base(dim);
    const candidates = this.landmarks().filter((l) => !dim || l.dim === dim);
    const found = (
      candidates.find((l) => l.id.toLowerCase() === s) ??
      candidates.find((l) => l.label.toLowerCase() === s) ??
      candidates.find((l) => l.label.toLowerCase().includes(s))
    );
    if (!found || !isContainerLandmark(found.label)) return found;
    const location = chestLocation(found);
    return { ...found, pos: location.pos, radius: location.radius, precise: location.precise, observedAt: location.observedAt };
  }

  landmarks(): Landmark[] {
    return this.data.landmarks.filter((l) => this.inWorld(l));
  }

  /** 亲眼看到某处的资源/危险已经没了（现在是 now） */
  markGone(label: string, dim: string, pos: Vec3Like, now: string) {
    const all = (this.data.gone ??= []);
    const i = all.findIndex((g) => this.inWorld(g) && g.dim === dim && g.label === label && dist3(g.pos, pos) <= 1);
    const rec: GoneSpot = { worldId: this.worldId, dim, label, pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }, now, ts: Date.now() };
    if (i >= 0) all[i] = rec; else all.push(rec);
    if (all.length > 120) all.splice(0, all.length - 120);
    this.touch();
  }

  /** 某个坐标附近亲眼看到已经没了的东西（又看见它了就不算） */
  goneNear(dim: string, pos: Vec3Like, r = 3): GoneSpot[] {
    return (this.data.gone ?? []).filter((g) => this.inWorld(g) && g.dim === dim && dist3(g.pos, pos) <= r
      && !this.data.landmarks.some((l) => this.inWorld(l) && l.dim === dim && l.label === g.label && dist3(l.pos, g.pos) <= 1));
  }

  removeLandmark(id: string): boolean {
    const i = this.data.landmarks.findIndex((l) => this.inWorld(l) && l.id === id);
    if (i < 0 || this.data.landmarks[i].kind === 'base') return false;
    this.data.landmarks.splice(i, 1);
    this.touch();
    return true;
  }

  /**
   * 不主动攻击的生物（羊、牛、狼、村民……）在哪一带出没：同一种 32 格内只记一处，再看见就挪到这回看见的中心、刷新数量和时间。
   * 每个世界最多记 40 处，满了先忘最久没见的。
   */
  noteHerd(label: string, dim: string, pos: Vec3Like, count: number, detail?: string): Landmark {
    const p = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
    const near = this.data.landmarks.find((l) => this.inWorld(l) && l.kind === 'herd' && l.label === label && l.dim === dim && dist3(l.pos, p) < 32);
    if (near) {
      near.pos = p; near.ts = Date.now(); near.count = count;
      if (detail) near.detail = detail; else delete near.detail;
      this.touch();
      return near;
    }
    const herds = this.data.landmarks.filter((l) => this.inWorld(l) && l.kind === 'herd').sort((a, b) => a.ts - b.ts);
    if (herds.length >= 40) this.data.landmarks = this.data.landmarks.filter((l) => l !== herds[0]);
    const lm: Landmark = { id: shortId('herd_'), kind: 'herd', label, dim, pos: p, ts: Date.now(), worldId: this.worldId, count, ...(detail ? { detail } : {}) };
    this.data.landmarks.push(lm);
    this.touch();
    return lm;
  }

  /** 资源地标附近 radius 格内、名字匹配 names 的地标 */
  resourceLandmarksNear(names: string[], dim: string, pos: Vec3Like, radius: number): Landmark[] {
    return this.landmarks().filter((l) => l.kind === 'resource' && l.dim === dim && names.includes(l.label) && dist3(l.pos, pos) <= radius);
  }

  // ------------------------------------------------ 技能 / 目标 / 笔记
  recordSkill(name: string, status: 'succeeded' | 'failed' | 'cancelled', failCode?: string) {
    const s = (this.data.skillStats[name] ??= { runs: 0, ok: 0, fail: 0, cancelled: 0, failCodes: {} });
    s.runs++;
    if (status === 'succeeded') s.ok++;
    else if (status === 'failed') {
      s.fail++;
      if (failCode) s.failCodes[failCode] = (s.failCodes[failCode] ?? 0) + 1;
    } else s.cancelled++;
    this.touch();
  }

  skillStats() {
    return this.data.skillStats;
  }

  recordGoal(g: Omit<GoalRecord, 'ts'>) {
    this.data.goals.push({ id: shortId('goal_'), worldId: this.worldId, ts: Date.now(), ...g });
    if (this.data.goals.length > 100) this.data.goals.shift();
    this.touch();
  }

  recentGoals(n = 8) {
    return this.data.goals.slice(-n);
  }

  addNote(kind: Note['kind'], text: string, dimension?: string, pos?: Vec3Like): Note | null {
    const t = text.trim().slice(0, 200);
    if (!t) return null;
    const at = pos && [pos.x, pos.y, pos.z].every(Number.isFinite) ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : undefined;
    // 同一世界、同一维度、写在附近（或没有位置）的同一句话只记一次；换个地方写同一句话是新的观察
    const same = this.data.notes.find((n) => this.inWorld(n) && n.text === t && (n.dimension ?? dimension) === dimension
      && (!at || !n.pos || dist3(n.pos, at) <= 16));
    if (same) return null;
    const note: Note = { id: shortId('note_'), worldId: this.worldId, dimension, ts: Date.now(), kind, text: t, ...(at ? { pos: at } : {}) };
    this.data.notes.push(note);
    if (this.data.notes.length > 60) this.data.notes.shift();
    this.touch();
    return structuredClone(note);
  }

  recentNotes(n = 10) {
    return this.data.notes.slice(-n);
  }

  /** 当前世界（可限定维度、时间窗口）最近的笔记，旧的在前 */
  notesFor(opts: { dimension?: string; withinMs?: number; n?: number } = {}): Note[] {
    const cut = opts.withinMs ? Date.now() - opts.withinMs : 0;
    return this.data.notes.filter((x) => this.inWorld(x) && x.ts >= cut && (!opts.dimension || !x.dimension || x.dimension === opts.dimension))
      .slice(-(opts.n ?? 10)).map((x) => structuredClone(x));
  }

  // ------------------------------------------------ 死亡与掉落物
  setDeath(d: DeathRecord) {
    const rec = { ...d, worldId: this.worldId, pos: { x: Math.round(d.pos.x), y: Math.round(d.pos.y), z: Math.round(d.pos.z) } };
    this.data.lastDeath = rec;
    this.data.deaths[this.worldId] = [...(this.data.deaths[this.worldId] ?? []), rec].slice(-3);
    this.touch();
  }

  /** 游戏的死亡播报晚一点才到：补上原文和更可靠的死因 */
  updateDeathMessage(message: string, cause?: string) {
    const death = this.lastDeath();
    if (!death) return;
    death.message = message.slice(0, 300);
    if (cause && cause !== 'unknown') death.cause = cause;
    this.touch();
  }

  updateDeathLost(lost: DeathRecord['lost']) {
    const death = this.lastDeath();
    if (!death) return;
    death.lost = lost;
    this.touch();
  }

  lastDeath(): DeathRecord | null {
    const list = this.data.deaths[this.worldId];
    if (list?.length) return list[list.length - 1];
    return (this.data.lastDeath && this.inWorld(this.data.lastDeath)) ? this.data.lastDeath : null;
  }

  /** 最近几次死亡（最新在末尾），最多 limit 条；Agent 自己判断要不要回到最远点继续 */
  recentDeaths(limit = 3): DeathRecord[] {
    return (this.data.deaths[this.worldId] ?? []).slice(-limit);
  }

  clearDeath() {
    if (!this.lastDeath()) return;
    delete this.data.deaths[this.worldId];
    if (this.data.lastDeath && this.inWorld(this.data.lastDeath)) this.data.lastDeath = null;
    this.touch();
  }

  // ------------------------------------------------ 危险区域（程序记录的真实出事地点）
  /**
   * 危险区域会慢慢淡化：很久没再出事（约 2 个游戏日 = 40 分钟，出事次数多的保留更久，最多 3 倍）之后，
   * 半径每 20 分钟缩 2 格，缩到 2 格以下就过期（不再出现在提示词里，也不再绕开）。
   */
  static readonly HAZARD_FADE_MS = 40 * 60_000;
  private effectiveHazard(z: Hazard, now = Date.now()): Hazard | null {
    const fadeStart = WorldMemory.HAZARD_FADE_MS * Math.min(3, Math.max(1, z.count));
    const over = now - z.ts - fadeStart;
    if (over <= 0) return z;
    const radius = z.radius - 2 * Math.ceil(over / (20 * 60_000));
    return radius < 3 ? null : { ...z, radius };
  }

  /** 记一次出事：同一世界/维度、同类、6 格内的旧记录合并（次数 +1，半径随次数变大） */
  addHazard(h: { dim: string; pos: Vec3Like; kind: HazardKind; during?: string; note?: string }): Hazard {
    const pos = { x: Math.round(h.pos.x), y: Math.round(h.pos.y), z: Math.round(h.pos.z) };
    const list = (this.data.hazards ??= []);
    const now = Date.now();
    // 过期很久（再过一个淡化周期）的记录直接清掉
    for (let i = list.length - 1; i >= 0; i--) if (!this.effectiveHazard(list[i], now - WorldMemory.HAZARD_FADE_MS)) list.splice(i, 1);
    const old = list.find((z) => this.inWorld(z) && z.dim === h.dim && z.kind === h.kind && this.effectiveHazard(z, now) && dist3(z.pos, pos) <= Math.max(6, z.radius));
    if (old) {
      old.count++;
      old.ts = now;
      old.radius = Math.min(12, 4 + old.count * 2);
      if (h.during) old.during = h.during.slice(0, 120);
      if (h.note) old.note = h.note.slice(0, 200);
      this.checkpoint();
      return structuredClone(old);
    }
    const z: Hazard = { id: shortId('hz_'), worldId: this.worldId, dim: h.dim, pos, radius: 6, kind: h.kind, count: 1,
      ...(h.during ? { during: h.during.slice(0, 120) } : {}), ...(h.note ? { note: h.note.slice(0, 200) } : {}), firstTs: now, ts: now };
    list.push(z);
    if (list.length > 40) list.splice(0, list.length - 40);
    this.checkpoint();
    return structuredClone(z);
  }

  /** 当前世界的危险区域（可按维度过滤），最近出事的在后 */
  hazards(dim?: string): Hazard[] {
    const now = Date.now();
    return (this.data.hazards ?? []).filter((z) => this.inWorld(z) && (!dim || z.dim === dim)).sort((a, b) => a.ts - b.ts)
      .flatMap((z) => { const e = this.effectiveHazard(z, now); return e ? [structuredClone(e)] : []; });
  }

  /** pos 是否落在某个危险区域里（可限定种类）；返回最严重（出事次数最多）的那个 */
  hazardAt(pos: Vec3Like, dim: string, kinds?: HazardKind[]): Hazard | null {
    let best: Hazard | null = null;
    const now = Date.now();
    for (const raw of this.data.hazards ?? []) {
      if (!this.inWorld(raw) || raw.dim !== dim || (kinds && !kinds.includes(raw.kind))) continue;
      const z = this.effectiveHazard(raw, now);
      if (!z) continue;
      if (dist3(z.pos, pos) > z.radius) continue;
      if (!best || z.count > best.count) best = z;
    }
    return best ? structuredClone(best) : null;
  }

  // ------------------------------------------------ 效率统计
  recordDig(block: string, tool: string | null, ms: number) {
    this.data.digs.push({ ts: Date.now(), block, tool, ms: Math.round(ms) });
    if (this.data.digs.length > 300) this.data.digs.splice(0, this.data.digs.length - 300);
    this.touch();
  }

  recentDigs(windowMs = 20 * 60_000): DigRecord[] {
    const cut = Date.now() - windowMs;
    return (this.data.digs ?? []).filter((d) => d.ts >= cut);
  }

  // ------------------------------------------------ 自己挖的通道
  passages(dim?: string): PassageRecord[] {
    return structuredClone((this.data.passages ?? []).filter((p) => this.inWorld(p) && (!dim || p.dim === dim)));
  }

  /** 被 live 工作集淘汰的历史通道；显式查询和旧路导航可读。 */
  archivedPassages(dim?: string): PassageRecord[] {
    return structuredClone((this.data.passageArchive ?? []).filter((p) => this.inWorld(p) && (!dim || p.dim === dim)));
  }

  /** live 工作集 + 历史归档；同 ID 以 live 为准。调用方必须把归档点当历史几何，不能当当前可通行。 */
  allPassages(dim?: string): PassageRecord[] {
    const live = this.passages(dim);
    const ids = new Set(live.map((p) => p.id));
    return [...live, ...this.archivedPassages(dim).filter((p) => !ids.has(p.id))];
  }

  /** 把一条旧通道放进历史归档（回填或 live 淘汰时用）。 */
  archivePassage(rec: PassageRecord) {
    const copy = structuredClone({ ...rec, worldId: rec.worldId ?? this.worldId, archivedAt: Date.now() });
    const archive = (this.data.passageArchive ??= []);
    const i = archive.findIndex((p) => p.id === copy.id && this.inWorld(p));
    if (i >= 0) archive[i] = copy; else archive.push(copy);
    this.trimPassageArchive();
    this.spatial?.savePassageNow(copy);
    this.touch();
  }

  private trimPassageArchive() {
    let archive = this.data.passageArchive;
    if (!archive) return;
    let changed = false;
    // bridge 是可从 placedBlocks 重新推导的施工记录，不能因数量大而把 dug/walked 旧矿道挤出归档。
    const bridges = archive.filter((p) => p.kind === 'bridge').sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    if (bridges.length > PASSAGE_BRIDGE_ARCHIVE_CAP) {
      const keep = new Set(bridges.slice(0, PASSAGE_BRIDGE_ARCHIVE_CAP));
      archive = archive.filter((p) => p.kind !== 'bridge' || keep.has(p));
      this.data.passageArchive = archive;
      changed = true;
    }
    if (archive.length > PASSAGE_ARCHIVE_CAP) {
      archive.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      archive.splice(0, archive.length - PASSAGE_ARCHIVE_CAP);
      changed = true;
    }
    if (changed) this.touch();
  }

  /** 新记或更新一条通道；live 工作集最多留 PASSAGE_LIVE_CAP 条，满了移入历史归档而不是丢弃 */
  savePassage(rec: PassageRecord) {
    const all = (this.data.passages ??= []);
    const i = all.findIndex((p) => p.id === rec.id);
    const copy = structuredClone({ ...rec, worldId: rec.worldId ?? this.worldId });
    delete copy.archivedAt;
    if (i >= 0) all[i] = copy; else all.push(copy);
    // 同一条记录重新进入 live 工作集后，归档里的旧副本不再参与读取。
    const archive = this.data.passageArchive;
    const ai = archive?.findIndex((p) => p.id === copy.id && this.inWorld(p)) ?? -1;
    if (archive && ai >= 0) archive.splice(ai, 1);
    const mine = all.filter((p) => this.inWorld(p));
    if (mine.length > PASSAGE_LIVE_CAP) {
      // 满了先移走"走过的路"（最久没走过的），再轮到最久没走过的"我挖的通道"
      const walked = mine.filter((p) => p.kind === 'walked').sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      const victim = walked ?? mine.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      all.splice(all.indexOf(victim), 1);
      this.archivePassage(victim);
    }
    this.spatial?.savePassageNow(structuredClone({ ...copy, worldId: copy.worldId ?? this.worldId }));
    this.touch();
  }

  /** 一条通道并进了另一条：这条就不单独留了 */
  forgetPassage(id: string) {
    const all = this.data.passages ?? [];
    const i = all.findIndex((p) => p.id === id && this.inWorld(p));
    if (i >= 0) all.splice(i, 1);
    const archive = this.data.passageArchive;
    const ai = archive?.findIndex((p) => p.id === id && this.inWorld(p)) ?? -1;
    if (archive && ai >= 0) archive.splice(ai, 1);
    if (i >= 0 || ai >= 0) {
      this.spatial?.forgetPassageNow(id);
      this.touch();
    }
  }

  // ------------------------------------------------ 仓储
  private chestKey(dim: string, pos: Vec3Like) { return `${this.worldId}:${dim}:${pos.x},${pos.y},${pos.z}`; }
  /** 箱子记忆的“现在”：游戏日 + 开箱序号，用来算印象淡了多少 */
  chestClock(day?: number): Clock { return { day, now: Date.now(), op: this.data.chestOps ?? 0 }; }

  /**
   * 用了一次箱子（存、取、或只是打开看了看）：按人的注意力记印象——放过什么记得牢，拿过的就不确定还剩多少，
   * 顺眼看到的只留最多几样，找过没有的记成“这里没有”。不抄清单（见 chest-memory.ts）
   */
  noteChestUse(dim: string, pos: Vec3Like, use: ChestUse) {
    const k = this.chestKey(dim, pos);
    const all = (this.data.chests ??= {});
    this.data.chestOps = (this.data.chestOps ?? 0) + 1;
    const rec = all[k] ?? (all[k] = { worldId: this.worldId, dim, pos: { x: pos.x, y: pos.y, z: pos.z }, block: use.block ?? 'chest', uses: 0, ts: Date.now(), contents: { items: [], observedAt: 0, possiblyStale: true } });
    const clock = { ...this.chestClock(use.day), now: use.now ?? Date.now() };
    applyContents(rec, use, clock);
    this.touch();
    return rec;
  }

  /** 老接口：知道这个箱子里有这些东西（当作自己放进去的）。新代码用 noteChestUse */
  setChest(dim: string, pos: Vec3Like, items: { name: string; count: number }[], day?: number) {
    return this.noteChestUse(dim, pos, { put: items, seen: items, day });
  }

  /** 那里已经不是箱子了（被挖、被炸）：别再惦记 */
  forgetChest(dim: string, pos: Vec3Like) {
    const k = this.chestKey(dim, pos);
    if (this.data.chests?.[k]) { delete this.data.chests[k]; this.touch(); }
  }

  chests(dim?: string): ChestRecord[] {
    return Object.values(this.data.chests ?? {}).filter((c) => this.inWorld(c) && (!dim || c.dim === dim));
  }

  chestAt(dim: string, pos: Vec3Like): ChestRecord | undefined {
    const c = this.data.chests?.[this.chestKey(dim, pos)];
    return c && this.inWorld(c) ? c : undefined;
  }

  /** 想找某样东西：记得哪些箱子里有、各多少，近的在前（accept 可以放宽：找木板时原木也算） */
  recallChests(accept: string | ((name: string) => boolean), opts: { dim?: string; day?: number; from?: Vec3Like } = {}): ChestRecall[] {
    const fn = typeof accept === 'string' ? (n: string) => n === accept : accept;
    return recall(this.chests(opts.dim), fn, this.chestClock(opts.day), opts.from);
  }

  /** 熔炉里留下了东西就记着；取空了（或者那里不再是熔炉）就忘掉 */
  setFurnace(rec: Omit<FurnaceRecord, 'worldId' | 'ts'> & { ts?: number }) {
    const k = `${this.worldId}:${rec.dim}:${rec.pos.x},${rec.pos.y},${rec.pos.z}`;
    const all = (this.data.furnaces ??= {});
    if (!rec.input && !rec.output) { if (all[k]) { delete all[k]; this.touch(); } return; }
    all[k] = { worldId: this.worldId, ...rec, ts: rec.ts ?? Date.now() };
    this.touch();
  }

  forgetFurnace(dim: string, pos: Vec3Like) {
    const k = `${this.worldId}:${dim}:${pos.x},${pos.y},${pos.z}`;
    if (this.data.furnaces?.[k]) { delete this.data.furnaces[k]; this.touch(); }
  }

  furnaces(dim?: string): FurnaceRecord[] {
    return Object.values(this.data.furnaces ?? {}).filter((c) => this.inWorld(c) && (!dim || c.dim === dim));
  }

  // ------------------------------------------------ 农田
  addFarm(f: FarmRecord) {
    (this.data.farms ??= []).push({ ...f, worldId: this.worldId });
    this.touch();
  }

  farms(): FarmRecord[] {
    return (this.data.farms ?? []).filter((f) => this.inWorld(f));
  }

  updateFarm(id: string, patch: Partial<FarmRecord>) {
    const f = this.farms().find((x) => x.id === id);
    if (f) Object.assign(f, patch);
    this.touch();
  }

  // ------------------------------------------------ 经验教训（反思产出，长期保留）
  addLesson(text: string, opts: { source?: 'model' | 'observed'; key?: string; replaces?: string } = {}): Lesson | null {
    const t = text.trim().slice(0, 160);
    const list = (this.data.lessons ??= []);
    if (!t) return null;
    const source = opts.source ?? 'model';
    if (opts.key) {
      const old = list.find((l) => l.key === opts.key && this.inWorld(l))
        ?? list.find((l) => !l.key && l.source === source && (l.text === t || opts.replaces !== undefined && l.text === opts.replaces.trim().slice(0, 160)) && this.inWorld(l));
      if (old) {
        if (old.text === t && old.key === opts.key) return null;
        old.text = t; old.key = opts.key; old.ts = Date.now(); old.source = source;
        this.touch();
        return structuredClone(old);
      }
    }
    if (list.some((l) => l.text === t && (l.worldId ?? this.worldId) === this.worldId)) return null;
    const lesson: Lesson = { ts: Date.now(), text: t, worldId: this.worldId, source, ...(opts.key ? { key: opts.key } : {}) };
    list.push(lesson);
    if (list.length > 40) {
      // 先挤掉最旧的模型推断；程序观察到的教训（死亡地点等）更值得留
      const i = list.findIndex((l) => l.source !== 'observed');
      list.splice(i >= 0 ? i : 0, 1);
    }
    this.touch();
    return structuredClone(lesson);
  }

  lessons(n = 10) {
    return (this.data.lessons ?? []).slice(-n);
  }

  /** 当前世界的经验（旧记录没有 worldId 也算），程序观察到的排在前面，各自按时间先后 */
  lessonsFor(n = 6): Lesson[] {
    const mine = (this.data.lessons ?? []).filter((l) => (l.worldId ?? this.worldId) === this.worldId);
    const observed = mine.filter((l) => l.source === 'observed');
    const model = mine.filter((l) => l.source !== 'observed');
    const last = <T>(a: T[], k: number) => k > 0 ? a.slice(-k) : [];
    // 程序观察到的至少占一半名额（模型推断不够时全给它们）
    const keepObserved = last(observed, Math.max(n - model.length, Math.ceil(n / 2)));
    const keepModel = last(model, n - keepObserved.length);
    return [...keepObserved, ...keepModel].slice(0, n).map((l) => structuredClone(l));
  }

  // ------------------------------------------------ 长期目标
  setObjective(text: string) {
    const t = text.trim().slice(0, 120);
    if (!t || this.data.objective?.text === t) return;
    this.data.objective = { text: t, ts: Date.now() };
    this.touch();
  }

  objective() {
    return this.data.objective;
  }

  // Durable choices, specifications and factual evidence are separate records.
  preferences(): Preference[] { return structuredClone(this.data.preferences); }
  intents(): Intent[] { return structuredClone(this.data.intents); }
  decisions(): Decision[] { return structuredClone(this.data.decisions); }
  projects(): Project[] { return structuredClone(this.data.projects); }
  evidence(): Evidence[] { return structuredClone(this.data.evidence); }
  pauseReasons(): PauseReason[] { return [...this.data.runtimePauseReasons]; }
  setPauseReason(reason: PauseReason, enabled: boolean) {
    const had = this.data.runtimePauseReasons.includes(reason);
    if (had === enabled) return;
    this.data.runtimePauseReasons = enabled ? [...this.data.runtimePauseReasons, reason] : this.data.runtimePauseReasons.filter((r) => r !== reason);
    this.checkpoint();
  }
  currentIntent(): Intent | undefined { return this.intents().reverse().find((i) => i.status === 'active'); }
  activeProject(): Project | undefined {
    return this.projects().reverse().find((p) => ['active', 'paused', 'blocked', 'undecomposed'].includes(p.status));
  }

  addIntent(input: Omit<Intent, 'id' | 'createdAt' | 'updatedAt'>): Intent {
    const intent: Intent = { ...structuredClone(input), id: shortId('int_'), createdAt: Date.now(), updatedAt: Date.now() };
    if (intent.status === 'active' && this.currentIntent()) throw new Error('只有一个意图可以处于进行状态');
    // Preserve unfinished interests: a full list needs an explicit review rather than silent FIFO loss.
    while (this.data.intents.length >= 120) {
      const index = this.data.intents.findIndex((i) => i.status === 'ended');
      if (index < 0) throw new Error('未完成意图已达 120 条，需要先回顾、结束或合并旧兴趣');
      this.data.intents.splice(index, 1);
    }
    this.data.intents.push(intent);
    this.checkpoint();
    return structuredClone(intent);
  }

  updateIntent(id: string, patch: Partial<Omit<Intent, 'id' | 'createdAt'>>) {
    const intent = this.data.intents.find((i) => i.id === id);
    if (!intent) throw new Error(`未知意图: ${id}`);
    if (patch.status === 'active' && this.currentIntent()?.id !== id && this.currentIntent()) throw new Error('已有进行中的意图');
    Object.assign(intent, structuredClone(patch), { updatedAt: Date.now() });
    this.checkpoint();
    return structuredClone(intent);
  }

  addPreference(input: Omit<Preference, 'id' | 'createdAt' | 'updatedAt'>): Preference {
    const existing = this.data.preferences.find((p) => p.text === input.text && p.source === input.source);
    if (existing) {
      existing.support = [...new Set([...existing.support, ...input.support])].slice(-20);
      existing.counterexamples = [...new Set([...existing.counterexamples, ...input.counterexamples])].slice(-20);
      existing.adjustmentReason = input.adjustmentReason;
      existing.updatedAt = Date.now();
      this.checkpoint();
      return structuredClone(existing);
    }
    const preference: Preference = { ...structuredClone(input), id: shortId('pref_'), createdAt: Date.now(), updatedAt: Date.now() };
    if (this.data.preferences.length >= 60) throw new Error('偏好记录已满，请回顾已有偏好');
    this.data.preferences.push(preference);
    this.checkpoint();
    return structuredClone(preference);
  }

  recordDecision(input: Omit<Decision, 'id' | 'ts'>): Decision {
    const decision = { ...structuredClone(input), id: shortId('dec_'), ts: Date.now() };
    this.data.decisions.push(decision);
    if (this.data.decisions.length > 200) this.data.decisions.shift();
    this.checkpoint();
    return structuredClone(decision);
  }

  saveProject(project: Project, persist = true) {
    const index = this.data.projects.findIndex((p) => p.id === project.id);
    const live = ['active', 'paused', 'blocked', 'undecomposed'];
    if (live.includes(project.status) && this.data.projects.some((p) => p.id !== project.id && live.includes(p.status))) {
      throw new Error('同一时间只能有一个活动项目');
    }
    if (index < 0) {
      while (this.data.projects.length >= 100) {
        const old = this.data.projects.findIndex((p) => ['completed', 'cancelled'].includes(p.status));
        if (old < 0) throw new Error('未结束项目已达 100 条，需要先回顾或取消旧工程');
        this.data.projects.splice(old, 1);
      }
      this.data.projects.push(structuredClone(project));
    } else {
      this.data.projects[index] = structuredClone(project);
    }
    if (persist) this.checkpoint(); else this.touch();
    if (!this.transactionDepth) reservationsFor(this).reconcile(this.data.projects);
  }

  recordEvidence(input: Omit<Evidence, 'id'>): Evidence {
    const evidence = { ...structuredClone(input), id: shortId('ev_') };
    this.data.evidence.push(evidence);
    if (this.data.evidence.length > 2000) {
      const protectedIds = new Set(this.data.projects.flatMap((p) => [p.lastEvidenceId, ...p.milestones.map((m) => m.evidenceId)]));
      const old = this.data.evidence.findIndex((e) => !protectedIds.has(e.id));
      if (old >= 0) this.data.evidence.splice(old, 1);
    }
    this.touch();
    return structuredClone(evidence);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    if (this.placedTimer) clearInterval(this.placedTimer);
    this.flush();
    this.flushPlaced();
  }
}

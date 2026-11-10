import fs from 'node:fs';
import path from 'node:path';
import type { EffectEvidence, Vec3Like } from '../adapter/types.ts';
import { dist3, shortId } from '../util.ts';
import { reservationsFor } from '../projects/reservations.ts';
import type { Decision, Intent, Preference } from '../intentions/types.ts';
import type { Evidence, PauseReason, Project } from '../projects/types.ts';
import type { ChestRecall, ChestRecord, ChestUse, Clock } from './chest-memory.ts';
import {
  BASE_CAP,
  DISCOVERY_LABEL_CAP,
  EXCAVATION_WAYPOINT_CAP,
  HERD_CAP,
  LANDMARK_CAP,
  PASSAGE_ARCHIVE_CAP,
  PASSAGE_BRIDGE_ARCHIVE_CAP,
  PASSAGE_LIVE_CAP,
  SpatialSemanticStore,
  type SpatialLibraryStores,
} from '../spatial/semantic-store.ts';
import { createInMemoryLibraryStores } from '../spatial/in-memory.ts';
import { ContainerLedger } from './container-ledger.ts';

export type { ChestRecord, ChestRecall, ChestContents, ChestUse } from './chest-memory.ts';
export { BASE_CAP, DISCOVERY_LABEL_CAP, EXCAVATION_WAYPOINT_CAP, HERD_CAP, LANDMARK_CAP, PASSAGE_ARCHIVE_CAP, PASSAGE_BRIDGE_ARCHIVE_CAP, PASSAGE_LIVE_CAP };

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
  /** 亲自走过的边（无瞬移；相邻单步或一次观测间隔内的位移）：历史路径图（spatial/path-graph）用它们连格建路线。
   *  run = 同一段连续观测的编号，建图只在这一段内部补漏采的小缺口；
   *  cut = 这一段从这条边开始（合并/去重拼接的边界），不能把数组前一条当成连续行程；
   *  reverse = 同一对格子后来反方向走过，记录顺序不再能证明单向（路由按双向处理）。 */
  links?: { a: Vec3Like; b: Vec3Like; run?: number; cut?: boolean; reverse?: boolean }[];
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
  /** 路径几何来源；迁移进来的旧记录为 legacy，运行期记录保持 traversal。 */
  geometrySource?: 'traversal' | 'observed_structure' | 'legacy';
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

/** addLesson 里模型窍门镜像的 key 前缀：它们是主 know_how 通道的副本，不是独立教训。 */
export const KNOW_HOW_LESSON_KEY_PREFIX = 'know_how:';

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
  lessons: Lesson[];
  seen: { blocks: Record<string, number>; entities: Record<string, number>; biomes: Record<string, number>; items?: Record<string, number> };
  skillStats: Record<string, SkillStat>;
  goals: GoalRecord[];
  notes: Note[];
  worldId: string;
  /** 它最后一次亲手拿到主手的东西（跨进程重启恢复；不替它重新挑工具） */
  lastHand?: string | null;
  /** lastHand 是否来自“亲手选择”。旧版把自动换手也写进来，没有这个标记的值一律不恢复 */
  lastHandExplicit?: boolean;
  preferences: Preference[];
  intents: Intent[];
  decisions: Decision[];
  projects: Project[];
  evidence: Evidence[];
  runtimePauseReasons: PauseReason[];
}

/** v2：地标只来自 Vision 亲眼所见。v1 的早期版本用 findBlocks（穿墙）写过矿物地标，加载时清掉 */
const MEMORY_VERSION = 4;
/** Spatial keys that older worlds wrote into world-memory.json. Removed after cutover. */
const LEGACY_SPATIAL_KEYS = [
  'passages', 'passageArchive', 'landmarks', 'chests', 'chestOps', 'furnaces', 'gone', 'farms', 'hazards', 'visitedChunks',
] as const;

const empty = (): MemoryData => ({
  version: MEMORY_VERSION,
  lastDeath: null,
  deaths: {},
  objective: null,
  digs: [],
  lessons: [],
  seen: { blocks: {}, entities: {}, biomes: {}, items: {} },
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
  private transactionDepth = 0;
  /** Native spatial semantic view; the library owns the facts. */
  private semantic: SpatialSemanticStore;
  /** True only for the no-file test/non-persistent fallback; production injects the session store. */
  private readonly fallbackSemantic: boolean;
  /** Fallback keeps one in-memory semantic world per world id (production is world-bound). */
  private readonly fallbackWorlds = new Map<string, SpatialSemanticStore>();

  constructor(
    private file: string | null,
    options: { semantic?: SpatialSemanticStore; worldId?: string } = {},
  ) {
    this.data = empty();
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const key of LEGACY_SPATIAL_KEYS) delete parsed[key];
        this.data = { ...empty(), ...parsed, version: parsed.version ?? 1 };
        this.migrate();
        this.recoverProjects();
      } catch {
        fs.copyFileSync(file, file + '.corrupt-' + Date.now());
        this.data = empty();
      }
    }
    // Production main always injects the opened spatial session (and the startup
    // gate refuses un-migrated worlds). Dev scripts/tests that construct a
    // file-backed memory without a session get an ephemeral in-memory view, never
    // the old JSON spatial store; `ephemeralSpatial` exposes that fact.
    this.fallbackSemantic = !options.semantic;
    this.semantic = options.semantic ?? new SpatialSemanticStore(
      createInMemoryLibraryStores(options.worldId ?? this.data.worldId),
      new ContainerLedger(null, options.worldId ?? this.data.worldId),
      { worldId: options.worldId ?? this.data.worldId },
    );
    if (this.fallbackSemantic) this.fallbackWorlds.set(this.semantic.world, this.semantic);
    if (this.data.worldId === 'default') this.data.worldId = this.semantic.world;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.timer = setInterval(() => this.flush(), 10000);
      this.timer.unref?.();
      // Materialize the non-spatial file (and drop any legacy spatial keys) even
      // before the first non-spatial mutation.
      this.touch();
      this.flush();
    }
  }

  get semanticStore(): SpatialSemanticStore { return this.semantic; }
  get containerLedger(): ContainerLedger { return this.semantic.containers; }
  get ephemeralSpatial(): boolean { return this.fallbackSemantic; }

  private touch() {
    this.dirty = true;
  }

  get dataDirectory(): string | null { return this.file ? path.dirname(this.file) : null; }
  get worldId(): string { return this.data.worldId; }

  setWorld(worldId: string) {
    if (!worldId || worldId === this.data.worldId) return;
    if (worldId !== this.semantic.world) {
      if (!this.fallbackSemantic) {
        throw new Error(`空间会话绑定在世界 ${this.semantic.world}，不能在运行中切到 ${worldId}；需要重开空间会话`);
      }
      const existing = this.fallbackWorlds.get(worldId);
      if (existing) this.semantic = existing;
      else {
        this.semantic = new SpatialSemanticStore(
          createInMemoryLibraryStores(worldId),
          new ContainerLedger(null, worldId),
          { worldId },
        );
        this.fallbackWorlds.set(worldId, this.semantic);
      }
    }
    if (this.data.worldId === 'default') {
      if (this.data.lastDeath && !this.data.lastDeath.worldId) {
        this.data.lastDeath.worldId = worldId;
        const existing = this.data.deaths[worldId];
        this.data.deaths[worldId] = Array.isArray(existing) ? [...existing, this.data.lastDeath].slice(-3) : [this.data.lastDeath];
      }
      for (const category of ['blocks', 'entities', 'biomes'] as const) {
        this.data.seen[category] = Object.fromEntries(Object.entries(this.data.seen[category]).map(([name, ts]) => [
          `${worldId}:${name.startsWith('default:') ? name.slice('default:'.length) : name}`, ts,
        ]));
      }
    }
    this.data.worldId = worldId;
    this.touch();
  }

  /** Commit related identity/state changes together through the existing atomic file replacement. */
  transaction<T>(fn: () => T): T {
    const snapshot = this.transactionDepth === 0 ? structuredClone(this.data) : null;
    const containers = this.transactionDepth === 0 ? this.semantic.containers.snapshot() : null;
    const wasDirty = this.dirty;
    let succeeded = false;
    this.transactionDepth++;
    try { const result = fn(); succeeded = true; return result; }
    catch (error) {
      if (snapshot) { this.data = snapshot; this.dirty = wasDirty; }
      if (containers) this.semantic.containers.restore(containers);
      throw error;
    }
    finally {
      this.transactionDepth--;
      if (!this.transactionDepth) {
        this.flush();
        if (succeeded) reservationsFor(this).reconcile(this.data.projects);
      }
    }
  }

  private checkpoint() { this.touch(); if (!this.transactionDepth) this.flush(); }

  /** Apply non-spatial migrations. Spatial data is migrated by the cutover command. */
  private migrate() {
    // 死亡记录：旧版一个 world 只存一条对象，现改成按 world 存最近若干条（数组）
    for (const [k, v] of Object.entries(this.data.deaths ?? {})) {
      if (!Array.isArray(v)) this.data.deaths[k] = v ? [v] : [];
    }
    const version = this.data.version ?? 1;
    if (version < 2) {
      // “首次见过”的方块也可能是穿墙得来的，重新计
      this.data.seen.blocks = {};
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
  /** Spatial memory-patch support moved to the cutover admin path. */
  patched: string[] = [];
  /** Kept for the startup diagnostic; spatial migrations now report through the cutover. */
  migrated = 0;

  flush() {
    if (this.transactionDepth) return;
    if (this.file && this.dirty) {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    }
    this.semantic.containers.flush();
  }

  // ------------------------------------------------ 自己放置的方块（ledger）

  /** 放置成功时记一笔：同一格再放会更新方块名。 */
  putPlaced(pos: Vec3Like, name: string, dim?: string) {
    if (dim) this.semantic.putPlaced(pos, name, dim);
    else this.semantic.putPlaced(pos, name);
  }

  /** 挖掉时移除：不是自己放的格是无害 no-op。 */
  removePlaced(pos: Vec3Like, dim?: string) {
    this.semantic.removePlaced(pos, dim);
  }

  /** 这一格是不是自己放的；是则返回方块名，否则 null。 */
  getPlaced(pos: Vec3Like, dim?: string): string | null {
    return this.semantic.getPlaced(pos, dim);
  }

  /** 附近自己放的方块（按 3D 距离 ≤ radius）。 */
  queryPlacedNear(pos: Vec3Like, radius: number, dim?: string): { pos: Vec3Like; name: string; dist: number }[] {
    return this.semantic.queryPlacedNear(pos, radius, dim);
  }

  /** 全部自己放下的方块（位置 + 方块名）：检测桥/路这类自建连续结构时枚举用。 */
  placedBlocks(): { pos: Vec3Like; name: string }[] {
    return this.semantic.placedBlocks();
  }

  // ------------------------------------------------ 空间记忆 / 新颖性
  /** 进入一个区块；返回是否首次访问。ledger 负责同一区块连续去重。 */
  visit(dim: string, pos: Vec3Like): boolean {
    return this.semantic.visit(dim, pos);
  }

  chunkVisits(dim: string, x: number, z: number): number {
    return this.semantic.chunkVisits(dim, x, z);
  }

  get visitedChunkCount() {
    return this.semantic.visitedChunkCount;
  }

  visitedExtent(dim: string) {
    return this.semantic.visitedExtent(dim);
  }

  nearbyPaths(dim: string, here: Vec3Like, radius: number) {
    return this.semantic.nearbyPaths(dim, here, radius);
  }

  /** 计数式新颖性：1/sqrt(n+1)，取目标点周围 3x3 区块平均。 */
  novelty(dim: string, x: number, z: number): number {
    return this.semantic.novelty(dim, x, z);
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
    return this.semantic.addLandmark(kind, label, dim, pos, dedupeRadius);
  }

  private inWorld(record: { worldId?: string }): boolean { return (record.worldId ?? 'default') === this.worldId; }

  setBase(dim: string, pos: Vec3Like, label?: string, opts: { select?: boolean } = {}): Landmark {
    return this.semantic.setBase(dim, pos, label, opts);
  }

  base(dim?: string): Landmark | undefined {
    return this.semantic.base(dim);
  }

  bases(dim?: string): Landmark[] {
    return this.semantic.bases(dim);
  }

  selectBase(id: string): Landmark {
    return this.semantic.selectBase(id);
  }

  findLandmark(q: string, dim?: string): Landmark | undefined {
    return this.semantic.findLandmark(q, dim);
  }

  landmarks(): Landmark[] {
    return this.semantic.landmarks();
  }

  /** 亲眼看到某处的资源/危险已经没了（现在是 now） */
  markGone(label: string, dim: string, pos: Vec3Like, now: string) {
    this.semantic.markGone(label, dim, pos, now);
  }

  /** 某个坐标附近亲眼看到已经没了的东西（又看见它了就不算） */
  goneNear(dim: string, pos: Vec3Like, r = 3): GoneSpot[] {
    return this.semantic.goneNear(dim, pos, r);
  }

  removeLandmark(id: string): boolean {
    return this.semantic.removeLandmark(id);
  }

  /** 人工从控制台移除一个地点记忆（含基地）。 */
  forgetLandmark(id: string): Landmark | null {
    return this.semantic.forgetLandmark(id);
  }

  /** 不主动攻击的生物（羊、牛、狼、村民……）在哪一带出没。 */
  noteHerd(label: string, dim: string, pos: Vec3Like, count: number, detail?: string): Landmark {
    return this.semantic.noteHerd(label, dim, pos, count, detail);
  }

  /** 资源地标附近 radius 格内、名字匹配 names 的地标 */
  resourceLandmarksNear(names: string[], dim: string, pos: Vec3Like, radius: number): Landmark[] {
    return this.semantic.resourceLandmarksNear(names, dim, pos, radius);
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
  static readonly HAZARD_FADE_MS = 40 * 60_000;

  /** 记一次出事：同一世界/维度、同类、6 格内的旧记录合并（次数 +1，半径随次数变大） */
  addHazard(h: { dim: string; pos: Vec3Like; kind: HazardKind; during?: string; note?: string }): Hazard {
    return this.semantic.addHazard(h);
  }

  /** 当前世界的危险区域（可按维度过滤），最近出事的在后 */
  hazards(dim?: string): Hazard[] {
    return this.semantic.hazards(dim);
  }

  /** pos 是否落在某个危险区域里（可限定种类）；返回最严重（出事次数最多）的那个 */
  hazardAt(pos: Vec3Like, dim: string, kinds?: HazardKind[]): Hazard | null {
    return this.semantic.hazardAt(pos, dim, kinds);
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

  // ------------------------------------------------ 自己挖的通道（library fragments）
  passages(dim?: string): PassageRecord[] {
    return this.semantic.passages(dim);
  }

  /** 被 live 工作集淘汰的历史通道；显式查询和旧路导航可读。 */
  archivedPassages(dim?: string): PassageRecord[] {
    return this.semantic.archivedPassages(dim);
  }

  /** live 工作集 + 历史归档；同 ID 以 live 为准。 */
  allPassages(dim?: string): PassageRecord[] {
    return this.semantic.allPassages(dim);
  }

  archivePassage(rec: PassageRecord) {
    this.semantic.archivePassage(rec);
  }

  savePassage(rec: PassageRecord) {
    this.semantic.savePassage(rec);
  }

  forgetPassage(id: string) {
    this.semantic.forgetPassage(id);
  }

  // ------------------------------------------------ 仓储（宿主精确账本 + 空间锚点）
  /** 箱子记忆的“现在”：游戏日 + 开箱序号。 */
  chestClock(day?: number): Clock { return this.semantic.chestClock(day); }

  /**
   * 用了一次箱子（存、取、或只是打开看了看）：不抄清单，只记最后一次真实观察。
   */
  noteChestUse(dim: string, pos: Vec3Like, use: ChestUse) {
    return this.semantic.noteChestUse(dim, pos, use);
  }

  /** 老接口：知道这个箱子里有这些东西（当作自己放进去的）。新代码用 noteChestUse */
  setChest(dim: string, pos: Vec3Like, items: { name: string; count: number }[], day?: number) {
    return this.semantic.setChest(dim, pos, items, day);
  }

  /** 那里已经不是箱子了（被挖、被炸）：别再惦记 */
  forgetChest(dim: string, pos: Vec3Like) {
    this.semantic.forgetChest(dim, pos);
  }

  chests(dim?: string): ChestRecord[] {
    return this.semantic.chests(dim);
  }

  chestAt(dim: string, pos: Vec3Like): ChestRecord | undefined {
    return this.semantic.chestAt(dim, pos);
  }

  /** 想找某样东西：记得哪些箱子里有、各多少，近的在前（accept 可以放宽：找木板时原木也算） */
  recallChests(accept: string | ((name: string) => boolean), opts: { dim?: string; day?: number; from?: Vec3Like } = {}): ChestRecall[] {
    return this.semantic.recallChests(accept, opts);
  }

  /** 熔炉里留下了东西就记着；取空了（或者那里不再是熔炉）就忘掉 */
  setFurnace(rec: Omit<FurnaceRecord, 'worldId' | 'ts'> & { ts?: number }) {
    this.semantic.setFurnace(rec);
  }

  forgetFurnace(dim: string, pos: Vec3Like) {
    this.semantic.forgetFurnace(dim, pos);
  }

  furnaces(dim?: string): FurnaceRecord[] {
    return this.semantic.furnaces(dim);
  }

  // ------------------------------------------------ 农田
  addFarm(f: FarmRecord) {
    this.semantic.addFarm(f);
  }

  farms(): FarmRecord[] {
    return this.semantic.farms();
  }

  updateFarm(id: string, patch: Partial<FarmRecord>) {
    this.semantic.updateFarm(id, patch);
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

  /** 最后一次亲手拿到主手的东西：重启/重连后由上层恢复，而不是让身体按“最快工具”重新挑。
   *  只有带 explicit 标记的值才算；旧版自动换手写进来的值不能当它的选择。 */
  lastHand(): string | null { return this.data.lastHandExplicit ? this.data.lastHand ?? null : null; }
  /** 立刻落盘：它刚换完手就可能重启，不能等 10 秒的周期 flush */
  setLastHand(name: string | null) { this.data.lastHand = name; this.data.lastHandExplicit = true; this.checkpoint(); }
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
    this.flush();
    this.semantic.containers.close();
  }
}

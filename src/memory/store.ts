import fs from 'node:fs';
import path from 'node:path';
import type { EffectEvidence, Vec3Like } from '../adapter/types.ts';
import { dist3, shortId } from '../util.ts';
import { reservationsFor } from '../projects/reservations.ts';
import type { Decision, Intent, Preference } from '../intentions/types.ts';
import type { Evidence, PauseReason, Project } from '../projects/types.ts';

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
 * 只记亲身走过的点（脚下的位置），不透视；它挖过的这些地方以后还能走，比每次从脚下重新往下挖省事。
 */
export interface PassageRecord {
  id: string;
  worldId?: string;
  dim: string;
  /** 从地表钻下去的地方（可能有好几个口），不知道就空着 */
  entrances: Vec3Like[];
  /** 沿途脚下的点，每隔几格记一个 */
  path: Vec3Like[];
  deepestY: number;
  /** 这条通道里自己挖掉了多少格 */
  dug: number;
  /** 沿途挖到的矿 */
  ores: Record<string, number>;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
}

export interface ChestRecord {
  worldId?: string;
  dim: string;
  pos: Vec3Like;
  items: { name: string; count: number }[];
  ts: number;
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
export type HazardKind = 'drowning' | 'lava' | 'fall' | 'mob' | 'starvation' | 'suffocation' | 'unknown';
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
  deaths: Record<string, DeathRecord>;
  /** 跨计划的长期目标（由 LLM 设定/更新） */
  objective: { text: string; ts: number } | null;
  digs: DigRecord[];
  chests: Record<string, ChestRecord>;
  furnaces?: Record<string, FurnaceRecord>;
  passages?: PassageRecord[];
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
const MEMORY_VERSION = 3;

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
    }
  }

  private touch() {
    this.dirty = true;
  }

  get dataDirectory(): string | null { return this.file ? path.dirname(this.file) : null; }
  get worldId(): string { return this.data.worldId; }

  setWorld(worldId: string) {
    if (!worldId || worldId === this.data.worldId) return;
    if (this.data.worldId === 'default') {
      for (const l of this.data.landmarks) l.worldId ??= worldId;
      for (const c of Object.values(this.data.chests)) c.worldId ??= worldId;
      for (const f of this.data.farms) f.worldId ??= worldId;
      if (this.data.lastDeath && !this.data.lastDeath.worldId) {
        this.data.lastDeath.worldId = worldId;
        this.data.deaths[worldId] = this.data.lastDeath;
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
  /** 迁移时清掉的地标数（main 启动时报告） */
  migrated = 0;

  flush() {
    if (!this.file || !this.dirty || this.transactionDepth) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
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
    const near = this.data.landmarks.find(
      (l) => this.inWorld(l) && l.kind === kind && l.label === label && l.dim === dim && dist3(l.pos, pos) < dedupeRadius,
    );
    if (near) { near.ts = Date.now(); this.touch(); return null; }
    // 同一格的“工作台”和“我的工作台”只留一个：自己的那个
    if (kind === 'discovery') {
      const own = label.startsWith('我的') ? null : this.data.landmarks.find((l) => this.inWorld(l) && l.kind === 'discovery' && l.label === `我的${label}` && l.dim === dim && dist3(l.pos, pos) <= 2);
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
    if (this.data.landmarks.length > 200) {
      const disposable = this.data.landmarks.map((landmark, index) => ({ landmark, index }))
        .filter(({ landmark }) => ['herd', 'resource', 'danger', 'death'].includes(landmark.kind)).sort((a, b) => a.landmark.ts - b.landmark.ts)[0];
      if (disposable) this.data.landmarks.splice(disposable.index, 1);
      else { this.data.landmarks.pop(); return null; }
    }
    this.touch();
    return lm;
  }

  /** “我的X”记下时，同一格（2 格内）看见时记的“X”就多余了 */
  private dropPlainTwins(ownLabel: string, dim: string, pos: Vec3Like, worldId = this.worldId) {
    const plain = ownLabel.slice('我的'.length);
    const before = this.data.landmarks.length;
    this.data.landmarks = this.data.landmarks.filter((l) => !((l.worldId ?? 'default') === worldId && l.kind === 'discovery' && l.label === plain && l.dim === dim && dist3(l.pos, pos) <= 2));
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

  setBase(dim: string, pos: Vec3Like, label?: string): Landmark {
    if (typeof dim !== 'string' || !dim || !pos || [pos.x, pos.y, pos.z].some((n) => !Number.isFinite(n))) throw new Error('基地需要实际维度与有限坐标');
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 100)) throw new Error('基地名称需要 1–100 字符');
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
    return this.selectBase(base.id);
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
    const candidates = this.landmarks().filter((l) => (!dim || l.dim === dim) && (l.kind !== 'resource' || Date.now() - l.ts <= 15 * 60_000));
    return (
      candidates.find((l) => l.id.toLowerCase() === s) ??
      candidates.find((l) => l.label.toLowerCase() === s) ??
      candidates.find((l) => l.label.toLowerCase().includes(s))
    );
  }

  landmarks(): Landmark[] {
    return this.data.landmarks.filter((l) => this.inWorld(l));
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
    return this.landmarks().filter((l) => l.kind === 'resource' && Date.now() - l.ts <= 15 * 60_000 && l.dim === dim && names.includes(l.label) && dist3(l.pos, pos) <= radius);
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
    this.data.lastDeath = { ...d, worldId: this.worldId, pos: { x: Math.round(d.pos.x), y: Math.round(d.pos.y), z: Math.round(d.pos.z) } };
    this.data.deaths[this.worldId] = this.data.lastDeath;
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
    return this.data.deaths[this.worldId] ?? (this.data.lastDeath && this.inWorld(this.data.lastDeath) ? this.data.lastDeath : null);
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

  /** 新记或更新一条通道；每个世界最多留 24 条，满了先忘最久没走过的 */
  savePassage(rec: PassageRecord) {
    const all = (this.data.passages ??= []);
    const i = all.findIndex((p) => p.id === rec.id);
    const copy = structuredClone({ ...rec, worldId: rec.worldId ?? this.worldId });
    if (i >= 0) all[i] = copy; else all.push(copy);
    const mine = all.filter((p) => this.inWorld(p));
    if (mine.length > 24) {
      const oldest = mine.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      all.splice(all.indexOf(oldest), 1);
    }
    this.touch();
  }

  /** 一条通道并进了另一条：这条就不单独留了 */
  forgetPassage(id: string) {
    const all = this.data.passages ?? [];
    const i = all.findIndex((p) => p.id === id && this.inWorld(p));
    if (i >= 0) { all.splice(i, 1); this.touch(); }
  }

  // ------------------------------------------------ 仓储
  setChest(dim: string, pos: Vec3Like, items: { name: string; count: number }[]) {
    (this.data.chests ??= {})[`${this.worldId}:${dim}:${pos.x},${pos.y},${pos.z}`] = { worldId: this.worldId, dim, pos, items, ts: Date.now() };
    this.touch();
  }

  /** 那里已经不是箱子了（被挖、被炸）：别再惦记 */
  forgetChest(dim: string, pos: Vec3Like) {
    const k = `${this.worldId}:${dim}:${pos.x},${pos.y},${pos.z}`;
    if (this.data.chests?.[k]) { delete this.data.chests[k]; this.touch(); }
  }

  chests(dim?: string): ChestRecord[] {
    return Object.values(this.data.chests ?? {}).filter((c) => this.inWorld(c) && (!dim || c.dim === dim));
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

  /** 所有箱子里各物品的总数 */
  storedTotals(dim?: string): Map<string, number> {
    const m = new Map<string, number>();
    for (const c of this.chests(dim)) for (const i of c.items) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
    return m;
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
    this.flush();
  }
}

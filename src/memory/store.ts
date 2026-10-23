import fs from 'node:fs';
import path from 'node:path';
import type { Vec3Like } from '../adapter/types.ts';
import { dist3, shortId } from '../util.ts';
import { reservationsFor } from '../projects/reservations.ts';
import type { Decision, Intent, Preference } from '../intentions/types.ts';
import type { Evidence, PauseReason, Project } from '../projects/types.ts';

export type LandmarkKind = 'base' | 'resource' | 'danger' | 'discovery' | 'death' | 'waypoint';

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
}

export interface ChestRecord {
  worldId?: string;
  dim: string;
  pos: Vec3Like;
  items: { name: string; count: number }[];
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
}

export interface DeathRecord {
  worldId?: string;
  ts: number;
  dim: string;
  pos: Vec3Like;
  /** 死前背包；复活后与当前背包比较得出真正丢失的物品 */
  lost: { name: string; count: number }[];
  cause?: string;
}

interface MemoryData {
  version: number;
  lastDeath: DeathRecord | null;
  deaths: Record<string, DeathRecord>;
  /** 跨计划的长期目标（由 LLM 设定/更新） */
  objective: { text: string; ts: number } | null;
  digs: DigRecord[];
  chests: Record<string, ChestRecord>;
  farms: FarmRecord[];
  lessons: { ts: number; text: string }[];
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
        .filter(({ landmark }) => ['resource', 'danger', 'death'].includes(landmark.kind)).sort((a, b) => a.landmark.ts - b.landmark.ts)[0];
      if (disposable) this.data.landmarks.splice(disposable.index, 1);
      else { this.data.landmarks.pop(); return null; }
    }
    this.touch();
    return lm;
  }

  setBase(dim: string, pos: Vec3Like, label?: string): Landmark {
    if (typeof dim !== 'string' || !dim || !pos || [pos.x, pos.y, pos.z].some((n) => !Number.isFinite(n))) throw new Error('基地需要实际维度与有限坐标');
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 100)) throw new Error('基地名称需要 1–100 字符');
    let base = this.data.landmarks.filter((l) => this.inWorld(l) && l.kind === 'base' && l.dim === dim && dist3(l.pos, pos) <= 4).sort((a, b) => dist3(a.pos, pos) - dist3(b.pos, pos))[0];
    if (!base) {
      if (this.bases().length >= 64) throw new Error('当前世界已保存 64 个基地，需要先人工回顾，不能静默丢弃旧基地');
      if (this.data.landmarks.length >= 200) {
        const disposable = this.data.landmarks.map((landmark, index) => ({ landmark, index })).filter(({ landmark }) => ['resource', 'danger', 'death'].includes(landmark.kind)).sort((a, b) => a.landmark.ts - b.landmark.ts)[0];
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

  addNote(kind: Note['kind'], text: string, dimension?: string) {
    const t = text.trim().slice(0, 200);
    if (!t || this.data.notes.some((n) => this.inWorld(n) && n.text === t)) return;
    this.data.notes.push({ id: shortId('note_'), worldId: this.worldId, dimension, ts: Date.now(), kind, text: t });
    if (this.data.notes.length > 60) this.data.notes.shift();
    this.touch();
  }

  recentNotes(n = 10) {
    return this.data.notes.slice(-n);
  }

  // ------------------------------------------------ 死亡与掉落物
  setDeath(d: DeathRecord) {
    this.data.lastDeath = { ...d, worldId: this.worldId, pos: { x: Math.round(d.pos.x), y: Math.round(d.pos.y), z: Math.round(d.pos.z) } };
    this.data.deaths[this.worldId] = this.data.lastDeath;
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

  // ------------------------------------------------ 仓储
  setChest(dim: string, pos: Vec3Like, items: { name: string; count: number }[]) {
    (this.data.chests ??= {})[`${this.worldId}:${dim}:${pos.x},${pos.y},${pos.z}`] = { worldId: this.worldId, dim, pos, items, ts: Date.now() };
    this.touch();
  }

  chests(dim?: string): ChestRecord[] {
    return Object.values(this.data.chests ?? {}).filter((c) => this.inWorld(c) && (!dim || c.dim === dim));
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
  addLesson(text: string) {
    const t = text.trim().slice(0, 160);
    if (!t || (this.data.lessons ??= []).some((l) => l.text === t)) return;
    this.data.lessons.push({ ts: Date.now(), text: t });
    if (this.data.lessons.length > 40) this.data.lessons.shift();
    this.touch();
  }

  lessons(n = 10) {
    return (this.data.lessons ?? []).slice(-n);
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

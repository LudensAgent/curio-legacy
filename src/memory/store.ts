import fs from 'node:fs';
import path from 'node:path';
import type { Vec3Like } from '../adapter/types.ts';
import { dist3, shortId } from '../util.ts';

export type LandmarkKind = 'base' | 'resource' | 'danger' | 'discovery' | 'death';

export interface Landmark {
  id: string;
  kind: LandmarkKind;
  label: string;
  dim: string;
  pos: Vec3Like;
  ts: number;
}

export interface GoalRecord {
  ts: number;
  goal: string;
  goalType: string;
  source: string;
  status: string;
  summary: string;
  durationSec?: number;
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
  ts: number;
  kind: 'fact' | 'inference' | 'hypothesis';
  text: string;
}

export interface DeathRecord {
  ts: number;
  dim: string;
  pos: Vec3Like;
  /** 死前背包；复活后与当前背包比较得出真正丢失的物品 */
  lost: { name: string; count: number }[];
  cause?: string;
}

interface MemoryData {
  version: 1;
  lastDeath: DeathRecord | null;
  /** 跨计划的长期目标（由 LLM 设定/更新） */
  objective: { text: string; ts: number } | null;
  digs: DigRecord[];
  visitedChunks: Record<string, number>;
  seen: { blocks: Record<string, number>; entities: Record<string, number>; biomes: Record<string, number> };
  landmarks: Landmark[];
  skillStats: Record<string, SkillStat>;
  goals: GoalRecord[];
  notes: Note[];
}

const empty = (): MemoryData => ({
  version: 1,
  lastDeath: null,
  objective: null,
  digs: [],
  visitedChunks: {},
  seen: { blocks: {}, entities: {}, biomes: {} },
  landmarks: [],
  skillStats: {},
  goals: [],
  notes: [],
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

  constructor(private file: string | null) {
    this.data = empty();
    if (file && fs.existsSync(file)) {
      try {
        this.data = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        fs.copyFileSync(file, file + '.corrupt-' + Date.now());
      }
    }
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.timer = setInterval(() => this.flush(), 10000);
      this.timer.unref?.();
    }
  }

  private touch() {
    this.dirty = true;
  }

  flush() {
    if (!this.file || !this.dirty) return;
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
    const key = WorldMemory.chunkKey(dim, pos.x, pos.z);
    if (key === this.lastChunk) return false;
    this.lastChunk = key;
    const first = !this.data.visitedChunks[key];
    this.data.visitedChunks[key] = (this.data.visitedChunks[key] ?? 0) + 1;
    this.touch();
    return first;
  }

  chunkVisits(dim: string, x: number, z: number): number {
    return this.data.visitedChunks[WorldMemory.chunkKey(dim, x, z)] ?? 0;
  }

  get visitedChunkCount() {
    return Object.keys(this.data.visitedChunks).length;
  }

  /** 计数式新颖性：1/sqrt(n+1)，取目标点周围 3x3 区块平均。 */
  novelty(dim: string, x: number, z: number): number {
    let s = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) s += 1 / Math.sqrt(this.chunkVisits(dim, x + dx * 16, z + dz * 16) + 1);
    return s / 9;
  }

  markSeen(cat: 'blocks' | 'entities' | 'biomes', name: string): boolean {
    if (this.data.seen[cat][name]) return false;
    this.data.seen[cat][name] = Date.now();
    this.touch();
    return true;
  }

  seenCount() {
    const s = this.data.seen;
    return { blocks: Object.keys(s.blocks).length, entities: Object.keys(s.entities).length, biomes: Object.keys(s.biomes).length };
  }

  // ------------------------------------------------ 地标
  addLandmark(kind: LandmarkKind, label: string, dim: string, pos: Vec3Like, dedupeRadius = 24): Landmark | null {
    const near = this.data.landmarks.find(
      (l) => l.kind === kind && l.label === label && l.dim === dim && dist3(l.pos, pos) < dedupeRadius,
    );
    if (near) return null;
    const lm: Landmark = {
      id: shortId(kind.slice(0, 3) + '_'),
      kind,
      label,
      dim,
      pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      ts: Date.now(),
    };
    this.data.landmarks.push(lm);
    if (this.data.landmarks.length > 200) this.data.landmarks.splice(1, 1); // 保留第一个（通常是 base）
    this.touch();
    return lm;
  }

  setBase(dim: string, pos: Vec3Like) {
    this.data.landmarks = this.data.landmarks.filter((l) => l.kind !== 'base');
    this.data.landmarks.unshift({ id: 'base', kind: 'base', label: '基地', dim, pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }, ts: Date.now() });
    this.touch();
  }

  base(): Landmark | undefined {
    return this.data.landmarks.find((l) => l.kind === 'base');
  }

  findLandmark(q: string): Landmark | undefined {
    const s = q.trim().toLowerCase();
    return (
      this.data.landmarks.find((l) => l.id.toLowerCase() === s) ??
      this.data.landmarks.find((l) => l.label.toLowerCase() === s) ??
      this.data.landmarks.find((l) => l.label.toLowerCase().includes(s))
    );
  }

  landmarks(): Landmark[] {
    return this.data.landmarks;
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
    this.data.goals.push({ ts: Date.now(), ...g });
    if (this.data.goals.length > 100) this.data.goals.shift();
    this.touch();
  }

  recentGoals(n = 8) {
    return this.data.goals.slice(-n);
  }

  addNote(kind: Note['kind'], text: string) {
    const t = text.trim().slice(0, 200);
    if (!t || this.data.notes.some((n) => n.text === t)) return;
    this.data.notes.push({ ts: Date.now(), kind, text: t });
    if (this.data.notes.length > 60) this.data.notes.shift();
    this.touch();
  }

  recentNotes(n = 10) {
    return this.data.notes.slice(-n);
  }

  // ------------------------------------------------ 死亡与掉落物
  setDeath(d: DeathRecord) {
    this.data.lastDeath = { ...d, pos: { x: Math.round(d.pos.x), y: Math.round(d.pos.y), z: Math.round(d.pos.z) } };
    this.touch();
  }

  updateDeathLost(lost: DeathRecord['lost']) {
    if (!this.data.lastDeath) return;
    this.data.lastDeath.lost = lost;
    this.touch();
  }

  lastDeath(): DeathRecord | null {
    return this.data.lastDeath;
  }

  clearDeath() {
    if (!this.data.lastDeath) return;
    this.data.lastDeath = null;
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

  close() {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }
}

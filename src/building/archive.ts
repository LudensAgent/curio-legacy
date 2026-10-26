import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Vec3Like } from '../adapter/types.ts';
import type { BuildingPhase, BuildingSpec, Rotation } from './spec.ts';

export interface BuildingDefect {
  cellId: string;
  pos: Vec3Like;
  kind: 'missing' | 'wrong_block' | 'wrong_state' | 'unknown' | 'obstruction' | 'unsupported' | 'terrain' | 'functional';
  expected: string;
  actual: string | null;
}
export interface BuildingInspection {
  at: number;
  complete: boolean;
  checked: number;
  defects: BuildingDefect[];
  functions: Record<string, 'pass' | 'fail' | 'unknown'>;
}
export interface DesignVersion {
  version: number;
  at: number;
  spec: BuildingSpec;
  reason: string;
  materials: Record<string, number>;
}
export interface ArtifactFeedback {
  id: string;
  at: number;
  source: 'user' | 'agent' | 'world';
  text: string;
  designVersion: number;
  /** Subjective feedback is never converted into measured structural success. */
  evidence?: string[];
  category: 'appearance' | 'use' | 'pathing' | 'raid' | 'preference';
}
export interface BuildingProject {
  id: string;
  worldId: string;
  dimension: string;
  origin: Vec3Like;
  rotation: Rotation;
  createdAt: number;
  updatedAt: number;
  /** complete：逐格验收通过，或者被认定“能住、这样就行了”（acceptance）；abandoned：不要了，不再惦记 */
  status: 'planned' | 'building' | 'incomplete' | 'complete' | 'abandoned';
  /** 没逐格验收通过、但被认定可以收工：谁认定的、当时还差几处 */
  acceptance?: { at: number; by: 'agent' | 'operator' | 'audience'; note: string; defectsLeft: number };
  abandonedAt?: number;
  abandonNote?: string;
  versions: DesignVersion[];
  checkpoint: { phase: BuildingPhase | 'survey' | 'inspection'; ownedCells: string[]; note: string };
  inspections: BuildingInspection[];
  feedback: ArtifactFeedback[];
  /** References only: snapshots are acquired through actual observer tools, never fabricated. */
  views: { at: number; reference: string; caption: string; designVersion: number; observation?: Record<string, unknown> }[];
  temporaryBlocks: { pos: Vec3Like; name: string }[];
  /** A pre-action intention; only a later live observation can turn it into owned evidence. */
  pendingPlacement: { kind: 'temporary' | 'permanent'; pos: Vec3Like; name: string; cellId?: string } | null;
  /** 连续“动了手（放了/试着放了方块）、不缺料、缺陷却没减少”的施工次数；纯缺料的失败不计 */
  stalls?: number;
}

/** One bounded atomic JSON archive, wholly underneath DATA_DIR and memory:clear's scope. */
export class BuildingArchive {
  private file: string | null;
  private projects: BuildingProject[];

  constructor(directory: string | null) {
    this.file = directory ? path.join(directory, 'building-artifacts.json') : null;
    this.projects = [];
    if (this.file && fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error('不支持的作品档案格式');
      this.projects = data.projects;
    }
  }

  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, projects: this.projects }, null, 2));
      fs.renameSync(temp, this.file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  list(): BuildingProject[] { return structuredClone(this.projects); }
  get(id: string): BuildingProject | undefined { return structuredClone(this.projects.find((p) => p.id === id)); }
  private require(id: string) {
    const project = this.projects.find((p) => p.id === id);
    if (!project) throw new Error(`未知建筑项目 ${id}`);
    return project;
  }

  design(input: { id?: string; worldId: string; dimension: string; origin: Vec3Like; rotation: Rotation; spec: BuildingSpec; materials: Record<string, number>; reason?: string }): BuildingProject {
    let project = input.id ? this.projects.find((p) => p.id === input.id) : undefined;
    if (!project) {
      if (this.projects.length >= 128) throw new Error('作品档案已达到 128 个项目；请先整理档案');
      project = { id: input.id ?? randomUUID(), worldId: input.worldId, dimension: input.dimension, origin: { ...input.origin }, rotation: input.rotation, createdAt: Date.now(), updatedAt: Date.now(), status: 'planned', versions: [], checkpoint: { phase: 'survey', ownedCells: [], note: '' }, inspections: [], feedback: [], views: [], temporaryBlocks: [], pendingPlacement: null };
      this.projects.push(project);
    } else if (project.worldId !== input.worldId || project.dimension !== input.dimension || JSON.stringify(project.origin) !== JSON.stringify(input.origin) || project.rotation !== input.rotation) {
      throw new Error('已存项目的位置、维度、朝向不可被重新解释；新位置需要新项目');
    }
    const previous = project.versions.at(-1);
    if (!previous || JSON.stringify(previous.spec) !== JSON.stringify(input.spec)) {
      if (project.versions.length >= 64) throw new Error('单个作品已达到 64 个设计版本');
      project.versions.push({ version: (previous?.version ?? 0) + 1, at: Date.now(), spec: structuredClone(input.spec), materials: { ...input.materials }, reason: (input.reason ?? '首次设计').slice(0, 1000) });
      if (!project.acceptance) project.status = 'planned';
      project.updatedAt = Date.now();
      this.save();
    }
    return structuredClone(project);
  }

  checkpoint(id: string, phase: BuildingProject['checkpoint']['phase'], ownedCell: string | null, note: string) {
    const project = this.require(id);
    project.status = 'building';
    project.checkpoint.phase = phase;
    if (ownedCell && !project.checkpoint.ownedCells.includes(ownedCell)) project.checkpoint.ownedCells.push(ownedCell);
    project.checkpoint.note = note.slice(0, 1000);
    project.updatedAt = Date.now();
    this.save();
  }

  temporary(id: string, block: { pos: Vec3Like; name: string }, removed = false) {
    const project = this.require(id);
    project.temporaryBlocks ??= [];
    const index = project.temporaryBlocks.findIndex((b) => b.pos.x === block.pos.x && b.pos.y === block.pos.y && b.pos.z === block.pos.z);
    if (removed) { if (index >= 0) project.temporaryBlocks.splice(index, 1); }
    else if (index < 0) project.temporaryBlocks.push(structuredClone(block));
    project.updatedAt = Date.now();
    if (!removed) project.status = 'building';
    this.save();
  }

  actualMaterialEstimate(id: string, materials: Record<string, number>) {
    this.require(id).versions.at(-1)!.materials = { ...materials };
    this.save();
  }

  pending(id: string, placement: BuildingProject['pendingPlacement']) {
    this.require(id).pendingPlacement = structuredClone(placement);
    this.save();
  }

  rollback(id: string, version: number, reason: string) {
    const project = this.require(id), selected = project.versions.find((v) => v.version === version);
    if (!selected) throw new Error('未知设计版本');
    if (!reason.trim()) throw new Error('回退设计需要原因');
    return this.design({ id, worldId: project.worldId, dimension: project.dimension, origin: project.origin, rotation: project.rotation, spec: selected.spec, materials: selected.materials, reason: `回退到版本 ${version}：${reason}` });
  }

  releaseCell(id: string, cellId: string) {
    const project = this.require(id);
    project.checkpoint.ownedCells = project.checkpoint.ownedCells.filter((cell) => cell !== cellId);
    this.save();
  }

  compareVersions(id: string, leftVersion: number, rightVersion: number) {
    const project = this.require(id), left = project.versions.find((v) => v.version === leftVersion), right = project.versions.find((v) => v.version === rightVersion);
    if (!left || !right) throw new Error('比较需要两个实际存在的设计版本');
    const changedFields = Object.keys(left.spec).filter((field) => JSON.stringify((left.spec as any)[field]) !== JSON.stringify((right.spec as any)[field]));
    const materialDelta = Object.fromEntries([...new Set([...Object.keys(left.materials), ...Object.keys(right.materials)])].map((name) => [name, (right.materials[name] ?? 0) - (left.materials[name] ?? 0)]));
    return structuredClone({ projectId: id, left, right, changedFields, materialDelta, feedback: project.feedback.filter((f) => f.designVersion === leftVersion || f.designVersion === rightVersion) });
  }

  /** 记一次施工结果：stalled=true 计一次停滞，false 清零，null（纯缺料等）不变 */
  noteAttempt(id: string, stalled: boolean | null) {
    if (stalled === null) return;
    const project = this.require(id);
    project.stalls = stalled ? (project.stalls ?? 0) + 1 : 0;
    this.save();
  }

  inspect(id: string, inspection: BuildingInspection) {
    const project = this.require(id);
    project.inspections.push(structuredClone(inspection));
    project.inspections = project.inspections.slice(-20);
    // 认定过“这样就行了”的作品：之后的复查只记录缺陷，不再把它变回“没盖完”
    project.status = inspection.complete || project.acceptance ? 'complete' : 'incomplete';
    project.updatedAt = Date.now();
    project.checkpoint.phase = 'inspection';
    this.save();
  }

  /** 认定可以收工（没逐格验收通过也算能住）：之后不再当成没盖完的工地 */
  accept(id: string, by: 'agent' | 'operator' | 'audience', note: string) {
    const project = this.require(id);
    project.acceptance = { at: Date.now(), by, note: note.slice(0, 300), defectsLeft: project.inspections.at(-1)?.defects.length ?? 0 };
    project.status = 'complete';
    delete project.abandonedAt; delete project.abandonNote;
    project.updatedAt = Date.now();
    this.save();
    return structuredClone(project);
  }

  /** 不要了：不再续建、不再提醒；位置仍被占着（选址会避开），想重拾就用 projectId 接着盖 */
  abandon(id: string, note: string) {
    const project = this.require(id);
    project.status = 'abandoned';
    project.abandonedAt = Date.now();
    project.abandonNote = note.slice(0, 300);
    project.updatedAt = Date.now();
    this.save();
    return structuredClone(project);
  }

  feedback(id: string, input: Omit<ArtifactFeedback, 'id' | 'at' | 'designVersion'>) {
    const project = this.require(id);
    if (!input.text.trim()) throw new Error('作品反馈需要内容');
    project.feedback.push({ ...structuredClone(input), text: input.text.slice(0, 2000), evidence: input.evidence?.slice(0, 20), id: randomUUID(), at: Date.now(), designVersion: project.versions.at(-1)!.version });
    project.feedback = project.feedback.slice(-100);
    project.updatedAt = Date.now();
    this.save();
  }

  view(id: string, reference: string, caption: string) {
    const project = this.require(id);
    if (!reference.trim()) throw new Error('视角需要真实资源引用');
    project.views.push({ at: Date.now(), reference: reference.slice(0, 1000), caption: caption.slice(0, 300), designVersion: project.versions.at(-1)!.version });
    project.views = project.views.slice(-30);
    this.save();
  }

  observationView(id: string, camera: string, observation: Record<string, unknown>) {
    const project = this.require(id);
    project.views.push({ at: Date.now(), reference: `raycast:${String(observation.sessionId)}:${String(observation.observationId)}:${camera}`, caption: camera, designVersion: project.versions.at(-1)!.version, observation: structuredClone(observation) });
    project.views = project.views.slice(-30);
    project.updatedAt = Date.now();
    this.save();
  }

  compare(leftId: string, rightId: string) {
    const left = this.require(leftId), right = this.require(rightId);
    const a = left.versions.at(-1)!, b = right.versions.at(-1)!;
    const materialDelta = Object.fromEntries([...new Set([...Object.keys(a.materials), ...Object.keys(b.materials)])].map((name) => [name, (b.materials[name] ?? 0) - (a.materials[name] ?? 0)]));
    return { left: structuredClone(left), right: structuredClone(right), materialDelta, note: '材料差异是事实；美观与适用性由反馈及模型判断，不使用预设总分。' };
  }
}

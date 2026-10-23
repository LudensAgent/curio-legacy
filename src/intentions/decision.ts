import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { ProjectCoordinator } from '../projects/coordinator.ts';
import { validateCondition } from '../projects/conditions.ts';
import type { Binding, ProjectSpec } from '../projects/types.ts';
import type { DecisionKind, Preference } from './types.ts';

export interface ValidatedIntentDecision {
  kind: DecisionKind;
  reason: string;
  context: string[];
  intentId?: string;
  intent?: { text: string; whyNow: string; context: string[]; tradeoffs: string[] };
  project?: Omit<ProjectSpec, 'intentId'>;
  preferences?: Omit<Preference, 'id' | 'createdAt' | 'updatedAt'>[];
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}须为 1–${max} 字符的文字`);
  return value.trim();
}
function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${label}最多包含 12 项`);
  return value.map((s) => text(s, label, 300));
}

/** A pure validation boundary: late/invalid model replies must never write memories. */
export function validateIntentDecision(raw: unknown, memory: WorldMemory, adapter: Pick<GameAdapter, 'state' | 'isKnownItem'>): { ok: true; decision: ValidatedIntentDecision } | { ok: false; error: string } {
  try {
    if (!object(raw) || !['begin', 'continue', 'change_method', 'revise', 'defer', 'abandon', 'complete'].includes(raw.kind)) throw new Error('未知意图选择类型');
    const decision: ValidatedIntentDecision = { kind: raw.kind, reason: text(raw.reason, '选择理由'), context: strings(raw.context, '采用的上下文') };
    const current = memory.currentIntent();
    const currentProject = memory.activeProject();
    const currentWorld = adapter.state().worldId;
    if (currentProject && currentProject.worldId !== currentWorld && ['continue', 'change_method', 'revise'].includes(raw.kind)) {
      throw new Error('当前项目属于另一个世界；请明确暂缓、放弃，或开始一个新意图');
    }
    if (raw.intentId !== undefined) {
      decision.intentId = text(raw.intentId, '意图 ID', 100);
      if (!memory.intents().some((i) => i.id === decision.intentId && i.status !== 'ended')) throw new Error('意图 ID 已结束或不存在');
    }
    if (raw.intent !== undefined) {
      if (!object(raw.intent) || !['begin', 'revise'].includes(raw.kind)) throw new Error('只有开始或改意可以提出意图文字');
      decision.intent = { text: text(raw.intent.text, '意图', 300), whyNow: text(raw.intent.whyNow, '此刻想做的理由'), context: strings(raw.intent.context, '意图关联经历'), tradeoffs: strings(raw.intent.tradeoffs, '当前取舍') };
    }
    if (raw.kind === 'begin' && !decision.intent && !decision.intentId) throw new Error('begin 需要 decision.intent:{text,whyNow,context:[],tradeoffs:[]} 或 decision.intentId；不能把 intent 放在顶层');
    if (raw.kind === 'begin' && decision.intent && decision.intentId) throw new Error('新意图和已有意图 ID 只能选择一个');
    if (raw.kind === 'begin' && decision.intentId) {
      const previousProject = memory.projects().reverse().find((p) => p.intentId === decision.intentId && !['completed', 'cancelled'].includes(p.status));
      if (previousProject && previousProject.worldId !== currentWorld) throw new Error('旧意图的项目属于另一个世界；保留暂缓并为当前世界另开新意图');
    }
    if (raw.kind !== 'begin') {
      decision.intentId ??= current?.id;
      if (!decision.intentId || current?.id !== decision.intentId) throw new Error('这次选择必须关联当前进行中的意图');
    }
    if (raw.project !== undefined) {
      if (!object(raw.project) || !['begin', 'continue', 'change_method', 'revise'].includes(raw.kind)) throw new Error('该选择不能建立项目');
      const state = adapter.state();
      const project: Omit<ProjectSpec, 'intentId'> = { title: text(raw.project.title, '项目描述', 240), successCondition: validateCondition(raw.project.successCondition, adapter, memory, state) };
      if (raw.project.milestones !== undefined) {
        if (!Array.isArray(raw.project.milestones) || raw.project.milestones.length > 12) throw new Error('项目最多包含 12 个里程碑');
        project.milestones = raw.project.milestones.map((m: unknown) => {
          if (!object(m)) throw new Error('里程碑格式无效');
          return { ...(m.id ? { id: text(m.id, '里程碑 ID', 100) } : {}), title: text(m.title, '里程碑描述', 240), condition: validateCondition(m.condition, adapter, memory, state) };
        });
        const ids = project.milestones!.map((m) => m.id).filter(Boolean);
        if (new Set(ids).size !== ids.length) throw new Error('里程碑 ID 不可重复');
      }
      decision.project = project;
      const active = memory.activeProject();
      if (active && ['continue', 'change_method'].includes(raw.kind)) throw new Error('更改项目验收条件须使用 revise');
    }
    if (raw.preferences !== undefined) {
      if (!Array.isArray(raw.preferences) || raw.preferences.length > 6) throw new Error('每次最多更新 6 条偏好');
      decision.preferences = raw.preferences.map((p: unknown) => {
        if (!object(p) || (p.source !== undefined && p.source !== 'inferred')) throw new Error('模型只能记录推断偏好，不能冒充用户明确偏好');
        return { text: text(p.text, '偏好', 300), source: 'inferred' as const, support: strings(p.support, '支持经历'), counterexamples: strings(p.counterexamples, '反例'), adjustmentReason: text(p.adjustmentReason ?? decision.reason, '偏好调整理由') };
      });
    }
    return { ok: true, decision };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

/** Subjective completion ends an interest; factual project completion only comes from reconciliation. */
export function applyDecision(memory: WorldMemory, coordinator: ProjectCoordinator, decision: ValidatedIntentDecision, state: AgentState): Binding {
  return memory.transaction(() => {
    let intent = decision.intentId ? memory.intents().find((i) => i.id === decision.intentId) : memory.currentIntent();
    const previous = memory.currentIntent();
    let project = memory.activeProject();
    if (decision.kind === 'begin' && (!intent || previous?.id !== intent.id || decision.intent)) {
      if (previous) memory.updateIntent(previous.id, { status: 'deferred', endReason: decision.reason });
      if (project) {
        project.status = 'deferred';
        project.checkpoint = { ts: Date.now(), reason: decision.reason };
        project.updatedAt = Date.now();
        memory.saveProject(project);
        project = undefined;
      }
      if (decision.intent) intent = memory.addIntent({ ...decision.intent, status: 'active', source: 'model' });
      else if (intent) intent = memory.updateIntent(intent.id, { status: 'active', endReason: undefined });
    }
    if (!intent) throw new Error('选择缺少有效意图');
    if (decision.kind === 'begin' && decision.intentId && !decision.project && !project) project = coordinator.resumeDeferred(intent.id, state);
    if (project && project.worldId === state.worldId && state.observationReady && project.pauseReasons.includes('world_changed') && !['defer', 'abandon', 'complete'].includes(decision.kind)) {
      project.pauseReasons = project.pauseReasons.filter((reason) => reason !== 'world_changed');
      project.status = project.pauseReasons.length ? 'paused' : 'active';
      project.checkpoint = { ts: Date.now(), reason: `world_restored:${decision.reason}`, evidenceId: project.lastEvidenceId };
      memory.saveProject(project);
    }
    if (decision.kind === 'revise' && decision.intent) {
      intent = memory.updateIntent(intent.id, decision.intent);
      if (project && !decision.project) {
        project.status = 'cancelled';
        project.checkpoint = { ts: Date.now(), reason: `intent_revised:${decision.reason}` };
        project.updatedAt = Date.now();
        memory.saveProject(project);
        project = undefined;
      }
    }
    if (['defer', 'abandon', 'complete'].includes(decision.kind)) {
      memory.updateIntent(intent.id, { status: decision.kind === 'defer' ? 'deferred' : 'ended', endReason: decision.reason });
      if (project) {
        project.status = decision.kind === 'defer' ? 'deferred' : 'cancelled';
        project.checkpoint = { ts: Date.now(), reason: `${decision.kind}:${decision.reason}` };
        project.updatedAt = Date.now();
        memory.saveProject(project);
      }
    } else {
      if (decision.project) {
        if (project) coordinator.revise(project.id, { ...decision.project, intentId: intent.id }, state);
        else coordinator.create({ ...decision.project, intentId: intent.id }, state);
      } else if (project && project.status === 'blocked' && ['continue', 'change_method', 'revise'].includes(decision.kind)) {
        project.noProgressAttempts = 0;
        project.status = project.pauseReasons.length ? 'paused' : 'active';
        project.checkpoint = { ts: Date.now(), reason: `${decision.kind}:${decision.reason}` };
        project.updatedAt = Date.now();
        memory.saveProject(project);
      }
    }
    for (const preference of decision.preferences ?? []) memory.addPreference(preference);
    memory.recordDecision({ kind: decision.kind, reason: decision.reason, context: decision.context, intentId: intent.id, projectId: memory.activeProject()?.id ?? project?.id });
    return coordinator.currentBinding();
  });
}

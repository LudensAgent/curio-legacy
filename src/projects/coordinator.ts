import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import { applyDecision, type ValidatedIntentDecision } from '../intentions/decision.ts';
import { shortId } from '../util.ts';
import { conditionDeficit, evaluateCondition, observationReady, validateCondition } from './conditions.ts';
import type { Binding, Condition, Evidence, PauseReason, Project, ProjectSpec } from './types.ts';

export interface AttemptOutcome {
  /** Only actual executions consume the loop budget. Planning/network waits do not. */
  executed: boolean;
  cancelled?: boolean;
  interrupted?: boolean;
  before?: AgentState;
  after?: AgentState;
  reason?: string;
}

export class ProjectCoordinator {
  private baseline: { projectId: string; revision: number; milestone: number; deficit: number | null } | null = null;

  constructor(private memory: WorldMemory, private adapter: Pick<GameAdapter, 'state' | 'isKnownItem'>) {}

  decide(decision: ValidatedIntentDecision, state = this.adapter.state()): Binding {
    return applyDecision(this.memory, this, decision, state);
  }

  validateSpec(spec: ProjectSpec, state = this.adapter.state()): ProjectSpec {
    if (!this.memory.intents().some((i) => i.id === spec.intentId && i.status !== 'ended')) throw new Error('项目需要现有的未结束意图');
    if (typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 240) throw new Error('项目需要简短明确的描述');
    if (spec.milestones && (!Array.isArray(spec.milestones) || spec.milestones.length > 12)) throw new Error('项目最多包含 12 个顺序里程碑');
    const milestones = (spec.milestones ?? []).map((m) => {
      if (!m || typeof m.title !== 'string' || !m.title.trim() || m.title.length > 240) throw new Error('里程碑需要简短描述');
      return { ...(m.id ? { id: m.id } : {}), title: m.title.trim(), condition: validateCondition(m.condition, this.adapter, this.memory, state) };
    });
    if (new Set(milestones.map((m) => m.id).filter(Boolean)).size !== milestones.filter((m) => m.id).length) throw new Error('里程碑 ID 不可重复');
    return { intentId: spec.intentId, title: spec.title.trim(), successCondition: validateCondition(spec.successCondition, this.adapter, this.memory, state), milestones };
  }

  create(spec: ProjectSpec, state = this.adapter.state()): Project {
    const valid = this.validateSpec(spec, state);
    if (this.memory.activeProject()) throw new Error('已有活动项目，须明确暂缓、结束或修订');
    const ts = Date.now();
    const project: Project = {
      id: shortId('proj_'), intentId: valid.intentId, title: valid.title, revision: 1,
      worldId: state.worldId || this.memory.worldId, status: 'active', successCondition: valid.successCondition,
      milestones: (valid.milestones ?? []).map((m) => ({ ...m, id: m.id ?? shortId('mile_') })),
      currentMilestone: 0, noProgressAttempts: 0, pauseReasons: [],
      checkpoint: { ts, reason: 'created' }, createdAt: ts, updatedAt: ts,
    };
    this.memory.saveProject(project);
    this.baseline = { projectId: project.id, revision: project.revision, milestone: project.currentMilestone, deficit: conditionDeficit(this.target(project), state, project.worldId) };
    return project;
  }

  revise(id: string, spec: ProjectSpec, state = this.adapter.state()): Project {
    const project = this.memory.projects().find((p) => p.id === id);
    if (!project || ['completed', 'cancelled'].includes(project.status)) throw new Error('无法修订已结束或未知项目');
    const valid = this.validateSpec(spec, state);
    if (valid.intentId !== project.intentId) throw new Error('项目不能改绑另一个意图');
    project.revision++;
    project.title = valid.title;
    project.successCondition = valid.successCondition;
    project.milestones = (valid.milestones ?? []).map((m) => ({ ...m, id: m.id ?? shortId('mile_') }));
    project.currentMilestone = 0;
    project.noProgressAttempts = 0;
    project.status = project.pauseReasons.length ? 'paused' : 'active';
    project.lastEvidenceId = undefined;
    project.checkpoint = { ts: Date.now(), reason: 'specification_revised' };
    project.updatedAt = Date.now();
    this.memory.saveProject(project);
    this.baseline = { projectId: project.id, revision: project.revision, milestone: project.currentMilestone, deficit: conditionDeficit(this.target(project), state, project.worldId) };
    return project;
  }

  currentBinding(): Binding {
    const intent = this.memory.currentIntent();
    const project = this.memory.activeProject();
    return { ...(intent ? { intentId: intent.id } : {}), ...(project ? { intentId: project.intentId, projectId: project.id, revision: project.revision, ...(project.milestones[project.currentMilestone] ? { milestoneId: project.milestones[project.currentMilestone].id } : {}) } : {}) };
  }

  isBindingCurrent(binding: Binding): boolean {
    const current = this.currentBinding();
    const project = this.memory.activeProject();
    return (!project || (project.worldId === this.adapter.state().worldId && project.status === 'active' && !project.pauseReasons.length)) &&
      binding.intentId === current.intentId && binding.projectId === current.projectId && binding.revision === current.revision && binding.milestoneId === current.milestoneId;
  }

  private target(project: Project): Condition { return project.milestones[project.currentMilestone]?.condition ?? project.successCondition; }

  private evidence(project: Project, condition: Condition, state: AgentState, milestoneId?: string): Evidence {
    const result = evaluateCondition(condition, state, project.worldId);
    return this.memory.recordEvidence({
      projectId: project.id, revision: project.revision, ...(milestoneId ? { milestoneId } : {}), condition,
      sessionId: state.sessionId ?? 'unavailable', observationId: state.observationId ?? 'unavailable', worldId: state.worldId ?? project.worldId,
      ts: Date.now(), source: 'adapter.state', actual: result.actual, status: result.status, ...(result.reason ? { reason: result.reason } : {}),
    });
  }

  /** Checkpoint milestones as historical achievements; final acceptance is a fresh check. */
  reconcile(state = this.adapter.state()): Project | undefined {
    const project = this.memory.activeProject();
    if (!project) return;
    if (project.worldId !== state.worldId && !project.pauseReasons.includes('world_changed')) {
      project.pauseReasons.push('world_changed');
      project.status = 'paused';
      project.checkpoint = { ts: Date.now(), reason: 'paused:world_changed', evidenceId: project.lastEvidenceId };
      this.memory.saveProject(project);
    }
    if (!this.baseline || this.baseline.projectId !== project.id || this.baseline.revision !== project.revision) {
      this.baseline = { projectId: project.id, revision: project.revision, milestone: project.currentMilestone, deficit: conditionDeficit(this.target(project), state, project.worldId) };
    }
    return (() => {
      let changed = false;
      let last: Evidence | undefined;
      while (project.milestones[project.currentMilestone]) {
        const milestone = project.milestones[project.currentMilestone];
        last = this.evidence(project, milestone.condition, state, milestone.id);
        if (last.status !== 'satisfied') break;
        milestone.completedAt = last.ts;
        milestone.evidenceId = last.id;
        project.currentMilestone++;
        project.noProgressAttempts = 0;
        changed = true;
      }
      // Never allow a final condition to skip uncompleted sequential milestones.
      if (project.currentMilestone >= project.milestones.length) {
        last = this.evidence(project, project.successCondition, state);
        if (last.status === 'satisfied' && project.status === 'active' && !project.pauseReasons.length) {
          project.status = 'completed';
          project.noProgressAttempts = 0;
          changed = true;
        }
      }
      if (last) project.lastEvidenceId = last.id;
      project.updatedAt = Date.now();
      if (changed) project.checkpoint = { ts: Date.now(), reason: project.status === 'completed' ? 'factually_completed' : 'milestone_completed', observationId: state.observationId, evidenceId: last?.id };
      // Evidence is bounded, and ordinary observations may use the periodic flush.
      this.memory.saveProject(project, changed);
      return project;
    })();
  }

  recordAttempt(outcome: AttemptOutcome, state?: AgentState): Project | undefined {
    const project = this.memory.activeProject();
    if (!project || !outcome.executed || outcome.cancelled || outcome.interrupted || project.pauseReasons.length || project.status !== 'active') return project;
    const after = outcome.after ?? state ?? this.adapter.state();
    if (!observationReady(after) || after.worldId !== project.worldId) return project;
    const beforeMetric = outcome.before ? conditionDeficit(this.target(project), outcome.before, project.worldId) : this.baseline?.deficit;
    const beforeMilestone = this.baseline?.milestone ?? project.currentMilestone;
    this.reconcile(after);
    const current = this.memory.projects().find((p) => p.id === project.id)!;
    if (current.status === 'completed') return current;
    const afterMetric = conditionDeficit(this.target(current), after, current.worldId);
    const progressed = current.currentMilestone > beforeMilestone || (beforeMetric != null && afterMetric != null && afterMetric < beforeMetric - 1e-6);
    current.noProgressAttempts = progressed ? 0 : current.noProgressAttempts + 1;
    if (current.noProgressAttempts >= 3) current.status = 'blocked';
    current.checkpoint = { ts: Date.now(), reason: progressed ? 'observed_progress' : current.status === 'blocked' ? 'three_attempts_without_progress' : 'attempt_without_progress', observationId: after.observationId, evidenceId: current.lastEvidenceId };
    current.updatedAt = Date.now();
    this.memory.saveProject(current);
    this.baseline = { projectId: current.id, revision: current.revision, milestone: current.currentMilestone, deficit: afterMetric };
    return current;
  }

  pause(reason: PauseReason): Project | undefined {
    return this.memory.transaction(() => {
    this.memory.setPauseReason(reason, true);
    const project = this.memory.activeProject();
    if (!project) return;
    if (!project.pauseReasons.includes(reason)) project.pauseReasons.push(reason);
    if (project.status !== 'blocked') project.status = 'paused';
    project.checkpoint = { ts: Date.now(), reason: `paused:${reason}`, evidenceId: project.lastEvidenceId };
    project.updatedAt = Date.now();
    this.memory.saveProject(project);
    this.baseline = null;
    return project;
    });
  }

  resume(reason: PauseReason, state = this.adapter.state()): Project | undefined {
    if (reason !== 'user' && !observationReady(state)) return this.memory.activeProject();
    return this.memory.transaction(() => {
    this.memory.setPauseReason(reason, false);
    const project = this.memory.activeProject();
    if (!project) return;
    project.pauseReasons = project.pauseReasons.filter((r) => r !== reason);
    if (!project.pauseReasons.length && project.status !== 'blocked') project.status = 'active';
    project.checkpoint = { ts: Date.now(), reason: `resumed:${reason}` };
    project.updatedAt = Date.now();
    this.memory.saveProject(project);
    this.baseline = null;
    return project;
    });
  }

  context() {
    const project = this.memory.activeProject();
    return { intent: this.memory.currentIntent() ?? null, project: project ?? null, binding: this.currentBinding(),
      openInterests: this.memory.intents().filter((i) => ['open', 'deferred'].includes(i.status)).slice(-8),
      deferredProjects: this.memory.projects().filter((p) => p.status === 'deferred').slice(-8).map((p) => ({ id: p.id, intentId: p.intentId, title: p.title, worldId: p.worldId, revision: p.revision, currentMilestone: p.currentMilestone, checkpoint: p.checkpoint })),
      evidence: project ? this.memory.evidence().filter((e) => e.projectId === project.id).slice(-5) : [] };
  }

  /** Only an explicit model decision resumes a deferred project; no skill cursor is restored. */
  resumeDeferred(intentId: string, state = this.adapter.state()): Project | undefined {
    const project = this.memory.projects().reverse().find((p) => p.intentId === intentId && p.status === 'deferred');
    if (!project) return;
    if (project.worldId !== state.worldId) throw new Error('旧项目属于另一个世界，保留暂缓；请另开新意图');
    if (this.memory.activeProject()) throw new Error('恢复暂缓项目之前须先处理当前活动项目');
    project.pauseReasons = this.memory.pauseReasons();
    if (!observationReady(state) && !project.pauseReasons.includes('restart')) project.pauseReasons.push('restart');
    project.status = project.pauseReasons.length ? 'paused' : 'active';
    project.checkpoint = { ...project.checkpoint, ts: Date.now(), reason: 'explicit_resume_deferred' };
    project.updatedAt = Date.now();
    this.memory.saveProject(project);
    this.baseline = { projectId: project.id, revision: project.revision, milestone: project.currentMilestone, deficit: conditionDeficit(this.target(project), state, project.worldId) };
    return project;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { evaluateCondition, observationReady, validateCondition } from '../projects/conditions.ts';
import type { Condition } from '../projects/types.ts';
import { SKILLS } from '../skills/index.ts';
import { fail, ok, type Skill } from '../skills/types.ts';
import { shortId, throwIfAborted } from '../util.ts';
import { bindParameters, executeProgram, substitute, validateParameters, validateProgram, type Parameters, type Program } from './program.ts';

export interface AbilityGap {
  id: string;
  description: string;
  worldId: string;
  dimension: string;
  intentId?: string;
  projectId?: string;
  missingPrimitive?: string;
  status: 'open' | 'resolved';
  ts: number;
}
export interface MethodTrial {
  id: string;
  ts: number;
  worldId: string;
  dimension: string;
  sessionId: string;
  observationId: number | string;
  contextKey: string;
  parameters: Record<string, string | number>;
  before: unknown;
  after: unknown;
  status: 'verified' | 'failed' | 'uninformative';
  reason: string;
  source: 'adapter.state';
}
export interface MethodDefinition {
  name: string;
  description: string;
  version: number;
  parameters: Parameters;
  program: Program;
  postcondition: unknown;
  status: 'candidate' | 'verified' | 'retired';
  createdAt: number;
  trials: MethodTrial[];
  scope: { intentId?: string; projectId?: string };
}

/** Candidates remain visibly unverified until isolated executions establish their postcondition. */
export class MethodLibrary {
  private definitions: MethodDefinition[] = [];
  private gaps: AbilityGap[] = [];
  private installed = new Map<string, Skill>();
  private trialWorldIds: Set<string>;

  constructor(private file: string | null, private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus, options: { trialWorldIds?: string[] } = {}) {
    this.trialWorldIds = new Set(options.trialWorldIds ?? []);
    if (file && fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.gaps = Array.isArray(saved.gaps) ? saved.gaps.slice(-100) : [];
        for (const raw of (Array.isArray(saved.methods) ? saved.methods : []).slice(-100)) {
          const validated = this.prepare(raw);
          const trials = Array.isArray(raw.trials) ? raw.trials.slice(-20) : [];
          const status = raw.status === 'retired' ? 'retired' : raw.status === 'verified' && this.hasProof(trials) ? 'verified' : 'candidate';
          const definition: MethodDefinition = { ...validated, version: raw.version, createdAt: raw.createdAt, trials, status, scope: raw.scope ?? {} };
          this.definitions.push(definition);
          if (status !== 'retired') this.install(definition);
        }
      } catch { /* Keep the source file intact; invalid saved programs never become executable. */ }
    }
  }

  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, methods: this.definitions, gaps: this.gaps }, null, 1));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  list(): MethodDefinition[] { return structuredClone(this.definitions); }
  abilityGaps(): AbilityGap[] { return structuredClone(this.gaps.filter((g) => g.worldId === this.memory.worldId)); }

  recordGap(description: string, scope: { intentId?: string; projectId?: string; missingPrimitive?: string } = {}): AbilityGap {
    const state = this.adapter.state();
    const existing = this.gaps.find((g) => g.worldId === state.worldId && g.dimension === state.dim && g.description === description && g.intentId === scope.intentId && g.projectId === scope.projectId && g.status === 'open');
    if (existing) return structuredClone(existing);
    const gap: AbilityGap = { id: shortId('gap_'), description: description.slice(0, 300), worldId: state.worldId, dimension: state.dim, ...scope, status: 'open', ts: Date.now() };
    this.gaps.push(gap);
    if (this.gaps.length > 100) this.gaps.shift();
    this.save();
    this.bus.publish('ability_gap', 'P2', gap.description, { ...gap });
    return structuredClone(gap);
  }

  resolveGap(id: string, methodName: string): boolean {
    const method = this.definitions.find((m) => m.name === methodName && m.status === 'verified');
    const gap = this.gaps.find((g) => g.id === id && g.worldId === this.memory.worldId);
    if (!gap || !method) return false;
    gap.status = 'resolved';
    this.save();
    return true;
  }

  private prepare(raw: any) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !/^[a-z][a-z0-9_]{2,31}$/.test(raw.name) || SKILLS[raw.name]) throw new Error('方法名称须为 3–32 位小写字母/数字/下划线且不与底层技能重名');
    if (typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > 240) throw new Error('方法需要简短用途说明');
    const parameters = validateParameters(raw.parameters, this.adapter);
    const bound = bindParameters(parameters, {});
    const program = validateProgram(raw.program, bound, this.adapter, this.memory, this.adapter.state());
    if (!raw.postcondition) throw new Error('候选方法需要可观测的 postcondition，执行成功文字不能代替验收');
    validateCondition(substitute(raw.postcondition, bound), this.adapter, this.memory, this.adapter.state());
    return { name: raw.name, description: raw.description.trim(), parameters, program, postcondition: structuredClone(raw.postcondition) };
  }

  propose(raw: unknown, scope: { intentId?: string; projectId?: string } = {}): { ok: true; name: string; version: number; status: 'candidate' } | { ok: false; error: string } {
    try {
      if (this.definitions.length >= 100) throw new Error('方法版本库已满，请先回顾或退役旧版本');
      const prepared = this.prepare(raw);
      const version = 1 + Math.max(0, ...this.definitions.filter((d) => d.name === prepared.name).map((d) => d.version));
      const definition: MethodDefinition = { ...prepared, version, createdAt: Date.now(), trials: [], status: 'candidate', scope };
      this.definitions.push(definition);
      this.install(definition);
      this.save();
      const name = `trial:${definition.name}:v${version}`;
      this.bus.publish('method_candidate', 'P2', `保存未验证的方法 ${name}：${definition.description}`, { name, version });
      return { ok: true, name, version, status: 'candidate' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('不可组合的底层技能')) this.recordGap(message, scope);
      return { ok: false, error: message };
    }
  }

  private hasProof(trials: MethodTrial[]) {
    return new Set(trials.filter((t) => t.status === 'verified' && t.source === 'adapter.state' && this.trialWorldIds.has(t.worldId)).map((t) => t.contextKey)).size >= 2;
  }

  promote(name: string, version: number): boolean {
    const definition = this.definitions.find((d) => d.name === name && d.version === version && d.status === 'candidate');
    if (!definition || !this.hasProof(definition.trials)) return false;
    definition.status = 'verified';
    this.install(definition);
    this.save();
    this.bus.publish('method_verified', 'P2', `方法 method:${name} v${version} 在两个隔离情境中通过事实验收`);
    return true;
  }

  retire(name: string, version: number, reason: string) {
    const definition = this.definitions.find((d) => d.name === name && d.version === version);
    if (!definition) return;
    definition.status = 'retired';
    for (const key of [`trial:${name}:v${version}`, `method:${name}`]) {
      if (SKILLS[key] === this.installed.get(key)) { delete SKILLS[key]; this.installed.delete(key); }
    }
    const previous = this.definitions.filter((d) => d.name === name && d.status === 'verified').sort((a, b) => b.version - a.version)[0];
    if (previous) this.install(previous);
    this.save();
    this.bus.publish('method_retired', 'P2', `方法 ${name} v${version} 退役：${reason}`);
  }

  dispose() { for (const [name, skill] of this.installed) if (SKILLS[name] === skill) delete SKILLS[name]; this.installed.clear(); }

  private install(definition: MethodDefinition) {
    const trialName = `trial:${definition.name}:v${definition.version}`;
    const trial = this.toSkill(definition, true);
    SKILLS[trialName] = trial;
    this.installed.set(trialName, trial);
    if (definition.status === 'verified') {
      const name = `method:${definition.name}`;
      const skill = this.toSkill(definition, false);
      SKILLS[name] = skill;
      this.installed.set(name, skill);
    }
  }

  private toSkill(definition: MethodDefinition, trial: boolean): Skill<{ parameters: Record<string, string | number> }> {
    return {
      name: trial ? `trial:${definition.name}:v${definition.version}` : `method:${definition.name}`,
      description: `${trial ? '【候选试验，尚未证明】' : '【已验证方法】'}${definition.description}`,
      argsDoc: JSON.stringify({ parameters: Object.fromEntries(Object.entries(definition.parameters).map(([name, p]) => [name, p.default])) }),
      timeoutMs: 600_000,
      movement: true,
      validate: (raw) => {
        try {
          const parameters = bindParameters(definition.parameters, (raw as any)?.parameters ?? {});
          validateProgram(definition.program, parameters, this.adapter, this.memory, this.adapter.state());
          validateCondition(substitute(definition.postcondition, parameters), this.adapter, this.memory, this.adapter.state());
          if (trial && !this.trialWorldIds.has(this.adapter.state().worldId)) throw new Error('候选方法只能在配置的隔离测试世界中执行');
          return { ok: true, args: { parameters } };
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      },
      run: async (ctx, args) => {
        throwIfAborted(ctx.signal);
        const beforeState = ctx.adapter.state();
        if (trial && !this.trialWorldIds.has(beforeState.worldId)) return fail('BAD_ARGS', '当前世界没有隔离试验授权');
        const postcondition: Condition = validateCondition(substitute(definition.postcondition, args.parameters), ctx.adapter, ctx.memory, beforeState);
        const before = evaluateCondition(postcondition, beforeState);
        if (!observationReady(beforeState)) return fail('NOT_CONNECTED', '方法试验需要有效观测');
        const result = await executeProgram(definition.program, args.parameters, ctx);
        throwIfAborted(ctx.signal);
        const afterState: AgentState = ctx.adapter.state();
        const after = evaluateCondition(postcondition, afterState, beforeState.worldId);
        const sameSession = afterState.sessionId === beforeState.sessionId && afterState.dim === beforeState.dim && afterState.observationId !== beforeState.observationId;
        const satisfied = sameSession && after.status === 'satisfied';
        if (trial) {
          const status: MethodTrial['status'] = result.status !== 'succeeded' || !satisfied ? 'failed' : before.status === 'satisfied' ? 'uninformative' : 'verified';
          definition.trials.push({ id: shortId('trial_'), ts: Date.now(), worldId: afterState.worldId, dimension: afterState.dim, sessionId: afterState.sessionId, observationId: afterState.observationId,
            contextKey: `${beforeState.worldId}:${beforeState.dim}:${Math.floor(beforeState.pos.x / 16)}:${Math.floor(beforeState.pos.z / 16)}:${JSON.stringify(args.parameters)}`,
            parameters: args.parameters, before: before.actual, after: after.actual, status, reason: satisfied ? before.status === 'satisfied' ? '条件在试验前已成立，不作为学习证据' : '执行后同会话事实条件成立' : '执行结束但事实条件未成立', source: 'adapter.state' });
          if (definition.trials.length > 20) definition.trials.shift();
          this.save();
          if (status === 'verified') this.promote(definition.name, definition.version);
        }
        if (result.status !== 'succeeded') return result;
        if (!satisfied) return fail('MISSING_MATERIALS', '方法步骤结束，但真实观测未满足约定结果', { actual: after.actual });
        return ok(`${trial ? '候选试验' : '方法'} ${definition.name} v${definition.version} 的当前事实条件成立`, { verified: definition.status === 'verified', actual: after.actual });
      },
    };
  }
}

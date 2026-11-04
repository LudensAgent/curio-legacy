import fs from 'node:fs';
import path from 'node:path';
import type { GameAdapter } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { SKILLS } from './index.ts';
import { constrainRecoveryAction } from './recovery.ts';
import { fail, ok, runSkill, validateSkill, type Skill } from './types.ts';

/**
 * 技能库（受限的“自我进化”）：
 * LLM 可以把一串已有技能组合成新技能（learn_skill），例如“砍树做木镐”“回死亡点捡东西”。
 * - 只能组合内置技能，不能嵌套其他组合技能，不能执行任意代码
 * - 每一步的参数都要通过对应技能的校验
 * - 运行统计会被记录；多次失败的组合技能自动淘汰
 * - 持久化在 data/skill-library.json，重启后保留
 */

export interface MacroDef {
  name: string; // 不含 macro: 前缀
  description: string;
  steps: { skill: string; args?: unknown }[];
  createdAt: number;
  source: 'llm' | 'builtin';
  /** 保留历史定义供诊断，但不再向执行层注册。显式重新 learn 可激活新定义。 */
  disabled?: { reason: string; at: number };
}

const NAME_RE = /^[a-z][a-z0-9_]{2,31}$/;
const PREFIX = 'macro:';

export class SkillLibrary {
  private defs = new Map<string, MacroDef>();

  constructor(private file: string | null, private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus) {
    if (file && fs.existsSync(file)) {
      try {
        for (const d of JSON.parse(fs.readFileSync(file, 'utf8')) as MacroDef[]) this.install(d, false);
      } catch {
        /* 文件损坏：忽略，从空库开始 */
      }
    }
  }

  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify([...this.defs.values()], null, 1));
  }

  list(): MacroDef[] {
    return [...this.defs.values()];
  }

  /** 校验 LLM 提议的新技能；成功则安装并持久化 */
  learn(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
    const o = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
    const name = String(o.name ?? '').trim().replace(/^macro:/, '');
    if (!NAME_RE.test(name)) return { ok: false, error: '名称需为 3-32 位小写字母/数字/下划线，且以字母开头' };
    if (SKILLS[name]) return { ok: false, error: `与内置技能重名：${name}` };
    if (!Array.isArray(o.steps) || o.steps.length < 2 || o.steps.length > 6) return { ok: false, error: 'steps 需要 2-6 步' };
    const steps: MacroDef['steps'] = [];
    for (const [i, st] of o.steps.entries()) {
      const sk = SKILLS[String(st?.skill ?? '')];
      if (!sk || sk.name.startsWith(PREFIX) || sk.name === 'unstuck') return { ok: false, error: `第 ${i + 1} 步使用了不可组合的技能 ${st?.skill}` };
      const v = validateSkill(sk, st?.args ?? {}, this.adapter);
      if (!v.ok) return { ok: false, error: `第 ${i + 1} 步参数错误：${v.error}` };
      steps.push({ skill: sk.name, args: v.args });
    }
    const def: MacroDef = { name, description: String(o.description ?? '').slice(0, 120) || steps.map((s) => s.skill).join(' → '), steps, createdAt: Date.now(), source: 'llm' };
    const existed = this.defs.has(name);
    this.install(def, true);
    this.bus.publish('skill_learned', 'P2', `${existed ? '更新' : '学会'}了组合技能 ${PREFIX}${name}：${def.description}`, { steps });
    return { ok: true, name: PREFIX + name };
  }

  private install(def: MacroDef, persist: boolean) {
    this.defs.set(def.name, def);
    if (def.disabled) delete SKILLS[PREFIX + def.name];
    else SKILLS[PREFIX + def.name] = this.toSkill(def);
    if (persist) this.save();
  }

  /** 停用有问题的旧组合，保留定义与原因；不抹除历史，也不让重启重新装上它。 */
  suspend(name: string, why: string): boolean {
    const n = name.replace(/^macro:/, ''), def = this.defs.get(n);
    if (!def) return false;
    delete SKILLS[PREFIX + n];
    const reason = why.slice(0, 500);
    if (def.disabled?.reason === reason) return false;
    def.disabled = { reason, at: Date.now() };
    this.save();
    this.bus.publish('skill_suspended', 'P2', `停用组合技能 ${PREFIX}${n}（保留记录）：${reason}`);
    return true;
  }

  forget(name: string, why: string) {
    const n = name.replace(/^macro:/, '');
    if (!this.defs.delete(n)) return;
    delete SKILLS[PREFIX + n];
    this.save();
    this.bus.publish('skill_forgotten', 'P1', `淘汰组合技能 ${PREFIX}${n}：${why}`);
  }

  /** 成功率太低的组合技能自动淘汰（≥3 次运行且成功率 < 1/3） */
  prune() {
    const stats = this.memory.skillStats();
    for (const d of this.defs.values()) {
      if (d.disabled) continue;
      const st = stats[PREFIX + d.name];
      if (st && st.runs >= 3 && st.ok / st.runs < 1 / 3) this.forget(d.name, `成功 ${st.ok}/${st.runs}`);
    }
  }

  private toSkill(def: MacroDef): Skill<{}> {
    const timeout = def.steps.reduce((a, s) => a + (SKILLS[s.skill]?.timeoutMs ?? 60000), 0);
    return {
      name: PREFIX + def.name,
      description: `【自学】${def.description}`,
      argsDoc: '{}',
      timeoutMs: Math.min(timeout, 600_000),
      movement: def.steps.some((s) => SKILLS[s.skill]?.movement),
      // 子步骤全是只读时，宏本身也只读：调度、效果判定和统计都不能把它当物理动作。
      readOnly: def.steps.every((s) => SKILLS[s.skill]?.readOnly === true),
      validate: () => ({ ok: true, args: {} }),
      run: async (ctx) => {
        const results: string[] = [];
        // 宏最多 6 步；只保留只读步骤的实际返回（如 spatial_query 的查询证据），
        // 不重复收集物理动作或代码技能的调用历史。
        const stepResults: Record<string, unknown>[] = [];
        let physical = false;
        let inputCompleted = false;
        for (const [i, st] of def.steps.entries()) {
          const sk = SKILLS[st.skill];
          if (!sk) return fail('ERROR', `组合技能引用的 ${st.skill} 不存在`);
          const v = validateSkill(sk, st.args ?? {}, ctx.adapter);
          if (!v.ok) return fail('BAD_ARGS', `第 ${i + 1} 步参数失效：${v.error}`);
          ctx.progress(i / def.steps.length, `${def.name}：第 ${i + 1}/${def.steps.length} 步 ${st.skill}`);
          const r = await runSkill({ ...ctx, deadline: Math.min(ctx.deadline, Date.now() + sk.timeoutMs) }, sk, constrainRecoveryAction(ctx, st.skill, v.args));
          results.push(`${st.skill}:${r.status}`);
          if (sk.readOnly === true && r.status === 'succeeded' && r.data) stepResults.push({ skill: st.skill, status: r.status, data: r.data });
          // 与 use_skill 一致：输入已执行但效果未确认时不是物理改变；显式 verified + changed 才是真效果。
          const effect = r.data?.effectEvidence as { verified?: boolean; changed?: boolean } | undefined;
          const confirmedEffect = effect?.verified === true && effect.changed === true;
          const inputOnly = r.data?.inputCompleted === true && (r.data.effectUnconfirmed ?? !confirmedEffect);
          if (confirmedEffect) physical = true;
          if (r.status === 'succeeded' && sk.readOnly !== true && r.data?.noop !== true && !inputOnly) physical = true;
          if (r.data?.inputCompleted === true) inputCompleted = true;
          if (r.status !== 'succeeded') {
            return { ...r, summary: `${def.name} 在第 ${i + 1} 步失败：${r.summary}`,
              data: { ...(r.data ?? {}), ...(stepResults.length ? { stepResults } : {}) } };
          }
        }
        // 只读/空转结果不是物理执行：保留查询数据与状态，但不冒充身体效果。
        const noop = !physical && !inputCompleted;
        return ok(`${def.name} 完成（${results.join('，')}）`, {
          ...(stepResults.length ? { stepResults } : {}),
          ...(inputCompleted ? { inputCompleted: true, effectUnconfirmed: !physical } : {}),
          ...(noop ? { noop: true } : {}),
        });
      },
    };
  }
}

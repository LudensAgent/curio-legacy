import { evalPredicate, senseNow, type Predicate } from '../mind/predicate.ts';
import { throwIfAborted } from '../util.ts';
import { SKILLS } from './index.ts';
import { fail, isAbort, obj, ok, type Skill, type SkillResult } from './types.ts';

/** use_skill 只需要按名字取出步骤；注册表由 main 设置（行为引擎） */
export interface BehaviorLookup {
  get(name: string): { name: string; description: string; steps: { skill: string; args?: unknown; if?: Predicate; optional?: boolean }[] } | undefined;
  list(): { name: string }[];
}
let registry: BehaviorLookup | null = null;
export function setBehaviorRegistry(r: BehaviorLookup | null) { registry = r; }

/**
 * 照着自己写的技能一步步做（技能书里带动作步骤的那种）。
 * 每一步开工前当场判断它的 if 条件；参数在开工时重新校验（朝向、坐标按当时站的位置算）。
 */
export const useSkill: Skill<{ name: string }> = {
  name: 'use_skill',
  description: '照着技能书里带动作步骤的技能一步步做（自己写的做法、恢复办法）；每步的 if 条件当场判断',
  argsDoc: '{"name":"技能名"}',
  timeoutMs: 120000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const name = String(a.name ?? a.skill ?? '').trim().toLowerCase();
    if (!name) return { ok: false, error: '要用哪份技能？写 {"name":"技能名"}' };
    if (registry && !registry.get(name)) {
      const have = registry.list().map((b) => b.name).slice(0, 12);
      return { ok: false, error: `没有叫 ${name} 的可执行技能${have.length ? `；有：${have.join('、')}` : '（还没写过带步骤的技能）'}` };
    }
    return { ok: true, args: { name } };
  },
  async run(ctx, args) {
    const b = registry?.get(args.name);
    if (!b) return fail('BAD_ARGS', `技能 ${args.name} 不存在或已停用`);
    const done: string[] = [];
    for (const [i, st] of b.steps.entries()) {
      throwIfAborted(ctx.signal);
      ctx.progress(i / b.steps.length, `${b.name}：第 ${i + 1} 步 ${st.skill}`);
      if (st.if && !evalPredicate(st.if, senseNow(ctx.adapter, ctx.senses, 'use_skill'))) { done.push(`${st.skill} 跳过（条件不成立）`); continue; }
      const skill = SKILLS[st.skill];
      const v = skill?.validate(st.args ?? {}, ctx.adapter);
      if (!skill || !v?.ok) {
        if (st.optional) { done.push(`${st.skill} 跳过（${v && !v.ok ? v.error : '没有这个动作'}）`); continue; }
        return fail('BAD_ARGS', `技能「${b.name}」第 ${i + 1} 步 ${st.skill} 写错了：${v && !v.ok ? v.error : '没有这个动作'}`, { done });
      }
      let r: SkillResult;
      try {
        r = await skill.run({ ...ctx, deadline: Math.min(ctx.deadline, Date.now() + skill.timeoutMs),
          progress: (p, note) => ctx.progress((i + Math.max(0, Math.min(1, p))) / b.steps.length, note) }, v.args);
      } catch (e) {
        if (isAbort(e)) throw e;
        r = fail('ERROR', String((e as Error)?.message ?? e));
      }
      if (r.status === 'cancelled') return r;
      done.push(`${st.skill} → ${r.status === 'succeeded' ? '成' : `没成(${r.failureCode ?? ''})`}`);
      if (r.status === 'failed' && !st.optional) return fail(r.failureCode ?? 'ERROR', `技能「${b.name}」第 ${i + 1} 步 ${st.skill} 没成：${r.summary.slice(0, 120)}`, { done });
    }
    ctx.progress(1);
    return ok(`照技能「${b.name}」做完了：${done.join('，')}`, { done });
  },
};

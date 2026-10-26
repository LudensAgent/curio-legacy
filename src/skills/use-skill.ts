import { makeBridge } from '../codeskills/bridge.ts';
import { runSandboxed } from '../codeskills/sandbox.ts';
import { evalPredicate, senseNow, type Predicate } from '../mind/predicate.ts';
import { throwIfAborted } from '../util.ts';
import { dirName } from '../perception/perception.ts';
import { SKILLS } from './index.ts';
import { fail, isAbort, obj, ok, type Skill, type SkillResult } from './types.ts';

/** use_skill 只需要按名字取出步骤；注册表由 main 设置（行为引擎） */
export interface BehaviorLookup {
  get(name: string): { name: string; description: string; steps: { skill: string; args?: unknown; if?: Predicate; optional?: boolean }[]; code?: string; version?: number; needs?: Record<string, string> } | undefined;
  list(): { name: string }[];
}
let registry: BehaviorLookup | null = null;
export function setBehaviorRegistry(r: BehaviorLookup | null) { registry = r; }

/**
 * 照着自己写的技能一步步做（技能书里带动作步骤的那种）。
 * 每一步开工前当场判断它的 if 条件；参数在开工时重新校验（朝向、坐标按当时站的位置算）。
 */
export const useSkill: Skill<{ name: string; args?: Record<string, unknown>; failure?: Record<string, unknown> }> = {
  name: 'use_skill',
  description: '用技能书里会动手的技能：带步骤的一步步做，代码技能在沙箱里运行（args 原样交给代码）',
  argsDoc: '{"name":"技能名","args"?:{给代码技能的参数}}',
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
    const extra = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args as Record<string, unknown> : undefined;
    if (extra && JSON.stringify(extra).length > 2000) return { ok: false, error: 'args 太大了' };
    const failure = a.failure && typeof a.failure === 'object' ? a.failure as Record<string, unknown> : undefined;
    // 技能声明了要哪些参数：调用时没给就当场说清楚，别让代码跑到一半才报错
    const needs = registry?.get(name)?.needs;
    const missing = needs && !failure ? Object.keys(needs).filter((k) => extra?.[k] === undefined || extra[k] === '') : [];
    if (missing?.length) return { ok: false, error: `${name} 需要参数：${missing.map((k) => `args.${k}（${needs![k]}）`).join('、')}；写 {"name":"${name}","args":{${missing.map((k) => `"${k}":…`).join(',')}}}` };
    return { ok: true, args: { name, ...(extra ? { args: extra } : {}), ...(failure ? { failure } : {}) } };
  },
  async run(ctx, args) {
    const b = registry?.get(args.name);
    if (!b) return fail('BAD_ARGS', `技能 ${args.name} 不存在或已停用`);
    // 技能自己报的结果之外，身体实际挪了多少：一份叫“挖阶梯下去”的技能，实际是在地表平着走了几十格，靠这个才看得出来
    const from = ctx.adapter.state().pos;
    const moved = () => {
      const to = ctx.adapter.state().pos;
      const h = Math.hypot(to.x - from.x, to.z - from.z), dy = Math.floor(to.y) - Math.floor(from.y);
      if (h < 3 && Math.abs(dy) < 1) return { text: '', h: Math.round(h), dy };
      return { text: `（身体实际：往 ${dirName(to.x - from.x, to.z - from.z)} 平移 ${Math.round(h)} 格，高度 ${dy > 0 ? `上升 ${dy}` : dy < 0 ? `下降 ${-dy}` : '没变'}，y ${Math.floor(from.y)}→${Math.floor(to.y)}）`, h: Math.round(h), dy };
    };
    if (b.code) {
      // 代码技能：在沙箱里跑模型写的 JavaScript；失败时把出错的行和最后几次 api 调用交回去（后台改进会用到）
      const input = { ...(args.args ?? {}), ...(args.failure ? { failure: args.failure } : {}) };
      const r = await runSandboxed(b.code, input, makeBridge(ctx), {
        signal: ctx.signal, deadline: ctx.deadline - 500,
        onProgress: (p) => ctx.progress(Math.max(0, Math.min(1, p))),
        onLog: (t) => ctx.bus.publish('skill_log', 'P3', `[${b.name}] ${t}`),
      });
      const data = { version: b.version ?? 1, calls: r.calls, trace: r.trace, logs: r.logs, args: JSON.stringify(input).slice(0, 300), ...(r.line ? { line: r.line } : {}) };
      const m = moved();
      if (!r.ok) return fail(/超时/.test(r.error ?? '') ? 'TIMEOUT' : 'ERROR', `代码技能「${b.name}」v${b.version ?? 1} 没成${r.line ? `（第 ${r.line} 行）` : ''}：${r.error}${m.text}`, { ...data, displacement: { horizontal: m.h, dy: m.dy } });
      return ok(`代码技能「${b.name}」做完了${m.text}${r.result !== null && r.result !== undefined ? `：${JSON.stringify(r.result).slice(0, 160)}` : ''}`, { ...data, result: r.result, displacement: { horizontal: m.h, dy: m.dy } });
    }
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
    return ok(`照技能「${b.name}」做完了：${done.join('，')}${moved().text}`, { done });
  },
};

import { makeBridge } from '../codeskills/bridge.ts';
import { runSandboxed, VERIFY_METHODS, type SandboxHandler } from '../codeskills/sandbox.ts';
import { evalPredicate, senseNow, type Predicate } from '../mind/predicate.ts';
import { throwIfAborted } from '../util.ts';
import { dirName } from '../perception/perception.ts';
import { SKILLS } from './index.ts';
import { fail, isAbort, obj, ok, type Skill, type SkillResult } from './types.ts';

/** use_skill 只需要按名字取出步骤；注册表由 main 设置（行为引擎） */
export interface BehaviorLookup {
  get(name: string): { name: string; description: string; steps: { skill: string; args?: unknown; if?: Predicate; optional?: boolean }[]; code?: string; version?: number; verify?: string; needs?: Record<string, string> } | undefined;
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
    let extra = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args as Record<string, unknown> : undefined;
    // 参数直接摊在外面（{"name":"x","dir":"E","count":20}）也认：两种写法它都会写，意思一样，没必要每次退回去让它改
    const flat = Object.fromEntries(Object.entries(a).filter(([k]) => !['name', 'skill', 'args', 'failure'].includes(k)));
    if (Object.keys(flat).length) extra = { ...flat, ...(extra ?? {}) };
    if (extra && JSON.stringify(extra).length > 2000) return { ok: false, error: 'args 太大了' };
    const failure = a.failure && typeof a.failure === 'object' ? a.failure as Record<string, unknown> : undefined;
    // 技能声明了要哪些参数：调用时没给就当场说清楚，别让代码跑到一半才报错
    const needs = registry?.get(name)?.needs;
    // 说明里写了“默认…/不给就…/省略…/可选”的参数是可以不给的：以前一律当必填，报错又说“不给就按当前朝向”，自相矛盾
    const optional = (desc: unknown) => /默认|不给|省略|可选|可不|不写|没给|缺省|optional|default/i.test(String(desc ?? ''));
    const missing = needs && !failure ? Object.keys(needs).filter((k) => !optional(needs[k]) && (extra?.[k] === undefined || extra[k] === '')) : [];
    // 声明了参数的技能：传了它不认识的名字（targetY、depth……）会被代码悄悄忽略，当场说清楚它要的是什么
    const unknown = needs && extra ? Object.keys(extra).filter((k) => !(k in needs) && k !== 'trigger') : [];
    if (unknown.length) return { ok: false, error: `${name} 不认识参数 ${unknown.map((k) => `args.${k}`).join('、')}；它要的是：${Object.entries(needs!).map(([k, v]) => `args.${k}（${v}）`).join('、')}` };
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
    // 背包的样子：和位置一起看这次到底有没有做任何事
    const invSig = () => ctx.adapter.state().inventory.map((i) => `${i.name}:${i.count}`).sort().join('|');
    const invBefore = invSig();
    const bridge = makeBridge(ctx);
    // 开工前的样子：给判定代码对照（做完以后真的变了没有）
    const before = b.verify ? await bridge('state', []).catch(() => null) : null;
    if (b.code) {
      // 代码技能：在沙箱里跑模型写的 JavaScript；失败时把出错的行和最后几次 api 调用交回去（后台改进会用到）
      const input = { ...(args.args ?? {}), ...(args.failure ? { failure: args.failure } : {}) };
      // 判定里调用参数在 args.args，代码里就是 args 本身；两种写法都认，免得代码照着判定的写法读不到参数
      const codeArgs = 'args' in input ? input : { ...input, args: input };
      const r = await runSandboxed(b.code, codeArgs, bridge, {
        signal: ctx.signal, deadline: ctx.deadline - 500,
        onProgress: (p) => ctx.progress(Math.max(0, Math.min(1, p))),
        onLog: (t) => ctx.bus.publish('skill_log', 'P3', `[${b.name}] ${t}`),
      });
      const data = { version: b.version ?? 1, calls: r.calls, trace: r.trace, logs: r.logs, args: JSON.stringify(input).slice(0, 300), ...(r.line ? { line: r.line } : {}) };
      const m = moved();
      if (!r.ok) return fail(/超时/.test(r.error ?? '') ? 'TIMEOUT' : 'ERROR', `代码技能「${b.name}」v${b.version ?? 1} 没成${r.line ? `（第 ${r.line} 行）` : ''}：${r.error}${m.text}`, { ...data, displacement: { horizontal: m.h, dy: m.dy } });
      // 代码自己说没成（返回 {ok:false,…}）：照它说的算失败，不能记成“做完了”
      const res = r.result as Record<string, unknown> | null | undefined;
      if (res && typeof res === 'object' && !Array.isArray(res) && res.ok === false) {
        return fail('ERROR', `代码技能「${b.name}」v${b.version ?? 1} 自己报告没成：${JSON.stringify(res).slice(0, 160)}${m.text}`, { ...data, result: r.result, displacement: { horizontal: m.h, dy: m.dy } });
      }
      const judged = await verifyRun(b, bridge, { before, result: r.result ?? null, args: input }, ctx);
      if (judged) return fail('ERROR', `代码技能「${b.name}」v${b.version ?? 1} 说做完了，但${judged}${m.text}`, { ...data, result: r.result, verified: false, displacement: { horizontal: m.h, dy: m.dy } });
      // 代码没报错，但身体一点没动、背包没变、也没挖没放：说清楚这次什么都没做（可能是条件不满足就跳过了，也可能是技能没起作用），别当成“做成了”
      const acted = (r.trace ?? []).some((t: string) => /^(digAt|placeAt|stepTo|moveTo|goto|attack|useItem|useOn|craft|smelt|equip|toss|eat|interact|swim|jump|pillar)/.test(String(t)) && / → /.test(String(t)) && !/"ok":false/.test(String(t)));
      const still = Math.abs(ctx.adapter.state().pos.x - from.x) + Math.abs(ctx.adapter.state().pos.z - from.z) < 0.3 && Math.floor(ctx.adapter.state().pos.y) === Math.floor(from.y);
      const noop = still && invSig() === invBefore && !acted;
      const noopText = noop ? '（身体这次什么都没做：没挪动、背包没变、没挖也没放。是条件不满足跳过了，还是技能没起作用，看上面的结果；要的事并没有发生）' : '';
      return ok(`代码技能「${b.name}」做完了${m.text}${r.result !== null && r.result !== undefined ? `：${JSON.stringify(r.result).slice(0, 160)}` : ''}${noopText}`, { ...data, result: r.result, displacement: { horizontal: m.h, dy: m.dy }, ...(noop ? { noop: true } : {}) });
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
    const judged = await verifyRun(b, bridge, { before, result: { done }, args: args.args ?? {} }, ctx);
    if (judged) return fail('ERROR', `技能「${b.name}」的步骤都做完了，但${judged}${moved().text}`, { done, verified: false });
    return ok(`照技能「${b.name}」做完了：${done.join('，')}${moved().text}`, { done });
  },
};

/**
 * 跑技能自己带的判定（verify）：做完以后看一眼世界，确认真的做成了。
 * 只能读（state/blockAt/region/entities/drops/nearestLand），最多几秒。返回 null = 判定通过（或者这份技能没写判定）；
 * 否则返回一句说明，算这次没做成——代码没抛错不等于做成了。
 */
async function verifyRun(b: { name: string; verify?: string }, bridge: SandboxHandler, input: { before: unknown; result: unknown; args: unknown },
  ctx: { signal: AbortSignal; deadline: number; bus: { publish: (...a: any[]) => void } }): Promise<string | null> {
  if (!b.verify) return null;
  const allowed = new Set<string>(VERIFY_METHODS);
  const readOnly: SandboxHandler = async (m, a) => {
    if (!allowed.has(m) && m !== 'log') throw new Error(`判定只能看不能动：不能用 api.${m}`);
    return bridge(m, a);
  };
  const r = await runSandboxed(b.verify, input, readOnly, {
    signal: ctx.signal, deadline: Math.min(ctx.deadline, Date.now() + 5000), maxCalls: 400,
    onLog: (t) => ctx.bus.publish('skill_log', 'P3', `[${b.name} 判定] ${t}`),
  });
  if (!r.ok) return `判定代码出错${r.line ? `（第 ${r.line} 行）` : ''}：${r.error}`;
  const v = r.result as unknown;
  if (v === true || (v && typeof v === 'object' && (v as any).ok === true)) return null;
  const why = typeof v === 'string' ? v : v && typeof v === 'object' && (v as any).why ? String((v as any).why) : JSON.stringify(v);
  return `判定没通过：${String(why).slice(0, 200)}`;
}

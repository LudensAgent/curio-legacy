import { makeBridge, visibleActionSenses } from '../codeskills/bridge.ts';
import { runSandboxed, VERIFY_METHODS, type SandboxHandler } from '../codeskills/sandbox.ts';
import { evalPredicate, senseNow, type Predicate } from '../mind/predicate.ts';
import { throwIfAborted } from '../util.ts';
import { dirName } from '../perception/perception.ts';
import { SKILLS } from './index.ts';
import { relativeCellAction, STANCE_MOVES } from './stance.ts';
import { constrainRecoveryAction, recoveryContext, worldPoint, type RecoveryContext } from './recovery.ts';
import { fail, isAbort, obj, ok, runSkill, validateSkill, type Skill, type SkillCtx, type SkillResult } from './types.ts';

/** use_skill 只需要按名字取出步骤；注册表由 main 设置（行为引擎） */
export interface BehaviorLookup {
  get(name: string, trial?: boolean): { name: string; description: string; steps: { skill: string; args?: unknown; if?: Predicate; optional?: boolean }[]; code?: string; version?: number; verify?: string; needs?: Record<string, string> } | undefined;
  list(): { name: string }[];
  executionError?(name: string, trial?: boolean): string | null;
  recordInvocation?(name: string, result: SkillResult): void;
}
const OBSERVATION_ACTIONS = new Set(['look', 'look_around', 'wait', 'inspect_block', 'assess_landings']);
/** 代码技能里实际发生失败的导航动作；用于保留真实的最近一次失败回执。 */
const NAVIGATION_ACTIONS = new Set(['walk_to', 'walk_known_route']);
/** 步骤结果只保留有界的最近条目，避免代码/宏把整段历史都塞进失败回执。 */
const MAX_STEP_RESULTS = 8;
let registry: BehaviorLookup | null = null;
export function setBehaviorRegistry(r: BehaviorLookup | null) { registry = r; }

/**
 * 照着自己写的技能一步步做（技能书里带动作步骤的那种）。
 * 每一步开工前当场判断它的 if 条件；参数在开工时重新校验（朝向、坐标按当时站的位置算）。
 */
export const useSkill: Skill<{ name: string; trial?: boolean; args?: Record<string, unknown>; failure?: RecoveryContext }> = {
  name: 'use_skill',
  description: '用技能书里会动手的技能：带步骤的一步步做，代码技能在沙箱里运行（args 原样交给代码）',
  argsDoc: '{"name":"技能名","trial"?:true（显式试用尚未启用的候选版本）,"args"?:{给代码技能的参数}}',
  timeoutMs: 120000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const name = String(a.name ?? a.skill ?? '').trim().toLowerCase();
    if (!name) return { ok: false, error: '要用哪份技能？写 {"name":"技能名"}' };
    const trial = a.trial === true;
    const unavailable = registry?.executionError?.(name, trial);
    if (unavailable) return { ok: false, error: unavailable };
    if (registry && !registry.get(name, trial)) {
      const have = registry.list().map((b) => b.name).slice(0, 12);
      return { ok: false, error: `没有叫 ${name} 的可执行技能${have.length ? `；有：${have.join('、')}` : '（还没写过带步骤的技能）'}` };
    }
    let extra = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args as Record<string, unknown> : undefined;
    // 参数直接摊在外面（{"name":"x","dir":"E","count":20}）也认：两种写法它都会写，意思一样，没必要每次退回去让它改
    const flat = Object.fromEntries(Object.entries(a).filter(([k]) => !['name', 'skill', 'args', 'failure', 'trial', 'make'].includes(k)));
    if (Object.keys(flat).length) extra = { ...flat, ...(extra ?? {}) };
    if (extra && JSON.stringify(extra).length > 2000) return { ok: false, error: 'args 太大了' };
    const failure = a.failure === undefined ? undefined : recoveryContext(a.failure);
    if (failure && 'error' in failure) return { ok: false, error: failure.error };
    // 技能声明了要哪些参数：调用时没给就当场说清楚，别让代码跑到一半才报错
    const needs = registry?.get(name, trial)?.needs;
    // 说明里写了“默认…/不给就…/省略…/可选”的参数是可以不给的：以前一律当必填，报错又说“不给就按当前朝向”，自相矛盾
    const optional = (desc: unknown) => /默认|不给|省略|可选|可不|不写|没给|缺省|optional|default/i.test(String(desc ?? ''));
    const missing = needs && !failure ? Object.keys(needs).filter((k) => !optional(needs[k]) && (extra?.[k] === undefined || extra[k] === '')) : [];
    // 声明了参数的技能：传了它不认识的名字（targetY、depth……）会被代码悄悄忽略，当场说清楚它要的是什么
    const unknown = needs && extra ? Object.keys(extra).filter((k) => !(k in needs) && k !== 'trigger') : [];
    if (unknown.length) return { ok: false, error: `${name} 不认识参数 ${unknown.map((k) => `args.${k}`).join('、')}；它要的是：${Object.entries(needs!).map(([k, v]) => `args.${k}（${v}）`).join('、')}` };
    if (missing?.length) return { ok: false, error: `${name} 需要参数：${missing.map((k) => `args.${k}（${needs![k]}）`).join('、')}；完整参数：${Object.entries(needs!).map(([k, v]) => `args.${k}（${v}）`).join('、')}；已提供：${Object.keys(extra ?? {}).map((k) => `args.${k}`).join('、') || '无'}；保留已提供的参数并补齐缺项` };
    return { ok: true, args: { name, ...(trial ? { trial } : {}), ...(extra ? { args: extra } : {}), ...(failure ? { failure } : {}) } };
  },
  async run(ctx, args) {
    const unavailable = registry?.executionError?.(args.name, args.trial);
    if (unavailable) return fail('BAD_ARGS', unavailable);
    const b = registry?.get(args.name, args.trial);
    if (!b) return fail('BAD_ARGS', `技能 ${args.name} 不存在或已停用`);
    const recovery = ctx.recovery ?? (args.failure ? { ...args.failure, allowPlace: args.args?.allowPlace === true, allowDig: args.args?.allowDig === true } : undefined);
    ctx = { ...ctx, ...(recovery ? { recovery } : {}), ...(recovery?.args.make === false ? { make: false } : {}) };
    // 整个技能执行实例累计的爬升级数，跨取消/失败保留，避免“缺少回执”被当成“没有进展”。
    let climbedTotal = 0;
    // 成功、失败、取消统一附加累计效果：局部增量（climbed）与共享账本累计（spent）分开。
    const climbFacts = () => (climbedTotal > 0 ? { climbed: climbedTotal, spent: recovery?.climb?.spent ?? climbedTotal } : {});
    const result = await (async (): Promise<SkillResult> => {
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
      // 战斗状态（举盾/拉弓）单独比：这类防御动作不动、不改背包，却是真实效果，不能当成空转
      const combatSig = () => { const c = ctx.adapter.combatState?.() ?? { usingItem: false, offHand: null }; return `${c.usingItem ? 1 : 0}:${c.offHand ?? ''}`; };
      const combatBefore = combatSig();
      let acted = false;
      let inputCompleted = false;
      let effectExpect: { discarded?: string[]; forMs?: number; what?: string; by: string } | null = null;
      // 代码技能抛错时保留最近一次真实导航失败的结构化回执；它是上下文，不是后续错误的成因，
      // 也不代表当前/新位置。只记录动作实际返回的失败回执，不从截断 trace 重建或重读现场。
      let lastNavigationFailure: Record<string, unknown> | null = null;
      const handle = makeBridge(ctx);
      const bridge: SandboxHandler = async (method, values) => {
        const value = await handle(method, values);
        const receipt = value as { ok?: boolean; code?: string | null; summary?: string; moved?: number; data?: { noop?: boolean; inputCompleted?: boolean; effectUnconfirmed?: boolean; expect?: { discarded?: string[]; forMs?: number; what?: string }; effectEvidence?: { verified?: boolean; changed?: boolean }; climbed?: number; nav?: unknown; originalRequest?: unknown; knownStart?: unknown; search?: unknown } } | null;
        const child = method === 'act' ? String(values[0] ?? '') : method === 'useSkill' ? String(values[0] ?? '') : '';
        const nestedData = receipt?.data as Record<string, unknown> | undefined;
        // 实际返回的导航证据：直接导航动作、失败的组合宏，或嵌套 useSkill 的子结果。
        const navEvidence = (data: Record<string, unknown> | undefined) => data !== undefined
          && ['nav', 'originalRequest', 'knownStart', 'search'].some((key) => data[key] !== undefined);
        const nestedReceipt = nestedData?.lastNavigationFailure;
        const failed = receipt != null && receipt.ok !== true;
        const directNavigationFailure = failed && (method === 'act'
          ? NAVIGATION_ACTIONS.has(child) || (child.startsWith('macro:') && navEvidence(nestedData))
          : method === 'useSkill' && navEvidence(nestedData));
        if (directNavigationFailure) {
          lastNavigationFailure = {
            childSkill: child,
            via: method,
            request: method === 'act' ? values[1] ?? null : { name: child, args: values[1] ?? null },
            result: { ok: false, code: receipt.code ?? null, summary: receipt.summary ?? '', ...(receipt.data !== undefined ? { data: receipt.data } : {}) },
            note: 'contextual prior navigation failure receipt; not the cause of a later code error and not a current or new position',
          };
        } else if (failed && nestedReceipt !== null && nestedReceipt !== undefined && typeof nestedReceipt === 'object' && !Array.isArray(nestedReceipt)) {
          // 子代码技能只暴露 data.lastNavigationFailure：保留该回执的实际 child/call 身份与原结果，
          // 不改写成本层调用或当前导航状态。
          lastNavigationFailure = nestedReceipt as Record<string, unknown>;
        }
        // 代码桥与声明式步骤共用效果收集：api.act 的爬升也计入整个技能实例的累计进展。
        if (typeof receipt?.data?.climbed === 'number') climbedTotal += receipt.data.climbed;
        // 嵌套动作声明的持续效果（toss_item 的 discarded）要带上去：做完以后被自己打破，才能把失败记到这份技能头上
        const nested = receipt?.data?.expect;
        if (nested && !effectExpect) effectExpect = { ...nested, by: b.name };
        const evidence = receipt?.data?.effectEvidence?.verified === true && receipt.data.effectEvidence.changed === true;
        const inputOnly = receipt?.data?.inputCompleted === true && (receipt.data.effectUnconfirmed ?? !evidence);
        if (receipt?.data?.inputCompleted === true) inputCompleted = true;
        const okEffect = receipt?.ok === true && receipt.data?.noop !== true && !inputOnly;
        // 有的动作自己报 ok 但没真做（move moved=0、shield 没举、look/lookAt 只转头）；有的报没成却真改了世界（挖到一半）
        // ——只有真正改变了身体/世界才算"动了"：effectEvidence 是通用真效果信号；move 看 moved>0；look/lookAt/shield 不算。
        // 只读动作（含由只读子步骤组成的宏）即使成功也不改变身体/世界，不能算物理执行。
        const observationAction = method === 'act'
          && (OBSERVATION_ACTIONS.has(String(values[0])) || SKILLS[String(values[0])]?.readOnly === true);
        const effectful = evidence
          || (method === 'move' ? (receipt?.moved ?? 0) > 0
            : !['look', 'lookAt', 'shield', 'log', 'sleep', 'progress'].includes(method)
              && !VERIFY_METHODS.includes(method as typeof VERIFY_METHODS[number])
              && !observationAction
              && okEffect);
        if (effectful) acted = true;
        return value;
      };
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
        const receipt = lastNavigationFailure === null ? {} : { lastNavigationFailure };
        const m = moved();
        if (!r.ok) return fail(/超时/.test(r.error ?? '') ? 'TIMEOUT' : 'ERROR', `代码技能「${b.name}」v${b.version ?? 1} 没成${r.line ? `（第 ${r.line} 行）` : ''}：${r.error}${m.text}`, { ...data, ...receipt, displacement: { horizontal: m.h, dy: m.dy } });
        // 代码自己说没成（返回 {ok:false,…}）：照它说的算失败，不能记成“做完了”
        const res = r.result as Record<string, unknown> | null | undefined;
        if (res && typeof res === 'object' && !Array.isArray(res) && res.ok === false) {
          return fail('ERROR', `代码技能「${b.name}」v${b.version ?? 1} 自己报告没成：${JSON.stringify(res).slice(0, 160)}${m.text}`, { ...data, ...receipt, result: r.result, displacement: { horizontal: m.h, dy: m.dy } });
        }
        const judged = await verifyRun(b, bridge, { before, result: r.result ?? null, args: input }, ctx);
        if (judged) return fail('ERROR', `代码技能「${b.name}」v${b.version ?? 1} 说做完了，但${judged}${m.text}`, { ...data, ...receipt, result: r.result, verified: false, displacement: { horizontal: m.h, dy: m.dy } });
        // 代码没报错，但身体一点没动、背包没变、也没挖没放：说清楚这次什么都没做（可能是条件不满足就跳过了，也可能是技能没起作用），别当成“做成了”
        const still = Math.abs(ctx.adapter.state().pos.x - from.x) + Math.abs(ctx.adapter.state().pos.z - from.z) < 0.3 && Math.floor(ctx.adapter.state().pos.y) === Math.floor(from.y);
        const combatChanged = combatSig() !== combatBefore;
        // 原始使用输入确实执行过，不能称为空转；但期间捡到物品不能替它证明效果。
        const effectUnconfirmed = inputCompleted && !acted && !b.verify;
        const noop = !inputCompleted && still && invSig() === invBefore && !acted && !combatChanged;
        const noopText = noop ? '（没有观察到身体或世界效果：没挪动、背包没变、没挖也没放。是条件不满足跳过了，还是技能没起作用，看上面的结果）' : '';
        const inputText = effectUnconfirmed ? '（使用输入已执行，效果尚未确认）' : '';
        return ok(`代码技能「${b.name}」做完了${m.text}${r.result !== null && r.result !== undefined ? `：${JSON.stringify(r.result).slice(0, 160)}` : ''}${noopText}${inputText}`, { ...data, ...(inputCompleted ? { inputCompleted: true, effectUnconfirmed } : {}), result: r.result, verified: !!b.verify, displacement: { horizontal: m.h, dy: m.dy }, ...(effectExpect ? { expect: effectExpect } : {}), ...(noop ? { noop: true } : {}) });
      }
      const done: string[] = [];
      // 只读步骤（spatial_query、只读宏等）成功时的实际返回：保留查询数据，但不计为物理执行。
      // steps 数量受技能上限约束（行为步骤最多 8），不会额外收集代码的 api 调用历史。
      const stepResults: Record<string, unknown>[] = [];
      let completedSteps = 0;
      // 上一步移动未确认到达的事实：下一步校验完成后、执行前用它判断相对坐标依赖。
      let pendingStance: { skill: string; step: number; pos?: { x: number; y: number; z: number }; data?: Record<string, unknown> } | null = null;
      for (const [i, st] of b.steps.entries()) {
        throwIfAborted(ctx.signal);
        ctx.progress(i / b.steps.length, `${b.name}：第 ${i + 1} 步 ${st.skill}`);
        if (st.if && !evalPredicate(st.if, senseNow(ctx.adapter, ctx.senses, 'use_skill'))) { done.push(`${st.skill} 跳过（条件不成立）`); continue; }
        const skill = SKILLS[st.skill];
        const v = skill ? validateSkill(skill, st.args ?? {}, ctx.adapter) : null;
        if (!skill || !v?.ok) {
          if (st.optional) { done.push(`${st.skill} 跳过（${v && !v.ok ? v.error : '没有这个动作'}）`); continue; }
          return fail('BAD_ARGS', `技能「${b.name}」第 ${i + 1} 步 ${st.skill} 写错了：${v && !v.ok ? v.error : '没有这个动作'}`, { done });
        }
        // 校验完成后、执行前：上一步移动未确认到达，本步是相对挖掘/放置 → 报告依赖缺口，不执行本步。
        if (pendingStance !== null && relativeCellAction(st.skill, v.args)) {
          const pos = pendingStance.pos;
          const where = pos
            ? `${pendingStance.data !== undefined ? '原失败回执位置在' : '当时读取位置在'} (${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)})`
            : '没有保留原始站位回执';
          // 原失败步骤的实际回执只作为先验上下文，不冒充本次错误成因或当前 Nav/位置。
          const priorNavigation = pendingStance.data !== undefined ? {
            skill: pendingStance.skill,
            step: pendingStance.step,
            ...(pos ? { position: { ...pos } } : {}),
            data: pendingStance.data,
          } : undefined;
          return fail('ERROR', `技能「${b.name}」第 ${pendingStance.step} 步「${pendingStance.skill}」没到新站位，${where}；第 ${i + 1} 步「${st.skill}」是相对坐标，会打到错误位置。先确认实际站位或改用绝对坐标`,
            { done, ...(stepResults.length ? { stepResults } : {}), ...(priorNavigation ? { priorNavigation } : {}) });
        }
        // 只读中间步骤（如 spatial_query）既不移动也不确认新站位，不能清掉未解决的移动缺口；
        // 只有实际执行的非只读步骤才消耗该事实。绝对坐标动作本就直接放行。
        if (SKILLS[st.skill]?.readOnly !== true) pendingStance = null;
        let r: SkillResult;
        try {
          r = await runSkill({ ...ctx, senses: visibleActionSenses(ctx.senses), deadline: Math.min(ctx.deadline, Date.now() + skill.timeoutMs),
            progress: (p, note) => ctx.progress((i + Math.max(0, Math.min(1, p))) / b.steps.length, note) }, skill, constrainRecoveryAction(ctx, st.skill, v.args));
        } catch (e) {
          if (isAbort(e)) throw e;
          r = fail('ERROR', String((e as Error)?.message ?? e));
        }
        if (r.status === 'cancelled') return r;
        const effect = r.data?.effectEvidence as { verified?: boolean; changed?: boolean } | undefined;
        const inputOnly = r.data?.inputCompleted === true && (r.data.effectUnconfirmed ?? !(effect?.verified === true && effect.changed === true));
        if (r.data?.inputCompleted === true) inputCompleted = true;
        if (effect?.verified === true && effect.changed === true) acted = true;
        const readOnlyStep = SKILLS[st.skill]?.readOnly === true;
        // 只读成功与零边 noop 成功都保留实际返回；noop 的 zeroEdge/trace[] 语义不能被步骤层抹掉。
        if (r.status === 'succeeded' && (readOnlyStep || r.data?.noop === true)) {
          stepResults.push({ skill: st.skill, status: r.status, ...(r.data ? { data: r.data } : {}) });
          if (stepResults.length > MAX_STEP_RESULTS) stepResults.splice(0, stepResults.length - MAX_STEP_RESULTS);
        }
        if (r.status === 'succeeded' && r.data?.noop !== true && !inputOnly && !readOnlyStep) {
          completedSteps++;
          if (!OBSERVATION_ACTIONS.has(st.skill)) acted = true;
        }
        if (typeof r.data?.climbed === 'number') climbedTotal += r.data.climbed;
        done.push(`${st.skill} → ${r.status === 'succeeded' ? (inputOnly ? '输入已执行，效果未确认' : '成') : `没成(${r.failureCode ?? ''})`}`);
        // optional 移动没到新站位：记下事实，留给下一步在校验后判断。
        if (r.status === 'failed' && st.optional && STANCE_MOVES.has(st.skill)) {
          if (NAVIGATION_ACTIONS.has(st.skill)) {
            // 新导航失败时只沿用该步实际返回的末位/位置与完整回执；不在这里重读 adapter.state
            // 采样“现在”，否则之后的身体变化会把旧回执顶替成当前状态。
            const nav = r.data?.nav as { lastPosition?: unknown } | undefined;
            const original = worldPoint(r.data?.position) ?? worldPoint(nav?.lastPosition);
            pendingStance = { skill: st.skill, step: i + 1, ...(original ? { pos: original } : {}), ...(r.data ? { data: r.data } : {}) };
          } else {
            // 旧动作没有统一的导航回执：保持原有回退（当前站位）。
            pendingStance = { skill: st.skill, step: i + 1, pos: { ...ctx.adapter.state().pos } };
          }
        }
        // 非可选步骤失败：原样保留该步的结构化返回（nav/search/knownStart/history/position/
        // spatialQuery result_too_large 等），不重建时间/作用域、不压平语义、不截断事实。
        // 聚合 done/stepResults 放在展开之后，语义优先级明确。
        if (r.status === 'failed' && !st.optional) return fail(r.failureCode ?? 'ERROR', `技能「${b.name}」第 ${i + 1} 步 ${st.skill} 没成：${r.summary.slice(0, 120)}`,
          { ...(r.data ?? {}), done, ...(stepResults.length ? { stepResults } : {}) });
      }
      ctx.progress(1);
      const judged = await verifyRun(b, bridge, { before, result: { done }, args: { ...args.args, ...(args.failure ? { failure: args.failure } : {}) } }, ctx);
      if (judged) return fail('ERROR', `技能「${b.name}」的步骤都做完了，但${judged}${moved().text}`, { done, ...(stepResults.length ? { stepResults } : {}), verified: false });
      const effectUnconfirmed = inputCompleted && !acted && !b.verify;
      return ok(`照技能「${b.name}」做完了：${done.join('，')}${moved().text}`, { done, verified: !!b.verify,
        ...(stepResults.length ? { stepResults } : {}),
        ...(inputCompleted ? { inputCompleted: true, effectUnconfirmed } : {}), ...(completedSteps === 0 && !inputCompleted ? { noop: true } : {}) });
    })().catch((error: unknown) => {
      // 取消/失败也保留已累计的爬升进展：局部增量相加，共享账本只读取一次，不重复计算。
      if (climbedTotal > 0 && error && typeof error === 'object') {
        const prev = (error as { partial?: Record<string, unknown> }).partial ?? {};
        const climbed = climbedTotal + (typeof prev.climbed === 'number' ? prev.climbed : 0);
        const spent = recovery?.climb?.spent ?? climbed;
        (error as { partial?: Record<string, unknown> }).partial = { ...prev, climbed, spent };
      }
      if (isAbort(error) && ((ctx as SkillCtx & { skillDepth?: number }).skillDepth ?? 0) > 0) {
        registry?.recordInvocation?.(b.name, { status: 'cancelled', summary: '嵌套技能调用被取消', data: { version: b.version ?? 1 } });
      }
      throw error;
    });
    result.data = { ...result.data, ...climbFacts(), version: b.version ?? 1 };
    if (((ctx as SkillCtx & { skillDepth?: number }).skillDepth ?? 0) > 0) registry?.recordInvocation?.(b.name, result);
    return result;
  },
};

/**
 * 跑技能自己带的判定（verify）：做完以后看一眼世界，确认真的做成了。
 * 只能读（state/blockAt/region/entities/drops/nearestLand），最多几秒。返回 null = 判定通过（或者这份技能没写判定）；
 * 否则返回一句说明，算这次没做成——代码没抛错不等于做成了。
 */
async function verifyRun(b: { name: string; verify?: string }, bridge: SandboxHandler, input: { before: unknown; result: unknown; args: unknown },
  ctx: Pick<SkillCtx, 'signal' | 'deadline' | 'bus'>): Promise<string | null> {
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
  if (v === true || (v && typeof v === 'object' && 'ok' in v && v.ok === true)) return null;
  const why = typeof v === 'string' ? v : v && typeof v === 'object' && 'why' in v ? String(v.why) : JSON.stringify(v);
  return `判定没通过：${String(why).slice(0, 200)}`;
}

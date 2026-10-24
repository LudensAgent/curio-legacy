import type { Skill } from '../skills/types.ts';
import { fail, ok, obj } from '../skills/types.ts';
import type { MethodLibrary } from './learning.ts';
import type { ResourceKnowledge } from './knowledge.ts';
import { observationReady } from '../projects/conditions.ts';
import { throwIfAborted } from '../util.ts';
import { currentReservationOwner, reservationsFor } from '../projects/reservations.ts';

/** Model-invoked knowledge tools provide options and gaps without assigning a gameplay objective. */
export function createMethodSkills(library: MethodLibrary, knowledge: ResourceKnowledge): Skill[] {
  return [
    {
      name: 'experiment_method',
      description: '把自己的机制设想写成有界参数程序，立即在当前游戏里试验并保存实际成败；同名修订生成新版本，两种情境验收后才学会。不执行任意代码',
      argsDoc: '{"name":"<3-32位小写英文/数字/下划线>","description":"用途/设想","question"?:"我想弄清什么（最多240字）","hypothesis"?:"在什么条件下，做什么预计发生什么（待检验，最多240字）","parameters"?:{"amount":{"type":"integer","default":1,"min":1,"max":8}},"program":{"type":"sequence","steps":[{"type":"call","skill":"<底层技能>","args":{}}]},"postcondition":{"type":"inventory_gain","item":"<物品>","count":1},"arguments"?:{"amount":1}}；program可用有界if/repeat，修订沿用同名；question/hypothesis 是模型假设，postcondition 是本次可失败的事实预测',
      timeoutMs: 600_000, movement: true,
      validate(raw) {
        const input = obj(raw);
        if (typeof input.name !== 'string' || !/^[a-z][a-z0-9_]{2,31}$/.test(input.name)) return { ok: false, error: 'name 须为 3–32 位小写字母/数字/下划线' };
        if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 240) return { ok: false, error: '需要简短的试验用途/设想' };
        for (const field of ['question', 'hypothesis']) {
          if (input[field] !== undefined && (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 240)) return { ok: false, error: `${field} 须为 1–240 字符的待检验陈述` };
        }
        if (!input.program || typeof input.program !== 'object' || Array.isArray(input.program) || !input.postcondition || typeof input.postcondition !== 'object' || Array.isArray(input.postcondition)) return { ok: false, error: '试验需要有界 program 和可观测 postcondition' };
        if (input.arguments !== undefined && (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments))) return { ok: false, error: 'arguments 须为本次参数值对象' };
        return { ok: true, args: { name: input.name, description: input.description.trim(), parameters: input.parameters,
          ...(input.question !== undefined ? { question: input.question.trim() } : {}), ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis.trim() } : {}),
          program: input.program, postcondition: input.postcondition, arguments: input.arguments ?? {} } };
      },
      async run(ctx, args) {
        const { arguments: values, ...definition } = args;
        return library.experiment(definition, values, ctx);
      },
    },
    {
      name: 'query_resource', description: '查询版本匹配的物品获取方法、配方、所需设施/工具与真实背包缺口；不查找资源坐标，不自动选择方案',
      argsDoc: '{"item":"<具体物品名>","count"?:1-2304}', timeoutMs: 5000, movement: false, readOnly: true,
      validate(raw, adapter) {
        const input = obj(raw), count = input.count ?? 1;
        if (typeof input.item !== 'string' || !adapter.isKnownItem(input.item)) return { ok: false, error: '需要已注册的具体物品名' };
        if (!Number.isInteger(count) || count < 1 || count > 2304) return { ok: false, error: 'count 须为 1–2304 的整数' };
        return { ok: true, args: { item: input.item, count } };
      },
      async run(ctx, args) {
        throwIfAborted(ctx.signal);
        const state = ctx.adapter.state();
        if (!observationReady(state)) return fail('NOT_CONNECTED', '当前背包尚无有效观测，无法计算实际缺口');
        try {
          const ledger = reservationsFor(ctx.memory);
          ledger.reconcile(ctx.memory.projects());
          return ok(`获取 ${args.item} 的候选方法`, knowledge.query(args.item, args.count, state.inventory, ledger.protectedItems(state.worldId, currentReservationOwner(ctx.memory, state))));
        }
        catch (error) { return fail('UNKNOWN_ITEM', error instanceof Error ? error.message : String(error)); }
      },
    },
    {
      name: 'method_catalog', description: '不传 name 列最近方法概览；按 name/version 查看一个方法的程序、参数约束、验收条件及最近两次实际试验，供修订或复用',
      argsDoc: '{"name"?:"<方法名或 method:name/trial:name:v1>","version"?:1}；省略 version 查看该方法最新版本', timeoutMs: 5000, movement: false, readOnly: true,
      validate(raw) {
        const input = obj(raw);
        if (input.name !== undefined && typeof input.name !== 'string') return { ok: false, error: 'name 须为具体方法名' };
        const match = input.name === undefined ? null : /^(?:(?:method|trial):)?([a-z][a-z0-9_]{2,31})(?::v([1-9]\d*))?$/.exec(input.name.trim());
        if (input.name !== undefined && !match) return { ok: false, error: 'name 须为具体方法名或已注册的 method:/trial: 名称' };
        const version = input.version ?? (match?.[2] ? Number(match[2]) : undefined);
        if (version !== undefined && (!match || !Number.isSafeInteger(version) || version < 1)) return { ok: false, error: 'version 须搭配 name 且为正整数' };
        if (input.version !== undefined && match?.[2] && input.version !== Number(match[2])) return { ok: false, error: 'version 与 trial 名称中的版本不一致' };
        return { ok: true, args: { ...(match ? { name: match[1] } : {}), ...(version !== undefined ? { version } : {}) } };
      },
      async run(_ctx, args) {
        const definitions = library.list();
        const callName = (d: typeof definitions[number]) => d.status === 'retired' ? null : d.status === 'verified' ? `method:${d.name}` : `trial:${d.name}:v${d.version}`;
        if (args.name) {
          const versions = definitions.filter((d) => d.name === args.name).sort((a, b) => b.version - a.version);
          const d = args.version ? versions.find((v) => v.version === args.version) : versions[0];
          if (!d) return fail('NOT_FOUND', `找不到方法 ${args.name}${args.version ? ` v${args.version}` : ''}；先用 method_catalog {} 查看目录`);
          const trials = d.trials.slice(-2).map((t) => ({ at: t.ts, status: t.status, parameters: t.parameters, reason: t.reason,
            before: t.before, actual: t.after, expected: t.expected, beforeStatus: t.beforeStatus, afterStatus: t.afterStatus,
            executionStatus: t.executionStatus, failureCode: t.failureCode, worldId: t.worldId, dimension: t.dimension, source: t.source }));
          return ok(`${d.name} v${d.version}（${d.status}）；参数 ${Object.keys(d.parameters).join('、') || '无'}；${trials.length ? `最近试验：${trials.map((t) => `${t.status}：${t.reason}`).join('；')}` : '尚无实际试验'}。记录为历史证据，不能代替当前验收`, {
            source: 'method_catalog',
            method: { name: d.name, callName: callName(d), version: d.version, status: d.status, description: d.description,
              ...(d.question ? { question: d.question } : {}), ...(d.hypothesis ? { hypothesis: d.hypothesis } : {}), claims: 'model_hypotheses',
              parameters: d.parameters, program: d.program, postcondition: d.postcondition, trials, trialCount: d.trials.length, historical: true },
            versions: versions.slice(0, 8).map((v) => ({ version: v.version, status: v.status })),
          });
        }
        return ok('最近方法与能力缺口概览；用 method_catalog {name,version?} 查看选定方法的参数约束和试验证据', {
          source: 'method_catalog',
          methods: definitions.slice(-8).reverse().map((d) => ({ name: d.name, callName: callName(d), version: d.version, status: d.status, description: d.description.slice(0, 80) })),
          gaps: library.abilityGaps().slice(-3).map((g) => ({ id: g.id, description: g.description.slice(0, 120), missingPrimitive: g.missingPrimitive })),
          totalVersions: definitions.length,
        });
      },
    },
    {
      name: 'record_ability_gap', description: '记录当前意图遇到的能力缺口，保留原意图，供后续设计或暂缓；不宣称已掌握技能', argsDoc: '{"description":"<缺少什么能力>","missingPrimitive"?:"<底层动作>"}', timeoutMs: 5000, movement: false, readOnly: true,
      validate(raw) {
        const input = obj(raw);
        if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 300) return { ok: false, error: '需要 1–300 字符的能力缺口描述' };
        return { ok: true, args: { description: input.description.trim(), ...(typeof input.missingPrimitive === 'string' ? { missingPrimitive: input.missingPrimitive.slice(0, 100) } : {}) } };
      },
      async run(ctx, args) {
        throwIfAborted(ctx.signal);
        return ok('能力缺口已保存', { gap: library.recordGap(args.description, { intentId: ctx.memory.currentIntent()?.id, projectId: ctx.memory.activeProject()?.id, missingPrimitive: args.missingPrimitive }) });
      },
    },
  ];
}

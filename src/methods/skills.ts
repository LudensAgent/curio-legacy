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
      argsDoc: '{"name":"<3-32位小写英文/数字/下划线>","description":"用途/设想","parameters"?:{"amount":{"type":"integer","default":1,"min":1,"max":8}},"program":{"type":"sequence","steps":[{"type":"call","skill":"<底层技能>","args":{}}]},"postcondition":{"type":"inventory_gain","item":"<物品>","count":1},"arguments"?:{"amount":1}}；program可用有界if/repeat，修订沿用同名',
      timeoutMs: 600_000, movement: true,
      validate(raw) {
        const input = obj(raw);
        if (typeof input.name !== 'string' || !/^[a-z][a-z0-9_]{2,31}$/.test(input.name)) return { ok: false, error: 'name 须为 3–32 位小写字母/数字/下划线' };
        if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 240) return { ok: false, error: '需要简短的试验用途/设想' };
        if (!input.program || typeof input.program !== 'object' || Array.isArray(input.program) || !input.postcondition || typeof input.postcondition !== 'object' || Array.isArray(input.postcondition)) return { ok: false, error: '试验需要有界 program 和可观测 postcondition' };
        if (input.arguments !== undefined && (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments))) return { ok: false, error: 'arguments 须为本次参数值对象' };
        return { ok: true, args: { name: input.name, description: input.description.trim(), parameters: input.parameters,
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
      name: 'method_catalog', description: '回顾已验证方法、候选版本的试验结果，以及当前世界仍未解决的能力缺口', argsDoc: '{}', timeoutMs: 5000, movement: false, readOnly: true,
      validate: () => ({ ok: true, args: {} }),
      async run() { return ok('方法与能力缺口', { methods: library.list().slice(-20).map((d) => ({ name: d.name, version: d.version, description: d.description, status: d.status, parameters: d.parameters, trials: d.trials.slice(-3) })), gaps: library.abilityGaps().slice(-10) }); },
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

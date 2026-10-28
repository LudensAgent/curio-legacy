import { throwIfAborted } from '../util.ts';
import { fail, isAbort, obj, ok, type Skill } from './types.ts';

export const baseMemory: Skill<{ operation: 'remember' | 'select' | 'list'; label?: string; baseId?: string }> = {
  name: 'base_memory',
  description: '保留同一世界和维度的多个命名基地。remember 只记录当前实际观测位置并设为该维度首选；select 只切换已有可信基地，不移动或刷新其最近确认时间；list 查看全部基地与首选。不能提交任意坐标来虚构地点。',
  argsDoc: '{"operation":"remember|select|list","label"?:"当前基地名称","baseId"?:"已有基地 ID"}',
  timeoutMs: 5000, movement: false, readOnly: true,
  validate(raw) {
    const input = obj(raw);
    if (!['remember', 'select', 'list'].includes(input.operation)) return { ok: false, error: 'operation 支持 remember/select/list' };
    if (input.label !== undefined && (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 100)) return { ok: false, error: 'label 需要 1–100 字符' };
    if (['pos', 'position', 'origin', 'dimension', 'worldId', 'x', 'y', 'z'].some((key) => key in input)) return { ok: false, error: '基地只能从当前实际观测位置记录；不可指定坐标或维度' };
    if (input.operation === 'remember' && (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 100)) return { ok: false, error: 'remember 需要 1–100 字符 label' };
    if (input.operation === 'select' && (typeof input.baseId !== 'string' || !input.baseId || input.baseId.length > 150)) return { ok: false, error: 'select 需要已有 baseId' };
    return { ok: true, args: { operation: input.operation, label: input.label?.trim(), baseId: input.baseId } };
  },
  async run(ctx, args) {
    try {
      throwIfAborted(ctx.signal);
      const state = ctx.adapter.state();
      if (args.operation === 'list') return ok('当前世界的多个基地（历史确认时间不会因查看而刷新）', { worldId: ctx.memory.worldId, bases: ctx.memory.bases(), currentDimension: state.dim, primary: ctx.memory.base(state.dim)?.id ?? null });
      if (!state.connected || !state.alive || !state.observationReady || state.worldId !== ctx.memory.worldId) return fail('NOT_CONNECTED', '需要当前世界有效的实际位置观测');
      if (args.operation === 'select') {
        if (!ctx.memory.bases().some((base) => base.id === args.baseId)) return fail('NOT_FOUND', '没有当前世界中可信的该基地');
        return ok('已切换首选基地；其实际确认时间保持原值', { base: ctx.memory.selectBase(args.baseId!) });
      }
      return ok('已根据当前观测保存命名基地', { base: ctx.memory.setBase(state.dim, state.pos, args.label, { select: true }), source: 'adapter.state.pos', sessionId: state.sessionId, observationId: state.observationId });
    } catch (error) { if (isAbort(error)) throw error; return fail('ERROR', (error as Error).message); }
  },
};
export const baseSkills: Skill[] = [baseMemory];

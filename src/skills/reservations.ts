import type { InvItem } from '../adapter/types.ts';
import { currentReservationOwner, reservationsFor, type ReservationOwner } from '../projects/reservations.ts';
import { throwIfAborted } from '../util.ts';
import { fail, isAbort, obj, ok, type Skill } from './types.ts';

export const materialReservations: Skill<{ operation: 'reserve' | 'release' | 'query'; projectId?: string; revision?: number; items?: InvItem[]; names?: string[] }> = {
  name: 'material_reservations',
  description: '为现有项目的当前修订预留实际背包物资，或查询/释放预留。reserve 设置该所有者的整份清单，不能预留尚未拿到的掉落或箱子传闻。暂缓项目保留预留，旧修订和完成/取消项目自动释放；查询明确区分实际数量、其他项目预留和损失后的缺口。',
  argsDoc: '{"operation":"reserve|release|query","projectId"?:"现有项目 ID，默认当前项目","revision"?:1,"items"?:[{"name":"cobblestone","count":16}],"names"?:["cobblestone"]}',
  timeoutMs: 5000, movement: false, readOnly: true,
  validate(raw, adapter) {
    const input = obj(raw);
    if (!['reserve', 'release', 'query'].includes(input.operation)) return { ok: false, error: 'operation 支持 reserve/release/query' };
    if (input.projectId !== undefined && (typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 100)) return { ok: false, error: 'projectId 无效' };
    if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision < 1)) return { ok: false, error: 'revision 必须为正整数' };
    if (input.operation === 'reserve' && (!Array.isArray(input.items) || !input.items.length || input.items.length > 32 || input.items.some((i: any) => !i || typeof i.name !== 'string' || !adapter.isKnownItem(i.name) || !Number.isInteger(i.count) || i.count < 1 || i.count > 2304) || new Set(input.items.map((i: any) => i.name)).size !== input.items.length)) return { ok: false, error: 'items 需要 1–32 种具体物品，每种 1–2304 个且名称不重复' };
    if (input.names !== undefined && (!Array.isArray(input.names) || input.names.length > 32 || input.names.some((name: unknown) => typeof name !== 'string' || !adapter.isKnownItem(name)))) return { ok: false, error: 'names 需要具体物品名称列表' };
    return { ok: true, args: { operation: input.operation, projectId: input.projectId, revision: input.revision, items: input.items?.map((i: InvItem) => ({ name: i.name, count: i.count })), names: input.names } };
  },
  async run(ctx, args) {
    try {
      throwIfAborted(ctx.signal);
      const state = ctx.adapter.state(), ledger = reservationsFor(ctx.memory), projects = ctx.memory.projects();
      if (!state.connected || !state.alive || !state.observationReady) return fail('NOT_CONNECTED', '当前背包尚无可靠观测');
      ledger.reconcile(projects);
      let owner: ReservationOwner | undefined = currentReservationOwner(ctx.memory, state);
      if (args.projectId) {
        const project = projects.find((p) => p.id === args.projectId && p.worldId === state.worldId && !['completed', 'cancelled'].includes(p.status));
        if (!project || args.revision !== undefined && project.revision !== args.revision) return fail('BAD_ARGS', '项目或修订已经失效');
        owner = { worldId: state.worldId, projectId: project.id, revision: project.revision };
      } else if (args.revision !== undefined && owner?.revision !== args.revision) return fail('BAD_ARGS', '当前项目修订已经失效');
      if (args.operation !== 'query' && !owner) return fail('BAD_ARGS', '预留和释放需要现有项目所有者');
      if (args.operation === 'reserve') return ok('已根据实际背包保存物资预留', { reservation: ledger.reserve(owner!, args.items!, state, projects), availability: ledger.query(state, owner) });
      if (args.operation === 'release') return ok('已释放指定的物资预留', { releasedItems: ledger.release(owner!, args.names), availability: ledger.query(state, owner) });
      return ok('实际背包与项目物资预留', { owner: owner ?? null, reservations: ledger.list(state.worldId), availability: ledger.query(state, owner), source: 'adapter.state.inventory', chestInventoryIncluded: false });
    } catch (error) { if (isAbort(error)) throw error; return fail('MISSING_MATERIALS', (error as Error).message); }
  },
};

export const reservationSkills: Skill[] = [materialReservations];

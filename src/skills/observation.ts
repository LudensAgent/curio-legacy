import type { Vec3Like } from '../adapter/types.ts';
import { fail, obj, ok, type Skill, type SkillCtx } from './types.ts';

/** Looking at state is distinct from using or breaking the target. */
/** 转头看向一格（像人一样：要看身后的东西得先回头）。只转头，不走动 */
export async function glanceAt(ctx: SkillCtx, pos: Vec3Like) {
  const eye = ctx.adapter.eye();
  if (!eye) return;
  const dx = pos.x + 0.5 - eye.x, dy = pos.y + 0.5 - eye.y, dz = pos.z + 0.5 - eye.z;
  if (Math.hypot(dx, dy, dz) > 48) return;
  try { await ctx.adapter.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), ctx.signal); }
  catch (e) { if ((e as Error)?.name === 'AbortedError') throw e; }
  ctx.senses.refresh();
}

export const inspectBlock: Skill<{ target: string | Vec3Like }> = {
  name: 'inspect_block',
  description: '只读查看当前视野内指定方块的实际名称和属性（如门的 open、作物 age）；遮挡或视野外返回未知',
  argsDoc: '{"target":"<方块名>" | {"x":整数,"y":整数,"z":整数}}',
  timeoutMs: 3000,
  movement: false,
  readOnly: true,
  validate(raw) {
    const target = obj(raw).target;
    if (typeof target === 'string' && /^[a-z0-9_]{1,80}$/.test(target)) return { ok: true, args: { target } };
    if (target && typeof target === 'object' && [target.x, target.y, target.z].every((n) => Number.isInteger(n) && Math.abs(n) <= 29_999_984) && Math.abs(target.y) <= 2048) {
      return { ok: true, args: { target: { x: target.x, y: target.y, z: target.z } } };
    }
    return { ok: false, error: 'target 需要方块注册名或观测到的整数坐标' };
  },
  async run(ctx, args) {
    if (!ctx.senses.observeBlocks) return fail('NOT_FOUND', '当前感官没有提供可见方块状态，不能凭坐标读取');
    ctx.senses.refresh();
    const positions = typeof args.target === 'string'
      ? ctx.senses.knownBlocks([args.target, ...ctx.adapter.resolveBlockNames(args.target)], 32).slice(0, 16).map((b) => b.pos)
      : [args.target];
    let observed = ctx.senses.observeBlocks(positions)[0];
    // 不在视野里（在身后、头顶、脚下）：先转头看过去再说，不要直接说看不见
    if (!observed && positions[0]) { await glanceAt(ctx, positions[0]); observed = ctx.senses.observeBlocks(positions)[0]; }
    if (!observed) return fail('NOT_FOUND', '转头看过去也没看见：被挡住、太暗、太远或区块没加载；状态仍未知（空气格本身看不见，只能看到它周围）');
    return ok(`看见 ${observed.name} 在 ${observed.pos.x},${observed.pos.y},${observed.pos.z}，属性 ${JSON.stringify(observed.properties)}`,
      { target: observed.name, pos: observed.pos, actual: observed, effectEvidence: { verified: true, changed: false, reasons: ['只读视觉观测'] } });
  },
};

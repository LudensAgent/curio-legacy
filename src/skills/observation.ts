import type { Vec3Like } from '../adapter/types.ts';
import { fail, obj, ok, type Skill } from './types.ts';

/** Looking at state is distinct from using or breaking the target. */
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
    const observed = ctx.senses.observeBlocks(positions)[0];
    if (!observed) return fail('NOT_FOUND', '目标当前不可见或未加载；请靠近或转头观察，状态仍未知');
    return ok(`看见 ${observed.name} 在 ${observed.pos.x},${observed.pos.y},${observed.pos.z}，属性 ${JSON.stringify(observed.properties)}`,
      { target: observed.name, pos: observed.pos, actual: observed, effectEvidence: { verified: true, changed: false, reasons: ['只读视觉观测'] } });
  },
};

import { sleep } from '../util.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

export const equipArmor: Skill<{}> = {
  name: 'equip_armor', description: '装备当前持有的最好材质护甲及盾牌，并核对真实装备栏；不会凭背包中有护甲就当作已穿戴。', argsDoc: '{}', timeoutMs: 30000, movement: false,
  validate: () => ({ ok: true, args: {} }),
  async run(ctx) {
    if (!ctx.adapter.equipItem) return fail('ERROR', '适配器没有装备接口');
    const state = ctx.adapter.state();
    const materials = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];
    const slots = [['head', 'helmet'], ['torso', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']] as const;
    const changed: string[] = [];
    for (const [slot, suffix] of slots) {
      const equipped = state.equipment?.find((e) => e.slot === slot)?.name;
      const selected = materials.map((m) => `${m}_${suffix}`).find((name) => equipped === name || state.inventory.some((i) => i.name === name && i.count > 0));
      if (!selected || selected === equipped) continue;
      const result = await ctx.adapter.equipItem(selected, slot, ctx.signal);
      if (!result.ok) return fail('ERROR', `装备 ${selected} 失败：${result.reason}`);
      changed.push(selected);
    }
    if (state.inventory.some((i) => i.name === 'shield' && i.count > 0)) {
      const result = await ctx.adapter.equipItem('shield', 'off-hand', ctx.signal);
      if (!result.ok) return fail('ERROR', `装备盾牌失败：${result.reason}`);
      changed.push('shield');
    }
    const actual = ctx.adapter.state().equipment ?? [];
    if (changed.some((name) => !actual.some((item) => item.name === name))) return fail('ERROR', '装备栏未确认此次装备变更');
    return ok(changed.length ? `已装备并核对：${changed.join('、')}` : '当前没有可升级的护甲', { equipment: actual });
  },
};

export const rangedDefend: Skill<{ entityId?: number; shots: number }> = {
  name: 'ranged_defend', description: '用弓在本地瞄准可感知目标并射击，距离过近时拉开；只报告真实发射和目标是否仍可感知，不能据此伪称 Boss 已击败。', argsDoc: '{"entityId"?:number,"shots"?:1-16}', timeoutMs: 45000, movement: true,
  validate(raw) {
    const value = obj(raw);
    if (value.entityId !== undefined && (!Number.isInteger(value.entityId) || value.entityId < 0)) return { ok: false, error: 'entityId 必须是非负整数' };
    const shots = value.shots ?? 4;
    if (!Number.isInteger(shots) || shots < 1 || shots > 16) return { ok: false, error: 'shots 必须为 1-16' };
    return { ok: true, args: { entityId: value.entityId, shots } };
  },
  async run(ctx, args) {
    if (!ctx.adapter.rangedAttack) return fail('ERROR', '适配器没有远程武器能力');
    let shots = 0;
    try {
      for (; shots < args.shots;) {
        ctx.senses.refresh();
        const target = ctx.senses.perceivedEntities(48).find((entity) => args.entityId === undefined ? entity.kind === 'hostile' : entity.id === args.entityId);
        if (!target) return shots ? ok(`已射击 ${shots} 次，目标不再可感知，不能确认击败`, { shots, defeatVerified: false }) : fail('NOT_FOUND', '没有可感知的射击目标');
        if (ctx.adapter.state().hp <= 6) return fail('LOW_HP', '生命过低，停止射击并请求撤离');
        if (target.dist < 5) await ctx.adapter.moveTo({ kind: 'away_from', pos: target.pos, distance: 10 }, { signal: ctx.signal, timeoutMs: 5000 });
        const result = await ctx.adapter.rangedAttack(target.id, ctx.signal);
        if (!result.ok) return fail(result.reason === 'NO_BOW_OR_ARROWS' ? 'MISSING_MATERIALS' : 'ERROR', `射击失败：${result.reason}`, { shots });
        shots++;
        ctx.progress(shots / args.shots, `已射击 ${shots} 次`);
        await sleep(250, ctx.signal);
      }
      return ok(`完成 ${shots} 次实际射击`, { shots, defeatVerified: false });
    } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `射击中断：${(error as Error).message}`, { shots }); }
  },
};

export const equipmentSkills = { equip_armor: equipArmor, ranged_defend: rangedDefend };

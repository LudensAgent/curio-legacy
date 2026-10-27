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

/**
 * 举盾：通用的身体动作（右键按住副手的盾），什么时候举、举多久、边挡边做什么由心智和它自己学的技能决定。
 * 报告实际效果：期间掉了多少血、盾挡下了几下（盾耐久少了多少）——挡没挡住要看结果，不是举了就算挡了。
 */
export const guard: Skill<{ seconds: number; target?: string; back?: boolean }> = {
  name: 'guard',
  description: '举起副手的盾挡一会儿：面朝目标（不写就朝最近的敌对生物），挡正面的近战和箭；举着时走得慢、不能攻击，可以边挡边后退',
  argsDoc: '{"seconds"?:1-6, "target"?:"<生物名>", "back"?:true（边挡边慢慢后退）}',
  timeoutMs: 12000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const seconds = Number(a.seconds ?? 2);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 6) return { ok: false, error: 'seconds 是 1-6' };
    const target = typeof a.target === 'string' && a.target.trim() ? a.target.trim() : undefined;
    return { ok: true, args: { seconds, ...(target ? { target } : {}), ...(a.back === true ? { back: true } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    if (!adapter.raiseShield) return fail('ERROR', '适配器不支持举盾');
    const shieldDur = () => adapter.state().equipment?.find((e) => e.slot === 'off-hand' && e.name === 'shield')?.durabilityRemaining;
    if (adapter.combatState?.().offHand !== 'shield') {
      if (!adapter.state().inventory.some((i) => i.name === 'shield' && i.count > 0) || !adapter.equipItem) return fail('MISSING_MATERIALS', '副手没有盾，背包里也没有（盾 = 6 木板 + 1 铁锭）');
      const r = await adapter.equipItem('shield', 'off-hand', signal);
      if (!r.ok) return fail('ERROR', `把盾换到副手没成：${r.reason}`);
    }
    const hp0 = adapter.state().hp, dur0 = shieldDur();
    const end = Date.now() + args.seconds * 1000;
    let faced = '';
    try {
      const up = await adapter.raiseShield(true, signal);
      if (!up.ok) return fail('ERROR', `举盾没成：${up.reason}`);
      while (Date.now() < end) {
        senses.refresh();
        const foe = senses.perceivedEntities(16).filter((e) => args.target ? e.name === args.target : e.kind === 'hostile').sort((a, b) => a.dist - b.dist)[0];
        if (foe) faced = `${foe.name} ${Math.round(foe.dist)} 格`;
        if (adapter.drive) await adapter.drive(args.back ? { back: true } : {}, Math.min(500, end - Date.now()), signal, foe ? { faceEntity: foe.id } : {});
        else await sleep(Math.min(500, end - Date.now()), signal);
      }
    } catch (e) {
      if (isAbort(e)) { try { await adapter.raiseShield(false, AbortSignal.timeout(1000)); } catch { /* ignore */ } throw e; }
      return fail(codeFromError(e), `举盾时出错：${(e as Error).message}`);
    } finally {
      try { await adapter.raiseShield(false, AbortSignal.timeout(1000)); } catch { /* ignore */ }
    }
    const lost = Math.max(0, Math.round((hp0 - adapter.state().hp) * 10) / 10), dur1 = shieldDur();
    const blocked = dur0 !== undefined && dur1 !== undefined ? Math.max(0, dur0 - dur1) : 0;
    return ok(`举盾 ${args.seconds} 秒${faced ? `（对着 ${faced}）` : '（附近没看见敌对生物）'}：${blocked ? `盾挡下了攻击（盾耐久 -${blocked}）` : '盾没挡到东西'}，${lost ? `掉了 ${lost} 点血` : '没掉血'}`,
      { blocked, hpLost: lost, ...(dur1 !== undefined ? { shieldLeft: dur1 } : {}) });
  },
};

export const equipmentSkills = { equip_armor: equipArmor, ranged_defend: rangedDefend, guard };

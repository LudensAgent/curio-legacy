import { dist3, sleep } from '../util.ts';
import { equipArmor } from './equipment.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

type DragonStage = 'prepare' | 'observe' | 'crystals' | 'flying' | 'perched' | 'feed' | 'defend' | 'withdraw' | 'verify';

/** Local phase execution; a missing entity is never evidence of defeating it. */
export const dragonFight: Skill<{ seconds: number; endermanMask?: boolean }> = {
  name: 'dragon_fight',
  description: '末地本地战斗控制：穿甲、补给、优先射击看见的末影水晶，按真实阶段在飞行射击与栖息躯干近战间切换；躯干伤害较低，不冒充龙头命中。低血撤离，只有真实死亡证据能验收击败。',
  argsDoc: '{"seconds"?:10-300,"endermanMask"?:boolean}', timeoutMs: 310000, movement: true,
  validate(raw) {
    const value = obj(raw), seconds = value.seconds ?? 120;
    return Number.isInteger(seconds) && seconds >= 10 && seconds <= 300 && (value.endermanMask === undefined || typeof value.endermanMask === 'boolean') ? { ok: true, args: { seconds, endermanMask: value.endermanMask } } : { ok: false, error: 'seconds 必须为 10-300，endermanMask 必须为布尔值' };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const start = adapter.state();
    if (start.dim !== 'the_end') return fail('WRONG_DIMENSION', '末影龙战斗必须在末地进行');
    if (!adapter.rangedAttack || !adapter.bossStatus) return fail('ERROR', '适配器缺少远程射击或 Boss 死亡观察能力');
    const startedAt = Date.now();
    const end = Math.min(ctx.deadline, startedAt + args.seconds * 1000);
    let stage: DragonStage = 'prepare';
    const stages: { stage: DragonStage; at: number }[] = [];
    const change = (next: DragonStage) => {
      if (stages.length && stage === next) return;
      stage = next;
      stages.push({ stage, at: Date.now() });
      ctx.progress(Math.min(0.95, (Date.now() - startedAt) / Math.max(1, end - startedAt)), `末影龙阶段：${next}`);
      ctx.bus.publish('boss_phase', 'P2', `末影龙本地控制 → ${next}`);
    };
    change('prepare');
    const equipped = await equipArmor.run(ctx, { head: args.endermanMask ? 'carved_pumpkin' : 'best' });
    if (equipped.status === 'failed') return equipped;
    const inventory = adapter.state().inventory;
    if (!inventory.some((i) => i.name === 'bow' && i.count > 0) || !inventory.some((i) => /^(arrow|spectral_arrow|tipped_arrow)$/.test(i.name) && i.count > 0)) return fail('MISSING_MATERIALS', '战斗需要弓与箭来处理水晶和飞行阶段');
    let shots = 0;
    let bodyMeleeAttempts = 0;
    let sweeps = 0;
    let crystalApproaches = 0;
    let lastHazard = { ...start.pos };
    const observedDragons = new Set<number>();
    try {
      while (Date.now() < end) {
        const state = adapter.state();
        if (!state.observationReady || state.worldId !== start.worldId || state.dim !== start.dim || state.sessionId !== start.sessionId) return fail('WRONG_DIMENSION', '战斗观察会话已改变，不能沿用旧战场');
        const death = adapter.bossStatus().dragonDeath;
        if (death && death.observedAt >= startedAt && death.worldId === start.worldId && death.dim === start.dim && death.sessionId === start.sessionId && observedDragons.has(death.entityId)) {
          change('verify');
          ctx.memory.addLandmark('discovery', '已观察到末影龙死亡', state.dim, death.pos, 4);
          return ok('已确认末影龙死亡', { defeatVerified: true, death, shots, bodyMeleeAttempts, stages });
        }
        senses.refresh();
        const entities = senses.perceivedEntities(96);
        const dragon = entities.find((e) => e.name === 'ender_dragon' && e.perception !== 'heard');
        if (dragon) observedDragons.add(dragon.id);
        const breath = entities.find((e) => e.name === 'area_effect_cloud' && e.dist < 6);
        const attacker = entities.find((e) => e.name !== 'ender_dragon' && e.kind === 'hostile' && e.perception !== 'heard' && e.dist < 6);
        if (breath || attacker || dragon) lastHazard = { ...(breath ?? attacker ?? dragon)!.pos };
        if (state.hp <= 6 || state.inLava || breath) {
          change('withdraw');
          // Low health still needs an actual retreat when the dragon has flown
          // outside the current FOV. Use the last observed hazard, then fall
          // back to the observed entry position if no threat was ever seen.
          try {
            if (dist3(state.pos, lastHazard) > 0.1 || attacker || dragon || breath) await adapter.moveTo({ kind: 'away_from', pos: lastHazard, distance: 20 }, { sprint: true, signal, timeoutMs: Math.max(1, Math.min(6000, end - Date.now())) });
            else await adapter.moveTo({ kind: 'near', pos: start.pos, range: 1 }, { signal, timeoutMs: Math.max(1, Math.min(4000, end - Date.now())) });
          } catch (error) { if (isAbort(error)) throw error; }
          if (adapter.hasFood() && state.food < 20) await adapter.eat(signal);
          if (state.hp <= 6) return fail('LOW_HP', '战斗中低血撤离，未宣称击败末影龙', { shots, bodyMeleeAttempts, stages });
          await sleep(500, signal);
          continue;
        }
        if ((state.food <= 18 || state.hp < 16 && state.food < 20) && adapter.hasFood()) {
          change('feed');
          if (dragon && dragon.dist < 12) await adapter.moveTo({ kind: 'away_from', pos: dragon.pos, distance: 14 }, { sprint: true, signal, timeoutMs: 6000 });
          await adapter.eat(signal);
          continue;
        }
        if (attacker && attacker.dist <= 3.5) {
          change('defend');
          await adapter.equipWeapon(signal);
          await adapter.attack(attacker.id, signal);
          await sleep(650, signal);
          continue;
        }
        const crystal = entities.find((e) => e.name === 'end_crystal' && e.perception !== 'heard');
        if (crystal) {
          change('crystals');
          lastHazard = { ...crystal.pos };
          if (crystal.dist < 12) await adapter.moveTo({ kind: 'away_from', pos: crystal.pos, distance: 14 }, { sprint: true, signal, timeoutMs: 8000 });
          if (crystal.dist > 48) {
            const dx = state.pos.x - crystal.pos.x, dz = state.pos.z - crystal.pos.z;
            const distance = Math.hypot(dx, dz) || 1;
            await adapter.moveTo({ kind: 'xz', x: crystal.pos.x + dx / distance * 14, z: crystal.pos.z + dz / distance * 14, range: 3 }, { signal, timeoutMs: 10000 });
          }
          const result = await adapter.rangedAttack(crystal.id, signal);
          if (!result.ok && result.reason === 'BLOCKED_AIM') {
            // A caged crystal needs a real arrow path through an observed gap.
            // Try bounded ground-level angles; never repeatedly fire at bars.
            const angle = Math.atan2(state.pos.z - crystal.pos.z, state.pos.x - crystal.pos.x) + Math.PI / 4;
            if (++crystalApproaches > 8) return fail('PATH_NOT_FOUND', '水晶周围没有确认可用的射击通道，需要另选开笼或登高方法', { shots, bodyMeleeAttempts, stages });
            await adapter.moveTo({ kind: 'xz', x: crystal.pos.x + Math.cos(angle) * 16, z: crystal.pos.z + Math.sin(angle) * 16, range: 1 }, { signal, timeoutMs: Math.max(1, Math.min(8000, end - Date.now())) });
            await sleep(150, signal);
            continue;
          }
          if (!result.ok) return fail(result.reason === 'NO_BOW_OR_ARROWS' ? 'MISSING_MATERIALS' : 'ERROR', `处理水晶失败：${result.reason}`, { shots, bodyMeleeAttempts, stages });
          shots++;
          await sleep(350, signal);
          continue;
        }
        if (!dragon) {
          change('observe');
          const eye = adapter.eye();
          await adapter.look((eye?.yaw ?? 0) + Math.PI / 4, sweeps++ % 2 ? 0.35 : 0.05);
          await sleep(300, signal);
          continue;
        }
        if (dragon.phase === 9 || dragon.hp === 0) {
          change('verify');
          await sleep(300, signal);
          continue;
        }
        if ([5, 6, 7].includes(dragon.phase ?? -1)) {
          change('perched');
          if (dragon.phase === 5 && dragon.dist < 10) {
            change('withdraw');
            await adapter.moveTo({ kind: 'away_from', pos: dragon.pos, distance: 12 }, { sprint: true, signal, timeoutMs: 6000 });
          } else {
            await adapter.equipWeapon();
            if (dragon.dist > 3) await adapter.moveTo({ kind: 'near', pos: dragon.pos, range: 2.5 }, { signal, timeoutMs: 8000 });
            senses.refresh();
            const current = senses.perceivedEntities(12).find((e) => e.id === dragon.id && e.perception !== 'heard');
            if (current && [6, 7].includes(current.phase ?? -1) && dist3(adapter.state().pos, current.pos) <= 4 && await adapter.attack(current.id)) bodyMeleeAttempts++;
          }
        } else {
          change('flying');
          if (dragon.dist <= 48) {
            const result = await adapter.rangedAttack(dragon.id, signal);
            if (!result.ok && result.reason === 'NO_BOW_OR_ARROWS') return fail('MISSING_MATERIALS', '弓箭耗尽，需要补给或调整方法', { shots, bodyMeleeAttempts, stages });
            if (result.ok) shots++;
          } else {
            const eye = adapter.eye();
            await adapter.look(eye?.yaw ?? 0, 0.35);
          }
        }
        await sleep(600, signal);
      }
      return fail('TIMEOUT', '战斗时限内没有观察到末影龙死亡；目标消失不能作为胜利证据', { defeatVerified: false, shots, bodyMeleeAttempts, stages });
    } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `末影龙战斗中断：${(error as Error).message}`, { defeatVerified: false, shots, bodyMeleeAttempts, stages }); }
  },
};

export const dragonSkills = { dragon_fight: dragonFight };

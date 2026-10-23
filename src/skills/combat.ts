import { sleep } from '../util.ts';
import { clampInt, fail, isAbort, obj, ok, type Skill } from './types.ts';

// ------------------------------------------------------------------ flee
export const flee: Skill<{ distance: number }> = {
  name: 'flee',
  description: '远离附近的敌对生物，或撤离岩浆等环境危险',
  argsDoc: '{"distance"?: 8-32}',
  timeoutMs: 15000,
  movement: true,
  validate(raw) {
    return { ok: true, args: { distance: clampInt(obj(raw).distance, 8, 32, 18) } };
  },
  async run(ctx, args) {
    const hostiles = ctx.senses.perceivedEntities(16).filter((e) => e.kind === 'hostile');
    const state = ctx.adapter.state();
    if (!hostiles.length && state.inLava) {
      const land = ctx.senses.nearestLand?.(state.pos);
      try {
        if (land) await ctx.adapter.moveTo({ kind: 'near', pos: { ...land.pos, y: land.pos.y + 1 }, range: 1 }, { signal: ctx.signal, timeoutMs: Math.max(1000, ctx.deadline - Date.now()) });
        else {
          // With no remembered shore, actively try to climb out and move away
          // from the hazard origin. Returning success here would strand the bot.
          await ctx.adapter.jump(500, ctx.signal);
          await ctx.adapter.moveTo({ kind: 'xz', x: state.pos.x + args.distance, z: state.pos.z, range: 1 }, { signal: ctx.signal, timeoutMs: Math.max(1000, ctx.deadline - Date.now()) });
        }
      } catch (e) { if (isAbort(e)) throw e; }
      return ctx.adapter.state().inLava ? fail('STUCK', '仍在岩浆中，未能脱离环境危险') : ok('已撤离岩浆');
    }
    if (!hostiles.length) return ok('附近没有威胁');
    const c = hostiles.reduce((a, e) => ({ x: a.x + e.pos.x / hostiles.length, y: a.y + e.pos.y / hostiles.length, z: a.z + e.pos.z / hostiles.length }), { x: 0, y: 0, z: 0 });
    try {
      await ctx.adapter.moveTo({ kind: 'away_from', pos: c, distance: args.distance }, { signal: ctx.signal, timeoutMs: Math.max(3000, ctx.deadline - Date.now()) });
    } catch (e) {
      if (isAbort(e)) throw e;
    }
    ctx.senses.refresh();
    if (ctx.adapter.state().inLava) return fail('STUCK', '仍在岩浆中，环境危险尚未解除');
    const left = ctx.senses.perceivedEntities(10).filter((e) => e.kind === 'hostile').length;
    return ok(left ? `撤离中，附近仍有 ${left} 个敌对生物` : `已远离 ${hostiles.map((h) => h.name).join('、')}`);
  },
};

// ------------------------------------------------------------------ defend
export const defend: Skill<{ entityId?: number }> = {
  name: 'defend',
  description: '装备最好的武器并攻击最近的敌对生物（苦力怕除外）',
  argsDoc: '{}',
  timeoutMs: 20000,
  movement: true,
  validate(raw) {
    const id = Number(obj(raw).entityId);
    return { ok: true, args: Number.isFinite(id) ? { entityId: id } : {} };
  },
  async run(ctx, args) {
    const { adapter, signal, senses } = ctx;
    const pick = () =>
      senses
        .perceivedEntities(12)
        .find((e) => e.kind === 'hostile' && e.name !== 'creeper' && (args.entityId === undefined || e.id === args.entityId));
    let target = pick();
    if (!target) return ok('附近没有可攻击的目标');
    const name = target.name;
    await adapter.equipWeapon();
    let hits = 0;
    while (Date.now() < ctx.deadline) {
      if (adapter.state().hp <= 6) return fail('LOW_HP', `与 ${name} 战斗时生命过低`);
      senses.refresh();
      target = senses.perceivedEntities(16).find((e) => e.id === (args.entityId ?? target!.id));
      if (!target) return ok(`${name} 已被击退或消失（攻击 ${hits} 次）`);
      if (target.dist > 3) {
        try {
          await adapter.moveTo({ kind: 'follow_entity', entityId: target.id, range: 2 }, { signal, timeoutMs: 3000 });
        } catch (e) {
          if (isAbort(e)) throw e;
        }
        continue;
      }
      if (await adapter.attack(target.id)) hits++;
      await sleep(650, signal);
    }
    return ok(`与 ${name} 交战结束（攻击 ${hits} 次）`);
  },
};

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
export const defend: Skill<{ entityId?: number; target?: string; stay?: boolean }> = {
  name: 'defend',
  description: '装备最好的武器去打附近的敌对生物：不写 target 打最近的（不含苦力怕）；target 写生物名专打那一种（苦力怕要明写 "creeper"，身体会砍一下退一步、嘶嘶响就躲）；退无可退 "stay":true 硬打',
  argsDoc: '{"target"?: "creeper|zombie|skeleton|spider|<敌对生物名>", "entityId"?: 数字}',
  timeoutMs: 20000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const id = Number(a.entityId);
    const target = typeof a.target === 'string' && a.target.trim() ? a.target.trim().toLowerCase().replace(/^minecraft:/, '') : undefined;
    return { ok: true, args: { ...(Number.isFinite(id) ? { entityId: id } : {}), ...(target ? { target } : {}), ...(a.stay === true ? { stay: true } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, signal, senses } = ctx;
    const pick = () =>
      senses
        .perceivedEntities(16)
        .find((e) => e.kind === 'hostile' && (args.target ? e.name === args.target : args.entityId !== undefined || e.name !== 'creeper') && (args.entityId === undefined || e.id === args.entityId));
    let target = pick();
    if (!target) return args.target ? fail('NOT_FOUND', `附近 16 格内没看见 ${args.target}`) : ok('附近没有可攻击的目标');
    const name = target.name;
    await adapter.equipWeapon();
    let hits = 0;
    while (Date.now() < ctx.deadline) {
      if (!args.stay && adapter.state().hp <= 6) {
        // 不替它决定跑还是打：把局面说清楚（谁贴着、血多少），下一步它自己选
        const near = senses.perceivedEntities(8).filter((e) => e.kind === 'hostile').map((e) => `${e.name} ${Math.round(e.dist * 10) / 10}格`);
        return fail('LOW_HP', `血只剩 ${Math.round(adapter.state().hp * 10) / 10}，停手了（打了 ${hits} 下）；身边：${near.join('、') || '没看见怪'}。要跑就 flee；退无可退、跑只会被追着打就 defend {"stay":true} 硬打`);
      }
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
      // 打苦力怕：砍一下就往后退一步，别贴着它让它炸
      if (target.name === 'creeper') {
        const me = adapter.state().pos, dx = me.x - target.pos.x, dz = me.z - target.pos.z, d = Math.hypot(dx, dz) || 1;
        await adapter.moveTo({ kind: 'xz', x: me.x + dx / d * 3, z: me.z + dz / d * 3, range: 1 }, { signal, timeoutMs: 900 }).catch((e) => { if (isAbort(e)) throw e; });
      }
      await sleep(650, signal);
    }
    return ok(`与 ${name} 交战结束（攻击 ${hits} 次）`);
  },
};

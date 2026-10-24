import { raceAbort, sleep, throwIfAborted, TimeoutError } from '../util.ts';
import { surface } from './movement.ts';
import { clampInt, fail, obj, ok, type Skill } from './types.ts';

/** 原地等一会儿：像人一样站着、偶尔慢慢转头看看；受伤或掉进水里就提前结束 */
export const wait: Skill<{ seconds: number; look: boolean }> = {
  name: 'wait',
  description: '原地等一会儿（等天亮/等作物/等怪离开），会慢慢看看四周；受伤或落水会提前停',
  argsDoc: '{"seconds"?:2-60}',
  timeoutMs: 65000,
  movement: false,
  validate(raw) {
    const a = obj(raw);
    return { ok: true, args: { seconds: clampInt(a.seconds ?? a.s, 2, 60, 10), look: !(a.look === false || a.look === 'false') } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    // 在水里原地等会淹死：像人一样先游上岸、站稳，再在岸上等
    let landed = '';
    if (adapter.state().inWater && !adapter.state().riding) {
      const v = surface.validate({}, adapter);
      const r = v.ok ? await surface.run({ ...ctx, deadline: Math.min(ctx.deadline, Date.now() + 30_000) }, v.args) : null;
      if (!r || r.status !== 'succeeded' || adapter.state().inWater) return fail('ERROR', `在水里不能原地等（会淹死），想先上岸但没成功${r ? `：${r.summary}` : ''}`);
      landed = '先游上了岸，';
    }
    const s0 = adapter.state();
    const t0 = Date.now();
    const end = Math.min(t0 + args.seconds * 1000, ctx.deadline - 1000);
    const yaw0 = adapter.eye()?.yaw ?? 0;
    let k = 0;
    while (Date.now() < end) {
      await sleep(Math.min(2000, Math.max(1, end - Date.now())), signal);
      const s = adapter.state();
      if (s.hp <= s0.hp - 2) return ok(`等了 ${Math.round((Date.now() - t0) / 1000)} 秒，受到伤害（生命 ${Math.round(s.hp)}），提前停下`, { interrupted: 'hurt' });
      if (s.inWater && !s0.inWater && !s.riding) return ok(`等了 ${Math.round((Date.now() - t0) / 1000)} 秒，掉进了水里，提前停下`, { interrupted: 'water' });
      if (args.look && Date.now() < end) await adapter.look(yaw0 + Math.sin(++k * 0.9) * 0.9, -0.1, signal);
      ctx.progress(Math.min(1, (Date.now() - t0) / (args.seconds * 1000)), '等待中');
    }
    const s = adapter.state();
    return ok(`${landed}原地等了 ${Math.round((Date.now() - t0) / 1000)} 秒（现在${s.isDay ? '白天' : '夜晚'}）`);
  },
};

/**
 * 思考期间持续维护当前视野，近处没有可见关注对象时才偶尔轻微扫视。
 * 不走动、不挖不放、不消耗东西；决定一到立即让出控制，不恢复旧视线。
 */
export const glance: Skill<{ seconds: number }> = {
  name: 'glance',
  description: '想事情时持续留意当前视野，偶尔轻微扫视（不移动、不消耗东西）',
  argsDoc: '{"seconds"?:2-300}',
  timeoutMs: 305000,
  movement: false,
  readOnly: true,
  validate(raw) {
    return { ok: true, args: { seconds: clampInt(obj(raw).seconds, 2, 300, 120) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    throwIfAborted(signal);
    const initial = adapter.state(), eye = adapter.eye();
    const t0 = Date.now(), end = Math.min(t0 + args.seconds * 1000, ctx.deadline);
    let previousHp = initial.hp, nextScan = t0 + 8000, scan = 0,
      canScan = !!eye && Number.isFinite(eye.yaw) && Number.isFinite(eye.pitch);
    const finish = (interrupted?: string) => ok(interrupted ? '观察已让出，等待下一步处理' : '持续留意了当前视野', {
      seconds: Math.max(0, (Date.now() - t0) / 1000), ...(interrupted ? { interrupted } : {}),
    });
    while (Date.now() < end) {
      throwIfAborted(signal);
      const s = adapter.state();
      if (!s.connected || !s.alive || !s.observationReady) return finish('observation_lost');
      if (s.worldId !== initial.worldId || s.dim !== initial.dim || s.sessionId !== initial.sessionId) return finish('session_changed');
      if (s.inLava || s.inWater && !s.riding) return finish(s.inLava ? 'lava' : 'water');
      if (!s.onGround && !s.riding) return finish('airborne');
      if (s.hp < previousHp || s.hp <= 6) return finish(s.hp < previousHp ? 'hurt' : 'low_hp');
      previousHp = s.hp;
      ctx.senses.refresh();
      throwIfAborted(signal);
      if (ctx.senses.perceivedEntities(8).some((entity) => entity.perception === 'seen')) nextScan = Date.now() + 8000;
      if (canScan && eye && Date.now() >= nextScan) {
        // The surrounding arc stays within ten degrees and keeps the current pitch.
        const offset = [0.16, 0, -0.16, 0][scan++ % 4];
        const lookController = new AbortController();
        try {
          await raceAbort(adapter.look(eye.yaw + offset, eye.pitch, lookController.signal), signal,
            Math.max(1, Math.min(400, end - Date.now())), () => lookController.abort('observation yielded'));
        } catch (error) {
          throwIfAborted(signal);
          // Missing look acknowledgements must not stall attention or repeated inputs.
          if (!(error instanceof TimeoutError)) throw error;
          canScan = false;
        }
        throwIfAborted(signal);
        nextScan = Date.now() + 8000;
        continue; // Recheck safety and refresh the resulting view before waiting again.
      }
      ctx.progress(Math.min(1, (Date.now() - t0) / Math.max(1, end - t0)), '留意当前视野');
      if (Date.now() < end) await sleep(Math.min(500, end - Date.now()), signal);
    }
    throwIfAborted(signal);
    return finish();
  },
};

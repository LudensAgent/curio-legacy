import { sleep } from '../util.ts';
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
 * 想事情时的“发呆张望”：等模型想下一步的那一两秒里，像人一样慢慢转头看看，而不是僵在原地。
 * 不走动、不挖不放、不消耗任何东西，所以不会让正在想的决定过时；决定一到就被取消。只给执行层当填充用。
 */
export const glance: Skill<{ seconds: number }> = {
  name: 'glance',
  description: '想事情时慢慢转头看看四周（不移动、不消耗东西）',
  argsDoc: '{"seconds"?:2-20}',
  timeoutMs: 25000,
  movement: false,
  readOnly: true,
  validate(raw) {
    return { ok: true, args: { seconds: clampInt(obj(raw).seconds, 2, 20, 8) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    const yaw0 = adapter.eye()?.yaw ?? 0;
    const t0 = Date.now(), end = Math.min(t0 + args.seconds * 1000, ctx.deadline - 500);
    let k = 0;
    while (Date.now() < end) {
      await sleep(Math.min(1200, Math.max(1, end - Date.now())), signal);
      const s = adapter.state();
      if (s.inWater || s.inLava) break;
      await adapter.look(yaw0 + Math.sin(++k * 0.7) * 0.8, -0.05, signal);
      ctx.progress(Math.min(1, (Date.now() - t0) / (args.seconds * 1000)), '一边想一边看看四周');
    }
    return ok('一边想一边看了看四周');
  },
};

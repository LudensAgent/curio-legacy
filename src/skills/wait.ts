import { sleep } from '../util.ts';
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
    const s0 = adapter.state();
    if (s0.inWater && !s0.riding) return fail('ERROR', '在水里不能原地等（会淹死），先上岸');
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
    return ok(`原地等了 ${Math.round((Date.now() - t0) / 1000)} 秒（现在${s.isDay ? '白天' : '夜晚'}）`);
  },
};

import type { BlockHit, Vec3Like } from '../adapter/types.ts';
import { dist3 } from '../util.ts';
import { lookAround } from './movement.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';
import { findWaterSurface, isWaterSurface, openWater, shoreSpot } from './vehicles.ts';
import { craft } from './work.ts';

/** 每一竿最多等多久（原版平均 5~30 秒咬钩） */
const CAST_MS = 45000;

const count = (inv: { name: string; count: number }[], pred: (n: string) => boolean) => inv.filter((i) => pred(i.name)).reduce((a, i) => a + i.count, 0);

export const fish: Skill<{ count: number }> = {
  name: 'fish',
  outcomeBoundary: true,
  description: '用已有钓鱼竿在可见水边钓指定次数，自动等待咬钩并收竿；缺竿默认返回缺口，make:true 才允许用3木棍和2线制作钓鱼竿并准备前置材料',
  argsDoc: '{"count"?:1-16}',
  timeoutMs: 300000,
  movement: true,
  validate(raw) {
    return { ok: true, args: { count: clampInt(obj(raw).count, 1, 16, 4) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    if (!adapter.fish) return fail('ERROR', '当前适配器不支持钓鱼');
    const s0 = adapter.state();
    if (s0.inWater && !s0.riding) return fail('ERROR', '在水里没法钓鱼，先上岸');
    let made = false;
    try {
      // ---- 钓鱼竿
      if (!s0.inventory.some((i) => i.name === 'fishing_rod' && i.count > 0)) {
        if (ctx.make !== true) return fail('MISSING_MATERIALS', '没有钓鱼竿，未制造；可自行准备，或显式 make:true 允许消耗3木棍和2线制作');
        const inv = s0.inventory;
        const string = count(inv, (n) => n === 'string');
        const sticks = count(inv, (n) => n === 'stick') + 4 * count(inv, (n) => n.endsWith('_planks')) + 8 * count(inv, (n) => /_(log|stem)$/.test(n));
        if (string < 2 || sticks < 3) {
          return fail('MISSING_MATERIALS', `没有钓鱼竿：需要 3 根木棍 + 2 根线（线来自蜘蛛或蜘蛛网）；现有线 ${string} 根、木棍折合 ${Math.min(sticks, 99)} 根`,
            { shortfall: [string < 2 ? `线还差 ${2 - string}` : '', sticks < 3 ? '木棍还差（1 块木板 = 2 根木棍）' : ''].filter(Boolean).join('，') });
        }
        ctx.progress(0.03, '先做一根钓鱼竿');
        const r = await craft.run(ctx, { item: 'fishing_rod', count: 1 });
        if (r.status !== 'succeeded' || !adapter.state().inventory.some((i) => i.name === 'fishing_rod')) return fail(r.failureCode ?? 'MISSING_MATERIALS', `做钓鱼竿失败：${r.summary}`, r.data);
        made = true;
      }

      // ---- 找一片开阔的水面，站到岸边
      let water: BlockHit | null = findWaterSurface(ctx, 16, { minOpen: 6, shore: true });
      if (!water) {
        ctx.progress(0.08, '四下找找水面');
        await lookAround.run(ctx, { seconds: 3, for: 'water' });
        water = findWaterSurface(ctx, 16, { minOpen: 6, shore: true });
      }
      if (!water) return fail('NOT_FOUND', `附近 16 格内看不见够大的水面可以钓鱼${made ? '（钓鱼竿已经做好）' : ''}`);
      const here = adapter.state().pos;
      const nearWater = dist3(here, { x: water.pos.x + 0.5, y: water.pos.y + 0.5, z: water.pos.z + 0.5 }) <= 4;
      let stand: Vec3Like = here;
      if (!nearWater) {
        const spot = shoreSpot(ctx, water.pos, here);
        ctx.progress(0.12, `走到水边（${Math.round(water.dist)} 格）`);
        try {
          if (!spot) return fail('NOT_FOUND', '看得见水，但水边没有能站的岸');
          await adapter.moveTo({ kind: 'xyz', x: spot.x, y: spot.y, z: spot.z }, { signal, timeoutMs: 30000 });
        } catch (e) {
          if (isAbort(e)) throw e;
          return fail(codeFromError(e) === 'ERROR' ? 'PATH_NOT_FOUND' : codeFromError(e), `走不到水边：${(e as Error).message}`);
        }
        stand = adapter.state().pos;
        if (adapter.state().inWater) return fail('ERROR', '走到水边时掉进了水里，换个干燥的岸边再钓');
      }
      // 往水里甩远一点（离岸 3~6 格的开阔水面），浮漂不容易挂到岸上
      const aimOf = (): Vec3Like => {
        const vx = water!.pos.x + 0.5 - stand.x, vz = water!.pos.z + 0.5 - stand.z, l = Math.hypot(vx, vz) || 1;
        for (const k of [5, 4, 3, 6]) {
          const p = { x: Math.floor(stand.x + (vx / l) * k), y: water!.pos.y, z: Math.floor(stand.z + (vz / l) * k) };
          if (isWaterSurface(ctx, p) && openWater(ctx, p, 1) >= 4) return p;
        }
        return water!.pos;
      };
      let aim = aimOf();

      // ---- 一竿一竿地钓
      const caught: string[] = [];
      let casts = 0, misses = 0, snags = 0;
      while (caught.length < args.count && ctx.deadline - Date.now() > 8000) {
        casts++;
        ctx.progress(0.15 + 0.85 * (caught.length / args.count), `甩第 ${casts} 竿（已钓到 ${caught.length}）`);
        const r = await adapter.fish(signal, { aim, timeoutMs: Math.min(CAST_MS, ctx.deadline - Date.now() - 4000) });
        if (r.ok) { caught.push(r.caught ?? '东西（没看清是什么）'); misses = 0; continue; }
        if (r.reason === 'NO_ROD') { if (!caught.length) return fail('TOOL_MISSING', '钓鱼竿没了（可能用坏了）'); break; }
        if (r.reason === 'NO_BITE') { misses++; if (misses >= 4) break; continue; }
        // 浮漂挂到方块/生物上被收回：换个落点
        if (++snags >= 3) break;
        const alt = findWaterSurface(ctx, 8, { minOpen: 6 });
        if (alt) { water = alt; aim = aimOf(); }
      }
      const fishy = caught.filter((c) => /cod|salmon|tropical_fish|pufferfish/.test(c));
      if (!caught.length) return fail(misses ? 'TIMEOUT' : 'ERROR', `甩了 ${casts} 竿什么也没钓到${snags ? `（浮漂挂住 ${snags} 次）` : ''}；可以换片更大的水面再试`, { casts });
      return ok(`甩了 ${casts} 竿，钓到：${caught.join('、')}${fishy.some((c) => /cod|salmon/.test(c)) ? '；生鳕鱼/鲑鱼用 smelt 烤熟更顶饱' : ''}${caught.some((c) => /pufferfish/.test(c)) ? '；河豚有毒别吃' : ''}`,
        { caught, casts, ...(made ? { craftedRod: true } : {}) });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `钓鱼出错：${(e as Error).message}`);
    }
  },
};

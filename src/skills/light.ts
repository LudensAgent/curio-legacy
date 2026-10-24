import { effectiveLight, lightAround, sleep } from '../util.ts';
import { clampInt, fail, isAbort, obj, ok, type Skill } from './types.ts';

const AIRISH = new Set(['air', 'cave_air', 'short_grass', 'tall_grass', 'snow']);
const NOT_SOLID = new Set(['air', 'cave_air', 'water', 'lava', 'torch', 'wall_torch', 'short_grass', 'tall_grass', 'snow', 'fern', 'dead_bush']);

/** 背包里的火把数量 */
export const torchCount = (inv: { name: string; count: number }[]) => inv.filter((i) => i.name === 'torch').reduce((n, i) => n + i.count, 0);

/**
 * 在身边最暗的位置插一支火把：优先插在脚边地面上，没有地面就插在墙上。
 * 火把 = 1 煤炭/木炭 + 1 木棍 → 4 支（没有火把时会自动尝试合成）。
 */
export const placeTorch: Skill<{ count: number }> = {
  name: 'place_torch',
  description: '在身边最暗的地方插火把照明（暗处容易刷怪、也看不清）。没有火把会先用煤炭/木炭+木棍合成',
  argsDoc: '{"count"?: 1-4}',
  timeoutMs: 30000,
  movement: false,
  validate(raw) {
    return { ok: true, args: { count: clampInt(obj(raw).count, 1, 4, 1) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    let s = adapter.state();
    const feet = { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y), z: Math.floor(s.pos.z) };
    const feetBlock = adapter.blockAt(feet) ?? 'air';
    if (s.inWater || s.inLava || feetBlock === 'water' || feetBlock === 'lava') return fail('ERROR', '人泡在水里（或岩浆里），插不了火把——先上岸站稳再插');
    // 半空中（掉落、跳跃、悬在梯子/藤蔓上）：脚下没有地，身边也多半靠不上墙，别白找
    const under = adapter.blockAt({ ...feet, y: feet.y - 1 }) ?? 'air';
    if (!s.onGround && NOT_SOLID.has(under)) return fail('ERROR', '人在半空中（脚下没站稳），插不了火把——落地站稳后再插');
    if (torchCount(s.inventory) === 0) {
      const r = await adapter.craft('torch', 4, signal).catch((e) => {
        if (isAbort(e)) throw e;
        return { ok: false, reason: String(e?.message ?? e), crafted: 0 };
      });
      if (!r.ok) return fail('MISSING_MATERIALS', '没有火把，也没有做火把的材料（需要煤炭或木炭 + 木棍）');
      s = adapter.state();
    }
    const fx = Math.floor(s.pos.x), fy = Math.floor(s.pos.y), fz = Math.floor(s.pos.z);
    const lightOf = (x: number, y: number, z: number) => {
      const l = lightAround(adapter, x, y, z);
      return l ? effectiveLight(l, s.timeOfDay) : 15;
    };
    // 候选：脚边一圈（含斜角）同高度的空位，下方是实心方块；按亮度从暗到亮
    const cands: { x: number; y: number; z: number; light: number }[] = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = fx + dx, z = fz + dz;
      const here = adapter.blockAt({ x, y: fy, z }) ?? 'air';
      const below = adapter.blockAt({ x, y: fy - 1, z }) ?? 'air';
      if (AIRISH.has(here) && !NOT_SOLID.has(below)) cands.push({ x, y: fy, z, light: lightOf(x, fy, z) });
    }
    // 没有地面可插：找头部高度旁边有墙的空位（墙上火把）
    if (!cands.length) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = fx + dx, z = fz + dz;
        if (AIRISH.has(adapter.blockAt({ x, y: fy + 1, z }) ?? 'air')) cands.push({ x, y: fy + 1, z, light: lightOf(x, fy + 1, z) });
      }
    }
    cands.sort((a, b) => a.light - b.light);
    let placed = 0;
    for (const c of cands) {
      if (placed >= args.count) break;
      const r = await adapter.placeBlockAt(c, ['torch'], signal);
      if (r.ok) placed++;
    }
    if (!placed) {
      const l = lightAround(adapter, fx, fy, fz);
      if (l && l.sky >= 12 && s.isDay) return ok(`这里是露天（天光 ${l.sky}/15），白天本来就亮，不用插`);
      return fail('ERROR', '附近没有能插火把的位置（脚边没有实心地面，也没有能靠的墙）');
    }
    // 光照更新要等服务器回包：稍等再读，免得报告“插了火把还是 0”
    let after = lightOf(fx, fy, fz);
    for (let i = 0; i < 6 && (lightAround(adapter, fx, fy, fz)?.block ?? 0) === 0; i++) { await sleep(100, signal); after = lightOf(fx, fy, fz); }
    return ok(`插了 ${placed} 支火把，脚下亮度 ${after}/15，剩余火把 ${torchCount(adapter.state().inventory)}`);
  },
};

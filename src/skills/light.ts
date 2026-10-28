import type { GameAdapter } from '../adapter/types.ts';
import { effectiveLight, lightAround, sleep } from '../util.ts';
import { clampInt, fail, isAbort, obj, ok, type Skill } from './types.ts';

const AIRISH = new Set(['air', 'cave_air', 'short_grass', 'tall_grass', 'snow']);
const NOT_SOLID = new Set(['air', 'cave_air', 'water', 'lava', 'torch', 'wall_torch', 'short_grass', 'tall_grass', 'snow', 'fern', 'dead_bush']);

/** 不挡天光的方块：头顶一路都是这些就算“看得见天” */
const SKY_CLEAR = /^(air|cave_air|void_air|water|glass|.*_glass|.*_glass_pane|.*_leaves|short_grass|tall_grass|snow|vine|torch|wall_torch|.*_carpet)$/;
const TORCH_LIGHT: Record<string, number> = { torch: 14, wall_torch: 14, soul_torch: 10, soul_wall_torch: 10 };
const ENOUGH_BLOCK_LIGHT = 8;

/** 头顶这一列往上看到底（最多 96 格）：没有实心方块挡着 = 露天；区块不全时返回 null（不知道） */
export function openSky(adapter: Pick<GameAdapter, 'blockAt'>, x: number, y: number, z: number): boolean | null {
  for (let yy = y; yy <= Math.min(y + 96, 320); yy++) {
    const n = adapter.blockAt({ x, y: yy, z });
    if (n === null) return null; // 未加载的上方不能当成没有屋顶
    if (!SKY_CLEAR.test(n)) return false;
  }
  return true;
}

/**
 * 身边实际有多亮：与感知共用可读脚/头格采样，兼容站在床、半砖和地毯上的位置。
 * 取 max(方块光, 天光按时间折算)。读不到、或者露天白天却读出 0（光照数据没下发）→ level=null（不知道）。
 */
export function measureLight(adapter: Pick<GameAdapter, 'blockAt' | 'lightAt'>, pos: { x: number; y: number; z: number }, timeOfDay: number, isDay: boolean): { level: number | null; sky: boolean | null } {
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  const sky = openSky(adapter, x, y + 2, z);
  const light = lightAround(adapter, x, y, z);
  let level = light ? effectiveLight(light, timeOfDay) : null;
  if (sky && isDay && level !== null && level <= 4) level = null; // 白天露天不可能这么暗：数据不可信
  return { level, sky };
}

/** 背包里的火把数量 */
export const torchCount = (inv: { name: string; count: number }[]) => inv.filter((i) => i.name === 'torch').reduce((n, i) => n + i.count, 0);

/** 实际火把已存在但光照回包迟到时，只认能直接照到身边的近处光源；墙后的火把不算。 */
function nearbyTorchLight(adapter: Pick<GameAdapter, 'blockAt'>, pos: { x: number; y: number; z: number }) {
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  let light = 0;
  for (let dx = -4; dx <= 4; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -4; dz <= 4; dz++) {
    const source = { x: x + dx, y: y + dy, z: z + dz }, name = adapter.blockAt(source);
    const emission = name === null ? 0 : TORCH_LIGHT[name] ?? 0;
    const estimate = emission - Math.abs(dx) - Math.abs(dy) - Math.abs(dz);
    if (estimate < ENOUGH_BLOCK_LIGHT || estimate <= light) continue;
    const from = { x: pos.x, y: pos.y + 1, z: pos.z };
    const length = Math.hypot(source.x + 0.5 - from.x, source.y + 0.5 - from.y, source.z + 0.5 - from.z);
    const steps = Math.max(1, Math.ceil(length * 4));
    let clear = true;
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      const n = adapter.blockAt({ x: Math.floor(from.x + (source.x + 0.5 - from.x) * f), y: Math.floor(from.y + (source.y + 0.5 - from.y) * f), z: Math.floor(from.z + (source.z + 0.5 - from.z) * f) });
      if (n === null || !SKY_CLEAR.test(n) && !(n in TORCH_LIGHT)) { clear = false; break; }
    }
    if (clear) light = estimate;
  }
  return light;
}

function blockLightAround(adapter: Pick<GameAdapter, 'blockAt' | 'lightAt'>, pos: { x: number; y: number; z: number }) {
  const measured = lightAround(adapter, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))?.block;
  return Math.max(measured ?? 0, nearbyTorchLight(adapter, pos));
}

/**
 * 在身边最暗的位置插一支火把：优先插在脚边地面上，没有地面就插在墙上。
 * 火把 = 1 煤炭/木炭 + 1 木棍 → 4 支（没有火把时会自动尝试合成）。
 */
export const placeTorch: Skill<{ count: number; auto?: boolean }> = {
  name: 'place_torch',
  description: '在周围暗处放背包火把，已有足够方块光时结束；放置后核对亮度。缺火把默认返回缺口，make:true 才允许合成（消耗煤/木炭和木棍，也可能准备前置材料）',
  argsDoc: '{"count"?: 1-4}',
  timeoutMs: 30000,
  movement: false,
  validate(raw) {
    const a = obj(raw);
    return { ok: true, args: { count: clampInt(a.count, 1, 4, 1), ...(a.auto === true ? { auto: true } : {}) } };
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
    // 白天天光很亮仍可能需要为夜间照明；只有已有的方块光/真实近处光源能让显式请求幂等。
    if (blockLightAround(adapter, s.pos) >= ENOUGH_BLOCK_LIGHT) return ok('周围已有足够照明，保留现有火把', { placed: 0 });
    const lit = measureLight(adapter, s.pos, s.timeOfDay, s.isDay);
    if (args.auto && lit.sky === true && s.isDay) return ok('这里是露天，白天本来就亮，不用插火把', { placed: 0 });
    if (args.auto && (lit.level === null || lit.level > 4 || lit.sky !== false)) return ok('周围没有确认需要补光的暗处，先保留火把', { placed: 0 });
    if (torchCount(s.inventory) === 0) {
      if (ctx.make !== true) return fail('MISSING_MATERIALS', '没有火把，未合成；可自行准备，或显式 make:true 允许消耗煤/木炭和木棍制作');
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
      const here = adapter.blockAt({ x, y: fy, z });
      const below = adapter.blockAt({ x, y: fy - 1, z });
      if (here !== null && below !== null && AIRISH.has(here) && !NOT_SOLID.has(below)) cands.push({ x, y: fy, z, light: lightOf(x, fy, z) });
    }
    // 没有地面可插：找头部高度旁边有墙的空位（墙上火把）
    if (!cands.length) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = fx + dx, z = fz + dz;
        const here = adapter.blockAt({ x, y: fy + 1, z });
        if (here !== null && AIRISH.has(here)) cands.push({ x, y: fy + 1, z, light: lightOf(x, fy + 1, z) });
      }
    }
    // 窄竖井、一格宽的巷子里四周全是石头：火把没有碰撞箱，可以插在自己脚下那格（地上）或头那格（靠墙）
    if (!cands.length) {
      const feetHere = adapter.blockAt({ x: fx, y: fy, z: fz }), floor = adapter.blockAt({ x: fx, y: fy - 1, z: fz });
      if (feetHere !== null && floor !== null && AIRISH.has(feetHere) && !NOT_SOLID.has(floor)) cands.push({ x: fx, y: fy, z: fz, light: lightOf(fx, fy, fz) });
      const headHere = adapter.blockAt({ x: fx, y: fy + 1, z: fz });
      const wall = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const n = adapter.blockAt({ x: fx + dx, y: fy + 1, z: fz + dz }); return n !== null && !NOT_SOLID.has(n); });
      if (headHere !== null && AIRISH.has(headHere) && wall) cands.push({ x: fx, y: fy + 1, z: fz, light: lightOf(fx, fy + 1, fz) });
    }
    cands.sort((a, b) => a.light - b.light);
    let placed = 0;
    const placedAt: { x: number; y: number; z: number }[] = [];
    for (const c of cands) {
      if (placed >= args.count || blockLightAround(adapter, adapter.state().pos) >= ENOUGH_BLOCK_LIGHT) break;
      // 即使服务器光照还没更新，也不在刚插的一支旁边继续堆。
      if (placedAt.some((p) => Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) < 4)) continue;
      const r = await adapter.placeBlockAt(c, ['torch'], signal);
      if (r.ok) { placed++; placedAt.push(c); }
    }
    if (!placed) {
      const l = lightAround(adapter, fx, fy, fz);
      if (lit.sky === true && l && l.sky >= 12 && s.isDay) return ok(`这里是露天（天光 ${l.sky}/15），白天本来就亮，不用插`, { placed: 0 });
      return fail('ERROR', '附近没有能插火把的位置（脚边没有实心地面，也没有能靠的墙）');
    }
    // 光照更新要等服务器回包：稍等再读，免得报告“插了火把还是 0”
    const measure = () => measureLight(adapter, adapter.state().pos, s.timeOfDay, s.isDay).level;
    let after = measure();
    for (let i = 0; i < 6 && (after ?? 0) <= 4 && blockLightAround(adapter, adapter.state().pos) < ENOUGH_BLOCK_LIGHT; i++) { await sleep(100, signal); after = measure(); }
    const estimate = blockLightAround(adapter, adapter.state().pos);
    return ok(`插了 ${placed} 支火把，${after === null || after <= 4 && estimate >= ENOUGH_BLOCK_LIGHT ? '周围光照回包尚未确认，近处光源已放好' : `周围亮度 ${after}/15`}，剩余火把 ${torchCount(adapter.state().inventory)}`, { placed });
  },
};

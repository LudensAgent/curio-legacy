import type { InvItem, Vec3Like } from '../adapter/types.ts';
import { DIRS } from '../perception/perception.ts';
import { shortId, sleep } from '../util.ts';
import { findStation, rememberStation } from './stations.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

// ===================================================================== 冶炼
export const SMELTABLE: Record<string, string> = {
  raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato',
  sand: 'glass', red_sand: 'glass', cobblestone: 'stone', clay_ball: 'brick', kelp: 'dried_kelp', cactus: 'green_dye',
  oak_log: 'charcoal', birch_log: 'charcoal', spruce_log: 'charcoal', jungle_log: 'charcoal', acacia_log: 'charcoal',
  dark_oak_log: 'charcoal', mangrove_log: 'charcoal', cherry_log: 'charcoal',
};
const FUELS = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick'];

export function pickFuel(inv: InvItem[], input: string): string | null {
  for (const f of FUELS) if (f !== input && inv.some((i) => i.name === f && i.count > 0)) return f;
  return null;
}

export const smelt: Skill<{ item: string; count: number }> = {
  name: 'smelt',
  description: `用熔炉烧东西（自动找记得的熔炉；没有就用 8 圆石做一个放下；燃料自动选煤/木炭/木板/原木）。可烧：生铁→铁锭、生肉→熟肉、原木→木炭（可做火把）、沙子→玻璃、圆石→石头等`,
  argsDoc: '{"item": "raw_iron|beef|oak_log|sand|…", "count"?: 1-64}',
  timeoutMs: 600000,
  movement: false,
  validate(raw) {
    const a = obj(raw);
    const item = String(a.item ?? '').replace(/^minecraft:/, '');
    if (!SMELTABLE[item]) return { ok: false, error: `不能烧 ${item}；可烧：${Object.keys(SMELTABLE).slice(0, 12).join('/')}…` };
    return { ok: true, args: { item, count: clampInt(a.count, 1, 64, 8) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const s = adapter.state();
    const have = s.inventory.filter((i) => i.name === args.item).reduce((n, i) => n + i.count, 0);
    if (!have) return fail('MISSING_MATERIALS', `背包里没有 ${args.item}`);
    const fuel = pickFuel(s.inventory, args.item);
    if (!fuel) return fail('MISSING_MATERIALS', '没有燃料（煤、木炭、木板或原木）');
    const furnace = findStation(ctx, ['furnace'], 64);
    const n = Math.min(have, args.count);
    ctx.progress(0, `烧 ${args.item} ×${n}（燃料 ${fuel}）`);
    try {
      const r = await adapter.smelt(args.item, n, fuel, signal, { furnacePos: furnace?.pos, onProgress: (d) => ctx.progress(d / n, `已烧好 ${d}/${n}`) });
      if (r.furnacePos) rememberStation(ctx, 'furnace', r.furnacePos);
      if (!r.ok) return fail(r.reason === 'NO_FURNACE' ? 'MISSING_MATERIALS' : 'ERROR', `烧不了：${r.reason}${r.reason === 'NO_FURNACE' ? '（需要 8 个圆石做熔炉）' : ''}`);
      return ok(`烧好了 ${r.made} 个 ${r.output ?? SMELTABLE[args.item]}${furnace && furnace.dist > 4 ? `（用了 ${furnace.dist} 格外${furnace.from === 'memory' ? '记得' : '看到'}的熔炉）` : ''}`, { made: r.made });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `冶炼出错：${(e as Error).message}`);
    }
  },
};

// ===================================================================== 仓储
/** 身上一直要带着的东西：工具、武器、食物、火把、床，以及少量建材 */
export function isEssential(name: string) {
  return /_(pickaxe|axe|shovel|hoe|sword)$|^(torch|white_bed|.*_bed|bread|cooked_.*|baked_potato|apple|carrot|golden_apple|shears|bucket|water_bucket|flint_and_steel|compass|clock)$/.test(name);
}
const KEEP_SOME: Record<string, number> = { cobblestone: 32, dirt: 16, oak_planks: 16, birch_planks: 16, spruce_planks: 16, stick: 8, coal: 16, charcoal: 16, wheat_seeds: 16 };

async function ensureChest(ctx: SkillCtx): Promise<Vec3Like | null> {
  const known = findStation(ctx, ['chest'], 48);
  if (known) return known.pos;
  const s = ctx.adapter.state();
  if (!s.inventory.some((i) => i.name === 'chest')) {
    const r = await ctx.adapter.craft('chest', 1, ctx.signal);
    if (!r.ok) return null;
  }
  const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y), z = Math.floor(s.pos.z);
  for (const [dx, dz] of [[2, 0], [0, 2], [-2, 0], [0, -2], [1, 1], [-1, -1]]) {
    const p = { x: x + dx, y, z: z + dz };
    if ((ctx.adapter.blockAt(p) ?? 'air') !== 'air') continue;
    const r = await ctx.adapter.placeBlockAt(p, ['chest'], ctx.signal);
    if (r.ok) {
      ctx.memory.addLandmark('discovery', '我的箱子', s.dim, p, 3);
      ctx.senses.refresh();
      return p;
    }
  }
  return null;
}

export const storeItems: Skill<{}> = {
  name: 'store_items',
  description: '把背包里暂时用不上的东西存进记得的箱子（没有就做一个放下，8 木板），工具/食物/火把/少量建材留在身上。背包快满时使用',
  argsDoc: '{}',
  timeoutMs: 90000,
  movement: true,
  validate() {
    return { ok: true, args: {} };
  },
  async run(ctx) {
    const pos = await ensureChest(ctx);
    if (!pos) return fail('MISSING_MATERIALS', '没有箱子也做不了（需要 8 木板）');
    const s = ctx.adapter.state();
    const deposits: InvItem[] = [];
    for (const it of s.inventory) {
      if (isEssential(it.name)) continue;
      const keep = KEEP_SOME[it.name] ?? 0;
      if (it.count > keep) deposits.push({ name: it.name, count: it.count - keep });
    }
    if (!deposits.length) return ok('背包里没有需要存放的东西');
    try {
      const r = await ctx.adapter.useChest(pos, deposits, [], ctx.signal);
      if (!r.ok) return fail('ERROR', `存放失败：${r.reason}`);
      ctx.memory.setChest(s.dim, pos, r.contents);
      return ok(`存入 ${r.moved} 个物品（${deposits.map((d) => `${d.name}×${d.count}`).slice(0, 6).join('、')}）；背包空位 ${ctx.adapter.state().emptySlots}`);
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `存放出错：${(e as Error).message}`);
    }
  },
};

export const takeItems: Skill<{ item: string; count: number }> = {
  name: 'take_items',
  description: '从记得的箱子里取出物品（state.storage 里能看到箱子里存了什么）',
  argsDoc: '{"item": "<物品名>", "count"?: 1-64}',
  timeoutMs: 90000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const item = String(a.item ?? '').replace(/^minecraft:/, '');
    if (!adapter.isKnownItem(item)) return { ok: false, error: `未知物品：${item}` };
    return { ok: true, args: { item, count: clampInt(a.count, 1, 64, 16) } };
  },
  async run(ctx, args) {
    const chests = ctx.memory.chests().filter((c) => c.items.some((i) => i.name === args.item && i.count > 0));
    if (!chests.length) return fail('NOT_FOUND', `记得的箱子里没有 ${args.item}`);
    const s = ctx.adapter.state();
    chests.sort((a, b) => Math.hypot(a.pos.x - s.pos.x, a.pos.z - s.pos.z) - Math.hypot(b.pos.x - s.pos.x, b.pos.z - s.pos.z));
    try {
      const r = await ctx.adapter.useChest(chests[0].pos, [], [{ name: args.item, count: args.count }], ctx.signal);
      if (!r.ok) return fail('ERROR', `取不到：${r.reason}`);
      ctx.memory.setChest(chests[0].dim, chests[0].pos, r.contents);
      return r.moved ? ok(`取出 ${r.moved} 个 ${args.item}`) : fail('NOT_FOUND', `箱子里的 ${args.item} 已经没了`);
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `取物出错：${(e as Error).message}`);
    }
  },
};

// ===================================================================== 农业
const SEEDS: Record<string, string> = { wheat: 'wheat_seeds', carrot: 'carrot', potato: 'potato', beetroot: 'beetroot_seeds' };

export const collectSeeds: Skill<{ count: number }> = {
  name: 'collect_seeds',
  description: '打掉附近看得见的草丛收集小麦种子（每丛约 1/8 概率掉种子）',
  argsDoc: '{"count"?: 1-16}',
  timeoutMs: 90000,
  movement: true,
  validate(raw) {
    return { ok: true, args: { count: clampInt(obj(raw).count, 1, 16, 6) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const seeds = () => adapter.state().inventory.filter((i) => i.name === 'wheat_seeds').reduce((n, i) => n + i.count, 0);
    const start = seeds();
    let broken = 0;
    const tried = new Set<string>();
    while (seeds() - start < args.count && Date.now() < ctx.deadline - 2000 && broken < 80) {
      senses.refresh();
      const g = senses.knownBlocks(['short_grass', 'tall_grass', 'grass', 'fern'], 32).find((b) => !tried.has(`${b.pos.x},${b.pos.y},${b.pos.z}`));
      if (!g) break;
      tried.add(`${g.pos.x},${g.pos.y},${g.pos.z}`);
      try {
        await adapter.moveTo({ kind: 'reach_block', pos: g.pos }, { signal, timeoutMs: 10000 });
        if ((await adapter.dig(g.pos, signal)).ok) broken++;
        await adapter.collectNearbyDrops(signal, 3, 1200);
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      ctx.progress((seeds() - start) / args.count, `打草 ${broken} 丛，种子 +${seeds() - start}`);
    }
    const got = seeds() - start;
    return got > 0 ? ok(`打了 ${broken} 丛草，得到 ${got} 颗种子`) : fail('NOT_FOUND', broken ? `打了 ${broken} 丛草没掉种子` : '视野里没有草丛');
  },
};

export const farm: Skill<{ crop: string; size: number }> = {
  name: 'farm',
  description: '经营农田：成熟的作物收割并补种；没有农田就在脚边开垦一块（需要锄头，会自动用木板/圆石+木棍做；需要种子：wheat_seeds 可用 collect_seeds 获得，carrot/potato 直接种）。稳定的食物来源',
  argsDoc: '{"crop"?: "wheat|carrot|potato|beetroot", "size"?: 4-25}',
  timeoutMs: 240000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const crop = String(a.crop ?? 'wheat');
    if (!SEEDS[crop]) return { ok: false, error: `crop 必须是 ${Object.keys(SEEDS).join('/')}` };
    return { ok: true, args: { crop, size: clampInt(a.size, 4, 25, 9) } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    const seed = SEEDS[args.crop];
    const s = adapter.state();
    let f = memory.farms().filter((x) => x.dim === s.dim).sort((a, b) => Math.hypot(a.cells[0].x - s.pos.x, a.cells[0].z - s.pos.z) - Math.hypot(b.cells[0].x - s.pos.x, b.cells[0].z - s.pos.z))[0];
    let harvested = 0, planted = 0, tilled = 0;

    if (!f) {
      if (!s.inventory.some((i) => i.name.endsWith('_hoe'))) {
        const hoe = s.inventory.some((i) => i.name === 'cobblestone') ? 'stone_hoe' : 'wooden_hoe';
        const r = await adapter.craft(hoe, 1, signal);
        if (!r.ok) return fail('MISSING_MATERIALS', `没有锄头也做不了（${hoe}：2 ${hoe === 'stone_hoe' ? '圆石' : '木板'} + 2 木棍）`);
      }
      // 在脚边找一块 n×n 的草地/泥土（这些方块就在眼前，属于可见的地面）
      const n = Math.max(2, Math.round(Math.sqrt(args.size)));
      const x0 = Math.floor(s.pos.x) + 2, z0 = Math.floor(s.pos.z) - Math.floor(n / 2), y = Math.floor(s.pos.y) - 1;
      const cells: Vec3Like[] = [];
      for (let dx = 0; dx < n; dx++) for (let dz = 0; dz < n; dz++) {
        const p = { x: x0 + dx, y, z: z0 + dz };
        if (['grass_block', 'dirt', 'farmland'].includes(adapter.blockAt(p) ?? '')) cells.push(p);
      }
      if (cells.length < 2) return fail('ERROR', '脚边没有适合开垦的平地（草方块/泥土）');
      for (const c of cells) {
        if (Date.now() > ctx.deadline - 5000) break;
        try {
          const r = await adapter.till(c, signal);
          if (r.ok) tilled++;
          if (r.reason === 'NO_HOE') break;
        } catch (e) {
          if (isAbort(e)) throw e;
        }
        ctx.progress(tilled / cells.length / 2, `开垦 ${tilled}/${cells.length}`);
      }
      if (!tilled) return fail('ERROR', '没能锄出耕地');
      f = { id: shortId('farm_'), dim: s.dim, crop: args.crop, cells: cells.filter((c) => adapter.blockAt(c) === 'farmland'), plantedAt: Date.now(), harvests: 0 };
      memory.addFarm(f);
      memory.addLandmark('discovery', '我的农田', s.dim, f.cells[0], 4);
      ctx.bus.publish('farm', 'P2', `开垦了一块 ${f.cells.length} 格的农田`);
    }

    // 收割成熟的、补种空着的
    for (const [i, c] of f.cells.entries()) {
      if (Date.now() > ctx.deadline - 3000) break;
      const top = { x: c.x, y: c.y + 1, z: c.z };
      const age = adapter.cropAge(top);
      try {
        if (age && age.age >= age.max) {
          if (Math.hypot(top.x - adapter.state().pos.x, top.z - adapter.state().pos.z) > 4) {
            await adapter.moveTo({ kind: 'near', pos: top, range: 2 }, { signal, timeoutMs: 15000 });
          }
          if ((await adapter.dig(top, signal)).ok) harvested++;
        }
        if (!adapter.cropAge(top) && adapter.state().inventory.some((it) => it.name === seed)) {
          if ((await adapter.plant(c, seed, signal)).ok) planted++;
        }
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      ctx.progress(0.5 + (i + 1) / f.cells.length / 2, `收割 ${harvested}，播种 ${planted}`);
    }
    await adapter.collectNearbyDrops(signal, 6, 3000).catch((e) => { if (isAbort(e)) throw e; return 0; });
    memory.updateFarm(f.id, { plantedAt: planted ? Date.now() : f.plantedAt, harvests: f.harvests + (harvested ? 1 : 0) });
    if (!harvested && !planted && !tilled) {
      const hasSeed = adapter.state().inventory.some((it) => it.name === seed);
      return hasSeed ? ok('农田里的作物还没成熟') : fail('MISSING_MATERIALS', `没有 ${seed} 可以播种`);
    }
    return ok(`农田：开垦 ${tilled}、收割 ${harvested}、播种 ${planted}（共 ${f.cells.length} 格）`, { harvested, planted });
  },
};

// ===================================================================== 远征
export const expedition: Skill<{ direction: string; distance: number; torches?: boolean; eat_below?: number }> = {
  name: 'expedition',
  description: '远征：朝一个方向长距离行进（100-600 格），每约 64 格记一个路标，沿途记录新发现；路上要不要在路标插火把、饿到多少吃东西由你在参数里定。出发前带足食物、火把和工具。用 goto base 沿路标回家',
  argsDoc: '{"direction": "N|NE|E|SE|S|SW|W|NW", "distance"?: 100-600, "torches"?: true（路标处插火把）, "eat_below"?: 2-19（饿到这个数就吃）}',
  timeoutMs: 900000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const d = String(a.direction ?? '').toUpperCase();
    if (!DIRS[d]) return { ok: false, error: `direction 必须是 ${Object.keys(DIRS).join('/')}` };
    return { ok: true, args: { direction: d, distance: clampInt(a.distance, 100, 600, 240), ...(a.torches === true ? { torches: true } : {}), ...(a.eat_below !== undefined ? { eat_below: clampInt(a.eat_below, 2, 19, 12) } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    const s0 = adapter.state();
    const food = s0.inventory.filter((i) => /cooked_|bread|baked_potato|apple|carrot/.test(i.name)).reduce((n, i) => n + i.count, 0);
    if (food < 3) return fail('MISSING_MATERIALS', `食物只有 ${food} 个，远征至少带 3 个熟食`);
    const [dx, dz] = DIRS[args.direction];
    const start = s0.pos;
    let travelled = 0, waypoints = 0, failures = 0;
    const chunks0 = memory.visitedChunkCount;
    while (travelled < args.distance && Date.now() < ctx.deadline - 5000) {
      const hop = Math.min(48, args.distance - travelled);
      const p = adapter.state().pos;
      try {
        await adapter.moveTo({ kind: 'xz', x: p.x + dx * hop, z: p.z + dz * hop, range: 6 }, { signal, timeoutMs: 60000 });
        failures = 0;
      } catch (e) {
        if (isAbort(e)) throw e;
        if (++failures >= 3) break;
        // 绕一下：斜着走一段
        const side = failures % 2 ? 1 : -1;
        await adapter.moveTo({ kind: 'xz', x: p.x - dz * side * 16, z: p.z + dx * side * 16, range: 4 }, { signal, timeoutMs: 20000 }).catch((er) => { if (isAbort(er)) throw er; });
      }
      const now = adapter.state();
      travelled = Math.round(Math.hypot(now.pos.x - start.x, now.pos.z - start.z));
      if (travelled >= (waypoints + 1) * 64) {
        waypoints++;
        memory.addLandmark('waypoint', `路标 ${args.direction}-${waypoints}`, now.dim, now.pos, 8);
        if (args.torches && now.inventory.some((i) => i.name === 'torch')) {
          const x = Math.floor(now.pos.x), y = Math.floor(now.pos.y), z = Math.floor(now.pos.z);
          await adapter.placeBlockAt({ x: x + 1, y, z }, ['torch'], signal).catch((er) => { if (isAbort(er)) throw er; });
        }
      }
      if (args.eat_below && now.food <= args.eat_below && adapter.hasFood()) await adapter.eat(signal).catch((er) => { if (isAbort(er)) throw er; });
      if (now.hp <= 8) break;
      ctx.progress(travelled / args.distance, `远征 ${args.direction}：${travelled}/${args.distance} 格，路标 ${waypoints}`);
      await sleep(50, signal);
    }
    const newChunks = memory.visitedChunkCount - chunks0;
    const msg = `远征向 ${args.direction} 走了 ${travelled} 格，新区块 +${newChunks}，留下 ${waypoints} 个路标`;
    return travelled >= args.distance * 0.5 ? ok(msg, { travelled }) : fail('PATH_NOT_FOUND', `${msg}（中途受阻）`);
  },
};

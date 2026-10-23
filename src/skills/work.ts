import { lookAround } from './movement.ts';
import { findStation, rememberStation } from './stations.ts';
import { dist3 } from '../util.ts';
import { codeFromError, clampInt, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';
import { craftReservationConflict } from '../projects/reservations.ts';
import { config } from '../config.ts';

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

// ------------------------------------------------------------------ gather
/** 可以“往下挖”找到的地表/地下方块 */
const DIGGABLE_DOWN = new Set(['stone', 'cobblestone', 'deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'dirt', 'grass_block', 'coarse_dirt', 'sand', 'gravel', 'clay']);
const UNSAFE_BELOW = new Set(['lava', 'water', 'air', 'cave_air', 'bedrock']);
const WATERY = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column', 'lava']);

/** 走向目标方块；8 秒内几乎没挪动就放弃这个目标（换下一个），而不是原地耗到被判卡死 */
async function moveWithWatchdog(ctx: SkillCtx, pos: { x: number; y: number; z: number }) {
  const stop = new AbortController();
  let anchor = ctx.adapter.state().pos, since = Date.now();
  const iv = setInterval(() => {
    const p = ctx.adapter.state().pos;
    if (Math.hypot(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z) >= 0.6) { anchor = p; since = Date.now(); }
    else if (Date.now() - since >= 8000) stop.abort('no_progress');
  }, 500);
  try {
    await ctx.adapter.moveTo({ kind: 'reach_block', pos }, { signal: AbortSignal.any([ctx.signal, stop.signal]), timeoutMs: Math.min(90000, Math.max(3000, ctx.deadline - Date.now())) });
  } catch (e) {
    if (stop.signal.aborted && !ctx.signal.aborted) throw new Error('PATH_NO_PROGRESS');
    throw e;
  } finally {
    clearInterval(iv);
  }
}

export const gather: Skill<{ block: string; count: number }> = {
  name: 'gather',
  description: '前往【看见过或正看见】的指定方块并挖掘、拾取。看不见的不会去挖（没有透视）；stone/dirt/sand 若看不见会就地向下挖。block 可用别名：log(任意原木)、stone、dirt、coal、iron、ore',
  argsDoc: '{"block": "log|stone|coal|iron|<方块名>", "count"?: 1-32}',
  timeoutMs: 180000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const block = String(a.block ?? '').trim();
    if (!block) return { ok: false, error: 'block 不能为空' };
    if (!adapter.resolveBlockNames(block).length) return { ok: false, error: `未知方块：${block}` };
    return { ok: true, args: { block, count: clampInt(a.count, 1, 32, 4) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const names = adapter.resolveBlockNames(args.block);
    const canDigDown = names.some((n) => DIGGABLE_DOWN.has(n));
    const skip = new Set<string>();
    let dug = 0;
    let failsInRow = 0;
    let dugDown = 0;
    let searched = false;
    let lost = 0;
    ctx.progress(0, `采集 ${args.block} x${args.count}`);
    while (dug < args.count) {
      const s = adapter.state();
      if (!s.connected) return fail('NOT_CONNECTED', '连接断开');
      if (s.emptySlots === 0) {
        return dug > 0 ? ok(`背包已满，采集了 ${dug}/${args.count} 个 ${args.block}`) : fail('INVENTORY_FULL', '背包已满');
      }
      senses.refresh();
      const hits = senses
        .knownBlocks(names, 256)
        .filter((h) => !skip.has(key(h.pos)))
        // 水下（上方是水）的方块不去挖：会憋气溺水
        .filter((h) => !WATERY.has(adapter.blockAt({ x: h.pos.x, y: h.pos.y + 1, z: h.pos.z }) ?? 'air'))
        .sort((a, b) => a.dist + Math.abs(a.pos.y - s.pos.y) * 0.6 - (b.dist + Math.abs(b.pos.y - s.pos.y) * 0.6));

      if (!hits.length) {
        // 看不见目标：石头/泥土类可以就地往下挖（脚下的方块是“踩着的”，不算透视）
        if (canDigDown && dugDown < 8 && !s.inWater) {
          const below = { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y) - 1, z: Math.floor(s.pos.z) };
          const under = adapter.blockAt(below);
          const under2 = adapter.blockAt({ ...below, y: below.y - 1 });
          // 旁边有水就别往下挖：一挖开水就灌进来（脚边的方块是踩着、碰着的，不算透视）
          const wet = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => [below.y, below.y + 1].some((y) => WATERY.has(adapter.blockAt({ x: below.x + dx, y, z: below.z + dz }) ?? 'air')));
          if (under && DIGGABLE_DOWN.has(under) && !UNSAFE_BELOW.has(under2 ?? 'air') && !wet) {
            ctx.progress(dug / args.count, `向下挖（${under}）`);
            const r = await adapter.dig(below, signal);
            if (r.ok) {
              dugDown++;
              if (names.includes(under)) {
                dug++;
                ctx.progress(dug / args.count, `采集 ${args.block} ${dug}/${args.count}`);
              }
              await adapter.collectNearbyDrops(signal, 3, 1500);
              continue;
            }
          }
        }
        // 眼前没有了就转头找找（砍完一棵树，人会四下看看下一棵在哪），每次采集只找一次
        if (!searched && !s.inWater) {
          searched = true;
          ctx.progress(dug / args.count, `四下找找还有没有 ${args.block}`);
          const r = await lookAround.run(ctx, { seconds: 3, for: args.block });
          if (r.status === 'succeeded') continue;
        }
        // 走到了记忆里的资源地标附近却看不到它：地标过时（被挖走 / 记错），从记忆里抹掉
        const stale = ctx.memory.resourceLandmarksNear(names, s.dim, s.pos, 16);
        for (const l of stale) ctx.memory.removeLandmark(l.id);
        const staleNote = stale.length ? `；已把 ${stale.length} 个过时的 ${args.block} 地标从记忆里删除` : '';
        const looked = searched ? '（已转头找过）' : '';
        return dug > 0
          ? ok(`看不到更多 ${args.block}${looked}，采集了 ${dug}/${args.count}${staleNote}`, { searched })
          : fail('NOT_FOUND', `视野和记忆里都没有 ${args.block}${looked}${staleNote}；尚未定位该资源，不代表其他地点也没有`, { searched });
      }
      // 记忆里的方块可能已经被砍掉/不在加载范围：这种目标跳过，不能误报成“缺工具”
      const present = hits.filter((h) => adapter.blockAt(h.pos) === h.name);
      for (const h of hits) if (!present.includes(h)) skip.add(key(h.pos));
      if (!present.length) continue;
      const target = present.find((h) => adapter.canHarvest(h.pos));
      if (!target) return fail('TOOL_MISSING', `缺少能采集 ${present[0].name} 的工具`, { block: present[0].name });

      const invTotal = () => adapter.state().inventory.reduce((a, i) => a + i.count, 0);
      const before = invTotal();
      try {
        ctx.progress(dug / args.count, `前往 ${target.name}（${Math.round(target.dist)} 格）`);
        await moveWithWatchdog(ctx, target.pos);
        const t0 = Date.now();
        const r = await adapter.dig(target.pos, signal);
        if (!r.ok) throw new Error(r.reason ?? 'DIG_FAILED');
        ctx.memory.recordDig(target.name, adapter.state().held, Date.now() - t0);
      } catch (e) {
        if (isAbort(e)) throw e;
        skip.add(key(target.pos));
        if (++failsInRow >= 4) {
          return dug > 0 ? ok(`多次失败后停止，采集了 ${dug}/${args.count}`, { dug }) : fail(codeFromError(e) === 'ERROR' ? 'PATH_NOT_FOUND' : codeFromError(e), `无法到达或挖掘 ${args.block}：${(e as Error).message}`);
        }
        continue;
      }
      failsInRow = 0;
      dug++;
      ctx.progress(dug / args.count, `采集 ${args.block} ${dug}/${args.count}`);
      await adapter.collectNearbyDrops(signal, 6, 3000);
      // 捡完再核对：挖掉了但掉落物没进背包（掉进水里、卡在角落）就不算数
      if (invTotal() <= before) await adapter.collectNearbyDrops(signal, 8, 2500);
      if (invTotal() <= before) {
        dug--;
        ctx.progress(dug / args.count, `${args.block} 的掉落物没捡到`);
        if (++lost >= 3) return dug > 0
          ? ok(`采集了 ${dug}/${args.count}；另外挖掉了 ${lost} 块但掉落物没捡到（可能掉进水里或够不着）`, { dug, lost })
          : fail('ERROR', `挖掉了 ${lost} 块 ${args.block} 但掉落物都没捡到（可能掉进水里或够不着），换个干燥、好走的地方再挖`, { dug, lost });
        continue;
      }
    }
    return ok(`采集了 ${dug} 个 ${args.block}${lost ? `（另有 ${lost} 块的掉落物没捡到）` : ''}`, { dug, ...(lost ? { lost } : {}) });
  },
};

// ------------------------------------------------------------------ craft
const COLORED = ['bed', 'wool', 'carpet', 'banner', 'concrete', 'terracotta', 'stained_glass', 'candle'];
const WOODEN = ['planks', 'boat', 'door', 'fence', 'fence_gate', 'slab', 'stairs', 'sign', 'button', 'pressure_plate', 'trapdoor', 'log', 'wood'];
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo'];
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

/** LLM 常写泛称（bed、planks、boat）：映射到一个具体物品 ID；无法识别返回 null */
export function resolveItemAlias(name: string, adapter: { isKnownItem(n: string): boolean }): string | null {
  const n = name.toLowerCase().replace(/\s+/g, '_');
  if (adapter.isKnownItem(n)) return n;
  if (COLORED.includes(n) && adapter.isKnownItem(`white_${n}`)) return `white_${n}`;
  if (WOODEN.includes(n) && adapter.isKnownItem(`oak_${n}`)) return `oak_${n}`;
  for (const cut of ['es', 's']) if (n.endsWith(cut) && adapter.isKnownItem(n.slice(0, -cut.length))) return n.slice(0, -cut.length); // torches → torch
  return null;
}

/** 按背包里的材料挑颜色/木种：有 3 个红羊毛就做 red_bed，手里是云杉原木就做 spruce_planks */
export function pickVariant(item: string, inv: { name: string; count: number }[]): string {
  const count = (n: string) => inv.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  const color = COLORS.find((c) => item.startsWith(c + '_') && COLORED.includes(item.slice(c.length + 1)));
  if (color && item.endsWith('_bed') && count(`${color}_wool`) < 3) {
    const alt = COLORS.find((c) => count(`${c}_wool`) >= 3);
    if (alt) return `${alt}_bed`;
  }
  const wood = WOODS.find((w) => item.startsWith(w + '_') && WOODEN.includes(item.slice(w.length + 1)));
  if (wood && item.endsWith('_planks') && count(`${wood}_log`) === 0) {
    const alt = WOODS.map((w) => [w, count(`${w}_log`) + count(`${w}_stem`)] as const).sort((a, b) => b[1] - a[1])[0];
    if (alt && alt[1] > 0) return `${alt[0]}_planks`;
  }
  return item;
}

/** 常见木制/石制物品折合多少块木板（木棍按半块木板算）和圆石 */
const WOOD_COST: Record<string, { planks: number; cobble?: number; table: boolean }> = {
  crafting_table: { planks: 4, table: false }, stick: { planks: 0.5, table: false }, chest: { planks: 8, table: true },
  wooden_pickaxe: { planks: 4, table: true }, wooden_axe: { planks: 4, table: true }, wooden_shovel: { planks: 2, table: true },
  wooden_hoe: { planks: 3, table: true }, wooden_sword: { planks: 2.5, table: true },
  stone_pickaxe: { planks: 1, cobble: 3, table: true }, stone_axe: { planks: 1, cobble: 3, table: true }, stone_shovel: { planks: 1, cobble: 1, table: true },
  stone_hoe: { planks: 1, cobble: 2, table: true }, stone_sword: { planks: 0.5, cobble: 2, table: true }, furnace: { planks: 0, cobble: 8, table: true },
  torch: { planks: 0.5, table: false },
};
/** 用玩家的算法说清楚“还差多少”：木镐要 4 块木板的料，工作台还要 4 块；1 块原木 = 4 块木板 */
export function woodShortfall(item: string, count: number, inv: { name: string; count: number }[], tableNearby: boolean): string | null {
  const cost = WOOD_COST[item];
  if (!cost) return null;
  const have = (pred: (n: string) => boolean) => inv.filter((i) => pred(i.name)).reduce((a, i) => a + i.count, 0);
  const planksHave = have((n) => n.endsWith('_planks')) + 4 * have((n) => /_(log|stem|wood|hyphae)$/.test(n)) + have((n) => n === 'stick') / 2;
  const tableNeeded = cost.table && !tableNearby && have((n) => n === 'crafting_table') === 0;
  const planksNeed = cost.planks * count + (tableNeeded ? 4 : 0);
  const cobbleNeed = (cost.cobble ?? 0) * count, cobbleHave = have((n) => n === 'cobblestone' || n === 'cobbled_deepslate' || n === 'blackstone');
  const parts: string[] = [];
  if (planksHave < planksNeed) parts.push(`木料还差约 ${Math.ceil((planksNeed - planksHave) / 4)} 块原木（需要约 ${planksNeed} 块木板${tableNeeded ? '，其中 4 块用来做工作台' : ''}，现有折合 ${Math.floor(planksHave)} 块）`);
  if (cobbleHave < cobbleNeed) parts.push(`圆石还差 ${cobbleNeed - cobbleHave} 块`);
  return parts.length ? parts.join('；') : null;
}

export const craft: Skill<{ item: string; count: number }> = {
  name: 'craft',
  description: '合成物品。会自动补做两层以内的前置材料（原木→木板→木棍）、自动使用记得的工作台或现做一个放下，所以直接写最终物品即可。常用：wooden_pickaxe、stone_pickaxe、furnace、torch、crafting_table',
  argsDoc: '{"item": "<物品名>", "count"?: 1-64}',
  timeoutMs: 60000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const raw0 = String(a.item ?? '').trim().replace(/^minecraft:/, '');
    const item = resolveItemAlias(raw0, adapter);
    if (!item) return { ok: false, error: `未知物品：${raw0}（请用完整物品 ID，如 white_bed、oak_planks）` };
    return { ok: true, args: { item, count: clampInt(a.count, 1, 64, 1) } };
  },
  async run(ctx, args) {
    args = { ...args, item: pickVariant(args.item, ctx.adapter.state().inventory) };
    try {
      // 先用看得见或记得的工作台（自己放过的也算），附近没有才让底层现做一个
      const table = findStation(ctx, ['crafting_table'], 48);
      const conflict = craftReservationConflict(ctx.memory, ctx.adapter.state(), args.item, args.count, config.mc.version, !!table);
      if (conflict) return fail('MISSING_MATERIALS', `预留保护：${conflict.reason}`, { conflict });
      const r = await ctx.adapter.craft(args.item, args.count, ctx.signal, { tablePos: table?.pos });
      if (r.tablePos) rememberStation(ctx, 'crafting_table', r.tablePos);
      const reused = table && r.tablePos && dist3(table.pos, r.tablePos) < 1 && table.dist > 4 ? `（用了 ${table.dist} 格外${table.from === 'memory' ? '记得' : '看到'}的工作台）` : '';
      if (!r.ok) {
        const short = woodShortfall(args.item, args.count, ctx.adapter.state().inventory, !!table);
        const why = [r.detail, short].filter(Boolean).join('；');
        return fail((r.reason as any) ?? 'ERROR', `无法合成 ${args.item}：${r.reason}${why ? `（${why}）` : ''}${reused}`, why ? { shortfall: why } : undefined);
      }
      return ok(`合成了 ${r.crafted} 个 ${args.item}${reused}`, { crafted: r.crafted });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `合成 ${args.item} 出错：${(e as Error).message}`);
    }
  },
};

// ------------------------------------------------------------------ eat
export const eat: Skill<{}> = {
  name: 'eat',
  description: '吃背包里最好的食物，一直吃到饱（饱食度 18 以上才会自然回血）',
  argsDoc: '{}',
  timeoutMs: 20000,
  movement: false,
  validate() {
    return { ok: true, args: {} };
  },
  async run(ctx) {
    if (!ctx.adapter.hasFood()) return fail('NO_FOOD', '背包里没有可吃的食物');
    try {
      // 像人一样一次吃饱：饱食度到 18 以上（能自然回血）或吃完为止，而不是吃一口就走、过一会儿又被饿意打断
      let bites = 0;
      do {
        const before = ctx.adapter.state().food;
        await ctx.adapter.eat(ctx.signal);
        bites++;
        if (ctx.adapter.state().food <= before) break; // 吃不进去（满了或食物无效）
      } while (bites < 6 && ctx.adapter.state().food < 18 && ctx.adapter.hasFood() && Date.now() < ctx.deadline - 2500);
      return ok(`进食完成（吃了 ${bites} 次），饥饿值 ${ctx.adapter.state().food}`, { bites });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `进食失败：${(e as Error).message}`);
    }
  },
};

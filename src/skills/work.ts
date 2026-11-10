import { chestHint, needsFromShortfall } from './chest-hint.ts';
import { canAcceptItem, describePlan, dropItemsOf, materialPlan } from '../methods/shortfall.ts';
import { lookAround, noteFruitlessSearch, repeatSearchNote } from './movement.ts';
import { findStation, myBed, rememberStation } from './stations.ts';
import { classifyBlock, MAN_MADE_NOTE, ownBuildingAt } from './build.ts';
import { AbortedError, dist3, sleep } from '../util.ts';
import { codeFromError, clampInt, fail, isAbort, obj, ok, type Skill, type SkillCtx, type SkillResult } from './types.ts';
import { craftReservationConflict } from '../projects/reservations.ts';
import { isResourceBlock, oreSpotsNear } from '../memory/ore-spots.ts';
import { config } from '../config.ts';
import { FOOD_VALUE, foodNote } from './food.ts';
import { ITEM_ZH } from '../observer/item-zh.ts';
import type { InvItem } from '../adapter/types.ts';

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

// ------------------------------------------------------------------ gather
/** 常常就在脚下的方块：看不见别处的时候提一句脚下踩着的是不是它 */
const UNDERFOOT = new Set(['stone', 'cobblestone', 'deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'dirt', 'grass_block', 'coarse_dirt', 'sand', 'gravel', 'clay']);
const WATERY = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column', 'lava']);
/** 木头/树叶这类长在地面上的东西不怕挨着水；石头矿石这类往往在坑底、洞里，挨着水就容易一路走进水下 */
const isTreeTarget = (name: string) => /_log$|_stem$|_wood$|_hyphae$|_leaves$|mushroom_block$/.test(name);
/** 石头、深板岩、矿石：多在坑底/洞里，挨着水就危险。沙子黏土沙砾泥土甘蔗本来就长在水边，不按“挨水”跳过 */
const isStoneLike = (name: string) => /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|granite|diorite|tuff|calcite|blackstone|basalt|netherrack|obsidian)$|_ore$|^raw_.*_block$|^ancient_debris$/.test(name);

export type TargetRisk = 'hazard' | 'wet' | 'deep';
/**
 * 采集目标的安全检查（只看目标身边的方块：走到跟前就看得见、摸得着，不算透视）：
 * - hazard：在出过事（淹死/掉岩浆）的危险区域里
 * - wet：石头类目标贴着水/岩浆，或者站过去挖它的位置泡在水里（要潜到水面以下才挖得到）
 * - deep：目标比脚下低很多、附近又有水（往下走多半是进了被水淹的洞穴/峡谷）
 */
export function gatherTargetRisk(ctx: SkillCtx, target: { name: string; pos: { x: number; y: number; z: number } }, feetY: number): TargetRisk | null {
  const { adapter, memory } = ctx;
  const dim = adapter.state().dim;
  // 树长在水面以上，站在地上就砍得到：不按危险区域/挨水跳过
  if (isTreeTarget(target.name)) return null;
  if (memory.hazardAt?.(target.pos, dim, ['drowning', 'lava'])) return 'hazard';
  if (!isStoneLike(target.name)) return null;
  const at = (dx: number, dy: number, dz: number) => adapter.blockAt({ x: target.pos.x + dx, y: target.pos.y + dy, z: target.pos.z + dz }) ?? 'air';
  // 六个面贴着液体：一挖开就灌水/流岩浆
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (WATERY.has(at(dx, dy, dz))) return 'wet';
  // 站位：目标旁边（含上方两层）是水 → 得泡在水里挖
  let water = 0;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 3; dy++) {
    if (!WATERY.has(at(dx, dy, dz))) continue;
    water++;
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && dy >= 1 && dy <= 2) return 'wet';
  }
  if (water && target.pos.y < feetY - 4) return 'deep';
  return null;
}

/**
 * 走着走着进了水的目标：这次采集里不再去，10 分钟内其他采集也绕开（按世界/维度/坐标记）。
 * 这是“亲身走过去发现要下水”的经验，不是透视。
 */
const wetApproach = new Map<string, number>();
const WET_TTL_MS = 10 * 60_000;
/** 同一站位刚确认够不着的目标，短时间内换别的；走开后可以从新方向再试。 */
const unreachableTargets = new WeakMap<SkillCtx['adapter'], Map<string, { at: number; from: { x: number; y: number; z: number }; block: string }>>();
const UNREACHABLE_TTL_MS = 2 * 60_000;
const wetKey = (ctx: SkillCtx, p: { x: number; y: number; z: number }) => { const s = ctx.adapter.state(); return `${s.worldId}:${s.dim}:${p.x},${p.y},${p.z}`; };
function wetRemembered(ctx: SkillCtx, p: { x: number; y: number; z: number }) {
  const t = wetApproach.get(wetKey(ctx, p));
  if (t === undefined) return false;
  if (Date.now() - t > WET_TTL_MS) { wetApproach.delete(wetKey(ctx, p)); return false; }
  return true;
}
/** 把这个目标和它周围 4 格内的同类目标都记成“要下水才挖得到” */
function rememberWet(ctx: SkillCtx, p: { x: number; y: number; z: number }) {
  for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) wetApproach.set(wetKey(ctx, { x: p.x + dx, y: p.y + dy, z: p.z + dz }), Date.now());
  if (wetApproach.size > 20000) for (const [k, t] of wetApproach) if (Date.now() - t > WET_TTL_MS) wetApproach.delete(k);
}

/** 挖这种方块至少要什么镐子（null = 不需要镐子） */
export function pickaxeTierFor(block: string): string | null {
  if (/^(obsidian|crying_obsidian|ancient_debris|netherite_block|respawn_anchor)$/.test(block)) return 'diamond';
  if (/(gold|diamond|redstone|emerald)_(ore|block)$/.test(block)) return 'iron';
  if (/(iron|copper|lapis)_(ore|block)$|^raw_(iron|copper)_block$/.test(block)) return 'stone';
  if (/^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|granite|diorite|tuff|calcite|sandstone|red_sandstone|blackstone|basalt|netherrack|end_stone|terracotta|bricks|furnace|.*_terracotta|.*_concrete)$|coal_(ore|block)$|nether_(gold|quartz)_ore$|^stone_bricks$/.test(block)) return 'wooden';
  return null;
}

/**
 * 挖不动时像玩家一样先想办法：缺的是木镐、背包里木料够 → 先做一把木镐（会用附近的工作台或现做一个）；
 * 否则说清楚缺哪一级的镐子。ok=true 表示现在能挖了。
 */
export async function ensureToolFor(ctx: SkillCtx, pos: { x: number; y: number; z: number }): Promise<{ ok: true; crafted?: string } | { ok: false; message: string }> {
  const { adapter } = ctx;
  if (adapter.canHarvest(pos)) return { ok: true };
  const block = adapter.blockAt(pos) ?? '?';
  const tier = pickaxeTierFor(block);
  const inv = adapter.state().inventory;
  const woodShort = woodShortfall('wooden_pickaxe', 1, inv, !!findStation(ctx, ['crafting_table'], 48));
  if (ctx.make === true && tier === 'wooden' && !woodShort) {
    ctx.progress(0, `挖 ${block} 要镐子：先做一把木镐`);
    const r = await craft.run(ctx, { item: 'wooden_pickaxe', count: 1 });
    if (r.status === 'succeeded' && adapter.canHarvest(pos)) return { ok: true, crafted: 'wooden_pickaxe' };
    return { ok: false, message: `手上没有能挖 ${block} 的镐子（需要 wooden_pickaxe 以上）；试着做木镐没成：${r.summary}` };
  }
  if (!tier) return { ok: false, message: `手上的工具挖不了 ${block}` };
  const hasWood = inv.some((i) => /_(log|planks|stem)$/.test(i.name) && i.count > 0);
  const hasCobble = inv.some((i) => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name) && i.count >= 3);
  const hint = tier === 'wooden' ? (!woodShort ? '背包有足够木料，可先显式 craft wooden_pickaxe' : hasWood ? `背包有木料但不够（${woodShort}）` : '先砍点木头做 wooden_pickaxe')
    : tier === 'stone' ? (hasCobble ? '背包有圆石，可以先 craft stone_pickaxe' : '先挖 3 块圆石做 stone_pickaxe')
    : `先做 ${tier}_pickaxe`;
  return { ok: false, message: `手上没有能挖 ${block} 的镐子（需要 ${tier}_pickaxe 以上）；${hint}` };
}

/** 走向目标方块；8 秒内几乎没挪动就放弃这个目标（换下一个），而不是原地耗到被判卡死；走着走着进了水也立刻停（ENTERED_WATER） */
async function moveWithWatchdog(ctx: SkillCtx, pos: { x: number; y: number; z: number }) {
  const stop = new AbortController();
  const dryStart = !ctx.adapter.state().inWater;
  let anchor = ctx.adapter.state().pos, since = Date.now();
  const iv = setInterval(() => {
    if (dryStart && inDeepWater(ctx)) { stop.abort('entered_water'); return; }
    const p = ctx.adapter.state().pos;
    if (Math.hypot(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z) >= 0.6) { anchor = p; since = Date.now(); }
    else if (Date.now() - since >= 8000) stop.abort('no_progress');
  }, 500);
  try {
    await ctx.adapter.moveTo({ kind: 'reach_block', pos }, { signal: AbortSignal.any([ctx.signal, stop.signal]), timeoutMs: Math.min(90000, Math.max(3000, ctx.deadline - Date.now())) });
  } catch (e) {
    if (stop.signal.aborted && !ctx.signal.aborted) throw new Error(stop.signal.reason === 'entered_water' ? 'ENTERED_WATER' : 'PATH_NO_PROGRESS');
    throw e;
  } finally {
    clearInterval(iv);
  }
  // 路走完了人却在水里（寻路一路游过去的）：同样算“要下水才够得着”
  if (dryStart && inDeepWater(ctx)) throw new Error('ENTERED_WATER');
}

/** 真的“下了水”：头没进水、只是蹚过一格深的小水洼/小溪不算；头在水里、脚下水有两格深、或开始憋气才算 */
function inDeepWater(ctx: SkillCtx): boolean {
  const s = ctx.adapter.state();
  if (!s.inWater) return false;
  const x = Math.floor(s.pos.x), z = Math.floor(s.pos.z), feet = Math.floor(s.pos.y);
  const water = (y: number) => WATERY.has(ctx.adapter.blockAt({ x, y, z }) ?? 'air');
  return water(Math.floor(s.pos.y + 1.62)) || (water(feet) && water(feet - 1)) || s.oxygen < 20;
}

export const gather: Skill<{ block: string; count: number; for?: { item: string; count: number }; note?: string; dig?: boolean }> = {
  name: 'gather',
  description: '前往【看见过或正看见】的指定方块并挖掘、拾取。count 是采到背包里一共有多少个（先扣掉已有的，只采缺口）；写 for（要做的东西和数量）时按配方算缺多少原材料，已经够了就不采；看不见的不会去挖（没有透视），也不会自己往下挖。block 可用别名：log(任意原木)、stone、dirt、coal、iron、ore',
  argsDoc: '{"block": "log|stone|coal|iron|<方块名>", "count"?: 1-32（目标总数，会扣掉背包已有的）, "for"?: {"item":"要做的东西（物品 ID）","count":1} | "物品名", "dig"?: true（路上挡着的土石挖穿、垫方块过去）}',
  timeoutMs: 180000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const block = String(a.block ?? '').trim();
    if (!block) return { ok: false, error: 'block 不能为空' };
    if (!adapter.resolveBlockNames(block).length) return { ok: false, error: `未知方块：${block}` };
    let goal: { item: string; count: number } | undefined;
    let note: string | undefined;
    if (a.for !== undefined && a.for !== null && a.for !== '') {
      const f = typeof a.for === 'string' ? { item: a.for } : obj(a.for);
      const m = String(f.item ?? '').trim().replace(/^minecraft:/, '').match(/^([a-z0-9_]+)(?:\s*[x×*]\s*(\d+))?$/);
      const item = m ? resolveItemAlias(m[1], adapter) : null;
      // 不认识的 for（比如写了中文“小木屋木料”）不让整个计划作废：去掉 for，按 block/count 照常采
      if (!item) note = `for 里的「${String(f.item ?? a.for).slice(0, 40)}」不是物品 ID，已忽略，按 count 采`;
      else goal = { item, count: clampInt(f.count ?? (m?.[2] ? Number(m[2]) : undefined), 1, 512, 1) };
    }
    return { ok: true, args: { block, count: clampInt(a.count, 1, 32, 4), ...(goal ? { for: goal } : {}), ...(note ? { note } : {}), ...(a.dig === true ? { dig: true } : {}) } };
  },
  async run(ctx, args) {
    const r = await gatherRun(ctx, args);
    return args.note ? { ...r, summary: `${r.summary}（${args.note}）` } : r;
  },
};

async function gatherRun(ctx: SkillCtx, args: { block: string; count: number; for?: { item: string; count: number }; dig?: boolean }): Promise<SkillResult> {
  {
    const { adapter, senses, signal } = ctx;
    let names = adapter.resolveBlockNames(args.block);
    let drops = new Set(names.flatMap((n) => dropItemsOf(n)));
    // 采到背包里的目标物：count 模式是这些方块的实际掉落物；for 模式是配方真正缺的原材料。
    let targetItems = [...drops];
    let target = args.count;
    let initial = 0;
    const held = () => adapter.state().inventory.filter((i) => targetItems.includes(i.name)).reduce((a, i) => a + i.count, 0);
    const receipt = (dug: number, lost = 0) => {
      const final = held();
      return { block: args.block, items: targetItems, initial, target, final, gained: final - initial, dug, targetMet: final >= target,
        ...(lost ? { lost } : {}) };
    };
    const itemsLabel = (items: string[]) => items.length <= 3 ? items.join('/') : `${items.slice(0, 3).join('/')} 等 ${items.length} 种`;
    const briefly = (r: ReturnType<typeof receipt>) =>
      `${itemsLabel(r.items)} ${r.initial}→${r.final}（目标 ${r.target}${r.targetMet ? '，已达成' : '，未达成'}；实得 +${r.gained}，挖了 ${r.dug} 块 ${r.block}${r.lost ? `，${r.lost} 块掉落物没捡到` : ''}）`;
    // 先算账：要做的东西还差多少原材料，其中多少要从这种方块里来
    if (args.for) {
      const plan = materialPlan(args.for.item, args.for.count, adapter.state().inventory);
      const mine = plan.raw.filter((r) => names.includes(r.item) || r.from.some((b) => names.includes(b)) || (r.anyWood && names.some((n) => n.endsWith('_log'))));
      const need = mine.reduce((a, r) => a + r.count, 0);
      initial = held();
      if (!need) {
        target = initial;
        const r = receipt(0);
        return plan.enough ? ok(`不用采了：${describePlan(plan)}；${briefly(r)}`, { needed: 0, plan, collection: r })
          : fail('BAD_ARGS', `做 ${args.for.item}×${args.for.count} 不缺 ${args.block}；${describePlan(plan)}；${briefly(r)}`, { plan, collection: r });
      }
      args = { ...args, count: Math.min(64, need) };
      // 只采真正缺的那种（做桦木门就砍桦木，别砍橡木）
      const wanted = names.filter((n) => mine.some((r) => r.item === n || r.from.includes(n) || (r.anyWood && n.endsWith('_log'))));
      if (wanted.length) names = wanted;
      drops = new Set(names.flatMap((n) => dropItemsOf(n)));
      // 目标物按配方的原材料名计；哪种原木都行时把各种原木合计。
      targetItems = [...new Set(mine.flatMap((r) => r.anyWood ? [...drops].filter((i) => i.endsWith('_log')) : [r.item]))];
      if (!targetItems.length) targetItems = [...drops];
      initial = held();
      target = initial + args.count;
      ctx.progress(0, `${describePlan(plan)}：先采 ${args.block}×${args.count}`);
    } else {
      // 不写 for：count 是"要采到多少"（背包里这类掉落物的总数），不是"再采多少"
      initial = held();
      if (initial >= target) {
        const r = receipt(0);
        return ok(`不用再采：${briefly(r)}`, { collection: r });
      }
    }
    const canDigDown = names.some((n) => UNDERFOOT.has(n));
    const skip = new Set<string>();
    let unreachable = unreachableTargets.get(adapter);
    if (!unreachable) { unreachable = new Map(); unreachableTargets.set(adapter, unreachable); }
    for (const [k, failed] of unreachable) if (Date.now() - failed.at > UNREACHABLE_TTL_MS) unreachable.delete(k);
    const skippedUnreachable = new Set<string>();
    // dug 是实际挖掉的方块数；返回的顶层 data.dug 沿用旧语义 = dug - lost（确实计入目标物品的采集块数，
    // recordOf 用它判断是否 acquired），collection.dug 才是实际挖掉块数。
    let dug = 0;
    let manMade = 0;
    let failsInRow = 0;
    let underNote = '';
    let searched = false, fruitlessHere = 1;
    let lost = 0;
    const risky: Record<TargetRisk, number> = { hazard: 0, wet: 0, deep: 0 };
    const riskCache = new Map<string, TargetRisk | null>();
    const riskNote = () => {
      const parts = [risky.hazard ? `${risky.hazard} 处在出过事的危险区域` : '', risky.wet ? `${risky.wet} 处挨着水/岩浆或要泡在水里挖` : '', risky.deep ? `${risky.deep} 处在脚下很深、旁边有水的地方` : ''].filter(Boolean);
      return parts.length ? `；为安全跳过了 ${parts.join('、')} 的 ${args.block}（换个干燥、露天的地方采）` : '';
    };
    const progressNow = (note: string) => ctx.progress(Math.min(1, Math.max(0, (held() - initial) / Math.max(1, target - initial))), note);
    // 移动/挖掘/拾取被取消或报错时保留当前采集回执。productiveDug 沿用顶层 data.dug 的旧语义，
    // collection.dug 仍是实际挖掉的块数；不把没进背包的当前方块算成已取得。
    const attachPartial = (error: unknown, productiveDug: number) => {
      if (!error || typeof error !== 'object') return;
      const target = error as Error & { partial?: Record<string, unknown> };
      const previous = target.partial && typeof target.partial === 'object' ? target.partial : {};
      target.partial = { ...previous, dug: productiveDug, ...(lost ? { lost } : {}), collection: receipt(dug, lost) };
    };
    ctx.progress(0, `采集 ${args.block} x${args.count}`);
    const ownSkipped = new Set<string>();
    while (held() < target) {
      const s = adapter.state();
      if (!s.connected) return fail('NOT_CONNECTED', `连接断开；${briefly(receipt(dug, lost))}`, { collection: receipt(dug, lost) });
      if (![...drops].some((item) => canAcceptItem(s.inventory, s.emptySlots, item))) {
        const r = receipt(dug, lost);
        return held() > initial ? ok(`背包已满，${briefly(r)}`, { dug: dug - lost, collection: r }) : fail('INVENTORY_FULL', `背包已满；${briefly(r)}`, { collection: r });
      }
      senses.refresh();
      const feetY = Math.floor(s.pos.y);
      const candidates = senses
        .knownBlocks(names, 256)
        .filter((h) => !skip.has(key(h.pos)))
        .filter((h) => {
          const k = `${s.worldId}:${s.dim}:${key(h.pos)}`, failed = unreachable.get(k);
          if (!failed || failed.block !== h.name || dist3(failed.from, s.pos) >= 3) return true;
          skippedUnreachable.add(key(h.pos));
          return false;
        })
        // 自己盖的房子的墙、屋顶、地板不当原料（拆了 build 又要补：拆东墙补西墙）
        .filter((h) => { if (!ownBuildingAt(ctx.memory, s, h.pos, h.name)) return true; ownSkipped.add(key(h.pos)); return false; })
        // 水下（上方是水）的方块不去挖：会憋气溺水
        .filter((h) => !WATERY.has(adapter.blockAt({ x: h.pos.x, y: h.pos.y + 1, z: h.pos.z }) ?? 'air'))
        // 比脚下低的目标多扣分：宁可挖身边露天的，也不往坑底/水边钻
        // 高过头顶够不着的（树冠里的原木）也多扣分：像人一样先砍树干根部
        .sort((a, b) => {
          const cost = (h: typeof a) => h.dist + Math.abs(h.pos.y - s.pos.y) * 0.6 + Math.max(0, s.pos.y - h.pos.y - 2) + Math.max(0, h.pos.y - s.pos.y - 2) * 2.5;
          return cost(a) - cost(b);
        });
      // 安全检查按远近逐个做，找到第一个能挖的就停（每轮最多查 24 个；同一位置的结论本次采集内缓存）
      const safeHits: typeof candidates = [];
      let evaluated = 0;
      for (const h of candidates) {
        if (evaluated >= 24) break;
        const k = key(h.pos);
        let risk = riskCache.get(k);
        if (risk === undefined) { evaluated++; risk = wetRemembered(ctx, h.pos) ? 'wet' : gatherTargetRisk(ctx, h, feetY); riskCache.set(k, risk); }
        if (risk) { risky[risk]++; skip.add(k); continue; }
        safeHits.push(h);
        if (adapter.blockAt(h.pos) === h.name && adapter.canHarvest(h.pos)) break;
      }
      // 这一批全不安全，但后面还有没查过的：下一轮接着查，不要当成“看不见”
      if (!safeHits.length && candidates.some((h) => !skip.has(key(h.pos)))) continue;
      const hits = safeHits;

      if (!hits.length) {
        if (skippedUnreachable.size && !candidates.length) {
          const r = receipt(dug, lost);
          return held() > initial
            ? ok(`${briefly(r)}；其余 ${skippedUnreachable.size} 处刚确认无法到达或够不着，先换个站位再采`, { dug: dug - lost, skippedUnreachable: skippedUnreachable.size, collection: r })
            : fail('PATH_NOT_FOUND', `${briefly(r)}；${skippedUnreachable.size} 处 ${args.block} 刚确认无法到达或够不着，同一站位暂不重复尝试；先换个方向走至少 3 格，或稍后再试`, { skippedUnreachable: skippedUnreachable.size, collection: r });
        }
        // 看不见目标：不替它决定往下挖（直上直下挖是最危险的挖法），只说脚下踩着的是什么，挖不挖、往哪挖由它定
        if (canDigDown && !underNote) {
          const under = adapter.blockAt({ x: Math.floor(s.pos.x), y: Math.floor(s.pos.y) - 1, z: Math.floor(s.pos.z) });
          if (under && names.includes(under)) underNote = `；脚下踩着的就是 ${under}（要挖自己用 mine_cell，往下挖小心掉进洞里或岩浆）`;
        }
        // 眼前没有了就转头找找（砍完一棵树，人会四下看看下一棵在哪），每次采集只找一次
        if (!searched && !s.inWater) {
          searched = true;
          progressNow(`四下找找还有没有 ${args.block}`);
          const r = await lookAround.run(ctx, { seconds: 3, for: args.block });
          if (r.status === 'succeeded') continue;
          fruitlessHere = Number(r.data?.searchedHere ?? 1);
        }
        // 没找到不证明原地点已消失；只有实际看见变化或亲手拆除才能作废。
        const unconfirmed = ctx.memory.resourceLandmarksNear(names, s.dim, s.pos, 5);
        const staleNote = unconfirmed.length ? `；附近 ${unconfirmed.length} 处历史 ${args.block} 地点尚未重新确认，保留线索` : '';
        const looked = searched ? '（已转头找过）' : '';
        // 转头找过的那次 look_around 已记下“这里没找到”；没转头（在水里）时这里补记一次。
        const times = searched ? fruitlessHere : noteFruitlessSearch(ctx, args.block);
        const skipped = risky.hazard + risky.wet + risky.deep;
        const ownNote = ownSkipped.size ? `；另有 ${ownSkipped.size} 块是自己房子上的，没拆（拆了还得补）` : '';
        const manMadeNote = manMade ? `；其中 ${manMade} 块${MAN_MADE_NOTE}` : '';
        const manMadeCaveat = manMade ? `采集到的 ${manMade} 块 ${args.block} 是人造建材，可能是村庄或别人房子的一部分（不是自然地形，也不是你的矿道）；拆了可能破坏建筑，拆不拆你自己定` : undefined;
        // 眼前看不见时只查询附近 256 格：不能说“长期记忆里没记过”，因为更远处
        // 的资源没有进入本次查询。否定结论必须写明本次覆盖半径和未知范围。
        const spots = names.some((n) => isResourceBlock(n))
          ? oreSpotsNear(ctx.memory.resourceLandmarksAround(s.dim, s.pos, 256), { worldId: s.worldId, dim: s.dim, pos: s.pos }, { only: names, excludeWithin: 6 }).slice(0, 3)
          : [];
        const remembered = spots.length
          ? `；不过记得别处有 ${args.block}：${spots.map((o) => o.text).join('；')}——要去就先用 travel_to 走到跟前再 gather`
          : !unconfirmed.length && isResourceBlock(args.block)
            ? `；附近 256 格内也没记过哪里有 ${args.block}（更远处未查询，不代表其他地点没有）`
            : '';
        const r = receipt(dug, lost);
        return held() > initial
          ? ok(`看不到更多 ${args.block}${looked}，${briefly(r)}${ownNote}${manMadeNote}${staleNote}${riskNote()}${remembered}${underNote}`, { searched, dug: dug - lost, ...(skipped ? { skippedUnsafe: { ...risky } } : {}), collection: r }, manMadeCaveat)
          : fail('NOT_FOUND', `未达成：${briefly(r)}；${skipped
            ? `能看见的 ${args.block} 都不安全，没有去挖${riskNote()}${looked}${staleNote}`
            : ownSkipped.size ? `附近能看到的 ${args.block} 都是自己房子上的（${ownSkipped.size} 块），拆了还得补，没去挖；要去别处找${staleNote}`
            : `眼前看不见 ${args.block}${looked}${staleNote}${remembered || '；尚未定位该资源，不代表其他地点也没有'}${underNote}${remembered ? '' : repeatSearchNote(args.block, times)}`}`, {
              searched, searchedHere: times, coverage: { mode: 'seen_or_remembered', knownRadius: 256, unknownBeyond: true },
              ...(spots.length ? { remembered: spots.map((o) => o.pos) } : {}), ...(skipped ? { skippedUnsafe: { ...risky } } : {}), collection: r,
            });
      }
      // 记忆里的方块可能已经被砍掉/不在加载范围：这种目标跳过，不能误报成“缺工具”
      const present = hits.filter((h) => adapter.blockAt(h.pos) === h.name);
      for (const h of hits) if (!present.includes(h)) skip.add(key(h.pos));
      if (!present.length) continue;
      let pick = present.find((h) => adapter.canHarvest(h.pos));
      if (!pick) {
        const tool = await ensureToolFor(ctx, present[0].pos);
        if (!tool.ok) {
          const r = receipt(dug, lost);
          return fail('TOOL_MISSING', `${tool.message}；${briefly(r)}`, { block: present[0].name, collection: r });
        }
        pick = present[0];
      }

      let before = 0;
      if (classifyBlock(ctx.memory, s, pick.pos, pick.name) === 'man-made') manMade++;
      try {
        progressNow(`前往 ${pick.name}（${Math.round(pick.dist)} 格）`);
        await moveWithWatchdog(ctx, pick.pos);
        // 路上可能已经捡到目标物品（走过掉落物）：先核对目标，再决定还要不要挖这一块。
        if (held() >= target) { progressNow(`路上已经拿到足够 ${itemsLabel(targetItems)}，不再挖 ${pick.name}`); continue; }
        before = held();
        const r = await adapter.dig(pick.pos, signal);
        if (!r.ok) throw new Error(r.reason ?? 'DIG_FAILED');
      } catch (e) {
        if (isAbort(e)) { attachPartial(e, Math.max(0, dug - lost)); throw e; }
        skip.add(key(pick.pos));
        if (String((e as Error).message).includes('OUT_OF_REACH') || codeFromError(e) === 'PATH_NOT_FOUND' || String((e as Error).message) === 'PATH_NO_PROGRESS') {
          const failedAt = adapter.state();
          unreachable.set(`${failedAt.worldId}:${failedAt.dim}:${key(pick.pos)}`, { at: Date.now(), from: { ...failedAt.pos }, block: pick.name });
        }
        if ((e as Error).message === 'ENTERED_WATER') {
          rememberWet(ctx, pick.pos);
          risky.wet++;
          adapter.stopAll();
          const current = adapter.state();
          const r = receipt(dug, lost);
          return fail('PATH_NOT_FOUND', `前往 ${pick.name} 时进入水中，已停止采集；${briefly(r)}，氧气 ${current.oxygen}/20`,
            { dug: dug - lost, target: pick.pos, pos: current.pos, inWater: current.inWater, oxygen: current.oxygen, collection: r });
        }
        if (++failsInRow >= 4) {
          const r = receipt(dug, lost);
          return held() > initial
            ? ok(`多次失败后停止，${briefly(r)}`, { dug: dug - lost, collection: r })
            : fail(codeFromError(e) === 'ERROR' ? 'PATH_NOT_FOUND' : codeFromError(e), `无法到达或挖掘 ${args.block}：${(e as Error).message}${args.dig ? '' : '；路上是土石坡坎挡着就加 "dig":true（挖穿、垫方块过去）'}；${briefly(r)}`, { collection: r });
        }
        continue;
      }
      failsInRow = 0;
      dug++;
      progressNow(`采集 ${args.block}：${briefly(receipt(dug, lost))}`);
      try {
        await adapter.collectNearbyDrops(signal, 6, 3000);
        // 捡完再核对：挖掉了但目标物品没进背包（掉进水里、卡在角落、掉落的是别的物品）就不算数
        if (held() <= before) await adapter.collectNearbyDrops(signal, 8, 2500);
      } catch (e) {
        // 拾取超时/取消不吞掉：保留原错误语义并挂上当前回执。当前块若没把目标物品装进背包，
        // legacy dug 不把它算成产出；collection 仍如实报告实际挖掉了几块。
        attachPartial(e, Math.max(0, dug - lost - (held() > before ? 0 : 1)));
        throw e;
      }
      if (held() <= before) {
        lost++;
        progressNow(`${args.block} 的目标掉落物没捡到`);
        if (lost >= 3) {
          const r = receipt(dug, lost);
          return held() > initial
            ? ok(`${briefly(r)}；另有 ${lost} 块挖掉后目标物品没进背包（可能掉进水里或够不着）`, { dug: dug - lost, lost, collection: r })
            : fail('ERROR', `挖掉了 ${lost} 块 ${args.block} 但目标物品都没进背包（可能掉进水里或够不着），换个干燥、好走的地方再挖；${briefly(r)}`, { dug: dug - lost, lost, collection: r });
        }
        continue;
      }
    }
    const after = args.for ? materialPlan(args.for.item, args.for.count, adapter.state().inventory) : null;
    const r = receipt(dug, lost);
    return ok(`${briefly(r)}${after ? `；${describePlan(after)}` : ''}${riskNote()}`, { dug: dug - lost, ...(lost ? { lost } : {}), ...(after ? { plan: after } : {}), collection: r });
  }
}

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
  boat: { planks: 5, table: true }, raft: { planks: 5, table: true },
};
/** 用玩家的算法说清楚“还差多少”：木镐要 4 块木板的料，工作台还要 4 块；1 块原木 = 4 块木板 */
export function woodShortfall(item: string, count: number, inv: { name: string; count: number }[], tableNearby: boolean): string | null {
  // 带木种名的船/筏（oak_boat、spruce_boat、bamboo_raft）折成通用键，好查 WOOD_COST
  const key = item.endsWith('_boat') ? 'boat' : item.endsWith('_raft') ? 'raft' : item;
  const cost = WOOD_COST[item] ?? WOOD_COST[key];
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

/**
 * 被打断的合成：取消只是不再等服务器回包，合成请求往往已经发出去、过一会儿就做成了。
 * 记下来，看它到底成没成：成了就说一声；紧接着又要做同一样东西时，先算上它，免得多做一份。
 */
const INTERRUPTED_WINDOW_MS = 60_000;
const interruptedCrafts = new Map<string, { at: number; landed: Promise<number> }>();
const countIn = (inv: { name: string; count: number }[], item: string) => inv.filter((i) => i.name === item).reduce((n, i) => n + i.count, 0);

function watchInterruptedCraft(ctx: SkillCtx, item: string, before: number, settleMs = 5000) {
  const landed = (async () => {
    const end = Date.now() + settleMs;
    let gained = 0;
    for (;;) {
      try { gained = countIn(ctx.adapter.state().inventory, item) - before; } catch { return 0; }
      if (gained > 0 || Date.now() >= end) break;
      await sleep(250);
    }
    if (gained <= 0) return 0;
    const total = countIn(ctx.adapter.state().inventory, item);
    ctx.bus.publish('craft_landed', 'P2', `刚才被打断的合成其实做成了：${item} +${gained}（背包里现在共 ${total} 个）`, { item, count: gained, total });
    return gained;
  })();
  interruptedCrafts.set(item, { at: Date.now(), landed });
}

/** 合成结果里顺带说清现在有多少（身上穿着的也算上）：做不做第二件由它自己定，但得看得见已经有的 */
function haveNote(ctx: SkillCtx, item: string): string {
  const s = ctx.adapter.state();
  const total = countIn(s.inventory, item);
  const worn = s.equipment?.some((e) => e.name === item) ? '，身上还穿着一件' : '';
  return `（背包里现在共 ${total} 个${worn}）`;
}

/** 工具、武器、护甲、盾：材质等级（同一种东西，等级不低于要做的那把就算“已经有了”） */
const TOOL_TIER: Record<string, number> = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };
const ARMOR_TIER: Record<string, number> = { leather: 0, golden: 1, chainmail: 2, iron: 3, diamond: 4, netherite: 5 };
function gearKind(name: string): { kind: string; tier: number } | null {
  let m = name.match(/^(wooden|stone|golden|iron|diamond|netherite)_(sword|pickaxe|axe|shovel|hoe)$/);
  if (m) return { kind: m[2], tier: TOOL_TIER[m[1]] };
  m = name.match(/^(leather|chainmail|golden|iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/);
  if (m) return { kind: m[2], tier: ARMOR_TIER[m[1]] };
  return name === 'shield' ? { kind: 'shield', tier: 0 } : null;
}
/**
 * 要做的工具/武器/护甲，手上已经有同类、等级不低、还经用（剩四分之一以上耐久）的了：多半是忘了自己有。
 * 镐、斧、锹允许多带一把备用；剑、锄、护甲、盾有一件就够。返回说明，没问题返回 null
 */
export function gearAlreadyHeld(item: string, inv: InvItem[], worn: { name: string; durabilityRemaining?: number; durabilityMax?: number }[] = []): string | null {
  const want = gearKind(item);
  if (!want) return null;
  const have: string[] = [];
  let usable = 0;
  for (const i of inv) {
    const g = gearKind(i.name);
    if (!g || g.kind !== want.kind || g.tier < want.tier || i.count <= 0) continue;
    const max = i.durability?.max ?? 0;
    const lefts = i.durabilities?.length ? i.durabilities : Array.from({ length: i.count }, () => i.durability?.left ?? max);
    const ok = max ? lefts.filter((l) => l / max >= 0.25).length : i.count;
    usable += ok;
    have.push(`${i.name}×${i.count}${max ? `（耐久 ${lefts.map((l) => `${l}/${max}`).join('、')}）` : ''}`);
  }
  for (const e of worn) {
    const g = gearKind(e.name);
    if (!g || g.kind !== want.kind || g.tier < want.tier) continue;
    // 穿在身上的也要看耐久：快报废的护甲不能当作“还有件经用的”，否则会挡住修补/更换的决定
    const left = e.durabilityRemaining, max = e.durabilityMax;
    if (left !== undefined && max && left / max < 0.25) continue;
    usable++;
    have.push(`身上穿着的 ${e.name}${left !== undefined && max ? `（耐久 ${left}/${max}）` : ''}`);
  }
  const limit = ['pickaxe', 'axe', 'shovel'].includes(want.kind) ? 2 : 1;
  return usable >= limit ? `已经有 ${have.join('、')}，还经用` : null;
}

/**
 * 装备中文名 → item ID（含“铁靴”这类简称，以及清单里常写的“盾”而不是物品名的“盾牌”）。
 * 按名字从长到短排，扫描时先匹配最长的，避免“钻石剑”被误拆成“石剑”、“下界合金剑”被拆成“金剑”。
 */
const GEAR_ZH: [string, string][] = (() => {
  const m = new Map<string, string>();
  for (const [id, zh] of Object.entries(ITEM_ZH)) {
    if (!gearKind(id)) continue;
    m.set(zh, id);
    if (zh.endsWith('子')) m.set(zh.slice(0, -1), id);
  }
  m.set('盾', 'shield');
  return [...m.entries()].sort((a, b) => b[0].length - a[0].length);
})();

/**
 * 一段清单/想法文字里提到的装备，哪些其实已经拿在手上或穿在身上（同级或更好、还经用）。
 * 给「清单里写着要做铁剑、身上却有钻石剑」这类忘了自己有什么的情况做交叉核对。返回一句话说明，没有返回 null。
 */
export function gearAlreadyHeldInText(text: string, inv: InvItem[], worn: { name: string; durabilityRemaining?: number; durabilityMax?: number }[] = []): string | null {
  const ids = new Set<string>();
  let i = 0;
  while (i < text.length) {
    let advanced = false;
    for (const [zh, id] of GEAR_ZH) {
      if (text.startsWith(zh, i)) { ids.add(id); i += zh.length; advanced = true; break; }
    }
    if (!advanced) i++;
  }
  const held = new Set<string>();
  for (const id of ids) {
    const note = gearAlreadyHeld(id, inv, worn);
    if (note) held.add(note);
  }
  return held.size ? [...held].join('；') : null;
}

export const craft: Skill<{ item: string; count: number; batchSize?: number; extra?: boolean }> = {
  name: 'craft',
  description: '合成指定物品，默认只使用现有材料和已放好的工作台；缺少前置材料或工作台就报告缺口。make:true 显式允许补做两层以内的材料并制造、放置临时工作台，用完收回。count 是本次产物总个数；batchSize 可自主指定每批执行配方的次数（一次配方可能产出多个物品），省略时按材料容量批量执行。',
  argsDoc: '{"item": "<物品名>", "count"?: 1-64, "batchSize"?: 1-64（每批配方次数）, "make"?: true（允许补材料和准备工作台）, "extra"?: true（已有同类设施、床或经用装备仍要再做）}',
  timeoutMs: 60000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const raw0 = String(a.item ?? '').trim().replace(/^minecraft:/, '');
    const item = resolveItemAlias(raw0, adapter);
    if (!item) return { ok: false, error: `未知物品：${raw0}（请用完整物品 ID，如 white_bed、oak_planks）` };
    return { ok: true, args: { item, count: clampInt(a.count, 1, 64, 1), ...(a.batchSize !== undefined ? { batchSize: clampInt(a.batchSize, 1, 64, 64) } : {}), ...(a.extra === true ? { extra: true } : {}) } };
  },
  async run(ctx, args) {
    // 已经有床（背包里，或者放在了某处）还要再做：多半是忘了自己的床。说清楚床在哪；真要第二张写 extra:true
    if (args.item.endsWith('_bed') && !args.extra) {
      const s = ctx.adapter.state();
      const held = s.inventory.find((i) => i.name.endsWith('_bed') && i.count > 0);
      const placed = myBed(ctx.memory, s, (p) => ctx.adapter.blockAt(p));
      if (held) return fail('BAD_ARGS', `背包里已经有 ${held.name} 了，不用再做：天黑（或黄昏）直接 sleep；真要第二张床写 {"item":"${args.item}","extra":true}`);
      if (placed) return fail('BAD_ARGS', `已经有一张自己的床放在 (${placed.pos.x},${placed.pos.y},${placed.pos.z})（${placed.dist} 格外），不用再做：天黑时 sleep 会自己走过去睡；真要第二张床写 {"item":"${args.item}","extra":true}`);
    }
    // 工作台、熔炉也一样：附近就有（看得见或记得的），或者背包里揣着一个，多半是忘了。说清楚在哪；真要再做一个写 extra:true
    if ((args.item === 'crafting_table' || args.item === 'furnace') && !args.extra) {
      const zh = args.item === 'crafting_table' ? '工作台' : '熔炉';
      const use = args.item === 'crafting_table' ? '可先放好工作台，再 craft 要做的东西' : '可先放好熔炉，再 smelt';
      const held = ctx.adapter.state().inventory.find((i) => i.name === args.item && i.count > 0);
      if (held) return fail('BAD_ARGS', `背包里已经有 ${held.count} 个${zh}了，不用再做：${use}；真要再做一个写 {"item":"${args.item}","extra":true}`);
      const near = findStation(ctx, [args.item], 24);
      if (near) return fail('BAD_ARGS', `${near.dist} 格外 (${near.pos.x},${near.pos.y},${near.pos.z}) 就有${zh}${near.from === 'memory' ? '（记得的）' : ''}，不用再做：${use}；真要再做一个写 {"item":"${args.item}","extra":true}`);
    }
    // 工具、武器、护甲：手上已经有同类、等级不低、还经用的，多半是忘了（背包里攒了三把铁剑）。说清楚有什么；真要再做写 extra:true
    // 刚被打断的同一样合成在等落地：交给下面的“打断续做”去算，不当成重复做
    if (!args.extra && !interruptedCrafts.has(args.item)) {
      const s = ctx.adapter.state();
      const held = gearAlreadyHeld(args.item, s.inventory, s.equipment);
      const armor = /_(helmet|chestplate|leggings|boots)$/.test(args.item);
      if (held) return fail('BAD_ARGS', `${held}，不用再做 ${args.item}${armor ? '（背包里的护甲要 hold_item 穿到对应槽才生效）' : '：打架、干活时会自己拿出最好的那件用'}；真要再做（备用、给别处）写 {"item":"${args.item}","extra":true}`);
    }
    args = { ...args, item: pickVariant(args.item, ctx.adapter.state().inventory) };
    // 刚被打断的同一样合成：先等它落地，做成了就算进这次的数量
    let landedNote = '';
    const prior = interruptedCrafts.get(args.item);
    if (prior) {
      interruptedCrafts.delete(args.item);
      const landed = Date.now() - prior.at <= INTERRUPTED_WINDOW_MS ? await prior.landed : 0;
      if (ctx.signal.aborted) throw new AbortedError(String(ctx.signal.reason ?? 'aborted'));
      if (landed >= args.count) {
        return ok(`刚才被打断的那次合成其实已经做成了 ${landed} 个 ${args.item}，这次不再重复做${haveNote(ctx, args.item)}`, { crafted: 0, landedEarlier: landed });
      }
      if (landed > 0) { args = { ...args, count: args.count - landed }; landedNote = `；刚才被打断的那次其实已做成 ${landed} 个，这次只补 ${args.count} 个`; }
    }
    const before = countIn(ctx.adapter.state().inventory, args.item);
    try {
      // 只复用已知工作台；自动准备必须由当前动作的 make:true 授权。
      const table = findStation(ctx, ['crafting_table'], 48);
      const conflict = craftReservationConflict(ctx.memory, ctx.adapter.state(), args.item, args.count, config.mc.version, !!table);
      if (conflict) return fail('MISSING_MATERIALS', `预留保护：${conflict.reason}`, { conflict });
      const r = await ctx.adapter.craft(args.item, args.count, ctx.signal, { tablePos: table?.pos, ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}) });
      const placedFresh = !!r.tablePos && (!table || dist3(table.pos, r.tablePos) >= 1);
      if (r.tablePos && (!placedFresh || nearHome(ctx, r.tablePos))) rememberStation(ctx, 'crafting_table', r.tablePos);
      const reused = table && r.tablePos && dist3(table.pos, r.tablePos) < 1 && table.dist > 4 ? `（用了 ${table.dist} 格外${table.from === 'memory' ? '记得' : '看到'}的工作台）` : '';
      if (!r.ok) {
        const short = woodShortfall(args.item, args.count, ctx.adapter.state().inventory, !!table);
        const why = [r.detail, short].filter(Boolean).join('；');
        const st = ctx.adapter.state();
        const inChest = r.reason === 'MISSING_MATERIALS' ? chestHint(ctx.memory, st, needsFromShortfall(r.detail)) : '';
        return fail((r.reason as any) ?? 'ERROR', `无法合成 ${args.item}：${r.reason}${why ? `（${why}）` : ''}${reused}${inChest}`, why ? { shortfall: why } : undefined);
      }
      // 野外临时放下的工作台用完收回来带着走（真人都这样）；家附近的留着当家具
      const tookBack = r.ok && placedFresh && r.tablePos && !nearHome(ctx, r.tablePos) ? await takeBackTable(ctx, r.tablePos) : false;
      const shortNote = r.crafted < args.count && r.detail ? `；要 ${args.count} 个只做了 ${r.crafted} 个：${r.detail}` : '';
      return ok(`合成了 ${r.crafted} 个 ${args.item}${shortNote}${haveNote(ctx, args.item)}${reused}${landedNote}${tookBack ? '；临时放下的工作台已收回背包' : ''}`, { crafted: r.crafted, ...(tookBack ? { tableTakenBack: true } : {}) });
    } catch (e) {
      if (isAbort(e)) { watchInterruptedCraft(ctx, args.item, before); throw e; }
      return fail(codeFromError(e), `合成 ${args.item} 出错：${(e as Error).message}`);
    }
  },
};

// ------------------------------------------------------------------ eat
export const eat: Skill<{ item?: string }> = {
  name: 'eat',
  description: '吃东西，一直吃到饱（饱食度 18 以上才会自然回血）：写 item 只吃那一样（比如先吃生的、留着金苹果），不写挑背包里最好的；没有正常食物且饥饿值不超过 6 时允许吃腐肉救急',
  argsDoc: '{"item"?: "<食物名>"}',
  timeoutMs: 20000,
  movement: false,
  validate(raw, adapter) {
    const name = String(obj(raw).item ?? '').trim().replace(/^minecraft:/, '');
    if (!name) return { ok: true, args: {} };
    const item = resolveItemAlias(name, adapter);
    if (!item || !FOOD_VALUE[item]) return { ok: false, error: `${name} 不是能吃的东西` };
    return { ok: true, args: { item } };
  },
  async run(ctx, args) {
    if (args.item && !ctx.adapter.state().inventory.some((i) => i.name === args.item && i.count > 0)) return fail('NO_FOOD', `背包里没有 ${args.item}`);
    if (!args.item && !ctx.adapter.hasFood()) {
      const inv = ctx.adapter.state().inventory;
      const has = (re: RegExp) => inv.some((i) => re.test(i.name) && i.count > 0);
      const alt = [
        has(/^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/) ? 'smelt 背包里的生肉/生鱼' : '',
        'hunt（看见牛猪羊鸡兔时）',
        has(/^fishing_rod$/) ? 'fish（有钓竿）' : '',
        'forage（摘橡树/深色橡树叶里的苹果、浆果、西瓜）',
        has(/^(wheat_seeds)$/) ? 'farm（种小麦，慢）' : '',
      ].filter(Boolean);
      const rotten = has(/^rotten_flesh$/) ? '（腐肉只在没有正常食物且饥饿值 ≤6 时救急）' : '';
      return fail('NO_FOOD', `背包里没有当前适合吃的食物${rotten}：可以 ${alt.join('、')}`, { alternatives: alt });
    }
    try {
      // 像人一样一次吃饱：饱食度到 18 以上（能自然回血）或吃完为止，而不是吃一口就走、过一会儿又被饿意打断
      // 吃没吃进去以饥饿值为准：服务器的饥饿值更新会晚到一会儿，咬完等它到了再判断，别把“没吃进去”当成吃过了
      const start = ctx.adapter.state().food;
      if (start >= 20) return ok('已经饱了，不用吃', { bites: 0 });
      let bites = 0, eaten = 0;
      const ate: Record<string, number> = {};
      const counts = () => { const m = new Map<string, number>(); for (const i of ctx.adapter.state().inventory) m.set(i.name, (m.get(i.name) ?? 0) + i.count); return m; };
      do {
        const before = ctx.adapter.state().food;
        const invBefore = counts();
        const used = await ctx.adapter.eat(ctx.signal, args.item);
        if (used === false) break;
        bites++;
        const until = Date.now() + 1500;
        while (ctx.adapter.state().food <= before && Date.now() < until) await sleep(100, ctx.signal);
        if (ctx.adapter.state().food <= before) break; // 吃不进去（满了、被打断或食物无效）
        eaten++;
        const invAfter = counts();
        for (const [name, n] of invBefore) if ((invAfter.get(name) ?? 0) < n && FOOD_VALUE[name]) ate[name] = (ate[name] ?? 0) + (n - (invAfter.get(name) ?? 0));
      } while (eaten < 6 && ctx.adapter.state().food < 18 && (args.item ? ctx.adapter.state().inventory.some((i) => i.name === args.item && i.count > 0) : ctx.adapter.hasFood()) && Date.now() < ctx.deadline - 2500);
      const food = ctx.adapter.state().food;
      if (!eaten) return fail('ERROR', `没吃进去：试了 ${bites} 口，饥饿值还是 ${food}${food >= 20 ? '（已经饱了）' : '（可能被打断或手上换了东西），稍后再试'}`, { bites });
      // 吃了什么、每块值多少（生的顺带说烤熟后值多少）：让它自己看出划不划算
      const what = Object.entries(ate).map(([name, n]) => `${name}×${n}（${foodNote(name) ?? '?'}）`).join('、');
      return ok(`吃了 ${eaten} 口${what ? `：${what}` : ''}，饥饿值 ${start} → ${food}`, { bites: eaten, ate });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `进食失败：${(e as Error).message}`);
    }
  },
};

/** 附近（16 格内）有家、基地或自己的作品：那里的工作台算家具，不收走 */
function nearHome(ctx: SkillCtx, pos: { x: number; y: number; z: number }): boolean {
  const dim = ctx.adapter.state().dim;
  return ctx.memory.landmarks().some((l) => l.dim === dim && (l.kind === 'base' || /家|基地|小屋|房/.test(l.label)) && dist3(l.pos, pos) <= 16);
}

async function takeBackTable(ctx: SkillCtx, pos: { x: number; y: number; z: number }): Promise<boolean> {
  try {
    if (ctx.adapter.blockAt(pos) !== 'crafting_table') return false;
    const before = ctx.adapter.state().inventory.filter((i) => i.name === 'crafting_table').reduce((n, i) => n + i.count, 0);
    const r = await ctx.adapter.dig(pos, ctx.signal);
    if (!r.ok) return false;
    try { await ctx.adapter.moveTo({ kind: 'near', pos, range: 0.8 }, { signal: ctx.signal, timeoutMs: 4000 }); } catch (e) { if (isAbort(e)) throw e; }
    const after = ctx.adapter.state().inventory.filter((i) => i.name === 'crafting_table').reduce((n, i) => n + i.count, 0);
    return after > before;
  } catch (e) {
    if (isAbort(e)) throw e;
    return false;
  }
}

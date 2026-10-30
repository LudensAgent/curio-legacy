import { chestHint, needsFromShortfall } from './chest-hint.ts';
import { describePlan, materialPlan } from '../methods/shortfall.ts';
import { lookAround } from './movement.ts';
import { findStation, myBed, rememberStation } from './stations.ts';
import { ownBuildingAt } from './build.ts';
import { AbortedError, dist3, sleep } from '../util.ts';
import { codeFromError, clampInt, fail, isAbort, obj, ok, type Skill, type SkillCtx, type SkillResult } from './types.ts';
import { craftReservationConflict } from '../projects/reservations.ts';
import { isResourceBlock, oreSpotsNear } from '../memory/ore-spots.ts';
import { config } from '../config.ts';
import { FOOD_VALUE, foodNote } from './food.ts';
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
async function moveWithWatchdog(ctx: SkillCtx, pos: { x: number; y: number; z: number }, dig = false) {
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
    await ctx.adapter.moveTo({ kind: 'reach_block', pos }, { signal: AbortSignal.any([ctx.signal, stop.signal]), timeoutMs: Math.min(90000, Math.max(3000, ctx.deadline - Date.now())), ...(dig ? { allowTerrainChanges: true } : {}) });
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
    // 先算账：要做的东西还差多少原材料，其中多少要从这种方块里来
    if (args.for) {
      const plan = materialPlan(args.for.item, args.for.count, adapter.state().inventory);
      const mine = plan.raw.filter((r) => names.includes(r.item) || r.from.some((b) => names.includes(b)) || (r.anyWood && names.some((n) => n.endsWith('_log'))));
      const need = mine.reduce((a, r) => a + r.count, 0);
      if (!need) {
        return plan.enough ? ok(`不用采了：${describePlan(plan)}`, { needed: 0, plan })
          : fail('BAD_ARGS', `做 ${args.for.item}×${args.for.count} 不缺 ${args.block}；${describePlan(plan)}`, { plan });
      }
      args = { ...args, count: Math.min(64, need) };
      // 只采真正缺的那种（做桦木门就砍桦木，别砍橡木）
      const wanted = names.filter((n) => mine.some((r) => r.item === n || r.from.includes(n) || (r.anyWood && n.endsWith('_log'))));
      if (wanted.length) names = wanted;
      ctx.progress(0, `${describePlan(plan)}：先采 ${args.block}×${args.count}`);
    } else {
      // 不写 for：count 是"要采到多少"，不是"再采多少"——先扣掉背包里已经有的
      const have = names.reduce((sum, n) => sum + adapter.state().inventory.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0), 0);
      if (have >= args.count) return ok(`背包里已经有 ${have} 个 ${args.block}，不用再采`);
      args = { ...args, count: args.count - have };
    }
    const canDigDown = names.some((n) => UNDERFOOT.has(n));
    const skip = new Set<string>();
    let unreachable = unreachableTargets.get(adapter);
    if (!unreachable) { unreachable = new Map(); unreachableTargets.set(adapter, unreachable); }
    for (const [k, failed] of unreachable) if (Date.now() - failed.at > UNREACHABLE_TTL_MS) unreachable.delete(k);
    const skippedUnreachable = new Set<string>();
    let dug = 0;
    let failsInRow = 0;
    let underNote = '';
    let searched = false;
    let lost = 0;
    const risky: Record<TargetRisk, number> = { hazard: 0, wet: 0, deep: 0 };
    const riskCache = new Map<string, TargetRisk | null>();
    const riskNote = () => {
      const parts = [risky.hazard ? `${risky.hazard} 处在出过事的危险区域` : '', risky.wet ? `${risky.wet} 处挨着水/岩浆或要泡在水里挖` : '', risky.deep ? `${risky.deep} 处在脚下很深、旁边有水的地方` : ''].filter(Boolean);
      return parts.length ? `；为安全跳过了 ${parts.join('、')} 的 ${args.block}（换个干燥、露天的地方采）` : '';
    };
    ctx.progress(0, `采集 ${args.block} x${args.count}`);
    const ownSkipped = new Set<string>();
    while (dug < args.count) {
      const s = adapter.state();
      if (!s.connected) return fail('NOT_CONNECTED', '连接断开');
      if (s.emptySlots === 0) {
        return dug > 0 ? ok(`背包已满，采集了 ${dug}/${args.count} 个 ${args.block}`) : fail('INVENTORY_FULL', '背包已满');
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
        if (skippedUnreachable.size && !candidates.length) return dug > 0
          ? ok(`采集了 ${dug}/${args.count}；其余 ${skippedUnreachable.size} 处刚确认无法到达或够不着，先换个站位再采`, { dug, skippedUnreachable: skippedUnreachable.size })
          : fail('PATH_NOT_FOUND', `${skippedUnreachable.size} 处 ${args.block} 刚确认无法到达或够不着，同一站位暂不重复尝试；先换个方向走至少 3 格，或稍后再试`, { skippedUnreachable: skippedUnreachable.size });
        // 看不见目标：不替它决定往下挖（直上直下挖是最危险的挖法），只说脚下踩着的是什么，挖不挖、往哪挖由它定
        if (canDigDown && !underNote) {
          const under = adapter.blockAt({ x: Math.floor(s.pos.x), y: Math.floor(s.pos.y) - 1, z: Math.floor(s.pos.z) });
          if (under && names.includes(under)) underNote = `；脚下踩着的就是 ${under}（要挖自己用 dig_at，往下挖小心掉进洞里或岩浆）`;
        }
        // 眼前没有了就转头找找（砍完一棵树，人会四下看看下一棵在哪），每次采集只找一次
        if (!searched && !s.inWater) {
          searched = true;
          ctx.progress(dug / args.count, `四下找找还有没有 ${args.block}`);
          const r = await lookAround.run(ctx, { seconds: 3, for: args.block });
          if (r.status === 'succeeded') continue;
        }
        // 没找到不证明原地点已消失；只有实际看见变化或亲手拆除才能作废。
        const unconfirmed = ctx.memory.resourceLandmarksNear(names, s.dim, s.pos, 5);
        const staleNote = unconfirmed.length ? `；附近 ${unconfirmed.length} 处历史 ${args.block} 地点尚未重新确认，保留线索` : '';
        const looked = searched ? '（已转头找过）' : '';
        const skipped = risky.hazard + risky.wet + risky.deep;
        const ownNote = ownSkipped.size ? `；另有 ${ownSkipped.size} 块是自己房子上的，没拆（拆了还得补）` : '';
        // 眼前看不见，但长期记着别处有：说出在哪（去不去由心智定）；“记忆里没有”只在真没记过时才说
        const spots = names.some((n) => isResourceBlock(n)) ? oreSpotsNear(ctx.memory.landmarks(), { worldId: s.worldId, dim: s.dim, pos: s.pos }, { only: names, excludeWithin: 6 }).slice(0, 3) : [];
        const remembered = spots.length
          ? `；不过记得别处有 ${args.block}：${spots.map((o) => o.text).join('；')}——要去就 goto {"target":"${spots[0].pos.x},${spots[0].pos.y},${spots[0].pos.z}","dig":true} 走到跟前再 gather`
          : !unconfirmed.length && isResourceBlock(args.block) ? `；长期记忆里也没记过哪里有 ${args.block}` : '';
        return dug > 0
          ? ok(`看不到更多 ${args.block}${looked}，采集了 ${dug}/${args.count}${ownNote}${staleNote}${riskNote()}${remembered}${underNote}`, { searched, ...(skipped ? { skippedUnsafe: { ...risky } } : {}) })
          : fail('NOT_FOUND', skipped
            ? `能看见的 ${args.block} 都不安全，没有去挖${riskNote()}${looked}${staleNote}`
            : ownSkipped.size ? `附近能看到的 ${args.block} 都是自己房子上的（${ownSkipped.size} 块），拆了还得补，没去挖；要去别处找${staleNote}`
            : `眼前看不见 ${args.block}${looked}${staleNote}${remembered || '；尚未定位该资源，不代表其他地点也没有'}${underNote}`, { searched, ...(spots.length ? { remembered: spots.map((o) => o.pos) } : {}), ...(skipped ? { skippedUnsafe: { ...risky } } : {}) });
      }
      // 记忆里的方块可能已经被砍掉/不在加载范围：这种目标跳过，不能误报成“缺工具”
      const present = hits.filter((h) => adapter.blockAt(h.pos) === h.name);
      for (const h of hits) if (!present.includes(h)) skip.add(key(h.pos));
      if (!present.length) continue;
      let target = present.find((h) => adapter.canHarvest(h.pos));
      if (!target) {
        const tool = await ensureToolFor(ctx, present[0].pos);
        if (!tool.ok) return fail('TOOL_MISSING', tool.message, { block: present[0].name });
        target = present[0];
      }

      const invTotal = () => adapter.state().inventory.reduce((a, i) => a + i.count, 0);
      const before = invTotal();
      try {
        ctx.progress(dug / args.count, `前往 ${target.name}（${Math.round(target.dist)} 格）`);
        await moveWithWatchdog(ctx, target.pos, args.dig === true);
        const t0 = Date.now();
        const r = await adapter.dig(target.pos, signal);
        if (!r.ok) throw new Error(r.reason ?? 'DIG_FAILED');
        ctx.memory.recordDig(target.name, adapter.state().held, Date.now() - t0);
      } catch (e) {
        if (isAbort(e)) throw e;
        skip.add(key(target.pos));
        if (String((e as Error).message).includes('OUT_OF_REACH') || codeFromError(e) === 'PATH_NOT_FOUND' || String((e as Error).message) === 'PATH_NO_PROGRESS') {
          const failedAt = adapter.state();
          unreachable.set(`${failedAt.worldId}:${failedAt.dim}:${key(target.pos)}`, { at: Date.now(), from: { ...failedAt.pos }, block: target.name });
        }
        if ((e as Error).message === 'ENTERED_WATER') {
          rememberWet(ctx, target.pos);
          risky.wet++;
          adapter.stopAll();
          const current = adapter.state();
          return fail('PATH_NOT_FOUND', `前往 ${target.name} 时进入水中，已停止采集；已采 ${dug}/${args.count}，氧气 ${current.oxygen}/20`,
            { dug, target: target.pos, pos: current.pos, inWater: current.inWater, oxygen: current.oxygen });
        }
        if (++failsInRow >= 4) {
          return dug > 0 ? ok(`多次失败后停止，采集了 ${dug}/${args.count}`, { dug }) : fail(codeFromError(e) === 'ERROR' ? 'PATH_NOT_FOUND' : codeFromError(e), `无法到达或挖掘 ${args.block}：${(e as Error).message}${args.dig ? '' : '；路上是土石坡坎挡着就加 "dig":true（挖穿、垫方块过去）'}`);
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
    const after = args.for ? materialPlan(args.for.item, args.for.count, adapter.state().inventory) : null;
    return ok(`采集了 ${dug} 个 ${args.block}${lost ? `（另有 ${lost} 块的掉落物没捡到）` : ''}${after ? `；${describePlan(after)}` : ''}${riskNote()}`, { dug, ...(lost ? { lost } : {}), ...(after ? { plan: after } : {}) });
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
export function gearAlreadyHeld(item: string, inv: InvItem[], worn: { name: string; durabilityRemaining?: number }[] = []): string | null {
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
    usable++;
    have.push(`身上穿着的 ${e.name}`);
  }
  const limit = ['pickaxe', 'axe', 'shovel'].includes(want.kind) ? 2 : 1;
  return usable >= limit ? `已经有 ${have.join('、')}，还经用` : null;
}

export const craft: Skill<{ item: string; count: number; extra?: boolean }> = {
  name: 'craft',
  description: '合成指定物品，默认只使用现有材料和已放好的工作台；缺少前置材料或工作台就报告缺口。make:true 显式允许补做两层以内的材料并制造、放置临时工作台，用完收回。count 是本次产物个数。',
  argsDoc: '{"item": "<物品名>", "count"?: 1-64, "make"?: true（允许补材料和准备工作台）, "extra"?: true（已有同类设施、床或经用装备仍要再做）}',
  timeoutMs: 60000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const raw0 = String(a.item ?? '').trim().replace(/^minecraft:/, '');
    const item = resolveItemAlias(raw0, adapter);
    if (!item) return { ok: false, error: `未知物品：${raw0}（请用完整物品 ID，如 white_bed、oak_planks）` };
    return { ok: true, args: { item, count: clampInt(a.count, 1, 64, 1), ...(a.extra === true ? { extra: true } : {}) } };
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
      if (held) return fail('BAD_ARGS', `${held}，不用再做 ${args.item}：打架、干活时会自己拿出最好的那件用；真要再做一把（备用、给别处）写 {"item":"${args.item}","extra":true}`);
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
      const r = await ctx.adapter.craft(args.item, args.count, ctx.signal, { tablePos: table?.pos });
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

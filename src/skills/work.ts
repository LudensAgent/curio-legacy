import { describePlan, materialPlan } from '../methods/shortfall.ts';
import { lookAround, surface } from './movement.ts';
import { findStation, rememberStation } from './stations.ts';
import { dist3, sleep } from '../util.ts';
import { codeFromError, clampInt, fail, isAbort, obj, ok, type Skill, type SkillCtx, type SkillResult } from './types.ts';
import { craftReservationConflict } from '../projects/reservations.ts';
import { config } from '../config.ts';

const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

// ------------------------------------------------------------------ gather
/** 可以“往下挖”找到的地表/地下方块 */
const DIGGABLE_DOWN = new Set(['stone', 'cobblestone', 'deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'dirt', 'grass_block', 'coarse_dirt', 'sand', 'gravel', 'clay']);
const UNSAFE_BELOW = new Set(['lava', 'water', 'air', 'cave_air', 'bedrock']);
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
  if (tier === 'wooden' && !woodShort) {
    ctx.progress(0, `挖 ${block} 要镐子：先做一把木镐`);
    const r = await craft.run(ctx, { item: 'wooden_pickaxe', count: 1 });
    if (r.status === 'succeeded' && adapter.canHarvest(pos)) return { ok: true, crafted: 'wooden_pickaxe' };
    return { ok: false, message: `手上没有能挖 ${block} 的镐子（需要 wooden_pickaxe 以上）；试着做木镐没成：${r.summary}` };
  }
  if (!tier) return { ok: false, message: `手上的工具挖不了 ${block}` };
  const hasWood = inv.some((i) => /_(log|planks|stem)$/.test(i.name) && i.count > 0);
  const hasCobble = inv.some((i) => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name) && i.count >= 3);
  const hint = tier === 'wooden' ? (hasWood ? `背包有木料但不够（${woodShort}）` : '先砍点木头做 wooden_pickaxe')
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

export const gather: Skill<{ block: string; count: number; for?: { item: string; count: number }; note?: string }> = {
  name: 'gather',
  description: '前往【看见过或正看见】的指定方块并挖掘、拾取。写 for（要做的东西和数量）时按背包缺口算该采几个，已经够了就不采；看不见的不会去挖（没有透视）；stone/dirt/sand 若看不见会就地向下挖。block 可用别名：log(任意原木)、stone、dirt、coal、iron、ore',
  argsDoc: '{"block": "log|stone|coal|iron|<方块名>", "for"?: {"item":"要做的东西（物品 ID）","count":1} | "物品名", "count"?: 1-32（不写 for 时用）}',
  timeoutMs: 180000,
  movement: true,
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
    return { ok: true, args: { block, count: clampInt(a.count, 1, 32, 4), ...(goal ? { for: goal } : {}), ...(note ? { note } : {}) } };
  },
  async run(ctx, args) {
    const r = await gatherRun(ctx, args);
    return args.note ? { ...r, summary: `${r.summary}（${args.note}）` } : r;
  },
};

async function gatherRun(ctx: SkillCtx, args: { block: string; count: number; for?: { item: string; count: number } }): Promise<SkillResult> {
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
    }
    const canDigDown = names.some((n) => DIGGABLE_DOWN.has(n));
    const skip = new Set<string>();
    let dug = 0;
    let failsInRow = 0;
    let dugDown = 0;
    let searched = false;
    let lost = 0;
    const risky: Record<TargetRisk, number> = { hazard: 0, wet: 0, deep: 0 };
    const riskCache = new Map<string, TargetRisk | null>();
    let wetEntries = 0;
    const riskNote = () => {
      const parts = [risky.hazard ? `${risky.hazard} 处在出过事的危险区域` : '', risky.wet ? `${risky.wet} 处挨着水/岩浆或要泡在水里挖` : '', risky.deep ? `${risky.deep} 处在脚下很深、旁边有水的地方` : ''].filter(Boolean);
      return parts.length ? `；为安全跳过了 ${parts.join('、')} 的 ${args.block}（换个干燥、露天的地方采）` : '';
    };
    ctx.progress(0, `采集 ${args.block} x${args.count}`);
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
        // 水下（上方是水）的方块不去挖：会憋气溺水
        .filter((h) => !WATERY.has(adapter.blockAt({ x: h.pos.x, y: h.pos.y + 1, z: h.pos.z }) ?? 'air'))
        // 比脚下低的目标多扣分：宁可挖身边露天的，也不往坑底/水边钻
        .sort((a, b) => a.dist + Math.abs(a.pos.y - s.pos.y) * 0.6 + Math.max(0, s.pos.y - a.pos.y - 2) - (b.dist + Math.abs(b.pos.y - s.pos.y) * 0.6 + Math.max(0, s.pos.y - b.pos.y - 2)));
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
        // 看不见目标：石头/泥土类可以就地往下挖（脚下的方块是“踩着的”，不算透视）
        if (canDigDown && dugDown < 8 && !s.inWater) {
          const below = { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y) - 1, z: Math.floor(s.pos.z) };
          const under = adapter.blockAt(below);
          const under2 = adapter.blockAt({ ...below, y: below.y - 1 });
          // 旁边有水就别往下挖：一挖开水就灌进来（脚边的方块是踩着、碰着的，不算透视）
          const wet = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => [below.y, below.y + 1].some((y) => WATERY.has(adapter.blockAt({ x: below.x + dx, y, z: below.z + dz }) ?? 'air')));
          const danger = !!ctx.memory.hazardAt?.(below, s.dim, ['drowning', 'lava']);
          if (danger) risky.hazard++;
          if (under && DIGGABLE_DOWN.has(under) && !UNSAFE_BELOW.has(under2 ?? 'air') && !wet && !danger) {
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
        const skipped = risky.hazard + risky.wet + risky.deep;
        return dug > 0
          ? ok(`看不到更多 ${args.block}${looked}，采集了 ${dug}/${args.count}${staleNote}${riskNote()}`, { searched, ...(skipped ? { skippedUnsafe: { ...risky } } : {}) })
          : fail('NOT_FOUND', skipped
            ? `能看见的 ${args.block} 都不安全，没有去挖${riskNote()}${looked}${staleNote}`
            : `视野和记忆里都没有 ${args.block}${looked}${staleNote}；尚未定位该资源，不代表其他地点也没有`, { searched, ...(skipped ? { skippedUnsafe: { ...risky } } : {}) });
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
        await moveWithWatchdog(ctx, target.pos);
        const t0 = Date.now();
        const r = await adapter.dig(target.pos, signal);
        if (!r.ok) throw new Error(r.reason ?? 'DIG_FAILED');
        ctx.memory.recordDig(target.name, adapter.state().held, Date.now() - t0);
      } catch (e) {
        if (isAbort(e)) throw e;
        skip.add(key(target.pos));
        if ((e as Error).message === 'ENTERED_WATER') {
          // 走着走着下了水：这一片都别去了，先上岸，再看别的目标
          rememberWet(ctx, target.pos);
          risky.wet++;
          ctx.progress(dug / args.count, `去 ${target.name} 要下水，放弃这一片，先上岸`);
          adapter.stopAll();
          const out = await surface.run(ctx, {});
          if (++wetEntries >= 2 || out.status !== 'succeeded') {
            const msg = `去挖 ${args.block} 的路上两次进了水（${out.summary}），这一带的 ${args.block} 要下水才够得着，换个干燥的地方采${riskNote()}`;
            return dug > 0 ? ok(`采集了 ${dug}/${args.count}；${msg}`, { dug }) : fail('NOT_FOUND', msg, { skippedUnsafe: { ...risky } });
          }
          continue;
        }
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
    if (!ctx.adapter.hasFood()) {
      const inv = ctx.adapter.state().inventory;
      const has = (re: RegExp) => inv.some((i) => re.test(i.name) && i.count > 0);
      const alt = [
        has(/^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/) ? 'smelt 背包里的生肉/生鱼' : '',
        'hunt（看见牛猪羊鸡兔时）',
        has(/^fishing_rod$/) ? 'fish（有钓竿）' : '',
        'forage（摘橡树/深色橡树叶里的苹果、浆果、西瓜）',
        has(/^(wheat_seeds)$/) ? 'farm（种小麦，慢）' : '',
      ].filter(Boolean);
      return fail('NO_FOOD', `背包里没有能吃的：可以 ${alt.join('、')}`, { alternatives: alt });
    }
    try {
      // 像人一样一次吃饱：饱食度到 18 以上（能自然回血）或吃完为止，而不是吃一口就走、过一会儿又被饿意打断
      // 吃没吃进去以饥饿值为准：服务器的饥饿值更新会晚到一会儿，咬完等它到了再判断，别把“没吃进去”当成吃过了
      const start = ctx.adapter.state().food;
      if (start >= 20) return ok('已经饱了，不用吃', { bites: 0 });
      let bites = 0, eaten = 0;
      do {
        const before = ctx.adapter.state().food;
        const used = await ctx.adapter.eat(ctx.signal);
        if (used === false) break;
        bites++;
        const until = Date.now() + 1500;
        while (ctx.adapter.state().food <= before && Date.now() < until) await sleep(100, ctx.signal);
        if (ctx.adapter.state().food <= before) break; // 吃不进去（满了、被打断或食物无效）
        eaten++;
      } while (eaten < 6 && ctx.adapter.state().food < 18 && ctx.adapter.hasFood() && Date.now() < ctx.deadline - 2500);
      const food = ctx.adapter.state().food;
      if (!eaten) return fail('ERROR', `没吃进去：试了 ${bites} 口，饥饿值还是 ${food}${food >= 20 ? '（已经饱了）' : '（可能被打断或手上换了东西），稍后再试'}`, { bites });
      return ok(`吃了 ${eaten} 口，饥饿值 ${start} → ${food}`, { bites: eaten });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `进食失败：${(e as Error).message}`);
    }
  },
};

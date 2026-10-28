import { chestHint } from './chest-hint.ts';
import { checkedRecently, chestName, describeRecall, type ChestRecall } from '../memory/chest-memory.ts';
import type { InvItem, Vec3Like } from '../adapter/types.ts';
import { DIRS } from '../perception/perception.ts';
import { shortId, sleep } from '../util.ts';
import { findStation, rememberStation } from './stations.ts';
import { ownBuildingAt } from './build.ts';
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

const slotText = (x: { name: string; count: number } | null) => (x ? `${x.name}×${x.count}` : '');
const STOP_ZH: Record<string, string> = { out_of_fuel: '燃料烧完了，背包里也没有能补的燃料', stalled: '15 秒没有任何进展（成品格堵着、或放进去的烧不了）', deadline: '等太久还没烧完' };

/** 熔炉里留下的东西记进记忆：东西不会自己回到背包，之后路过要想得起来 */
function noteFurnace(ctx: SkillCtx, l: import('../adapter/types.ts').FurnaceLeave) {
  ctx.memory.setFurnace({ dim: ctx.adapter.state().dim, pos: l.pos, block: l.block, input: l.input, output: l.output, fuel: l.fuel, burning: l.burning, ...(l.why ? { why: l.why } : {}) });
}

export const smelt: Skill<{ item: string; count: number }> = {
  name: 'smelt',
  description: `用已有熔炉烧指定物品，燃料按煤/木炭/木板/原木选择；缺熔炉默认返回缺口。make:true 才允许制造和放置熔炉（消耗8圆石或背包熔炉）。可烧生铁、生肉、原木、沙子、圆石等`,
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
    if (!have) return fail('MISSING_MATERIALS', `背包里没有 ${args.item}${chestHint(ctx.memory, s, [{ item: args.item, count: args.count }])}`);
    const fuel = pickFuel(s.inventory, args.item);
    if (!fuel) return fail('MISSING_MATERIALS', `没有燃料（煤、木炭、木板或原木）${chestHint(ctx.memory, s, [], { fuel: true })}`);
    const furnace = findStation(ctx, ['furnace'], 64);
    const n = Math.min(have, args.count);
    ctx.progress(0, `烧 ${args.item} ×${n}（燃料 ${fuel}）`);
    try {
      const moreFuels = FUELS.filter((f) => f !== fuel && f !== args.item && s.inventory.some((i) => i.name === f && i.count > 0));
      const r = await adapter.smelt(args.item, n, fuel, signal, { furnacePos: furnace?.pos, moreFuels, onLeave: (l) => noteFurnace(ctx, l), onProgress: (d) => ctx.progress(d / n, `已烧好 ${d}/${n}`) });
      if (r.furnacePos) rememberStation(ctx, 'furnace', r.furnacePos);
      const at = r.furnacePos ? ` (${r.furnacePos.x},${r.furnacePos.y},${r.furnacePos.z})` : '';
      const why = r.stopped ? `；没烧完：${STOP_ZH[r.stopped]}` : '';
      const back = r.returned ? `，没烧的 ${r.returned} 个 ${args.item} 取回了背包` : '';
      const still = r.left && (r.left.input || r.left.output) ? `；熔炉${at}里还留着 ${[slotText(r.left.input), slotText(r.left.output)].filter(Boolean).join('、')}（背包满了拿不回来，记得回来取）` : '';
      if (!r.ok) {
        if (r.reason === 'NO_FURNACE') return fail('MISSING_MATERIALS', '烧不了：NO_FURNACE（需要 8 个圆石做熔炉）');
        if (r.reason === 'OUT_OF_FUEL') return fail('MISSING_MATERIALS', `一个也没烧成：燃料不够（${fuel} 烧完了，背包里没有别的燃料）${back}${still}${chestHint(ctx.memory, s, [], { fuel: true })}`, { stopped: r.stopped });
        return fail('ERROR', `烧不了：${r.reason}${why}${back}${still}`, { stopped: r.stopped });
      }
      return ok(`烧好了 ${r.made} 个 ${r.output ?? SMELTABLE[args.item]}${furnace && furnace.dist > 4 ? `（用了 ${furnace.dist} 格外${furnace.from === 'memory' ? '记得' : '看到'}的熔炉）` : ''}${why}${back}${still}`, { made: r.made, ...(r.stopped ? { stopped: r.stopped } : {}) });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `冶炼出错：${(e as Error).message}`);
    }
  },
};

export const collectFurnace: Skill<{ at?: Vec3Like; fuel: boolean }> = {
  name: 'collect_furnace',
  description: '回到熔炉把烧好的和没烧完的东西取回背包（fuel:true 连剩下的燃料也拿走）；不给 at 就取最近一个留着东西的熔炉',
  argsDoc: '{"at"?:{x,y,z},"fuel"?:true}',
  timeoutMs: 60000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const at = a.at;
    if (at !== undefined && (!at || typeof at !== 'object' || ['x', 'y', 'z'].some((k) => !Number.isFinite(Number((at as any)[k]))))) return { ok: false, error: 'at 需要熔炉坐标 {"x","y","z"}' };
    return { ok: true, args: { ...(at ? { at: { x: Math.round(Number((at as any).x)), y: Math.round(Number((at as any).y)), z: Math.round(Number((at as any).z)) } } : {}), fuel: a.fuel === true } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    if (!adapter.emptyFurnace) return fail('ERROR', '当前适配器不支持');
    const s = adapter.state();
    const d = (p: Vec3Like) => Math.round(Math.hypot(p.x - s.pos.x, p.y - s.pos.y, p.z - s.pos.z));
    const pos = args.at ?? memory.furnaces(s.dim).sort((a, b) => d(a.pos) - d(b.pos))[0]?.pos ?? findStation(ctx, ['furnace'], 16)?.pos;
    if (!pos) return fail('NOT_FOUND', '不记得哪个熔炉里留着东西，身边也没看到熔炉');
    try {
      const r = await adapter.emptyFurnace(pos, signal, { fuel: args.fuel });
      if (!r.ok) {
        if (/^NOT_A_FURNACE/.test(String(r.reason))) memory.forgetFurnace(s.dim, pos);
        return fail(/^NOT_A_FURNACE/.test(String(r.reason)) ? 'TARGET_GONE' : 'ERROR', `取不了：${r.reason}`);
      }
      memory.setFurnace({ dim: s.dim, pos, block: adapter.blockAt(pos) ?? 'furnace', input: r.left.input, output: r.left.output, fuel: r.left.fuel, burning: r.burning });
      const got = r.taken.map((t) => `${t.name}×${t.count}`).join('、');
      const left = [r.left.input, r.left.output].filter(Boolean).map((x) => `${x!.name}×${x!.count}`).join('、');
      return ok(`${got ? `从熔炉 (${pos.x},${pos.y},${pos.z}) 取回了 ${got}` : `熔炉 (${pos.x},${pos.y},${pos.z}) 里没有可取的东西`}${left ? `；还剩 ${left}（背包满了）` : ''}${r.left.fuel ? `；燃料格里还有 ${r.left.fuel.name}×${r.left.fuel.count}` : ''}`, { taken: r.taken });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `取熔炉出错：${(e as Error).message}`);
    }
  },
};

// ===================================================================== 仓储
/**
 * 存什么由它自己按眼下的需要点名，身体不替它判断“哪些是废料、哪些值钱”
 * （以前写死一张留身上的表，表外的铁锭、粗铁跟着石块整包进了箱子）
 */
type StoreSpec = { name: string; count?: number };
/**
 * "cobblestone" 整包存；"dirt:32" 只存 32 个；名字里可以写 * 通配（"*_log"）。
 * 模型常写成别的样子，意思一样就照收：[{"name":"dirt","count":32}]、{"dirt":32,"granite":true}
 */
const parseStoreSpecs = (v: unknown): StoreSpec[] | null => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，|\s]+/)
    : v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([name, count]) => ({ name, count })) : null;
  if (!arr) return null;
  const out: StoreSpec[] = [];
  for (const x of arr) {
    let text: string;
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      const name = o.name ?? o.item;
      if (typeof name !== 'string') return null;
      const n = typeof o.count === 'number' || typeof o.count === 'string' ? Number(o.count) : NaN; // true / null 当“整包”
      text = Number.isFinite(n) && n >= 1 ? `${name}:${Math.floor(n)}` : name;
    } else text = String(x);
    const m = /^(?:minecraft:)?([a-z0-9_*]{2,60})(?:\s*[:×x*]\s*(\d+))?$/.exec(text.trim().toLowerCase());
    if (!m) return null;
    out.push(m[2] ? { name: m[1], count: Math.max(1, +m[2]) } : { name: m[1] });
  }
  return out.length && out.length <= 24 ? out : null;
};
const nameMatch = (pattern: string, name: string) => pattern.includes('*') ? new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name) : pattern === name;

async function ensureChest(ctx: SkillCtx): Promise<Vec3Like | null> {
  const known = findStation(ctx, ['chest'], 48);
  if (known) return known.pos;
  if (ctx.make !== true) return null;
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

export const storeItems: Skill<{ items: StoreSpec[]; note?: string }> = {
  name: 'store_items',
  description: '把点名物品存入已有箱子，可用 note 记用途；缺箱子默认返回缺口，make:true 才允许合成和放置新箱子（消耗8木板或背包箱子）',
  argsDoc: '{"items":["dirt:32","granite",…], "note"?: "放矿的"}（也收 [{"name":"dirt","count":32}]）',
  timeoutMs: 90000,
  movement: true,
  validate(raw) {
    const items = parseStoreSpecs(obj(raw).items);
    if (!items) return { ok: false, error: 'items 写要存的物品名数组：["cobblestone","dirt:32"]（不写数量就整包存，可用 * 通配）。先看背包，按接下来要用什么挑' };
    const note = typeof obj(raw).note === 'string' ? String(obj(raw).note).trim().replace(/的?箱子$/, '').slice(0, 30) : '';
    return { ok: true, args: note ? { items, note } : { items } };
  },
  async run(ctx, args) {
    const planFor = (inventory: InvItem[]) => {
      const have = new Map<string, number>();
      for (const it of inventory) if (it.name !== 'chest') have.set(it.name, (have.get(it.name) ?? 0) + it.count);
      const plan = new Map<string, number>();
      for (const spec of args.items) {
        for (const [name, n] of have) {
          if (!nameMatch(spec.name, name)) continue;
          const left = n - (plan.get(name) ?? 0);
          const take = Math.min(left, spec.count ?? left);
          if (take > 0) plan.set(name, (plan.get(name) ?? 0) + take);
        }
      }
      return [...plan].map(([name, count]) => ({ name, count }));
    };
    const missing = (plan: InvItem[]) => args.items.filter((s) => !plan.some((d) => nameMatch(s.name, d.name))).map((s) => s.name);
    if (!planFor(ctx.adapter.state().inventory).length) return ok(`背包里没有 ${args.items.map((s) => s.name).join('、')}，没什么可存`);
    const pos = await ensureChest(ctx);
    if (!pos) return fail('MISSING_MATERIALS', ctx.make === true ? '未能准备可用箱子（制造需要8木板，也需要可放置的位置）' : '没有已知可用箱子，未制造或放置；可自行准备，或显式 make:true 允许消耗8木板制作并放置箱子');
    const s = ctx.adapter.state();
    const plan = planFor(s.inventory); // 做箱子可能用掉了木板，重算
    if (!plan.length) return ok('背包里已经没有要存的东西了');
    try {
      const r = await openChest(ctx, pos, plan, []);
      if (!r.ok) return fail('ERROR', `存放失败：${r.reason}`);
      const rec = ctx.memory.noteChestUse(s.dim, pos, { put: plan, seen: r.contents, note: args.note, day: s.worldDay });
      const list = plan.slice(0, 10).map((d) => `${d.name}×${d.count}`).join('、') + (plan.length > 10 ? ` 等 ${plan.length} 种` : '');
      const miss = missing(plan);
      return ok(`存进 ${chestName(rec)} ${r.moved} 个${clearedNote(r)}：${list}${miss.length ? `；背包里没有 ${miss.join('、')}` : ''}；背包空位 ${ctx.adapter.state().emptySlots}`);
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `存放出错：${(e as Error).message}`);
    }
  },
};

const CONTAINERS = ['chest', 'trapped_chest', 'barrel'];

/**
 * 开箱存取。箱子顶上压着方块（原版开不了盖）就先挖掉那一格再开——挖的是盖子上的方块，不是箱子；
 * 那一格是自己房子的一部分就不动，把原因交给心智
 */
async function openChest(ctx: SkillCtx, pos: Vec3Like, deposits: InvItem[], withdraws: InvItem[]): Promise<Awaited<ReturnType<SkillCtx['adapter']['useChest']>> & { cleared?: string }> {
  let r = await ctx.adapter.useChest(pos, deposits, withdraws, ctx.signal);
  const lid = !r.ok && /^LID_BLOCKED:(.+)$/.exec(r.reason ?? '');
  if (!lid) return r;
  const up = { x: pos.x, y: pos.y + 1, z: pos.z };
  const mine = ownBuildingAt(ctx.memory, ctx.adapter.state(), up, lid[1]);
  if (mine) return { ...r, reason: `箱子顶上 (${up.x},${up.y},${up.z}) 压着 ${lid[1]}，开不了盖；那是「${mine.name}」的一部分，没挖。挪走箱子或改建再说，别挖箱子` };
  const d = await ctx.adapter.dig(up, ctx.signal);
  if (!d.ok) return { ...r, reason: `箱子顶上 (${up.x},${up.y},${up.z}) 压着 ${lid[1]}，开不了盖；想挖掉它没成（${d.reason}）。挖掉箱子上面那一格就能开，别挖箱子` };
  r = await ctx.adapter.useChest(pos, deposits, withdraws, ctx.signal);
  return r.ok ? { ...r, cleared: lid[1] } : r;
}
const clearedNote = (r: { cleared?: string }) => r.cleared ? `（先挖掉了压在箱子顶上的 ${r.cleared}）` : '';
const listItems = (items: { name: string; count: number }[]) => items.length ? items.slice(0, 10).map((i) => `${i.name}×${i.count}`).join('、') + (items.length > 10 ? ` 等 ${items.length} 种` : '') : '空的';

const posKey = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
const at = (p: Vec3Like) => `(${p.x},${p.y},${p.z})`;

/**
 * 翻箱子找东西。人找东西就是这样：先去最有把握“放过”的箱子，没有再翻别的用过的、看得见的箱子，
 * 翻过的每一个都留下点印象（翻到什么、没翻到什么），找到就停。
 * 以前是“查记忆里的清单 → 精确命中 → 去拿”，记忆是抄来的清单，所以从不翻、也从不记错。
 */
async function rummage(ctx: SkillCtx, item: string, count: number, candidates: { pos: Vec3Like; why: string }[]) {
  const s = ctx.adapter.state();
  const log: string[] = [];
  let opened = 0;
  for (const c of candidates) {
    const where = at(c.pos);
    try {
      const r = await openChest(ctx, c.pos, [], [{ name: item, count }]);
      if (!r.ok && r.reason === 'NO_CHEST') { ctx.memory.forgetChest(s.dim, c.pos); log.push(`${where} 已经没有箱子了（忘了它）`); continue; }
      if (!r.ok && r.reason === 'UNLOADED') { log.push(`${where} 那一片还没加载、看不到，走近了再翻`); continue; }
      if (!r.ok) { log.push(`${where} 打不开：${r.reason}`); continue; }
      opened++;
      const rec = ctx.memory.noteChestUse(s.dim, c.pos, { took: r.moved ? [{ name: item, count: r.moved }] : [], seen: r.contents, sought: [item], day: s.worldDay });
      if (r.moved) {
        const before = log.length ? `翻了 ${log.length + 1} 个箱子：${log.join('；')}；` : '';
        return ok(`${before}在 ${chestName(rec)} 里找到了，取出 ${r.moved} 个 ${item}${clearedNote(r)}${r.moved < count ? `（只有这么多）` : ''}`);
      }
      log.push(`${where}${c.why ? `（${c.why}）` : ''}里没有，只有 ${glance(r.contents)}`);
    } catch (e) {
      if (isAbort(e)) throw e;
      log.push(`${where} 出错：${(e as Error).message.slice(0, 60)}`);
    }
  }
  return { opened, log };
}
/** 开箱时一眼看到的：最多的三样 */
const glance = (items: { name: string; count: number }[]) => items.length ? [...items].sort((a, b) => b.count - a.count).slice(0, 3).map((i) => i.name).join('、') + (items.length > 3 ? ' 等' : '') : '空的';

export const takeItems: Skill<{ item: string; count: number }> = {
  name: 'take_items',
  description: '去箱子里翻东西：先翻记得放过它的箱子，再翻别的用过的、看得见的箱子，翻到为止（翻过的都会留个印象）',
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
    const s = ctx.adapter.state();
    const flat = (p: Vec3Like) => Math.round(Math.hypot(p.x - s.pos.x, p.z - s.pos.z));
    const REACH = 96;
    const clock = ctx.memory.chestClock(s.worldDay);
    const recalls = ctx.memory.recallChests(args.item, { day: s.worldDay });
    // 别的维度、或者远到这一趟走不过去的箱子：不去开（开不到也不等于箱子没了），只说记得在哪
    const near = recalls.filter((r) => r.chest.dim === s.dim && flat(r.chest.pos) <= REACH);
    const far = recalls.filter((r) => !near.includes(r)).sort((a, b) => flat(a.chest.pos) - flat(b.chest.pos)).slice(0, 3)
      .map((r) => `${describeRecall(r, r.chest.dim === s.dim ? flat(r.chest.pos) : undefined)}${r.chest.dim !== s.dim ? `（${r.chest.dim}）` : ''}`);
    const farNote = far.length ? `；更远的：${far.join('；')}——要的话先走过去再翻` : '';

    // 翻的顺序：最有把握放过的在前，把握差不多就近的先；然后是别的用过的箱子（近的先）；最后是看得见但没用过的
    const rank = (r: ChestRecall) => (r.confidence === 'sure' ? 0 : r.confidence === 'likely' ? 1 : 2);
    const planned = new Map<string, { pos: Vec3Like; why: string }>();
    for (const r of [...near].sort((a, b) => rank(a) - rank(b) || flat(a.chest.pos) - flat(b.chest.pos))) {
      planned.set(posKey(r.chest.pos), { pos: r.chest.pos, why: r.confidence === 'sure' ? '记得放过' : r.confidence === 'likely' ? '好像放过' : '隐约记得' });
    }
    const recentlyChecked: string[] = [];
    const others = ctx.memory.chests(s.dim).filter((c) => flat(c.pos) <= 48 && !planned.has(posKey(c.pos)))
      .sort((a, b) => flat(a.pos) - flat(b.pos));
    for (const c of others) {
      // 刚翻过没有：这次先不去（人也记得“那个我刚看过”）
      if (checkedRecently(c, args.item, clock)) { recentlyChecked.push(at(c.pos)); continue; }
      planned.set(posKey(c.pos), { pos: c.pos, why: c.note ? `${c.note}的箱子` : '用过的箱子' });
    }
    const known = new Set(planned.keys());
    for (const b of ctx.senses.knownBlocks(CONTAINERS, 48).sort((a, b) => flat(a.pos) - flat(b.pos))) {
      if (known.has(posKey(b.pos)) || ctx.memory.chestAt(s.dim, b.pos)) continue;
      planned.set(posKey(b.pos), { pos: b.pos, why: '没打开过' });
    }
    const candidates = [...planned.values()].slice(0, 4);
    if (!candidates.length) {
      const checked = recentlyChecked.length ? `刚翻过 ${recentlyChecked.join('、')} 都没有；` : '';
      return fail('NOT_FOUND', `不记得往哪个箱子放过 ${args.item}：${checked}附近 48 格也没看见别的箱子${farNote}`);
    }
    const r = await rummage(ctx, args.item, args.count, candidates);
    if ('status' in r) return r;
    const checked = recentlyChecked.length ? `；${recentlyChecked.join('、')} 刚翻过没有，这次没再去` : '';
    return fail('NOT_FOUND', `翻了 ${r.opened} 个箱子都没有 ${args.item}：${r.log.join('；')}${checked}${farNote}。箱子打不开别挖箱子，东西会洒一地`);
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
  description: '经营农田：收割成熟作物并补种，或按 crop/size 在附近开垦；消耗对应种子并使用锄头。缺锄头默认返回缺口，make:true 才允许消耗木板/圆石和木棍制作锄头',
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
        if (ctx.make !== true) return fail('MISSING_MATERIALS', '没有锄头，未制造；请自行准备，或显式 make:true 授权制作');
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

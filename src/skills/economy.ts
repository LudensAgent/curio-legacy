import { chestHint } from './chest-hint.ts';
import { chestLocation, describeChest, describeRecall, isContainerLandmark } from '../memory/chest-memory.ts';
import type { GuiContainerObservation, InvItem, Vec3Like } from '../adapter/types.ts';
import { DIRS } from '../perception/perception.ts';
import { shortId, sleep, throwIfAborted } from '../util.ts';
import { findStation, forgetStationAt, rememberStation } from './stations.ts';
import { interactiveName } from '../perception/vision.ts';
import { glanceAt } from './observation.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';
import { FUELS } from '../methods/fuel.ts';
import { FOOD_VALUE } from './food.ts';
import { runMovementCoordinator, type MakeWayEdit } from './movement/coordinator.ts';
import { MAKE_WAY_ARGS_DOC, MAKE_WAY_DEFAULT_EDITS, MAKE_WAY_DOC, makeWayArgs, makeWayRequest, parseMakeWay } from './movement/make-way.ts';

// ===================================================================== 冶炼
export const SMELTABLE: Record<string, string> = {
  raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato',
  sand: 'glass', red_sand: 'glass', cobblestone: 'stone', clay_ball: 'brick', kelp: 'dried_kelp', cactus: 'green_dye',
  oak_log: 'charcoal', birch_log: 'charcoal', spruce_log: 'charcoal', jungle_log: 'charcoal', acacia_log: 'charcoal',
  dark_oak_log: 'charcoal', mangrove_log: 'charcoal', cherry_log: 'charcoal',
};
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

export const smelt: Skill<{ item: string; count: number; make?: boolean }> = {
  name: 'smelt',
  description: `用已有熔炉烧指定物品，燃料按煤/木炭/木板/原木选择；缺熔炉默认返回缺口。make:true 才允许制造和放置熔炉（消耗8圆石或背包熔炉）。count 是这段活要烧掉的总数。可烧生铁、生肉、原木、沙子、圆石等`,
  argsDoc: '{"item": "raw_iron|beef|oak_log|sand|…", "count"?: 1-64（这段活要烧掉的总数）, "make"?:true（允许缺熔炉时就地做一个，消耗 8 圆石）}',
  timeoutMs: 600000,
  movement: false, bodyMotion: 'horizontal',
  validate(raw) {
    const a = obj(raw);
    const item = String(a.item ?? '').replace(/^minecraft:/, '');
    if (!SMELTABLE[item]) return { ok: false, error: `不能烧 ${item}；可烧：${Object.keys(SMELTABLE).slice(0, 12).join('/')}…` };
    if (a.make !== undefined && typeof a.make !== 'boolean') return { ok: false, error: 'make 需要布尔值' };
    return { ok: true, args: { item, count: clampInt(a.count, 1, 64, 8), ...(a.make === true ? { make: true } : {}) } };
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
      const r = await adapter.smelt(args.item, n, fuel, signal, { furnacePos: furnace?.pos, prepare: args.make === true, moreFuels, onLeave: (l) => noteFurnace(ctx, l), onProgress: (d) => ctx.progress(d / n, `已烧好 ${d}/${n}`) });
      if (r.furnacePos) rememberStation(ctx, 'furnace', r.furnacePos);
      const at = r.furnacePos ? ` (${r.furnacePos.x},${r.furnacePos.y},${r.furnacePos.z})` : '';
      const why = r.stopped ? `；没烧完：${STOP_ZH[r.stopped]}` : '';
      const back = r.returned ? `，没烧的 ${r.returned} 个 ${args.item} 取回了背包` : '';
      const still = r.left && (r.left.input || r.left.output) ? `；熔炉${at}里还留着 ${[slotText(r.left.input), slotText(r.left.output)].filter(Boolean).join('、')}（背包满了拿不回来，记得回来取）` : '';
      if (!r.ok) {
        if (r.reason === 'NO_FURNACE') return fail('MISSING_MATERIALS', '烧不了：NO_FURNACE（附近没有可用熔炉；允许就地做一个熔炉就写 make:true，需要 8 个圆石）');
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

const CONTAINERS = ['chest', 'trapped_chest', 'barrel', 'shulker_box', ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map((color) => `${color}_shulker_box`)];
type ContainerTarget = string | Vec3Like;
const posKey = (pos: Vec3Like) => `${pos.x},${pos.y},${pos.z}`;

/** Only a fresh non-container observation can invalidate a remembered local store. */
function forgetObservedContainer(ctx: SkillCtx, pos: Vec3Like) {
  const state = ctx.adapter.state();
  if (ctx.memory.worldId !== state.worldId) return;
  const landmarks = ctx.memory.landmarks().filter((l) => l.dim === state.dim && posKey(l.pos) === posKey(pos) && isContainerLandmark(l.label));
  const name = CONTAINERS.find((name) => landmarks.some((l) => l.label === name || l.label === interactiveName(name) || l.label === `我的${interactiveName(name)}` || l.label.endsWith(`（${name}）`)));
  if (name || ctx.memory.chestAt(state.dim, pos)) forgetStationAt(ctx.memory, state.dim, [pos], name ?? 'chest');
  landmarks.forEach((landmark) => ctx.memory.removeLandmark(landmark.id));
}

function parseContainerTarget(value: unknown): ContainerTarget | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^-?\d+\s*,\s*-?\d+\s*,\s*-?\d+$/.test(text)) return parseContainerTarget(text.split(',').map(Number));
    return text && text.length <= 100 ? text : null;
  }
  const xyz = Array.isArray(value) ? value : value && typeof value === 'object'
    ? ['x', 'y', 'z'].map((key) => (value as Record<string, unknown>)[key]) : [];
  if (xyz.length !== 3 || !xyz.every((n) => typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= 29_999_984) || Math.abs(Number(xyz[1])) > 2048) return null;
  return { x: Number(xyz[0]), y: Number(xyz[1]), z: Number(xyz[2]) };
}

/** Listing evidence does not choose a box or spend a search budget on the Agent's behalf. */
function containerCandidates(ctx: SkillCtx) {
  const state = ctx.adapter.state(), clock = ctx.memory.chestClock(state.worldDay);
  const records = ctx.memory.chests(state.dim).filter((c) => (c.worldId ?? 'default') === state.worldId);
  const landmarks = ctx.memory.landmarks().filter((l) => (l.worldId ?? 'default') === state.worldId && l.dim === state.dim && isContainerLandmark(l.label));
  const known = new Map([...landmarks.map((l) => [posKey(l.pos), { pos: l.pos, ts: l.ts, label: l.label, id: l.id }] as const),
    ...records.map((c) => {
      const landmark = landmarks.find((l) => posKey(l.pos) === posKey(c.pos));
      return [posKey(c.pos), { pos: c.pos, ts: Math.max(c.ts, landmark?.ts ?? 0), label: c.note ? `${c.note}的箱子` : '用过的容器', id: landmark?.id }] as const;
    })]);
  ctx.senses.refresh();
  const recent = ctx.senses.knownBlocks(CONTAINERS, 48);
  const positions = [...new Map([...recent.map((b) => [posKey(b.pos), b.pos] as const), ...[...known.values()].map((c) => [posKey(c.pos), c.pos] as const)]).values()];
  const visible = Array.from({ length: Math.ceil(positions.length / 32) }, (_, index) => positions.slice(index * 32, (index + 1) * 32))
    .flatMap((batch) => ctx.senses.observeBlocks?.(batch) ?? []);
  visible.forEach((block) => {
    if (!CONTAINERS.includes(block.name)) {
      if (known.has(posKey(block.pos))) { forgetObservedContainer(ctx, block.pos); known.delete(posKey(block.pos)); }
      return;
    }
    const previous = known.get(posKey(block.pos));
    known.set(posKey(block.pos), { pos: block.pos, ts: block.observedAt, label: previous?.label ?? block.name, id: previous?.id });
  });
  return [...known.values()].map((candidate) => {
    const location = chestLocation(candidate, clock);
    const seen = visible.some((block) => posKey(block.pos) === posKey(candidate.pos) && CONTAINERS.includes(block.name));
    const record = records.find((c) => posKey(c.pos) === posKey(candidate.pos));
    return { label: candidate.label, worldId: state.worldId, dimension: state.dim, location,
      distance: Math.round(Math.hypot(location.pos.x - state.pos.x, location.pos.y - state.pos.y, location.pos.z - state.pos.z)),
      ...(location.precise ? { target: candidate.id ?? candidate.pos } : {}),
      source: seen ? 'current_visual_observation' : 'historical_observation',
      contents: record ? describeChest(record, clock) : '未打开过，内容未知' };
  }).sort((a, b) => a.distance - b.distance).slice(0, 24);
}

/** 报错时把记下的容器精确坐标顺口说给心智：坐标错了就照着改，而不是继续从方位心算。 */
function knownContainersHint(ctx: SkillCtx): string {
  const candidates = containerCandidates(ctx).slice(0, 3);
  return candidates.length ? `；记得的容器：${candidates.map((c) => `${c.label} ${c.location.text}`).join('、')}` : '';
}

/**
 * 把容器候选写成可执行事实：位置、是否打开过、可直接复制的 target。
 * 只陈述事实，不替 Agent 选容器。
 */
function containerFacts(candidates: ReturnType<typeof containerCandidates>, limit = 3): string {
  return candidates.slice(0, limit).map((candidate) => {
    const label = candidate.label && candidate.label !== candidate.location.text
      ? `${String(candidate.label).slice(0, 24)} ` : '容器 ';
    const target = candidate.target === undefined ? '' : `，target ${JSON.stringify(candidate.target)}`;
    return `${label}${candidate.location.text}${target}（${candidate.contents.slice(0, 80)}）`;
  }).join('；');
}

/** A historical area is a cue to look again, never a concealed exact interaction target. */
async function selectedContainer(ctx: SkillCtx, target: ContainerTarget) {
  const state = ctx.adapter.state();
  let pos: Vec3Like;
  if (typeof target === 'string') {
    const matches = ctx.memory.landmarks().filter((l) => (l.worldId ?? 'default') === state.worldId && l.dim === state.dim && isContainerLandmark(l.label) && (l.id === target || l.label === target));
    if (matches.length !== 1) return { ok: false as const, result: fail('BAD_ARGS', 'target 需要明确的容器地标 ID 或坐标；同名多个容器不能自动代选', { candidates: containerCandidates(ctx) }) };
    ctx.senses.refresh();
    const current = ctx.senses.observeBlocks?.([matches[0].pos])[0];
    if (current && !CONTAINERS.includes(current.name)) {
      forgetObservedContainer(ctx, matches[0].pos);
      return { ok: false as const, result: fail('TARGET_GONE', `选定地点亲眼看见已是 ${current.name}，忘掉已失效的容器记忆；未改选其他容器${knownContainersHint(ctx)}`, { candidates: containerCandidates(ctx) }) };
    }
    pos = matches[0].pos;
  } else pos = target;
  ctx.senses.refresh();
  let observed = ctx.senses.observeBlocks?.([pos])[0];
  if (!observed) { await glanceAt(ctx, pos); observed = ctx.senses.observeBlocks?.([pos])[0]; }
  if (!observed) {
    const dist = Math.round(Math.hypot(pos.x - state.pos.x, pos.y - state.pos.y, pos.z - state.pos.z));
    const why = dist > 48
      ? `离你约 ${dist} 格（超出 48 格视野，store_items 不会自己走过去）`
      : `离你约 ${dist} 格，转头看仍看不见（可能被遮挡或未加载）`;
    return { ok: false as const, result: fail('NOT_FOUND', `选定容器在 (${pos.x},${pos.y},${pos.z})，${why}；先 navigate_to 过去、或改选看得见的容器再存${knownContainersHint(ctx)}`, { candidates: containerCandidates(ctx), pos, distance: dist }) };
  }
  if (!CONTAINERS.includes(observed.name)) {
    forgetObservedContainer(ctx, pos);
    return { ok: false as const, result: fail('TARGET_GONE', `选定位置当前是 ${observed.name}，忘掉已失效的容器记忆；未改选其他容器${knownContainersHint(ctx)}`, { candidates: containerCandidates(ctx) }) };
  }
  // 带精确坐标直接指定容器时，也把记忆里这箱子的空余格数一并给出（不带 target 列候选时才看得到「还剩 N 格空」）。
  // 全量快照才记 freeSlots，增量操作会标 possiblyStale 并丢字段，所以 freeSlots 存在即代表可靠的满空线索。
  const remembered = ctx.memory.chestAt(state.dim, pos);
  return { ok: true as const, pos, ...(remembered && remembered.contents.freeSlots != null ? { rememberedFree: remembered.contents.freeSlots } : {}) };
}

/** useChest 的失败原因说成人话；LID_BLOCKED 说明盖子被压着，得先把上面的方块挖掉 */
function chestFailText(reason: string | undefined): string {
  if (!reason) return '未知原因';
  if (reason.startsWith('LID_BLOCKED:')) return `箱子上压着 ${reason.slice('LID_BLOCKED:'.length)}，盖子打不开`;
  if (reason === 'UNLOADED') return '那一片没加载（离太远）';
  if (reason === 'NO_CHEST') return '那里已经不是容器';
  return reason;
}

export const storeItems: Skill<{ items: StoreSpec[]; target?: ContainerTarget; note?: string }> = {
  name: 'store_items',
  description: '会自己走到已看见的容器旁（不必先 go_near，远处/没看见的先 navigate_to）。把点名物品存入 target 指定、重新看见的容器；不带 target 只返回容器线索让你选择。不会制造箱子、挖盖或更换目标；note 可记录用途',
  argsDoc: '{"items":["dirt:32","granite",…],"target"?:{x,y,z}|"容器地标ID","note"?:"放矿的"}；items也收 [{"name":"dirt","count":32}]；make 不会授权此工具选址造箱',
  timeoutMs: 90000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const input = obj(raw), items = parseStoreSpecs(input.items);
    if (!items) return { ok: false, error: 'items 写要存的物品名数组：["cobblestone","dirt:32"]（不写数量就整包存，可用 * 通配）' };
    const target = parseContainerTarget(input.target);
    if (target === null) return { ok: false, error: 'target 需要整数坐标或明确的容器地标 ID' };
    const note = typeof input.note === 'string' ? input.note.trim().replace(/的?箱子$/, '').slice(0, 30) : '';
    return { ok: true, args: { items, ...(target !== undefined ? { target } : {}), ...(note ? { note } : {}) } };
  },
  async run(ctx, args) {
    if (args.target === undefined) {
      const candidates = containerCandidates(ctx), facts = containerFacts(candidates);
      return fail('BAD_ARGS', `尚未指定存入哪只容器${facts ? `；${facts}` : ''}；用 target 指定其中一只（坐标或地标 ID）再存`, { candidates });
    }
    const selected = await selectedContainer(ctx, args.target);
    if (!selected.ok) return selected.result;
    const rememberedFree = selected.rememberedFree;
    const state = ctx.adapter.state(), have = new Map<string, number>();
    state.inventory.forEach((item) => have.set(item.name, (have.get(item.name) ?? 0) + item.count));
    const requested = new Map<string, number>();
    args.items.forEach((spec) => have.forEach((count, name) => {
      if (!nameMatch(spec.name, name)) return;
      const take = Math.min(count - (requested.get(name) ?? 0), spec.count ?? count);
      if (take > 0) requested.set(name, (requested.get(name) ?? 0) + take);
    }));
    const plan = [...requested].map(([name, count]) => ({ name, count }));
    const missing = args.items.filter((spec) => ![...have.keys()].some((name) => nameMatch(spec.name, name))).map((spec) => spec.name);
    if (!plan.length) return fail('MISSING_MATERIALS', '背包里没有点名要存入的物品，未操作容器');
    let container: GuiContainerObservation | undefined;
    const record = (contents?: InvItem[]) => {
      const after = new Map<string, number>();
      ctx.adapter.state().inventory.forEach((item) => after.set(item.name, (after.get(item.name) ?? 0) + item.count));
      const put = container?.put ?? plan.map((item) => ({ name: item.name, count: Math.max(0, Math.min(item.count, (have.get(item.name) ?? 0) - (after.get(item.name) ?? 0))) })).filter((item) => item.count > 0);
      const seen = container?.after ?? contents;
      if ((put.length || seen) && ctx.memory.worldId === state.worldId) ctx.memory.noteChestUse(state.dim, selected.pos, { put, ...(seen ? { seen } : {}), note: args.note, day: state.worldDay, block: container?.block, ...(container?.capacity !== undefined ? { capacity: container.capacity } : {}), ...(container?.freeSlots !== undefined ? { freeSlots: container.freeSlots } : {}) });
      return put;
    };
    try {
      const result = await ctx.adapter.useChest(selected.pos, plan, [], ctx.signal, { onContainer: (observation) => { container = observation; } });
      container ??= result.container;
      const put = record(result.ok || result.moved > 0 ? result.contents : undefined), moved = put.reduce((count, item) => count + item.count, 0);
      const actual = put.map((item) => `${item.name}×${item.count}`).join('、');
      const free = container?.freeSlots != null ? `；箱子还剩 ${container.freeSlots} 格空` : '';
      // 存之前记得的满空线索：只在它和本次亲眼看到的空余格数不一致时补充，避免重复同一句话。
      const before = rememberedFree !== undefined && rememberedFree !== container?.freeSlots ? `；存之前记得这箱子还剩 ${rememberedFree} 格空` : '';
      if (!result.ok) return fail('ERROR', `选定容器存放未完成：${chestFailText(result.reason)}${moved ? `；实际已存入 ${actual}` : ''}${free}${before}；未挖盖、造箱或更换容器`, { moved, put, ...(container?.freeSlots != null ? { freeSlots: container.freeSlots } : {}), ...(rememberedFree !== undefined ? { rememberedFree } : {}) });
      if (!moved) {
        const why = container?.freeSlots === 0 ? '箱子已经满了（0 格空）' : container?.freeSlots != null ? `箱子还有 ${container.freeSlots} 格空，但这种物品堆叠已满、放不进去` : '箱子可能满了或放不下这种物品';
        return fail('ERROR', `选定容器没有存入任何物品——${why}${before}；未挖盖、造箱或更换容器`, { moved: 0, put: [], ...(container?.freeSlots != null ? { freeSlots: container.freeSlots } : {}), ...(rememberedFree !== undefined ? { rememberedFree } : {}) });
      }
      return ok(`在选定容器存入 ${actual || '0 件物品'}${moved < plan.reduce((count, item) => count + item.count, 0) ? '；只有这部分实际存入' : ''}${missing.length ? `；背包没有 ${missing.join('、')}` : ''}${free}${before}`, { moved, put, ...(missing.length ? { missing } : {}), ...(container?.freeSlots != null ? { freeSlots: container.freeSlots } : {}), ...(rememberedFree !== undefined ? { rememberedFree } : {}) });
    } catch (error) {
      const put = record();
      if (isAbort(error)) throw error;
      return fail(codeFromError(error), `存放出错：${(error as Error).message}`, { put });
    }
  },
};

export const takeItems: Skill<{ item: string; count: number; target?: ContainerTarget }> = {
  name: 'take_items',
  description: '会自己走到已看见的容器旁（不必先 go_near，远处/没看见的先 navigate_to）。从 target 指定、重新看见的容器取出指定物品；不带 target 只返回容器地点和物品印象。不会自行翻其他箱子、挖盖、制造设施或决定搜索顺序',
  argsDoc: '{"item":"<物品名>","count"?:1-64,"target"?:{x,y,z}|"容器地标ID"}；未指定target时只列线索，不执行存取',
  timeoutMs: 90000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const input = obj(raw), item = String(input.item ?? '').replace(/^minecraft:/, ''), target = parseContainerTarget(input.target);
    if (!adapter.isKnownItem(item)) return { ok: false, error: `未知物品：${item}` };
    if (target === null) return { ok: false, error: 'target 需要整数坐标或明确的容器地标 ID' };
    return { ok: true, args: { item, count: clampInt(input.count, 1, 64, 16), ...(target !== undefined ? { target } : {}) } };
  },
  async run(ctx, args) {
    const state = ctx.adapter.state();
    if (args.target === undefined) {
      const hints = ctx.memory.recallChests(args.item, { from: state.pos }).slice(0, 8).map((recall) => ({ dimension: recall.chest.dim, text: describeRecall(recall, recall.dist) }));
      const hintText = hints.length ? `；${hints.map((h) => h.text).join('；')}` : '；不记得哪个箱子里有它';
      const candidates = containerCandidates(ctx), facts = containerFacts(candidates);
      return fail('BAD_ARGS', `尚未指定翻哪只容器（未自动搜索）${hintText}${facts ? `；${facts}` : ''}；用 target 指定其中一只（坐标或地标 ID）再取物`, { candidates, hints });
    }
    const selected = await selectedContainer(ctx, args.target);
    if (!selected.ok) return selected.result;
    const before = ctx.adapter.state().inventory.filter((item) => item.name === args.item).reduce((count, item) => count + item.count, 0);
    let container: GuiContainerObservation | undefined;
    const record = (contents?: InvItem[]) => {
      const after = ctx.adapter.state().inventory.filter((item) => item.name === args.item).reduce((count, item) => count + item.count, 0);
      const moved = container ? container.took.filter((item) => item.name === args.item).reduce((count, item) => count + item.count, 0) : Math.max(0, Math.min(args.count, after - before));
      const seen = container?.after ?? contents;
      if ((moved || seen) && ctx.memory.worldId === state.worldId) ctx.memory.noteChestUse(state.dim, selected.pos, { took: moved ? [{ name: args.item, count: moved }] : [], ...(seen ? { seen, sought: [args.item] } : {}), day: state.worldDay, block: container?.block, ...(container?.capacity !== undefined ? { capacity: container.capacity } : {}), ...(container?.freeSlots !== undefined ? { freeSlots: container.freeSlots } : {}) });
      return moved;
    };
    try {
      const result = await ctx.adapter.useChest(selected.pos, [], [{ name: args.item, count: args.count }], ctx.signal, { onContainer: (observation) => { container = observation; } });
      container ??= result.container;
      const moved = record(result.ok || result.moved > 0 ? result.contents : undefined);
      if (!result.ok) return fail('ERROR', `选定容器取物未完成：${result.reason}${moved ? `；实际已取出 ${moved} 个 ${args.item}` : ''}；未挖盖或换箱`, { moved });
      if (!moved) return fail('NOT_FOUND', `选定容器没有取到 ${args.item}；只记录这次实际看到的内容，未改选其他容器`, { moved });
      return ok(`从选定容器取出 ${moved} 个 ${args.item}${moved < args.count ? '（只取到了这些）' : ''}`, { moved });
    } catch (error) {
      const moved = record();
      if (isAbort(error)) throw error;
      return fail(codeFromError(error), `取物出错：${(error as Error).message}`, { moved });
    }
  },
};

// ===================================================================== 查库存
export const findItem: Skill<{ item: string; count?: number }> = {
  name: 'find_item',
  description: '查某样东西现在在哪：背包多少，记得的箱子各有多少（按远近列出坐标；带 count 时标出哪只单独够用），箱子里合计与总计多少。只读，不开箱不移动；没打开过的箱子内容未知',
  argsDoc: '{"item":"<物品名>","count"?:1-9999（要几个：用来判断哪只箱子单独够用）}',
  timeoutMs: 3000,
  movement: false,
  readOnly: true,
  validate(raw, adapter) {
    const input = obj(raw);
    const item = String(input.item ?? '').trim().replace(/^minecraft:/, '');
    if (!adapter.isKnownItem(item)) return { ok: false, error: `未知物品：${item}` };
    if (input.count !== undefined && !Number.isFinite(Number(input.count))) return { ok: false, error: 'count 需要正整数' };
    return { ok: true, args: { item, ...(input.count !== undefined ? { count: clampInt(input.count, 1, 9999, 1) } : {}) } };
  },
  async run(ctx, args) {
    const s = ctx.adapter.state();
    const backpack = s.inventory.filter((i) => i.name === args.item).reduce((n, i) => n + i.count, 0);
    // 所有维度都查：只查当前维度却说「哪里都没有」，会把记在别的维度的箱子说丢。
    const recalls = ctx.memory.recallChests(args.item, { from: s.pos });
    const here = recalls.filter((r) => r.chest.dim === s.dim);
    const elsewhere = recalls.filter((r) => r.chest.dim !== s.dim);
    const inChests = here.reduce((n, r) => n + r.count, 0);
    const total = backpack + inChests;
    const need = args.count;
    // 距离用三维：同一基地上下层、坡上坡下的箱子不会被水平距离算成一样近。
    const dist3 = (pos: Vec3Like) => Math.round(Math.hypot(pos.x - s.pos.x, pos.y - s.pos.y, pos.z - s.pos.z));
    const sorted = here.slice().sort((a, b) => dist3(a.chest.pos) - dist3(b.chest.pos) || b.count - a.count);
    const chests = sorted.slice(0, 8).map((r) => {
      const dist = dist3(r.chest.pos);
      return { pos: r.chest.pos, count: r.count, dist, ...(r.chest.note ? { note: r.chest.note } : {}),
        observedAt: r.observedAt, ...(r.chest.contents.possiblyStale === true ? { possiblyStale: true } : {}),
        ...(need !== undefined ? { enough: r.count >= need } : {}) };
    });
    // 带数量时优先指向「单独够用」的那只，否则仍按最近；完整清单同时给出，选哪只由 Agent 决定。
    const chosen = (need !== undefined ? sorted.find((r) => r.count >= need) : undefined) ?? sorted[0];
    const chest = chosen ? { pos: chosen.chest.pos, count: chosen.count, dist: dist3(chosen.chest.pos), ...(chosen.chest.note ? { note: chosen.chest.note } : {}), observedAt: chosen.observedAt, ...(chosen.chest.contents.possiblyStale === true ? { possiblyStale: true } : {}) } : null;
    const target = chest ? { x: chest.pos.x, y: chest.pos.y, z: chest.pos.z } : null;
    if (!backpack && !recalls.length) {
      // 只查“打开过的记录”不等于箱子是空的：把附近未打开的容器说清楚，
      // 否则模型会把“不记得”误读成“箱子里没有”，转头去别处找。
      const unopened = containerCandidates(ctx).filter((candidate) => candidate.contents.includes('未打开过')).slice(0, 3);
      const facts = containerFacts(unopened);
      return ok(`背包和记得的箱子里都没有 ${args.item}（只查已打开记录、所有维度）${facts ? `；附近有未打开的容器：${facts}，用 take_items/store_items 指定 target 打开才知道里面有什么` : '；没打开过的箱子内容未知'}`, {
        item: args.item, backpack: 0, chest: null, chests: [], target: null, inChests: 0, total: 0, ...(unopened.length ? { unopened } : {}),
      });
    }
    const label = (c: typeof chests[number]) => `${c.note ? `${c.note}的箱子` : '箱子'} (${c.pos.x},${c.pos.y},${c.pos.z}) ×${c.count}${need !== undefined ? (c.enough ? `（够 ${need}）` : `（不够 ${need}）`) : ''}${c.possiblyStale ? '（未确认全量）' : ''}（${c.dist} 格外）`;
    const listText = chests.length ? `；记得 ${here.length > chests.length ? `${chests.length}/${here.length}` : `${chests.length}`} 只箱子有它：${chests.map(label).join('、')}` : '';
    const shortText = need !== undefined && !sorted.some((r) => r.count >= need) && inChests > 0 ? `；没有单只箱子够 ${need}（箱子里合计×${inChests}）` : '';
    const dimsText = elsewhere.length ? `；其他维度：${elsewhere.slice(0, 4).map((r) => describeRecall(r)).join('；')}` : '';
    const useText = target
      ? `；用 go_near {"target":${JSON.stringify(target)}} 到旁边，再 take_items {"item":"${args.item}"${need !== undefined ? `,"count":${need}` : ''},"target":${JSON.stringify(target)}}`
      : '';
    const enoughText = need !== undefined && backpack >= need ? `；背包已够 ${need}` : '';
    return ok(`${args.item}：背包×${backpack}${listText}；箱子里合计×${inChests}、总计×${total}${enoughText}${shortText}${dimsText}${useText}`, {
      item: args.item, backpack, chest, chests, target, inChests, total,
      ...(need !== undefined ? { needed: need } : {}),
      ...(elsewhere.length ? { elsewhere: elsewhere.slice(0, 8).map((r) => ({ dim: r.chest.dim, pos: r.chest.pos, count: r.count })) } : {}),
    });
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
  description: '经营农田：收割成熟作物并补种；附近有自己见过、上面没有作物的耕地时优先接管（最多 size 格），否则按 crop/size 在附近开垦；消耗对应种子并使用锄头。缺锄头默认返回缺口，make:true 才允许消耗木板/圆石和木棍制作锄头',
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

    // 没有登记过的田时，先采用脚边已经开垦好的空耕地（手工锄的地块不在 memory.farms 里），
    // 而不是另开一块新地。只接管上面没有作物的耕地：不把别人的作物当成自己的收成。
    if (!f && Date.now() < ctx.deadline - 5000) {
      const base = { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y), z: Math.floor(s.pos.z) };
      const offsets = Array.from({ length: 9 }, (_, i) => i - 4);
      const existing = offsets.flatMap((dx) => offsets.flatMap((dz) => [-2, -1, 0, 1].flatMap((dy) => {
        const p = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
        // 只接管亲眼见过（或刚操作过）的耕地，不靠方块读取发现墙后/地下的田。
        const seen = ctx.senses.recognizedAt?.(p) === 'farmland';
        const empty = /^(air|cave_air|void_air)$/.test(adapter.blockAt({ ...p, y: p.y + 1 }) ?? '');
        return seen && adapter.blockAt(p) === 'farmland' && empty ? [p] : [];
      }))).sort((a, b) => Math.hypot(a.x - base.x, a.z - base.z) - Math.hypot(b.x - base.x, b.z - base.z))
        .slice(0, Math.min(args.size, 25));
      if (existing.length >= 2) {
        f = { id: shortId('farm_'), dim: s.dim, crop: args.crop, cells: existing, plantedAt: Date.now(), harvests: 0 };
        memory.addFarm(f);
        ctx.bus.publish('farm', 'P2', `接管附近已开垦的 ${existing.length} 格空耕地`);
      }
    }

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
/** 远征找方块时沿路线两侧检查的范围（格）；结果只覆盖这个范围，不据此断言世界其它地方没有。 */
const EXPEDITION_SCAN_RADIUS = 32;
export const expedition: Skill<{ direction: string; distance: number; find?: string; torches?: boolean; eat_below?: number; dig?: true | string; place?: string; maxEdits?: number }> = {
  name: 'expedition',
  description: '远征：朝一个方向长距离行进（100-600 格），每约 64 格记一个路标，沿途记录新发现；可选 find 指定要找的方块，边走边查路线两侧约 32 格，找到就停并报坐标，走完没看到只说明这段路线附近没有（更远处/遮挡后未知，不是“世界上没有”）。路上是否在路标插火把、饿到多少吃东西写在 torches/eat_below 参数里。回家用 resolve_target 选 base，再 navigate_to 沿路标走。' + MAKE_WAY_DOC + '；dig/place 需要共享空间 VoxelMap，缺失时直接报错且不移动。',
  argsDoc: '{"direction": "N|NE|E|SE|S|SW|W|NW", "distance"?: 100-600, "find"?: "要沿路找的方块（如 log、oak_log、crimson_stem）", "torches"?: true（路标处插火把）, "eat_below"?: 2-19（饿到这个数就吃）,' + MAKE_WAY_ARGS_DOC + '}',
  timeoutMs: 900000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const d = String(a.direction ?? '').toUpperCase();
    if (!DIRS[d]) return { ok: false, error: `direction 必须是 ${Object.keys(DIRS).join('/')}` };
    let find: string | undefined;
    if (a.find !== undefined) {
      const wanted = String(a.find).trim();
      if (!wanted || !adapter.resolveBlockNames(wanted).length) return { ok: false, error: `未知方块：${wanted || '（空）'}` };
      find = wanted;
    }
    const makeWay = parseMakeWay(a);
    if (!makeWay.ok) return makeWay;
    return { ok: true, args: { direction: d, distance: clampInt(a.distance, 100, 600, 240), ...(find ? { find } : {}), ...(a.torches === true ? { torches: true } : {}), ...(a.eat_below !== undefined ? { eat_below: clampInt(a.eat_below, 2, 19, 12) } : {}), ...makeWayArgs(makeWay.value) } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    const s0 = adapter.state();
    // 带多少吃的由 Agent 定：这里只把出发时的食物如实写进回执，不设门槛。
    const food = s0.inventory.filter((i) => FOOD_VALUE[i.name]).reduce((n, i) => n + i.count, 0);
    const [dx, dz] = DIRS[args.direction];
    const start = s0.pos;
    const targets = args.find ? [...new Set(adapter.resolveBlockNames(args.find))] : [];
    // 搜索覆盖度随结果一起返回：只说明“这段路线两侧扫过”，不能升级成“世界其它地方没有”。
    const coverage = {
      target: args.find ?? null, dimension: s0.dim, start: { ...s0.pos }, end: { ...s0.pos },
      travelled: 0, scanRadius: targets.length ? EXPEDITION_SCAN_RADIUS : 0, foodAtStart: food,
      scans: 0, mode: 'known_sightings_along_route' as const, unknownBeyond: true as const,
      found: null as null | { name: string; pos: Vec3Like; dist: number },
    };
    // 显式授权的开路参数：没有 dig/place 时保持原有 adapter.moveTo 单跳，不改变既有行为。
    const making = args.dig !== undefined || args.place !== undefined;
    const editBudget = args.maxEdits ?? MAKE_WAY_DEFAULT_EDITS;
    // 已校验过一次的开路授权；每跳只换本次剩余额度，不再重复 parseMakeWay。
    const makeWayBase = making ? makeWayRequest(args).makeWay : undefined;
    const makeWayEdits: MakeWayEdit[] = [];
    const resultData = (extra: Record<string, unknown>) => ({
      ...extra, coverage,
      ...(making ? { makeWay: { edits: makeWayEdits, editsUsed: makeWayEdits.length, maxEdits: editBudget } } : {}),
    });
    const scan = () => {
      if (!targets.length) return null;
      ctx.senses.refresh();
      coverage.scans += 1;
      return ctx.senses.knownBlocks(targets, EXPEDITION_SCAN_RADIUS)[0] ?? null;
    };
    const discover = (hit: { name: string; pos: Vec3Like; dist: number }) => {
      coverage.found = { name: hit.name, pos: { ...hit.pos }, dist: hit.dist };
      return ok(`远征向 ${args.direction} 走了 ${coverage.travelled} 格，在路线附近发现 ${hit.name} 于 (${hit.pos.x},${hit.pos.y},${hit.pos.z})（约 ${hit.dist} 格外）；已停在发现处`, resultData({
        travelled: coverage.travelled, found: { ...coverage.found }, direction: args.direction,
      }));
    };
    // 开路只在有共享空间体素时能做：没有地图却接受 dig/place 等于静默忽略授权，必须明确交回。
    if (making && ctx.spatial?.session?.voxel === undefined) {
      return fail('BAD_ARGS', `远征请求了 ${args.dig !== undefined ? 'dig' : ''}${args.dig !== undefined && args.place !== undefined ? '/' : ''}${args.place !== undefined ? 'place' : ''}，但当前没有共享空间 VoxelMap，无法按已记录体素代为开路；没有移动。去掉 dig/place 可继续普通移动，或等共享空间接好后重试`, resultData({ travelled: 0, found: null, direction: args.direction, noSharedMap: true }));
    }
    if (targets.length) {
      const atStart = scan();
      if (atStart) return discover(atStart);
    }
    let travelled = 0, waypoints = 0, failures = 0, blocked = false;
    let lastHopFailure: string | undefined, stopReason: string | undefined, terminalFailure: string | undefined;
    const chunks0 = memory.visitedChunkCount;
    // 单跳：没有 dig/place 时就是原来的 xz 移动；授权开路时交给同一个协调器，
    // 用 navigate 意图走向这一跳的终点，普通路线走不通才按 make-way 挖开/补支撑。
    const hopOnce = async (x: number, z: number): Promise<{ failure?: string; stopReason?: string; terminal?: string }> => {
      if (!making) {
        try {
          await adapter.moveTo({ kind: 'xz', x, z, range: 6 }, { signal, timeoutMs: 60000 });
          return {};
        } catch (e) {
          if (isAbort(e)) throw e;
          return { failure: (e as Error).message };
        }
      }
      // 施工额度用完后仍可继续走普通路线；只是不再授权新的挖/放。
      const remaining = editBudget - makeWayEdits.length;
      const hopDeadline = Math.min(ctx.deadline, Date.now() + 60000);
      const outcome = await runMovementCoordinator({ ...ctx, deadline: hopDeadline }, {
        intent: {
          kind: 'navigate',
          to: { x: Math.floor(x), y: Math.floor(adapter.state().pos.y), z: Math.floor(z) },
          targetKind: 'cell', arrival: { radius: 6, metric: 'horizontal' },
          allowed: ['walk', 'step', 'drop', 'jump'], historical: true,
        },
        rolling: true,
        maxSegments: 4, maxStepsPerSegment: 32,
        maxTransitions: 256, invocationMaxTransitions: 96,
        maxSearches: 32, maxObservations: 16, maxObservedCells: 1024, maxNoProgressSegments: 4,
        allowUnknownCorridor: false,
        ...(makeWayBase === undefined ? {} : { makeWay: { ...makeWayBase, maxEdits: Math.max(0, remaining) } }),
        makeWayAvailable: true,
      });
      // 连接/维度/忙碌这类前置失败不是局部阻挡，不能再用普通 moveTo 绕行重试。
      if (!outcome.ok) return { failure: outcome.summary, terminal: outcome.failureCode };
      if (outcome.makeWay !== undefined) makeWayEdits.push(...outcome.makeWay.edits);
      // 取消/挂起必须照原样向上抛，不能把“身体被借走”算成这一跳的局部阻挡。
      if (outcome.status === 'cancelled') { throwIfAborted(signal); return { failure: `这一跳被取消：${outcome.summary}` }; }
      if (outcome.status === 'succeeded') return {};
      // 施工额度在协调器内部耗尽：立即停下交回，不再用普通 moveTo 绕行重试。
      return {
        failure: outcome.summary,
        ...(outcome.stop.reason === 'MAKE_WAY_BUDGET_EXHAUSTED' ? { stopReason: 'MAKE_WAY_BUDGET_EXHAUSTED' } : {}),
      };
    };
    while (travelled < args.distance && Date.now() < ctx.deadline - 5000) {
      // 有目标时缩短单跳，保证每次扫描的 32 格范围有重叠，不会从两跳之间漏过去。
      const hop = Math.min(targets.length ? 24 : 48, args.distance - travelled);
      const p = adapter.state().pos;
      const before = travelled;
      const attempt = await hopOnce(p.x + dx * hop, p.z + dz * hop);
      const afterHop = adapter.state();
      travelled = Math.round(Math.hypot(afterHop.pos.x - start.x, afterHop.pos.z - start.z));
      coverage.travelled = travelled;
      coverage.end = { ...afterHop.pos };
      if (attempt.terminal !== undefined) { lastHopFailure = attempt.failure; terminalFailure = attempt.terminal; blocked = true; stopReason = attempt.terminal; break; }
      let settled = afterHop;
      if (travelled > before) {
        // 只要实测前进了，这一跳即使没到目标也不算失败；下一跳从新位置重规划。
        failures = 0;
        lastHopFailure = attempt.failure;
      } else if (attempt.failure === undefined && travelled >= args.distance - 6) {
        // 协调器到达半径内的最后一小段：不再斜走绕行，直接收工报告实测位置。
        lastHopFailure = undefined;
        break;
      } else {
        lastHopFailure = attempt.failure ?? `这一跳结束时实测位置没有向前推进（${before} → ${travelled} 格）`;
        // 施工额度耗尽且没有推进：停下交回；如果已经推进，下一跳可以走普通路线继续。
        if (attempt.stopReason !== undefined) { blocked = true; stopReason = attempt.stopReason; break; }
        if (++failures >= 3) { blocked = true; stopReason = attempt.failure !== undefined ? 'BLOCKED' : 'NO_PROGRESS'; break; }
        // 绕一下：斜着走一段（沿用原来的成败交替方向）
        const side = failures % 2 === 0 ? 1 : -1;
        await adapter.moveTo({ kind: 'xz', x: p.x - dz * side * 16, z: p.z + dx * side * 16, range: 4 }, { signal, timeoutMs: 20000 }).catch((er) => { if (isAbort(er)) throw er; });
        settled = adapter.state();
        travelled = Math.round(Math.hypot(settled.pos.x - start.x, settled.pos.z - start.z));
        coverage.travelled = travelled;
        coverage.end = { ...settled.pos };
      }
      const hit = scan();
      if (hit) return discover(hit);
      if (travelled >= (waypoints + 1) * 64) {
        waypoints++;
        memory.addLandmark('waypoint', `路标 ${args.direction}-${waypoints}`, settled.dim, settled.pos, 8);
        if (args.torches && settled.inventory.some((i) => i.name === 'torch')) {
          const x = Math.floor(settled.pos.x), y = Math.floor(settled.pos.y), z = Math.floor(settled.pos.z);
          await adapter.placeBlockAt({ x: x + 1, y, z }, ['torch'], signal).catch((er) => { if (isAbort(er)) throw er; });
        }
      }
      if (args.eat_below && settled.food <= args.eat_below && adapter.hasFood()) await adapter.eat(signal).catch((er) => { if (isAbort(er)) throw er; });
      if (settled.hp <= 8) { blocked = true; stopReason = 'BLOCKED'; break; }
      ctx.progress(travelled / args.distance, `远征 ${args.direction}：${travelled}/${args.distance} 格，路标 ${waypoints}`);
      await sleep(50, signal);
    }
    const newChunks = memory.visitedChunkCount - chunks0;
    const foodNow = adapter.state().inventory.filter((i) => FOOD_VALUE[i.name]).reduce((n, i) => n + i.count, 0);
    const foodText = `；食物 出发时 ${food} 个、现在 ${foodNow} 个`;
    // 停下的原因只说明这一跳/这段路线，不能说成整个方向不可通行。
    const localFact = lastHopFailure === undefined ? ''
      : terminalFailure !== undefined
        ? `；这次远征因前置条件失败停下（${terminalFailure}）：${lastHopFailure}`
        : `；最后一次向前单跳没有通过（局部阻挡/单跳失败，不代表整个 ${args.direction} 方向不可通行）：${lastHopFailure}`;
    const stopLabel = terminalFailure !== undefined ? '（前置失败）' : blocked ? '（中途受阻）' : '';
    const editText = making ? `；本次远征累计施工改动 ${makeWayEdits.length}/${editBudget}` : '';
    const stopFacts = {
      ...(blocked ? { blocked: true, stopReason: stopReason ?? 'BLOCKED' } : {}),
      ...(terminalFailure === undefined ? {} : { terminalFailure }),
      ...(lastHopFailure === undefined ? {} : { lastHopFailure }),
    };
    if (targets.length) {
      const msg = `远征向 ${args.direction} 走了 ${travelled} 格（目标 ${args.distance} 格），路线两侧约 ${EXPEDITION_SCAN_RADIUS} 格内没看见 ${args.find}；更远处和遮挡后仍未知${stopLabel}${foodText}${editText}${localFact}`;
      const data = resultData({ travelled, found: null, direction: args.direction, ...stopFacts });
      return travelled >= args.distance * 0.5
        ? ok(msg, data)
        : fail('PATH_NOT_FOUND', `${msg}${blocked ? '' : `；这次只走到这里，不代表整个 ${args.direction} 方向不可通行`}`, data);
    }
    const msg = `远征向 ${args.direction} 走了 ${travelled} 格，新区块 +${newChunks}，留下 ${waypoints} 个路标${foodText}${editText}${localFact}`;
    // 没有 find 的远征也要带回起点/终点，供出行账记录实测推进；不改变远征行为。
    const data = resultData({ travelled, direction: args.direction, ...stopFacts });
    return travelled >= args.distance * 0.5
      ? ok(msg, data)
      : fail('PATH_NOT_FOUND', `${msg}${blocked ? '' : `（只走到这里，不代表整个 ${args.direction} 方向不可通行）`}`, data);
  },
};

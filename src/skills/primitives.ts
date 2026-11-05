import type { Vec3Like } from '../adapter/types.ts';
import { FACINGS, facingOfYaw, feetCell, localMap, supportCell, toWorld, type Facing } from '../perception/local.ts';
import { attachmentFaces, dropBelow, isSoftBlock, LIQUID_BLOCKS, surroundings } from '../perception/surroundings.ts';
import { blockCollidesBody, bodyBoxAt, bodyCells, estimatedFallDamage, footSurfaceY, hasAnyCollision, isReplaceable, placementReference, shapeKnown, supportTop, type BlockProps } from '../perception/geometry.ts';
import { AbortedError, sleep, throwIfAborted } from '../util.ts';
import { breakCell, why } from './body.ts';
import { classifyBlock, MAN_MADE_NOTE, OWN_BUILDING_HINT, ownBuildingAt, storedChestAt } from './build.ts';
import { noteEdit } from '../mind/edits.ts';
import { glanceAt } from './observation.ts';
import { PLACEABLE } from './survival.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';
import { findStation, isStation, rememberStation } from './stations.ts';

/**
 * 原子动作：模型说出确切是哪一格，身体只负责准确执行、检查安全、如实回报。
 * 坐标是以脚为原点的 [前, 上, 右]，前 = facing（不写就按规划时的朝向固定下来）。
 * 在 routine 里重复时，每一步都按“当时站的位置”重新计算，所以
 *   dig_at [0,2,0] → dig_at [1,1,0] → dig_at [1,2,0] → step [1,1,0]   重复几轮就是一道往前上方的阶梯。
 */
type Rel = [number, number, number];
interface CellArgs { at: Rel; facing: Facing; own?: boolean; wet?: boolean; lava?: boolean; fall?: boolean; xyz?: Vec3Like }
interface StepArgs extends CellArgs { fill?: string }
const AIR = new Set(['air', 'cave_air', 'void_air']);

/** 模型常用的几种写法都认：at / to / pos / offset / rel / cell，数组 [1,1,0]、字符串 "1,1,0"、对象 {"f":1,"u":1,"r":0} */
function relValue(a: Record<string, any>): unknown {
  const v = a.at ?? a.to ?? a.pos ?? a.position ?? a.offset ?? a.rel ?? a.cell;
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean).map(Number);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const f = v.f ?? v.forward ?? v.front, u = v.u ?? v.up, r = v.r ?? v.right;
    if ([f, u, r].every((n) => n !== undefined)) return [Number(f), Number(u), Number(r)];
  }
  return v;
}

function parseRel(v: unknown, bounds: { f: number; u: [number, number]; r: number }): Rel | string {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isInteger(n))) return '需要 "at":[前,上,右] 三个整数，例如 {"at":[1,1,0]}';
  const [f, u, r] = v as number[];
  if (f === 0 && r === 0 && u < bounds.u[0]) return `够不到脚下 ${-u} 格：往下挖几格就重复 dig_at [0,-1,0]，每挖空一格人就掉下去一格`;
  if (Math.abs(f) > bounds.f || Math.abs(r) > bounds.r || u < bounds.u[0] || u > bounds.u[1]) return `只能是身边的格子：前后 ±${bounds.f}、左右 ±${bounds.r}、上下 ${bounds.u[0]}..${bounds.u[1]}`;
  return [f, u, r];
}

function facingArg(raw: unknown, adapter: { eye(): { yaw: number } | null }): Facing | string {
  if (raw === undefined || raw === null) { const eye = adapter.eye(); return eye ? facingOfYaw(eye.yaw) : 'N'; }
  const f = String(raw).trim().toUpperCase();
  return FACINGS.includes(f as Facing) ? (f as Facing) : 'facing 只能是 N/E/S/W';
}

/** 执行后附上身边的新样子，模型下一步就知道该挖哪格 */
function after(ctx: SkillCtx, facing: Facing, target?: Vec3Like) {
  const s = ctx.adapter.state();
  return { position: { ...s.pos }, ...(target ? { targetCell: { ...target } } : {}), local: localMap(ctx.adapter, s.pos, facing, ctx.senses.observeBlocks?.bind(ctx.senses)), around: surroundings(ctx.adapter).text };
}

function visibleCells(ctx: SkillCtx, positions: Vec3Like[]) {
  ctx.senses.refresh();
  return new Map((ctx.senses.observeBlocks?.(positions) ?? []).map((b) => [`${b.pos.x},${b.pos.y},${b.pos.z}`, b.name]));
}

/** 只认本次视线确认的方块及其 blockstate；用于 step 的几何（未观察 = 未知，不读 blockAt 墙后数据）。 */
function visibleStates(ctx: SkillCtx, positions: Vec3Like[]) {
  ctx.senses.refresh();
  return new Map((ctx.senses.observeBlocks?.(positions) ?? []).map((b) => [`${b.pos.x},${b.pos.y},${b.pos.z}`, { name: b.name, properties: b.properties ?? {} }]));
}

const liquidNext = (ctx: SkillCtx, c: Vec3Like) => wetNeighbours(ctx, c)[0]?.name;
/** 这一格挖开以后会流进来的液体：在哪几格（侧面四格和上面；下面的流不上来） */
const wetNeighbours = (ctx: SkillCtx, c: Vec3Like) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
  .map(([dx, dy, dz]) => ({ pos: { x: c.x + dx, y: c.y + dy, z: c.z + dz }, name: ctx.adapter.blockAt({ x: c.x + dx, y: c.y + dy, z: c.z + dz }) ?? '' }))
  .filter((w) => LIQUID_BLOCKS.has(w.name));
/** 世界坐标换回以脚为原点的 [前,上,右] */
const FWD: Record<Facing, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const RGT: Record<Facing, [number, number]> = { N: [1, 0], E: [0, 1], S: [-1, 0], W: [0, -1] };
const toRel = (feet: Vec3Like, facing: Facing, p: Vec3Like): [number, number, number] => {
  const dx = p.x - feet.x, dz = p.z - feet.z;
  return [dx * FWD[facing][0] + dz * FWD[facing][1], p.y - feet.y, dx * RGT[facing][0] + dz * RGT[facing][1]];
};

/** 挖下来是要带走的东西（挖下来的方块就是同名物品）：挖完核对有没有真进背包 */
const KEEPSAKE = /_bed$|^(crafting_table|furnace|smoker|blast_furnace|chest|barrel|anvil|jukebox|ender_chest|enchanting_table|brewing_stand|cartography_table|smithing_table|loom|stonecutter|grindstone)$|_door$|shulker_box$/;

export const digAt: Skill<CellArgs> = {
  name: 'dig_at',
  description: '挖掉身边指定的一格；目标不在视野时先转头看向它，仍看不见则返回未知，不挖其他位置。自动换现有工具，默认不造工具。液体邻格默认不挖；wet:true 接受进水，lava:true 接受进岩浆，分别显式选择。挖脚下支撑块若下方有落差/液体会默认拦住，fall:true 才接受坠落风险照挖（风险已如实报告，挖不挖由你定）。只挖不走，不能挖基岩。斜下格 [1,-1,0] 在正前方那格后面，看不见也挖不到；往下挖 [0,-1,0] 挖的是脚下支撑块（半砖、耕地这类矮方块就在脚这一格，挖空后自己会落下）',
  argsDoc: '{"at":[前,上,右], "facing"?:"N|E|S|W", "own"?:true, "wet"?:true（允许进水）, "lava"?:true（允许进岩浆）, "fall"?:true（接受挖脚下后的坠落风险）}（前后/左右 ±2，上下 -1..3；facing 定义相对坐标的方向，执行时可能转头观察固定的目标格；例：[1,1,0] 前方高一格，[0,2,0] 头顶上方（往上挖用这个；[0,1,0] 是自己站的头那格、本来就空），[0,-1,0] 脚下的支撑块（半砖等矮方块就在脚这一格））',
  timeoutMs: 30000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    const facing = facingArg(a.facing, adapter);
    if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
    // [0,0,0]/[0,1,0] 是自己站的两格，本来就空：照样接受（执行时说明一下），不当成写错丢掉
    return { ok: true, args: { at, facing: facing as Facing, ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(a.fall === true ? { fall: true } : {}) } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const raw = ctx.adapter.state().pos;
    const feet = feetCell(raw);
    // [0,-1,0] 是“挖掉脚下的支撑格”：半砖、耕地、床这类不满一格的方块，支撑就在脚所在那格本身，
    // 直接套 feetCell 的 y-1 会挖到它下面的空气，永远挖不到脚下的台阶。用 supportCell 按脚高落到真正的支撑格。
    // 绝对坐标 xyz 只解析一次，是明确的世界方块格，不能再被这个相对特例重解释成“挖当前支撑”。
    const support = supportCell(raw);
    const digsSupport = args.xyz !== undefined
      ? args.xyz.x === support.x && args.xyz.y === support.y && args.xyz.z === support.z
      : args.at[0] === 0 && args.at[2] === 0 && args.at[1] === -1;
    const pos = args.xyz !== undefined
      ? { x: args.xyz.x, y: args.xyz.y, z: args.xyz.z }
      : digsSupport ? support : toWorld(feet, args.facing, args.at);
    // 只把 blockAt 当作“是否加载”的物理提示，绝不再拿它冒充“已经看见是空气”。
    const loaded = ctx.adapter.blockAt(pos);
    // 自己站的两格是接触证据：人就在里面，火把、花、雪层这类东西直接够得着。
    const ownCell = args.at[0] === 0 && args.at[2] === 0 && (args.at[1] === 0 || args.at[1] === 1);
    if (loaded === null) return fail('NOT_FOUND', `[${args.at}] 那一格还没加载（区块没载入），看不见也没法挖`, { ...after(ctx, args.facing, pos), noop: true, obscured: true });
    if (ownCell && AIR.has(loaded)) return ok(`[${args.at}] 是${args.at[1] === 0 ? '自己站的脚' : '自己的头'}，本来就空着，别挖这里；往上挖是 [0,2,0]`, { ...after(ctx, args.facing, pos), noop: true });
    const key = `${pos.x},${pos.y},${pos.z}`;
    // 非自身格必须由本次视线确认；未观察 = 未知，不把墙后/斜下格的 raw 数据当成空气。
    let seenBefore: string | undefined = ownCell ? loaded ?? undefined : visibleCells(ctx, [pos]).get(key);
    if (!seenBefore && !ownCell && ctx.senses.observeBlocks) {
      await glanceAt(ctx, pos);
      throwIfAborted(ctx.signal);
      seenBefore = visibleCells(ctx, [pos]).get(key);
    }
    if (!seenBefore) {
      const [df, du, dr] = args.at;
      const diagonalDown = du === -1 && (df !== 0 || dr !== 0);
      const hint = diagonalDown
        ? `；斜下格在正前方/侧方那格后面，本来就看不见也挖不到——先挖 [${df},0,${dr}] 让这格露出来，再挖 [${df},-1,${dr}]，或直接往下挖 [0,-1,0]`
        : '';
      return fail('NOT_FOUND', `[${args.at}] 没有发生挖掘：目标格 (${pos.x},${pos.y},${pos.z}) 状态未确认（视野外/被遮挡/未加载），不把未看见当作空气；换个站位或先挖掉挡着的那一格${hint}`, {
        ...after(ctx, args.facing, pos), targetCell: { ...pos }, cell: [...args.at], noop: true, obscured: true, unknown: true,
      });
    }
    const before = seenBefore;
    if (AIR.has(before)) return ok(`[${args.at}] 本来就是空的，不用挖`, { cell: [...args.at], was: 'air', evidence: 'vision', ...after(ctx, args.facing, pos), noop: true });
    if (LIQUID_BLOCKS.has(before)) return fail('BAD_ARGS', `[${args.at}] 是 ${seenBefore}，挖不了`, after(ctx, args.facing, pos));
    // 挖开会进水/进岩浆：默认不挖，但说清是哪几格、能怎么办（像人一样先堵上，或者认了让水流进来）
    const wets = wetNeighbours(ctx, pos);
    const blocked = wets.filter((w) => /lava/.test(w.name) ? !args.lava : !args.wet);
    if (blocked.length) {
      const cells = wets.map((w) => `[${toRel(feet, args.facing, w.pos)}] 是 ${w.name}`).join('、');
      const fix = blocked.some((w) => /lava/.test(w.name)) ? '可以先堵上，或写 "lava":true 明确接受岩浆流入的风险后照挖'
        : `可以先 place_at 往那几格放方块把水堵上（水格可以直接放方块），或者写 "wet":true 照挖、让水流进来（水只会漫过来，不会伤人，挖完可以再堵）；也可以换个方向`;
      return fail('BAD_ARGS', `[${args.at}] 挖开会有液体流进来：${cells}。${fix}`, { wet: wets[0].name, wetCells: wets.map((w) => toRel(feet, args.facing, w.pos)), ...after(ctx, args.facing, pos) });
    }
    let fallFacts: { below: string | null; drop: number | null; fallRisk: string } | undefined;
    // 挖的是脚下支撑块（相对 [0,-1,0] 或绝对坐标正好落在支撑格）：挖前先向下扫 3 格确认有安全落点
    // （和 dig dir:down 同一套），落差未知/超过 3 格、或下面就是液体时拒绝，避免挖掉自己的支撑直接坠落。
    if (digsSupport) {
      const { drop, landing } = dropBelow(ctx.adapter, pos);
      if (drop === 0 || LIQUID_BLOCKS.has(landing ?? '')) {
        // 物理检查可以阻止未授权动作，但反馈只说明当前观察支持的事实，不能透露支撑格遮住的落点。
        const below = [1, 2, 3].map((d) => ({ x: pos.x, y: pos.y - d, z: pos.z }));
        const seen = visibleCells(ctx, below);
        const observed = dropBelow({ blockAt: (p) => seen.get(`${p.x},${p.y},${p.z}`) ?? null }, pos);
        const reason = observed.drop > 0
          ? `已观察到下方 ${observed.drop} 格是 ${observed.landing}，移除支撑后会向下坠落`
          : below.every((p) => seen.has(`${p.x},${p.y},${p.z}`))
            ? '下方已观察的 3 格内未见落点，移除支撑后有较大落差风险'
            : '下方落点未看清，移除脚下支撑后存在未知的坠落风险';
        fallFacts = { below: observed.landing, drop: observed.drop || null, fallRisk: reason };
        if (!args.fall) return fail('BAD_ARGS', `[${args.at}] 挖的是脚下支撑块：${reason}，没有往下挖；如果确认接受这个坠落风险，写 "fall":true 再挖`, { ...after(ctx, args.facing, pos), ...fallFacts });
      }
    }
    const mine = args.own ? null : ownBuildingAt(ctx.memory, ctx.adapter.state(), pos, before);
    if (mine) return fail('BAD_ARGS', `[${args.at}] 的 ${before} 是自己盖的「${mine.name}」的一部分；${OWN_BUILDING_HINT}`, { own: mine, ...after(ctx, args.facing, pos) });
    // 不是自己的房子、也不是自己的矿道，但看起来是人造建材（村庄/别人家）：只报事实，拆不拆由它定
    const structure = classifyBlock(ctx.memory, ctx.adapter.state(), pos, before);
    const stash = args.own ? null : storedChestAt(ctx.memory, ctx.adapter.state(), pos, before);
    if (stash) return fail('BAD_ARGS', stash, after(ctx, args.facing, pos));
    const how: { noDrop?: boolean; ms?: number } = {};
    const keepsake = KEEPSAKE.test(before) ? before : null;
    const countOf = (n: string) => ctx.adapter.state().inventory.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
    const had = keepsake ? countOf(keepsake) : 0;
    try {
      await breakCell(ctx, pos, true, how, { allowWater: args.wet, allowLava: args.lava });
    } catch (e) {
      if (isAbort(e)) throw e;
      const m = String((e as Error).message);
      const code = m.startsWith('NEED_TOOL') || m === 'TOOL_MISSING' ? 'TOOL_MISSING' : codeFromError(e);
      return fail(code, seenBefore ? `挖 [${args.at}] 的 ${seenBefore} 没成：${why(e)}` : `挖 [${args.at}] 没成（${code}）；未触碰或看清目标，不能确认方块名称`, { ...after(ctx, args.facing, pos), ...fallFacts });
    }
    const now = ctx.adapter.blockAt(pos);
    if (now && !AIR.has(now) && !isSoftBlock(now)) {
      // 沙子、沙砾会从上面掉下来补上
      return ok(`挖掉了 [${args.at}] 的 ${before}，但上面掉下来的 ${now} 又填上了`, { cell: [...args.at], was: before, now, ...after(ctx, args.facing, pos), ...fallFacts });
    }
    noteEdit(ctx.taskId, 'dig', pos);
    // 空手挖的：挖开了，但慢、不掉东西（要拿到圆石、矿石得用镐）
    const hand = how.noDrop ? `（空手挖的，用了 ${Math.max(1, Math.round((how.ms ?? 0) / 1000))} 秒，没有掉落：要拿到东西得用镐）` : '';
    // 床、工作台、熔炉、箱子这类要搬走的东西：挖下来不等于拿到了，看背包里有没有真的多出来
    let got = '';
    let inBag: boolean | undefined;
    if (keepsake && !how.noDrop) {
      for (let i = 0; i < 6 && countOf(keepsake) <= had; i++) await sleep(150, ctx.signal);
      inBag = countOf(keepsake) > had;
      got = inBag ? `；${keepsake} 已经进了背包（现在共 ${countOf(keepsake)} 个）` : `；${keepsake} 掉在地上，还没进背包——要拿回来写 pickup_items {"item":"${keepsake}"}，别当成已经拿到了`;
    }
    const manMade = structure === 'man-made' ? `；${MAN_MADE_NOTE}` : '';
    return ok(`挖掉了 [${args.at}] 的 ${before}${hand}${got}${manMade}`, { cell: [...args.at], was: before, ...(how.noDrop ? { noDrop: true } : {}), ...(inBag !== undefined ? { inBag } : {}), ...after(ctx, args.facing, pos), ...fallFacts }, structure === 'man-made' ? MAN_MADE_NOTE : undefined);
  },
};

const WATER_PLANTS = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);

/**
 * 在水里迈向相邻一格：那一列上（比脚低 1 格到高 2 格）有干的落脚处，就朝它游过去、贴岸按住跳爬上去。
 * 那一列没有能站的干地时返回 null，交给平常的检查（会说清楚那边是什么）。
 */
async function stepOutOfWater(ctx: SkillCtx, args: CellArgs, feet: Vec3Like) {
  const a = ctx.adapter;
  const dry = (p: Vec3Like) => { const n = a.blockAt(p); return n !== null && (AIR.has(n) || isSoftBlock(n)) && !LIQUID_BLOCKS.has(n) && !WATER_PLANTS.has(n); };
  const solid = (p: Vec3Like) => { const n = a.blockAt(p); return n !== null && !LIQUID_BLOCKS.has(n) && !AIR.has(n) && !isSoftBlock(n); };
  const base = toWorld(feet, args.facing, [args.at[0], 0, args.at[2]]);
  let stand: Vec3Like | null = null, dy = 0;
  for (const k of [...new Set([args.at[1], 1, 0, 2, -1])]) {
    const c = { ...base, y: feet.y + k };
    if (solid({ ...c, y: c.y - 1 }) && dry(c) && dry({ ...c, y: c.y + 1 })) { stand = c; dy = k; break; }
  }
  if (!stand) return null;
  const rel: [number, number, number] = [args.at[0], dy, args.at[2]];
  let res: { ok: boolean; reason?: string };
  try {
    res = await a.swimTo!({ x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, ctx.signal, { timeoutMs: Math.max(1000, Math.min(7000, ctx.deadline - Date.now())) });
  } catch (e) {
    // 取消时保留辅助实际选定的上岸落点，不能只用原请求目标或最后位置代替。
    if (isAbort(e)) (e as Error & { partial?: Record<string, unknown> }).partial = { stand: { ...stand }, rel: [...rel] };
    throw e;
  }
  const s = a.state(), end = feetCell(s.pos);
  if (!s.inWater && s.onGround && end.x === stand.x && end.y === stand.y && end.z === stand.z) {
    return ok(`从水里爬上了岸 [${rel}]（实际在 (${end.x},${end.y},${end.z})）`, { moved: rel, landed: true, ...after(ctx, args.facing, stand) });
  }
  return fail('EFFECT_NOT_CONFIRMED', `从水里朝 [${rel}] 的岸爬了，没有站到指定落脚格（岸边落脚处比脚高 ${dy} 格；${res.ok ? '' : `游泳：${res.reason}；`}现在${s.inWater ? '还在水里' : s.onGround ? '已离水并站稳' : '不在水里但没站稳'}，实际在 (${end.x},${end.y},${end.z})）`, { stand: rel, ...after(ctx, args.facing, stand) });
}

export const stepTo: Skill<StepArgs> = {
  name: 'step',
  description: '迈到身边相邻的一格（[前,上,右]）：可以平走、上一级台阶（上+1，会跳）、下一级（上-1）；脚下是梯子时 [0,1,0] 沿梯子爬一格。落点按实际碰撞顶面计算（整块、半砖、雪层、地毯都能站，脚高可为分数）；目标列没有同层支撑时向下扫到第一处可站立面：4 格内自动走并报告落差和摔伤，更大落差返回精确落点、高度和伤害由你判断。显式上 1 格只接受至少高半格的目标面；持平或更低时回报实际脚高/下一落点，不会自动改平走。不做逐格视线预检，也不因支撑格是 air 就报错；身体被占住或扫完 64 格无落点才拒绝，并给出挖掘坐标、精确高度或要补的支撑格。泡在水里时朝岸迈（[1,0,0]），身体会游过去、贴岸爬上去（岸比脚高一两格也行）。可选 fill：支撑格是空气或可替换植物时先只补那一格再迈（消耗 1 块）；不写就不垫',
  argsDoc: '{"to":[前,上,右], "facing"?:"N|E|S|W", "fill"?:方块名（目标脚下空或可替换时先补这一格，可搭桥）}（前后/左右 ±1，上下 -1..1；[1,0,0] 平走，也会自动迈上相邻一格台阶或处理 4 格以内落差，更大落差会返回精确高度；[1,1,0] 明确上一级，目标列没有高半格的面时只回报实际脚高/下一落点，不自动改平走；[1,-1,0] 明确下一级；更深落差用 descend）',
  timeoutMs: 8000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const to = parseRel(relValue(a), { f: 1, u: [-1, 1], r: 1 });
    if (typeof to === 'string') return { ok: false, error: to };
    if (to[0] === 0 && to[2] === 0) {
      // 站在梯子里可以直接往上爬一格；没有梯子时原地上下不是 step
      const feetBlock = adapter.blockAt(feetCell(adapter.state().pos));
      if (!(to[1] === 1 && feetBlock === 'ladder')) return { ok: false, error: `原地上下不是 step：往上只有脚下有梯子才能爬（现在脚下这格是 ${feetBlock ?? '未知'}），否则要 place_at [0,0,0] 垫一块站上去；往下用 dig_at [0,-1,0]（脚下挖空人会自己掉下去，不需要再 step）` };
    }
    const facing = facingArg(a.facing, adapter);
    if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
    const rawFill = a.fill ?? a.support;
    let fill: string | undefined;
    if (rawFill !== undefined && rawFill !== null) {
      fill = String(rawFill).trim().replace(/^minecraft:/, '');
      if (!/^[a-z0-9_]{1,80}$/.test(fill) || !adapter.isKnownItem(fill)) return { ok: false, error: `fill 需要已知的方块名（例如 cobblestone），收到 ${String(rawFill)}` };
      if (/_(boat|raft)$/.test(fill)) return { ok: false, error: `${fill} 是船/筏（实体，不是方块），不能用来补支撑` };
    }
    return { ok: true, args: { at: to, facing: facing as Facing, ...(fill ? { fill } : {}) } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const a = ctx.adapter;
    // 相对坐标必须从真实的落脚状态量：上一动作的跳跃/下落还没结束时，脚格、支撑和净空都是空中的瞬时值，
    // 算出来的 [1,1,0] 会对不上地面。有界等身体真正触地再继续；水里、岩浆里和梯子上本来就不算“在跳”。
    const s0 = a.state();
    if (!s0.onGround && !s0.inWater && !s0.inLava && !s0.riding && a.blockAt(feetCell(s0.pos)) !== 'ladder') {
      const settleBy = Date.now() + Math.min(800, Math.max(0, ctx.deadline - Date.now()));
      while (!a.state().onGround && Date.now() < settleBy) {
        throwIfAborted(ctx.signal);
        await sleep(50, ctx.signal);
      }
    }
    const start = a.state().pos, feet = feetCell(start);
    const target = toWorld(feet, args.facing, args.at);
    // 取消/中断时保留已发生位移与最后位置：Arbiter 经 AbortedError.partial 拿到。所有执行模式（平走/梯子/水中）共用。
    const partialFacts = (extra?: Record<string, unknown>) => {
      const s = a.state();
      return { at: args.at, ...(args.xyz !== undefined ? { xyz: args.xyz } : {}), target: { ...target }, position: { ...s.pos }, moved: s.pos.x !== start.x || s.pos.y !== start.y || s.pos.z !== start.z, ...(extra ?? {}) };
    };
    // 走路不再逐格做视线扫描：用当前已加载的方块状态判断落点和身体净空，是否真能走过去交给寻路器。
    // 目标格/其正下方能站就正常走；站不住时只在 4 格内找较低落点（安全坠落范围），不因“没看过”原地卡住。
    const rawState = (p: Vec3Like) => {
      const name = a.blockAt(p);
      return name === null ? null : { name, properties: a.blockStateAt?.(p)?.properties ?? {} };
    };
    const rawFoot = (p: Vec3Like) => footSurfaceY(p, rawState);
    const bodyProblem = (footY: number, cx: number, cz: number) => {
      const body = bodyBoxAt(footY, cx, cz);
      for (const cell of bodyCells(footY, cx, cz)) {
        const o = rawState(cell);
        if (o && blockCollidesBody(o.name, o.properties, cell, body)) return { cell, name: o.name };
      }
      return null;
    };
    const describe = (p: Vec3Like) => rawState(p)?.name ?? '未加载的格子';
    // 方块名属于观察信息：碰撞判定可以用已加载方块，但反馈里只说亲眼看过的那一格，没看过就不报名字。
    const visibleName = (p: Vec3Like) => ctx.senses.observeBlocks?.([p])?.[0]?.name ?? null;
    const blockerLabel = (p: Vec3Like) => visibleName(p) ?? '实心方块';
    const absolute = args.xyz !== undefined;
    const requestedFoot = absolute ? args.xyz!.y : feet.y + args.at[1];
    // 直接落点优先（含半砖顶面、一格台阶）；站不住时一直向下找，拿到精确落点和落差。
    // 4 格以内仍自动走（不卡在微小落差上）；更大的落差把精确高度和预计摔伤交回给 Agent 判断。
    // 向上迈也扫同一列：扫描结果用于如实回报这一列的真实脚高，不能把“没扫过”写成“64 格空腔”。
    const scanLanding = (): { direct: number | null; foot: number | null; drop: number; unknown: number } => {
      if (absolute) return { direct: requestedFoot, foot: requestedFoot, drop: start.y - requestedFoot, unknown: 0 };
      const direct = rawFoot(target);
      if (direct !== null) return { direct, foot: direct, drop: start.y - direct, unknown: 0 };
      let unknown = 0;
      for (let depth = 1; depth <= 64; depth++) {
        const cell = { x: target.x, y: target.y - depth, z: target.z };
        if (a.blockAt(cell) === null) unknown++;
        const foot = rawFoot(cell);
        if (foot !== null && Math.abs(foot - cell.y) <= 0.95) return { direct: null, foot, drop: start.y - foot, unknown };
      }
      return { direct: null, foot: null, drop: 0, unknown };
    };
    // 泡在水里：脚下那格是水、岸往往比脚高一两格，平地上的“上下 ±1”对不上。像玩家一样朝那边游、贴着岸按住跳爬上去。
    // 这项“邻列内多高度选出口”的辅助只属于相对 step；绝对 xyz/stepTo 保持所选脚高，不套用多高度搜索。
    if (a.state().inWater && a.swimTo && args.xyz === undefined) {
      try {
        const out = await stepOutOfWater(ctx, args, feet);
        if (out) return out;
      } catch (e) {
        if (isAbort(e)) {
          // 保留原请求目标，同时合并水中辅助实际选定的上岸落点（stand/rel），不能用最后位置代替。
          const prev = (e as Error & { partial?: Record<string, unknown> }).partial ?? {};
          (e as Error & { partial?: Record<string, unknown> }).partial = { ...partialFacts(), ...prev };
        }
        throw e;
      }
    }
    // 沿梯子往上爬一格：目标是自己头那格，脚下是梯子；头顶上方要空。绝对 xyz 也走这条（整数脚高才触发）。
    if (args.at[0] === 0 && args.at[2] === 0 && args.at[1] === 1) {
      if (args.xyz !== undefined && Math.abs(args.xyz.y - target.y) > 0.01) {
        return fail('BAD_ARGS', `当前 step 的梯子辅助仅支持整数脚高，收到 ${args.xyz.y.toFixed(2)}`, after(ctx, args.facing, target));
      }
      const blocker = bodyProblem(target.y, target.x, target.z);
      if (blocker) return fail('PATH_NOT_FOUND', `梯子往上爬不动：头顶上方是 ${blocker.name}`, after(ctx, args.facing, target));
      let movementError: unknown;
      try {
        await a.moveTo({ kind: 'xyz', x: target.x, y: target.y, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())), allowTerrainChanges: false });
      } catch (e) {
        if (isAbort(e)) {
          (e as Error & { partial?: Record<string, unknown> }).partial = partialFacts({ targetFoot: target.y });
          throw e;
        }
        movementError = e;
      }
      if (ctx.signal.aborted) {
        const ab = new AbortedError(String(ctx.signal.reason ?? 'aborted'));
        (ab as Error & { partial?: Record<string, unknown> }).partial = partialFacts({ targetFoot: target.y });
        throw ab;
      }
      const end = feetCell(a.state().pos);
      if (end.x !== target.x || end.y !== target.y || end.z !== target.z) return fail(movementError ? codeFromError(movementError) : 'EFFECT_NOT_CONFIRMED', `没有爬到指定格，实际在 (${end.x},${end.y},${end.z})${movementError ? `；${(movementError as Error).message}` : ''}`, after(ctx, args.facing, target));
      return ok(`沿梯子爬上了一格（现在 y=${end.y}）${a.blockAt({ ...end }) === 'ladder' ? '' : '；这格没有梯子了，再往上要先挂'}`, { moved: [0, 1, 0], ...after(ctx, args.facing, target) });
    }
    const corners = args.at[0] !== 0 && args.at[2] !== 0
      ? [{ x: target.x, z: feet.z }, { x: feet.x, z: target.z }]
      : [];
    let scan = scanLanding();
    const support = { x: target.x, y: target.y - 1, z: target.z };
    const supportAt = toRel(feet, args.facing, support);
    const landingSupport = {
      pos: support, at: supportAt,
      placeAtInRange: supportAt[1] >= -2 && supportAt[1] <= 3,
      observed: rawState(support)?.name ?? null,
      reference: placementReference(support, rawState),
    };
    if (absolute) {
      const actual = rawFoot(target);
      if (actual !== null && Math.abs(actual - requestedFoot) > 0.01) {
        return fail('PATH_NOT_FOUND', `目标格 (${target.x},${target.y},${target.z}) 的支撑面在 y=${actual.toFixed(2)}，与绝对脚高 ${requestedFoot.toFixed(2)} 不符；未执行迈步`,
          { targetCell: target, expectedFoot: requestedFoot, actualSupport: actual, movementNotAttempted: true, ...after(ctx, args.facing, target) });
      }
    }
    const fills: { pos: Vec3Like; at: [number, number, number]; item: string }[] = [];
    // 只有 agent 显式写了 fill 才补支撑：选哪种材料、要不要垫仍由 agent 决定；这里只负责把这一块放到
    // 脚部目标格正下方，然后按实际方块重算落点，不额外改落点或方向。
    if (args.fill && isReplaceable(rawState(support)?.name ?? '') && landingSupport.placeAtInRange) {
      const placed = await placeAt.run(ctx, { at: supportAt, facing: args.facing, item: args.fill });
      if (placed.status !== 'succeeded') {
        return fail(placed.failureCode ?? 'PATH_NOT_FOUND',
          `迈不到 [${args.at}]：先往支撑格 [${supportAt}] 补 ${args.fill} 没成——${placed.summary}`,
          { movementNotAttempted: true, fill: { at: supportAt, item: args.fill, pos: support }, ...after(ctx, args.facing, target) });
      }
      fills.push({ pos: support, at: supportAt, item: args.fill });
      scan = scanLanding();
    }
    // 显式上 1 格：只接受至少高半格的目标面。不接受时也要把这一列的真实脚高/下一落点说清楚，
    // 不能拿“没往下扫”冒充“64 格空腔”；也不把 Agent 要求的向上迈偷偷改成平走。
    const upStep = !absolute && args.at[1] > 0;
    if (upStep && !(scan.direct !== null && scan.direct >= feet.y + 0.5)) {
      const supportName = describe(support);
      const footText = scan.foot === null ? null : scan.foot.toFixed(2);
      const height = scan.foot === null ? null
        : Math.abs(scan.foot - start.y) <= 0.01 ? '与当前脚高相同'
        : scan.foot > start.y ? `只比当前脚高 ${(scan.foot - start.y).toFixed(2)} 格`
        : `比当前脚低 ${(start.y - scan.foot).toFixed(2)} 格`;
      const fact = footText === null
        ? `目标列下方已扫 64 格${scan.unknown ? `（其中 ${scan.unknown} 格未加载/未知）` : ''}没有可站立面，上不去`
        : `这一列的可站立面在 y=${footText}（${height}），不是上 1 格`;
      return fail('PATH_NOT_FOUND', `迈不到 [${args.at}]：目标格脚下 (${support.x},${support.y},${support.z}) 是 ${supportName}；${fact}。脚部目标格 [${args.at}] 须留空——要补支撑就是 [${supportAt}] 这一格（step 写 fill:"<方块名>" 可先补这里；也可先 place_at）；要平走请把上分量改成 0；未执行迈步`,
        {
          problems: [`目标格脚下 (${support.x},${support.y},${support.z}) 是 ${supportName}，${footText === null ? '下方 64 格内无落点' : `这一列可站立面 y=${footText}，不是上 1 格`}`],
          targetCell: target, landingSupport,
          ...(footText === null ? { scannedDepth: 64, unknownCells: scan.unknown } : { landing: { x: target.x, y: scan.foot, z: target.z, drop: scan.drop } }),
          movementNotAttempted: true, ...after(ctx, args.facing, target),
        });
    }
    if (scan.foot === null) {
      return fail('PATH_NOT_FOUND', `迈不到 [${args.at}]：目标格脚下 (${support.x},${support.y},${support.z}) 是 ${describe(support)}；目标格 (${target.x},${target.y},${target.z}) 下方已扫 64 格${scan.unknown ? `（其中 ${scan.unknown} 格未加载/未知）` : ''}没有可站立面（不是“air 就禁止”，是还没找到落点）；脚部目标格 [${args.at}] 须留空——要补支撑就是 [${supportAt}] 这一格（step 写 fill:"<方块名>" 可先补这里，支撑格是空气或可替换植物时会先补；也可先 place_at）；未执行迈步`,
        { problems: [`目标格脚下 (${support.x},${support.y},${support.z}) 是 ${describe(support)}，64 格内无落点`], targetCell: target, landingSupport, scannedDepth: 64, unknownCells: scan.unknown, movementNotAttempted: true, ...after(ctx, args.facing, target) });
    }
    const landing = { foot: scan.foot, drop: scan.drop };
    if (!absolute && landing.drop > 4.01) {
      const drop = landing.drop, damage = estimatedFallDamage(drop);
      const dropText = drop.toFixed(Number.isInteger(drop) ? 0 : 2);
      const fall = { drop, damage, landing: { x: target.x, y: landing.foot, z: target.z } };
      return fail('PATH_NOT_FOUND', `迈不到 [${args.at}]：目标列下方 ${dropText} 格才有可站立面 (${target.x},${landing.foot.toFixed(2)},${target.z})，落差约 ${dropText} 格${damage ? `，按当前生命预计约 ${damage} 点摔伤（未计护甲/摔落保护）` : ''}；step 只自动处理 4 格以内，未执行迈步。要下去可用 assess_landings + descend 选这个落点，或 place_at/step fill 补支撑，或换方向`,
        { problems: [`落差 ${dropText} 格，超过 step 自动处理的 4 格`], targetCell: target, landingSupport, fall, movementNotAttempted: true, ...after(ctx, args.facing, target) });
    }
    const foot = landing.foot;
    // 往上迈要真的跳：先确认自己头顶/起跳扫过的身体空间；这是身体与方块的碰撞事实，不靠视线扫。
    if (foot > start.y + 0.5) {
      const jump = bodyProblem(foot, feet.x, feet.z);
      if (jump) {
        const digRel = toRel(feet, args.facing, jump.cell);
        const prompt = `往上迈时自己头顶上方是 ${blockerLabel(jump.cell)}（跳不起来；先 dig_at [${digRel}]）`;
        return fail('PATH_NOT_FOUND', `迈不到 [${args.at}]：${prompt}`, { problems: [prompt], targetCell: target, landingSupport, movementNotAttempted: true, ...after(ctx, args.facing, target) });
      }
    }
    const blocker = bodyProblem(foot, target.x, target.z);
    if (blocker) {
      const digRel = toRel(feet, args.facing, blocker.cell);
      const atTarget = blocker.cell.y === target.y;
      const label = blockerLabel(blocker.cell);
      const prompt = atTarget ? `目标格是 ${label}（身体被占住，先 dig_at [${digRel}] 挖开）` : `目标格上方是 ${label}（会碰头；先 dig_at [${digRel}]）`;
      return fail('PATH_NOT_FOUND', `迈不到 [${args.at}]：${prompt}`, { problems: [prompt], targetCell: target, landingSupport, movementNotAttempted: true, ...after(ctx, args.facing, target) });
    }
    for (const c of corners) {
      const cb = bodyProblem(foot, c.x, c.z);
      if (cb) {
        const prompt = `斜向迈步会撞到角落 ${blockerLabel(cb.cell)} (${cb.cell.x},${cb.cell.y},${cb.cell.z})`;
        return fail('PATH_NOT_FOUND', `迈不到 [${args.at}]：${prompt}`, { problems: [prompt], targetCell: target, landingSupport, movementNotAttempted: true, ...after(ctx, args.facing, target) });
      }
    }
    let movementError: unknown;
    try {
      // 直接按实际落点走路。默认寻路允许最多 4 格、不致命的落差；不再为每格支撑/净空做视线预检，
      // 也不在 air 支撑上原地报错——能否走过去由寻路器按真实方块和物理判断。
      await a.moveTo({ kind: 'xyz', x: target.x, y: foot, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())), allowTerrainChanges: false });
    } catch (e) {
      if (isAbort(e)) {
        (e as Error & { partial?: Record<string, unknown> }).partial = partialFacts({ targetFoot: foot });
        throw e;
      }
      movementError = e;
    }
    if (ctx.signal.aborted) {
      const ab = new AbortedError(String(ctx.signal.reason ?? 'aborted'));
      (ab as Error & { partial?: Record<string, unknown> }).partial = partialFacts({ targetFoot: foot });
      throw ab;
    }
    // moveTo 可能在身体仍在下落时返回（尤其空腔边缘/一格落差）；先有界等待真实落地，
    // 不能拿空中的瞬时位置判“身体没有站稳”并让下一次相对 step 从这个空中位置重算目标。
    const settleBy = Date.now() + 2000;
    while (!a.state().onGround && Date.now() < settleBy) {
      throwIfAborted(ctx.signal);
      await sleep(50, ctx.signal);
    }
    // 用实际身体状态确认到达：站稳、列一致、实际脚高与目标脚高相符；不能只凭整数脚格或 moveTo 返回成功。
    const state = a.state();
    const end = feetCell(state.pos);
    // 验收按实际脚高 + 目标列 + 接触状态，不比较整数脚格——半砖/雪层的脚高会让脚格比目标格低一格。
    // 脚高是离散的支撑顶面；睡莲(0.09375)与地毯(0.0625)只差 0.03125，故容差取 0.01，只吸收浮点，
    // 不能把「仍停在原支撑（差 0.03125）」当成已踩到目标支撑。
    const landed = state.onGround && end.x === target.x && end.z === target.z
      && Math.abs(state.pos.y - foot) <= 0.01;
    if (!landed) {
      const why = !state.onGround ? '身体没有站稳'
        : end.x !== target.x || end.z !== target.z ? `实际列 (${end.x},${end.z}) 与目标不符`
        : `实际脚高 ${state.pos.y.toFixed(2)} 与目标脚高 ${foot.toFixed(2)} 不符`;
      return fail(movementError ? codeFromError(movementError) : 'EFFECT_NOT_CONFIRMED', `没有站到 [${args.at}]：${why}；实际在 (${end.x},${end.y},${end.z})${movementError ? `；${(movementError as Error).message}` : ''}`, { ...(fills.length ? { fills } : {}), ...after(ctx, args.facing, target) });
    }
    const drop = start.y - foot;
    const damage = drop > 0 ? estimatedFallDamage(drop) : 0;
    const dropNote = drop > 0.01 ? `，下落 ${drop.toFixed(Number.isInteger(drop) ? 0 : 2)} 格${damage ? `（预计约 ${damage} 点摔伤，未计护甲/摔落保护）` : ''}` : '';
    return ok(`站到了 [${args.at}]${Math.abs(foot - Math.floor(foot)) > 0.01 ? `（脚高 ${foot.toFixed(2)}）` : ''}${dropNote}${fills.length ? `（先垫了 ${fills.map((f) => `${f.item} 在 [${f.at}]`).join('、')}）` : ''}`, { moved: [...args.at], ...(drop > 0.01 ? { drop, fall: { drop, damage } } : {}), ...(fills.length ? { fills } : {}), ...after(ctx, args.facing, target) });
  },
};

/** 已占用格子的碰撞形状：半砖、雪层、地毯、门、火把不是同一种“实心”，反馈里分开说。 */
function shapeOf(name: string, properties: BlockProps = {}): string {
  const top = supportTop(name, properties), known = shapeKnown(name, properties);
  const topText = top !== null ? `顶面 ${top}` : known ? '无碰撞' : '状态未确认';
  if (name === 'snow') return `雪层（${String(properties.layers ?? 1)} 层，${topText}）`;
  if (/_carpet$/.test(name)) return `地毯（薄层，${topText}）`;
  if (/_slab$/.test(name)) return `${properties.type === 'top' ? '上半砖' : '下半砖'}（${top !== null ? `顶面 ${top}` : topText}）`;
  if (/_door$/.test(name)) return `门（${properties.half === 'upper' ? '上半' : '下半'}，${properties.open === true ? '打开' : '关闭'}）`;
  if (/torch$/.test(name)) return '火把（无碰撞、不承重）';
  if (/_trapdoor$/.test(name)) return `活板门（${properties.open === true ? '打开' : '关闭'}）`;
  if (/_stairs$/.test(name)) return '台阶';
  if (/_bed$/.test(name)) return '床';
  if (name === 'ladder') return '梯子（不承重）';
  return top === null ? '非完整方块' : `可站立顶面 ${top}`;
}

export const placeAt: Skill<CellArgs & { item: string; extra?: boolean }> = {
  name: 'place_at',
  description: '在身边指定的空格放一块方块（[前,上,右]）。实心方块放 [0,0,0] 表示原地垫一块站上去（跳起来往脚下放）；梯子、火把这类贴墙的东西可以放进自己站的格子 [0,0,0]/[0,1,0]，但旁边要有实心墙。item 写方块名，或 "any" 用背包里随便一种能垫的（泥土、圆石、木板…）。树苗、花这类小植物也是方块，可以用 item 指定名字放在草方块/泥土上（之后长成什么见知识库）。目标格已有别的方块（包括半砖、雪层、地毯、门、火把）时如实报占用，不把错误材料当已完成；只放这一格，不替你做搭柱以外的施工',
  argsDoc: '{"at":[前,上,右], "item"?:"<方块名>|any", "facing"?:"N|E|S|W"}（前后/左右 ±2，上下 -2..3；at 是方块占据格；例：[0,0,0] 原地垫高，[1,-1,0] 支撑 step [1,0,0]，会挡住 step [1,-1,0]；[1,-2,0] 补下一级 [1,-1,0] 脚下的支撑；{"at":[0,0,0],"item":"ladder"} 在脚边墙上挂梯子）',
  timeoutMs: 15000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const at = parseRel(relValue(a), { f: 2, u: [-2, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    const item = String(a.item ?? a.block ?? 'any').replace(/^minecraft:/, '');
    if (item !== 'any' && !adapter.isKnownItem(item)) return { ok: false, error: `未知物品：${item}` };
    if (/_(boat|raft)$/.test(item)) return { ok: false, error: `${item} 是船/筏（实体，不是方块），不能用 place_at 放；放船用 use_item {"item":"${item}","on":"water"}，坐上去用 interact {"entity":"boat"}` };
    if (at[0] === 0 && at[2] === 0 && at[1] === 1 && !attachmentFaces(item)) return { ok: false, error: '[0,1,0] 是自己的头，实心方块放不进去；往上垫高用 [0,0,0]（梯子、火把这类贴墙的东西才能放进自己站的格子）' };
    const facing = facingArg(a.facing, adapter);
    if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
    return { ok: true, args: { at, facing: facing as Facing, item, ...(a.extra === true ? { extra: true } : {}) } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const a = ctx.adapter;
    const feet = feetCell(a.state().pos);
    // 相对 [0,0,0] 的实心块是“原地垫高”搭柱；绝对 xyz 落到脚这一格仍按普通放置，不套搭柱。
    const pos = args.xyz !== undefined ? { x: args.xyz.x, y: args.xyz.y, z: args.xyz.z } : toWorld(feet, args.facing, args.at);
    const attachable = args.item !== 'any' && attachmentFaces(args.item);
    const neighbors = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]
      .map((d) => ({ x: pos.x + d.x, y: pos.y + d.y, z: pos.z + d.z }));
    const seen = visibleStates(ctx, [pos, { ...feet, y: feet.y + 2 }, ...neighbors]);
    const stateAt = (p: Vec3Like) => seen.get(`${p.x},${p.y},${p.z}`) ?? null;
    // 搭柱是“站高一格”的动作模式，目标不是“把方块放进这一格”，不做普通放置的“已满足”幂等判断。
    const pillar = args.xyz === undefined && args.at[0] === 0 && args.at[1] === 0 && args.at[2] === 0 && !attachable;
    if (!pillar) {
      // 普通放置：只有亲眼看见同一物品才算已满足。半砖/雪层/地毯/门/火把都占着这一格，
      // 不能因为“看起来是实心”就把错误材料当成功。
      const here = stateAt(pos);
      if (here) {
        const sameItem = args.item !== 'any' && (here.name === args.item || (args.item === 'torch' && here.name === 'wall_torch'));
        const anySolid = args.item === 'any' && !isReplaceable(here.name) && hasAnyCollision(here.name, here.properties ?? {});
        const shape = shapeOf(here.name, here.properties);
        if (sameItem || anySolid) return ok(`[${args.at}] 已经有 ${here.name} 了（${shape}）`, { already: here.name, alreadyShape: shape, noop: true, ...after(ctx, args.facing, pos) });
        if (!isReplaceable(here.name)) {
          return fail('PATH_NOT_FOUND', `[${args.at}] 已被 ${here.name} 占据（${shape}），不是要放的 ${args.item}；先 dig_at 清掉，或换一格`, { occupied: here.name, occupiedShape: shape, ...after(ctx, args.facing, pos) });
        }
      } else {
        const cur = a.blockAt(pos);
        // 没看清：未加载不能当空气；服务器同步数据说明已占用时如实报占用，但不泄露方块名。
        if (cur === null) return fail('NOT_FOUND', `[${args.at}] 目标格未加载，无法确认是否为空，没有放置`, after(ctx, args.facing, pos));
        if (!isReplaceable(cur)) return fail('PATH_NOT_FOUND', `[${args.at}] 已被占用，未放置；当前未看清方块名称`, after(ctx, args.facing, pos));
      }
    }
    const inv = a.state().inventory;
    const names = args.item === 'any' ? PLACEABLE.filter((n) => inv.some((i) => i.name === n && i.count > 0)) : [args.item];
    if (!names.length || !inv.some((i) => names.includes(i.name) && i.count > 0)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item === 'any' ? '能垫的方块（泥土/圆石/木板…）' : args.item}`, after(ctx, args.facing, pos));
    // 旁边已经有一个工作台/熔炉还要再放：多半是没注意到它（合成/烧东西会自己走过去用）。真要再放一个写 extra:true
    if ((args.item === 'crafting_table' || args.item === 'furnace') && !args.extra) {
      const near = findStation(ctx, [args.item], 8);
      if (near) {
        const zh = args.item === 'crafting_table' ? '工作台' : '熔炉';
        return fail('BAD_ARGS', `旁边 ${near.dist} 格 (${near.pos.x},${near.pos.y},${near.pos.z}) 已经有${zh}了，不用再放：${args.item === 'crafting_table' ? 'craft' : 'smelt'} 会自己走过去用它；真要再放一个写 "extra":true`, after(ctx, args.facing, pos));
      }
    }
    // 梯子、火把这类贴墙的东西放进自己站的格子：不是垫高，是挂在旁边的墙上（人站在里面不碍事）
    if (pillar) {
      // 原地垫高：跳起来往脚下放一块，站上去
      if (a.pillarUp) {
        const r = await a.pillarUp(names, ctx.signal);
        if (!r.ok) {
          const why = r.reason === 'NO_REFERENCE' ? (r.waterDepth != null
            ? `脚下是水，池底在下方 ${r.waterDepth} 格，超出贴面放置范围；要垫高得先潜到池底贴着放，或改上浮/游上岸`
            : '脚下是空的（悬着、在水里或梯子上），没有能贴着放的面')
            : r.reason === 'OCCUPIED' ? '脚下这格已经有东西'
            : String(r.reason).startsWith('BLOCKED:') ? `脚下这格有 ${String(r.reason).slice('BLOCKED:'.length)}，方块放不进去；先 dig_at [0,0,0] 把它拿掉` : r.reason === 'NO_ITEM' ? '背包里没有能垫的方块' : `方块没放上（${r.reason}）`;
          return fail(r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : r.reason === 'NO_REFERENCE' ? 'PATH_NOT_FOUND' : 'EFFECT_NOT_CONFIRMED', `原地垫高没成：${why}${r.clearanceDetail ? `；${r.clearanceDetail}` : ''}`, { ...after(ctx, args.facing, pos), pillarFailure: r.reason, ...(r.clearance?.cells?.length ? { pillarClearance: r.clearance } : {}) });
        }
      } else {
        const above = { ...feet, y: feet.y + 2 }, n = a.blockAt(above);
        if (n === null || !AIR.has(n) && !isSoftBlock(n)) return fail('PATH_NOT_FOUND', `无法确认头顶跳跃空间足够（${stateAt(above)?.name ?? '未看清的格子'}）`, { ...after(ctx, args.facing, pos), obscured: true });
        try {
          await a.moveTo({ kind: 'xyz', x: feet.x, y: feet.y + 1, z: feet.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(8000, ctx.deadline - Date.now())), allowTerrainChanges: true });
        } catch (e) {
          if (isAbort(e)) throw e;
          return fail(codeFromError(e), `原地垫高没成：${(e as Error).message}`, after(ctx, args.facing, pos));
        }
      }
      const end = feetCell(a.state().pos);
      // 落稳以后再看：脚下那格真的有方块、人真的高了一格（跳在半空不算）
      const under = a.blockAt(feet);
      if (end.y <= feet.y || !under || AIR.has(under) || isSoftBlock(under)) return fail('EFFECT_NOT_CONFIRMED', '没有站高一格：方块没留在脚下', after(ctx, args.facing, pos));
      return ok(`原地垫了一块，站高了一格（现在 y=${end.y}）`, after(ctx, args.facing, pos));
    }
    // 实心方块放在箱子/木桶正上方会盖住箱盖，之后 store_items 报 LID_BLOCKED 打不开。
    if (!attachable) {
      const below = a.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z });
      if (below && ['chest', 'trapped_chest', 'barrel'].includes(below)) {
        return fail('BAD_ARGS', `[${args.at}] 正下方是 ${below}，放上实心方块会盖住箱盖、之后打不开；请换个位置，或先用 dig_at {"own":true} 把箱子挪走`);
      }
    }
    // 附着面：已看清六个方向却没有可贴面的方块，就不必再调一个必然失败的放置；
    // 还有方向没看清时只报未知，交给适配器按真实视线/距离尝试。
    const reference = placementReference(pos, stateAt, attachable || null);
    if (reference === 'none') {
      return fail('PATH_NOT_FOUND', `[${args.at}] 四周已看清，没有可贴面的方块；${
        attachable === 'side' ? `${args.item} 只能挂在实心方块侧面` : attachable === 'floor_or_side' ? `${args.item} 要立在实心方块顶面或挂在侧面` : '悬空处放不了方块'}；先走近别的面或换个位置`, { reference, ...after(ctx, args.facing, pos) });
    }
    try {
      const r = await a.placeBlockAt(pos, names, ctx.signal);
      if (!r.ok) {
        const why = r.reason === 'NO_WALL' ? (r.detail ?? `${args.item} 只能挂在实心方块的侧面，四周没有实心墙（或者看不见那个面）`)
          : r.reason === 'NO_FLOOR_OR_WALL' ? (r.detail ?? `${args.item} 要立在实心方块上或挂在它侧面，脚下和四周都没有实心方块`)
          : r.reason === 'NO_REFERENCE' ? (r.detail ?? (attachable ? `旁边没有能挂住 ${args.item} 的实心方块面，或者看不见那个面` : '旁边没有能贴着放的方块（悬空），或者看不见那个面'))
          : typeof r.reason === 'string' && r.reason.startsWith('BAD_SUPPORT:') ? r.reason.slice('BAD_SUPPORT:'.length) : r.reason;
        return fail(r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : 'PATH_NOT_FOUND', `放不到 [${args.at}]：${why}`, after(ctx, args.facing, pos));
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `放 [${args.at}] 没成：${(e as Error).message}`, after(ctx, args.facing, pos));
    }
    const now = a.blockStateAt?.(pos)?.name ?? a.blockAt(pos);
    if (!now || AIR.has(now)) return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 还是空的`, after(ctx, args.facing, pos));
    // 验收按实际出现的东西：请求 dirt 却出现 stone 时不能把“有方块了”当作成功。
    const accepted = args.item === 'any'
      ? names.includes(now)
      : now === args.item || (args.item === 'torch' && now === 'wall_torch');
    if (!accepted) return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 实际出现的是 ${now}，不是请求的 ${args.item}`, { placed: now, requested: args.item, ...after(ctx, args.facing, pos) });
    noteEdit(ctx.taskId, 'place', pos);
    // 亲手放下的功能方块（附魔台、铁砧、酿造台、工作台……）记成“我的X”：以前只有 craft/use_item_on 放的才记，place_at 放的就忘了
    if (isStation(now)) rememberStation(ctx, now, pos);
    return ok(`在 [${args.at}] 放了 ${now}`, { placed: now, ...after(ctx, args.facing, pos) });
  },
};

/** 绝对坐标："xyz":[x,y,z]、"x,y,z" 或 {"x":…,"y":…,"z":…} */
function absValue(v: unknown): Vec3Like | null {
  const arr = typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean).map(Number)
    : Array.isArray(v) ? v.map(Number) : v && typeof v === 'object' ? [(v as any).x, (v as any).y, (v as any).z].map(Number) : null;
  return arr && arr.length === 3 && arr.every(Number.isFinite) ? { x: arr[0], y: arr[1], z: arr[2] } : null;
}

/**
 * 让原子动作也认绝对坐标（"xyz"）：[前,上,右] 要按朝向心算，模型常算错（日志里 dig_at [0,2,0] 挖到空气）。
 * 开工时按当时站的位置和朝向换成 [前,上,右]，在 routine 里重复时每次都按当时的位置重新换——绝对坐标指的始终是同一格。
 */
function withAbsolute<A extends CellArgs>(skill: Skill<A>, bounds: { f: number; u: [number, number]; r: number }): Skill<A & { xyz?: Vec3Like }> {
  const rel = (feet: Vec3Like, facing: Facing, p: Vec3Like) => parseRel(toRel(feet, facing, p), bounds);
  const far = (p: Vec3Like, why: string) => `(${p.x},${p.y},${p.z}) 不在身边能${skill.name === 'step' ? '迈到' : '够到'}的范围：${why}；先走近（goto 那里）再做`;
  // step 的绝对 y 是脚高（可为分数，如半砖 64.5），范围换算用它的脚格；dig_at/place_at 仍是整数方块格。
  const cellOf = (p: Vec3Like): Vec3Like => skill.name === 'step' ? { x: p.x, y: Math.floor(p.y), z: p.z } : p;
  return {
    ...skill,
    argsDoc: `${skill.argsDoc}；也可以用绝对坐标 "xyz":[x,y,z] 代替 [前,上,右]${skill.name === 'step' ? '（step 的 y 是脚高，可为分数，如半砖 64.5）' : ''}`,
    validate(raw, adapter) {
      const a = obj(raw);
      const p = absValue(a.xyz ?? a.abs ?? a.world);
      if (!p) return skill.validate(raw, adapter);
      const facing = facingArg(a.facing, adapter);
      if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
      const r = rel(feetCell(adapter.state().pos), facing as Facing, cellOf(p));
      if (typeof r === 'string') return { ok: false, error: far(p, r) };
      const { xyz: _x, abs: _a, world: _w, at: _at, to: _to, pos: _p, ...rest } = a;
      const v = skill.validate({ ...rest, at: r, facing }, adapter);
      return v.ok ? { ok: true, args: { ...v.args, xyz: p } } : v;
    },
    async run(ctx, args) {
      const from = feetCell(ctx.adapter.state().pos);
      const r = args.xyz ? rel(from, args.facing, cellOf(args.xyz)) : args.at;
      const result = typeof r === 'string'
        ? fail('PATH_NOT_FOUND', far(args.xyz!, r), after(ctx, args.facing, args.xyz))
        : await skill.run(ctx, args.xyz ? { ...args, at: r } : args);
      // The action may finish elsewhere; report its target relative to the starting feet,
      // including the actual landing selected by the existing water-exit helper.
      const target = (result.data?.targetCell as Vec3Like | undefined) ?? args.xyz ?? toWorld(from, args.facing, args.at);
      const dx = target.x - from.x, dy = target.y - from.y, dz = target.z - from.z;
      const horizontal = `${dx < 0 ? '西' : dx > 0 ? '东' : ''}${dz < 0 ? '北' : dz > 0 ? '南' : ''}`;
      const vertical = dy ? `${dy > 0 ? '上' : '下'}${Math.abs(dy)}格` : '';
      const direction = horizontal ? `${horizontal}方${vertical ? `、${vertical}` : ''}` : vertical ? `正${vertical}` : '原脚格';
      return { ...result, summary: `目标${direction} (${target.x},${target.y},${target.z})；坐标前=${args.facing}；${result.summary}`,
        data: { ...result.data, targetCell: target, targetFrom: from, coordinateFacing: args.facing } };
    },
  };
}

export const primitiveSkills = [withAbsolute(digAt, { f: 2, u: [-1, 3], r: 2 }), withAbsolute(stepTo, { f: 1, u: [-1, 1], r: 1 }), withAbsolute(placeAt, { f: 2, u: [-2, 3], r: 2 })];

import type { Vec3Like } from '../adapter/types.ts';
import { describeCell, FACINGS, facingOfYaw, feetCell, localMap, toWorld, type Facing } from '../perception/local.ts';
import { attachmentFaces, isSoftBlock, LIQUID_BLOCKS, surroundings } from '../perception/surroundings.ts';
import { sleep, throwIfAborted } from '../util.ts';
import { breakCell, why } from './body.ts';
import { OWN_BUILDING_HINT, ownBuildingAt, storedChestAt } from './build.ts';
import { noteEdit } from '../mind/edits.ts';
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
interface CellArgs { at: Rel; facing: Facing; own?: boolean; wet?: boolean }
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
  const f = String(raw).toUpperCase().slice(0, 1) as Facing;
  return FACINGS.includes(f) ? f : 'facing 只能是 N/E/S/W';
}

/** 执行后附上身边的新样子，模型下一步就知道该挖哪格 */
function after(ctx: SkillCtx, facing: Facing) {
  const s = ctx.adapter.state();
  return { position: { ...s.pos }, local: localMap(ctx.adapter, s.pos, facing), around: surroundings(ctx.adapter).text };
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
  description: '挖掉身边指定的那一格（以脚为原点的 [前,上,右]）。自动换合适的工具；那格旁边有水时默认不挖（会说是哪几格，可以先堵上或写 wet:true 照挖），旁边有岩浆、或是基岩时不挖。只挖不走，挖完人还在原地',
  argsDoc: '{"at":[前,上,右], "facing"?:"N|E|S|W", "own"?:true（确实要拆自己房子的方块）, "wet"?:true（旁边有水也照挖，让水流进来）}（前后/左右 ±2，上下 -1..3；例：[1,1,0] 前方高一格，[0,2,0] 头顶上方，[0,-1,0] 脚下）',
  timeoutMs: 30000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    const facing = facingArg(a.facing, adapter);
    if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
    // [0,0,0]/[0,1,0] 是自己站的两格，本来就空：照样接受（执行时说明一下），不当成写错丢掉
    return { ok: true, args: { at, facing: facing as Facing, ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}) } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const feet = feetCell(ctx.adapter.state().pos);
    const pos = toWorld(feet, args.facing, args.at);
    const before = ctx.adapter.blockAt(pos);
    // 自己站的两格通常是空的；但也可能有火把、花、雪层、蜘蛛网这类东西，那就照样拿掉
    if (args.at[0] === 0 && args.at[2] === 0 && (args.at[1] === 0 || args.at[1] === 1) && (before === null || AIR.has(before))) return ok(`[${args.at}] 是自己站的地方，本来就空着；往上挖是 [0,2,0]`, after(ctx, args.facing));
    if (before === null) return fail('NOT_FOUND', `[${args.at}] 那一格还没加载或看不见`, after(ctx, args.facing));
    if (AIR.has(before)) return ok(`[${args.at}] 本来就是空的，不用挖`, { cell: [...args.at], was: 'air', ...after(ctx, args.facing) });
    if (LIQUID_BLOCKS.has(before)) return fail('BAD_ARGS', `[${args.at}] 是 ${before}，挖不了`, after(ctx, args.facing));
    // 挖开会进水/进岩浆：默认不挖，但说清是哪几格、能怎么办（像人一样先堵上，或者认了让水流进来）
    const wets = wetNeighbours(ctx, pos);
    const lava = wets.some((w) => /lava/.test(w.name));
    if (wets.length && (lava || !args.wet)) {
      const cells = wets.map((w) => `[${toRel(feet, args.facing, w.pos)}] 是 ${w.name}`).join('、');
      const fix = lava ? '岩浆不能放进来：先 place_at 把那几格堵上，或者换个方向挖'
        : `可以先 place_at 往那几格放方块把水堵上（水格可以直接放方块），或者写 "wet":true 照挖、让水流进来（水只会漫过来，不会伤人，挖完可以再堵）；也可以换个方向`;
      return fail('BAD_ARGS', `[${args.at}] 挖开会有液体流进来：${cells}。${fix}`, { wet: wets[0].name, wetCells: wets.map((w) => toRel(feet, args.facing, w.pos)), ...after(ctx, args.facing) });
    }
    const mine = args.own ? null : ownBuildingAt(ctx.memory, ctx.adapter.state(), pos, before);
    if (mine) return fail('BAD_ARGS', `[${args.at}] 的 ${before} 是自己盖的「${mine.name}」的一部分；${OWN_BUILDING_HINT}`, { own: mine, ...after(ctx, args.facing) });
    const stash = args.own ? null : storedChestAt(ctx.memory, ctx.adapter.state(), pos, before);
    if (stash) return fail('BAD_ARGS', stash, after(ctx, args.facing));
    const how: { noDrop?: boolean; ms?: number } = {};
    const keepsake = KEEPSAKE.test(before) ? before : null;
    const countOf = (n: string) => ctx.adapter.state().inventory.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
    const had = keepsake ? countOf(keepsake) : 0;
    try {
      await breakCell(ctx, pos, true, how, { allowWater: !!args.wet });
    } catch (e) {
      if (isAbort(e)) throw e;
      const m = String((e as Error).message);
      return fail(m.startsWith('NEED_TOOL') || m === 'TOOL_MISSING' ? 'TOOL_MISSING' : codeFromError(e), `挖 [${args.at}] 的 ${before} 没成：${why(e)}`, after(ctx, args.facing));
    }
    const now = ctx.adapter.blockAt(pos);
    if (now && !AIR.has(now) && !isSoftBlock(now)) {
      // 沙子、沙砾会从上面掉下来补上
      return ok(`挖掉了 [${args.at}] 的 ${before}，但上面掉下来的 ${now} 又填上了`, { cell: [...args.at], was: before, now, ...after(ctx, args.facing) });
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
    return ok(`挖掉了 [${args.at}] 的 ${before}${hand}${got}`, { cell: [...args.at], was: before, ...(how.noDrop ? { noDrop: true } : {}), ...(inBag !== undefined ? { inBag } : {}), ...after(ctx, args.facing) });
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
  const res = await a.swimTo!({ x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, ctx.signal, { timeoutMs: Math.max(1000, Math.min(7000, ctx.deadline - Date.now())) });
  const s = a.state(), end = feetCell(s.pos);
  if (!s.inWater && s.onGround && Math.hypot(end.x - stand.x, end.z - stand.z) <= 1 && Math.abs(end.y - stand.y) <= 1) {
    return ok(`从水里爬上了岸 [${rel}]（实际在 (${end.x},${end.y},${end.z})）`, { moved: rel, landed: true, ...after(ctx, args.facing) });
  }
  return fail('EFFECT_NOT_CONFIRMED', `从水里朝 [${rel}] 的岸爬了，没上去（岸边落脚处比脚高 ${dy} 格${dy >= 2 ? '，从水里多半爬不上两格高的岸，换一处低一点的岸' : ''}；${res.ok ? '' : `游泳：${res.reason}；`}现在${s.inWater ? '还在水里' : '不在水里但没站稳'}）`, { stand: rel, ...after(ctx, args.facing) });
}

export const stepTo: Skill<CellArgs> = {
  name: 'step',
  description: '迈到身边相邻的一格（[前,上,右]）：可以平走、上一级台阶（上+1，会跳）、下一级（上-1）；脚下是梯子时 [0,1,0] 沿梯子爬一格。目标格和头顶要空、脚下要实；上台阶时自己头顶上方也要空。只走这一格。泡在水里时朝岸那边迈（[1,0,0] 就行），身体会游过去、贴着岸爬上去（岸比脚高一两格也行）',
  argsDoc: '{"to":[前,上,右], "facing"?:"N|E|S|W"}（前后/左右 ±1，上下 -1..1；例：[1,0,0] 往前一格，[1,1,0] 迈上前方台阶）',
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
    return { ok: true, args: { at: to, facing: facing as Facing } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const a = ctx.adapter;
    const start = a.state().pos, feet = feetCell(start);
    const target = toWorld(feet, args.facing, args.at);
    const free = (p: Vec3Like) => { const n = a.blockAt(p); return n !== null && (AIR.has(n) || isSoftBlock(n)); };
    // 泡在水里：脚下那格是水、岸往往比脚高一两格，平地上的“上下 ±1”对不上。像玩家一样朝那边游、贴着岸按住跳爬上去
    if (a.state().inWater && a.swimTo) {
      const out = await stepOutOfWater(ctx, args, feet);
      if (out) return out;
    }
    // 沿梯子往上爬一格：目标是自己头那格，脚下是梯子；头顶上方要空
    if (args.at[0] === 0 && args.at[2] === 0 && args.at[1] === 1) {
      const top = { ...target, y: target.y + 1 };
      if (!free(top)) return fail('PATH_NOT_FOUND', `梯子往上爬不动：头顶上方是 ${describeCell(a, top)}（先 dig_at [0,2,0]）`, after(ctx, args.facing));
      try {
        await a.moveTo({ kind: 'xyz', x: target.x, y: target.y, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())) });
      } catch (e) {
        if (isAbort(e)) throw e;
        return fail(codeFromError(e), `沿梯子往上爬没成：${(e as Error).message}`, after(ctx, args.facing));
      }
      const end = feetCell(a.state().pos);
      if (end.y < target.y) return fail('EFFECT_NOT_CONFIRMED', `没有爬上去，实际在 (${end.x},${end.y},${end.z})${a.blockAt(target) === 'ladder' ? '' : '：上面那格没有梯子，梯子要一格一格接着挂'}`, after(ctx, args.facing));
      return ok(`沿梯子爬上了一格（现在 y=${end.y}）${a.blockAt({ ...end }) === 'ladder' ? '' : '；这格没有梯子了，再往上要先挂'}`, { moved: [0, 1, 0], ...after(ctx, args.facing) });
    }
    const head = { ...target, y: target.y + 1 }, floor = { ...target, y: target.y - 1 };
    const problems: string[] = [];
    if (!free(target)) problems.push(`目标格是 ${describeCell(a, target)}${LIQUID_BLOCKS.has(a.blockAt(target) ?? '') ? '' : /chest|barrel|furnace|crafting_table|_bed$/.test(a.blockAt(target) ?? '') ? '（是用得着的东西，绕过去，别挖）' : `（要过去先 dig_at [${args.at}] 挖开）`}`);
    if (!free(head)) problems.push(`目标格上方是 ${describeCell(a, head)}（会碰头${LIQUID_BLOCKS.has(a.blockAt(head) ?? '') ? '' : `；先 dig_at [${args.at[0]},${args.at[1] + 1},${args.at[2]}]`}）`);
    // 能站住：实心方块；薄雪层下面有实心方块也能踩
    const solid = (p: Vec3Like) => { const n = a.blockAt(p); return n !== null && !LIQUID_BLOCKS.has(n) && !free(p); };
    const standable = (p: Vec3Like) => solid(p) || (a.blockAt(p) === 'snow' && solid({ ...p, y: p.y - 1 }));
    let dest = target, drop = 0;
    if (!standable(floor) && !problems.length && args.at[1] <= 0) {
      // 走下小坎：前面低 1–3 格有落脚处就直接走下去（像人一样，不必先垫）
      for (let k = 1; k <= 3; k++) {
        const f = { ...floor, y: floor.y - k };
        if (!free({ ...f, y: f.y + 1 })) break;
        if (standable(f)) { dest = { ...target, y: target.y - k }; drop = k; break; }
      }
    }
    if (dest === target && !standable(floor)) problems.push(`目标格脚下是 ${describeCell(a, floor)}，往下 3 格内也没有落脚处（踩不住；要过去可以先 place_at [${args.at[0]},${args.at[1] - 1},${args.at[2]}] 垫一块落脚）`);
    if (args.at[1] === 1 && !free({ ...feet, y: feet.y + 2 })) problems.push(`往上跳时自己头顶上方是 ${describeCell(a, { ...feet, y: feet.y + 2 })}（跳不起来；先 dig_at [0,2,0]）`);
    if (problems.length) return fail('PATH_NOT_FOUND', `迈不到 [${args.at}]：${problems.join('；')}`, { problems, ...after(ctx, args.facing) });
    try {
      await a.moveTo({ kind: 'xyz', x: dest.x, y: dest.y, z: dest.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())) });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `迈向 [${args.at}] 没成：${(e as Error).message}`, after(ctx, args.facing));
    }
    const end = feetCell(a.state().pos);
    // 雪层、坡上的半格高低会让脚下那格差一格；水平差一格以内、而且比出发时更靠近目标，就算迈到了
    const off = Math.hypot(end.x - dest.x, end.z - dest.z), before = Math.hypot(feet.x - dest.x, feet.z - dest.z);
    if (off > 1 || Math.abs(end.y - dest.y) > 1 || (off > 0 && off >= before)) return fail('EFFECT_NOT_CONFIRMED', `没有站到 [${args.at}]，实际在 (${end.x},${end.y},${end.z})`, after(ctx, args.facing));
    if (off > 0 || end.y !== dest.y) return ok(`大致迈到了 [${args.at}]（实际在 (${end.x},${end.y},${end.z})）`, { moved: [...args.at], ...after(ctx, args.facing) });
    return ok(drop ? `往前走下了 ${drop} 格的小坎` : `站到了 [${args.at}]`, { moved: [args.at[0], args.at[1] - drop, args.at[2]], ...after(ctx, args.facing) });
  },
};

export const placeAt: Skill<CellArgs & { item: string; extra?: boolean }> = {
  name: 'place_at',
  description: '在身边指定的空格放一块方块（[前,上,右]）。实心方块放 [0,0,0] 表示原地垫一块站上去（跳起来往脚下放）；梯子、火把这类贴墙的东西可以放进自己站的格子 [0,0,0]/[0,1,0]，但旁边要有实心墙。item 写方块名，或 "any" 用背包里随便一种能垫的（泥土、圆石、木板…）',
  argsDoc: '{"at":[前,上,右], "item"?:"<方块名>|any", "facing"?:"N|E|S|W"}（前后/左右 ±2，上下 -1..3；例：[0,0,0] 原地垫高一格，[1,-1,0] 填前方脚下的坑，{"at":[0,0,0],"item":"ladder"} 在自己脚边的墙上挂梯子）',
  timeoutMs: 15000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    const item = String(a.item ?? a.block ?? 'any').replace(/^minecraft:/, '');
    if (item !== 'any' && !adapter.isKnownItem(item)) return { ok: false, error: `未知物品：${item}` };
    if (at[0] === 0 && at[2] === 0 && at[1] === 1 && !attachmentFaces(item)) return { ok: false, error: '[0,1,0] 是自己的头，实心方块放不进去；往上垫高用 [0,0,0]（梯子、火把这类贴墙的东西才能放进自己站的格子）' };
    const facing = facingArg(a.facing, adapter);
    if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
    return { ok: true, args: { at, facing: facing as Facing, item, ...(a.extra === true ? { extra: true } : {}) } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const a = ctx.adapter;
    const inv = a.state().inventory;
    const names = args.item === 'any' ? PLACEABLE.filter((n) => inv.some((i) => i.name === n && i.count > 0)) : [args.item];
    if (!names.length || !inv.some((i) => names.includes(i.name) && i.count > 0)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item === 'any' ? '能垫的方块（泥土/圆石/木板…）' : args.item}`, after(ctx, args.facing));
    // 旁边已经有一个工作台/熔炉还要再放：多半是没注意到它（合成/烧东西会自己走过去用）。真要再放一个写 extra:true
    if ((args.item === 'crafting_table' || args.item === 'furnace') && !args.extra) {
      const near = findStation(ctx, [args.item], 8);
      if (near) {
        const zh = args.item === 'crafting_table' ? '工作台' : '熔炉';
        return fail('BAD_ARGS', `旁边 ${near.dist} 格 (${near.pos.x},${near.pos.y},${near.pos.z}) 已经有${zh}了，不用再放：${args.item === 'crafting_table' ? 'craft' : 'smelt'} 会自己走过去用它；真要再放一个写 "extra":true`, after(ctx, args.facing));
      }
    }
    const feet = feetCell(a.state().pos);
    // 梯子、火把这类贴墙的东西放进自己站的格子：不是垫高，是挂在旁边的墙上（人站在里面不碍事）
    const attachable = args.item !== 'any' && attachmentFaces(args.item);
    if (args.at[0] === 0 && args.at[1] === 0 && args.at[2] === 0 && !attachable) {
      // 原地垫高：跳起来往脚下放一块，站上去
      const above = { ...feet, y: feet.y + 2 };
      const n = a.blockAt(above);
      if (n !== null && !AIR.has(n) && !isSoftBlock(n)) return fail('PATH_NOT_FOUND', `头顶上方是 ${n}，跳不起来；先 dig_at [0,2,0]`, after(ctx, args.facing));
      if (a.pillarUp) {
        const r = await a.pillarUp(names, ctx.signal);
        if (!r.ok) {
          const why = r.reason === 'NO_REFERENCE' ? '脚下是空的（悬着、在水里或梯子上），没有能贴着放的面'
            : r.reason === 'OCCUPIED' ? '脚下这格已经有东西'
            : String(r.reason).startsWith('BLOCKED:') ? `脚下这格有 ${String(r.reason).slice(8)}，方块放不进去；先 dig_at [0,0,0] 把它拿掉` : r.reason === 'NO_ITEM' ? '背包里没有能垫的方块' : `方块没放上（${r.reason}）`;
          return fail(r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : r.reason === 'NO_REFERENCE' ? 'PATH_NOT_FOUND' : 'EFFECT_NOT_CONFIRMED', `原地垫高没成：${why}`, after(ctx, args.facing));
        }
      } else {
        try {
          await a.moveTo({ kind: 'xyz', x: feet.x, y: feet.y + 1, z: feet.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(8000, ctx.deadline - Date.now())), allowTerrainChanges: true });
        } catch (e) {
          if (isAbort(e)) throw e;
          return fail(codeFromError(e), `原地垫高没成：${(e as Error).message}`, after(ctx, args.facing));
        }
      }
      const end = feetCell(a.state().pos);
      // 落稳以后再看：脚下那格真的有方块、人真的高了一格（跳在半空不算）
      const under = a.blockAt(feet);
      if (end.y <= feet.y || !under || AIR.has(under) || isSoftBlock(under)) return fail('EFFECT_NOT_CONFIRMED', '没有站高一格：方块没留在脚下', after(ctx, args.facing));
      return ok(`原地垫了一块，站高了一格（现在 y=${end.y}）`, after(ctx, args.facing));
    }
    const pos = toWorld(feet, args.facing, args.at);
    const cur = a.blockAt(pos);
    if (cur !== null && !AIR.has(cur) && !isSoftBlock(cur) && !LIQUID_BLOCKS.has(cur)) return ok(`[${args.at}] 已经有 ${cur} 了`, { already: cur, ...after(ctx, args.facing) });
    if (cur !== null && (cur === args.item || (args.item === 'torch' && cur === 'wall_torch'))) return ok(`[${args.at}] 已经有 ${cur} 了`, { already: cur, ...after(ctx, args.facing) });
    try {
      const r = await a.placeBlockAt(pos, names, ctx.signal);
      if (!r.ok) {
        const why = r.reason === 'NO_WALL' ? `${args.item} 只能挂在实心方块的侧面，[${args.at}] 四周没有实心墙（或者看不见那个面）`
          : r.reason === 'NO_FLOOR_OR_WALL' ? `${args.item} 要立在实心方块上或挂在它侧面，[${args.at}] 脚下和四周都没有实心方块`
          : r.reason === 'NO_REFERENCE' ? (attachable ? `旁边没有能挂住 ${args.item} 的实心方块面，或者看不见那个面` : '旁边没有能贴着放的方块（悬空），或者看不见那个面') : r.reason;
        return fail(r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : 'PATH_NOT_FOUND', `放不到 [${args.at}]：${why}`, after(ctx, args.facing));
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `放 [${args.at}] 没成：${(e as Error).message}`, after(ctx, args.facing));
    }
    const now = a.blockAt(pos);
    if (!now || AIR.has(now)) return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 还是空的`, after(ctx, args.facing));
    noteEdit(ctx.taskId, 'place', pos);
    // 亲手放下的功能方块（附魔台、铁砧、酿造台、工作台……）记成“我的X”：以前只有 craft/use_item_on 放的才记，place_at 放的就忘了
    if (isStation(now)) rememberStation(ctx, now, pos);
    return ok(`在 [${args.at}] 放了 ${now}`, { placed: now, ...after(ctx, args.facing) });
  },
};

/** 绝对坐标："xyz":[x,y,z]、"x,y,z" 或 {"x":…,"y":…,"z":…} */
function absValue(v: unknown): Vec3Like | null {
  const arr = typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean).map(Number)
    : Array.isArray(v) ? v.map(Number) : v && typeof v === 'object' ? [(v as any).x, (v as any).y, (v as any).z].map(Number) : null;
  return arr && arr.length === 3 && arr.every(Number.isInteger) ? { x: arr[0], y: arr[1], z: arr[2] } : null;
}

/**
 * 让原子动作也认绝对坐标（"xyz"）：[前,上,右] 要按朝向心算，模型常算错（日志里 dig_at [0,2,0] 挖到空气）。
 * 开工时按当时站的位置和朝向换成 [前,上,右]，在 routine 里重复时每次都按当时的位置重新换——绝对坐标指的始终是同一格。
 */
function withAbsolute<A extends CellArgs>(skill: Skill<A>, bounds: { f: number; u: [number, number]; r: number }): Skill<A & { xyz?: Vec3Like }> {
  const rel = (feet: Vec3Like, facing: Facing, p: Vec3Like) => parseRel(toRel(feet, facing, p), bounds);
  const far = (p: Vec3Like, why: string) => `(${p.x},${p.y},${p.z}) 不在身边能${skill.name === 'step' ? '迈到' : '够到'}的范围：${why}；先走近（goto 那里）再做`;
  return {
    ...skill,
    argsDoc: `${skill.argsDoc}；也可以用绝对坐标 "xyz":[x,y,z] 代替 [前,上,右]`,
    validate(raw, adapter) {
      const a = obj(raw);
      const p = absValue(a.xyz ?? a.abs ?? a.world);
      if (!p) return skill.validate(raw, adapter);
      const facing = facingArg(a.facing, adapter);
      if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
      const r = rel(feetCell(adapter.state().pos), facing as Facing, p);
      if (typeof r === 'string') return { ok: false, error: far(p, r) };
      const { xyz: _x, abs: _a, world: _w, at: _at, to: _to, pos: _p, ...rest } = a;
      const v = skill.validate({ ...rest, at: r, facing }, adapter);
      return v.ok ? { ok: true, args: { ...v.args, xyz: p } } : v;
    },
    async run(ctx, args) {
      if (!args.xyz) return skill.run(ctx, args);
      const r = rel(feetCell(ctx.adapter.state().pos), args.facing, args.xyz);
      if (typeof r === 'string') return fail('PATH_NOT_FOUND', far(args.xyz, r), after(ctx, args.facing));
      return skill.run(ctx, { ...args, at: r });
    },
  };
}

export const primitiveSkills = [withAbsolute(digAt, { f: 2, u: [-1, 3], r: 2 }), withAbsolute(stepTo, { f: 1, u: [-1, 1], r: 1 }), withAbsolute(placeAt, { f: 2, u: [-1, 3], r: 2 })];

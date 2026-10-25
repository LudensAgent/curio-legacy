import type { Vec3Like } from '../adapter/types.ts';
import { describeCell, FACINGS, facingOfYaw, feetCell, localMap, toWorld, type Facing } from '../perception/local.ts';
import { isSoftBlock, LIQUID_BLOCKS, surroundings } from '../perception/surroundings.ts';
import { throwIfAborted } from '../util.ts';
import { breakCell, why } from './body.ts';
import { OWN_BUILDING_HINT, ownBuildingAt } from './build.ts';
import { noteEdit } from '../mind/edits.ts';
import { PLACEABLE } from './survival.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

/**
 * 原子动作：模型说出确切是哪一格，身体只负责准确执行、检查安全、如实回报。
 * 坐标是以脚为原点的 [前, 上, 右]，前 = facing（不写就按规划时的朝向固定下来）。
 * 在 routine 里重复时，每一步都按“当时站的位置”重新计算，所以
 *   dig_at [0,2,0] → dig_at [1,1,0] → dig_at [1,2,0] → step [1,1,0]   重复几轮就是一道往前上方的阶梯。
 */
type Rel = [number, number, number];
interface CellArgs { at: Rel; facing: Facing; own?: boolean }
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

const liquidNext = (ctx: SkillCtx, c: Vec3Like) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
  .map(([dx, dy, dz]) => ctx.adapter.blockAt({ x: c.x + dx, y: c.y + dy, z: c.z + dz })).find((n) => !!n && LIQUID_BLOCKS.has(n));

export const digAt: Skill<CellArgs> = {
  name: 'dig_at',
  description: '挖掉身边指定的那一格（以脚为原点的 [前,上,右]）。自动换合适的工具；那格旁边有水或岩浆、或是基岩时不挖。只挖不走，挖完人还在原地',
  argsDoc: '{"at":[前,上,右], "facing"?:"N|E|S|W", "own"?:true（确实要拆自己房子的方块）}（前后/左右 ±2，上下 -1..3；例：[1,1,0] 前方高一格，[0,2,0] 头顶上方，[0,-1,0] 脚下）',
  timeoutMs: 30000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    const facing = facingArg(a.facing, adapter);
    if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
    // [0,0,0]/[0,1,0] 是自己站的两格，本来就空：照样接受（执行时说明一下），不当成写错丢掉
    return { ok: true, args: { at, facing: facing as Facing, ...(a.own === true ? { own: true } : {}) } };
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
    const wet = liquidNext(ctx, pos);
    if (wet) return fail('BAD_ARGS', `[${args.at}] 旁边就是 ${wet}，挖开会流进来`, { wet, ...after(ctx, args.facing) });
    const mine = args.own ? null : ownBuildingAt(ctx.memory, ctx.adapter.state(), pos, before);
    if (mine) return fail('BAD_ARGS', `[${args.at}] 的 ${before} 是自己盖的「${mine.name}」的一部分；${OWN_BUILDING_HINT}`, { own: mine, ...after(ctx, args.facing) });
    try {
      await breakCell(ctx, pos, true);
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
    return ok(`挖掉了 [${args.at}] 的 ${before}`, { cell: [...args.at], was: before, ...after(ctx, args.facing) });
  },
};

export const stepTo: Skill<CellArgs> = {
  name: 'step',
  description: '迈到身边相邻的一格（[前,上,右]）：可以平走、上一级台阶（上+1，会跳）、下一级（上-1）。目标格和头顶要空、脚下要实；上台阶时自己头顶上方也要空。只走这一格',
  argsDoc: '{"to":[前,上,右], "facing"?:"N|E|S|W"}（前后/左右 ±1，上下 -1..1；例：[1,0,0] 往前一格，[1,1,0] 迈上前方台阶）',
  timeoutMs: 8000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const to = parseRel(relValue(a), { f: 1, u: [-1, 1], r: 1 });
    if (typeof to === 'string') return { ok: false, error: to };
    if (to[0] === 0 && to[2] === 0) return { ok: false, error: '原地上下不是 step：往上用 place_at [0,0,0]（垫一块站上去），往下用 dig_at [0,-1,0]（脚下挖空人会自己掉下去，不需要再 step）' };
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
    const head = { ...target, y: target.y + 1 }, floor = { ...target, y: target.y - 1 };
    const problems: string[] = [];
    if (!free(target)) problems.push(`目标格是 ${describeCell(a, target)}`);
    if (!free(head)) problems.push(`目标格上方是 ${describeCell(a, head)}（会碰头）`);
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
    if (args.at[1] === 1 && !free({ ...feet, y: feet.y + 2 })) problems.push(`往上跳时自己头顶上方是 ${describeCell(a, { ...feet, y: feet.y + 2 })}`);
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

export const placeAt: Skill<CellArgs & { item: string }> = {
  name: 'place_at',
  description: '在身边指定的空格放一块方块（[前,上,右]）；[0,0,0] 表示原地垫一块站上去（跳起来往脚下放）。item 写方块名，或 "any" 用背包里随便一种能垫的（泥土、圆石、木板…）',
  argsDoc: '{"at":[前,上,右], "item"?:"<方块名>|any", "facing"?:"N|E|S|W"}（前后/左右 ±2，上下 -1..3；例：[0,0,0] 原地垫高一格，[1,-1,0] 填前方脚下的坑）',
  timeoutMs: 15000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    if (at[0] === 0 && at[2] === 0 && at[1] === 1) return { ok: false, error: '[0,1,0] 是自己的头，往上垫高用 [0,0,0]' };
    const facing = facingArg(a.facing, adapter);
    if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
    const item = String(a.item ?? a.block ?? 'any').replace(/^minecraft:/, '');
    if (item !== 'any' && !adapter.isKnownItem(item)) return { ok: false, error: `未知物品：${item}` };
    return { ok: true, args: { at, facing: facing as Facing, item } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const a = ctx.adapter;
    const inv = a.state().inventory;
    const names = args.item === 'any' ? PLACEABLE.filter((n) => inv.some((i) => i.name === n && i.count > 0)) : [args.item];
    if (!names.length || !inv.some((i) => names.includes(i.name) && i.count > 0)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item === 'any' ? '能垫的方块（泥土/圆石/木板…）' : args.item}`, after(ctx, args.facing));
    const feet = feetCell(a.state().pos);
    if (args.at[0] === 0 && args.at[1] === 0 && args.at[2] === 0) {
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
    try {
      const r = await a.placeBlockAt(pos, names, ctx.signal);
      if (!r.ok) return fail(r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : 'PATH_NOT_FOUND', `放不到 [${args.at}]：${r.reason === 'NO_REFERENCE' ? '旁边没有能贴着放的方块（悬空），或者看不见那个面' : r.reason}`, after(ctx, args.facing));
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `放 [${args.at}] 没成：${(e as Error).message}`, after(ctx, args.facing));
    }
    const now = a.blockAt(pos);
    if (!now || AIR.has(now)) return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 还是空的`, after(ctx, args.facing));
    noteEdit(ctx.taskId, 'place', pos);
    return ok(`在 [${args.at}] 放了 ${now}`, { placed: now, ...after(ctx, args.facing) });
  },
};

export const primitiveSkills = [digAt, stepTo, placeAt];

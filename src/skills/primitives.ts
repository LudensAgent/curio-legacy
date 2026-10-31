import type { Vec3Like } from '../adapter/types.ts';
import { FACINGS, facingOfYaw, feetCell, localMap, toWorld, type Facing } from '../perception/local.ts';
import { attachmentFaces, isSoftBlock, LIQUID_BLOCKS, surroundings } from '../perception/surroundings.ts';
import { sleep, throwIfAborted } from '../util.ts';
import { breakCell, why } from './body.ts';
import { OWN_BUILDING_HINT, ownBuildingAt, storedChestAt } from './build.ts';
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
interface CellArgs { at: Rel; facing: Facing; own?: boolean; wet?: boolean; lava?: boolean }
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
  description: '挖掉身边指定的一格；目标不在视野时先转头看向它，仍看不见则返回未知，不挖其他位置。自动换现有工具，默认不造工具。液体邻格默认不挖；wet:true 接受进水，lava:true 接受进岩浆，分别显式选择。只挖不走，不能挖基岩。斜下格 [1,-1,0] 在正前方那格后面，看不见也挖不到；往下挖一格是 [0,-1,0]（挖空后自己会落下）',
  argsDoc: '{"at":[前,上,右], "facing"?:"N|E|S|W", "own"?:true, "wet"?:true（允许进水）, "lava"?:true（允许进岩浆）}（前后/左右 ±2，上下 -1..3；facing 定义相对坐标的方向，执行时可能转头观察固定的目标格；例：[1,1,0] 前方高一格，[0,2,0] 头顶上方，[0,-1,0] 脚下）',
  timeoutMs: 30000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    const facing = facingArg(a.facing, adapter);
    if (!FACINGS.includes(facing as Facing)) return { ok: false, error: facing };
    // [0,0,0]/[0,1,0] 是自己站的两格，本来就空：照样接受（执行时说明一下），不当成写错丢掉
    return { ok: true, args: { at, facing: facing as Facing, ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}) } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const feet = feetCell(ctx.adapter.state().pos);
    const pos = toWorld(feet, args.facing, args.at);
    const physical = ctx.adapter.blockAt(pos);
    // 自己站的两格通常是空的；但也可能有火把、花、雪层、蜘蛛网这类东西，那就照样拿掉
    if (physical === null) return fail('NOT_FOUND', `[${args.at}] 那一格还没加载或看不见`, { ...after(ctx, args.facing, pos), obscured: true });
    if (args.at[0] === 0 && args.at[2] === 0 && (args.at[1] === 0 || args.at[1] === 1) && AIR.has(physical)) return ok(`[${args.at}] 是自己站的地方，本来就空着；往上挖是 [0,2,0]`, { ...after(ctx, args.facing, pos), noop: true });
    // 感知边界取舍：目标格已加载且 blockAt（服务器同步的世界数据，非透视）确认是 air 时，直接当“已经挖空”，
    // 不再强求 raycast 视线亲眼确认——挖阶梯时斜下格 [1,-1,0] 被正前方那格挡住、永远看不见，却常常已经是空气，
    // 硬报 NOT_FOUND 会让整段阶梯卡死。只认“已加载 + 确实是空气”这一种；未加载(null)仍报 NOT_FOUND，
    // 矿石/实心格仍走视线确认、不泄露方块名，也不替 Agent 选目标或改手段。
    if (AIR.has(physical)) return ok(`[${args.at}] 本来就是空的，不用挖`, { cell: [...args.at], was: 'air', ...after(ctx, args.facing, pos), noop: true });
    const key = `${pos.x},${pos.y},${pos.z}`;
    let seenBefore = visibleCells(ctx, [pos]).get(key);
    if (!seenBefore && ctx.senses.observeBlocks) {
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
      return fail('NOT_FOUND', `[${args.at}] 没有发生挖掘；目标格 (${pos.x},${pos.y},${pos.z}) ${ctx.senses.observeBlocks ? '尝试看向后仍未在当前视野' : '当前没有视觉确认'}，可能被遮挡、太暗或未加载，方块状态未知，未确认是空气还是其他方块${hint}`, { ...after(ctx, args.facing, pos), noop: true, obscured: true });
    }
    const before = ctx.adapter.blockAt(pos);
    if (before !== seenBefore) return fail('TARGET_GONE', `[${args.at}] 目标格在观察后已改变或尚未加载，没有执行挖掘`, { ...after(ctx, args.facing, pos), noop: true });
    if (AIR.has(before)) return ok(`[${args.at}] 本来就是空的，不用挖`, { cell: [...args.at], was: 'air', ...after(ctx, args.facing, pos), noop: true });
    if (LIQUID_BLOCKS.has(before)) return fail('BAD_ARGS', `[${args.at}] ${seenBefore ? `是 ${seenBefore}` : '未看清目标，当前不能挖掘'}，挖不了`, after(ctx, args.facing, pos));
    // 挖开会进水/进岩浆：默认不挖，但说清是哪几格、能怎么办（像人一样先堵上，或者认了让水流进来）
    const wets = wetNeighbours(ctx, pos);
    const blocked = wets.filter((w) => /lava/.test(w.name) ? !args.lava : !args.wet);
    if (blocked.length) {
      const cells = wets.map((w) => `[${toRel(feet, args.facing, w.pos)}] 是 ${w.name}`).join('、');
      const fix = blocked.some((w) => /lava/.test(w.name)) ? '可以先堵上，或写 "lava":true 明确接受岩浆流入的风险后照挖'
        : `可以先 place_at 往那几格放方块把水堵上（水格可以直接放方块），或者写 "wet":true 照挖、让水流进来（水只会漫过来，不会伤人，挖完可以再堵）；也可以换个方向`;
      return fail('BAD_ARGS', `[${args.at}] 挖开会有液体流进来：${cells}。${fix}`, { wet: wets[0].name, wetCells: wets.map((w) => toRel(feet, args.facing, w.pos)), ...after(ctx, args.facing, pos) });
    }
    const mine = args.own ? null : ownBuildingAt(ctx.memory, ctx.adapter.state(), pos, before);
    if (mine) return fail('BAD_ARGS', `[${args.at}] 的 ${before} 是自己盖的「${mine.name}」的一部分；${OWN_BUILDING_HINT}`, { own: mine, ...after(ctx, args.facing, pos) });
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
      return fail(code, seenBefore ? `挖 [${args.at}] 的 ${seenBefore} 没成：${why(e)}` : `挖 [${args.at}] 没成（${code}）；未触碰或看清目标，不能确认方块名称`, after(ctx, args.facing, pos));
    }
    const now = ctx.adapter.blockAt(pos);
    if (now && !AIR.has(now) && !isSoftBlock(now)) {
      // 沙子、沙砾会从上面掉下来补上
      return ok(`挖掉了 [${args.at}] 的 ${before}，但上面掉下来的 ${now} 又填上了`, { cell: [...args.at], was: before, now, ...after(ctx, args.facing, pos) });
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
    return ok(`挖掉了 [${args.at}] 的 ${before}${hand}${got}`, { cell: [...args.at], was: before, ...(how.noDrop ? { noDrop: true } : {}), ...(inBag !== undefined ? { inBag } : {}), ...after(ctx, args.facing, pos) });
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
  if (!s.inWater && s.onGround && end.x === stand.x && end.y === stand.y && end.z === stand.z) {
    return ok(`从水里爬上了岸 [${rel}]（实际在 (${end.x},${end.y},${end.z})）`, { moved: rel, landed: true, ...after(ctx, args.facing, stand) });
  }
  return fail('EFFECT_NOT_CONFIRMED', `从水里朝 [${rel}] 的岸爬了，没有站到指定落脚格（岸边落脚处比脚高 ${dy} 格；${res.ok ? '' : `游泳：${res.reason}；`}现在${s.inWater ? '还在水里' : s.onGround ? '已离水并站稳' : '不在水里但没站稳'}，实际在 (${end.x},${end.y},${end.z})）`, { stand: rel, ...after(ctx, args.facing, stand) });
}

export const stepTo: Skill<CellArgs> = {
  name: 'step',
  description: '迈到身边相邻的一格（[前,上,右]）：可以平走、上一级台阶（上+1，会跳）、下一级（上-1）；脚下是梯子时 [0,1,0] 沿梯子爬一格。目标格和头顶需要有身体通行空间、脚下要有支撑；上台阶时自己头顶上方也要空。陆上只走指定高度的一格，不会自动下坎；更深的落点可用 assess_landings 查看并用 descend 明确选择。泡在水里时朝岸那边迈（[1,0,0] 就行），身体会游过去、贴着岸爬上去（岸比脚高一两格也行）',
  argsDoc: '{"to":[前,上,右], "facing"?:"N|E|S|W"}（前后/左右 ±1，上下 -1..1；to 是脚部目标格，须留空，支撑在它下面一格；例：[1,-1,0] 下一级，支撑在 [1,-2,0]）',
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
    const seen = visibleCells(ctx, [target, { ...target, y: target.y + 1 }, { ...target, y: target.y - 1 }, { ...feet, y: feet.y + 2 }]);
    const describe = (p: Vec3Like) => seen.get(`${p.x},${p.y},${p.z}`) ?? '未看清的格子';
    const free = (p: Vec3Like) => {
      const n = a.blockAt(p);
      if (n === null) return false;
      if (AIR.has(n) || isSoftBlock(n)) return true;
      if (!n.endsWith('_door') || n === 'iron_door') return false;
      const open = a.blockStateAt?.(p)?.properties.open;
      // 打开的木门可穿行（门板贴格边、不挡中心通行）；blockOptics 是禁用的透视接口，不能用它取碰撞形状。
      return open === true;
    };
    // 泡在水里：脚下那格是水、岸往往比脚高一两格，平地上的“上下 ±1”对不上。像玩家一样朝那边游、贴着岸按住跳爬上去
    if (a.state().inWater && a.swimTo) {
      const out = await stepOutOfWater(ctx, args, feet);
      if (out) return out;
    }
    // 沿梯子往上爬一格：目标是自己头那格，脚下是梯子；头顶上方要空
    if (args.at[0] === 0 && args.at[2] === 0 && args.at[1] === 1) {
      const top = { ...target, y: target.y + 1 };
      if (!free(top)) {
        if (describe(top) === '未看清的格子' && ctx.senses.observeBlocks) {
          await glanceAt(ctx, top);
          for (const [key, value] of visibleCells(ctx, [top])) seen.set(key, value);
        }
        return fail('PATH_NOT_FOUND', describe(top) === '未看清的格子' ? '梯子往上爬不动：头顶跳跃空间未确认'
          : `梯子往上爬不动：头顶上方是 ${describe(top)}`, after(ctx, args.facing, target));
      }
      let movementError: unknown;
      try {
        await a.moveTo({ kind: 'xyz', x: target.x, y: target.y, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())) });
      } catch (e) {
        if (isAbort(e)) throw e;
        movementError = e;
      }
      throwIfAborted(ctx.signal);
      const end = feetCell(a.state().pos);
      if (end.x !== target.x || end.y !== target.y || end.z !== target.z) return fail(movementError ? codeFromError(movementError) : 'EFFECT_NOT_CONFIRMED', `没有爬到指定格，实际在 (${end.x},${end.y},${end.z})${movementError ? `；${(movementError as Error).message}` : ''}`, after(ctx, args.facing, target));
      return ok(`沿梯子爬上了一格（现在 y=${end.y}）${a.blockAt({ ...end }) === 'ladder' ? '' : '；这格没有梯子了，再往上要先挂'}`, { moved: [0, 1, 0], ...after(ctx, args.facing, target) });
    }
    const head = { ...target, y: target.y + 1 }, floor = { ...target, y: target.y - 1 };
    const solid = (p: Vec3Like) => { const n = a.blockAt(p); return n !== null && !LIQUID_BLOCKS.has(n) && !free(p); };
    const standable = (p: Vec3Like) => solid(p) || (a.blockAt(p) === 'snow' && solid({ ...p, y: p.y - 1 }));
    const ownHead = { ...feet, y: feet.y + 2 };
    const unseenBlock = [!free(target) ? target : null, !free(head) ? head : null, !standable(floor) ? floor : null,
      args.at[1] === 1 && !free(ownHead) ? ownHead : null].find((p) => p && describe(p) === '未看清的格子');
    if (unseenBlock && ctx.senses.observeBlocks) {
      await glanceAt(ctx, unseenBlock);
      for (const [key, value] of visibleCells(ctx, [target, head, floor, ownHead])) seen.set(key, value);
    }
    const problems: string[] = [];
    if (!free(target)) problems.push(describe(target) === '未看清的格子' ? '目标格是 未看清的格子，无法确认通行空间'
      : `目标格是 ${describe(target)}${describe(target).endsWith('_door') ? '（门的状态或碰撞形状阻碍通行）' : LIQUID_BLOCKS.has(describe(target)) ? '' : /chest|barrel|furnace|crafting_table|_bed$/.test(describe(target)) ? '（是用得着的东西，绕过去，别挖）' : `（要过去先 dig_at [${args.at}] 挖开）`}`);
    if (!free(head)) problems.push(describe(head) === '未看清的格子' ? '目标格上方是 未看清的格子，无法确认头部空间'
      : `目标格上方是 ${describe(head)}${describe(head).endsWith('_door') ? '（门的状态或碰撞形状阻碍通行）' : `（会碰头${LIQUID_BLOCKS.has(describe(head)) ? '' : `；先 dig_at [${args.at[0]},${args.at[1] + 1},${args.at[2]}]`}）`}`);
    // 能站住：实心方块；薄雪层下面有实心方块也能踩
    const hasSupport = standable(floor);
    const supportAt = toRel(feet, args.facing, floor);
    const placeAtInRange = supportAt[1] >= -1;
    if (!hasSupport) problems.unshift(`目标格脚下 (${floor.x},${floor.y},${floor.z}) 是 ${describe(floor)}，无已确认支撑；支撑格 [${supportAt}]${placeAtInRange ? '' : ' 超出 place_at 上下 -1..3 范围'}；脚部目标格 [${args.at}] 须留空；未执行迈步`);
    if (args.at[1] === 1 && !free({ ...feet, y: feet.y + 2 })) problems.push(describe({ ...feet, y: feet.y + 2 }) === '未看清的格子'
      ? '往上跳时自己头顶上方是 未看清的格子，无法确认跳跃空间'
      : `往上跳时自己头顶上方是 ${describe({ ...feet, y: feet.y + 2 })}（跳不起来；先 dig_at [0,2,0]）`);
    if (problems.length) return fail('PATH_NOT_FOUND', `迈不到 [${args.at}]：${problems.join('；')}`, { problems, movementNotAttempted: true, obscured: problems.every((p) => p.includes('未看清')),
      ...(!hasSupport ? { landingSupport: { pos: floor, at: supportAt, placeAtInRange, observed: seen.get(`${floor.x},${floor.y},${floor.z}`) ?? null } } : {}),
      ...after(ctx, args.facing, target) });
    let movementError: unknown;
    try {
      await a.moveTo({ kind: 'xyz', x: target.x, y: target.y, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())) });
    } catch (e) {
      if (isAbort(e)) throw e;
      movementError = e;
    }
    throwIfAborted(ctx.signal);
    const end = feetCell(a.state().pos);
    if (end.x !== target.x || end.y !== target.y || end.z !== target.z) return fail(movementError ? codeFromError(movementError) : 'EFFECT_NOT_CONFIRMED', `没有站到 [${args.at}]，实际在 (${end.x},${end.y},${end.z})${movementError ? `；${(movementError as Error).message}` : ''}`, after(ctx, args.facing, target));
    return ok(`站到了 [${args.at}]`, { moved: [...args.at], ...after(ctx, args.facing, target) });
  },
};

export const placeAt: Skill<CellArgs & { item: string; extra?: boolean }> = {
  name: 'place_at',
  description: '在身边指定的空格放一块方块（[前,上,右]）。实心方块放 [0,0,0] 表示原地垫一块站上去（跳起来往脚下放）；梯子、火把这类贴墙的东西可以放进自己站的格子 [0,0,0]/[0,1,0]，但旁边要有实心墙。item 写方块名，或 "any" 用背包里随便一种能垫的（泥土、圆石、木板…）',
  argsDoc: '{"at":[前,上,右], "item"?:"<方块名>|any", "facing"?:"N|E|S|W"}（前后/左右 ±2，上下 -1..3；at 是方块占据格；例：[0,0,0] 原地垫高，[1,-1,0] 支撑 step [1,0,0]，会挡住 step [1,-1,0]；{"at":[0,0,0],"item":"ladder"} 在脚边墙上挂梯子）',
  timeoutMs: 15000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
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
    const feet = feetCell(a.state().pos), pos = toWorld(feet, args.facing, args.at);
    const seen = visibleCells(ctx, [pos, { ...feet, y: feet.y + 2 }]);
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
    const attachable = args.item !== 'any' && attachmentFaces(args.item);
    if (args.at[0] === 0 && args.at[1] === 0 && args.at[2] === 0 && !attachable) {
      // 原地垫高：跳起来往脚下放一块，站上去
      if (a.pillarUp) {
        const r = await a.pillarUp(names, ctx.signal);
        if (!r.ok) {
          const why = r.reason === 'NO_REFERENCE' ? '脚下是空的（悬着、在水里或梯子上），没有能贴着放的面'
            : r.reason === 'OCCUPIED' ? '脚下这格已经有东西'
            : String(r.reason).startsWith('BLOCKED:') ? `脚下这格有 ${seen.get(`${feet.x},${feet.y},${feet.z}`) ?? '未看清的阻挡'}，方块放不进去；先 dig_at [0,0,0] 把它拿掉` : r.reason === 'NO_ITEM' ? '背包里没有能垫的方块' : `方块没放上（${r.reason}）`;
          return fail(r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : r.reason === 'NO_REFERENCE' ? 'PATH_NOT_FOUND' : 'EFFECT_NOT_CONFIRMED', `原地垫高没成：${why}${r.clearanceDetail ? `；${r.clearanceDetail}` : ''}`, { ...after(ctx, args.facing, pos), pillarFailure: r.reason, ...(r.clearance?.at ? { pillarClearance: r.clearance } : {}) });
        }
      } else {
        const above = { ...feet, y: feet.y + 2 }, n = a.blockAt(above);
        if (n === null || !AIR.has(n) && !isSoftBlock(n)) return fail('PATH_NOT_FOUND', `无法确认头顶跳跃空间足够（${seen.get(`${above.x},${above.y},${above.z}`) ?? '未看清的格子'}）`, { ...after(ctx, args.facing, pos), obscured: true });
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
    const cur = a.blockAt(pos);
    if (cur !== null && ((!AIR.has(cur) && !isSoftBlock(cur) && !LIQUID_BLOCKS.has(cur)) || cur === args.item || (args.item === 'torch' && cur === 'wall_torch'))) {
      const name = seen.get(`${pos.x},${pos.y},${pos.z}`);
      return name ? ok(`[${args.at}] 已经有 ${name} 了`, { already: name, ...after(ctx, args.facing, pos) })
        : fail('PATH_NOT_FOUND', `[${args.at}] 已被占用，未放置；当前未看清方块名称`, after(ctx, args.facing, pos));
    }
    // 实心方块放在箱子/木桶正上方会盖住箱盖，之后 store_items 报 LID_BLOCKED 打不开。
    if (!attachable) {
      const below = a.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z });
      if (below && ['chest', 'trapped_chest', 'barrel'].includes(below)) {
        return fail('BAD_ARGS', `[${args.at}] 正下方是 ${below}，放上实心方块会盖住箱盖、之后打不开；请换个位置，或先用 dig_at {"own":true} 把箱子挪走`);
      }
    }
    try {
      const r = await a.placeBlockAt(pos, names, ctx.signal);
      if (!r.ok) {
        const why = r.reason === 'NO_WALL' ? `${args.item} 只能挂在实心方块的侧面，[${args.at}] 四周没有实心墙（或者看不见那个面）`
          : r.reason === 'NO_FLOOR_OR_WALL' ? `${args.item} 要立在实心方块上或挂在它侧面，[${args.at}] 脚下和四周都没有实心方块`
          : r.reason === 'NO_REFERENCE' ? (attachable ? `旁边没有能挂住 ${args.item} 的实心方块面，或者看不见那个面` : '旁边没有能贴着放的方块（悬空），或者看不见那个面') : r.reason;
        return fail(r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : 'PATH_NOT_FOUND', `放不到 [${args.at}]：${why}`, after(ctx, args.facing, pos));
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `放 [${args.at}] 没成：${(e as Error).message}`, after(ctx, args.facing, pos));
    }
    const now = a.blockAt(pos);
    if (!now || AIR.has(now)) return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 还是空的`, after(ctx, args.facing, pos));
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
      const from = feetCell(ctx.adapter.state().pos);
      const r = args.xyz ? rel(from, args.facing, args.xyz) : args.at;
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

export const primitiveSkills = [withAbsolute(digAt, { f: 2, u: [-1, 3], r: 2 }), withAbsolute(stepTo, { f: 1, u: [-1, 1], r: 1 }), withAbsolute(placeAt, { f: 2, u: [-1, 3], r: 2 })];

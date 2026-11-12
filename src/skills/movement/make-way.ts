import type { Vec3Like } from '../../adapter/types.ts';
import { evidenceStale, type VoxelMap } from 'curio-minecraft-3d-memory';
import { hasAnyCollision, isReplaceable, supportTop } from '../../perception/geometry.ts';
import { isDangerousBlock, isWaterBlock } from '../../spatial/land-edge-policy.ts';

/**
 * 开路授权：普通路线走不通时，允许在已记录体素上规划“挖开/补支撑/原地垫高”的路线（类似 pathfinder 的
 * canDig/scaffolding）。只在显式授权时启用；挖用 tool（缺省用当前手持），放用 item（必填，或 "any"）。
 */
export type MakeWayOptions = {
  dig?: { tool?: string };
  place?: { item: string };
  maxEdits: number;
  /**
   * 协调器在普通搜索已失败后调用时置 true：若搜索找到一条不改方块、但确实
   * 走到目标附近的完整路线，也返回它。默认 false，保持“开路只返回施工计划”
   * 的单元语义。
   */
  allowPlainRoute?: boolean;
};

type Cell = { x: number; y: number; z: number };
/** 一步开路：先挖 dig 中的格、再在 place 补支撑（或 pillar 原地垫高），然后站到 to。 */
export type MakeWayStep = { kind: 'move' | 'pillar'; to: Cell; dig: Cell[]; place?: Cell };

/** 各动作的代价：能少挖少放就少挖少放，已知可走的格优先。 */
const COST = { move: 1, stepUp: 1, dropPerBlock: 0.5, dig: 4, place: 3, pillar: 4, unknown: 2 } as const;
const MAX_NODES = 6000, MAX_RADIUS = 40, MAX_RISE = 16;
/** 开路步由连续脚位身体控制执行，它只处理同层/±1；更深的落差不在开路计划里，交回 Agent 选 descend_to 或允许 drop 的路线。 */
const MAX_DROP = 1;
/** 每扫这么久让出一次主线程。 */
const SLICE_MS = 5;
/** 挖不动或挖了会出事的方块：基岩类、需要高级工具才有掉落的硬方块不规划去挖。 */
const UNDIGGABLE = /^(bedrock|barrier|end_portal_frame|end_portal|nether_portal|end_gateway|command_block|chain_command_block|repeating_command_block|structure_block|jigsaw|obsidian|crying_obsidian|reinforced_deepslate|respawn_anchor|ancient_debris|spawner)$/;
/** 头顶压着会落下来的方块：挖开下面的格会让它掉下来砸进身体所在格。 */
const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|pointed_dripstone|scaffolding)$|_concrete_powder$/;
/** 授权 dig 时可以直接打掉的火：没有碰撞，打掉后身体格就是空气；岩浆等其余危险格仍不可挖。 */
const DIGGABLE_FIRE = /^(fire|soul_fire)$/;

const keyOf = (c: Cell) => `${c.x},${c.y},${c.z}`;
const stem = (name: string) => name.replace(/^minecraft:/, '');

type Kind = 'unknown' | 'clear' | 'standable' | 'solid' | 'liquid' | 'danger' | 'fire';

/**
 * 在已记录体素上找一条允许挖开/补支撑/垫高的路线，走向 target。未观察、待重新确认的格一律不当可走/可挖；
 * 危险格、液体、紧挨已记录液体的格不挖，上方压着沙砾的格不挖；授权了 dig 时火/灵魂火可以打掉，
 * 墙后未知的格按可挖岩石规划（另加代价）。到不了时返回离目标最近（至少近 3 格）的部分路线。
 * 只读体素，不动身体；返回 null 表示没有可用路线。
 */
export async function planMakeWay(
  voxel: VoxelMap, dim: string, start: Cell, target: Vec3Like, opts: MakeWayOptions,
  allowed: (cell: Cell) => boolean,
  budget: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<MakeWayStep[] | null> {
  const kinds = new Map<string, { kind: Kind; name: string }>();
  const look = (x: number, y: number, z: number) => {
    const key = `${x},${y},${z}`;
    let hit = kinds.get(key);
    if (hit === undefined) {
      const view = voxel.cellAt(dim, x, y, z);
      if (!view.observed || evidenceStale(view.evidence) || !view.evidence.observation.stateComplete) hit = { kind: 'unknown', name: '' };
      else {
        const { name: raw, properties } = view.evidence.observation.state;
        const name = stem(raw);
        hit = {
          name,
          kind: isDangerousBlock(name)
            ? (opts.dig !== undefined && DIGGABLE_FIRE.test(name) ? 'fire' : 'danger')
            : name === 'lava' || isWaterBlock(name) ? 'liquid'
              : supportTop(name, properties) !== null ? 'standable'
                : hasAnyCollision(name, properties) ? 'solid' : 'clear',
        };
      }
      kinds.set(key, hit);
    }
    return hit;
  };
  // 身体要占的格：已经空着就不用挖；实心且允许挖、挖得动、不邻液体、上方不压落体才挖。不可行返回 null。
  // 授权了 dig 时，墙后看不见的未知格按“大概是岩石、可挖”规划（加 COST.unknown）：执行只做到第一处改动，
  // 走到跟前、挖开前一格后视觉看清了再按真实情况重新规划；第一步要挖的格是已看见的墙面。
  const clearing = (c: Cell): Cell[] | null => {
    const here = look(c.x, c.y, c.z);
    if (here.kind === 'clear') return [];
    // 火没有碰撞，也不会作为支撑：授权 dig 时先打掉再占这一格。
    if (here.kind === 'fire') return [c];
    if (here.kind === 'unknown' && opts.dig === undefined) return null;
    if (here.kind !== 'standable' && here.kind !== 'solid' && here.kind !== 'unknown') return null;
    if (opts.dig === undefined || UNDIGGABLE.test(here.name)) return null;
    const near = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
    // 已记录的液体邻格不挖（岩浆既是液体也在危险名单里，两者都挡）。往岩体里挖时墙后与两侧本来就看不见：
    // 未记录的邻格允许，执行只做到第一处改动就回到普通路线，按视觉新看到的格重新规划。
    if (near.some(([dx, dy, dz]) => { const n = look(c.x + dx, c.y + dy, c.z + dz); return n.kind === 'liquid' || n.name === 'lava'; })) return null;
    if (FALLING.test(look(c.x, c.y + 1, c.z).name)) return null;
    return [c];
  };
  // 脚下支撑：已记录的可站立面；授权了 dig 时岩体里看不见的支撑按“大概有”规划（加 COST.unknown），到跟前看清再定。
  const supported = (c: Cell) => {
    const below = look(c.x, c.y - 1, c.z).kind;
    return below === 'standable' || (below === 'unknown' && opts.dig !== undefined);
  };
  // 一步里有几处是按“未知但大概如此”规划的：每处加 COST.unknown，已知可走的路线优先。
  const unsure = (cells: readonly Cell[]) => cells.filter((cell) => look(cell.x, cell.y, cell.z).kind === 'unknown').length * COST.unknown;
  // 要放方块的格：空气或可替换（草、火…）直接放；被不可替换的无碰撞物（树苗、花、火把…）占着时，
  // 授权了 dig 就先把它打掉，否则放不进去。返回要先挖的格，null 表示放不了。
  const freeing = (c: Cell): Cell[] | null => {
    if (opts.place === undefined) return null;
    const here = look(c.x, c.y, c.z);
    // 岩浆、水在原版里可被方块替换：往液体格里放一块就是在湖面上搭桥。
    if (here.kind === 'unknown' || here.kind === 'standable') return null;
    if (here.name === 'air' || here.name === 'cave_air' || here.name === 'void_air' || isReplaceable(here.name)) return [];
    return here.kind === 'clear' && opts.dig !== undefined && !UNDIGGABLE.test(here.name) ? [c] : null;
  };
  const h = (c: Cell) => Math.hypot(target.x - (c.x + 0.5), target.z - (c.z + 0.5)) + Math.abs(target.y - c.y) * 0.5;

  type Node = { cell: Cell; g: number; f: number; parent: Node | null; step: MakeWayStep | null };
  type OpenEntry = { node: Node; seq: number };
  // 稳定最小堆：f 相同时按插入序号先到先出，与原线性扫描挑“第一个最小值”的选择顺序一致。
  const open: OpenEntry[] = [];
  let nextSeq = 0;
  const openLess = (a: OpenEntry, b: OpenEntry) => a.node.f < b.node.f || (a.node.f === b.node.f && a.seq < b.seq);
  const openPush = (node: Node) => {
    const entry: OpenEntry = { node, seq: nextSeq++ };
    open.push(entry);
    let index = open.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!openLess(entry, open[parent]!)) break;
      open[index] = open[parent]!;
      index = parent;
    }
    open[index] = entry;
  };
  const openPop = (): Node => {
    const first = open[0]!;
    const last = open.pop()!;
    if (open.length === 0) return first.node;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1, right = left + 1;
      if (left >= open.length) break;
      const child = right < open.length && openLess(open[right]!, open[left]!) ? right : left;
      if (!openLess(open[child]!, last)) break;
      open[index] = open[child]!;
      index = child;
    }
    open[index] = last;
    return first.node;
  };
  const startNode: Node = { cell: start, g: 0, f: h(start), parent: null, step: null };
  openPush(startNode);
  const best = new Map<string, number>([[keyOf(start), 0]]);
  let closest = startNode;
  let expanded = 0;
  let sliceEnd = performance.now() + SLICE_MS;
  while (open.length > 0 && expanded < MAX_NODES) {
    // 取消/期限由调用方决定；规划只是委托的一部分，不能越过它继续占主线程。
    if (budget.signal?.aborted || (budget.deadlineMs !== undefined && Date.now() >= budget.deadlineMs)) return null;
    if (performance.now() >= sliceEnd) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceEnd = performance.now() + SLICE_MS;
    }
    const node = openPop();
    if ((best.get(keyOf(node.cell)) ?? Infinity) < node.g) continue;
    expanded++;
    if (h(node.cell) < h(closest.cell)) closest = node;
    if (h(node.cell) <= 1) { closest = node; break; }
    const { x, y, z } = node.cell;
    const candidates: { step: MakeWayStep; cost: number }[] = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, nz = z + dz;
      // 同层：脚、头两格要空（或挖开），脚下有支撑（或补一块）。
      {
        const to = { x: nx, y, z: nz };
        const feet = clearing(to), head = clearing({ ...to, y: y + 1 });
        // 脚下是危险格（岩浆、火…）时不站上去；授权了 place 且它可被替换（岩浆、火）就先补一块再走。
        const under = look(nx, y - 1, nz);
        if (feet !== null && head !== null && (under.kind !== 'danger' || (opts.place !== undefined && isReplaceable(under.name)))) {
          const dig = [...feet, ...head];
          if (supported(to)) candidates.push({ step: { kind: 'move', to, dig }, cost: COST.move + dig.length * COST.dig + unsure([...dig, { x: nx, y: y - 1, z: nz }]) });
          else {
            const free = freeing({ x: nx, y: y - 1, z: nz });
            if (free !== null) candidates.push({ step: { kind: 'move', to, dig: [...dig, ...free], place: { x: nx, y: y - 1, z: nz } }, cost: COST.move + (dig.length + free.length) * COST.dig + COST.place + unsure(dig) });
          }
        }
      }
      // 上一级：起跳要自己头顶再高一格空着；落点脚、头空着且脚下本来就有支撑。
      {
        const to = { x: nx, y: y + 1, z: nz };
        const lift = clearing({ x, y: y + 2, z }), feet = clearing(to), head = clearing({ ...to, y: y + 2 });
        if (lift !== null && feet !== null && head !== null && supported(to) && look(nx, y, nz).kind !== 'danger') {
          const dig = [...lift, ...feet, ...head];
          candidates.push({ step: { kind: 'move', to, dig }, cost: COST.move + COST.stepUp + dig.length * COST.dig + unsure([...dig, { x: nx, y, z: nz }]) });
        }
      }
      // 下落：只规划 move_step 能执行的一格落差；更深的落差交回 Agent 选择下行方式。
      if (look(nx, y, nz).kind === 'clear' && look(nx, y + 1, nz).kind === 'clear') {
        for (let d = 1; d <= MAX_DROP; d++) {
          const below = look(nx, y - d, nz);
          if (below.kind !== 'clear') break;
          const floor = look(nx, y - d - 1, nz);
          if (floor.kind === 'standable') {
            candidates.push({ step: { kind: 'move', to: { x: nx, y: y - d, z: nz }, dig: [] }, cost: COST.move + d * COST.dropPerBlock });
            break;
          }
          if (floor.kind !== 'clear') break;
        }
      }
    }
    // 原地垫高一格：头顶再高一格要空（或挖开）。
    // 原地垫高：方块放进身体所在的脚格（被树苗等占着要先打掉），头顶再高一格要空（或挖开）。
    {
      const free = freeing({ x, y, z }), lift = clearing({ x, y: y + 2, z });
      if (free !== null && lift !== null) candidates.push({ step: { kind: 'pillar', to: { x, y: y + 1, z }, dig: [...free, ...lift] }, cost: COST.pillar + (free.length + lift.length) * COST.dig + unsure(lift) });
    }
    for (const { step, cost } of candidates) {
      const to = step.to;
      if (Math.abs(to.x - start.x) > MAX_RADIUS || Math.abs(to.z - start.z) > MAX_RADIUS || Math.abs(to.y - start.y) > MAX_RISE) continue;
      if (!allowed(to)) continue;
      if (look(to.x, to.y, to.z).kind === 'danger' || look(to.x, to.y + 1, to.z).kind === 'danger') continue;
      // 落点身体两格里若有本步没打掉的火，执行时仍会被 move_step 拒绝：这种候选不成立。
      const dug = (cell: Cell) => step.dig.some((d) => d.x === cell.x && d.y === cell.y && d.z === cell.z);
      const unDugFire = [to, { x: to.x, y: to.y + 1, z: to.z }]
        .some((cell) => look(cell.x, cell.y, cell.z).kind === 'fire' && !dug(cell));
      if (unDugFire) continue;
      // 与 move_step 的危险检查同口径：落点身体两格的水平邻格或头顶是已记录的岩浆（可能流入）时，它默认不迈；
      // 规划时就避开，不规划一条执行时注定被拒的路线。
      const flowIn = [to.y, to.y + 1].some((y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => look(to.x + dx!, y, to.z + dz!).name === 'lava'))
        || look(to.x, to.y + 2, to.z).name === 'lava';
      if (flowIn) continue;
      const g = node.g + cost;
      const key = keyOf(to);
      if ((best.get(key) ?? Infinity) <= g) continue;
      best.set(key, g);
      openPush({ cell: to, g, f: g + h(to), parent: node, step });
    }
  }
  if (closest === startNode || h(start) - h(closest.cell) < 3 && h(closest.cell) > 1) return null;
  const steps: MakeWayStep[] = [];
  for (let n: Node | null = closest; n !== null && n.step !== null; n = n.parent) steps.push(n.step);
  steps.reverse();
  // 含挖/放/垫高的部分路线照旧返回。“不改动方块、只走过去”的路线默认丢弃，
  // 保持“开路=施工计划”的语义；协调器在普通搜索已失败后传入 allowPlainRoute，
  // 此时若这条纯移动路线真的走到目标附近（h<=1）就返回它——普通搜索可能因为
  // 边界/证据/预算停在别处，而这里从实测位置找到了完整通路。
  const hasEdits = steps.some((step) => step.dig.length > 0 || step.place !== undefined || step.kind === 'pillar');
  return hasEdits || (opts.allowPlainRoute === true && h(closest.cell) <= 1) ? steps : null;
}

/** 默认与上限：一次调用最多为开路改动这么多格（挖开 + 放置合计）。长距离探索常需要连续搭桥，默认按最大可走距离给足。 */
export const MAKE_WAY_DEFAULT_EDITS = 512, MAKE_WAY_MAX_EDITS = 512;
/** 开路参数的说明片段，三个入口共用，与 parseMakeWay 一致。 */
export const MAKE_WAY_ARGS_DOC = `"dig"?:true|"工具名"（普通路线走不通时允许挖开挡路的格；true 用当前手持，写工具名只用那一把；火/灵魂火也在这项授权内直接打掉）,"place"?:"方块名|any"（允许补脚下支撑/原地垫高，只用这种方块；any 只用泥土、下界岩、圆石等土石类填充方块）,"maxEdits"?:1-${MAKE_WAY_MAX_EDITS}（默认 ${MAKE_WAY_DEFAULT_EDITS}；本次调用最多挖开+放置这么多格。搭桥/长距离开路通常每格约一次改动，长距离目标要按距离留足额度；续接只能收窄，不退还同一移动委托已经用掉的累计施工额度）`;
/** 开路参数的行为说明，三个入口共用。 */
export const MAKE_WAY_DOC = '默认不挖不放；写了 dig/place 时，先按已记录体素走普通路线，走不通（阻挡/无路/无进展，或路线只被火/灵魂火挡住）才在已记录体素上规划代价最小的挖开/补支撑/原地垫高路线（未观察格、液体及其邻格、其余危险格、上方压着沙砾的格不挖；dig 授权时火/灵魂火可以打掉），每次只执行到第一处挖开/放置就回到普通路线、按新看到的格重新规划（挖进看不见的岩体时邻格可能藏着岩浆等液体，这是授权 dig 承担的风险），用 mine_cell/place_support/pillar_one 施工，迈步用连续脚位身体控制；每一步迈出前都用当前已加载方块确认落点支撑、扫掠与危险格，确认不了或看到阻挡就停下交回，不会先迈出去再报错；回执 makeWay.edits 逐条记录挖开了什么、在哪放了什么';

/** 从委托参数解析开路授权；没有写 dig/place 返回 undefined。参数非法返回错误。 */
export function parseMakeWay(a: Record<string, unknown>): { ok: true; value: MakeWayOptions | undefined } | { ok: false; error: string } {
  if (a.dig !== undefined && a.dig !== true && a.dig !== false && (typeof a.dig !== 'string' || a.dig.trim() === '')) return { ok: false, error: 'dig 需要 true/false 或工具名' };
  if (a.place !== undefined && (typeof a.place !== 'string' || a.place.trim() === '')) return { ok: false, error: 'place 需要方块名或 "any"' };
  if (a.maxEdits !== undefined && (!Number.isInteger(a.maxEdits) || (a.maxEdits as number) < 1 || (a.maxEdits as number) > MAKE_WAY_MAX_EDITS)) return { ok: false, error: `maxEdits 需要 1–${MAKE_WAY_MAX_EDITS} 的整数` };
  const dig = a.dig === true ? {} : typeof a.dig === 'string' ? { tool: a.dig.trim() } : undefined;
  const place = typeof a.place === 'string' ? { item: a.place.trim() } : undefined;
  if (dig === undefined && place === undefined) {
    if (a.maxEdits !== undefined) return { ok: false, error: 'maxEdits 只在写了 dig 或 place 时有意义' };
    return { ok: true, value: undefined };
  }
  return { ok: true, value: { ...(dig === undefined ? {} : { dig }), ...(place === undefined ? {} : { place }), maxEdits: (a.maxEdits as number | undefined) ?? MAKE_WAY_DEFAULT_EDITS } };
}

/** 把开路授权还原成平铺的委托参数：校验结果必须能再次通过校验（计划录入后、执行前会再校验一次）。 */
export function makeWayArgs(opts: MakeWayOptions | undefined): { dig?: true | string; place?: string; maxEdits?: number } {
  if (opts === undefined) return {};
  return {
    ...(opts.dig === undefined ? {} : { dig: opts.dig.tool ?? true }),
    ...(opts.place === undefined ? {} : { place: opts.place.item }),
    maxEdits: opts.maxEdits,
  };
}

/** 已校验的平铺参数 → 交给协调器的开路授权；没有授权返回空对象。 */
export function makeWayRequest(args: { dig?: true | string; place?: string; maxEdits?: number }): { makeWay?: MakeWayOptions } {
  const parsed = parseMakeWay(args);
  return parsed.ok && parsed.value !== undefined ? { makeWay: parsed.value } : {};
}

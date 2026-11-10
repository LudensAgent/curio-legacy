import type { MoveTarget, Vec3Like } from '../../adapter/types.ts';
import { DIRS } from '../../perception/perception.ts';
import { travelStore } from '../../travel/store.ts';
import { cancelledNav, fail, isAbort, navReceipt, obj, ok, type NavOutcome, type Skill, type SkillResult } from '../types.ts';
import { HEADING_TARGET, MAX_HEADING_DISTANCE } from '../overland.ts';
import { pageFragments } from '../../spatial/fragments.ts';
import { buildPathGraph, routeOnPathGraph } from '../../spatial/path-graph.ts';

type Heading = keyof typeof DIRS;
type TravelTarget =
  | { x: number; y?: number; z: number }
  /** corridor：沿方向推进到 distance、横向偏离 ≤ corridor 的任意站位都算到达，不要求射线上那个点。 */
  | { heading: Heading; distance: number; origin: Vec3Like; corridor?: number }
  | { landmark: string }
  | { portal: string }
  | { death: true };

type TravelToArgs = {
  to: TravelTarget;
  range: number;
  allowDig: boolean;
  allowPlace: boolean;
  allowTower: boolean;
  allowSwim: boolean;
  allowHazard: boolean;
  avoid: string[];
  sprint: boolean;
  timeoutMs: number;
  /** 寻路挖掘只用这件工具；不写按手上/自己挑过的工具，最后才按最快。 */
  tool?: string;
  /**
   * direct = 朝目标直线分跳；history = 先查自己走过的历史路线（拓扑没有就用记录过的路径片段），
   * 按其路点分跳；{fragment} = 只沿 Agent 指定的那条片段走。都仍由 pathfinder 逐跳实测。
   */
  /** auto（默认）：记录路线算上离路代价更省就沿它走，否则直接走；direct 只走直线；history 先查拓扑历史路线。 */
  via: 'auto' | 'direct' | 'history' | { fragment: string };
};

/** 每跳的水平长度：pathfinder 每次只在附近已加载区块里搜一小段，到了再按实测位置规划下一跳。 */
const HOP = 24;
/**
 * 目标在这个水平距离内（通常仍在已加载区块里）时，正前方一跳直接以真实目标为寻路终点：
 * pathfinder 在可达路线里找最短的那条，不必先朝「从当前位置往目标方向 HOP 格」的中间点走——
 * 那个点随身体位置漂移、不在去目标的路上：三维目标会被带下矿道/坡底；下界岩洞里会在两条洞道间
 * 来回（在 A 时中间点只能经 B 到，到了 B 新的中间点又只能经 A 到）。
 */
const DIRECT_REACH = 64;
/** 一轮走完落在本次之前某轮停过的位置这么近、且没更接近目标：判为来回打转，不再继续绕。 */
const REVISIT_RADIUS = 3;
/** 正前方一跳走不通时依次试的偏转角（度）；偏转跳更短，只用于绕开眼前的阻挡。 */
const DETOURS = [45, -45, 90, -90];
const DETOUR_HOP = 16;
/** 单跳寻路的绕路余量（mineflayer-pathfinder searchRadius：路线代价最多比直线估计多这么多）：绕太远就算这跳不通，换偏转跳或停下，不让一跳在岩洞里绕出反方向的长路。 */
const HOP_SEARCH_RADIUS = 48;
/** 连续这么多轮没有更接近目标就停，不在原地反复试。 */
const MAX_STALE_ROUNDS = 3;
/** 历史路线路点的间距（沿路线累计的格数）：太密的点合并，每跳仍由 pathfinder 实测。按三维路程算，竖井/螺旋阶梯的路点不会被水平距离吞掉。 */
const HISTORY_SPACING = 8;
/** 目标吸附到记录路径格的半径（格） */
const HISTORY_NEAR = 8;
/** 历史路线可以从这么远的记录格上路（不在记录上的那段按离路代价计，由 pathfinder 按授权走/挖/垫过去） */
const HISTORY_REACH = 24;
/** 两片不相连的记录相距不超过这么多格时，可以跨过去接着走（同样按离路代价计） */
const HISTORY_GAP = 16;
const historyRoute = (fragments: Parameters<typeof buildPathGraph>[0], from: Vec3Like, to: Vec3Like, deadline: number, preferRecorded = false) =>
  routeOnPathGraph(buildPathGraph(fragments), from, to, HISTORY_NEAR, deadline, { reach: HISTORY_REACH, maxGap: HISTORY_GAP, ...(preferRecorded ? { preferRecorded: true } : {}) });
/** 行走辅助（mineflayer-pathfinder 默认 maxDropDown）一次最多往下落几格；更高的落差它不会走 */
const WALK_MAX_DROP = 4;
/** 剩余高差超过这么多格、且是水平剩余的 2 倍以上时，水平偏转绕行帮不上，不再偏转 */
const VERTICAL_DOMINANT = 8;
/** 默认绕开会伤身的方块（含“站在上面”）；岩浆与火由寻路器始终绕开，不受 allowHazard 影响。 */
const HAZARD_AVOID = ['magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'wither_rose', 'soul_fire'];
const BLOCK_NAME = /^[a-z0-9_]+$/;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseTarget(raw: unknown, origin: () => Vec3Like): TravelTarget | string {
  if (typeof raw === 'string') {
    const s = raw.trim();
    const heading = s.toUpperCase().match(HEADING_TARGET);
    if (heading) return parseTarget({ heading: heading[1], distance: Number(heading[2]) }, origin);
    if (/^death$/i.test(s)) return { death: true };
    const portal = s.match(/^portal\s*[:：]\s*(\S+)$/i);
    if (portal) return { portal: portal[1] };
    const nums = s.match(/-?\d+(?:\.\d+)?/g);
    if (nums && !/[a-z一-龥]{2,}/i.test(s.replace(/\b[xyz]\s*[=:]/gi, ''))) {
      if (nums.length === 3) return { x: +nums[0], y: +nums[1], z: +nums[2] };
      if (nums.length === 2) return { x: +nums[0], z: +nums[1] };
      return 'to 坐标需要 "x,z" 或 "x,y,z"';
    }
    return s ? { landmark: s } : 'to 不能为空';
  }
  const t = obj(raw);
  if (finite(t.x) && finite(t.z)) {
    if (t.y !== undefined && !finite(t.y)) return 'to.y 需要有限数字';
    return { x: t.x, ...(finite(t.y) ? { y: t.y } : {}), z: t.z };
  }
  if (t.heading !== undefined) {
    const heading = String(t.heading).toUpperCase();
    if (!Object.hasOwn(DIRS, heading)) return 'heading 只能是 N/NE/E/SE/S/SW/W/NW';
    if (!Number.isInteger(t.distance) || t.distance < 1) return 'distance 需要正整数格数';
    // 原目标不缩短：超过上限直接拒绝，由 Agent 分段或写终点坐标。
    if (t.distance > MAX_HEADING_DISTANCE) return `方向距离 ${t.distance} 格超过单次上限 ${MAX_HEADING_DISTANCE} 格；原目标不会被缩短，请分段或直接写终点坐标`;
    // 首次校验冻结起点；重试/续接沿用冻结的起点，不按新位置重新解释方向。
    const o = obj(t.origin);
    if (t.origin !== undefined && ![o.x, o.y, o.z].every(finite)) return 'heading 的 origin 需要 {x,y,z} 有限数字';
    if (t.corridor !== undefined && (!Number.isInteger(t.corridor) || t.corridor < 1 || t.corridor > 64)) return 'heading 的 corridor 需要 1–64 的整数';
    return {
      heading: heading as Heading, distance: t.distance, origin: t.origin === undefined ? { ...origin() } : { x: o.x, y: o.y, z: o.z },
      ...(t.corridor === undefined ? {} : { corridor: t.corridor }),
    };
  }
  if (typeof t.landmark === 'string' && t.landmark.trim()) return { landmark: t.landmark.trim() };
  if (typeof t.portal === 'string' && t.portal.trim()) return { portal: t.portal.trim() };
  if (t.death === true) return { death: true };
  return 'to 需要坐标 {x,z}/{x,y,z}/"x,z"、方向如 "E 150" 或 {"heading":"E","distance":150}、记得的地标名/base、"death" 或 "portal:<id>"';
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const at = (p: Vec3Like) => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;

/**
 * 显式的已加载区块行走辅助（D-091）：Agent 选定目的地与允许的手段，pathfinder 在服务器已发来的区块里
 * 按 ≤24 格分跳执行，每跳用实测位置验收。读已加载区块只用于驱动身体：路径格不回报、不写入 VoxelMap，
 * 失败只说辅助没找到/走不通，不描述没看见的地形。默认不挖、不放、不搭柱；开启后回执逐项列出改动。
 */
export const travelTo: Skill<TravelToArgs> = {
  name: 'travel_to',
  description: '已加载区块行走辅助（后端 pathfinder）：走向你给的坐标、方向+距离、记得的地标/base/死亡点/已记录传送门。目标在 64 格内时直接以目标为寻路终点（找已加载区块里最短的可达路线），更远时按 ≤24 格分跳，每跳实测验收；正前方走不通时在附近偏转绕行，连续 3 轮不更近、绕回之前到过的位置、无路或超时就停，回执报实测位置、位移、剩余距离、停止原因。默认不下水、不挖不放不搭柱（allowSwim:true 才走水路）、绕开岩浆块/仙人掌/浆果丛等伤身方块；allowDig/allowPlace/allowTower 授权后可能挖掉或放下方块（消耗背包方块与工具耐久），回执逐项列出。默认 via:"auto" 先找起点附近的实际记录锚点，沿自己走过/搭过/挖过的连续记录路线接到目标附近：只按顺序推进实际到达的历史路点，不因下一个点欧氏距离更近就跳过弯道；跟随历史路点时即使授权施工也不挖/垫/搭柱，历史记录只代表过去走过、现在是否还通需逐跳实测。历史路点走不通就停在实测位置，回执报失败路点、原因和已有进度，不会丢下剩余路点转去挖新通道。没有可用记录、或走完记录只到旧路末端后，新段也先按不施工寻路；只有这次不施工搜索明确返回 noPath、且原请求允许施工时，才按已给授权重试同一目标。超时、执行卡住、NOT_CONFIRMED、取消都不会升级成挖/放。via:"auto" 的记录候选按实际路线长度/爬升代价选较短连接，不用未证明可走的直线距离否掉真实旧路；via:"history" 先查拓扑历史路线，再查记录片段，agent 指定片段时只沿该片段；via:"direct" 跳过旧路优先，直接按当前授权寻路，是显式改变方法的入口。寻路挖掘默认用手上能挖的工具、其次你挑过的那类，tool 指定后只用那件。不搜索方块名，不报告规划出的路径；“没找到路”只表示辅助在已加载区块、这次授权搜索里没找到，不说明没看见的地形或全世界都没有路。sprint 更快但耗饥饿。',
  argsDoc: '{"to": {"x":0,"z":0} | {"x":0,"y":64,"z":0} | "x,z" | "x,y,z" | "E 150"（方向 N/NE/E/SE/S/SW/W/NW + 格数，≤200，超出拒绝不缩短；到达看射线终点附近） | {"heading":"E","distance":150,"corridor"?:16}（同上；写 corridor 时沿方向推进够距离、横向偏离 ≤ corridor 的任意站位都算到，不要求射线上那个点；寻路也按推进找路） | "地标名" | "base"（首选基地，不一定是最近的那个） | "death" | "portal:<id>", "range"?:2（到达半径 1–16；无 y 按水平、带 y 按三维）, "allowSwim"?:false（true 才下水；水里有溺水与溺尸风险）, "allowDig"?:false, "tool"?:"stone_pickaxe"（需 allowDig；寻路挖掘只用这件）, "allowPlace"?:false, "allowTower"?:false（需 allowPlace）, "allowHazard"?:false（true 时不额外绕开伤身方块；岩浆与火始终绕开）, "avoid"?:["方块名"], "sprint"?:false, "timeoutMs"?:180000（10000–600000）, "via"?:"auto"|"direct"|"history"|{"fragment":"<片段 id>"}（默认 auto：优先从起点附近的实际记录锚点沿连续旧路接到目标附近，按实际路线/爬升代价选较短记录候选；跟随旧路时不施工，历史路点走不通就停在实测进度并报该路点，不转去挖新路；没有可用记录或走到记录末端后，新段先试不施工搜索，只有明确 noPath 且原请求允许施工才按原授权重试。direct 跳过旧路优先，按当前授权直接寻路，是显式换方法的入口。history 先查拓扑历史路线，再查记录片段；{fragment} 只沿指定片段。历史记录只说明过去走过，现在是否还通仍逐跳实测；回执 history 给出到达路点数、失败路点/原因、偏离与剩余目标）}',
  timeoutMs: 600000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const to = parseTarget(a.to ?? a.target, () => adapter.state().pos);
    if (typeof to === 'string') return { ok: false, error: to };
    for (const flag of ['allowDig', 'allowPlace', 'allowTower', 'allowSwim', 'allowHazard', 'sprint'] as const) {
      if (a[flag] !== undefined && typeof a[flag] !== 'boolean') return { ok: false, error: `${flag} 需要布尔值` };
    }
    if (a.allowTower === true && a.allowPlace !== true) return { ok: false, error: 'allowTower 原地搭柱要放方块，需要同时写 allowPlace:true' };
    if (a.range !== undefined && (!Number.isInteger(a.range) || a.range < 1 || a.range > 16)) return { ok: false, error: 'range 需要 1–16 的整数' };
    if (a.timeoutMs !== undefined && (!Number.isInteger(a.timeoutMs) || a.timeoutMs < 10000 || a.timeoutMs > 600000)) return { ok: false, error: 'timeoutMs 需要 10000–600000 的整数' };
    if (a.avoid !== undefined && (!Array.isArray(a.avoid) || a.avoid.length > 32 || a.avoid.some((n) => typeof n !== 'string' || !BLOCK_NAME.test(n)))) {
      return { ok: false, error: 'avoid 需要方块名数组（小写 snake_case，最多 32 个）' };
    }
    if (a.tool !== undefined) {
      if (typeof a.tool !== 'string' || !/^[a-z0-9_]{1,80}$/.test(a.tool)) return { ok: false, error: 'tool 为物品注册名（如 stone_pickaxe）' };
      if (a.allowDig !== true) return { ok: false, error: 'tool 指定寻路挖掘用哪件工具，需要同时写 allowDig:true' };
      if (!adapter.state().inventory.some((i) => i.name === a.tool && i.count > 0)) return { ok: false, error: `TOOL_MISSING：背包里没有 ${a.tool}，没有移动` };
    }
    const viaFragment = obj(a.via).fragment;
    if (a.via !== undefined && a.via !== 'auto' && a.via !== 'direct' && a.via !== 'history' && !(typeof viaFragment === 'string' && viaFragment.trim())) {
      return { ok: false, error: 'via 只能是 "auto"、"direct"、"history" 或 {"fragment":"<片段 id>"}（id 来自 spatial_query fragments / spatial_extrema 回执）' };
    }
    return {
      ok: true,
      args: {
        to, range: a.range ?? 2,
        allowDig: a.allowDig === true, allowPlace: a.allowPlace === true, allowTower: a.allowTower === true,
        allowSwim: a.allowSwim === true, allowHazard: a.allowHazard === true,
        avoid: [...new Set((a.avoid ?? []) as string[])], sprint: a.sprint === true, timeoutMs: a.timeoutMs ?? 180000,
        ...(typeof a.tool === 'string' ? { tool: a.tool } : {}),
        via: typeof viaFragment === 'string' ? { fragment: viaFragment.trim() } : (a.via as 'auto' | 'direct' | 'history' | undefined) ?? 'auto',
      },
    };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    const s0 = adapter.state();
    const request = { ...args, to: structuredClone(args.to) } as Record<string, unknown>;
    const backend = 'pathfinder';
    // 目标只来自坐标、方向或 Agent 记忆里的实体；不按方块名搜索，不替 Agent 选目的地。
    const t = args.to;
    const target = 'x' in t ? { x: t.x, y: t.y, z: t.z, label: `${t.x},${t.y === undefined ? '' : `${t.y},`}${t.z}` }
      : 'heading' in t ? { x: Math.round(t.origin.x + DIRS[t.heading][0] / Math.hypot(...DIRS[t.heading]) * t.distance), y: undefined, z: Math.round(t.origin.z + DIRS[t.heading][1] / Math.hypot(...DIRS[t.heading]) * t.distance), label: `往 ${t.heading} ${t.distance} 格` }
      : 'death' in t ? (() => { const d = ctx.memory.lastDeath(); return d && d.dim === s0.dim ? { ...d.pos, label: '死亡地点' } : null; })()
      : 'portal' in t ? (() => { const p = travelStore(ctx.memory).get(t.portal, s0.worldId); return p && p.dim === s0.dim ? { ...p.pos, label: `传送门 ${p.id}` } : null; })()
      : (() => { const lm = ctx.memory.findLandmark(t.landmark, s0.dim); return lm && lm.dim === s0.dim ? { ...lm.pos, label: lm.label } : null; })();
    if (!target) return fail('NOT_FOUND', `当前维度 ${s0.dim} 里没有记得的目标 ${JSON.stringify(args.to)}；travel_to 只去坐标、方向或已记录的地标/base/死亡点/传送门，没有移动`, { originalRequest: request, backend });
    if (!s0.alive || !s0.connected) return fail('NOT_CONNECTED', 'travel_to 需要存活且已连接的身体；没有移动', { originalRequest: request, backend });
    if (s0.riding) return fail('BAD_ARGS', `正在乘坐 ${s0.riding}；travel_to 只步行/游泳，是否下船由你决定，没有移动`, { originalRequest: request, backend });

    const resolvedTarget = { x: target.x, ...(target.y === undefined ? {} : { y: target.y }), z: target.z };
    const start = { ...s0.pos };
    const startedAt = Date.now();
    const deadline = Math.min(ctx.deadline, startedAt + args.timeoutMs);
    const startChunks = ctx.memory.visitedChunkCount;
    const trace: Vec3Like[] = [start];
    const record = () => { trace.push({ ...adapter.state().pos }); if (trace.length > 24) trace.splice(0, trace.length - 24); };
    // 方向 + corridor：按沿方向推进验收，剩余 = 还差的推进 + 超出 corridor 的横向偏离（格心口径，与适配器 advance 目标一致）。
    const lane = 'heading' in t && t.corridor !== undefined
      ? { origin: t.origin, dir: { x: DIRS[t.heading][0] / Math.hypot(...DIRS[t.heading]), z: DIRS[t.heading][1] / Math.hypot(...DIRS[t.heading]) }, distance: t.distance, corridor: t.corridor }
      : null;
    const alongOf = (p: Vec3Like) => lane === null ? 0 : (Math.floor(p.x) + 0.5 - lane.origin.x) * lane.dir.x + (Math.floor(p.z) + 0.5 - lane.origin.z) * lane.dir.z;
    const lateralOf = (p: Vec3Like) => lane === null ? 0 : Math.abs((Math.floor(p.z) + 0.5 - lane.origin.z) * lane.dir.x - (Math.floor(p.x) + 0.5 - lane.origin.x) * lane.dir.z);
    // 按 pathfinder 的节点口径验收：脚下所在格到目标格的距离。
    const flat = (p: Vec3Like) => lane !== null
      ? Math.max(0, lane.distance - alongOf(p)) + Math.max(0, lateralOf(p) - lane.corridor)
      : Math.hypot(Math.floor(p.x) - Math.floor(target.x), Math.floor(p.z) - Math.floor(target.z));
    const gap = (p: Vec3Like) => target.y === undefined ? flat(p) : Math.hypot(flat(p), Math.floor(p.y) - Math.floor(target.y));
    const arrived = (p: Vec3Like) => gap(p) <= args.range;
    const avoid = [...new Set([...args.avoid, ...(args.allowHazard ? [] : HAZARD_AVOID)])];
    const hopBudget = !args.allowSwim && !args.allowDig && !args.allowPlace;
    const moveOpts = {
      signal,
      ...(args.allowDig ? { allowTerrainChanges: true, ...(args.tool ? { digTool: args.tool } : {}) } : {}),
      allowPlace: args.allowPlace, allowTower: args.allowTower,
      ...(args.allowSwim ? {} : { allowSwimming: false }),
      sprint: args.sprint, avoid,
      // 不另外授权冒险时，路线尽量离岩浆边远一点（只加代价，唯一的路仍可走）
      ...(args.allowHazard ? {} : { lavaEdgeCost: 10 }),
      // 只在纯步行时限制绕路余量：余量按寻路代价算，不按格数。水格代价是陆路的 10 倍；挖一块计
      // 1+3×挖掘秒数（铁镐挖下界岩一步两块就约 3.6，徒手更高），放一块 +1。授权游泳/挖/放时，
      // 一跳 24 格直穿的代价就超过“直线 + 48”，加了上限等于不让用这些授权。
      ...(hopBudget ? { searchRadius: HOP_SEARCH_RADIUS } : {}),
    };
    // 纯步行搜索：跟随历史路点、以及历史/未记录段先试的新段都用它。即使 Agent 授权了施工，
    // 也不在这类搜索里挖/放/搭柱；只有无施工搜索明确 noPath 后，才按原授权重试同一个目标。
    // 纯步行试探不额外裁剪 searchRadius：已加载区块里明明走得通的绕路，不能因为人为 48 格上限
    // 被报成 noPath，再升级成挖/垫。执行仍受每跳 timeoutMs 和整段 deadline 限制。
    const safeMoveOpts = {
      ...moveOpts, allowTerrainChanges: false, allowPlace: false, allowTower: false, digTool: undefined, searchRadius: undefined,
    };
    const authorizedConstruction = args.allowDig || args.allowPlace || args.allowTower;
    const safeFirst = args.via !== 'direct' && authorizedConstruction;
    /** 只接受库/到达层显式设置的 NoPath 标记；文本 "No path:" 本身不是无路证明。 */
    const noPathError = (e: unknown) => String((e as { name?: unknown } | null)?.name ?? '') === 'NoPath';
    const failedKind = (e: unknown) => {
      const name = String((e as { name?: unknown } | null)?.name ?? '');
      const message = String((e as { message?: unknown } | null)?.message ?? e ?? '');
      return name === 'NoPath' ? 'NO_PATH'
        : name === 'Timeout' || name === 'TimeoutError' ? 'TIMEOUT'
          : name === 'Stuck' ? 'STUCK'
            : /NOT_CONFIRMED|EFFECT_NOT_CONFIRMED/.test(message) ? 'NOT_CONFIRMED' : 'ERROR';
    };
    // via:history / {fragment}：查自己走过的路线，把路点按三维路程间距抽稀。历史只是路点提示，
    // 每跳仍按实测验收；某个路点走不通就放弃剩余历史路点并在回执里列出，不写回记忆。
    // 先查库的拓扑路线；没有时用记录过的路径片段现建路径图（旧 passage 迁移进来只有片段、没有拓扑）。
    const waypoints: Vec3Like[] = [];
    let waypoint = 0;
    let history: Record<string, unknown> | undefined;
    let historyPath: Vec3Like[] = [];
    if (args.via !== 'direct') {
      const goalPoint = { x: target.x, y: target.y ?? start.y, z: target.z };
      let points: Vec3Like[] = [];
      const reasons: string[] = [];
      if (args.via === 'history') {
        const query = ctx.spatial?.query({ kind: 'historyRoute', dim: s0.dim, from: start, to: goalPoint, near: 5 });
        const inspection = query?.status === 'ok' && query.data?.kind === 'historyRoute' ? query.data.inspection : undefined;
        if (inspection?.status === 'FOUND') {
          points = inspection.points;
          historyPath = points;
          const observed = inspection.segments.map((segment) => segment.evidence.observedAt).filter((t): t is number => typeof t === 'number');
          history = { found: true, source: 'topology', points: points.length, ...(observed.length ? { oldestAgeMs: startedAt - Math.min(...observed) } : {}) };
        } else {
          reasons.push(ctx.spatial === undefined ? '没有接线共享空间记忆' : inspection ? `拓扑 ${inspection.status}` : `拓扑查询 ${query?.status ?? '失败'}`);
        }
      }
      if (history === undefined && ctx.spatial !== undefined) {
        const scan = pageFragments(ctx.spatial, { dim: s0.dim, maxFragments: 1000, signal, deadline: Math.min(deadline, Date.now() + 3000) });
        const wanted = typeof args.via === 'object' ? args.via.fragment : null;
        const fragments = wanted === null ? scan.items : scan.items.filter((f) => f.id === wanted);
        if (wanted !== null && fragments.length === 0) {
          return fail('NOT_FOUND', `${s0.dim} 里没有片段 ${wanted}${scan.partial || scan.truncated ? '（片段列表没读全）' : ''}；没有移动`, { originalRequest: request, backend });
        }
        const route = historyRoute(fragments, start, goalPoint, Date.now() + 1500, true);
        // 完整接到目标附近的旧路优先使用；只有 PARTIAL 时，至少要在实际记录路线上把离目标的距离拉近，
        // 否则沿一段反向/原地旧路走只会绕圈。via:history/指定片段是 Agent 明确选择，仍把 PARTIAL 交回实测。
        const startDistance = target.y === undefined
          ? Math.hypot(target.x - start.x, target.z - start.z)
          : Math.hypot(target.x - start.x, target.y - start.y, target.z - start.z);
        const usable = 'points' in route && route.points.length > 1
          && (route.status === 'FOUND' || args.via !== 'auto' || route.endDistance < startDistance - 2);
        if (usable && 'points' in route) {
          points = route.points.map((p) => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }));
          history = {
            found: true, source: 'path_fragments', status: route.status, points: points.length, fragments: route.fragments.slice(0, 8),
            joinsUsed: route.joinsUsed, startSnap: route.startSnap, endDistance: route.endDistance,
            ...(route.recordedOnly === undefined ? {} : { recordedOnly: route.recordedOnly }), ...(route.hypothetical ? { hypothetical: true } : {}),
            ...(route.targetRecorded === undefined ? {} : { targetRecorded: route.targetRecorded }),
            ...(route.connectors.length ? { connectors: route.connectors } : {}),
            ...(route.climbs.length ? { climbs: route.climbs.length, climbHeight: route.climbs.reduce((sum, c) => sum + c.height, 0), firstClimb: route.climbs[0]!.from } : {}),
            ...(scan.partial || scan.truncated ? { fragmentsIncomplete: true } : {}),
          };
        } else {
          reasons.push('points' in route
            ? (route.status === 'FOUND' || args.via !== 'auto' ? '片段：记录路径没有比起点更接近目标的部分' : '片段：记录只到旧路末端，没有把起点接到目标附近')
            : `片段：${route.message}`);
        }
      }
      if (history === undefined) {
        history = { found: false, reason: reasons.join('；') || '没有接线共享空间记忆' };
      } else {
        let last = start, travelled = 0;
        // 必要弯点不能被 8 格抽稀吞掉；最后一点即使只挪了一小段也必须保留，否则会停在线段中间。
        const turnAt = (i: number) => {
          if (i <= 0 || i >= points.length - 1) return false;
          const a = points[i - 1]!, p = points[i]!, n = points[i + 1]!;
          const v1 = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z }, v2 = { x: n.x - p.x, y: n.y - p.y, z: n.z - p.z };
          const d1 = Math.hypot(v1.x, v1.y, v1.z), d2 = Math.hypot(v2.x, v2.y, v2.z);
          if (d1 < 1e-9 || d2 < 1e-9) return false;
          return (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (d1 * d2) < 0.9;
        };
        for (const [i, p] of points.entries()) {
          travelled += Math.hypot(p.x - (points[i - 1] ?? start).x, p.y - (points[i - 1] ?? start).y, p.z - (points[i - 1] ?? start).z);
          const final = i === points.length - 1, corner = turnAt(i);
          const fromLast = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
          if (final ? fromLast >= 0.01 : corner || travelled >= HISTORY_SPACING) {
            if (final || corner || fromLast >= 2) { waypoints.push({ ...p }); last = p; travelled = 0; }
          }
        }
        history.waypoints = waypoints.length;
        historyPath = points;
      }
    }
    const routePoints = [...waypoints];
    let offRoute = 0;
    // 历史路点必须按实际脚格推进：同一格心/同一列、允许半砖/楼梯的合理脚高，但不能用 2–3 格
    // 半径隔墙或隔层跳过拐弯。记录 y 是量化过的整数，不要求身体脚高必须等于整数。
    const atWaypoint = (p: Vec3Like, wp: Vec3Like) =>
      Math.floor(p.x) === Math.floor(wp.x) && Math.floor(p.z) === Math.floor(wp.z)
      && Math.floor(p.y) >= Math.floor(wp.y) && Math.floor(p.y) <= Math.floor(wp.y) + 1;
    const goalFor = (from: Vec3Like, turn: number | null): MoveTarget => {
      const left = Math.hypot(target.x - from.x, target.z - from.z);
      while (waypoint < waypoints.length && atWaypoint(from, waypoints[waypoint]!)) waypoint++;
      const next = turn === null ? waypoints[waypoint] : undefined;
      if (next !== undefined) {
        return { kind: 'xz', x: Math.floor(next.x), z: Math.floor(next.z), range: 0, footY: [Math.floor(next.y), Math.floor(next.y) + 1] };
      }
      if (turn === null && lane !== null) {
        // 正前方一跳按推进找路：够到这一跳的推进量、横向不出 corridor 的任意站位都行，不追射线上的某个点。
        const minAlong = left <= DIRECT_REACH ? lane.distance - args.range : alongOf(from) + HOP;
        return { kind: 'advance', origin: { x: lane.origin.x, z: lane.origin.z }, dir: lane.dir, minAlong, maxLateral: lane.corridor };
      }
      if (turn === null && left <= DIRECT_REACH) {
        return target.y === undefined
          ? { kind: 'xz', x: target.x, z: target.z, range: args.range }
          : { kind: 'near', pos: { x: target.x, y: target.y, z: target.z }, range: args.range };
      }
      const angle = Math.atan2(target.z - from.z, target.x - from.x) + (turn ?? 0) * Math.PI / 180;
      const len = turn === null ? HOP : DETOUR_HOP;
      const x = Math.round(from.x + Math.cos(angle) * len), z = Math.round(from.z + Math.sin(angle) * len);
      if (target.y === undefined) return { kind: 'xz', x, z, range: 3 };
      // 三维目标的中间跳（偏转跳、或目标超出直接寻路范围时）：终点与目标的高差最多比出发时多一次行走下落
      // （WALK_MAX_DROP），否则只按水平坐标找最省的路，会顺着矿道/坡一路下到远离目标高度的地方。
      const allowed = Math.abs(Math.floor(target.y) - Math.floor(from.y)) + WALK_MAX_DROP;
      return { kind: 'xz', x, z, range: 3, footY: [Math.floor(target.y) - allowed, Math.floor(target.y) + allowed] };
    };

    let best = gap(start), staleRounds = 0, hops = 0, failedHops = 0, detours = 0, constructionRetries = 0, lastError = '';
    // 每轮结束时的实测位置：判断是否回到了之前停过的地方（来回打转）。
    const roundEnds: Vec3Like[] = [{ ...start }];
    let revisited: Vec3Like | undefined;
    let stop: 'ARRIVED' | 'NO_ROUTE' | 'VERTICAL_GAP' | 'NO_PROGRESS' | 'HISTORY_STOPPED' | 'NOT_CONFIRMED' | 'STUCK' | 'ERROR' | 'IN_WATER' | 'TIMEOUT' | 'DIMENSION_CHANGED' | 'NOT_ALIVE' = 'TIMEOUT';
    /** TIMEOUT 是整段预算耗尽，还是单跳搜索/执行超时。摘要不能把单跳超时说成等满了整段预算。 */
    let timeoutSource: 'budget' | 'hop' | undefined;
    /** 当前一轮实际失败：主跳原因 + 所有候选（偏转/施工重试）的原因，避免用上一轮旧状态解释。 */
    let primaryFailureKind: string | undefined;
    let roundFailureKinds: string[] = [];
    /** 当前未完成历史路点的最好三维距离：只有路点序号推进或这个距离真的变近才算沿历史有进展。 */
    let waypointBest = waypoints.length ? Math.hypot(waypoints[0]!.x - start.x, waypoints[0]!.y - start.y, waypoints[0]!.z - start.z) : Infinity;
    let historyFailure: { at: Vec3Like; kind: string; message: string } | undefined;
    // 剩余主要是高差：偏转跳只按水平坐标走，绕一圈也不会更接近上下方的目标
    const verticalGap = (p: Vec3Like) => target.y === undefined ? 0 : Math.floor(target.y) - Math.floor(p.y);
    const verticalDominant = (p: Vec3Like) => Math.abs(verticalGap(p)) > VERTICAL_DOMINANT && Math.abs(verticalGap(p)) > 2 * flat(p);
    // 放弃的历史路点之前那段记录里最长的直上直下（同一列连续变高度）：竖井/垂直爬升行走辅助走不了
    let abandonedVertical = 0;
    const verticalRunBefore = (wp: Vec3Like, from: Vec3Like) => {
      const end = historyPath.findIndex((p) => p.x === wp.x && p.y === wp.y && p.z === wp.z);
      const startIdx = historyPath.reduce((best, p, i) => i <= end && Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) < Math.hypot(historyPath[best]!.x - from.x, historyPath[best]!.y - from.y, historyPath[best]!.z - from.z) ? i : best, 0);
      let longest = 0, run = 0;
      for (let i = startIdx + 1; i <= Math.min(end + 1, historyPath.length - 1); i++) {
        const a = historyPath[i - 1]!, b = historyPath[i]!;
        run = Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.z) === Math.floor(b.z) ? run + Math.abs(b.y - a.y) : 0;
        longest = Math.max(longest, run);
      }
      return longest;
    };
    // 没授权下水却进了水（窄堤失足、末段补推等）：立刻停下交回，不再分跳、不再扫视，换气/上岸怎么做由 Agent 定。
    const fellIn = () => !args.allowSwim && !s0.inWater && adapter.state().inWater;
    try {
      for (;;) {
        const s = adapter.state();
        if (!s.alive) { stop = 'NOT_ALIVE'; break; }
        if (s.dim !== s0.dim) { stop = 'DIMENSION_CHANGED'; break; }
        if (fellIn()) { stop = 'IN_WATER'; break; }
        if (arrived(s.pos)) { stop = 'ARRIVED'; break; }
        if (deadline - Date.now() < 1000) { stop = 'TIMEOUT'; timeoutSource = 'budget'; break; }
        ctx.progress(1 - Math.min(1, gap(s.pos) / Math.max(1, gap(start))), `第 ${hops + 1} 跳，剩余约 ${Math.round(gap(s.pos))} 格`);
        // 先走正前方一跳；走不通（没动起来）再依次试偏转跳。任何一跳让身体实际挪动 ≥2 格即进入下一轮。
        let moved = false, alongHistory = false, historyProgress = false, reachedHistoryWaypoint = false;
        primaryFailureKind = undefined;
        roundFailureKinds = [];
        const wpBefore = waypoint;
        for (const turn of [null, ...(verticalDominant(s.pos) ? [] : DETOURS)]) {
          const before = { ...adapter.state().pos };
          const goal = goalFor(before, turn);
          const followHistory = turn === null && waypoint < waypoints.length;
          const targetWaypoint = followHistory ? waypoints[waypoint] : undefined;
          // 跟随历史路点：无论原请求是否授权施工，都只用纯步行搜索。新段/偏转只有在原来的施工授权下
          // 才先试纯步行、明确 noPath 后再按原授权重试；via:direct 不遮挡显式授权。
          const attempts = followHistory ? [safeMoveOpts] : safeFirst ? [safeMoveOpts, moveOpts] : [moveOpts];
          let hopError: unknown;
          for (const [i, attemptOpts] of attempts.entries()) {
            try {
              await adapter.moveTo(goal, { ...attemptOpts, timeoutMs: Math.max(1000, Math.min(30000, deadline - Date.now())) });
              hopError = undefined;
            } catch (e) {
              if (isAbort(e)) throw e;
              hopError = e;
              failedHops++;
              const kind = failedKind(e);
              roundFailureKinds.push(kind);
              if (turn === null) primaryFailureKind = kind;
              lastError = e instanceof Error ? e.message : String(e);
            }
            hops++;
            if (i > 0) constructionRetries++;
            record();
            // 只有明确 noPath 才能打开下一次（已授权施工）尝试；timeout/卡住/NOT_CONFIRMED/取消不升级。
            if (!hopError || i === attempts.length - 1 || !noPathError(hopError)) break;
          }
          if (followHistory && hopError) {
            historyFailure = { at: { ...waypoints[waypoint]! }, kind: failedKind(hopError), message: lastError || String(hopError) };
            abandonedVertical = verticalRunBefore(waypoints[waypoint]!, adapter.state().pos);
          }
          if (turn !== null) detours++;
          const after = adapter.state().pos;
          if (routePoints.length) offRoute = Math.max(offRoute, Math.min(...routePoints.map((p) => Math.hypot(p.x - after.x, p.y - after.y, p.z - after.z))));
          // 到达一个历史路点本身就是进展，即使这一步只挪了 1 格（拐角/楼梯常见）；不能按 ≥2 格误判没动。
          reachedHistoryWaypoint = !!targetWaypoint && !hopError && atWaypoint(after, targetWaypoint);
          if (reachedHistoryWaypoint || Math.hypot(after.x - before.x, after.z - before.z) >= 2 || Math.abs(after.y - before.y) >= 2 || arrived(after)) {
            moved = true; alongHistory = followHistory; break;
          }
          // 朝历史路点的一跳没走通：停在实测进度并报这个路点，不丢下剩余路点改挖新通道。
          if (followHistory) {
            if (!historyFailure) {
              historyFailure = { at: { ...waypoints[waypoint]! }, kind: 'NO_PROGRESS', message: lastError || '朝这个历史路点的一跳没有让身体前进' };
              abandonedVertical = verticalRunBefore(waypoints[waypoint]!, adapter.state().pos);
            }
            stop = 'HISTORY_STOPPED';
            break;
          }
          if (deadline - Date.now() < 1000 || !adapter.state().alive || fellIn()) break;
        }
        if (fellIn()) { stop = 'IN_WATER'; break; }
        if (stop === 'HISTORY_STOPPED') break;
        const now = gap(adapter.state().pos);
        if (!moved) {
          // 实际失败原因优先：只要有一路搜索没完成（超时/未确认/停滞/未知错误），就不能把整轮说成“无路”。
          const incomplete = (['TIMEOUT', 'NOT_CONFIRMED', 'STUCK', 'ERROR'] as const).find((kind) => roundFailureKinds.includes(kind));
          const budgetDone = deadline - Date.now() < 1000;
          if (budgetDone) timeoutSource = 'budget';
          else if (incomplete === 'TIMEOUT') timeoutSource = 'hop';
          stop = budgetDone ? 'TIMEOUT'
            : incomplete === 'TIMEOUT' ? 'TIMEOUT'
              : incomplete === 'NOT_CONFIRMED' ? 'NOT_CONFIRMED'
                : incomplete === 'STUCK' ? 'STUCK'
                  : incomplete === 'ERROR' ? 'ERROR'
                    : verticalDominant(adapter.state().pos) ? 'VERTICAL_GAP' : 'NO_ROUTE';
          if (arrived(adapter.state().pos)) stop = 'ARRIVED';
          break;
        }
        // 沿历史路点前进时离目标可能先变远（历史路线本来会绕）：只有路点序号推进、或当前路点的
        // 实测最好三维距离变近才算进展。同一个未到路点下来回走不能一直豁免。
        const here = adapter.state().pos;
        // 真实到达当前历史脚格就立即推进；连续 1 格拐点/楼梯也算明确进展，不能等下一轮再推进。
        if (reachedHistoryWaypoint) waypoint = Math.min(waypoints.length, waypoint + 1);
        if (alongHistory) {
          if (waypoint > wpBefore) {
            historyProgress = true;
            const wp = waypoints[waypoint];
            waypointBest = wp ? Math.hypot(wp.x - here.x, wp.y - here.y, wp.z - here.z) : Infinity;
          } else {
            const wp = waypoints[waypoint];
            if (wp) {
              const d = Math.hypot(wp.x - here.x, wp.y - here.y, wp.z - here.z);
              if (d < waypointBest - 1) { historyProgress = true; waypointBest = d; }
            }
          }
        }
        const back = roundEnds.find((p) => Math.hypot(p.x - here.x, p.y - here.y, p.z - here.z) <= REVISIT_RADIUS);
        roundEnds.push({ ...here });
        if (now < best - 1) { best = now; staleRounds = 0; }
        else if (historyProgress) staleRounds = 0;
        else if (back) { revisited = { x: Math.floor(back.x), y: Math.floor(back.y), z: Math.floor(back.z) }; stop = arrived(here) ? 'ARRIVED' : 'NO_PROGRESS'; break; }
        else if (++staleRounds >= MAX_STALE_ROUNDS) { stop = arrived(here) ? 'ARRIVED' : 'NO_PROGRESS'; break; }
        if (historyFailure) { stop = arrived(here) ? 'ARRIVED' : 'HISTORY_STOPPED'; break; }
      }
    } catch (e) {
      if (isAbort(e)) throw cancelledNav(e, { backend, originalRequest: request, resolvedTarget, position: trace.at(-1) ?? null, trace });
      throw e;
    }

    const end = { ...adapter.state().pos };
    // 副作用只列本次委托期间身体实际挖掉/放下的方块（含位置），不列规划路径。
    const dug = (adapter.recentDug?.(startedAt - 1) ?? []).map((d) => ({ pos: { ...d.pos }, name: d.name }));
    const placed = (adapter.recentPlaced?.(startedAt - 1) ?? []).map((d) => ({ pos: { ...d.pos }, name: d.name, status: d.status }));
    const displacement = { horizontal: round1(Math.hypot(end.x - start.x, end.z - start.z)), vertical: round1(end.y - start.y) };
    const remaining = { horizontal: round1(flat(end)), ...(target.y === undefined ? {} : { vertical: Math.floor(target.y) - Math.floor(end.y) }) };
    const closer = round1(gap(start) - gap(end));
    const elapsedRealS = Math.round((Date.now() - startedAt) / 1000);
    const facts = {
      target: resolvedTarget, label: target.label, stopReason: stop, arrived: stop === 'ARRIVED',
      displacement, remaining, closer, hops, failedHops, detours, constructionRetries, elapsedRealS,
      ...(timeoutSource ? { timeoutSource } : {}),
      ...(primaryFailureKind ? { primaryFailureKind } : {}),
      ...(roundFailureKinds.length ? { candidateFailureKinds: [...new Set(roundFailureKinds)] } : {}),
      ...(revisited ? { revisited } : {}),
      newChunks: ctx.memory.visitedChunkCount - startChunks,
      authorized: { allowDig: args.allowDig, allowPlace: args.allowPlace, allowTower: args.allowTower, allowSwim: args.allowSwim, allowHazard: args.allowHazard, sprint: args.sprint },
      avoided: avoid,
      sideEffects: { dug: dug.slice(0, 24), dugCount: dug.length, placed: placed.slice(0, 24), placedCount: placed.length },
      ...(history === undefined ? {} : {
        history: { ...history, reached: Math.min(waypoint, routePoints.length), offRoute: round1(offRoute),
          ...(historyFailure === undefined ? {} : { failedAt: historyFailure.at, failedKind: historyFailure.kind, failedMessage: historyFailure.message.slice(0, 200),
            ...(abandonedVertical > WALK_MAX_DROP ? { verticalRun: abandonedVertical } : {}) }) },
      }),
      ...(lastError ? { lastError: lastError.slice(0, 200) } : {}),
    };
    const effects = dug.length || placed.length ? `；挖掉 ${dug.length} 块、放下 ${placed.length} 块（见 sideEffects）` : '';
    const historyNote = history === undefined ? ''
      : history.found !== true ? `；没有可用的历史路线（${String(history.reason)}），按直线分跳`
        : `；按${history.source === 'path_fragments' ? `记录过的路径片段（${(history.fragments as string[]).length} 条${history.status === 'PARTIAL' ? `，记录只到离目标 ${String(history.endDistance)} 格处${history.targetRecorded === false ? '，最后一段未记录' : ''}` : ''}${history.hypothetical ? '；其中含未验证的 26 邻接/跨片连接' : ''}）` : '历史路线'}走到 ${Math.min(waypoint, routePoints.length)}/${routePoints.length} 个路点、最大偏离 ${round1(offRoute)} 格${typeof history.climbs === 'number' ? `；这条记录里有 ${history.climbs} 处当初是掉下来的（共 ${String(history.climbHeight)} 格，第一处从 ${at(history.firstClimb as Vec3Like)} 往上），原路返回要爬升这些高度，行走辅助不挖不搭柱时上不去` : ''}${historyFailure === undefined ? '' : `，历史路点 ${at(historyFailure.at)} 没走通（${historyFailure.kind}：${historyFailure.message.slice(0, 120)}），停在实测位置，没有丢下剩余路点改挖新通道；要换方法可用 via:"direct" 显式按当前授权直接寻路${abandonedVertical > WALK_MAX_DROP ? `（记录里到这个路点前有 ${abandonedVertical} 格直上直下的竖直段，像竖井；行走辅助一次最多下落 ${WALK_MAX_DROP} 格、不挖不搭柱时不走这种段）` : ''}`}`;
    const measured = `实测 ${at(end)}，水平位移 ${displacement.horizontal} 格、垂直 ${displacement.vertical} 格，${hops} 跳`;
    const outcome: NavOutcome = stop === 'ARRIVED' ? 'ARRIVED' : stop === 'TIMEOUT' ? 'TIMEOUT' : closer >= 2 ? 'PARTIAL'
      : stop === 'NO_ROUTE' || stop === 'VERTICAL_GAP' || (stop === 'HISTORY_STOPPED' && historyFailure?.kind === 'NO_PATH') ? 'NO_PATH'
        : stop === 'NO_PROGRESS' || stop === 'STUCK' || (stop === 'HISTORY_STOPPED' && historyFailure?.kind !== 'ERROR' && historyFailure?.kind !== 'TIMEOUT' && historyFailure?.kind !== 'NOT_CONFIRMED') ? 'BLOCKED'
          : 'FAILED';
    const arrival = {
      mode: 'near_radius', required: { radius: args.range, metric: target.y === undefined ? 'horizontal' : '3d' },
      measured: { position: end, distance: round1(gap(end)) }, satisfied: stop === 'ARRIVED',
    };
    const receipt = (r: SkillResult) => navReceipt(r, { backend, originalRequest: request, resolvedTarget, outcome, position: end, trace, arrival });
    if (stop === 'ARRIVED') return receipt(ok(`到了 ${target.label} 附近：${measured}${effects}${historyNote}`, facts));
    const why = {
      NO_ROUTE: `辅助在已加载区块里没找到能让身体前进的下一跳（正前方与偏转都试过${hopBudget ? `；每跳只接受代价不超过直线约 +${HOP_SEARCH_RADIUS} 的路线，更远的绕行没有尝试` : ''}）`,
      VERTICAL_GAP: `目标在${verticalGap(end) < 0 ? '下' : '上'}方 ${Math.abs(verticalGap(end))} 格、水平只差 ${round1(flat(end))} 格，辅助找不到${verticalGap(end) < 0 ? '下行' : '上行'}的路；水平偏转绕行帮不上高差，没有再绕（行走辅助一次最多下落 ${WALK_MAX_DROP} 格${args.allowDig ? '' : '，没授权挖'}${args.allowTower ? '' : '、没授权搭柱'}）`,
      NO_PROGRESS: revisited ? `绕了一圈又回到之前到过的 (${revisited.x},${revisited.y},${revisited.z}) 附近，没有更接近目标，不再来回绕` : `连续 ${MAX_STALE_ROUNDS} 轮没有更接近目标`,
      HISTORY_STOPPED: historyFailure ? `历史路点 ${at(historyFailure.at)} 没走通（${historyFailure.kind}：${historyFailure.message.slice(0, 120)}），没有丢下剩余路点改挖新通道` : '历史路点没走通，没有改挖新通道',
      NOT_CONFIRMED: `寻路结束但没有确认到达${lastError ? `（${lastError.slice(0, 160)}）` : ''}；不是 noPath，没有升级施工`,
      STUCK: `寻路执行停滞/调整不动${lastError ? `（${lastError.slice(0, 160)}）` : ''}；不是 noPath，没有升级施工`,
      ERROR: `寻路报错但没有明确的 NoPath 标记${lastError ? `（${lastError.slice(0, 160)}）` : ''}；没有升级施工`,
      TIMEOUT: timeoutSource === 'hop'
        ? `单跳寻路/执行超时，实际已进行 ${elapsedRealS} 秒（请求的整段上限 ${Math.round(args.timeoutMs / 1000)} 秒未被证实用完）${lastError ? `；最近错误：${lastError.slice(0, 160)}` : ''}`
        : `整体移动预算到点，实际已进行 ${elapsedRealS} 秒（请求上限 ${Math.round(args.timeoutMs / 1000)} 秒）${lastError ? `；最近错误：${lastError.slice(0, 160)}` : ''}`,
      DIMENSION_CHANGED: `途中离开了 ${s0.dim}`,
      NOT_ALIVE: '途中死亡',
      IN_WATER: `没授权下水（allowSwim:false）却进了水，已停下，氧气 ${adapter.state().oxygen}/20；换气、上岸怎么做由你定`,
    }[stop];
    const historyCode = historyFailure?.kind === 'NO_PATH' ? 'PATH_NOT_FOUND'
      : historyFailure?.kind === 'TIMEOUT' ? 'TIMEOUT'
        : historyFailure?.kind === 'NOT_CONFIRMED' ? 'EFFECT_NOT_CONFIRMED'
          : historyFailure?.kind === 'STUCK' || historyFailure?.kind === 'NO_PROGRESS' ? 'STUCK' : 'ERROR';
    const code = stop === 'TIMEOUT' ? 'TIMEOUT' : stop === 'HISTORY_STOPPED' ? historyCode
      : stop === 'NOT_CONFIRMED' ? 'EFFECT_NOT_CONFIRMED' : stop === 'STUCK' ? 'STUCK' : stop === 'ERROR' ? 'ERROR'
        : stop === 'NO_ROUTE' || stop === 'VERTICAL_GAP' ? 'PATH_NOT_FOUND' : stop === 'NO_PROGRESS' || stop === 'IN_WATER' ? 'STUCK' : stop === 'DIMENSION_CHANGED' ? 'WRONG_DIMENSION' : 'ERROR';
    const permissions = `当前授权 allowDig:${args.allowDig} allowPlace:${args.allowPlace} allowSwim:${args.allowSwim}`;
    // 直走没到：查一下记录里有没有从现在位置附近通往目标附近的走过的路，只作为事实回报，换不换走法由 Agent 定。
    let recordedNote = '';
    if (args.via === 'direct' && ctx.spatial !== undefined && stop !== 'NOT_ALIVE' && stop !== 'DIMENSION_CHANGED') {
      const scan = pageFragments(ctx.spatial, { dim: s0.dim, maxFragments: 1000, signal, deadline: Date.now() + 1500 });
      const route = historyRoute(scan.items, end, { x: target.x, y: target.y ?? end.y, z: target.z }, Date.now() + 1000);
      if ('points' in route && route.points.length > 1) {
        const climbHeight = route.climbs.reduce((sum, c) => sum + c.height, 0);
        const recorded = { fragments: route.fragments.slice(0, 8), points: route.points.length, endDistance: route.endDistance, status: route.status, ...(climbHeight ? { climbs: route.climbs.length, climbHeight } : {}) };
        Object.assign(facts, { recordedRoute: recorded });
        recordedNote = `；记录里有从你附近${route.startSnap > 2 ? `（离最近的记录格约 ${Math.round(route.startSnap)} 格）` : ''}出发、沿自己走过的路（片段 ${recorded.fragments.join('、')}，${recorded.points} 格${route.connectors.length ? `，中间 ${route.connectors.length} 处要跨过两片记录之间的空当` : ''}）${route.status === 'PARTIAL' ? `到离目标 ${route.endDistance} 格处` : '到目标附近'}的连续路径，via:"history" 会沿它走（历史记录，现在是否还通未确认）${climbHeight ? `；其中 ${route.climbs.length} 处当初是掉下来的，沿它返回要爬升共 ${climbHeight} 格` : ''}`;
      }
    }
    return receipt(fail(code, `没到 ${target.label}：${why}；${measured}，比出发时近 ${closer} 格，剩余水平 ${remaining.horizontal} 格${effects}${historyNote}${recordedNote}。${permissions}；这只说明辅助走不通，不描述没看见的地形，下一步由你决定`, facts));
  },
};

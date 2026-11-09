import type { Vec3Like } from '../../adapter/types.ts';
import { DIRS } from '../../perception/perception.ts';
import { lookAround } from '../movement.ts';
import { fail, isAbort, obj, ok, type Skill, type SkillResult } from '../types.ts';
import { travelTo } from './travel-to.ts';

type Heading = keyof typeof DIRS;
type ExploreArgs = {
  direction: Heading;
  distance: number;
  origin: Vec3Like;
  until?: string;
  segment: number;
  /** 横向偏离冻结射线超过这么多格就停（格）。 */
  maxLateralDrift: number;
  allowDig: boolean;
  allowPlace: boolean;
  allowSwim: boolean;
  allowHazard: boolean;
  sprint: boolean;
  timeoutMs: number;
};

/** 单次探索的方向距离上限（格）；更远由 Agent 分次续走。 */
export const MAX_EXPLORE_DISTANCE = 512;
/** 每段交给 travel_to 的到达半径（格）；走完全程的判定与它一致，否则每段都“到了”却永远差几格算不上走完。 */
const SEGMENT_RANGE = 3;
/** 连续这么多段没走到段终点、或沿方向推进不足 2 格就停（没挪动，或只是横着/往回走），不在原地或侧向反复试。 */
const MAX_STUCK_SEGMENTS = 2;

const round1 = (v: number) => Math.round(v * 10) / 10;
const at = (p: Vec3Like) => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;

/**
 * Agent 指定方向的远距离探索：沿冻结的方向射线，每段 ≤segment 格交给 travel_to（pathfinder，已加载区块），
 * 每段结束朝该方向扫视一次（look_around），可选 until 看见某物就停。方向、距离、何时继续都由 Agent 决定；
 * 这里不打分、不换方向、不推荐 frontier，只报实测位置、新区块、每段停止原因与扫视结果。
 */
export const exploreToward: Skill<ExploreArgs> = {
  name: 'explore_toward',
  description: '朝你选的方向走远路探索（后端 pathfinder，已加载区块）：沿冻结方向每段 ≤32 格交给 travel_to 走，每段结束朝该方向扫视一次；until 写方块/生物名、类别（log、stem）或 "a|b" 时，本次视野看见其中之一就停。不换方向、不替你选路线；某段走不通会先在附近偏转绕行，连续 2 段没走到段终点、沿方向推进不足 2 格或横向偏离超过 maxLateralDrift 就停，回执报实测沿方向进度、横向偏离、新区块数、每段停止原因。默认不下水、不挖不放不搭柱（allowSwim:true 才走水路）；施工授权与副作用同 travel_to。',
  argsDoc: '{"direction":"N|NE|E|SE|S|SW|W|NW", "distance":16-512, "until"?:"log"（看见就停；类别 log=各种原木、stem=菌柄，或 "crimson_stem|warped_stem" 列几种；写具体名如 oak_log 就只认这一种）, "segment"?:16-48（默认 32）, "maxLateralDrift"?:16（4-64，横向偏离超过就停）, "allowSwim"?:false（true 才下水；水里有溺水与溺尸风险）, "allowDig"?:false, "allowPlace"?:false, "allowHazard"?:false, "sprint"?:false, "timeoutMs"?:300000（30000-600000）}',
  timeoutMs: 600000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const direction = String(a.direction ?? '').toUpperCase();
    if (!Object.hasOwn(DIRS, direction)) return { ok: false, error: 'direction 只能是 N/NE/E/SE/S/SW/W/NW' };
    if (!Number.isInteger(a.distance) || a.distance < 16 || a.distance > MAX_EXPLORE_DISTANCE) {
      return { ok: false, error: `distance 需要 16–${MAX_EXPLORE_DISTANCE} 的整数格数；原目标不会被缩短，更远请分次续走` };
    }
    if (a.until !== undefined && (typeof a.until !== 'string' || !a.until.trim() || a.until.length > 40)) return { ok: false, error: 'until 需要方块/生物名、类别（log、stem）或 "a|b"（≤40 字）' };
    if (a.segment !== undefined && (!Number.isInteger(a.segment) || a.segment < 16 || a.segment > 48)) return { ok: false, error: 'segment 需要 16–48 的整数' };
    if (a.maxLateralDrift !== undefined && (!Number.isInteger(a.maxLateralDrift) || a.maxLateralDrift < 4 || a.maxLateralDrift > 64)) return { ok: false, error: 'maxLateralDrift 需要 4–64 的整数' };
    if (a.timeoutMs !== undefined && (!Number.isInteger(a.timeoutMs) || a.timeoutMs < 30000 || a.timeoutMs > 600000)) return { ok: false, error: 'timeoutMs 需要 30000–600000 的整数' };
    for (const flag of ['allowDig', 'allowPlace', 'allowSwim', 'allowHazard', 'sprint'] as const) {
      if (a[flag] !== undefined && typeof a[flag] !== 'boolean') return { ok: false, error: `${flag} 需要布尔值` };
    }
    // 首次校验冻结起点；续接/重试沿用同一条射线，不按新位置重新解释方向。
    const o = obj(a.origin);
    if (a.origin !== undefined && ![o.x, o.y, o.z].every((n) => typeof n === 'number' && Number.isFinite(n))) return { ok: false, error: 'origin 需要 {x,y,z} 有限数字' };
    const origin = a.origin === undefined ? { ...adapter.state().pos } : { x: o.x as number, y: o.y as number, z: o.z as number };
    return {
      ok: true,
      args: {
        direction: direction as Heading, distance: a.distance, origin,
        ...(typeof a.until === 'string' ? { until: a.until.trim().toLowerCase() } : {}),
        segment: a.segment ?? 32, maxLateralDrift: a.maxLateralDrift ?? 16,
        allowDig: a.allowDig === true, allowPlace: a.allowPlace === true, allowSwim: a.allowSwim === true,
        allowHazard: a.allowHazard === true, sprint: a.sprint === true, timeoutMs: a.timeoutMs ?? 300000,
      },
    };
  },
  async run(ctx, args) {
    const { adapter } = ctx;
    const s0 = adapter.state();
    const backend = 'pathfinder';
    const [bx, bz] = DIRS[args.direction];
    const norm = Math.hypot(bx, bz);
    const ux = bx / norm, uz = bz / norm;
    const project = (p: Vec3Like) => {
      const dx = p.x - args.origin.x, dz = p.z - args.origin.z;
      return { along: round1(dx * ux + dz * uz), lateral: round1(dx * -uz + dz * ux) };
    };
    const startedAt = Date.now();
    const deadline = Math.min(ctx.deadline, startedAt + args.timeoutMs);
    const startChunks = ctx.memory.visitedChunkCount;
    const segments: { target: { x: number; z: number }; stopReason: string; end: Vec3Like; closer: number }[] = [];
    let stuck = 0, bestAlong = project(s0.pos).along;
    let stop: 'DISTANCE_MET' | 'UNTIL_SEEN' | 'BLOCKED' | 'NO_ALONG_PROGRESS' | 'LATERAL_DRIFT' | 'IN_WATER' | 'TIMEOUT' | 'DIMENSION_CHANGED' | 'NOT_ALIVE' = 'TIMEOUT';
    let sighting: Record<string, unknown> | undefined;
    let lastFailure: SkillResult | undefined;
    const factsNow = () => {
      const end = { ...adapter.state().pos }, progress = project(end);
      return {
        end, progress,
        measured: `实测 ${at(end)}，沿 ${args.direction} 推进 ${progress.along}/${args.distance} 格、横向偏离 ${progress.lateral} 格，${segments.length} 段，新进入 ${ctx.memory.visitedChunkCount - startChunks} 个区块`,
      };
    };

    try {
      for (;;) {
        const s = adapter.state();
        if (!s.alive) { stop = 'NOT_ALIVE'; break; }
        if (s.dim !== s0.dim) { stop = 'DIMENSION_CHANGED'; break; }
        const { along } = project(s.pos);
        if (along >= args.distance - SEGMENT_RANGE) { stop = 'DISTANCE_MET'; break; }
        const left = deadline - Date.now();
        if (left < 10000) { stop = 'TIMEOUT'; break; }
        ctx.progress(Math.max(0, along) / args.distance, `往 ${args.direction} 已推进 ${Math.round(along)}/${args.distance} 格`);
        // 下一段终点在冻结射线上，从实测沿方向进度往前一段；中途绕行由 travel_to 处理。
        const reach = Math.min(args.distance, Math.max(0, along) + args.segment);
        const target = { x: Math.round(args.origin.x + ux * reach), z: Math.round(args.origin.z + uz * reach) };
        const parsed = travelTo.validate({
          to: target, range: SEGMENT_RANGE, allowDig: args.allowDig, allowPlace: args.allowPlace, allowSwim: args.allowSwim,
          allowHazard: args.allowHazard, sprint: args.sprint, timeoutMs: Math.min(120000, left),
        }, adapter);
        if (!parsed.ok) return fail('BAD_ARGS', `内部分段参数无效：${parsed.error}；没有移动`, { backend });
        const segStart = { ...adapter.state().pos };
        const hop = await travelTo.run(ctx, parsed.args);
        const end = { ...adapter.state().pos };
        const hopStop = String(hop.data?.stopReason ?? hop.status);
        const closer = Number(hop.data?.closer ?? 0);
        segments.push({ target, stopReason: hopStop, end, closer });
        if (hopStop === 'NOT_ALIVE' || hopStop === 'DIMENSION_CHANGED' || hopStop === 'IN_WATER') { stop = hopStop; break; }
        if (hop.status !== 'succeeded') lastFailure = hop;
        // 每段结束朝探索方向扫视一次：新看到的地形同时进入空间记忆；until 只认本次视野里看见的。
        const glance = await lookAround.run(ctx, { seconds: 2, direction: args.direction, ...(args.until ? { for: args.until } : {}) });
        if (args.until && glance.status === 'succeeded') { stop = 'UNTIL_SEEN'; sighting = glance.data; break; }
        // 最后一段的目标就是全程终点：travel_to 按同一到达半径确认到了，就是走完全程。
        if (reach >= args.distance && hop.status === 'succeeded') { stop = 'DISTANCE_MET'; break; }
        if (hopStop === 'TIMEOUT' && deadline - Date.now() < 10000) { stop = 'TIMEOUT'; break; }
        // 进展按沿冻结方向的实测推进算：横着走或往回绕不算前进（下界岩洞里 pathfinder 可能绕出反方向的路）。
        const now = project(end);
        if (Math.abs(now.lateral) > args.maxLateralDrift) { stop = 'LATERAL_DRIFT'; break; }
        const gained = now.along >= bestAlong + 2;
        if (gained) bestAlong = now.along;
        // 这一段 travel_to 没走到段终点（正前方与偏转都试过）也算卡住，哪怕顺带往前蹭了几格：
        // 实机下界两段都 NO_PROGRESS、各往前蹭 9 格和 3 格，按“推进 ≥2 格”一直不停，在原地附近绕圈。
        if (gained && hop.status === 'succeeded') stuck = 0;
        // travel_to 报回到了之前到过的位置：身体在动、只是来回绕，起止点重合也不算「没挪动」。
        else if (++stuck >= MAX_STUCK_SEGMENTS) { stop = Math.hypot(end.x - segStart.x, end.z - segStart.z) >= 2 || hop.data?.revisited ? 'NO_ALONG_PROGRESS' : 'BLOCKED'; break; }
      }
    } catch (e) {
      // 被打断（挨打、改主意、操作者指令）时也把已走出的事实交回去：取消回执里能看到推进与偏离。
      if (isAbort(e)) {
        const { end, progress, measured } = factsNow();
        const target = e as Error & { partial?: Record<string, unknown> };
        target.partial = { ...(target.partial ?? {}), backend, direction: args.direction, distance: args.distance, origin: args.origin,
          progress, position: end, segments: segments.slice(-24), segmentCount: segments.length,
          continuation: { direction: args.direction, distance: args.distance, origin: args.origin },
          progressNote: `explore_toward 被打断时${measured}` };
      }
      throw e;
    }

    const { end, progress, measured } = factsNow();
    const dug = adapter.recentDug?.(startedAt - 1) ?? [];
    const placed = adapter.recentPlaced?.(startedAt - 1) ?? [];
    const facts = {
      backend, direction: args.direction, distance: args.distance, origin: args.origin, stopReason: stop,
      progress: { ...progress, remaining: round1(Math.max(0, args.distance - progress.along)) },
      position: end, newChunks: ctx.memory.visitedChunkCount - startChunks, visitedChunks: ctx.memory.visitedChunkCount,
      segments: segments.slice(-24), segmentCount: segments.length,
      ...(args.until ? { until: { seen: args.until, found: stop === 'UNTIL_SEEN' }, ...(sighting ? { sighting } : {}) } : {}),
      sideEffects: { dugCount: dug.length, placedCount: placed.length },
      // 续走同一条射线：把这些参数原样再给一次（origin 冻结，不按新位置重新解释方向）。
      continuation: { direction: args.direction, distance: args.distance, origin: args.origin },
    };
    const effects = dug.length || placed.length ? `；挖掉 ${dug.length} 块、放下 ${placed.length} 块` : '';
    if (stop === 'DISTANCE_MET') return ok(`往 ${args.direction} 走完 ${args.distance} 格：${measured}${effects}${args.until ? `；途中扫视没看见 ${args.until}（只覆盖每段的当前视野）` : ''}`, facts);
    if (stop === 'UNTIL_SEEN') return ok(`往 ${args.direction} 探索途中看见 ${args.until}：${measured}${effects}；看见的位置见 sighting`, facts);
    const why = {
      BLOCKED: `连续 ${MAX_STUCK_SEGMENTS} 段几乎没挪动（最后一段：${lastFailure?.summary.slice(0, 160) ?? '无'}）`,
      NO_ALONG_PROGRESS: `连续 ${MAX_STUCK_SEGMENTS} 段没走到段终点或沿 ${args.direction} 推进不足 2 格（身体在动，寻路在附近横着/往回绕；正前方与偏转都没走通）`,
      LATERAL_DRIFT: `横向偏离冻结方向超过 ${args.maxLateralDrift} 格（绕路太远；maxLateralDrift 可放宽到 64）`,
      TIMEOUT: `用完 ${Math.round(args.timeoutMs / 1000)} 秒时限`,
      DIMENSION_CHANGED: `途中离开了 ${s0.dim}`,
      NOT_ALIVE: '途中死亡',
      IN_WATER: `没授权下水却进了水，已停下（没有再走、没有扫视），氧气 ${adapter.state().oxygen}/20；换气、上岸怎么做由你定`,
    }[stop];
    const code = stop === 'TIMEOUT' ? 'TIMEOUT' : stop === 'BLOCKED' || stop === 'NO_ALONG_PROGRESS' || stop === 'LATERAL_DRIFT' || stop === 'IN_WATER' ? 'STUCK' : stop === 'DIMENSION_CHANGED' ? 'WRONG_DIMENSION' : 'ERROR';
    // 授权是 Agent 给的：说清这次有没有允许挖、放（搭桥/垫脚要 allowPlace）、下水，换不换手段由它定。
    const permissions = `当前授权 allowDig:${args.allowDig} allowPlace:${args.allowPlace}（搭桥/垫脚需要它） allowSwim:${args.allowSwim}`;
    return fail(code, `往 ${args.direction} 探索停下：${why}；${measured}${effects}。${permissions}；这只说明辅助走不通，不描述没看见的地形；继续、换方向或换手段由你决定`, facts);
  },
};

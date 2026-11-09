import type { Vec3Like } from '../../adapter/types.ts';
import { DIRS } from '../../perception/perception.ts';
import { lookAround } from '../movement.ts';
import { fail, obj, ok, type Skill, type SkillResult } from '../types.ts';
import { travelTo } from './travel-to.ts';

type Heading = keyof typeof DIRS;
type ExploreArgs = {
  direction: Heading;
  distance: number;
  origin: Vec3Like;
  until?: string;
  segment: number;
  allowDig: boolean;
  allowPlace: boolean;
  allowSwim: boolean;
  allowHazard: boolean;
  sprint: boolean;
  timeoutMs: number;
};

/** 单次探索的方向距离上限（格）；更远由 Agent 分次续走。 */
export const MAX_EXPLORE_DISTANCE = 512;
/** 连续这么多段几乎没挪动就停，不在原地反复试。 */
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
  description: '朝你选的方向走远路探索（后端 pathfinder，已加载区块）：沿冻结方向每段 ≤32 格交给 travel_to 走，每段结束朝该方向扫视一次；until 写方块或生物名时，本次视野看见就停。不换方向、不替你选路线；某段走不通会先在附近偏转绕行，连续 2 段几乎没挪动就停，回执报实测沿方向进度、横向偏离、新区块数、每段停止原因。默认不下水、不挖不放不搭柱（allowSwim:true 才走水路）；施工授权与副作用同 travel_to。',
  argsDoc: '{"direction":"N|NE|E|SE|S|SW|W|NW", "distance":16-512, "until"?:"<方块或生物名，看见就停>", "segment"?:16-48（默认 32）, "allowSwim"?:false（true 才下水；水里有溺水与溺尸风险）, "allowDig"?:false, "allowPlace"?:false, "allowHazard"?:false, "sprint"?:false, "timeoutMs"?:300000（30000-600000）}',
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
    if (a.until !== undefined && (typeof a.until !== 'string' || !a.until.trim() || a.until.length > 40)) return { ok: false, error: 'until 需要一个方块或生物名（≤40 字）' };
    if (a.segment !== undefined && (!Number.isInteger(a.segment) || a.segment < 16 || a.segment > 48)) return { ok: false, error: 'segment 需要 16–48 的整数' };
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
        segment: a.segment ?? 32,
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
    let stuck = 0;
    let stop: 'DISTANCE_MET' | 'UNTIL_SEEN' | 'BLOCKED' | 'TIMEOUT' | 'DIMENSION_CHANGED' | 'NOT_ALIVE' = 'TIMEOUT';
    let sighting: Record<string, unknown> | undefined;
    let lastFailure: SkillResult | undefined;

    for (;;) {
      const s = adapter.state();
      if (!s.alive) { stop = 'NOT_ALIVE'; break; }
      if (s.dim !== s0.dim) { stop = 'DIMENSION_CHANGED'; break; }
      const { along } = project(s.pos);
      if (along >= args.distance - 2) { stop = 'DISTANCE_MET'; break; }
      const left = deadline - Date.now();
      if (left < 10000) { stop = 'TIMEOUT'; break; }
      ctx.progress(Math.max(0, along) / args.distance, `往 ${args.direction} 已推进 ${Math.round(along)}/${args.distance} 格`);
      // 下一段终点在冻结射线上，从实测沿方向进度往前一段；中途绕行由 travel_to 处理。
      const reach = Math.min(args.distance, Math.max(0, along) + args.segment);
      const target = { x: Math.round(args.origin.x + ux * reach), z: Math.round(args.origin.z + uz * reach) };
      const parsed = travelTo.validate({
        to: target, range: 3, allowDig: args.allowDig, allowPlace: args.allowPlace, allowSwim: args.allowSwim,
        allowHazard: args.allowHazard, sprint: args.sprint, timeoutMs: Math.min(120000, left),
      }, adapter);
      if (!parsed.ok) return fail('BAD_ARGS', `内部分段参数无效：${parsed.error}；没有移动`, { backend });
      const hop = await travelTo.run(ctx, parsed.args);
      const end = { ...adapter.state().pos };
      const hopStop = String(hop.data?.stopReason ?? hop.status);
      const closer = Number(hop.data?.closer ?? 0);
      segments.push({ target, stopReason: hopStop, end, closer });
      if (hopStop === 'NOT_ALIVE' || hopStop === 'DIMENSION_CHANGED') { stop = hopStop; break; }
      if (hop.status !== 'succeeded') lastFailure = hop;
      // 每段结束朝探索方向扫视一次：新看到的地形同时进入空间记忆；until 只认本次视野里看见的。
      const glance = await lookAround.run(ctx, { seconds: 2, direction: args.direction, ...(args.until ? { for: args.until } : {}) });
      if (args.until && glance.status === 'succeeded') { stop = 'UNTIL_SEEN'; sighting = glance.data; break; }
      if (hopStop === 'TIMEOUT' && deadline - Date.now() < 10000) { stop = 'TIMEOUT'; break; }
      stuck = hop.status === 'succeeded' || closer >= 2 ? 0 : stuck + 1;
      if (stuck >= MAX_STUCK_SEGMENTS) { stop = 'BLOCKED'; break; }
    }

    const end = { ...adapter.state().pos };
    const progress = project(end);
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
    const measured = `实测 ${at(end)}，沿 ${args.direction} 推进 ${progress.along}/${args.distance} 格、横向偏离 ${progress.lateral} 格，${segments.length} 段，新进入 ${facts.newChunks} 个区块`;
    const effects = dug.length || placed.length ? `；挖掉 ${dug.length} 块、放下 ${placed.length} 块` : '';
    if (stop === 'DISTANCE_MET') return ok(`往 ${args.direction} 走完 ${args.distance} 格：${measured}${effects}${args.until ? `；途中扫视没看见 ${args.until}（只覆盖每段的当前视野）` : ''}`, facts);
    if (stop === 'UNTIL_SEEN') return ok(`往 ${args.direction} 探索途中看见 ${args.until}：${measured}${effects}；看见的位置见 sighting`, facts);
    const why = {
      BLOCKED: `连续 ${MAX_STUCK_SEGMENTS} 段几乎没挪动（最后一段：${lastFailure?.summary.slice(0, 160) ?? '无'}）`,
      TIMEOUT: `用完 ${Math.round(args.timeoutMs / 1000)} 秒时限`,
      DIMENSION_CHANGED: `途中离开了 ${s0.dim}`,
      NOT_ALIVE: '途中死亡',
    }[stop];
    const code = stop === 'TIMEOUT' ? 'TIMEOUT' : stop === 'BLOCKED' ? 'STUCK' : stop === 'DIMENSION_CHANGED' ? 'WRONG_DIMENSION' : 'ERROR';
    return fail(code, `往 ${args.direction} 探索停下：${why}；${measured}${effects}。这只说明辅助走不通，不描述没看见的地形；继续、换方向或换手段由你决定`, facts);
  },
};

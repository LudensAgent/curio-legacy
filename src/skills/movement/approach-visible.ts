import type { EntityInfo, Vec3Like } from '../../adapter/types.ts';
import { isReplaceable } from '../../perception/geometry.ts';
import { fail, obj, ok, runSkill, validateSkill, type FailureCode, type Skill, type SkillResult } from '../types.ts';
import { navigateTo } from './navigate.ts';

type Kind = 'walk' | 'step' | 'drop';
type Target =
  | { kind: 'position'; pos: Vec3Like }
  | { kind: 'block'; pos: Vec3Like }
  | { kind: 'entity'; id?: number; name?: string };
type Args = {
  target: Target;
  radius: number;
  allowed: Kind[];
  historical: boolean;
  maxSteps: number;
  allowUnknownCorridor: boolean;
};
type Outcome = 'ARRIVED' | 'PARTIAL' | 'BLOCKED' | 'UNKNOWN' | 'UNSUPPORTED' | 'TIMEOUT' | 'CANCELLED' | 'INVALIDATED';

const KINDS: readonly Kind[] = ['walk', 'step', 'drop'];
const AIR = /^(air|cave_air|void_air)$/;
const DEFAULT_RADIUS = 32;
const MAX_RADIUS = 64;
const TOLERANCE = 0.75;
const ENTITY_REACH = 2.5;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const Y_OFFSETS = [-1, 0, 1] as const;
const MULTI_CELL = /(_bed$|_chest$|nether_portal|end_portal|end_gateway)/;

const point = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};
const dist = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function entityTarget(e: unknown): Target | string {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'entity 需要 {id?} 或 {name?}';
  const r = e as Record<string, unknown>;
  if (r.id !== undefined && (!Number.isInteger(r.id) || (r.id as number) < 0)) return 'entity.id 必须是非负整数';
  if (r.name !== undefined && (typeof r.name !== 'string' || !r.name.trim())) return 'entity.name 必须是非空字符串';
  if (r.id === undefined && r.name === undefined) return 'entity 需要 id 或 name';
  return { kind: 'entity', ...(r.id !== undefined ? { id: r.id as number } : {}), ...(r.name !== undefined ? { name: String(r.name) } : {}) };
}

function targetOf(raw: unknown): Target | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'target 必须是对象，例如 {"pos":{"x":0,"y":64,"z":0}}';
  const t = raw as Record<string, unknown>;
  const keys = Object.keys(t).filter((k) => t[k] !== undefined);
  const kind = typeof t.kind === 'string' ? t.kind.trim().toLowerCase() : undefined;
  // validate() 返回的是规范化 target，而 Arbiter 在执行前会再校验一次；必须接受自己的输出。
  // 实体规范化后是扁平的 {kind:"entity", id?, name?}，位置/方块是 {kind, pos}。
  if (kind === 'entity' && !('pos' in t) && !('block' in t) && !('entity' in t)
    && keys.every((k) => k === 'kind' || k === 'id' || k === 'name')) {
    return entityTarget({ id: t.id, name: t.name });
  }
  // kind 只是目标类型的说明，必须与唯一的目标键一致；规范化后的方块目标也写作 {kind:"block", pos}。
  const payload = keys.filter((k): k is 'pos' | 'block' | 'entity' => k === 'pos' || k === 'block' || k === 'entity');
  const key = payload[0];
  const effective = kind === 'position' ? (key === 'pos' ? 'position' : undefined)
    : kind === 'block' ? (key === 'pos' || key === 'block' ? 'block' : undefined)
    : kind === 'entity' ? (key === 'entity' ? 'entity' : undefined)
    : key === 'pos' ? 'position' : key === 'block' ? 'block' : key === 'entity' ? 'entity' : undefined;
  const foreign = keys.filter((k) => k !== 'kind' && k !== 'pos' && k !== 'block' && k !== 'entity');
  if (foreign.length || payload.length !== 1 || effective === undefined) {
    return `target 必须且只能指定 pos、block 或 entity 之一，例如 {"pos":{"x":0,"y":64,"z":0}}；不要再套 kind`;
  }
  if (effective === 'position' || effective === 'block') {
    const p = point(t[key]);
    if (!p) return `${key} 需要 {x,y,z} 三个有限数字`;
    if (effective === 'block' && !['x', 'y', 'z'].every((k) => Number.isInteger(p[k as 'x' | 'y' | 'z']))) {
      return 'block 需要整数方块坐标；站位坐标请用 pos';
    }
    return { kind: effective, pos: p };
  }
  return entityTarget(t.entity);
}

function outcomeOf(code: string | undefined, nested: SkillResult): Outcome {
  if (nested.status === 'succeeded') return 'ARRIVED';
  if (nested.status === 'cancelled') return 'CANCELLED';
  const data = nested.data as Record<string, unknown> | undefined;
  const executed = typeof data?.executed === 'number' ? data.executed : 0;
  switch (code) {
    case 'TIMEOUT': return 'TIMEOUT';
    case 'NOT_FOUND': return 'UNKNOWN';
    case 'NOT_CONNECTED':
    case 'WRONG_DIMENSION':
    case 'BAD_ARGS': return 'UNSUPPORTED';
    case 'PATH_NOT_FOUND': return executed > 0 ? 'PARTIAL' : data?.insufficientEvidence === true ? 'UNKNOWN' : 'BLOCKED';
    case 'EFFECT_NOT_CONFIRMED': return executed > 0 ? 'PARTIAL' : 'BLOCKED';
    default: return executed > 0 ? 'PARTIAL' : 'BLOCKED';
  }
}

const transitionsOf = (result: SkillResult) => {
  const transitions = (result.data as Record<string, unknown> | undefined)?.transitions;
  return Array.isArray(transitions) ? transitions.length : 0;
};

/**
 * 接近一个已经由感知或空间记忆识别出的附近目标：位置/方块/实体。
 * 只做局部选点，并复用 go_near/navigate_to 的现有规划与执行；不改目标、
 * 不挖/放/建、不换维度、不调用旧 Pathfinder。
 */
export const approachVisible: Skill<Args> = {
  name: 'approach_visible',
  description: '接近一个已经看见或记得的附近目标：位置（站立脚位）、方块（走到旁侧合法站立格）或实体。默认局部半径 32 格且不超过当前视觉有效范围；复用现有空间证据与 go_near/navigate_to，不改目标、不挖/放/建、不换维度、不调用旧 Pathfinder。ARRIVED 只按实测位置与原到达条件确认。',
  argsDoc: '{"target":{"pos":{"x":0,"y":64,"z":0}}|{"block":{"x":0,"y":64,"z":0}}|{"entity":{"id":123}}|{"entity":{"name":"cow"}}, "radius"?:32, "allowed"?:["walk","step","drop"], "historical"?:true, "maxSteps"?:16}；target 三选一；radius 默认 32、上限 64 且不超过视觉范围；block 是方块坐标，不是站立格；entity 需已看见/记得。',
  timeoutMs: 45000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const target = targetOf(a.target);
    if (typeof target === 'string') return { ok: false, error: target };
    const radius = a.radius === undefined ? DEFAULT_RADIUS : Number(a.radius);
    if (!Number.isFinite(radius) || radius < 1 || radius > MAX_RADIUS) return { ok: false, error: `radius 需要 1–${MAX_RADIUS} 的有限数字` };
    const allowedRaw = a.allowed === undefined ? KINDS : a.allowed;
    if (!Array.isArray(allowedRaw) || !allowedRaw.length || allowedRaw.some((k) => !KINDS.includes(k as Kind))) {
      return { ok: false, error: 'allowed 需要非空数组，元素只能是 walk、step、drop' };
    }
    if (a.historical !== undefined && typeof a.historical !== 'boolean') return { ok: false, error: 'historical 需要布尔值' };
    if (a.maxSteps !== undefined && (!Number.isInteger(a.maxSteps) || a.maxSteps < 1 || a.maxSteps > 64)) return { ok: false, error: 'maxSteps 需要 1–64 的整数' };
    if (a.allowUnknownCorridor !== undefined && typeof a.allowUnknownCorridor !== 'boolean') return { ok: false, error: 'allowUnknownCorridor 需要布尔值' };
    return {
      ok: true,
      args: {
        target, radius: Math.round(radius * 100) / 100,
        allowed: [...new Set(allowedRaw as Kind[])],
        historical: a.historical !== false,
        maxSteps: (a.maxSteps as number | undefined) ?? 16,
        allowUnknownCorridor: a.allowUnknownCorridor === true,
      },
    };
  },
  async run(ctx, args) {
    const spatial = ctx.spatial;
    if (!spatial?.session?.voxel) return fail('NOT_CONNECTED', 'approach_visible 需要共享空间 VoxelMap；当前没有接线');
    const state = ctx.adapter.state();
    if (!state.alive || !state.connected || !state.observationReady) return fail('NOT_CONNECTED', 'approach_visible 需要有效的存活观测');
    if (state.worldId !== spatial.worldId) return fail('WRONG_DIMENSION', '当前世界与空间会话不一致');
    const start = { ...state.pos };
    const target = args.target;
    const visualCap = Math.min(MAX_RADIUS, ctx.adapter.renderDistance?.() ?? MAX_RADIUS);
    const radius = Math.min(args.radius, visualCap);
    const base = { radius, visualCap, requestedRadius: args.radius, originalTarget: target };

    if (target.kind === 'position') {
      const to = { ...target.pos };
      const d = dist(start, to);
      if (d > radius) return fail('BAD_ARGS', `目标位置 ${JSON.stringify(to)} 距当前 ${d.toFixed(1)} 格，超出局部接近范围 ${radius} 格`, { ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0 });
      const moved = await runSkill(ctx, navigateTo, { to, allowed: args.allowed, historical: args.historical, maxSteps: args.maxSteps, allowUnknownCorridor: args.allowUnknownCorridor });
      const position = { ...ctx.adapter.state().pos };
      const displacement = dist(start, position);
      if (moved.status !== 'succeeded') {
        return fail(moved.failureCode ?? 'ERROR', `approach_visible 没能接近位置 ${JSON.stringify(to)}：${moved.summary}`, {
          ...base, outcome: outcomeOf(moved.failureCode, moved), resolvedStance: to, position, displacement, navigation: moved.data,
        });
      }
      if (dist(position, to) > TOLERANCE) {
        return fail('EFFECT_NOT_CONFIRMED', `到达后实测位置 (${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}) 与目标站位 ${JSON.stringify(to)} 不符`, {
          ...base, outcome: 'PARTIAL', resolvedStance: to, position, displacement, navigation: moved.data,
        });
      }
      return ok(`已接近位置 (${to.x},${to.y},${to.z})；实测在 (${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})，位移 ${displacement.toFixed(2)} 格`, {
        ...base, outcome: 'ARRIVED', resolvedStance: to, position, displacement, confirmedSegments: transitionsOf(moved), navigation: moved.data,
      });
    }

    let targetCell: Vec3Like;
    let targetName: string | undefined;
    let entity: EntityInfo | undefined;
    if (target.kind === 'block') {
      targetCell = { ...target.pos };
      const name = ctx.adapter.blockAt(targetCell);
      if (name === null) return fail('NOT_FOUND', `目标方块 (${targetCell.x},${targetCell.y},${targetCell.z}) 未加载/未观察`, { ...base, outcome: 'UNKNOWN', position: start, displacement: 0 });
      if (AIR.test(name)) return fail('BAD_ARGS', `目标格 (${targetCell.x},${targetCell.y},${targetCell.z}) 是空气；方块接近要指定方块坐标，位置接近用 pos`, { ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0 });
      targetName = name.replace(/^minecraft:/, '');
    } else {
      const wantName = target.name?.replace(/^minecraft:/, '');
      entity = ctx.senses.perceivedEntities(radius)
        .filter((e) => e.perception !== 'heard'
          && (target.id === undefined || e.id === target.id)
          && (wantName === undefined || e.name.replace(/^minecraft:/, '') === wantName))
        .sort((a, b) => a.dist - b.dist)[0];
      if (!entity) return fail('NOT_FOUND', `半径 ${radius} 格内没有看见/记得匹配的实体 ${JSON.stringify(target)}`, { ...base, outcome: 'UNKNOWN', position: start, displacement: 0 });
      targetCell = { x: Math.floor(entity.pos.x), y: Math.floor(entity.pos.y), z: Math.floor(entity.pos.z) };
    }

    const targetDistance = dist(start, targetCell);
    if (targetDistance > radius) {
      return fail('BAD_ARGS', `目标 ${target.kind} (${targetCell.x},${targetCell.y},${targetCell.z}) 距当前 ${targetDistance.toFixed(1)} 格，超出局部接近范围 ${radius} 格`, { ...base, outcome: 'UNSUPPORTED', position: start, displacement: 0 });
    }
    const multi = targetName !== undefined && MULTI_CELL.test(targetName);
    const candidates = DIRS.flatMap(([dx, dz]) => Y_OFFSETS.map((dy) => ({
      x: targetCell.x + dx, y: targetCell.y + dy, z: targetCell.z + dz,
    }))).filter((c) => {
      const name = ctx.adapter.blockAt(c);
      if (name === null || !(AIR.test(name) || isReplaceable(name))) return false;
      if (dist(start, c) > radius) return false;
      if (multi) {
        // 床/双箱/门的另一半不是“旁边的站立格”；检查该列里是否还有同种方块。
        for (let y = targetCell.y - 1; y <= targetCell.y + 2; y++) {
          const n = ctx.adapter.blockAt({ x: c.x, y, z: c.z })?.replace(/^minecraft:/, '');
          if (n !== undefined && n !== null && n === targetName) return false;
        }
      }
      return true;
    }).sort((a, b) => dist(start, a) - dist(start, b) || dist(targetCell, a) - dist(targetCell, b)).slice(0, 8);

    if (!candidates.length) {
      return fail('NOT_FOUND', `目标 ${target.kind} 周围没有当前可站的空位（半径 ${radius} 格）`, {
        ...base, outcome: 'UNKNOWN', position: start, displacement: 0, ...(entity ? { entity } : {}),
      });
    }

    let best: { position: Vec3Like; displacement: number; stance: Vec3Like | null; navigation: unknown } | null = null;
    let last: { code: string | undefined; summary: string; data: unknown } | null = null;
    for (const candidate of candidates) {
      if (ctx.signal.aborted) return { status: 'cancelled', summary: 'approach_visible 已取消', data: { ...base, outcome: 'CANCELLED', position: { ...ctx.adapter.state().pos }, displacement: 0 } };
      if (Date.now() >= ctx.deadline) break;
      const validated = validateSkill(navigateTo, { to: candidate, allowed: args.allowed, historical: args.historical, maxSteps: args.maxSteps, allowUnknownCorridor: args.allowUnknownCorridor }, ctx.adapter);
      if (!validated.ok) { last = { code: 'BAD_ARGS', summary: validated.error, data: null }; continue; }
      const moved = await runSkill(ctx, navigateTo, validated.args);
      const position = { ...ctx.adapter.state().pos };
      const displacement = dist(start, position);
      if (best === null || displacement > best.displacement) best = { position, displacement, stance: candidate, navigation: moved.data };
      if (moved.status === 'succeeded') {
        const reach = target.kind === 'entity' ? ENTITY_REACH : 1.8;
        const distanceToTarget = target.kind === 'entity' && entity !== undefined
          ? dist(position, entity.pos)
          : Math.hypot(position.x - (targetCell.x + 0.5), position.z - (targetCell.z + 0.5));
        if (distanceToTarget <= reach + 0.5) {
          return ok(`已接近${target.kind === 'entity' ? `实体 ${entity?.name ?? ''}` : '目标方块'}；实测在 (${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})，位移 ${displacement.toFixed(2)} 格`, {
            ...base, outcome: 'ARRIVED', resolvedStance: candidate, position, displacement, confirmedSegments: transitionsOf(moved),
            ...(entity ? { entity } : {}), navigation: moved.data,
          });
        }
      } else {
        last = { code: moved.failureCode, summary: moved.summary, data: moved.data };
      }
    }

    const position = best?.position ?? start;
    const displacement = best?.displacement ?? 0;
    if (best !== null && (displacement > 0.05 || last?.code === 'EFFECT_NOT_CONFIRMED')) {
      return fail('EFFECT_NOT_CONFIRMED', `approach_visible 只完成了部分接近：${last?.summary ?? '没有到达可用站位'}`, {
        ...base, outcome: 'PARTIAL', resolvedStance: best.stance, position, displacement, ...(entity ? { entity } : {}),
        ...(last?.data === undefined ? {} : { navigation: last.data }), attempts: candidates.length,
      });
    }
    const code = last?.code as FailureCode | undefined;
    const fake = { status: 'failed', failureCode: code, data: last?.data } as SkillResult;
    return fail(code ?? 'NOT_FOUND', `approach_visible 没能接近 ${target.kind}：${last?.summary ?? '没有可用站位'}`, {
      ...base, outcome: outcomeOf(last?.code, fake), resolvedStance: null, position, displacement,
      ...(entity ? { entity } : {}), ...(last?.data === undefined ? {} : { navigation: last.data }), attempts: candidates.length,
    });
  },
};

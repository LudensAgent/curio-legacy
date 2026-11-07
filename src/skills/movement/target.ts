import type { Vec3Like } from '../../adapter/types.ts';
import { DIRS } from '../../perception/perception.ts';
import { HEADING_TARGET, MAX_HEADING_DISTANCE } from '../overland.ts';
import { findStation, isStation } from '../stations.ts';
import { fail, obj, ok, type Skill } from '../types.ts';

/** 床的 16 种颜色名；findStation 只接受具体方块名。 */
const BED_NAMES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map((c) => `${c}_bed`);

type TargetArgs = { target: string | Vec3Like; headingOrigin?: Vec3Like };

const finitePoint = (v: unknown): Vec3Like | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]))
    ? { x: p.x as number, y: p.y as number, z: p.z as number } : null;
};

/**
 * 把 Agent 写的目标解析成规范绝对目标。只读：不移动、不观察、不读隐藏方块；
 * 名字/基地/死亡点/工作站来自记忆，坐标与方向是调用方给定的事实。
 */
export const resolveTarget: Skill<TargetArgs> = {
  name: 'resolve_target',
  description: '把坐标、方向（如 "E 150"）、地标名、base、death 或工作站名解析成规范绝对目标，附带来源、维度、半径/不确定项。只读，不移动、不观察、不遗忘；工作站名只查记忆，不现场观察也不删除过时地标；找不到就报已知地标，不猜坐标。',
  argsDoc: '{"target":"x,y,z | x,z | 地标名 | base | death | 工作站名 | 方向如 E 150", "headingOrigin"?:{"x","y","z"}}（方向单次最多 200 格；只给 x,z 时高度沿用当前脚高并标注 horizontalOnly；工作站名来自记忆，不观察、不遗忘）',
  timeoutMs: 3000,
  movement: false,
  readOnly: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const target = a.target ?? a.to ?? a.pos;
    if (typeof target === 'string') {
      if (!target.trim()) return { ok: false, error: 'target 不能为空' };
    } else if (target && typeof target === 'object' && !Array.isArray(target)) {
      const p = target as Record<string, unknown>;
      const finite = (k: string) => typeof p[k] === 'number' && Number.isFinite(p[k]);
      const full = finite('x') && finite('y') && finite('z');
      const horizontalOnly = p.y === undefined && finite('x') && finite('z');
      if (!full && !horizontalOnly) {
        return { ok: false, error: 'target 对象需要有限的 x、y、z，或至少 x、z' };
      }
    } else {
      return { ok: false, error: 'target 需要坐标字符串/对象、地标名、base、death、工作站名或方向如 "E 150"' };
    }
    const origin = a.headingOrigin;
    if (origin !== undefined && !finitePoint(origin)) return { ok: false, error: 'headingOrigin 需要 {x,y,z} 有限数字' };
    const heading = typeof target === 'string' ? target.trim().toUpperCase().match(HEADING_TARGET) : null;
    if (heading && Number(heading[2]) > MAX_HEADING_DISTANCE) return { ok: false, error: `方向距离 ${heading[2]} 格超过单次上限 ${MAX_HEADING_DISTANCE} 格；原目标不会被缩短，请分段或直接写终点坐标` };
    return { ok: true, args: { target: target as string | Vec3Like, ...(origin !== undefined ? { headingOrigin: origin } : {}) } };
  },
  async run(ctx, args) {
    const s = ctx.adapter.state();
    const failAt = (message: string, extra: Record<string, unknown> = {}) => fail('NOT_FOUND', message, { originalTarget: args.target, ...extra });
    const point = (pos: Vec3Like, extra: { label?: string; source: string; kind: string; radius?: number; horizontalOnly?: boolean; origin?: Vec3Like; uncertain?: string }) => ok(
      `${extra.label ?? `(${pos.x},${pos.y},${pos.z})`}：${extra.kind}，来源 ${extra.source}${extra.horizontalOnly ? '；只有水平坐标，高度沿用当前脚高' : ''}${extra.radius !== undefined ? `；半径约 ${extra.radius} 格，具体位置未确认` : ''}`,
      { target: pos, kind: extra.kind, label: extra.label ?? null, dim: s.dim, source: extra.source, ...(extra.radius !== undefined ? { radius: extra.radius } : {}), ...(extra.horizontalOnly ? { horizontalOnly: true } : {}), ...(extra.origin ? { headingOrigin: extra.origin } : {}), ...(extra.uncertain ? { uncertain: extra.uncertain } : {}) },
    );
    // 对象坐标：validate 已保证 x,y,z 或至少 x,z；没有 y 时高度沿用当前脚高。
    if (typeof args.target !== 'string') {
      const p = args.target as unknown as Record<string, number>;
      return Number.isFinite(p.y)
        ? point({ x: p.x, y: p.y, z: p.z }, { source: 'given', kind: 'point' })
        : point({ x: p.x, y: s.pos.y, z: p.z }, { source: 'given', kind: 'point', horizontalOnly: true });
    }
    const raw = String(args.target).trim();
    const heading = raw.toUpperCase().match(HEADING_TARGET);
    if (heading) {
      const [dx, dz] = DIRS[heading[1]];
      const from = args.headingOrigin ?? s.pos;
      const n = Number(heading[2]), len = Math.hypot(dx, dz) || 1;
      const pos = { x: Math.round(from.x + dx / len * n), y: s.pos.y, z: Math.round(from.z + dz / len * n) };
      return point(pos, { label: `往 ${heading[1]} ${n} 格`, source: 'given', kind: 'heading', horizontalOnly: true, origin: { ...from } });
    }
    // 坐标写法：支持 "x,y,z"、"x,z"、x=1 y=64 z=2、"-3 90 -10"
    const nums = raw.replace(/\b[xyz]\s*[=:]/gi, '').match(/-?\d+(?:\.\d+)?/g);
    if (nums && !/[a-z一-龥]{2,}/i.test(raw.replace(/\b[xyz]\s*[=:]/gi, ''))) {
      if (nums.length === 3) return point({ x: +nums[0], y: +nums[1], z: +nums[2] }, { source: 'given', kind: 'point' });
      if (nums.length === 2) return point({ x: +nums[0], y: s.pos.y, z: +nums[1] }, { source: 'given', kind: 'point', horizontalOnly: true });
    }
    const lower = raw.toLowerCase();
    if (lower === 'death') {
      const d = ctx.memory.lastDeath();
      if (!d) return failAt('没有记录的死亡地点');
      if (d.dim !== s.dim) return fail('WRONG_DIMENSION', `死亡地点在 ${d.dim}`, { target: { ...d.pos }, dim: d.dim });
      return point(d.pos, { label: '死亡地点', source: 'death', kind: 'death' });
    }
    if (lower === 'base' || lower === '基地') {
      const lm = ctx.memory.findLandmark('base', s.dim) ?? ctx.memory.findLandmark('基地', s.dim);
      if (!lm) return failAt('没有记录的首选基地');
      if (lm.dim !== s.dim) return fail('WRONG_DIMENSION', `首选基地在 ${lm.dim}`, { target: { ...lm.pos }, dim: lm.dim });
      return point(lm.pos, { label: `${lm.label}（首选基地 base）`, source: 'memory', kind: 'base', ...(lm.radius !== undefined ? { radius: lm.radius } : {}) });
    }
    if (/^[a-z_]+$/.test(lower) && (isStation(lower) || lower === 'bed' || lower.endsWith('_bed'))) {
      const names = lower === 'bed' || lower.endsWith('_bed') ? BED_NAMES : [lower];
      const station = findStation(ctx, names, 160, { readOnly: true });
      if (station) return point(station.pos, { label: `${station.from === 'memory' ? '记得的' : '看到的'} ${lower}`, source: 'station', kind: 'station', ...(station.radius !== undefined ? { radius: station.radius } : {}) });
    }
    const lm = ctx.memory.findLandmark(raw, s.dim);
    if (!lm) {
      const known = ctx.memory.landmarks().filter((l) => l.dim === s.dim && l.kind !== 'resource').slice(-8).map((l) => l.label);
      return failAt(`找不到地标：${raw}${known.length ? `（记得的地标：${known.join('、')}）` : '（也可以直接写坐标）'}`, { knownLandmarks: known });
    }
    if (lm.dim !== s.dim) return fail('WRONG_DIMENSION', `地标 ${lm.label} 在 ${lm.dim}`, { target: { ...lm.pos }, dim: lm.dim });
    return point(lm.pos, { label: lm.label, source: 'memory', kind: 'landmark', ...(lm.radius !== undefined ? { radius: lm.radius } : {}) });
  },
};

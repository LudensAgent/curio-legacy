import { DIRS } from '../perception/perception.ts';
import { dist3, sleep } from '../util.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

// ------------------------------------------------------------------ explore
export const explore: Skill<{ direction: string; distance: number }> = {
  name: 'explore',
  description: '朝新颖度最高（或指定）的方向前进，进入未访问区块，沿途自动记录新发现',
  argsDoc: '{"direction"?: "auto|N|NE|E|SE|S|SW|W|NW", "distance"?: 24-160}',
  timeoutMs: 90000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const direction = String(a.direction ?? 'auto').toUpperCase();
    if (direction !== 'AUTO' && !DIRS[direction]) return { ok: false, error: `direction 必须是 auto 或 ${Object.keys(DIRS).join('/')}` };
    return { ok: true, args: { direction, distance: clampInt(a.distance, 24, 160, 64) } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    const s = adapter.state();
    if (!s.connected) return fail('NOT_CONNECTED', '未连接');
    const ranked = Object.entries(DIRS)
      .map(([d, [dx, dz]]) => ({ d, dx, dz, n: memory.novelty(s.dim, s.pos.x + dx * args.distance, s.pos.z + dz * args.distance) + Math.random() * 0.05 }))
      .sort((a, b) => b.n - a.n);
    const order = args.direction === 'AUTO' ? ranked : [ranked.find((r) => r.d === args.direction)!, ...ranked.filter((r) => r.d !== args.direction)];
    const chunksBefore = memory.visitedChunkCount;
    const start = s.pos;
    const prog = setInterval(() => {
      const p = adapter.state().pos;
      ctx.progress(Math.min(1, Math.hypot(p.x - start.x, p.z - start.z) / args.distance));
    }, 1000);
    try {
      for (const cand of order.slice(0, 2)) {
        const tx = start.x + cand.dx * args.distance;
        const tz = start.z + cand.dz * args.distance;
        ctx.progress(0, `向 ${cand.d} 探索 ${args.distance} 格`);
        try {
          await adapter.moveTo({ kind: 'xz', x: tx, z: tz, range: 4 }, { signal, timeoutMs: Math.max(5000, ctx.deadline - Date.now()) });
          const moved = Math.round(Math.hypot(adapter.state().pos.x - start.x, adapter.state().pos.z - start.z));
          return ok(`向 ${cand.d} 探索 ${moved} 格，新区块 +${memory.visitedChunkCount - chunksBefore}`, { dir: cand.d, moved });
        } catch (e) {
          if (isAbort(e)) throw e;
          const p = adapter.state().pos;
          const moved = Math.hypot(p.x - start.x, p.z - start.z);
          if (moved >= args.distance * 0.5) {
            return ok(`向 ${cand.d} 探索了 ${Math.round(moved)} 格（未完全到达），新区块 +${memory.visitedChunkCount - chunksBefore}`, { dir: cand.d, moved });
          }
          if (codeFromError(e) === 'TIMEOUT') return fail('TIMEOUT', `向 ${cand.d} 探索超时，仅前进 ${Math.round(moved)} 格`);
          // 换一个方向再试一次
        }
      }
      return fail('PATH_NOT_FOUND', '两个方向都无法前进');
    } finally {
      clearInterval(prog);
    }
  },
};

// ------------------------------------------------------------------ goto
export const goTo: Skill<{ target: string }> = {
  name: 'goto',
  description: '前往地标（base、地标 id 或名称）或坐标',
  argsDoc: '{"target": "base | <地标id或名称> | x,y,z"}',
  timeoutMs: 120000,
  movement: true,
  validate(raw) {
    const t = String(obj(raw).target ?? '').trim();
    if (!t) return { ok: false, error: 'target 不能为空' };
    return { ok: true, args: { target: t } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    const s = adapter.state();
    let pos: { x: number; y: number; z: number } | null = null;
    let label = args.target;
    const m = args.target.match(/^\s*(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)\s*$/);
    if (m) pos = { x: +m[1], y: +m[2], z: +m[3] };
    else {
      const lm = memory.findLandmark(args.target);
      if (!lm) return fail('NOT_FOUND', `找不到地标：${args.target}`);
      if (lm.dim !== s.dim) return fail('WRONG_DIMENSION', `地标 ${lm.label} 在 ${lm.dim}`);
      pos = lm.pos;
      label = lm.label;
    }
    const startDist = dist3(s.pos, pos);
    const prog = setInterval(() => ctx.progress(1 - Math.min(1, dist3(adapter.state().pos, pos!) / Math.max(1, startDist))), 1000);
    try {
      await adapter.moveTo({ kind: 'near', pos, range: 2 }, { signal, timeoutMs: Math.max(5000, ctx.deadline - Date.now()) });
      return ok(`到达 ${label}`);
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `前往 ${label} 失败：${(e as Error).message}`);
    } finally {
      clearInterval(prog);
    }
  },
};

// ------------------------------------------------------------------ wander（空档填充）
export const wander: Skill<{ radius: number }> = {
  name: 'wander',
  description: '在附近随意走动观察（低价值填充行为，等待思考时使用）',
  argsDoc: '{"radius"?: 4-16}',
  timeoutMs: 20000,
  movement: true,
  validate(raw) {
    return { ok: true, args: { radius: clampInt(obj(raw).radius, 4, 16, 8) } };
  },
  async run(ctx, args) {
    const s = ctx.adapter.state();
    const ang = Math.random() * Math.PI * 2;
    const r = args.radius * (0.5 + Math.random() * 0.5);
    try {
      await ctx.adapter.moveTo(
        { kind: 'xz', x: s.pos.x + Math.cos(ang) * r, z: s.pos.z + Math.sin(ang) * r, range: 2 },
        { signal: ctx.signal, timeoutMs: Math.max(3000, ctx.deadline - Date.now()) },
      );
    } catch (e) {
      if (isAbort(e)) throw e;
    }
    return ok('在附近走动观察');
  },
};

// ------------------------------------------------------------------ look_around（空档填充）
export const lookAround: Skill<{ seconds: number }> = {
  name: 'look_around',
  description: '原地环顾四周几秒',
  argsDoc: '{"seconds"?: 2-20}',
  timeoutMs: 25000,
  movement: false,
  validate(raw) {
    return { ok: true, args: { seconds: clampInt(obj(raw).seconds, 2, 20, 5) } };
  },
  async run(ctx, args) {
    const end = Date.now() + args.seconds * 1000;
    while (Date.now() < end) {
      await ctx.adapter.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6);
      await sleep(900 + Math.random() * 600, ctx.signal);
    }
    return ok(`环顾了 ${args.seconds} 秒`);
  },
};


// ------------------------------------------------------------------ unstuck（仅反射层使用）
export const unstuck: Skill<{}> = {
  name: 'unstuck',
  description: '脱困：跳跃并向随机方向小范围移动',
  argsDoc: '{}',
  timeoutMs: 12000,
  movement: false,
  validate() {
    return { ok: true, args: {} };
  },
  async run(ctx) {
    await ctx.adapter.jump(600, ctx.signal);
    const s = ctx.adapter.state();
    const ang = Math.random() * Math.PI * 2;
    try {
      await ctx.adapter.moveTo({ kind: 'xz', x: s.pos.x + Math.cos(ang) * 5, z: s.pos.z + Math.sin(ang) * 5, range: 1 }, { signal: ctx.signal, timeoutMs: 8000 });
    } catch (e) {
      if (isAbort(e)) throw e;
    }
    return ok('尝试脱困');
  },
};

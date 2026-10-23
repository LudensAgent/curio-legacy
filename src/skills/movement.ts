import { DIRS } from '../perception/perception.ts';
import { dist3, sleep } from '../util.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

// ------------------------------------------------------------------ 寻找与张望（人眼式：不透视，只是转头看）
/** 朝 (dx,dz) 方向的 yaw（0 = 北/-Z，正值向左/西） */
export const yawOfDir = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export const FOOD_ANIMAL_NAMES = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
/** 目标的类别写法：animal/food = 能吃的动物，hostile = 敌对生物 */
const CATEGORY: Record<string, string[]> = { animal: FOOD_ANIMAL_NAMES, animals: FOOD_ANIMAL_NAMES, food: FOOD_ANIMAL_NAMES, food_animal: FOOD_ANIMAL_NAMES };

/** target 是否已在视野/近期记忆中：方块（log、iron_ore…）或实体（cow、sheep…）；可写 "cow|sheep" 或类别 "animal" */
export function sighted(ctx: SkillCtx, target: string): { what: string; dist: number } | null {
  const here = ctx.adapter.state().pos;
  for (const raw of target.toLowerCase().split(/[|,，、/ ]+/).filter(Boolean)) {
    const wanted = CATEGORY[raw] ?? [raw];
    for (const t of wanted) {
      const names = ctx.adapter.resolveBlockNames(t).filter(Boolean);
      if (names.length) {
        const hit = ctx.senses.knownBlocks(names, 96)[0];
        if (hit) return { what: hit.name, dist: Math.round(dist3(here, hit.pos)) };
      }
    }
    const e = ctx.senses.perceivedEntities(48).find((x) => wanted.some((t) => x.name === t || x.name.replace(/^player:/, '') === t || x.name.endsWith(`_${t}`)));
    if (e) return { what: e.name, dist: Math.round(e.dist) };
  }
  return null;
}

/** 快速左右张望一下（约 1 秒），像走路时扫一眼两侧 */
export async function glance(ctx: SkillCtx, until?: string): Promise<{ what: string; dist: number } | null> {
  const eye = ctx.adapter.eye();
  if (!eye) return null;
  for (const off of [1.2, -1.2, 0]) {
    await ctx.adapter.look(eye.yaw + off, -0.15);
    await sleep(off === 0 ? 200 : 260, ctx.signal); // 视觉刷新节流 150ms：每个角度都要停够一次扫描
    ctx.senses.refresh();
    const seen = until ? sighted(ctx, until) : null;
    if (seen) return seen;
  }
  return null;
}

// ------------------------------------------------------------------ explore
/** 最近走不通的方向：2 分钟内降低优先级，避免对着大海/悬崖反复尝试 */
const failedDirs = new Map<string, number>();
const dirPenalty = (d: string) => (Date.now() - (failedDirs.get(d) ?? 0) < 120_000 ? 1 : 0);
const SEGMENT = 32;
export const explore: Skill<{ direction: string; distance: number; until?: string }> = {
  name: 'explore',
  description: '朝新颖度最高（或指定）方向前进并沿途张望；until 一看见就停（可写 "cow|sheep" 或 "animal"）',
  argsDoc: '{"direction"?: "auto|N|NE|E|SE|S|SW|W|NW", "distance"?: 24-160, "until"?: "<方块/生物，可用 | 分隔多个，或 animal>"}',
  timeoutMs: 90000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const direction = String(a.direction ?? 'auto').toUpperCase();
    if (direction !== 'AUTO' && !DIRS[direction]) return { ok: false, error: `direction 必须是 auto 或 ${Object.keys(DIRS).join('/')}` };
    const until = typeof a.until === 'string' && a.until.trim() ? a.until.trim().toLowerCase().slice(0, 80) : undefined;
    return { ok: true, args: { direction, distance: clampInt(a.distance, 24, 160, 64), ...(until ? { until } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    const s = adapter.state();
    if (!s.connected) return fail('NOT_CONNECTED', '未连接');
    const already = args.until ? sighted(ctx, args.until) : null;
    if (already) return ok(`不用走远：${already.what} 就在 ${already.dist} 格外`, { found: already.what, dist: already.dist, moved: 0 });
    const ranked = Object.entries(DIRS)
      .map(([d, [dx, dz]]) => ({ d, dx, dz, n: memory.novelty(s.dim, s.pos.x + dx * args.distance, s.pos.z + dz * args.distance) + Math.random() * 0.05 - dirPenalty(d) }))
      .sort((a, b) => b.n - a.n);
    const order = args.direction === 'AUTO' ? ranked : [ranked.find((r) => r.d === args.direction)!, ...ranked.filter((r) => r.d !== args.direction)];
    const chunksBefore = memory.visitedChunkCount;
    const start = s.pos;
    const movedNow = () => Math.round(Math.hypot(adapter.state().pos.x - start.x, adapter.state().pos.z - start.z));
    const done = (dir: string, partial: boolean) => ok(`向 ${dir} 探索${partial ? '了' : ''} ${movedNow()} 格${partial ? '（未完全到达）' : ''}，新区块 +${memory.visitedChunkCount - chunksBefore}`, { dir, moved: movedNow() });
    const found = (dir: string, f: { what: string; dist: number }) => ok(`向 ${dir} 走了 ${movedNow()} 格，看见 ${f.what}（${f.dist} 格外），停下`, { dir, moved: movedNow(), found: f.what, dist: f.dist });
    let seen: { what: string; dist: number } | null = null;
    // 边走边看：每段路上持续检查目标是否进入视野，一旦看见就停下（像人一样看到树就不再往前走）
    const prog = setInterval(() => {
      ctx.progress(Math.min(1, movedNow() / args.distance));
      if (args.until && !seen) {
        ctx.senses.refresh();
        seen = sighted(ctx, args.until);
        if (seen) stopWalk?.abort('target_seen');
      }
    }, 500);
    let stopWalk: AbortController | null = null;
    try {
      for (const cand of order.slice(0, 2)) {
        const tx = start.x + cand.dx * args.distance;
        const tz = start.z + cand.dz * args.distance;
        ctx.progress(0, `向 ${cand.d} 探索 ${args.distance} 格${args.until ? `，留意 ${args.until}` : ''}`);
        try {
          const segments = Math.max(1, Math.ceil(args.distance / SEGMENT));
          for (let k = 1; k <= segments; k++) {
            const f = Math.min(1, (k * SEGMENT) / args.distance);
            stopWalk = new AbortController();
            const walk = AbortSignal.any([signal, stopWalk.signal]);
            try {
              await adapter.moveTo({ kind: 'xz', x: start.x + (tx - start.x) * f, z: start.z + (tz - start.z) * f, range: k === segments ? 4 : 6 }, { signal: walk, timeoutMs: Math.max(5000, ctx.deadline - Date.now()) });
            } catch (e) {
              if (seen && !signal.aborted) return found(cand.d, seen);
              throw e;
            }
            if (seen) return found(cand.d, seen);
            // 每段路走完扫一眼两侧（最后一段也看：到了地方先看看周围，不必再单独环顾）
            const g = await glance(ctx, args.until);
            if (g) return found(cand.d, g);
          }
          ctx.senses.markSweep();
          return done(cand.d, false);
        } catch (e) {
          if (isAbort(e)) throw e;
          const moved = movedNow();
          if (moved < args.distance * 0.3) failedDirs.set(cand.d, Date.now());
          if (moved >= args.distance * 0.5) return done(cand.d, true);
          if (codeFromError(e) === 'TIMEOUT') return fail('TIMEOUT', `向 ${cand.d} 探索超时，仅前进 ${moved} 格`);
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
  description: '前往地标（base、death=上次死亡地点、地标 id 或名称）或坐标',
  argsDoc: '{"target": "base | death | <地标id或名称> | x,y,z"}',
  timeoutMs: 600000,
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
    else if (args.target.toLowerCase() === 'death') {
      const d = memory.lastDeath();
      if (!d) return fail('NOT_FOUND', '没有记录的死亡地点');
      if (d.dim !== s.dim) return fail('WRONG_DIMENSION', `死亡地点在 ${d.dim}`);
      pos = d.pos;
      label = '死亡地点';
    } else {
      const lm = memory.findLandmark(args.target, s.dim);
      if (!lm) return fail('NOT_FOUND', `找不到地标：${args.target}`);
      if (lm.dim !== s.dim) return fail('WRONG_DIMENSION', `地标 ${lm.label} 在 ${lm.dim}`);
      pos = lm.pos;
      label = lm.label;
    }
    const startDist = dist3(s.pos, pos);
    const prog = setInterval(() => ctx.progress(1 - Math.min(1, dist3(adapter.state().pos, pos!) / Math.max(1, startDist))), 1000);
    try {
      // 远距离（远征回家）：分段朝目标走，每段 64 格，避免寻路一次算太远
      for (let hops = 0; hops < 20; hops++) {
        if (adapter.state().dim !== s.dim || adapter.state().worldId !== s.worldId) return fail('WRONG_DIMENSION', '途中世界或维度已改变，需要重新规划');
        const cur = adapter.state().pos;
        const dxz = Math.hypot(pos.x - cur.x, pos.z - cur.z);
        if (dxz <= 96) break;
        const k = 64 / dxz;
        await adapter.moveTo({ kind: 'xz', x: cur.x + (pos.x - cur.x) * k, z: cur.z + (pos.z - cur.z) * k, range: 6 }, { signal, timeoutMs: 60000 });
      }
      if (adapter.state().dim !== s.dim || adapter.state().worldId !== s.worldId) return fail('WRONG_DIMENSION', '途中世界或维度已改变，需要重新规划');
      await adapter.moveTo({ kind: 'near', pos, range: 2 }, { signal, timeoutMs: Math.max(5000, ctx.deadline - Date.now()) });
      if (adapter.state().dim !== s.dim || adapter.state().worldId !== s.worldId) return fail('WRONG_DIMENSION', '途中世界或维度已改变，需要重新规划');
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

// ------------------------------------------------------------------ look_around
export const lookAround: Skill<{ seconds: number; for?: string; direction?: string }> = {
  name: 'look_around',
  description: '停下来专门找东西（for），或只看某个方向（direction）；看见就停',
  argsDoc: '{"for"?: "<要找的方块或生物>", "direction"?: "N|NE|E|SE|S|SW|W|NW", "seconds"?: 2-20}',
  timeoutMs: 25000,
  movement: false,
  validate(raw) {
    const a = obj(raw);
    const dir = typeof a.direction === 'string' ? a.direction.toUpperCase() : undefined;
    if (dir !== undefined && !DIRS[dir]) return { ok: false, error: `direction 必须是 ${Object.keys(DIRS).join('/')}` };
    const target = typeof a.for === 'string' && a.for.trim() ? a.for.trim().toLowerCase().slice(0, 40) : undefined;
    return { ok: true, args: { seconds: clampInt(a.seconds, 2, 20, 4), ...(target ? { for: target } : {}), ...(dir ? { direction: dir } : {}) } };
  },
  async run(ctx, args) {
    if (args.for) {
      const known = sighted(ctx, args.for);
      if (known) return ok(`${known.what} 就在 ${known.dist} 格外，不用再找`, { found: known.what, dist: known.dist });
    }
    // 定向：在该方向 ±75° 扇形里看 5 个角度；全向：转一圈 8 个角度
    const sector = args.direction ? DIRS[args.direction] : null;
    const center = sector ? yawOfDir(sector[0], sector[1]) : (ctx.adapter.eye()?.yaw ?? 0);
    const yaws = sector ? [-1.3, -0.65, 0, 0.65, 1.3].map((o) => center + o) : Array.from({ length: 8 }, (_, k) => center + ((k + 1) * 2 * Math.PI) / 8);
    const per = Math.max(250, (args.seconds * 1000) / yaws.length);
    for (const [k, yaw] of yaws.entries()) {
      const pitch = k % 2 === 0 ? -0.05 : -0.45; // 平视 / 略低头
      await ctx.adapter.look(yaw, pitch);
      await sleep(per, ctx.signal);
      ctx.senses.refresh();
      ctx.progress((k + 1) / yaws.length, args.for ? `寻找 ${args.for}` : '环顾四周');
      if (args.for) {
        const f = sighted(ctx, args.for);
        if (f) return ok(`看见 ${f.what}（${f.dist} 格外）`, { found: f.what, dist: f.dist });
      }
    }
    if (!sector) ctx.senses.markSweep();
    if (args.for) return fail('NOT_FOUND', `${args.direction ? `${args.direction} 方向` : '四周'}看不到 ${args.for}（视线被挡住或确实没有），换个地方或方向再找`);
    return ok(args.direction ? `看了看 ${args.direction} 方向` : '环顾了一圈');
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
    // Random horizontal pathfinding can sink back into the same water trap.
    if (ctx.adapter.state().inWater) return surface.run(ctx, {});
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

// ------------------------------------------------------------------ surface（仅反射层使用：防溺水）
export const surface: Skill<{}> = {
  name: 'surface',
  description: '溺水时持续上浮并朝看见的岸边游动，确认站稳干地后结束',
  argsDoc: '{}',
  timeoutMs: 35000,
  movement: true,
  validate() {
    return { ok: true, args: {} };
  },
  async run(ctx) {
    const end = Math.min(ctx.deadline, Date.now() + 32000);
    const excluded: { x: number; y: number; z: number }[] = [];
    let attempts = 0, scans = 0;
    if (!ctx.adapter.swimTo) return fail('STUCK', '当前适配器缺少持续游泳控制，不能确认已安全上岸');
    let brokeCeiling = 0;
    while (Date.now() < end) {
      ctx.signal.throwIfAborted();
      // 头顶被冰/方块封住时往上游没用：先把头顶那一块挖开（玩家在冰下会这么做）
      const lid = ceilingAbove(ctx);
      if (lid && brokeCeiling < 3) {
        ctx.progress(0, `头顶是 ${lid.name}，挖开透气`);
        try {
          const r = await ctx.adapter.dig(lid.pos, ctx.signal);
          if (r.ok) brokeCeiling++;
        } catch (e) {
          if (isAbort(e)) throw e;
        }
      }
      ctx.senses.refresh();
      const before = ctx.adapter.state();
      let land = ctx.senses.nearestLand?.(before.pos, excluded);
      const target = land ? { x: land.pos.x + 0.5, y: land.pos.y + 1, z: land.pos.z + 0.5 } : null;
      ctx.progress(0, land ? `保持上浮，向 ${land.dir} 岸边游动（${land.dist} 格）` : '保持上浮并寻找实际可站立的岸边');
      const result = await ctx.adapter.swimTo(target, ctx.signal, { timeoutMs: Math.min(land ? 8000 : 10000, end - Date.now()), observeShore: () => {
        ctx.senses.refresh();
        land = ctx.senses.nearestLand?.(ctx.adapter.state().pos, excluded);
        return land ? { x: land.pos.x + 0.5, y: land.pos.y + 1, z: land.pos.z + 0.5 } : null;
      } });
      const after = ctx.adapter.state();
      if (result.ok && result.landed && !after.inWater && after.onGround && after.oxygen >= 18) {
        return ok(`已游上岸并站稳，氧气 ${after.oxygen}/20`, { attempts, landed: true, pos: after.pos });
      }
      if (land) {
        attempts++;
        excluded.push(land.pos);
      } else {
        // The continuous primitive already turns while afloat. A new bounded
        // observation period can continue without inventing a destination.
        scans++;
      }
      if (attempts >= 4 || scans >= 8) break;
    }
    const s = ctx.adapter.state();
    // 没找到岸，但已经浮在水面、能正常呼吸：溺水危险已解除，交还给原来的事情（由它决定怎么离开水面）
    if (s.oxygen >= 18 && !ceilingAbove(ctx)) {
      const land = ctx.senses.nearestLand?.(s.pos, []);
      return ok(`浮在水面能正常呼吸了（氧气 ${s.oxygen}/20），还没上岸${land ? `；最近看到的陆地在 ${land.dir} ${land.dist} 格` : '；附近没看到能上岸的地方'}`,
        { attempts, landed: false, afloat: true, pos: s.pos, ...(brokeCeiling ? { brokeCeiling } : {}) });
    }
    return fail('STUCK', `尚未确认安全上岸，氧气 ${s.oxygen}/20${s.inWater ? '，仍在水中' : '，尚未站稳干地'}`, { attempts, landed: false, pos: s.pos });
  },
};

const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate']);
/** 人在水里且头顶 3 格内有实心方块挡住水面（冰面、石顶）时返回那一块 */
function ceilingAbove(ctx: SkillCtx): { name: string; pos: { x: number; y: number; z: number } } | null {
  const s = ctx.adapter.state();
  if (!s.inWater) return null;
  const x = Math.floor(s.pos.x), z = Math.floor(s.pos.z), feet = Math.floor(s.pos.y);
  for (let y = feet + 1; y <= feet + 3; y++) {
    const name = ctx.adapter.blockAt({ x, y, z }) ?? 'air';
    if (name === 'air' || name === 'cave_air' || name === 'void_air') return null; // 头顶是开阔水面
    if (PASSABLE.has(name)) continue;
    return UNBREAKABLE.has(name) ? null : { name, pos: { x, y, z } };
  }
  return null;
}

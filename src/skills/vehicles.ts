import type { BlockHit, Vec3Like } from '../adapter/types.ts';
import { DIRS } from '../perception/perception.ts';
import { dist3, sleep } from '../util.ts';
import { lookAround, sighted } from './movement.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';
import { craft } from './work.ts';

/**
 * 坐船：把“做船 → 找水面放船 → 坐上去 → 划到目标 → 靠岸下船 → 把船收回背包”合成一个像人一样的动作。
 * 底层仍是 use_item / interact / ride / dismount 这几个通用原语。
 */

const AIRISH = new Set(['air', 'cave_air', 'void_air']);
const WATERISH = new Set(['water', 'bubble_column']);
const NOT_GROUND = new Set([...AIRISH, 'water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'lily_pad']);
const PASSABLE = new Set([...AIRISH, 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dandelion', 'poppy', 'snow']);

/** 有船的木种（bamboo 做的叫 bamboo_raft） */
const BOAT_WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo'] as const;
const boatOf = (w: string) => (w === 'bamboo' ? 'bamboo_raft' : `${w}_boat`);
export const isBoatItem = (n: string) => /_boat$|_raft$/.test(n) && !/chest_(boat|raft)$/.test(n);
const isBoatEntity = (n: string) => /(^|_)(boat|raft)$/.test(n);
/** 普通船（不含运输船 chest_boat：打碎会把箱子里的东西撒出来） */
const isPlainBoat = (n: string) => isBoatEntity(n) && !/chest_(boat|raft)$/.test(n);

type Ctx = SkillCtx;
type Inv = { name: string; count: number }[];
const countOf = (inv: Inv, n: string) => inv.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);

/** 按背包里的木料挑一种能凑齐 5 块同种木板的船；返回 null 表示不够 */
export function chooseBoat(inv: Inv): { item: string; planks: number } | null {
  let best: { item: string; planks: number; direct: number } | null = null;
  for (const w of BOAT_WOODS) {
    const direct = countOf(inv, `${w}_planks`);
    const logs = w === 'bamboo'
      ? countOf(inv, 'bamboo_block') * 2 + countOf(inv, 'stripped_bamboo_block') * 2
      : (countOf(inv, `${w}_log`) + countOf(inv, `stripped_${w}_log`) + countOf(inv, `${w}_wood`) + countOf(inv, `stripped_${w}_wood`)) * 4;
    const planks = direct + logs;
    if (planks < 5) continue;
    if (!best || (direct >= 5 ? 1 : 0) > (best.direct >= 5 ? 1 : 0) || planks > best.planks) best = { item: boatOf(w), planks, direct };
  }
  return best ? { item: best.item, planks: best.planks } : null;
}

const describeWood = (inv: Inv) => {
  const wood = inv.filter((i) => /_(planks|log|wood)$|^bamboo_block$/.test(i.name)).map((i) => `${i.name}×${i.count}`);
  return wood.length ? wood.join('、') : '没有任何木头';
};

const fluidAt = (ctx: Ctx, p: Vec3Like) => WATERISH.has(ctx.adapter.blockAt(p) ?? '');
/** 水面：水方块且上面是空气 */
export const isWaterSurface = (ctx: Ctx, p: Vec3Like) => fluidAt(ctx, p) && AIRISH.has(ctx.adapter.blockAt({ x: p.x, y: p.y + 1, z: p.z }) ?? 'air');
/** 周围 5×5 里有几格水面（衡量是不是一片开阔水域，而不是一个小水坑） */
export function openWater(ctx: Ctx, p: Vec3Like, r = 2): number {
  let n = 0;
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (isWaterSurface(ctx, { x: p.x + dx, y: p.y, z: p.z + dz })) n++;
  return n;
}

/** 能站人的格子：脚下实心、不是液体，脚和头两格可通过 */
export function standable(ctx: Ctx, p: Vec3Like): boolean {
  const below = ctx.adapter.blockAt({ x: p.x, y: p.y - 1, z: p.z });
  if (!below || NOT_GROUND.has(below)) return false;
  return [0, 1].every((dy) => PASSABLE.has(ctx.adapter.blockAt({ x: p.x, y: p.y + dy, z: p.z }) ?? 'air'));
}

/** 水面方块旁边、离自己最近的一块能站的岸边 */
export function shoreSpot(ctx: Ctx, water: Vec3Like, from: Vec3Like): Vec3Like | null {
  let best: { p: Vec3Like; d: number } | null = null;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [1, 2, 0]) {
    if (!dx && !dz) continue;
    const p = { x: water.x + dx, y: water.y + dy, z: water.z + dz };
    if (!standable(ctx, p)) continue;
    const d = Math.hypot(dx, dz) * 2 + dist3(p, from) * 0.2;
    if (!best || d < best.d) best = { p, d };
  }
  return best?.p ?? null;
}

/** 看得见的水面，优先朝 want 方向、开阔一些、近一些的 */
export function findWaterSurface(ctx: Ctx, maxDist: number, opts: { want?: { x: number; z: number }; minOpen?: number; shore?: boolean } = {}): BlockHit | null {
  ctx.senses.refresh();
  const here = ctx.adapter.state().pos;
  const hits = ctx.senses.knownBlocks(['water'], maxDist).filter((h) => isWaterSurface(ctx, h.pos));
  let best: { h: BlockHit; score: number } | null = null;
  for (const h of hits.slice(0, 400)) {
    const open = openWater(ctx, h.pos);
    if (open < (opts.minOpen ?? 4)) continue;
    // shore：只要旁边有能站人的岸（站在岸上放船/甩竿，不用先下水）
    if (opts.shore && !shoreSpot(ctx, h.pos, here)) continue;
    let score = h.dist;
    if (opts.want) {
      const vx = h.pos.x + 0.5 - here.x, vz = h.pos.z + 0.5 - here.z, len = Math.hypot(vx, vz) || 1;
      const cos = (vx * opts.want.x + vz * opts.want.z) / len;
      score -= cos * 6; // 朝着要去的方向的水面更好（不用回头绕）
    }
    score -= Math.min(open, 25) * 0.15;
    if (!best || score < best.score) best = { h, score };
  }
  return best?.h ?? null;
}

/** 把一个向量归到最近的 8 方位 */
export function nearestDir(vx: number, vz: number): string {
  let best = 'N', bestDot = -Infinity;
  const len = Math.hypot(vx, vz) || 1;
  for (const [k, [dx, dz]] of Object.entries(DIRS)) {
    const dot = (vx * dx + vz * dz) / len;
    if (dot > bestDot) { bestDot = dot; best = k; }
  }
  return best;
}

const parseXZ = (v: unknown): { x: number; z: number } | null | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'object') {
    const o = obj(v);
    return Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.z)) ? { x: Number(o.x), z: Number(o.z) } : null;
  }
  const m = String(v).match(/^\s*(-?\d+(?:\.\d+)?)[ ,]+(?:-?\d+(?:\.\d+)?[ ,]+)?(-?\d+(?:\.\d+)?)\s*$/);
  return m ? { x: +m[1], z: +m[2] } : null;
};

const footOverWater = (ctx: Ctx) => {
  const p = ctx.adapter.state().pos;
  const f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  return ctx.adapter.state().inWater || fluidAt(ctx, f) || fluidAt(ctx, { ...f, y: f.y - 1 });
};

/** 下船后脚下还是水：走/游到旁边最近的岸上 */
async function stepAshore(ctx: Ctx, heading: { x: number; z: number }) {
  if (!footOverWater(ctx)) return true;
  const p = ctx.adapter.state().pos;
  const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  let best: { p: Vec3Like; s: number } | null = null;
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, 1, -1]) {
    const q = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
    if (!standable(ctx, q)) continue;
    const s = Math.hypot(dx, dz) - (dx * heading.x + dz * heading.z) * 0.3; // 优先往前（对岸）
    if (!best || s < best.s) best = { p: q, s };
  }
  const land = best?.p ?? ctx.senses.nearestLand?.(p)?.pos ?? null;
  if (!land) return false;
  try {
    if (ctx.adapter.state().inWater && ctx.adapter.swimTo) await ctx.adapter.swimTo(land, ctx.signal, { timeoutMs: 12000 });
    else await ctx.adapter.moveTo({ kind: 'xyz', x: land.x, y: land.y, z: land.z }, { signal: ctx.signal, timeoutMs: 10000 });
  } catch (e) {
    if (isAbort(e)) throw e;
  }
  return !footOverWater(ctx);
}

/** 被取消时还坐在船上：用独立的信号尽量下船（原任务的信号已经中止了） */
async function bailOut(ctx: Ctx) {
  try {
    if (ctx.adapter.state().riding && ctx.adapter.dismount) await ctx.adapter.dismount(AbortSignal.timeout(4000));
  } catch { /* ignore */ }
}

/** 把靠岸的船打掉（1.20 里连打几下船就会碎成船物品），再把掉落的船捡回背包 */
async function retrieveBoat(ctx: Ctx, boatId: number | null, boatItems: () => number, boatPos: Vec3Like): Promise<{ kept: boolean; note: string }> {
  const { adapter, senses, signal } = ctx;
  const before = boatItems();
  const findBoat = () => {
    senses.refresh();
    const ents = senses.perceivedEntities(8);
    // 只打自己坐的那条；认不出 id 时（本来就坐在船上开始的）只认下船处 3 格内的普通船，别人的船/运输船不碰
    return ents.find((e) => e.id === boatId)
      ?? (boatId === null ? ents.filter((e) => e.kind !== 'item' && isPlainBoat(e.name) && dist3(e.pos, boatPos) <= 3).sort((a, b) => dist3(a.pos, boatPos) - dist3(b.pos, boatPos))[0] : undefined);
  };
  let boat: ReturnType<typeof findBoat> | undefined = findBoat();
  /** 低头看向脚边某处（掉落物很矮，平视看不到） */
  const lookToward = async (p: Vec3Like, h = 0.3) => {
    const eye = adapter.eye();
    if (!eye) return;
    const vx = p.x - eye.x, vz = p.z - eye.z, vy = p.y + h - eye.y;
    await adapter.look(Math.hypot(vx, vz) > 0.2 ? Math.atan2(-vx, -vz) : eye.yaw, Math.atan2(vy, Math.max(0.3, Math.hypot(vx, vz))), signal);
    await sleep(200, signal);
  };
  if (!boat) {
    // 上岸后船多半在身后：回头看一眼下船的地方
    await lookToward(boatPos);
    boat = findBoat();
  }
  if (!boat) return { kept: false, note: '下船处附近看不见自己的船，没去收' };
  try { await adapter.equipWeapon(signal); } catch (e) { if (isAbort(e)) throw e; }
  let hits = 0;
  let lastPos: Vec3Like = boat.pos;
  for (; hits < 16 && boat && Date.now() < ctx.deadline - 3000; hits++) {
    if (boat.dist > 2.8) {
      try { await adapter.moveTo({ kind: 'near', pos: boat.pos, range: 2 }, { signal, timeoutMs: 6000 }); } catch (e) { if (isAbort(e)) throw e; }
    }
    await adapter.attack(boat.id, signal);
    await sleep(300, signal); // 等攻击冷却，满蓄力的一下伤害才高
    const id = boat.id;
    lastPos = boat.pos;
    senses.refresh();
    boat = senses.perceivedEntities(8).find((e) => e.id === id);
  }
  if (boat) return { kept: false, note: `打了 ${hits} 下船还没碎，留在岸边了` };
  // 捡回掉落的船
  for (let i = 0; i < 4 && boatItems() <= before; i++) {
    await lookToward(lastPos, 0.1);
    senses.refresh();
    const drop = senses.perceivedEntities(10).find((e) => e.kind === 'item' && isBoatItem(e.name.replace(/^item:/, '')));
    if (!drop) { await adapter.collectNearbyDrops(signal, 6, 2000); continue; }
    try { await adapter.moveTo({ kind: 'near', pos: drop.pos, range: 1 }, { signal, timeoutMs: 6000 }); } catch (e) { if (isAbort(e)) throw e; }
  }
  return boatItems() > before ? { kept: true, note: '船已收回背包' } : { kept: false, note: '船打碎了但掉落物没捡到（可能漂走了）' };
}

// ------------------------------------------------------------------ boat
type BoatArgs = { to?: { x: number; z: number }; direction?: string; distance: number; until?: string; keep: boolean };

export const boat: Skill<BoatArgs> = {
  name: 'boat',
  description: '过河/渡湖/沿海岸远行时坐船：没船先用 5 块同种木板做一条，找水面放下坐上去划到目标，靠岸下船并把船收回背包；比游泳快且不会淹死',
  argsDoc: '{"to"?:"x,z","direction"?:"N|E|S|W|NE…","distance"?:8-240,"until"?,"keep"?}',
  timeoutMs: 180000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const direction = typeof a.direction === 'string' && a.direction.trim() ? a.direction.trim().toUpperCase() : undefined;
    if (direction && !DIRS[direction]) return { ok: false, error: `direction 必须是 ${Object.keys(DIRS).join('/')}` };
    const to = parseXZ(a.to);
    if (to === null) return { ok: false, error: 'to 的格式是 "x,z"' };
    const until = typeof a.until === 'string' && a.until.trim() ? a.until.trim().toLowerCase().slice(0, 80) : undefined;
    const keep = !(a.keep === false || a.keep === 'false');
    return { ok: true, args: { ...(to ? { to } : {}), ...(direction ? { direction } : {}), distance: clampInt(a.distance, 8, 240, 64), ...(until ? { until } : {}), keep } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    if (!adapter.ride || !adapter.useItemOn || !adapter.interactEntity || !adapter.dismount) return fail('ERROR', '当前适配器不支持坐船');
    const s0 = adapter.state();
    const boatItems = () => adapter.state().inventory.filter((i) => isBoatItem(i.name)).reduce((n, i) => n + i.count, 0);
    // 想去的方向（单位向量）：坐标 > 方位 > 稍后按找到的水面定
    const wantOf = (from: Vec3Like): { x: number; z: number } | undefined => {
      if (args.to) { const dx = args.to.x - from.x, dz = args.to.z - from.z, l = Math.hypot(dx, dz) || 1; return { x: dx / l, z: dz / l }; }
      if (args.direction) { const [dx, dz] = DIRS[args.direction]; return { x: dx, z: dz }; }
      return undefined;
    };
    let crafted: string | null = null;
    let boatId: number | null = null;
    let direction = args.direction;
    const notes: string[] = [];

    try {
      if (s0.riding && !isBoatEntity(s0.riding)) return fail('BAD_ARGS', `正在乘坐 ${s0.riding}，先 dismount 再坐船`);
      if (!s0.riding) {
        // ---- b) 准备一条船
        let item = adapter.state().inventory.find((i) => isBoatItem(i.name) && i.count > 0)?.name;
        if (!item) {
          const inv = adapter.state().inventory;
          const pick = chooseBoat(inv);
          if (!pick) return fail('MISSING_MATERIALS', `背包里没有船，也凑不齐做船的材料：一条船要 5 块同种木板（约 2 块同种原木），附近没工作台还要多 4 块木板；现有：${describeWood(inv)}`,
            { shortfall: '5 块同种木板（约 2 块同种原木）' });
          ctx.progress(0.05, `先用木板做一条 ${pick.item}`);
          const r = await craft.run(ctx, { item: pick.item, count: 1 });
          if (r.status !== 'succeeded') return fail(r.failureCode ?? 'MISSING_MATERIALS', `做船失败：${r.summary}`, r.data);
          item = adapter.state().inventory.find((i) => isBoatItem(i.name) && i.count > 0)?.name;
          if (!item) return fail('ERROR', `合成报告成功，但背包里没看到船（${r.summary}）`);
          crafted = item;
        }

        // ---- c) 找水面、走到岸边、放船、坐上去
        const here = adapter.state().pos;
        let water = findWaterSurface(ctx, 24, { want: wantOf(here), shore: !s0.inWater });
        if (!water && !s0.inWater) {
          ctx.progress(0.12, '四下找找水面');
          await lookAround.run(ctx, { seconds: 3, for: 'water', ...(direction ? { direction } : {}) });
          water = findWaterSurface(ctx, 24, { want: wantOf(adapter.state().pos), shore: true });
        }
        if (!water && s0.inWater) water = findWaterSurface(ctx, 6, { minOpen: 1 });
        if (!water) return fail('NOT_FOUND', `附近 24 格内看不见能放船的开阔水面${crafted ? `（船已经做好放在背包里：${crafted}）` : ''}`, crafted ? { crafted } : undefined);
        if (!direction && !args.to) direction = nearestDir(water.pos.x + 0.5 - here.x, water.pos.z + 0.5 - here.z);

        if (!adapter.state().inWater && dist3(adapter.state().pos, { x: water.pos.x + 0.5, y: water.pos.y + 0.5, z: water.pos.z + 0.5 }) > 3.5) {
          ctx.progress(0.2, `走到水边（${Math.round(water.dist)} 格）`);
          const spot = shoreSpot(ctx, water.pos, adapter.state().pos);
          try {
            if (spot) await adapter.moveTo({ kind: 'xyz', x: spot.x, y: spot.y, z: spot.z }, { signal, timeoutMs: Math.min(40000, Math.max(5000, ctx.deadline - Date.now() - 60000)) });
            else await adapter.moveTo({ kind: 'near', pos: water.pos, range: 2 }, { signal, timeoutMs: 30000 });
          } catch (e) {
            if (isAbort(e)) throw e;
            if (dist3(adapter.state().pos, water.pos) > 4.5) return fail(codeFromError(e) === 'ERROR' ? 'PATH_NOT_FOUND' : codeFromError(e), `走不到水边：${(e as Error).message}`);
          }
        }
        // 走到岸边后重新挑最近的水面放船（够得着）
        const near = findWaterSurface(ctx, 5, { want: wantOf(adapter.state().pos), minOpen: 2 }) ?? water;
        ctx.progress(0.3, `把 ${item} 放到水面上`);
        const knownBoats = new Set(ctx.senses.perceivedEntities(12).filter((e) => isBoatEntity(e.name)).map((e) => e.id));
        const before = boatItems();
        const placed = await adapter.useItemOn(item, { kind: 'block', pos: near.pos }, signal);
        const findNew = () => {
          ctx.senses.refresh();
          return ctx.senses.perceivedEntities(12).filter((e) => e.kind !== 'item' && isPlainBoat(e.name) && !knownBoats.has(e.id))
            .sort((a, b) => dist3(a.pos, near.pos) - dist3(b.pos, near.pos))[0];
        };
        let ent = findNew();
        for (let i = 0; !ent && i < 8; i++) { await sleep(250, signal); ent = findNew(); }
        if (!ent) {
          return fail('ERROR', `放船失败：${placed.ok ? '船没有出现在水面上' : placed.reason}${boatItems() < before ? '（背包里的船少了一条，可能放到别处了）' : ''}`);
        }
        boatId = ent.id;
        ctx.progress(0.38, '坐上船');
        let mounted = false;
        for (let attempt = 0; attempt < 3 && !mounted; attempt++) {
          ctx.senses.refresh();
          const cur = ctx.senses.perceivedEntities(12).find((e) => e.id === boatId) ?? ent;
          if (cur.dist > 2.8) {
            try { await adapter.moveTo({ kind: 'follow_entity', entityId: cur.id, range: 2 }, { signal, timeoutMs: 8000 }); } catch (e) { if (isAbort(e)) throw e; }
          }
          const r = await adapter.interactEntity(cur.id, null, signal);
          mounted = r.ok && !!adapter.state().riding;
          if (!mounted) await sleep(300, signal);
        }
        if (!mounted) return fail('ERROR', '船放下了但坐不上去（船还在水边，可以用 interact 再试）', { boatId });
      } else notes.push(`本来就坐在 ${s0.riding} 上`);

      // ---- d) 划船
      const start = adapter.state().pos;
      if (!direction && !args.to) {
        const w = findWaterSurface(ctx, 24, { minOpen: 4 });
        direction = w ? nearestDir(w.pos.x + 0.5 - start.x, w.pos.z + 0.5 - start.z) : undefined;
        if (!direction) { await bailOut(ctx); return fail('BAD_ARGS', '已经在船上，但没给 direction/to，前方也看不见水面'); }
      }
      const [dx, dz] = direction ? DIRS[direction] : [0, 0];
      const target = args.to ?? { x: start.x + dx * args.distance, z: start.z + dz * args.distance };
      const heading = (() => { const vx = target.x - start.x, vz = target.z - start.z, l = Math.hypot(vx, vz) || 1; return { x: vx / l, z: vz / l }; })();
      ctx.progress(0.45, `划船去 ${Math.round(target.x)},${Math.round(target.z)}`);
      let seen: { what: string; dist: number } | null = null;
      const r = await adapter.ride(target, signal, {
        timeoutMs: Math.max(3000, ctx.deadline - Date.now() - 25000), // 留时间靠岸、收船
        stop: () => { if (!args.until) return false; ctx.senses.refresh(); seen = sighted(ctx, args.until); return !!seen; },
      });
      const moved = Math.round(r.moved);
      const found = seen as { what: string; dist: number } | null;
      const how = found ? `看见 ${found.what}（${found.dist} 格外）停下` : r.arrived ? '到了目标附近' : r.blocked ? '前方靠岸/有障碍停下' : r.ok ? '停下' : `中途出问题（${r.reason}）`;

      // ---- e) 下船、上岸、收船
      ctx.progress(0.85, '下船');
      if (adapter.state().riding) {
        const d = await adapter.dismount(signal);
        if (!d.ok) return fail('ERROR', `划了 ${moved} 格（${how}），但下不了船：${d.reason}`, { moved });
      }
      const boatPos = adapter.state().pos;
      const ashore = await stepAshore(ctx, heading);
      if (!ashore) notes.push('下船处附近没找到能站的岸，还在水里');
      let kept = false;
      if (args.keep && ashore) {
        ctx.progress(0.92, '把船收回背包');
        const k = await retrieveBoat(ctx, boatId, boatItems, boatPos);
        kept = k.kept;
        notes.push(k.note);
      } else if (args.keep) notes.push('没上岸，船先不收');
      else notes.push('船留在岸边');
      if (crafted) notes.unshift(`先做了一条 ${crafted}`);
      const p = adapter.state().pos;
      const at = `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
      const data = { moved, landed: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, kept, ...(found ? { found: found.what } : {}), ...(r.arrived ? { arrived: true } : {}), ...(crafted ? { crafted } : {}) };
      if (!r.ok && moved < 3) return fail(r.reason === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR', `坐上船但没划动：${r.reason}；${notes.join('，')}`, data);
      return ok(`坐船划了 ${moved} 格，${how}，在 ${at} ${ashore ? '上岸' : '下船'}；${notes.join('，')}`, data);
    } catch (e) {
      if (isAbort(e)) { await bailOut(ctx); throw e; }
      await bailOut(ctx); // 任何出错路径都不能把自己留在船上（坐船时物理模拟是关着的）
      return fail(codeFromError(e), `坐船出错：${(e as Error).message}`);
    }
  },
};

export const vehicleSkills: Skill[] = [boat];

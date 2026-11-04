import { buildingArchiveFor } from './build.ts';
import { findStation, isStation } from './stations.ts';
import { AIR_BLOCKS, DIR_OFFSETS, LIQUID_BLOCKS, isSoftBlock, surroundings } from '../perception/surroundings.ts';
import { breakCell, climbUp, why } from './body.ts';
import { hasPlaceable, PLACEABLE } from './survival.ts';
import { DIRS, dirName } from '../perception/perception.ts';
import { dist3, sleep, throwIfAborted } from '../util.ts';
import type { EntityInfo, Vec3Like } from '../adapter/types.ts';
import { feetCell } from '../perception/local.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type FailureCode, type Skill, type SkillCtx, type SkillResult } from './types.ts';
import { planTravel } from './overland.ts';
import { passageDeepestAnchor, passageNearestNode, passageRoute, passageSurfaceAnchor } from '../memory/passages.ts';

// ------------------------------------------------------------------ 寻找与张望（人眼式：不透视，只是转头看）
/** 朝 (dx,dz) 方向的 yaw（0 = 北/-Z，正值向左/西） */
export const yawOfDir = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export const FOOD_ANIMAL_NAMES = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
/** 目标的类别写法：animal/food = 能吃的动物，hostile = 敌对生物 */
const CATEGORY: Record<string, string[]> = { animal: FOOD_ANIMAL_NAMES, animals: FOOD_ANIMAL_NAMES, food: FOOD_ANIMAL_NAMES, food_animal: FOOD_ANIMAL_NAMES };

/** target 是否已在视野/近期记忆中：方块（log、iron_ore…）或实体（cow、sheep…）；可写 "cow|sheep" 或类别 "animal" */
export function sighted(ctx: SkillCtx, target: string, options: { visibleOnly?: boolean; direction?: string } = {}): { what: string; dist: number; key: string; pos?: Vec3Like } | null {
  const here = ctx.adapter.state().pos;
  const sector = options.direction ? DIRS[options.direction] : null;
  const inDirection = (pos: Vec3Like) => !sector || Math.abs(Math.atan2(Math.sin(yawOfDir(pos.x - here.x, pos.z - here.z) - yawOfDir(...sector)),
    Math.cos(yawOfDir(pos.x - here.x, pos.z - here.z) - yawOfDir(...sector)))) <= 1.3;
  for (const raw of target.toLowerCase().split(/[|,，、/ ]+/).filter(Boolean)) {
    const wanted = CATEGORY[raw] ?? [raw];
    for (const t of wanted) {
      const names = ctx.adapter.resolveBlockNames(t).filter(Boolean);
      if (names.length) {
        const candidates = ctx.senses.knownBlocks(names, 96).filter((b) => inDirection({ x: b.pos.x + .5, y: b.pos.y, z: b.pos.z + .5 }));
        const hits = options.visibleOnly ? Array.from({ length: Math.ceil(candidates.length / 32) }, (_, index) =>
          ctx.senses.observeBlocks?.(candidates.slice(index * 32, (index + 1) * 32).map((b) => b.pos)) ?? []).flat() : candidates;
        const hit = hits.find((b) => names.includes(b.name));
        if (hit) return { what: hit.name, dist: Math.round(dist3(here, hit.pos)), key: `${hit.name}:${hit.pos.x},${hit.pos.y},${hit.pos.z}`, pos: hit.pos };
      }
    }
    const e = ctx.senses.perceivedEntities(48).find((x) => (!options.visibleOnly || x.perception === 'seen') && inDirection(x.pos)
      && wanted.some((t) => x.name === t || x.name.replace(/^player:/, '') === t || x.name.endsWith(`_${t}`)));
    if (e) return { what: e.name, dist: Math.round(e.dist), key: `entity:${e.id}`, pos: e.pos };
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
    const seen = until ? sighted(ctx, until, { visibleOnly: true }) : null;
    if (seen) return seen;
  }
  return null;
}

// ------------------------------------------------------------------ explore
/** 最近走不通的方向：2 分钟内降低优先级，避免对着大海/悬崖反复尝试 */
const failedDirs = new Map<string, number>();
const dirPenalty = (d: string) => (Date.now() - (failedDirs.get(d) ?? 0) < 120_000 ? 1 : 0);
const SEGMENT = 32;

/**
 * 找东西的“一趟搜寻”：像玩家在沙漠里找树那样，认准一个大方向一直走，而不是走几十格就掉头。
 * 记下这趟已经走了多远、离开始找的地方多远、朝哪个大方向，用来：不往已经搜过的地方走回头路、
 * 越找不到走得越远，并在结果里告诉模型进展。找到目标或 10 分钟没再找就结束。
 */
interface Search { key: string; worldId: string; dim: string; start: { x: number; z: number }; last: { x: number; z: number }; walked: number; legs: number; heading: string | null; ts: number }
const searches = new Map<string, Search>();
const searchKey = (until: string) => [...new Set(until.split('|').map((t) => t.trim()).filter(Boolean).map((t) => /_(log|wood)$|^log$|^wood$/.test(t) ? 'log' : t))].sort().join('|');
export function resetSearches() { searches.clear(); }
const ANGLE: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const turn = (a: string, b: string) => { const d = Math.abs((ANGLE[a] ?? 0) - (ANGLE[b] ?? 0)) % 360; return Math.min(d, 360 - d); };
/** 树极少的群系：找木头要走很远、一直朝一个方向走到群系边缘 */
const TREELESS = /desert|badlands|ocean|beach|snowy_plains|ice_spikes|mushroom|stony_shore/;
export const explore: Skill<{ direction: string; distance: number; until?: string }> = {
  name: 'explore',
  description: '朝新颖度最高（或指定）方向前进并沿途张望；until 一看见就停（可写 "cow|sheep" 或 "animal"）。接着找同一样东西时会认准大方向、不走回头路、越找走得越远',
  argsDoc: '{"direction"?: "auto|N|NE|E|SE|S|SW|W|NW", "distance"?: 24-160, "until"?: "<方块/生物，可用 | 分隔多个，或 animal>"}',
  timeoutMs: 90000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const direction = String(a.direction ?? 'auto').toUpperCase();
    if (direction !== 'AUTO' && !DIRS[direction]) return { ok: false, error: `direction 必须是 auto 或 ${Object.keys(DIRS).join('/')}` };
    const until = typeof a.until === 'string' && a.until.trim() ? a.until.trim().toLowerCase().slice(0, 80) : undefined;
    if (until && until.split('|').some((t) => /^(base|home|家|基地|bed|床)$/.test(t.trim()))) return { ok: false, error: 'until 只认看得见的方块或生物；回家用 goto {"target":"base"}，路不通就看【身边】local 一段段走，或用 goto 到中途某个坐标' };
    return { ok: true, args: { direction, distance: clampInt(a.distance, 24, 160, 64), ...(until ? { until } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    const s = adapter.state();
    if (!s.connected) return fail('NOT_CONNECTED', '未连接');
    // 指定了方向就只算那个方向上看见的（要往东找陆地，西边身后那片草地不算）
    const already = args.until ? sighted(ctx, args.until, { visibleOnly: true, ...(args.direction !== 'AUTO' ? { direction: args.direction } : {}) }) : null;
    const key = args.until ? searchKey(args.until) : '';
    if (already) {
      searches.delete(key);
      const at = already.pos;
      const where = at ? `，在 ${dirName(at.x - s.pos.x, at.z - s.pos.z)} 边 (${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)})` : '';
      // 水底的石头、对岸的草地也“看得见”：说清楚它泡在水里，别当成脚下就有
      const above = at ? adapter.blockAt({ x: Math.floor(at.x), y: Math.floor(at.y) + 1, z: Math.floor(at.z) }) : null;
      const underwater = above === 'water' ? '（它在水底，上面是水）' : '';
      return ok(`不用走远：已经看见 ${already.what} 就在 ${already.dist} 格外${where}${underwater}；这次没有走过去，要过去用 goto`, { found: already.what, dist: already.dist, moved: 0, ...(at ? { pos: at } : {}), ...(underwater ? { underwater: true } : {}) });
    }
    // 这趟搜寻的进展（同一世界/维度、10 分钟内接着找同一样东西才算同一趟）
    let search = key ? searches.get(key) : undefined;
    // 换了世界/维度、太久没接着找、或者人被挪到了别处（死亡复活、传送）：这趟搜寻就算结束了
    const jumped = search ? Math.hypot(s.pos.x - search.last.x, s.pos.z - search.last.z) > 48 : false;
    if (search && (search.worldId !== s.worldId || search.dim !== s.dim || Date.now() - search.ts > 10 * 60_000 || jumped)) { searches.delete(key); search = undefined; }
    if (key && !search) { search = { key, worldId: s.worldId, dim: s.dim, start: { x: s.pos.x, z: s.pos.z }, last: { x: s.pos.x, z: s.pos.z }, walked: 0, legs: 0, heading: null, ts: Date.now() }; searches.set(key, search); }
    const wood = key.split('|').includes('log');
    const notes: string[] = [];
    // 越找不到走得越远；在几乎没有树的群系里找木头，直接走远
    let distance = args.distance;
    if (search && search.legs >= 1) distance = Math.max(distance, Math.min(160, 64 + 32 * search.legs));
    if (wood && s.biome && TREELESS.test(s.biome)) distance = 160;
    // 沿整条路线看去过多少（不只看终点）：已经搜过的路线就别再走
    const visitedAlong = (dx: number, dz: number) => {
      let seen = 0, n = 0;
      for (let d = 16; d <= distance; d += 16) { n++; if (memory.chunkVisits(s.dim, s.pos.x + dx * d, s.pos.z + dz * d) > 0) seen++; }
      return n ? seen / n : 0;
    };
    // 看得见的地面是不是水（眼前的海/湖，像人站着就能看到）：只看 64 格内的地表，不透视地下
    const surfaceWater = (x: number, z: number) => {
      for (let y = Math.floor(s.pos.y) + 12; y >= Math.floor(s.pos.y) - 12; y--) {
        const b = adapter.blockAt({ x: Math.floor(x), y, z: Math.floor(z) });
        if (b === null || b === undefined) return null;
        if (b === 'air' || b === 'cave_air' || /leaves|grass$|fern|flower/.test(b)) continue;
        return b === 'water' || b === 'kelp' || b === 'seagrass' || b === 'tall_seagrass';
      }
      return null;
    };
    const waterAlong = (dx: number, dz: number) => {
      let wet = 0, n = 0;
      for (let d = 16; d <= Math.min(64, distance); d += 16) { const w = surfaceWater(s.pos.x + dx * d, s.pos.z + dz * d); if (w === null) continue; n++; if (w) wet++; }
      return n ? wet / n : 0;
    };
    const ranked = Object.entries(DIRS)
      .map(([d, [dx, dz]]) => {
        const visited = visitedAlong(dx, dz), wet = waterAlong(dx, dz);
        // 认准一个大方向：离上一趟方向越远越扣分，掉头（≥135°）扣得最多
        const momentum = search?.heading ? -turn(d, search.heading) / 180 * 0.6 : 0;
        return { d, dx, dz, visited, wet, n: memory.novelty(s.dim, s.pos.x + dx * distance, s.pos.z + dz * distance) * 0.5 + (1 - visited) - wet * 0.8 + momentum + Math.random() * 0.05 - dirPenalty(d) };
      })
      .sort((a, b) => b.n - a.n);
    let wanted = args.direction;
    if (wanted !== 'AUTO') {
      const asked = ranked.find((r) => r.d === wanted)!;
      const searched = !!search && search.legs >= 1 && asked.visited >= 0.6;
      // 要去的方向大半都搜过了，或者眼前一片水：换成离它最近、还没怎么去过、也不是水的方向（别绕圈、别下水）
      if (searched || asked.wet >= 0.75) {
        const alt = ranked.filter((r) => r.visited < 0.4 && r.wet < 0.5).sort((a, b) => turn(a.d, wanted) - turn(b.d, wanted) || b.n - a.n)[0];
        if (alt && turn(alt.d, wanted) <= 90) {
          notes.push(searched ? `${wanted} 方向这一路大多已经走过（没看到 ${args.until}），改往 ${alt.d}` : `${wanted} 方向眼前是一片水，改往 ${alt.d} 走陆路`);
          wanted = alt.d;
        }
      }
    }
    const order = wanted === 'AUTO' ? ranked : [ranked.find((r) => r.d === wanted)!, ...ranked.filter((r) => r.d !== wanted)];
    const chunksBefore = memory.visitedChunkCount;
    const start = s.pos;
    const movedNow = () => Math.round(Math.hypot(adapter.state().pos.x - start.x, adapter.state().pos.z - start.z));
    // 这一趟没找到：记下进展，告诉模型已经找了多远、离起点多远、朝哪个大方向，并给出像玩家那样的建议
    const progressNote = (dir: string) => {
      if (!search) return notes.length ? `（${notes.join('；')}）` : '';
      search.walked += movedNow(); search.legs++; search.heading = dir; search.ts = Date.now();
      const here = adapter.state().pos;
      search.last = { x: here.x, z: here.z };
      const net = Math.round(Math.hypot(here.x - search.start.x, here.z - search.start.z));
      const netDir = net >= 16 ? dirName(here.x - search.start.x, here.z - search.start.z) : '';
      const tips = [...notes, `为找 ${args.until} 这趟已经走了 ${search.walked} 格，离开始找的地方 ${net} 格${netDir ? `（朝 ${netDir}）` : ''}`];
      if (search.legs >= 2 && net < search.walked * 0.5) tips.push('一直在附近绕：认准一个方向（explore 用 auto 或同一方向）一口气走远');
      if (wood && s.biome && TREELESS.test(s.biome)) tips.push(`${s.biome} 里几乎没有树：沿同一方向一直走到群系边缘（看见草地、森林或河流）`);
      return `（${tips.join('；')}）`;
    };
    const done = (dir: string, partial: boolean) => ok(`向 ${dir} 探索${partial ? '了' : ''} ${movedNow()} 格${partial ? '（未完全到达）' : ''}，新区块 +${memory.visitedChunkCount - chunksBefore}${progressNote(dir)}`, { dir, moved: movedNow(), ...(search ? { search: { walked: search.walked, legs: search.legs } } : {}) });
    const found = (dir: string, f: { what: string; dist: number }) => { searches.delete(key); return ok(`向 ${dir} 走了 ${movedNow()} 格，看见 ${f.what}（${f.dist} 格外），停下`, { dir, moved: movedNow(), found: f.what, dist: f.dist }); };
    let seen: { what: string; dist: number } | null = null;
    // 边走边看：每段路上持续检查目标是否进入视野，一旦看见就停下（像人一样看到树就不再往前走）
    const prog = setInterval(() => {
      ctx.progress(Math.min(1, movedNow() / distance));
      if (args.until && !seen) {
        ctx.senses.refresh();
        seen = sighted(ctx, args.until, { visibleOnly: true });
        if (seen) stopWalk?.abort('target_seen');
      }
    }, 500);
    let stopWalk: AbortController | null = null;
    try {
      for (const cand of order.slice(0, 2)) {
        const tx = start.x + cand.dx * distance;
        const tz = start.z + cand.dz * distance;
        ctx.progress(0, `向 ${cand.d} 探索 ${distance} 格${args.until ? `，留意 ${args.until}` : ''}`);
        try {
          const segments = Math.max(1, Math.ceil(distance / SEGMENT));
          for (let k = 1; k <= segments; k++) {
            const f = Math.min(1, (k * SEGMENT) / distance);
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
          if (moved < distance * 0.3) failedDirs.set(cand.d, Date.now());
          if (moved >= distance * 0.5) return done(cand.d, true);
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
export const goTo: Skill<{ target: string; dig?: boolean; place?: boolean; tower?: boolean; sprint?: boolean; avoid?: string[]; lead?: string }> = {
  name: 'goto',
  description: '步行去地标或坐标；普通步行按可见或近期亲历的落脚点引导，明确三维坐标尽量进入指定格，进不去时停在相邻格并说明差多少。遇到已观察的木门会开门。默认不挖墙、不放方块；dig:true 兼容旧行为，允许挖掘、垫路，并默认允许原地搭柱爬坡（可 tower:false 关闭）。place:false 可禁止放置，tower:false 可禁止原地搭柱；也可单独设 place:true 授权垫路、tower:true 授权搭柱。搭建消耗方块，可能在水面架桥。lead 可带指定生物走。',
  argsDoc: '{"target":"<地标、坐标或方向>" 或 {"x":数字,"y":数字,"z":数字}, "dig"?:boolean, "place"?:boolean（允许垫路，默认继承 dig）, "tower"?:boolean（允许原地搭柱；dig:true 时默认开启，可 tower:false 关闭）, "sprint"?:boolean, "avoid"?:["方块名"], "lead"?:"生物名"}',
  timeoutMs: 600000,
  movement: true,
  validate(raw) {
    const target = obj(raw).target;
    const point = typeof target === 'object' && target !== null && !Array.isArray(target) ? target as Record<string, unknown> : null;
    const t = typeof target === 'string' ? target.trim()
      : point && [point.x, point.y, point.z].every((n) => typeof n === 'number' && Number.isFinite(n)) ? `${point.x},${point.y},${point.z}` : '';
    if (!t) return { ok: false, error: 'target 需要地标、坐标字符串或包含数字 x、y、z 的坐标对象' };
    for (const flag of ['dig', 'place', 'tower'] as const) if (obj(raw)[flag] !== undefined && typeof obj(raw)[flag] !== 'boolean') return { ok: false, error: `${flag} 需要布尔值` };
    if (obj(raw).tower === true && (obj(raw).place ?? obj(raw).dig) !== true) return { ok: false, error: 'tower:true 需要允许放置（place:true 或 dig:true）' };
    const avoid = Array.isArray(obj(raw).avoid) ? (obj(raw).avoid as unknown[]).map((n) => String(n).replace(/^minecraft:/, '')).filter((n) => /^[a-z_]+$/.test(n)).slice(0, 16) : [];
    const lead = typeof obj(raw).lead === 'string' ? String(obj(raw).lead).trim().toLowerCase().replace(/^minecraft:/, '') : '';
    if (obj(raw).lead !== undefined && !/^[a-z_]{2,40}$/.test(lead)) return { ok: false, error: 'lead 写生物名，比如 "cow"' };
    return { ok: true, args: { target: t, ...(obj(raw).dig === true ? { dig: true } : {}), ...(typeof obj(raw).place === 'boolean' ? { place: obj(raw).place as boolean } : {}), ...(typeof obj(raw).tower === 'boolean' ? { tower: obj(raw).tower as boolean } : {}), ...(obj(raw).sprint === true && !lead ? { sprint: true } : {}), ...(avoid.length ? { avoid } : {}), ...(lead ? { lead } : {}) } };
  },
  async run(ctx, args) {
    const r = await walkTo(ctx, args);
    const d = (r.data ?? {}) as { target?: Vec3Like; position?: Vec3Like; waterAhead?: boolean };
    // 走不通时反馈地形，不将步行委托自动升级为游泳或准备载具。
    if (r.status === 'failed' && r.failureCode === 'PATH_NOT_FOUND' && d.target && !/看地形/.test(r.summary)) {
      try {
        const here = ctx.adapter.state().pos;
        const plan = planTravel((p) => ctx.adapter.blockAt(p), here, d.target, { canBoat: false, maxNodes: 8000, margin: 16 });
        if (plan && !plan.reached && plan.why) {
          const climbHint = plan.climbed && args.place !== true && args.dig !== true ? '；可加 dig:true 授权挖墙和垫方块爬坡' : '';
          return { ...r, summary: `${r.summary}（看地形：${plan.why}${climbHint}）` };
        }
      } catch { /* 诊断不了就照原样 */ }
    }
    return r;
  },
};

/** goto 的步行部分 */
/** 带着走：动物只在手持它爱吃的东西、离人 10 格以内时才跟着来；人走得比它快，所以几格一停、掉队就等 */
const LEAD_HOP = 5, LEAD_CLOSE = 4, LEAD_LOST = 12, LEAD_WAIT_MS = 8000;

/** 被带的那只现在在哪：优先找同一个实体 id，找不到再按名字找最近的 */
function follower(ctx: SkillCtx, name: string, id: number | null): EntityInfo | null {
  const seen = ctx.senses.perceivedEntities(24).filter((e) => e.perception !== 'heard' && e.name === name);
  return (id !== null ? seen.find((e) => e.id === id) : undefined) ?? seen.sort((a, b) => a.dist - b.dist)[0] ?? null;
}

async function walkTo(ctx: SkillCtx, args: { target: string; dig?: boolean; place?: boolean; tower?: boolean; sprint?: boolean; avoid?: string[]; lead?: string }): Promise<SkillResult> {
  {
    const { adapter, memory, signal } = ctx;
    const allowPlace = args.place ?? !!args.dig, allowTower = allowPlace && (args.tower ?? !!args.dig);
    const terrainPermission = { ...(args.dig ? { allowTerrainChanges: true } : {}), allowPlace, allowTower };
    const s = adapter.state();
    let pos: { x: number; y: number; z: number } | null = null;
    let label = args.target;
    let flat = false; // 只给了 x,z：只管水平到达，高度随地形
    // 坐标写法很随意：(-3,90,-10)、x=-3 y=90 z=-10、-3 90 -10 都认；只有两个数时当作 x,z
    // 作品 ID（或前几位）先认：像 3f9a1b2c 这样的 ID 里也有数字，不能当坐标
    // “往东 20 格”：按方向和格数算出落点（东 x+、南 z+），免得自己算坐标算反
    const heading = args.target.trim().toUpperCase().match(/^(N|NE|E|SE|S|SW|W|NW)\s*(\d{1,3})$/);
    if (heading) {
      const [dx, dz] = DIRS[heading[1]];
      const n = Math.min(200, Number(heading[2])), len = Math.hypot(dx, dz) || 1;
      pos = { x: Math.round(s.pos.x + dx / len * n), y: s.pos.y, z: Math.round(s.pos.z + dz / len * n) };
      flat = true;
      label = `往 ${heading[1]} ${n} 格`;
    }
    const project = !heading && /^[0-9a-f-]{6,36}$/i.test(args.target) ? buildingArchiveFor(memory).list().find((p) => p.worldId === s.worldId && p.id.startsWith(args.target.toLowerCase())) : undefined;
    const nums = project || /[a-z\u4e00-\u9fa5]{2,}/i.test(args.target.replace(/\b[xyz]\s*[=:]/gi, '')) ? null : args.target.match(/-?\d+(?:\.\d+)?/g);
    const station = !nums && !project && /^[a-z_]+$/.test(args.target) && args.target !== 'base' && args.target !== 'death' && (isStation(args.target) || args.target === 'bed')
      ? findStation(ctx, args.target.endsWith('_bed') || args.target === 'bed' ? BED_NAMES : [args.target], 160) : null;
    if (heading) { /* 上面已经算好 */ }
    else if (nums && nums.length === 3) pos = { x: +nums[0], y: +nums[1], z: +nums[2] };
    else if (nums && nums.length === 2) { pos = { x: +nums[0], y: s.pos.y, z: +nums[1] }; flat = true; }
    else if (project) {
      if (project.dimension !== s.dim) return fail('WRONG_DIMENSION', `作品在 ${project.dimension}`);
      pos = project.origin;
      label = `作品 ${project.versions.at(-1)?.spec.name ?? project.id.slice(0, 8)}`;
    } else if (station) {
      pos = station.pos;
      label = `${station.from === 'memory' ? '记得的' : '看到的'} ${args.target}${station.radius ? ` 所在区域中心（半径约${station.radius}格，具体位置未确认）` : ''}`;
    } else if (args.target.toLowerCase() === 'death') {
      const d = memory.lastDeath();
      if (!d) return fail('NOT_FOUND', '没有记录的死亡地点');
      if (d.dim !== s.dim) return fail('WRONG_DIMENSION', `死亡地点在 ${d.dim}`);
      pos = d.pos;
      label = '死亡地点';
    } else {
      const lm = memory.findLandmark(args.target, s.dim);
      if (!lm) {
        const known = memory.landmarks().filter((l) => l.dim === s.dim && l.kind !== 'resource').slice(-8).map((l) => l.label);
        return fail('NOT_FOUND', `找不到地标：${args.target}${known.length ? `（记得的地标：${known.join('、')}；也可以直接写坐标）` : '（可以直接写坐标）'}`);
      }
      if (lm.dim !== s.dim) return fail('WRONG_DIMENSION', `地标 ${lm.label} 在 ${lm.dim}`);
      pos = lm.pos;
      // 写的是 base：把首选基地的名字带上，免得把“家”想成别的房子
      label = /^(base|基地)$/i.test(args.target.trim()) ? `${lm.label}（首选基地 base）` : lm.label;
    }
    if (!pos) return fail('BAD_ARGS', `看不懂目标：${args.target}`);
    // 明确坐标始终指向指定格，不替调用方改成方块上方的格子。
    if (nums && nums.length === 3 && !heading) {
      ctx.senses.refresh();
      const here = ctx.senses.observeBlocks?.([{ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }])[0]?.name;
      if (here && /lava/.test(here)) return fail('BAD_ARGS', `目标格 (${pos.x},${pos.y},${pos.z}) 是 ${here}，不能走进去；要去它旁边就写旁边那一格的坐标`);
    }
    const range = nums && !heading ? 0 : 2;
    const waterNames = ['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'];
    const waterNear = () => ctx.senses.knownBlocks(waterNames, 12).some((b) => waterNames.includes(adapter.blockAt(b.pos) ?? ''));
    const distance = (p: Vec3Like) => flat ? Math.hypot(p.x - pos!.x, p.z - pos!.z) : dist3(p, pos!);
    // 与 Pathfinder 的整数节点判定一致；明确坐标比“到地标附近”更精确。
    const arrived = (p: Vec3Like) => Math.hypot(Math.floor(p.x) - Math.floor(pos!.x), flat ? 0 : Math.floor(p.y) - Math.floor(pos!.y), Math.floor(p.z) - Math.floor(pos!.z)) <= range;
    const cell = (p: Vec3Like) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    const measured = (position = adapter.state().pos) => ({ target: pos, position, moved: dist3(s.pos, position),
      targetCell: cell(pos!), positionCell: cell(position), arrivedCell: Math.floor(position.x) === Math.floor(pos!.x)
        && Math.floor(position.z) === Math.floor(pos!.z) && (flat || Math.floor(position.y) === Math.floor(pos!.y)),
      ...(flat ? { horizontalOnly: true } : {}) });
    // 邻格只是实际进展，不代表已到达指定格；不推断未见目标的障碍。
    const nextTo = (p: Vec3Like) => !flat && !!nums && !heading && Math.max(Math.abs(Math.floor(p.x) - Math.floor(pos!.x)), Math.abs(Math.floor(p.y) - Math.floor(pos!.y)), Math.abs(Math.floor(p.z) - Math.floor(pos!.z))) <= 1;
    const doorNoteAt = () => {
      ctx.senses.refresh();
      const door = ctx.senses.observeBlocks?.([cell(pos!)])[0];
      const observedDoor = door?.source === 'vision' && door.worldId === s.worldId && door.dimension === s.dim && door.sessionId === s.sessionId
        && Math.abs(Date.now() - door.observedAt) <= 2000 && door.name.endsWith('_door') ? door : null;
      const open = observedDoor?.properties.open;
      // blockOptics 是禁用的透视接口，不能为诊断门板位置而调用它。
      const note = observedDoor && (open === true || open === false || open === 'true' || open === 'false')
        ? `；目标格看到 ${observedDoor.name}，门目前${String(open) === 'true' ? '打开' : '关闭'}，尚未确认它是否挡住路线` : '';
      return { note, observedDoor };
    };
    // 明确坐标那格走不进去（被挡/够不着）时，人已经停在相邻格：如实报告"到旁边了、差多少"，不算失败也不谎称进格。
    const arrivedNearby = (p: Vec3Like, why: string) => {
      const { note, observedDoor } = doorNoteAt();
      return ok(`到达 ${label} 附近：站在相邻格 (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})，差 ${distance(p).toFixed(2)} 格，没能进入目标格（${why}）${note}${terrainNote()}`, { ...measured(p), nextTo: true, arrivedNearby: true, ...(observedDoor ? { observedDoor } : {}) });
    };
    // 一步都没挪动、还贴着目标格：这是卡住，不是"到附近"，照旧报失败。
    const failedNear = (p: Vec3Like, why: string, code: FailureCode = 'PATH_NOT_FOUND') => {
      const { note, observedDoor } = doorNoteAt();
      return fail(code, `尚未到达 ${label} 的目标格：实际站在 (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})，紧挨着目标格，差 ${distance(p).toFixed(2)} 格（${why}）${note}${terrainNote()}`, { ...measured(p), nextTo: true, ...(observedDoor ? { observedDoor } : {}) });
    };
    const inScope = () => {
      throwIfAborted(signal);
      const now = adapter.state();
      return now.worldId === s.worldId && now.dim === s.dim && now.sessionId === s.sessionId;
    };
    const face = async () => {
      const eye = adapter.eye(), here = adapter.state().pos;
      const dx = pos!.x + 0.5 - here.x, dz = pos!.z + 0.5 - here.z;
      if (eye && Math.hypot(dx, dz) >= 0.75) {
        const yaw = yawOfDir(dx, dz);
        const turn = Math.abs(Math.atan2(Math.sin(yaw - eye.yaw), Math.cos(yaw - eye.yaw)));
        if (turn > 0.12 || Math.abs(eye.pitch + 0.18) > 0.15) {
          await adapter.look(yaw, -0.18, signal);
          await sleep(160, signal);
        }
      }
      ctx.senses.refresh();
    };
    const opened = new Set<string>();
    const tryDoor = async () => {
      if (!adapter.useBlockAt) return false;
      const names = adapter.resolveBlockNames('door').filter((n) => n.endsWith('_door') && n !== 'iron_door');
      const doors = ctx.senses.knownBlocks(names, 14).filter((d) => !opened.has(`${d.pos.x},${d.pos.y},${d.pos.z}`)
        && dist3(d.pos, pos!) < distance(adapter.state().pos) + 4);
      for (const door of doors.slice(0, 2)) {
        const key = `${door.pos.x},${door.pos.y},${door.pos.z}`;
        opened.add(key);
        const state = adapter.blockStateAt?.(door.pos);
        if (state?.properties.open === true || state?.properties.open === 'true') continue;
        if (state?.properties.half === 'upper') continue;
        try {
          ctx.progress(0, `沿门口接近 ${label}，打开 ${door.name}`);
          await adapter.moveTo({ kind: 'near', pos: door.pos, range: 3 }, { signal, timeoutMs: Math.max(1, Math.min(10000, ctx.deadline - Date.now())), constructionSafe: true, allowSwimming: false });
          if (!inScope()) return false;
          // 只操作亲眼看过/记得且仍是原来木门的方块，不把门当作采集材料。
          if (adapter.blockAt(door.pos) !== door.name) continue;
          const current = adapter.blockStateAt?.(door.pos)?.properties.open;
          if (current === true || current === 'true') { ctx.senses.refresh(); return true; }
          const result = await adapter.useBlockAt(door.pos, '', signal);
          if (result.ok) { await sleep(160, signal); ctx.senses.refresh(); return true; }
        } catch (e) { if (isAbort(e)) throw e; }
      }
      return false;
    };
    // dig 时寻路会挖开挡路的、在坑和水面上垫方块：走完要说清楚垫了多少、是不是一路架在水上（不然以为自己走在陆地上）
    const invBefore = new Map<string, number>();
    for (const i of s.inventory) invBefore.set(i.name, (invBefore.get(i.name) ?? 0) + i.count);
    const terrainNote = () => {
      if (!allowPlace) return '';
      const now = new Map<string, number>();
      for (const i of adapter.state().inventory) now.set(i.name, (now.get(i.name) ?? 0) + i.count);
      const used = [...invBefore].map(([n, c]) => [n, c - (now.get(n) ?? 0)] as const).filter(([n, d]) => d > 0 && PLACEABLE.includes(n));
      const end = adapter.state().pos, fx = Math.floor(end.x), fy = Math.floor(end.y), fz = Math.floor(end.z);
      const wet = (n: string | null) => !!n && waterNames.includes(n);
      const onBridge = wet(adapter.blockAt({ x: fx, y: fy - 2, z: fz })) || [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => wet(adapter.blockAt({ x: fx + dx, y: fy - 1, z: fz + dz }))).length >= 3;
      const placed = used.reduce((n, [, d]) => n + d, 0);
      if (!placed && !onBridge) return '';
      return `；沿途垫了 ${placed} 块（${used.map(([n, d]) => `${n}×${d}`).join('、') || '—'}）${onBridge ? '，现在脚下是垫在水上的方块、四周是水——这一路多半是在水面上架桥，不是陆地' : ''}`;
    };
    const startDist = distance(s.pos), alreadyHere = arrived(s.pos);
    const visited: Vec3Like[] = [s.pos];
    let bestDistance = startDist, detours = 0, memoryHops = 0;
    const prog = setInterval(() => ctx.progress(1 - Math.min(1, distance(adapter.state().pos) / Math.max(1, startDist))), 1000);
    // 稀疏历史脚点不是当前连通路线；本次只围绕指定目标选择落脚点。
    try {
      let leadId: number | null = null, leadWaited = 0;
      for (let hops = 0; !arrived(adapter.state().pos) && hops < (args.lead ? 400 : 160); hops++) {
        if (!inScope()) return fail('WRONG_DIMENSION', '途中世界或会话已改变，需要重新规划');
        if (Date.now() >= ctx.deadline) return fail('TIMEOUT', '步行时间已用完，按当前位置重新选择路线');
        await face();
        const cur = adapter.state().pos;
        // 带着走：每一小段之前先看它跟上没有，掉队就停下等；等不来就说清楚它最后在哪
        if (args.lead) {
          let f = follower(ctx, args.lead, leadId);
          if (f) leadId = f.id;
          const waitUntil = Date.now() + LEAD_WAIT_MS;
          while (f && f.dist > LEAD_CLOSE && Date.now() < waitUntil && Date.now() < ctx.deadline) {
            try { await adapter.look(Math.atan2(-(f.pos.x - cur.x), -(f.pos.z - cur.z)), 0, signal); } catch (e) { if (isAbort(e)) throw e; }
            await sleep(500, signal);
            f = follower(ctx, args.lead, leadId);
          }
          if (!f || f.dist > LEAD_LOST) {
            const held = adapter.state().held ?? '空手';
            const last = f ? `还在 ${f.dist.toFixed(0)} 格外的 (${Math.round(f.pos.x)},${Math.round(f.pos.y)},${Math.round(f.pos.z)}) 没跟上来` : '不在视野里了';
            return fail('TARGET_GONE', `带着走的 ${args.lead} ${last}（手里拿的是 ${held}；动物只在人手持它爱吃的东西、离它 10 格以内时才跟）；人走到 (${cur.x.toFixed(1)},${cur.y.toFixed(1)},${cur.z.toFixed(1)})，离目标还有 ${distance(cur).toFixed(0)} 格`, { ...measured(cur), lead: args.lead, leadPos: f?.pos ?? null });
          }
          if (f.dist > LEAD_CLOSE) { leadWaited++; if (leadWaited >= 3) return fail('TARGET_GONE', `带着走的 ${args.lead} 一直落在 ${f.dist.toFixed(0)} 格外不肯跟（手里拿的是 ${adapter.state().held ?? '空手'}）；人在 (${cur.x.toFixed(1)},${cur.y.toFixed(1)},${cur.z.toFixed(1)})，离目标还有 ${distance(cur).toFixed(0)} 格`, { ...measured(cur), lead: args.lead, leadPos: f.pos }); }
          else leadWaited = 0;
        }
        // dig：不找“看得见的落脚点”，直接让寻路朝目标走，挡路的土石挖开、坡坎垫方块（真人赶路也是这样）
        let waypoint = args.dig || allowPlace || args.lead ? null : ctx.senses.navigationWaypoint?.(pos, 12, visited);
        let fromMemory = false;
        if (ctx.senses.navigationWaypoint && !waypoint && !args.dig && !allowPlace && !args.lead) {
          if (await tryDoor()) continue;
          await glance(ctx);
          if (ctx.senses.navigationWaypoint(pos, 12, visited)) continue;
          // 眼前找不到路：像人一样沿着来时走过的地方往回挪（只用亲身站过的位置）
          const remembered = memoryHops < 12 ? ctx.senses.rememberedWaypoint?.(pos, 24, visited) : null;
          if (remembered) { waypoint = remembered; fromMemory = true; memoryHops++; }
        }
        if (ctx.senses.navigationWaypoint && !waypoint && !args.dig && !allowPlace && !args.lead) {
          const water = waterNear();
          return fail('PATH_NOT_FOUND', `前往 ${label}：眼前没有可确认的${water ? '陆地落脚点，附近有水' : '通路'}；没有挖墙或搭柱（可加 place:true 或 dig:true 授权垫路）`, { ...measured(cur), waterAhead: water });
        }
        const dxz = Math.hypot(pos.x - cur.x, pos.z - cur.z);
        const target = waypoint ? { kind: 'near' as const, pos: waypoint, range: fromMemory ? 1.2 : 0.7 }
          // 带着走：一次只挪几格，免得把它甩开
          : args.lead && dxz > LEAD_HOP ? { kind: 'xz' as const, x: cur.x + (pos.x - cur.x) * LEAD_HOP / dxz, z: cur.z + (pos.z - cur.z) * LEAD_HOP / dxz, range: 1.5 }
          : dxz > 32 ? { kind: 'xz' as const, x: cur.x + (pos.x - cur.x) * 24 / dxz, z: cur.z + (pos.z - cur.z) * 24 / dxz, range: 2 }
          : flat ? { kind: 'xz' as const, x: pos.x, z: pos.z, range } : { kind: 'near' as const, pos, range };
        try {
          await adapter.moveTo(target, { signal, timeoutMs: Math.max(1, Math.min(20000, ctx.deadline - Date.now())), allowSwimming: false, ...terrainPermission, ...(args.sprint ? { sprint: true } : {}), ...(args.avoid ? { avoid: args.avoid } : {}) });
        } catch (e) {
          if (isAbort(e) || (e as Error).name === 'PillarClearanceError') throw e;
          if (await tryDoor()) continue;
          // 记忆里的落脚点走不过去（被挡住、地形变了）：记下，换下一个
          if (fromMemory) { visited.push(waypoint!); continue; }
          throw e;
        }
        if (!inScope()) return fail('WRONG_DIMENSION', '途中世界或会话已改变，需要重新规划');
        const after = adapter.state().pos;
        if (fromMemory && dist3(cur, after) < 0.3 && !arrived(after)) { visited.push(waypoint!); continue; }
        if (arrived(after)) continue;
        if (dist3(cur, after) < 0.3 && !arrived(after)) {
          if (nextTo(after)) return failedNear(after, '没有取得进展');
          // 泡在水里时步行寻路不肯动（不游泳），一下就返回：说清楚是因为在水里
          const wet = adapter.state().inWater ? '；人泡在水里，步行寻路不游泳——先 surface 游上岸，或在脚下垫一块站出水面，再走' : '';
          return fail('PATH_NOT_FOUND', `前往 ${label} 没有取得进展，仍在 (${after.x.toFixed(2)},${after.y.toFixed(2)},${after.z.toFixed(2)})；尚未到达目标位置，需要换入口或路线${wet}`, measured(after));
        }
        if (distance(after) < bestDistance - 0.5) { bestDistance = distance(after); detours = 0; }
        else if (++detours >= (args.dig || allowPlace ? 6 : 4)) return nextTo(after) ? arrivedNearby(after, '绕了几次也没走进那一格') : fail('PATH_NOT_FOUND', `绕行后仍未接近 ${label}`, measured(after));
        visited.push(waypoint ?? after);
      }
      if (!inScope()) return fail('WRONG_DIMENSION', '途中世界或会话已改变，需要重新规划');
      const end = adapter.state().pos;
      if (!arrived(end)) return nextTo(end) ? arrivedNearby(end, '那一格没走进去') : fail('PATH_NOT_FOUND', `尚未到达 ${label}，需要重新选择路线`, measured(end));
      await face();
      if (args.lead) {
        const f = follower(ctx, args.lead, leadId);
        const note = f ? `带着的 ${args.lead} 在 ${f.dist.toFixed(0)} 格外 (${Math.round(f.pos.x)},${Math.round(f.pos.y)},${Math.round(f.pos.z)})` : `带着的 ${args.lead} 已不在视野里`;
        return ok(`到达 ${label}；人站在 (${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)})，${note}${terrainNote()}`, { ...measured(end), lead: args.lead, leadPos: f?.pos ?? null, leadDist: f?.dist ?? null });
      }
      return ok(`${alreadyHere ? '已在' : '到达'} ${label}${nums ? ' 的目标格' : ' 附近'}；实际站在 (${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)})，本次往 ${dirName(end.x - s.pos.x, end.z - s.pos.z)} 净位移 ${dist3(s.pos, end).toFixed(2)} 格，距目标点 ${distance(end).toFixed(2)} 格${alreadyHere ? '；没有执行新的位移' : ''}${terrainNote()}`, { ...measured(end), alreadyHere });
    } catch (e) {
      if (isAbort(e)) throw e;
      // 寻路报错（想太久、换路失败）时人可能已经走到了：先看看实际在哪，别把到了的当成没到
      const now = adapter.state().pos;
      if (inScope() && arrived(now)) { await face(); return ok(`到达 ${label}${nums ? ' 的目标格' : ' 附近'}；实际站在 (${now.x.toFixed(2)},${now.y.toFixed(2)},${now.z.toFixed(2)})，距目标点 ${distance(now).toFixed(2)} 格（寻路最后报了“${(e as Error).message.slice(0, 40)}”，但人已经到了）${terrainNote()}`, measured(now)); }
      if (inScope() && nextTo(now)) {
        const code = codeFromError(e);
        // 只有"没路可走"才当"到附近"；超时这类临时失败仍按原失败码报，别谎称到了
        return code === 'PATH_NOT_FOUND'
          ? arrivedNearby(now, `寻路报“${(e as Error).message}”，那一格没走进去`)
          : failedNear(now, `寻路报“${(e as Error).message}”，那一格没走进去`, code);
      }
      const water = waterNear();
      return fail(codeFromError(e), `前往 ${label} 失败：${(e as Error).message}${water ? '；附近有水，尚未确认干燥步行通路' : ''}`, {
        ...measured(), waterAhead: water,
        ...((e as Error).name === 'PillarClearanceError' ? { pillarClearance: true } : {}),
      });
    } finally {
      clearInterval(prog);
    }
  }
}

// ------------------------------------------------------------------ follow_passage
/** 沿自己记下的旧矿道（把全部通道连成网的脚点）逐段走：entrance 回地表入口，deepest 下到最深处。 */
export const followPassage: Skill<{ to: 'entrance' | 'deepest'; dig?: boolean }> = {
  name: 'follow_passage',
  description: '沿自己记下的旧矿道（全部通道连成网的脚点）逐段走：to:"entrance" 回地表入口，to:"deepest" 下到最深处。每段用步行寻路，dig:true 才允许挖开挡路、垫方块；走不通就停在原地并说明走到第几段、离目标还差多少',
  argsDoc: '{"to":"entrance"|"deepest", "dig"?:boolean}',
  timeoutMs: 600000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const to = a.to === 'deepest' ? 'deepest' : a.to === 'entrance' ? 'entrance' : null;
    if (!to) return { ok: false, error: 'to 必须是 entrance（回入口）或 deepest（下最深）' };
    if (a.dig !== undefined && typeof a.dig !== 'boolean') return { ok: false, error: 'dig 需要布尔值' };
    return { ok: true, args: { to, ...(a.dig === true ? { dig: true } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    const s = adapter.state();
    if (!s.connected) return fail('NOT_CONNECTED', '未连接');
    const here = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
    const recs = memory.passages(s.dim).filter((r) => !r.worldId || r.worldId === s.worldId);
    if (!recs.length) return fail('NOT_FOUND', '没有记下的旧矿道；要先下矿走过/挖过一段，或改用 goto / excavate_path');
    const back = args.to === 'entrance';
    const target = back ? passageSurfaceAnchor(recs, here) : passageDeepestAnchor(recs, here);
    if (!target) return fail('NOT_FOUND', '旧矿道里没有可用的目标点');
    const kind = recs.some((r) => r.kind === 'dug') ? '挖过的旧矿道' : recs.some((r) => r.kind === 'bridge') ? '我搭的桥' : '走过的路';
    const allowDig = !!args.dig;
    const terrainPermission = { ...(allowDig ? { allowTerrainChanges: true } : {}), allowPlace: allowDig, allowTower: allowDig };
    const goal = back ? '入口' : '最深处';
    let route = passageRoute(recs, here, target, { near: 6 });
    let start = here;
    // 离矿道网太远连不上：先走到最近的脚点把 agent 接回网里，再沿路由走；dig:true 才授权挖开挡路
    if (!route || route.length < 2) {
      const nearest = passageNearestNode(recs, start);
      if (!nearest) return fail('PATH_NOT_FOUND', `旧矿道连不到${back ? '地表入口' : '最深处'}（没有可接的脚点）；改走别的路`);
      const np = `${Math.round(nearest.x)},${Math.round(nearest.y)},${Math.round(nearest.z)}`;
      try {
        await adapter.moveTo({ kind: 'near', pos: nearest, range: 2 }, { signal, timeoutMs: Math.max(2000, Math.min(20000, ctx.deadline - Date.now())), allowSwimming: false, ...terrainPermission });
      } catch (e) {
        if (isAbort(e)) throw e;
        const now = adapter.state().pos;
        return fail('PATH_NOT_FOUND', `先走到最近的旧矿道脚点 (${np}) 没成（${(e as Error).message.slice(0, 50)}）。人停在 (${now.x.toFixed(1)},${now.y.toFixed(1)},${now.z.toFixed(1)})${allowDig ? '' : '；可加 dig:true 授权挖开挡路'}`);
      }
      start = adapter.state().pos;
      route = passageRoute(recs, start, target, { near: 6 });
      if (!route || route.length < 2) {
        const tgtNode = passageNearestNode(recs, target);
        const tgtStr = tgtNode ? `(${Math.round(tgtNode.x)},${Math.round(tgtNode.y)},${Math.round(tgtNode.z)})` : '未知位置';
        const gap = tgtNode ? Math.round(dist3(start, tgtNode)) : null;
        return fail('PATH_NOT_FOUND', `到了脚点 (${np}) 附近，但仍连不到${back ? '地表入口' : '最深处'}：离${goal}最近的旧矿道脚点在 ${tgtStr}，从你脚下直线约 ${gap ?? '未知'} 格（通道在这中间断开；可朝它垫/挖过去接上，或改走别的路）`);
      }
    }
    ctx.progress(0, `沿${kind}${back ? '回入口' : '下最深'}，共 ${route.length} 段`);
    let last = start;
    for (let i = 0; i < route.length; i++) {
      throwIfAborted(signal);
      if (Date.now() >= ctx.deadline) return fail('TIMEOUT', `沿${kind}${back ? '回入口' : '下最深'}走到第 ${i}/${route.length - 1} 段时间用完；人停在 (${last.x.toFixed(1)},${last.y.toFixed(1)},${last.z.toFixed(1)})，离目标约 ${Math.round(dist3(last, target))} 格`, { position: last, reachedWaypoint: i, totalWaypoints: route.length - 1 });
      const wp = route[i];
      if (dist3(last, wp) <= 1.2) continue;
      // 上 1 格台阶：两格高隧道里跳不起来。先把「起跳头顶」「新头」两格挖开（dig:true 才授权挖），再迈。
      const lc = feetCell(last);
      if (wp.y === lc.y + 1 && Math.abs(wp.x - lc.x) <= 1 && Math.abs(wp.z - lc.z) <= 1) {
        for (const h of [{ x: lc.x, y: lc.y + 2, z: lc.z }, { x: wp.x, y: wp.y + 1, z: wp.z }]) {
          const b = adapter.blockAt(h);
          if (b === null || AIR_BLOCKS.has(b) || isSoftBlock(b) || LIQUID_BLOCKS.has(b)) continue;
          if (!allowDig) {
            return fail('PATH_NOT_FOUND', `沿${kind}${back ? '回入口' : '下最深'}走到第 ${i}/${route.length - 1} 段：下一路点 (${Math.round(wp.x)},${Math.round(wp.y)},${Math.round(wp.z)}) 是 1 格上台阶，头顶 (${h.x},${h.y},${h.z}) 是 ${b}，两格高隧道里跳不上去；可加 dig:true 让我先挖开头顶再迈，或自己 dig_at 阶梯`, { position: last, reachedWaypoint: i, totalWaypoints: route.length - 1, blockedHead: h });
          }
          try {
            await breakCell(ctx, h);
          } catch (e) {
            if (isAbort(e)) throw e;
            const now = adapter.state().pos;
            return fail('PATH_NOT_FOUND', `沿${kind}${back ? '回入口' : '下最深'}走到第 ${i}/${route.length - 1} 段：要挖开头顶 (${h.x},${h.y},${h.z}) 迈上台阶，没成（${why(e)}）。人停在 (${now.x.toFixed(1)},${now.y.toFixed(1)},${now.z.toFixed(1)})`, { position: now, reachedWaypoint: i, totalWaypoints: route.length - 1, blockedHead: h });
          }
        }
      }
      ctx.progress(i / route.length, `沿${kind}${back ? '回入口' : '下最深'}：第 ${i}/${route.length - 1} 段`);
      try {
        await adapter.moveTo({ kind: 'near', pos: wp, range: 1.2 }, { signal, timeoutMs: Math.max(2000, Math.min(20000, ctx.deadline - Date.now())), allowSwimming: false, ...terrainPermission });
      } catch (e) {
        if (isAbort(e)) throw e;
        const now = adapter.state().pos;
        return fail('PATH_NOT_FOUND', `沿${kind}${back ? '回入口' : '下最深'}走到第 ${i}/${route.length - 1} 段卡住：下一路点 (${Math.round(wp.x)},${Math.round(wp.y)},${Math.round(wp.z)}) 过不去（${(e as Error).message.slice(0, 50)}）。人停在 (${now.x.toFixed(1)},${now.y.toFixed(1)},${now.z.toFixed(1)})，离${goal}约 ${Math.round(dist3(now, target))} 格${allowDig ? '' : '；可加 dig:true 授权挖开挡路'}`, { position: now, reachedWaypoint: i, totalWaypoints: route.length - 1, remaining: Math.round(dist3(now, target)), target });
      }
      last = adapter.state().pos;
    }
    const end = adapter.state().pos;
    const remaining = Math.round(dist3(end, target));
    // 下更深时：目标只取「从脚下连得上的最深处」，还有更深但互不相连的碎片要如实讲，别让 agent 以为全网最深已经到了
    const deeper = back ? '' : (() => {
      const g = passageDeepestAnchor(recs);
      return g && g.y < target.y - 2 ? `；还记着更深的旧矿道脚点 (${Math.round(g.x)},${Math.round(g.y)},${Math.round(g.z)})，和当前这段不连通，接不进去（要下去得先朝它垫/挖一段接上）` : '';
    })();
    return ok(`沿${kind}${back ? '回入口' : '下最深'}走完了记下的 ${route.length} 个脚点，现在站在 (${end.x.toFixed(1)},${end.y.toFixed(1)},${end.z.toFixed(1)})，离${goal}参考点约 ${remaining} 格（再往前没有记过的路，剩下的自己看）${deeper}`, { position: end, remaining, target, walkedWaypoints: route.length });
  },
};

const BED_NAMES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map((c) => `${c}_bed`);

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
  readOnly: true,
  description: '停下来专门找东西（for），或扫描某个方向（direction）；看见就停。已在视野里的目标不触发转头，扫描结束也不保证面朝扇区中心',
  argsDoc: '{"for"?: "<要找的方块或生物>", "direction"?: "N|NE|E|SE|S|SW|W|NW", "seconds"?: 2-20}',
  timeoutMs: 25000,
  movement: false,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const dir = typeof a.direction === 'string' ? a.direction.toUpperCase() : undefined;
    if (dir !== undefined && !DIRS[dir]) return { ok: false, error: `direction 必须是 ${Object.keys(DIRS).join('/')}` };
    const target = typeof a.for === 'string' && a.for.trim() ? a.for.trim().toLowerCase().slice(0, 40) : undefined;
    return { ok: true, args: { seconds: clampInt(a.seconds, 2, 20, 4), ...(target ? { for: target } : {}), ...(dir ? { direction: dir } : {}) } };
  },
  async run(ctx, args) {
    ctx.senses.refresh();
    const names = (args.for ?? '').split(/[|,，、/ ]+/).filter(Boolean).flatMap((raw) => CATEGORY[raw] ?? [raw])
      .flatMap((name) => ctx.adapter.resolveBlockNames(name));
    const priorKnown = new Set([...ctx.senses.knownBlocks(names, 96).map((b) => `${b.name}:${b.pos.x},${b.pos.y},${b.pos.z}`),
      ...ctx.senses.perceivedEntities(48).map((e) => `entity:${e.id}`)]);
    const observed = () => args.for ? sighted(ctx, args.for, { visibleOnly: true, direction: args.direction }) : null;
    const facts = (views: number, hit: ReturnType<typeof sighted> = null) => {
      const eye = ctx.adapter.eye();
      return { searched: views > 0, scanViews: views, turned: views > 0,
        ...(args.direction ? { direction: args.direction, directionInspected: views > 0 } : {}),
        alreadyVisible: views === 0 && !!hit, newlyDiscovered: !!hit && !priorKnown.has(hit.key),
        ...(eye ? { finalView: { yaw: eye.yaw, pitch: eye.pitch } } : {}),
        ...(hit ? { found: hit.what, dist: hit.dist, ...(hit.pos ? { foundPos: hit.pos } : {}), source: 'current_vision' } : {}) };
    };
    if (args.for) {
      const known = observed();
      if (known) return ok(`${args.direction ? `${args.direction} 方向` : '当前视野'}已看见 ${known.what}（${known.dist} 格外）；没有转头，也没有新的搜索发现`, facts(0, known));
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
        const f = observed();
        if (f) return ok(`${args.direction ? `${args.direction} 方向` : '转头后'}看见 ${f.what}（${f.dist} 格外）${priorKnown.has(f.key) ? '，是已知目标的当前观察' : '，本次新发现'}`, facts(k + 1, f));
      }
    }
    if (!sector) ctx.senses.markSweep();
    if (args.for) return fail('NOT_FOUND', `${args.direction ? `${args.direction} 方向` : '四周'}本次视野未见 ${args.for}；旧记忆不算本次看见，视野外或遮挡后的情况仍未知`, facts(yaws.length));
    return ok(args.direction ? `看了看 ${args.direction} 方向` : '环顾了一圈', facts(yaws.length));
  },
};

// ------------------------------------------------------------------ unstuck（仅反射层使用）
export const unstuck: Skill<{}> = {
  name: 'unstuck',
  description: '脱困：看看身边哪边能走就往哪边走；四面都被封住时垫方块往上爬出去',
  argsDoc: '{}',
  timeoutMs: 40000,
  movement: false,
  validate() {
    return { ok: true, args: {} };
  },
  async run(ctx) {
    const initial = ctx.adapter.state();
    if (initial.inWater) return fail('STUCK', `当前在水中，unstuck 没有执行移动；氧气 ${initial.oxygen}/20`,
      { pos: initial.pos, inWater: true, oxygen: initial.oxygen });
    const { adapter, signal } = ctx;
    const s = adapter.state();
    const around = surroundings(adapter, s.pos);
    // 先试身边能走的方向（像玩家看一眼往空处走），每个方向走 3 格
    for (const exit of around.exits) {
      const [dx, dz] = DIR_OFFSETS[exit.replace(/[↑↓]/, '')];
      const before = adapter.state().pos;
      try {
        await adapter.moveTo({ kind: 'xz', x: s.pos.x + dx * 3, z: s.pos.z + dz * 3, range: 1 }, { signal, timeoutMs: 5000 });
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      const p = adapter.state().pos;
      if (Math.hypot(p.x - before.x, p.z - before.z) + Math.abs(p.y - before.y) >= 1.5) return ok(`往 ${exit} 挪出来了｜${surroundings(adapter).text}`);
    }
    // 四面都走不了（坑底、竖井、被封住）：垫方块往上爬（头顶挡着会先挖开），爬到四周有路可走为止
    if (around.enclosed && hasPlaceable(adapter.state().inventory)) {
      ctx.progress(0.3, '四面被封住，垫方块往上爬');
      const r = await climbUp.run(ctx, { height: 12, untilSky: false, untilExit: true });
      if (r.status === 'succeeded' && (r.data as any)?.climbed > 0) return ok(`四面被封住，往上爬出来了：${r.summary}`);
    }
    await adapter.jump(600, signal);
    return fail('STUCK', `没能脱困｜${surroundings(adapter).text}`);
  },
};

// ------------------------------------------------------------------ surface（由 Agent 主动调用）
/** 一次有界上浮委托：只往上浮出水面换气，不找岸、不找气穴、不挖不垫、不换目标。 */
export const surface: Skill<{ timeout?: number }> = {
  name: 'surface',
  description: '只做一次有界上浮：按住上浮让头露出水面换气；不找岸、不找气穴、不挖不垫。浮出水面（surfaced）与站稳上岸（landed）分开报告，未浮出会如实说清位置与氧气',
  argsDoc: '{"timeout"?: 1000-30000（毫秒，本次上浮最多持续多久，可选）}',
  timeoutMs: 35000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    if (a.escape !== undefined) return { ok: false, error: 'surface 不再接受 escape："dig"|"shore"（自动挖顶/找气穴/寻岸超出委托）。要挖开头顶用 dig_at，要向指定岸边游用 swim_to {"xyz":[x,y,z]}，要持续按住上浮用 press_keys {"keys":{"jump":true},"ms":…}' };
    const timeout = a.timeout ?? a.timeoutMs;
    if (timeout !== undefined && (!Number.isFinite(Number(timeout)) || Number(timeout) < 1000 || Number(timeout) > 30000)) return { ok: false, error: 'timeout 必须是 1000–30000 的毫秒数' };
    return { ok: true, args: timeout !== undefined ? { timeout: Math.round(Number(timeout)) } : {} };
  },
  async run(ctx, args) {
    const a = ctx.adapter;
    if (!a.swimTo) return fail('STUCK', '当前适配器缺少持续游泳控制，不能确认已浮出水面');
    const s0 = a.state();
    if (!s0.inWater && s0.onGround) return ok('没在水里，已经站在干地上了', { landed: true, surfaced: true, pos: s0.pos });
    // 一次有界上浮委托：不选岸、不找气穴、不挖不垫、不换目标；surfaced（浮出水面）与 landed（站稳干地）分别报告。
    const timeoutMs = Math.max(300, Math.min(args.timeout ?? 20000, ctx.deadline - Date.now() - 1000));
    const r = await a.swimTo(null, ctx.signal, { timeoutMs });
    const s = a.state();
    const at = `现在在 (${s.pos.x.toFixed(1)},${s.pos.y.toFixed(1)},${s.pos.z.toFixed(1)})，氧气 ${s.oxygen}/20`;
    if (r.ok && r.landed) return ok(`上浮后已站稳干地，氧气 ${s.oxygen}/20`, { landed: true, surfaced: true, pos: s.pos, oxygen: s.oxygen });
    if (r.ok && r.surfaced) return ok(`头已稳定露出水面能呼吸了（氧气 ${s.oxygen}/20），还没上岸`, { landed: false, surfaced: true, pos: s.pos, oxygen: s.oxygen });
    const why = r.reason === 'WATER_ESCAPE_TIMEOUT' ? '上浮没把头露出水面' : r.reason === 'SWIM_NO_PROGRESS' ? '上浮没动' : r.reason;
    return fail('STUCK', `${why}；${at}`, { landed: false, surfaced: false, pos: s.pos, oxygen: s.oxygen, reason: r.reason });
  },
};

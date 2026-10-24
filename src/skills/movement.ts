import { buildingArchiveFor } from './build.ts';
import { findStation, isStation } from './stations.ts';
import { DIR_OFFSETS, surroundings } from '../perception/surroundings.ts';
import { climbUp } from './body.ts';
import { hasPlaceable } from './survival.ts';
import { DIRS, dirName } from '../perception/perception.ts';
import { dist3, sleep, throwIfAborted } from '../util.ts';
import type { Vec3Like } from '../adapter/types.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

// ------------------------------------------------------------------ 寻找与张望（人眼式：不透视，只是转头看）
/** 朝 (dx,dz) 方向的 yaw（0 = 北/-Z，正值向左/西） */
export const yawOfDir = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export const FOOD_ANIMAL_NAMES = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
/** 目标的类别写法：animal/food = 能吃的动物，hostile = 敌对生物 */
const CATEGORY: Record<string, string[]> = { animal: FOOD_ANIMAL_NAMES, animals: FOOD_ANIMAL_NAMES, food: FOOD_ANIMAL_NAMES, food_animal: FOOD_ANIMAL_NAMES };

/** target 是否已在视野/近期记忆中：方块（log、iron_ore…）或实体（cow、sheep…）；可写 "cow|sheep" 或类别 "animal" */
export function sighted(ctx: SkillCtx, target: string, options: { visibleOnly?: boolean; direction?: string } = {}): { what: string; dist: number; key: string } | null {
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
        const hits = options.visibleOnly ? (ctx.senses.observeBlocks?.(candidates.slice(0, 32).map((b) => b.pos)) ?? []) : candidates;
        const hit = hits.find((b) => names.includes(b.name));
        if (hit) return { what: hit.name, dist: Math.round(dist3(here, hit.pos)), key: `${hit.name}:${hit.pos.x},${hit.pos.y},${hit.pos.z}` };
      }
    }
    const e = ctx.senses.perceivedEntities(48).find((x) => (!options.visibleOnly || x.perception === 'seen') && inDirection(x.pos)
      && wanted.some((t) => x.name === t || x.name.replace(/^player:/, '') === t || x.name.endsWith(`_${t}`)));
    if (e) return { what: e.name, dist: Math.round(e.dist), key: `entity:${e.id}` };
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
    return { ok: true, args: { direction, distance: clampInt(a.distance, 24, 160, 64), ...(until ? { until } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, memory, signal } = ctx;
    const s = adapter.state();
    if (!s.connected) return fail('NOT_CONNECTED', '未连接');
    const already = args.until ? sighted(ctx, args.until) : null;
    const key = args.until ? searchKey(args.until) : '';
    if (already) { searches.delete(key); return ok(`不用走远：${already.what} 就在 ${already.dist} 格外`, { found: already.what, dist: already.dist, moved: 0 }); }
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
        seen = sighted(ctx, args.until);
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
export const goTo: Skill<{ target: string }> = {
  name: 'goto',
  description: '沿看得见的落脚点步行去地标、坐标、作品或记得的功能方块；绕开墙壁，遇到已观察的木门会开门，不自动挖墙、搭柱或架桥。水路不通时可另选 boat',
  argsDoc: '{"target": "base | death | <地标id或名称> | <作品ID> | crafting_table | x,y,z"}',
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
    let flat = false; // 只给了 x,z：只管水平到达，高度随地形
    // 坐标写法很随意：(-3,90,-10)、x=-3 y=90 z=-10、-3 90 -10 都认；只有两个数时当作 x,z
    // 作品 ID（或前几位）先认：像 3f9a1b2c 这样的 ID 里也有数字，不能当坐标
    const project = /^[0-9a-f-]{6,36}$/i.test(args.target) ? buildingArchiveFor(memory).list().find((p) => p.worldId === s.worldId && p.id.startsWith(args.target.toLowerCase())) : undefined;
    const nums = project || /[a-z\u4e00-\u9fa5]{2,}/i.test(args.target.replace(/\b[xyz]\s*[=:]/gi, '')) ? null : args.target.match(/-?\d+(?:\.\d+)?/g);
    const station = !nums && !project && /^[a-z_]+$/.test(args.target) && args.target !== 'base' && args.target !== 'death' && (isStation(args.target) || args.target === 'bed')
      ? findStation(ctx, args.target.endsWith('_bed') || args.target === 'bed' ? BED_NAMES : [args.target], 160) : null;
    if (nums && nums.length === 3) pos = { x: +nums[0], y: +nums[1], z: +nums[2] };
    else if (nums && nums.length === 2) { pos = { x: +nums[0], y: s.pos.y, z: +nums[1] }; flat = true; }
    else if (project) {
      if (project.dimension !== s.dim) return fail('WRONG_DIMENSION', `作品在 ${project.dimension}`);
      pos = project.origin;
      label = `作品 ${project.versions.at(-1)?.spec.name ?? project.id.slice(0, 8)}`;
    } else if (station) {
      pos = station.pos;
      label = `${station.from === 'memory' ? '记得的' : '看到的'} ${args.target}`;
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
      label = lm.label;
    }
    const range = nums ? 0 : 2;
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
    const startDist = distance(s.pos), alreadyHere = arrived(s.pos);
    const visited: Vec3Like[] = [s.pos];
    let bestDistance = startDist, detours = 0;
    const prog = setInterval(() => ctx.progress(1 - Math.min(1, distance(adapter.state().pos) / Math.max(1, startDist))), 1000);
    try {
      for (let hops = 0; !arrived(adapter.state().pos) && hops < 160; hops++) {
        if (!inScope()) return fail('WRONG_DIMENSION', '途中世界或会话已改变，需要重新规划');
        if (Date.now() >= ctx.deadline) return fail('TIMEOUT', '步行时间已用完，按当前位置重新选择路线');
        await face();
        const cur = adapter.state().pos;
        const waypoint = ctx.senses.navigationWaypoint?.(pos, 12, visited);
        if (ctx.senses.navigationWaypoint && !waypoint) {
          if (await tryDoor()) continue;
          await glance(ctx);
          if (ctx.senses.navigationWaypoint(pos, 12, visited)) continue;
          const water = waterNear();
          return fail('PATH_NOT_FOUND', `前往 ${label}：眼前没有可确认的${water ? '陆地落脚点，附近有水，可考虑 boat 渡河' : '通路，先换个观察位置或寻找入口'}；没有挖墙或搭柱`, { ...measured(cur), waterAhead: water });
        }
        const dxz = Math.hypot(pos.x - cur.x, pos.z - cur.z);
        const target = waypoint ? { kind: 'near' as const, pos: waypoint, range: 0.7 }
          : dxz > 32 ? { kind: 'xz' as const, x: cur.x + (pos.x - cur.x) * 24 / dxz, z: cur.z + (pos.z - cur.z) * 24 / dxz, range: 2 }
          : flat ? { kind: 'xz' as const, x: pos.x, z: pos.z, range } : { kind: 'near' as const, pos, range };
        try {
          await adapter.moveTo(target, { signal, timeoutMs: Math.max(1, Math.min(20000, ctx.deadline - Date.now())), allowSwimming: false });
        } catch (e) {
          if (isAbort(e)) throw e;
          if (await tryDoor()) continue;
          throw e;
        }
        if (!inScope()) return fail('WRONG_DIMENSION', '途中世界或会话已改变，需要重新规划');
        const after = adapter.state().pos;
        if (dist3(cur, after) < 0.3 && !arrived(after)) return fail('PATH_NOT_FOUND', `前往 ${label} 没有取得进展，仍在 (${after.x.toFixed(2)},${after.y.toFixed(2)},${after.z.toFixed(2)})；尚未到达目标位置，需要换入口或路线`, measured(after));
        if (distance(after) < bestDistance - 0.5) { bestDistance = distance(after); detours = 0; }
        else if (++detours >= 4) return fail('PATH_NOT_FOUND', `绕行后仍未接近 ${label}，需要观察入口或另选路线`, measured(after));
        visited.push(waypoint ?? after);
      }
      if (!inScope()) return fail('WRONG_DIMENSION', '途中世界或会话已改变，需要重新规划');
      const end = adapter.state().pos;
      if (!arrived(end)) return fail('PATH_NOT_FOUND', `尚未到达 ${label}，需要重新选择路线`, measured(end));
      await face();
      return ok(`${alreadyHere ? '已在' : '到达'} ${label}${nums ? ' 的目标格' : ' 附近'}；实际站在 (${end.x.toFixed(2)},${end.y.toFixed(2)},${end.z.toFixed(2)})，本次移动 ${dist3(s.pos, end).toFixed(2)} 格，距目标点 ${distance(end).toFixed(2)} 格${alreadyHere ? '；没有执行新的位移' : ''}`, { ...measured(end), alreadyHere });
    } catch (e) {
      if (isAbort(e)) throw e;
      const water = waterNear();
      return fail(codeFromError(e), `前往 ${label} 失败：${(e as Error).message}${water ? '；附近有水，尚未确认干燥步行通路，可沿岸绕行或用 boat 渡河' : ''}`, {
        ...measured(), waterAhead: water,
      });
    } finally {
      clearInterval(prog);
    }
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
  description: '停下来专门找东西（for），或只看某个方向（direction）；看见就停',
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
    const facts = (views: number, hit: ReturnType<typeof sighted> = null) => ({ searched: views > 0, scanViews: views,
      ...(args.direction ? { direction: args.direction, directionInspected: views > 0 } : {}),
      alreadyVisible: views === 0 && !!hit, newlyDiscovered: !!hit && !priorKnown.has(hit.key),
      ...(hit ? { found: hit.what, dist: hit.dist, source: 'current_vision' } : {}) });
    if (args.for) {
      const known = observed();
      if (known) return ok(`${args.direction ? `${args.direction} 方向` : '当前视野'}已看见 ${known.what}（${known.dist} 格外）；没有新的搜索发现`, facts(0, known));
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
    // Random horizontal pathfinding can sink back into the same water trap.
    if (ctx.adapter.state().inWater) return surface.run(ctx, {});
    const { adapter, signal } = ctx;
    const s = adapter.state();
    const around = surroundings(adapter, s.pos);
    // 先试身边能走的方向（像玩家看一眼往空处走），每个方向走 3 格
    for (const exit of around.exits) {
      const [dx, dz] = DIR_OFFSETS[exit.replace('↑', '')];
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

// ------------------------------------------------------------------ surface（仅反射层使用：防溺水）
type Vec = { x: number; y: number; z: number };
/** escape：同一处上浮失败过时反射层换的打法——dig=优先找气穴/往上挖，shore=让寻路带着往岸上走 */
export const surface: Skill<{ escape?: 'dig' | 'shore' }> = {
  name: 'surface',
  description: '被水困住时游上岸站稳',
  argsDoc: '{}',
  timeoutMs: 35000,
  movement: true,
  validate(raw) {
    const e = obj(raw).escape;
    return { ok: true, args: e === 'dig' || e === 'shore' ? { escape: e } : {} };
  },
  async run(ctx, args) {
    const end = Math.min(ctx.deadline, Date.now() + 32000);
    const excluded: Vec[] = [];
    let attempts = 0, scans = 0, pockets = 0, rises = 0, walks = 0, failedSwims = 0;
    // 打法在一次上浮里就会升级：先正常游；游两次没上岸或氧气 <6 → 找气穴/往上挖；再不行 → 让寻路往岸上走；轮完从头再来
    let tactic: 'swim' | 'dig' | 'shore' = args.escape ?? 'swim';
    const escalate = (why: string) => {
      const next = tactic === 'swim' ? 'dig' : tactic === 'dig' ? 'shore' : 'swim';
      notes.push(`${why}，改为${next === 'dig' ? '找气穴/往上挖' : next === 'shore' ? '让寻路往岸上走' : '重新游'}`);
      tactic = next; failedSwims = 0;
      if (next === 'dig') pockets = 0;
      if (next === 'shore') walks = 0;
    };
    if (!ctx.adapter.swimTo) return fail('STUCK', '当前适配器缺少持续游泳控制，不能确认已安全上岸');
    {
      const s0 = ctx.adapter.state();
      if (!s0.inWater && s0.onGround) return ok('没在水里，已经站在干地上了', { landed: true, pos: s0.pos });
    }
    let brokeCeiling = 0;
    const stubborn = new Set<string>(); // 挖不动的顶（没合适的工具/基岩）
    const notes: string[] = [];
    while (Date.now() < end) {
      ctx.signal.throwIfAborted();
      // 头顶被冰/石头封住时往上游没用：够得着就挖开（玩家在冰下、水洞里会这么做），够不着先往上游到够得着
      const lid = ceilingAbove(ctx);
      let sealed = false;
      if (lid) {
        const k = `${lid.pos.x},${lid.pos.y},${lid.pos.z}`;
        // 水下挖方块慢 5 倍（脚不着地再慢 5 倍）：附近有气穴就先游过去，比憋着气挖顶快
        const near = pockets < 3 ? findAirPocket(ctx) : null;
        if (near && near.steps <= 10) {
          pockets++;
          ctx.progress(0, `头顶是 ${lid.name}，旁边 ${near.steps} 格有气穴，先游过去换气`);
          const landed = await swimPath(ctx, near.path, end);
          if (landed) return ok(`游进气穴后上了岸，氧气 ${ctx.adapter.state().oxygen}/20`, { attempts, landed: true, pocket: near.pos });
          notes.push(`游向了 ${near.steps} 格外的气穴`);
          if (headInAir(ctx)) { await ctx.adapter.swimTo(null, ctx.signal, { timeoutMs: Math.max(300, Math.min(3000, end - Date.now())) }); }
          continue;
        }
        if (lid.reachable && !lid.unbreakable && !stubborn.has(k) && brokeCeiling < 6) {
          ctx.progress(0, `头顶是 ${lid.name}，挖开透气`);
          try {
            const r = await ctx.adapter.dig(lid.pos, ctx.signal);
            if (r.ok) { brokeCeiling++; continue; }
            stubborn.add(k);
          } catch (e) {
            if (isAbort(e)) throw e;
            stubborn.add(k);
          }
        } else if (!lid.reachable && rises < 3) {
          // 顶在头上好几格：先浮上去（一直按着跳），到了够得着的高度再挖
          rises++;
          ctx.progress(0, `往上游，头顶 ${Math.round(lid.pos.y - ctx.adapter.state().pos.y)} 格处是 ${lid.name}`);
          await ctx.adapter.swimTo(null, ctx.signal, { timeoutMs: 1500 });
          continue;
        }
        sealed = true;
      }
      if (tactic === 'swim' && ctx.adapter.state().oxygen < 6 && !sealed) escalate(`氧气只剩 ${ctx.adapter.state().oxygen}`);
      // 头已经在空气里（游进了气穴/水面）：原地按住上浮换气，别又游走
      // 头顶这一列本来就通到水面（没有封顶）时，“找气穴”就是直接往上浮：同样原地按住上浮
      if (tactic === 'dig' && (headInAir(ctx) || !lid)) {
        ctx.progress(0, headInAir(ctx) ? '头在空气里，原地换气' : '头顶通着水面，按住上浮换气');
        await ctx.adapter.swimTo(null, ctx.signal, { timeoutMs: Math.max(300, Math.min(3000, end - Date.now())) });
        const now = ctx.adapter.state();
        if (!now.inWater && now.onGround && now.oxygen >= 18) return ok(`换过气后已游上岸并站稳，氧气 ${now.oxygen}/20`, { attempts, landed: true, pos: now.pos });
        if (now.oxygen >= 18) escalate('气换足了');
        else if (!headInAir(ctx)) escalate('上浮没换到气');
        continue;
      }
      // 被封住（挖不开）或换打法时：找身边水里连着的气穴（相邻的水面/洞里的空气），游过去换气
      if ((sealed || tactic === 'dig') && pockets < 3) {
        const pocket = findAirPocket(ctx);
        if (pocket) {
          pockets++;
          ctx.progress(0, `头顶封住了，游向 ${pocket.steps} 格外的气穴换气`);
          const landed = await swimPath(ctx, pocket.path, end);
          if (landed) return ok(`游进气穴后上了岸，氧气 ${ctx.adapter.state().oxygen}/20`, { attempts, landed: true, pocket: pocket.pos });
          notes.push(`游向了 ${pocket.steps} 格外的气穴`);
          continue;
        }
        if (sealed) notes.push('头顶封住、身边没找到气穴');
        if (tactic === 'dig') escalate('身边没有气穴');
      } else if (tactic === 'dig') escalate('气穴都试过了');
      ctx.senses.refresh();
      const before = ctx.adapter.state();
      let land = ctx.senses.nearestLand?.(before.pos, excluded);
      // 换打法：直接让寻路往岸上走（会绕路、必要时挖开挡路的方块），而不是对着看得见却游不过去的岸直线游
      if (tactic === 'shore' && (!land || walks >= 2)) escalate(land ? '寻路上岸没成' : '看不到能走上去的岸');
      if (tactic === 'shore' && land && walks < 2) {
        walks++;
        ctx.progress(0, `让寻路带着往 ${land.dir} 的岸上走（${land.dist} 格）`);
        try {
          await ctx.adapter.moveTo({ kind: 'near', pos: { x: land.pos.x, y: land.pos.y + 1, z: land.pos.z }, range: 1 }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(9000, end - Date.now())) });
        } catch (e) {
          if (isAbort(e)) throw e;
        }
        const now = ctx.adapter.state();
        if (!now.inWater && now.onGround) return ok(`走上了岸，氧气 ${now.oxygen}/20`, { attempts, landed: true, pos: now.pos });
      }
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
      failedSwims++;
      if (tactic === 'swim' && (failedSwims >= 2 || ctx.adapter.state().oxygen < 6)) escalate(`游了 ${failedSwims} 次没上岸`);
      if (land) {
        attempts++;
        excluded.push(land.pos);
      } else {
        // The continuous primitive already turns while afloat. A new bounded
        // observation period can continue without inventing a destination.
        scans++;
      }
      // 氧气还在掉时不提前放弃：换个岸、找气穴，一直动到时间用完
      if ((attempts >= 4 || scans >= 8) && ctx.adapter.state().oxygen >= 14) break;
      if (attempts >= 4) { attempts = 0; excluded.length = 0; pockets = Math.min(pockets, 2); }
    }
    const s = ctx.adapter.state();
    // 没找到岸，但已经浮在水面、能正常呼吸：溺水危险已解除，交还给原来的事情（由它决定怎么离开水面）
    if (s.oxygen >= 18 && !ceilingAbove(ctx)) {
      const land = ctx.senses.nearestLand?.(s.pos, []);
      return ok(`浮在水面能正常呼吸了（氧气 ${s.oxygen}/20），还没上岸${land ? `；最近看到的陆地在 ${land.dir} ${land.dist} 格` : '；附近没看到能上岸的地方'}`,
        { attempts, landed: false, afloat: true, pos: s.pos, ...(brokeCeiling ? { brokeCeiling } : {}) });
    }
    return fail('STUCK', `尚未确认安全上岸，氧气 ${s.oxygen}/20${s.inWater ? '，仍在水中' : '，尚未站稳干地'}${notes.length ? `（${[...new Set(notes)].join('；')}）` : ''}`, { attempts, landed: false, pos: s.pos, ...(brokeCeiling ? { brokeCeiling } : {}) });
  },
};

/** 沿气穴路线分段游过去（游泳原语只会走直线，拐弯的水道要一段一段游）；上了岸返回 true */
async function swimPath(ctx: SkillCtx, path: Vec[], end: number): Promise<boolean> {
  const waypoints = path.filter((_, i) => i > 0 && (i % 3 === 0 || i === path.length - 1));
  for (const [i, w] of waypoints.entries()) {
    const last = i === waypoints.length - 1;
    const here = ctx.adapter.state().pos;
    const d = Math.hypot(w.x + 0.5 - here.x, w.y - here.y, w.z + 0.5 - here.z);
    const r = await ctx.adapter.swimTo!({ x: w.x + 0.5, y: w.y, z: w.z + 0.5 }, ctx.signal, { timeoutMs: Math.max(300, Math.min(end - Date.now(), last ? 4000 : 600 * d + 800)) });
    if (r.landed) return true;
    if (Date.now() >= end) break;
  }
  return false;
}

/** 眼睛所在的那一格是不是空气（已经能呼吸） */
function headInAir(ctx: SkillCtx): boolean {
  const s = ctx.adapter.state();
  return AIRS.has(ctx.adapter.blockAt({ x: Math.floor(s.pos.x), y: Math.floor(s.pos.y + 1.62), z: Math.floor(s.pos.z) }) ?? '');
}

const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const SWIMMABLE = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const AIRS = new Set(['air', 'cave_air', 'void_air']);
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate']);
/**
 * 人在水里时，头顶这一列往上看 24 格：先碰到空气 = 开阔水面（null）；先碰到实心方块 = 被封住，返回那一块
 * （reachable：站在水里伸手够得着，约 4.5 格内）。只看自己头顶这一列，是身边的物理环境，不算透视。
 */
export function ceilingAbove(ctx: SkillCtx): { name: string; pos: Vec; reachable: boolean; unbreakable: boolean } | null {
  const s = ctx.adapter.state();
  if (!s.inWater) return null;
  const x = Math.floor(s.pos.x), z = Math.floor(s.pos.z), feet = Math.floor(s.pos.y);
  for (let y = feet + 1; y <= feet + 24; y++) {
    const name = ctx.adapter.blockAt({ x, y, z }) ?? 'air';
    if (AIRS.has(name)) return null; // 头顶是开阔水面
    if (PASSABLE.has(name)) continue;
    return { name, pos: { x, y, z }, reachable: y + 0.5 - (s.pos.y + 1.62) <= 4, unbreakable: UNBREAKABLE.has(name) };
  }
  return null;
}

/**
 * 在身边连通的水里找最近的气穴：水面上方是空气的一格（或水道边能把头探进去的空气）。
 * 只沿着身体所在的水往外摸（有限范围的局部环境），不穿墙找。返回路线（水格序列，最后一格是能换气的空气）。
 */
export function findAirPocket(ctx: SkillCtx, radius = 8, maxNodes = 2500): { pos: Vec; steps: number; path: Vec[] } | null {
  const s = ctx.adapter.state();
  const ox = Math.floor(s.pos.x), oz = Math.floor(s.pos.z), feet = Math.floor(s.pos.y);
  const k = (p: Vec) => `${p.x},${p.y},${p.z}`;
  const name = (p: Vec) => ctx.adapter.blockAt(p);
  const prev = new Map<string, Vec | null>();
  const queue: Vec[] = [];
  for (const y of [feet, feet + 1]) {
    const p = { x: ox, y, z: oz };
    if (SWIMMABLE.has(name(p) ?? '')) { prev.set(k(p), null); queue.push(p); }
  }
  const pathTo = (end: Vec, from: Vec) => {
    const out: Vec[] = [end];
    let cur: Vec | null = from;
    while (cur) { out.push(cur); cur = prev.get(k(cur)) ?? null; }
    return out.reverse();
  };
  for (let i = 0; i < queue.length && prev.size < maxNodes; i++) {
    const cur = queue[i];
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
      const n = { x: cur.x + dx, y: cur.y + dy, z: cur.z + dz };
      if (prev.has(k(n)) || Math.hypot(n.x - ox, n.z - oz) > radius || n.y < feet - 4 || n.y > feet + 24) continue;
      const b = name(n);
      if (b === null) continue;
      if (AIRS.has(b)) {
        // 水面上方的空气，或水道旁边的空气（下面有东西托着头/身体）
        const under = name({ ...n, y: n.y - 1 });
        if (dy === 1 || (under !== null && !AIRS.has(under))) {
          return { pos: n, steps: pathTo(n, cur).length - 1, path: pathTo(n, cur) };
        }
        continue;
      }
      if (!SWIMMABLE.has(b)) continue;
      prev.set(k(n), cur);
      queue.push(n);
    }
  }
  return null;
}

import type { Vec3Like } from '../adapter/types.ts';
import { dist3 } from '../util.ts';
import { ride } from './actions.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

/**
 * 出行：步行与游泳的水陆寻路；已经乘船时委托水面导航，不隐式切换载具。
 * 这是身体的寻路能力（和 goto 的步行寻路一样是基础设施），不是战术：去哪、什么时候去由心智决定。
 * 只看已经加载的地形（服务器发来的、走过附近的区块），看不到的地方当作走不通，走到近处再重新规划。
 */

type BlockAt = (p: Vec3Like) => string | null;
export type Col = { kind: 'land' | 'water' | 'blocked'; y: number; why?: 'unloaded' | 'obstacle' | 'deep' };

const PASS = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'dandelion', 'poppy',
  'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'brown_mushroom', 'red_mushroom', 'torch', 'wall_torch', 'vine', 'glow_lichen', 'pink_petals', 'sugar_cane', 'sweet_berry_bush']);
const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const isLeaves = (n: string) => n.endsWith('_leaves');
const DANGER = /^(lava|fire|soul_fire|magma_block|cactus|campfire|soul_campfire|powder_snow)$/;

/** 一列地面：从 hintY 上方往下找第一块“实”的（树叶当树冠跳过），返回能站的高度，或水面高度 */
export function surveyColumn(blockAt: BlockAt, x: number, z: number, hintY: number): Col {
  let y = Math.floor(hintY) + 6;
  const at = (yy: number) => blockAt({ x, y: yy, z });
  // 起点在实心里（山坡更高）：往上找到空处
  for (let i = 0; i < 24; i++) {
    const n = at(y);
    if (n === null) return { kind: 'blocked', y: hintY, why: 'unloaded' };
    if (PASS.has(n) || isLeaves(n)) break;
    y++;
  }
  for (let i = 0; i < 40; i++, y--) {
    const n = at(y);
    if (n === null) return { kind: 'blocked', y: hintY, why: 'unloaded' };
    if (PASS.has(n) || isLeaves(n)) continue;
    if (WATER.has(n)) return { kind: 'water', y };
    if (DANGER.test(n) || /_log$|_wood$|_fence|_wall$|_fence_gate$/.test(n)) return { kind: 'blocked', y, why: 'obstacle' };
    const feet = at(y + 1), head = at(y + 2);
    if (feet === null || head === null || !PASS.has(feet) || !PASS.has(head)) return { kind: 'blocked', y: y + 1, why: 'obstacle' };
    return { kind: 'land', y: y + 1 };
  }
  return { kind: 'blocked', y: hintY, why: 'deep' };
}

export type Leg = { mode: 'walk' | 'water'; cells: { x: number; y: number; z: number }[] };
export type TravelPlan = { legs: Leg[]; reached: boolean; cells: number; /** 没到时：周围路走不通的主要原因（给身体和心智看） */ why?: string };

/**
 * 在已加载的地形上找一条水陆路线（A*，8 邻接，不切角）：
 * 走路每格 1、坡每高一格 +0.3、往下跳 2–3 格 +0.5；水里按调用方声明的乘船能力每格 1，游泳每格 2.5；
 * 上下水：从岸上下水落差不超过 3 格，从水里上岸岸边最多比水面高 1 格（游上去或从船上跳上去）。
 */
export function planTravel(blockAt: BlockAt, from: Vec3Like, to: { x: number; z: number }, opts: { canBoat: boolean; avoid?: Set<string>; maxNodes?: number; margin?: number }): TravelPlan | null {
  const key = (x: number, z: number) => `${x},${z}`;
  const cols = new Map<string, Col>();
  const col = (x: number, z: number, hint: number) => {
    const k = key(x, z);
    let c = cols.get(k);
    if (!c) { c = opts.avoid?.has(k) ? { kind: 'blocked', y: hint } : surveyColumn(blockAt, x, z, hint); cols.set(k, c); }
    return c;
  };
  const sx = Math.floor(from.x), sz = Math.floor(from.z), tx = Math.floor(to.x), tz = Math.floor(to.z);
  const start = col(sx, sz, from.y);
  // 起点：站在地上（脚下那列的地面就是自己站的高度）或者泡在水里
  if (start.kind === 'blocked' || (start.kind === 'land' && Math.abs(start.y - Math.floor(from.y)) > 2)) return null;
  const margin = opts.margin ?? 40;
  const minX = Math.min(sx, tx) - margin, maxX = Math.max(sx, tx) + margin, minZ = Math.min(sz, tz) - margin, maxZ = Math.max(sz, tz) + margin;
  const h = (x: number, z: number) => Math.hypot(x - tx, z - tz);
  type Node = { x: number; z: number; c: Col; g: number; f: number; parent: Node | null };
  const heap: Node[] = [];
  const push = (n: Node) => { heap.push(n); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) { heap[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };
  // 走不通的边记下原因（起点附近的单独记）：没到时告诉它“卡在哪类地形上”
  const rejNear = new Map<string, number>(), rejAll = new Map<string, number>();
  let nearNow = false;
  const no = (why: string) => { rejAll.set(why, (rejAll.get(why) ?? 0) + 1); if (nearNow) rejNear.set(why, (rejNear.get(why) ?? 0) + 1); return null; };
  const step = (a: Col, b: Col): number | null => {
    if (b.kind === 'blocked') return no(b.why === 'unloaded' ? 'unloaded' : b.why === 'deep' ? 'drop' : 'obstacle');
    if (a.kind === 'land' && b.kind === 'land') {
      const dy = b.y - a.y;
      if (dy > 1) return no('climb');
      if (dy < -3) return no('drop');
      return 1 + (dy > 0 ? 0.3 : dy < -1 ? 0.5 : 0);
    }
    if (a.kind === 'land' && b.kind === 'water') {
      const drop = a.y - (b.y + 1);
      if (drop < -1) return no('climb');
      if (drop > 3) return no('drop');
      return opts.canBoat ? 1 + 6 : 2.5;
    }
    if (a.kind === 'water' && b.kind === 'land') return b.y - (a.y + 1) <= 1 ? 1.5 : no('bank');
    return opts.canBoat ? 1 : 2.5; // 水里
  };
  const best = new Map<string, number>();
  const closed = new Set<string>();
  push({ x: sx, z: sz, c: start, g: 0, f: h(sx, sz), parent: null });
  let closest: Node | null = null, found: Node | null = null;
  for (let n = 0; heap.length && n < (opts.maxNodes ?? 60000);) {
    const cur = pop();
    const k = key(cur.x, cur.z);
    if (closed.has(k)) continue;
    closed.add(k); n++;
    if (!closest || h(cur.x, cur.z) < h(closest.x, closest.z)) closest = cur;
    if (h(cur.x, cur.z) <= 1.5 && cur.c.kind === 'land') { found = cur; break; }
    nearNow = Math.hypot(cur.x - sx, cur.z - sz) <= 2.5;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const nx = cur.x + dx, nz = cur.z + dz;
      if (nx < minX || nx > maxX || nz < minZ || nz > maxZ || closed.has(key(nx, nz))) continue;
      const c = col(nx, nz, cur.c.y);
      let cost = step(cur.c, c);
      if (cost === null) continue;
      if (dx && dz) {
        const a = col(cur.x + dx, cur.z, cur.c.y), b = col(cur.x, cur.z + dz, cur.c.y);
        if (a.kind === 'blocked' || b.kind === 'blocked') continue;
        cost *= Math.SQRT2;
      }
      const g = cur.g + cost;
      if (g >= (best.get(key(nx, nz)) ?? Infinity)) continue;
      best.set(key(nx, nz), g);
      push({ x: nx, z: nz, c, g, f: g + h(nx, nz), parent: cur });
    }
  }
  const end = found ?? closest;
  const why = found ? undefined : explainBlocked(end && Math.hypot(end.x - sx, end.z - sz) < 3 ? rejNear : rejAll, rejNear);
  if (!end || (end.x === sx && end.z === sz)) return { legs: [], reached: !!found, cells: 0, ...(why ? { why } : {}) };
  const path: Node[] = [];
  for (let n: Node | null = end; n; n = n.parent) path.push(n);
  path.reverse();
  const legs: Leg[] = [];
  for (const p of path.slice(1)) {
    const mode = p.c.kind === 'water' ? 'water' : 'walk';
    const cell = { x: p.x, y: p.c.y, z: p.z };
    if (legs.length && legs[legs.length - 1].mode === mode) legs[legs.length - 1].cells.push(cell);
    else legs.push({ mode, cells: [cell] });
  }
  return { legs, reached: !!found, cells: path.length - 1, ...(why ? { why } : {}) };
}

const WHY_ZH: Record<string, string> = {
  drop: '往下落差超过 3 格（悬崖、深坑，或者自己正站在高处/柱子上）', climb: '要一次往上爬 2 格以上（陡坡、高墙）',
  obstacle: '被树干、墙、栅栏、岩浆这类东西挡住', bank: '水边的岸比水面高 2 格以上，从水里上不去', unloaded: '再往前的地形还没加载（太远，走近了才看得到）',
};
/** 把被拒的边归成一两句话：起点附近四周都走不通时特别说明 */
function explainBlocked(rej: Map<string, number>, near: Map<string, number>): string | undefined {
  const top = [...rej].sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 0).slice(0, 2).map(([k]) => WHY_ZH[k]).filter(Boolean);
  if (!top.length) return undefined;
  const nearTotal = [...near.values()].reduce((a, b) => a + b, 0);
  const nearDrop = near.get('drop') ?? 0;
  if (nearTotal >= 6 && nearDrop / nearTotal > 0.6) return '脚下四周大多是 3 格以上的落差：你站在高处（柱子、悬崖边、自己垫的方块上），先找安全的办法下去（一级级挖台阶下、往水里跳、或者往下垫）';
  return `挡路的主要是：${top.join('；')}`;
}

// ------------------------------------------------------------------ travel
type TravelArgs = { to: string; noBoat?: boolean };

const parseTarget = (ctx: SkillCtx, raw: string): { x: number; y?: number; z: number; label: string } | null => {
  const nums = raw.match(/-?\d+(?:\.\d+)?/g);
  if (nums && !/[a-z一-龥]{2,}/i.test(raw.replace(/\b[xyz]\s*[=:]/gi, ''))) {
    if (nums.length === 3) return { x: +nums[0], y: +nums[1], z: +nums[2], label: `${nums[0]},${nums[1]},${nums[2]}` };
    if (nums.length === 2) return { x: +nums[0], z: +nums[1], label: `${nums[0]},${nums[1]}` };
  }
  const s = ctx.adapter.state();
  if (raw === 'death') { const d = ctx.memory.lastDeath(); return d && d.dim === s.dim ? { ...d.pos, label: '死亡地点' } : null; }
  const lm = ctx.memory.findLandmark(raw, s.dim);
  return lm && lm.dim === s.dim ? { ...lm.pos, label: /^(base|基地)$/i.test(raw.trim()) ? `${lm.label}（首选基地 base）` : lm.label } : null;
};

export const travel: Skill<TravelArgs> = {
  name: 'travel',
  description: '按地形步行和游泳前往目标；已乘船时沿水路停靠，保持乘坐并反馈落脚处，不制造或切换载具',
  argsDoc: '{"to": "x,z | x,y,z | 地标名 | base | death", "noBoat"?: true（只走和游，已乘船时需先自行下船）}',
  timeoutMs: 600000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const to = String(a.to ?? a.target ?? '').trim();
    if (!to) return { ok: false, error: 'to 不能为空' };
    return { ok: true, args: { to, ...(a.noBoat === true ? { noBoat: true } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    const target = parseTarget(ctx, args.to);
    if (!target) return fail('NOT_FOUND', `看不懂目标或找不到地标：${args.to}（写坐标 x,z 或记得的地标名）`);
    const s0 = adapter.state();
    const startPos = { ...s0.pos };
    const flat = (p: Vec3Like) => Math.hypot(p.x - target.x, p.z - target.z);
    if (s0.riding) {
      if (args.noBoat || !/(^|_)(boat|raft)$/.test(s0.riding)) return fail('BAD_ARGS', `正在乘坐 ${s0.riding}，此次出行不能使用当前载具；是否下船由你决定`);
      const result = await ride.run(ctx, { to: { x: target.x, z: target.z }, distance: 240 });
      if (result.status !== 'succeeded') return result;
      if (flat(adapter.state().pos) <= 2.5) return result;
      return fail('PATH_NOT_FOUND', `水路部分已停船，距 ${target.label} 还有 ${Math.round(flat(adapter.state().pos))} 格；${result.summary}`, { ...result.data, target });
    }
    const avoid = new Set<string>();
    const done: string[] = [];
    let walked = 0, swum = 0, replans = 0, lastErr = '';
    const blockAt: BlockAt = (p) => adapter.blockAt(p);
    try {
      for (let round = 0; round < 12 && Date.now() < ctx.deadline - 5000; round++) {
        const here = adapter.state().pos;
        if (flat(here) <= 2.5) break;
        const plan = planTravel(blockAt, here, target, { canBoat: false, avoid });
        if (!plan) return fail('PATH_NOT_FOUND', `travel 只管地面上的路：现在脚下不是地面（在地下、悬空或站不住），先回到地面再走；${done.length ? `已经${done.join('，')}` : ''}`);
        if (!plan.legs.length) { lastErr = lastErr || `看得到的地形里找不到更近的路：${plan.why ?? '远处没加载、或被墙/悬崖/岩浆挡住'}`; break; }
        if (!plan.reached && plan.why && round === 0) lastErr = `路只能规划到一半：${plan.why}`;
        ctx.progress(1 - Math.min(1, flat(here) / Math.max(1, flat(startPos))), `规划了 ${plan.legs.map((l) => `${l.mode === 'walk' ? '走' : '水'}${l.cells.length}`).join('→')}`);
        // 一次最多走 ~120 格，再按新看到的地形重新规划
        let budget = 120, failed = false;
        for (let i = 0; i < plan.legs.length && budget > 0 && !failed; i++) {
          const leg = plan.legs[i];
          const next = plan.legs[i + 1];
          if (leg.mode === 'walk') {
            for (let j = Math.min(leg.cells.length - 1, 9); ; j = Math.min(leg.cells.length - 1, j + 10)) {
              const c = leg.cells[j];
              const before = adapter.state().pos;
              try {
                await adapter.moveTo({ kind: 'near', pos: c, range: 1.2 }, { signal, timeoutMs: Math.max(1000, Math.min(20000, ctx.deadline - Date.now())), allowSwimming: false });
              } catch (e) {
                if (isAbort(e)) throw e;
                avoid.add(`${c.x},${c.z}`);
                lastErr = `走到 (${c.x},${c.y},${c.z}) 没走通：${(e as Error).message}`;
                failed = true; break;
              }
              const moved = dist3(before, adapter.state().pos);
              walked += moved; budget -= moved;
              if (j >= leg.cells.length - 1 || budget <= 0) break;
            }
          } else {
            const land = next?.cells[0] ?? leg.cells[leg.cells.length - 1];
            const before = adapter.state().pos;
            const r = adapter.swimTo ? await adapter.swimTo(land, signal, { timeoutMs: Math.min(20000, 3000 + leg.cells.length * 1500) }) : { ok: false, reason: 'NO_SWIM', landed: false, oxygen: 20 };
            swum += dist3(before, adapter.state().pos);
            if (!r.ok || !r.landed) { lastErr = `游过 ${leg.cells.length} 格水没上岸（${r.reason ?? '没站稳'}）`; avoid.add(`${land.x},${land.z}`); failed = true; }
            budget -= dist3(before, adapter.state().pos);
            failed = true; // 过完一段水就按新位置重新规划（岸那边的路这时才看得清）
          }
        }
        replans++;
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `出行途中出错：${(e as Error).message}`);
    }
    const end = adapter.state().pos;
    const left = Math.round(flat(end));
    const how = [walked > 1 ? `走了约 ${Math.round(walked)} 格` : '', swum > 1 ? `游了约 ${Math.round(swum)} 格` : ''].filter(Boolean).join('、') || '没怎么挪动';
    const at = `(${Math.round(end.x)},${Math.round(end.y)},${Math.round(end.z)})`;
    if (left <= 2.5) return ok(`到了 ${target.label} 附近 ${at}：${how}`, { walked: Math.round(walked), swum: Math.round(swum), replans });
    const closer = Math.round(flat(startPos) - left);
    return fail(closer > 4 ? 'TIMEOUT' : 'PATH_NOT_FOUND', `离 ${target.label} 还有 ${left} 格，现在在 ${at}（${how}，比出发时近了 ${closer} 格）${lastErr ? `；${lastErr}` : ''}`, { walked: Math.round(walked), swum: Math.round(swum), left, replans });
  },
};

export const overlandSkills = [travel];

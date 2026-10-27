import type { DriveKeys, Vec3Like } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import { facingOfYaw, feetCell } from '../perception/local.ts';
import { AIR_BLOCKS, isSoftBlock, LIQUID_BLOCKS } from '../perception/surroundings.ts';
import { SKILLS } from '../skills/index.ts';
import { LLM_HIDDEN } from '../skills/index.ts';
import type { SkillCtx } from '../skills/types.ts';
import { sleep, throwIfAborted } from '../util.ts';
import type { SandboxHandler } from './sandbox.ts';

/**
 * 代码技能能用的 api：身体感觉得到的东西 + 已有的动作。看方块只看身边（48 格内），没有透视的怪物列表。
 * 说明写在 skills/writing-skills/SKILL.md，模型写代码前会翻开。
 */
export const READ_RADIUS = 48;

/** 给模型看的 api 说明（写代码技能、后台改进时都用这一份） */
export const API_DOC = `代码是一个 async 函数体，参数 api 和 args 已经给好（args 是 use_skill 的 args；恢复时 args.failure = {skill,args,code,summary,target?,position} 是刚失败的那一步：target 是那一步实际要去/要动的坐标（动作算出来的，比如 goto "NW 20" 的落点），position 是失败时人在哪）。所有 api 调用都要 await，返回普通 JSON。
- api.state() → {pos, feet:{x,y,z}, hp, food, oxygen, onGround, inWater, inLava, isDay, dim, yaw, facing, held, inventory:[{name,count}]}
- api.blockAt(x,y,z) → {name, kind}；kind = open（空气、草、雪层，能穿过）| solid | liquid | unknown；只看得到身边 48 格
- api.region(x1,y1,z1,x2,y2,z2) → {min, size:[sx,sy,sz], palette:[名字], kinds:[同上], data:[下标]}；第 i 格：i = (y-min.y)*sx*sz + (z-min.z)*sx + (x-min.x)；最多 40000 格
- api.entities(半径≤32) → 看见/听见的实体 [{id,name,kind,dist,pos,fusing?}]（kind=item 的是掉落物，name 形如 item:cobblestone）
- api.drops(半径≤32) → 地上的掉落物 [{id,item,count?,pos,dist,seen,ageSec?}]：seen=true 是眼前看得见的；seen=false 是刚才亲眼见过、现在不在视野里（记得的位置，ageSec 秒前）。扔完东西核对“走开了没有、有没有被捡回来”就看这个
- api.nearestLand() → 最近亲眼见过的、能站的干地 {stand:{x,y,z} 站上去时脚的位置, dir, dist, dy 比脚高几格} 或 null（和 surface、上岸判断用的是同一个标准：脚下实心、上面两格是空气、不是水底）
- api.stepTo(x,y,z) 迈到相邻一格（平走、上一级、下一级）｜api.digAt(x,y,z)｜api.placeAt(x,y,z,"方块名|any") → {ok,code,summary}
- api.moveTo(x,y,z,range,{sprint,avoid}?) 用寻路走过去（默认走路；sprint:true 跑，快但很耗饥饿；avoid:["方块名"] 这一趟绕开这些方块）→ {ok,error?,pos}｜api.act("动作名",{参数}) 用已有动作（goto、dig_at、defend…）→ {ok,code,summary}
- api.useSkill("技能名",{args}?) 调用一份已经验证可靠的技能（reliable_skills 里列的，当积木用：先组合已经管用的，再补新的部分）→ {ok,code,summary}；最多套两层
- api.look(yaw,pitch)｜api.lookAt(x,y,z)｜api.sleep(毫秒≤5000)｜api.log(…) 记一句给自己看｜api.progress(0..1)
身体的细动作（打架、走位、躲闪都靠这些拼，怎么打由你决定）：
- api.move({forward,back,left,right,jump,sprint,sneak}, 毫秒≤1000, {face: 实体id 或 [x,y,z]}?) 按住这些键一小会儿，期间一直盯着 face → {ok, moved 走了几格, stopped?: "lava"|"cliff"}；
  前面是岩浆/火或一脚会摔 4 格以上，身体会自己停下（ok=false）；{unsafe:true} 关掉这个保护
- api.attack(实体id) 朝它挥一下（4 格内才打得到）→ {ok, sinceLastMs 距上次挥了多久}；挥得太勤伤害很低：剑约 625ms、斧约 1000ms、空手 250ms 才恢复满
- api.equip(物品名, "hand"|"off-hand"|"head"|"torso"|"legs"|"feet")｜api.shield(true/false) 举起/放下副手的盾（要先把 shield equip 到 off-hand；举着时走得慢、挡正面的近战和箭）
- api.draw("bow"|"crossbow"|"trident") 开始蓄力 → api.release([x,y,z]?) 转向那一点松手 → {ok, chargedMs}；弓蓄 1000ms 以上才是满力，远处要往上抬（箭会下坠）
- api.shoot(实体id) 身体按经验估好提前量和下坠、拉满弓射一箭（慢但省事）
- api.state() 还有 offHand、armor、usingItem（在举盾/拉弓）、hurtAgoMs（距上次挨打多久）、deathDrop（死后掉在地上还没捡回的东西：{pos,dim,items,secondsLeft} 或 null）
- api.entities(r) 每个还有 velocity（每 tick 移动，正在冲过来就看得出）、height、hp（看得到时）
规则：只能用 api 和普通 JavaScript（不能 require/import/eval）；循环要有出口（每次唤醒最多 1.5 秒同步计算，总共最多 12000 次 api 调用）；做成 return 一个结果，做不成 throw new Error("原因")。`;
const MAX_REGION = 40_000;

const int = (v: unknown, name: string) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} 要是数字`); return Math.floor(n); };
export const kindOf = (name: string | null): 'open' | 'solid' | 'liquid' | 'unknown' =>
  name === null ? 'unknown' : LIQUID_BLOCKS.has(name) ? 'liquid' : AIR_BLOCKS.has(name) || isSoftBlock(name) ? 'open' : 'solid';

/** 每条总线上最近一次挨打的时刻（代码技能读 hurtAgoMs 用） */
const hurtClock = new WeakMap<EventBus, { at: number }>();
function hurtAt(bus: EventBus): number {
  let c = hurtClock.get(bus);
  if (!c) {
    const clock = { at: 0 };
    hurtClock.set(bus, clock);
    bus.on('event', (ev: { type: string; ts?: number }) => { if (ev.type === 'hurt') clock.at = ev.ts ?? Date.now(); });
    c = clock;
  }
  return c.at;
}
let lastSwingAt = 0;
const point = (v: unknown, name: string): Vec3Like => {
  const a = Array.isArray(v) ? v : v && typeof v === 'object' ? [(v as any).x, (v as any).y, (v as any).z] : null;
  if (!a || a.length < 3 || !a.slice(0, 3).every((n) => Number.isFinite(Number(n)))) throw new Error(`${name} 要写 [x,y,z]`);
  return { x: Number(a[0]), y: Number(a[1]), z: Number(a[2]) };
};
const need = <T>(fn: T | undefined, what: string): T => { if (!fn) throw new Error(`这个身体做不了：${what}`); return fn; };

/** 哪些技能可靠到能被别的代码技能当积木调用（行为引擎登记；返回 null = 可以） */
let reliableCheck: ((name: string) => string | null) | null = null;
export function setReliableSkills(fn: ((name: string) => string | null) | null) { reliableCheck = fn; }
export const MAX_SKILL_DEPTH = 2;

export function makeBridge(ctx: SkillCtx): SandboxHandler {
  hurtAt(ctx.bus); // 开始记挨打时刻
  const near = (p: Vec3Like) => {
    const s = ctx.adapter.state().pos;
    if (Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) > READ_RADIUS) throw new Error(`只看得到身边 ${READ_RADIUS} 格内的方块`);
  };
  /** 绝对坐标 → 以脚为原点、面朝北的 [前,上,右]（给 step/dig_at/place_at 用） */
  const rel = (x: number, y: number, z: number): [number, number, number] => { const f = feetCell(ctx.adapter.state().pos); return [f.z - z, y - f.y, x - f.x]; };
  const runSkill = async (name: string, args: unknown) => {
    const skill = SKILLS[name];
    if (!skill || LLM_HIDDEN.has(name) || name === 'use_skill') throw new Error(`没有 "${name}" 这个动作（代码里不能再调用 use_skill）`);
    const v = skill.validate(args ?? {}, ctx.adapter);
    if (!v.ok) throw new Error(`${name} 参数错误：${v.error}`);
    throwIfAborted(ctx.signal);
    const r = await skill.run({ ...ctx, deadline: Math.min(ctx.deadline, Date.now() + skill.timeoutMs), progress: () => {} }, v.args);
    if (r.status === 'cancelled') throw Object.assign(new Error('task cancelled'), { name: 'AbortedError' });
    return { ok: r.status === 'succeeded', code: r.failureCode ?? null, summary: r.summary.slice(0, 200) };
  };
  return async (method, a) => {
    throwIfAborted(ctx.signal);
    switch (method) {
      case 'state': {
        const s = ctx.adapter.state();
        const eye = ctx.adapter.eye();
        const combat = ctx.adapter.combatState?.() ?? { usingItem: false, offHand: null, drawingSinceMs: null };
        const hurt = hurtAt(ctx.bus);
        let deathDrop: unknown = null;
        try {
          const d = ctx.memory.lastDeath();
          const left = d ? Math.round((d.ts + 300_000 - Date.now()) / 1000) : 0;
          if (d && d.lost.length && left > 0) deathDrop = { pos: d.pos, dim: d.dim, items: d.lost.map((i) => ({ name: i.name, count: i.count })), secondsLeft: left };
        } catch { /* 记忆暂不可用 */ }
        return { pos: s.pos, feet: feetCell(s.pos), hp: Math.round(s.hp * 10) / 10, food: s.food, oxygen: s.oxygen, onGround: s.onGround !== false, inWater: s.inWater, inLava: s.inLava,
          isDay: s.isDay, dim: s.dim, yaw: eye?.yaw ?? null, pitch: eye?.pitch ?? null, facing: eye ? facingOfYaw(eye.yaw) : null, held: s.held,
          offHand: combat.offHand, armor: (s.equipment ?? []).filter((e) => e.slot !== 'off-hand').map((e) => ({ slot: e.slot, name: e.name })),
          usingItem: combat.usingItem, drawingMs: combat.drawingSinceMs, hurtAgoMs: hurt ? Date.now() - hurt : null, deathDrop,
          inventory: s.inventory.map((i) => ({ name: i.name, count: i.count })) };
      }
      case 'blockAt': {
        const p = { x: int(a[0], 'x'), y: int(a[1], 'y'), z: int(a[2], 'z') };
        near(p);
        const name = ctx.adapter.blockAt(p);
        return { name, kind: kindOf(name) };
      }
      case 'region': {
        const [x1, y1, z1, x2, y2, z2] = a.slice(0, 6).map((v, i) => int(v, 'xyzxyz'[i]));
        const min = { x: Math.min(x1, x2), y: Math.min(y1, y2), z: Math.min(z1, z2) }, max = { x: Math.max(x1, x2), y: Math.max(y1, y2), z: Math.max(z1, z2) };
        const size = [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1];
        if (size[0] * size[1] * size[2] > MAX_REGION) throw new Error(`region 最多 ${MAX_REGION} 格（现在 ${size.join('×')}）`);
        near(min); near(max);
        const palette: string[] = [], kinds: string[] = [], index = new Map<string, number>(), data: number[] = [];
        // 顺序：x 最快，然后 z，最后 y：i = (y-min.y)*sx*sz + (z-min.z)*sx + (x-min.x)
        for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) for (let x = min.x; x <= max.x; x++) {
          const name = ctx.adapter.blockAt({ x, y, z }) ?? '?';
          let i = index.get(name);
          if (i === undefined) { i = palette.length; index.set(name, i); palette.push(name); kinds.push(kindOf(name === '?' ? null : name)); }
          data.push(i);
        }
        return { min, size, palette, kinds, data };
      }
      case 'entities': {
        const r = Math.max(1, Math.min(32, Number(a[0]) || 16));
        const r2 = (v: number) => Math.round(v * 100) / 100;
        return ctx.senses.perceivedEntities(r).map((e) => ({ id: e.id, name: e.name, kind: e.kind, dist: Math.round(e.dist * 10) / 10, pos: e.pos,
          ...(e.perception ? { how: e.perception } : {}), ...(e.velocity ? { velocity: { x: r2(e.velocity.x), y: r2(e.velocity.y), z: r2(e.velocity.z) } } : {}),
          ...(e.height ? { height: e.height } : {}), ...(typeof e.hp === 'number' ? { hp: e.hp } : {}), ...(e.fusing ? { fusing: true } : {}) }));
      }
      case 'drops': {
        // 地上的掉落物：眼前看得见的，加上刚才亲眼见过、转身后不在视野里的（记得掉在哪）。不透视
        const r = Math.max(1, Math.min(32, Number(a[0]) || 16));
        const here = ctx.adapter.state().pos;
        ctx.senses.refresh();
        const seen = ctx.senses.perceivedEntities(r).filter((e) => e.kind === 'item').map((e) => ({ id: e.id, item: e.name.replace(/^item:/, ''), count: (e as any).count ?? 1, pos: e.pos, dist: Math.round(e.dist * 10) / 10, seen: true }));
        const ids = new Set(seen.map((d) => d.id));
        const remembered = (ctx.senses.recentDrops?.(120_000) ?? []).filter((d) => !ids.has(d.id))
          .map((d) => ({ id: d.id, item: d.name, pos: d.pos, dist: Math.round(Math.hypot(d.pos.x - here.x, d.pos.y - here.y, d.pos.z - here.z) * 10) / 10, seen: false, ageSec: Math.round(d.ageMs / 1000) }))
          .filter((d) => d.dist <= r);
        return [...seen, ...remembered].sort((x, y) => x.dist - y.dist);
      }
      case 'nearestLand': {
        const s = ctx.adapter.state();
        ctx.senses.refresh();
        const land = ctx.senses.nearestLand?.(s.pos, []);
        if (!land) return null;
        const stand = { x: land.pos.x, y: land.pos.y + 1, z: land.pos.z };
        return { stand, dir: land.dir, dist: land.dist, dy: stand.y - feetCell(s.pos).y };
      }
      case 'act': return runSkill(String(a[0] ?? ''), a[1]);
      case 'useSkill': {
        const name = String(a[0] ?? '').trim().toLowerCase();
        const why = reliableCheck ? reliableCheck(name) : '没有登记可靠的技能';
        if (why) throw new Error(`api.useSkill 只能调用已经验证可靠的技能：${why}`);
        const depth = (ctx as SkillCtx & { skillDepth?: number }).skillDepth ?? 0;
        if (depth >= MAX_SKILL_DEPTH) throw new Error(`技能最多套 ${MAX_SKILL_DEPTH} 层`);
        const skill = SKILLS.use_skill;
        const v = skill.validate({ name, ...(a[1] && typeof a[1] === 'object' ? { args: a[1] } : {}) }, ctx.adapter);
        if (!v.ok) throw new Error(`useSkill 参数错误：${v.error}`);
        throwIfAborted(ctx.signal);
        const r = await skill.run({ ...ctx, skillDepth: depth + 1, deadline: Math.min(ctx.deadline, Date.now() + skill.timeoutMs), progress: () => {} } as SkillCtx, v.args);
        if (r.status === 'cancelled') throw Object.assign(new Error('task cancelled'), { name: 'AbortedError' });
        return { ok: r.status === 'succeeded', code: r.failureCode ?? null, summary: r.summary.slice(0, 200) };
      }
      case 'stepTo': return runSkill('step', { to: rel(int(a[0], 'x'), int(a[1], 'y'), int(a[2], 'z')), facing: 'N' });
      case 'digAt': return runSkill('dig_at', { at: rel(int(a[0], 'x'), int(a[1], 'y'), int(a[2], 'z')), facing: 'N' });
      case 'placeAt': return runSkill('place_at', { at: rel(int(a[0], 'x'), int(a[1], 'y'), int(a[2], 'z')), item: String(a[3] ?? 'any'), facing: 'N' });
      case 'moveTo': {
        const p = { x: Number(a[0]), y: Number(a[1]), z: Number(a[2]) };
        if (![p.x, p.y, p.z].every(Number.isFinite)) throw new Error('moveTo 要写 x,y,z');
        const range = Math.max(0, Math.min(8, Number(a[3] ?? 1)));
        try {
          const o = (a[4] && typeof a[4] === 'object' ? a[4] : {}) as Record<string, unknown>;
          const sprint = o.sprint === true;
          const avoid = Array.isArray(o.avoid) ? o.avoid.map(String).slice(0, 16) : [];
          await ctx.adapter.moveTo({ kind: 'near', pos: p, range }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(30_000, ctx.deadline - Date.now())), ...(sprint ? { sprint: true } : {}), ...(avoid.length ? { avoid } : {}) });
        } catch (e) { if ((e as Error)?.name === 'AbortedError') throw e; return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 160), pos: ctx.adapter.state().pos }; }
        return { ok: true, pos: ctx.adapter.state().pos };
      }
      case 'look': await ctx.adapter.look(Number(a[0]) || 0, Number(a[1]) || 0, ctx.signal); return { ok: true };
      case 'lookAt': {
        const p = point(a.length >= 3 ? a.slice(0, 3) : a[0], 'lookAt');
        const eye = ctx.adapter.eye();
        if (!eye) throw new Error('现在看不了');
        const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
        await ctx.adapter.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), ctx.signal);
        return { ok: true };
      }
      case 'move': {
        const raw = (a[0] && typeof a[0] === 'object' ? a[0] : {}) as Record<string, unknown>;
        const keys: DriveKeys = {};
        for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const) if (raw[k]) keys[k] = true;
        const o = (a[2] && typeof a[2] === 'object' ? a[2] : {}) as Record<string, unknown>;
        const face = o.face;
        const r = await need(ctx.adapter.drive?.bind(ctx.adapter), 'move')(keys, Math.max(50, Math.min(1000, Number(a[1]) || 200)), ctx.signal, {
          ...(typeof face === 'number' ? { faceEntity: face } : face !== undefined ? { facePoint: point(face, 'face') } : {}), guard: o.unsafe !== true });
        return { ok: r.ok, moved: r.moved, ...(r.stopped ? { stopped: r.stopped } : {}), pos: ctx.adapter.state().pos };
      }
      case 'attack': {
        const id = Number(a[0]);
        const target = ctx.senses.perceivedEntities(8).find((e) => e.id === id);
        if (!target) return { ok: false, error: '看不见这个实体（或者太远了）', sinceLastMs: Date.now() - lastSwingAt };
        if (target.dist > 4.5) return { ok: false, error: `够不着：还有 ${Math.round(target.dist * 10) / 10} 格`, sinceLastMs: Date.now() - lastSwingAt };
        const since = Date.now() - lastSwingAt;
        const ok = await ctx.adapter.attack(id, ctx.signal);
        if (ok) lastSwingAt = Date.now();
        return { ok, sinceLastMs: since };
      }
      case 'equip': {
        const dest = String(a[1] ?? 'hand');
        if (!['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(dest)) throw new Error('equip 的位置写 hand|off-hand|head|torso|legs|feet');
        const r = await need(ctx.adapter.equipItem?.bind(ctx.adapter), 'equip')(String(a[0] ?? ''), dest as 'hand', ctx.signal);
        return { ok: r.ok, ...(r.reason ? { code: r.reason } : {}) };
      }
      case 'shield': {
        const r = await need(ctx.adapter.raiseShield?.bind(ctx.adapter), 'shield')(a[0] !== false, ctx.signal);
        return { ok: r.ok, ...(r.reason ? { code: r.reason } : {}) };
      }
      case 'draw': {
        const r = await need(ctx.adapter.startDraw?.bind(ctx.adapter), 'draw')(String(a[0] ?? 'bow'), ctx.signal);
        return { ok: r.ok, ...(r.reason ? { code: r.reason } : {}) };
      }
      case 'release': {
        const r = await need(ctx.adapter.releaseDraw?.bind(ctx.adapter), 'release')(ctx.signal, a[0] === undefined || a[0] === null ? undefined : point(a.length >= 3 ? a.slice(0, 3) : a[0], 'release'));
        return { ok: r.ok, chargedMs: r.chargedMs, ...(r.reason ? { code: r.reason } : {}) };
      }
      case 'shoot': {
        const r = await need(ctx.adapter.rangedAttack?.bind(ctx.adapter), 'shoot')(Number(a[0]), ctx.signal);
        return { ok: r.ok, ...(r.reason ? { code: r.reason } : {}) };
      }
      case 'sleep': await sleep(Math.max(0, Math.min(5000, Number(a[0]) || 0)), ctx.signal); return { ok: true };
      default: throw new Error(`没有 api.${method}`);
    }
  };
}

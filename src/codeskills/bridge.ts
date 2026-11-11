import type { DriveKeys, Vec3Like } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import { facingOfYaw, feetCell } from '../perception/local.ts';
import { dirName } from '../perception/perception.ts';
import { AIR_BLOCKS, isSoftBlock, LIQUID_BLOCKS } from '../perception/surroundings.ts';
import { SKILLS } from '../skills/index.ts';
import { LLM_HIDDEN } from '../skills/index.ts';
import { constrainRecoveryAction, worldPoint } from '../skills/recovery.ts';
import { NAVIGATION_ACTIONS, relativeCellAction, STANCE_MOVES } from '../skills/stance.ts';
import { runSkill as executeSkill, validateSkill, type Senses, type SkillCtx } from '../skills/types.ts';
import { sleep, throwIfAborted } from '../util.ts';
import type { SandboxHandler } from './sandbox.ts';

/**
 * 代码技能能用的 api：身体感觉得到的东西 + 已有的动作。看方块只看身边（48 格内），没有透视的怪物列表。
 * 说明写在 skills/writing-skills/SKILL.md，模型写代码前会翻开。
 */
export const READ_RADIUS = 48;

/** 给模型看的 api 说明（写代码技能、后台改进时都用这一份） */
export const API_DOC = `代码是一个 async 函数体，参数 api 和 args 已经给好（args 是 use_skill 的 args；恢复时 args.failure = {skill,args,code,summary,target?,position} 是刚失败的那一步：target 是那一步实际要去/要动的坐标（动作算出来的，比如 resolve_target/navigate_to 的落点），position 是失败时人在哪）。所有 api 调用都要 await，返回普通 JSON。
恢复的 target 是世界坐标，不是相对 at/to；原目标、目标类型（格/精确脚位）、实体 ID、挖掘/放置范围和液体/坠落风险限制会传给步骤与嵌套技能。不能自行换目标或增加挖掘、合成和探索；超出原委托还需放方块或挖方块时，先交回心智显式调用 use_skill args.allowPlace:true 或 args.allowDig:true。缺少绝对目标就报告缺口，不能拿当前位置猜。
- api.state() → {pos, feet:{x,y,z}, feetBlock, headBlock, bodyPortal, hp, food, oxygen, onGround, inWater, inLava, isDay, dim, yaw, facing, held, riding（载具名或 null）, inventory:[{name,count}]}；feetBlock/headBlock/bodyPortal 是触觉事实（adapter 直接读身体占据格，不受视野限制，站在门方块里时为 nether_portal）
- api.blockAt(x,y,z) → {name, kind}；kind = open（无整身碰撞盒：空气、草、雪层、地毯等）| solid | liquid | unknown；open 不等于空格：雪层、地毯仍占据该格，并可能提供较低的站立顶面；只读取身边 48 格内当前视野可见的格子。遮挡、视野外、黑暗或未加载时返回 {name:null,kind:"unknown"}，不透露隐藏的矿、液体或洞穴；先用 api.lookAt 转头，再读取。unknown 不能当空气或实心。要挖/迈身边的格子，直接用 digAt/stepTo（它们自己会转头、处理遮挡、如实回报），别先 blockAt 预检再因为 unknown 就 throw——紧邻格没转头时 blockAt 常返回 unknown，只代表还没看清，不代表没法处理
- api.region(x1,y1,z1,x2,y2,z2) → {min, size:[sx,sy,sz], palette:[名字或"?"], kinds:[同上], data:[下标]}；第 i 格：i = (y-min.y)*sx*sz + (z-min.z)*sx + (x-min.x)；最多 40000 格；与 blockAt 共用当前可见观测，未知格为 "?"/unknown，记忆不能冒充当前观测
- api.entities(半径≤32) → 看见的实体 [{id,name,kind,dist,pos,how:"seen",fusing?}]（kind=item 的是掉落物，name 形如 item:cobblestone）；只听见的返回 {name,kind,how:"heard",dir,dist,fusing?}，没有精确位置或实体id，距离约两格精度，只能据此决定转头或搜索。挥击、射击、跟踪和 api.act 的实体动作只能选择当前看见的目标。when.hostile 同样匹配听见的怪——按位置/ID 行动时 when 写 seen:true，或在代码里处理 heard
- api.drops(半径≤32) → 地上的掉落物 [{id,item,count?,pos,dist,seen,ageSec?}]：seen=true 是眼前看得见的；seen=false 是刚才亲眼见过、现在不在视野里（记得的位置，ageSec 秒前）。扔完东西核对“走开了没有、有没有被捡回来”就看这个
- api.nearestLand() → 最近候选干地经当前视野确认后返回 {stand:{x,y,z} 站上去时脚的位置, dir, dist, dy 比脚高几格} 或 null（支撑为实心、上面两格为空气、不是水底）；历史位置或被遮挡的位置不能当作已确认落点，null 不代表四周一定没有陆地
- api.stepTo(x,y,z) 迈到相邻一格（平走、上一级、下一级；一次只迈一格，不能跨多格；陆上不自动改成更低的落点，水中可朝岸爬出）｜api.digAt(x,y,z, {wet:true,lava:true,fall:true}?)（旁边有液体默认不挖；wet:true 接受进水，lava:true 接受进岩浆；fall:true 接受移除脚下支撑后的坠落风险，三项分别显式选择，恢复不能追加原委托未授权的风险）｜api.placeAt(x,y,z,"方块名|any") → {ok,code,summary,data?}；检查 ok 和失败原因，stepTo 的 data 可包含实际位置、目标格及未确认支撑的位置和已观察方块（null 表示未看清）。迈步的「支撑」按当前碰撞形状判断：整块、上下半砖、雪层、地毯都能站（实际脚高按它们的顶面，半砖半格、雪层更矮，不取整）；火把、花草这类没有碰撞盒的方块不挡路也不提供支撑，会看它下面那格的顶面；门开着可穿、关着挡路。缺支撑或脚高与请求不符就如实报出支撑格，不会自动补块或改落点。同一次代码技能里，api.stepTo 或 api.act("move_step") 失败后，下一步“相对 at”的 mine_cell/place_cell/place_support 会按错误站位解析，会被直接拒绝并提示先确认实际站位；绝对 xyz 的 digAt/placeAt 仍按原目标执行。placeAt 会填空气格，也会替换可替换的植物（草/花/树苗等）和液体；目标格被不可替换的方块（含雪层、地毯、火把、半砖、门）占住时只如实报占用，不把错误材料当完成
- api.moveTo(x,y,z) 用 navigate_to 走到精确世界坐标：按已观测体素做有界 3D A*（walk/step/drop），整数 x/z 按目标格验收、分数 x/z 按精确连续脚位验收，可上下层；不挖/不放/不搭柱、不换目标。失败回执保留原目标、实测位置和边界缺口；不要对目标邻格换几个 y 反复 moveTo。需要施工或别的移动能力时用 api.act 显式选择。不再支持 range/sprint/avoid → {ok,error?,pos,data?}｜api.act("动作名",{参数}) 用已有动作（navigate_to、advance、plan_route、move_step、assess_landings、descend_to、mine_cell、defend…）→ {ok,code,summary,data?}；data 保留动作返回的实际观测与失败进展，去掉独立的原始 local/around 地图；查看地形仍用 blockAt/region 的可见边界
- api.useSkill("技能名",{args}?) 调用一份已经验证可靠的技能（reliable_skills 里列的，当积木用：先组合已经管用的，再补新的部分）→ {ok,code,summary}；最多套两层
- api.look(yaw,pitch)｜api.lookAt(x,y,z)｜api.sleep(毫秒≤5000)｜api.log(…) 记一句给自己看｜api.progress(0..1)
身体的细动作（打架、走位、躲闪都靠这些拼，怎么打由你决定）：
- api.move({forward,back,left,right,jump,sprint,sneak}, 毫秒 50–1000 的整数, {face: 实体id 或 [x,y,z]}?) 按住这些键一小会儿，期间一直盯着 face（实体：直视；坐标点：只水平朝向它、平视，贴近 0.3 格内不再转身） → {ok, moved 走了几格, stopped?: "lava"|"cliff"}；时长超出 50–1000 会报参数错误（press_keys 的 50–10000 是另一个入口的上限，两者不共用）；
  前面是岩浆/火或一脚会摔 4 格以上，身体会自己停下（ok=false）；{unsafe:true} 关掉这个保护
- api.attack(实体id) 朝它挥一下（4 格内才打得到）→ {ok, sinceLastMs 距上次挥了多久}；挥得太勤伤害很低：剑约 625ms、斧约 1000ms、空手 250ms 才恢复满
- api.equip(物品名或null, "hand"|"off-hand"|"head"|"torso"|"legs"|"feet", {sourceSlot}?) 指定现有槽位可区分同名物品；null 清空该装备位。api.act("inspect_inventory",{}) 查看槽位、附魔、名称和NBT｜api.shield(true/false) 举起/放下副手的盾（要先把 shield equip 到 off-hand；举着时走得慢、挡正面的近战和箭）
- api.draw("bow"|"crossbow"|"trident") 开始蓄力 → api.release([x,y,z]?) 转向那一点松手 → {ok, chargedMs}；弓蓄 1000ms 以上才是满力，远处要往上抬（箭会下坠）
- api.shoot(实体id) 身体按经验估好提前量和下坠、拉满弓射一箭（慢但省事）
- api.state() 还有 offHand、armor、usingItem（在举盾/拉弓）、hurtAgoMs（距上次挨打多久）、deathDrop（死亡掉落记录：{pos,dim,items,secondsLeft} 或 null；secondsLeft 是按正常 TPS 且持续加载估算的剩余现实秒，0 不代表已消失）
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

/** Preserve each sense's owner while excluding hearing from precise entity actions. */
export function visibleActionSenses(senses: Senses): Senses {
  return new Proxy(senses, {
    get(target, key) {
      if (key === 'perceivedEntities') return (radius: number) => target.perceivedEntities(radius).filter((e) => e.perception !== 'heard');
      if (key === 'knownBlocks') return (names: string[], radius: number) => {
        target.refresh();
        const remembered = target.knownBlocks(names, radius), visible = new Map<string, string>();
        for (let i = 0; i < remembered.length; i += 32) {
          for (const block of target.observeBlocks?.(remembered.slice(i, i + 32).map((entry) => entry.pos)) ?? []) visible.set(`${block.pos.x},${block.pos.y},${block.pos.z}`, block.name);
        }
        return remembered.filter((block) => visible.get(`${block.pos.x},${block.pos.y},${block.pos.z}`) === block.name);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function makeBridge(ctx: SkillCtx): SandboxHandler {
  hurtAt(ctx.bus); // 开始记挨打时刻
  const actionSenses = visibleActionSenses(ctx.senses);
  const near = (p: Vec3Like) => {
    const s = ctx.adapter.state().pos;
    if (Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) > READ_RADIUS) throw new Error(`只看得到身边 ${READ_RADIUS} 格内的方块`);
  };
  // One visibility boundary for single-cell, region and landing reads. Even an
  // unnamed solid/liquid flag would reveal hidden terrain, so absence stays unknown.
  const readBlocks = (positions: Vec3Like[]) => {
    ctx.senses.refresh();
    const observed = new Map<string, string>();
    for (let i = 0; i < positions.length; i += 32) {
      for (const block of ctx.senses.observeBlocks?.(positions.slice(i, i + 32)) ?? []) {
        observed.set(`${block.pos.x},${block.pos.y},${block.pos.z}`, block.name);
      }
    }
    return observed;
  };
  // 与宏步骤相同的站位依赖：一次 step/导航段失败后，紧接着的相对 at 挖掘/放置会按
  // 错误站位解析。只有确实改变或确认站位的移动入口才清掉它；转头、攻击、装备等
  // 不解决站位缺口的动作不能把提示吞掉。
  let pendingStance: { skill: string; pos: Vec3Like | undefined } | null = null;
  const isStanceMove = (name: string) => STANCE_MOVES.has(name) || NAVIGATION_ACTIONS.has(name);
  const runSkill = async (name: string, args: unknown) => {
    const skill = SKILLS[name];
    if (!skill || LLM_HIDDEN.has(name) || name === 'use_skill') throw new Error(`没有 "${name}" 这个动作（代码里不能再调用 use_skill）`);
    const v = validateSkill(skill, args ?? {}, ctx.adapter);
    if (!v.ok) throw new Error(`${name} 参数错误：${v.error}`);
    if (pendingStance !== null && relativeCellAction(name, v.args)) {
      const where = pendingStance.pos
        ? `（回执/实测位置 ${pendingStance.pos.x.toFixed(2)},${pendingStance.pos.y.toFixed(2)},${pendingStance.pos.z.toFixed(2)}）`
        : '（没有保留失败回执位置）';
      throw new Error(`上一步 ${pendingStance.skill} 没到新站位${where}；${name} 使用相对 at，会按错误站位解析。先确认实际站位，或改用带绝对 xyz 的目标`);
    }
    throwIfAborted(ctx.signal);
    const r = await executeSkill({ ...ctx, senses: actionSenses, deadline: Math.min(ctx.deadline, Date.now() + skill.timeoutMs), progress: () => {} }, skill, constrainRecoveryAction(ctx, name, v.args));
    if (r.status === 'cancelled') throw Object.assign(new Error('task cancelled'), { name: 'AbortedError', ...(r.data ? { partial: r.data } : {}) });
    if (r.status === 'succeeded' && isStanceMove(name)) {
      // 成功迈步或导航已把站位带到新位置，旧的“未到达”缺口随之解除。
      pendingStance = null;
    } else if (r.status === 'failed' && isStanceMove(name)) {
      const nav = r.data?.nav as { lastPosition?: unknown } | undefined;
      // 导航动作优先用该步真实回执里的末位，不事后重读现场覆盖旧回执；
      // 旧动作没有统一回执时用刚失败时的站位。
      const pos = NAVIGATION_ACTIONS.has(name)
        ? worldPoint(r.data?.position) ?? worldPoint(nav?.lastPosition)
        : worldPoint(ctx.adapter.state().pos);
      pendingStance = { skill: name, pos };
    }
    const { local: _local, around: _around, ...data } = r.data ?? {};
    // 保留 data 外壳（即使去掉 local/around 后为空），代码里能稳定区分“没有 data”和“有结构化 data”。
    return { ok: r.status === 'succeeded', code: r.failureCode ?? null, summary: r.summary.slice(0, 200), ...(r.data !== undefined ? { data } : {}) };
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
          const left = d ? Math.max(0, Math.round((d.ts + 300_000 - Date.now()) / 1000)) : 0;
          if (d && d.lost.length) deathDrop = { pos: d.pos, dim: d.dim, items: d.lost.map((i) => ({ name: i.name, count: i.count })), secondsLeft: left };
        } catch { /* 记忆暂不可用 */ }
        const feet = feetCell(s.pos);
        return { pos: s.pos, feet, feetBlock: ctx.adapter.blockAt(feet), headBlock: ctx.adapter.blockAt({ x: feet.x, y: feet.y + 1, z: feet.z }),
          bodyPortal: s.bodyPortal ?? null,
          hp: Math.round(s.hp * 10) / 10, food: s.food, oxygen: s.oxygen, onGround: s.onGround !== false, inWater: s.inWater, inLava: s.inLava,
          isDay: s.isDay, dim: s.dim, yaw: eye?.yaw ?? null, pitch: eye?.pitch ?? null, facing: eye ? facingOfYaw(eye.yaw) : null, held: s.held, riding: s.riding ?? null,
          offHand: combat.offHand, armor: (s.equipment ?? []).filter((e) => e.slot !== 'off-hand').map((e) => ({ slot: e.slot, name: e.name })),
          usingItem: combat.usingItem, drawingMs: combat.drawingSinceMs, hurtAgoMs: hurt ? Date.now() - hurt : null, deathDrop,
          inventory: s.inventory.map((i) => ({ name: i.name, count: i.count })) };
      }
      case 'blockAt': {
        const p = { x: int(a[0], 'x'), y: int(a[1], 'y'), z: int(a[2], 'z') };
        near(p);
        const name = readBlocks([p]).get(`${p.x},${p.y},${p.z}`) ?? null;
        return { name, kind: kindOf(name) };
      }
      case 'region': {
        const [x1, y1, z1, x2, y2, z2] = Array.from({ length: 6 }, (_, i) => int(a[i], 'xyzxyz'[i]));
        const min = { x: Math.min(x1, x2), y: Math.min(y1, y2), z: Math.min(z1, z2) }, max = { x: Math.max(x1, x2), y: Math.max(y1, y2), z: Math.max(z1, z2) };
        const size = [max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1];
        if (size[0] * size[1] * size[2] > MAX_REGION) throw new Error(`region 最多 ${MAX_REGION} 格（现在 ${size.join('×')}）`);
        near(min); near(max);
        const positions = Array.from({ length: size[0] * size[1] * size[2] }, (_, i) => ({
          x: min.x + i % size[0], y: min.y + Math.floor(i / (size[0] * size[2])), z: min.z + Math.floor(i / size[0]) % size[2],
        }));
        // A rectangular region can cross the radius at a mixed corner even
        // when its min/max corners fit; every requested cell shares the limit.
        const origin = ctx.adapter.state().pos;
        if (positions.some((p) => Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z) > READ_RADIUS)) throw new Error(`只看得到身边 ${READ_RADIUS} 格内的方块`);
        const observed = readBlocks(positions);
        const palette: string[] = [], kinds: string[] = [], index = new Map<string, number>();
        // 顺序：x 最快，然后 z，最后 y：i = (y-min.y)*sx*sz + (z-min.z)*sx + (x-min.x)
        const data = positions.map(({ x, y, z }) => {
          const name = observed.get(`${x},${y},${z}`) ?? '?';
          let i = index.get(name);
          if (i === undefined) { i = palette.length; index.set(name, i); palette.push(name); kinds.push(kindOf(name === '?' ? null : name)); }
          return i;
        });
        return { min, size, palette, kinds, data };
      }
      case 'entities': {
        const r = Math.max(1, Math.min(32, Number(a[0]) || 16));
        const r2 = (v: number) => Math.round(v * 100) / 100;
        ctx.senses.refresh();
        const here = ctx.adapter.state().pos;
        return ctx.senses.perceivedEntities(r).map((e) => e.perception === 'heard' ? {
          name: e.name, kind: e.kind, how: 'heard', dir: dirName(e.pos.x - here.x, e.pos.z - here.z), dist: Math.max(2, Math.round(e.dist / 2) * 2),
          ...(e.fusing ? { fusing: true } : {}),
        } : ({ id: e.id, name: e.name, kind: e.kind, dist: Math.round(e.dist * 10) / 10, pos: e.pos,
          how: 'seen', ...(e.velocity ? { velocity: { x: r2(e.velocity.x), y: r2(e.velocity.y), z: r2(e.velocity.z) } } : {}),
          ...(e.height ? { height: e.height } : {}), ...(typeof e.hp === 'number' ? { hp: e.hp } : {}), ...(e.fusing ? { fusing: true } : {}) }));
      }
      case 'drops': {
        // 地上的掉落物：眼前看得见的，加上刚才亲眼见过、转身后不在视野里的（记得掉在哪）。不透视
        const r = Math.max(1, Math.min(32, Number(a[0]) || 16));
        const here = ctx.adapter.state().pos;
        ctx.senses.refresh();
        const seen = ctx.senses.perceivedEntities(r).filter((e) => e.kind === 'item' && e.perception !== 'heard').map((e) => ({ id: e.id, item: e.name.replace(/^item:/, ''), ...(e.count !== undefined ? { count: e.count } : {}), pos: e.pos, dist: Math.round(e.dist * 10) / 10, seen: true }));
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
        const head = { ...stand, y: stand.y + 1 };
        if ([land.pos, stand, head].some((p) => Math.hypot(p.x - s.pos.x, p.y - s.pos.y, p.z - s.pos.z) > READ_RADIUS)) return null;
        const observed = readBlocks([land.pos, stand, head]);
        const at = (p: Vec3Like) => observed.get(`${p.x},${p.y},${p.z}`) ?? null;
        if (kindOf(at(land.pos)) !== 'solid' || ![stand, head].every((p) => AIR_BLOCKS.has(at(p) ?? ''))) return null;
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
        const v = validateSkill(skill, { name, ...(a[1] && typeof a[1] === 'object' ? { args: a[1] } : {}) }, ctx.adapter);
        if (!v.ok) throw new Error(`useSkill 参数错误：${v.error}`);
        throwIfAborted(ctx.signal);
        const r = await executeSkill({ ...ctx, skillDepth: depth + 1, deadline: Math.min(ctx.deadline, Date.now() + skill.timeoutMs), progress: () => {} } as SkillCtx, skill, v.args);
        if (r.status === 'cancelled') throw Object.assign(new Error('task cancelled'), { name: 'AbortedError', ...(r.data ? { partial: r.data } : {}) });
        const { local: _local, around: _around, ...data } = r.data ?? {};
        // api.useSkill 与 api.act 一样保留 data 外壳：嵌套代码技能的结构化事实不能被压成 ok/code/summary。
        return { ok: r.status === 'succeeded', code: r.failureCode ?? null, summary: r.summary.slice(0, 200), ...(r.data !== undefined ? { data } : {}) };
      }
      case 'stepTo': {
        const y = Number(a[1]);
        if (!Number.isFinite(y)) throw new Error('y 要是数字');
        return runSkill('move_step', { xyz: { x: int(a[0], 'x'), y, z: int(a[2], 'z') }, facing: 'N' });
      }
      case 'digAt': {
        const options = a[3] && typeof a[3] === 'object' ? a[3] as Record<string, unknown> : {};
        return runSkill('mine_cell', { xyz: { x: int(a[0], 'x'), y: int(a[1], 'y'), z: int(a[2], 'z') }, facing: 'N', ...(options.wet === true ? { wet: true } : {}), ...(options.lava === true ? { lava: true } : {}), ...(options.fall === true ? { fall: true } : {}) });
      }
      case 'placeAt': {
        const pos = { x: int(a[0], 'x'), y: int(a[1], 'y'), z: int(a[2], 'z') };
        const item = String(a[3] ?? 'any');
        const feet = feetCell(ctx.adapter.state().pos);
        if (item !== 'any' && feet.x === pos.x && feet.y === pos.y && feet.z === pos.z) return runSkill('pillar_one', { item });
        return item === 'any'
          ? runSkill('place_support', { xyz: pos, item: 'any', facing: 'N' })
          : runSkill('place_cell', { xyz: pos, item, facing: 'N' });
      }
      case 'moveTo': {
        const p = { x: Number(a[0]), y: Number(a[1]), z: Number(a[2]) };
        if (![p.x, p.y, p.z].every(Number.isFinite)) throw new Error('moveTo 要写 x,y,z');
        const o = (a[4] && typeof a[4] === 'object' ? a[4] : {}) as Record<string, unknown>;
        if (o.sprint === true) throw new Error('moveTo 不再支持 sprint；需要跑用 press_keys，或让 Agent 自己选择');
        if (Array.isArray(o.avoid) && o.avoid.length) throw new Error('moveTo 不再支持 avoid；需要绕行请让 navigate_to 按当前证据规划');
        if (a[3] !== undefined && Number(a[3]) !== 0) throw new Error('moveTo 只支持精确到达，不再接受 range；需要保留距离时先 api.act("plan_route",{to,source:"spatial"}) 查看落点');
        // 代码技能的 moveTo 直接使用 navigate_to：目标原样交给 3D 体素 A*；
        // 整数/分数目标语义由 navigate_to 保持。
        const walked = await runSkill('navigate_to', { to: p });
        pendingStance = null;
        return walked.ok
          ? { ok: true, pos: ctx.adapter.state().pos, data: walked.data }
          : { ok: false, error: walked.summary, code: walked.code, pos: ctx.adapter.state().pos, data: walked.data };
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
        // 时长按 api.move 自己的 50–1000 上限校验；不做静默夹取。press_keys 是
        // 50–10000 的另一个入口，两者上限不同，不能声称相同。
        const ms = a[1] === undefined ? 200 : Number(a[1]);
        if (!Number.isInteger(ms) || ms < 50 || ms > 1000) throw new Error('move 时长必须是 50 到 1000 的整数毫秒（press_keys 的 50–10000 是另一个入口的上限，两者不共用）');
        const keys: DriveKeys = {};
        for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const) if (raw[k]) keys[k] = true;
        const o = (a[2] && typeof a[2] === 'object' ? a[2] : {}) as Record<string, unknown>;
        // 恢复委托是导航时，原始按键移动会绕过原后端/目标/手段；必须在任何身体写入前拒绝。
        // 同时把校验后的 ms 与 unsafe 选项交给恢复约束：恢复不能超过原 press_keys 时长，
        // 也不能关掉原委托的 guard 保护。
        constrainRecoveryAction(ctx, 'move', { ...raw, ms, unsafe: o.unsafe === true });
        const face = o.face;
        if (typeof face === 'number') {
          constrainRecoveryAction(ctx, 'hit_entity', { entity: face });
          ctx.senses.refresh();
          if (!ctx.senses.perceivedEntities(32).some((e) => e.id === face && e.perception !== 'heard')) return { ok: false, moved: 0, error: '看不见这个实体，不能精确跟踪；先转头确认' };
        }
        const r = await need(ctx.adapter.drive?.bind(ctx.adapter), 'move')(keys, ms, ctx.signal, {
          ...(typeof face === 'number' ? { faceEntity: face } : face !== undefined ? { facePoint: point(face, 'face') } : {}), guard: o.unsafe !== true });
        return { ok: r.ok, moved: r.moved, ...(r.stopped ? { stopped: r.stopped } : {}), pos: ctx.adapter.state().pos };
      }
      case 'attack': {
        const id = Number(a[0]);
        constrainRecoveryAction(ctx, 'hit_entity', { entity: id });
        ctx.senses.refresh();
        const target = ctx.senses.perceivedEntities(8).find((e) => e.id === id && e.perception !== 'heard');
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
        const options = a[2] && typeof a[2] === 'object' ? a[2] as Record<string, unknown> : {};
        if (options.sourceSlot !== undefined && (!Number.isInteger(options.sourceSlot) || Number(options.sourceSlot) < 5 || Number(options.sourceSlot) > 45)) throw new Error('sourceSlot 必须是 5–45 的背包槽位');
        const r = await need(ctx.adapter.equipItem?.bind(ctx.adapter), 'equip')(a[0] === null ? null : String(a[0] ?? ''), dest as 'hand', ctx.signal, options.sourceSlot !== undefined ? { sourceSlot: Number(options.sourceSlot) } : undefined);
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
        constrainRecoveryAction(ctx, 'hit_entity', { entity: Number(a[0]) });
        ctx.senses.refresh();
        if (!ctx.senses.perceivedEntities(32).some((e) => e.id === Number(a[0]) && e.perception !== 'heard')) return { ok: false, code: 'NOT_FOUND', error: '看不见这个实体，不能精确瞄准；先转头确认' };
        const r = await need(ctx.adapter.rangedAttack?.bind(ctx.adapter), 'shoot')(Number(a[0]), ctx.signal);
        return { ok: r.ok, ...(r.reason ? { code: r.reason } : {}) };
      }
      case 'sleep': await sleep(Math.max(0, Math.min(5000, Number(a[0]) || 0)), ctx.signal); return { ok: true };
      default: throw new Error(`没有 api.${method}`);
    }
  };
}

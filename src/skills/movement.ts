import { DIR_OFFSETS, surroundings } from '../perception/surroundings.ts';
import { facingOfYaw } from '../perception/local.ts';
import { climbUp } from './body.ts';
import { hasPlaceable, PLACEABLE } from './survival.ts';
import { DIRS } from '../perception/perception.ts';
import { dist3, sleep } from '../util.ts';
import type { Vec3Like } from '../adapter/types.ts';
import { clampInt, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

// ------------------------------------------------------------------ 寻找与张望（人眼式：不透视，只是转头看）
/** 朝 (dx,dz) 方向的 yaw（0 = 北/-Z，正值向左/西） */
export const yawOfDir = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export const FOOD_ANIMAL_NAMES = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
/** 目标的类别写法：animal/food = 能吃的动物，hostile = 敌对生物 */
const CATEGORY: Record<string, string[]> = { animal: FOOD_ANIMAL_NAMES, animals: FOOD_ANIMAL_NAMES, food: FOOD_ANIMAL_NAMES, food_animal: FOOD_ANIMAL_NAMES };

/** 最近在哪儿找过什么、没找到（10 分钟内）：只记实际发生的扫视，用来如实告诉心智“这里已经找过几次”。 */
const fruitless: { worldId: string; dim: string; pos: Vec3Like; target: string; at: number }[] = [];
const FRUITLESS_MS = 10 * 60_000;
/** 记下一次没找到，返回这附近（4 格内、同一维度）10 分钟内找同一目标没找到的次数（含本次）。 */
export function noteFruitlessSearch(ctx: SkillCtx, target: string): number {
  const s = ctx.adapter.state(), now = Date.now();
  while (fruitless.length && (now - fruitless[0].at > FRUITLESS_MS || fruitless.length >= 64)) fruitless.shift();
  fruitless.push({ worldId: s.worldId, dim: s.dim, pos: { ...s.pos }, target, at: now });
  return fruitless.filter((f) => f.worldId === s.worldId && f.dim === s.dim && f.target === target && dist3(f.pos, s.pos) <= 4).length;
}
/** 同一处反复没找到时附在回执后的事实：原地再转看到的是同一片视野；要不要、往哪移动由心智定。 */
export const repeatSearchNote = (target: string, times: number) => times >= 2
  ? `；这附近已经第 ${times} 次找 ${target} 都没看见，原地再转看到的还是同一片视野；要看新的地方得移动（例如 explore_toward {"direction":"…","until":"${target}"}）`
  : '';

type SightRef = { kind: 'block'; pos: Vec3Like } | { kind: 'entity'; id: number; name: string };
const entityIdOf = (ref?: SightRef) => ref?.kind === 'entity' ? ref.id : undefined;

/** target 是否已在视野/近期记忆中：方块（log、iron_ore…）或实体（cow、sheep…）；可写 "cow|sheep" 或类别 "animal" */
export type SightHit = { what: string; dist: number; key: string; pos?: Vec3Like; ref?: SightRef };

/**
 * 同 sighted，但返回同一批已核对候选里的全部命中（方块按位置去重，实体仍只返回一个）。
 * 用于“看清这堆方块摆成什么形状”：只给最近一块，Agent 会把 8/10 的门框当成散块。
 */
export function sightedAll(ctx: SkillCtx, target: string, options: { visibleOnly?: boolean; direction?: string; currentViewOnly?: boolean } = {}): SightHit[] {
  const here = ctx.adapter.state().pos;
  const sector = options.direction ? DIRS[options.direction] : null;
  const inDirection = (pos: Vec3Like) => !sector || Math.abs(Math.atan2(Math.sin(yawOfDir(pos.x - here.x, pos.z - here.z) - yawOfDir(...sector)),
    Math.cos(yawOfDir(pos.x - here.x, pos.z - here.z) - yawOfDir(...sector)))) <= 1.3;
  for (const raw of target.toLowerCase().split(/[|,，、/ ]+/).filter(Boolean)) {
    const wanted = CATEGORY[raw] ?? [raw];
    for (const t of wanted) {
      const names = ctx.adapter.resolveBlockNames(t).filter(Boolean);
      if (names.length) {
        const frame = options.visibleOnly ? ctx.senses.currentBlockCandidates?.(names) : undefined;
        const known = options.currentViewOnly && frame !== undefined ? [] : ctx.senses.knownBlocks(names, 96);
        const matches = frame?.length ? [...frame, ...known] : known;
        const candidates = matches.filter((b) => inDirection({ x: b.pos.x + .5, y: b.pos.y, z: b.pos.z + .5 }));
        const hits = options.visibleOnly ? Array.from({ length: Math.ceil(candidates.length / 32) }, (_, index) =>
          ctx.senses.observeBlocks?.(candidates.slice(index * 32, (index + 1) * 32).map((b) => b.pos)) ?? []).flat() : candidates;
        const found = new Map<string, SightHit>();
        for (const hit of hits) {
          if (!names.includes(hit.name)) continue;
          const key = `${hit.name}:${hit.pos.x},${hit.pos.y},${hit.pos.z}`;
          if (!found.has(key)) found.set(key, {
            what: hit.name, dist: Math.round(dist3(here, hit.pos)), key, pos: hit.pos, ref: { kind: 'block', pos: { ...hit.pos } },
          });
        }
        if (found.size) return [...found.values()];
      }
    }
    const e = ctx.senses.perceivedEntities(48).find((x) => (!options.visibleOnly || x.perception === 'seen') && inDirection(x.pos)
      && wanted.some((t) => x.name === t || x.name.replace(/^player:/, '') === t || x.name.endsWith(`_${t}`)));
    if (e) return [{ what: e.name, dist: Math.round(e.dist), key: `entity:${e.id}`, pos: e.pos, ref: { kind: 'entity', id: e.id, name: e.name } }];
  }
  return [];
}

export function sighted(ctx: SkillCtx, target: string, options: { visibleOnly?: boolean; direction?: string; currentViewOnly?: boolean } = {}): SightHit | null {
  return sightedAll(ctx, target, options)[0] ?? null;
}

// ------------------------------------------------------------------ look_around
export const lookAround: Skill<{ seconds: number; for?: string; direction?: string }> = {
  name: 'look_around',
  readOnly: true,
  description: '停下来专门找东西（for），或扫描某个方向（direction）；看见就停。for 是方块时，回执列出这次视野里所有可见位置（摘要最多 16 处，foundPositions 最多 32 条），不只是最近一块，用来判断门框/结构形状；实体仍给 id 和位置。方向+距离不是坐标，不要自己推算。已在视野里的目标不触发转头，扫描结束也不保证面朝扇区中心',
  argsDoc: '{"for"?: "<要找的方块或生物>", "direction"?: "N|NE|E|SE|S|SW|W|NW", "seconds"?: 2-20}；回执的 foundPositions/foundPos/foundRef/visibleEntities 才是真实坐标或稳定引用；方向+距离不是坐标，不要自己推算。',
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
    const observedHits = () => args.for ? sightedAll(ctx, args.for, { visibleOnly: true, direction: args.direction }) : [];
    const hitsText = (hits: SightHit[]) => {
      if (hits.length === 1) {
        const hit = hits[0], id = entityIdOf(hit.ref);
        return `${hit.what}（${hit.dist} 格外${id === undefined ? '' : `，实体 id=${id}`}${hit.pos ? `，位置 (${Math.floor(hit.pos.x)},${Math.floor(hit.pos.y)},${Math.floor(hit.pos.z)})` : ''}）`;
      }
      const shown = hits.slice(0, 16).map((hit) => {
        const place = hit.pos ? `(${Math.floor(hit.pos.x)},${Math.floor(hit.pos.y)},${Math.floor(hit.pos.z)})` : '';
        const id = entityIdOf(hit.ref);
        return `${hit.what}${id === undefined ? place : `(id=${id}${place ? `，位置 ${place}` : ''})`}`;
      });
      return hits.length > shown.length ? `${shown.join('、')} 等 ${hits.length} 处` : shown.join('、');
    };
    // 未指定 for 时给出扫描后仍在视野里的实体稳定引用；block 目标请用 for 精确查找。
    const visibleNow = () => ctx.senses.perceivedEntities(32)
      .filter((entity) => entity.perception !== 'heard')
      .slice(0, 8)
      .map((entity) => ({ id: entity.id, name: entity.name, pos: { ...entity.pos }, dist: Math.round(entity.dist) }));
    const facts = (views: number, hits: SightHit[] = [], visibleEntities?: ReturnType<typeof visibleNow>) => {
      const eye = ctx.adapter.eye(), hit = hits[0];
      return { searched: views > 0, scanViews: views, turned: views > 0,
        // directionInspected 只说明扫过这个扇区；currentFacing 是扫描结束时身体的实际朝向。
        // 扫视不等于转向完成，后续按世界方向移动要显式定向。
        ...(args.direction ? { direction: args.direction, directionInspected: views > 0 } : {}),
        alreadyVisible: views === 0 && !!hit, newlyDiscovered: !!hit && !priorKnown.has(hit.key),
        ...(eye ? { finalView: { yaw: eye.yaw, pitch: eye.pitch }, currentFacing: facingOfYaw(eye.yaw) } : {}),
        // 只覆盖本次视线；没看到不是“世界其它地方没有”。
        ...(args.for ? { coverage: { mode: 'current_vision', views, unknownBeyond: true } } : {}),
        ...(hit ? {
          found: hit.what, dist: hit.dist,
          ...(hit.pos ? { foundPos: hit.pos } : {}),
          ...(hit.ref === undefined ? {} : { foundRef: hit.ref }),
          ...(entityIdOf(hit.ref) === undefined ? {} : { foundEntityId: entityIdOf(hit.ref) }),
          // 同一眼看到的全部位置：只给最近一块不足以看清门框/结构形状。
          foundPositions: hits.slice(0, 32).map((h) => ({
            name: h.what, ...(h.pos ? { pos: h.pos } : {}), dist: h.dist,
            ...(entityIdOf(h.ref) === undefined ? {} : { entityId: entityIdOf(h.ref) }),
          })),
          source: 'current_vision',
        } : {}),
        ...(visibleEntities !== undefined && visibleEntities.length > 0 ? { visibleEntities } : {}) };
    };
    if (args.for) {
      const hits = observedHits();
      if (hits.length) return ok(`${args.direction ? `${args.direction} 方向` : '当前视野'}已看见 ${hits.length} 处：${hitsText(hits)}；没有转头，也没有新的搜索发现`, facts(0, hits));
    }
    // 定向：在该方向 ±75° 扇形里看 5 个角度；全向：转一圈 8 个角度
    const sector = args.direction ? DIRS[args.direction] : null;
    const center = sector ? yawOfDir(sector[0], sector[1]) : (ctx.adapter.eye()?.yaw ?? 0);
    const yaws = sector ? [-1.3, -0.65, 0, 0.65, 1.3].map((o) => center + o) : Array.from({ length: 8 }, (_, k) => center + ((k + 1) * 2 * Math.PI) / 8);
    const per = Math.max(250, (args.seconds * 1000) / yaws.length);
    for (const [k, yaw] of yaws.entries()) {
      // 平视 / 略低头 / 每四个角度抬一次头：头顶（洞顶、树冠下的矿）也要扫到
      const pitch = k % 4 === 2 ? 0.45 : k % 2 === 0 ? -0.05 : -0.45;
      await ctx.adapter.look(yaw, pitch);
      await sleep(per, ctx.signal);
      ctx.senses.refresh();
      ctx.progress((k + 1) / yaws.length, args.for ? `寻找 ${args.for}` : '环顾四周');
      if (args.for) {
        const hits = observedHits();
        if (hits.length) return ok(`${args.direction ? `${args.direction} 方向` : '转头后'}看见 ${hits.length} 处：${hitsText(hits)}${priorKnown.has(hits[0].key) ? '，是已知目标的当前观察' : '，本次新发现'}`, facts(k + 1, hits));
      }
    }
    if (!sector) ctx.senses.markSweep();
    // 扫完回到平视：否则接下来的行走、地平线扫描和远景都会被最后一下低头挡住
    const end = ctx.adapter.eye();
    if (end) { await ctx.adapter.look(end.yaw, -0.05); ctx.senses.refresh(); }
    if (args.for) {
      const times = noteFruitlessSearch(ctx, args.for);
      return fail('NOT_FOUND', `${args.direction ? `${args.direction} 方向` : '四周'}本次视野未见 ${args.for}（只覆盖当前视野；旧记忆不算本次看见，更远处和遮挡后未知——不代表其它地方没有）${repeatSearchNote(args.for, times)}`, { ...facts(yaws.length), searchedHere: times });
    }
    const facingNote = end ? `（扫完身体朝向 ${facingOfYaw(end.yaw)}，扫视不等于转向）` : '';
    // 附近实体的稳定引用随扫描回执给出：模型可以直接用 id/位置，不必从方向和距离推算。
    const visibleEntities = args.for ? undefined : visibleNow();
    const nearby = visibleEntities?.length
      ? `；附近看见 ${visibleEntities.slice(0, 3).map((entity) => `${entity.name}(id=${entity.id}，${entity.dist} 格，位置 (${Math.floor(entity.pos.x)},${Math.floor(entity.pos.y)},${Math.floor(entity.pos.z)}))`).join('；')}${visibleEntities.length > 3 ? ` 等 ${visibleEntities.length} 个` : ''}`
      : '';
    return ok(`${args.direction ? `看了看 ${args.direction} 方向` : '环顾了一圈'}${facingNote}${nearby}`, facts(yaws.length, [], visibleEntities));
  },
};

// ------------------------------------------------------------------ unstuck（仅反射层使用）
export const unstuck: Skill<{}> = {
  name: 'unstuck',
  description: '脱困：看看身边哪边能走就往哪边走；四面都被封住且背包有可垫方块时，自动垫方块搭柱向上爬（脚下有梯子时先沿梯爬）（会消耗背包里的可垫方块，可能先挖开头顶阻挡）。只由反射层使用，不自动改变玩法方法；结果按阶段列出实际放下的方块与数量',
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
    // 四面都走不了（坑底、竖井、被封住）：垫方块往上爬（头顶挡着会先挖开），爬到四周有路可走为止。
    // 施工/耗材必须显式：按阶段记录背包里实际少了哪些可垫方块，不把垫柱藏成纯移动。
    let construction: Record<string, unknown> | undefined;
    if (around.enclosed && hasPlaceable(adapter.state().inventory)) {
      const inventory = () => {
        const counts = new Map<string, number>();
        for (const item of adapter.state().inventory) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
        return counts;
      };
      const before = inventory();
      ctx.progress(0.3, '四面被封住，垫方块往上爬');
      const r = await climbUp.run(ctx, { height: 12, untilSky: false, untilExit: true });
      const after = inventory();
      const blocks = [...before].flatMap(([name, count]) => PLACEABLE.includes(name)
        ? [{ name, count: Math.max(0, count - (after.get(name) ?? 0)) }].filter((item) => item.count > 0) : []);
      const climb = (r.data ?? {}) as { climbed?: number; goalReached?: boolean };
      construction = {
        attempted: true, stage: 'pillar_up', backend: 'climb_up',
        placedByStage: [{ stage: 'pillar_up', blocks }],
        blocksPlaced: blocks.reduce((sum, item) => sum + item.count, 0),
        climbed: climb.climbed ?? 0, goalReached: climb.goalReached === true,
        // climb_up 的结果不区分搭柱与沿梯攀爬；这里只报背包净减少的可垫方块。
        // 同一阶段挖开头顶若有同类掉落，净差可能低估实际放置，故把确认爬升步数一并列出。
        boundary: 'blocksPlaced 按本次背包净减少的可垫方块统计；climb_up 不区分搭柱/梯子，挖开头顶的同类掉落可能抵消净差，未逐块确认放置位置',
      };
      if (r.status === 'succeeded' && (climb.climbed ?? 0) > 0) {
        const spent = blocks.length ? `；本次垫了 ${(construction.blocksPlaced as number)} 块（${blocks.map((b) => `${b.name}×${b.count}`).join('、')}）` : '；背包没有观察到可垫方块减少（可能沿梯子攀爬或未实际放置）';
        return ok(`四面被封住，往上爬出来了${spent}：${r.summary}`, { construction, climb: r.data });
      }
    } else if (around.enclosed) {
      construction = { attempted: false, stage: 'pillar_up', reason: 'no_placeable_blocks', blocksPlaced: 0 };
    }
    await adapter.jump(600, signal);
    return fail('STUCK', `没能脱困${construction?.attempted ? `（已尝试搭柱，放下 ${construction.blocksPlaced} 块可垫方块）` : ''}｜${surroundings(adapter).text}`, construction ? { construction } : undefined);
  },
};

// ------------------------------------------------------------------ surface（由 Agent 主动调用）
/** 一次有界上浮委托：只往上浮出水面换气，不找岸、不找气穴、不挖不垫、不换目标。 */
export const surface: Skill<{ timeoutMs?: number }> = {
  name: 'surface',
  description: '有界上浮：按住上浮让头露出流体并持续换气到氧气明显回升或 timeout；不找岸、不找气穴、不挖不垫。surfaced 表示头已露出空气、氧气是实际值；松开 jump 仍会下沉；landed 表示站稳干地，未浮出会如实说清位置与氧气',
  argsDoc: '{"timeoutMs"?: 1000-20000（毫秒，本次上浮最多持续多久，可选）}',
  timeoutMs: 25000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    if (a.escape !== undefined) return { ok: false, error: 'surface 不再接受 escape："dig"|"shore"（自动挖顶/找气穴/寻岸超出委托）。要挖开头顶用 mine_cell，要游到指定位置用 swim_path {"xyz":[x,y,z],"mode":"water_point|dry_shore"}（dry_shore 到干岸站稳），要持续按住上浮用 press_keys {"keys":{"jump":true},"ms":…}' };
    const timeoutMs = a.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 20000)) return { ok: false, error: 'timeoutMs 必须是 1000–20000 的毫秒数' };
    return { ok: true, args: timeoutMs !== undefined ? { timeoutMs: Math.round(Number(timeoutMs)) } : {} };
  },
  async run(ctx, args) {
    const a = ctx.adapter;
    if (!a.swimTo) return fail('STUCK', '当前适配器缺少持续游泳控制，不能确认已浮出水面');
    const s0 = a.state();
    // 委托前就冻结自己的位置/氧气/观测时刻：state().pos 可能是可变引用，不克隆会被底层动作改成新主人的状态。
    const s0Snapshot = { pos: { ...s0.pos }, oxygen: s0.oxygen, observedAt: Date.now() };
    // 一次有界上浮委托：不选岸、不找气穴、不挖不垫、不换目标；surfaced（头露出流体）与 landed（站稳干地）分别报告。
    // 预算耗尽（remaining <= 0）才拒绝，不强行开游（岩浆同样由底层 dryFooting/headOut 的真实身体确认排除）。
    const timeoutMs = Math.min(args.timeoutMs ?? 20000, ctx.deadline - Date.now());
    if (timeoutMs <= 0) return fail('TIMEOUT', `上浮时间已用完，未执行；现在在 (${s0.pos.x.toFixed(1)},${s0.pos.y.toFixed(1)},${s0.pos.z.toFixed(1)})，氧气 ${s0.oxygen}/20`, { landed: false, surfaced: false, pos: s0Snapshot.pos, oxygen: s0Snapshot.oxygen, observedAt: s0Snapshot.observedAt });
    let r;
    try {
      r = await a.swimTo(null, ctx.signal, { timeoutMs });
    } catch (e) {
      // 取消/超时：保留底层带回的冻结 partial；无则用委托前的 s0 兜底，不重读 a.state() 以免张冠李戴到新主人状态。
      if (isAbort(e) || (e as Error)?.name === 'TimeoutError') {
        const prev = (e as Error & { partial?: Record<string, unknown> }).partial ?? {};
        (e as Error & { partial?: Record<string, unknown> }).partial = { landed: false, surfaced: false, pos: s0Snapshot.pos, oxygen: s0Snapshot.oxygen, observedAt: s0Snapshot.observedAt, ...prev };
      }
      throw e;
    }
    const s = a.state();
    const at = `现在在 (${s.pos.x.toFixed(1)},${s.pos.y.toFixed(1)},${s.pos.z.toFixed(1)})，氧气 ${s.oxygen}/20`;
    const facts = {
      ...(r.goal ? { goal: r.goal } : {}), ...(r.stage ? { stage: r.stage } : {}),
      ...(r.enteredWater !== undefined ? { enteredWater: r.enteredWater } : {}),
      ...(r.blockedAbove ? { blockedAbove: r.blockedAbove } : {}),
      ...(r.openWater ? { openWater: r.openWater } : {}),
    };
    if (r.ok && r.landed) return ok(`上浮后已站稳干地，氧气 ${s.oxygen}/20`, { landed: true, surfaced: r.surfaced, pos: s.pos, oxygen: s.oxygen, ...facts });
    if (r.ok && r.surfaced) return ok(`已持续换气到氧气 ${s.oxygen}/20（还没上岸）；松开 jump 后会重新下沉，要一直浮着需自己按住 jump（press_keys）或交给会持续上浮/挖开头顶的做法`, { landed: false, surfaced: true, pos: s.pos, oxygen: s.oxygen, ...facts });
    // 时间到只说明预算耗尽，不证明身体卡住，也不断言头一定没露出来；surfaced 以实际返回为准。
    const why = r.reason === 'WATER_ESCAPE_TIMEOUT' ? '上浮时间到，尚未确认完成' : r.reason === 'SWIM_NO_PROGRESS' ? '上浮没动' : r.reason;
    // 把身体实测到的阻挡交给调用方：surface 只按跳，挖开头顶、横游找空气或持续踩水由它自己决定。
    const blockers = [
      ...(r.blockedAbove ? [`头顶 (${r.blockedAbove.x},${r.blockedAbove.y},${r.blockedAbove.z}) 是 ${r.blockedAbove.name}（相对脚部 [0,${r.blockedAbove.y - Math.floor(s.pos.y)},0]；surface 只按跳，不能挖开）`] : []),
      ...(r.openWater ? [`最近的开阔水面在 ${r.openWater.dir} ${r.openWater.dist} 格 (${r.openWater.x},${r.openWater.y},${r.openWater.z})`] : []),
    ].join('；');
    const code = r.reason === 'WATER_ESCAPE_TIMEOUT' ? 'TIMEOUT' : 'STUCK';
    return fail(code, `${why}；${at}${blockers ? `；${blockers}` : ''}`, { landed: false, surfaced: r.surfaced, pos: s.pos, oxygen: s.oxygen, reason: r.reason, ...facts });
  },
};

import { sleep, throwIfAborted } from '../util.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx, type SkillResult } from './types.ts';
import { lookAround } from './movement.ts';
import { sleepSkill } from './build.ts';
import { findStation } from './stations.ts';
import { canSleepAt } from '../perception/perception.ts';
import { creatureSpotsNear } from '../memory/creature-spots.ts';

/** 可以用来封顶/搭建的方块（不含会下落的沙子沙砾） */
export const PLACEABLE = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'granite', 'diorite', 'deepslate', 'netherrack',
  'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
];
const DIGGABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'stone', 'andesite', 'granite', 'diorite', 'deepslate', 'tuff', 'sand', 'gravel', 'clay', 'sandstone']);
const SAFE_FLOOR = new Set([...DIGGABLE, ...PLACEABLE, 'bedrock'].filter((name) => !['sand', 'gravel'].includes(name)));
const AIR = new Set(['air', 'cave_air', 'void_air']);
const PLANTS = new Set(['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'dandelion', 'poppy']);
const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
/** 鱼只在明确指定时才去打：要贴着水面下手，浅水里才去（不潜进深水） */
const FISH = new Set(['cod', 'salmon']);

export const hasPlaceable = (inv: { name: string; count: number }[]) => inv.some((i) => PLACEABLE.includes(i.name) && i.count > 0);

// ------------------------------------------------------------------ shelter
const BED_NAMES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map((c) => `${c}_bed`);

export const shelter: Skill<{ until: 'day' | 'healed' }> = {
  name: 'shelter',
  description: '夜里保命：有床且附近没怪就先睡一觉；否则就地挖 3 格深的坑钻进去封顶，躲到天亮/回血（需要 1 个泥土/圆石/木板等方块）。躲进坑里、四面堵死是正常的，天亮后往上挖 3 格就回到原地',
  argsDoc: '{"until"?: "day|healed"}',
  timeoutMs: 150000,
  movement: false,
  validate(raw) {
    const u = String(obj(raw).until ?? 'day');
    return { ok: true, args: { until: u === 'healed' ? 'healed' : 'day' } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    throwIfAborted(signal);
    const s0 = adapter.state();
    if (!s0.connected || !s0.alive || !s0.observationReady) return fail('NOT_CONNECTED', '当前状态无法确认，不能挖避难所');
    // 睡不睡觉是模型的决定（sleep）；shelter 只管挖坑躲起来
    if (s0.inWater || s0.inLava || !s0.onGround) return fail('ERROR', s0.inWater || s0.inLava ? '人在水里/岩浆里，先上岸站到干地上再躲' : '脚下没站稳（在跳、在掉落或站在树枝树叶上），先站到实地上再躲');
    if (!hasPlaceable(s0.inventory)) return fail('MISSING_MATERIALS', '背包里没有可以封顶的方块（泥土/圆石/木板/原木）');
    const here = { x: Math.floor(s0.pos.x), y: Math.floor(s0.pos.y), z: Math.floor(s0.pos.z) };
    if (pitProblem(adapter, here)) {
      // 脚下挖不了（沙滩、沙砾、石板上…）：像玩家一样先走到附近能挖的泥土/石头地上
      const spot = nearestPitSpot(ctx, here, 12);
      if (spot) {
        ctx.progress(0.05, `这里 ${pitProblem(adapter, here)}，走到 ${Math.round(Math.hypot(spot.x - here.x, spot.z - here.z))} 格外能挖坑的地方`);
        try { await adapter.moveTo({ kind: 'xyz', ...spot }, { signal, timeoutMs: Math.max(3000, Math.min(20000, ctx.deadline - Date.now() - 60000)) }); }
        catch (e) { if (isAbort(e)) throw e; }
        const now = adapter.state();
        const at = { x: Math.floor(now.pos.x), y: Math.floor(now.pos.y), z: Math.floor(now.pos.z) };
        if (!pitProblem(adapter, at) && now.onGround && !now.inWater) {
          const r = await digPit(ctx, args);
          return r.status === 'succeeded' ? { ...r, summary: `原地挖不了，走到 (${at.x},${at.y},${at.z}) 挖了坑：${r.summary}` } : r;
        }
      }
      // 附近没有能挖的地：就地用方块把自己围起来（四面两层墙 + 顶）
      return enclosure(ctx, args, pitProblem(adapter, here)!);
    }
    return digPit(ctx, args);
  },
};

/** 这一格为什么挖不了避难坑（null = 能挖） */
function pitProblem(adapter: SkillCtx['adapter'], p: { x: number; y: number; z: number }): string | null {
  const below = [1, 2, 3, 4].map((dy) => adapter.blockAt({ x: p.x, y: p.y - dy, z: p.z }));
  if (below.slice(0, 3).some((name) => !name || !DIGGABLE.has(name) || name === 'sand' || name === 'gravel') || !below[3] || !SAFE_FLOOR.has(below[3])) return `脚下（${below.join('/')}）没有三层可挖方块和稳定地板`;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let dy = 1; dy <= 3; dy++) {
    const n = adapter.blockAt({ x: p.x + dx, y: p.y - dy, z: p.z + dz });
    if (n === 'water' || n === 'lava') return '坑壁旁边有水/岩浆';
  }
  return null;
}

/** 12 格内最近的能挖坑的站立点（只看身边地表，站在附近就看得见的地形） */
function nearestPitSpot(ctx: SkillCtx, from: { x: number; y: number; z: number }, radius: number) {
  const { adapter } = ctx;
  const cands: { x: number; y: number; z: number; d: number }[] = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const d = Math.hypot(dx, dz);
    if (d > radius || d < 1) continue;
    for (let dy = 3; dy >= -3; dy--) {
      const p = { x: from.x + dx, y: from.y + dy, z: from.z + dz };
      const feet = adapter.blockAt(p), head = adapter.blockAt({ ...p, y: p.y + 1 }), ground = adapter.blockAt({ ...p, y: p.y - 1 });
      if (!feet || !head || !ground || !AIR.has(feet) || !AIR.has(head) || !DIGGABLE.has(ground)) continue;
      if (!pitProblem(adapter, p) && !ctx.memory.hazardAt?.(p, adapter.state().dim)) cands.push({ ...p, d: d + Math.abs(dy) });
      break;
    }
  }
  const best = cands.sort((a, b) => a.d - b.d)[0];
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

/** 就地围一圈：脚和头两层的四面墙 + 头顶一块，躲到天亮/回血 */
async function enclosure(ctx: SkillCtx, args: { until: 'day' | 'healed' }, why: string): Promise<SkillResult> {
  const { adapter, signal } = ctx;
  const s0 = adapter.state();
  const x = Math.floor(s0.pos.x), y = Math.floor(s0.pos.y), z = Math.floor(s0.pos.z);
  // 没走到安全地方（寻路超时等）时人可能站在水里/悬空：这种地方把自己围起来会憋死
  const wet = (n: string | null) => n === 'water' || n === 'lava' || n === 'bubble_column';
  if (s0.inWater || s0.inLava || !s0.onGround || wet(adapter.blockAt({ x, y, z })) || wet(adapter.blockAt({ x, y: y + 1, z }))) {
    return fail('ERROR', `${why}；现在站在水里/岩浆里或没站稳，不能就地围起来——先上岸站到干地上再躲`);
  }
  const cells = [...[[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => [0, 1].map((dy) => ({ x: x + dx, y: y + dy, z: z + dz }))), { x, y: y + 2, z }];
  const open = (p: { x: number; y: number; z: number }) => { const n = adapter.blockAt(p); return n === null || AIR.has(n) || PLANTS.has(n) || n === 'water'; };
  const need = cells.filter(open);
  const blocks = adapter.state().inventory.filter((i) => PLACEABLE.includes(i.name)).reduce((a, i) => a + i.count, 0);
  if (blocks < need.length) return fail('MISSING_MATERIALS', `${why}；附近 12 格也没有能挖坑的泥土/石头地，就地围起来要 ${need.length} 个方块，背包只有 ${blocks} 个（泥土/圆石/木板/原木）`);
  ctx.progress(0.1, `${why}，就地用方块围起来（${need.length} 块）`);
  let placed = 0;
  for (const p of need.sort((a, b) => a.y - b.y)) {
    throwIfAborted(signal);
    const item = PLACEABLE.find((n) => adapter.state().inventory.some((i) => i.name === n && i.count > 0));
    if (!item) break;
    if (PLANTS.has(adapter.blockAt(p) ?? '')) await adapter.dig(p, signal).catch((e) => { if (isAbort(e)) throw e; });
    const r = await adapter.placeBlockAt(p, [item], signal);
    if (r.ok) placed++;
  }
  const sealed = () => cells.every((p) => !open(p));
  for (let i = 0; i < 10 && !sealed(); i++) await sleep(100, signal); // 等服务器回报方块更新
  if (!sealed()) return fail('ERROR', `${why}；试着就地围起来，但还有 ${cells.filter(open).length} 面没封住（放了 ${placed} 块）`);
  ctx.bus.publish('shelter', 'P2', `就地用方块围了个小间 (${x}, ${y}, ${z})，等待${args.until === 'day' ? '天亮' : '回血'}`);
  const waitEnd = ctx.deadline - 3000;
  while (Date.now() < waitEnd) {
    const s = adapter.state();
    if (Math.floor(s.pos.x) !== x || Math.floor(s.pos.z) !== z) return fail('ERROR', '离开了围起来的小间');
    // 小间进水 / 开始憋气：马上拆开一面墙出去，不在里面淹死
    if (s.inWater || s.inLava || s.oxygen < 18) {
      const side = { x: x + 1, y: y + 1, z };
      await adapter.dig(side, signal).catch((e) => { if (isAbort(e)) throw e; });
      await adapter.dig({ ...side, y }, signal).catch((e) => { if (isAbort(e)) throw e; });
      return fail('ERROR', `小间里进了水/开始憋气（氧气 ${s.oxygen}/20），拆开东面的墙出来了`);
    }
    if (!sealed()) return fail('ERROR', '围墙被破开了');
    const morning = s.timeOfDay >= 0 && s.timeOfDay < 11500 && s.isDay;
    if (args.until === 'day' ? morning && s.hp >= 10 : s.hp >= 18) break;
    if (s.food < 18 && adapter.hasFood()) await adapter.eat(signal).catch((e) => { if (isAbort(e)) throw e; });
    ctx.progress(0.3 + 0.7 * Math.min(1, s.hp / 20), `躲在小间里（生命 ${Math.round(s.hp)}）`);
    await sleep(2000, signal);
  }
  const s = adapter.state();
  return ok(`${why}，附近也没有能挖坑的地，就地用 ${placed} 个方块围了个小间，待到${s.isDay ? '天亮' : '现在'}，生命 ${Math.round(s.hp)}；出去时挖开一面墙即可`, { enclosure: true, placed });
}

async function digPit(ctx: SkillCtx, args: { until: 'day' | 'healed' }): Promise<SkillResult> {
  {
    const { adapter, signal } = ctx;
    const s0 = adapter.state();
    const x = Math.floor(s0.pos.x), y = Math.floor(s0.pos.y), z = Math.floor(s0.pos.z);
    const stateProblem = (s: ReturnType<typeof adapter.state>) => {
      if (!s.connected || !s.alive || !s.observationReady || s.worldId !== s0.worldId || s.sessionId !== s0.sessionId || s.dim !== s0.dim) return '当前状态或世界已改变';
      if (s.inWater || s.inLava) return '避难坑进水或有岩浆';
      if (Math.floor(s.pos.x) !== x || Math.floor(s.pos.z) !== z) return '已经离开避难坑';
      return null;
    };
    let capName: string | undefined;
    // 封顶方块会变：泥土见光会长成草方块，也算同一块
    const capOk = (n: string | null) => !!n && (n === capName || (capName === 'dirt' && n === 'grass_block'));
    const chamberProblem = (sealed: boolean) => {
      throwIfAborted(signal);
      const s = adapter.state();
      const problem = stateProblem(s);
      if (problem) return problem;
      if (!s.onGround || Math.abs(s.pos.y - (y - 3)) > 0.1) return '尚未站稳在避难坑底';
      const floor = adapter.blockAt({ x, y: y - 4, z });
      if (!floor || !SAFE_FLOOR.has(floor)) return '避难坑地板不再稳定';
      if ([y - 3, y - 2].some((level) => !AIR.has(adapter.blockAt({ x, y: level, z }) ?? ''))) return '避难坑没有干燥的两格头部空间';
      if (sealed && !capOk(adapter.blockAt({ x, y: y - 1, z }))) return '没有观测到预期封顶方块';
      return null;
    };

    ctx.progress(0.1, '往下挖避难坑');
    try {
      for (const dy of [1, 2, 3]) {
        throwIfAborted(signal);
        if (!DIGGABLE.has(adapter.blockAt({ x, y: y - dy, z }) ?? '')) return fail('ERROR', '待挖方块已改变，停止挖坑');
        const r = await adapter.dig({ x, y: y - dy, z }, signal);
        if (!r.ok) return fail('ERROR', `挖坑失败：${r.reason}`);
        const descentEnd = Math.min(ctx.deadline, Date.now() + 2500);
        while (true) {
          throwIfAborted(signal);
          const s = adapter.state(), problem = stateProblem(s);
          if (problem) return fail('ERROR', problem);
          if (s.onGround && Math.abs(s.pos.y - (y - dy)) <= 0.1 && AIR.has(adapter.blockAt({ x, y: y - dy, z }) ?? '')) break;
          if (Date.now() >= descentEnd) return fail('TIMEOUT', '挖开脚下后未能确认实际落地，停止挖坑');
          await sleep(Math.max(1, Math.min(50, descentEnd - Date.now())), signal);
        }
      }
      const problem = chamberProblem(false);
      if (problem) return fail('ERROR', problem);
      const capInventory = adapter.state().inventory;
      capName = PLACEABLE.find((name) => capInventory.some((item) => item.name === name && item.count > 0));
      if (!capName) return fail('MISSING_MATERIALS', '封顶材料已不可用');
      ctx.progress(0.3, '封顶');
      const cap = await adapter.placeBlockAt({ x, y: y - 1, z }, [capName], signal);
      if (!cap.ok) return fail('ERROR', `封顶失败：${cap.reason}`);
      // 放下后服务器的方块更新要过一会儿才到：等一下再核对
      for (let i = 0; i < 10 && !capOk(adapter.blockAt({ x, y: y - 1, z })); i++) await sleep(100, signal);
      const sealedProblem = chamberProblem(true);
      if (sealedProblem) return fail('ERROR', sealedProblem);
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `挖避难所出错：${(e as Error).message}`);
    }

    ctx.bus.publish('shelter', 'P2', `躲进了地下避难所 (${x}, ${y - 3}, ${z})，等待${args.until === 'day' ? '天亮' : '回血'}`);
    const waitEnd = ctx.deadline - 3000;
    while (Date.now() < waitEnd) {
      const problem = chamberProblem(true);
      if (problem) return fail('ERROR', problem);
      const s = adapter.state();
      // 黄昏时 isDay 仍为真：“躲到天亮”要等到真正的早上（日出后、正午前），否则黄昏躲进去马上就出来了
      const morning = s.timeOfDay >= 0 && s.timeOfDay < 11500 && s.isDay;
      const done = args.until === 'day' ? morning && s.hp >= 10 : s.hp >= 18;
      if (done) break;
      if (s.food < 18 && adapter.hasFood()) await adapter.eat(signal).catch((e) => { if (isAbort(e)) throw e; });
      ctx.progress(0.3 + 0.7 * Math.min(1, s.hp / 20), `躲避中（生命 ${Math.round(s.hp)}）`);
      await sleep(2000, signal);
    }
    const problem = chamberProblem(true);
    if (problem) return fail('ERROR', problem);
    const s = adapter.state();
    return ok(`在避难所里待到${s.isDay ? '天亮' : '现在'}，生命 ${Math.round(s.hp)}；人在自己挖的坑底，正上方 3 格就是原来的地面，出去时 dig {"dir":"up","blocks":3} 或直接走动（会挖开顶上的方块）`);
  }
}

// ------------------------------------------------------------------ hunt
export const hunt: Skill<{ animal?: string; count: number }> = {
  name: 'hunt',
  description: '猎杀看得见的牛/猪/羊/鸡/兔子获取食物，并捡起掉落物。饥饿值低且背包没有食物时使用；animal 写 cod/salmon 时在浅水边打鱼（只打离水面近的，不潜深水）',
  argsDoc: '{"animal"?: "cow|pig|sheep|chicken|rabbit|cod|salmon", "count"?: 1-4}',
  timeoutMs: 90000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const animal = a.animal ? String(a.animal) : undefined;
    if (animal && !FOOD_ANIMALS.has(animal) && !FISH.has(animal)) return { ok: false, error: `animal 必须是 ${[...FOOD_ANIMALS, ...FISH].join('/')}` };
    return { ok: true, args: { animal, count: clampInt(a.count, 1, 4, 1) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    await adapter.equipWeapon();
    let kills = 0, searches = 0, escaped = 0, walks = 0;
    const fishing = !!args.animal && FISH.has(args.animal);
    // 鱼：只打浅水里的（鱼离脚下不超过 2 格深、上面 3 格内就是水面），人站在岸边/浅水里下手
    const shallow = (p: { x: number; y: number; z: number }) => {
      if (p.y < adapter.state().pos.y - 2.5) return false;
      for (let dy = 1; dy <= 3; dy++) {
        const n = adapter.blockAt({ x: Math.floor(p.x), y: Math.floor(p.y) + dy, z: Math.floor(p.z) }) ?? 'air';
        if (n === 'air' || n === 'cave_air') return true;
        if (n !== 'water' && n !== 'seagrass' && n !== 'kelp' && n !== 'kelp_plant') return false;
      }
      return false;
    };
    let deepFish = 0;
    const findPrey = () => senses.perceivedEntities(48)
      .find((e) => {
        if (e.kind !== 'passive') return false;
        if (fishing) {
          if (e.name !== args.animal) return false;
          if (!shallow(e.pos)) { deepFish++; return false; }
          return true;
        }
        return FOOD_ANIMALS.has(e.name) && (!args.animal || e.name === args.animal);
      });
    while (kills < args.count && Date.now() < ctx.deadline) {
      senses.refresh();
      let target = findPrey();
      // 刚才亲眼看见过（例如探索时远远看到），现在被树/坡挡住了：先走到最后看见它的地方
      if (!target && senses.lastSighting && walks < 2 && !fishing) {
        const last = senses.lastSighting((n) => FOOD_ANIMALS.has(n) && (!args.animal || n === args.animal), 120_000);
        const here = adapter.state().pos;
        if (last && Math.hypot(last.pos.x - here.x, last.pos.z - here.z) > 3 && Math.hypot(last.pos.x - here.x, last.pos.z - here.z) <= 160) {
          walks++;
          ctx.progress(kills / args.count, `走向 ${Math.round(last.ageMs / 1000)} 秒前看见 ${last.name} 的地方`);
          const stop = new AbortController();
          const iv = setInterval(() => { senses.refresh(); if (findPrey()) stop.abort('prey_seen'); }, 400);
          try {
            await adapter.moveTo({ kind: 'near', pos: last.pos, range: 3 }, { signal: AbortSignal.any([signal, stop.signal]), timeoutMs: 40000 });
          } catch (e) {
            if (signal.aborted) throw e;
          } finally {
            clearInterval(iv);
          }
          continue;
        }
      }
      // 动物刚才还在、一转眼走出视野是常事：先转头找一找再说（最多两次）
      if (!target && searches < 2 && !adapter.state().inWater) {
        searches++;
        ctx.progress(kills / args.count, `四下找找${args.animal ?? '动物'}`);
        await lookAround.run(ctx, { seconds: 3, ...(args.animal ? { for: args.animal } : {}) });
        senses.refresh();
        target = findPrey();
      }
      const what = args.animal ?? '可以猎杀的动物';
      if (!target) {
        if (kills) return ok(`猎到 ${kills} 只，附近没有更多猎物`, { kills, searched: true });
        // 说清楚看见了什么：只有马、只有别的动物、还是什么都没有——下一步才知道该换目标还是换地方
        const others = new Map<string, number>();
        for (const e of senses.perceivedEntities(48)) if (e.kind === 'passive' && e.name !== args.animal) others.set(e.name, (others.get(e.name) ?? 0) + 1);
        const food = [...others].filter(([n]) => FOOD_ANIMALS.has(n));
        const seen = others.size ? `；看得见的动物：${[...others].map(([n, c]) => `${n}×${c}`).join('、')}${food.length && args.animal ? '（其中有能吃的，可以改猎它们）' : ''}` : '；视野里一只动物都没有';
        // 眼前没有，但记得别处见过：说出在哪、多久前（动物会走动，只是大概那一带；去不去由心智定）
        const st = ctx.adapter.state();
        const want = args.animal ? [args.animal] : [...FOOD_ANIMALS];
        const spots = creatureSpotsNear(ctx.memory.landmarks(), { worldId: st.worldId, dim: st.dim, pos: st.pos }, { only: want, excludeWithin: 12 }).slice(0, 3);
        const remembered = spots.length ? `；记得别处见过：${spots.map((o) => `${o.label} ${o.text}`).join('；')}——要去就 goto {"target":"${spots[0].pos.x},${spots[0].pos.y},${spots[0].pos.z}"} 再 hunt` : '';
        return fail('NOT_FOUND', `转头找过了，视野里没有${fishing && deepFish ? `能在浅水够到的 ${what}（看见的都在深水里，不潜下去）` : what}${escaped ? `（有 ${escaped} 只跑出了视线）` : ''}${seen}${remembered || '；动物多在开阔的草地、平原，可以 explore 换个地方，或 forage 摘苹果/浆果'}`, { searched: true, seen: Object.fromEntries(others), ...(spots.length ? { remembered: spots.map((o) => o.pos) } : {}) });
      }
      const id = target.id;
      let lastPos = target.pos;
      let hits = 0, lastDist = target.dist;
      ctx.progress(kills / args.count, `追 ${target.name}（${Math.round(target.dist)} 格）`);
      const huntEnd = Math.min(ctx.deadline, Date.now() + 30000);
      while (Date.now() < huntEnd) {
        senses.refresh();
        target = senses.perceivedEntities(48).find((e) => e.id === id);
        if (!target) break; // 死了或跑出视野
        lastPos = target.pos;
        lastDist = target.dist;
        // 打鱼时鱼游进深水 / 自己氧气不够：不追下去
        if (fishing && (!shallow(target.pos) || adapter.state().oxygen < 14)) { target = undefined; hits = -1; break; }
        if (target.dist > 3) {
          try {
            await adapter.moveTo({ kind: 'follow_entity', entityId: id, range: 2 }, { signal, timeoutMs: 4000 });
          } catch (e) {
            if (isAbort(e)) throw e;
          }
          continue;
        }
        await adapter.attack(id);
        hits++;
        await sleep(600, signal);
      }
      if (target) continue; // 超时没追上，换下一只
      if (hits < 0) { escaped++; continue; } // 鱼进了深水，放过它
      // 没打到过、或消失时离得很远：是跑出了视线，不是被打死了
      if (hits === 0 || lastDist > 4.5) { escaped++; continue; }
      kills++;
      try {
        await adapter.moveTo({ kind: 'near', pos: lastPos, range: 1 }, { signal, timeoutMs: 6000 });
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      await adapter.collectNearbyDrops(signal, 5, 4000);
    }
    return kills ? ok(`猎到 ${kills} 只动物`, { kills }) : fail('TIMEOUT', `没能追上猎物${escaped ? `（${escaped} 只跑掉了）` : ''}`);
  },
};

// ------------------------------------------------------------------ pickup_items
export const pickupItems: Skill<{ radius: number; item?: string }> = {
  name: 'pickup_items',
  description: '捡起附近看得见的掉落物（可只捡某种物品 item），报告实际进了背包的东西',
  argsDoc: '{"radius"?: 4-24, "item"?: "<物品名>"}',
  timeoutMs: 60000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const a = obj(raw);
    const item = typeof a.item === 'string' && a.item.trim() ? a.item.trim().replace(/^minecraft:/, '') : undefined;
    return { ok: true, args: { radius: clampInt(a.radius, 4, 24, 12), ...(item ? { item } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const tried = new Set<number>();
    const chased = new Map<number, number>();
    const inv = () => {
      const m = new Map<string, number>();
      for (const i of adapter.state().inventory) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
      return m;
    };
    const before = inv();
    // 指名要捡：哪怕是刚扔掉的，也是改主意了，捡回来不算“又捡回来了”
    if (args.item) adapter.forgetDiscarded?.(args.item);
    const wanted = (name: string, _pos?: { x: number; y: number; z: number }) => !args.item || name.replace(/^item:/, '') === args.item;
    let visits = 0;
    let looked = false;
    for (let i = 0; i < 30 && Date.now() < ctx.deadline; i++) {
      senses.refresh();
      // 漂在水里的掉落物会动：同一个最多追 3 次，每次按它现在的位置
      let item = senses.perceivedEntities(args.radius).find((e) => e.kind === 'item' && (chased.get(e.id) ?? 0) < 3 && wanted(e.name, e.pos));
      // 指名要捡的东西（比如自己刚拆下的床）眼前没看见：先转一圈、低头找找（只用眼睛，不透视实体列表）
      if (!item && args.item && !looked) {
        looked = true;
        try { await lookAround.run(ctx, { seconds: 3, for: args.item }); } catch (e) { if (isAbort(e)) throw e; }
        senses.refresh();
        item = senses.perceivedEntities(args.radius).find((e) => e.kind === 'item' && (chased.get(e.id) ?? 0) < 3 && wanted(e.name, e.pos));
      }
      if (!item) break;
      chased.set(item.id, (chased.get(item.id) ?? 0) + 1);
      tried.add(item.id);
      try {
        await adapter.moveTo({ kind: 'near', pos: item.pos, range: 1 }, { signal, timeoutMs: 8000 });
        visits++;
        ctx.progress(Math.min(1, visits / 10), `去捡 ${item.name.replace(/^item:/, '')}`);
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      await sleep(250, signal);
    }
    // 按背包实际变化报告捡到了什么
    const after = inv();
    const increases = [...after].filter(([n, c]) => c > (before.get(n) ?? 0)).map(([name, count]) => ({ name, count: count - (before.get(name) ?? 0) }));
    const gained = increases.map(({ name, count }) => `${name}×${count}`);
    const collected = increases.filter(({ name }) => wanted(name)).reduce((sum, item) => sum + item.count, 0);
    if (args.item && collected === 0) {
      const block = senses.knownBlocks([args.item], args.radius)[0];
      return fail('NOT_FOUND', `${visits ? `走过去了 ${visits} 处掉落物，但没有捡到` : '附近没有看得见的'} ${args.item} 掉落物${block ? `；已知放置方块在 (${block.pos.x},${block.pos.y},${block.pos.z})，搬走要先精确挖下该方块，再捡掉落物` : '；不能把已放置的方块当成掉落物，也不要假设已经拿到'}`,
        { gained, collected, visits, ...(block ? { blockTarget: { name: block.name, pos: block.pos } } : {}) });
    }
    if (gained.length) return ok(`捡到了 ${gained.join('、')}`, { gained, collected, visits });
    return visits ? ok(`走过去了 ${visits} 处掉落物，但背包没有变化（可能被捡走了或够不着）`, { gained, collected, visits }) : ok('附近没有看得见的掉落物', { gained, collected, visits });
  },
};

import { sleep, throwIfAborted } from '../util.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';
import { lookAround } from './movement.ts';

/** 可以用来封顶/搭建的方块（不含会下落的沙子沙砾） */
export const PLACEABLE = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'granite', 'diorite', 'deepslate', 'netherrack',
  'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
];
const DIGGABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'stone', 'andesite', 'granite', 'diorite', 'deepslate', 'tuff', 'sand', 'gravel', 'clay', 'sandstone']);
const SAFE_FLOOR = new Set([...DIGGABLE, ...PLACEABLE, 'bedrock'].filter((name) => !['sand', 'gravel'].includes(name)));
const AIR = new Set(['air', 'cave_air', 'void_air']);
const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);

export const hasPlaceable = (inv: { name: string; count: number }[]) => inv.some((i) => PLACEABLE.includes(i.name) && i.count > 0);

// ------------------------------------------------------------------ shelter
export const shelter: Skill<{ until: 'day' | 'healed' }> = {
  name: 'shelter',
  description: '就地挖一个 3 格深的坑钻进去，在地表封顶并留出两格空间，躲到天亮/回血（需要至少 1 个泥土/圆石/木板/原木等方块）。夜晚或低血量时的保命手段',
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
    if (s0.inWater || s0.inLava || !s0.onGround) return fail('ERROR', '必须在干燥地面上挖避难所');
    if (!hasPlaceable(s0.inventory)) return fail('MISSING_MATERIALS', '背包里没有可以封顶的方块（泥土/圆石/木板/原木）');
    const x = Math.floor(s0.pos.x), y = Math.floor(s0.pos.y), z = Math.floor(s0.pos.z);
    const below = [1, 2, 3, 4].map((dy) => adapter.blockAt({ x, y: y - dy, z }));
    if (below.slice(0, 3).some((name) => !name || !DIGGABLE.has(name)) || !below[3] || !SAFE_FLOOR.has(below[3])) return fail('ERROR', `脚下（${below.join('/')}）没有三层可挖方块和稳定地板`);
    const stateProblem = (s: ReturnType<typeof adapter.state>) => {
      if (!s.connected || !s.alive || !s.observationReady || s.worldId !== s0.worldId || s.sessionId !== s0.sessionId || s.dim !== s0.dim) return '当前状态或世界已改变';
      if (s.inWater || s.inLava) return '避难坑进水或有岩浆';
      if (Math.floor(s.pos.x) !== x || Math.floor(s.pos.z) !== z) return '已经离开避难坑';
      return null;
    };
    let capName: string | undefined;
    const chamberProblem = (sealed: boolean) => {
      throwIfAborted(signal);
      const s = adapter.state();
      const problem = stateProblem(s);
      if (problem) return problem;
      if (!s.onGround || Math.abs(s.pos.y - (y - 3)) > 0.1) return '尚未站稳在避难坑底';
      const floor = adapter.blockAt({ x, y: y - 4, z });
      if (!floor || !SAFE_FLOOR.has(floor)) return '避难坑地板不再稳定';
      if ([y - 3, y - 2].some((level) => !AIR.has(adapter.blockAt({ x, y: level, z }) ?? ''))) return '避难坑没有干燥的两格头部空间';
      if (sealed && adapter.blockAt({ x, y: y - 1, z }) !== capName) return '没有观测到预期封顶方块';
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
    return ok(`在避难所里待到${s.isDay ? '天亮' : '现在'}，生命 ${Math.round(s.hp)}；出去时直接走动即可（会挖开顶上的方块）`);
  },
};

// ------------------------------------------------------------------ hunt
export const hunt: Skill<{ animal?: string; count: number }> = {
  name: 'hunt',
  description: '猎杀看得见的牛/猪/羊/鸡/兔子获取食物，并捡起掉落物。饥饿值低且背包没有食物时使用',
  argsDoc: '{"animal"?: "cow|pig|sheep|chicken|rabbit", "count"?: 1-4}',
  timeoutMs: 90000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const animal = a.animal ? String(a.animal) : undefined;
    if (animal && !FOOD_ANIMALS.has(animal)) return { ok: false, error: `animal 必须是 ${[...FOOD_ANIMALS].join('/')}` };
    return { ok: true, args: { animal, count: clampInt(a.count, 1, 4, 1) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    await adapter.equipWeapon();
    let kills = 0, searches = 0, escaped = 0, walks = 0;
    const findPrey = () => senses.perceivedEntities(48)
      .find((e) => e.kind === 'passive' && FOOD_ANIMALS.has(e.name) && (!args.animal || e.name === args.animal));
    while (kills < args.count && Date.now() < ctx.deadline) {
      senses.refresh();
      let target = findPrey();
      // 刚才亲眼看见过（例如探索时远远看到），现在被树/坡挡住了：先走到最后看见它的地方
      if (!target && senses.lastSighting && walks < 2) {
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
      if (!target) return kills ? ok(`猎到 ${kills} 只，附近没有更多猎物`, { kills, searched: true })
        : fail('NOT_FOUND', `转头找过了，视野里没有${what}${escaped ? `（有 ${escaped} 只跑出了视线）` : ''}`, { searched: true });
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
  validate(raw) {
    const a = obj(raw);
    const item = typeof a.item === 'string' && a.item.trim() ? a.item.trim().replace(/^minecraft:/, '') : undefined;
    return { ok: true, args: { radius: clampInt(a.radius, 4, 24, 12), ...(item ? { item } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const tried = new Set<number>();
    const inv = () => {
      const m = new Map<string, number>();
      for (const i of adapter.state().inventory) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
      return m;
    };
    const before = inv();
    const wanted = (name: string) => !args.item || name.replace(/^item:/, '') === args.item;
    let visits = 0;
    for (let i = 0; i < 30 && Date.now() < ctx.deadline; i++) {
      senses.refresh();
      const item = senses.perceivedEntities(args.radius).find((e) => e.kind === 'item' && !tried.has(e.id) && wanted(e.name));
      if (!item) break;
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
    const gained = [...after].filter(([n, c]) => c > (before.get(n) ?? 0)).map(([n, c]) => `${n}×${c - (before.get(n) ?? 0)}`);
    if (gained.length) return ok(`捡到了 ${gained.join('、')}`, { gained });
    return visits ? ok(`走过去了 ${visits} 处掉落物，但背包没有变化（可能被捡走了或够不着）`) : ok(`附近没有看得见的${args.item ? ` ${args.item} ` : ''}掉落物`);
  },
};

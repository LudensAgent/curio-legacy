import { sleep } from '../util.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

/** 可以用来封顶/搭建的方块（不含会下落的沙子沙砾） */
export const PLACEABLE = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'granite', 'diorite', 'deepslate', 'netherrack',
  'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
];
const DIGGABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'stone', 'andesite', 'granite', 'diorite', 'deepslate', 'tuff', 'sand', 'gravel', 'clay', 'sandstone']);
const UNSAFE = new Set(['air', 'cave_air', 'water', 'lava', 'bedrock']);
const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);

export const hasPlaceable = (inv: { name: string; count: number }[]) => inv.some((i) => PLACEABLE.includes(i.name) && i.count > 0);

// ------------------------------------------------------------------ shelter
export const shelter: Skill<{ until: 'day' | 'healed' }> = {
  name: 'shelter',
  description: '就地挖一个 2 格深的坑钻进去，用背包里的方块封顶，躲到天亮/回血（需要至少 1 个泥土/圆石/木板/原木等方块）。夜晚或低血量时的保命手段',
  argsDoc: '{"until"?: "day|healed"}',
  timeoutMs: 150000,
  movement: false,
  validate(raw) {
    const u = String(obj(raw).until ?? 'day');
    return { ok: true, args: { until: u === 'healed' ? 'healed' : 'day' } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    const s0 = adapter.state();
    if (s0.inWater) return fail('ERROR', '在水里无法挖避难所');
    if (!hasPlaceable(s0.inventory)) return fail('MISSING_MATERIALS', '背包里没有可以封顶的方块（泥土/圆石/木板/原木）');
    const x = Math.floor(s0.pos.x), y = Math.floor(s0.pos.y), z = Math.floor(s0.pos.z);
    const b1 = adapter.blockAt({ x, y: y - 1, z }) ?? 'air';
    const b2 = adapter.blockAt({ x, y: y - 2, z }) ?? 'air';
    const b3 = adapter.blockAt({ x, y: y - 3, z }) ?? 'air';
    if (!DIGGABLE.has(b1) || !DIGGABLE.has(b2) || UNSAFE.has(b3)) return fail('ERROR', `脚下（${b1}/${b2}/${b3}）不适合往下挖`);

    ctx.progress(0.1, '往下挖避难坑');
    try {
      for (const dy of [1, 2]) {
        const r = await adapter.dig({ x, y: y - dy, z }, signal);
        if (!r.ok) return fail('ERROR', `挖坑失败：${r.reason}`);
        await sleep(700, signal); // 等掉下去
      }
      ctx.progress(0.3, '封顶');
      const cap = await adapter.placeBlockAt({ x, y, z }, PLACEABLE, signal);
      if (!cap.ok) return fail('ERROR', `封顶失败：${cap.reason}`);
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `挖避难所出错：${(e as Error).message}`);
    }

    ctx.bus.publish('shelter', 'P2', `躲进了地下避难所 (${x}, ${y - 2}, ${z})，等待${args.until === 'day' ? '天亮' : '回血'}`);
    const waitEnd = ctx.deadline - 3000;
    while (Date.now() < waitEnd) {
      const s = adapter.state();
      const done = args.until === 'day' ? s.isDay && s.hp >= 10 : s.hp >= 18;
      if (done) break;
      if (s.food < 18 && adapter.hasFood()) await adapter.eat(signal).catch((e) => { if (isAbort(e)) throw e; });
      ctx.progress(0.3 + 0.7 * Math.min(1, s.hp / 20), `躲避中（生命 ${Math.round(s.hp)}）`);
      await sleep(2000, signal);
    }
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
    let kills = 0;
    while (kills < args.count && Date.now() < ctx.deadline) {
      senses.refresh();
      let target = senses
        .perceivedEntities(48)
        .find((e) => e.kind === 'passive' && FOOD_ANIMALS.has(e.name) && (!args.animal || e.name === args.animal));
      if (!target) return kills ? ok(`猎到 ${kills} 只，附近没有更多猎物`) : fail('NOT_FOUND', '视野里没有可以猎杀的动物');
      const id = target.id;
      let lastPos = target.pos;
      ctx.progress(kills / args.count, `追 ${target.name}（${Math.round(target.dist)} 格）`);
      const huntEnd = Math.min(ctx.deadline, Date.now() + 30000);
      while (Date.now() < huntEnd) {
        senses.refresh();
        target = senses.perceivedEntities(48).find((e) => e.id === id);
        if (!target) break; // 死了或跑出视野
        lastPos = target.pos;
        if (target.dist > 3) {
          try {
            await adapter.moveTo({ kind: 'follow_entity', entityId: id, range: 2 }, { signal, timeoutMs: 4000 });
          } catch (e) {
            if (isAbort(e)) throw e;
          }
          continue;
        }
        await adapter.attack(id);
        await sleep(600, signal);
      }
      if (target) continue; // 超时没追上，换下一只
      kills++;
      try {
        await adapter.moveTo({ kind: 'near', pos: lastPos, range: 1 }, { signal, timeoutMs: 6000 });
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      await adapter.collectNearbyDrops(signal, 5, 4000);
    }
    return kills ? ok(`猎到 ${kills} 只动物`) : fail('TIMEOUT', '没能追上猎物');
  },
};

// ------------------------------------------------------------------ pickup_items
export const pickupItems: Skill<{ radius: number }> = {
  name: 'pickup_items',
  description: '捡起附近看得见的掉落物（例如死亡后回到死亡地点时使用）',
  argsDoc: '{"radius"?: 4-24}',
  timeoutMs: 60000,
  movement: true,
  validate(raw) {
    return { ok: true, args: { radius: clampInt(obj(raw).radius, 4, 24, 12) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    const tried = new Set<number>();
    let picked = 0;
    for (let i = 0; i < 30 && Date.now() < ctx.deadline; i++) {
      senses.refresh();
      const item = senses.perceivedEntities(args.radius).find((e) => e.kind === 'item' && !tried.has(e.id));
      if (!item) break;
      tried.add(item.id);
      try {
        await adapter.moveTo({ kind: 'near', pos: item.pos, range: 1 }, { signal, timeoutMs: 8000 });
        picked++;
        ctx.progress(Math.min(1, picked / 10), `已拾取 ${picked} 组`);
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      await sleep(250, signal);
    }
    return picked ? ok(`拾取了 ${picked} 组掉落物`) : ok('附近没有看得见的掉落物');
  },
};

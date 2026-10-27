import type { WorldMemory } from '../memory/store.ts';
import type { Percept } from '../perception/perception.ts';
import { buildingArchiveFor } from '../skills/build.ts';

/**
 * 兼容规则模式的游玩驱动力；自主模型改用 observedNeeds 的事实投影。
 * 每个驱动力 0..1，附带原因和建议，按强度排序。它们不直接控制动作，只影响“想做什么”。
 */
export interface Drive {
  drive: 'survive' | 'recover' | 'eat' | 'rest' | 'light' | 'tools' | 'efficiency' | 'home' | 'bed' | 'storage' | 'smelt' | 'farm' | 'stockpile' | 'expedition' | 'explore' | 'curiosity' | 'novelty' | 'automate';
  level: number;
  why: string;
  suggest: string;
}

const LOG = (n: string) => n.endsWith('_log');
const PLANK = (n: string) => n.endsWith('_planks');
const FOOD = new Set(['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'apple', 'baked_potato', 'carrot', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_rabbit', 'potato', 'sweet_berries', 'melon_slice', 'golden_apple', 'cookie', 'pumpkin_pie', 'beetroot', 'dried_kelp']);
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];

export interface Stock {
  logs: number;
  planks: number;
  cobblestone: number;
  food: number;
  wool: number;
  blocks: number;
  hasBed: boolean;
  toolTier: 'none' | 'wood' | 'stone' | 'iron' | 'diamond';
}

export function stockOf(p: Percept): Stock {
  const sum = (f: (n: string) => boolean) => p.inventory.filter((i) => f(i.name)).reduce((a, i) => a + i.count, 0);
  const has = (n: string) => p.inventory.some((i) => i.name === n);
  const toolTier = has('diamond_pickaxe') ? 'diamond' : has('iron_pickaxe') ? 'iron' : has('stone_pickaxe') ? 'stone' : has('wooden_pickaxe') ? 'wood' : 'none';
  return {
    logs: sum(LOG),
    planks: sum(PLANK),
    cobblestone: sum((n) => n === 'cobblestone' || n === 'cobbled_deepslate'),
    food: sum((n) => FOOD.has(n)),
    wool: sum((n) => n.endsWith('_wool')),
    blocks: sum((n) => LOG(n) || PLANK(n) || n === 'cobblestone' || n === 'dirt'),
    hasBed: p.inventory.some((i) => i.name.endsWith('_bed')),
    toolTier,
  };
}

export interface ObservedNeed {
  need: 'health' | 'hunger' | 'visibility' | 'carry_space' | 'time' | 'lost_items' | 'effort';
  facts: string[];
  unknowns?: string[];
}

/** Autonomous input describes experienced constraints, never a rule planner's preferred goals or routes. */
export function observedNeeds(p: Percept): ObservedNeed[] {
  const needs: ObservedNeed[] = [];
  if (p.self.hp < 20 || p.self.inWater || p.self.inLava || p.nearby.hostile.length) {
    needs.push({ need: 'health', facts: [
      `生命 ${p.self.hp}/20`,
      ...(p.self.inWater ? ['身体在水中'] : []),
      ...(p.self.inLava ? ['身体在岩浆中'] : []),
      ...p.nearby.hostile.slice(0, 4).map((h) => `${h.how === 'seen' ? '看见' : '听见'} ${h.name}，距离 ${h.dist} 格`),
    ] });
  }
  const food = stockOf(p).food;
  if (p.self.food < 20 || food === 0) {
    needs.push({ need: 'hunger', facts: [`饥饿值 ${p.self.food}/20`, `背包食物类物品 ${food} 个`],
      ...(food === 0 ? { unknowns: ['当前观察以外的食物来源尚未确认'] } : {}) });
  }
  if (p.time.phase === 'dusk' || p.time.phase === 'night') {
    needs.push({ need: 'time', facts: [`当前是${p.time.phase === 'night' ? '夜晚' : '黄昏'}`] });
  }
  const light = p.light;
  if (light && (light.level === 'dark' || light.mob_spawn_risk)) {
    needs.push({ need: 'visibility', facts: [`身边亮度 ${light.here}/15`, `视野 ${light.dark_view_pct}% 看不清`,
      `背包火把 ${light.torches} 支`, ...(light.mob_spawn_risk ? ['身边光照条件有刷怪风险'] : [])] });
  }
  if (p.emptySlots <= 5) needs.push({ need: 'carry_space', facts: [`背包剩余 ${p.emptySlots} 个空位`] });
  if (p.death_recovery) {
    const d = p.death_recovery;
    needs.push({ need: 'lost_items', facts: [`死亡时遗失 ${d.lost}`, `记忆中的掉落位置在 ${d.dir} ${d.dist} 格外`,
      `预计距掉落物消失还有 ${d.seconds_left} 秒`], unknowns: ['掉落物的当前状态与前往路线尚未确认'] });
  }
  for (const e of (p.efficiency ?? []).slice(0, 2)) {
    needs.push({ need: 'effort', facts: [`最近用${e.tool}挖了 ${e.mined} 个 ${e.block}，实测平均 ${e.avg_s} 秒/个`] });
  }
  return needs;
}

export function computeDrives(p: Percept, memory: WorldMemory): { drives: Drive[]; stock: Stock } {
  const st = stockOf(p);
  const out: Drive[] = [];
  const night = p.time.phase === 'night';
  const dusk = p.time.phase === 'dusk';
  const hostiles = p.nearby.hostile.length;
  const animals = (p.vision?.seen_entities ?? []).filter((e) => FOOD_ANIMALS.includes(e.name));
  // 有没有自己的房子：看建筑档案里是否有验收通过的作品（房子是自己设计的，名字不固定）
  const homeBuilt = (() => { try { return buildingArchiveFor(memory as any).list().some((p) => p.status === 'complete' && (!p.worldId || p.worldId === memory.worldId)); } catch { return false; } })()
    || memory.landmarks().some((l) => l.label.startsWith('我的hut') || l.label.startsWith('我的big_hut'));
  const bedPlaced = memory.landmarks().some((l) => l.label === '我的床');
  const recent = memory.recentGoals(6);
  const sameTypeStreak = (() => {
    let n = 0;
    const t = recent[recent.length - 1]?.goalType;
    for (let i = recent.length - 1; i >= 0 && recent[i].goalType === t; i--) n++;
    return { type: t, n };
  })();

  if (p.death_recovery) {
    const d = p.death_recovery;
    out.push({ drive: 'recover', level: d.seconds_left > d.dist / 3 + 20 ? 0.95 : 0.3, why: `死亡掉落物（${d.lost}）还在 ${d.dir} ${d.dist} 格外，${d.seconds_left} 秒后消失`, suggest: 'goto {target:"death"} 然后 pickup_items' });
  }
  if (p.self.hp <= 8 || (hostiles >= 2 && p.self.hp <= 14)) {
    out.push({ drive: 'survive', level: p.self.hp <= 5 ? 1 : 0.8, why: `生命 ${p.self.hp}，附近敌对 ${hostiles} 个`, suggest: night ? 'shelter（挖坑封顶躲到天亮）' : '远离危险、吃东西回血' });
  }
  if (p.self.food <= 14 || st.food === 0) {
    const lvl = p.self.food <= 6 ? 0.9 : p.self.food <= 14 ? 0.6 : 0.3;
    out.push({ drive: 'eat', level: lvl, why: `饥饿值 ${p.self.food}/20，背包食物 ${st.food} 个（饥饿值 ≥18 才会自然回血）`, suggest: st.food > 0 ? 'eat' : animals.length ? `hunt（视野里有 ${animals.map((a) => a.name).join('、')}）` : '去草原/平原找动物 hunt' });
  }
  if (night || dusk) {
    out.push({
      drive: 'rest',
      level: night ? 0.75 : 0.5,
      why: night ? '天黑了，怪物在外面游荡' : '太阳在落山，晚上 7 点天黑刷怪',
      suggest: st.hasBed || bedPlaced ? 'sleep（有床直接睡过夜）' : homeBuilt ? 'goto base 回小屋' : st.blocks >= 1 ? 'shelter；有材料的话白天自己设计一间小屋 build' : '尽快收集几个方块以便 shelter',
    });
  }
  // 亮度：暗处看不清、会刷怪 → 插火把；没有火把就做；没煤就去挖煤
  const L = p.light;
  if (L && !p.self.inWater) {
    const coalKnown = p.nearby.resources.find((r) => r.block.includes('coal_ore'));
    const hasCoal = p.inventory.some((i) => i.name === 'coal' || i.name === 'charcoal');
    if (L.level === 'dark' || (L.mob_spawn_risk && L.underground)) {
      const lvl = L.underground ? 0.7 : 0.45;
      if (L.torches > 0) out.push({ drive: 'light', level: lvl, why: `这里很暗（亮度 ${L.here}/15${L.mob_spawn_risk ? '，会刷怪' : ''}，视野 ${L.dark_view_pct}% 看不清）`, suggest: 'place_torch' });
      else if (hasCoal) out.push({ drive: 'light', level: lvl, why: `这里很暗（亮度 ${L.here}/15），背包有煤但没有火把`, suggest: 'craft torch（1 煤 + 1 木棍 = 4 火把）然后 place_torch' });
      else if (coalKnown) out.push({ drive: 'light', level: lvl - 0.15, why: `这里很暗，没有火把；记得 ${coalKnown.dir ?? ''} ${coalKnown.nearest} 格外有煤矿`, suggest: 'gather coal 再 craft torch' });
    } else if (L.torches === 0 && (dusk || (st.toolTier !== 'none' && !night)) && (hasCoal || coalKnown)) {
      out.push({ drive: 'light', level: dusk ? 0.45 : 0.3, why: '身上没有火把，天黑或下矿时会看不清', suggest: hasCoal ? 'craft torch' : `gather coal（${coalKnown!.dir ?? ''} ${coalKnown!.nearest} 格）再 craft torch` });
    }
  }
  if (st.toolTier === 'none' || st.toolTier === 'wood') {
    const woodKnown = p.nearby.resources.find((r) => LOG(r.block));
    const woodInPack = st.logs > 0 || st.planks > 0;
    const available = woodInPack || !!woodKnown;
    out.push({ drive: 'tools', level: st.toolTier === 'wood' ? 0.55 : available ? 0.7 : 0.35,
      why: `当前镐子等级：${st.toolTier}；${woodInPack ? '背包已有木料' : woodKnown ? `${woodKnown.seen === 'now' ? '看见' : '记得'} ${woodKnown.dir ?? ''} ${woodKnown.nearest} 格外有木料` : '当前观察和记忆中没有木料线索，其他区域仍未知'}`,
      suggest: st.toolTier === 'wood' ? '若当前活动需要，可利用已知石材改善工具；也可继续当前兴趣'
        : available ? '若当前活动需要工具，可评估已有木料或已知资源与制作条件，选择合适工具'
          : '先判断当前兴趣是否需要工具，并比较获取材料、调整方法或暂缓的代价；缺镐子不指定下一目标',
    });
  }
  // 偷懒：同一种东西挖得多又慢，换把好工具更划算
  for (const e of p.efficiency ?? []) {
    const b = e.better.find((x) => !x.have);
    if (!b) continue;
    const level = Math.min(0.85, 0.35 + 0.1 * Math.min(e.mined, 6) * (b.speedup - 1) / 2);
    out.push({ drive: 'efficiency', level, why: `最近用${e.tool}挖了 ${e.mined} 个 ${e.block}，平均 ${e.avg_s} 秒/个；${b.tool} 约 ${b.est_s} 秒/个（快 ${b.speedup} 倍）`, suggest: `craft ${b.tool}（${b.materials}），之后再继续` });
    break;
  }
  if (!homeBuilt && st.toolTier !== 'none' && !night) {
    const need = 71;
    const enough = st.blocks + st.logs * 3 >= need;
    const woodAround = p.nearby.resources.some((r) => r.block.endsWith('_log'));
    out.push({ drive: 'home', level: enough ? 0.65 : woodAround ? 0.6 : 0.45, why: '还没有自己的房子，晚上只能挖坑', suggest: st.blocks + st.logs * 3 >= need ? '自己设计一间小屋：build {spec:{name, design:{legend, layers}}}' : `先备 ${need} 个方块（约 ${Math.ceil((need - st.blocks) / 4)} 个原木做木板）再自己设计一间小屋 build` });
  }
  if (!st.hasBed && !bedPlaced) {
    const sheep = animals.some((a) => a.name === 'sheep');
    out.push({ drive: 'bed', level: sheep ? 0.5 : 0.3, why: '没有床，不能跳过夜晚', suggest: st.wool >= 3 ? 'craft white_bed' : sheep ? 'hunt {animal:"sheep", count:3} 拿羊毛，再 craft white_bed' : '找羊（3 羊毛 + 3 木板 = 床）' });
  }
  if (st.toolTier !== 'none' && (st.logs < 16 || st.cobblestone < 16 || st.food < 4)) {
    out.push({ drive: 'stockpile', level: 0.35, why: `库存：原木 ${st.logs}、圆石 ${st.cobblestone}、食物 ${st.food}`, suggest: '一次多采一些常用材料，省得以后反复跑' });
  }

  const novelty = Math.max(0, ...Object.values(p.exploration.noveltyByDir));
  out.push({ drive: 'explore', level: !night ? 0.25 + 0.3 * novelty : 0.05, why: `周围新颖度最高 ${novelty}`, suggest: '去没去过的方向，寻找新的生物群系、村庄、矿洞' });
  if (p.curiosities.length && !night) {
    const c = p.curiosities[0];
    out.push({ drive: 'curiosity', level: 0.45, why: `之前看见过 ${c.what}，在 ${c.dir} ${c.dist} 格外，还没去过`, suggest: `explore {direction:"${c.dir}"} 去看看` });
  }
  // ---- 仓储：背包快满了就回家整理
  if (p.emptySlots <= 5) out.push({ drive: 'storage', level: p.emptySlots <= 2 ? 0.8 : 0.6, why: `背包只剩 ${p.emptySlots} 个空位`, suggest: 'store_items（挑眼下用不上的点名存进箱子）' });
  else if (p.emptySlots <= 12 && homeBuilt) out.push({ drive: 'storage', level: 0.3, why: `背包空位 ${p.emptySlots}，东西有点杂`, suggest: 'store_items' });

  // ---- 冶炼：生矿、生肉、要做火把却没煤
  const raw = (n: string) => p.inventory.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  const rawOre = ['raw_iron', 'raw_gold', 'raw_copper'].map((n) => [n, raw(n)] as const).find(([, c]) => c >= 2);
  const rawMeat = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon'].map((n) => [n, raw(n)] as const).find(([, c]) => c >= 1);
  const canFurnace = st.cobblestone >= 8 || memory.landmarks().some((l) => l.label === 'furnace') || p.nearby.resources.some((r) => r.block === 'furnace');
  if (canFurnace && rawOre) out.push({ drive: 'smelt', level: 0.6, why: `背包有 ${rawOre[1]} 个 ${rawOre[0]}`, suggest: `smelt {item:"${rawOre[0]}"} → 铁锭可做铁镐/铁剑/桶` });
  if (canFurnace && rawMeat && p.self.food <= 16) out.push({ drive: 'smelt', level: 0.55, why: `有生的 ${rawMeat[0]}，熟肉更顶饱`, suggest: `smelt {item:"${rawMeat[0]}"}` });

  // ---- 农业：稳定的食物来源
  const seedsHave = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds'].find((n) => raw(n) >= 2);
  const farmsNear = p.farms ?? [];
  const ripe = farmsNear.find((f) => (f.mature ?? 0) >= 2);
  if (ripe) out.push({ drive: 'farm', level: 0.5, why: `农田（${ripe.crop}）有 ${ripe.mature} 格成熟了`, suggest: 'farm（收割并补种）' });
  else if (farmsNear.length && farmsNear[0].minutes_since_planted >= 25 && farmsNear[0].dist <= 200 && !night) out.push({ drive: 'farm', level: 0.3, why: `农田种下 ${farmsNear[0].minutes_since_planted} 分钟了，去看看`, suggest: 'farm' });
  else if (!farmsNear.length && st.toolTier !== 'none' && !night) {
    const grass = (p.vision?.view ?? '').includes('grass');
    if (seedsHave) out.push({ drive: 'farm', level: homeBuilt ? 0.45 : 0.3, why: `有 ${seedsHave}，还没有农田，食物全靠打猎不稳定`, suggest: `farm {crop:"${seedsHave === 'wheat_seeds' ? 'wheat' : seedsHave.replace('_seeds', '')}"}` });
    else if (grass && homeBuilt) out.push({ drive: 'farm', level: 0.3, why: '想种地但没有种子', suggest: 'collect_seeds（打草掉种子）' });
  }

  // ---- 远征：家里安顿好了，就去远方看看
  const cooked = p.inventory.filter((i) => /cooked_|bread|baked_potato/.test(i.name)).reduce((a, i) => a + i.count, 0);
  if (homeBuilt && (st.toolTier === 'stone' || st.toolTier === 'iron' || st.toolTier === 'diamond') && !night && !(p.curiosities ?? []).length) {
    const ready = cooked >= 3;
    out.push({ drive: 'expedition', level: ready ? 0.35 : 0.2, why: ready ? '家安顿好了，附近也看得差不多了' : `想去远方，但熟食只有 ${cooked} 个`, suggest: ready ? 'expedition {direction:"新颖度最高的方向", distance:240}，记得带火把' : '先准备 3 个以上熟食（smelt 生肉 / farm）' });
  }

  // ---- 新鲜感：最近没做过的玩法
  const recentSkills = new Set(memory.recentGoals(15).flatMap((g) => (g.steps ?? []).map((x) => x.split(':')[0])));
  const untried = [
    ['farm', homeBuilt], ['smelt', canFurnace && (!!rawOre || !!rawMeat)], ['build', st.blocks >= 20],
    ['expedition', homeBuilt && cooked >= 3], ['hunt', animals.length > 0], ['place_torch', (p.light?.torches ?? 0) > 0 && homeBuilt],
  ].filter(([k, ok]) => ok && !recentSkills.has(k as string)).map(([k]) => k as string);
  if (untried.length && recent.length >= 5) out.push({ drive: 'novelty', level: 0.3, why: `好久没 ${untried.join('、')} 了`, suggest: `换个玩法：${untried[0]}` });

  // ---- 自学技能 / 反思
  if ((p.learn_candidates ?? []).length) {
    const c = p.learn_candidates[0];
    out.push({ drive: 'automate', level: 0.35 + 0.1 * Math.min(3, c.times), why: `「${c.steps}」已经成功做了 ${c.times} 次`, suggest: '用 learn_skill 学成一个技能，下次一步完成' });
  }

  // ---- 习惯化：刚做过的同类事情，兴趣下降（满足感）
  const typeOf: Partial<Record<Drive['drive'], string[]>> = {
    tools: ['craft'], efficiency: ['craft'], stockpile: ['gather'], explore: ['explore'], curiosity: ['investigate', 'explore'],
    home: ['build'], farm: ['gather', 'craft'], smelt: ['craft'], expedition: ['explore'], novelty: [], storage: [],
  };
  const last8 = recent.slice(-8).map((g) => g.goalType);
  for (const d of out) {
    const types = typeOf[d.drive];
    if (!types?.length || ['survive', 'recover', 'eat', 'rest', 'light'].includes(d.drive)) continue;
    const n = last8.filter((t) => types.includes(t)).length;
    if (n >= 2) d.level *= Math.max(0.45, 1 - 0.12 * n);
  }

  // 无聊：同一类目标连做 3 次以上，压低它、抬高别的
  if (sameTypeStreak.n >= 3) {
    for (const d of out) {
      if ((sameTypeStreak.type === 'gather' && (d.drive === 'stockpile' || d.drive === 'tools')) || (sameTypeStreak.type === 'explore' && d.drive === 'explore')) d.level *= 0.5;
      if (['home', 'bed', 'curiosity', 'explore', 'automate', 'novelty', 'farm', 'expedition', 'smelt'].includes(d.drive) && sameTypeStreak.type !== 'explore') d.level = Math.min(1, d.level + 0.2);
    }
    out.push({ drive: 'automate', level: 0.4, why: `已经连续 ${sameTypeStreak.n} 次做「${sameTypeStreak.type}」类目标，有点无聊`, suggest: '换点别的：建房子、做床、去远处看看，或者把重复步骤学成新技能' });
  }
  return { drives: out.sort((a, b) => b.level - a.level).map((d) => ({ ...d, level: Math.round(d.level * 100) / 100 })), stock: st };
}

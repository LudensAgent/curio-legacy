import type { WorldMemory } from '../memory/store.ts';
import type { Percept } from '../perception/perception.ts';

/**
 * 游玩欲望（内在动机）：把“像真人一样想玩什么”量化成几个驱动力，交给 LLM 和规则目标使用。
 * 每个驱动力 0..1，附带原因和建议，按强度排序。它们不直接控制动作，只影响“想做什么”。
 */
export interface Drive {
  drive: 'survive' | 'recover' | 'eat' | 'rest' | 'tools' | 'efficiency' | 'home' | 'bed' | 'stockpile' | 'explore' | 'curiosity' | 'automate';
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

export function computeDrives(p: Percept, memory: WorldMemory): { drives: Drive[]; stock: Stock } {
  const st = stockOf(p);
  const out: Drive[] = [];
  const night = p.time.phase === 'night';
  const dusk = p.time.phase === 'dusk';
  const hostiles = p.nearby.hostile.length;
  const animals = (p.vision?.seen_entities ?? []).filter((e) => FOOD_ANIMALS.includes(e.name));
  const homeBuilt = memory.landmarks().some((l) => l.label.startsWith('我的hut') || l.label.startsWith('我的big_hut'));
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
      why: night ? '天黑了，怪物在外面游荡' : '天快黑了',
      suggest: st.hasBed || bedPlaced ? 'sleep（有床直接睡过夜）' : homeBuilt ? 'goto base 回小屋' : st.blocks >= 1 ? 'shelter；有材料的话白天先 build 一个 hut' : '尽快收集几个方块以便 shelter',
    });
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
    out.push({ drive: 'home', level: enough ? 0.65 : woodAround ? 0.6 : 0.45, why: '还没有自己的房子，晚上只能挖坑', suggest: st.blocks + st.logs * 3 >= need ? 'build {blueprint:"hut"}' : `先备 ${need} 个方块（约 ${Math.ceil((need - st.blocks) / 4)} 个原木做木板）再 build hut` });
  }
  if (!st.hasBed && !bedPlaced) {
    const sheep = animals.some((a) => a.name === 'sheep');
    out.push({ drive: 'bed', level: sheep ? 0.5 : 0.3, why: '没有床，不能跳过夜晚', suggest: st.wool >= 3 ? 'craft white_bed' : sheep ? 'hunt {animal:"sheep", count:3} 拿羊毛，再 craft white_bed' : '找羊（3 羊毛 + 3 木板 = 床）' });
  }
  if (st.toolTier !== 'none' && (st.logs < 16 || st.cobblestone < 16 || st.food < 4)) {
    out.push({ drive: 'stockpile', level: 0.35, why: `库存：原木 ${st.logs}、圆石 ${st.cobblestone}、食物 ${st.food}`, suggest: '一次多采一些常用材料，省得以后反复跑' });
  }
  if (recent.length >= 4) {
    out.push({ drive: 'automate', level: 0.3, why: '同样的事做了好几遍', suggest: '把常做的步骤组合成 learn_skill，下次一步完成；以后可以建农场/仓库' });
  }
  const novelty = Math.max(0, ...Object.values(p.exploration.noveltyByDir));
  out.push({ drive: 'explore', level: !night ? 0.25 + 0.3 * novelty : 0.05, why: `周围新颖度最高 ${novelty}`, suggest: '去没去过的方向，寻找新的生物群系、村庄、矿洞' });
  if (p.curiosities.length && !night) {
    const c = p.curiosities[0];
    out.push({ drive: 'curiosity', level: 0.45, why: `之前看见过 ${c.what}，在 ${c.dir} ${c.dist} 格外，还没去过`, suggest: `explore {direction:"${c.dir}"} 去看看` });
  }
  // 无聊：同一类目标连做 3 次以上，压低它、抬高别的
  if (sameTypeStreak.n >= 3) {
    for (const d of out) {
      if ((sameTypeStreak.type === 'gather' && (d.drive === 'stockpile' || d.drive === 'tools')) || (sameTypeStreak.type === 'explore' && d.drive === 'explore')) d.level *= 0.5;
      if (['home', 'bed', 'curiosity', 'explore', 'automate'].includes(d.drive) && sameTypeStreak.type !== 'explore') d.level = Math.min(1, d.level + 0.2);
    }
    out.push({ drive: 'automate', level: 0.4, why: `已经连续 ${sameTypeStreak.n} 次做「${sameTypeStreak.type}」类目标，有点无聊`, suggest: '换点别的：建房子、做床、去远处看看，或者把重复步骤学成新技能' });
  }
  return { drives: out.sort((a, b) => b.level - a.level).map((d) => ({ ...d, level: Math.round(d.level * 100) / 100 })), stock: st };
}

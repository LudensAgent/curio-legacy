import type { Step } from '../arbiter/arbiter.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Percept } from '../perception/perception.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { computeDrives, stockOf, type Drive } from '../brain/drives.ts';

const IDLE_ALIASES = new Set(['wait', 'idle', 'rest_a_bit', 'pause', 'stand_still']);

/**
 * 把模型写歪的步骤扶正（不放宽校验，只纠正常见的格式偏差）：
 * - 参数平铺在步骤上：{"skill":"gather","block":"stone"} → {"skill":"gather","args":{"block":"stone"}}
 * - 不存在的 wait/idle：有 wait 技能就用它，否则换成原地环顾
 */
export function normalizeStep(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { skill, args, ...rest } = raw as Record<string, unknown>;
  let name = typeof skill === 'string' ? skill.trim() : skill;
  let a: unknown = args;
  // 相对格子动作把坐标直接当 args 写：{"skill":"mine_cell","args":[0,2,0]}，place_cell 还可能把方块名接在后面 [0,3,0,"dirt"]
  if (Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every((n) => Number.isInteger(n)) && ['mine_cell', 'place_cell', 'place_support', 'move_step'].includes(String(name))) {
    a = { at: a.slice(0, 3), ...(typeof a[3] === 'string' ? { item: a[3] } : {}) };
  }
  const noArgs = a === undefined || a === null || typeof a !== 'object' || Array.isArray(a) || !Object.keys(a).length;
  if (noArgs && Object.keys(rest).length) a = rest;
  if (typeof name === 'string' && !SKILLS[name] && IDLE_ALIASES.has(name.toLowerCase())) {
    const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    const seconds = Number(o.seconds ?? o.duration ?? o.time);
    if (SKILLS.wait && !LLM_HIDDEN.has('wait')) {
      name = 'wait';
      a = { ...o, seconds: Number.isFinite(seconds) ? seconds : 5 };
    } else {
      name = 'look_around';
      a = Number.isFinite(seconds) ? { seconds: Math.max(2, Math.min(20, Math.round(seconds))) } : {};
    }
  }
  return { ...(name !== undefined ? { skill: name } : {}), ...(a !== undefined ? { args: a } : {}) };
}

/** 从 start 处的 { 开始，找到括号配平（忽略字符串内的括号）的第一个完整对象 */
function firstBalancedObject(t: string, start: number): string | null {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return t.slice(start, i + 1);
  }
  return null;
}

/** 从模型输出中提取 JSON（容忍 ```json 包裹或前后多余文字）。 */
/** 修模型输出里常见的 JSON 小毛病；没改动返回 null */
export function repairJson(s: string): string | null {
  const out = s
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/([{,]\s*)[「“”]([^「」“”"\n]{1,60})[」“”](\s*:)/g, '$1"$2"$3')
    .replace(/,(\s*[}\]])/g, '$1');
  return out === s ? null : out;
}

export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('输出中没有 JSON 对象');
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (error) {
      // 模型偶尔在完整对象后面多写一个右括号或第二段内容：取第一个括号配平的完整对象
      const first = firstBalancedObject(t, a);
      if (first) { try { return JSON.parse(first); } catch { /* 再试试修一修 */ } }
      // 常见的小毛病：键名用了「」或中文引号、混进零宽字符、多了尾逗号。只在解析失败后才修，修了还不行就照原样报错
      const fixed = repairJson(first ?? t.slice(a, b + 1));
      if (fixed) { try { return JSON.parse(fixed); } catch { /* 修不好 */ } }
      throw error;
    }
  }
}

const count = (p: Percept, pred: (n: string) => boolean) => p.inventory.filter((i) => pred(i.name)).reduce((a, i) => a + i.count, 0);

/**
 * 规则版目标生成：LLM 不可用、超预算或用 mock 时使用。
 * 简单的“生存 + 科技树 + 好奇心”优先级，保证 Agent 永远有事可做。
 */
const DROPS: Record<string, string> = { stone: 'cobblestone', coal: 'coal', iron: 'raw_iron', copper: 'raw_copper', gold: 'raw_gold', dirt: 'dirt' };

/**
 * 预规划时“假设当前任务会成功”：把当前任务的预期产出加进背包，再做决定。
 * 这样提前规划出的计划不会重复当前正在做的事。
 */
export function projectAfter(p: Percept, current: { skill: string; args: any } | null | undefined): Percept {
  if (!current) return p;
  const inv = p.inventory.map((i) => ({ ...i }));
  const add = (name: string, n: number) => {
    const it = inv.find((i) => i.name === name);
    if (it) it.count += n;
    else inv.push({ name, count: n });
  };
  const a = current.args ?? {};
  if (current.skill === 'gather') {
    const b = String(a.block ?? '');
    const name = b === 'log' || b === 'wood' || b === 'logs' ? p.nearby.resources.find((r) => r.block.endsWith('_log'))?.block ?? 'oak_log' : DROPS[b] ?? DROPS[b.replace(/^deepslate_/, '').replace(/_ore$/, '')] ?? b;
    add(name, Number(a.count ?? 1));
  } else if (current.skill === 'craft') add(String(a.item), Number(a.count ?? 1));
  return { ...p, inventory: inv };
}

export function ruleProposal(p0: Percept, memory?: WorldMemory, current?: { skill: string; args: any } | null): Record<string, unknown> {
  const prop = baseRule(projectAfter(p0, current), memory);
  // 失败冷却：3 分钟内同一个目标刚失败过，就先换个方向探索，避免原地反复失败
  if (memory && prop.goal_type !== 'survive') {
    const failed = memory.recentGoals(4).filter((g) => g.goal === prop.goal && (g.status === 'failed' || g.status === 'aborted') && Date.now() - g.ts < 180000);
    if (failed.length) {
      const [dir] = Object.entries(p0.exploration.noveltyByDir).sort((a, b) => b[1] - a[1])[0] ?? ['auto'];
      return {
        thought: `刚才「${prop.goal}」没成功（${failed[failed.length - 1].summary}），先换个方向探索，回头再试。`,
        goal: `换个地方：向 ${dir} 探索`,
        goal_type: 'explore',
        steps: [dir === 'auto' ? { skill: 'look_around', args: { seconds: 4 } } : { skill: 'resolve_target', args: { target: `${dir} 64` } }],
      };
    }
  }
  return prop;
}

function baseRule(p: Percept, memory?: WorldMemory): Record<string, unknown> {
  const has = (n: string) => count(p, (x) => x === n);
  const logs = count(p, (n) => n.endsWith('_log'));
  const planks = count(p, (n) => n.endsWith('_planks'));
  const sticks = has('stick');
  const cobble = has('cobblestone');
  const logName = p.inventory.find((i) => i.name.endsWith('_log'))?.name ?? 'oak_log';
  const plankName = logName.replace('_log', '_planks');
  const hasWoodPick = has('wooden_pickaxe') > 0;
  const hasStonePick = has('stone_pickaxe') > 0;
  const night = p.time.phase === 'night';
  const logNearby = p.nearby.resources.some((r) => r.block.endsWith('_log'));
  const st = p.stock ?? stockOf(p);
  const drives = p.drives?.length ? p.drives : memory ? computeDrives(p, memory).drives : [];
  const homeBuilt = memory?.landmarks().some((l) => l.label.startsWith('我的hut') || l.label.startsWith('我的big_hut')) ?? false;
  const bedPlaced = memory?.landmarks().some((l) => l.label === '我的床') ?? false;
  const animals = (p.vision?.seen_entities ?? []).filter((e) => ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(e.name));

  const mk = (thought: string, goal: string, goal_type: string, steps: Step[], extra: Record<string, unknown> = {}) => ({ thought, goal, goal_type, steps, ...extra });
  // 旧 explore/goto 已移除：规则兜底只解析目标或环顾，具体走法由 Agent 用 plan_route → walk_path 决定。
  const seek = (target: string): Step => ({ skill: 'resolve_target', args: { target } });
  const scout = (dir: string, distance: number): Step =>
    dir && dir !== 'auto' ? seek(`${dir} ${Math.max(1, Math.min(200, Math.round(distance)))}`) : { skill: 'look_around' };
  const bestDir = () => Object.entries(p.exploration.noveltyByDir).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N';

  const vis = p.vision;
  const sweptRecently = vis?.last_look_around_s != null && vis.last_look_around_s < 90;
  const waterView = /water (\d+)%/.exec(vis?.view ?? '');
  const mostlyWater = p.self.inWater || (waterView ? Number(waterView[1]) >= 50 : false);

  if (mostlyWater && vis?.nearest_land && vis.nearest_land.dist > 3) {
    return mk(`周围都是水，${vis.nearest_land.dir} 方向 ${vis.nearest_land.dist} 格外能看到陆地，先上岸。`, '游回陆地', 'survive', [
      scout(vis.nearest_land.dir, Math.min(160, Math.max(24, vis.nearest_land.dist + 6))),
    ]);
  }
  if (mostlyWater && !sweptRecently) return mk('四周都是水，先环顾一圈看看陆地在哪。', '环顾四周寻找陆地', 'investigate', [{ skill: 'look_around' }]);

  const toolsChain = (): Record<string, unknown> | null => {
    if (hasStonePick) return null;
    if (!hasWoodPick) {
      if (logs + planks / 4 < 3 && logNearby) {
        const t = p.nearby.resources.find((r) => r.block.endsWith('_log'))!;
        return mk(`${t.seen === 'now' ? '看到' : '记得'} ${t.dir ?? ''} 方向 ${t.nearest} 格外有树，先去砍几块原木。`, '收集原木', 'gather', [{ skill: 'gather', args: { block: 'log', count: 5 } }]);
      }
      if (logs + planks / 4 < 3 && !sweptRecently) return mk('眼前没看到树，先环顾一圈。', '环顾四周寻找树木', 'investigate', [{ skill: 'look_around' }]);
      if (logs + planks / 4 < 3) return mk('环顾过了，附近看不到树，去别处找找。', '寻找树木', 'explore', [scout(bestDir(), 48)]);
      return mk('有木头了，做一把木镐（木板、木棍、工作台会自动补做）。', '制作木镐', 'craft', [{ skill: 'craft', args: { item: 'wooden_pickaxe', count: 1 } }]);
    }
    if (cobble < 3) return mk('有木镐了，去挖点圆石做石镐。', '收集圆石', 'gather', [{ skill: 'gather', args: { block: 'stone', count: 6 } }]);
    void sticks;
    return mk('圆石够了，升级成石镐。', '制作石镐', 'craft', [{ skill: 'craft', args: { item: 'stone_pickaxe', count: 1 } }]);
  };

  const act = (d: Drive): Record<string, unknown> | null => {
    switch (d.drive) {
      case 'recover': {
        const dr = p.death_recovery!;
        return mk(`死亡时掉落的东西（${dr.lost}）记录在 ${dr.dir} ${dr.dist} 格外，当前状态未知。`, '回去捡回掉落物', 'survive', [
          seek('death'),
        ]);
      }
      case 'survive':
        if (night && st.blocks >= 1 && !p.self.inWater) return mk('天黑又受了伤，就地挖个坑躲到天亮。', '挖坑躲避', 'survive', [{ skill: 'shelter', args: { until: 'day' } }]);
        if (st.food > 0) return mk('血不多了，先吃东西回血。', '进食回血', 'survive', [{ skill: 'eat' }]);
        if (p.nearby.hostile.length) return mk('血少，先离怪远一点。', '撤离危险', 'survive', [{ skill: 'flee', args: { distance: 24 } }]);
        return null;
      case 'eat':
        if (st.food > 0 && p.self.food < 18) return mk('有点饿了，吃点东西（饱食度高才会回血）。', '进食', 'survive', [{ skill: 'eat' }]);
        if (animals.length && !night) return mk(`肚子饿，背包没吃的，那边有 ${animals[0].name}，去猎点肉。`, '打猎补充食物', 'gather', [{ skill: 'hunt', args: { animal: animals[0].name, count: 2 } }, { skill: 'eat' }]);
        if (!night && p.self.food <= 10) return mk('饿了又没看到动物，去开阔的地方找找。', '寻找动物', 'explore', [scout(bestDir(), 64)]);
        return null;
      case 'rest':
        if (st.hasBed || bedPlaced) return night ? mk('天黑了，睡一觉跳过夜晚。', '睡觉过夜', 'rest', [{ skill: 'sleep' }]) : null;
        if (homeBuilt && p.exploration.base && p.exploration.base.dist > 6) return mk('天要黑了，回小屋待着。', '回家过夜', 'rest', [seek('base')]);
        if (night && st.blocks >= 1 && !p.self.inWater) return mk('没有床也没房子，挖个坑躲一晚。', '挖坑过夜', 'rest', [{ skill: 'shelter', args: { until: 'day' } }]);
        return null;
      case 'light': {
        const L = p.light;
        const hasCoal = p.inventory.some((i) => i.name === 'coal' || i.name === 'charcoal');
        if (L && L.torches > 0 && (L.level === 'dark' || L.mob_spawn_risk)) return mk(`这里太暗了（亮度 ${L.here}），插支火把，免得看不清还刷怪。`, '插火把照明', 'survive', [{ skill: 'place_torch', args: { count: 1 } }]);
        if (hasCoal) return mk('有煤，做一组火把备用。', '制作火把', 'craft', [{ skill: 'craft', args: { item: 'torch', count: 8 } }, ...(L && L.level === 'dark' ? [{ skill: 'place_torch', args: { count: 1 } }] : [])]);
        const coal = p.nearby.resources.find((r) => r.block.includes('coal_ore'));
        if (coal && hasWoodPick) return mk(`没有火把，${coal.dir ?? ''} ${coal.nearest} 格外有煤矿，去挖点煤做火把。`, '挖煤做火把', 'gather', [{ skill: 'gather', args: { block: 'coal', count: 4 } }, { skill: 'craft', args: { item: 'torch', count: 8 } }]);
        return null;
      }
      case 'tools':
        return toolsChain();
      case 'advance': {
        const raw = count(p, (x) => x === 'raw_iron');
        if (raw >= 3) return mk('铁矿石够了，炼成铁锭再做铁镐。', '炼铁做铁镐', 'craft', [{ skill: 'smelt', args: { item: 'raw_iron', count: 3 } }, { skill: 'craft', args: { item: 'iron_pickaxe', count: 1 } }]);
        return mk('有石镐了，下矿挖铁升级铁器。', '挖铁', 'gather', [{ skill: 'gather', args: { block: 'iron', count: 6 } }]);
      }
      case 'efficiency': {
        const e = (p.efficiency ?? []).find((x) => x.better.some((b) => !b.have));
        const b = e?.better.find((x) => !x.have);
        if (!e || !b) return null;
        return mk(`用${e.tool}挖 ${e.block} 太慢了（${e.avg_s} 秒/个），做把 ${b.tool} 能快 ${b.speedup} 倍，磨刀不误砍柴工。`, `做 ${b.tool} 提高效率`, 'craft', [{ skill: 'craft', args: { item: b.tool, count: 1 } }]);
      }
      case 'home': {
        const need = 71;
        if (st.blocks >= need) return mk('材料够了，盖一间小屋当家，晚上就不用挖坑了。', '建造小屋', 'build', [{ skill: 'build', args: { blueprint: 'hut', prefab: true } }]);
        if (st.blocks + st.logs * 3 >= need) {
          const n = Math.min(64, need - (st.blocks - st.logs) + 4);
          return mk('原木够盖房子了，先做成木板再盖。', '建造小屋', 'build', [{ skill: 'craft', args: { item: plankName, count: n } }, { skill: 'build', args: { blueprint: 'hut', prefab: true } }]);
        }
        if (logNearby) return mk('想盖个小屋，得先多砍点木头。', '为小屋备料', 'gather', [{ skill: 'gather', args: { block: 'log', count: Math.min(24, Math.ceil((need - st.blocks) / 3) + 1) } }]);
        return null;
      }
      case 'bed':
        if (st.wool >= 3) return mk('羊毛够了，做张床，以后能睡觉跳过夜晚。', '做床', 'craft', [{ skill: 'craft', args: { item: 'white_bed', count: 1 } }]);
        if (animals.some((a) => a.name === 'sheep') && !night) return mk('看到羊了，弄 3 块羊毛做床。', '收集羊毛', 'gather', [{ skill: 'hunt', args: { animal: 'sheep', count: 3 } }]);
        return null;
      case 'curiosity': {
        const c = p.curiosities[0];
        return mk(`之前看见 ${c.dir} 方向有 ${c.what}，去看看是什么。`, `调查 ${c.what}`, 'investigate', [scout(c.dir, Math.min(160, Math.max(24, c.dist)))]);
      }
      case 'stockpile':
        if (st.logs < 16 && logNearby) return mk('多囤点木头，省得以后来回跑。', '囤积木材', 'gather', [{ skill: 'gather', args: { block: 'log', count: 12 } }]);
        if (st.cobblestone < 16 && hasWoodPick) return mk('多挖点圆石备用。', '囤积圆石', 'gather', [{ skill: 'gather', args: { block: 'stone', count: 12 } }]);
        return null;
      case 'storage':
        return null; // 存哪些要按它接下来的打算点名，规则兜底替它挑不了
      case 'smelt': {
        const m = /smelt \{item:"([a-z_]+)"\}/.exec(d.suggest ?? '');
        if (!m) return null;
        return mk(`${d.why}，烧一下。`, `冶炼 ${m[1]}`, 'craft', [{ skill: 'smelt', args: { item: m[1] } }]);
      }
      case 'farm': {
        if ((d.suggest ?? '').startsWith('collect_seeds')) return mk('想种地，先打草收集种子。', '收集种子', 'gather', [{ skill: 'collect_seeds', args: { count: 6 } }]);
        const m = /crop:"([a-z_]+)"/.exec(d.suggest ?? '');
        return mk(`${d.why}。`, m ? `开垦农田种 ${m[1]}` : '照看农田', 'build', [{ skill: 'farm', args: m ? { crop: m[1] } : {} }]);
      }
      case 'expedition': {
        if (night || !(d.suggest ?? '').startsWith('expedition')) return null;
        const dir = bestDir();
        return mk(`家里安顿好了，去 ${dir} 方向远行看看，沿途留路标。`, `远征 ${dir}`, 'explore', [{ skill: 'expedition', args: { direction: dir, distance: 240 } }]);
      }
      case 'novelty': {
        const k = /换个玩法：([a-z_]+)/.exec(d.suggest ?? '')?.[1];
        if (k === 'hunt' && animals.length && !night) return mk('好久没打猎了，去活动活动。', '打猎', 'gather', [{ skill: 'hunt', args: { animal: animals[0].name, count: 1 } }]);
        if (k === 'place_torch') return mk('给家附近插点火把，省得晚上刷怪。', '照亮家园', 'build', [{ skill: 'place_torch', args: { count: 2 } }]);
        return null; // 其他玩法由对应的欲望（farm/smelt/expedition）负责
      }
      case 'explore': {
        if (night) return null;
        const east = bestDir();
        return mk(`去 ${east} 方向看看没去过的地方。`, `向 ${east} 探索`, 'explore', [scout(east, 80)]);
      }
      default:
        return null;
    }
  };

  for (const d of drives) {
    const r = act(d);
    if (r) return r;
  }
  return toolsChain() ?? mk('四处走走看看。', '闲逛观察', 'explore', [scout(bestDir(), 48)]);
}

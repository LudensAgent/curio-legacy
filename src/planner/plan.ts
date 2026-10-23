import type { GameAdapter } from '../adapter/types.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Percept } from '../perception/perception.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { shortId } from '../util.ts';
import { computeDrives, stockOf, type Drive } from '../brain/drives.ts';
import type { Binding } from '../projects/types.ts';
import type { ValidatedIntentDecision } from '../intentions/decision.ts';

export const GOAL_TYPES = ['explore', 'gather', 'craft', 'survive', 'investigate', 'rest', 'build'] as const;

export interface Plan {
  id: string;
  source: 'llm' | 'rule' | 'user';
  thought: string;
  goal: string;
  goalType: string;
  steps: Step[];
  index: number;
  say?: string;
  abortIf: { hpBelow?: number; night?: boolean };
  memoryNote?: string;
  /** 长期目标（跨多个计划），LLM 可更新 */
  objective?: string;
  /** 反思得到的经验（长期保留） */
  lesson?: string;
  /** LLM 提议学习的新组合技能（原始 JSON，由技能库校验） */
  learnSkill?: unknown;
  createdAt: number;
  retries: number;
  /** 请求原因（prefetch 表示在上一个任务完成前预先规划） */
  reason?: string;
  requestedAt?: number;
  /** Assigned by Executive, never accepted from model JSON. */
  binding?: Binding;
  generation?: number;
  decision?: ValidatedIntentDecision;
  /** 被生存反射打断后自动恢复的次数，以及每个步骤被同一反射打断的次数 */
  resumes?: number;
  interruptions?: Record<string, number>;
  /** 模型给出的失败备选：某一步失败时，在重新决策的同时先做这些（1–2 步） */
  onFail?: Step[];
  /** 正在执行失败后的补救动作；新决策一到就被替换 */
  recovering?: { summary: string };
  /** 模型想做却没有对应能力的事（给观察者看：它还缺什么手脚） */
  missingAbility?: string;
  /** 短期工作记忆：做完这些之后打算做什么；接下来几分钟要记住的事 */
  then?: string;
  note?: string;
}

/** 从模型输出中提取 JSON（容忍 ```json 包裹或前后多余文字）。 */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('输出中没有 JSON 对象');
  }
}

/**
 * 计划校验第 1、2 关：结构 + 技能白名单 + 参数校验。
 * 第 3 关（安全规则）由反射层和 abort_if 在执行期保证。
 */
export function validatePlan(raw: unknown, adapter: GameAdapter, source: Plan['source']): { ok: true; plan: Plan } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '顶层必须是 JSON 对象' };
  const o = raw as Record<string, any>;
  const goal = String(o.goal ?? '').trim();
  if (!goal) return { ok: false, error: '缺少 goal' };
  const subjectiveEnd = ['defer', 'abandon', 'complete'].includes(o.decision?.kind);
  if (!Array.isArray(o.steps) || o.steps.length < (subjectiveEnd ? 0 : 1)) return { ok: false, error: 'steps 必须是 1-6 个元素的数组（暂缓/结束可为空）' };
  // 多写的步骤不作废整个计划：只执行前 6 步，后面的交给下一次决策
  if (o.steps.length > 6) o.steps = o.steps.slice(0, 6);
  const steps: Step[] = [];
  for (const [i, s] of o.steps.entries()) {
    const name = String(s?.skill ?? '');
    const skill = SKILLS[name];
    if (!skill || LLM_HIDDEN.has(name)) return { ok: false, error: `steps[${i}] 使用了不存在的技能 "${name}"，可用：${Object.keys(SKILLS).filter((k) => !LLM_HIDDEN.has(k)).join(', ')}` };
    const v = skill.validate(s?.args ?? {}, adapter);
    if (!v.ok) return { ok: false, error: `steps[${i}] ${name} 参数错误：${v.error}` };
    steps.push({ skill: name, args: v.args });
  }
  // on_fail 是可选的锦上添花：写错了就忽略，不影响主计划
  const onFail: Step[] = [];
  if (Array.isArray(o.on_fail)) for (const s of o.on_fail.slice(0, 2)) {
    const skill = SKILLS[String(s?.skill ?? '')];
    if (!skill || LLM_HIDDEN.has(skill.name)) continue;
    const v = skill.validate(s?.args ?? {}, adapter);
    if (v.ok) onFail.push({ skill: skill.name, args: v.args });
  }
  const ab = o.abort_if && typeof o.abort_if === 'object' ? o.abort_if : {};
  const hp = Number(ab.hp_below);
  return {
    ok: true,
    plan: {
      id: shortId('p_'),
      source,
      thought: String(o.thought ?? '').slice(0, 200),
      goal: goal.slice(0, 60),
      goalType: GOAL_TYPES.includes(o.goal_type) ? o.goal_type : 'explore',
      steps,
      index: 0,
      say: o.say ? String(o.say).slice(0, 120) : undefined,
      abortIf: { hpBelow: Number.isFinite(hp) ? Math.max(1, Math.min(19, hp)) : undefined, night: ab.night === true },
      memoryNote: o.memory_note ? String(o.memory_note).slice(0, 200) : undefined,
      objective: o.objective ? String(o.objective).slice(0, 120) : undefined,
      lesson: o.lesson ? String(o.lesson).slice(0, 160) : undefined,
      learnSkill: o.learn_skill && typeof o.learn_skill === 'object' ? o.learn_skill : undefined,
      createdAt: Date.now(),
      retries: 0,
      ...(onFail.length ? { onFail } : {}),
      ...(typeof o.missing_ability === 'string' && o.missing_ability.trim() ? { missingAbility: o.missing_ability.trim().slice(0, 200) } : {}),
      ...(typeof o.then === 'string' && o.then.trim() ? { then: o.then.trim().slice(0, 140) } : {}),
      ...(typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim().slice(0, 140) } : {}),
    },
  };
}

const FOODS = new Set(['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'apple', 'baked_potato', 'carrot', 'beef', 'porkchop', 'chicken', 'mutton', 'potato', 'sweet_berries', 'melon_slice', 'golden_apple', 'cookie', 'pumpkin_pie', 'beetroot', 'dried_kelp']);

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
        steps: [{ skill: 'explore', args: { direction: dir, distance: 64 } }],
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

  const vis = p.vision;
  const sweptRecently = vis?.last_look_around_s != null && vis.last_look_around_s < 90;
  const waterView = /water (\d+)%/.exec(vis?.view ?? '');
  const mostlyWater = p.self.inWater || (waterView ? Number(waterView[1]) >= 50 : false);

  if (mostlyWater && vis?.nearest_land && vis.nearest_land.dist > 3) {
    return mk(`周围都是水，${vis.nearest_land.dir} 方向 ${vis.nearest_land.dist} 格外能看到陆地，先上岸。`, '游回陆地', 'survive', [
      { skill: 'explore', args: { direction: vis.nearest_land.dir, distance: Math.min(160, Math.max(24, vis.nearest_land.dist + 6)) } },
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
      if (logs + planks / 4 < 3) return mk('环顾过了，附近看不到树，去别处找找。', '寻找树木', 'explore', [{ skill: 'explore', args: { direction: 'auto', distance: 48 } }]);
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
        return mk(`死的时候掉的东西（${dr.lost}）还在 ${dr.dir} ${dr.dist} 格外，趁 ${dr.seconds_left} 秒内回去捡。`, '回去捡回掉落物', 'survive', [
          { skill: 'goto', args: { target: 'death' } },
          { skill: 'pickup_items', args: { radius: 12 } },
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
        if (!night && p.self.food <= 10) return mk('饿了又没看到动物，去开阔的地方找找。', '寻找动物', 'explore', [{ skill: 'explore', args: { direction: 'auto', distance: 64 } }]);
        return null;
      case 'rest':
        if (st.hasBed || bedPlaced) return night ? mk('天黑了，睡一觉跳过夜晚。', '睡觉过夜', 'rest', [{ skill: 'sleep' }]) : null;
        if (homeBuilt && p.exploration.base && p.exploration.base.dist > 6) return mk('天要黑了，回小屋待着。', '回家过夜', 'rest', [{ skill: 'goto', args: { target: 'base' } }]);
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
      case 'efficiency': {
        const e = (p.efficiency ?? []).find((x) => x.better.some((b) => !b.have));
        const b = e?.better.find((x) => !x.have);
        if (!e || !b) return null;
        return mk(`用${e.tool}挖 ${e.block} 太慢了（${e.avg_s} 秒/个），做把 ${b.tool} 能快 ${b.speedup} 倍，磨刀不误砍柴工。`, `做 ${b.tool} 提高效率`, 'craft', [{ skill: 'craft', args: { item: b.tool, count: 1 } }]);
      }
      case 'home': {
        const need = 71;
        if (st.blocks >= need) return mk('材料够了，盖一间小屋当家，晚上就不用挖坑了。', '建造小屋', 'build', [{ skill: 'build', args: { blueprint: 'hut' } }]);
        if (st.blocks + st.logs * 3 >= need) {
          const n = Math.min(64, need - (st.blocks - st.logs) + 4);
          return mk('原木够盖房子了，先做成木板再盖。', '建造小屋', 'build', [{ skill: 'craft', args: { item: plankName, count: n } }, { skill: 'build', args: { blueprint: 'hut' } }]);
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
        return mk(`之前看见 ${c.dir} 方向有 ${c.what}，去看看是什么。`, `调查 ${c.what}`, 'investigate', [{ skill: 'explore', args: { direction: c.dir, distance: Math.min(160, Math.max(24, c.dist)) } }]);
      }
      case 'stockpile':
        if (st.logs < 16 && logNearby) return mk('多囤点木头，省得以后来回跑。', '囤积木材', 'gather', [{ skill: 'gather', args: { block: 'log', count: 12 } }]);
        if (st.cobblestone < 16 && hasWoodPick) return mk('多挖点圆石备用。', '囤积圆石', 'gather', [{ skill: 'gather', args: { block: 'stone', count: 12 } }]);
        return null;
      case 'storage':
        return mk(`背包只剩 ${p.emptySlots} 个空位，把不常用的东西存进箱子。`, '整理背包', 'build', [{ skill: 'store_items' }]);
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
        const [dir] = Object.entries(p.exploration.noveltyByDir).sort((a, b) => b[1] - a[1])[0] ?? ['auto'];
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
        const [bestDir] = Object.entries(p.exploration.noveltyByDir).sort((a, b) => b[1] - a[1])[0] ?? ['auto'];
        return mk(`去 ${bestDir} 方向看看没去过的地方。`, `向 ${bestDir} 探索`, 'explore', [{ skill: 'explore', args: { direction: bestDir, distance: 80 } }]);
      }
      default:
        return null;
    }
  };

  for (const d of drives) {
    const r = act(d);
    if (r) return r;
  }
  return toolsChain() ?? mk('四处走走看看。', '闲逛观察', 'explore', [{ skill: 'explore', args: { direction: 'auto', distance: 48 } }]);
}

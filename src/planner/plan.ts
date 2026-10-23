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
  lesson?: string;
  /** 长期目标（跨多个计划），LLM 可更新 */
  objective?: string;
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
  if (!Array.isArray(o.steps) || o.steps.length < (subjectiveEnd ? 0 : 1) || o.steps.length > 5) return { ok: false, error: 'steps 必须是 1-5 个元素的数组（暂缓/结束可为空）' };
  const steps: Step[] = [];
  for (const [i, s] of o.steps.entries()) {
    const name = String(s?.skill ?? '');
    const skill = SKILLS[name];
    if (!skill || LLM_HIDDEN.has(name)) return { ok: false, error: `steps[${i}] 使用了不存在的技能 "${name}"，可用：${Object.keys(SKILLS).filter((k) => !LLM_HIDDEN.has(k)).join(', ')}` };
    const v = skill.validate(s?.args ?? {}, adapter);
    if (!v.ok) return { ok: false, error: `steps[${i}] ${name} 参数错误：${v.error}` };
    steps.push({ skill: name, args: v.args });
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
      lesson: o.lesson ? String(o.lesson).slice(0, 160) : undefined,
      memoryNote: o.memory_note ? String(o.memory_note).slice(0, 200) : undefined,
      objective: o.objective ? String(o.objective).slice(0, 120) : undefined,
      learnSkill: o.learn_skill && typeof o.learn_skill === 'object' ? o.learn_skill : undefined,
      createdAt: Date.now(),
      retries: 0,
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

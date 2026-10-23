import type { GameAdapter } from '../adapter/types.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Percept } from '../perception/perception.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { shortId } from '../util.ts';

export const GOAL_TYPES = ['explore', 'gather', 'craft', 'survive', 'investigate', 'rest'] as const;

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
  createdAt: number;
  retries: number;
  /** 请求原因（prefetch 表示在上一个任务完成前预先规划） */
  reason?: string;
  requestedAt?: number;
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
  if (!Array.isArray(o.steps) || o.steps.length < 1 || o.steps.length > 5) return { ok: false, error: 'steps 必须是 1-5 个元素的数组' };
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
      memoryNote: o.memory_note ? String(o.memory_note).slice(0, 200) : undefined,
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
  const prop = baseRule(projectAfter(p0, current));
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

function baseRule(p: Percept): Record<string, unknown> {
  const has = (n: string) => count(p, (x) => x === n);
  const logs = count(p, (n) => n.endsWith('_log'));
  const planks = count(p, (n) => n.endsWith('_planks'));
  const sticks = has('stick');
  const cobble = has('cobblestone');
  const logName = p.inventory.find((i) => i.name.endsWith('_log'))?.name ?? 'oak_log';
  const plankName = logName.replace('_log', '_planks');
  const hasTableNearby = p.nearby.resources.some((r) => r.block === 'crafting_table' && r.nearest < 30) || has('crafting_table') > 0;
  const hasWoodPick = has('wooden_pickaxe') > 0;
  const hasStonePick = has('stone_pickaxe') > 0;
  const base = p.exploration.base;
  const night = p.time.phase === 'night';
  const logNearby = p.nearby.resources.some((r) => r.block.endsWith('_log'));
  const stoneNearby = true; // 看不见石头时 gather 会就地向下挖

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

  if (p.self.hp < 8 && p.self.food < 18 && count(p, (n) => FOODS.has(n)) > 0) return mk('生命值偏低，先吃点东西恢复。', '恢复状态', 'survive', [{ skill: 'eat' }]);
  if (night && base && base.dist > 24) return mk('天黑了，离基地有点远，先回去比较安全。', '夜间返回基地', 'survive', [{ skill: 'goto', args: { target: 'base' } }], { abort_if: { hp_below: 5 } });

  if (!hasStonePick) {
    if (!hasWoodPick) {
      if (logs + planks / 4 < 3 && logNearby) {
        const t = p.nearby.resources.find((r) => r.block.endsWith('_log'))!;
        return mk(`${t.seen === 'now' ? '看到' : '记得'} ${t.dir ?? ''} 方向 ${t.nearest} 格外有树，先去砍几块原木。`, '收集原木', 'gather', [{ skill: 'gather', args: { block: 'log', count: 5 } }]);
      }
      if (logs + planks / 4 < 3 && !sweptRecently) return mk('眼前没看到树，先环顾一圈。', '环顾四周寻找树木', 'investigate', [{ skill: 'look_around' }]);
      if (logs + planks / 4 < 3) return mk('环顾过了，附近看不到树，去别处找找。', '寻找树木', 'explore', [{ skill: 'explore', args: { direction: 'auto', distance: 48 } }]);
      const steps: Step[] = [];
      if (planks < 7) steps.push({ skill: 'craft', args: { item: plankName, count: Math.min(16, 8 - (planks % 4)) } });
      if (!hasTableNearby) steps.push({ skill: 'craft', args: { item: 'crafting_table', count: 1 } });
      if (sticks < 2) steps.push({ skill: 'craft', args: { item: 'stick', count: 4 } });
      steps.push({ skill: 'craft', args: { item: 'wooden_pickaxe', count: 1 } });
      return mk('有木头了，按科技树做一把木镐。', '制作木镐', 'craft', steps.slice(0, 5));
    }
    if (cobble < 3 && stoneNearby) return mk('有木镐了，去挖点圆石做石镐。', '收集圆石', 'gather', [{ skill: 'gather', args: { block: 'stone', count: 4 } }]);
    const steps: Step[] = [];
    if (sticks < 2) {
      if (planks < 2) steps.push({ skill: 'craft', args: { item: plankName, count: 4 } });
      steps.push({ skill: 'craft', args: { item: 'stick', count: 4 } });
    }
    steps.push({ skill: 'craft', args: { item: 'stone_pickaxe', count: 1 } });
    return mk('圆石够了，升级成石镐。', '制作石镐', 'craft', steps);
  }

  const coal = p.nearby.resources.find((r) => r.block.includes('coal_ore'));
  if (coal && has('coal') < 4 && !night) return mk('看到煤矿了，挖一些备用。', '采集煤炭', 'gather', [{ skill: 'gather', args: { block: 'coal', count: 4 } }]);
  const iron = p.nearby.resources.find((r) => r.block.includes('iron_ore'));
  if (iron && has('raw_iron') < 6 && !night) return mk('附近有铁矿，值得挖一点。', '采集铁矿', 'gather', [{ skill: 'gather', args: { block: 'iron', count: 3 } }]);

  const dirs = Object.entries(p.exploration.noveltyByDir).sort((a, b) => b[1] - a[1]);
  const [bestDir] = dirs[0] ?? ['auto'];
  return mk(`工具齐了，去 ${bestDir} 方向看看没去过的地方。`, `向 ${bestDir} 探索`, 'explore', [
    { skill: 'explore', args: { direction: bestDir, distance: 64 } },
    { skill: 'explore', args: { direction: 'auto', distance: 32 } },
  ]);
}

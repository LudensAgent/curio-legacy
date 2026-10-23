import type { TaskInfo } from '../arbiter/arbiter.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Percept } from '../perception/perception.ts';
import { skillCatalog } from '../skills/index.ts';
import type { ChatMessage } from './llm.ts';

export interface PlanContext {
  reason: string;
  percept: Percept;
  current: TaskInfo | null;
  lastFailure: { skill: string; code?: string; summary: string } | null;
  userSuggestion: string | null;
}

export function systemPrompt(persona: string): string {
  return `${persona}

你是这个 Minecraft Agent 的“高层思考”模块。你不直接操作键盘鼠标，也看不到画面；你只根据结构化的游戏状态 JSON 决定“接下来想做什么”，并把它拆成 1-5 个技能步骤，由程序连续执行。

## 可用技能（只能用这些，参数必须符合格式）
${skillCatalog()}

## 原则
- 安全优先：生命低、夜晚且离基地远、背包满、附近敌对生物多时，先处理生存问题。被攻击时的紧急躲避/反击由程序自动处理，不需要你规划。
- 好奇心：noveltyByDir 越接近 1 代表那个方向越没去过；优先调查“首次发现”的东西和新方向。
- 不要重复失败：参考 last_failure 和 recent_goals，换一种做法或换个目标。
- 工具路线参考：原木 → 木板 → 工作台 → 木棍 → 木镐 → 圆石 → 石镐 → 熔炉/火把 → 铁。
- 计划要短：一般 1-3 分钟内能完成；完成后你会被再次询问。
- 如果 reason 是 "prefetch"：current_task 即将完成，请假设它会成功，规划它**之后**的下一步，不要重复正在做的事。
- 用户建议（user_suggestion）可以采纳也可以说明理由后拒绝，但安全规则优先。

## 输出
只输出一个 JSON 对象，不要输出任何其他文字：
{"thought":"一句话说明你为什么这样做（会显示给观众）","goal":"目标，30 字以内","goal_type":"explore|gather|craft|survive|investigate|rest","steps":[{"skill":"技能名","args":{}}],"say":"可选：在游戏聊天里说的一句短话","abort_if":{"hp_below":6,"night":false},"memory_note":"可选：值得记住的推断"}`;
}

export function userPrompt(ctx: PlanContext, memory: WorldMemory): string {
  const p = ctx.percept;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  const landmarks = memory
    .landmarks()
    .filter((l) => l.dim === p.self.dim)
    .map((l) => ({ id: l.id, kind: l.kind, label: l.label, dist: Math.round(Math.hypot(l.pos.x - here.x, l.pos.z - here.z)) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 10);
  const stats = Object.entries(memory.skillStats())
    .filter(([, s]) => s.fail > 0)
    .map(([k, s]) => `${k}: 成功 ${s.ok}/${s.runs}，失败原因 ${JSON.stringify(s.failCodes)}`);

  const payload = {
    reason: ctx.reason,
    state: p,
    current_task: ctx.current ? { skill: ctx.current.skill, args: ctx.current.args, progress: Math.round(ctx.current.progress * 100) + '%' } : null,
    last_failure: ctx.lastFailure,
    recent_goals: memory.recentGoals(6).map((g) => ({ goal: g.goal, status: g.status, summary: g.summary })),
    landmarks,
    notes: memory.recentNotes(6).map((n) => `[${n.kind}] ${n.text}`),
    skill_failures: stats,
    discovered: memory.seenCount(),
    user_suggestion: ctx.userSuggestion,
  };
  return `当前情况（JSON）：\n${JSON.stringify(payload)}\n\n请给出下一个计划。`;
}

export function buildMessages(persona: string, ctx: PlanContext, memory: WorldMemory): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt(persona) },
    { role: 'user', content: userPrompt(ctx, memory) },
  ];
}

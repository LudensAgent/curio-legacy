import type { AgentState } from '../adapter/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { TaskInfo } from '../arbiter/arbiter.ts';
import type { MemoryContext } from '../memory/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Percept } from '../perception/perception.ts';
import type { Binding } from '../projects/types.ts';
import { LLM_HIDDEN, SKILLS, skillCatalog } from '../skills/index.ts';
import type { ChatMessage } from './llm.ts';
import { travelStore } from '../travel/store.ts';
import { buildingArchiveFor } from '../skills/build.ts';

export interface PlanContext {
  reason: string;
  percept: Percept;
  current: TaskInfo | null;
  lastFailure: { skill: string; code?: string; summary: string } | null;
  userSuggestion: string | null;
  binding?: Binding;
  continuity?: unknown;
  worldState?: AgentState;
  memoryContext?: MemoryContext;
  memoryAvailable?: boolean;
  results?: unknown[];
}

export function systemPrompt(persona: string, fov = 100, catalog = skillCatalog()): string {
  return `${persona}

你是 Minecraft 自主玩家的高层决策模块。根据观察、个人偏好、近期经历与未完成的兴趣，自由选择现在想做的事情。可以建设、研究、整理、探索、休息、继续旧事，也可以基于新情况改变主意。没有必须遵循的科技树、囤货配额或通关主线；长期种田、装修或不去下界都可以。state.drives 只是可权衡的信号，分数最高项不决定你的目标。安全反射由程序执行。

每次决策是独立请求，当前观察、意图和证据由程序重新组装，不依赖完整聊天历史。需要旧经历时再请求 recall；memory_source=available_on_request 表示记忆服务可按需查询，并非没有记忆。
reason=prefetch 时，current_task 仍在执行，下一计划只在本轮步骤结束后接续；不要重复当前步骤，也不能把预计产出当成已验证事实。思考空档中程序仅原地观察，不会另选目标或消耗材料；请根据已知事实安排后续动作。

兴趣需有连续性。每次给出 decision：begin（新事）、continue（继续）、change_method（改法）、revise（改目标）、defer（暂缓）、abandon（放弃）、complete（主观结束）。reason 说明眼前事实或经历为何支持这个选择，context 引用采用的发现/记忆。改意时说明之前的投入与新取舍。用户建议可以采纳，也可以有理由地拒绝。偏好 source 只能是 inferred；用户明确偏好由程序另行记录，模型不得冒充用户。
新事在 intent 写 text、whyNow；持续多轮且可验证的事情可附 project。简单观察或闲逛无需工程。
project={title,successCondition,milestones:[{title,condition}]}，同一时间仅一个主动项目，里程碑顺序执行。
事实条件仅支持 {type:"inventory_min",item:"具体物品注册名",count:16}、{type:"location_near",dimension:"overworld",pos:{x:0,y:64,z:0},radius:3,landmarkId:"已知地标ID"}、{type:"all_of",conditions:[条件...]}。位置必须来自当下观测或已知地标，不能猜测。库存条件读取实际完整背包，技能成功或预计产出不证明事实完成。缺少可证明的条件时保留开放意图，不编造验收。complete 只表示体验结束，不能宣布未验证的材料、房屋或战斗事实。

只组合当前可用技能；缺少能力时记录缺口、尝试相关的现有方法或暂缓。不要把缺材料自动改写为无关囤货。learn_skill 仅为待试验组合，注册名称不等于已学会。lesson 是有来源的推断，memory_note 不得伪造事实。
learn_skill 的完整格式为 {name,description,parameters:{amount:{type:"integer",default:4,min:1,max:16}},program:{type:"sequence",steps:[{type:"call",skill:"gather",args:{block:"stone",count:{param:"amount"}}}]},postcondition:{type:"inventory_min",item:"cobblestone",count:{param:"amount"}}}。program 还可用 {type:"if",condition,then,else} 或 {type:"repeat",times,body}，循环有界。候选 trial 只在配置的隔离试验世界执行，两个不同情境事实验收后才晋升 method；程序不替你选择要学什么。

视觉仅约 ${fov}° 面前视锥，遮挡和光照有效。visible_resources 是亲眼所见，remembered_resources 是可能过期的旧观察；未去过的位置未知。gather 只能采已知资源。look_around 只在需要观察且上次环顾较久时使用，无需每计划都扫视。不要用管理指令或种子定位资源。sleep 只在主世界安全。不同维度的位置不能直接 goto。
若附带建筑图片，它们是作品实地固定机位的射线语义色可视化，只有观测到的轮廓/遮挡/大类色彩，不能由此声称看到了原版材质细节。请结合自己的偏好、版本差异、功能缺陷和使用反馈成对比较；外观判断属于主观评价，不替代结构验收，不用自评分上涨证明进化。

可用技能（参数必须合法；组合技能也通过同一取消与动作守卫）：
${catalog}

如果还需要记忆，先输出 {"kind":"recall","query":"要追查的问题","ids":["可选记忆ID"],"filters":{"kinds":["experience"]}}。这是只读查询，不占用游戏动作；最多两轮，返回未知时承认未知。检索排名与读过次数不提高真实性。历史事件不代表库存/设施的当前状态。

否则只输出一个 JSON 对象：
thought 会显示在游戏聊天中，请写成简短的第一人称角色独白（建议 1–2 句、60 字以内），表达眼前的感受、好奇、疑惑或偏好；不要写行动计划、步骤清单、技能参数或详细推演。执行安排只放在 goal 和 steps 中。
{"kind":"plan","thought":"我有点好奇，这棵树另一侧的轮廓是什么样。","decision":{"kind":"continue","reason":"上次只看了一面，还想比较另一侧","context":["上一轮观察"]},"goal":"观察树冠另一侧","goal_type":"investigate","steps":[{"skill":"look_around","args":{"seconds":4}}],"abort_if":{"hp_below":6}}
若没有当前意图，新意图必须嵌套在 decision.intent 中（不是顶层 intent），例如：
{"kind":"plan","thought":"我还是头一次见到这种树冠，真特别。","decision":{"kind":"begin","reason":"发现了没见过的树冠","intent":{"text":"观察这种树木的形状","whyNow":"眼前发现了新树种","context":["当前视觉"],"tradeoffs":["暂缓其他想法"]}},"goal":"观察周围树木","goal_type":"investigate","steps":[{"skill":"look_around","args":{"seconds":4}}]}
decision.intent.context 与 tradeoffs 都是字符串数组。只有 begin/revise 可写 decision.intent，只有新项目或 revise 可写 decision.project（不得在 continue 时重新定义已有工程）。preferences、memory_note、lesson、learn_skill 都是可选字段；learn_skill 采用上文的程序格式。聊天只展示 thought，不另用 say 播报。
steps 保持 1–5 步；defer/abandon/complete 可以 steps:[]，表示选择等待而非填充无关动作。不要每轮换目标，也不必每轮说话。可用 begin + 已有 intentId 恢复 continuity 中列出的暂缓兴趣及其原项目；新记录的 ID、项目修订、里程碑和请求代次由程序分配，不能伪造或覆盖。`;
}

export function boundedJson(value: unknown, maxBytes: number): string {
  if (maxBytes <= 0) return '[]';
  if (!Array.isArray(value)) {
    const json = JSON.stringify(value);
    return json && Buffer.byteLength(json, 'utf8') <= maxBytes ? json : '[]';
  }
  // Encode each record once; repeated whole-history serialization stalls physics ticks.
  const rows: string[] = [];
  let bytes = 2;
  for (const entry of value) {
    const json = JSON.stringify(entry) ?? 'null';
    const next = Buffer.byteLength(json, 'utf8') + (rows.length ? 1 : 0);
    if (bytes + next > maxBytes) break;
    rows.push(json); bytes += next;
  }
  return `[${rows.join(',')}]`;
}

export function userPrompt(ctx: PlanContext, memory: WorldMemory, recalled?: unknown[], memoryBytes = 8000, compact = 0): string {
  const p = ctx.percept;
  const state = ctx.worldState;
  const recall = recalled ?? ctx.memoryContext?.memories ?? [];
  const payload = {
    reason: ctx.reason, state: p, current_task: ctx.current ? { skill: ctx.current.skill, args: ctx.current.args, progress: ctx.current.progress } : null,
    last_failure: ctx.lastFailure, user_suggestion: ctx.userSuggestion,
    continuity: ctx.continuity ?? { intent: memory.currentIntent(), project: memory.activeProject() },
    preferences: memory.preferences().sort((a, b) => Number(b.source === 'user') - Number(a.source === 'user') || b.updatedAt - a.updatedAt).slice(0, 8),
    recalled_memories: JSON.parse(boundedJson(recall, memoryBytes)),
    memory_source: ctx.memoryContext?.source ?? (ctx.memoryAvailable ? 'available_on_request' : 'unavailable'),
    known_portals: state ? travelStore(memory).snapshot(state.worldId).endpoints.slice(-10) : [],
    recent_attempts: memory.recentGoals(4).map((g) => ({ goal: g.goal, status: g.status, summary: g.summary })),
    tool_results: JSON.parse(boundedJson(ctx.results ?? [], Math.min(memoryBytes, 6000))),
    known_locations: memory.landmarks().filter((l) => l.dim === p.self.dim && (!state || l.worldId === state.worldId))
      .sort((a, b) => Math.hypot(a.pos.x - p.self.pos[0], a.pos.z - p.self.pos[2]) - Math.hypot(b.pos.x - p.self.pos[0], b.pos.z - p.self.pos[2]))
      .slice(0, 10).map((l) => ({ id: l.id, label: l.label, dimension: l.dim, pos: l.pos, observedAt: l.ts })),
  };
  return contextMessage(compact ? compactContext(payload, compact) : payload);
}

const contextPrefix = '当前观察和选择记录（JSON）：\n';
const contextSuffix = '\n请选择继续、改法或改意，并给出可执行的短计划。';
const contextMessage = (payload: unknown) => `${contextPrefix}${JSON.stringify(payload)}${contextSuffix}`;

/** Keep structured identity and present failure while shedding historical detail. */
function compactContext(value: unknown, level: number, key = '', depth = 0): any {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // IDs, state enums and registered names must remain exact for the decision protocol.
    const exact = /^(?:id|.*Id|kind|type|status|source|worldId|sessionId|dimension|dim|item|skill|name|code|reason)$/.test(key);
    const limit = exact ? 2000 : level === 1 ? 240 : 120;
    return value.length <= limit ? value : `${value.slice(0, limit)}…[上下文已截短]`;
  }
  if (Array.isArray(value)) {
    const limit = /^(?:conditions|pauseReasons)$/.test(key) ? 16
      : /^(?:inventory|visible_resources|remembered_resources|resources)$/.test(key) ? (level === 1 ? 12 : 6)
      : key === 'evidence' ? 1 : level === 1 ? 3 : 1;
    const selected = key === 'evidence' ? value.slice(-limit) : value.slice(0, limit);
    return selected.map((entry) => compactContext(entry, level, '', depth + 1));
  }
  if (typeof value !== 'object' || depth > 16) return '[上下文已省略]';
  const result: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(value)) {
    // wishes duplicates openInterests; repeated historical details are lower priority.
    if (field === 'wishes' || level > 1 && ['recent_attempts', 'tool_results', 'recalled_memories', 'farms', 'efficiency', 'learn_candidates'].includes(field)) continue;
    if (field === 'milestones' && Array.isArray(entry)) {
      const current = Number((value as Record<string, unknown>).currentMilestone ?? 0);
      const offset = Number((value as Record<string, unknown>).milestone_offset ?? 0);
      result.milestones = entry.slice(Math.max(0, current - offset), current - offset + 1).map((m) => compactContext(m, level, '', depth + 1));
      result.milestone_offset = current;
    } else result[field] = compactContext(entry, level, field, depth + 1);
  }
  if (!depth) result.context_truncated = true;
  return result;
}

function briefCatalog(descriptionChars = 60): string {
  return Object.values(SKILLS).filter((s) => !LLM_HIDDEN.has(s.name))
    .map((s) => `- ${s.name} ${s.argsDoc}${descriptionChars ? `：${s.description.slice(0, descriptionChars)}` : ''}`).join('\n');
}

export const promptCost = (messages: ChatMessage[]) => Buffer.byteLength(JSON.stringify(messages), 'utf8') + messages.length * 64
  + messages.reduce((sum, m) => sum + (m.images?.length ?? 0) * 1024, 0);

/** Conservative byte bound across model tokenizers, including Chinese and tool/retry turns. */
export function enforcePromptBudget(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (!Number.isFinite(maxTokens) || maxTokens < 1024) throw new Error('PROMPT_BUDGET_INVALID');
  // Preserve the newest query/result or validation feedback as a complete exchange.
  while (messages.length > 4 && promptCost(messages) > maxTokens) {
    const count = messages[2].role === 'assistant' && messages[3]?.role === 'user' ? 2 : 1;
    messages.splice(2, count);
  }
  if (promptCost(messages) > maxTokens) for (const message of messages) delete message.images;
  const base = messages[1];
  if (base?.content.startsWith(contextPrefix) && base.content.endsWith(contextSuffix)) {
    const payload = JSON.parse(base.content.slice(contextPrefix.length, -contextSuffix.length));
    for (const level of [1, 2]) {
      if (promptCost(messages) <= maxTokens) break;
      base.content = contextMessage(compactContext(payload, level));
    }
  }
  if (promptCost(messages) > maxTokens && messages[0]?.role === 'system') {
    const system = messages[0].content;
    const catalogStart = system.indexOf('\n', system.indexOf('\n可用技能（'));
    const catalogEnd = system.indexOf('\n\n如果还需要记忆', catalogStart);
    if (catalogStart >= 0 && catalogEnd > catalogStart) {
      messages[0].content = `${system.slice(0, catalogStart + 1)}${briefCatalog(0)}${system.slice(catalogEnd)}`;
    }
  }
  if (promptCost(messages) > maxTokens) throw new Error(`PROMPT_BUDGET_EXCEEDED: ${promptCost(messages)}/${maxTokens}`);
  return messages;
}

export function buildMessages(persona: string, ctx: PlanContext, memory: WorldMemory, fov = 100, maxTokens = 128000, visionInput = false,
  limits: { contextWindowTokens?: number; compactAtRatio?: number; maxOutputTokens?: number } = {}): ChatMessage[] {
  const system = systemPrompt(persona, fov);
  if (!Number.isFinite(maxTokens) || maxTokens < 1024) throw new Error('PROMPT_BUDGET_INVALID');
  const window = Number.isFinite(limits.contextWindowTokens) ? limits.contextWindowTokens! : 1000000;
  const output = Number.isFinite(limits.maxOutputTokens) ? Math.max(0, limits.maxOutputTokens!) : 16384;
  maxTokens = Math.min(maxTokens, window - output);
  const ratio = Number.isFinite(limits.compactAtRatio) ? Math.max(0.25, Math.min(0.95, limits.compactAtRatio!)) : 0.75;
  // Recall results and invalid-output feedback must fit without deleting the reason to replan.
  const initialBudget = Math.min(Math.floor(maxTokens * ratio), maxTokens - Math.min(5000, Math.floor(maxTokens / 4)));
  const images: NonNullable<ChatMessage['images']> = [];
  if (visionInput && memory.dataDirectory && ctx.worldState) {
    const root = path.resolve(memory.dataDirectory, 'building-views');
    const works = buildingArchiveFor(memory).list().filter((p) => p.worldId === ctx.worldState!.worldId && p.dimension === ctx.worldState!.dim);
    for (const view of works.flatMap((p) => p.views).slice(-2)) {
      const file = view.observation?.pixelImage;
      if (typeof file !== 'string') continue;
      const resolved = path.resolve(file), relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(resolved) || fs.statSync(resolved).size > 500_000) continue;
      const bytes = fs.readFileSync(resolved);
      if (bytes.subarray(1, 4).toString() === 'PNG') images.push({ url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'low' });
    }
  }
  for (const memoryBytes of [8000, 4000, 1800, 0]) {
    const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: userPrompt(ctx, memory, undefined, memoryBytes), ...(images.length ? { images } : {}) }];
    if (promptCost(messages) <= initialBudget) return messages;
  }
  const p = ctx.percept;
  const compact: PlanContext = { ...ctx, percept: { ...p, inventory: p.inventory.slice(0, 16),
    curiosities: p.curiosities.slice(0, 4), drives: p.drives.slice(0, 8),
    nearby: { ...p.nearby, resources: p.nearby.resources.slice(0, 10) }, vision: p.vision ? { ...p.vision,
      visible_resources: p.vision.visible_resources.slice(0, 10), remembered_resources: p.vision.remembered_resources.slice(0, 10),
      seen_entities: p.vision.seen_entities.slice(0, 8), heard: p.vision.heard.slice(0, 8) } : null } };
  for (const catalog of [skillCatalog(), briefCatalog(), briefCatalog(0)]) for (const level of [1, 2]) {
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(persona, fov, catalog) }, { role: 'user', content: userPrompt(compact, memory, [], 0, level) }];
    if (promptCost(messages) <= initialBudget) return messages;
  }
  return enforcePromptBudget([{ role: 'system', content: systemPrompt(persona, fov, briefCatalog()) },
    { role: 'user', content: userPrompt(compact, memory, [], 0, 2) }], maxTokens);
}

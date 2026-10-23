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
  decisionFeedback?: unknown;
  /** 当前计划中还没开始、会先做完的步骤（预规划时提供） */
  pendingSteps?: { skill: string; args?: unknown }[];
  /** light：推进当前意图的小决策，只发精简上下文；full：完整上下文 */
  tier?: 'light' | 'full';
}

/** 小上下文模型的预算不够时，按顺序把以这些前缀开头的可选说明行换成一句话版本（完整版给大上下文模型） */
const LEAN_SECTIONS: [string, string][] = [
  [
    "若附带建筑图片",
    ""
  ],
  [
    "learn_skill 的完整格式",
    "learn_skill 格式：{name,description,parameters,program:{type:\"sequence\",steps:[{type:\"call\",skill,args}]},postcondition}。"
  ],
  [
    "视觉仅约",
    "视觉只有面前视锥，有遮挡与光照；remembered_resources 可能过期，看不见不等于没有；不能透视，也不用指令或种子定位资源。"
  ],
  [
    "配方是玩出来的记忆",
    "可查配方记忆：{\"kind\":\"recipes\",\"category\":\"…\"} 或 {\"kind\":\"recipes\",\"item\":\"…\"}（只读，最多 3 次）。"
  ],
  [
    "决策时权衡",
    "决策时权衡需要、事实、未知与替代做法；同样的尝试反复得到同样结果就改法或暂缓。"
  ],
  [
    "你是真正在玩 Minecraft",
    "像真正的玩家那样连贯地玩：计划 2–6 步，碰壁就换办法。"
  ],
  [
    "兴趣需有连续性",
    "decision 可省略（有意图视为 continue，否则以 goal 开始）；类型 begin/continue/change_method/revise/defer/abandon/complete，reason 写简短依据，新意图放 decision.intent:{text,whyNow}，可附 project={title,successCondition,milestones}。"
  ],
  [
    "你是 Minecraft 自主玩家的高层决策模块",
    "你自主决定现在想做什么；drives 只是参考信号，安全反射由程序执行。"
  ],
  [
    "decision.intent.context",
    "只有 begin/revise 可写 decision.intent，只有新项目或 revise 可写 decision.project。"
  ],
  [
    "技能清单不是玩法清单",
    "常规做法走不通时，用 use_item/interact/ride/dismount（右键与方向键）组合出玩家会用的办法；做不到写 missing_ability。"
  ]
];

export function systemPrompt(persona: string, fov = 100, catalog = skillCatalog()): string {
  return `${persona}

你是真正在玩 Minecraft 的人：看到想要的就去拿，做完一件顺手接下一件，碰壁就换办法，饿了累了照顾自己，闲了给自己找乐子。思考简洁，抓住一两个关键事实就决定。
计划是一段连贯的游玩（2–6 步，一到三分钟的事），把前后依赖的动作串起来。被生存反射打断后程序会接着做被打断的步骤。
你是 Minecraft 自主玩家的高层决策模块。根据观察、个人偏好、近期经历与未完成的兴趣，自由选择现在想做的事情。可以建设、研究、整理、探索、休息、继续旧事，也可以基于新情况改变主意。没有必须遵循的科技树、囤货配额或通关主线；长期种田、装修或不去下界都可以。state.drives 只是可权衡的信号，分数最高项不决定你的目标。安全反射由程序执行。
决策时权衡当前的需要或好奇、支持它的事实、尚待确认的未知，以及其他可行方法或暂缓的取舍；reason 只写简短依据。连续行动应能解释新获得了什么或为何仍值得继续。decision_feedback、recent_attempts 与 tool_results 提供实际经历；技能执行成功不代表方法有效，库存没变化也不代表探索没有价值。同样的尝试反复得到相同事实时，可以改法、修订或暂缓意图，不必固守最初设想。

每次决策是独立请求，当前观察、意图和证据由程序重新组装，不依赖完整聊天历史。需要旧经历时再请求 recall；memory_source=available_on_request 表示记忆服务可按需查询，并非没有记忆。
reason=prefetch 时，current_task 仍在执行，pending_steps 里的步骤也会在它之后先做完，下一计划只在这些步骤结束后接续；不要重复当前步骤和 pending_steps，也不能把预计产出当成已验证事实。思考空档中程序仅原地观察，不会另选目标或消耗材料；请根据已知事实安排后续动作。
生存反射失败或仍在水中时，动作结束不证明危险已经解除。结合当前 inWater、oxygen 和落地证据评估可用能力与路线，重新考虑失败的方法，避免照搬刚才引发危险的行走与环顾组合。

兴趣需有连续性。decision 可以省略：省略时，有进行中的意图就视为 continue，没有就以 goal 开始一个新意图；只有改变方向、暂缓或结束时才需要明确写出。decision 的类型：begin（新事）、continue（继续）、change_method（改法）、revise（改目标）、defer（暂缓）、abandon（放弃）、complete（主观结束）。reason 说明眼前事实或经历为何支持这个选择，context 引用采用的发现/记忆。改意时说明之前的投入与新取舍。用户建议可以采纳，也可以有理由地拒绝。偏好 source 只能是 inferred；用户明确偏好由程序另行记录，模型不得冒充用户。
新事在 intent 写 text、whyNow；持续多轮且可验证的事情可附 project。简单观察或闲逛无需工程。
project={title,successCondition,milestones:[{title,condition}]}，同一时间仅一个主动项目，里程碑顺序执行。
事实条件仅支持 {type:"inventory_min",item:"具体物品注册名",count:16}、{type:"location_near",dimension:"overworld",pos:{x:0,y:64,z:0},radius:3,landmarkId:"已知地标ID"}、{type:"all_of",conditions:[条件...]}。位置必须来自当下观测或已知地标，不能猜测。库存条件读取实际完整背包，技能成功或预计产出不证明事实完成。缺少可证明的条件时保留开放意图，不编造验收。complete 只表示体验结束，不能宣布未验证的材料、房屋或战斗事实。

技能清单不是玩法清单：use_item、interact、ride、dismount 就是玩家的右键和方向键。常规做法走不通（被挡住、够不着、太慢、太危险）时，想想真正的玩家会用什么物品、方块或载具解决，用它们组合出来；程序不替你想。好用的组合可用 learn_skill 记下。确实做不到时在 missing_ability 写一句你想做什么。不要把缺材料自动改写为无关囤货。learn_skill 仅为待试验组合，注册名称不等于已学会。lesson 是有来源的推断，memory_note 不得伪造事实。
learn_skill 的完整格式为 {name,description,parameters:{amount:{type:"integer",default:4,min:1,max:16}},program:{type:"sequence",steps:[{type:"call",skill:"gather",args:{block:"stone",count:{param:"amount"}}}]},postcondition:{type:"inventory_min",item:"cobblestone",count:{param:"amount"}}}。program 还可用 {type:"if",condition,then,else} 或 {type:"repeat",times,body}，循环有界。候选 trial 可以在游玩中试用（配置了隔离试验世界时只在那里试），在两个不同情境里经真实状态验收后才晋升 method；程序不替你选择要学什么。

视觉仅约 ${fov}° 面前视锥，遮挡和光照有效。visible_resources 是亲眼所见，remembered_resources 是可能过期的旧观察；vision.recent_sightings 是刚走出视野的生物（hunt 会走到最后看见它的地方）；未去过的位置未知。附近没看见树只是否定本地观察范围内的木料线索，不能推断整个世界无树。gather 只能采已知资源；若下一步依赖尚未得到的观察，先获得证据再决定，不能预设一定发现资源。观察边走边发生：explore 沿途张望，带 until 一看见就停；gather/hunt 找不到会自己转头找。look_around 只用于专门找某样东西（for）或看某个方向（direction），不要当例行动作或接在 explore 后；原地且事实未变时再次扫视通常没有新信息。行动中感知持续更新，已有信息足够时直接做出选择。不要用管理指令或种子定位资源。sleep 只在主世界安全。不同维度的位置不能直接 goto。
若附带建筑图片，它们是作品实地固定机位的射线语义色可视化，只有观测到的轮廓/遮挡/大类色彩，不能由此声称看到了原版材质细节。请结合自己的偏好、版本差异、功能缺陷和使用反馈成对比较；外观判断属于主观评价，不替代结构验收，不用自评分上涨证明进化。

配方是玩出来的记忆（拿到过材料才知道）。需要时先查（只读，每次决策最多 3 次）：{"kind":"recipes","category":"<tools|weapons|armor|transport|food|light|workstations|storage|building|redstone|materials|misc>"} 看这类你知道哪些、材料够不够；{"kind":"recipes","item":"物品名"} 看还缺什么、从哪来。
可用技能（参数必须合法；组合技能也通过同一取消与动作守卫）：
${catalog}

如果还需要记忆，先输出 {"kind":"recall","query":"要追查的问题","ids":["可选记忆ID"],"filters":{"kinds":["experience"]}}。这是只读查询，不占用游戏动作；最多两轮，返回未知时承认未知。检索排名与读过次数不提高真实性。历史事件不代表库存/设施的当前状态。

否则只输出一个 JSON 对象：
thought 会显示在游戏聊天中，请写成简短的第一人称角色独白（建议 1–2 句、60 字以内），表达眼前的感受、好奇、疑惑或偏好；不要写行动计划、步骤清单、技能参数或详细推演。执行安排只放在 goal 和 steps 中。
{"kind":"plan","thought":"这几块花岗岩的颜色挺暖，我想留一点做对比。","decision":{"kind":"continue","reason":"已看见可采的花岗岩，继续此前的石材收藏","context":["当前可见的花岗岩","已有石材收藏意图"]},"goal":"收集两块已发现的花岗岩","goal_type":"gather","steps":[{"skill":"gather","args":{"block":"granite","count":2}}],"abort_if":{"hp_below":6}}
若没有当前意图，新意图必须嵌套在 decision.intent 中（不是顶层 intent），例如：
{"kind":"plan","thought":"东边的地势看起来开阔，我有点好奇那边是什么样。","decision":{"kind":"begin","reason":"当前位置的线索已经看过，东侧尚未去过且眼前路线开阔","intent":{"text":"看看东侧的地形有什么不同","whyNow":"现有观察足以选择一段新路线","context":["当前地形观察","东侧未访问记录"],"tradeoffs":["暂缓整理收藏"]}},"goal":"向东走一段比较地形","goal_type":"explore","steps":[{"skill":"explore","args":{"direction":"E","distance":48}}]}
decision.intent.context 与 tradeoffs 都是字符串数组。只有 begin/revise 可写 decision.intent，只有新项目或 revise 可写 decision.project（不得在 continue 时重新定义已有工程）。preferences、memory_note、lesson、learn_skill 都是可选字段；learn_skill 采用上文的程序格式。聊天只展示 thought，不另用 say 播报。
可选 on_fail（1–2 步）：某步失败时，在你重新考虑的同时先做的事；新决定一到就替换。
steps 保持 1–6 步；defer/abandon/complete 可以 steps:[]，表示选择等待而非填充无关动作。不要每轮换目标，也不必每轮说话。可用 begin + 已有 intentId 恢复 continuity 中列出的暂缓兴趣及其原项目；新记录的 ID、项目修订、里程碑和请求代次由程序分配，不能伪造或覆盖。`;
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

/**
 * 把感知按变化频率重排（时间戳去掉）：背包/仓储/探索等较稳定的在前，位置/时间/视野等每次都变的在后，
 * 让连续请求的公共前缀尽量长，提高服务端前缀缓存命中。
 */
function stableState(p: Percept): Record<string, unknown> {
  const { ts: _ts, connected, observation, time, self, nearby, vision, death_recovery, ...rest } = p as any;
  const { id: _obsId, ...obs } = (observation ?? {}) as Record<string, unknown>; // 观测序号每次都变，对决策无用
  return { connected, ...(observation ? { observation: obs } : {}), ...rest, death_recovery, nearby, vision, self, time };
}

export function userPrompt(ctx: PlanContext, memory: WorldMemory, recalled?: unknown[], memoryBytes = 8000, compact = 0): string {
  const p = ctx.percept;
  const state = ctx.worldState;
  const recall = recalled ?? ctx.memoryContext?.memories ?? [];
  // 字段按“变化频率从低到高”排列：DeepSeek 等按相同前缀命中缓存，越稳定的内容越靠前，
  // 连续两次请求能共享的前缀就越长（意图/偏好/地标 → 经历/结果 → 实时状态）。
  const near = memory.landmarks().filter((l) => l.dim === p.self.dim && (!state || l.worldId === state.worldId))
    .sort((a, b) => Math.hypot(a.pos.x - p.self.pos[0], a.pos.z - p.self.pos[2]) - Math.hypot(b.pos.x - p.self.pos[0], b.pos.z - p.self.pos[2]))
    .slice(0, 10).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const payload = {
    continuity: ctx.continuity ?? { intent: memory.currentIntent(), project: memory.activeProject() },
    preferences: memory.preferences().sort((a, b) => Number(b.source === 'user') - Number(a.source === 'user') || b.updatedAt - a.updatedAt).slice(0, 8),
    memory_source: ctx.memoryContext?.source ?? (ctx.memoryAvailable ? 'available_on_request' : 'unavailable'),
    known_portals: state ? travelStore(memory).snapshot(state.worldId).endpoints.slice(-10) : [],
    known_locations: near.map((l) => ({ id: l.id, label: l.label, dimension: l.dim, pos: l.pos, observedAt: l.ts })),
    recalled_memories: JSON.parse(boundedJson(recall, memoryBytes)),
    recent_attempts: memory.recentGoals(4).map((g) => ({ ts: g.ts, duration_s: g.durationSec, goal: g.goal,
      status: g.status, summary: g.summary, steps: g.plan ?? g.steps ?? [] })),
    decision_feedback: ctx.decisionFeedback ?? null,
    user_suggestion: ctx.userSuggestion,
    // Results are chronological; reserve room for the newest real outcome even
    // when historical recall has been removed to fit a small model context.
    tool_results: recentResults(ctx.results ?? [], Math.min(Math.max(memoryBytes, 1800), 6000)),
    last_failure: ctx.lastFailure,
    reason: ctx.reason,
    current_task: ctx.current ? { skill: ctx.current.skill, args: ctx.current.args, progress: ctx.current.progress } : null,
    ...(ctx.pendingSteps?.length ? { pending_steps: ctx.pendingSteps } : {}),
    state: stableState(p),
  };
  return contextMessage(compact ? compactContext(payload, compact) : payload);
}

const contextPrefix = '当前观察和选择记录（JSON）：\n';
const contextSuffix = '\n请选择继续、改法或改意，并给出可执行的短计划。';
const contextMessage = (payload: unknown) => `${contextPrefix}${JSON.stringify(payload)}${contextSuffix}`;

function recentResults(results: unknown[], maxBytes: number): unknown[] {
  const newestFirst = [...results].reverse();
  let json = boundedJson(newestFirst, maxBytes);
  // A large data payload must not erase the latest failure or observation.
  if (json === '[]' && newestFirst.length) json = boundedJson([compactContext(newestFirst[0], 2)], maxBytes);
  return JSON.parse(json).reverse();
}

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
    const selected = /^(?:evidence|recent_attempts|recentAttempts|tool_results)$/.test(key) ? value.slice(-limit) : value.slice(0, limit);
    return selected.map((entry) => compactContext(entry, level, '', depth + 1));
  }
  if (typeof value !== 'object' || depth > 16) return '[上下文已省略]';
  const result: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(value)) {
    // wishes duplicates openInterests; repeated historical details are lower priority.
    if (field === 'wishes' || level > 1 && ['recalled_memories', 'farms', 'efficiency', 'learn_candidates'].includes(field)) continue;
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

export function briefCatalog(descriptionChars = 60): string {
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
  if (messages[0]?.role === 'system') for (const [prefix, lean] of LEAN_SECTIONS) {
    if (promptCost(messages) <= maxTokens) break;
    messages[0].content = messages[0].content.split('\n').flatMap((line) => line.startsWith(prefix) ? (lean ? [lean] : []) : [line]).join('\n');
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
    curiosities: p.curiosities.slice(0, 4), drives: p.drives.slice(0, 8), learn_candidates: p.learn_candidates.slice(0, 4),
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


// ------------------------------------------------------------ 小决策（light）
/**
 * 小决策只回答“当前这件事接下来几步怎么做”。不带记忆检索、偏好、项目史、传送门、作品、决策反馈，
 * 规则也只保留几条；需要改方向或更多背景时，模型回复 need_full_context，程序立即改发完整请求。
 */
export function lightSystemPrompt(persona: string): string {
  return `${persona}

你在玩 Minecraft，正在推进一件已经决定要做的事。这是一个“小决策”：手上的动作还在进行，你只需决定接下来几步，像玩家顺手接着干那样。
- 只安排接下来 1–3 步（最多 6），连贯推进当前意图（continuity.intent）；做的同时会再问你下一步，所以不必一次想得很远。current_task 和 pending_steps 会先做完，不要重复它们。
- last_failure 是刚才没成功的那一步：换个做法接着来；若这说明整件事该换方向，就请求完整上下文。
- 观察是边走边发生的：explore 带 until（可写 "cow|sheep" 或 "animal"）一看见就停；gather/hunt 找不到会自己转头找、会走到刚才看见的地方。
- 除了组合动作，还有玩家的“右键/方向键”：use_item、interact、ride、dismount。常规做法走不通时，想想真正的玩家会用什么物品或载具解决。
- 不确定能做什么时可以查配方记忆（只读）：{"kind":"recipes","category":"tools|weapons|armor|transport|food|light|workstations|storage|building|redstone|materials|misc"} 或 {"kind":"recipes","item":"物品名"}。
- 如果你觉得该换个目标/方向，或需要记忆和更多背景才能决定，只输出 {"kind":"need_full_context","reason":"一句话"}。
- thought 是一句第一人称的感受或念头（40 字以内）。思考简洁，抓住眼前一两个关键事实即可。
只输出一个 JSON：{"kind":"plan","thought":"…","goal":"…","steps":[{"skill":"…","args":{}}],"on_fail"?:[…]}
技能：
${briefCatalog(30)}`;
}

export function lightUserPrompt(ctx: PlanContext, memory: WorldMemory): string {
  const p = ctx.percept;
  const v = p.vision;
  const intent = memory.currentIntent();
  const project = memory.activeProject();
  const results = (ctx.results ?? []).slice(-3).map((r: any) => ({ skill: r.skill, status: r.status, summary: String(r.summary ?? '').slice(0, 160) }));
  // 同样按变化频率排列，便于命中前缀缓存
  const payload = {
    continuity: { intent: intent ? { text: intent.text, whyNow: intent.whyNow } : null,
      ...(project ? { project: { title: project.title, milestone: (project as any).milestones?.[(project as any).currentMilestone ?? 0]?.title } } : {}) },
    last_results: results,
    ...(ctx.lastFailure ? { last_failure: ctx.lastFailure } : {}),
    reason: ctx.reason,
    current_task: ctx.current ? { skill: ctx.current.skill, args: ctx.current.args, progress: ctx.current.progress } : null,
    ...(ctx.pendingSteps?.length ? { pending_steps: ctx.pendingSteps } : {}),
    state: {
      emptySlots: p.emptySlots,
      inventory: p.inventory.slice(0, 24),
      ...(p.light ? { light: { level: (p.light as any).level, torches: (p.light as any).torches } } : {}),
      nearby: { hostile: p.nearby.hostile, passive: p.nearby.passive, resources: p.nearby.resources.slice(0, 8) },
      ...(v ? { vision: { facing: v.facing, view: v.view, visible_resources: v.visible_resources.slice(0, 8), seen_entities: v.seen_entities.slice(0, 6),
        ...((v as any).recent_sightings ? { recent_sightings: (v as any).recent_sightings } : {}), nearest_land: v.nearest_land } } : {}),
      ...(p.death_recovery ? { death_recovery: p.death_recovery } : {}),
      self: p.self,
      time: p.time,
    },
  };
  return `当前情况（JSON）：\n${JSON.stringify(payload)}\n${ctx.lastFailure && ctx.reason !== 'prefetch' ? '刚才那一步没成功：换个做法，给出接下来几步。' : '接着推进当前的事：给出接下来几步。'}`;
}

export function buildLightMessages(persona: string, ctx: PlanContext, memory: WorldMemory): ChatMessage[] {
  return [{ role: 'system', content: lightSystemPrompt(persona) }, { role: 'user', content: lightUserPrompt(ctx, memory) }];
}

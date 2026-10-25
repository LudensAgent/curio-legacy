import type { AgentState } from '../adapter/types.ts';
import type { AudienceContext } from '../live/audience.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Percept } from '../perception/perception.ts';
import { audienceBlock, AUDIENCE_RULES, exploredAround, liveAudience, type MySkillInfo } from '../planner/prompt.ts';
import type { ChatMessage } from '../planner/llm.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { myBed } from '../skills/stations.ts';
import { travelStore } from '../travel/store.ts';
import { describeActivity } from './activity.ts';
import { cleanLesson, moodWords, type SelfModel } from './self.ts';
import type { Activity, ActivityRecord, Noticing, StuckHere } from './types.ts';

export interface MindContext {
  tier: 'glance' | 'deliberate';
  reason: string;
  percept: Percept;
  state: AgentState;
  self: SelfModel;
  memory: WorldMemory;
  activity: Activity | null;
  suspended: Activity[];
  lastRecord: ActivityRecord | null;
  noticed: Noticing[];
  changes: string[];
  userSuggestion: string | null;
  audience: AudienceContext | null;
  /** 上次决定里被纠正/丢弃的部分 */
  notes: string[];
  mySkills: MySkillInfo[];
  researchContext?: unknown;
  persona: string;
  stuckHere?: StuckHere | null;
  repeatedFailures?: string[];
}

/** 手脚清单：真人玩家会的动作都在这里（便利流程 + 底层右键/方向键），不再刻意藏起来 */
export function movesCatalog(chars = 60, only?: Set<string>): string {
  return Object.values(SKILLS).filter((s) => !LLM_HIDDEN.has(s.name) && (!only || only.has(s.name)))
    .map((s) => `- ${s.name} ${s.argsDoc}${chars ? `：${s.description.replace(/\s+/g, ' ').slice(0, chars)}` : ''}`).join('\n');
}

const CONDITIONS = `事实条件（done_when 用，可选；每种写法如下）：
- 背包数量：{"type":"inventory_min","item":"oak_log","count":20}
- 到达位置：{"type":"location_near","dimension":"overworld","pos":{"x":0,"y":64,"z":0},"radius":4}（坐标必须来自亲眼看到的或已知地标，不能照抄示例）
- 自身状态：{"type":"self_state","field":"inWater","equals":false}；field 仅支持 inWater/inLava/onGround（布尔）或 held/riding（物品/载具名称或 null）
- 看见天空：{"type":"sky_visible","equals":true}
- 离开地下：{"type":"underground","equals":false}
- 装备：{"type":"equipment","slot":"hand","item":"stone_pickaxe"}
- 亲眼验看方块：{"type":"block_state","dimension":"overworld","pos":{"x":0,"y":64,"z":0},"name":"oak_door","properties":{"open":true}}（坐标同样须有观察依据；遮挡时结果未知）
- 同时满足：{"type":"all_of","conditions":[{"type":"sky_visible","equals":true},{"type":"underground","equals":false}]}
不要写 {"self_state":{"inWater":false}} 或 {"type":"self_state","sky_visible":true}，应分别使用标准 self_state/sky_visible 写法。观察动作没找到目标只是信息；爬出地面应验看 sky_visible/underground，不要用“找到树”代替。`;

const OUTPUT = `只输出一个 JSON 对象：
{"monologue":"第一人称内心独白，接着刚才的念头往下想（20–80 字）",
 "say":"可选：仅有新发现、改主意（switch/detour/experiment）、完成一件事或遇到危险才说；不要复述独白，两句至少隔 45 秒",
 "decision":"continue | adjust | new | detour | switch | experiment | rest",
 "activity":{"what":"这段活要干什么（具体）","why":"为什么现在做","kind":"gather|craft|build|explore|survive|rest|experiment|tidy|social|other",
   "steps":[{"skill":"…","args":{}},{"skill":"…","args":{},"optional":true}],"repeat":1,"done_when":事实条件,"expect":"我预计会怎样","if_stuck":"万一卡住打算怎么办"},
 "next":{"what":"…","why":"…","kind":"…","steps":[…],"repeat":1},
 "agenda":{"add":[{"text":"…","kind":"goal|idea|question","horizon":"today|someday"}],"done":["a_…"],"drop":["a_…"],"focus":"a_…"},
 "learned":"可选：只在结果出乎意料或做完实验时写一句窍门；同情境已有经验时按 id 修订。平常的小想法不用写，休息时会一起回想整理",
 "hypothesis":"experiment 时必填：我猜……会……",
 "experiment_result":"上一段是实验时：supported | refuted | unclear（看 last_activity 的实际结果判断）",
 "diary":"可选：值得写进日记的一句话（今天的经历、感受、里程碑）"}
顺手、碰运气的步骤（路上见到动物就打、有果子就摘、顺便看看有没有矿）标 "optional":true：没成也不算这段活失败，身体会接着做后面的步骤。真正要完成的事别标 optional。
continue 时 activity 可省略；next 可省略（但手上这段活快干完时最好写上，干完就能直接接上，不用停下来发呆）。agenda 只放想做的事或想弄明白的问题，像“卡住时先换路”“别往水里挖”的规则写进 learned，不能当成议程。learned 也可直接输出对象，例如 "learned":{"revise":"k_xxx","text":"这次修订的结论"}。`;

export function deliberateSystem(persona: string): string {
  return `${persona}

你就是这个 Minecraft 角色本人，正在像一个真人玩家那样连续地玩、同时在直播。你脑子里一直有个念头在转，手上一直有事在做。

【怎么想】
1. 先看此刻：noticed（刚注意到的事）、since_last_thought（这段时间真实发生的变化）、身体状态、手上这段活（current_activity）进展如何。
2. 再接上刚才的念头（stream）、今天想做的事（agenda）和日记（diary）。人的思路是连续的：没有新情况就顺着做下去，不要每次都换主意，也不要把刚做完的事再做一遍。
3. 有新情况就权衡：身体的需要（危险、饥饿、天黑、背包满）> 手上正在做的事 > 新冒出来的好奇心。可以先绕个弯处理（detour），处理完会自动回到被打断的活。
4. 活要按“一段”来安排：真人不会每走一步想一次。一段活是几分钟的事（“砍够 20 个原木”“把小屋墙砌完”“往东边那座山走过去看看”），routine 写 1–6 步，可以 repeat 多轮，用 done_when 说清楚什么时候算干完。别把一个零碎动作单独当成一段活：同一件事的几步放进同一个 routine，能重复的用 repeat；顺手的事标 optional。身体会自己连续执行，没找到会换个地方找，失败后只有位置或视野变化才会原样再试；真卡住了才会叫你。
5. 学习：know_how 是自己以前总结的窍门（id/text/wins/losses 分开显示，unverified=true 表示未验证，可信度较低）；last_activity 是刚才那段活的真实结果（得到/失去了什么、和预想比如何）。结果和预想不一样时想想为什么，出乎意料才用 learned 写一句可复用的窍门（平常的小想法留到休息时回想）；同情境已有经验必须用其 id 修订。连续失败就换办法，别硬磕；某个窍门失败多了就别再信它。出现 stuck_here 时必须选择和 tried 完全不同的思路，例如放弃原目标、就地安家或换区域；参考 repeated_failures，别重复已经失败多次的目标。
6. 创新：无聊、好奇或者遇到没见过的东西时，可以冒出点子放进 agenda（kind=idea/question），或者开一段 experiment：小、便宜、结果看得见，写清 hypothesis。实验结果会回到 experiments 里，支持或推翻都是收获。手脚清单里的 use_item / interact_block / hit_entity / ride 等底层操作可以组合出新玩法。
7. 情绪是真实的信号：累了就找个安全的地方歇着或者睡觉；烦躁说明这个办法不行；无聊说明该找点新鲜事；成就感来自做成东西。没有必须完成的科技树或主线，喜欢什么就玩什么，但要像个会过日子的玩家：吃饱、有工具、天黑有地方待。
8. 视野有限：只知道亲眼看到/记得的东西，远处没看见不等于没有；坐标必须来自观察或地标，不要编。
9. 安全反射由程序自动处理（打怪、上浮、逃跑、吃东西、插火把），你不用安排这些琐事，专心想玩什么。

【决定类型】
- continue：手上这段活照常做（只更新独白）
- adjust：还是这件事，但改一改 routine（换目标、数量、方向），当前动作做完就用新 routine
- new：开始一段新的活（手上的已经做完/没意义）
- detour：先插一段别的事，做完回到被打断的活
- switch：放下手上的活改做别的，monologue 里说清为什么
- experiment：一段验证猜想的小活（必须写 hypothesis）
- rest：歇一下，喘口气、看看风景、整理思路

${OUTPUT}
${CONDITIONS}
需要查东西时可以先输出只读查询（不占游戏时间，每次思考最多 3 次）：{"kind":"recipes","item":"物品名","count":1} 看配方和缺口；{"kind":"recipes","category":"tools"} 看一类配方；{"kind":"recall","query":"想回忆的事"} 查长期记忆；{"kind":"mechanics","query":"想做到的操作"} 查底层操作接口。
${liveAudience.enabled ? AUDIENCE_RULES + '\n' : ''}手脚（技能，参数必须合法）：
${movesCatalog(60)}`;
}

export function glanceSystem(persona: string, inUse: Set<string>): string {
  return `${persona}

你在连续地玩 Minecraft。这次只是抬头看一眼：刚注意到的事（noticed）要不要管？手上的活（current_activity）要不要改？
- 手上有活、又没什么要紧的就 continue（顺着做，独白接着刚才的念头，可以很短）。
- 手上没活（刚干完上一段）就直接 new 一段接下来的活，接着 last_activity 的结果和 agenda 往下玩。
- 小改用 adjust（给出改好的完整 activity），要处理一件别的事用 detour，彻底换事用 switch/new。
- 手上的活快干完了就顺便写 next（干完直接接上的下一段活）。
- 需要回想、查配方、做实验或者想得更深，就输出 {"kind":"deliberate","reason":"…"}，会给你完整的信息。
${OUTPUT}
${CONDITIONS}
常用手脚：
${movesCatalog(0, new Set([...inUse, 'gather', 'goto', 'explore', 'craft', 'eat', 'hunt', 'look_around', 'pickup_items', 'wait', 'place_torch', 'sleep', 'shelter', 'build', 'smelt', 'store_items']))}`;
}

const pos3 = (p: [number, number, number]) => p.map((n) => Math.round(n)).join(',');

function bodyState(p: Percept, s: AgentState, activity: Activity | null) {
  const inv = new Map<string, number>();
  for (const i of s.inventory) inv.set(i.name, (inv.get(i.name) ?? 0) + i.count);
  const step = activity?.steps[Math.max(0, activity.index - 1)];
  const digging = !!step && ['gather', 'dig', 'climb_up'].includes(step.skill);
  const material = String((step?.args as Record<string, unknown> | undefined)?.block ?? '');
  const tool = /stone|ore|coal|iron|copper|deepslate/.test(material) ? 'pickaxe' : /dirt|grass|sand|gravel|clay/.test(material) ? 'shovel' : /log|wood/.test(material) ? 'axe' : undefined;
  const suitable = digging ? !!p.self.held && (tool ? p.self.held.endsWith(`_${tool}`) : /_(pickaxe|shovel|axe)$/.test(p.self.held)) : null;
  return {
    pos: pos3(p.self.pos), dim: p.self.dim, biome: p.self.biome, hp: Math.round(p.self.hp), food: p.self.food,
    held: p.self.held, ...(p.self.inWater ? { inWater: true, oxygen: s.oxygen } : {}), ...(p.self.inLava ? { inLava: true } : {}),
    sky_visible: p.self.sky_visible ?? null, depth_below_surface: p.self.depth_below_surface ?? null,
    exits: p.self.exits ?? null,
    ...(digging ? { held_suitable: suitable, ...(!suitable ? { held_note: `正在挖掘，手持 ${p.self.held ?? '空手'}；${tool ? `更适合用 ${tool}` : '应按目标方块选镐或铲等工具'}` } : {}) } : {}),
    ...(p.self.riding ? { riding: p.self.riding } : {}),
    time: { phase: p.time.phase, timeOfDay: p.time.timeOfDay, ...(p.time.can_sleep !== undefined ? { can_sleep: p.time.can_sleep } : {}) },
    ...(p.light ? { light: { level: p.light.level, underground: p.light.underground, mob_spawn_risk: p.light.mob_spawn_risk } } : {}),
    inventory: [...inv].map(([name, count]) => `${name}×${count}`), empty_slots: p.emptySlots,
    ...(p.self.around ? { around: p.self.around } : {}),
  };
}

function surroundingsOf(p: Percept, tier: 'glance' | 'deliberate') {
  const v = p.vision;
  const n = tier === 'glance' ? 5 : 10;
  return {
    hostile: p.nearby.hostile.slice(0, 5), passive: p.nearby.passive.slice(0, 6), players: p.nearby.players,
    see_now: p.nearby.resources.filter((r) => r.seen === 'now').slice(0, n).map((r) => `${r.block}×${r.count} ${r.dir ?? ''}${r.nearest}格`),
    remember: p.nearby.resources.filter((r) => r.seen === 'memory').slice(0, tier === 'glance' ? 3 : 6).map((r) => `${r.block} ${r.dir ?? ''}${r.nearest}格`),
    ...(v ? { facing: v.facing, view: v.view, ...((v as any).visible_drops?.length ? { drops: (v as any).visible_drops.slice(0, 4) } : {}),
      ...(v.nearest_land ? { nearest_land: v.nearest_land } : {}) } : {}),
    ...(tier === 'deliberate' && p.curiosities.length ? { curious_about: p.curiosities.slice(0, 5).map((c) => `${c.what} ${c.dir}${c.dist}格`) } : {}),
    ...(p.death_recovery ? { my_dropped_items: p.death_recovery } : {}),
  };
}

function worldKnowledge(ctx: MindContext) {
  const p = ctx.percept, s = ctx.state, m = ctx.memory;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  const places = m.landmarks().filter((l) => l.dim === p.self.dim && l.worldId === s.worldId)
    .map((l) => ({ l, d: Math.round(Math.hypot(l.pos.x - here.x, l.pos.z - here.z)) })).sort((a, b) => a.d - b.d).slice(0, 8)
    .map(({ l, d }) => `${l.label}[${l.id}] (${Math.round(l.pos.x)},${Math.round(l.pos.y)},${Math.round(l.pos.z)}) ${d}格`);
  const chests = m.chests(p.self.dim).slice(0, 3).map((c) => `(${c.pos.x},${c.pos.y},${c.pos.z}): ${c.items.slice(0, 6).map((i) => `${i.name}×${i.count}`).join('、')}`);
  const danger = m.hazards(p.self.dim).map((h) => ({ h, d: Math.round(Math.hypot(h.pos.x - here.x, h.pos.z - here.z)) })).filter((e) => e.d < 96).slice(0, 4)
    .map(({ h, d }) => `${h.kind} @(${h.pos.x},${h.pos.y},${h.pos.z}) ${d}格，出过 ${h.count} 次事`);
  const bed = myBed(m, { dim: p.self.dim, worldId: s.worldId, pos: here });
  const portals = travelStore(m).snapshot(s.worldId).endpoints.slice(-4);
  return {
    places, ...(chests.length ? { chests } : {}), ...(danger.length ? { danger_zones: danger } : {}),
    ...(bed ? { my_bed: `(${bed.pos.x},${bed.pos.y},${bed.pos.z}) ${bed.dist}格` } : {}),
    ...(portals.length ? { portals } : {}),
    explored_around: exploredAround(m, p.self.dim, p.self.pos),
  };
}

function recordLine(r: ActivityRecord) {
  const g = Object.entries(r.gained).slice(0, 6).map(([k, v]) => `${k}+${v}`).join(' ');
  const l = Object.entries(r.lost).slice(0, 4).map(([k, v]) => `${k}-${v}`).join(' ');
  return { what: r.what, outcome: r.outcome, took_s: r.durationSec, ...(g ? { gained: g } : {}), ...(l ? { used: l } : {}), summary: r.summary,
    ...(r.expect ? { i_expected: r.expect } : {}), ...(r.hypothesis ? { hypothesis: r.hypothesis } : {}) };
}

export function buildMindMessages(ctx: MindContext): ChatMessage[] {
  const self = ctx.self, p = ctx.percept, s = ctx.state;
  const context = [ctx.activity?.what, ctx.lastRecord?.what, ...ctx.noticed.map((n) => n.what), ...self.agenda().map((a) => a.text),
    ...p.nearby.resources.slice(0, 6).map((r) => r.block), ...s.inventory.slice(0, 10).map((i) => i.name)].filter(Boolean).join(' ');
  const image = self.selfImage();
  const glance = ctx.tier === 'glance';
  const payload = {
    me: { traits: self.data.traits, feeling: moodWords(self.mood),
      ...(!glance && (image.goodAt.length || image.struggleWith.length) ? { self_image: image } : {}) },
    agenda: self.agenda().map((a) => ({ id: a.id, text: a.text, kind: a.kind, horizon: a.horizon, ...(a.status === 'active' ? { focus: true } : {}), ...(a.attempts ? { tried: a.attempts } : {}) })),
    ...(!glance && self.diary().length ? { diary: self.diary(5).map((d) => d.text) } : {}),
    know_how: self.relevantKnowHow(context, ctx.activity?.kind, glance ? 3 : 6).map((k) => ({ id: k.id, text: cleanLesson(k.text), wins: k.wins, losses: k.losses, unverified: k.unverified === true })),
    ...(!glance && self.experiments().length ? { experiments: self.experiments().map((e) => ({ hypothesis: e.hypothesis, status: e.status, ...(e.evidence ? { evidence: e.evidence } : {}) })) } : {}),
    ...(!glance && ctx.mySkills.length ? { my_methods: ctx.mySkills.slice(0, 8).map((m) => `${m.name}：${m.description.slice(0, 50)}（${m.status}）`) } : {}),
    ...(!glance && ctx.researchContext ? { research: ctx.researchContext } : {}),
    ...(!glance ? { recent_activities: self.history(5).map(recordLine) } : {}),
    stream: self.recentThoughts(glance ? 4 : 8).map((t) => `${t.kind === 'monologue' ? '' : `[${t.kind}] `}${t.text}`),
    ...(!glance ? { world: worldKnowledge(ctx) } : {}),
    ...(ctx.lastRecord ? { last_activity: recordLine(ctx.lastRecord) } : {}),
    current_activity: ctx.activity ? describeActivity(ctx.activity, s, p) : null,
    ...(ctx.stuckHere ? { stuck_here: { minutes: ctx.stuckHere.minutes, tried: ctx.stuckHere.tried } } : {}),
    ...(ctx.repeatedFailures?.length ? { repeated_failures: ctx.repeatedFailures } : {}),
    ...(ctx.suspended.length ? { will_resume_after: ctx.suspended.map((a) => a.what) } : {}),
    ...(ctx.notes.length ? { last_decision_corrections: ctx.notes } : {}),
    ...(ctx.userSuggestion ? { operator_suggestion: ctx.userSuggestion } : {}),
    ...(audienceBlock(ctx.audience, glance ? 'light' : 'full') ?? {}),
    surroundings: surroundingsOf(p, ctx.tier),
    body: bodyState(p, s, ctx.activity),
    since_last_thought: ctx.changes,
    noticed: ctx.noticed.map((n) => `${n.what}${n.level === 'urgent' ? '（要紧）' : ''}`),
    why_thinking_now: ctx.reason,
  };
  const inUse = new Set([...(ctx.activity?.steps ?? []).map((s) => s.skill), ...(ctx.lastRecord ? [] : [])]);
  const system = glance ? glanceSystem(ctx.persona, inUse) : deliberateSystem(ctx.persona);
  return [{ role: 'system', content: system }, { role: 'user', content: `${JSON.stringify(payload)}\n现在你在想什么、打算怎么做？` }];
}

/**
 * 休息/睡前回想：像人一样把这段时间的零碎经验整理成少数几条靠谱的窍门。
 * 只依据实际成败次数和最近的真实结果，不发明新的事实。
 */
export function buildReflectionMessages(self: SelfModel, persona: string): ChatMessage[] {
  const now = Date.now();
  const system = `${persona}

你在 Minecraft 里歇下来了（休息、睡觉或者告一段落），回想一下这段时间：哪些办法真的好用，哪些想法被事实推翻了，哪些说的是同一回事。像人一样把零碎的经验整理成少数几条靠谱的窍门。
规则：
- 只依据给出的窍门、成败次数（wins/losses）、零碎想法（insights）和最近的经历（recent），不要编造没发生过的事。
- 说的是同一件事的合并成一条（merge），措辞含糊或太长的改写（rewrite，60 字以内，写清“什么情况下、怎么做、会怎样”）。
- 失败明显多于成功、或被后来的经历推翻的丢掉（drop）；只是一次性的流水账也丢掉。
- 零碎想法里被最近经历证实的，才整理成新的窍门（add，最多 5 条）；没证实的就让它过去。
- 议程里已经过时、做不成或不再想做的，可以放下（agenda_drop）。
- 整理后窍门总数最好不超过 25 条。
- 用一句话写日记（diary）记下这段时间最值得记住的事，再用一句独白（monologue）说说现在的感受。
只输出一个 JSON 对象：
{"merge":[{"ids":["k_…","k_…"],"text":"…"}],"rewrite":[{"id":"k_…","text":"…"}],"drop":["k_…"],"add":["…"],"agenda_drop":["a_…"],"diary":"…","monologue":"…"}`;
  const payload = {
    know_how: self.data.knowHow.map((k) => ({ id: k.id, text: cleanLesson(k.text), wins: k.wins, losses: k.losses, ...(k.unverified ? { unverified: true } : {}),
      age_min: Math.round((now - k.createdAt) / 60000) })),
    insights: self.insights().map((i) => `${i.text}${i.outcome ? `（当时结果：${i.outcome}）` : ''}`),
    recent: self.history(20).map((r) => `${r.what} → ${r.outcome}${Object.keys(r.gained).length ? `，得到 ${Object.entries(r.gained).map(([k, v]) => `${k}×${v}`).join(' ')}` : ''}${r.outcome !== 'done' ? `：${r.summary.slice(0, 60)}` : ''}`),
    experiments: self.experiments(6).map((e) => `${e.hypothesis} → ${e.status}${e.evidence ? `（${e.evidence.slice(0, 80)}）` : ''}`),
    agenda: self.agenda().map((a) => ({ id: a.id, text: a.text, kind: a.kind, tried: a.attempts })),
    diary: self.diary(5).map((d) => d.text),
    feeling: moodWords(self.mood),
  };
  return [{ role: 'system', content: system }, { role: 'user', content: `${JSON.stringify(payload)}\n回想一下，整理好再告诉我。` }];
}

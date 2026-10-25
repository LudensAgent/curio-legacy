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
import { describeBuild, homeOf, myBuilds } from './home.ts';
import { activeDrafts } from '../building/drafts.ts';
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
  /** 技能书索引（每份一行） */
  skills?: string[];
  /** 游戏自己的系统消息（死亡播报、成就、公告），原话 */
  gameMessages?: string[];
  stuckHere?: StuckHere | null;
  repeatedFailures?: string[];
  /** 建筑师正在后台画的图纸 */
  designing?: { brief: string; minutes: number };
}

/**
 * 提示词的组织（针对注意力容易被“手边的格式”和“最后看到的内容”带走的模型，如 DeepSeek）：
 * - 系统提示词短而稳定：身份 → 原则 → 先查再做（技能书、建筑师）→ 决定 → 输出 → 例子 → 动作；固定内容在前，便于缓存。
 * - 规则贴在用的地方：动作说明自己写清“新房子用图纸”，常用动作给完整参数，冷门动作只列名字（需要时 moves 查）。
 * - 用户消息末尾按情境追加 2–4 条“此刻要留意”的提醒，只说和眼下有关的。
 */

/** 常用动作：给完整参数；其余只列名字和一句用途，需要时用 {"kind":"moves"} 查完整参数 */
export const COMMON_MOVES = ['dig_at', 'step', 'place_at', 'defend', 'gather', 'goto', 'explore', 'wander', 'look_around', 'craft', 'smelt', 'eat', 'hunt', 'forage', 'fish', 'farm', 'collect_seeds',
  'pickup_items', 'store_items', 'take_items', 'place_torch', 'shelter', 'sleep', 'wait', 'dig', 'climb_up', 'build', 'boat', 'inspect_block', 'interact_block', 'use_item'];

/** 远行、传送门、末地这些只在用得上时列出来，平时是噪音 */
const ADVANCED = /portal|end_|dragon|stronghold|search_structure|excavate|reservations|base_memory|building_archive|building_review|ranged_defend|equip_armor/;

/** 描述取第一句话，太长就在逗号处截断（不截在半个词上） */
function briefOf(d: string, n: number): string {
  const first = d.replace(/\s+/g, ' ').split(/[。；;：:]/)[0];
  if (first.length <= n) return first;
  const cut = first.slice(0, n);
  const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(','), cut.lastIndexOf('（'));
  return at > n / 2 ? cut.slice(0, at) : `${cut}…`;
}

export function movesCatalog(chars = 40, only?: Set<string>, advanced = true): string {
  const visible = Object.values(SKILLS).filter((s) => !LLM_HIDDEN.has(s.name) && (!only || only.has(s.name)));
  const common = visible.filter((s) => COMMON_MOVES.includes(s.name)).map((s) => `- ${s.name} ${s.argsDoc}${chars ? `：${briefOf(s.description, chars)}` : ''}`);
  const rare = only ? [] : visible.filter((s) => !COMMON_MOVES.includes(s.name) && (advanced || !ADVANCED.test(s.name))).map((s) => `${s.name}（${briefOf(s.description, 14)}）`);
  return `${common.join('\n')}${rare.length ? `\n其他动作（用 {"kind":"moves","names":["…"]} 查完整参数）：${rare.join('、')}` : ''}`;
}

/** 完整参数（moves 查询用） */
export function moveDetails(names: string[]): string {
  return names.slice(0, 6).map((n) => {
    const s = SKILLS[n];
    return s && !LLM_HIDDEN.has(n) ? `- ${s.name} ${s.argsDoc}：${s.description.replace(/\s+/g, ' ')}` : `- ${n}：没有这个动作`;
  }).join('\n');
}

const CONDITIONS = `done_when 的写法（可选，写错会被忽略）：
{"type":"inventory_min","item":"oak_log","count":20}｜{"type":"location_near","dimension":"overworld","pos":{"x":0,"y":64,"z":0},"radius":4}（坐标要来自观察或地标）｜{"type":"self_state","field":"inWater|inLava|onGround","equals":false}｜{"type":"self_state","field":"held|riding","equals":"物品名或 null"}｜{"type":"sky_visible","equals":true}｜{"type":"underground","equals":false}｜{"type":"equipment","slot":"hand","item":"stone_pickaxe"}｜{"type":"all_of","conditions":[…]}
写开工时还不成立、做完才成立的事（往下躲进地里 → {"type":"underground","equals":true}）；开工前就成立的条件会被当成没写。`;

const OUTPUT = `只输出一个 JSON 对象：
{"monologue":"第一人称内心独白，接着刚才的念头往下想（20–80 字）",
 "decision":"continue|adjust|new|detour|switch|experiment|rest",
 "activity":{"what":"具体要干什么","why":"为什么现在做","kind":"gather|craft|build|explore|survive|rest|experiment|tidy|social|other","steps":[{"skill":"动作名","args":{}}],"repeat":1,"done_when":{…},"expect":"预计会怎样","if_stuck":"卡住打算怎么办"},
 "next":{同 activity，手上的活快干完时写上，干完直接接上}}
continue 时可以不写 activity；要换成别的做法就用 adjust/new，别写 continue。顺手、碰运气的步骤加 "optional":true（没成也不算失败）。
其他可选字段：say（有新发现、改主意、做成一件事或遇到危险时才说的一句口语）｜agenda（{"add":[{"text":"想做的事或想弄清的问题","kind":"goal|idea|question","horizon":"today|someday"}],"done":["a_…"],"drop":["a_…"],"focus":"a_…"}，规则不要放这里）｜learned（结果出乎意料时的一句窍门，或 {"revise":"k_…","text":"…"} 修订旧窍门）｜hypothesis（experiment 必填）｜experiment_result（上一段是实验时：supported|refuted|unclear）｜diary（值得记住的一句话）｜liked（刚发现自己喜欢的东西）｜habits（身体的顺手习惯，改之前一直有效：{"torch_every":8} 暗处每 8 格插火把，{"eat_below":12} 饿到 12 顺手吃，{"pickup":true} 空档捡掉落物；0 关掉。没定的身体不做）`;

const DECISIONS = `continue 照常做｜adjust 还是这件事、改一改 routine｜new 开始新的一段｜detour 先插一段别的，做完自动回来｜switch 放下手上的改做别的（独白里说清为什么）｜experiment 验证一个猜想的小活｜rest 歇一下`;

const QUERIES = (skills: string[]) => `【先查再做】需要时先输出一个查询 JSON（不占游戏时间，每次思考最多 3 次），拿到结果再决定：
- {"kind":"skill","name":"技能名"} 翻开技能书看做法｜{"kind":"design","brief":"用途、多大、风格、在哪"} 请建筑师在后台画图纸
- {"kind":"recipes","item":"物品名","count":1} 看配方和缺口｜{"kind":"moves","names":["动作名"]} 看动作完整参数
- {"kind":"recall","query":"…"} 查长期记忆｜{"kind":"mechanics","query":"…"} 查底层操作接口
${skills.length ? `技能书：\n${skills.map((x) => `- ${x}`).join('\n')}` : ''}`;

/** 用户消息分块：越往后越要紧（模型对末尾注意力最强） */
const READING = `【消息怎么读】分块给出，越往后越要紧：【我】性格心情、议程、窍门 →【记得的地方】家、床、作品、图纸、地标 →【最近】刚做完的事和念头 →【手上的活】在做什么、做到哪 →【身边】方块图 local、出口、生物、资源 →【身体】在哪(where)、生命饥饿、时间、亮度、背包 →【此刻】为什么现在想、注意到什么 →【此刻要留意】。`;

const ROUTINE_OF_THINKING = `【每次这样想】
1. 先看【此刻】和【此刻要留意】：危险、快饿死、天黑、卡住这类要紧的先处理。
2. 看【身体】where：在地表就走路，在坑里或地下才挖。
3. 手上的活还对吗：recent 结果正常、done_when 在推进就 continue。
4. 要换就按【选动作】挑最贴切的；身边一格的事对照【身边】local 写坐标。
5. 拿不准做法或参数就先查（skill / moves / recipes）。
6. 输出前核对：动作名在列表里、参数合法、done_when 做完才成立。
这几步在心里快速过一遍就够，不用长篇推演；拿不准的去查，别反复猜。`;

const CHOOSE = `【选动作】
- 去记得的地方或坐标 → goto；找没见过的东西 → explore {"until":…}；拿看得见的方块 → gather；身边某一格 → dig_at / step / place_at
- 过水 → boat 或游过去；吃 → eat（背包有吃的）/ hunt / forage / fish；做东西 → craft、smelt（拿不准先查 recipes）
- 有怪靠近 → defend {"target":"名字"} 打掉，或走开绕路（苦力怕也是你定：打就砍一下退一步）
- 过夜 → sleep（有床，看参数选哪张）/ shelter / 自己挖坑封顶；在坑里或地下 → place_at [0,0,0] 垫高或挖台阶
- 盖新房子 → design 拿图纸 → 攒材料 → build {"draft":"图纸ID"}；没盖完的 → build {"projectId":"作品ID"}；不要自己画图纸`;

const PRINCIPLES = `【原则】
- 接着刚才的念头往下想，不反复换主意、不重复刚做完的事；临时处理用 detour，做完自动回到原来的活。
- 一段活是几分钟的一件事（“砍够 20 个原木”“把墙砌完”）：routine 1–6 步，可 repeat，done_when 写清何时收工；身体连续执行、自己应变，真卡住才叫你。
- 从真实结果里学：出乎意料才写 learned；连续失败就换办法；有 stuck_here 必须换完全不同的思路，别碰 repeated_failures 里的目标。
- 你会被风景吸引、想把家弄得舒服好看：喜欢的写 liked，想做的放 agenda；天黑惦记家，没盖完的房子会回去盖。情绪是信号：累了歇、烦了换办法、腻了找新鲜事。
- 只知道亲眼看到或记得的东西，坐标来自观察或地标，不编。
- 身体只有保命本能（苦力怕嘶嘶响时躲开、溺水上浮、被贴脸还手、快饿死才吃）；插火把、顺手吃、捡东西要你自己做，或用 habits 定成习惯。`;

const PRECISE = `【精确操作】【身边】local 是以脚为原点的方块图（[前,上,右]，前=facing）。dig_at 挖哪格、step 迈到哪格、place_at 在哪格放方块，都写确切的相对坐标；放进 routine 重复时每步按当时站的位置重算，例如：
- 朝北挖阶梯上地面：steps [dig_at {"at":[0,2,0],"facing":"N"}, dig_at {"at":[1,1,0],"facing":"N"}, dig_at {"at":[1,2,0],"facing":"N"}, step {"to":[1,1,0],"facing":"N"}]，repeat 10，done_when {"type":"sky_visible","equals":true}
- 原地垫高：steps [dig_at {"at":[0,2,0]}, place_at {"at":[0,0,0],"item":"any"}]，repeat 6｜平巷：steps [dig_at {"at":[1,0,0]}, dig_at {"at":[1,1,0]}, step {"to":[1,0,0]}]，repeat 8
- 往下挖：重复 dig_at [0,-1,0]（挖空人就掉下去，不用 step）
repeat 每轮重做整套 steps：火把别写进要重复的 steps，用 habits.torch_every 或看【身体】light 暗了再插。挖之前看清那格（沙子沙砾会掉，水和岩浆别挖开）。`;

const EXAMPLE = `【例子】想有个家时：
→ {"kind":"design","brief":"湖边能住的小屋，云杉木，放得下床、箱子和工作台"}
← 已经请建筑师去画了……画好会告诉你
→ {"monologue":"图纸要等一会儿，先去砍云杉攒木板，碰到羊顺手打。","decision":"new","activity":{"what":"砍够 12 根云杉原木","why":"盖小屋缺木板","kind":"gather","steps":[{"skill":"gather","args":{"block":"spruce_log","count":12}},{"skill":"hunt","args":{"animal":"sheep"},"optional":true}],"done_when":{"type":"inventory_min","item":"spruce_log","count":12}}}`;

export function deliberateSystem(persona: string, skills: string[] = [], advanced = false): string {
  return `${persona}

你就是这个 Minecraft 角色本人，像真人玩家一样连续地玩，同时在直播。

${READING}

${ROUTINE_OF_THINKING}

${PRINCIPLES}

${CHOOSE}

${QUERIES(skills)}

【决定】${DECISIONS}

【输出】${OUTPUT}
${CONDITIONS}

${PRECISE}

${EXAMPLE}
${liveAudience.enabled ? `\n${AUDIENCE_RULES}\n` : ''}
【动作】参数必须合法：
${movesCatalog(28, undefined, advanced)}`;
}

export function glanceSystem(persona: string, inUse: Set<string>, skills: string[] = []): string {
  return `${persona}

你在连续地玩 Minecraft，这次只是抬头看一眼。
${READING}
- 先看【此刻】：没什么要紧的、手上的活还顺，就 continue（独白可以很短）。
- 手上没活：直接 new 一段，接着【最近】的结果和议程往下玩；活快干完时顺便写 next。小改用 adjust，插一件事用 detour，彻底换事用 switch/new。
- 在地表就走路，在坑里或地下（看【身体】where）才挖；身边一格的事对照【身边】local 用 dig_at / step / place_at 写确切坐标。
- 要翻技能书、请建筑师（design）、查配方或想得更深：直接输出查询，如 {"kind":"design","brief":"…"}、{"kind":"skill","name":"…"}、{"kind":"deliberate","reason":"…"}（转成认真想、给你完整信息）。
${skills.length ? `技能书：${skills.map((x) => x.split('：')[0]).join('、')}。` : ''}盖新房子先 design 拿图纸，再 build {"draft":"图纸ID"}；不要自己画图纸。

${CHOOSE}

【决定】${DECISIONS}

【输出】${OUTPUT}
${CONDITIONS}

【常用动作】
${movesCatalog(0, new Set([...inUse, 'dig_at', 'step', 'place_at', 'defend', 'gather', 'goto', 'explore', 'craft', 'eat', 'hunt', 'forage', 'look_around', 'pickup_items', 'wait', 'place_torch', 'sleep', 'shelter', 'build', 'smelt', 'store_items', 'climb_up', 'boat']))}`;
}

/** 按情境追加在用户消息末尾的提醒：只说和眼下有关的 2–4 件事 */
export function situationalReminders(ctx: MindContext): string[] {
  const out: string[] = [];
  const p = ctx.percept, s = ctx.state;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  const drafts = activeDrafts()?.list(4).filter((d) => !d.usedBy) ?? [];
  const unfinished = myBuilds(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }).filter((b) => b.status !== 'complete' && b.dist <= 96);
  const intent = [ctx.activity?.what, ctx.activity?.why, ...ctx.self.agenda().map((a) => a.text), ...ctx.self.recentThoughts(3).map((t) => t.text)].filter(Boolean).join(' ');
  if (ctx.stuckHere) out.push(`你在这一带已经卡了 ${ctx.stuckHere.minutes} 分钟：换一个和 tried 完全不同的办法（换区域、换目标、就地安家都行）`);
  const exits = Object.values(p.self.exits ?? {});
  const where = p.self.where?.kind;
  const trapped = where ? where === 'underground' || where === 'pit' : p.self.sky_visible !== true && (p.self.overhead?.covered === 'rock' || p.light?.underground === true) || exits.length > 0 && exits.every((e) => !e.walk && !e.step_up);
  if (trapped && where === 'pit') out.push(`你${p.self.where!.text}：原地 place_at [0,0,0] 垫高，或挖一级台阶 step 上去就出来了`);
  else if (trapped) out.push('你在地下或被围住了：看【身边】local，用 dig_at / step / place_at 一格一格自己挖出去（比如挖阶梯：dig_at [0,2,0]、dig_at [1,1,0]、dig_at [1,2,0]、step [1,1,0] 重复到 sky_visible）');
  else if (where === 'surface' && p.self.sky_visible !== true) out.push(`你${p.self.where!.text}，不是在地下：直接走路，不用挖`);
  if (unfinished.length) out.push(`「${unfinished[0].name}」还没盖完：材料够了就 build {"projectId":"${unfinished[0].id}"} 接着盖`);
  if (ctx.designing) out.push(`建筑师正在画「${ctx.designing.brief.slice(0, 40)}」（${ctx.designing.minutes} 分钟了），画好会告诉你：先攒常用的木头、石头，或做别的事`);
  else if (drafts.length) out.push(`图纸 ${drafts[0].id}「${drafts[0].name}」已经画好：按材料清单攒齐后 build {"draft":"${drafts[0].id}"}`);
  else if (!unfinished.length && /盖|建|房|屋|家|住处|庇护/.test(intent)) out.push('想盖新房子：先输出 {"kind":"design","brief":"…"} 请建筑师画图纸，再按清单攒材料、照图施工，不要自己画图纸');
  const bed = nearestBed(ctx);
  const bedInBag = s.inventory.some((i) => i.name.endsWith('_bed'));
  const bedLine = bed ? `记得的床在 ${bed.dist} 格外（${bed.dir}，${bed.pos}）` : '';
  if (p.time.phase === 'dusk' || p.time.phase === 'night') {
    const [bx, by, bz] = bed ? bed.pos.split(',') : [];
    const options = [bed ? `${bedLine}${bed.dist > 128 ? '，挺远' : ''}，去那儿睡写 sleep {"at":{"x":${bx},"y":${by},"z":${bz}}}` : '', bedInBag ? '背包里有床，就地放下睡写 sleep {"place":true}' : ''].filter(Boolean).join('；');
    out.push(`天${p.time.phase === 'dusk' ? '快' : '已经'}黑了：想好今晚在哪过${options ? `（${options}）` : '（家、床，或者就地躲一晚）'}`);
  } else {
    // 像人一样掂量回程：离天黑不远、床又在远处，就该动身或另作打算
    const tod = ((p.time.timeOfDay % 24000) + 24000) % 24000;
    const toDuskMin = (12000 - tod) / 1200;
    if (bed && !bedInBag && bed.dist > 32 && toDuskMin > 0 && toDuskMin <= Math.max(2, bed.dist / 4 / 60 + 1.5))
      out.push(`再过大约 ${Math.max(1, Math.round(toDuskMin))} 分钟天黑；${bedLine}，走回去要 ${Math.max(1, Math.round(bed.dist / 4 / 60))} 分钟左右：要回去睡就该动身了，否则就近想办法过夜`);
  }
  if (p.self.food <= 8) out.push(`饿了（饥饿 ${p.self.food}）：留意吃的`);
  return out.slice(0, 4);
}

/** 记得的最近一张床（自己的或看见过的） */
function nearestBed(ctx: MindContext): { dist: number; dir: string; pos: string } | null {
  const p = ctx.percept, s = ctx.state;
  const [x, , z] = p.self.pos;
  let best: { dist: number; dir: string; pos: string } | null = null;
  for (const l of ctx.memory.landmarks()) {
    if ((l.label !== '床' && l.label !== '我的床') || l.dim !== p.self.dim || (l.worldId && l.worldId !== s.worldId)) continue;
    const dx = l.pos.x - x, dz = l.pos.z - z, dist = Math.round(Math.hypot(dx, dz, l.pos.y - p.self.pos[1]));
    if (best && best.dist <= dist) continue;
    const ns = Math.abs(dz) > Math.abs(dx) * 0.4 ? (dz < 0 ? '北' : '南') : '', ew = Math.abs(dx) > Math.abs(dz) * 0.4 ? (dx < 0 ? '西' : '东') : '';
    best = { dist, dir: `${ns}${ew}${ns && ew ? '' : '边'}`, pos: `${Math.round(l.pos.x)},${Math.round(l.pos.y)},${Math.round(l.pos.z)}` };
  }
  return best;
}

const pos3 = (p: [number, number, number]) => p.map((n) => Math.round(n)).join(',');

/** 【身体】：自己在哪、状态、时间、亮度、背包 */
function bodyState(p: Percept, s: AgentState, activity: Activity | null, habits: object) {
  const inv = new Map<string, number>();
  for (const i of s.inventory) inv.set(i.name, (inv.get(i.name) ?? 0) + i.count);
  const step = activity?.steps[Math.max(0, activity.index - 1)];
  const digging = !!step && ['gather', 'dig', 'climb_up'].includes(step.skill);
  const material = String((step?.args as Record<string, unknown> | undefined)?.block ?? '');
  const tool = /stone|ore|coal|iron|copper|deepslate/.test(material) ? 'pickaxe' : /dirt|grass|sand|gravel|clay/.test(material) ? 'shovel' : /log|wood/.test(material) ? 'axe' : undefined;
  const suitable = digging ? !!p.self.held && (tool ? p.self.held.endsWith(`_${tool}`) : /_(pickaxe|shovel|axe)$/.test(p.self.held)) : null;
  return {
    ...(p.self.where ? { where: p.self.where.text } : p.self.overhead ? { overhead: p.self.overhead.block ? `头顶 ${p.self.overhead.up} 格是 ${p.self.overhead.block}` : '头顶一直空着' } : {}),
    pos: pos3(p.self.pos), dim: p.self.dim, biome: p.self.biome, sky_visible: p.self.sky_visible ?? null,
    hp: Math.round(p.self.hp), food: p.self.food,
    ...(p.self.inWater ? { inWater: true, oxygen: s.oxygen } : {}), ...(p.self.inLava ? { inLava: true } : {}), ...(p.self.riding ? { riding: p.self.riding } : {}),
    time: `${{ day: '白天', dusk: '黄昏', night: '夜里', dawn: '清晨' }[p.time.phase] ?? p.time.phase}（${p.time.timeOfDay}）${p.time.can_sleep ? '，能睡觉' : ''}`,
    ...(p.light ? { light: `${{ bright: '亮', dim: '有点暗', dark: '很暗' }[p.light.level] ?? p.light.level}${p.light.mob_spawn_risk ? '，会刷怪' : ''}` } : {}),
    held: p.self.held,
    ...(digging ? { held_suitable: suitable, ...(!suitable ? { held_note: `正在挖掘，手持 ${p.self.held ?? '空手'}；${tool ? `更适合用 ${tool}` : '应按目标方块选镐或铲等工具'}` } : {}) } : {}),
    inventory: [...inv].map(([name, count]) => `${name}×${count}`), empty_slots: p.emptySlots,
    habits,
  };
}

function surroundingsOf(p: Percept, tier: 'glance' | 'deliberate') {
  const v = p.vision;
  const n = tier === 'glance' ? 5 : 10;
  return {
    ...(p.self.local ? { local: p.self.local } : {}),
    ...(p.self.around ? { around: p.self.around } : {}),
    exits: p.self.exits ?? null,
    hostile: p.nearby.hostile.slice(0, 5), passive: p.nearby.passive.slice(0, 6), players: p.nearby.players,
    see_now: p.nearby.resources.filter((r) => r.seen === 'now').slice(0, n).map((r) => `${r.block}×${r.count} ${r.dir ?? ''}${r.nearest}格`),
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
  const builds = myBuilds(m, { worldId: s.worldId, dim: p.self.dim, pos: here });
  const home = homeOf(m, { worldId: s.worldId, dim: p.self.dim, pos: here });
  const drafts = activeDrafts()?.list(4).filter((d) => !d.usedBy) ?? [];
  const remember = p.nearby.resources.filter((r) => r.seen === 'memory').slice(0, ctx.tier === 'glance' ? 3 : 6).map((r) => `${r.block} ${r.dir ?? ''}${r.nearest}格`);
  return {
    home: home ? `${home.label} 在${home.dir}边 ${home.dist} 格 (${Math.round(home.pos.x)},${Math.round(home.pos.y)},${Math.round(home.pos.z)})` : '还没有家',
    ...(bed ? { my_bed: `(${bed.pos.x},${bed.pos.y},${bed.pos.z}) ${bed.dist}格` } : {}),
    ...(builds.length ? { my_builds: builds.map(describeBuild) } : {}),
    // 建筑师画好、还没盖的图纸：一直惦记着
    ...(drafts.length ? { my_drafts: drafts.map((d) => `${d.id}「${d.name}」${d.size.width}×${d.size.depth}，用料 ${Object.entries(d.materials).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n}×${c}`).join('、')}`) } : {}),
    ...(remember.length ? { resources_seen_before: remember } : {}),
    ...(ctx.tier === 'deliberate' ? { places, ...(chests.length ? { chests } : {}), ...(portals.length ? { portals } : {}), explored_around: exploredAround(m, p.self.dim, p.self.pos) } : {}),
    ...(danger.length ? { danger_zones: danger } : {}),
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
  // 分块，越往后越要紧：背景 → 记得的 → 最近 → 手上的活 → 身边 → 身体 → 此刻
  const sections: [string, Record<string, unknown>][] = [
    ['我', {
      traits: self.data.traits, feeling: moodWords(self.mood), ...(self.tastes().length ? { likes: self.tastes() } : {}),
      ...(!glance && (image.goodAt.length || image.struggleWith.length) ? { self_image: image } : {}),
      agenda: self.agenda().map((a) => ({ id: a.id, text: a.text, kind: a.kind, horizon: a.horizon, ...(a.status === 'active' ? { focus: true } : {}), ...(a.attempts ? { tried: a.attempts } : {}) })),
      know_how: self.relevantKnowHow(context, ctx.activity?.kind, glance ? 3 : 6).map((k) => ({ id: k.id, text: cleanLesson(k.text), wins: k.wins, losses: k.losses, unverified: k.unverified === true })),
      ...(!glance && self.experiments().length ? { experiments: self.experiments().map((e) => ({ hypothesis: e.hypothesis, status: e.status, ...(e.evidence ? { evidence: e.evidence } : {}) })) } : {}),
      ...(!glance && self.diary().length ? { diary: self.diary(5).map((d) => d.text) } : {}),
      ...(!glance && ctx.mySkills.length ? { my_methods: ctx.mySkills.slice(0, 8).map((m) => `${m.name}：${m.description.slice(0, 50)}（${m.status}）`) } : {}),
      ...(!glance && ctx.researchContext ? { research: ctx.researchContext } : {}),
    }],
    ['记得的地方', worldKnowledge(ctx)],
    ['最近', {
      ...(!glance ? { recent_activities: self.history(5).map(recordLine) } : {}),
      ...(ctx.lastRecord ? { last_activity: recordLine(ctx.lastRecord) } : {}),
      stream: self.recentThoughts(glance ? 4 : 8).map((t) => `${t.kind === 'monologue' ? '' : `[${t.kind}] `}${t.text}`),
    }],
    ['手上的活', {
      current_activity: ctx.activity ? describeActivity(ctx.activity, s, p) : null,
      ...(ctx.suspended.length ? { will_resume_after: ctx.suspended.map((a) => a.what) } : {}),
      ...(ctx.designing ? { architect_drawing: `${ctx.designing.brief.slice(0, 60)}（${ctx.designing.minutes} 分钟了）` } : {}),
      ...(ctx.stuckHere ? { stuck_here: { minutes: ctx.stuckHere.minutes, tried: ctx.stuckHere.tried } } : {}),
      ...(ctx.repeatedFailures?.length ? { repeated_failures: ctx.repeatedFailures } : {}),
      ...(ctx.notes.length ? { last_decision_corrections: ctx.notes } : {}),
    }],
    ['身边', surroundingsOf(p, ctx.tier)],
    ['身体', bodyState(p, s, ctx.activity, self.habits())],
    ['此刻', {
      why_thinking_now: ctx.reason,
      noticed: ctx.noticed.map((n) => `${n.what}${n.level === 'urgent' ? '（要紧）' : ''}`),
      since_last_thought: ctx.changes,
      ...(ctx.gameMessages?.length ? { game_messages: ctx.gameMessages } : {}),
      ...(ctx.userSuggestion ? { operator_suggestion: ctx.userSuggestion } : {}),
      ...(audienceBlock(ctx.audience, glance ? 'light' : 'full') ?? {}),
    }],
  ];
  const advanced = p.self.dim !== 'overworld' || s.inventory.some((i) => /ender_(eye|pearl)|obsidian|blaze/.test(i.name));
  const inUse = new Set((ctx.activity?.steps ?? []).map((s) => s.skill));
  const system = glance ? glanceSystem(ctx.persona, inUse, ctx.skills ?? []) : deliberateSystem(ctx.persona, ctx.skills ?? [], advanced);
  const reminders = situationalReminders(ctx);
  const body = sections.map(([name, data]) => `【${name}】${JSON.stringify(data)}`).join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `${body}${reminders.length ? `\n\n【此刻要留意】\n${reminders.map((r) => `- ${r}`).join('\n')}` : ''}\n\n现在你在想什么、打算怎么做？只输出一个 JSON 对象。` }];
}

/**
 * 休息/睡前回想：像人一样把这段时间的零碎经验整理成少数几条靠谱的窍门。
 * 只依据实际成败次数和最近的真实结果，不发明新的事实。
 */
export function buildReflectionMessages(self: SelfModel, persona: string, mySkills: string[] = []): ChatMessage[] {
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
- 如果这段时间琢磨出了一整套成体系、以后还会用到的做法（比如怎么在山坡上盖房、怎么经营一块农田、夜里怎么过），可以写成一份自己的技能（skill：英文小写名字、一句用途、几行 Markdown 写清步骤和要点），以后直接翻开用；已有同名的自己写的技能会被更新。没有就省略。
- 用一句话写日记（diary）记下这段时间最值得记住的事，再用一句独白（monologue）说说现在的感受。
只输出一个 JSON 对象：
{"merge":[{"ids":["k_…","k_…"],"text":"…"}],"rewrite":[{"id":"k_…","text":"…"}],"drop":["k_…"],"add":["…"],"agenda_drop":["a_…"],"skill":{"name":"…","description":"…","body":"…"},"diary":"…","monologue":"…"}`;
  const payload = {
    know_how: self.data.knowHow.map((k) => ({ id: k.id, text: cleanLesson(k.text), wins: k.wins, losses: k.losses, ...(k.unverified ? { unverified: true } : {}),
      age_min: Math.round((now - k.createdAt) / 60000) })),
    insights: self.insights().map((i) => `${i.text}${i.outcome ? `（当时结果：${i.outcome}）` : ''}`),
    recent: self.history(20).map((r) => `${r.what} → ${r.outcome}${Object.keys(r.gained).length ? `，得到 ${Object.entries(r.gained).map(([k, v]) => `${k}×${v}`).join(' ')}` : ''}${r.outcome !== 'done' ? `：${r.summary.slice(0, 60)}` : ''}`),
    experiments: self.experiments(6).map((e) => `${e.hypothesis} → ${e.status}${e.evidence ? `（${e.evidence.slice(0, 80)}）` : ''}`),
    agenda: self.agenda().map((a) => ({ id: a.id, text: a.text, kind: a.kind, tried: a.attempts })),
    diary: self.diary(5).map((d) => d.text),
    feeling: moodWords(self.mood),
    ...(mySkills.length ? { my_skills: mySkills } : {}),
  };
  return [{ role: 'system', content: system }, { role: 'user', content: `${JSON.stringify(payload)}\n回想一下，整理好再告诉我。` }];
}

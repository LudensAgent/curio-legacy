import type { AgentState } from '../adapter/types.ts';
import type { AudienceContext } from '../live/audience.ts';
import type { WorldMemory } from '../memory/store.ts';
import { DARK_TICK, durationText, realSecondsToTicks, ticksUntil, timeSense, type Percept } from '../perception/perception.ts';
import { audienceBlock, AUDIENCE_RULES, exploredAround, liveAudience, type MySkillInfo } from '../planner/prompt.ts';
import type { ChatMessage } from '../planner/llm.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { myBed } from '../skills/stations.ts';
import { travelStore } from '../travel/store.ts';
import { describeActivity } from './activity.ts';
import { describeBuild, homeOf, myBuilds } from './home.ts';
import { FACILITY_LABELS, myFacilities } from './facilities.ts';
import { activeDrafts } from '../building/drafts.ts';
import { cleanLesson, moodWords, type SelfModel } from './self.ts';
import type { Activity, ActivityRecord, Noticing, StuckHere } from './types.ts';
import type { FocusPlan } from './self.ts';
import { RECALL_LABEL, type Recalled } from './recall.ts';
import { foodNote } from '../skills/food.ts';
import { isResourceBlock, oreSpotsByKind, oreSpotsNear } from '../memory/ore-spots.ts';
import { oreLayerFacts } from '../knowledge/ore-layers.ts';
import { husbandryFacts, villagerFacts } from '../knowledge/husbandry.ts';
import type { HuntTally } from './ledger.ts';
import { FOOD_ANIMAL_NAMES } from '../skills/movement.ts';
import { config } from '../config.ts';
import { creatureSpotsByKind, creatureSpotsNear } from '../memory/creature-spots.ts';

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
  /** 操作者的指令（直到做完、做不到或被新指令替换都一直在） */
  operatorOrder?: { text: string; ageSec: number; status: 'new' | 'doing'; kind?: 'order' | 'suggestion' } | null;
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
  /** 按关键词自动想起来的经历、教训、技能 */
  recalled?: Recalled[];
  /** 想起来、拿得准的技能：直接翻开的全文 */
  openedSkill?: { name: string; body: string };
  /** 刚才卡住、随后在同一带做成：值得写成技能 */
  learnFrom?: { stuck: { what: string; why: string; skill?: string; code?: string }; solved: { what: string; routine: string[] } };
  /** 这一趟下地：下来多久、背包多了什么、是不是手上的活快收工了（给“下矿的账”） */
  trip?: { minutes: number; gained: Record<string, number>; nearEnd: boolean };
  /** 打猎的账（给“肉快打光了”这种事实） */
  hunting?: HuntTally | null;
  /** 主目标和清单 */
  plan?: FocusPlan | null;
  /** 阶段回顾：情绪或回想提醒它停下来看这一阶段在做什么（有这一项时才允许换主目标） */
  stageReview?: Record<string, unknown>;
  /** 自己写的可执行技能一览（带成败） */
  learnedSkills?: string[];
  /** 本能现状：哪些身体会自己做（躲苦力怕、还手这些现在可能没开） */
  instincts?: string;
}

/**
 * 提示词的组织（针对注意力容易被“手边的格式”和“最后看到的内容”带走的模型，如 DeepSeek）：
 * - 系统提示词短而稳定：身份 → 原则 → 先查再做（技能书、建筑师）→ 决定 → 输出 → 例子 → 动作；固定内容在前，便于缓存。
 * - 规则贴在用的地方：动作说明自己写清“新房子用图纸”，常用动作给完整参数，冷门动作只列名字（需要时 moves 查）。
 * - 用户消息末尾按情境追加 2–4 条“此刻要留意”的提醒，只说和眼下有关的。
 */

/** 常用动作：给完整参数；其余只列名字和一句用途，需要时用 {"kind":"moves"} 查完整参数 */
export const COMMON_MOVES = ['dig_at', 'step', 'place_at', 'defend', 'gather', 'goto', 'explore', 'look_around', 'craft', 'smelt', 'collect_furnace', 'eat', 'hunt', 'forage', 'fish', 'farm', 'collect_seeds',
  'pickup_items', 'store_items', 'take_items', 'place_torch', 'shelter', 'sleep', 'wait', 'dig', 'climb_up', 'build', 'travel', 'inspect_block', 'interact_block', 'use_item', 'use_skill'];

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
  return `${common.join('\n')}${rare.length ? `\n其他动作（用 {"kind":"moves","names":["…"]} 查完整参数）：${rare.join('、')}` : ''}${only ? '' : '\n缺工具、熔炉、船、火把时动作会顺手做（结果里写用掉了什么）；不想让它做就加 "make":false，缺了会停下说缺什么'}`;
}

/** 完整参数（moves 查询用） */
export function moveDetails(names: string[]): string {
  return names.slice(0, 6).map((n) => {
    const s = SKILLS[n];
    return s && !LLM_HIDDEN.has(n) ? `- ${s.name} ${s.argsDoc}：${s.description.replace(/\s+/g, ' ')}` : `- ${n}：没有这个动作`;
  }).join('\n');
}

const CONDITIONS = `done_when 的写法（可选，写错会被忽略）：
{"type":"inventory_min","item":"oak_log","count":20}｜{"type":"location_near","dimension":"overworld","pos":{"x":0,"y":64,"z":0},"radius":4}（坐标要来自观察或地标）｜{"type":"self_state","field":"inWater|inLava|onGround","equals":false}｜{"type":"self_state","field":"held|riding","equals":"物品名或 null"}｜{"type":"sky_visible","equals":true}｜{"type":"underground","equals":false}｜{"type":"equipment","slot":"hand","item":"stone_pickaxe"}｜{"type":"inventory_full","free_slots":2}（背包只剩 2 格空）｜{"type":"all_of","conditions":[…]}｜{"type":"any_of","conditions":[…]}（哪个先到就收工：“铁够 24 个，或背包装满”）
写开工时还不成立、做完才成立的事（往下躲进地里 → {"type":"underground","equals":true}）；开工前就成立的条件会被当成没写。`;

const OUTPUT = `只输出一个 JSON 对象：
{"monologue":"第一人称内心独白，接着刚才的念头往下想（20–80 字）",
 "decision":"continue|adjust|new|detour|switch|experiment|rest",
 "activity":{"what":"具体要干什么","why":"为什么现在做","kind":"gather|craft|build|explore|survive|rest|experiment|tidy|social|other","steps":[{"skill":"动作名","args":{}}],"repeat":1,"done_when":{…},"expect":"预计会怎样","if_stuck":"卡住打算怎么办"},
 "next":{同 activity，手上的活快干完时写上，干完直接接上}}
continue 时可以不写 activity；要换成别的做法就用 adjust/new，别写 continue。顺手、碰运气的步骤加 "optional":true（没成也不算失败）。
operator（有【操作者的指令】时必写 {"status":"doing|done|cannot","note":"…"}；有【操作者的建议】时写 {"status":"adopted|declined","note":"…"}）｜plan（主目标清单：定下 {"focus":"a_…或一句话","steps":["…"]}，做完一项 {"done":[0]}）｜skill（见【技能】）｜worth_learning（刚才的事值得练成技能时写：哪里出了问题、想学会什么）
其他可选字段：say（有新发现、改主意、做成事或遇险时说的一句口语）｜agenda（{"add":[{"text":"想做的事或想弄清的问题","kind":"goal|idea|question","horizon":"today|someday"}],"done":["a_…"],"drop":["a_…"],"focus":"a_…"}，规则不要放这里）｜learned（结果出乎意料时的一句窍门，或 {"revise":"k_…","text":"…"} 修订旧窍门）｜hypothesis（experiment 必填）｜experiment_result（上一段是实验时：supported|refuted|unclear）｜diary（值得记住的一句话）｜liked（刚发现喜欢的东西）｜habits（身体的顺手习惯，一直有效：{"torch_every":8} 暗处每 8 格插火把，{"eat_below":12} 饿到 12 顺手吃，{"pickup":true} 捡掉落物；0 关掉）`;

const DECISIONS = `continue 照常做｜adjust 还是这件事、改一改 routine｜new 开始新的一段｜detour 先插一段别的，做完自动回来｜switch 放下手上的改做别的｜experiment 验证一个猜想的小活｜rest 歇一下`;

/** 操作者：直播的主人，从控制台下指令的人。指令不是“建议”，优先于自己的打算 */
const OPERATOR = `【操作者】控制台里的操作者（直播的主人）说话分两种。【操作者的指令】：优先于自己的主目标、手上的活和弹幕，这一念就照做（可以直接 switch），做法自己想，不讨价还价；只有会马上送命才先保命再回来；写 operator doing / done / cannot。做完或做不到就说，别一直挂着。【操作者的建议】：只是提个想法，认真掂量一下，合适就采纳（adopted），不合适就说一句为什么（declined），然后照自己的节奏玩，不用一直惦记。`;

/** 专注：主目标 + 清单，插曲用 detour */
const FOCUS = `【专注】主目标是这一阶段要拿到的成果（有床有箱的家、整套铁甲、去下界），不是做法，也不是过夜、脱困这类眼前事（detour）。清单 3–6 项可验证的子任务，可写 {"text":"…","done_when":{…}} 自动勾；依次推进；久没推进就改清单，有【阶段回顾】时可换目标（写 switch_reason）。`;

/** 技能：从经历里总结、写下就生效的做法（详细写法在 writing-skills 技能里，按需查） */
const SKILLS_DOC = () => `【技能】管用的做法写进 skill，存下就生效：{"name":"英文-连字符","description":"…","when":{条件},"steps":[…]或"code":"JS"}。when 含 after_failure＝动作失败时先试；只有状态条件＝成立自动做；不写＝use_skill 调用。写不出就用 worth_learning；写法先查 {"kind":"skill","name":"writing-skills"}。身体只会躲岩浆和溺水，别的反应（躲怪、逃跑、脱困）都靠你总结成技能。`;

const QUERIES = (skills: string[]) => `【先查再做】需要时先输出一个查询 JSON（不占游戏时间，每次思考最多 3 次），拿到结果再决定：
- {"kind":"skill","name":"技能名"} 翻开技能书看做法｜{"kind":"design","brief":"用途、多大、风格","where":"here|base|x,y,z"} 请建筑师画图纸：房子、前哨、仓库、畜栏、塔等要长期用的建筑（where：脚下、家旁或坐标）
- {"kind":"recipes","item":"物品名","count":1} 看配方和缺口（"uses":"物品" 反查用途）｜{"kind":"moves","names":["动作名"]} 看动作参数
- {"kind":"recall","query":"关键词"} 回想以前的经历、日记、教训和技能｜{"kind":"mechanics","query":"…"} 查底层操作接口
- {"kind":"knowledge","query":"想了解的问题"} 搜索游戏资料和相关段落；{"kind":"knowledge","id":"文档id","section":"章节id"} 读文档（section 可省略）；{"kind":"knowledge"} 浏览目录。knowledge 是带出处和版本的文献参考，moves 查实际动作接口，recipes 查配方与缺口，recall 查自己的经历。读到的做法由你判断是否采用，不代表现场事实或已经学会的技能。`;
/** 技能书目录放在系统提示词最后：它变得最勤（写、改、收起），放在前面会让后面不变的大段内容每次都缓存不中 */
const SKILL_INDEX = (skills: string[]) => skills.length ? `\n\n【技能书】\n${skills.map((x) => `- ${x}`).join('\n')}` : '';

/** 用户消息分块：越往后越要紧（模型对末尾注意力最强） */
const READING = `【方位】北 N=z减 南 S=z加 东 E=x加 西 W=x减。往某方向走直接写 goto {"target":"E 20"}，别自己算坐标；[前,上,右] 跟着朝向转，不是东南西北。
【消息怎么读】越往后越要紧：【我】性格心情、议程、窍门 →【记得的地方】→【想起来的】自动想起的旧事和技能 →【最近】→【手上的活】→【身边】方块图 local、生物、资源 →【身体】where、生命饥饿、时间、背包 →【专注】主目标和清单 →【此刻】为什么现在想、注意到什么 →【此刻要留意】。`;

const ROUTINE_OF_THINKING = `【每次这样想】
1. 【此刻】要紧的（危险、快饿死、卡住）先处理。
2. 看【专注】：在推进清单就 continue。
3. 看【身体】where：地表走路，坑里或地下才挖；身边一格的事对照 local 写坐标。
4. 拿不准就先查（knowledge / skill / moves / recipes / recall）；输出前核对动作名和参数。`;

const CHOOSE = `【选动作】
- 去记得的地方或坐标 → goto；找没见过的东西 → explore {"until":…}；拿看得见的方块 → gather；身边某一格 → dig_at / step / place_at
- 过水的准备、载具交互和上下船由你选择元语组合；ride 提供船宽避障的水面导航，停船后保持乘坐；travel 提供步行和游泳寻路，已乘船时沿水路导航；吃 → eat（背包有吃的）/ hunt / forage / fish；做东西 → craft、smelt（会自己放下背包里的工作台/熔炉；拿不准查 recipes）
- 有怪靠近 → defend {"target":"名字"} 打掉，或走开绕路（苦力怕也是你定：打就砍一下退一步）
- 过夜 → sleep（有床，看参数选哪张）/ shelter / 自己挖坑封顶；在坑里或地下想上去 → 看【身边】local 和背包，用 dig_at / step / place_at 自己想办法（怎么上去由你定，背包里有什么用什么）
- 盖新房子 → design 拿图纸 → 攒材料 → build {"draft":"图纸ID"}（料不全也能先盖，有多少盖多少）；没盖完的 → build {"projectId":"作品ID"}；不要自己画图纸
- goto 没路、挡着的是土坡石坎 → goto {"target":…,"dig":true} 挖穿直走`;

const PRINCIPLES = `【原则】
- 接着刚才的念头往下想，不反复换主意、不重复刚做完的事。
- 一段活是几分钟的一件事（“砍够 20 个原木”）：routine 1–6 步，可 repeat，done_when 写清何时收工；身体连续执行、自己应变，真卡住才叫你。
- 从真实结果里学：出乎意料才写 learned；连续失败就换办法；有 stuck_here 必须换完全不同的思路，别碰 repeated_failures。
- 你会被风景吸引、想把家弄得舒服好看：喜欢的写 liked，想做的放 agenda。情绪是信号：累了歇、烦了换办法、腻了找新鲜事。
- 只知道亲眼看到或记得的东西，坐标来自观察或地标，不编。
- 身体只有保命本能和你写下的技能；插火把、顺手吃、捡东西要你自己做，或用 habits 定成习惯。`;

const PRECISE = `【精确操作】【身边】local 是以脚为原点的方块图（[前,上,右]，前=facing），local.spots 已算好能站（stand）、能放（place）的格子。dig_at / step / place_at 都写确切的相对坐标，routine 重复时每步按当时站的位置重算，例如：
- 写法示例（只是语法，不是该怎么走）：steps [dig_at {"at":[1,0,0]}, dig_at {"at":[1,1,0]}, step {"to":[1,0,0]}]，repeat 8，facing 都写同一个方向（如 "N"），done_when 写看得到的结果（如 {"type":"sky_visible","equals":true}）
- [0,0,0] 是自己脚下那格、[0,1,0] 是自己头那格：place_at [0,0,0] 放实心方块会跳起来垫在脚下；梯子、火把这种贴墙的东西可以放进自己站的格子（要贴着实心墙）。挖空脚下 [0,-1,0] 人会自己掉下去，不用 step
repeat 每轮重做整套 steps：火把别写进重复的 steps，用 habits.torch_every。挖前看清那格（沙砾会掉，别挖开水和岩浆）。`;

const EXAMPLE = `【例子】想有个家时：
→ {"kind":"design","brief":"湖边能住的小屋，云杉木，放得下床、箱子和工作台"}
← 已经请建筑师去画了……画好会告诉你
→ {"monologue":"图纸要等一会儿，先去砍云杉攒木板。小屋大概要 12 根，砍 20 根，省得工具、门、箱子再跑一趟；碰到羊顺手打。","decision":"new","activity":{"what":"砍 20 根云杉原木","why":"盖小屋缺木板，多备几根做工具和箱子","kind":"gather","steps":[{"skill":"gather","args":{"block":"spruce_log","count":20}},{"skill":"hunt","args":{"animal":"sheep"},"optional":true}],"done_when":{"type":"inventory_min","item":"spruce_log","count":20}}}
下矿时同理：来一趟不容易，顺手的矿加 "optional":true 的 gather，done_when 用 any_of 写“够用 + 余量，或背包装满”。`;

export function deliberateSystem(persona: string, skills: string[] = [], advanced = false): string {
  return `${persona}

你就是这个 Minecraft 角色本人，像真人玩家一样连续地玩，同时在直播。

${OPERATOR}

${READING}

${ROUTINE_OF_THINKING}

${PRINCIPLES}

${CHOOSE}

${FOCUS}

${QUERIES(skills)}

${SKILLS_DOC()}

【决定】${DECISIONS}

【输出】${OUTPUT}
${CONDITIONS}

${PRECISE}

${EXAMPLE}
${liveAudience.enabled ? `\n${AUDIENCE_RULES}\n` : ''}
【动作】参数必须合法：
${movesCatalog(28, undefined, advanced)}${SKILL_INDEX(skills)}`;
}

export function glanceSystem(persona: string, inUse: Set<string>, skills: string[] = []): string {
  return `${persona}

你在连续地玩 Minecraft，这次只是抬头看一眼。
${OPERATOR}
${READING}
- 先看【此刻】：没什么要紧的、手上的活还顺，就 continue（独白可以很短）。
- 手上没活：直接 new 一段，接着【最近】的结果和议程往下玩；活快干完时顺便写 next。小改用 adjust，插一件事用 detour，彻底换事用 switch/new。
- 在地表就走路，在坑里或地下（看【身体】where）才挖；身边一格的事对照【身边】local 用 dig_at / step / place_at 写确切坐标。
- 要翻技能书、请建筑师（design）、查配方、查游戏资料或想得更深：直接输出查询，如 {"kind":"knowledge","query":"想了解的问题"}、{"kind":"design","brief":"…"}、{"kind":"skill","name":"…"}、{"kind":"deliberate","reason":"…"}（转成认真想、给你完整信息）。knowledge 是文献参考，moves 查动作接口，recipes 查配方，recall 查自己的经历；资料不代表现场事实或已经学会的技能。
${skills.length ? `技能书：${skills.map((x) => x.split('：')[0]).join('、')}（带步骤的可以 use_skill 调用）。` : ''}盖新房子先 design 拿图纸，再 build {"draft":"图纸ID"}；不要自己画图纸。
- 有【专注】的主目标就接着推进清单；天黑、饿了、缺料用 detour 插一段，做完会回来；瞥一眼不能 switch。做完清单一项写 "plan":{"done":[序号]}。
- 刚从卡住里找到办法、想把它变成身体的习惯：转成认真想（{"kind":"deliberate","reason":"写技能"}）。

${CHOOSE}

【决定】${DECISIONS}

【输出】${OUTPUT}
${CONDITIONS}

【常用动作】
${movesCatalog(0, new Set([...inUse, 'dig_at', 'step', 'place_at', 'defend', 'gather', 'goto', 'explore', 'craft', 'eat', 'hunt', 'forage', 'look_around', 'pickup_items', 'wait', 'place_torch', 'sleep', 'shelter', 'build', 'smelt', 'store_items', 'climb_up', 'use_skill']))}`;
}

/** 打算里说要下矿、往下挖 */
/** 身体快把手上的活做完时那一念的 reason（mind.ts 用同一个字符串） */
export const NEAR_END_REASON = '手上这段活快干完了，想想接下来';

const MINING_INTENT = /下矿|矿道|矿洞|找铁|挖铁|找矿|挖矿|粗铁|铁矿|往下挖|下挖|下到 ?y|挖(阶梯|台阶)[^上]{0,6}(下|降)|石层|深层/;

/** 打算里说要从地下回地面 */
const SURFACE_INTENT = /回地面|回到地面|见天|爬出|挖出去|出矿|上到地面|挖(阶梯|台阶).{0,8}上|往上挖/;

/**
 * 走旧矿道和就地新挖各要花多少，用数字摆出来让它自己比（不替它选）。
 * 挖台阶：每往下/往上一格要挖掉约 3 格方块（石头带镐约 1 秒一格）；走路约 4 格/秒，矿道里绕一点算 1.5 倍
 */
function digVsWalk(dy: number, walk: number): string {
  const blocks = Math.max(0, Math.round(Math.abs(dy) * 3));
  const digMin = blocks / 60, walkSec = Math.round((walk * 1.5) / 4);
  return `走过去约 ${walkSec < 90 ? `${walkSec} 秒` : `${Math.round(walkSec / 60)} 分钟`}；从这里挖台阶${dy > 0 ? '下' : '上'}去要挖约 ${blocks} 格（约 ${digMin < 1 ? '不到 1' : Math.round(digMin)} 分钟，还费镐）`;
}

/** 按情境追加在用户消息末尾的提醒：只说和眼下有关的 2–4 件事 */
export function situationalReminders(ctx: MindContext): string[] {
  const out: string[] = [];
  const p = ctx.percept, s = ctx.state;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  const drafts = activeDrafts()?.list(4).filter((d) => !d.usedBy) ?? [];
  const unfinished = myBuilds(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }).filter((b) => b.status !== 'complete' && b.dist <= 96);
  const intent = [ctx.activity?.what, ctx.activity?.why, ...ctx.self.agenda().map((a) => a.text), ...ctx.self.recentThoughts(3).map((t) => t.text)].filter(Boolean).join(' ');
  if (ctx.learnFrom) {
    const f = ctx.learnFrom;
    out.push(`刚才「${f.stuck.what}」卡住了（${f.stuck.why.slice(0, 50)}${f.stuck.skill ? `，失败的是 ${f.stuck.skill}${f.stuck.code ? ` ${f.stuck.code}` : ''}` : ''}），随后「${f.solved.what}」做成了（${f.solved.routine.slice(0, 4).join('；')}）：以后还会碰到的话，写 worth_learning 说清怎么回事，后台会把它练成技能`);
  }
  if (ctx.stuckHere) out.push(`你在这一带已经卡了 ${ctx.stuckHere.minutes} 分钟：换一个和 tried 完全不同的办法（换区域、换目标、就地安家都行）`);
  const focusItem = ctx.self.activeAgenda();
  if (focusItem && !ctx.plan && ctx.tier === 'deliberate') out.push(`主目标「${focusItem.text}」还没有清单：写 "plan":{"focus":"${focusItem.id}","steps":[…3–6 项]}，之后一项项推进`);
  const exits = Object.values(p.self.exits ?? {});
  const where = p.self.where?.kind;
  const trapped = where ? where === 'underground' || where === 'pit' : p.self.sky_visible !== true && (p.self.overhead?.covered === 'rock' || p.light?.underground === true) || exits.length > 0 && exits.every((e) => !e.walk && !e.step_up);
  // 想下矿、想往下挖：自己挖过的通道就是现成的路（10-26 晚它开了 67 次新阶梯，只有被提醒才走回旧矿道）
  // 想下到哪一层（打算里写了 y 就按它，没写按通道最深处）
  const wantY = (() => { const m = intent.match(/y ?(-?\d{1,3})/); return m ? Number(m[1]) : null; })();
  if (MINING_INTENT.test(intent)) {
    // 矿在哪一层是版本事实：模型记得的多是老版本（钻石 y12），摆出这个世界的版本对应的分布，下到哪层它自己定
    const layers = oreLayerFacts(config.mc.version, intent);
    if (layers) out.push(layers);
    const tunnels = myFacilities(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }, ['passage']).filter((f) => f.dist <= 160).slice(0, 2);
    for (const t of tunnels) {
      const deep = Number(t.text.match(/能走到 y(-?\d+)/)?.[1] ?? here.y);
      const dy = here.y - (wantY !== null && wantY >= deep ? wantY : deep);
      out.push(t.inside
        ? `你现在就在自己${t.text.replace(/^挖过的通道：/, '挖过的通道里：')}；顺着走比重新挖省事：goto 通道里的坐标或设施会自己沿记下的路线一段段走，不用一格格挖`
        : `你${t.text}：${dy > 4 ? `${digVsWalk(dy, t.dist)}。` : ''}goto 入口会顺着记下的路线走下去；要去的地方离这条通道远，再就地新挖`);
    }
  }
  // 下矿的账：在地下、手上的活快收工或想回地面时，把这一趟的成本和身边还剩的矿摆出来（真人多挖几组是因为知道“再来一趟更贵”）；多挖不多挖它自己定
  const trip = ctx.trip;
  if (trip && trip.minutes >= 1.5 && (trip.nearEnd || !ctx.activity || SURFACE_INTENT.test(intent)) && (p.self.where?.kind === 'underground' || p.self.sky_visible === false)) {
    const got = Object.entries(trip.gained).filter(([k]) => /raw_|_ore$|coal|diamond|emerald|lapis|redstone|amethyst|obsidian|debris|flint|gold_nugget|quartz/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}×${n}`);
    const seen = p.nearby.resources.filter((r) => r.seen === 'now' && isResourceBlock(r.block)).sort((a, b) => a.nearest - b.nearest).slice(0, 4).map((r) => `${r.block}×${r.count}（最近 ${Math.round(r.nearest)} 格）`);
    const remembered = oreSpotsNear(ctx.memory.landmarks(), { worldId: s.worldId, dim: p.self.dim, pos: here }, { radius: 48 }).length;
    const picks = s.inventory.filter((i) => i.name.endsWith('_pickaxe') && i.durability).map((i) => `${i.name} 剩 ${Math.round(((i.durabilities?.[0] ?? i.durability!.left) / i.durability!.max) * 100)}%`);
    const depth = p.self.depth_below_surface ?? 0;
    const back = (() => {
      const t = myFacilities(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }, ['passage']).find((f) => f.inside);
      if (t) { const walkSec = Math.round((Math.hypot(t.pos.x - here.x, t.pos.y - here.y, t.pos.z - here.z) * 1.5) / 4); return `沿通道走回入口约 ${walkSec < 90 ? `${walkSec} 秒` : `${Math.round(walkSec / 60)} 分钟`}`; }
      return depth >= 6 ? `挖台阶回地面约 ${Math.round(depth * 3)} 格（约 ${Math.max(1, Math.round(depth * 3 / 60))} 分钟）` : '';
    })();
    out.push(`下矿的账：这趟下来 ${Math.round(trip.minutes)} 分钟${got.length ? `，挖到 ${got.join(' ')}` : '，还没挖到矿'}；背包空 ${p.emptySlots} 格${picks.length ? `；${picks.join('、')}` : ''}；身边${seen.length ? `看得见 ${seen.join('、')}` : '没看见矿'}${remembered ? `，48 格内记得 ${remembered} 处矿点` : ''}${back ? `；${back}，再下来一趟也差不多这个价` : ''}。清单后面几项还要不要这些料，一起掂量再决定收不收工`);
  }
  // 养动物、村民交易：打算里提到了才把机制摆出来（模型对这些的记忆常是含糊或老版本的）
  const husbandry = husbandryFacts(intent);
  if (husbandry) out.push(husbandry);
  const villagers = villagerFacts(intent);
  if (villagers) out.push(villagers);
  // 肉的账：刚打完猎或正打着，把这一带还剩几只、为了肉走了多远摆出来（真人会在这时想“该养了”；养不养它自己定）
  const hunting = ctx.hunting;
  const hunted = !!ctx.lastRecord && /\bhunt\b/.test(ctx.lastRecord.signature ?? '') && Date.now() - ctx.lastRecord.at < 3 * 60_000
    || !!ctx.activity && (ctx.activity.steps ?? []).some((st) => st.skill === 'hunt') && ctx.reason === NEAR_END_REASON;
  if (hunting && hunting.trips >= 2 && hunted && !husbandry) {
    // passive 写法是 "cow x3" 或 "sheep(白)"：数能吃的那几种
    const seenNow = p.nearby.passive.reduce((n, t) => { const m = t.match(/^([a-z_]+)(?:\([^)]*\))?(?: x(\d+))?$/); return m && FOOD_ANIMAL_NAMES.includes(m[1]) ? n + (Number(m[2]) || 1) : n; }, 0);
    const herds = creatureSpotsNear(ctx.memory.landmarks(), { worldId: s.worldId, dim: p.self.dim, pos: here }, { radius: 128, only: FOOD_ANIMAL_NAMES });
    const remembered = herds.reduce((n, h) => n + (Number(h.text.match(/(\d+) 只/)?.[1]) || 1), 0);
    const feed = s.inventory.filter((i) => /^(wheat|wheat_seeds|carrot|potato|beetroot|beetroot_seeds|melon_seeds|pumpkin_seeds)$/.test(i.name)).map((i) => `${i.name}×${i.count}`).slice(0, 4);
    out.push(`肉的账：这局已经打猎 ${hunting.trips} 次、大约 ${hunting.animals} 只，最近几次每次为了肉走 ${hunting.recentWalked ?? '?'} 格；现在看得见能吃的动物 ${seenNow} 只，128 格内记得的还有约 ${remembered} 只${feed.length ? `；背包里有 ${feed.join(' ')}` : ''}。动物不会再生，打一只少一只——是接着找，还是圈几只养起来，自己掂量`);
  }
  // 人在自己挖过的通道里、想回地面：原路就是现成的出口
  if (SURFACE_INTENT.test(intent) && p.self.sky_visible !== true) {
    const t = myFacilities(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }, ['passage']).find((f) => f.inside);
    if (t) out.push(`你在自己挖过的通道里，入口 (${Math.round(t.pos.x)},${Math.round(t.pos.y)},${Math.round(t.pos.z)}) 就是出口：goto 入口会沿原路一段段走上去；${digVsWalk(here.y - t.pos.y, Math.hypot(t.pos.x - here.x, t.pos.y - here.y, t.pos.z - here.z))}`);
  }
  if (where === 'indoors' && /坑|垫高|台阶|爬出|挖出去|出坑/.test(intent)) out.push(`你${p.self.where!.text}。刚才想的“坑”其实是屋子的墙`);
  if (trapped && where === 'pit') out.push(`你${p.self.where!.text}：看【身边】local 和背包，怎么上去自己定`);
  else if (trapped) out.push('你在地下或被围住了：看【身边】local，用 dig_at / step / place_at 一格一格自己出去，怎么出去自己定');
  else if (where === 'surface' && p.self.sky_visible !== true) out.push(`你${p.self.where!.text}，不是在地下：直接走路，不用挖`);
  // 没盖完的房子：久没碰了才提一句；一直在补却补不动，就把事实摆出来让它掂量够不够住（不再每一念都催“接着盖”）
  const site = unfinished[0];
  if (site) {
    const idleMin = (Date.now() - site.lastWorkedAt) / 60_000;
    if (site.attempts >= 5 && site.recentProgress !== null && site.recentProgress <= 2)
      out.push(`「${site.name}」已经验收过 ${site.attempts} 次，最近几次只少了 ${Math.max(0, site.recentProgress)} 处，还差 ${site.missing} 处：想想是不是已经够住了（够了就 build {"projectId":"${site.id}","mode":"accept"} 收工去做别的；不想要了就 abandon）`);
    else if (idleMin >= 20) out.push(`「${site.name}」还没盖完（还差 ${site.missing} 处）：想接着盖写 build {"projectId":"${site.id}"}；够住了就 accept，不想要了就 abandon`);
  }
  if (ctx.designing) out.push(`建筑师正在画「${ctx.designing.brief.slice(0, 40)}」（${ctx.designing.minutes} 分钟了），画好会告诉你：先攒常用的木头、石头，或做别的事`);
  else if (drafts.length) out.push(`图纸 ${drafts[0].id}「${drafts[0].name}」已经画好：按材料清单攒齐后 build {"draft":"${drafts[0].id}"}`);
  else if (!unfinished.length && /盖|建|房|屋|家|住处|庇护|前哨|据点|补给点|仓库|畜栏|围栏|瞭望|塔|围墙|平台/.test(intent))
    out.push('想盖要长期用的建筑（房子、前哨、仓库、畜栏、塔……）：现在就输出 {"kind":"design","brief":"…","where":"here|base"} 请建筑师——画图要几分钟，一边画一边去攒料，图到了按清单补齐就能盖；不要自己画图纸。施工只认露天干地：地下的落脚点自己挖、应急的几块自己搭');
  const bed = nearestBed(ctx);
  const bedInBag = s.inventory.some((i) => i.name.endsWith('_bed'));
  const bedLine = bed ? `记得的床在 ${bed.dist} 格外（${bed.dir}，${bed.pos}）` : '';
  if (p.time.phase === 'dusk' || p.time.phase === 'night') {
    const [bx, by, bz] = bed ? bed.pos.split(',') : [];
    const options = [bed ? `${bedLine}${bed.dist > 128 ? '，挺远' : ''}，去那儿睡写 sleep {"at":{"x":${bx},"y":${by},"z":${bz}}}` : '', bedInBag ? '背包里有床，就地放下睡写 sleep {"place":true}' : ''].filter(Boolean).join('；');
    const tod = ((p.time.timeOfDay % 24000) + 24000) % 24000;
    const head = tod < DARK_TICK ? `太阳在落山，${durationText(ticksUntil(tod, DARK_TICK))}后天黑刷怪` : `天黑了，离天亮还有${durationText(ticksUntil(tod, 23000))}`;
    out.push(`${head}：想好今晚在哪过、这段时间做什么${options ? `（${options}）` : '（家、床，或者就地躲一晚）'}`);
  } else {
    // 像人一样掂量回程：离天黑不远、床又在远处，就该动身或另作打算
    const tod = ((p.time.timeOfDay % 24000) + 24000) % 24000;
    // 太阳还高就想着躲起来过夜：把尺度摆出来（挖窝十几秒、天黑还早），让它接着干活
    const toDarkTicks = ticksUntil(tod, DARK_TICK);
    if (tod < 11000 && toDarkTicks > 2000 && /过夜|躲|窝|封顶|天黑|等天/.test(intent))
      out.push(`现在${timeSense(tod).split('；')[0]}，离天黑还有${durationText(toDarkTicks)}（游戏 1 小时≈现实 50 秒）：挖个能封顶的窝只要十几秒，下午 5 点以后再准备过夜就来得及，现在手上的活接着做，别提前躲起来干等`);
    // 都换成游戏时间比：走回去要的时间（约 4 格/秒）加一个游戏小时的余量，够不着天黑前到床就提醒
    const toDark = ticksUntil(tod, DARK_TICK);
    const walk = realSecondsToTicks(bed ? bed.dist / 4 : 0);
    if (bed && !bedInBag && bed.dist > 32 && toDark <= walk + 1000)
      out.push(`离天黑（晚上 7 点）还有${durationText(toDark)}；${bedLine}，走回去要${durationText(walk)}：要回去睡就该动身了，否则就近想办法过夜`);
  }
  if (p.self.food <= 8) out.push(`饿了（饥饿 ${p.self.food}）：留意吃的`);
  // 家已经有了、手上又没什么大目标：像玩家一样给自己找下一个更长的目标，而不是只做零碎的小事
  const done = myBuilds(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }).some((b) => b.status === 'complete');
  const planOpen = !!ctx.plan && ctx.plan.steps.some((st) => !st.done);
  if (done && (!ctx.activity || !planOpen) && ctx.self.agenda().filter((x) => x.kind === 'goal' && x.status !== 'done' && x.status !== 'dropped').length < 2)
    out.push('家已经盖好了：给自己定个更大的目标放进 agenda（比如下矿弄铁和铁工具、开一块农田养几只动物、扩建仓库、去远处探险）');
  return out.slice(0, 5);
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

/** 【专注】：主目标、清单、手上的活是不是在推进它（放在消息靠后，模型最看得见的地方） */
function focusBlock(ctx: MindContext): Record<string, unknown> | null {
  const item = ctx.self.activeAgenda();
  const plan = ctx.plan;
  if (!item && !plan) return null;
  const goal = plan?.goal ?? item!.text;
  const next = plan?.steps.findIndex((st) => !st.done) ?? -1;
  return {
    goal, agenda_id: plan?.agendaId ?? item!.id,
    ...(plan ? { for_min: Math.round((Date.now() - plan.setAt) / 60000), checklist: plan.steps.map((st, i) => `${i}. [${st.done ? 'x' : ' '}] ${st.text}${st.done && st.auto ? '（条件达成，自动勾的）' : !st.done && st.doneWhen ? '（条件达成会自动勾）' : ''}`), ...(next >= 0 ? { next_item: next } : {}),
      // 进展的事实交给它自己判断：多久没勾掉一项、这期间做了几段活
      no_progress_min: Math.round((Date.now() - (plan.progressAt ?? plan.setAt)) / 60000),
      activities_since_progress: ctx.self.history(60).filter((r) => r.at > (plan.progressAt ?? plan.setAt)).length } : { checklist: '还没有：写 plan' }),
    ...(ctx.activity ? { current_activity_for_goal: ctx.activity.agendaId === (plan?.agendaId ?? item!.id) } : {}),
    ...(ctx.suspended.length ? { will_resume_after_detour: ctx.suspended.map((a) => a.what) } : {}),
  };
}

const WEAR_SLOT: Record<string, string> = { head: '头', torso: '胸', legs: '腿', feet: '脚', 'off-hand': '副手' };
/** 【身体】：自己在哪、状态、时间、亮度、背包 */
function bodyState(p: Percept, s: AgentState, activity: Activity | null, habits: object) {
  const inv = new Map<string, number>();
  for (const i of s.inventory) inv.set(i.name, (inv.get(i.name) ?? 0) + i.count);
  const step = activity?.steps[Math.max(0, activity.index - 1)];
  const digging = !!step && ['gather', 'dig', 'climb_up'].includes(step.skill);
  const material = String((step?.args as Record<string, unknown> | undefined)?.block ?? '');
  const tool = /stone|ore|coal|iron|copper|deepslate/.test(material) ? 'pickaxe' : /dirt|grass|sand|gravel|clay/.test(material) ? 'shovel' : /log|wood/.test(material) ? 'axe' : undefined;
  // 挖的时候身体会自动换上背包里最快的工具；要提醒的是“背包里根本没有合适的工具”
  const ownsTool = tool ? [...inv.keys()].some((n) => n.endsWith(`_${tool}`)) : true;
  return {
    ...(p.self.where ? { where: p.self.where.text } : p.self.overhead ? { overhead: p.self.overhead.block ? `头顶 ${p.self.overhead.up} 格是 ${p.self.overhead.block}` : '头顶一直空着' } : {}),
    pos: pos3(p.self.pos), dim: p.self.dim, biome: p.self.biome, sky_visible: p.self.sky_visible ?? null,
    // 血量保留一位小数：半颗心四舍五入成 0 会让模型以为自己已经死了
    hp: Math.round(p.self.hp * 10) / 10, food: p.self.food,
    ...(p.self.inWater ? { inWater: true, oxygen: s.oxygen } : {}), ...(p.self.inLava ? { inLava: true } : {}), ...(p.self.riding ? { riding: p.self.riding } : {}),
    time: (() => {
      return `${p.time.day !== undefined ? `第 ${p.time.day + 1} 天 ` : ''}${timeSense(p.time.timeOfDay, { canSleep: !!p.time.can_sleep })}（游戏时间）`;
    })(),
    ...(p.time.weather ? { weather: p.time.weather } : {}),
    ...(p.light ? { light: `${{ bright: '亮', dim: '有点暗', dark: '很暗' }[p.light.level] ?? p.light.level}${p.light.mob_spawn_risk ? '，会刷怪' : ''}` } : {}),
    held: p.self.held ? `${p.self.held}${s.heldDurability ? `（耐久 ${s.heldDurability.left}/${s.heldDurability.max}${s.heldDurability.left / s.heldDurability.max < 0.15 ? `，快坏了${spareNote(s.inventory.find((i) => i.name === p.self.held), s.heldDurability)}` : ''}）` : ''}` : p.self.held,
    // 身上穿戴的（盔甲、副手）：不在背包里，不写出来它就以为自己什么都没穿
    wearing: s.equipment?.length
      ? Object.fromEntries(s.equipment.map((e) => [WEAR_SLOT[e.slot] ?? e.slot, `${e.name}${e.durabilityRemaining !== undefined ? `（耐久剩 ${e.durabilityRemaining}）` : ''}`]))
      : '没穿盔甲，副手空着',
    ...(digging && tool && !ownsTool ? { tool_note: `正在挖 ${material}，背包里没有 ${tool}（身体只能空手挖，很慢）：做一把${tool === 'axe' ? '斧子' : tool === 'pickaxe' ? '镐' : '铲子'}会快很多` } : {}),
    // 工具、武器、护甲带上耐久（像物品栏里那条耐久条）；附魔的标出来
    inventory: [...inv].map(([name, count]) => {
      const it = s.inventory.find((i) => i.name === name);
      return `${name}×${count}${durabilityText(it)}${it?.enchanted ? '（附魔）' : ''}`;
    }), empty_slots: p.emptySlots,
    ...(s.effects?.length ? { effects: s.effects.map((e) => `${e.name}${e.level > 1 ? ` ${e.level} 级` : ''}，还剩 ${e.seconds} 秒`) } : {}),
    ...(s.xp ? { xp_level: s.xp.level } : {}),
    // 背包里的食物各值多少（生的顺带说烤熟后值多少）：只给事实，吃不吃、烤不烤由它自己定
    ...([...inv.keys()].some((n) => foodNote(n)) ? { food_values: Object.fromEntries([...inv.keys()].filter((n) => foodNote(n)).map((n) => [n, foodNote(n)])) } : {}),
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
  // 自己的设施（箱子、工作站、床、挖过的通道）在 my_facilities 里单独说，这里只列别的地点
  // 矿点按矿种单独列（ore_spots），不和死亡点、基地挤这 8 个位置
  const places = m.landmarks().filter((l) => l.dim === p.self.dim && l.worldId === s.worldId && !FACILITY_LABELS.has(l.label) && !(l.kind === 'resource' && isResourceBlock(l.label)) && l.kind !== 'herd')
    .map((l) => ({ l, d: Math.round(Math.hypot(l.pos.x - here.x, l.pos.z - here.z)) })).sort((a, b) => a.d - b.d).slice(0, 8)
    .map(({ l, d }) => `${l.label}[${l.id}] (${Math.round(l.pos.x)},${Math.round(l.pos.y)},${Math.round(l.pos.z)}) ${d}格`);
  const facilities = ctx.tier === 'deliberate' ? myFacilities(m, { worldId: s.worldId, dim: p.self.dim, pos: here }, ['chest', 'station', 'passage']).slice(0, 8).map((f) => f.text) : [];
  const danger = m.hazards(p.self.dim).map((h) => ({ h, d: Math.round(Math.hypot(h.pos.x - here.x, h.pos.z - here.z)) })).filter((e) => e.d < 96).slice(0, 4)
    .map(({ h, d }) => `${h.kind} @(${h.pos.x},${h.pos.y},${h.pos.z}) ${d}格，出过 ${h.count} 次事`);
  const bed = myBed(m, { dim: p.self.dim, worldId: s.worldId, pos: here });
  const portals = travelStore(m).snapshot(s.worldId).endpoints.slice(-4);
  const builds = myBuilds(m, { worldId: s.worldId, dim: p.self.dim, pos: here });
  const home = homeOf(m, { worldId: s.worldId, dim: p.self.dim, pos: here });
  const drafts = activeDrafts()?.list(4).filter((d) => !d.usedBy) ?? [];
  const remember = p.nearby.resources.filter((r) => r.seen === 'memory').slice(0, ctx.tier === 'glance' ? 3 : 6).map((r) => `${r.block} ${r.dir ?? ''}${r.nearest}格`);
  // 记得的矿点：每种矿最近的一两处（带高低差），瞥一眼也看得到——想挖铁时知道铁在哪
  const ores = oreSpotsByKind(oreSpotsNear(m.landmarks(), { worldId: s.worldId, dim: p.self.dim, pos: here }), ctx.tier === 'glance' ? 1 : 2, ctx.tier === 'glance' ? 5 : 8);
  // 记得的生物出没点（不主动攻击的：羊、牛、狼、村民……）：动物会走动，只是大概那一带，带着多久前看见
  const herds = creatureSpotsByKind(creatureSpotsNear(m.landmarks(), { worldId: s.worldId, dim: p.self.dim, pos: here }), 1, ctx.tier === 'glance' ? 5 : 10);
  return {
    home: home ? `${home.label} 在${home.dir}边 ${home.dist} 格 (${Math.round(home.pos.x)},${Math.round(home.pos.y)},${Math.round(home.pos.z)})` : '还没有家',
    ...(bed ? { my_bed: `(${bed.pos.x},${bed.pos.y},${bed.pos.z}) ${bed.dist}格` } : {}),
    ...(builds.length ? { my_builds: builds.map(describeBuild) } : {}),
    // 建筑师画好、还没盖的图纸：一直惦记着
    ...(drafts.length ? { my_drafts: drafts.map((d) => `${d.id}「${d.name}」${d.size.width}×${d.size.depth}，用料 ${Object.entries(d.materials).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n}×${c}`).join('、')}`) } : {}),
    ...(remember.length ? { resources_seen_before: remember } : {}),
    ...(Object.keys(ores).length ? { ore_spots: ores } : {}),
    ...(Object.keys(herds).length ? { animal_spots: herds } : {}),
    ...(ctx.tier === 'deliberate' ? { places, ...(facilities.length ? { my_facilities: facilities } : {}), ...(portals.length ? { portals } : {}), explored_around: exploredAround(m, p.self.dim, p.self.pos) } : {}),
    ...(danger.length ? { danger_zones: danger } : {}),
    // 自己开了头、要等它自己变化的事：离开时留下的样子和现在看得到的样子
    ...(p.waiting_on?.length ? { waiting_on: p.waiting_on } : {}),
  };
}

function recordLine(r: ActivityRecord) {
  const g = Object.entries(r.gained).slice(0, 6).map(([k, v]) => `${k}+${v}`).join(' ');
  const l = Object.entries(r.lost).slice(0, 4).map(([k, v]) => `${k}-${v}`).join(' ');
  return { what: r.what, outcome: r.outcome, took_s: r.durationSec, ...(g ? { gained: g } : {}), ...(l ? { used: l } : {}), summary: r.summary,
    ...(r.expect ? { i_expected: r.expect } : {}), ...(r.hypothesis ? { hypothesis: r.hypothesis } : {}) };
}

/**
 * 窍门、议程、回想、念头里写着的坐标，如果那里的东西已经亲眼看到没了（岩浆被填、矿被挖），就在坐标后面注一句。
 * 文字记忆不会自己更新，不注明它会一直照着一处早就不存在的东西去找
 */
export function noteGoneSpots(text: string, memory: Pick<WorldMemory, 'goneNear'> | undefined, dim: string): string {
  if (!memory?.goneNear) return text;
  return text.replace(/\(?(-?\d{1,7}),\s*(-?\d{1,3}),\s*(-?\d{1,7})\)?/g, (m, x, y, z) => {
    const gone = memory.goneNear(dim, { x: +x, y: +y, z: +z }, 3);
    if (!gone.length) return m;
    const g = gone[0];
    return `${m}〔亲眼看过：这里的 ${g.label} 已经没了，现在是 ${g.now}〕`;
  });
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
      // 学会的东西只列一张表：技能书里会动手的技能（use_skill 调用）+ 从经历里验证过的做法（直接写成一步）
      ...(!glance && (ctx.learnedSkills?.length || ctx.mySkills.length) ? { my_skills: [...(ctx.learnedSkills ?? []).slice(0, 12),
        ...ctx.mySkills.slice(0, 6).map((m) => `${m.name}［${m.status === 'verified' ? '验证过的做法' : m.status === 'macro' ? '组合' : '试验中的做法'}，直接写成一步 {"skill":"${m.name}"}］：${m.description.slice(0, 50)}`)] } : {}),
      ...(!glance && ctx.instincts ? { body_instincts: ctx.instincts } : {}),
      ...(!glance && ctx.researchContext ? { research: ctx.researchContext } : {}),
    }],
    ['记得的地方', worldKnowledge(ctx)],
    ...(ctx.recalled?.length || ctx.openedSkill ? [['想起来的', {
      ...(ctx.recalled?.length ? { memories: ctx.recalled.map((r) => `[${RECALL_LABEL[r.kind]}] ${r.text}`) } : {}),
      ...(ctx.openedSkill ? { skill_opened: { name: ctx.openedSkill.name, text: ctx.openedSkill.body } } : {}),
    }] as [string, Record<string, unknown>]] : []),
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
    ...(focusBlock(ctx) ? [['专注', focusBlock(ctx)!] as [string, Record<string, unknown>]] : []),
    ...(ctx.stageReview ? [['阶段回顾', ctx.stageReview] as [string, Record<string, unknown>]] : []),
    ['此刻', {
      why_thinking_now: ctx.reason,
      noticed: ctx.noticed.map((n) => `${n.what}${n.level === 'urgent' ? '（要紧）' : ''}`),
      since_last_thought: ctx.changes,
      ...(ctx.gameMessages?.length ? { game_messages: ctx.gameMessages } : {}),
      ...(ctx.userSuggestion && !ctx.operatorOrder ? { operator_suggestion: ctx.userSuggestion } : {}),
      ...(audienceBlock(ctx.audience, glance ? 'light' : 'full') ?? {}),
    }],
  ];
  const advanced = p.self.dim !== 'overworld' || s.inventory.some((i) => /ender_(eye|pearl)|obsidian|blaze/.test(i.name));
  const inUse = new Set((ctx.activity?.steps ?? []).map((s) => s.skill));
  const system = glance ? glanceSystem(ctx.persona, inUse, ctx.skills ?? []) : deliberateSystem(ctx.persona, ctx.skills ?? [], advanced);
  const reminders = situationalReminders(ctx);
  // 操作者的指令放在最前面，最后的提醒里再说一遍（开头和结尾模型最不容易忽略）
  const order = ctx.operatorOrder;
  if (order && order.kind === 'suggestion') {
    sections.unshift(['操作者的建议', { suggestion: order.text, received: `${order.ageSec} 秒前`, how: '掂量一下：合适就采纳（operator adopted），不合适说一句为什么（declined），之后照自己的节奏玩' }]);
    reminders.unshift(`操作者提了个建议「${order.text.slice(0, 80)}」：采纳还是不采纳，写 operator`);
  } else if (order) {
    sections.unshift(['操作者的指令', { order: order.text, received: `${order.ageSec} 秒前`, status: order.status === 'new' ? '刚收到，还没照做' : '照做中', must: '优先于你自己的打算；照做，并在 operator 里回应 doing / done / cannot' }]);
    reminders.unshift(`操作者的指令「${order.text.slice(0, 80)}」${order.status === 'new' ? '刚收到：这一念就照做（把它变成手上的活）' : '还没做完：手上的活要为它服务；做完了就写 done'}，并写 operator`);
  }
  const body = noteGoneSpots(sections.map(([name, data]) => `【${name}】${JSON.stringify(data)}`).join('\n'), ctx.memory, p.self.dim);
  return [{ role: 'system', content: system }, { role: 'user', content: `${body}${reminders.length ? `\n\n【此刻要留意】\n${reminders.map((r) => `- ${r}`).join('\n')}` : ''}\n\n现在你在想什么、打算怎么做？只输出一个 JSON 对象。` }];
}

/**
 * 休息/睡前回想：像人一样把这段时间的零碎经验整理成少数几条靠谱的窍门。
 * 只依据实际成败次数和最近的真实结果，不发明新的事实。
 */
export function buildReflectionMessages(self: SelfModel, persona: string, mySkills: string[] = [], strategy: string[] = []): ChatMessage[] {
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
- 再退一步看看日子是怎么过的（strategy：夜里在哪过、怎么死的、哪些目标耗了很多段活、盖房花了多少工夫、游戏进度到哪了）：
  找出最大的、一再出现的麻烦，问自己“有没有一种根本不同的玩法能让它不再发生”——不是把同一件事做得更用力，而是换个思路（出门时带上什么、把什么搬到哪、换个地方住、先去弄某样东西、干脆放下某件事）。
  换玩法多半是做法上的改变（出门带什么、什么时候收工、在哪冶炼、一次挖多少）：写成一条窍门 add，不进议程。
  只有它要专门花几段活去做成一件事（比如在矿口搭个前哨、开一片农田）时，才放进议程 agenda_add（{"text":"要做成的事","kind":"idea|goal"}，最多 3 条，写成“做成什么”，不要写成“以后要怎样”）；没想到就不写，不要硬凑。
- 用一句话写日记（diary）记下这段时间最值得记住的事，再用一句独白（monologue）说说现在的感受。
只输出一个 JSON 对象：
{"merge":[{"ids":["k_…","k_…"],"text":"…"}],"rewrite":[{"id":"k_…","text":"…"}],"drop":["k_…"],"add":["…"],"agenda_drop":["a_…"],"agenda_add":[{"text":"…","kind":"idea"}],"skill":{"name":"…","description":"…","body":"…"},"diary":"…","monologue":"…"}`;
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
    ...(strategy.length ? { strategy } : {}),
  };
  return [{ role: 'system', content: system }, { role: 'user', content: `${JSON.stringify(payload)}\n回想一下，整理好再告诉我。` }];
}

/**
 * 背包里同名工具的耐久：每件都说，同样耐久的合在一起数。
 * 以前只报最旧那件——11 把石镐里有 2 把快坏，它看到的是“stone_pickaxe×11（耐久 2/131，快坏了）”，
 * 以为全是废品，一遍遍去做新的、去“换把好的”。
 */
export function durabilityText(it: { count: number; durability?: { left: number; max: number }; durabilities?: number[] } | undefined): string {
  const d = it?.durability;
  if (!it || !d) return '';
  const all = it.durabilities?.length ? it.durabilities : [d.left];
  const worn = (left: number) => left / d.max < 0.15;
  if (all.length === 1) return `（耐久 ${all[0]}/${d.max}${worn(all[0]) ? '，快坏了' : ''}）`;
  const groups: [number, number][] = [];
  for (const left of all) { const g = groups.find(([v]) => v === left); if (g) g[1]++; else groups.push([left, 1]); }
  const shown = groups.length <= 4 ? groups : [groups[0], [-1, groups.slice(1, -1).reduce((n, [, c]) => n + c, 0)] as [number, number], groups.at(-1)!];
  const parts = shown.map(([v, c]) => v < 0 ? `其余 ${c} 件在中间` : `${v}/${d.max}${c > 1 ? `×${c}` : ''}`);
  const nWorn = all.filter(worn).length;
  const tail = nWorn === all.length ? '，全都快坏了' : nWorn ? `；快坏的 ${nWorn} 件用完会自动换下一件，还有 ${all.length - nWorn} 件好的` : '';
  return `（耐久 ${parts.join('、')}${tail}）`;
}

/** 手里那件快坏了：背包里还有好的同名的就说一句，不用再做新的 */
function spareNote(it: { durabilities?: number[] } | undefined, held: { left: number; max: number }): string {
  const spare = (it?.durabilities ?? []).filter((v) => v / held.max >= 0.15).length;
  return spare ? `；背包里还有 ${spare} 件好的，用坏了身体会自动换，也可以 hold_item 先换上，不用再做新的` : '';
}

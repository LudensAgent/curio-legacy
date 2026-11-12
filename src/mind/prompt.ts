import type { AgentState, Vec3Like } from '../adapter/types.ts';
import { effortFacts } from '../brain/efficiency.ts';
import { durabilityFacts, fuelFacts, oreOpportunityFact, supplyFacts } from '../brain/supply.ts';
import type { AudienceContext } from '../live/audience.ts';
import type { WorldMemory } from '../memory/store.ts';
import { dirName, durationText, realSecondsToTicks, sunText, type Percept } from '../perception/perception.ts';
import { isSoftBlock, isTreeSaplingItem, LIQUID_BLOCKS } from '../perception/surroundings.ts';
import { audienceBlock, AUDIENCE_RULES, exploredAround, liveAudience, UNEXPLORED_LABEL, type MySkillInfo } from '../planner/prompt.ts';
import type { ChatMessage } from '../planner/llm.ts';
import { isSkillDisabled } from '../skills/disabled.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { myBed } from '../skills/stations.ts';
import { gearAlreadyHeldInText } from '../skills/work.ts';
import { portalAgeText, travelStore } from '../travel/store.ts';
import { argsLabel, describeActivity } from './activity.ts';
import { describeBuild, dirOf, homeOf, myBuilds } from './home.ts';
import { FACILITY_LABELS, myFacilities } from './facilities.ts';
import { activeDrafts } from '../building/drafts.ts';
import { cleanLesson, moodWords, PLAN_REVISION_MIN, type KnowledgeFact, type PlanAttemptEvidence, type SelfModel } from './self.ts';
import type { Condition } from '../projects/types.ts';
import type { Activity, ActivityRecord, Noticing } from './types.ts';
import type { FocusPlan } from './self.ts';
import type { KnowledgeMatch } from '../knowledge/library.ts';

import { RECALL_LABEL, type Recalled } from './recall.ts';
import { describeCurrentTrip, describeLeg, LEG_NOTE, type Leg } from './excursions.ts';
import { foodNote } from '../skills/food.ts';
import { isResourceBlock, oreSpotsByKind, oreSpotsNear } from '../memory/ore-spots.ts';
import { oreLayerFacts } from '../knowledge/ore-layers.ts';
import { husbandryFacts, villagerFacts } from '../knowledge/husbandry.ts';
import { MATERIAL_FAMILIES, type HuntTally, type MaterialTally } from './ledger.ts';
import { FOOD_ANIMAL_NAMES } from '../skills/movement.ts';
import { PLACEABLE } from '../skills/survival.ts';
import { config } from '../config.ts';
import { creatureSpotsByKind, creatureSpotsNear } from '../memory/creature-spots.ts';
import { chestLocation, isContainerLandmark } from '../memory/chest-memory.ts';
import { noteGoneSpots, recallText } from '../memory/recollection.ts';
/** 查过的资料：出处 + 一句摘录 + 读取时间；只作外部参考，不是现场事实。 */
const knowledgeFactLine = (fact: KnowledgeFact) => {
  const minutes = Math.max(0, Math.round((Date.now() - fact.at) / 60_000));
  const age = minutes < 60 ? `${minutes || 1} 分钟前` : minutes < 1440 ? `${Math.round(minutes / 60)} 小时前` : `${Math.round(minutes / 1440)} 天前`;
  return `${fact.docId}${fact.section ? `#${fact.section}` : ''}｜${fact.title}：${fact.fact}（${age}查到）`;
};
export { noteGoneSpots } from '../memory/recollection.ts';

const PATH_REPEAT = new Set(['move_step', 'plan_route', 'navigate_to', 'advance', 'travel_to', 'explore_toward', 'go_near']);

export interface MindContext {
  tier: 'glance' | 'deliberate';
  reason: string;
  percept: Percept;
  state: AgentState;
  self: SelfModel;
  memory: WorldMemory;
  /** 结构性事实的审计出口（notice 级低噪）：只在顺手采集/不可替代工具等事实触发时打点，便于核对提示词是否生效 */
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** 读一格方块：给 my_bed 就近核对床还在不在（离得近、看得见不是床就把旧地标删掉） */
  blockAt?: (p: { x: number; y: number; z: number }) => string | null;
  activity: Activity | null;
  /** 调度器里正在执行的实际动作；用于区分“仍在执行”和“已失败/被取消”。 */
  runningStep?: { skill: string; args: unknown; source: string; startedAt: number } | null;
  suspended: Activity[];
  /** 提前想好、手上的活做完就接上的下一段（模型自己写的 next，如实回显，不加引导） */
  next?: { what: string; why?: string; requires?: Condition } | null;
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
  /** 主线进度事实：已达成里程碑与下一个未达成的目标（只作方向参考，不是硬目标） */
  progress?: { reached: number; total: number; done: string[]; next: string | null; branches: { group: string; done: number; total: number; next: string[] }[] } | null;
  /** 技能书索引（每份一行） */
  skills?: string[];
  /** 游戏自己的系统消息（死亡播报、成就、公告），原话 */
  gameMessages?: string[];
  repeatedFailures?: string[];
  /** 动作结束时实际观察到的失败；地形可能随后改变。scope 说明它只否定哪一层。 */
  recentActionFailures?: { skill: string; args: unknown; failure_code: string | null; summary: string; position: AgentState['pos']; observed_at: string; repeats?: number; scope?: 'step'; implication?: string }[];
  /** 动作成功但附带、要心智掂量的事实（如挖到了人造建材）；位置和环境可能随后改变。 */
  recentActionCaveats?: { skill: string; args: unknown; caveat: string; position: AgentState['pos']; observed_at: string }[];
  /** 建筑师正在后台画的图纸 */
  designing?: { brief: string; minutes: number };
  /** 按关键词自动想起来的经历、教训、技能 */
  recalled?: Recalled[];
  /** 后台预取的长期记忆（Hindsight 合并）：历史经历/推断，不等于当前现场事实 */
  hindsightMemories?: { text: string; kind: 'experience' | 'inference' }[];
  /** 想起来、拿得准的技能：直接翻开的全文 */
  openedSkill?: { name: string; body: string };
  /** 刚才卡住、随后在同一带做成：值得写成技能 */
  learnFrom?: { stuck: { what: string; why: string; skill?: string; code?: string }; solved: { what: string; routine: string[] } };
  /** 这一趟下地：下来多久、背包多了什么、是不是手上的活快收工了（给“下矿的账”） */
  trip?: { minutes: number; gained: Record<string, number>; nearEnd: boolean };
  /** 出行记录（认真想时给）：每段在某维度的在线经历、走到的最远脚格、怎么结束、吃了多少 */
  excursions?: readonly Leg[];
  /** 本维度各方位身体站过的最远脚格（体素到访标记，后台读的缓存；认真想时给） */
  reach?: { dim: string; origin: Vec3Like; at: number; sectors: Record<string, { pos: Vec3Like; distance: number }>; truncated: boolean };
  /** 打猎的账（给“肉快打光了”这种事实） */
  hunting?: HuntTally | null;
  /** 材料账：木料/矿石各跑过几段活、一共多少、走了多远（给重复跑腿的事实，不替 Agent 决定备多少） */
  materials?: { wood: MaterialTally; ore: MaterialTally } | null;
  /** 主目标和清单 */
  plan?: FocusPlan | null;
  /** 阶段回顾：情绪或回想提醒它停下来看这一阶段在做什么（有这一项时才允许换主目标） */
  stageReview?: Record<string, unknown>;
  /** 主目标级无进展闸门：最近几段活没有物品/清单/新区块/出行最远点的变化，重复的动作签名会被退回重新确认 */
  progressGate?: Record<string, unknown> | null;
  /** 自己写的可执行技能一览（带成败） */
  learnedSkills?: string[];
  /** 本能现状：哪些身体会自己做（躲苦力怕、还手这些现在可能没开） */
  instincts?: string;
  /** 工具分级事实：同状态签名已由 Mind 去重，这里只负责展示；null 表示这一念不重复 */
  toolFact?: string | null;
}

/**
 * 提示词的组织（针对注意力容易被“手边的格式”和“最后看到的内容”带走的模型，如 DeepSeek）：
 * - 系统提示词短而稳定，并分成三层：两级共用的静态前缀（身份 → 操作者 → 读法 → 原则 → 选动作 → 决定 → 输出 → 动作目录）→
 *   档位专属尾段（瞥一眼的说明，或认真想的步骤、专注、查找、技能和精确操作）→ 变动最勤的技能书索引。
 *   前缀逐字相同，瞥一眼和认真想交替时仍能命中服务端前缀缓存。
 * - 规则贴在用的地方：动作说明自己写清“新房子用图纸”，常用动作给完整参数，冷门动作只列名字（需要时 moves 查）。
 * - 技能索引每条只留名字、状态和一句用途；完整说明用 skill 查询，避免长尾目录占满提示词、拖累缓存。
 * - 用户消息末尾按情境追加 2–4 条“此刻要留意”的提醒，只说和眼下有关的。
 */

/**
 * 常用动作：给完整参数；其余只列名字和一句用途，需要时用 {"kind":"moves"} 查完整参数。
 * 只保留高频且参数易错、或静态说明直接依赖的动作（移动原语、导航、合成/建筑、容器存取）。
 * 参数简单、看名字和用途就能正确调用的动作（吃、睡、打猎、等待、查方块等）降到按需列表；
 * 它们正在被使用时，完整参数仍会作为 user 提醒送达，不依赖模型自己想起来查。
 * 例外：spatial_extrema 是一次只读到访/最深点查询，参数少且直接支撑提示词里的到访覆盖事实，
 * 放进核心目录是为了让 Agent 知道“可以查更大范围”，不是因为它高频。
 */
export const COMMON_MOVES = ['travel_to', 'explore_toward', 'approach_visible', 'go_near', 'move_step', 'navigate_to', 'mine_cell', 'place_cell', 'place_support', 'pillar_one', 'gather', 'look', 'swim_path', 'boat_path', 'descend_to', 'excavate_run', 'assess_landings', 'spatial_extrema', 'craft', 'smelt', 'eat', 'pickup_items', 'store_items', 'take_items', 'find_item', 'sleep', 'press_keys', 'build', 'use_item'];

/**
 * 真·远行/末地动作：平时不占静态目录。建造档案、基地、预留、远程防守这些是日常通用能力，
 * 归到“其余动作”按需可查，不能因为还没进下界就整类消失。
 * 只按动作名匹配：`descend_to` 曾因名字里含 "end_" 被误判为进阶动作，导致基础下行辅助在
 * 非下界/末地情境下既不在静态目录、也不在进阶提醒里。
 */
const ADVANCED = /portal|dragon|stronghold|search_structure|end_gateway/;

/** spatial_query 契约参数很大且不是每念都用，留在按需目录；到访覆盖用的 spatial_extrema 已在核心目录。 */

/** 描述取第一句话，太长就在标点处截断（不截进半个括号或半个英文词） */
function briefOf(d: string, n: number): string {
  const first = d.replace(/\s+/g, ' ').split(/[。；;：:]/)[0];
  if (first.length <= n) return first;
  const cut = first.slice(0, n);
  const open = cut.lastIndexOf('（');
  if (open > cut.lastIndexOf('）') && open > n / 2) return `${cut.slice(0, open)}…`;
  const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(','), cut.lastIndexOf(' '));
  return `${at > n / 2 ? cut.slice(0, at) : cut}…`;
}

/** 目录里的一句用途；有 catalog 的动作已自带参数与用途。 */
function descOf(s: { description: string }, chars: number): string {
  return chars ? briefOf(s.description, chars) : '';
}

/**
 * 静态动作目录：core 里的动作给完整参数，其余非进阶动作只列名字 + 一句用途（需要时用 {"kind":"moves"} 查完整参数）。
 * 不再随 advanced（是否下界/末地）或 inUse（当前活动用到哪些动作）变化：进阶动作单独走 advancedMovesLine() 作为 user 提醒，
 * 当前活动用到的动作单独作为 user 提醒，这样 system 前缀保持字节稳定，最大程度命中服务端前缀缓存。
 */
export function movesCatalog(chars = 40, core: Set<string> = new Set(COMMON_MOVES)): string {
  const visible = Object.values(SKILLS).filter((s) => !LLM_HIDDEN.has(s.name) && !isSkillDisabled(s.name) && !ADVANCED.test(s.name));
  const detailed = visible.filter((s) => core.has(s.name)).map((s) => {
    if (s.catalog) return `- ${s.name} ${s.catalog}`;
    // argsDoc 常以句号收尾，直接接“：用途”会出现“。：”，读起来像参数的一部分。
    const args = s.argsDoc.trim().replace(/[。；;]$/, '');
    const desc = descOf(s, chars);
    return `- ${s.name}${args ? ` ${args}` : ''}${desc ? `：${desc}` : ''}`;
  });
  const onDemand = visible.filter((s) => !core.has(s.name)).map((s) => `${s.name}（${briefOf(s.description, 14)}）`);
  const demandLine = onDemand.length ? `\n其他动作（用 {"kind":"moves","names":["…"]} 查完整参数；不写 names 列出全部动作，含进阶动作）：${onDemand.join('、')}` : '';
  return `${detailed.join('\n')}${demandLine}\n缺工具、熔炉、船、火把等默认报告缺口；加 "make":true 才允许顺手制造/准备并消耗材料，加 "make":false 则禁止本动作及嵌套准备`;
}

/** 一组动作的 user 提醒行：名字 + 一句用途，完整参数用 moves 查。 */
function purposeLine(label: string, names: string[]): string {
  return names.length ? `${label}：${names.map((n) => `${n}（${briefOf(SKILLS[n].description, 14)}）`).join('、')}` : '';
}

/** 进阶动作（portal/end_/dragon/…）：不进静态目录，按需作为 user 提醒给出，避免平时噪音、也不破坏 system 前缀缓存 */
export function advancedMovesLine(): string {
  return purposeLine('进阶动作可用（参数用 moves 查）', Object.values(SKILLS)
    .filter((s) => !LLM_HIDDEN.has(s.name) && !isSkillDisabled(s.name) && ADVANCED.test(s.name)).map((s) => s.name));
}

/**
 * 空 moves 查询的完整动作目录：常用动作已在 system 里给参数，这里只列名字；
 * 其余动作（含平时不占目录的进阶动作）给完整参数和一句用途，保证 Agent 能自己发现全部能力。
 */
export function moveDirectory(): string {
  const visible = Object.values(SKILLS).filter((s) => !LLM_HIDDEN.has(s.name) && !isSkillDisabled(s.name));
  const core = visible.filter((s) => COMMON_MOVES.includes(s.name)).map((s) => s.name);
  const rest = visible.filter((s) => !COMMON_MOVES.includes(s.name)).map((s) => {
    const args = s.argsDoc && s.argsDoc !== '{}' ? s.argsDoc : '';
    const purpose = s.description.replace(/\s+/g, ' ');
    const short = purpose.length > 70 ? `${purpose.slice(0, 70)}…` : purpose;
    return `- ${s.name}${args ? ` ${args}` : ''}：${short}`;
  });
  return `常用动作（system 目录已给完整参数和用途）：${core.join('、')}\n其余动作（参数和一句用途；完整副作用用 {"kind":"moves","names":["…"]} 再查）：\n${rest.join('\n')}`;
}

/** 完整参数（moves 查询用）；最多 12 个，多出来的明确提示分开查，不静默丢掉。 */
export function moveDetails(names: string[]): string {
  const unique = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  const shown = unique.slice(0, 12);
  const more = unique.length > shown.length ? `\n（还有 ${unique.length - shown.length} 个没查，请分开写 names）` : '';
  return shown.map((n) => {
    const s = SKILLS[n];
    if (LLM_HIDDEN.has(n)) return `- ${n}：不是可主动规划的动作`;
    if (isSkillDisabled(n)) return `- ${n}：当前已禁用，不能调用`;
    return s ? `- ${s.name} ${s.argsDoc}：${s.description.replace(/\s+/g, ' ')}` : `- ${n}：没有这个动作`;
  }).join('\n') + more;
}

const CONDITIONS = `done_when 的写法（可选，写错会被忽略）：
{"type":"inventory_min","item":"oak_log","count":20}｜{"type":"location_near","dimension":"overworld","pos":{"x":0,"y":64,"z":0},"radius":4}（坐标要来自观察或地标）｜{"type":"self_state","field":"inWater|inLava|onGround|inPortal","equals":false}｜{"type":"self_state","field":"held|riding","equals":"物品名或 null"}｜{"type":"self_state","field":"dim","equals":"the_nether"}｜{"type":"sky_visible","equals":true}｜{"type":"underground","equals":false}｜{"type":"equipment","slot":"hand","item":"stone_pickaxe"}｜{"type":"exploration","min_distance":16}（本段实测离起点至少 16 格或进了新区块；只证明推进量，不证明找到或到达目标）｜{"type":"exploration","find":"oak_log"}（本段实际看见目标）｜{"type":"inventory_full","free_slots":2}（背包只剩 2 格空）｜{"type":"all_of","conditions":[…]}｜{"type":"any_of","conditions":[…]}（哪个先到就收工：“铁够 24 个，或背包装满”）
清包验收：{"type":"inventory_space_min","free_slots":5} 表示至少腾出 5 格空位（空位 ≥ 5）；inventory_full 表示空位 ≤ 指定数量，用于采集到近满，不能用来确认腾出空位。
高度范围：{"type":"position_y","max":30}（脚的位置 y ≤ 30），也可写 min 或同时写 min、max。
身体状态仅表示当前快照：inWater=false 只表示采样时身体未接触水，不证明已上岸、持续站稳或完成换气；onGround=true 只表示当前触地，也可能在水底。氧气恢复程度看 oxygen 数值；条件及其组合由你按实际目标选择。
写与这段活实际收工目标相符的条件；条件只证明它自身成立，不证明描述里的其他目标达成。开工前就成立的条件会被当成没写。移动可用 location_near 验收连续脚坐标到目标点的三维距离；travel_to 的 range 按格距，两种距离在格边可能不同。纯移动或观察不产生目标物品，只读步骤不改变站位。exploration 的 min_distance（1–256 的整数）只表示这段走了多远/进了多少新区块，是推进量，不是“找到、到达或认出目标”的证明：找下界要塞、遗迹、矿脉这类还不知道位置的目标，不要用它冒充目标达成；找具体方块/物品用 find（本段实际看见），已知坐标用 location_near，目标位置未知或无法当场确认时可省略 done_when，做完看实际观察再决定。min_distance 只能用在这段 steps 里有会移动身体的动作时；只看、只评估、只查询的活写 find 或省略；没把握就省略 done_when。清单（plan.steps）的 done_when 按当前状态自动勾，没有本段探索回执，不能用 exploration；要用 location_near、self_state、inventory_min 等当前状态条件，或只写成果文字、做完自己判断。`;

const OUTPUT = `只输出一个 JSON 对象：
{"monologue":"第一人称内心独白，接着刚才的念头往下想（20–80 字）",
 "decision":"continue|adjust|new|detour|switch|experiment|rest",
 "activity":{"what":"具体要干什么","why":"为什么现在做","kind":"gather|craft|build|explore|survive|rest|experiment|tidy|social|other","facing":"N|E|S|W（含水平相对操作时必填）","steps":[{"skill":"动作名","args":{}}],"repeat":1,"done_when":{…},"expect":"预计会怎样","if_stuck":"卡住打算怎么办","applying":"k_…（可选：这段活按哪条窍门做，结果只作为它的应用证据，不自动证明结论正确）","outcome_id":"po_…（可选：推进哪项计划成果）","method_id":"pm_…（可选：采用哪条计划做法）"},
 "next":{同 activity，可提前写下一段；手上的活成功结束后接上——“要是卡住就…”这种备选写进 if_stuck，不要写成 next。可选 "requires":{当前状态条件（如 inventory_min、location_near、self_state、equipment、inventory_full、block_state 等，可用 all_of/any_of 组合；不能用 exploration）}：轮到这段 next 时先按当时状态验收的前置条件，未满足或无法确认就不启动并交回你重新决定；它不结束当前活动，也不替你去等待或准备材料}}
activity.done_when 只结束当前活动；next.requires 只决定下一段能否开始，两者不能互相替代。
新回执仍支持原做法时可以沿用。几个方案眼下都要做同一个可执行动作时，先做它。若必须知道一个现场事实才能决定后续，就把这段活排到能验证它的观察或尝试，等回执再选；已有依据的连续动作可以一次排完。
核对 continue_effect 后，只有决定原样执行剩余计划才写 decision:"continue"，且不要写 activity——continue 只按原 routine 原参数继续，写 activity（哪怕同名、同样动作只改了参数）会被退回要求澄清。要做新的一段或改现在的动作，写 decision:"new"/"adjust"/"switch"/"detour" 并给出 steps；独白、what、expect、noticed 不会改变执行。routine 1–6 步。顺手、碰运气的步骤加 "optional":true（没成也不算失败）。调整 routine 时：续跑同一个动作（比如恢复后接着爬）在该步骤写 "id":"st_…"（routine 里显示的 #st_… 去掉 #），沿用它的进度与额度；不写 id 表示新建动作、重新计额度；改了参数就不要沿用旧 id。
operator（有【操作者的指令】时必写 {"status":"doing|done|cannot","note":"…"}；有【操作者的建议】时写 {"status":"adopted|declined","note":"…"}）｜plan（主目标：定下 {"focus":"a_…或一句话","steps":["成果…"],"methods":[{"text":"当前做法","outcome":0}]}；只换做法 {"focus":"a_…","methods":[…]}/{"method_drop":["pm_…"]}；做完一项 {"done":[0]}；删没做完的成果要写 switch_reason）｜skill（见【技能】）｜worth_learning（刚才的事值得练成技能时写：哪里出了问题、想学会什么）
其他可选字段：say（有新发现、改主意、做成事或遇险时说的一句口语）｜agenda（{"add":[{"text":"想做的事或想弄清的问题","kind":"goal|idea|question","horizon":"today|someday"}],"done":["a_…"],"drop":["a_…"],"focus":"a_…"}，规则不要放这里）｜learned（结果出乎意料时的一句窍门，或 {"revise":"k_…","text":"…"} 修订旧窍门）｜hypothesis（experiment 必填）｜experiment_result（上一段是实验时：supported|refuted|unclear）｜diary（值得记住的一句话）｜liked（刚发现喜欢的东西）｜habits（身体习惯与注意偏好，一直有效：{"torch_every":8} 空闲且暗时相隔约 8 格消耗一支火把，不打断动作；{"eat_below":12} 饿到 12 顺手吃，{"pickup":true} 新掉落物触发瞥一眼，由你决定是否调用 pickup_items；pickup:false 关闭单独提醒，掉落事实仍随下次思考提供，不会自动捡；数值习惯用 0 关闭）`;

const DECISIONS = `continue 原样执行剩余计划｜adjust 还是这件事、改一改 routine｜new 开始新的一段｜detour 先插一段别的，做完自动回来｜switch 放下手上的改做别的｜experiment 验证一个猜想的小活｜rest 歇一下`;

/** 操作者：直播的主人，从控制台下指令的人。指令不是“建议”，优先于自己的打算 */
const OPERATOR = `【操作者】控制台里的操作者（直播的主人）说话分两种。【操作者的指令】：优先于自己的主目标、手上的活和弹幕，这一念就照做（可以直接 switch），做法自己想，不讨价还价；只有会马上送命才先保命再回来；写 operator doing / done / cannot。做完或做不到就说，别一直挂着。【操作者的建议】：只是提个想法，认真掂量一下，合适就采纳（adopted），不合适就说一句为什么（declined），然后照自己的节奏玩，不用一直惦记。建议涉及的游戏机制与自己的记忆不一致时，先查 knowledge；查不到就说明不确定。`;

/** 专注：主目标 = 成果 + 当前做法，插曲用 detour */
const FOCUS = `【专注】主目标是这一阶段要拿到的成果，不是做法，也不是过夜、脱困这类眼前事（detour）。checklist 是成果（3–6 项可验证的子任务，可写 {"text":"…","done_when":{…}} 自动勾）；methods 是当前采用的路线/做法（可写 {"text":"…","outcome":序号} 指向它服务哪项成果），做法可以换、可以停，换做法不删成果。给 activity/next 写 outcome_id（po_…）或 method_id（pm_…）可把这段活的结果记到对应账上。删掉没做完的成果要写 steps 并在 plan 里写 switch_reason 说明为什么；有【阶段回顾】时可换主目标。`;

/** 技能的生成、试用与正式使用分开，完整写法按需查。 */
const SKILLS_DOC = () => `【技能】把做法写进 skill 会保存候选：{"name":"英文-连字符","description":"…","when":{条件},"steps":[…]或"code":"JS","verify":"观察原目标是否达成"}。你决定何时在 routine 用 use_skill {"name":"…","trial":true,"args":{…}} 显式试用；候选不自动接手、不替换稳定版，取得足够实际验收证据才启用。启用后 when 含 after_failure＝动作失败时先试；只有状态条件＝成立自动做；不写＝手动调用。只写 body、没有可执行定义的纯文字技能只是未验证笔记，不会被自动接手；要按它做，先用 skill 读、再由你决定。可执行技能写进来自带 verify；保存时没有 verify 会被拒绝。方块只读当前视觉，unknown不能当作空气或已知矿物；只听到的实体没有精确坐标和可交互ID（写 hostile 条件时加 seen:true 只看看得见的怪）。写不出就用 worth_learning；写法先查 {"kind":"skill","name":"writing-skills"}。遇到岩浆或水下呼吸问题由你或你学会的技能处理。纯文字技能可用 skill {"name":"…","restore":true} 恢复到阅读目录；恢复不代表验证成功。技能目录和查询保留成功过的应急版本；可用 skill {"name":"…","from_version":1} 将指定完整历史契约另存新候选再试，保留稳定版和旧证据，新候选从零验收；历史成功不保证现在有效。`;

const QUERIES = `【先查再做】需要时先输出一个查询 JSON（查询本身不执行身体动作，但等待期间世界仍在运行、身体可能继续动作，每次思考最多 3 次；拿到结果后以最新状态为准），再决定：
- {"kind":"skill","query":"关键词"} 查技能（空查询浏览目录，offset 分页，含收起和停用）；{"kind":"skill","name":"技能名"} 读技能及版本记录，加 "version":30 读历史版本；读取不代表启用或验证｜{"kind":"design","brief":"用途、多大、风格","where":"here|base|x,y,z"} 请建筑师画图纸：房子、前哨、仓库、畜栏、塔等要长期用的建筑（where：脚下、家旁或坐标）；传送门/末地门不是建筑，用 build_portal 立框点燃，别让建筑师画
- {"kind":"recipes","item":"物品名","count":1} 看配方和缺口（"uses":"物品" 反查用途）｜{"kind":"moves","names":["动作名"]} 看动作参数；不写 names 列出全部动作（含平时不显示的进阶动作）
- {"kind":"recall","query":"关键词"} 回想以前的经历、日记、教训和技能｜{"kind":"progress","target":"po_…"} 查某个目标的空间/移动/执行/成本/物品进展（省略 target 看全部；【专注】里只有摘要）｜{"kind":"mechanics","query":"…"} 查底层操作接口
- {"kind":"knowledge","query":"问题"} 搜索 Wiki 候选；再用 {"kind":"knowledge","id":"文档id"} 看章节目录，加 "section":"章节id" 读正文，续页按 nextCursor 传 cursor。空查询浏览目录，目录续页传 offset。摘录不等于读完或学会；资料不代表现场事实，做法自行判断。`;
/** 技能书目录放在系统提示词最后：它变得最勤（写、改、收起），放在前面会让后面不变的大段内容每次都缓存不中。
 *  每条只留名字、状态和一句用途；状态用图例说明，瞥一眼连用途也省掉，按需用 skill 查。 */
const SKILL_INDEX = (skills: string[], brief = false) => skills.length
  ? `\n\n【技能书】每份一行：名字（自写＝你自己写的）［状态］一句用途。状态：文字（未验证）＝自写的纯文字笔记，只能读、不能 use_skill、也不会自动接手；可执行＝能调用（use_skill 或直接写成一步，自动/动作失败时先试/手动是触发方式）；候选可试＝use_skill trial:true 试用；不可执行、定义无效、候选不可用/未确认＝用 {"kind":"skill","name":"…"} 看原因。\n${skills.map((x) => `- ${brief ? x.replace(/］.*$/, '］') : x}`).join('\n')}` : '';

/** 用户消息分块：越往后越要紧（模型对末尾注意力最强） */
const READING = `【方位】北 N=z减 南 S=z加 东 E=x加 西 W=x减。resolve_target 只算绝对落点、不会移动；别自己算绝对坐标；[前,上,右] 按指定 facing 换算。
【走到哪】按意图选一个移动动作（失败看回执里的具体原因再决定换法）：
- 去一个确定的地方（坐标、记得的地标、base、死亡点、已登记的门）→ travel_to {"to":{"x":0,"y":64,"z":0},"range":2}；路上要挖开挡路或搭路就加 "dig":true / "place":"方块名"
- 没有具体目的地，朝一个方向去没去过的地方找东西 → explore_toward {"direction":"E","distance":96,"until":"log"}（until 写类别 log=各种原木、stem=菌柄，或 "a|b" 列几种；写 oak_log 就只认橡木）
- 往下挖矿、开隧道、开阶梯这类施工 → excavate_run（按方向、模式、步数直线施工，不负责绕路去某处）
- 身边相邻一格（含上下一级台阶）→ move_step；改变指定的一格 → mine_cell / place_cell / place_support / pillar_one
- 站到看见过/记得的附近目标旁 → approach_visible；容器/门/床/传送门方块旁 → go_near {"target":{x,y,z}}，再 take_items/sleep/travel_portal（进门先 observe_portal 拿 portalId）
- 要到一个确切的格或精确连续脚位 → navigate_to
移动回执带 sessionId，仍要完成同一目标时原样传回。重复 look_around 不代表移动进展，进入新区块也不等于观测覆盖；段后按实测位置重新判断。
【相对坐标】activity/next 含 move_step、mine_cell、place_cell、place_support 的水平相对操作时，必须声明活动的 facing:"N|E|S|W"，表示坐标的前方，不等于推进方向。子步骤省略 facing 就继承，显式冲突会退回；绝对 xyz 和纯竖直操作不要求这个字段。活动里没有相对坐标步骤就省略 facing，不要拿镜头或行进方向去填；要写只能是 N/E/S/W，没有 NE/NW 等八方向。活动参考系独立于镜头朝向；转头、观察、插火把不会改变它，local 方块图仍按 local.facing 解读。输出前核对文字目标方向与坐标换算后的实际方向；例如 facing:"N" 的 [-1,0,0] 是向南。需要改变参考系时可明确声明新的 facing（包括 "S"），后退或换向仍由你决定。
【原地上下】move_step [0,1,0] 原地上移要求梯子；相邻上下台阶可用 move_step [1,1,0]/[1,-1,0]（层高限制见动作目录）。assess_landings 返回当前可见的落点候选及未确认项，descend_to 核实所选落点后下降。施工动作会改变地形：pillar_one {"item":"any"}（或指定材料）消耗一块材料垫高，起跳需要头顶上方两格都空；mine_cell [0,-1,0] 挖空脚下支撑后身体会下落，无需再 move_step。上下行也可由【走到哪】中的导航按已观测路线执行，是否施工由你决定。
【消息怎么读】越往后越要紧：【我】性格心情、议程、窍门 →【记得的地方】→【进度】主线到哪了、下一个目标 →【想起来的】自动想起的旧事和技能 →【最近】→【手上的活】→【身边】方块图 local、生物、资源 →【身体】where、生命饥饿、天色、背包 →【专注】主目标和清单 →【此刻】为什么现在想、注意到什么 →【此刻要留意】。未看见的方块状态未知，未挖到不代表那里是空气。`;

const ROUTINE_OF_THINKING = `【每次这样想】
1. 【此刻】要紧的（危险、快饿死、卡住）先处理。
2. 看【手上的活】里的 continue_effect：只有当你核对后决定原样执行剩余计划时才 continue（continue 不改变动作）；要改变当下动作，用 adjust/detour/switch 并写出 steps，独白、what、expect、注意到的事不会改变执行。
3. 看【身体】where 和【身边】local 确认地形；地形分类不代表受困或需要离开，按当前目标和实际反馈选择动作，身边一格的操作写确切坐标。
4. 拿不准就先查（knowledge / skill / moves / recipes / recall）；输出前核对动作名和参数。`;

const CHOOSE = `【选动作】
- 去某处 → 按【走到哪】选；找没见过的东西 → look_around 看当前视野，explore_toward 朝你选的方向边走边看（until 在本轮视野看见就停）；停止后按实测位置和观测决定是否续走。进入新区块不等于已看清那片区域，到过的区块也不等于搜过——隧道里只看得见沿途；拿看得见的方块 → gather；身边某一格 → mine_cell / move_step / place_cell / place_support
- 坐船过水：船是实体，用 use_item {"item":"…_boat","on":"water"} 放到水面（别用 place_cell），再 interact {"entity":"boat"} 上船；boat_path {"direction":"SW"} 划（必须给 direction 或 to）。水面上岸/游到指定点用 swim_path；吃 → eat（背包有吃的）/ hunt / forage / fish；做东西 → craft、smelt（会自己放下背包里的工作台/熔炉；拿不准查 recipes）
- 从箱子取/存东西 → 先 find_item {"item":"…"} 查它在哪个箱子，再 take_items / store_items 指定那只箱子（target 写坐标或容器地标 ID）
- 地表和地下都可按【走到哪】选导航或相邻格动作，能否通行取决于实际地形与观测证据；mine_cell / place_cell / place_support / pillar_one 改变指定格，excavate_run 按显式方向、模式、步数施工。路线与是否改变地形由你决定。
- 穿下界门/末地门 → 先 observe_portal 拿 portalId，再 travel_portal {"portalId":"…"} 穿过去；travel_portal 不行时，自己走到门面正前那一格、面向门面走进去（进入门方块后要连续停留约 4 秒；先看 body_in_portal/身体所在格确认自己是否已在门里；portal 方块站不住也挖不掉，别用 move_step/mine_cell）
- design 请建筑师画图纸，再 build（新盖 {"draft":"图纸ID"}，续建 {"projectId":"作品ID"}）；不要自己画图纸
- 上不去的高处由你决定：用梯子、pillar_one/place_support 垫高、另找路，或让 travel_to/explore_toward 写 place 在走不通时代为垫高；navigate_to 不挖不放。`;

const PRINCIPLES = `【原则】
- 接着刚才的念头往下想，不反复换主意、不重复刚做完的事。内部思考有预算：最多比较两套可行方案，同一事实/同一权衡只评估一次；已有足够信息就停止推理并直接给出能执行的 JSON。不要重算已经给出的背包/箱子/目标，也不要列举用不上的配方、去不了的远处选项或已经排除的方案；卡住时先选一个可验证的下一步，做完再看结果。
- 一段活（如“砍 20 根木头”）：routine 1–6 步，可 repeat，done_when 写清何时收工；身体连续执行、自己应变，真卡住才叫你。
- 从真实结果里学，出乎意料才写 learned；历史失败只作参考，继续、重试或调整由你决定。
- 你既会被风景吸引、想把见闻记下来，也想把日子过扎实、去更远的地方看看；要做什么、先做什么都由你定。喜欢的写 liked，想做的放 agenda。情绪是信号：累了歇、烦了换办法、腻了找新鲜事。
- 只知道亲眼看到或记得的东西，坐标来自观察或地标，不编。
- 背包数量、计划和窍门的成败次数不能证明某次行动的具体工具或经过；讲自己的经历要有实际观察依据。
- 遇到危险如何行动由你或你写下的技能决定；插火把、顺手吃可用 habits 定成习惯；捡东西需明确安排 pickup_items，pickup 偏好只提醒思考。
- Skill 是执行经验，不是行动目标或推荐。先按当前目标、身体、环境和记忆决定做什么，再选基础动作，最后才考虑是否查/用 Skill；不要因为最近常用某动作、某动作 Skill 多、或为了用上已学 Skill 而改变方向；目标或环境变了就重新评估基础动作，没有匹配 Skill 时直接用基础动作完成。`;

const PRECISE = `【精确操作】local 以脚部占据格为原点：[前,上,右]，前=local.facing。spots.stand/place 是当前可见的候选站位/放置格，仍需动作确认。
- [0,0,0] 是脚部格，[0,1,0] 是头部格，[0,-1,0] 是支撑格；挖空 [0,-1,0] 会下落，无需 move_step。
- move_step 相对写法只锁定相邻列，±1 内实际脚高由宿主解析（回执 resolvedAt）；绝对 xyz 失败若给出同一列的实际脚高，这是该列的落脚证据；落点有岩浆/火等危险时默认拒绝，allowHazard:true 由你决定；更大落差可用 assess_landings，再把 options[].target 原样交给 descend_to（没有 mode/nearest）。move_step 报超出层高限制、或 assess_landings 没有相邻落点，只说明该动作范围内的结果，不证明远处没有路线，也不要求改用施工。
- place_cell 指方块占据格；place_support 的参数是补上的支撑格：[1,-1,0] 补 [1,0,0] 脚部目标格下方，上下范围 -2..3，可补下一级 [1,-2,0]。梯子、火把可放进身体格（需有附着面）。
- 机械性失败只做已授权的执行辅助；照明、垫方块、挖墙都要你显式安排（make / place / dig / fill），不会自动消耗材料。`;

/**
 * 两级思考共用的系统前缀：身份、操作者、读法、原则、选动作、决定、输出格式和动作目录逐字相同、顺序固定。
 * 瞥一眼和认真想交替发生，前缀一致时切换档位仍能命中服务端缓存；档位专属的内容放在后面各自的尾段。
 */
function systemCore(persona: string): string {
  return `${persona}

游戏版本：Minecraft Java Edition ${config.mc.version}。

你就是这个 Minecraft 角色本人，像真人玩家一样连续地玩，同时在直播。

${OPERATOR}

${READING}

${PRINCIPLES}

${CHOOSE}

【决定】${DECISIONS}

【输出】${OUTPUT}
${CONDITIONS}

【动作】参数必须合法：
${movesCatalog(28)}`;
}

/** 瞥一眼的专属说明；放在共用前缀之后，避免改动它时打碎前面的缓存 */
const GLANCE_GUIDE = `这次只是抬头看一眼，不必把每个细节重新铺开：
- 先看【此刻】，再核对【手上的活】的 continue_effect：只有决定原样执行剩余计划才 continue（独白可以很短）；要改变当下动作就用 adjust/detour/switch 写出 steps——独白、what、expect、noticed 不会改变执行。
- 手上没活：直接 new 一段，接着【最近】的结果和议程往下玩；边做边想下一段可写 next，当前动作仍在执行、结果未知。小改用 adjust，插一件事用 detour，彻底换事用 switch/new。
- 看【身体】where 和【身边】local 确认地形；地形分类不代表受困或需要离开，按当前目标和实际反馈选择动作，身边一格的操作写确切坐标。
- 要翻技能书、请建筑师、查配方/游戏资料或想得更深：直接输出查询，如 {"kind":"knowledge","query":"问题"}、{"kind":"design","brief":"…"}、{"kind":"skill","name":"…"}、{"kind":"deliberate","reason":"…"}（转成认真想）。knowledge 先搜候选再读章节，摘录不等于读完或学会；资料不代表现场事实。
- 有【专注】的主目标时，可用 detour 暂时插一段并自动回来；明确决定放下当前活动用 switch，想立即改做法用 adjust。做完清单一项写 "plan":{"done":[序号]}。
- 技能书在文末：需要时先用 skill 查询；文字做法不能用 use_skill 直接执行，只有已注册的可执行技能或可试用候选才能调用。
- 刚从卡住里找到办法、想把它变成身体的习惯：转成认真想（{"kind":"deliberate","reason":"写技能"}）。`;

export function deliberateSystem(persona: string, skills: string[] = []): string {
  return `${systemCore(persona)}

${ROUTINE_OF_THINKING}

${FOCUS}

${QUERIES}

${SKILLS_DOC()}

${PRECISE}

${liveAudience.enabled && liveAudience.inPrompt !== false ? `\n${AUDIENCE_RULES}\n` : ''}${SKILL_INDEX(skills)}`;
}

export function glanceSystem(persona: string, skills: string[] = []): string {
  return `${systemCore(persona)}

${GLANCE_GUIDE}${SKILL_INDEX(skills, true)}`;
}

/** 打算里说要下矿、往下挖 */
/** 最后一步执行中提前规划下一段；不推测当前动作的结果。 */
export const NEAR_END_REASON = '手上这段活的最后一步正在执行，结果还不知道；可以提前想想接下来';

const MINING_INTENT = /下矿|矿道|矿洞|找铁|挖铁|找矿|挖矿|粗铁|铁矿|往下挖|下挖|下到 ?y|挖(阶梯|台阶)[^上]{0,6}(下|降)|石层|深层/;

/** 打算里说木头/砍树/原木（材料账只在相关意图出现；前导非字母避免 dialog 之类误匹配） */
const WOOD_INTENT = /砍|伐|原木|木头|树干|找树|木料|木材|橡木|(^|[^a-z])(log|wood|stem|hyphae|bamboo)s?\b|\bchop\b|\btree\b/;

/** 打算里说要从地下回地面 */
const SURFACE_INTENT = /回地面|回到地面|回前哨|回基地|回入口|退回入口|回地表|见天|爬出|挖出去|出矿|上地面|上到地面|往上爬|往上走|往上挖|挖(阶梯|台阶).{0,8}上/;

/** 打算里说要过水 / 到对岸 */
const WATER_CROSS_INTENT = /过水|过河|渡河|过海|过湖|涉水|划船|坐船|游过去|游到|对岸|对面|跨过.{0,8}(水|河|海|湖)|去.{0,12}(对岸|对面)|到.{0,12}(对岸|对面)/;

/** 过水时的材料代价（站在水边/水里才说；怎么过由它定） */
export function waterCrossingHint(p: Percept, s: AgentState): string | null {
  if (p.self.riding) return null;
  const localWater = !!p.self.local && Object.values(p.self.local.layers).some((rows) => rows.some((row) => row.includes('~')));
  if (!p.self.inWater && !localWater) return null;
  const inv = s.inventory;
  const boat = inv.filter((i) => /(^|_)(boat|raft)$/.test(i.name)).reduce((n, i) => n + i.count, 0);
  const planks = inv.filter((i) => /_planks$/.test(i.name)).reduce((n, i) => n + i.count, 0);
  // 与 item/place/fill 写 any 时实际会用的方块同口径；木板单独报（要用得写方块名）。
  const blocks = inv.filter((i) => PLACEABLE.includes(i.name)).reduce((n, i) => n + i.count, 0);
  // 在水里时，上岸动作的委托写法和坐标口径贴在现场：swim_path 会沿看到的水路绕行，
  // 但目标仍由 Agent 选；给方块顶上的脚坐标要用中心（+0.5），整数 x/z 会卡在方块交界。
  const shore = p.self.inWater
    ? '；在水里要上岸用 swim_path {"mode":"dry_shore","xyz":[脚坐标]}：会沿已看到的水路绕行（不挖不垫）；站在方块 (bx,by,bz) 顶上时写 [bx+0.5, by+1, bz+0.5]'
    : '';
  return `过水可用的材料：${blocks ? `any 能用的土石类方块 ${blocks} 块` : 'any 能用的土石类方块没有'}；${boat ? `背包有船 ${boat} 只` : planks >= 5 ? `木板 ${planks} 块（够造一只船）` : '没有船，木板也不够造（要 5 块木板）'}${shore}；从水里直接爬上岸，岸顶最多比水面高 1 格；更高的岸要先垫方块或挖台阶（由你决定）`;
}

/** 主目标清单观察在线没进展、最近几段活还卡/没做成：提示可以改清单（不动主目标、不删做完的项、不重写已勾掉的项） */
function planRevisionHint(ctx: MindContext): string | null {
  if (ctx.tier !== 'deliberate') return null;
  const plan = ctx.plan;
  if (!plan) return null;
  const stall = ctx.self.planStallInfo();
  if (stall.minutes < PLAN_REVISION_MIN) return null;
  const since = plan.progressAt ?? plan.setAt;
  const acts = ctx.self.history(60).filter((r) => r.at > since);
  if (acts.length < 3) return null;
  // 改过清单之后，要等新清单也卡住两段才再提：否则停滞期间每次认真想都收到“可以改清单”，一念一改
  const revised = Math.max(since, plan.revisedAt?.at(-1) ?? 0);
  const stuck = acts.filter((r) => r.at > revised && (r.outcome === 'stuck' || r.outcome === 'unmet'));
  if (stuck.length < 2) return null;
  const outcomeText = { done: '做成', stuck: '卡住', unmet: '没做成', abandoned: '放下', interrupted: '打断', replaced: '换掉' } as const;
  const recent = acts.slice(-3).map((r) => `${r.what.slice(0, 18)}→${outcomeText[r.outcome] ?? r.outcome}`);
  const doneSteps = plan.steps.filter((st) => st.done).map((st) => st.text);
  return `主目标「${plan.goal.slice(0, 30)}」的清单已观察到 ${Math.round(stall.minutes)} 在线分钟没勾掉一项${stall.historyUnknown ? '（更早的在线时长未知）' : ''}，最近：${recent.join('；')}。主目标不用换（换目标要等阶段回顾）；清单可以按实际情况改，也可以不改：补上缺的一步、拆分或合并项、删掉做不成的项（已观察到 ${Math.round(stall.minutes)} 分钟无进展，删项不再强制写 switch_reason；写一句理由记下来更好；删项不会自动完成主目标，要收工请走阶段回顾或明确勾完清单），写 plan {"focus":"${plan.agendaId}","steps":[…] }${doneSteps.length ? `；已经勾掉的（${doneSteps.slice(0, 3).map((t) => `「${t.slice(0, 14)}」`).join('、')}）保留，别写成新步骤` : ''}`;
}

/** 这一念的意图文本：当前活动、议程、最近三个念头。提醒里的“想下矿/想回地面”判断共用同一口径。 */
function intentText(ctx: MindContext): string {
  return [ctx.activity?.what, ctx.activity?.why, ...ctx.self.agenda().map((a) => a.text), ...ctx.self.recentThoughts(3).map((t) => t.text)].filter(Boolean).join(' ');
}

/**
 * 不占 5 条提醒配额的决策事实：下矿的账、木料/矿石的账、顺手采集。
 * 地下挖掘时静态说明常已占满 situationalReminders 的 5 个位置，这些事实按 push 顺序排在后面会被 slice 截掉
 * （2026-11-06 线上：388 个地下 prompt 里“下矿的账/顺手采集”0 次送达，ore_opportunity 却打了 231 次日志）。
 * 这里只把已有事实换个送达位置；采不采、收不收工、备多少仍由 Agent 决定。
 */
export function decisionReminders(ctx: MindContext): string[] {
  const out: string[] = [];
  const p = ctx.percept, s = ctx.state;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  const intent = intentText(ctx);
  // 下矿的账：在地下、手上的活快收工或想回地面时，提供实际经历和当前所见。
  const trip = ctx.trip;
  let tripShown = false;
  if (trip && trip.minutes >= 1.5 && (trip.nearEnd || !ctx.activity || SURFACE_INTENT.test(intent)) && (p.self.where?.kind === 'underground' || p.self.sky_visible === false)) {
    const got = Object.entries(trip.gained).filter(([k]) => /raw_|_ore$|coal|diamond|emerald|lapis|redstone|amethyst|obsidian|debris|flint|gold_nugget|quartz/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}×${n}`);
    const seen = p.nearby.resources.filter((r) => r.seen === 'now' && isResourceBlock(r.block)).sort((a, b) => a.nearest - b.nearest).slice(0, 4).map((r) => `${r.block}×${r.count}（最近 ${Math.round(r.nearest)} 格）`);
    // 近邻资源走坐标索引；256 格是回忆上限，不是全图扫描。
    const remembered = oreSpotsNear(ctx.memory.resourceLandmarksAround(p.self.dim, here, 256), { worldId: s.worldId, dim: p.self.dim, pos: here }, { radius: 48 }).length;
    const picks = durabilityFacts(s.inventory, ['pickaxe'], p.storage?.stock);
    out.push(`下矿的账：${got.length ? `挖到 ${got.join(' ')}` : '还没挖到矿'}；背包空 ${p.emptySlots} 格${picks.length ? `；${picks.join('、')}` : ''}；身边${seen.length ? `看得见 ${seen.join('、')}` : '没看见矿'}${remembered ? `，48 格内记得 ${remembered} 处矿点` : ''}。清单后面几项还要不要这些料，一起掂量再决定收不收工`);
    tripShown = true;
  }
  // 木料/矿石的历史账：只陈述账本里的段活数、数量、路程和现有量。
  // 只在认真想时出现，瞥一眼不重复；现有量的背包是实时读的，箱子是上次打开时的记录，分开写。
  const materials = ctx.materials;
  if (materials && ctx.tier === 'deliberate') {
    const backpack = (re: RegExp) => s.inventory.filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0);
    const chestStock = (re: RegExp) => (p.storage?.stock ?? []).filter((r) => r.inChests > 0 && re.test(r.item)).reduce((n, r) => n + r.inChests, 0);
    const lastAgo = (at: number | null) => {
      if (at === null) return '';
      const minutes = Math.floor((Date.now() - at) / 60_000);
      return `；最近一次 ${minutes < 1 ? '不到 1 分钟前' : minutes < 90 ? `${minutes} 分钟前` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} 小时前` : `${Math.round(minutes / 1440)} 天前`}`;
    };
    const gatheringWood = ctx.activity?.kind === 'gather' && WOOD_INTENT.test(JSON.stringify(ctx.activity.steps));
    if (materials.wood.trips >= 2 && (WOOD_INTENT.test(intent) || gatheringWood)) {
      const t = materials.wood, wood = MATERIAL_FAMILIES.wood.stock;
      const inv = backpack(wood), chest = chestStock(wood);
      out.push(`木料的历史账（最近 ${t.trips} 段活）：拿到 ${t.units} 个原木类方块（不含木板/木棍），一共走了 ${t.walked} 格（最近平均每段活 ${t.recentWalked} 格${lastAgo(t.lastAt)}）；现在背包里有 ${inv} 个原木类方块（实时，不含木板/木棍）${chest ? `；记得的箱子（上次打开时）还有 ${chest} 个原木类方块` : ''}`);
      // 紧挨着木料历史账，给出“手头有树苗、树苗能长成树”的物品与世界机制事实。
      // 只说事实和知识库入口，不写“应该种/为了少跑”这类做法建议；种不种仍由 Agent 决定。
      const bagSaplings = s.inventory.filter((i) => isTreeSaplingItem(i.name)).reduce((n, i) => n + i.count, 0);
      const chestSaplings = (p.storage?.stock ?? []).filter((r) => r.inChests > 0 && isTreeSaplingItem(r.item)).reduce((n, r) => n + r.inChests, 0);
      if (bagSaplings + chestSaplings > 0) {
        const where = bagSaplings && chestSaplings
          ? `背包里有 ${bagSaplings} 个树苗（可种）；记得的箱子（上次打开时）还有 ${chestSaplings} 个`
          : bagSaplings ? `背包里有 ${bagSaplings} 个树苗（可种）` : `记得的箱子（上次打开时）里有 ${chestSaplings} 个树苗（可种）`;
        out.push(`树苗：${where}。树苗放在草方块/泥土等土壤上会生长成树，树木长成后可采原木（需要光照和上方空间；细节见 knowledge 的「树苗/植树」）。`);
      }
    }
    // 下矿的账（这一趟）已经在上面说过了，就不再用历史聚合重复一遍。
    if (!tripShown && materials.ore.trips >= 2 && MINING_INTENT.test(intent)) {
      const t = materials.ore, ore = MATERIAL_FAMILIES.ore.stock;
      const inv = backpack(ore), chest = chestStock(ore);
      const rawBlocks = backpack(/^raw_(iron|gold|copper)_block$/) + chestStock(/^raw_(iron|gold|copper)_block$/);
      out.push(`矿石的历史账（最近 ${t.trips} 段活）：拿到 ${t.units} 个矿石/粗矿/矿物，一共走了 ${t.walked} 格（最近平均每段活 ${t.recentWalked} 格${lastAgo(t.lastAt)}）；现在背包里有 ${inv} 个矿石/粗矿/锭（实时）${chest ? `；记得的箱子（上次打开时）还有 ${chest} 个矿石/粗矿/锭` : ''}${rawBlocks ? `；粗矿块 ${rawBlocks} 个（背包+记得的箱子合计）按块计，未折算成粗铁` : ''}`);
    }
  }
  // 站在这一趟的起点附近（通常刚到门边）时，把以前推到过的最远处贴在末尾：要不要从那里接着推由它定。
  const reach = ctx.reach;
  if (ctx.tier === 'deliberate' && reach && reach.dim === p.self.dim && Math.hypot(here.x - reach.origin.x, here.z - reach.origin.z) <= 24) {
    const far = reachLines(ctx, here, 64);
    if (far.length) out.push(`这个维度里身体站过的最远处（体素到访记录，从 (${reach.origin.x},${reach.origin.y},${reach.origin.z}) 起算）：${far.join('；')}——现在能否走通未确认，坐标可作为 travel_to 目标`);
  }
  // 顺手采集与不可替代工具：把「看见什么矿 + 现在这类料有多少 + 能做什么」摆成事实，让它在路过矿石时能自己掂量要不要顺手采；
  // 只报事实，采不采、做不做备用工具都由它定（不替它写 gather 或 craft）
  if (ctx.tier === 'deliberate') {
    const ore = oreOpportunityFact(p.nearby.resources, p.storage?.stock, s.inventory);
    if (ore) { out.push(ore); ctx.log?.(ore, { kind: 'ore_opportunity' }); }
  }
  return out;
}

/** 按情境追加在用户消息末尾的提醒：只说和眼下有关的 2–4 件事 */
export function situationalReminders(ctx: MindContext): string[] {
  const out: string[] = [];
  const p = ctx.percept, s = ctx.state;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  if (p.self.dim !== 'overworld') out.push(`你在${DIM_ZH[p.self.dim] ?? p.self.dim}，不是主世界；记得的地标、矿道、箱子都按维度分开，主世界的东西在这里看不到。这里没有昼夜、始终昏暗，火把只能照明，不能像主世界那样靠光拦住刷怪`);
  const drafts = activeDrafts()?.list(4).filter((d) => !d.usedBy) ?? [];
  const unfinished = myBuilds(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }).filter((b) => b.status !== 'complete' && b.dist <= 96);
  const intent = intentText(ctx);
  if (ctx.learnFrom) {
    const f = ctx.learnFrom;
    out.push(`刚才「${f.stuck.what}」卡住了（${f.stuck.why.slice(0, 50)}${f.stuck.skill ? `，失败的是 ${f.stuck.skill}${f.stuck.code ? ` ${f.stuck.code}` : ''}` : ''}），随后「${f.solved.what}」做成了（${f.solved.routine.slice(0, 4).join('；')}）：以后还会碰到的话，写 worth_learning 说清怎么回事，后台会把它练成技能`);
  }
  const focusItem = ctx.self.activeAgenda();
  if (focusItem && !ctx.plan && ctx.tier === 'deliberate') out.push(`主目标「${focusItem.text}」还没有清单：写 "plan":{"focus":"${focusItem.id}","steps":[…3–6 项]}，之后一项项推进`);
  const revision = planRevisionHint(ctx);
  if (revision) out.push(revision);
  // 同一位置连续移动/规划失败：保留各次原因，不把程序/证据问题归因成地形无路。
  const pathFails = (ctx.recentActionFailures ?? []).filter((f) => PATH_REPEAT.has(f.skill));
  if (pathFails.length >= 3) {
    const recent = pathFails.slice(0, 3).map((f) => `${f.skill} ${f.failure_code ?? '失败'}：${f.summary.slice(0, 120)}`).join('；');
    out.push(`【局部恢复】附近记录了 ${pathFails.length} 次移动/规划失败，最近：${recent}。预算耗尽、参数错误、证据变化与已观测阻挡含义不同；结合各次回执和当前目标判断是否续接、调整或停止，由你决定。`);
  } else {
    const repeatFails = (ctx.recentActionFailures ?? []).filter((f) => (f.repeats ?? 0) >= 2);
    if (repeatFails.length) {
      const f = repeatFails[0];
      out.push(`动作 ${f.skill} 在这一带反复 ${f.failure_code ?? '失败'}（${f.repeats} 次）：${f.summary.slice(0, 120)}。这只是该动作的结果；是否重试或调整由你结合当前证据决定，不必把整段活推倒重来`);
    }
  }
  const where = p.self.where?.kind;
  if (MINING_INTENT.test(intent)) {
    // 矿在哪一层是版本事实：模型记得的多是老版本（钻石 y12），摆出这个世界的版本对应的分布，下到哪层它自己定
    const layers = oreLayerFacts(config.mc.version, intent);
    if (layers) out.push(layers);
    // 消耗品预算：下矿前把火把够不够、还能做多少摆出来（只报事实，备多少由它定）
    out.push(...supplyFacts({ inv: s.inventory, torchEvery: ctx.self.habits().torch_every, only: new Set(['torch']), difficulty: s.difficulty, gamerules: s.gamerules, stock: p.storage?.stock }));
    // 世界规则事实：keepInventory 开着时死亡不掉落（只是事实，怎么备仍由它定）
    const keepInv = s.gamerules?.keepInventory;
    if (keepInv === true || keepInv === 'true') out.push('keepInventory 开着（死亡不掉落）');
  }
  // 冶炼燃料预算：手上这段活要 smelt 时，先把燃料够不够摆出来（只报事实，燃料比走 methods/fuel 的原版默认）
  const smeltStep = ctx.activity?.steps?.find((st) => st.skill === 'smelt');
  if (smeltStep) {
    const a = (smeltStep.args ?? {}) as Record<string, unknown>;
    const item = String(a.item ?? ''), count = Math.max(1, Math.min(64, Number(a.count ?? 8) || 8));
    if (item) {
      const f = fuelFacts(s.inventory, item, count, p.storage?.stock);
      if (f) out.push(f);
    }
  }
  // 下矿的账、顺手采集、挖掘规模不在这里追加：它们不占 5 条提醒配额，由 decisionReminders 在切片后单独送达。
  // 工具分级事实不在这里追加：这里末尾只保留 5 条，挖掘场景前面常已有 3–8 条，
  // 放在这里会被 slice 截掉；由 buildMindMessages 在切片后单独追加，确保真的送达。
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
    out.push(`肉的账：这局已经打猎 ${hunting.trips} 次、大约 ${hunting.animals} 只，最近几次每次为了肉走 ${hunting.recentWalked ?? '?'} 格；现在看得见能吃的动物 ${seenNow} 只，128 格内记得的还有约 ${remembered} 只${feed.length ? `；背包里有 ${feed.join(' ')}` : ''}`);
  }
  // 回地面时给方向事实，不把历史矿道当成已确认的开口。
  if (SURFACE_INTENT.test(intent) && p.self.sky_visible !== true && p.self.surface_dir) {
    out.push(`往 ${p.self.surface_dir.dir} 方向约 ${p.self.surface_dir.dist} 格外先有天光，可能更接近洞口/地表（这条路是否可通未确认，走过去再核实）`);
  }
  // 过水：站在水边/水里时，把材料代价摆出来，怎么过由它定
  if (p.self.inWater || WATER_CROSS_INTENT.test(intent)) {
    const hint = waterCrossingHint(p, s);
    if (hint) out.push(hint);
  }
  if (where === 'indoors' && /坑|垫高|台阶|爬出|挖出去|出坑/.test(intent)) out.push(`你${p.self.where!.text}。刚才想的“坑”其实是屋子的墙`);
  // 没盖完的房子：久没碰了才提一句；一直在补却补不动，就把事实摆出来让它掂量够不够住（不再每一念都催“接着盖”）
  const site = unfinished[0];
  if (site) {
    const idleMin = (Date.now() - site.lastWorkedAt) / 60_000;
    if (site.attempts >= 5 && site.recentProgress !== null && site.recentProgress <= 2)
      out.push(`「${site.name}」已经验收过 ${site.attempts} 次，最近几次只少了 ${Math.max(0, site.recentProgress)} 处，还差 ${site.missing} 处：想想是不是已经够住了（够了就 build {"projectId":"${site.id}","mode":"accept"} 收工去做别的；不想要了就 abandon）`);
    else if (idleMin >= 20) out.push(`「${site.name}」还没盖完（还差 ${site.missing} 处）：想接着盖写 build {"projectId":"${site.id}"}；够住了就 accept，不想要了就 abandon`);
  }
  if (ctx.designing) out.push(`建筑师正在画「${ctx.designing.brief.slice(0, 40)}」，画好会告诉你：先攒常用的木头、石头，或做别的事`);
  else if (drafts.length) out.push(`图纸 ${drafts[0].id}「${drafts[0].name}」已经画好：按材料清单攒齐后 build {"draft":"${drafts[0].id}"}`);
  else if (!unfinished.length && /盖|建|房|住处|庇护|前哨|据点|补给点|仓库|畜栏|围栏|瞭望|塔|围墙|平台/.test(intent))
    out.push('要盖长期用的建筑（房子、前哨、仓库、畜栏、塔……）：用 {"kind":"design","brief":"…","where":"here|base"} 请建筑师画图纸，别自己画；画图要几现实分钟，一边画一边去攒料。应急的几块自己搭，施工只认露天干地');
  if (p.time.phase === 'dusk' || p.time.phase === 'night') {
    // 只报“天快黑了/天黑了”。床的位置走【记得的地方】my_bed（记忆模块）；“睡觉跳过夜晚”是游戏知识
    out.push(p.time.phase === 'dusk' ? '太阳在落山，天快黑了' : '天黑了');
  }
  if (p.self.food <= 8) out.push(`饿了（饥饿 ${p.self.food}）：留意吃的`);
  return out.slice(0, 5);
}

// 展示身体位置用「脚部占据格」（floor，与 local 图原点一致），不用四舍五入，避免与局部图推算出的绝对坐标差一格。
const pos3 = (p: [number, number, number]) => [Math.floor(p[0]), Math.floor(p[1] + 0.05), Math.floor(p[2])].join(',');

/**
 * 一次计划尝试的实测证据，压成一行给模型复盘。施工量、覆盖和目标证据分开：
 * “走 24 格已知通路”会显示 dug0/filled0/open24，而不是只显示 done。
 */
function attemptEvidenceText(e: PlanAttemptEvidence): string {
  const coord = (p: { x: number; y: number; z: number }) => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
  const route = e.from && e.to ? `路线${coord(e.from)}→${coord(e.to)}；` : '';
  const passage = `挖${e.dug}/补${e.filled}/原通${e.openSteps}`;
  const coverage = `新格${e.newChunks ?? '?'}/覆盖${Math.round(e.maxHorizontal)}格`;
  const target = e.found.length ? `看见${e.found.slice(0, 3).join('、')}` : e.located ? '目标已定位' : '目标未定位';
  const acquired = e.acquired === true ? '已取得' : e.acquired === false ? '未取得' : '取得未知';
  return `${route}${passage}；${coverage}；${target}，${acquired}`;
}

/** 【专注】：主目标、清单、手上的活是不是在推进它（放在消息靠后，模型最看得见的地方） */
function focusBlock(ctx: MindContext): Record<string, unknown> | null {
  const item = ctx.self.activeAgenda();
  const plan = ctx.plan;
  if (!item && !plan) return null;
  const goal = plan?.goal ?? item!.text;
  const next = plan?.steps.findIndex((st) => !st.done) ?? -1;
  const stall = plan ? ctx.self.planStallInfo() : null;
  return {
    goal, agenda_id: plan?.agendaId ?? item!.id,
    ...(plan ? { goal_age_wall_clock_min: Math.round((Date.now() - plan.setAt) / 60000), checklist: plan.steps.map((st, i) => {
      const held = !st.done ? gearAlreadyHeldInText(st.text, ctx.state.inventory, ctx.state.equipment) : null;
      return `${i}. [${st.done ? 'x' : ' '}] ${st.text}${st.id ? ` ${st.id}` : ''}${held ? `（其实不用做：${held}）` : ''}${st.done && st.auto ? '（条件达成，自动勾的）' : !st.done && st.doneWhen ? '（条件达成会自动勾）' : ''}`;
    }), ...(next >= 0 ? { next_item: next } : {}),
      ...(plan.methods?.some((m) => m.status === 'active') ? { methods: plan.methods.filter((m) => m.status === 'active').map((m) => ({
        id: m.id, text: m.text, ...(m.outcomeId ? { outcome: m.outcomeId } : {}), attempts: m.attempts,
        ...(Object.keys(m.stopReasons).length ? { stopped: m.stopReasons } : {}),
        ...(m.lastEvidence ? { last_evidence: attemptEvidenceText(m.lastEvidence) } : {}),
      })) } : {}),
      ...(plan.attempts?.length ? { recent_attempts: plan.attempts.slice(-3).map((a) => `${new Date(a.at).toISOString().slice(11, 16)}${a.where ? `@(${Math.floor(a.where.x)},${Math.floor(a.where.y)},${Math.floor(a.where.z)})` : ''} ${a.whatHappened}${a.whyStopped ? `（停因 ${a.whyStopped}）` : ''}${a.evidence ? `｜${attemptEvidenceText(a.evidence)}` : ''}`) } : {}),
      // 清单是成果；它可以是可验证的施工结果，不能按“开巷/挖 N 格”这类关键词把成果判成做法。
      checklist_note: '清单是成果，要可验证：可以是找到/到达/取得，也可以是“挖通到某坐标的巷/新开 N 格通道”这类可验收施工结果；methods 是当前做法，可换可停，换做法不删成果。改成果清单要在 plan 里写 steps（和 switch_reason 说明为什么删掉没做完的项）；给 activity 写 outcome_id/method_id 可把结果记到对应账上。',
      ...(plan.methods?.some((m) => m.status === 'active') ? { method_review_note: 'last_evidence/recent_attempts：dug/filled 才是新通道，openSteps 是本来就能直接走的覆盖，found/located/acquired 是目标证据；这几条路线/阻碍是不是同一个，由你对照最近几次判断，继续或换做法也由你决定' } : {}),
      // 独立进展账本：只投影当前目标摘要；详情用 {"kind":"progress"} 查，不每念展开。
      ...(() => {
        const nextOutcome = plan.steps.find((st) => !st.done);
        const trend = nextOutcome ? ctx.self.progressSummary(nextOutcome.id) : null;
        return trend ? { progress_trend: trend } : {};
      })(),
      // 进展的事实交给它自己判断：多久没勾掉一项、这期间做了几段活
      no_progress_observed_online_min: Math.round(stall!.minutes), ...(stall!.historyUnknown ? { earlier_online_time: '未知' } : {}),
      activities_since_progress: ctx.self.history(60).filter((r) => r.at > (plan.progressAt ?? plan.setAt)).length,
      // 改写清单不算推进：把这段时间改了几次、上次改在多久前摆出来，改不改仍由它定
      ...(() => {
        const rewrites = (plan.revisedAt ?? []).filter((t) => t > (plan.progressAt ?? plan.setAt));
        return rewrites.length ? { checklist_rewrites_since_progress: rewrites.length, last_rewrite_wall_clock_min_ago: Math.round((Date.now() - rewrites.at(-1)!) / 60000) } : {};
      })() } : { checklist: '还没有：写 plan' }),
    ...(ctx.activity ? { current_activity_for_goal: ctx.activity.agendaId === (plan?.agendaId ?? item!.id) } : {}),
    ...(ctx.suspended.length ? { will_resume_after_detour: ctx.suspended.map((a) => a.what) } : {}),
  };
}

const WEAR_SLOT: Record<string, string> = { head: '头', torso: '胸', legs: '腿', feet: '脚', 'off-hand': '副手' };
const DIM_ZH: Record<string, string> = { overworld: '主世界', the_nether: '下界', the_end: '末地' };
/** 【身体】：自己在哪、状态、时间、亮度、背包 */
function bodyState(p: Percept, s: AgentState, activity: Activity | null, habits: object) {
  const inv = new Map<string, number>();
  for (const i of s.inventory) inv.set(i.name, (inv.get(i.name) ?? 0) + i.count);
  const step = activity?.steps[Math.max(0, activity.index - 1)];
  const digging = !!step && ['gather', 'mine_cell', 'excavate_run', 'pillar_one'].includes(step.skill);
  const material = String((step?.args as Record<string, unknown> | undefined)?.block ?? '');
  const tool = /stone|ore|coal|iron|copper|deepslate/.test(material) ? 'pickaxe' : /dirt|grass|sand|gravel|clay/.test(material) ? 'shovel' : /log|wood/.test(material) ? 'axe' : undefined;
  // 挖的时候手上有能挖的工具就不换；不能挖才按上次亲手选的同种工具、否则最快的工具换背包里能挖的；要提醒的是“背包里根本没有合适的工具”
  const ownsTool = tool ? [...inv.keys()].some((n) => n.endsWith(`_${tool}`)) : true;
  const wornBySlot = new Map((s.equipment ?? []).map((e) => [e.slot, e]));
  const ARMOR_SLOT: Record<string, string> = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
  // 背包里的护甲/盾不会自己生效：把槽位现状和这件并排写出来（穿哪件、要不要换由它定）
  const wearables = s.inventory.flatMap((it) => {
    const slot = it.name === 'shield' ? 'off-hand' : it.name === 'elytra' ? 'torso' : ARMOR_SLOT[it.name.split('_').at(-1) ?? ''];
    if (!slot || it.count <= 0) return [];
    const worn = wornBySlot.get(slot);
    const now = worn
      ? `现穿着 ${worn.name}${worn.durabilityRemaining !== undefined ? `（耐久 ${worn.durabilityRemaining}${worn.durabilityMax ? `/${worn.durabilityMax}` : ''}）` : ''}`
      : '空着';
    return [`${it.name}${durabilityText(it)}，${WEAR_SLOT[slot]}槽${now}`];
  });
  // 空槽少时，说清哪些未满的同类堆还能继续接收：0 个空槽不等于什么都捡不起来
  const stackRoom = s.inventory.flatMap((it) => {
    const size = it.stackSize;
    if (!size || size <= 1 || !it.stacks?.length) return [];
    const free = it.stacks.reduce((n, st) => n + Math.max(0, size - st.count), 0);
    return free > 0 ? [{ name: it.name, free }] : [];
  }).sort((a, b) => b.free - a.free);
  const roomText = `${stackRoom.slice(0, 6).map((r) => `${r.name} 还能装 ${r.free} 个`).join('、')}${stackRoom.length > 6 ? ` 等 ${stackRoom.length} 种` : ''}`;
  // 同名同材质装备有两件以上：工作台能合成修理；穿在身上的那件不在背包里，不能直接放进合成格
  const gearPieces = new Map<string, string[]>();
  for (const it of s.inventory) {
    if (!it.durability) continue;
    const parts = (it.durabilities?.length ? it.durabilities : [it.durability.left]).map((left) => `背包 ${left}/${it.durability!.max}`);
    gearPieces.set(it.name, [...(gearPieces.get(it.name) ?? []), ...parts]);
  }
  for (const e of s.equipment ?? []) {
    if (e.durabilityRemaining === undefined) continue;
    gearPieces.set(e.name, [...(gearPieces.get(e.name) ?? []), `身上 ${e.durabilityRemaining}${e.durabilityMax ? `/${e.durabilityMax}` : ''}`]);
  }
  const mergeable = [...gearPieces].filter(([, parts]) => parts.length >= 2).slice(0, 4)
    .map(([name, parts]) => `${name} ${parts.length} 件（${parts.slice(0, 4).join('、')}${parts.length > 4 ? '…' : ''}）`);
  return {
    ...(p.self.where ? { where: p.self.where.text } : p.self.overhead ? { overhead: p.self.overhead.block ? `头顶 ${p.self.overhead.up} 格是 ${p.self.overhead.block}` : '头顶一直空着' } : {}),
    pos: pos3(p.self.pos), dim: `${DIM_ZH[p.self.dim] ?? p.self.dim}（${p.self.dim}）`, biome: p.self.biome, sky_visible: p.self.sky_visible ?? null,
    // 血量保留一位小数：半颗心四舍五入成 0 会让模型以为自己已经死了
    hp: Math.round(p.self.hp * 10) / 10, food: p.self.food,
    ...(p.self.inWater ? { inWater: true, oxygen: s.oxygen } : {}), ...(p.self.inLava ? { inLava: true } : {}), ...(p.self.riding ? { riding: p.self.riding } : {}),
    // 触觉事实：身体 AABB 正压着的门方块（不受视野限制）；不在此格时省略，避免每念都占字数
    ...(p.self.body_in_portal ? { body_in_portal: p.self.body_in_portal } : {}),
    ...(s.dim === 'overworld' ? { time: sunText(p.time.timeOfDay) } : { time: `${DIM_ZH[s.dim] ?? '这里'}没有昼夜（光照恒定）` }),
    ...(s.dim === 'overworld' && p.time.can_sleep === false ? { can_sleep: '还不能睡：要等天黑后（雷雨时随时能睡）' } : {}),
    ...(p.time.weather ? { weather: p.time.weather } : {}),
    ...(p.light ? { light: `${{ bright: '亮', dim: '有点暗', dark: '很暗' }[p.light.level] ?? p.light.level}${p.light.mob_spawn_risk ? '，会刷怪' : ''}` } : {}),
    held: p.self.held ? `${p.self.held}${s.heldDurability ? `（耐久 ${s.heldDurability.left}/${s.heldDurability.max}${s.heldDurability.left / s.heldDurability.max < 0.15 ? `，快坏了${spareNote(s.inventory.find((i) => i.name === p.self.held), s.heldDurability)}` : ''}）` : ''}` : p.self.held,
    // 身上穿戴的（盔甲、副手）：不在背包里，空槽也写出来，不写它就以为自己还穿着
    wearing: Object.fromEntries(['head', 'torso', 'legs', 'feet', 'off-hand'].map((slot) => {
      const e = wornBySlot.get(slot);
      return [WEAR_SLOT[slot], e ? `${e.name}${e.durabilityRemaining !== undefined ? `（耐久 ${e.durabilityRemaining}${e.durabilityMax ? `/${e.durabilityMax}` : ''}）` : ''}` : '空'];
    })),
    ...(digging && tool && !ownsTool ? { tool_note: `正在挖 ${material}，背包里没有 ${tool}（只能空手挖，很慢）` } : {}),
    // 效率/抠门的双面事实：最近挖了很多，更快/更省的工具各是什么（只给事实，换不换由它定）
    ...(p.efficiency?.length ? { dig_effort: p.efficiency.slice(0, 2).map((e) => effortFacts(e, s.inventory, p.storage?.stock).join('；')) } : {}),
    // 工具、武器、护甲带上耐久（像物品栏里那条耐久条）；附魔的标出来
    inventory: [...inv].map(([name, count]) => {
      const it = s.inventory.find((i) => i.name === name);
      const stackSize = it?.stackSize;
      const multi = stackSize && count > stackSize && it?.stacks?.length ? `，共 ${it.stacks.length} 叠` : '';
      const stacks = s.emptySlots <= 5 && stackSize && stackSize > 1 && it?.stacks?.length
        ? `；${it.stacks.map((stack) => `槽${stack.slot} ${stack.count}/${stackSize}，该叠可再放 ${stackSize - stack.count} 个数据相同的物品`).join('；')}` : '';
      return `${name}×${count}${isTreeSaplingItem(name) ? '（可种）' : ''}${it?.stackSize ? `（每叠上限 ${it.stackSize}${multi}${stacks}）` : ''}${durabilityText(it)}${it?.enchanted ? '（附魔）' : ''}`;
    }), empty_slots: `${s.emptySlots} 个空槽（每槽放一叠，不是一件）`,
    ...(wearables.length ? { wearables_in_backpack: `背包里的护甲/盾（穿到对应槽才生效）：${wearables.join('；')}` } : {}),
    ...(mergeable.length ? { mergeable_gear: `${mergeable.join('；')}。同名同材质装备可在工作台/砂轮合成修理：结果耐久 = min(满耐久, 两件耐久之和 + 满耐久5%)；铁砧是 +满耐久12%（耗经验、保留普通附魔）。两件耐久之和超过满耐久时，多出的耐久会被丢掉、合计耐久反而下降，只换来一个空槽；合不合由你定。穿在身上的那件不在背包里，不能直接放进合成格。` } : {}),
    // 精确账本的总表（箱子+背包合计）：供"物资充足/稀缺"量化；箱子部分是最后打开时记的，之后世界可能变化
    ...(p.storage?.stock?.length ? { stored_stock: `${p.storage.stored}；以上是「箱子+背包」合计，按最后一次打开各箱子时记录（之后世界可能变化，重新打开才更新）` } : {}),
    ...(s.connected && s.emptySlots <= 5 ? { inventory_space: s.emptySlots > 0
      ? `空槽是能新放一整叠的位置，${s.emptySlots} 个空槽由所有物品共用（例如 64 个铁矿石只占 1 个空槽）${roomText ? `；未满的同类堆还能继续装：${roomText}` : '；现有物品堆都已满'}`
      : `没有空槽${roomText ? `，但未满的同类堆还能继续装：${roomText}——这些同类掉落物捡得起来` : '，现有物品堆都满了——新物品捡不进来，先腾空槽或把同类未满堆并起来'}` } : {}),
    ...(s.effects?.length ? { effects: s.effects.map((e) => `${e.name}${e.level > 1 ? ` ${e.level} 级` : ''}，${e.seconds > 0 ? `剩余时间按正常速度估算为${durationText(realSecondsToTicks(e.seconds))}现实时间` : '剩余时长未知或接近结束'}`) } : {}),
    ...(s.xp ? { xp_level: s.xp.level } : {}),
    // 背包里的食物各值多少（生的顺带说烤熟后值多少）：只给事实，吃不吃、烤不烤由它自己定
    ...([...inv.keys()].some((n) => foodNote(n)) ? { food_values: Object.fromEntries([...inv.keys()].filter((n) => foodNote(n)).map((n) => [n, foodNote(n)])) } : {}),
    habits,
  };
}

function surroundingsOf(p: Percept, tier: 'glance' | 'deliberate', memory: WorldMemory) {
  const v = p.vision;
  const n = tier === 'glance' ? 5 : 10;
  const here = p.self.pos;
  const placed = memory.queryPlacedNear({ x: here[0], y: here[1], z: here[2] }, 8, p.self.dim);
  return {
    ...(p.self.local ? { local: p.self.local } : {}),
    ...(p.self.around ? { around: p.self.around } : {}),
    // 身体占据的两格是触觉事实（不受视野限制）：站在门方块/水里时，别只报“脚下”的支撑格。
    ...(p.self.contacts ? { body_cells: {
      feet: p.self.contacts.feet.block,
      head: p.self.contacts.head.block,
    } } : {}),
    exits: p.self.exits ?? null,
    hostile: p.nearby.hostile.slice(0, 5), passive: p.nearby.passive.slice(0, 6), players: p.nearby.players,
    see_now: p.nearby.resources.filter((r) => r.seen === 'now').slice(0, n).map((r) => `${r.block}×${r.count} ${r.dir ?? ''}${r.nearest}格`),
    ...(placed.length ? { nearby_placed: placed.slice(0, 5).map((b) => `${b.name}（${dirName(b.pos.x - here[0], b.pos.z - here[2])} ${Math.round(b.dist)}格，自己放的）`).join('、') } : {}),
    ...(v ? { facing: v.facing, view: v.view, ...((v as any).visible_drops?.length ? { drops: (v as any).visible_drops.slice(0, 4) } : {}),
      ...(v.nearest_land ? { nearest_land: v.nearest_land } : {}),
      ...(v.recent_sightings?.length ? { recent_sightings: { dimension: p.self.dim, source: 'past_visual_observation',
        currently_visible: false, sightings: v.recent_sightings.slice(0, tier === 'glance' ? 3 : 6) } } : {}) } : {}),
    ...(tier === 'deliberate' && p.curiosities.length ? { curious_about: p.curiosities.slice(0, 5).map((c) => `${c.what} ${c.dir}${c.dist}格`) } : {}),
    ...(p.death_recovery ? { my_dropped_items: {
      dir: p.death_recovery.dir, dist: p.death_recovery.dist, lost: p.death_recovery.lost,
      lifetime: p.death_recovery.seconds_left > 0
        ? `假设区块持续加载且正常速度，估计还剩${durationText(realSecondsToTicks(p.death_recovery.seconds_left))}现实时间；实际状态未知`
        : '按区块持续加载且正常速度估算已过常规寿命；实际状态未知',
    } } : {}),
  };
}

function worldKnowledge(ctx: MindContext) {
  const p = ctx.percept, s = ctx.state, m = ctx.memory;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  // 八个方向身边到访覆盖；瞥一眼也给“没进过区块”的方向，移动中就不用靠猜往回走。
  const around = exploredAround(m, p.self.dim, p.self.pos);
  const untouched = Object.entries(around).filter(([, seen]) => seen === UNEXPLORED_LABEL).map(([dir]) => dir);
  // 相对自己的方位、水平距离与高差：坐标换算方向容易算反，直接给出
  const bearing = (pos: Vec3Like) => {
    const d = Math.round(Math.hypot(pos.x - here.x, pos.z - here.z)), dy = Math.round(pos.y - here.y);
    return `${d ? `${dirOf(here, pos)} ` : ''}${d}格${dy ? `，${dy > 0 ? '高' : '低'} ${Math.abs(dy)} 格` : ''}`;
  };
  // 自己的设施（箱子、工作站、床）在 my_facilities 里单独说，这里只列别的地点
  // 矿点按矿种单独列（ore_spots），不和死亡点、基地挤这 8 个位置
  const places = m.landmarks().filter((l) => l.dim === p.self.dim && l.worldId === s.worldId && !FACILITY_LABELS.has(l.label) && !(l.kind === 'resource' && isResourceBlock(l.label)) && l.kind !== 'herd')
    .map((l) => isContainerLandmark(l.label) ? { ...l, ...chestLocation(l) } : { ...l, radius: 0, precise: true })
    .map((l) => ({ l, d: Math.hypot(l.pos.x - here.x, l.pos.z - here.z) })).sort((a, b) => a.d - b.d).slice(0, 8)
    .map(({ l }) => `${l.label}[${l.id}] (${Math.round(l.pos.x)},${Math.round(l.pos.y)},${Math.round(l.pos.z)}) ${bearing(l.pos)}`);
  const facilities = ctx.tier === 'deliberate' ? myFacilities(m, { worldId: s.worldId, dim: p.self.dim, pos: here }, ['chest', 'station']).slice(0, 8).map((f) => f.text) : [];
  const danger = m.hazards(p.self.dim).map((h) => ({ h, d: Math.round(Math.hypot(h.pos.x - here.x, h.pos.z - here.z)) })).filter((e) => e.d < 96).slice(0, 4)
    .map(({ h, d }) => `${h.kind} @(${h.pos.x},${h.pos.y},${h.pos.z}) ${d}格，出过 ${h.count} 次事`);
  // 最近几次死亡地点（事实，不分维度）：Agent 自己判断要不要回到最远点继续，还是绕开
  const lastDeaths = (p.last_deaths ?? []).map((death) => {
    const ago = death.seconds_ago < 90 ? `${death.seconds_ago} 秒前` : death.seconds_ago < 3600 ? `${Math.round(death.seconds_ago / 60)} 分钟前` : `${Math.round(death.seconds_ago / 3600)} 小时前`;
    return `${death.dim} (${death.pos[0]},${death.pos[1]},${death.pos[2]})，${death.cause}，${ago}`;
  });
  const bed = myBed(m, { dim: p.self.dim, worldId: s.worldId, pos: here }, ctx.blockAt);
  const portalSnapshot = travelStore(m).snapshot(s.worldId);
  const endpointById = new Map(portalSnapshot.endpoints.map((e) => [e.id, e]));
  // 只列当前维度、离自己最近的几处门：别的维度的门走不过去，只在 leads_to 里说明落点；
  // 方块核对用的是当前维度的区块数据，跨维度的坐标查出来的不是那扇门。
  const portals = portalSnapshot.endpoints.filter((e) => e.dim === p.self.dim)
    .map((e) => ({ e, d: Math.hypot(e.pos.x - here.x, e.pos.z - here.z) })).sort((a, b) => a.d - b.d).slice(0, 4)
    .map(({ e }) => {
      // 同一目的地的路线可能被重复登记：只按「目的地 + 回程是否验证过」列一次
      const leadsTo = [...new Map(portalSnapshot.routes.filter((r) => r.fromId === e.id)
        .map((r) => {
          const to = endpointById.get(r.toId);
          return [`${r.toId}:${r.returnVerified}`, { to: r.toId, ...(to ? { dim: to.dim, pos: to.pos } : {}), return_verified: r.returnVerified }];
        })).values()];
      const nowBlock = ctx.blockAt?.(e.pos) ?? null;
      // 证据是客户端已加载的区块数据，只核对记录坐标这一格，不是这次视野亲眼看见
      const now = nowBlock === null ? '区块未加载(未知)'
        : nowBlock === e.kind ? `记录格仍是 ${e.kind}（区块数据）`
        : `记录格现为 ${nowBlock}（区块数据，非视野所见）`;
      return {
        id: e.id, kind: e.kind, pos: e.pos, from_here: bearing(e.pos),
        portal_observed: e.portalObserved ? '亲见门' : '仅到达位置',
        recorded_ago: portalAgeText(e.observedAt),
        ...(leadsTo.length ? { leads_to: leadsTo } : {}), now,
      };
    });
  // 本维度去过多远：explored_around 只抽样身边 32–128 格，看不到更远处走过的路；这里只给历史事实，不选方向。
  const extent = ctx.tier === 'deliberate' ? m.visitedExtent(p.self.dim) : null;
  const visitedExtent = extent === null || extent.bounds === null ? null : [
    `访问过 ${extent.chunks} 个区块，外框 x ${extent.bounds.minX}..${extent.bounds.maxX}、z ${extent.bounds.minZ}..${extent.bounds.maxZ}`,
    '只是走过的历史记录，不代表那片看全了',
  ].join('；');
  // 出行记录：本维度最近几段，以及身边 16 格内的门通往的维度最近几段（站在门前要不要进、带什么，由它掂量）。
  // 按数据是否存在给出，不看打算的措辞。
  const legs = (ctx.excursions ?? []).filter((l) => l.worldId === s.worldId && l.onlineMs >= 60_000);
  // 当前这一趟不按 60 秒过滤：刚出发的几分钟也要能看到方向覆盖与最近探索。
  const currentLeg = (ctx.excursions ?? []).find((l) => !l.end && l.worldId === s.worldId && l.dim === p.self.dim);
  const currentTrip = currentLeg ? describeCurrentTrip(currentLeg) : null;
  const portalNear = (dim: string) => (pos: Vec3Like) => portalSnapshot.endpoints
    .filter((e) => e.dim === dim && Math.hypot(e.pos.x - pos.x, e.pos.y - pos.y, e.pos.z - pos.z) <= 6)
    .sort((a, b) => Math.hypot(a.pos.x - pos.x, a.pos.z - pos.z) - Math.hypot(b.pos.x - pos.x, b.pos.z - pos.z))[0]?.id ?? null;
  const tripsHere = ctx.tier === 'deliberate' ? legs.filter((l) => l.dim === p.self.dim).slice(-3)
    .map((l) => describeLeg(l, { here, portalNear: portalNear(l.dim) })) : [];
  const beyond = [...new Set(portalSnapshot.endpoints
    .filter((e) => e.dim === p.self.dim && Math.hypot(e.pos.x - here.x, e.pos.y - here.y, e.pos.z - here.z) <= 16)
    .flatMap((e) => portalSnapshot.routes.filter((r) => r.fromId === e.id).map((r) => endpointById.get(r.toId)?.dim))
    .filter((d): d is string => !!d && d !== p.self.dim))];
  const tripsBeyond = ctx.tier === 'deliberate'
    ? beyond.flatMap((dim) => legs.filter((l) => l.dim === dim).slice(-3).map((l) => describeLeg(l, { portalNear: portalNear(dim) }))) : [];
  const builds = myBuilds(m, { worldId: s.worldId, dim: p.self.dim, pos: here });
  const home = homeOf(m, { worldId: s.worldId, dim: p.self.dim, pos: here });
  // 移动动作里的 "base" 只指一处（首选基地）；记得好几个基地时把它指哪、有多远摆出来，免得把别的基地当成 "base"
  const aliasBase = m.base(p.self.dim);
  const otherBases = m.landmarks().filter((l) => l.kind === 'base' && l.dim === p.self.dim && l.id !== aliasBase?.id).length;
  const baseAlias = aliasBase && otherBases
    ? `；移动目标写 "base" 指 ${aliasBase.label}（${Math.round(Math.hypot(aliasBase.pos.x - here.x, aliasBase.pos.z - here.z))} 格外），另记得 ${otherBases} 处基地，去别处写地标名或坐标`
    : '';
  const drafts = activeDrafts()?.list(4).filter((d) => !d.usedBy) ?? [];
  const remember = p.nearby.resources.filter((r) => r.seen === 'memory').slice(0, ctx.tier === 'glance' ? 3 : 6).map((r) => `${r.block} ${r.dir ?? ''}${r.nearest}格`);
  // 记得的矿点：每种矿最近的一两处（带高低差），瞥一眼也看得到——想挖铁时知道铁在哪
  const ores = oreSpotsByKind(oreSpotsNear(m.resourceLandmarksAround(p.self.dim, here, 256), { worldId: s.worldId, dim: p.self.dim, pos: here }), ctx.tier === 'glance' ? 1 : 2, ctx.tier === 'glance' ? 5 : 8);
  // 记得的生物出没点（不主动攻击的：羊、牛、狼、村民……）：动物会走动，只是大概那一带，带着多久前看见
  const herds = creatureSpotsByKind(creatureSpotsNear(m.landmarks(), { worldId: s.worldId, dim: p.self.dim, pos: here }), 1, ctx.tier === 'glance' ? 5 : 10);
  return {
    home: `${home ? `${home.label} 在${home.dir}边 ${home.dist} 格 (${Math.round(home.pos.x)},${Math.round(home.pos.y)},${Math.round(home.pos.z)})` : '还没有家'}${baseAlias}`,
    ...(bed ? { my_bed: `(${bed.pos.x},${bed.pos.y},${bed.pos.z}) ${bed.dist}格；要确认它还在不在，直接 inspect_block 这个坐标` } : {}),
    ...(builds.length ? { my_builds: builds.map(describeBuild) } : {}),
    // 建筑师画好、还没盖的图纸：一直惦记着
    ...(drafts.length ? { my_drafts: drafts.map((d) => `${d.id}「${d.name}」${d.size.width}×${d.size.depth}，用料 ${Object.entries(d.materials).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n}×${c}`).join('、')}`) } : {}),
    ...(remember.length ? { resources_seen_before: remember } : {}),
    ...(Object.keys(ores).length ? { ore_spots: ores } : {}),
    ...(Object.keys(herds).length ? { animal_spots: herds } : {}),
    ...(ctx.tier === 'glance' && untouched.length ? { unexplored_near: `身边 8 个方向在 32–128 格各抽 7 个采样环，这些方向的到访记录很少（不到四分之一，不分地上地下）：${untouched.join('、')}；只是抽样到访记录，不代表没去过、没有东西、看全或现在能走，往哪去由你判断` } : {}),
    ...(ctx.tier === 'deliberate' ? { places, ...(facilities.length ? { my_facilities: facilities } : {}), ...(portals.length ? { portals } : {}), explored_around: around,
      explored_around_note: 'explored_around 是身边 32–128 格八个方向各抽 7 个采样环的历史到访，只说明抽样处有没有进过区块，不代表看全或现在能走；要看记录里去过的整体范围与各方向未到访边缘，用 {"skill":"spatial_extrema","args":{"metric":"explored"}}（只读，往哪去由你判断）', ...(visitedExtent === null ? {} : { visited_extent: visitedExtent }) } : {}),
    ...(currentTrip ? { current_trip: currentTrip, current_trip_note: '本趟=当前这段出行；各方向最远是身体站稳过的脚格，最近探索是任务回执的实测推进；现在能否续走未确认，坐标可直接作为移动目标' } : {}),
    ...(ctx.tier === 'deliberate' && tripsHere.length ? { my_trips_in_this_dimension: tripsHere } : {}),
    ...(reachLines(ctx, here, 32).length ? { walked_farthest: { from: `(${ctx.reach!.origin.x},${ctx.reach!.origin.y},${ctx.reach!.origin.z}) 起算`, by_direction: reachLines(ctx, here, 32),
      note: `身体实际站过的脚格（体素到访记录，${Math.round((Date.now() - ctx.reach!.at) / 60_000)} 分钟前读取${ctx.reach!.truncated ? '，没读完全部区段' : ''}）；现在能否走通未确认，沿途也不等于看全了；坐标可以直接作为移动目标` } } : {}),
    ...(ctx.tier === 'deliberate' && tripsBeyond.length ? { my_trips_beyond_nearby_portal: tripsBeyond } : {}),
    ...(ctx.tier === 'deliberate' && (tripsHere.length || tripsBeyond.length) ? { trips_note: LEG_NOTE } : {}),
    ...(danger.length ? { danger_zones: danger } : {}),
    ...(lastDeaths.length ? { last_deaths: lastDeaths } : {}),
    // 自己开了头、要等它自己变化的事：离开时留下的样子和现在看得到的样子
    ...(p.waiting_on?.length ? { waiting_on: p.waiting_on } : {}),
  };
}

/** 各方位最远到访点里离起点至少 min 格的，按远近排；附上相对现在位置的方位与距离。 */
function reachLines(ctx: MindContext, here: Vec3Like, min: number): string[] {
  const reach = ctx.reach;
  if (!reach || reach.dim !== ctx.percept.self.dim) return [];
  return Object.entries(reach.sectors).filter(([, s]) => s.distance >= min).sort((a, b) => b[1].distance - a[1].distance).slice(0, 4).map(([dir, s]) => {
    const dx = s.pos.x + 0.5 - here.x, dz = s.pos.z + 0.5 - here.z, d = Math.round(Math.hypot(dx, dz));
    return `${dir} ${s.distance} 格 (${s.pos.x},${s.pos.y},${s.pos.z})，在你 ${dirName(dx, dz)} ${d} 格`;
  });
}

/** 历史采集回执的提示词写法：数量是当时的实际物品差量，不代表当前背包。 */
function collectionSnapshot(c: NonNullable<ActivityRecord['collection']>) {
  return `采集 ${c.items.join('/')} ${c.initial}→${c.final}（目标 ${c.target}${c.targetMet ? '，已达成' : '，未达成'}；实得 +${c.gained}，挖了 ${c.dug} 块${c.lost ? `，${c.lost} 块掉落物没捡到` : ''}）；动作 ${c.skill} ${argsLabel({ skill: c.skill, args: c.args ?? {} })} @ ${new Date(c.at).toISOString()}；历史采集回执，不代表当前背包`;
}

function recordLine(r: ActivityRecord, memory: WorldMemory, dimension: string) {
  const g = Object.entries(r.gained).slice(0, 6).map(([k, v]) => `${k}+${v}`).join(' ');
  const l = Object.entries(r.lost).slice(0, 4).map(([k, v]) => `${k}-${v}`).join(' ');
  return { what: recallText(r.what, memory, dimension, r.at), outcome: r.completion === 'condition' ? 'condition_met' : r.outcome, took_real_s: r.durationSec, ...(g ? { gained: g } : {}), ...(l ? { used: l } : {}), summary: recallText(r.summary, memory, dimension, r.at),
    ...(r.stop ? { stop: `${r.stop.reason}${r.stop.detail ? `：${r.stop.detail.slice(0, 120)}` : ''}` } : {}),
    ...(r.facing ? { facing: r.facing } : {}),
    ...(r.collection ? { collection: collectionSnapshot(r.collection) } : {}),
    ...(r.expect ? { i_expected: recallText(r.expect, memory, dimension, r.at) } : {}), ...(r.hypothesis ? { hypothesis: recallText(r.hypothesis, memory, dimension, 0) } : {}) };
}

export function buildMindMessages(ctx: MindContext): ChatMessage[] {
  const self = ctx.self, p = ctx.percept, s = ctx.state;
  const context = [ctx.activity?.what, ctx.lastRecord?.what, ...ctx.noticed.map((n) => n.what), ...self.agenda().map((a) => a.text),
    ...p.nearby.resources.slice(0, 6).map((r) => r.block), ...s.inventory.slice(0, 10).map((i) => i.name)].filter(Boolean).join(' ');
  const image = self.selfImage();
  const glance = ctx.tier === 'glance';
  const knowHow = self.relevantKnowHow(context, ctx.activity?.kind, glance ? 3 : 6);
  // 以前查过的资料摘录：只放最近的几条；瞥一眼少带，仍是外部参考，不是现场事实。
  const knowledgeFacts = self.knowledgeFacts(glance ? 3 : 6);
  // 恢复类技能由行为引擎在失败时自动接手，系统索引已按组列出；这里只保留需要手动
  // 写进 routine 的做法，避免同一批技能名在 system 和 user 消息里重复出现。
  const learnedSkills = (ctx.learnedSkills ?? []).filter((line) => !line.includes('失败时先试'));
  // 分块，越往后越要紧：背景 → 记得的 → 最近 → 手上的活 → 身边 → 身体 → 此刻
  const sections: [string, Record<string, unknown>][] = [
    ['我', {
      traits: self.data.traits, feeling: moodWords(self.mood), ...(self.tastes().length ? { likes: self.tastes() } : {}),
      ...(!glance && (image.goodAt.length || image.struggleWith.length) ? { self_image: image } : {}),
      agenda: self.agenda().map((a) => ({ id: a.id, text: a.text, kind: a.kind, horizon: a.horizon, ...(a.status === 'active' ? { focus: true } : {}), ...(a.attempts ? { tried: a.attempts } : {}) })),
      ...(self.agenda().length || ctx.plan ? { agenda_and_plan_source: '议程与【专注】里的目标、清单是你自己保存的计划；其中的方法或“操作者指令”等标注不等于操作者原话。当前指令以单独的【操作者的指令】为准。' } : {}),
      know_how: knowHow.map((k) => ({ id: k.id, text: recallText(cleanLesson(k.text), ctx.memory, undefined, k.source === 'observed' ? k.createdAt : 0), wins: k.wins, losses: k.losses, unverified: k.unverified === true, source: k.source,
        ...(k.prior ? { before_rewrite: `改写前的说法累计 ${k.prior.wins} 胜 ${k.prior.losses} 负（改写过 ${k.prior.revisions} 次）` } : {}),
        ...(k.unverified === true && !k.signature && !(k.applications?.length) ? { evidence: 'none' } : {}),
        ...(k.applications?.length ? { applications: k.applications.reduce((n, a) => ({ count: n.count + 1, done: n.done + Number(a.outcome === 'done' && a.completion !== 'condition' && a.completion !== 'attempt' && !a.searchUnconfirmed && !a.limited), stuck: n.stuck + Number(a.outcome === 'stuck') }), { count: 0, done: 0, stuck: 0 }) } : {}),
        ...(k.counterexamples?.length ? { counterexamples: { count: k.counterexamples.length, last: `${k.counterexamples[k.counterexamples.length - 1]!.reason}：${k.counterexamples[k.counterexamples.length - 1]!.summary.slice(0, 80)}`, ...(k.counterexamples[k.counterexamples.length - 1]!.claim ? { against: k.counterexamples[k.counterexamples.length - 1]!.claim!.slice(0, 80) } : {}) } } : {}),
        ...(k.limits?.length ? { limits: k.limits.slice(0, 4) } : {}) })),
      ...(knowHow.length ? { know_how_note: 'source=来源；unverified=true 是尚未验证；before_rewrite 是这条改写/合并前旧说法的成败，wins/losses 只计现在这个说法；evidence=none 是没有动作签名或应用证据的暂定结论；counterexamples 是明确应用后失败/受阻的反例（改写/合并后仍保留）；limits 是 Agent 写下的适用边界；要按某条窍门做，在 activity/next 写 applying:"k_…"，applications 是这类明确应用的结果计数，只供复核，不等于自动证明结论正确' } : {}),
      ...(knowledgeFacts.length ? { knowledge_facts: knowledgeFacts.map(knowledgeFactLine),
        knowledge_facts_note: '以前查到的外部资料摘录（reference_not_current_state）：不是当前世界已有资源或现场事实；是否适用、采用与否由你判断。' } : {}),
      ...(!glance && self.experiments().length ? { experiments: self.experiments().map((e) => ({ hypothesis: recallText(e.hypothesis, ctx.memory, undefined, 0), status: e.status, ...(e.evidence ? { evidence: recallText(e.evidence, ctx.memory, undefined, e.at) } : {}) })) } : {}),
      ...(!glance && self.diary().length ? { diary: self.diary(5).map((d) => recallText(d.text, ctx.memory, undefined, 0)) } : {}),
      // 学会的东西只列一张表：从经历里验证过的做法（直接写成一步）；恢复类技能不在这里重复。
      ...(!glance && (learnedSkills.length || ctx.mySkills.length) ? { my_skills: [...learnedSkills.slice(0, 12),
        ...ctx.mySkills.slice(0, 6).map((m) => `${m.name}［${m.status === 'verified' ? '验证过的做法' : m.status === 'macro' ? '组合' : '试验中的做法'}，直接写成一步 {"skill":"${m.name}"}］：${m.description.slice(0, 50)}`)] } : {}),
      ...(!glance && ctx.instincts ? { body_instincts: ctx.instincts } : {}),
      ...(!glance && ctx.researchContext ? { research: ctx.researchContext } : {}),
    }],
    ['记得的地方', worldKnowledge(ctx)],
    ...(ctx.progress ? [['进度', {
      mainline: `已完成 ${ctx.progress.reached}/${ctx.progress.total} 个里程碑${ctx.progress.done.length ? `（最近达成：${ctx.progress.done.join('、')}）` : ''}`,
      branches: ctx.progress.branches.map((b) => ({ group: b.group, reached: `${b.done}/${b.total}`, ...(b.next.length ? { untouched: b.next } : {}) })),
    }] as [string, Record<string, unknown>]] : []),
    ...(ctx.recalled?.length || ctx.hindsightMemories?.length || ctx.openedSkill ? [['想起来的', {
      ...(ctx.recalled?.length ? { memories: ctx.recalled.map((r) => `[${RECALL_LABEL[r.kind]}${r.match === 'current_goal' ? '·当前目标' : r.match === 'execution_gap' ? '·执行缺口' : '·历史'}] ${r.text}`) } : {}),
      ...(ctx.hindsightMemories?.length ? { long_term: ctx.hindsightMemories.map((m) => `[${m.kind === 'experience' ? '经历' : '推断'}·长期记忆] ${m.text}`) } : {}),
      ...(ctx.hindsightMemories?.length ? { long_term_note: '长期记忆是合并后的历史经历或推断，不等于当前现场事实；现场以【身边】【身体】为准。' } : {}),
      ...(ctx.openedSkill ? { skill_opened: { name: ctx.openedSkill.name, text: ctx.openedSkill.body } } : {}),
    }] as [string, Record<string, unknown>]] : []),
    ['最近', {
      ...(!glance ? { recent_activities: self.history(5).filter((r) => r !== ctx.lastRecord).map((r) => recordLine(r, ctx.memory, s.dim)) } : {}),
      ...(ctx.lastRecord ? { last_activity: recordLine(ctx.lastRecord, ctx.memory, s.dim) } : {}),
      stream: self.recentThoughts(glance ? 4 : 8).map((t) => `${t.kind === 'monologue' ? '[此前想法，未经核实]' : `[${t.kind}]`} ${recallText(t.text, ctx.memory, undefined, t.kind === 'outcome' || t.kind === 'notice' ? t.at : 0)}`),
    }],
    ['手上的活', {
      current_activity: ctx.activity ? describeActivity(ctx.activity, s, p, ctx.runningStep ?? undefined) : null,
      ...(ctx.activity?.why ? { activity_reason_source: '当前活动的 why 是先前选择的理由，不等于观测事实；动作反馈和当前观察可用于核对' } : {}),
      ...(ctx.suspended.length ? { will_resume_after: ctx.suspended.map((a) => a.what) } : {}),
      ...(ctx.next ? { queued_next: `已经想好接下来做「${ctx.next.what}」${ctx.next.why ? `（${ctx.next.why}）` : ''}` } : {}),
      ...(ctx.next?.requires ? { queued_next_requires: `「${ctx.next.what}」开始前会按当时状态验收这个前置条件（未满足或无法确认就不会启动，交回你重新决定）：${JSON.stringify(ctx.next.requires)}` } : {}),
      ...(ctx.designing ? { architect_drawing: ctx.designing.brief.slice(0, 60) } : {}),
      ...(ctx.repeatedFailures?.length ? { repeated_failures: ctx.repeatedFailures } : {}),
      ...(ctx.notes.length ? { last_decision_corrections: ctx.notes } : {}),
    }],
    ['身边', surroundingsOf(p, ctx.tier, ctx.memory)],
    ['身体', bodyState(p, s, ctx.activity, self.habits())],
    ...(focusBlock(ctx) ? [['专注', focusBlock(ctx)!] as [string, Record<string, unknown>]] : []),
    ...(ctx.stageReview ? [['阶段回顾', ctx.stageReview] as [string, Record<string, unknown>]] : []),
    ...(ctx.progressGate ? [['无进展', ctx.progressGate] as [string, Record<string, unknown>]] : []),
    ['此刻', {
      why_thinking_now: ctx.reason,
      ...(ctx.recentActionFailures?.length ? { recent_action_failures: { note: '动作结束时的实际反馈，位置和环境可能随后改变', entries: ctx.recentActionFailures } } : {}),
      ...(ctx.recentActionCaveats?.length ? { recent_action_caveats: { note: '动作成功但附带要你掂量的事实，位置和环境可能随后改变', entries: ctx.recentActionCaveats } } : {}),
      noticed: ctx.noticed.map((n) => `${n.what}${n.level === 'urgent' ? '（要紧）' : ''}`),
      since_last_thought: ctx.changes,
      ...(ctx.gameMessages?.length ? { game_messages: ctx.gameMessages } : {}),
      ...(ctx.userSuggestion && !ctx.operatorOrder ? { operator_suggestion: ctx.userSuggestion } : {}),
    }],
  ];
  // 弹幕单独成段、放在最前面：越靠近结尾的内容模型越当真，弹幕是最低优先级的外部意见，不和【此刻】的现场事实挤在一起。
  const audience = audienceBlock(ctx.audience, glance ? 'light' : 'full');
  if (audience) sections.unshift(['直播间', audience]);
  const advanced = p.self.dim !== 'overworld' || s.inventory.some((i) => /ender_(eye|pearl)|obsidian|blaze/.test(i.name));
  const system = glance ? glanceSystem(ctx.persona, ctx.skills ?? []) : deliberateSystem(ctx.persona, ctx.skills ?? []);
  const reminders = situationalReminders(ctx);
  // 工具分级事实不占 5 条提醒配额：挖掘场景前面的提醒常已满 5 条，必须在切片后单独追加才能送达。
  // 放在最前面：这是正在发生的工具消耗，比后面的环境提醒更该先看到。
  if (ctx.toolFact) reminders.unshift(ctx.toolFact);
  // 进阶动作（下界/末地或已有末影物品才出现）和当前活动用到、目录里没给完整参数的动作：作为提醒补在 user 消息里，
  // system 目录保持字节稳定以命中前缀缓存（见 movesCatalog 注释）。
  if (!glance && advanced) {
    const line = advancedMovesLine();
    if (line) reminders.push(line);
  }
  // 目录只给核心动作完整参数；其他动作正在被使用时，把参数贴在 user 消息里，免得每次都得先查 moves。
  const active = [...new Set((ctx.activity?.steps ?? []).map((st) => st.skill))].filter((n) => !COMMON_MOVES.includes(n));
  if (active.length) reminders.push(`正在用的动作参数：\n${moveDetails(active)}`);
  // 操作者的指令放在最前面，最后的提醒里再说一遍（开头和结尾模型最不容易忽略）
  const order = ctx.operatorOrder;
  if (order && order.kind === 'suggestion') {
    sections.unshift(['操作者的建议', { suggestion: order.text, received: `${order.ageSec} 现实秒前`, how: '掂量一下：合适就采纳（operator adopted），不合适说一句为什么（declined），之后照自己的节奏玩' }]);
    reminders.unshift(`操作者提了个建议「${order.text.slice(0, 80)}」：采纳还是不采纳，写 operator`);
  } else if (order) {
    sections.unshift(['操作者的指令', { order: order.text, received: `${order.ageSec} 现实秒前`, status: order.status === 'new' ? '刚收到，还没照做' : '照做中', must: '优先于你自己的打算；照做，并在 operator 里回应 doing / done / cannot' }]);
    reminders.unshift(`操作者的指令「${order.text.slice(0, 80)}」${order.status === 'new' ? '刚收到：这一念就照做（把它变成手上的活）' : '还没做完：手上的活要为它服务；做完了就写 done'}，并写 operator`);
  }
  // 决策事实不占 5 条提醒配额：地下挖掘时静态说明常已占满，必须像工具事实一样在切片后单独追加。
  for (const d of decisionReminders(ctx)) reminders.push(d);
  const body = noteGoneSpots(sections.map(([name, data]) => `【${name}】${JSON.stringify(data)}`).join('\n'), ctx.memory, p.self.dim);
  return [{ role: 'system', content: system }, { role: 'user', content: `${body}${reminders.length ? `\n\n【此刻要留意】\n${reminders.map((r) => `- ${r}`).join('\n')}` : ''}\n\n现在你在想什么、打算怎么做？只输出一个 JSON 对象。` }];
}

/**
 * 休息/睡前回想：像人一样把这段时间的零碎经验整理成少数几条靠谱的窍门。
 * 只依据实际成败次数和最近的真实结果，不发明新的事实。
 */
export interface ReflectionKnowledge {
  /** 触发检索的目标/经历摘要（不是整库目录）。 */
  query: string;
  /** 资料版本与“外部参考、非现场事实”的来源标记，引用时一并保留。 */
  edition: 'java';
  version: string;
  evidence: 'reference_not_current_state';
  /** 按相关性检索出的章节摘录；只放这些，不塞整个知识库。为空表示查过但没有相关章节。 */
  matches: KnowledgeMatch[];
  /** 检索失败的原因（不是“没查”）；失败时不要据此编造事实。 */
  error?: string;
}

export function buildReflectionMessages(self: SelfModel, persona: string, mySkills: string[] = [], strategy: string[] = [], memory?: WorldMemory, knowledge?: ReflectionKnowledge | null): ChatMessage[] {
  const now = Date.now();
  const historical = (text: string, observedAt = 0) => memory ? recallText(text, memory, undefined, observedAt, now) : text;
  const system = `${persona}

你在 Minecraft 里歇下来了（休息、睡觉或者告一段落），回想一下这段时间：哪些办法真的好用，哪些想法被事实推翻了，哪些说的是同一回事。像人一样把零碎的经验整理成少数几条靠谱的窍门。
规则：
- 只依据给出的窍门、成败次数（wins/losses）、来源（source）、应用证据（applications）、零碎想法（insights）和最近的经历（recent），不要编造没发生过的事。
- 说的是同一件事的合并成一条（merge），措辞含糊或太长的改写（rewrite，120 字以内，写清“什么情况下、怎么做、会怎样”）。
- 改写或合并时保留来源和适用条件（地形、方向、材料、授权、工具等）；一次有限情形的失败/成功只写成那次的具体情况，不要升级成普遍规则。unverified 且没有应用证据的条目仍只是暂定结论，没有新证据支持就不要当成已经成立的规律。counterexamples 是明确应用后失败/受阻的反例，limits 是已写下的适用边界：改写或合并不能把它们洗掉；反例说明这条说法在哪里不成立。
- 失败明显多于成功、或被后来的经历推翻的丢掉（drop）；只是一次性的流水账也丢掉。before_rewrite 是改写前旧说法累计的成败：改写只换措辞、做法没变时，这些失败仍是这个做法的记录。
- 零碎想法里被最近经历证实的，才整理成新的窍门（add，最多 5 条）；没证实的就让它过去。
- 议程里已经过时、做不成或不再想做的，可以放下（agenda_drop）。
- 整理后窍门总数最好不超过 25 条。
- 如果这段时间琢磨出了一整套成体系、以后还会用到的做法（比如怎么在深洞里照明、怎么顺着矿脉找钻石、夜里怎么过），可以写成一份自己的技能（skill：英文小写名字、一句用途、几行 Markdown 写清步骤和要点），以后直接翻开用；已有同名的自己写的技能会被更新。没有就省略。
- 如果给了 knowledge（按当前目标/经历检索出的相关文档/章节摘录，不是全库目录；matches 为空表示查过但没有相关章节，error 表示检索失败）或 knowledge_facts（你以前查过并记下的资料摘录），写涉及世界机制/结构/地形的技能、窍门或换玩法时，要写清出处（文档 id/章节）、适用条件和限制。与摘录矛盾、或只有一次有限经历/摘要不足支撑的做法，只能写成明确标为未验证的笔记或候选，不要写成普遍策略。没有检索到相关事实就不要编造，也不要假装有出处。knowledge_facts 是外部参考资料，不是当前世界已有什么的证明。
- 再退一步看看日子是怎么过的（strategy：夜里在哪过、怎么死的、哪些目标耗了很多段活、装备升到哪了、游戏进度到哪了）：
  找出最大的、一再出现的麻烦，问自己“有没有一种根本不同的玩法能让它不再发生”——不是把同一件事做得更用力，而是换个思路（出门时带上什么、把什么搬到哪、换个地方住、先去弄某样东西、干脆放下某件事）。
  换玩法多半是做法上的改变（出门带什么、什么时候收工、在哪冶炼、一次挖多少）：写成一条窍门 add，不进议程。
  只有它要专门花几段活去做成一件事（比如去下界要塞拿烈焰棒、合成末影之眼找要塞）时，才放进议程 agenda_add（{"text":"要做成的事","kind":"idea|goal"}，最多 3 条，写成“做成什么”，不要写成“以后要怎样”）；没想到就不写，不要硬凑。
- 用一句话写日记（diary）记下这段时间最值得记住的事，再用一句独白（monologue）说说现在的感受。
只输出一个 JSON 对象：
{"merge":[{"ids":["k_…","k_…"],"text":"…"}],"rewrite":[{"id":"k_…","text":"…"}],"drop":["k_…"],"add":["…"],"agenda_drop":["a_…"],"agenda_add":[{"text":"…","kind":"idea"}],"skill":{"name":"…","description":"…","body":"…"},"diary":"…","monologue":"…"}`;
  const knowledgeFacts = self.knowledgeFacts(6);
  const payload = {
    know_how: self.data.knowHow.map((k) => ({ id: k.id, text: historical(cleanLesson(k.text), k.source === 'observed' ? k.createdAt : 0), wins: k.wins, losses: k.losses,
      ...(k.prior ? { before_rewrite: { wins: k.prior.wins, losses: k.prior.losses, revisions: k.prior.revisions, last_text: k.prior.lastText } } : {}),
      unverified: k.unverified === true, source: k.source, ...(k.unverified === true && !k.signature && !(k.applications?.length) ? { evidence: 'none' } : {}),
      ...(k.kind ? { kind: k.kind } : {}), ...(k.tags.length ? { tags: k.tags } : {}),
      ...(k.counterexamples?.length ? { counterexamples: k.counterexamples.slice(-5).map((c) => ({
        at: new Date(c.at).toISOString(), reason: c.reason, summary: historical(c.summary, c.at),
        ...(c.claim ? { against: c.claim } : {}), ...(c.outcome ? { outcome: c.outcome } : {}),
      })) } : {}),
      ...(k.limits?.length ? { limits: k.limits } : {}),
      ...(k.applications?.length ? { applications: k.applications.slice(-5).map((a) => ({ at: new Date(a.at).toISOString(), activity_id: a.activityId,
        outcome: a.completion === 'condition' ? 'condition_met' : a.outcome,
        ...(a.completion && a.completion !== 'condition' ? { completion: a.completion } : {}),
        ...(a.failure ? { failure: { skill: a.failure.skill, ...(a.failure.args !== undefined ? { args: a.failure.args } : {}), code: a.failure.code,
          summary: historical(a.failure.summary, a.failure.at), ...(Number.isFinite(a.failure.at) ? { at: new Date(a.failure.at).toISOString() } : {}),
          ...(a.failure.worldId ? { world_id: a.failure.worldId } : {}), ...(a.failure.dim ? { dim: a.failure.dim } : {}),
          ...(a.failure.pos ? { pos: a.failure.pos } : {}) } } : {}),
        summary: historical(a.summary, a.at) })) } : {}),
      age_min: Math.round((now - k.createdAt) / 60000) })),
    insights: self.insights().map((i) => historical(`${i.text}${i.outcome ? `（当时结果：${i.outcome}）` : ''}`)),
    recent: self.history(20).map((r) => ({
      at: new Date(r.at).toISOString(), what: historical(r.what, r.at), kind: r.kind,
      outcome: r.completion === 'condition' ? 'condition_met' : r.outcome,
      ...(r.completion && r.completion !== 'condition' ? { completion: r.completion } : {}),
      duration_real_s: r.durationSec, failures: r.failures,
      ...(r.applying ? { applying: r.applying, applying_at_start: r.applyingText ?? 'unknown' } : {}),
      ...(r.failure ? { failed_action: { skill: r.failure.skill, ...(r.failure.args !== undefined ? { args: r.failure.args } : {}), code: r.failure.code,
        summary: historical(r.failure.summary, r.at), ...(Number.isFinite(r.failure.at) ? { at: new Date(r.failure.at).toISOString() } : {}),
        ...(r.failure.worldId ? { world_id: r.failure.worldId } : {}), ...(r.failure.dim ? { dim: r.failure.dim } : {}),
        ...(r.failure.pos ? { pos: r.failure.pos } : {}) } } : {}),
      ...(Object.keys(r.gained).length ? { gained: r.gained } : {}), ...(Object.keys(r.lost).length ? { used: r.lost } : {}),
      ...(r.collection ? { collection: collectionSnapshot(r.collection) } : {}),
      summary: historical(r.summary, r.at),
    })),
    experiments: self.experiments(6).map((e) => `${historical(e.hypothesis)} → ${e.status}${e.evidence ? `（${historical(e.evidence.slice(0, 80), e.at)}）` : ''}`),
    agenda: self.agenda().map((a) => ({ id: a.id, text: a.text, kind: a.kind, tried: a.attempts })),
    diary: self.diary(5).map((d) => historical(d.text)),
    feeling: moodWords(self.mood),
    ...(mySkills.length ? { my_skills: mySkills } : {}),
    ...(strategy.length ? { strategy } : {}),
    ...(knowledgeFacts.length ? { knowledge_facts: knowledgeFacts.map(knowledgeFactLine) } : {}),
    ...(knowledge ? { knowledge } : {}),
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

import type { AgentState } from '../adapter/types.ts';
import { effortFacts } from '../brain/efficiency.ts';
import { durabilityFacts, fuelFacts, oreOpportunityFact, supplyFacts, toolBackupFact } from '../brain/supply.ts';
import type { AudienceContext } from '../live/audience.ts';
import type { WorldMemory } from '../memory/store.ts';
import { dirName, durationText, realSecondsToTicks, sunText, type Percept } from '../perception/perception.ts';
import { isSoftBlock } from '../perception/surroundings.ts';
import { audienceBlock, AUDIENCE_RULES, exploredAround, liveAudience, type MySkillInfo } from '../planner/prompt.ts';
import type { ChatMessage } from '../planner/llm.ts';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { myBed } from '../skills/stations.ts';
import { gearAlreadyHeldInText } from '../skills/work.ts';
import { travelStore } from '../travel/store.ts';
import { describeActivity } from './activity.ts';
import { describeBuild, homeOf, myBuilds } from './home.ts';
import { FACILITY_LABELS, myFacilities } from './facilities.ts';
import { passageDeepestAnchor, passageNext, passageSurfaceAnchor } from '../memory/passages.ts';
import { activeDrafts } from '../building/drafts.ts';
import { cleanLesson, moodWords, type SelfModel } from './self.ts';
import type { Activity, ActivityRecord, Noticing } from './types.ts';
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
import { chestLocation, isContainerLandmark } from '../memory/chest-memory.ts';
import { noteGoneSpots, recallText } from '../memory/recollection.ts';
export { noteGoneSpots } from '../memory/recollection.ts';

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
  suspended: Activity[];
  /** 提前想好、手上的活做完就接上的下一段（模型自己写的 next，如实回显，不加引导） */
  next?: { what: string; why?: string } | null;
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
  /** 动作结束时实际观察到的失败；地形可能随后改变。 */
  recentActionFailures?: { skill: string; args: unknown; failure_code: string | null; summary: string; position: AgentState['pos']; observed_at: string; repeats?: number }[];
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
export const COMMON_MOVES = ['dig_at', 'step', 'place_at', 'defend', 'gather', 'goto', 'explore', 'look', 'look_around', 'dive', 'surface', 'craft', 'smelt', 'collect_furnace', 'eat', 'hunt', 'forage', 'fish', 'farm', 'collect_seeds',
  'pickup_items', 'store_items', 'take_items', 'find_item', 'place_torch', 'shelter', 'sleep', 'wait', 'dig', 'excavate_path', 'follow_passage', 'climb_up', 'press_keys', 'build', 'travel', 'inspect_block', 'interact_block', 'use_item', 'use_skill'];

/** 远行、传送门、末地这些只在用得上时列出来，平时是噪音 */
const ADVANCED = /portal|end_|dragon|stronghold|search_structure|reservations|base_memory|building_archive|building_review|ranged_defend|equip_armor/;

/** 描述取第一句话，太长就在逗号处截断（不截在半个词上） */
function briefOf(d: string, n: number): string {
  const first = d.replace(/\s+/g, ' ').split(/[。；;：:]/)[0];
  if (first.length <= n) return first;
  const cut = first.slice(0, n);
  const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(','), cut.lastIndexOf('（'));
  return at > n / 2 ? cut.slice(0, at) : `${cut}…`;
}

/** 移动/潜水上浮这类动作在两种思考档位里都要给足副作用说明 */
function descOf(s: { name: string; description: string }, chars: number): string {
  return ['look', 'dive', 'surface', 'travel'].includes(s.name) ? s.description.replace(/\s+/g, ' ')
    : chars ? briefOf(s.description, chars) : '';
}

/**
 * 静态动作目录：core 里的动作给完整参数，其余非进阶动作只列名字 + 一句用途（需要时用 {"kind":"moves"} 查完整参数）。
 * 不再随 advanced（是否下界/末地）或 inUse（当前活动用到哪些动作）变化：进阶动作单独走 advancedMovesLine() 作为 user 提醒，
 * 当前活动用到的动作单独作为 user 提醒，这样 system 前缀保持字节稳定，最大程度命中服务端前缀缓存。
 */
export function movesCatalog(chars = 40, core: Set<string> = new Set(COMMON_MOVES)): string {
  const visible = Object.values(SKILLS).filter((s) => !LLM_HIDDEN.has(s.name) && !ADVANCED.test(s.name));
  const detailed = visible.filter((s) => core.has(s.name)).map((s) => `- ${s.name} ${s.argsDoc}${descOf(s, chars) ? `：${descOf(s, chars)}` : ''}`);
  const onDemand = visible.filter((s) => !core.has(s.name)).map((s) => `${s.name}（${briefOf(s.description, 14)}）`);
  const demandLine = onDemand.length ? `\n其他动作（用 {"kind":"moves","names":["…"]} 查完整参数）：${onDemand.join('、')}` : '';
  return `${detailed.join('\n')}${demandLine}\n缺工具、熔炉、船、火把等默认报告缺口；加 "make":true 才允许顺手制造/准备并消耗材料，加 "make":false 则禁止本动作及嵌套准备`;
}

/** 瞥一眼时给完整参数的常用动作；其余只列名字 + 用途，参数按需用 moves 查 */
const GLANCE_CORE = ['dig_at', 'step', 'place_at', 'gather', 'goto', 'craft', 'eat', 'sleep', 'wait', 'look', 'look_around', 'defend', 'hunt', 'place_torch', 'dive', 'surface', 'travel', 'press_keys'];
/** 瞥一眼时只列名字 + 用途的动作（完整参数按需查） */
const GLANCE_SECONDARY = ['explore', 'forage', 'pickup_items', 'shelter', 'build', 'smelt', 'store_items', 'climb_up', 'use_skill', 'excavate_path', 'descend', 'assess_landings'];

/** 抬头看（glance）的动作目录：只列少数完整参数 + 常用名字，隐藏长尾，保持轻量 */
export function glanceCatalog(): string {
  const core = new Set(GLANCE_CORE);
  const visible = Object.values(SKILLS).filter((s) => !LLM_HIDDEN.has(s.name) && (GLANCE_CORE.includes(s.name) || GLANCE_SECONDARY.includes(s.name)));
  const detailed = visible.filter((s) => core.has(s.name)).map((s) => `- ${s.name} ${s.argsDoc}${descOf(s, 0) ? `：${descOf(s, 0)}` : ''}`);
  const onDemand = visible.filter((s) => !core.has(s.name)).map((s) => `${s.name}（${briefOf(s.description, 14)}）`);
  const demandLine = onDemand.length ? `\n其他动作（用 {"kind":"moves","names":["…"]} 查完整参数）：${onDemand.join('、')}` : '';
  return `${detailed.join('\n')}${demandLine}`;
}

/** 进阶动作（portal/end_/dragon/…）：不进静态目录，按需作为 user 提醒给出，避免平时噪音、也不破坏 system 前缀缓存 */
export function advancedMovesLine(): string {
  const names = Object.values(SKILLS).filter((s) => !LLM_HIDDEN.has(s.name) && ADVANCED.test(s.name)).map((s) => s.name);
  return names.length ? `进阶动作可用（参数用 moves 查）：${names.map((n) => `${n}（${briefOf(SKILLS[n].description, 14)}）`).join('、')}` : '';
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
清包验收：{"type":"inventory_space_min","free_slots":5} 表示至少腾出 5 格空位（空位 ≥ 5）；inventory_full 表示空位 ≤ 指定数量，用于采集到近满，不能用来确认腾出空位。
高度范围：{"type":"position_y","max":30}（脚的位置 y ≤ 30），也可写 min 或同时写 min、max。
身体状态仅表示当前快照：inWater=false 只表示采样时身体未接触水，不证明已上岸、持续站稳或完成换气；onGround=true 只表示当前触地，也可能在水底。氧气恢复程度看 oxygen 数值；条件及其组合由你按实际目标选择。
写与这段活实际收工目标相符的条件；条件只证明它自身成立，不证明描述里的其他目标达成。开工前就成立的条件会被当成没写。`;

const OUTPUT = `只输出一个 JSON 对象：
{"monologue":"第一人称内心独白，接着刚才的念头往下想（20–80 字）",
 "decision":"continue|adjust|new|detour|switch|experiment|rest",
 "activity":{"what":"具体要干什么","why":"为什么现在做","kind":"gather|craft|build|explore|survive|rest|experiment|tidy|social|other","facing":"N|E|S|W（含水平相对操作时必填）","steps":[{"skill":"动作名","args":{}}],"repeat":1,"done_when":{…},"expect":"预计会怎样","if_stuck":"卡住打算怎么办"},
 "next":{同 activity，可提前写下一段；手上的活成功结束后再接上}}
手上还有活要接着做就只写 decision:"continue"，不要写 activity；要做新的一段或换做法，写 decision:"new"/"adjust"/"switch"（不要写 continue）。routine 1–6 步。顺手、碰运气的步骤加 "optional":true（没成也不算失败）。
operator（有【操作者的指令】时必写 {"status":"doing|done|cannot","note":"…"}；有【操作者的建议】时写 {"status":"adopted|declined","note":"…"}）｜plan（主目标清单：定下 {"focus":"a_…或一句话","steps":["…"]}，做完一项 {"done":[0]}）｜skill（见【技能】）｜worth_learning（刚才的事值得练成技能时写：哪里出了问题、想学会什么）
其他可选字段：say（有新发现、改主意、做成事或遇险时说的一句口语）｜agenda（{"add":[{"text":"想做的事或想弄清的问题","kind":"goal|idea|question","horizon":"today|someday"}],"done":["a_…"],"drop":["a_…"],"focus":"a_…"}，规则不要放这里）｜learned（结果出乎意料时的一句窍门，或 {"revise":"k_…","text":"…"} 修订旧窍门）｜hypothesis（experiment 必填）｜experiment_result（上一段是实验时：supported|refuted|unclear）｜diary（值得记住的一句话）｜liked（刚发现喜欢的东西）｜habits（身体习惯与注意偏好，一直有效：{"torch_every":8} 空闲且暗时相隔约 8 格消耗一支火把，不打断动作；{"eat_below":12} 饿到 12 顺手吃，{"pickup":true} 新掉落物触发瞥一眼，由你决定是否调用 pickup_items；pickup:false 关闭单独提醒，掉落事实仍随下次思考提供，不会自动捡；数值习惯用 0 关闭）`;

const DECISIONS = `continue 照常做｜adjust 还是这件事、改一改 routine｜new 开始新的一段｜detour 先插一段别的，做完自动回来｜switch 放下手上的改做别的｜experiment 验证一个猜想的小活｜rest 歇一下`;

/** 操作者：直播的主人，从控制台下指令的人。指令不是“建议”，优先于自己的打算 */
const OPERATOR = `【操作者】控制台里的操作者（直播的主人）说话分两种。【操作者的指令】：优先于自己的主目标、手上的活和弹幕，这一念就照做（可以直接 switch），做法自己想，不讨价还价；只有会马上送命才先保命再回来；写 operator doing / done / cannot。做完或做不到就说，别一直挂着。【操作者的建议】：只是提个想法，认真掂量一下，合适就采纳（adopted），不合适就说一句为什么（declined），然后照自己的节奏玩，不用一直惦记。建议涉及的游戏机制与自己的记忆不一致时，先查 knowledge；查不到就说明不确定。背包数量、计划和窍门的成败次数不能证明某次行动的具体工具或经过；讲自己的经历要有实际观察依据。`;

/** 专注：主目标 + 清单，插曲用 detour */
const FOCUS = `【专注】主目标是这一阶段要拿到的成果，不是做法，也不是过夜、脱困这类眼前事（detour）。清单 3–6 项可验证的子任务，可写 {"text":"…","done_when":{…}} 自动勾；依次推进；久没推进就改清单，有【阶段回顾】时可换目标（写 switch_reason）。`;

/** 技能的生成、试用与正式使用分开，完整写法按需查。 */
const SKILLS_DOC = () => `【技能】把做法写进 skill 会保存候选：{"name":"英文-连字符","description":"…","when":{条件},"steps":[…]或"code":"JS","verify":"观察原目标是否达成"}。你决定何时在 routine 用 use_skill {"name":"…","trial":true,"args":{…}} 显式试用；候选不自动接手、不替换稳定版，取得足够实际验收证据才启用。启用后 when 含 after_failure＝动作失败时先试；只有状态条件＝成立自动做；不写＝手动调用。方块只读当前视觉，unknown不能当作空气或已知矿物；只听到的实体没有精确坐标和可交互ID（写 hostile 条件时加 seen:true 只看看得见的怪）。写不出就用 worth_learning；写法先查 {"kind":"skill","name":"writing-skills"}。遇到岩浆或水下呼吸问题由你或你学会的技能处理。纯文字技能可用 skill {"name":"…","restore":true} 恢复到阅读目录；恢复不代表验证成功。技能目录和查询保留成功过的应急版本；可用 skill {"name":"…","from_version":1} 将指定完整历史契约另存新候选再试，保留稳定版和旧证据，新候选从零验收；历史成功不保证现在有效。`;

const PASSAGES_QUERY = `{"kind":"passages"} 查当前世界和维度的矿道记录；加 "id":"记录ID","offset":0 分页读历史脚点，每页最多32点。脚点不代表连续或双向可走，当前通路需现场确认。`;

const QUERIES = (skills: string[]) => `【先查再做】需要时先输出一个查询 JSON（查询本身不执行身体动作，但等待期间世界仍在运行、身体可能继续动作，每次思考最多 3 次；拿到结果后以最新状态为准），再决定：
- {"kind":"skill","query":"关键词"} 查技能（空查询浏览目录，offset 分页，含收起和停用）；{"kind":"skill","name":"技能名"} 读技能及版本记录，加 "version":30 读历史版本；读取不代表启用或验证｜{"kind":"design","brief":"用途、多大、风格","where":"here|base|x,y,z"} 请建筑师画图纸：房子、前哨、仓库、畜栏、塔等要长期用的建筑（where：脚下、家旁或坐标）；传送门/末地门不是建筑，用 build_portal 立框点燃，别让建筑师画
- {"kind":"recipes","item":"物品名","count":1} 看配方和缺口（"uses":"物品" 反查用途）｜{"kind":"moves","names":["动作名"]} 看动作参数
- {"kind":"recall","query":"关键词"} 回想以前的经历、日记、教训和技能｜{"kind":"mechanics","query":"…"} 查底层操作接口
- ${PASSAGES_QUERY}
- {"kind":"knowledge","query":"问题"} 搜索 Wiki 候选；再用 {"kind":"knowledge","id":"文档id"} 看章节目录，加 "section":"章节id" 读正文，续页按 nextCursor 传 cursor。空查询浏览目录，目录续页传 offset。摘录不等于读完或学会；资料不代表现场事实，做法自行判断。`;
/** 技能书目录放在系统提示词最后：它变得最勤（写、改、收起），放在前面会让后面不变的大段内容每次都缓存不中 */
const SKILL_INDEX = (skills: string[]) => skills.length ? `\n\n【技能书】\n${skills.map((x) => `- ${x}`).join('\n')}` : '';

/** 用户消息分块：越往后越要紧（模型对末尾注意力最强） */
const READING = `【方位】北 N=z减 南 S=z加 东 E=x加 西 W=x减。往某方向走直接写 goto {"target":"E 20"}，别自己算坐标；[前,上,右] 按指定 facing 换算。
【相对坐标】activity/next 含 dig_at、step、place_at 的水平相对操作时，必须声明活动的 facing:"N|E|S|W"，表示坐标的前方，不等于推进方向。子步骤省略 facing 就继承，显式冲突会退回；绝对 xyz 和纯竖直操作不要求这个字段。活动参考系独立于镜头朝向；转头、观察、插火把不会改变它，local 方块图仍按 local.facing 解读。输出前核对文字目标方向与坐标换算后的实际方向；例如 facing:"N" 的 [-1,0,0] 是向南。需要改变参考系时可明确声明新的 facing（包括 "S"），后退或换向仍由你决定。
【上下移动】上下移动不用 step：往上只有脚下有梯子才能爬，否则用 place_at [0,0,0] 垫一块站上去；往下用 dig_at [0,-1,0]（挖空脚下人会自己掉下去，不需要再 step）。垫高会跳起来、需要头顶上方两格（头和头上一格）都空：两格高的隧道/矿道里跳不起来，别反复垫高，改用向上阶梯 dig_at [0,2,0] → dig_at [1,2,0] → dig_at [1,1,0] → step [1,1,0]。
【消息怎么读】越往后越要紧：【我】性格心情、议程、窍门 →【记得的地方】→【进度】主线到哪了、下一个目标 →【想起来的】自动想起的旧事和技能 →【最近】→【手上的活】→【身边】方块图 local、生物、资源 →【身体】where、生命饥饿、天色、背包 →【专注】主目标和清单 →【此刻】为什么现在想、注意到什么 →【此刻要留意】。未看见的方块状态未知，未挖到不代表那里是空气。`;

const ROUTINE_OF_THINKING = `【每次这样想】
1. 【此刻】要紧的（危险、快饿死、卡住）先处理。
2. 看【专注】：在推进清单就 continue。
3. 看【身体】where 和【身边】local 确认地形；地形分类不代表受困或需要离开，按当前目标和实际反馈选择动作，身边一格的操作写确切坐标。
4. 拿不准就先查（knowledge / skill / moves / recipes / recall / passages）；输出前核对动作名和参数。`;

const CHOOSE = `【选动作】
- 去记得的地方或坐标 → goto；找没见过的东西 → explore {"until":…}；拿看得见的方块 → gather；身边某一格 → dig_at / step / place_at
- 坐船过水：船是实体，用 use_item {"item":"…_boat","on":"water"} 放到水面（别用 place_at），再 interact {"entity":"boat"} 上船；ride {"direction":"SW"} 划（ride 必须给 direction 或 to）。travel 提供步行和游泳寻路，已乘船时沿水路导航；吃 → eat（背包有吃的）/ hunt / forage / fish；做东西 → craft、smelt（会自己放下背包里的工作台/熔炉；拿不准查 recipes）
- 从箱子取/存东西 → 先 find_item {"item":"…"} 查它在哪个箱子，再 take_items / store_items 指定那只箱子（target 写坐标或容器地标 ID）
- 在坑里或地下想上去 → 看【身边】local 和背包，用 dig_at / step / place_at 自己想办法（怎么上去由你定，背包里有什么用什么）；想往下深挖 → 有稳定辅助 excavate_path {"entry":"current","mode":"stairs"} 或 assess_landings + descend（手工 dig_at+step 阶梯的斜下格支撑超出 place_at 范围，容易卡住）
- 穿下界门/末地门 → 先 observe_portal 拿 portalId，再 travel_portal {"portalId":"…"} 穿过去；travel_portal 不行时，自己走到门面正前那一格、面向门面走进去（走进紫色门面等传送是可行的；portal 方块站不住也挖不掉，所以别用 step/dig 去动它）
- design 请建筑师画图纸，再 build（新盖 {"draft":"图纸ID"}，续建 {"projectId":"作品ID"}）；不要自己画图纸
- goto 默认不挖墙、不垫路、不搭柱；dig:true 才额外允许挖掘、垫路和搭柱；place:false 禁止放置，tower:false 禁止原地搭柱。`;

const PRINCIPLES = `【原则】
- 接着刚才的念头往下想，不反复换主意、不重复刚做完的事。
- 一段活（如“砍 20 根木头”）：routine 1–6 步，可 repeat，done_when 写清何时收工；身体连续执行、自己应变，真卡住才叫你。
- 从真实结果里学，出乎意料才写 learned；历史失败只作参考，继续、重试或调整由你决定。
- 你既会被风景吸引、想把一路的见闻记下来，也总惦记着把进度往前推——升级装备、进下界、找要塞、打败末影龙。喜欢的写 liked，想做的放 agenda。情绪是信号：累了歇、烦了换办法、腻了找新鲜事。
- 只知道亲眼看到或记得的东西，坐标来自观察或地标，不编。
- 遇到危险如何行动由你或你写下的技能决定；插火把、顺手吃可用 habits 定成习惯；捡东西需明确安排 pickup_items，pickup 偏好只提醒思考。`;

const PRECISE = `【精确操作】local 以脚部占据格为原点：[前,上,右]，前=local.facing。spots.stand/place 是当前可见的候选站位/放置格，仍需动作确认。step 指脚部目标格，place_at 指方块占据格，支撑在脚部目标下面一格。
- [0,0,0] 是脚部格，[0,1,0] 是头部格，[0,-1,0] 是支撑格。place_at [0,0,0] 放实心方块会跳起垫高（需头顶上方两格全空，两格高的隧道改用阶梯 dig_at+step）；梯子、火把可放进身体格（需有附着面）。挖空 [0,-1,0] 会下落，无需 step。
- step [1,-1,0] 下一级需 [1,-2,0] 支撑；place_at [1,-1,0] 会堵住该脚部目标格。place_at 上下范围 -1..3，不能原位补 [1,-2,0]。
repeat 每轮重做整套 steps；子步骤继承 activity.facing，每步相对坐标按当前位置重算。done_when 写可观察结果。照明可选 place_torch 或空闲习惯 habits.torch_every。挖前看清目标格。
- 机械性失败身体会就地应变再重试：太暗先插火把、脚下无支撑先垫一块、头顶被挡先挖开（会消耗方块/火把）；应变不动才交给你决定。`;

const EXAMPLE = `【例子】想进下界时：
→ {"kind":"knowledge","query":"怎么建下界传送门"}
← 已经查到资料了……黑曜石要用铁镐或钻石镐挖，岩浆浇上水就变成黑曜石
→ {"monologue":"先凑够黑曜石把传送门点起来。","decision":"new","activity":{"what":"采黑曜石","why":"要建下界传送门","kind":"gather","steps":[{"skill":"gather","args":{"block":"obsidian","count":10}}],"done_when":{"type":"inventory_min","item":"obsidian","count":10}}}`;

export function deliberateSystem(persona: string, skills: string[] = []): string {
  return `${persona}

游戏版本：Minecraft Java Edition ${config.mc.version}。

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
${liveAudience.enabled && liveAudience.inPrompt !== false ? `\n${AUDIENCE_RULES}\n` : ''}
【动作】参数必须合法：
${movesCatalog(28)}${SKILL_INDEX(skills)}`;
}

export function glanceSystem(persona: string, skills: string[] = []): string {
  return `${persona}

游戏版本：Minecraft Java Edition ${config.mc.version}。

你在连续地玩 Minecraft，这次只是抬头看一眼。
${OPERATOR}
${READING}
- 先看【此刻】：没什么要紧的、手上的活还顺，就 continue（独白可以很短）。
- 手上没活：直接 new 一段，接着【最近】的结果和议程往下玩；边做边想下一段可写 next，当前动作仍在执行、结果未知。小改用 adjust，插一件事用 detour，彻底换事用 switch/new。
- 看【身体】where 和【身边】local 确认地形；地形分类不代表受困或需要离开，按当前目标和实际反馈选择动作，用 dig_at / step / place_at 写确切坐标。
- 要翻技能书、请建筑师、查配方/游戏资料或想得更深：直接输出查询，如 {"kind":"knowledge","query":"问题"}、{"kind":"design","brief":"…"}、{"kind":"skill","name":"…"}、{"kind":"deliberate","reason":"…"}（转成认真想）。knowledge 先搜候选再读章节，摘录不等于读完或学会；资料不代表现场事实。
- ${PASSAGES_QUERY}
${skills.length ? `技能书：${skills.map((x) => x.replace(/］.*$/, '］')).join('、')}。需要时先用 skill 查询；文字做法不能用 use_skill 直接执行，只有已注册的可执行技能或可试用候选才能调用。` : ''}盖新房子先 design 拿图纸，再 build {"draft":"图纸ID"}；不要自己画图纸。
- 有【专注】的主目标时，可用 detour 暂时插一段并自动回来；明确决定放下当前活动用 switch，想立即改做法用 adjust，瞥一眼也能选择。系统可能提示打断的影响，但不会把 switch/adjust 改成其它决定。做完清单一项写 "plan":{"done":[序号]}。
- 刚从卡住里找到办法、想把它变成身体的习惯：转成认真想（{"kind":"deliberate","reason":"写技能"}）。

${CHOOSE}

【决定】${DECISIONS}

【输出】${OUTPUT}
${CONDITIONS}

【常用动作】
${glanceCatalog()}`;
}

/** 打算里说要下矿、往下挖 */
/** 最后一步执行中提前规划下一段；不推测当前动作的结果。 */
export const NEAR_END_REASON = '手上这段活的最后一步正在执行，结果还不知道；可以提前想想接下来';

const MINING_INTENT = /下矿|矿道|矿洞|找铁|挖铁|找矿|挖矿|粗铁|铁矿|往下挖|下挖|下到 ?y|挖(阶梯|台阶)[^上]{0,6}(下|降)|石层|深层/;

/** 打算里说要从地下回地面 */
const SURFACE_INTENT = /回地面|回到地面|回前哨|回基地|回入口|退回入口|回地表|见天|爬出|挖出去|出矿|上地面|上到地面|往上爬|往上走|往上挖|挖(阶梯|台阶).{0,8}上/;

/** 沿来路回入口的下一步：把全部记下的通道连成网（碎片也接得上），取朝地表锚点走的下一个路点，核对下一步那两格（脚下+头顶）现在是否还通，给出「可走/被堵」的当前事实。 */
function passageWayBack(ctx: MindContext): string | null {
  const p = ctx.percept, s = ctx.state;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  const recs = ctx.memory.passages(s.dim).filter((r) => !r.worldId || r.worldId === s.worldId);
  const to = passageSurfaceAnchor(recs, here);
  if (!to) return null;
  const g = passageNext(recs, here, to);
  if (!g) return null;
  const next = g.next;
  const at = (x: number, y: number, z: number) => ctx.blockAt?.({ x, y, z }) ?? null;
  const foot = at(next.x, next.y, next.z);
  const head = at(next.x, next.y + 1, next.z);
  const open = (n: string | null) => n !== null && isSoftBlock(n);
  const pos = `${Math.round(next.x)},${Math.round(next.y)},${Math.round(next.z)}`;
  const kind = g.kind === 'walked' ? '走过的路' : g.kind === 'bridge' ? '我搭的桥' : '自己挖过的旧矿道';
  const along = g.inside ? `你正沿着${kind}` : `附近有${kind}，朝它回入口的方向走`;
  const follow = g.inside ? '；也可以 follow_passage {"to":"entrance"} 让我沿这条旧矿道带路' : '；也可以 follow_passage {"to":"entrance","dig":true} 让我挖开挡路、接回旧矿道带路';
  if (open(foot) && open(head)) return `${along}；沿它回入口的下一步 (${pos}) 现在仍是 2 格高的空走廊，可以直接走过去${follow}`;
  const reason = !open(foot) ? `脚下那格现在是 ${foot ?? '未加载'}` : `头顶那格现在是 ${head ?? '未加载'}`;
  return `${along}；沿它回入口的下一步 (${pos}) 被堵了：${reason}。挖开这一格、还是改走别的路，由你定${follow}`;
}

/** 沿旧矿道往最深处走的下一步：和 passageWayBack 对称，但方向朝全网最深的脚点，供想下更深时接上旧通道 */
function passageWayDown(ctx: MindContext): string | null {
  const p = ctx.percept, s = ctx.state;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  const recs = ctx.memory.passages(s.dim).filter((r) => !r.worldId || r.worldId === s.worldId);
  const to = passageDeepestAnchor(recs, here);
  if (!to) return null;
  const g = passageNext(recs, here, to);
  if (!g) return null;
  const next = g.next;
  const at = (x: number, y: number, z: number) => ctx.blockAt?.({ x, y, z }) ?? null;
  const foot = at(next.x, next.y, next.z);
  const head = at(next.x, next.y + 1, next.z);
  const open = (n: string | null) => n !== null && isSoftBlock(n);
  const pos = `${Math.round(next.x)},${Math.round(next.y)},${Math.round(next.z)}`;
  const kind = g.kind === 'walked' ? '走过的路' : g.kind === 'bridge' ? '我搭的桥' : '自己挖过的旧矿道';
  const along = g.inside ? `你正沿着${kind}` : `附近有${kind}，朝它最深处走`;
  const follow = g.inside ? '；也可以 follow_passage {"to":"deepest"} 让我沿这条旧矿道带路' : '；也可以 follow_passage {"to":"deepest","dig":true} 让我挖开挡路、接回旧矿道带路';
  if (open(foot) && open(head)) return `${along}；沿它往最深处走的下一步 (${pos}) 现在仍是 2 格高的空走廊，可以直接走过去${follow}`;
  const reason = !open(foot) ? `脚下那格现在是 ${foot ?? '未加载'}` : `头顶那格现在是 ${head ?? '未加载'}`;
  return `${along}；沿它往最深处走的下一步 (${pos}) 被堵了：${reason}。挖开这一格、还是改走别的路，由你定${follow}`;
}

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
  const blocks = inv.filter((i) => /^(cobblestone|cobbled_deepslate|deepslate|stone|dirt|sand|gravel|netherrack|.*_planks)$/.test(i.name)).reduce((n, i) => n + i.count, 0);
  return `过水可用的材料：${blocks ? `能垫路的方块 ${blocks} 块` : '没有能垫路的方块'}；${boat ? `背包有船 ${boat} 只` : planks >= 5 ? `木板 ${planks} 块（够造一只船）` : '没有船，木板也不够造（要 5 块木板）'}`;
}

/** 主目标清单观察在线没进展、最近几段活还卡/没做成：提示可以改清单（不动主目标、不删做完的项、不重写已勾掉的项） */
function planRevisionHint(ctx: MindContext): string | null {
  if (ctx.tier !== 'deliberate') return null;
  const plan = ctx.plan;
  if (!plan) return null;
  const stall = ctx.self.planStallInfo();
  if (stall.minutes < 15) return null;
  const since = plan.progressAt ?? plan.setAt;
  const acts = ctx.self.history(60).filter((r) => r.at > since);
  if (acts.length < 3) return null;
  const stuck = acts.filter((r) => r.outcome === 'stuck' || r.outcome === 'unmet');
  if (stuck.length < 2) return null;
  const outcomeText = { done: '做成', stuck: '卡住', unmet: '没做成', abandoned: '放下', interrupted: '打断', replaced: '换掉' } as const;
  const recent = acts.slice(-3).map((r) => `${r.what.slice(0, 18)}→${outcomeText[r.outcome] ?? r.outcome}`);
  const doneSteps = plan.steps.filter((st) => st.done).map((st) => st.text);
  return `主目标「${plan.goal.slice(0, 30)}」的清单已观察到 ${Math.round(stall.minutes)} 在线分钟没勾掉一项${stall.historyUnknown ? '（更早的在线时长未知）' : ''}，最近：${recent.join('；')}。主目标不用换（换目标要等阶段回顾）；但清单可以改：把反复卡住缺掉的那一步补成一项、把卡住的项拆成能验证的小步，或删掉做不成的项（删项要在 plan 里写 "switch_reason" 说明为什么），写 plan {"focus":"${plan.agendaId}","steps":[…] }${doneSteps.length ? `；已经勾掉的（${doneSteps.slice(0, 3).map((t) => `「${t.slice(0, 14)}」`).join('、')}）保留，别写成新步骤` : ''}`;
}

/** 按情境追加在用户消息末尾的提醒：只说和眼下有关的 2–4 件事 */
export function situationalReminders(ctx: MindContext): string[] {
  const out: string[] = [];
  const p = ctx.percept, s = ctx.state;
  const here = { x: p.self.pos[0], y: p.self.pos[1], z: p.self.pos[2] };
  if (p.self.dim !== 'overworld') out.push(`你在${DIM_ZH[p.self.dim] ?? p.self.dim}，不是主世界；记得的地标、矿道、箱子都按维度分开，主世界的东西在这里看不到。这里没有昼夜、始终昏暗，火把只能照明，不能像主世界那样靠光拦住刷怪`);
  const drafts = activeDrafts()?.list(4).filter((d) => !d.usedBy) ?? [];
  const unfinished = myBuilds(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }).filter((b) => b.status !== 'complete' && b.dist <= 96);
  const intent = [ctx.activity?.what, ctx.activity?.why, ...ctx.self.agenda().map((a) => a.text), ...ctx.self.recentThoughts(3).map((t) => t.text)].filter(Boolean).join(' ');
  if (ctx.learnFrom) {
    const f = ctx.learnFrom;
    out.push(`刚才「${f.stuck.what}」卡住了（${f.stuck.why.slice(0, 50)}${f.stuck.skill ? `，失败的是 ${f.stuck.skill}${f.stuck.code ? ` ${f.stuck.code}` : ''}` : ''}），随后「${f.solved.what}」做成了（${f.solved.routine.slice(0, 4).join('；')}）：以后还会碰到的话，写 worth_learning 说清怎么回事，后台会把它练成技能`);
  }
  const focusItem = ctx.self.activeAgenda();
  if (focusItem && !ctx.plan && ctx.tier === 'deliberate') out.push(`主目标「${focusItem.text}」还没有清单：写 "plan":{"focus":"${focusItem.id}","steps":[…3–6 项]}，之后一项项推进`);
  const revision = planRevisionHint(ctx);
  if (revision) out.push(revision);
  // 同一动作在同一带反复失败：先想这一步怎么改，别整段推倒重来（卡住→整段重写的死循环）
  const repeatFails = (ctx.recentActionFailures ?? []).filter((f) => (f.repeats ?? 0) >= 2);
  if (repeatFails.length) {
    const f = repeatFails[0];
    out.push(`动作 ${f.skill} 在这一带反复 ${f.failure_code ?? '失败'}（${f.repeats} 次）：先想这一步怎么改——换方向、垫方块、改用辅助或换个站位；不必把整段活推倒重来`);
  }
  const where = p.self.where?.kind;
  // 旧通道是历史记忆，不保证现在仍然可通。
  if (MINING_INTENT.test(intent)) {
    // 矿在哪一层是版本事实：模型记得的多是老版本（钻石 y12），摆出这个世界的版本对应的分布，下到哪层它自己定
    const layers = oreLayerFacts(config.mc.version, intent);
    if (layers) out.push(layers);
    // 往下挖有稳定辅助：手工 dig_at[1,-1,0]+step 的斜下格支撑超出 place_at 范围，容易卡住
    const stairFails = (ctx.recentActionFailures ?? []).filter((f) => (f.skill === 'step' || f.skill === 'dig_at') && f.failure_code === 'PATH_NOT_FOUND');
    out.push(`下矿有稳定下行辅助：excavate_path {"entry":"current","mode":"stairs","direction":"…","steps":4}（逐格确认工具、地板、头部空间、干燥和真实落地，遇水/岩浆/沙砾不冒险）或 assess_landings + descend${stairFails.length >= 2 ? '；刚才 step/dig_at 连续走不通——这是手工阶梯的固有限制：斜下格支撑超出 place_at 范围，容易卡住' : ''}`);
    const tunnels = myFacilities(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }, ['passage']).filter((f) => f.dist <= 160).slice(0, 2);
    for (const t of tunnels) {
      out.push(`记得自己${t.text}`);
    }
    // 想下更深时：有旧矿道就给出朝最深处走的下一步（和回入口的下一步对称）
    const down = passageWayDown(ctx);
    if (down) out.push(down);
    // 消耗品预算：下矿前把火把够不够、还能做多少摆出来（只报事实，备多少由它定）
    out.push(...supplyFacts({ inv: s.inventory, torchEvery: ctx.self.habits().torch_every, only: new Set(['torch']), difficulty: s.difficulty, gamerules: s.gamerules, stock: p.storage?.stock }));
    // 世界规则事实：keepInventory 开着时死亡不掉落（只是事实，怎么备仍由它定）
    const keepInv = s.gamerules?.keepInventory;
    if (keepInv === true || keepInv === 'true') out.push('keepInventory 开着（死亡不掉落）');
    // 预算要有个规模可除：提醒它把挖多深/横多远说出来（不替它定）
    if (!/(y ?[=-]? ?\d+|挖到|下到|横着|横探|\d+ ?格)/.test(intent)) {
      out.push('要下矿先想好这次大概挖多深/横多远（挖到 y=某层、横着多少格）');
    }
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
  // 下矿的账：在地下、手上的活快收工或想回地面时，提供实际经历和当前所见。
  const trip = ctx.trip;
  if (trip && trip.minutes >= 1.5 && (trip.nearEnd || !ctx.activity || SURFACE_INTENT.test(intent)) && (p.self.where?.kind === 'underground' || p.self.sky_visible === false)) {
    const got = Object.entries(trip.gained).filter(([k]) => /raw_|_ore$|coal|diamond|emerald|lapis|redstone|amethyst|obsidian|debris|flint|gold_nugget|quartz/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}×${n}`);
    const seen = p.nearby.resources.filter((r) => r.seen === 'now' && isResourceBlock(r.block)).sort((a, b) => a.nearest - b.nearest).slice(0, 4).map((r) => `${r.block}×${r.count}（最近 ${Math.round(r.nearest)} 格）`);
    const remembered = oreSpotsNear(ctx.memory.landmarks(), { worldId: s.worldId, dim: p.self.dim, pos: here }, { radius: 48 }).length;
    const picks = durabilityFacts(s.inventory, ['pickaxe'], p.storage?.stock);
    const back = passageWayBack(ctx);
    out.push(`下矿的账：${got.length ? `挖到 ${got.join(' ')}` : '还没挖到矿'}；背包空 ${p.emptySlots} 格${picks.length ? `；${picks.join('、')}` : ''}；身边${seen.length ? `看得见 ${seen.join('、')}` : '没看见矿'}${remembered ? `，48 格内记得 ${remembered} 处矿点` : ''}${back ? `；${back}` : ''}。清单后面几项还要不要这些料，一起掂量再决定收不收工`);
  }
  // 顺手采集与不可替代工具：把「看见什么矿 + 现在这类料有多少 + 能做什么」摆成事实，让它在路过矿石时能自己掂量要不要顺手采；
  // 只报事实，采不采、做不做备用工具都由它定（不替它写 gather 或 craft）
  if (ctx.tier === 'deliberate') {
    const ore = oreOpportunityFact(p.nearby.resources, p.storage?.stock, s.inventory);
    if (ore) { out.push(ore); ctx.log?.(ore, { kind: 'ore_opportunity' }); }
  }
  // 工具备份：铁镐 + 铁锭不足 + 没有耐用石镐，这个状态快反应（glance）时也该知道，别等停下来想才说
  const backup = toolBackupFact(s.inventory, p.storage?.stock);
  if (backup) { out.push(backup); ctx.log?.(backup, { kind: 'tool_backup' }); }
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
  // 回地面时给出沿旧矿道回入口的下一步（并核对当前是否还通），不当作已确认的开口。
  if (SURFACE_INTENT.test(intent) && p.self.sky_visible !== true) {
    const back = passageWayBack(ctx);
    if (back) out.push(back);
    else {
      const t = myFacilities(ctx.memory, { worldId: s.worldId, dim: p.self.dim, pos: here }, ['passage']).find((f) => f.inside);
      if (t) out.push(`记得自己挖过的通道，入口参考点 (${Math.round(t.pos.x)},${Math.round(t.pos.y)},${Math.round(t.pos.z)})；当前开口是否可通尚未确认`);
      if (p.self.surface_dir) out.push(`往 ${p.self.surface_dir.dir} 方向约 ${p.self.surface_dir.dist} 格外先有天光，可能更接近洞口/地表（这条路是否可通未确认，走过去再核实）`);
    }
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

const pos3 = (p: [number, number, number]) => p.map((n) => Math.round(n)).join(',');

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
      return `${i}. [${st.done ? 'x' : ' '}] ${st.text}${held ? `（其实不用做：${held}）` : ''}${st.done && st.auto ? '（条件达成，自动勾的）' : !st.done && st.doneWhen ? '（条件达成会自动勾）' : ''}`;
    }), ...(next >= 0 ? { next_item: next } : {}),
      // 进展的事实交给它自己判断：多久没勾掉一项、这期间做了几段活
      no_progress_observed_online_min: Math.round(stall!.minutes), ...(stall!.historyUnknown ? { earlier_online_time: '未知' } : {}),
      activities_since_progress: ctx.self.history(60).filter((r) => r.at > (plan.progressAt ?? plan.setAt)).length } : { checklist: '还没有：写 plan' }),
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
  const digging = !!step && ['gather', 'dig', 'climb_up'].includes(step.skill);
  const material = String((step?.args as Record<string, unknown> | undefined)?.block ?? '');
  const tool = /stone|ore|coal|iron|copper|deepslate/.test(material) ? 'pickaxe' : /dirt|grass|sand|gravel|clay/.test(material) ? 'shovel' : /log|wood/.test(material) ? 'axe' : undefined;
  // 挖的时候身体会自动换上背包里最快的工具；要提醒的是“背包里根本没有合适的工具”
  const ownsTool = tool ? [...inv.keys()].some((n) => n.endsWith(`_${tool}`)) : true;
  return {
    ...(p.self.where ? { where: p.self.where.text } : p.self.overhead ? { overhead: p.self.overhead.block ? `头顶 ${p.self.overhead.up} 格是 ${p.self.overhead.block}` : '头顶一直空着' } : {}),
    pos: pos3(p.self.pos), dim: `${DIM_ZH[p.self.dim] ?? p.self.dim}（${p.self.dim}）`, biome: p.self.biome, sky_visible: p.self.sky_visible ?? null,
    // 血量保留一位小数：半颗心四舍五入成 0 会让模型以为自己已经死了
    hp: Math.round(p.self.hp * 10) / 10, food: p.self.food,
    ...(p.self.inWater ? { inWater: true, oxygen: s.oxygen } : {}), ...(p.self.inLava ? { inLava: true } : {}), ...(p.self.riding ? { riding: p.self.riding } : {}),
    ...(s.dim === 'overworld' ? { time: sunText(p.time.timeOfDay) } : { time: `${DIM_ZH[s.dim] ?? '这里'}没有昼夜（光照恒定）` }),
    ...(s.dim === 'overworld' && p.time.can_sleep === false ? { can_sleep: '还不能睡：要等天黑后（雷雨时随时能睡）' } : {}),
    ...(p.time.weather ? { weather: p.time.weather } : {}),
    ...(p.light ? { light: `${{ bright: '亮', dim: '有点暗', dark: '很暗' }[p.light.level] ?? p.light.level}${p.light.mob_spawn_risk ? '，会刷怪' : ''}` } : {}),
    held: p.self.held ? `${p.self.held}${s.heldDurability ? `（耐久 ${s.heldDurability.left}/${s.heldDurability.max}${s.heldDurability.left / s.heldDurability.max < 0.15 ? `，快坏了${spareNote(s.inventory.find((i) => i.name === p.self.held), s.heldDurability)}` : ''}）` : ''}` : p.self.held,
    // 身上穿戴的（盔甲、副手）：不在背包里，不写出来它就以为自己什么都没穿
    wearing: s.equipment?.length
      ? Object.fromEntries(s.equipment.map((e) => [WEAR_SLOT[e.slot] ?? e.slot, `${e.name}${e.durabilityRemaining !== undefined ? `（耐久剩 ${e.durabilityRemaining}）` : ''}`]))
      : '没穿盔甲，副手空着',
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
      return `${name}×${count}${/_sapling$/.test(name) ? '（可种）' : ''}${it?.stackSize ? `（每叠上限 ${it.stackSize}${multi}${stacks}）` : ''}${durabilityText(it)}${it?.enchanted ? '（附魔）' : ''}`;
    }), empty_slots: `${s.emptySlots} 个空槽（每槽放一叠，不是一件）`,
    // 精确账本的总表（箱子+背包合计）：供"物资充足/稀缺"量化；箱子部分是最后打开时记的，之后世界可能变化
    ...(p.storage?.stock?.length ? { stored_stock: `${p.storage.stored}；以上是「箱子+背包」合计，按最后一次打开各箱子时记录（之后世界可能变化，重新打开才更新）` } : {}),
    ...(s.connected && s.emptySlots <= 5 ? { inventory_space: `空格数是空槽位数量，不是可携带物品数量；${s.emptySlots} 个空槽全部用来放同一种且数据相同的物品时，每叠上限为 64、16、1 的物品分别可放 ${s.emptySlots * 64}、${s.emptySlots * 16}、${s.emptySlots} 个。这些空槽由所有物品共用，并非各物品各有这些空间；当前空间可能随物品变化。已有未满堆的剩余空间只适用于与该堆数据相同的物品，同名物品的属性不同时也不一定能合并。` } : {}),
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
  const placed = memory.queryPlacedNear({ x: here[0], y: here[1], z: here[2] }, 8);
  return {
    ...(p.self.local ? { local: p.self.local } : {}),
    ...(p.self.around ? { around: p.self.around } : {}),
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
  // 自己的设施（箱子、工作站、床、挖过的通道）在 my_facilities 里单独说，这里只列别的地点
  // 矿点按矿种单独列（ore_spots），不和死亡点、基地挤这 8 个位置
  const places = m.landmarks().filter((l) => l.dim === p.self.dim && l.worldId === s.worldId && !FACILITY_LABELS.has(l.label) && !(l.kind === 'resource' && isResourceBlock(l.label)) && l.kind !== 'herd')
    .map((l) => isContainerLandmark(l.label) ? { ...l, ...chestLocation(l) } : { ...l, radius: 0, precise: true })
    .map((l) => ({ l, d: Math.round(Math.hypot(l.pos.x - here.x, l.pos.z - here.z)) })).sort((a, b) => a.d - b.d).slice(0, 8)
    .map(({ l, d }) => `${l.label}[${l.id}] (${Math.round(l.pos.x)},${Math.round(l.pos.y)},${Math.round(l.pos.z)}) ${d}格`);
  const facilities = ctx.tier === 'deliberate' ? myFacilities(m, { worldId: s.worldId, dim: p.self.dim, pos: here }, ['chest', 'station', 'passage']).slice(0, 8).map((f) => f.text) : [];
  const danger = m.hazards(p.self.dim).map((h) => ({ h, d: Math.round(Math.hypot(h.pos.x - here.x, h.pos.z - here.z)) })).filter((e) => e.d < 96).slice(0, 4)
    .map(({ h, d }) => `${h.kind} @(${h.pos.x},${h.pos.y},${h.pos.z}) ${d}格，出过 ${h.count} 次事`);
  // 最近几次死亡地点（事实，不分维度）：Agent 自己判断要不要回到最远点继续，还是绕开
  const lastDeaths = (p.last_deaths ?? []).map((death) => {
    const ago = death.seconds_ago < 90 ? `${death.seconds_ago} 秒前` : death.seconds_ago < 3600 ? `${Math.round(death.seconds_ago / 60)} 分钟前` : `${Math.round(death.seconds_ago / 3600)} 小时前`;
    return `${death.dim} (${death.pos[0]},${death.pos[1]},${death.pos[2]})，${death.cause}，${ago}`;
  });
  const bed = myBed(m, { dim: p.self.dim, worldId: s.worldId, pos: here }, ctx.blockAt);
  const portalSnapshot = travelStore(m).snapshot(s.worldId);
  const portals = portalSnapshot.endpoints.slice(-4).map((e) => {
    const leadsTo = portalSnapshot.routes.filter((r) => r.fromId === e.id).map((r) => ({ to: r.toId, return_verified: r.returnVerified }));
    const nowBlock = ctx.blockAt?.(e.pos) ?? null;
    const now = nowBlock === e.kind ? '亮着'
      : nowBlock === null ? '未加载(未知)'
      : e.kind === 'nether_portal' && (nowBlock === 'air' || nowBlock === 'cave_air' || nowBlock === 'void_air') ? '门未点亮（黑曜石框多半还在）'
      : e.kind === 'nether_portal' && (nowBlock === 'torch' || nowBlock === 'wall_torch') ? '门未点亮（框里插了火把）'
      : `已变(现为 ${nowBlock})`;
    return { id: e.id, dim: e.dim, kind: e.kind, pos: e.pos, ...(leadsTo.length ? { leads_to: leadsTo } : {}), now };
  });
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
    ...(bed ? { my_bed: `(${bed.pos.x},${bed.pos.y},${bed.pos.z}) ${bed.dist}格；要确认它还在不在，直接 inspect_block 这个坐标` } : {}),
    ...(builds.length ? { my_builds: builds.map(describeBuild) } : {}),
    // 建筑师画好、还没盖的图纸：一直惦记着
    ...(drafts.length ? { my_drafts: drafts.map((d) => `${d.id}「${d.name}」${d.size.width}×${d.size.depth}，用料 ${Object.entries(d.materials).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n}×${c}`).join('、')}`) } : {}),
    ...(remember.length ? { resources_seen_before: remember } : {}),
    ...(Object.keys(ores).length ? { ore_spots: ores } : {}),
    ...(Object.keys(herds).length ? { animal_spots: herds } : {}),
    ...(ctx.tier === 'deliberate' ? { places, ...(facilities.length ? { my_facilities: facilities } : {}), ...(portals.length ? { portals } : {}), explored_around: exploredAround(m, p.self.dim, p.self.pos) } : {}),
    ...(danger.length ? { danger_zones: danger } : {}),
    ...(lastDeaths.length ? { last_deaths: lastDeaths } : {}),
    // 自己开了头、要等它自己变化的事：离开时留下的样子和现在看得到的样子
    ...(p.waiting_on?.length ? { waiting_on: p.waiting_on } : {}),
  };
}

function recordLine(r: ActivityRecord, memory: WorldMemory, dimension: string) {
  const g = Object.entries(r.gained).slice(0, 6).map(([k, v]) => `${k}+${v}`).join(' ');
  const l = Object.entries(r.lost).slice(0, 4).map(([k, v]) => `${k}-${v}`).join(' ');
  return { what: recallText(r.what, memory, dimension, r.at), outcome: r.completion === 'condition' ? 'condition_met' : r.outcome, took_real_s: r.durationSec, ...(g ? { gained: g } : {}), ...(l ? { used: l } : {}), summary: recallText(r.summary, memory, dimension, r.at),
    ...(r.facing ? { facing: r.facing } : {}),
    ...(r.expect ? { i_expected: recallText(r.expect, memory, dimension, r.at) } : {}), ...(r.hypothesis ? { hypothesis: recallText(r.hypothesis, memory, dimension, 0) } : {}) };
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
      know_how: self.relevantKnowHow(context, ctx.activity?.kind, glance ? 3 : 6).map((k) => ({ id: k.id, text: recallText(cleanLesson(k.text), ctx.memory, undefined, k.source === 'observed' ? k.createdAt : 0), wins: k.wins, losses: k.losses, unverified: k.unverified === true })),
      ...(!glance && self.experiments().length ? { experiments: self.experiments().map((e) => ({ hypothesis: recallText(e.hypothesis, ctx.memory, undefined, 0), status: e.status, ...(e.evidence ? { evidence: recallText(e.evidence, ctx.memory, undefined, e.at) } : {}) })) } : {}),
      ...(!glance && self.diary().length ? { diary: self.diary(5).map((d) => recallText(d.text, ctx.memory, undefined, 0)) } : {}),
      // 学会的东西只列一张表：技能书里会动手的技能（use_skill 调用）+ 从经历里验证过的做法（直接写成一步）
      ...(!glance && (ctx.learnedSkills?.length || ctx.mySkills.length) ? { my_skills: [...(ctx.learnedSkills ?? []).slice(0, 12),
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
      ...(ctx.recalled?.length ? { memories: ctx.recalled.map((r) => `[${RECALL_LABEL[r.kind]}] ${r.text}`) } : {}),
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
      current_activity: ctx.activity ? describeActivity(ctx.activity, s, p) : null,
      ...(ctx.activity?.why ? { activity_reason_source: '当前活动的 why 是先前选择的理由，不等于观测事实；动作反馈和当前观察可用于核对' } : {}),
      ...(ctx.suspended.length ? { will_resume_after: ctx.suspended.map((a) => a.what) } : {}),
      ...(ctx.next ? { queued_next: `已经想好接下来做「${ctx.next.what}」${ctx.next.why ? `（${ctx.next.why}）` : ''}` } : {}),
      ...(ctx.designing ? { architect_drawing: ctx.designing.brief.slice(0, 60) } : {}),
      ...(ctx.repeatedFailures?.length ? { repeated_failures: ctx.repeatedFailures } : {}),
      ...(ctx.notes.length ? { last_decision_corrections: ctx.notes } : {}),
    }],
    ['身边', surroundingsOf(p, ctx.tier, ctx.memory)],
    ['身体', bodyState(p, s, ctx.activity, self.habits())],
    ...(focusBlock(ctx) ? [['专注', focusBlock(ctx)!] as [string, Record<string, unknown>]] : []),
    ...(ctx.stageReview ? [['阶段回顾', ctx.stageReview] as [string, Record<string, unknown>]] : []),
    ['此刻', {
      why_thinking_now: ctx.reason,
      ...(ctx.recentActionFailures?.length ? { recent_action_failures: { note: '动作结束时的实际反馈，位置和环境可能随后改变', entries: ctx.recentActionFailures } } : {}),
      ...(ctx.recentActionCaveats?.length ? { recent_action_caveats: { note: '动作成功但附带要你掂量的事实，位置和环境可能随后改变', entries: ctx.recentActionCaveats } } : {}),
      noticed: ctx.noticed.map((n) => `${n.what}${n.level === 'urgent' ? '（要紧）' : ''}`),
      since_last_thought: ctx.changes,
      ...(ctx.gameMessages?.length ? { game_messages: ctx.gameMessages } : {}),
      ...(ctx.userSuggestion && !ctx.operatorOrder ? { operator_suggestion: ctx.userSuggestion } : {}),
      ...(audienceBlock(ctx.audience, glance ? 'light' : 'full') ?? {}),
    }],
  ];
  const advanced = p.self.dim !== 'overworld' || s.inventory.some((i) => /ender_(eye|pearl)|obsidian|blaze/.test(i.name));
  const system = glance ? glanceSystem(ctx.persona, ctx.skills ?? []) : deliberateSystem(ctx.persona, ctx.skills ?? []);
  const reminders = situationalReminders(ctx);
  // 进阶动作（下界/末地或已有末影物品才出现）和当前活动用到、目录里没给完整参数的动作：作为提醒补在 user 消息里，
  // system 目录保持字节稳定以命中前缀缓存（见 movesCatalog 注释）。
  if (!glance && advanced) reminders.push(advancedMovesLine());
  else if (glance) {
    const active = [...new Set((ctx.activity?.steps ?? []).map((st) => st.skill))].filter((n) => !GLANCE_CORE.includes(n) && !GLANCE_SECONDARY.includes(n));
    if (active.length) reminders.push(`正在用的动作参数：\n${moveDetails(active)}`);
  }
  // 操作者的指令放在最前面，最后的提醒里再说一遍（开头和结尾模型最不容易忽略）
  const order = ctx.operatorOrder;
  if (order && order.kind === 'suggestion') {
    sections.unshift(['操作者的建议', { suggestion: order.text, received: `${order.ageSec} 现实秒前`, how: '掂量一下：合适就采纳（operator adopted），不合适说一句为什么（declined），之后照自己的节奏玩' }]);
    reminders.unshift(`操作者提了个建议「${order.text.slice(0, 80)}」：采纳还是不采纳，写 operator`);
  } else if (order) {
    sections.unshift(['操作者的指令', { order: order.text, received: `${order.ageSec} 现实秒前`, status: order.status === 'new' ? '刚收到，还没照做' : '照做中', must: '优先于你自己的打算；照做，并在 operator 里回应 doing / done / cannot' }]);
    reminders.unshift(`操作者的指令「${order.text.slice(0, 80)}」${order.status === 'new' ? '刚收到：这一念就照做（把它变成手上的活）' : '还没做完：手上的活要为它服务；做完了就写 done'}，并写 operator`);
  }
  const body = noteGoneSpots(sections.map(([name, data]) => `【${name}】${JSON.stringify(data)}`).join('\n'), ctx.memory, p.self.dim);
  return [{ role: 'system', content: system }, { role: 'user', content: `${body}${reminders.length ? `\n\n【此刻要留意】\n${reminders.map((r) => `- ${r}`).join('\n')}` : ''}\n\n现在你在想什么、打算怎么做？只输出一个 JSON 对象。` }];
}

/**
 * 休息/睡前回想：像人一样把这段时间的零碎经验整理成少数几条靠谱的窍门。
 * 只依据实际成败次数和最近的真实结果，不发明新的事实。
 */
export function buildReflectionMessages(self: SelfModel, persona: string, mySkills: string[] = [], strategy: string[] = [], memory?: WorldMemory): ChatMessage[] {
  const now = Date.now();
  const historical = (text: string, observedAt = 0) => memory ? recallText(text, memory, undefined, observedAt, now) : text;
  const system = `${persona}

你在 Minecraft 里歇下来了（休息、睡觉或者告一段落），回想一下这段时间：哪些办法真的好用，哪些想法被事实推翻了，哪些说的是同一回事。像人一样把零碎的经验整理成少数几条靠谱的窍门。
规则：
- 只依据给出的窍门、成败次数（wins/losses）、零碎想法（insights）和最近的经历（recent），不要编造没发生过的事。
- 说的是同一件事的合并成一条（merge），措辞含糊或太长的改写（rewrite，60 字以内，写清“什么情况下、怎么做、会怎样”）。
- 失败明显多于成功、或被后来的经历推翻的丢掉（drop）；只是一次性的流水账也丢掉。
- 零碎想法里被最近经历证实的，才整理成新的窍门（add，最多 5 条）；没证实的就让它过去。
- 议程里已经过时、做不成或不再想做的，可以放下（agenda_drop）。
- 整理后窍门总数最好不超过 25 条。
- 如果这段时间琢磨出了一整套成体系、以后还会用到的做法（比如怎么在深洞里照明、怎么顺着矿脉找钻石、夜里怎么过），可以写成一份自己的技能（skill：英文小写名字、一句用途、几行 Markdown 写清步骤和要点），以后直接翻开用；已有同名的自己写的技能会被更新。没有就省略。
- 再退一步看看日子是怎么过的（strategy：夜里在哪过、怎么死的、哪些目标耗了很多段活、装备升到哪了、游戏进度到哪了）：
  找出最大的、一再出现的麻烦，问自己“有没有一种根本不同的玩法能让它不再发生”——不是把同一件事做得更用力，而是换个思路（出门时带上什么、把什么搬到哪、换个地方住、先去弄某样东西、干脆放下某件事）。
  换玩法多半是做法上的改变（出门带什么、什么时候收工、在哪冶炼、一次挖多少）：写成一条窍门 add，不进议程。
  只有它要专门花几段活去做成一件事（比如去下界要塞拿烈焰棒、合成末影之眼找要塞）时，才放进议程 agenda_add（{"text":"要做成的事","kind":"idea|goal"}，最多 3 条，写成“做成什么”，不要写成“以后要怎样”）；没想到就不写，不要硬凑。
- 用一句话写日记（diary）记下这段时间最值得记住的事，再用一句独白（monologue）说说现在的感受。
只输出一个 JSON 对象：
{"merge":[{"ids":["k_…","k_…"],"text":"…"}],"rewrite":[{"id":"k_…","text":"…"}],"drop":["k_…"],"add":["…"],"agenda_drop":["a_…"],"agenda_add":[{"text":"…","kind":"idea"}],"skill":{"name":"…","description":"…","body":"…"},"diary":"…","monologue":"…"}`;
  const payload = {
    know_how: self.data.knowHow.map((k) => ({ id: k.id, text: historical(cleanLesson(k.text), k.source === 'observed' ? k.createdAt : 0), wins: k.wins, losses: k.losses, ...(k.unverified ? { unverified: true } : {}),
      age_min: Math.round((now - k.createdAt) / 60000) })),
    insights: self.insights().map((i) => historical(`${i.text}${i.outcome ? `（当时结果：${i.outcome}）` : ''}`)),
    recent: self.history(20).map((r) => historical(`${r.what} → ${r.completion === 'condition' ? 'condition_met' : r.outcome}${Object.keys(r.gained).length ? `，得到 ${Object.entries(r.gained).map(([k, v]) => `${k}×${v}`).join(' ')}` : ''}：${r.summary.slice(0, 180)}`, r.at)),
    experiments: self.experiments(6).map((e) => `${historical(e.hypothesis)} → ${e.status}${e.evidence ? `（${historical(e.evidence.slice(0, 80), e.at)}）` : ''}`),
    agenda: self.agenda().map((a) => ({ id: a.id, text: a.text, kind: a.kind, tried: a.attempts })),
    diary: self.diary(5).map((d) => historical(d.text)),
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

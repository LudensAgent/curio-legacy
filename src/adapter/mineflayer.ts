import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Entity } from 'prismarine-entity';
import type { Block } from 'prismarine-block';
import type { iterators } from 'prismarine-world';
import type { Item } from 'prismarine-item';
import type { Window } from 'prismarine-windows';
import { simplify } from 'prismarine-nbt';
import { crystalArrowShot } from '../combat/ballistics.ts';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';
import { AbortedError, raceAbort, shortId, sleep, throwIfAborted, TimeoutError } from '../util.ts';
import { installClientGuard } from './click-guard.ts';
import { isClimbableBlockName } from './land-rules.ts';
import { AIR_BLOCKS, attachmentFaces, isTreeSaplingItem, saplingSoilFor, saplingSoilText } from '../perception/surroundings.ts';
import { feetCell, facingOfYaw, supportCell } from '../perception/local.ts';
import { bodyOverlapsPortal, PORTAL_KINDS, portalApproach as computePortalApproach, portalStance as computePortalStance } from '../perception/portal.ts';
import { FEET_ARRIVAL_TOLERANCE } from './types.ts';

import type {
  InvItem,
  InventorySlot,
  GuiTarget,
  ActionResult,
  AgentState,
  BlockHit,
  DriveKeys,
  DriveOptions,
  DriveResult,
  EntityInfo,
  EntityKind,
  Eye,
  GameAdapter,
  NavigationDelegate,
  Optics,
  PlacementFaceAttempt,
  MoveOpts,
  MoveTarget,
  Vec3Like,
  PortalTransitionFacts,
  BossDeathObservation,
  SwimOptions,
  SwimFacts,
  SwimGoal,
  SwimStage,
  UseItemOptions,
  GuiOp,
  GuiSlot,
  GuiView,
  GuiContainerObservation,
  GuiResult,
  TradeView,
  FurnaceSlots,
  SmeltOpts,
  SmeltResult,
} from './types.ts';

type PillarClearance = { kind: 'blocked' | 'unknown'; min: Vec3Like; max: Vec3Like; blocks: { pos: Vec3Like; rel?: [number, number, number]; facing?: string }[] };

/** 世界坐标 → 以脚为原点的 [前,上,右]（与 mine_cell 的 toWorld 互为逆运算），让心智能直接对着障碍格下 mine_cell */
const REL_FORWARD: Record<string, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const REL_RIGHT: Record<string, [number, number]> = { N: [1, 0], E: [0, 1], S: [-1, 0], W: [0, -1] };
function relToBody(feet: Vec3Like, facing: string, block: Vec3Like): [number, number, number] {
  const dx = block.x - feet.x, dz = block.z - feet.z;
  const fw = REL_FORWARD[facing] ?? [0, -1], rt = REL_RIGHT[facing] ?? [1, 0];
  return [dx * fw[0] + dz * fw[1], block.y - feet.y, dx * rt[0] + dz * rt[1]];
}

/** 相对坐标 → 自然语言方向（“身后 1 格、上方 2 格”）：心智对“前=-1”这类负向坐标解析不稳 */
function relWords(rel: [number, number, number]): string {
  const [f, u, r] = rel;
  const parts: string[] = [];
  if (f !== 0) parts.push(`${f > 0 ? '前方' : '身后'} ${Math.abs(f)} 格`);
  if (u !== 0) parts.push(`${u > 0 ? '上方' : '下方'} ${Math.abs(u)} 格`);
  if (r !== 0) parts.push(`${r > 0 ? '右侧' : '左侧'} ${Math.abs(r)} 格`);
  return parts.join('、');
}

function describePillarClearance(clearance: PillarClearance): string {
  const { min, max } = clearance;
  const range = `跳跃时身体扫过的方块范围 x=${min.x}..${max.x}, y=${min.y}..${max.y}, z=${min.z}..${max.z}`;
  // 只报“挡在哪几格”，不报方块名：跳起来撞到的位置是身体能感知的（本体感觉），
  // 方块名称属于看不到的透视信息，交给心智/技能自己看清或动手再确认。
  // 但补上相对身体的 [前,上,右] 坐标、自然语言方向、朝向和 mine_cell 参数：否则心智要从绝对坐标反推相对坐标，窄竖井里容易挖错格。
  if (clearance.kind === 'blocked') {
    const cells = clearance.blocks.slice(0, 4).map((blk) => blk.rel
      ? `(${blk.pos.x},${blk.pos.y},${blk.pos.z})【${relWords(blk.rel)}】[前,上,右]=[${blk.rel[0]},${blk.rel[1]},${blk.rel[2]}]（朝向 ${blk.facing}）→ mine_cell {"at":[${blk.rel[0]},${blk.rel[1]},${blk.rel[2]}],"facing":"${blk.facing}"}`
      : `(${blk.pos.x},${blk.pos.y},${blk.pos.z})`);
    const more = clearance.blocks.length > 4 ? `；还有 ${clearance.blocks.length - 4} 格` : '';
    return `头顶跳跃空间受阻；${range}，要跳起来得先把这几格都挖空（方块名未确认）：${cells.join('；')}${more}`;
  }
  return `头顶跳跃空间未加载；${range}，具体未加载位置未确认`;
}

const require = createRequire(import.meta.url);
/**
 * 运行时依赖只在模块加载时取一次。以前 vec() 里每次都 require('vec3')：每次都要走一遍模块解析（运行器的钩子不缓存，
 * 每次都翻 node_modules、读 package.json），blockAt 一秒调用上万次时主线程能卡上 5~10 秒，服务器就以超时踢人（10-28 08:53 采样）
 */
const { Vec3 } = require('vec3');

/** 右键一点就打开、触发的方块：贴着它放东西要按住潜行 */
const OPENS_ON_CLICK = /chest$|barrel|crafting_table|furnace|smoker|_door$|_trapdoor$|_fence_gate$|_button$|lever|_bed$|anvil|enchanting_table|brewing_stand|loom|stonecutter|grindstone|smithing_table|cartography_table|hopper|dispenser|dropper|shulker_box|note_block|jukebox|beacon|lectern|bell|repeater|comparator|cake/;
const isLocalStorage = (name: string) => ['chest', 'trapped_chest', 'barrel'].includes(name) || name.endsWith('shulker_box');

/** Call only with acknowledged container slots, so partial operations remain factual. */
function observeStorage(block: string, items: { name: string; count: number }[], previous?: GuiContainerObservation, containerSlots?: (Item | null)[]): GuiContainerObservation {
  const totals = new Map<string, number>();
  items.forEach((item) => totals.set(item.name, (totals.get(item.name) ?? 0) + item.count));
  const after = [...totals].map(([name, count]) => ({ name, count }));
  const capacity = containerSlots ? containerSlots.length : undefined;
  const freeSlots = containerSlots ? containerSlots.filter((s) => !s).length : undefined;
  const cap = capacity !== undefined && freeSlots !== undefined ? { capacity, freeSlots } : {};
  if (!previous) return { block, ...cap, before: after, after, put: [], took: [] };
  const before = new Map(previous.after.map((item) => [item.name, item.count]));
  const put = new Map(previous.put.map((item) => [item.name, item.count]));
  const took = new Map(previous.took.map((item) => [item.name, item.count]));
  [...new Set([...before.keys(), ...totals.keys()])].forEach((name) => {
    const delta = (totals.get(name) ?? 0) - (before.get(name) ?? 0);
    if (delta > 0) put.set(name, (put.get(name) ?? 0) + delta);
    if (delta < 0) took.set(name, (took.get(name) ?? 0) - delta);
  });
  return { block, ...cap, before: previous.before, after, put: [...put].map(([name, count]) => ({ name, count })), took: [...took].map(([name, count]) => ({ name, count })) };
}

const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'creeper', 'spider',
  'cave_spider', 'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker',
  'vex', 'ravager', 'silverfish', 'endermite', 'blaze', 'ghast', 'wither_skeleton', 'guardian',
  'elder_guardian', 'hoglin', 'zoglin', 'piglin_brute', 'warden', 'shulker', 'ender_dragon',
]);
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'wolf', 'bee', 'iron_golem', 'llama', 'panda', 'polar_bear', 'dolphin', 'goat']);
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit']);
const WEAPON_ORDER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
/**
 * 发到游戏聊天的文字：以 / 开头会被服务器当成命令执行（/op、/give…）。
 * 机器人说的话可能间接受观众弹幕影响，所以一律不允许以命令开头。
 */
export function safeChat(text: string): string {
  const t = text.normalize('NFKC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return /^[/／\\!]/.test(t) ? `· ${t.replace(/^[/／\\!]+/, '')}` : t;
}

const RAW_FOOD = /^(beef|porkchop|chicken|mutton|rabbit|cod|salmon|potato|tropical_fish)$/;
const PROTECTED_BLOCKS = ['chest', 'trapped_chest', 'crafting_table', 'furnace', 'barrel', 'white_bed', 'red_bed'];

const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
const ORE_BASE = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald'];
const ALIASES: Record<string, string[]> = {
  log: LOGS, logs: LOGS, wood: LOGS, tree: LOGS,
  stone: ['stone'],
  dirt: ['dirt', 'grass_block'],
  ore: ORE_BASE.flatMap((o) => [`${o}_ore`, `deepslate_${o}_ore`]),
  ...Object.fromEntries(ORE_BASE.map((o) => [o, [`${o}_ore`, `deepslate_${o}_ore`]])),
};


/** 界面里每一格是干什么的——玩家打开界面一眼就看得出（画着燃料、箭头、模板的轮廓） */
const GUI_ROLES: Record<string, string[]> = {
  furnace: ['原料', '燃料', '产物'], blast_furnace: ['原料', '燃料', '产物'], smoker: ['原料', '燃料', '产物'],
  brewing_stand: ['药水瓶', '药水瓶', '药水瓶', '材料', '烈焰粉（燃料）'],
  anvil: ['要修/改名的物品', '材料或附魔书', '产物（消耗经验）'],
  grindstone: ['物品', '物品', '产物（去掉附魔、返还少量经验）'],
  smithing: ['锻造模板', '装备', '材料（下界合金锭/纹饰材料）', '产物'],
  stonecutter: ['原料', '产物（先用 button 选配方）'],
  loom: ['旗帜', '染料', '旗帜图案（可选）', '产物（先用 button 选图案）'],
  cartography: ['地图', '纸/玻璃板/空地图', '产物'],
  enchantment: ['要附魔的物品', '青金石'],
  crafting: ['产物', '合成格', '合成格', '合成格', '合成格', '合成格', '合成格', '合成格', '合成格', '合成格'],
  beacon: ['支付物品（铁/金/绿宝石/钻石/下界合金锭）'],
};

const WOOL_ZH = ['白', '橙', '品红', '淡蓝', '黄', '黄绿', '粉红', '灰', '淡灰', '青', '紫', '蓝', '棕', '绿', '红', '黑'];
const PROFESSIONS = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith'];
const PROFESSION_ZH: Record<string, string> = { none: '无业', armorer: '盔甲匠', butcher: '屠夫', cartographer: '制图师', cleric: '牧师', farmer: '农民', fisherman: '渔夫', fletcher: '制箭师', leatherworker: '皮匠', librarian: '图书管理员', mason: '石匠', nitwit: '傻子（不交易）', shepherd: '牧羊人', toolsmith: '工具匠', weaponsmith: '武器匠' };
/** 效果到点后几秒内还没收到“结束”包也当作结束（包可能晚到） */
const EFFECT_GRACE_S = 3;
export function remainingEffects(effects: Record<string, any>, seenAt: Map<number, number>, now = Date.now()): { e: any; seconds: number }[] {
  const out: { e: any; seconds: number }[] = [];
  for (const [k, e] of Object.entries(effects)) {
    const total = (e.duration ?? 0) / 20;
    // 时长为负是“无限”（信标、指令给的）：不往下数
    if (total < 0) { out.push({ e, seconds: 0 }); continue; }
    if (!seenAt.has(e.id)) seenAt.set(e.id, now);
    const left = total - (now - seenAt.get(e.id)!) / 1000;
    if (left < -EFFECT_GRACE_S) { delete effects[k]; seenAt.delete(e.id); continue; }
    out.push({ e, seconds: Math.max(0, Math.round(left)) });
  }
  return out;
}
export function clearSelfEffects(bot: any, seenAt: Map<number, number>) {
  const effects = bot.entity?.effects;
  if (effects) for (const k of Object.keys(effects)) delete effects[k];
  seenAt.clear();
}

const EFFECT_ZH: Record<string, string> = { speed: '迅捷', slowness: '缓慢', haste: '急迫', mining_fatigue: '挖掘疲劳', strength: '力量', instant_health: '瞬间治疗', instant_damage: '瞬间伤害', jump_boost: '跳跃提升', nausea: '反胃', regeneration: '生命恢复', resistance: '抗性提升', fire_resistance: '抗火', water_breathing: '水下呼吸', invisibility: '隐身', blindness: '失明', night_vision: '夜视', hunger: '饥饿（吃了不该吃的，饥饿掉得快）', weakness: '虚弱', poison: '中毒（掉血到半颗心为止）', wither: '凋零（会掉血致死）', health_boost: '生命提升', absorption: '伤害吸收', saturation: '饱和', glowing: '发光', levitation: '飘浮', luck: '幸运', unluck: '霉运', slow_falling: '缓降', conduit_power: '潮涌能量', dolphins_grace: '海豚的恩惠', bad_omen: '不祥之兆（进村会引来袭击）', hero_of_the_village: '村庄英雄', darkness: '黑暗' };

/**
 * 自己的憋气值（0–20）。mineflayer 把收到的每个生物的 air_supply 都写进 bot.oxygenLevel，不看是不是自己：
 * 旁边有海豚（最多 4800 tick）就显示 300 多，旁边有快淹死的怪又会显得很低。只读自己实体的元数据才可靠。
 */
export function ownOxygen(b: any): number {
  const keys = b?.registry?.entitiesByName?.player?.metadataKeys;
  const i = Array.isArray(keys) && keys.includes('air_supply') ? keys.indexOf('air_supply') : 1;
  const raw = b?.entity?.metadata?.[i];
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.min(20, Math.round(raw / 15)));
  const level = Number(b?.oxygenLevel);
  return Number.isFinite(level) ? Math.max(0, Math.min(20, Math.round(level))) : 20;
}

/**
 * 死亡/重生后把自己的憋气值复位成满（300 = 20 格）。服务器只发“变了的”元数据：新生成的玩家憋气是默认满值，不会发包，
 * mineflayer 却沿用同一个 bot.entity，元数据里还留着淹死前的 0，导致重生后氧气状态不准确。
 */
export function resetOwnOxygen(b: any) {
  const keys = b?.registry?.entitiesByName?.player?.metadataKeys;
  const i = Array.isArray(keys) && keys.includes('air_supply') ? keys.indexOf('air_supply') : 1;
  if (b?.entity?.metadata && typeof b.entity.metadata[i] === 'number') b.entity.metadata[i] = 300;
  if (b && 'oxygenLevel' in b) b.oxygenLevel = 20;
}

/** 没有对应工具时，空手挖一格最多肯花多久（超过就当挖不动：黑曜石之类） */
const HAND_DIG_MAX_MS = 30_000;
/** 扔掉的东西多久之内算“自己刚扔的”（掉落物标出来；被捡回来时报一句） */
const DISCARD_MS = 3 * 60_000;

/** 船：每刻桨力（极速 = 桨力 ×10 格/刻；0.028 ≈ 5.6 格/秒，原版满桨 0.04 ≈ 8 格/秒）、船头每刻最多转多少、方向差多少以内才划 */
const BOAT_THRUST = 0.028;
const BOAT_TURN = (9 * Math.PI) / 180;
const BOAT_ROW_ANGLE = (35 * Math.PI) / 180;

export class MineflayerAdapter extends EventEmitter implements GameAdapter {
  bot: any = null;
  mcData: any = null;
  private connectedFlag = false;
  private reconnectAttempts = 0;
  private stopped = false;
  private initialized = false;
  private spawned = false;
  private sessionId = shortId('session_');
  private observationId = 0;
  private dimension = 'unknown';
  private actionEpoch = 0;
  private actionContext = new AsyncLocalStorage<(() => void) & { signal?: AbortSignal }>();
  /** 举盾的持续按住：mineflayer 在 entity_status/set_cooldown 时清 usingHeldItem，盾一挨打就掉；这里定时重举，直到 raiseShield(false) 或动作换主 */
  private shieldHold: { interval: NodeJS.Timeout; epoch: number } | null = null;
  /** 正在进行的底层动作数（afterAction 包着的）；为 0 时才算空闲 */
  private inFlight = 0;
  /** 打断后的“收拾残局”：下一个碰背包/界面的动作要等它做完，免得两边的点击交错 */
  private repairing: Promise<void> | null = null;
  private hygieneTimer: NodeJS.Timeout | null = null;
  private guardedClients = new WeakSet<object>();
  private dragonDeath: BossDeathObservation | null = null;
  /**
   * runSkill 在任务生命周期内绑定的非本地导航委托。只随 run 的异步作用域传播，
   * 覆盖适配器私有方法发起的 moveTo；嵌套技能会绑定自己的委托与期限。
   */
  private navigationDelegate = new AsyncLocalStorage<NavigationDelegate>();
  /**
   * 非本地 moveTo 的执行偏好（如 sprint）随同一异步作用域传给内部
   * 逐段 feet/ladder 身体控制；不是新的任务预算或权限来源。
   */
  private delegatedMoveOptions = new AsyncLocalStorage<{ sprint: boolean }>();
  /** 正在等一次跨维度传送落地：newSession 不打断这个动作，让 enterPortalAt 自己确认切换成功 */
  private inPortalTransition = false;

  private newSession() {
    this.dragonDeath = null;
    this.spawned = false;
    const previousSessionId = this.sessionId;
    this.sessionId = shortId('session_');
    this.observationId = 0;
    // 跨维度传送会等维度真正切过去再自己验收；这里不 stopAll，否则把正在等落地的动作掐成「断线」
    if (!this.inPortalTransition) this.stopAll();
    // 真实会话身份变化是共享空间记忆的唯一生命周期信号；载荷里没有状态，消费者不能回调 state()。
    // 监听器异常只记诊断，不能中断 newSession/end 的后续处理。
    if (this.sessionId !== previousSessionId) {
      try {
        this.emit('session_reset');
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        // Unknown boundary: keep a typed own `kind` that domain errors carry alongside name/message.
        const kind = error !== null && typeof error === 'object' && 'kind' in error && typeof error.kind === 'string' ? ` kind=${error.kind}` : '';
        this.bus.publish('adapter_event_error', 'P1', `session_reset listener failed: ${detail}${kind}`);
      }
    }
  }

  private currentDimension() {
    return String(this.bot?.game?.dimension ?? 'unknown').replace('minecraft:', '');
  }

  private worldIdentity() { return this.cfg.memory?.worldId || `${this.cfg.mc.host}:${this.cfg.mc.port}`; }

  /** 连着点了多少下界面（两下之间没歇过 1 秒）：慢速版的点击失控保护 */
  private pacedClicks = 0;
  private lastPacedClick = 0;

  /**
   * 界面节奏（UI_PACING_MS / UI_OPEN_HOLD_MS / UI_CLOSE_HOLD_MS）：默认逐次点击约 300ms 并在窗口开关时短暂停留，模拟真实玩家节奏。
   * Mineflayer 补丁（scripts/patch-deps.mjs）让 craft / transfer / deposit / withdraw / toss / equip 的点击经过 beforeWindowClick。
   */
  private installUiPacing(bot: any) {
    const ui = this.cfg.ui ?? { pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 };
    bot.beforeWindowClick = async (slot: number, _button: number, mode: number) => {
      const window = bot.currentWindow ?? bot.inventory;
      const now = Date.now();
      this.pacedClicks = now - this.lastPacedClick > 1000 ? 1 : this.pacedClicks + 1;
      this.lastPacedClick = now;
      // 点击失控（见 click-guard.ts）：放慢之后循环不再撑爆内存，但也不能让它无休止地点下去
      if (this.pacedClicks > 400) {
        this.pacedClicks = 0;
        this.scheduleRepair('界面点击失控（慢速）', 500);
        throw new Error('CLICK_LOOP: 连续点了 400 下界面还没停（多半是窗口已经关了），中止这次界面操作');
      }
      // Publish the target before waiting: the observer moves the still-held
      // stack to this slot while the real action waits, then sees the click.
      const ms = Math.max(0, mode === 1 ? Math.round(ui.pacingMs * 0.6) : ui.pacingMs);
      bot.emit?.('observerWindowClick', slot, ms);
      if (ms > 0) await sleep(ms, this.actionContext.getStore()?.signal);
      if ((bot.currentWindow ?? bot.inventory) !== window) throw new Error('WINDOW_CHANGED: 点击等待期间窗口已改变');
    };
    // Internal item-use and placement paths equip directly too. Observe their
    // actual inventory clicks without opening a GUI for hotbar-only selection.
    for (const name of ['equip', 'unequip']) {
      const original: ((...args: unknown[]) => Promise<unknown>) | undefined = bot[name];
      if (typeof original !== 'function') continue;
      bot[name] = (...args: unknown[]) => this.withObservedInventory(this.actionContext.getStore()?.signal,
        () => original.apply(bot, args));
    }
    if (ui.openHoldMs > 0) {
      // 开窗后停一下；附魔台和熔炉先安装属性监听，再执行停留。
      const specializedOpen = new AsyncLocalStorage<boolean>();
      for (const name of ['openBlock', 'openEntity', 'openEnchantmentTable', 'openFurnace']) {
        const orig = bot[name];
        if (typeof orig !== 'function') continue;
        bot[name] = async (...args: any[]) => {
          const w = await (name === 'openEnchantmentTable' || name === 'openFurnace' ? specializedOpen.run(true, () => orig.apply(bot, args)) : orig.apply(bot, args));
          // These helpers install property listeners after openBlock returns.
          if (name === 'openBlock' && specializedOpen.getStore()) return w;
          try { await sleep(ui.openHoldMs, this.actionContext.getStore()?.signal); } catch (e) { try { w?.close?.() ?? bot.closeWindow(w); } catch { /* ignore */ } throw e; }
          return w;
        };
      }
    }
  }

  /** 关窗前停一下，让观众看清结果；动作已被打断就立刻关 */
  private async uiCloseHold(signal?: AbortSignal) {
    const ms = this.cfg.ui?.closeHoldMs ?? 0;
    if (ms <= 0 || signal?.aborted) return;
    await sleep(ms, signal).catch(() => {});
  }

  private readonly inventoryObservation = new AsyncLocalStorage<object>();

  /** Present inventory clicks as a virtual window, but leave hotbar-only changes invisible. */
  private async withObservedInventory<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const b = this.bot, beforeClick = b.beforeWindowClick;
    if (this.inventoryObservation.getStore() === b) return operation();
    let opened = false;
    const observeClick = async (...args: any[]) => {
      if (!opened && !b.currentWindow) {
        opened = true;
        this.emit('inventory_open');
        await sleep(this.cfg.ui?.openHoldMs ?? 0, signal);
      }
      if (beforeClick) await beforeClick.apply(b, args);
    };
    b.beforeWindowClick = observeClick;
    try { return await this.inventoryObservation.run(b, operation); }
    finally {
      if (b.beforeWindowClick === observeClick) b.beforeWindowClick = beforeClick;
      if (opened) { await this.uiCloseHold(signal); this.emit('inventory_close'); }
    }
  }

  /** A pending transaction must never continue issuing commands after its owner ends. */
  private actionCheckpoint(signal?: AbortSignal) {
    const epoch = this.actionEpoch;
    const bot = this.bot;
    const dim = this.currentDimension();
    const check = () => {
      throwIfAborted(signal);
      if (epoch !== this.actionEpoch || bot !== this.bot || dim !== this.currentDimension()) throw new AbortedError('action ownership changed');
    };
    check();
    return Object.assign(check, { signal });
  }

  private async afterAction<T>(operation: () => Promise<T>, check: (() => void) & { signal?: AbortSignal }): Promise<T> {
    check();
    // Mineflayer's own helpers may await look/transaction acknowledgements before
    // writing their next packet. Preserve ownership through those continuations.
    const client = this.bot?._client;
    if (client && !this.guardedClients.has(client)) {
      const context = this.actionContext;
      installClientGuard(client, {
        guard: () => context.getStore(),
        // 界面点击失控（见 click-guard.ts）：记下当时的窗口和光标，事后能看出是哪种操作
        onLoop: (clicks) => {
          const b = this.bot;
          queueMicrotask(() => this.bus.publish('click_loop', 'P1', `界面点击失控，已中止：同一轮连续点了 ${clicks} 下（窗口 ${b?.currentWindow?.type ?? '背包'}，光标上 ${b?.inventory?.selectedItem?.name ?? b?.currentWindow?.selectedItem?.name ?? '没东西'}）`,
            { clicks, window: b?.currentWindow?.type ?? null, selected: b?.currentWindow?.selectedItem?.name ?? b?.inventory?.selectedItem?.name ?? null, emptySlots: b?.inventory?.emptySlotCount?.() ?? null }));
          this.scheduleRepair('界面点击失控', 500);
        },
      });
      this.guardedClients.add(client);
    }
    this.inFlight++;
    const promise = this.actionContext.run(check, operation);
    promise.finally(() => { this.inFlight--; }).catch(() => {});
    promise.then((late: any) => { try { check(); } catch { try { late?.close?.(); } catch { /* ignore */ } } }, () => {});
    const value = await raceAbort(promise, check.signal, undefined, () => {});
    try { check(); } catch (error) {
      // A container can finish opening after cancellation. Close that late window.
      try { (value as any)?.close?.(); } catch { /* ignore */ }
      throw error;
    }
    return value;
  }

  constructor(private cfg: Config, private bus: EventBus) {
    super();
  }

  // ---------------------------------------------------------------- 连接管理
  connect() {
    this.newSession();
    this.connectedFlag = false;
    const mineflayer = require('mineflayer');
    const { host, port, username, version } = this.cfg.mc;
    this.bus.publish('connect', 'P3', `连接 ${host}:${port} (${version}) 用户名 ${username}`);

    // 向服务器请求尽可能大的视距；服务器会按 view-distance 截断
    const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline', viewDistance: 32 });
    this.bot = bot;
    this.guardPrePlayWrites(bot);
    // Mineflayer 在 inject_allowed 才注入 openBlock 等方法；注入后再包装。
    bot.once('inject_allowed', () => {
      this.installUiPacing(bot);
      if ((this.cfg.ui?.pacingMs ?? 0) > 0 && (typeof bot.clickWindow !== 'function' || !Function.prototype.toString.call(bot.clickWindow).includes('/* curio-patch: window click hook */'))) {
        this.bus.publish('ui_pacing_unavailable', 'P1', 'Mineflayer 界面点击节奏补丁未生效，点击不会按 UI_PACING_MS 放慢；请运行 node scripts/patch-deps.mjs 并重启');
      }
    });
    // mineflayer 4.39 的下船检测有缺陷：1.9+ 服务器下船时发的是 set_passengers(船, [其余乘客])，
    // 里面已经没有 bot，而 mineflayer 只在“乘客里有 bot 且 entityId = -1”时才清 bot.vehicle、发 dismount——这种包服务器从不发。
    // 结果 bot.vehicle 一直挂着：dismount 等不到事件报 DISMOUNT_FAILED，走路报 RIDING，坐船时关掉的物理也恢复不了，人卡在水里。
    // 这里自己补上：船的乘客名单里没有自己了，就算下船了。
    bot._client.on('set_passengers', (pk: any) => {
      try { this.syncDismount(bot, pk); } catch { /* ignore */ }
    });
    // 捡起了自己刚扔掉的东西（不管是动作顺手捡的，还是走到掉落物上自动捡起的）：只报事实，让上层知道“扔了又捡回来了”
    bot.on('playerCollect', (collector: any, collected: any) => {
      try {
        if (collector !== bot.entity || !collected?.position) return;
        const di = collected.getDroppedItem?.();
        if (!di?.name || !this.isDiscarded(di.name, collected.position)) return;
        this.emit('recollected', { item: di.name, count: di.count ?? 1 });
      } catch { /* ignore */ }
    });
    // 自己挖掉的每一格（不管是哪个动作、代码技能还是寻路挖的）：记自己挖过的通道和挖掘耗时用
    bot.on('diggingCompleted', (block: any) => {
      try {
        if (!block?.position) return;
        const now = Date.now();
        const started = this.digStart;
        const matched = started && started.pos.x === block.position.x && started.pos.y === block.position.y && started.pos.z === block.position.z;
        this.dugLog.push({
          pos: { x: block.position.x, y: block.position.y, z: block.position.z }, name: String(block.name ?? ''), ts: now,
          // 用开挖前的实际手持工具：最后一格把镐用坏时，完成瞬间 heldItem 可能已经是空手。
          // 寻路/外部挖的没有本次动作的开始时间，只能用完成时主手；ms 记 0 表示“没有实测”。
          tool: matched ? started.tool : this.bot?.heldItem?.name ?? null,
          ms: matched ? now - started.ts : 0,
        });
        if (this.dugLog.length > 512) this.dugLog.splice(0, this.dugLog.length - 512);
      } catch { /* ignore */ }
    });

    bot.on('spawn', () => {
      this.newSession();
      // 空闲时巡一眼：有半截交互残留就收拾（不打扰正在进行的动作）
      if (!this.hygieneTimer) {
        this.hygieneTimer = setInterval(() => { if (this.inFlight === 0 && !this.repairing && this.interactionDirty().length) this.scheduleRepair('空闲时发现残留'); }, 5000);
        this.hygieneTimer.unref?.();
      }
      this.dimension = this.currentDimension();
      this.spawned = true;
      if (!this.mcData) this.mcData = require('minecraft-data')(bot.version);
      this.connectedFlag = true;
      this.reconnectAttempts = 0;
      if (!this.initialized) {
        this.initialized = true;
        this.startViewer();
      }
      this.emit('spawn');
    });
    // 死亡会清掉所有状态效果，但服务器不会逐个发“效果结束”：自己清，免得重生后还以为中着毒
    bot.on('death', () => { clearSelfEffects(bot, this.effectSeenAt); resetOwnOxygen(bot); this.newSession(); this.emit('death'); });
    // Mineflayer 只记包里的时长、不往下数：记下收到的时刻，读的时候自己减
    bot.on('entityEffect', (e: any, eff: any) => { if (e === bot.entity) this.effectSeenAt.set(eff.id, Date.now()); });
    bot.on('entityEffectEnd', (e: any, eff: any) => { if (e === bot.entity) this.effectSeenAt.delete(eff.id); });
    bot.on('respawn', () => { resetOwnOxygen(bot); this.newSession(); this.emit('respawn'); });
    bot.on('entityHurt', (e: any) => {
      if (e === bot.entity) this.emit('hurt', this.hurtCause());
    });
    bot.on('entityDead', (entity: any) => {
      if (entity.name !== 'ender_dragon' || !entity.position || !this.spawned) return;
      this.dragonDeath = { entityId: entity.id, worldId: this.worldIdentity(), dim: this.currentDimension(), sessionId: this.sessionId, observedAt: Date.now(), pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, source: 'entity_dead' };
    });
    bot.on('entityUpdate', (entity: any) => {
      if (entity.name !== 'ender_dragon' || !entity.position || !this.spawned) return;
      const keys: string[] = this.mcData?.entitiesByName?.ender_dragon?.metadataKeys ?? [];
      const hp = entity.metadata?.[keys.indexOf('health')];
      const phase = entity.metadata?.[keys.indexOf('phase')];
      if (Number.isFinite(hp) && hp <= 0 && phase === 9) this.dragonDeath = { entityId: entity.id, worldId: this.worldIdentity(), dim: this.currentDimension(), sessionId: this.sessionId, observedAt: Date.now(), pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, source: 'zero_health_dying' };
    });
    bot.on('kicked', (reason: unknown) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.emit('kicked', text);
    });
    bot.on('error', (err: Error) => this.bus.publish('bot_error', 'P1', String(err?.message ?? err)));
    bot.on('chat', (user: string, message: string) => {
      if (user && user !== bot.username) this.emit('chat', user, message);
    });
    // 游戏自己的系统消息（死亡播报、成就、进出服务器、公告）：原样交给上层记进记忆
    bot.on('messagestr', (message: string, position: string) => {
      if (position === 'system' && typeof message === 'string' && message.trim()) this.emit('game_message', message, position);
    });
    bot.on('end', (reason: string) => {
      this.newSession();
      this.connectedFlag = false;
      this.emit('disconnected', reason);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  /**
   * 断线重连时，上一条连接里还没收尾的动作、定时器可能拿着新的 bot 发包；新连接还在登录阶段时，
   * 游戏内的包（转头、点窗口……）在服务器看来是坏包，直接以 DecoderException 踢掉（10-28 08:22 连续几次）。
   * 进游戏之前只放行握手/登录需要的包，其它的丢掉并记一笔，以后好查是谁在发
   */
  private guardPrePlayWrites(bot: any) {
    const client = bot._client;
    if (!client || typeof client.write !== 'function') return;
    const PRE_PLAY = new Set(['set_protocol', 'legacy_server_list_ping', 'ping_start', 'ping', 'login_start', 'encryption_begin', 'login_plugin_response', 'login_acknowledged']);
    const write = client.write.bind(client);
    let reported = 0;
    client.write = (name: string, params: unknown) => {
      if (client.state === 'play' || PRE_PLAY.has(name)) return write(name, params);
      if (reported++ < 5) this.bus.publish('net_guard', 'P2', `还没进游戏（${client.state}）就有代码想发 ${name} 包，丢掉了：多半是断线前没收尾的动作`, { name, state: client.state, stack: new Error().stack?.split('\n').slice(2, 7).join(' | ') });
    };
  }

  private scheduleReconnect() {
    const delay = Math.min(30000, 2000 * 2 ** this.reconnectAttempts++);
    this.bus.publish('reconnect', 'P1', `${Math.round(delay / 1000)} 秒后重连（第 ${this.reconnectAttempts} 次）`);
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  quit() {
    this.stopped = true;
    try { this.bot?.quit(); } catch { /* ignore */ }
  }

  private startViewer() {
    if (!this.cfg.viewerPort) return;
    try {
      const { mineflayer: viewer } = require('prismarine-viewer');
      viewer(this.bot, { port: this.cfg.viewerPort, firstPerson: false });
      this.bus.publish('viewer', 'P3', `prismarine-viewer: http://localhost:${this.cfg.viewerPort}`);
    } catch (e: any) {
      this.bus.publish('viewer', 'P1', `prismarine-viewer 未启用：${e?.message ?? e}`);
    }
  }

  private get ready() {
    return this.connectedFlag && this.bot?.entity && this.mcData;
  }

  private vec(p: Vec3Like) {
    return new Vec3(p.x, p.y, p.z);
  }

  // ---------------------------------------------------------------- 视觉原语
  private opticsByState = new Map<number, Optics>();
  private tmpVec: any = null;

  private tmp(x: number, y: number, z: number) {
    if (!this.tmpVec) this.tmpVec = this.vec({ x: 0, y: 0, z: 0 });
    this.tmpVec.x = x;
    this.tmpVec.y = y;
    this.tmpVec.z = z;
    return this.tmpVec;
  }

  eye(): Eye | null {
    if (!this.ready) return null;
    const e = this.bot.entity;
    return { x: e.position.x, y: e.position.y + (e.eyeHeight ?? 1.62), z: e.position.z, yaw: e.yaw, pitch: e.pitch };
  }

  sectionEmpty(x: number, y: number, z: number): boolean {
    if (!this.ready) return false;
    try {
      const col = this.bot.world.getColumnAt(this.tmp(x, y, z));
      if (!col || !Array.isArray(col.sections)) return false; // 未加载或旧格式：不跳过
      const sec = col.sections[(y - (col.minY ?? 0)) >> 4];
      if (sec === undefined) return false;
      return !sec || (typeof sec.isEmpty === 'function' && sec.isEmpty());
    } catch {
      return false;
    }
  }

  renderDistance(): number | null {
    if (!this.ready) return null;
    const server = Number(this.bot.game?.serverViewDistance);
    const client = typeof this.bot.settings?.viewDistance === 'number' ? this.bot.settings.viewDistance : 12;
    const chunks = Number.isFinite(server) && server > 0 ? Math.min(server, client) : null;
    return chunks ? chunks * 16 : null;
  }

  private classifyOptics(b: any, stateId?: number): Optics {
    const name: string = b?.name ?? 'air';
    let kind: Optics['kind'] = 'solid';
    if (name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'light' || name === 'structure_void' || name === 'barrier') kind = 'clear';
    else if (name === 'water' || name === 'bubble_column' || name === 'kelp' || name === 'kelp_plant' || name === 'seagrass' || name === 'tall_seagrass') kind = 'water';
    else if (name === 'lava') kind = 'solid';
    else if (name.endsWith('_leaves')) kind = 'foliage';
    else if (name.includes('glass')) kind = 'clear';
    else if (b?.boundingBox === 'empty') kind = 'clear'; // 草、花、火把、铁轨等
    if ((name === 'iron_bars' || name.endsWith('_door')) && Number.isInteger(stateId)) {
      const definitions = this.mcData.blockCollisionShapes;
      const palette = definitions?.blocks?.[name];
      const offset = stateId! - this.mcData.blocksByName[name].minStateId;
      const shapeId = Array.isArray(palette) ? palette[offset] : palette;
      const boxes = definitions?.shapes?.[shapeId];
      if (Array.isArray(boxes) && boxes.length && boxes.every((box: unknown) => Array.isArray(box) && box.length === 6
        && box.every(Number.isFinite) && box[0] < box[3] && box[1] < box[4] && box[2] < box[5])) {
        return { name, kind, shapes: boxes.map((box: number[]) => [box[0], box[1], box[2], box[3], box[4], box[5]]) };
      }
    }
    return { name, kind };
  }

  blockOptics(x: number, y: number, z: number): Optics | null {
    if (!this.ready) return null;
    const w = this.bot.world;
    const v = this.tmp(x, y, z);
    try {
      if (typeof w.getColumnAt === 'function' && !w.getColumnAt(v)) return null;
      let sid: number | null | undefined;
      if (typeof w.getBlockStateId === 'function') sid = w.getBlockStateId(v);
      else sid = this.bot.blockAt(v)?.stateId;
      if (sid === null || sid === undefined) return null;
      let o = this.opticsByState.get(sid);
      if (!o) {
        const definition = this.mcData.blocksByStateId?.[sid];
        if (!definition) return null;
        o = this.classifyOptics(definition, sid);
        this.opticsByState.set(sid, o);
      }
      return o;
    } catch {
      return null;
    }
  }

  lightAt(x: number, y: number, z: number): { block: number; sky: number } | null {
    if (!this.ready) return null;
    const w = this.bot.world;
    const v = this.tmp(x, y, z);
    try {
      if (typeof w.getColumnAt === 'function' && !w.getColumnAt(v)) return null;
      const block = typeof w.getBlockLight === 'function' ? w.getBlockLight(v) : undefined;
      const sky = typeof w.getSkyLight === 'function' ? w.getSkyLight(v) : undefined;
      if (block === undefined && sky === undefined) return null;
      return { block: block ?? 0, sky: sky ?? 15 };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- 感知（结构化）
  state(): AgentState {
    const b = this.bot;
    const worldId = this.worldIdentity();
    const dim = this.currentDimension();
    if (this.dimension !== 'unknown' && dim !== this.dimension) {
      this.newSession();
      this.dimension = dim;
    }
    if (!this.ready) {
      return {
        connected: false, alive: false, observationReady: false, worldId, sessionId: this.sessionId, observationId: this.observationId,
        username: this.cfg.mc.username, pos: { x: 0, y: 0, z: 0 }, dim: 'unknown',
        hp: 0, food: 0, oxygen: 20, timeOfDay: 0, isDay: true, biome: null, onGround: false, inWater: false,
        inLava: false, inventory: [], emptySlots: 0, held: null,
      };
    }
    const e = b.entity;
    // 物理模拟只在坐船时被关掉（船的位置由 ride 自行推进）。下船事件可能因死亡、断开或服务器没发包而漏掉，
    // 没有载具却仍关着物理时，身体会停在最后位置、onGround=false，之后每次迈步都报“没站稳”。
    // 这里恢复物理，不让悬空状态无限延续；不替 agent 移动或改落点。
    const vehicle = b.vehicle;
    if (b.physicsEnabled === false && !(vehicle && /boat|raft/.test(String(vehicle.name ?? '')))) {
      b.physicsEnabled = true;
      this.bus.publish('body_adapt', 'P2', '身体物理模拟已恢复：没有乘船却仍关闭着物理（此前可能悬空不落地）', { physics: 'restored' });
    }
    const inv = new Map<string, InvItem>();
    for (const it of b.inventory.items()) {
      const stackSize = this.mcData.itemsByName?.[it.name]?.stackSize;
      const cur: InvItem = inv.get(it.name) ?? { name: it.name, count: 0, ...(stackSize ? { stackSize } : {}) };
      cur.count += it.count;
      if (Number.isInteger(it.slot)) cur.stacks = [...(cur.stacks ?? []), { slot: it.slot, count: it.count }];
      const max = this.mcData.itemsByName?.[it.name]?.maxDurability;
      if (max) {
        const left = Math.max(0, max - (it.durabilityUsed ?? 0));
        if (!cur.durability || left < cur.durability.left) cur.durability = { left, max };
        cur.durabilities = [...(cur.durabilities ?? []), left].sort((a, c) => c - a);
      }
      if ((it.enchants?.length ?? 0) > 0) cur.enchanted = true;
      inv.set(it.name, cur);
    }
    let biome: string | null = null;
    let chunkReady = false;
    let feetName: string | undefined;
    let feetWaterlogged = false;
    try {
      const block = b.blockAt(e.position);
      chunkReady = !!block;
      biome = block?.biome?.name ?? null;
      feetName = block?.name;
      feetWaterlogged = String((block as { getProperties?: () => Record<string, unknown> } | null)?.getProperties?.().waterlogged) === 'true';
    } catch { /* ignore */ }
    const observationReady = this.spawned && chunkReady && (b.health ?? 0) > 0 && dim !== 'unknown';
    const worldAgeTicks = b.time?.age;
    const DIFFICULTY = ['peaceful', 'easy', 'normal', 'hard'] as const;
    const difficulty = typeof b.game?.difficulty === 'string' && (DIFFICULTY as readonly string[]).includes(b.game.difficulty) ? b.game.difficulty as typeof DIFFICULTY[number] : undefined;
    const gamerules = b.game?.rules && typeof b.game.rules === 'object' ? { ...b.game.rules } as Record<string, string | number | boolean> : undefined;
    // mineflayer 的 isInWater 会在水面上下浮动时瞬时变 false；脚格本身仍是水时不能报成离开水。
    // 这是身体事实校正，不改变“水/岩浆是否危险”的游戏规则。
    const inWater = !b.vehicle && (!!e.isInWater || feetName === 'water' || feetName === 'bubble_column' || feetWaterlogged);
    const inLava = !b.vehicle && (!!e.isInLava || feetName === 'lava');
    return {
      connected: true,
      alive: (b.health ?? 0) > 0,
      observationReady,
      worldId,
      sessionId: this.sessionId,
      observationId: observationReady ? ++this.observationId : this.observationId,
      username: b.username,
      pos: { x: e.position.x, y: e.position.y, z: e.position.z },
      dim,
      hp: b.health ?? 0,
      food: b.food ?? 0,
      oxygen: b.vehicle ? 20 : ownOxygen(b),
      timeOfDay: b.time?.timeOfDay ?? 0,
      ...(Number.isFinite(b.time?.day) ? { worldDay: b.time.day } : {}),
      ...(typeof worldAgeTicks === 'number' && Number.isFinite(worldAgeTicks) && worldAgeTicks >= 0 ? { worldAgeTicks } : {}),
      ...(difficulty ? { difficulty } : {}),
      ...(gamerules ? { gamerules } : {}),
      weather: (b.thunderState ?? 0) > 0.5 && (b.isRaining || (b.rainState ?? 0) > 0.2) ? 'thunder' : b.isRaining || (b.rainState ?? 0) > 0.2 ? 'rain' : 'clear',
      isDay: b.time?.isDay ?? true,
      biome,
      onGround: !!e.onGround,
      inWater,
      inLava,
      bodyPortal: this.bodyPortalKind(),
      inventory: [...inv.values()],
      ...(this.effectsOf(b).length ? { effects: this.effectsOf(b) } : {}),
      ...(b.experience ? { xp: { level: b.experience.level ?? 0, progress: Math.round((b.experience.progress ?? 0) * 100) / 100 } } : {}),
      emptySlots: b.inventory.emptySlotCount(),
      held: b.heldItem?.name ?? null,
      ...(() => {
        const h = b.heldItem, max = h ? this.mcData.itemsByName?.[h.name]?.maxDurability : undefined;
        return h && max ? { heldDurability: { left: Math.max(0, max - (h.durabilityUsed ?? 0)), max } } : {};
      })(),
      hotbar: Array.from({ length: 9 }, (_, i) => b.inventory.slots?.[36 + i]?.name ?? null),
      ...(Number.isInteger(b.quickBarSlot) ? { hotbarSelected: b.quickBarSlot } : {}),
      riding: b.vehicle ? String(b.vehicle.name ?? 'vehicle') : null,
      equipment: ['head', 'torso', 'legs', 'feet', 'off-hand'].flatMap((slot) => {
        const item = b.inventory.slots?.[b.getEquipmentDestSlot?.(slot)];
        if (!item) return [];
        const max = this.mcData.itemsByName?.[item.name]?.maxDurability;
        return [{ slot, name: item.name, durabilityRemaining: max ? max - (item.durabilityUsed ?? 0) : undefined, ...(max ? { durabilityMax: max } : {}) }];
      }),
    };
  }

  /** 收到每个状态效果（按效果 id）的时刻 */
  private effectSeenAt = new Map<number, number>();

  /** 身上的状态效果：剩余时间按收到包以来过了多久往下数；早该结束、却没收到“结束”包的当作已经没了 */
  private effectsOf(b: any): { name: string; level: number; seconds: number }[] {
    const effects = b.entity?.effects;
    if (!effects) return [];
    return remainingEffects(effects, this.effectSeenAt).map(({ e, seconds }) => {
      const raw = String(this.mcData.effects?.[e.id]?.name ?? e.id);
      const key = raw.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      return { name: EFFECT_ZH[key] ?? key, level: (e.amplifier ?? 0) + 1, seconds };
    });
  }

  /** 一眼看得出的生物特征（来自实体元数据：玩家看得见的外观） */
  private traitsOf(ent: any, keys: string[]): string | undefined {
    const md = ent.metadata ?? [];
    const get = (k: string) => { const i = keys.indexOf(k); return i >= 0 ? md[i] : undefined; };
    const out: string[] = [];
    if (get('baby') === true) out.push('幼崽');
    if (ent.name === 'sheep') {
      const w = Number(get('wool'));
      if (Number.isFinite(w)) { out.push(`${WOOL_ZH[w & 0x0f] ?? '?'}色`); if (w & 0x10) out.push('已剪毛'); }
    }
    if (ent.name === 'villager' || ent.name === 'zombie_villager') {
      const vd = get('villager_data');
      const prof = vd?.villagerProfession ?? vd?.profession;
      const p = typeof prof === 'number' ? PROFESSIONS[prof] : typeof prof === 'string' ? prof.replace(/^minecraft:/, '') : undefined;
      if (p) out.push(`${PROFESSION_ZH[p] ?? p}${vd?.level ? ` ${vd.level} 级` : ''}`);
    }
    const flags = Number(get('flags'));
    if (['wolf', 'cat', 'parrot'].includes(ent.name) && Number.isFinite(flags) && flags & 0x04) out.push(flags & 0x01 ? '已驯服（坐着）' : '已驯服');
    if (['horse', 'donkey', 'mule', 'llama'].includes(ent.name) && Number.isFinite(flags)) { if (flags & 0x02) out.push('已驯服'); if (flags & 0x04) out.push('有鞍'); }
    if (ent.name === 'creeper' && get('is_powered') === true) out.push('带电（爆炸更猛）');
    if (ent.name === 'piglin' && get('is_dancing') === true) out.push('在跳舞');
    if (ent.name === 'wolf' && Number(get('remaining_anger_time')) > 0) out.push('发怒');
    return out.length ? out.join('、') : undefined;
  }

  /** 猪灵中立条件：玩家穿着任意一件金盔甲。只读当前装备，不推断未观察状态。 */
  private wearsGoldArmor(): boolean {
    const b = this.bot as any;
    if (!b) return false;
    return ['head', 'torso', 'legs', 'feet'].some((slot) => /^golden_(helmet|chestplate|leggings|boots)$/.test(
      String(b.inventory?.slots?.[b.getEquipmentDestSlot?.(slot)]?.name ?? ''),
    ));
  }

  private classify(ent: any): EntityKind {
    const name = String(ent.name ?? '');
    if (ent.type === 'player') return 'player';
    if (name === 'item') return 'item';
    if (name === 'enderman') {
      const keys: string[] = this.mcData?.entitiesByName?.enderman?.metadataKeys ?? [];
      if (['creepy', 'stared_at'].some((key) => keys.indexOf(key) >= 0 && ent.metadata?.[keys.indexOf(key)] === true)) return 'hostile';
    }
    // 猪灵只有玩家穿着金盔甲时才是中立；没有金甲时会主动攻击，不能当成 passive，
    // 否则 defend/attack 和技能里的 entities(kind:hostile) 都看不到它。
    if (name === 'piglin') return this.wearsGoldArmor() ? 'passive' : 'hostile';
    if (HOSTILE.has(name)) return 'hostile';
    if (NEUTRAL.has(name)) return 'passive';
    if (ent.type === 'hostile') return 'hostile';
    if (['animal', 'passive', 'water_creature', 'ambient', 'mob'].includes(ent.type)) return 'passive';
    return 'other';
  }

  nearbyEntities(radius: number): EntityInfo[] {
    if (!this.ready) return [];
    const b = this.bot;
    const me = b.entity.position;
    const out: EntityInfo[] = [];
    for (const ent of Object.values<any>(b.entities)) {
      if (!ent || ent === b.entity || !ent.position) continue;
      const d = ent.position.distanceTo(me);
      if (d > radius) continue;
      let name = ent.type === 'player' ? `player:${ent.username ?? '?'}` : String(ent.name ?? 'unknown');
      if (name === 'experience_orb') continue;
      // 掉落物：看清是什么、几个（item:raw_rabbit），像玩家看地上的东西一样
      let count: number | undefined;
      if (name === 'item') {
        try { const di = ent.getDroppedItem?.(); if (di?.name) { name = `item:${di.name}`; count = di.count; } } catch { /* ignore */ }
      }
      const keys: string[] = this.mcData.entitiesByName?.[ent.name]?.metadataKeys ?? [];
      const phase = ent.metadata?.[keys.indexOf('phase')];
      const hp = ent.metadata?.[keys.indexOf('health')];
      // 苦力怕的引信：swell_dir=1 正在膨胀，is_ignited=被点燃
      const fusing = ent.name === 'creeper' && (ent.metadata?.[keys.indexOf('swell_dir')] === 1 || ent.metadata?.[keys.indexOf('is_ignited')] === true);
      const traits = name.startsWith('item') || ent.type === 'player' ? undefined : this.traitsOf(ent, keys);
      out.push({ id: ent.id, name, kind: this.classify(ent), ...(traits ? { traits } : {}), pos: { x: ent.position.x, y: ent.position.y, z: ent.position.z }, dist: d, height: ent.height,
        velocity: ent.velocity ? { x: ent.velocity.x, y: ent.velocity.y, z: ent.velocity.z } : undefined,
        phase: Number.isInteger(phase) ? phase : undefined, hp: Number.isFinite(hp) ? hp : undefined, ...(fusing ? { fusing: true } : {}), ...(count ? { count } : {}) });
    }
    return out.sort((a, c) => a.dist - c.dist);
  }

  findBlocks(names: string[], maxDist: number, count: number): BlockHit[] {
    if (!this.ready || !names.length) return [];
    const b = this.bot;
    const ids = names.map((n) => this.mcData.blocksByName[n]?.id).filter((x: unknown) => x !== undefined);
    if (!ids.length) return [];
    const me = b.entity.position;
    const positions: any[] = b.findBlocks({ matching: ids, maxDistance: maxDist, count });
    return positions
      .map((p) => ({ name: b.blockAt(p)?.name ?? 'unknown', pos: { x: p.x, y: p.y, z: p.z }, dist: p.distanceTo(me) }))
      .sort((a, c) => a.dist - c.dist);
  }

  blockAt(pos: Vec3Like): string | null {
    if (!this.ready) return null;
    return this.bot.blockAt(this.vec(pos))?.name ?? null;
  }

  resolveBlockNames(query: string): string[] {
    if (!this.mcData) return [];
    const q = query.toLowerCase().trim().replace(/^minecraft:/, '');
    const known = this.mcData.blocksByName;
    let out: string[] = [];
    if (known[q]) {
      out = [q];
      if (q.endsWith('_ore') && known[`deepslate_${q}`]) out.push(`deepslate_${q}`);
    } else if (ALIASES[q]) {
      out = ALIASES[q].filter((n) => known[n]);
    } else {
      out = Object.keys(known).filter((n) => n.endsWith(`_${q}`)).slice(0, 20);
    }
    return out;
  }

  isKnownItem(name: string): boolean {
    return !!this.mcData?.itemsByName?.[name];
  }

  /** 控制台「给予物品」搜索用的物品名清单（去掉拿不到手的空气类方块） */
  listItems(): string[] {
    if (!this.mcData) return [];
    const skip = new Set(['air', 'cave_air', 'void_air']);
    return Object.keys(this.mcData.itemsByName).filter((n) => !skip.has(n)).sort();
  }

  // ---------------------------------------------------------------- 动作
  /**
   * 挨打那一刻身上、身边是什么：脚和头所在的格子、脚下踩的、着没着火、贴身的怪、氧气和饥饿。
   * 只是感觉到的事实（“碰着 sweet_berry_bush”），哪个是原因、以后怎么躲，由它自己判断。
   */
  hurtCause(): string {
    if (!this.ready) return '';
    const b = this.bot, p = b.entity.position;
    const out: string[] = [];
    const at = (dx: number, dy: number, dz: number) => b.blockAt(p.offset(dx, dy, dz))?.name as string | undefined;
    const touching = new Set([at(0, 0, 0), at(0, 1, 0)].filter((n): n is string => !!n && !/^(air|cave_air|void_air)$/.test(n)));
    for (const n of touching) out.push(`身体碰着 ${n}`);
    const under = at(0, -0.2, 0);
    if (under && /magma|campfire|cactus/.test(under)) out.push(`脚下踩着 ${under}`);
    for (const [dx, dz] of [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]]) { const n = at(dx, 0.5, dz); if (n === 'cactus') { out.push('贴着 cactus'); break; } }
    if (b.entity.onFire || (b.entity.metadata?.[0] & 1)) out.push('身上着火');
    const near = this.nearbyEntities(5).filter((e) => e.kind === 'hostile' || /arrow|fireball|trident/.test(e.name)).slice(0, 2);
    for (const e of near) out.push(`${e.name} 在 ${e.dist.toFixed(1)} 格`);
    // 远程攻击的发射者/弹体常在 5 格外：只报客户端已同步的实体事实，不据此断言是谁造成的。
    const ranged = this.nearbyEntities(32)
      .filter((e) => /^(ghast|blaze|fireball|arrow|trident|small_fireball|large_fireball|wither_skull|dragon_fireball)$/.test(e.name))
      .filter((e) => !near.some((n) => n.id === e.id))
      .slice(0, 2);
    for (const e of ranged) out.push(`${e.name} 在 ${e.dist.toFixed(1)} 格`);
    if (ownOxygen(b) <= 0) out.push('没气了');
    if ((b.food ?? 20) <= 0) out.push('饿着');
    return out.slice(0, 4).join('、');
  }

  async moveTo(target: MoveTarget, opts: MoveOpts): Promise<void> {
    const check = this.actionCheckpoint(opts.signal);
    throwIfAborted(opts.signal);
    if (!this.ready) throw new Error('NOT_CONNECTED');
    const b = this.bot;
    if (b.vehicle) throw new Error(`RIDING：正在乘坐 ${b.vehicle.name}，走路前先 dismount，或用 boat_path 操控它前进`);
    // 传送门方块没有碰撞箱，按几何算是“能站”的空格；可身体在里面待满几秒就会换维度。
    // 换站位、补支撑、贴近目标这类辅助移动把精确落点选进门格，会让 Agent 没选穿门就被送走
    // （2026-11-10 两次：补支撑的退后站位正对身后的下界门，思考还没回来人已回到主世界）。
    // 只有 travel_portal（enterPortalAt）自己能把身体送进门格；其余精确落点一律拒绝，交回事实。
    if (!this.inPortalTransition) {
      const cell = target.kind === 'xyz' || target.kind === 'ladder'
        ? { x: Math.floor(target.x), y: Math.ceil(target.y - 0.001), z: Math.floor(target.z) }
        : target.kind === 'feet' ? { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) }
          : target.kind === 'near' && target.range < 1 ? { x: Math.floor(target.pos.x), y: Math.floor(target.pos.y), z: Math.floor(target.pos.z) } : null;
      const portal = cell && [0, 1].map((dy) => this.blockAt({ ...cell, y: cell.y + dy })).find((n): n is string => !!n && PORTAL_KINDS.has(n));
      if (cell && portal) throw new Error(`PORTAL_CELL: 目标站位 (${cell.x},${cell.y},${cell.z}) 是 ${portal} 方块，进去会被传送；没有移动。要穿门用 travel_portal`);
    }
    // 连续脚位：不经过路线委托的整数节点/格心，直接用现有身体控制推进到实测点。
    // 选择方块列的相邻动作使用下方 xyz/adjacentStep，按实测落入目标列验收。
    if (target.kind === 'feet') {
      const deadline = Date.now() + opts.timeoutMs;
      const sprint = opts.sprint ?? this.delegatedMoveOptions.getStore()?.sprint ?? false;
      const outcome = await this.driveToFeet(
        { x: target.x, y: target.y, z: target.z },
        deadline,
        check,
        'feet',
        opts.corridor,
        opts.horizontalJump === true,
        sprint,
        opts.maxDropDown,
        opts.settleAtTarget !== false,
      );
      const where = `(${b.entity.position.x.toFixed(2)},${b.entity.position.y.toFixed(2)},${b.entity.position.z.toFixed(2)})`;
      if (outcome === 'arrived') return;
      if (outcome === 'timeout') throw Object.assign(new Error(`TIMEOUT: 连续脚位没有在期限内站稳，实际位于 ${where}`), { name: 'Timeout' });
      throw new Error(`NOT_CONFIRMED: ${outcome === 'overshot' ? '越过了连续脚位目标' : '身体控制没有完成连续脚位'}，实际位于 ${where}`);
    }
    const deadline = Date.now() + opts.timeoutMs;
    const inherited = this.delegatedMoveOptions.getStore();
    const sprint = opts.sprint ?? inherited?.sprint ?? false;
    // 一格内的精确迈步/明确下行/梯子过渡由本地身体控制完成：它们都是已复验的
    // 有限动作，不需要（也不应进入）整段路线委托。
    if (target.kind === 'xyz' && opts.adjacentStep && opts.maxDropDown === undefined) {
      const centerRadius = typeof opts.adjacentStep === 'object' ? opts.adjacentStep.centerRadius : undefined;
      if (centerRadius !== undefined && (!Number.isFinite(centerRadius) || centerRadius <= 0)) throw new Error('BAD_ARGS: 格内落点半径必须是有限正数');
      const outcome = await this.finishAdjacentStep({ x: target.x, y: target.y, z: target.z, centerRadius }, deadline, check);
      if (outcome === 'arrived') return;
      const at = b.entity.position;
      const where = `(${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)})`;
      if (outcome === 'timeout') throw Object.assign(new Error(`TIMEOUT: 相邻一步没有在期限内站稳，实际位于 ${where}`), { name: 'Timeout' });
      throw new Error(`NOT_CONFIRMED: ${outcome === 'overshot' ? '越过了所选相邻落点' : '身体控制没有完成相邻一步'}，实际位于 ${where}`);
    }
    if (target.kind === 'xyz' && opts.maxDropDown !== undefined) {
      await this.driveControlledDrop({ x: target.x, y: target.y, z: target.z }, deadline, check, opts.maxDropDown, opts.allowSwimming === true);
      check();
      return;
    }
    if (target.kind === 'ladder') {
      await this.driveAlongLadder({ x: target.x, y: target.y, z: target.z }, deadline, check);
      check();
      return;
    }
    // climb_up 的同列上行仍可落在已证实的梯子上：这是梯子身体控制，不是隐式施工。
    if (target.kind === 'xyz'
      && Math.floor(target.x) === Math.floor(b.entity.position.x)
      && Math.floor(target.z) === Math.floor(b.entity.position.z)
      && Math.abs(target.y - b.entity.position.y) > 0.05) {
      const feetName = this.blockAt({ x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) });
      if (feetName !== null && isClimbableBlockName(feetName)) {
        await this.driveAlongLadder({ x: target.x, y: target.y, z: target.z }, deadline, check);
        check();
        return;
      }
    }
    // 非本地移动只走 runSkill 绑定的 VoxelMap 导航委托。
    // 若路线确实需要施工/下水，委托会以结构化缺口交回，
    // 由 Agent 显式调用 mine_cell / place_cell / place_support / pillar_one / swim_path。
    // allowSwimming:true 同理只是允许，不会让陆地路线静默改成游泳模式。
    const delegate = this.navigationDelegate.getStore();
    if (!delegate) {
      throw Object.assign(
        new Error('NAVIGATION_UNAVAILABLE: 非本地移动需要 runSkill 在任务生命周期内绑定 withNavigation；没有回退到其他导航后端'),
        { name: 'NavigationUnavailable', position: { ...b.entity.position }, target },
      );
    }
    // sprint 是本次委托的执行请求：随同一异步作用域传给委托内部逐段 feet/ladder 控制。
    await this.delegatedMoveOptions.run({ sprint }, () => delegate.navigate(target, { ...opts, sprint }));
    check();
  }

  /**
   * 站在方块边缘、身体中心已经悬空时，路线规划会从“脚下中心那一列”（空气）出发，
   * 和真实物理对不上。先潜行挪回真正踩着的那一格中心（潜行不会掉下去），再继续。
   */
  private edgeSupport(): { x: number; z: number } | null {
    const b = this.bot, e = b?.entity;
    if (!e?.onGround || e.isInWater || e.isInLava || b.vehicle || typeof b.blockAt !== 'function' || typeof b.setControlState !== 'function' || !e.position?.offset) return null;
    const p = e.position;
    const supports = (dx: number, dz: number, recovery: boolean) => {
      const foot = p.offset(dx, -0.05, dz), cell = foot.floored(), block = b.blockAt(foot);
      if (!block) return undefined;
      if (recovery && /water|lava|magma|campfire|cactus|powder_snow/.test(block.name)) return null;
      const shapes: number[][] = block.shapes ?? (block.boundingBox === 'empty' ? [] : [[0, 0, 0, 1, 1, 1]]);
      return shapes.some((sh) => foot.x >= cell.x + sh[0] && foot.x <= cell.x + sh[3]
        && foot.z >= cell.z + sh[2] && foot.z <= cell.z + sh[5] && Math.abs(cell.y + sh[4] - p.y) < 0.1) ? cell : null;
    };
    // 中心列未知也不足以证明悬空。只有已读到的形状不托住中心时才寻找实际承重的邻列。
    if (supports(0, 0, false) !== null) return null;
    const cells = [[0.3, 0.3], [0.3, -0.3], [-0.3, 0.3], [-0.3, -0.3]].map(([dx, dz]) => supports(dx, dz, true)).filter((c): c is Vec3Like => c != null)
      .sort((a, c) => Math.hypot(a.x + 0.5 - p.x, a.z + 0.5 - p.z) - Math.hypot(c.x + 0.5 - p.x, c.z + 0.5 - p.z));
    return cells[0] ? { x: cells[0].x, z: cells[0].z } : null;
  }

  /**
   * 身体 AABB 宽 0.6、格子宽 1.0：中心离格中线超过 0.2 时身体已经压到相邻一列。
   * 返回中心所在格的格子，供潜行归位；中心下方不是实心方块或不在站立状态时不处理。
   */
  private spanningCell(): { x: number; z: number } | null {
    const b = this.bot, e = b?.entity;
    if (!e?.onGround || e.isInWater || e.isInLava || b.vehicle || typeof b.blockAt !== 'function' || typeof b.setControlState !== 'function') return null;
    const p = e.position, cell = p.floored();
    const offX = Math.abs(p.x - (cell.x + 0.5)), offZ = Math.abs(p.z - (cell.z + 0.5));
    if (offX <= 0.2 + 1e-6 && offZ <= 0.2 + 1e-6) return null;
    // 中心列真正托着身体的方块：灵魂沙、半砖上脚高 x.875/x.5，支撑是 floor(脚高) 那格本身，不是它下面一格。
    const below = b.blockAt(new Vec3(cell.x, supportCell(p).y, cell.z));
    if (!below || below.boundingBox !== 'block') return null;
    return { x: cell.x, z: cell.z };
  }

  private async steady(cell: { x: number; z: number }, signal: AbortSignal, check: () => void): Promise<void> {
    const b = this.bot, e = b.entity, p = e.position;
    const epoch = this.actionEpoch;
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot;
    const tx = cell.x + 0.5, tz = cell.z + 0.5;
    check();
    if (typeof b.look === 'function') await this.afterAction(() => raceAbort(b.look(Math.atan2(-(tx - p.x), -(tz - p.z)), e.pitch ?? 0, true), signal, 1000, () => {}), check);
    b.clearControlStates?.();
    b.setControlState('sneak', true);
    b.setControlState('forward', true);
    try {
      for (let t = 0; t < 900; t += 50) {
        await this.afterAction(() => sleep(50, signal), check);
        const q = b.entity.position;
        // 两轴都进入 0.15 才算归位：以欧氏距离 0.22 收尾时单轴仍可能压线，身体还跨在两列上。
        if (Math.abs(tx - q.x) < 0.15 && Math.abs(tz - q.z) < 0.15) break;
      }
    } finally {
      if (ownsControls()) { b.setControlState('forward', false); b.setControlState('sneak', false); }
    }
    this.bus.publish('path_steady', 'P3', `身体没对准格心，先潜行挪回脚下那一格中心`);
  }

  /** Check the actual player's head sweep before jumping high enough to place a block underfoot. */
  private pillarClearance(): PillarClearance | null {
    // 跳到放置格之上才能放：放置格是支撑方块上面一格（不足一格的支撑上，它高于 floor(脚高)）。
    const b = this.bot, p = b.entity.position, feetY = supportCell(p).y + 1, epsilon = 1e-6;
    const top = feetY + 1.02 + 1.8;
    const min = { x: Math.floor(p.x - 0.3 + epsilon), y: Math.floor(p.y + 1.8), z: Math.floor(p.z - 0.3 + epsilon) };
    const max = { x: Math.floor(p.x + 0.3 - epsilon), y: Math.floor(top - epsilon), z: Math.floor(p.z + 0.3 - epsilon) };
    const feet = feetCell({ x: p.x, y: p.y, z: p.z });
    const facing = facingOfYaw(b.entity.yaw);
    const blocks: PillarClearance['blocks'] = [];
    for (let x = min.x; x <= max.x; x++)
      for (let y = min.y; y <= max.y; y++)
        for (let z = min.z; z <= max.z; z++) {
          const block = b.blockAt(p.offset(x - p.x, y - p.y, z - p.z));
          if (!block) return { kind: 'unknown', min, max, blocks };
          const shapes: number[][] = block.shapes ?? (block.boundingBox === 'empty' ? [] : [[0, 0, 0, 1, 1, 1]]);
          if (shapes.some((shape) => x + shape[3] > p.x - 0.3 + epsilon && x + shape[0] < p.x + 0.3 - epsilon
            && z + shape[5] > p.z - 0.3 + epsilon && z + shape[2] < p.z + 0.3 - epsilon
            && y + shape[4] > p.y + 1.8 + epsilon && y + shape[1] < top - epsilon)) {
            blocks.push({ pos: { x, y, z }, rel: relToBody(feet, facing, { x, y, z }), facing });
          }
        }
    return blocks.length ? { kind: 'blocked', min, max, blocks } : null;
  }

  /**
   * 末段收尾：整数节点判定会在薄层/小落差的一步上提前结算，身体
   * 仍由原支撑托住、还没踩上目标支撑面时提前结算（节点已到、脚高未到）。此时身体已贴近目标列且
   * 仍在地面，分「水平推进 → 制动 → 落地确认」三阶段补完这一步：
   *   - 推进：面朝目标列中心按住前进，直到身体真正踩上目标支撑（列一致 + 脚高相符 + 站稳）才松键；
   *     不以水平距离提前刹车——否则寻路停在距中心很近但仍由原支撑托住时，刚前进就松键、一步迈不出去；
   *   - 越段保护：越过目标中心（距离由减转增）或超出单步位移即停止前推，不会无限前推；
   *   - 落地确认：所有成功都经统一的连续稳定验收（两拍站稳 + 列一致 + 脚高相符），不因单帧 settled 提前返回。
   * 只在干地相邻格列（脚高差 ≤1）且确有有效路径依据时执行；共用原 deadline，释放按键前
   * 确认仍拥有本次控制，旧回调不能松新动作的键。返回分类供调用方区分越段、超时与到达。
   */
  private async finishAdjacentStep(target: Vec3Like & { centerRadius?: number }, deadline: number, check: (() => void) & { signal?: AbortSignal }): Promise<'arrived' | 'overshot' | 'timeout' | 'blocked'> {
    return this.driveToFeet(target, deadline, check, 'cell');
  }

  /**
   * 明确落点的单步下行：只从当前支撑面向已选定的相邻较低列走，不跳、不挖、不放、
   * 不绕行。落下后按实测脚位/水面接触验收，并受 maxDropDown 上限与取消归属约束。
   */
  private async driveControlledDrop(
    target: { x: number; y: number; z: number }, deadline: number,
    check: (() => void) & { signal?: AbortSignal }, maxDropDown: number, allowWater: boolean,
  ): Promise<void> {
    const b = this.bot, e = b?.entity;
    const signal = check.signal ?? new AbortController().signal;
    if (!e?.position) throw new Error('NOT_CONNECTED: 没有身体位置，不能下行');
    if (!Number.isInteger(maxDropDown) || maxDropDown < 1 || maxDropDown > 32) throw new Error('BAD_ARGS: 明确下行需要 1–32 格上限');
    if (Date.now() >= deadline) throw Object.assign(new Error('TIMEOUT: 明确下行的期限已耗尽'), { name: 'Timeout' });
    if (!e.onGround || e.isInWater || e.isInLava || b.vehicle) throw new Error('STUCK: 明确下行需要先在干燥支撑面站稳，不能从乘骑、游泳或下落中再次起跳');
    if (typeof b.setControlState !== 'function' || typeof b.clearControlStates !== 'function') throw new Error('STUCK: 当前身体没有直接控制能力');
    const from = { x: e.position.x, y: e.position.y, z: e.position.z };
    const fx = Math.floor(target.x), fz = Math.floor(target.z);
    if (Math.abs(fx - Math.floor(from.x)) + Math.abs(fz - Math.floor(from.z)) !== 1) throw new Error('BAD_ARGS: 明确下行只支持相邻一列的落点');
    if (target.y >= from.y) throw new Error('BAD_ARGS: 明确下行只用于较低的落点');
    const tx = fx + 0.5, tz = fz + 0.5;
    const epoch = this.actionEpoch, dimension = this.currentDimension();
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot && dimension === this.currentDimension();
    const inColumn = () => Math.floor(b.entity.position.x) === fx && Math.floor(b.entity.position.z) === fz;
    check();
    try {
      if (typeof b.look === 'function') { try { b.look(Math.atan2(-(tx - from.x), -(tz - from.z)), 0, true); } catch { /* ignore */ } }
      b.clearControlStates();
      b.setControlState('forward', true);
      const leaveBy = Math.min(deadline, Date.now() + 4000);
      while (Date.now() < leaveBy) {
        check();
        const p = b.entity.position;
        // 身体中心进入目标列时仍可能被原支撑边缘托住；继续前推，直到真的离地
        // 或已走到目标格心，再交给落体确认。
        if (!b.entity.onGround || Math.hypot(p.x - tx, p.z - tz) <= 0.25) break;
        if (Math.hypot(p.x - from.x, p.z - from.z) > 2.2) break;
        await this.afterAction(() => sleep(25, signal), check);
      }
    } finally {
      if (ownsControls()) {
        try { b.setControlState('forward', false); } catch { /* ignore */ }
        try { b.setControlState('jump', false); } catch { /* ignore */ }
      }
    }
    check();
    while (Date.now() < deadline) {
      check();
      const p = b.entity.position;
      const column = inColumn();
      if (b.entity.isInWater) {
        // 水面落点：入水且仍在所选列的水层内即交回，由调用方按水深/落点验收。
        if (allowWater && column && p.y >= target.y - 1.01 && p.y <= target.y + 1.01) return;
      } else if (b.entity.onGround && column) {
        if (Math.abs(p.y - target.y) <= 0.05) return;
        throw new Error(`NOT_CONFIRMED: 已落到目标列但脚高 ${p.y.toFixed(2)} 与所选 ${target.y.toFixed(2)} 不符`);
      } else if (b.entity.onGround) {
        throw new Error(`NOT_CONFIRMED: 下落停在 (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})，不在所选列`);
      }
      if (from.y - p.y > maxDropDown + 0.6) throw new Error(`NOT_CONFIRMED: 实测下落超过授权 ${maxDropDown} 格，未改走其他边缘`);
      if (p.y < target.y - 1.01) throw new Error(`NOT_CONFIRMED: 下落越过所选落点，实际脚高 ${p.y.toFixed(2)}`);
      await this.afterAction(() => sleep(25, signal), check);
    }
    throw Object.assign(new Error('TIMEOUT: 明确下行没有在期限内完成'), { name: 'Timeout' });
  }

  /**
   * 已复验的梯子过渡：先在同一高度进入/退出目标列，再在同列上下攀爬。
   * 只按实测脚位验收；攀爬不按前进键，避免离开梯子列。取消后不再写按键。
   */
  private async driveAlongLadder(
    target: { x: number; y: number; z: number }, deadline: number,
    check: (() => void) & { signal?: AbortSignal },
  ): Promise<void> {
    const b = this.bot, e = b?.entity;
    const signal = check.signal ?? new AbortController().signal;
    if (!e?.position) throw new Error('NOT_CONNECTED: 没有身体位置，不能爬梯子');
    if (b.vehicle || e.isInLava || e.isInWater) throw new Error('STUCK: 当前不能执行梯子过渡（乘骑/岩浆/水中）');
    if (typeof b.setControlState !== 'function' || typeof b.clearControlStates !== 'function') throw new Error('STUCK: 当前身体没有直接控制能力');
    if (Date.now() >= deadline) throw Object.assign(new Error('TIMEOUT: 梯子过渡的期限已耗尽'), { name: 'Timeout' });
    const fx = Math.floor(target.x), fz = Math.floor(target.z);
    const tx = fx + 0.5, tz = fz + 0.5;
    const epoch = this.actionEpoch, dimension = this.currentDimension();
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot && dimension === this.currentDimension();
    const arrived = () => {
      const p = b.entity.position;
      return Math.hypot(p.x - tx, p.z - tz) <= 0.12 && Math.abs(p.y - target.y) <= 0.05;
    };
    const horizontal = () => Math.hypot(tx - b.entity.position.x, tz - b.entity.position.z);
    check();
    if (horizontal() > 0.12) {
      try {
        if (typeof b.look === 'function') { try { b.look(Math.atan2(-(tx - b.entity.position.x), -(tz - b.entity.position.z)), 0, true); } catch { /* ignore */ } }
        b.clearControlStates();
        b.setControlState('forward', true);
        while (Date.now() < deadline && horizontal() > 0.10) {
          check();
          const before = horizontal();
          await this.afterAction(() => sleep(25, signal), check);
          // 没有靠近且已越过目标列：如实停下，不再硬推。
          if (horizontal() >= before - 1e-6 && Math.floor(b.entity.position.x) === fx && Math.floor(b.entity.position.z) === fz) break;
        }
      } finally {
        if (ownsControls()) { try { b.setControlState('forward', false); } catch { /* ignore */ } }
      }
      check();
      if (horizontal() > 0.12) throw new Error(`NOT_CONFIRMED: 没有进入梯子列，实际位于 (${b.entity.position.x.toFixed(2)},${b.entity.position.y.toFixed(2)},${b.entity.position.z.toFixed(2)})`);
    }
    const dy = target.y - b.entity.position.y;
    if (Math.abs(dy) > 0.05) {
      const up = dy > 0;
      try {
        b.clearControlStates();
        b.setControlState(up ? 'jump' : 'sneak', true);
        while (Date.now() < deadline) {
          check();
          const remaining = target.y - b.entity.position.y;
          if (Math.abs(remaining) <= 0.04) break;
          // 越过目标高度：停手，交给实测验收如实报告。
          if ((up && remaining < -0.05) || (!up && remaining > 0.05)) break;
          await this.afterAction(() => sleep(25, signal), check);
        }
      } finally {
        if (ownsControls()) {
          try { b.setControlState('jump', false); } catch { /* ignore */ }
          try { b.setControlState('sneak', false); } catch { /* ignore */ }
        }
      }
      check();
    }
    if (!arrived()) throw new Error(`NOT_CONFIRMED: 梯子过渡没有到达目标，实际位于 (${b.entity.position.x.toFixed(2)},${b.entity.position.y.toFixed(2)},${b.entity.position.z.toFixed(2)})`);
  }

  /**
   * 连续脚位/相邻格共用的身体控制。`cell` 模式从实测位置直接迈入选定格列并站稳；
   * `feet` 模式不归位、不取格心，直接朝实测连续点推进，并按声明的物理精度验收。
   */
  private async driveToFeet(
    target: Vec3Like & { centerRadius?: number }, deadline: number,
    check: (() => void) & { signal?: AbortSignal }, mode: 'cell' | 'feet',
    corridor?: MoveOpts['corridor'],
    horizontalJump = false,
    sprint = false,
    maxDropDown = 1,
    settleAtTarget = true,
  ): Promise<'arrived' | 'overshot' | 'timeout' | 'blocked'> {
    const b = this.bot, e = b?.entity;
    if (!e?.position || !e.onGround || e.isInWater || e.isInLava || b.vehicle) return 'blocked';
    if (typeof b.setControlState !== 'function' || typeof b.clearControlStates !== 'function') return 'blocked';
    if (Date.now() >= deadline) return 'timeout';
    const fx = Math.floor(target.x), fz = Math.floor(target.z);
    // 只有身体中心脚下已悬空、实际靠邻列支撑才回到承重面。正常支撑上的偏心位置可以直接迈步。
    const signal = check.signal ?? new AbortController().signal;
    if (mode === 'cell') {
      if (Math.abs(Math.floor(e.position.x) - fx) + Math.abs(Math.floor(e.position.z) - fz) > 1) return 'blocked';
      const recentre = this.edgeSupport();
      if (recentre) {
        if (Math.abs(recentre.x - fx) + Math.abs(recentre.z - fz) > 1) return 'blocked';
        await this.steady(recentre, signal, check);
        check();
      }
    }
    const tx = mode === 'cell' ? Math.floor(target.x) + 0.5 : target.x;
    const tz = mode === 'cell' ? Math.floor(target.z) + 0.5 : target.z;
    const atEndpoint = () => {
      const p = b.entity.position;
      if (!b.entity.onGround) return false;
      if (mode === 'cell') {
        return Math.floor(p.x) === fx && Math.floor(p.z) === fz && Math.abs(p.y - target.y) <= 0.01
          && (target.centerRadius === undefined || Math.hypot(p.x - tx, p.z - tz) <= target.centerRadius);
      }
      return Math.hypot(p.x - target.x, p.z - target.z) <= FEET_ARRIVAL_TOLERANCE.horizontal
        && Math.abs(p.y - target.y) <= FEET_ARRIVAL_TOLERANCE.vertical;
    };
    const alongRemaining = () => {
      if (corridor?.minimumAlong === undefined) return 0;
      const p = b.entity.position;
      return corridor.minimumAlong - ((p.x - corridor.origin.x) * corridor.bearing.x + (p.z - corridor.origin.z) * corridor.bearing.z);
    };
    const settled = () => atEndpoint() && alongRemaining() <= 0;
    const p0 = b.entity.position;
    const p0y = p0.y;
    const dist = () => Math.hypot(tx - b.entity.position.x, tz - b.entity.position.z);
    if (Date.now() >= deadline) return 'timeout';
    // A horizontal jump is a single, already-proved gap crossing at the same
    // feet height. It never changes the target, climbs, or bridges terrain.
    const maxStartDistance = horizontalJump ? 4.2 : 1.2;
    if (mode === 'feet' && dist() > maxStartDistance) return 'blocked';
    if (!Number.isInteger(maxDropDown) || maxDropDown < 1 || maxDropDown > 32) throw new Error('BAD_ARGS: 明确下行需要 1–32 格上限');
    if (horizontalJump ? Math.abs(p0y - target.y) > 0.01 : target.y - p0y > 1 || p0y - target.y > maxDropDown) return 'blocked';
    const initialDistance = dist();
    const heading = Math.atan2(-(tx - p0.x), -(tz - p0.z));
    const epoch = this.actionEpoch, dimension = this.currentDimension();
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot && dimension === this.currentDimension();
    // 连续脚位可选走廊：只按实测身体位置到原 origin→bearing 轴线的横向距离判定，不用 0.12 到达容差冒充横向授权。
    // +0.01 与仓库既有走廊几何（withinCorridor / segment 的 corridorLimit）一致，只吸收浮点误差。
    const activeCorridor = mode === 'feet' ? corridor : undefined;
    const corridorLimit = activeCorridor === undefined ? Infinity : activeCorridor.maxLateral + 0.01;
    const corridorLateral = () => activeCorridor === undefined ? 0
      : Math.abs((b.entity.position.x - activeCorridor.origin.x) * activeCorridor.bearing.z
        - (b.entity.position.z - activeCorridor.origin.z) * activeCorridor.bearing.x);
    const passedIntermediate = () => {
      const p = b.entity.position;
      if (mode !== 'feet' || settleAtTarget || !b.entity.onGround || Math.abs(p.y - target.y) > FEET_ARRIVAL_TOLERANCE.vertical || atEndpoint()) return 0;
      return -(p.x - tx) * Math.sin(heading) - (p.z - tz) * Math.cos(heading);
    };
    const checkPosition = () => {
      if (p0y - b.entity.position.y > maxDropDown + FEET_ARRIVAL_TOLERANCE.vertical) {
        throw new Error(`NOT_CONFIRMED: 实测下落超过授权 ${maxDropDown} 格，未改走其他落点`);
      }
      if (activeCorridor !== undefined && corridorLateral() > corridorLimit) {
        const p = b.entity.position;
        throw new Error(`CORRIDOR_VIOLATION: 连续脚位实测横向 ${corridorLateral().toFixed(2)} 格，超出授权 ${activeCorridor.maxLateral} 格；实际位于 (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})，已停止`);
      }
      const past = passedIntermediate();
      if (past > 1e-9) {
        throw Object.assign(new Error(`CHECKPOINT_PASSED: 实测脚位已越过中间点 ${past.toFixed(3)} 格并超出脚位容差，停止并从当前实测位置重规划`), { code: 'CHECKPOINT_PASSED' });
      }
    };
    check();
    checkPosition();
    if (typeof b.look === 'function') { try { b.look(heading, 0, true); } catch { /* ignore */ } }
    b.clearControlStates();
    b.setControlState('forward', true);
    // 整块高度差不能只靠平走：原版自动跨步只有 0.6 格，一步上整块要起跳。
    // 同脚高但超过相邻格的距离由调用方证实的水平 jump 消耗一次起跳。
    // 只在这段身体控制里补一次跳跃；目标/落点仍由调用方决定。
    const needsJump = target.y > p0y + 0.6 || (horizontalJump && initialDistance > 1.2);
    if (needsJump) b.setControlState('jump', true);
    // sprint 只来自本次委托的执行请求；只在平走、无需跳跃/跨空时按住，
    // 逐段 feet 控制能看到外层非本地 moveTo 通过异步作用域传下来的同一请求。
    const sprinting = mode === 'feet' && sprint && !needsJump && !horizontalJump && Math.abs(target.y - p0y) <= 0.05;
    if (sprinting) b.setControlState('sprint', true);
    const jumpReleaseAt = Date.now() + 180;
    // 地面摩擦使水平速度每 tick 衰减到约 0.546 倍（停稳系数 ≈ 1/(1-0.546) ≈ 2.2），
    // 空中摩擦约 0.91 倍（停稳系数 ≈ 1/(1-0.91) ≈ 11.1，见 prismarine-physics）。
    const GROUND_DRAG = 0.546;
    const GROUND_STOP = 1 / (1 - GROUND_DRAG);
    const AIR_STOP = 1 / (1 - 0.91);
    // 平地上下一帧仍前进与现在松键的停止点相隔约一个步幅。两者中点决定哪次制动更接近原端点。
    const flatBrakeDistance = (speed: number) => speed * GROUND_STOP + speed / (2 * GROUND_DRAG);
    const flatFinish = mode === 'feet' && settleAtTarget && !horizontalJump && Math.abs(target.y - p0y) <= 1e-6;
    const EDGE = 0.2; // 身体中心离开原支撑、脚高开始变化的点：方块半宽 0.5 − 身体半宽 0.3
    let closest = dist();
    let overshot = false;
    let crossedCheckpoint = false;
    let coastingToCheckpoint = false;
    let previousX = p0.x, previousZ = p0.z;
    let wake: (() => void) | undefined;
    const stopWaiting = () => wake?.();
    const onPhysicsTick = () => {
      if (crossedCheckpoint || signal.aborted || !ownsControls()) return;
      const e = b.entity;
      const p = e.position, v = e.velocity;
      const stepX = p.x - previousX, stepZ = p.z - previousZ;
      previousX = p.x; previousZ = p.z;
      if (!atEndpoint() && passedIntermediate() <= 1e-9 && !(flatFinish && e.onGround && v && dist() <= flatBrakeDistance(Math.hypot(v.x, v.z)))) {
        // 若松键一帧就能入窗，而再走一帧后惯性会滑出，先滑入。下一帧仍读实际落脚。
        const coast = !settleAtTarget && !horizontalJump && e.onGround && v
          && Math.abs(p.y - target.y) <= FEET_ARRIVAL_TOLERANCE.vertical
          && Math.hypot(p.x + v.x - tx, p.z + v.z - tz) <= FEET_ARRIVAL_TOLERANCE.horizontal
          && Math.hypot(p.x + stepX + v.x - tx, p.z + stepZ + v.z - tz) > FEET_ARRIVAL_TOLERANCE.horizontal;
        if (Boolean(coast) !== coastingToCheckpoint) {
          coastingToCheckpoint = Boolean(coast);
          b.setControlState('forward', !coastingToCheckpoint);
          if (sprinting) b.setControlState('sprint', !coastingToCheckpoint);
        }
        return;
      }
      // Mineflayer 可在同一调用栈补跑多个物理帧。到位或到达平地制动点时立即松键，
      // 让下一帧按真实惯性前进；异步控制恢复后还会重新检查最新脚位。
      crossedCheckpoint = true;
      b.setControlState('forward', false);
      b.setControlState('jump', false);
      b.setControlState('sprint', false);
      stopWaiting();
    };
    if (mode === 'feet') b.on?.('physicsTick', onPhysicsTick);
    signal.addEventListener('abort', stopWaiting, { once: true });
    try {
      // 水平推进：按当前速度与「地面→下落」的状态变化估算制动距离，只有当身体会停在目标列内才松键。
      // 下降时身体离开支撑、水平速度在空中衰减更慢，须更早松键，让速度在到达边缘时降到能靠空中滑行落到中心。
      // 不以固定水平距离提前刹车——否则寻路停在距中心很近但仍由原支撑托住时，刚前进就松键、一步迈不出去。
      while (!crossedCheckpoint && !atEndpoint() && Date.now() < deadline) {
        check();
        checkPosition();
        if (needsJump && Date.now() >= jumpReleaseAt) b.setControlState('jump', false);
        const d = dist();
        const v = b.entity.velocity;
        const speed = v ? Math.hypot(v.x, v.z) : 0;
        const stopDist = horizontalJump && !b.entity.onGround
          // 空中无法用地面摩擦估计制动距离；保持前进，落地后再按目标列制动。
          ? 0
          : target.y < p0y
            ? EDGE + Math.max(0, speed - EDGE / AIR_STOP) * GROUND_STOP // 下降：地面减速到边缘速度，再空中滑到中心
            : flatFinish && b.entity.onGround ? flatBrakeDistance(speed) : speed * GROUND_STOP;
        // 小落差即便是中间点也先按落边速度制动，避免尚未落地就越过原端点。
        // 到位后的交接可以保留速度，不等于允许空中跳过落点验收。
        if ((settleAtTarget || target.y < p0y) && d <= stopDist) { b.setControlState('forward', false); break; }
        const overshootLimit = horizontalJump ? initialDistance + 0.75 : Math.max(1.5, initialDistance);
        if (d > closest + 0.05 || d > overshootLimit) { overshot = true; break; }
        closest = Math.min(closest, d);
        await this.afterAction(() => new Promise<void>(resolve => {
          const timer = setTimeout(finish, Math.min(50, Math.max(1, deadline - Date.now())));
          function finish() {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          }
          wake = finish;
        }), check);
        checkPosition();
      }
    } finally {
      if (mode === 'feet') b.removeListener?.('physicsTick', onPhysicsTick);
      signal.removeEventListener('abort', stopWaiting);
      if (ownsControls()) {
        try { b.setControlState('forward', false); } catch { /* ignore */ }
        try { b.setControlState('jump', false); } catch { /* ignore */ }
        try { b.setControlState('sprint', false); } catch { /* ignore */ }
      }
    }
    checkPosition();
    // 已复验的连续路线中间点只确认真实落地/端点，不把每格都当作最终停车点。
    // 上面的 finally 仍释放本次控制；宿主同步复验下一段后可立即接续而不等速度归零。
    if (!settleAtTarget && settled()) return 'arrived';
    // 连续脚位允许有限次低速修正：制动估计偏差可能让身体停在目标外几厘米，
    // 格心模式仍保留旧的越段即停语义。
    if (overshot && (mode === 'cell' || dist() > 0.6)) return 'overshot';
    // 末点/独立动作的落地确认：站稳 + 列一致 + 脚高相符 + 水平速度已衰减到接近停住；
    // 已复验路线的中间点只在真实落地到位后交接速度。
    // （低于物理的 negligibleVelocity 0.003，之后速度被置零、身体不再滑动），不因单帧 settled 提前返回。
    const stopped = () => {
      const v = b.entity.velocity;
      return !v || Math.hypot(v.x, v.z) < 0.003;
    };
    let stable = 0;
    let corrections = 0;
    while (Date.now() < deadline) {
      check();
      checkPosition();
      if (!settleAtTarget && settled()) return 'arrived';
      if (settled() && stopped()) {
        if (++stable >= 2) return 'arrived';
      } else {
        stable = 0;
        const d = dist();
        if (mode === 'feet' && d > 0.6 && b.entity.onGround && stopped()) return 'overshot';
        const shortOfFinish = alongRemaining() > 0 && atEndpoint();
        if (mode === 'feet' && corrections < 8 && (d > 0.02 || shortOfFinish) && d <= 0.6 && b.entity.onGround && stopped()) {
          // 发下一次修正前重新核对动作归属与原期限：剩余 <=0 就不再按键，等待时长也不得超过原期限。
          check();
          if (deadline - Date.now() <= 0) break;
          checkPosition();
          // 保持本段朝向，用前后/侧移短脉冲纠正真实偏差；越过落点几厘米不必转身。
          // 每次释放后仍重新测量停稳与原目标，不把“按过键”当作纠正完成。
          corrections += 1;
          const p = b.entity.position;
          // 已在原脚位容差内但尚差少量投影时，沿冻结方向低速点按，避免一个普通步幅跨过整个末点精度窗。
          const dx = shortOfFinish ? corridor!.bearing.x : target.x - p.x;
          const dz = shortOfFinish ? corridor!.bearing.z : target.z - p.z;
          const forward = -dx * Math.sin(heading) - dz * Math.cos(heading);
          const right = dx * Math.cos(heading) - dz * Math.sin(heading);
          const fineFinish = corridor?.minimumAlong !== undefined && d <= FEET_ARRIVAL_TOLERANCE.horizontal * 2;
          const keys: ('forward' | 'back' | 'left' | 'right' | 'sneak')[] = [
            ...(fineFinish ? ['sneak' as const] : []),
            ...(Math.abs(forward) > 0.02 ? [forward > 0 ? 'forward' as const : 'back' as const] : []),
            ...(Math.abs(right) > 0.02 ? [right > 0 ? 'right' as const : 'left' as const] : []),
          ];
          const tapMs = Math.min(fineFinish ? 50 : 120, Math.max(50, Math.round(d / 0.2) * 50), deadline - Date.now());
          if (tapMs <= 0) break;
          try {
            for (const key of keys) b.setControlState(key, true);
            await this.afterAction(() => sleep(tapMs, signal), check);
          } finally {
            if (ownsControls()) for (const key of keys) b.setControlState(key, false);
          }
          checkPosition();
        }
      }
      await this.afterAction(() => sleep(Math.min(40, Math.max(1, deadline - Date.now())), check.signal), check);
      checkPosition();
    }
    return 'timeout';
  }

  withNavigation<T>(delegate: NavigationDelegate, run: () => Promise<T>): Promise<T> {
    return this.navigationDelegate.run(delegate, run);
  }

  async settleMovement(opts: Pick<MoveOpts, 'signal' | 'timeoutMs'>): Promise<void> {
    const check = this.actionCheckpoint(opts.signal);
    check();
    if (!this.ready) throw new Error('NOT_CONNECTED');
    const b = this.bot;
    const deadline = Date.now() + Math.max(0, opts.timeoutMs);
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint'] as const) b.setControlState(key, false);
    let stable = 0;
    while (Date.now() < deadline) {
      check();
      const e = b.entity;
      if (e.onGround && Math.hypot(e.velocity.x, e.velocity.z) < 0.003) {
        if (++stable >= 2) return;
      } else stable = 0;
      await this.afterAction(() => sleep(Math.min(40, Math.max(1, deadline - Date.now())), opts.signal), check);
    }
    throw Object.assign(new Error('TIMEOUT: 运动键已释放，但身体尚未实测停稳'), { name: 'Timeout' });
  }

  stopAll() {
    this.actionEpoch++;
    this.actionContext.exit(() => {
      const b = this.bot;
      if (!b) return;
      try { b.clearControlStates(); } catch { /* ignore */ }
      try { if (b.targetDigBlock) b.stopDigging(); } catch { /* ignore */ }
      try { this.cancelItemUse(b); } catch { /* ignore */ }
      try { if (b.currentWindow) b.closeWindow(b.currentWindow); } catch { /* ignore */ }
      try { if (b.isSleeping) Promise.resolve(b.wake()).catch(() => {}); } catch { /* ignore */ }
    });
    // 被打断的动作可能做了一半：界面里摆了一半的材料、光标上拿着东西。等服务器处理完已经发出的包，再收拾
    this.scheduleRepair('动作被打断', 250);
  }

  /**
   * 交互卫生：Mineflayer 的界面操作（合成、箱子、熔炉、装备）是一串点击，中途被打断时，没发出去的点击被丢掉，
   * 服务器那边就留下半截状态（2×2 合成格里的材料、光标上的物品、没关的窗口），Mineflayer 却以为是干净的，
   * 之后同类操作会一直对不上（合成卡到超时、放东西放不进去）。这里统一收拾：打断后收一次，空闲时发现残留也收一次；
   * 碰背包/界面的动作开始前先等收拾完。每次收拾都发 interaction_repaired 事件，日志里看得到有多频繁。
   */
  private scheduleRepair(reason: string, delayMs = 0) {
    if (this.repairing) return;
    const run = async () => {
      if (delayMs) await sleep(delayMs);
      await this.repairInteraction(reason);
    };
    this.repairing = this.actionContext.exit(() => run()).catch(() => {}).finally(() => { this.repairing = null; });
  }

  /** 背包/界面里有没有残留（打断留下的半截交互） */
  private tossCursorReturn: { bot: any; window: Window; slot: number; identity: string } | null = null;

  private interactionDirty(): string[] {
    const b = this.bot;
    if (!this.ready || !b?.inventory?.slots) return [];
    const out: string[] = [];
    const grid = [1, 2, 3, 4].map((i) => b.inventory.slots[i]).filter(Boolean);
    if (grid.length) out.push(`合成格里有 ${grid.map((i: any) => `${i.name}×${i.count}`).join('、')}`);
    if (b.inventory.selectedItem) out.push(`光标上拿着 ${b.inventory.selectedItem.name}×${b.inventory.selectedItem.count}`);
    if (b.currentWindow && this.inFlight === 0) out.push(`窗口 ${b.currentWindow.type ?? ''} 没关`);
    return out;
  }

  private async repairInteraction(reason: string) {
    const b = this.bot;
    const pending = this.tossCursorReturn;
    if (pending && pending.bot !== b) this.tossCursorReturn = null;
    if (pending && pending.bot === b) {
      // A cancelled click may still have a server response in flight. Do not
      // move its cursor until that operation is finished.
      const deadline = Date.now() + 3000;
      while (this.inFlight > 0 && Date.now() < deadline) await sleep(25);
      if (this.inFlight > 0) return;
      if (b.currentWindow && b.currentWindow !== pending.window) return;
      const window: Window = b.currentWindow ?? b.inventory;
      const slot = window === pending.window ? pending.slot
        : pending.slot - pending.window.inventoryStart + window.inventoryStart;
      if (typeof b._syncWindow !== 'function') return;
      const synced = await Promise.race([Promise.resolve(b._syncWindow(window)).then(() => true, () => false), sleep(3000).then(() => false)]);
      if (!synced) return;
      const cursor = window.selectedItem, source = window.slots[slot];
      const identity = (item: any) => JSON.stringify([item.type, item.metadata, item.nbt ?? null]);
      if (cursor) {
        if (identity(cursor) !== pending.identity || source && (identity(source) !== pending.identity || source.count + cursor.count > source.stackSize)) return;
        const returnedName = cursor.name, returnedCount = cursor.count;
        await b.clickWindow(slot, 0, 0);
        const returned = await Promise.race([Promise.resolve(b._syncWindow(window)).then(() => true, () => false), sleep(3000).then(() => false)]);
        if (!returned) return;
        if (window.selectedItem) return;
        this.bus.publish('interaction_repaired', 'P3', `收拾交互残留（${reason}）：光标上的 ${returnedName}×${returnedCount} 已归还原槽`, { reason, slot, item: returnedName, count: returnedCount });
      }
      this.tossCursorReturn = null;
    }
    const found = this.interactionDirty();
    if (!found.length) return;
    try {
      if (b.currentWindow && this.inFlight === 0) { try { b.closeWindow(b.currentWindow); } catch { /* ignore */ } await sleep(100); }
      await this.clearCraftGrid();
    } catch { /* 下次再收 */ }
    const left = this.interactionDirty();
    this.bus.publish('interaction_repaired', left.length ? 'P2' : 'P3', `收拾交互残留（${reason}）：${found.join('；')}${left.length ? `；还剩：${left.join('；')}` : ''}`, { reason, found, left });
  }

  /** 碰背包/界面的动作开始前：等打断后的收拾做完；还有残留就先收拾 */
  private async interactionReady() {
    if (this.repairing) await this.repairing;
    if (this.tossCursorReturn) await this.actionContext.exit(() => this.repairInteraction('恢复中断的丢弃'));
    if (this.tossCursorReturn) throw new Error('INTERACTION_DIRTY: 丢弃操作遗留的光标物品尚未安全归还');
    if (this.interactionDirty().some((d) => !d.startsWith('窗口'))) await this.actionContext.exit(() => this.repairInteraction('动作开始前发现残留'));
  }

  private cancelItemUse(b: any) {
    // release_use_item fires a drawn bow. A held-slot change instead cancels
    // use synchronously, before the next action owner can take control.
    if (['bow', 'crossbow', 'trident'].includes(b.heldItem?.name)) {
      if (typeof b.setQuickBarSlot === 'function') b.setQuickBarSlot(((b.quickBarSlot ?? 0) + 1) % 9);
      b.usingHeldItem = false;
    } else b.deactivateItem();
  }

  canHarvest(pos: Vec3Like): boolean {
    if (!this.ready) return false;
    const block = this.bot.blockAt(this.vec(pos));
    if (!block) return false;
    if (!block.harvestTools) return true;
    const ids = Object.keys(block.harvestTools).map(Number);
    return this.bot.inventory.items().some((i: any) => ids.includes(i.type));
  }

  /** 它亲手拿到主手的工具（按种类记：pickaxe → iron_pickaxe）：之后自动换工具时照它的选择来 */
  private toolChoice = new Map<string, string>();
  private noteToolChoice(name: string) {
    const kind = name.match(/_(pickaxe|axe|shovel|hoe)$/)?.[1] ?? (name === 'shears' ? 'shears' : null);
    if (kind) this.toolChoice.set(kind, name);
  }
  private preferredDigTool(block: any): Item | undefined {
    const b = this.bot, e = b.entity;
    const timeFor = (type: number | null, ench: any[] = []) => {
      try { return block.digTime(type, false, !!e.isInWater, !e.onGround, ench, e.effects ?? {}); } catch { return Infinity; }
    };
    const bare = timeFor(null);
    const usable = (it: Item) => block.harvestTools ? !!block.harvestTools[it.type] : timeFor(it.type, (it as any).enchants ?? []) < bare;
    const held = b.heldItem;
    if (held && usable(held)) return held;
    const kindOf = (name: string) => name.match(/_(pickaxe|axe|shovel|hoe)$/)?.[1] ?? (name === 'shears' ? 'shears' : null);
    const chosen = b.inventory.items().find((it: Item) => { const kind = kindOf(it.name); return !!kind && this.toolChoice.get(kind) === it.name && usable(it); });
    return chosen ? this.bestInvItem(chosen.name) ?? chosen : undefined;
  }

  /** 它亲手拿到主手的东西（不只是工具）：外层用它跨进程重启恢复，避免重启后退回“最快工具” */
  private noteHandChoice(name: string | null) {
    if (name) this.noteToolChoice(name);
    this.emit('hand_choice', name);
  }

  private async equipBestTool(block: any, signal: AbortSignal, forced?: string | null, handOnly = false): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    const e = b.entity;
    // 指定了工具：只装这一把。软方块没有 harvestTools（任何工具都挖得动），照样照它说的用，
    // 不因为别的工具更快就换成别的，也不因为手上工具挖得慢就退回空手。
    if (forced) {
      const it = b.inventory.items().find((i: any) => i.name === forced);
      if (!it) return { ok: false, reason: `TOOL_MISSING: 背包里没有 ${forced}，无法挖 ${block.name}` };
      // 不因 harvestTools 拒绝：指定工具挖不出掉落时仍能挖开这一格（清路/脱困），
      // 掉落事实由 dig 在装备后按实际手持回报 noDrop；是否换工具由 Agent 决定。
      const pick = this.bestInvItem(forced) ?? it;
      if (b.heldItem?.type !== pick.type) await this.afterAction(() => b.equip(pick, 'hand'), check);
      // 指定工具必须真的在主手才开挖；装备没落到主手就不能拿原主手继续挖
      if (b.heldItem?.name !== forced) return { ok: false, reason: `EQUIP_NOT_CONFIRMED: ${forced} 没有装备到主手，未挖 ${block.name}` };
      this.noteHandChoice(forced);
      return { ok: true };
    }
    // 调用方只要“当前手持”：空手就空手挖，不能从背包替它挑/换工具。
    // 挖不动/不掉落的真实结果由 dig 的 noDrop/超时事实返回，不在这一步偷偷升级。
    if (handOnly) return { ok: true };
    let best: any = null;
    let bestTime = Infinity;
    const timeFor = (type: number | null, ench: any[] = []) => {
      try { return block.digTime(type, false, !!e.isInWater, !e.onGround, ench, e.effects ?? {}); } catch { return Infinity; }
    };
    const bare = timeFor(null);
    const held = b.heldItem;
    const preferred = this.preferredDigTool(block);
    if (preferred) {
      if (b.heldItem?.type !== preferred.type) await this.afterAction(() => b.equip(preferred, 'hand'), check);
      return { ok: true };
    }
    if (!block.harvestTools) bestTime = bare;
    for (const it of b.inventory.items()) {
      if (block.harvestTools && !block.harvestTools[it.type]) continue;
      const t = timeFor(it.type, it.enchants ?? []);
      if (t < bestTime) {
        bestTime = t;
        best = it;
      }
    }
    if (best && b.heldItem?.type !== best.type) await this.afterAction(() => b.equip(best, 'hand'), check);
    // 没有更快的工具：切到已有的非耐久物品来挖，满包也能换手，不能为了空手而丢掉武器。
    else if (!best && held && this.mcData.itemsByName?.[held.name]?.maxDurability > 0) {
      const replacement: Item | undefined = b.inventory.items().find((item: Item) => {
        const data = this.mcData.itemsByName[item.name];
        return data && !(data.maxDurability > 0);
      });
      const switched = await this.afterAction(() => this.equipItem(replacement?.name ?? null, 'hand', signal,
        replacement ? { sourceSlot: replacement.slot } : {}), check);
      if (!switched.ok) return { ok: false, reason: `${switched.reason}：无法安全切换挖掘时的手持物品，尚未挖掘` };
    }
    return { ok: true };
  }

  async dig(pos: Vec3Like, signal: AbortSignal, opts: { tool?: string | null; handOnly?: boolean } = {}): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const block = b.blockAt(this.vec(pos));
    if (!block || ['air', 'cave_air', 'void_air', 'water', 'lava'].includes(block.name)) return { ok: false, reason: 'NO_BLOCK' };
    if (block.diggable === false) return { ok: false, reason: 'UNBREAKABLE_BLOCK' };
    // 没有对应工具时只是不掉东西，照样能挖掉（原版：空手挖石头约 7.5 秒、深板岩约 15 秒，什么都不掉）：
    // 清路、脱困只要把这一格挖开，用不着镐；要拿到圆石、矿石才得用镐（gather 自己会先检查）。
    // 以前这里一律拒绝（TOOL_MISSING），它就学成了“没镐石头动不了”，镐快断时宁可困在洞里也不敢挖
    const tool = await this.afterAction(() => this.equipBestTool(block, signal, opts.tool, opts.handOnly === true), check);
    if (!tool.ok) return tool;
    // 掉落事实按装备后的实际手持算：背包里虽有镐，空手或指定斧头挖石头仍是什么都不掉。
    const harvest = !block.harvestTools || (!!b.heldItem && !!block.harvestTools[b.heldItem.type]);
    throwIfAborted(signal);
    if (!b.canDigBlock(block)) return { ok: false, reason: 'OUT_OF_REACH' };
    const e = b.entity;
    let ms = 0;
    try { ms = block.digTime(b.heldItem?.type ?? null, false, !!e?.isInWater, !e?.onGround, b.heldItem?.enchants ?? [], e?.effects ?? {}); } catch { ms = 0; }
    // Long legal hand digs exceed this bounded action's execution budget.
    if (!harvest && (!Number.isFinite(ms) || ms > HAND_DIG_MAX_MS)) return { ok: false, reason: 'HAND_DIG_TIMEOUT:预计挖掘时间超过本次身体动作预算；这不代表游戏禁止空手挖掘' };
    // 记下本次目标、开始时间和实际手持工具，供 diggingCompleted 回调填实测耗时；同一时刻只有一挖
    const started = { pos: { x: block.position.x, y: block.position.y, z: block.position.z }, ts: Date.now(), tool: b.heldItem?.name ?? null };
    this.digStart = started;
    // 取消/异常时清掉，免得下一次挖掘把这次的开始时间当成自己的（被中途打断的挖掘没有实测耗时）
    try {
      // 挖哪格就看着哪格：服务端虽不校验朝向，但不转头时视线停在走路方向，旁观看到的是背对方块在挖，
      // 视野也看不到正在挖的东西。
      await this.afterAction(() => raceAbort(b.dig(block, true), signal, Math.max(20000, (Number.isFinite(ms) ? ms : 0) + 5000), () => {
        try { b.stopDigging(); } catch { /* ignore */ }
      }), check);
    } finally {
      if (this.digStart === started) this.digStart = null;
    }
    return harvest ? { ok: true } : { ok: true, noDrop: true, digMs: Date.now() - started.ts };
  }

  async collectNearbyDrops(signal: AbortSignal, radius: number, timeoutMs: number): Promise<number> {
    let check = this.actionCheckpoint(signal);
    const bot = this.bot, session = this.sessionId, dimension = this.currentDimension();
    const start = Date.now();
    const deadline = start + Math.max(0, timeoutMs);
    const initialScanUntil = Math.min(deadline, start + 300);
    let picked = 0;
    // 每个掉落物最多追 3 次：掉进水里会漂，走到它原来的位置时它已经不在那儿了，要按它现在的位置再追
    const tries = new Map<number, number>();
    const tried = { has: (id: number) => (tries.get(id) ?? 0) >= 3, add: (id: number) => tries.set(id, (tries.get(id) ?? 0) + 1), get size() { return tries.size; } };
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      // 第一次只捡身边的；追过一次的，漂远一点（多 6 格）也接着追
      const item = this.nearbyEntities(radius + 6).find((e) => e.kind === 'item' && !tried.has(e.id) && (tries.has(e.id) || e.dist <= radius) && !this.isDiscarded(e.name.replace(/^item:/, ''), e.pos));
      if (!item) {
        // block_update can arrive before item_spawn; briefly allow that first
        // drop to become observable without turning collection into a long wait.
        const graceLeft = initialScanUntil - Date.now();
        if (!tried.size && graceLeft > 0) {
          await this.afterAction(() => sleep(Math.min(100, graceLeft), signal), check);
          continue;
        }
        break;
      }
      tried.add(item.id);
      const moveEpoch = this.actionEpoch;
      try {
        await this.afterAction(() => this.moveTo({ kind: 'near', pos: item.pos, range: 1 }, { signal, timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) }), check);
        if (!this.bot.entities[item.id]) picked++;
      } catch (e: any) {
        if (e?.name === 'AbortedError') throw e;
        // 走不过去（超时、没路）就不再追这一个；只有走到了它却漂走了才按新位置再追
        tries.set(item.id, 3);
        if (e instanceof TimeoutError && this.actionEpoch === moveEpoch + 1) {
          // The pickup path's own timeout calls stopAll to block late movement.
          // Keep this best-effort collection alive, while its old path stays
          // invalidated and an actual task/session cancellation still exits.
          throwIfAborted(signal);
          if (bot !== this.bot || session !== this.sessionId || dimension !== this.currentDimension()) throw new AbortedError('action ownership changed');
          check = this.actionCheckpoint(signal);
        } else if (e instanceof TimeoutError && this.actionEpoch !== moveEpoch) {
          // 还有别处也 stopAll 了（外部停止，epoch 不止 +1）：本次拾取作废，别继续追
          throw new AbortedError('action ownership changed');
        }
      }
      const waitMs = Math.min(200, deadline - Date.now());
      if (waitMs > 0) await this.afterAction(() => sleep(waitMs, signal), check);
      else check();
    }
    return picked;
  }

  private BlockCls: any = null;
  digTimeEstimate(block: string, tool: string | null): number | null {
    if (!this.mcData) return null;
    try {
      const bd = this.mcData.blocksByName[block];
      if (!bd) return null;
      this.BlockCls ??= require('prismarine-block')(this.bot.registry ?? this.bot.version);
      const blk = this.BlockCls.fromStateId(bd.defaultState ?? bd.minStateId, 0);
      const toolId = tool ? this.mcData.itemsByName[tool]?.id ?? null : null;
      if (blk.harvestTools && (toolId === null || !blk.harvestTools[toolId])) return null; // 这个工具挖不出东西
      const t = blk.digTime(toolId, false, false, false, [], {});
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * 跨空腔搭桥：身体站在最后一块实心方块上，潜行挪到朝目标方向的边缘（中心越过方块边缘一点，
   * AABB 仍压着旧方块，不会掉），再点参照方块朝目标那一面，把支撑放到脚下一格或两格。
   * 脚下一格点脚下支撑块的侧面；脚下两格点支撑块下方那一格的侧面（这要求那一格是实心参照方块）。
   * 只处理水平相邻的支撑位；目标格必须为空。几何不允许时如实返回原因，不瞬移、不伪造成功。
   */
  async sneakPlaceAt(target: Vec3Like, itemNames: string[], signal: AbortSignal): Promise<ActionResult & { placedName?: string | null; verified?: boolean; placed?: Vec3Like; stance?: Vec3Like; attemptedFaces?: { ref: Vec3Like; face: [number, number, number]; reason?: string }[] }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    await this.interactionReady();
    check();
    const b = this.bot;
    if (!b?.entity?.position || typeof b.setControlState !== 'function' || typeof b.placeBlock !== 'function') return { ok: false, reason: 'NOT_CONNECTED' };
    const feet = feetCell({ x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z });
    const dx = target.x - feet.x, dz = target.z - feet.z;
    if (Math.abs(dx) + Math.abs(dz) !== 1) return { ok: false, reason: 'EDGE_NOT_ADJACENT:目标格必须与脚格水平相邻' };
    const drop = feet.y - target.y;
    if (drop !== 1 && drop !== 2) return { ok: false, reason: 'EDGE_HEIGHT:只能补脚下一格或两格的支撑，其他高度需要另找站位' };
    const tgt = this.vec(target);
    const cur = b.blockAt(tgt);
    if (cur && cur.boundingBox === 'block') {
      return { ok: true, placed: { ...target }, placedName: String(cur.name), verified: itemNames.includes(String(cur.name)) };
    }
    const under = b.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
    if (!under || under.boundingBox !== 'block') return { ok: false, reason: 'EDGE_NO_SUPPORT:脚下不是实心方块' };
    // 参照方块必须与目标格同层：drop 1 是脚下支撑块，drop 2 是再下面一格。
    const refAt = new Vec3(feet.x, target.y, feet.z);
    const refBefore = b.blockAt(refAt);
    const face: [number, number, number] = [dx, 0, dz];
    const tried = refBefore && refBefore.boundingBox === 'block'
      ? [{ ref: { x: refAt.x, y: refAt.y, z: refAt.z }, face }]
      : [];
    if (!tried.length) {
      return { ok: false, reason: `EDGE_NO_REFERENCE:目标格 (${target.x},${target.y},${target.z}) 同层的 (${refAt.x},${refAt.y},${refAt.z}) 不是实心参照方块；脚下两格没有可点的侧面，换站位或改用 descend_to/place_cell`, attemptedFaces: [] };
    }
    const item = b.inventory.items().find((i: any) => itemNames.includes(i.name));
    if (!item) return { ok: false, reason: 'NO_ITEM', attemptedFaces: tried };
    const epoch = this.actionEpoch;
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot;
    const cx = feet.x + 0.5 + dx * 0.6, cz = feet.z + 0.5 + dz * 0.6;
    b.clearControlStates?.();
    b.setControlState('sneak', true);
    let placedOk = false;
    try {
      // 这次转头是功能性的：forward 键按 yaw 前进，要走到方块边缘外侧必须先面向 dx/dz。
      if (typeof b.look === 'function') {
        await this.afterAction(() => raceAbort(b.look(Math.atan2(-dx, -dz), -0.35, true), signal, 1000, () => {}), check);
      }
      b.setControlState('forward', true);
      let last = { x: b.entity.position.x, z: b.entity.position.z }, still = 0;
      for (let t = 0; t < 700; t += 50) {
        await this.afterAction(() => sleep(50, signal), check);
        const q = b.entity.position;
        if (Math.hypot(q.x - cx, q.z - cz) < 0.08) break;
        if (!b.entity.onGround) break;
        if (Math.hypot(q.x - last.x, q.z - last.z) < 0.01 && ++still >= 3) break;
        last = { x: q.x, z: q.z };
      }
      b.setControlState('forward', false);
      // 必须已经从方块中心挪到边缘外侧，否则还是会被旧方块的顶面挡住。
      const q = b.entity.position;
      const stance = { x: q.x, y: q.y, z: q.z };
      const pastEdge = (dx !== 0 ? (q.x - (feet.x + 0.5)) * dx : (q.z - (feet.z + 0.5)) * dz) >= 0.52;
      if (!pastEdge) return { ok: false, reason: 'EDGE_NOT_REACHED:潜行没有挪到方块边缘', stance, attemptedFaces: tried };
      const ref = b.blockAt(refAt);
      if (!ref || ref.boundingBox !== 'block') return { ok: false, reason: 'EDGE_LOST_SUPPORT:挪到边缘后脚下支撑或参照方块不见了', stance, attemptedFaces: tried };
      await this.afterAction(() => b.equip(item, 'hand'), check);
      // b.placeBlock 会看向被点的参照面：和挖掘一样朝向自己正在操作的方块。
      await this.afterAction(() => raceAbort(b.placeBlock(ref, new Vec3(dx, 0, dz)), signal, 5000, () => {}), check);
      const now = b.blockAt(tgt);
      if (!now || now.boundingBox !== 'block') return { ok: false, reason: 'NOT_PLACED:边缘放置后目标格仍是空的', stance, attemptedFaces: tried };
      // 目标格出现了碰撞方块不等于请求材料已放下；核对实际方块名再给 confirmed。
      const evidence = this.placementEvidence(target, itemNames, item.name);
      this.notePlaced({ x: target.x, y: target.y, z: target.z }, item.name, evidence.verified ? 'confirmed' : 'attempted');
      placedOk = true;
      return { ok: true, placed: { ...target }, stance, attemptedFaces: tried, ...evidence };
    } catch (e) {
      if ((e as Error)?.name === 'AbortedError') throw e;
      const q = b.entity.position;
      return { ok: false, reason: `EDGE_PLACE_FAILED:${String((e as Error)?.message ?? e).slice(0, 100)}`, stance: { x: q.x, y: q.y, z: q.z }, attemptedFaces: tried };
    } finally {
      // 放置失败时人还在方块边缘外面：先潜行退回格心再松 sneak，避免一松就不受支撑。
      // 已取消/被换主时绝不再主动移动身体，交给新的动作所有者接管。
      if (ownsControls() && !signal.aborted && !placedOk) {
        try {
          if (typeof b.look === 'function') await b.look(Math.atan2(dx, dz), -0.35, true);
          b.setControlState('forward', true);
          await sleep(250);
        } catch { /* 清理失败不覆盖原始结果 */ }
      }
      if (ownsControls()) {
        b.setControlState('forward', false);
        b.setControlState('sneak', false);
      }
    }
  }

  async placeBlockAt(pos: Vec3Like, itemNames: string[], signal: AbortSignal): Promise<ActionResult & { placedName?: string | null; verified?: boolean; attemptedFaces?: { ref: Vec3Like; face: [number, number, number]; reason?: string }[] }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    await this.interactionReady();
    check();
    const b = this.bot;
    const item = b.inventory.items().find((i: any) => itemNames.includes(i.name));
    if (!item) return { ok: false, reason: 'NO_ITEM' };
    const target = this.vec(pos);
    const cur = b.blockAt(target);
    // 已经有方块了：这不是本次放置，只如实返回目标格当前的方块名。
    if (cur && cur.boundingBox === 'block') return { ok: true, ...this.placementEvidence(pos, itemNames, item.name) };
    // 树苗只能种在草地/泥土类方块上：先查目标格下方，种不了就报清楚（别让服务器拒绝后只回一句 still air）
    if (isTreeSaplingItem(item.name)) {
      const below = b.blockAt(target.offset(0, -1, 0));
      if (!below) return { ok: false, reason: `BAD_SUPPORT:目标格 (${target.x},${target.y},${target.z}) 正下方未加载，无法确认树苗的土壤` };
      if (!saplingSoilFor(item.name).has(below.name)) {
        return { ok: false, reason: `BAD_SUPPORT:${item.name} 只能种在${saplingSoilText(item.name)}上，目标格 (${target.x},${target.y},${target.z}) 正下方 (${target.x},${target.y - 1},${target.z}) 是 ${below.name}` };
      }
    }
    // 贴墙的东西（梯子、火把、按钮……）要以它能挂住的那一面为参照：梯子只能挂在实心墙的侧面，火把可以立在地上或挂在墙上；
    // 以前对什么方块都先试脚下那块的顶面，梯子就放不上，还只报“没有参照”，学不到“要贴墙放”
    const attach = attachmentFaces(item.name);
    const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
    const faces = attach === 'side' ? sides : attach === 'floor_or_side' ? [...sides, new Vec3(0, -1, 0)]
      : [new Vec3(0, -1, 0), new Vec3(0, 1, 0), ...sides];
    // 贴着箱子、工作台、门这类一点就打开的方块放：先试别的面；只能贴着它时按住潜行再放（不然是打开它，不是放方块）
    // 桶（水/岩浆）能贴着流体块的面放：往岩浆源上方/旁边的空气格倒水生成黑曜石，靠的就是把水桶贴在岩浆块的面（流体没有 boundingBox:'block'，单独放行）
    const fluidRef = /^(water|lava)_bucket$/.test(item.name);
    const refs = faces.map((f) => ({ f, ref: b.blockAt(target.plus(f)) }))
      .filter((x) => x.ref && (x.ref.boundingBox === 'block' || (fluidRef && (x.ref.name === 'lava' || x.ref.name === 'water'))))
      .sort((x, y) => Number(OPENS_ON_CLICK.test(x.ref.name)) - Number(OPENS_ON_CLICK.test(y.ref.name)));
    const at = `(${target.x},${target.y},${target.z})`;
    if (!refs.length && attach) return { ok: false, reason: attach === 'side' ? 'NO_WALL' : 'NO_FLOOR_OR_WALL', detail: `${at} 四周没有已加载的实心方块面`, attemptedFaces: [] };
    // 整块方块不能放进和自己身体碰撞箱重叠的格子：服务器会直接拒绝，只回一句“仍是空气”。
    // 身体中心离格边不到 0.3 时碰撞箱会压进相邻格（2026-11-10 x=-50.71 压进 x=-52..-51 那列 0.008 格，连拒 4 次）。
    // 目标不是自己脚下这一列时，先潜行回到脚下格中心再放；仍重叠就如实报出，不再盲目点。
    if (!attach && this.mcData?.blocksByName?.[item.name]?.boundingBox === 'block') {
      const overlaps = () => {
        const q = b.entity.position;
        return q.x + 0.3 > target.x && q.x - 0.3 < target.x + 1 && q.z + 0.3 > target.z && q.z - 0.3 < target.z + 1
          && q.y + 1.8 > target.y && q.y < target.y + 1;
      };
      const feet = b.entity.position.floored();
      if (overlaps() && (feet.x !== target.x || feet.z !== target.z)) await this.steady({ x: feet.x, z: feet.z }, signal, check);
      if (overlaps()) return { ok: false, reason: `BODY_IN_TARGET:身体碰撞箱和目标格 ${at} 重叠，服务器不允许把方块放进自己身体所在的格`, attemptedFaces: [] };
    }
    // 实际尝试过的参照方块/面：失败回执要给结构化事实，不能只给一句文本。
    const attemptedFaces: { ref: Vec3Like; face: [number, number, number]; reason?: string }[] = [];
    for (const { f, ref } of refs) {
      const attempt: PlacementFaceAttempt = { ref: { x: ref.position.x, y: ref.position.y, z: ref.position.z }, face: [-f.x, -f.y, -f.z] };
      attemptedFaces.push(attempt);
      if (!this.canClickPlacementFace(ref, f.scaled(-1))) {
        attempt.reason = 'FACE_NOT_CLICKABLE:视线被挡或超出交互距离';
        continue;
      }
      const sneak = OPENS_ON_CLICK.test(ref.name);
      try {
        await this.afterAction(() => b.equip(item, 'hand'), check);
        if (sneak) { b.setControlState('sneak', true); await this.afterAction(() => sleep(120, signal), check); }
        try {
          // 放置时看着被点的面（面是否看得见由上面的 canClickPlacementFace 射线预检保证）。
          await this.afterAction(() => raceAbort(b.placeBlock(ref, f.scaled(-1)), signal, 5000, () => {}), check);
        } finally { if (sneak) b.setControlState('sneak', false); }
        // 动作回执成功不等于请求材料已经放下：读一次目标格再标 attempted/confirmed。
        const evidence = this.placementEvidence(pos, itemNames, item.name);
        this.notePlaced({ x: target.x, y: target.y, z: target.z }, item.name, evidence.verified ? 'confirmed' : 'attempted');
        return { ok: true, ...evidence };
      } catch (e: any) {
        if (e?.name === 'AbortedError') throw e;
        attempt.reason = `PLACE_FAILED:${String(e?.message ?? e).slice(0, 80)}`;
      }
    }
    // 窄竖井里往自己脚下/头那一格插火把：脚下那块顶面无论如何都够得着，射线门禁在身体格上容易误拒，直接贴着脚下放
    if (item && b.entity?.position && /(^|_)torch$/.test(item.name)) {
      const feet = feetCell({ x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z });
      const ownCell = target.x === feet.x && target.z === feet.z && (target.y === feet.y || target.y === feet.y + 1);
      if (ownCell) {
        const floor = b.blockAt(target.offset(0, -1, 0));
        if (floor && floor.boundingBox === 'block') {
          try {
            await this.afterAction(() => b.equip(item, 'hand'), check);
            await this.afterAction(() => raceAbort(b.placeBlock(floor, new Vec3(0, 1, 0)), signal, 5000, () => {}), check);
            const evidence = this.placementEvidence(pos, itemNames, item.name);
            this.notePlaced({ x: target.x, y: target.y, z: target.z }, item.name, evidence.verified ? 'confirmed' : 'attempted');
            return { ok: true, ...evidence };
          } catch (e: any) {
            if (e?.name === 'AbortedError') throw e;
          }
        }
      }
    }
    // 放置面全被拒时把每一面的实际原因带回去：是太远、还是被哪一格挡住。只说一句
    // “视线被挡或超出 4.4 格”，心智无法判断该靠近、侧移还是先挖开挡住的那一格。
    const explainFace = ({ f, ref }: { f: any; ref: any }) => {
      const face = f.scaled(-1);
      const from = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
      const to = ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const dir = to.minus(from), distance = dir.norm();
      const where = `(${ref.position.x},${ref.position.y},${ref.position.z})`;
      if (distance < 0.01) return `${where} 眼睛几乎贴着参照面，无法确认交互方向`;
      if (distance > 4.4) return `${where} 距眼睛 ${distance.toFixed(1)} 格（超过 4.4）`;
      if (typeof b.world?.raycast !== 'function') return `${where} 没有可用的视线射线`;
      const hit = b.world.raycast(from, dir.normalize(), distance + 0.05);
      if (!hit?.position) return `${where} 的射线没有命中任何方块`;
      if (!hit.position.equals(ref.position)) {
        const blocker = b.blockAt(hit.position);
        return `${where} 被 ${blocker?.name ?? '未加载方块'} (${hit.position.x},${hit.position.y},${hit.position.z}) 挡住`;
      }
      // 斜穿/贴脸时把「要站到哪一侧」说具体，别只让 Agent 猜“靠近或侧移”。
      const faceName = face.y > 0.5 ? '顶面' : face.y < -0.5 ? '底面' : face.z < 0 ? '北面' : face.z > 0 ? '南面' : face.x > 0 ? '东面' : '西面';
      const stance = face.y > 0.5 ? '站到它旁边并俯视'
        : face.y < -0.5 ? '站到它下方仰视'
        : `退到它${face.z < 0 ? '北侧（z 更小）' : face.z > 0 ? '南侧（z 更大）' : face.x > 0 ? '东侧（x 更大）' : '西侧（x 更小）'}一格`;
      return `${where} 命中的不是请求的那一面（可能斜穿）；这一面是 ${faceName}，${stance}再试`;
    };
    const why = refs.slice(0, 2).map(explainFace).join('；');
    return {
      ok: false,
      reason: 'NO_REFERENCE',
      detail: refs.length
        ? `${at} 有 ${refs.length} 个相邻实心方块，但从当前眼睛位置到这些面的视线被挡或超出 4.4 格${why ? `：${why}` : ''}；调整站位（靠近或侧移）让目标面和相邻方块进入视野/交互距离再放`
        : `${at} 四周没有相邻实心方块（悬空），从当前站位没有可贴的面${isTreeSaplingItem(item.name) ? '；即使下面有土，也要先站到能看见目标格相邻面的位置' : ''}`,
      attemptedFaces,
    };
  }

  /**
   * 满桶（water_bucket / lava_bucket）往指定空气格倒流体：按物品使用语义（use_item）处理，服务器按视线确定落点，
   * 不能走 placeBlock 的 block_place 数据包（那条路径会让服务器拒绝，桶也倒不进去）。这里选一格紧贴目标空气格的
   * 实心方块面，把准星对准那一面再发 use_item，最后分别核对「桶是否被消耗」与「目标格是否出现水/岩浆」。
   * 失败时保留真实原因：周围没有实心面（NO_REFERENCE）、面都看不见/够不到（NO_PLACEMENT_FACE）、
   * 服务端没消耗桶且目标没变化（NO_EFFECT）、桶消耗了但目标格没出现流体（PLACEMENT_NOT_CONFIRMED，如下界蒸发）。
   */
  async useBucketAt(pos: Vec3Like, item: string, signal: AbortSignal): Promise<ActionResult & { placed?: Vec3Like }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    await this.interactionReady();
    check();
    const b = this.bot;
    if (!(await this.equipNamed(item, check))) return { ok: false, reason: `NO_ITEM:${item}` };
    const target = this.vec(pos);
    const fluidName = item === 'water_bucket' ? 'water' : 'lava';
    const cur = b.blockAt(target);
    if (cur && cur.boundingBox === 'block') return { ok: false, reason: `BLOCKED:(${target.x},${target.y},${target.z}) 不是空气，是 ${cur.name}` };
    const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
    const neighborFacts = faces.map((f) => {
      const p = target.plus(f);
      return `${p.x},${p.y},${p.z}=${b.blockAt(p)?.name ?? '未加载'}`;
    });
    const refs = faces.map((f) => ({ f, ref: b.blockAt(target.plus(f)) }))
      .filter((x) => x.ref && x.ref.boundingBox === 'block')
      .sort((x, y) => Number(OPENS_ON_CLICK.test(x.ref.name)) - Number(OPENS_ON_CLICK.test(y.ref.name)));
    if (!refs.length) {
      const facts = `目标格六邻：${neighborFacts.join('、')}`;
      return { ok: false, reason: `NO_REFERENCE:(${target.x},${target.y},${target.z}) 四周没有实心方块可贴面，倒不进去`, detail: `${facts}；倒流体需要紧贴实心块的空气格`, effectEvidence: { verified: true, changed: false, reasons: [facts] } };
    }
    const before = this.invCountOf(item), beforeEmpty = this.invCountOf('bucket');
    // 水桶命中未含水的可含水块时，会填入参照块自身；这不是本次指定的相邻空气格。
    // 保留“无 raycast 时拒绝”的旧契约：不能把看不见的面当成可点击。
    const canCheck = typeof b.world?.raycast === 'function';
    const checked = refs.map(({ f, ref }) => ({
      f, ref,
      clickable: canCheck && (item !== 'water_bucket' || ref.getProperties().waterlogged !== false) && this.canClickPlacementFace(ref, f.scaled(-1)),
    }));
    const face = checked.find((x) => x.clickable);
    if (!face) {
      const facts = checked
        .map(({ f, ref, clickable }) => `参照 (${ref.position.x},${ref.position.y},${ref.position.z}) ${ref.name} 的 [${-f.x},${-f.y},${-f.z}] 面${clickable ? '可点击' : '不可点击（被挡/超距/含水）'}`)
        .join('；');
      return { ok: false, reason: 'NO_PLACEMENT_FACE:没有确认可点击的目标面，未发送使用动作', detail: `${facts}${canCheck ? '' : '；raycast 不可用，无法确认面'}；换到这些面的另一侧或靠近再倒`, effectEvidence: { verified: true, changed: false, reasons: [facts, ...(canCheck ? [] : ['raycast 不可用'])] } };
    }
    const { f, ref } = face;
    const sneak = OPENS_ON_CLICK.test(ref.name);
    const epoch = this.actionEpoch;
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot;
    if (sneak) b.setControlState('sneak', true);
    try {
      await this.afterAction(() => b.lookAt(ref.position.offset(0.5 - f.x * 0.5, 0.5 - f.y * 0.5, 0.5 - f.z * 0.5), true), check);
      await this.afterAction(() => this.lookSynced(), check);
      if (!this.canClickPlacementFace(ref, f.scaled(-1), undefined, true)) return { ok: false, reason: 'NO_PLACEMENT_FACE:使用前实际视线已不能命中目标面，未发送使用动作' };
      await this.afterAction(async () => { b.activateItem(); await sleep(200, signal); b.deactivateItem(); }, check);
    } finally {
      // 只有仍属于本次动作时才松开潜行：被换主/打断后的迟到收尾不能清掉新任务的潜行。
      if (sneak && ownsControls()) b.setControlState('sneak', false);
    }
    const sourcePlaced = () => {
      const now = b.blockAt(target);
      return now?.name === fluidName && Number(now.getProperties().level) === 0;
    };
    // 背包和区块消息可按任意顺序到达。一次使用后在同一窗口等待完整证据，不因部分证据重发使用。
    await this.waitForInteraction(() => this.invCountOf(item) < before && this.invCountOf('bucket') > beforeEmpty && sourcePlaced(), check, 800);
    const consumed = before - this.invCountOf(item), emptyAdded = this.invCountOf('bucket') - beforeEmpty;
    const placed = sourcePlaced();
    const reasons = [
      ...(placed ? [`(${target.x},${target.y},${target.z}) 出现了 ${fluidName} 源`] : []),
      ...(consumed > 0 ? [`背包 ${item} 减少 ${consumed}`] : []),
      ...(emptyAdded > 0 ? [`背包 bucket 增加 ${emptyAdded}`] : []),
    ];
    const effectEvidence = { verified: true, changed: reasons.length > 0, reasons: reasons.length ? reasons : ['没有确认桶转换或目标源格变化'] };
    if (placed && consumed > 0 && emptyAdded > 0) {
      this.notePlaced({ x: target.x, y: target.y, z: target.z }, fluidName, 'confirmed');
      return { ok: true, placed: { x: target.x, y: target.y, z: target.z }, effectEvidence };
    }
    if (reasons.length) return { ok: false, reason: `PLACEMENT_NOT_CONFIRMED:没有同时确认 ${item}→bucket 和目标格出现 ${fluidName} 源`, effectEvidence };
    return { ok: false, reason: `NO_EFFECT:没有确认 ${item} 的容器转换或目标源格变化`, effectEvidence };
  }

  private canClickPlacementFace(reference: any, face: any, delta?: any, currentView = false) {
    const b = this.bot;
    if (!b.entity?.position?.offset) return false;
    const from = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
    const to = delta ? reference.position.plus(delta) : reference.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
    const direction = to.minus(from);
    const distance = direction.norm();
    if (distance > 4.4 || distance < 0.01) return false;
    if (typeof b.world?.raycast !== 'function') return true;
    const view = currentView ? new Vec3(-Math.sin(b.entity.yaw) * Math.cos(b.entity.pitch), Math.sin(b.entity.pitch), -Math.cos(b.entity.yaw) * Math.cos(b.entity.pitch)) : direction.normalize();
    const hit = b.world.raycast(from, view, distance + 0.05);
    if (!hit?.position || !hit.position.equals(reference.position)) return false;
    // 除了命中参照方块，还要确认命中「请求的那一面」。否则射线斜穿侧壁时，use_item 会把水倒进别的相邻格
    // （例如请求倒进石块上方，实际命中西侧，倒进旁边一格），桶照样被消耗、目标格却没有任何流体。
    if (delta) return true;
    const expected = face.y !== 0 ? (face.y > 0 ? 1 : 0) : face.z !== 0 ? (face.z > 0 ? 3 : 2) : (face.x > 0 ? 5 : 4);
    return hit.face === expected;
  }

  blockStateAt(pos: Vec3Like) {
    if (!this.ready) return null;
    const block = this.bot.blockAt(this.vec(pos));
    if (!block) return null;
    // 拿不到属性读取器就返回 null，而不是空回退：空 map 只对 stone/air 这类
    // 本就没有状态属性的方块是真实的完整状态，缺失读取器不能冒充完整状态。
    const properties = block.getProperties?.();
    if (!properties) return null;
    return { name: String(block.name), properties };
  }

  /**
   * 实际身体验收：当前眼睛是否真能看见目标方块的一个面（或放置目标格的一个参照面）。
   * 使用与 placeBlockAt 相同的 raycast/参照面规则；没有 raycast 能力时如实返回 false，
   * 不用方块名猜“应该看得见”。只由完成验收调用，不参与路线规划。
   */
  canInteractAt(pos: Vec3Like, opts: { facing?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down'; place?: boolean } = {}): boolean {
    const b = this.bot;
    if (!this.ready || !b?.entity?.position) return false;
    const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
    const wanted = opts.facing === undefined ? null : {
      north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0), up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0),
    }[opts.facing];
    const target = this.vec(pos);
    const from = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
    if (opts.place) {
      for (const f of faces) {
        if (wanted !== null && !f.equals(wanted)) continue;
        const ref = b.blockAt(target.plus(f));
        if (!ref || ref.boundingBox !== 'block') continue;
        if (this.canClickPlacementFace(ref, f.scaled(-1))) return true;
      }
      return false;
    }
    const here = b.blockAt(target);
    if (!here) return false;
    const center = target.offset(0.5, 0.5, 0.5);
    const distance = center.distanceTo(from);
    if (distance < 0.01 || distance > 4.25) return false;
    // 无碰撞方块（草、花、浆果丛等）没有可点击的面：只核对实际视线是否到达这一格之前没有遮挡。
    if (here.shapes?.length === 0 || here.boundingBox === 'empty') {
      if (typeof b.world?.raycast !== 'function') return false;
      const direction = center.minus(from);
      const hit = b.world.raycast(from, direction.normalize(), direction.norm() + 0.05);
      return !hit?.position || hit.position.equals(target) || hit.position.distanceTo(center) >= distance - 0.55;
    }
    if (typeof b.world?.raycast !== 'function') return false;
    for (const f of faces) {
      const point = target.offset(0.5 + f.x * 0.5, 0.5 + f.y * 0.5, 0.5 + f.z * 0.5);
      const direction = point.minus(from);
      const hit = b.world.raycast(from, direction.normalize(), direction.norm() + 0.05);
      if (hit?.position?.equals(target)) return true;
    }
    return false;
  }

  async placeBlockStateAt(pos: Vec3Like, name: string, properties: Record<string, string | number | boolean>, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const door = name.endsWith('_door'), stairs = name.endsWith('_stairs'), slab = name.endsWith('_slab'), bed = name.endsWith('_bed'), gate = name.endsWith('_fence_gate');
    if (!door && !stairs && !slab && !bed && !gate) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    const yaw: Record<string, number> = { north: 0, east: -Math.PI / 2, south: Math.PI, west: Math.PI / 2 };
    const facing = String(properties.facing);
    const directions: Record<string, Vec3Like> = { north: { x: 0, y: 0, z: -1 }, east: { x: 1, y: 0, z: 0 }, south: { x: 0, y: 0, z: 1 }, west: { x: -1, y: 0, z: 0 } };
    const matchesAt = (position: Vec3Like, required: Record<string, string | number | boolean>) => {
      const actual = this.blockStateAt(position);
      return actual?.name === name && Object.entries(required).every(([key, value]) => String(actual.properties[key]) === String(value));
    };
    let paired: { pos: Vec3Like; properties: Record<string, string | number | boolean> } | null = null;
    if (bed && facing in directions) paired = { pos: { x: pos.x + directions[facing].x, y: pos.y, z: pos.z + directions[facing].z }, properties: { facing, part: 'head', occupied: false } };
    if (door) paired = { pos: { ...pos, y: pos.y + 1 }, properties: { ...properties, half: 'upper' } };
    const matches = () => matchesAt(pos, properties) && (!paired || matchesAt(paired.pos, paired.properties));
    if (matches()) return { ok: true };
    if ((door || stairs || bed || gate) && !(facing in yaw) || typeof b._placeBlockWithOptions !== 'function') return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (String(properties.waterlogged ?? false) !== 'false') return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (door && (properties.half !== 'lower' || String(properties.open ?? false) !== 'false' || String(properties.powered ?? false) !== 'false')) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (stairs && (!['top', 'bottom'].includes(String(properties.half)) || String(properties.shape ?? 'straight') !== 'straight')) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (slab && !['top', 'bottom'].includes(String(properties.type))) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (bed && (properties.part !== 'foot' || String(properties.occupied ?? false) !== 'false')) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (gate && (String(properties.open ?? false) !== 'false' || String(properties.powered ?? false) !== 'false')) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    const item = this.invItem(name);
    if (!item) return { ok: false, reason: 'NO_ITEM' };
    const at = b.blockAt(this.vec(pos));
    const empty = (block: any) => !!block && ['air', 'cave_air', 'void_air'].includes(block.name);
    if (!empty(at) || paired && !empty(b.blockAt(this.vec(paired.pos)))) return { ok: false, reason: 'BLOCKED' };
    if (bed && paired) {
      if (![pos, paired.pos].every((position) => b.blockAt(this.vec({ ...position, y: position.y - 1 }))?.boundingBox === 'block')) return { ok: false, reason: 'NO_SUPPORT' };
    }
    const half = stairs ? String(properties.half) : slab ? String(properties.type) : 'bottom';
    // A clicked top face produces a bottom half, a clicked underside a top
    // half. On horizontal faces the cursor height chooses the requested half.
    const offsets: Vec3Like[] = door || bed || gate ? [{ x: 0, y: -1, z: 0 }] : [
      { x: 0, y: half === 'top' ? 1 : -1, z: 0 },
      { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
    ];
    const deltaFor = (offset: Vec3Like) => {
      const delta = this.vec({ x: 0.5 - offset.x * 0.5, y: offset.y === 0 ? half === 'top' ? 0.75 : 0.25 : 0.5 - offset.y * 0.5, z: 0.5 - offset.z * 0.5 });
      if (door && offset.y === -1 && (properties.hinge === 'left' || properties.hinge === 'right')) {
        const forward = directions[facing];
        const sign = properties.hinge === 'left' ? 1 : -1;
        // Pick a point on the requested side of the doorway rather than the
        // center tie. Neighbor blocks can still override hinge choice; verify.
        delta.x += forward.z * 0.25 * sign;
        delta.z -= forward.x * 0.25 * sign;
      }
      return delta;
    };
    const selectReference = () => offsets.map((offset) => ({ offset, block: b.blockAt(this.vec({ x: pos.x + offset.x, y: pos.y + offset.y, z: pos.z + offset.z })) })).find(({ block, offset }) => block?.boundingBox === 'block' && this.canClickPlacementFace(block, this.vec({ x: -offset.x, y: -offset.y, z: -offset.z }), deltaFor(offset)));
    let reference = selectReference();
    if (!reference && door) {
      // A doorway's lintel or side pillars can hide the hinge quarter even when
      // the generic centre-face goal is visible. Try only observed, supported
      // frontal landing cells, then recheck the exact real click point.
      const direction = directions[facing];
      for (const sign of [1, -1]) {
        const landing = this.vec({ x: pos.x + direction.x * 2 * sign, y: pos.y, z: pos.z + direction.z * 2 * sign });
        if (b.blockAt(landing.offset(0, -1, 0))?.boundingBox !== 'block' || !empty(b.blockAt(landing)) || !empty(b.blockAt(landing.offset(0, 1, 0)))) continue;
        await this.afterAction(() => this.moveTo({ kind: 'near', pos: { x: landing.x + 0.5, y: landing.y, z: landing.z + 0.5 }, range: 0.4 }, { signal, timeoutMs: 8000 }), check);
        reference = selectReference();
        if (reference) break;
      }
    }
    if (!reference) return { ok: false, reason: 'NO_REFERENCE' };
    const face = this.vec({ x: -reference.offset.x, y: -reference.offset.y, z: -reference.offset.z });
    const delta = deltaFor(reference.offset);
    await this.afterAction(() => b.equip(item, 'hand'), check);
    if (facing in yaw) {
      await this.afterAction(() => b.look(yaw[facing], 0, true), check);
      // force=true returns before Mineflayer's next physics update actually
      // sends the yaw packet. Placement must follow that packet on the wire.
      if (typeof b.waitForTicks === 'function') await this.afterAction(() => raceAbort(b.waitForTicks(1), signal, 2000, () => {}), check);
      else await this.afterAction(() => sleep(60, signal), check);
    }
    // 这里不再转头：方块朝向（楼梯/门/箱子）取决于上面按 facing 设好的 yaw，再看向参照面会改掉它。
    await this.afterAction(() => raceAbort(b._placeBlockWithOptions(reference.block, face, { forceLook: 'ignore', swingArm: 'right', half, delta }), signal, 5000, () => {}), check);
    // Paired block updates may arrive one packet after the foot/lower block.
    for (let retry = 0; paired && !matches() && retry < 5; retry++) await this.afterAction(() => sleep(50, signal), check);
    return matches() ? { ok: true } : { ok: false, reason: 'BLOCK_STATE_MISMATCH' };
  }

  inventorySlots(): InventorySlot[] {
    if (!this.ready) return [];
    const slots: (Item | null)[] = this.bot.inventory.slots ?? [];
    return slots.flatMap((item, slot) => {
      if (!item || slot < 5 || slot > 45) return [];
      const max = this.mcData.itemsByName?.[item.name]?.maxDurability;
      const enchants = this.itemEnchants(item);
      const stackSize = this.mcData.itemsByName?.[item.name]?.stackSize;
      return [{ slot, name: item.name, count: item.count, ...(stackSize ? { stackSize } : {}),
        ...(max ? { durability: { left: Math.max(0, max - (item.durabilityUsed ?? 0)), max } } : {}),
        ...(enchants ? { enchants } : {}),
        ...(item.customName ? { customName: item.customName } : {}),
        ...(item.nbt ? { nbt: simplify(item.nbt) } : {}) }];
    });
  }

  async equipItem(name: string | null, destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet', signal: AbortSignal, opts: { sourceSlot?: number; explicit?: boolean } = {}): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    await this.interactionReady();
    check();
    const b = this.bot;
    if (name === null) {
      if (destination === 'hand' && !b.heldItem) return { ok: true };
      const slot = b.getEquipmentDestSlot?.(destination);
      if (destination !== 'hand' && !b.inventory.slots?.[slot]) return { ok: true };
      // Mineflayer's equipEmpty drops the held stack when full. Emptying a hand
      // never authorizes that additional action.
      const empty = b.inventory.slots?.slice(9, 45).some((item: Item | null) => !item);
      if (!empty) return { ok: false, reason: 'INVENTORY_FULL' };
      return this.withObservedInventory(signal, async () => {
        await this.afterAction(() => b.unequip(destination), check);
        await this.syncInventory(check);
        const actual = destination === 'hand' ? b.heldItem : b.inventory.slots?.[slot];
        if (!actual) {
          if (destination === 'hand' && opts.explicit) this.noteHandChoice(null);
          return { ok: true };
        }
        return { ok: false, reason: 'UNEQUIP_NOT_CONFIRMED' };
      });
    }
    const item = opts.sourceSlot === undefined ? this.bestInvItem(name) : b.inventory.slots?.[opts.sourceSlot];
    if (!item) return { ok: false, reason: 'NO_ITEM' };
    if (item.name !== name) return { ok: false, reason: 'SOURCE_ITEM_CHANGED' };
    const identity = JSON.stringify([item.type, item.metadata, item.nbt ?? null]);
    return this.withObservedInventory(signal, async () => {
      await this.afterAction(() => this.bot.equip(item, destination), check);
      await this.syncInventory(check);
      const slot = this.bot.getEquipmentDestSlot?.(destination);
      const read = () => destination === 'hand' ? this.bot.heldItem : this.bot.inventory.slots?.[slot];
      let actual = read();
      // 服务器把物品移进装备槽的回包可能比本地窗口同步晚一拍。只在有「离开源槽」的
      // 证据时继续等，避免把明确回滚的装备（物品还在源槽）误判成成功；物品仍在源槽
      // 就立即按失败返回。
      const stillAtSource = () => {
        const held = this.bot.inventory.slots?.[item.slot];
        return !!held && held.name === name && JSON.stringify([held.type, held.metadata, held.nbt ?? null]) === identity;
      };
      if (actual?.name !== name && !stillAtSource()) {
        for (let i = 0; i < 6 && actual?.name !== name && !stillAtSource(); i++) {
          check();
          await this.afterAction(() => sleep(50, signal), check);
          await this.syncInventory(check);
          actual = read();
        }
      }
      if (destination === 'hand' && actual?.name === name && opts.explicit) this.noteHandChoice(name);
      return actual?.name === name && (opts.sourceSlot === undefined || JSON.stringify([actual.type, actual.metadata, actual.nbt ?? null]) === identity) ? { ok: true } : { ok: false, reason: 'EQUIP_NOT_CONFIRMED' };
    });
  }

  private itemEnchants(item: any): string[] | undefined {
    try {
      const list = item?.enchants;
      return Array.isArray(list) && list.length ? list.map((e: any) => `${e.name} ${e.lvl}`) : undefined;
    } catch { return undefined; }
  }

  private async syncInventory(check: ReturnType<MineflayerAdapter['actionCheckpoint']>, window = this.bot.inventory) {
    await this.afterAction(() => raceAbort(this.bot._syncWindow(window), check.signal, 3000, () => {}), check);
  }

  private guiView(w: any): GuiView {
    const type = String(w.type ?? '').replace(/^minecraft:/, '');
    const size = w.inventoryStart ?? Math.max(0, (w.slots?.length ?? 36) - 36);
    let roles = GUI_ROLES[type];
    if (type === 'smithing' && size === 3) roles = roles.slice(1);
    const slots: GuiSlot[] = [];
    for (let i = 0; i < (w.slots?.length ?? 0); i++) {
      const it = w.slots[i];
      const enchants = it ? this.itemEnchants(it) : undefined;
      slots.push({ slot: i, ...(i >= size ? { role: '背包' } : roles?.[i] ? { role: roles[i] } : {}), name: it?.name ?? null, count: it?.count ?? 0, ...(enchants ? { enchants } : {}), ...(it?.customName ? { customName: it.customName } : {}), ...(it?.nbt ? { nbt: simplify(it.nbt) } : {}) });
    }
    const ench = Array.isArray(w.enchantments) ? w.enchantments.map((e: any, option: number) => {
      const id = e?.expected?.enchant;
      const name = id != null && id >= 0 ? this.mcData.enchantments?.[id]?.name : undefined;
      return { option, level: e?.level ?? 0, ...(name ? { hint: `${name} ${e.expected.level}…` } : {}) };
    }).filter((e: any) => e.level > 0) : [];
    const cursor: Item | null = w.selectedItem ?? null;
    return { type, slots, inventoryStart: w.inventoryStart ?? size, cursor: cursor ? { slot: -1, name: cursor.name, count: cursor.count, ...(cursor.nbt ? { nbt: simplify(cursor.nbt) } : {}) } : null, ...(ench.length ? { enchantments: ench } : {}) };
  }

  /**
   * 通用界面：玩家打开一个方块界面后能做的事就是这几样——拿起一叠、放一个/全部、shift 点击取走、点按钮。
   * 不认得哪种工作站怎么用；怎么摆是 LLM 自己的事，这里只把格子里实际有什么如实给回去。
   */
  async useGui(target: GuiTarget, ops: GuiOp[], signal: AbortSignal, opts: { onContainer?: (observation: GuiContainerObservation) => void } = {}): Promise<GuiResult> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    const done: string[] = [];
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', done };
    await this.interactionReady();
    check();
    const b = this.bot;
    let open: () => Promise<unknown>;
    let storageBlock: string | undefined;
    if (target === 'inventory') open = async () => b.inventory;
    else if ('entityId' in target) {
      const entity = b.entities?.[target.entityId];
      if (!entity) return { ok: false, reason: 'ENTITY_GONE', done };
      if (/horse|donkey|mule|llama|camel/.test(entity.name ?? '')) {
        if (b.vehicle?.id !== target.entityId) return { ok: false, reason: 'MOUNT_REQUIRED', done };
        open = async () => {
          const pending = once(b, 'windowOpen', { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
          b._client.write('entity_action', { entityId: b.entity.id, actionId: 6, jumpBoost: 0 });
          const window = (await pending)[0];
          try { await sleep(this.cfg.ui?.openHoldMs ?? 0, signal); } catch (e) { try { b.closeWindow(window); } catch { /* ignore */ } throw e; }
          return window;
        };
      } else {
        if (entity.position.distanceTo(b.entity.position) > 4.5) await this.afterAction(() => this.moveTo({ kind: 'follow_entity', entityId: target.entityId, range: 3 }, { signal, timeoutMs: 20000 }), check);
        if (b.entities?.[target.entityId] !== entity || entity.position.distanceTo(b.entity.position) > 4.5) return { ok: false, reason: 'ENTITY_OUT_OF_REACH', done };
        open = () => b.openEntity(entity);
      }
    } else {
      const block = b.blockAt(this.vec(target));
      if (!block) return { ok: false, reason: 'UNLOADED', done };
      if (isLocalStorage(block.name)) storageBlock = block.name;
      await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: target }, { signal, timeoutMs: 20000, allowSwimming: false }), check);
      open = block.name === 'enchanting_table' && typeof b.openEnchantmentTable === 'function' ? () => b.openEnchantmentTable(block) : () => b.openBlock(block);
    }
    let w: any;
    try {
      w = await this.afterAction(() => raceAbort(open(), signal, 8000, () => {}), check);
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      return { ok: false, reason: 'NOT_OPENABLE', done };
    }
    if (!w) return { ok: false, reason: 'NOT_OPENABLE', done };
    const size = () => w.inventoryStart ?? Math.max(0, (w.slots?.length ?? 36) - 36);
    let container: GuiContainerObservation | undefined;
    const observeContainer = () => {
      if (!storageBlock) return;
      const slots = w.slots.slice(0, size()) as (Item | null)[];
      container = observeStorage(storageBlock, slots.filter((item): item is Item => item !== null), container, slots);
    };
    const finish = (result: ActionResult & { view?: GuiView }): GuiResult => ({ ...result, done, ...(container ? { container } : {}) });
    const click = async (slot: number, button: number, mode: number) => {
      await this.afterAction(() => b.clickWindow(slot, button, mode), check);
      // 1.20.1 clicks update the client prediction before acknowledgement.
      // The installed sync asks for authoritative slots and carried cursor.
      await this.afterAction(() => raceAbort(b._syncWindow(w), signal, 3000, () => {}).then((result) => { observeContainer(); return result; }), check);
    };
    // Open containers maintain their own player slots until Mineflayer closes them.
    const invCount = (name: string) => w.slots.slice(size()).filter((i: Item | null) => i?.name === name).reduce((n: number, i: Item) => n + i.count, 0);
    const settle = () => this.afterAction(() => sleep(250, signal), check);
    const paceButton = () => this.afterAction(() => sleep(this.cfg.ui?.pacingMs ?? 0, signal), check);
    this.inFlight++; // 界面开着的整个过程都算在忙，空闲巡检不要替它关窗
    try {
      if (target === 'inventory') {
        this.emit('inventory_open');
        await this.afterAction(() => sleep(this.cfg.ui?.openHoldMs ?? 0, signal), check);
      }
      await settle();
      observeContainer();
      for (const op of ops) {
        check();
        if ('put' in op) {
          const { item, slot } = op.put;
          if (slot < 0 || slot >= size()) return finish({ ok: false, reason: `BAD_SLOT:${slot}`, view: this.guiView(w) });
          const source = op.put.sourceSlot;
          const src = source === undefined ? w.slots.slice(size()).map((it: Item | null, k: number) => it && it.name === item ? { it, at: size() + k } : null).find((entry: { it: Item; at: number } | null) => entry !== null)
            : source >= size() && source < w.slots.length && w.slots[source]?.name === item ? { it: w.slots[source], at: source } : null;
          if (!src) return finish({ ok: false, reason: `NO_ITEM:${item}`, view: this.guiView(w) });
          const before = w.slots[slot]?.name === item ? w.slots[slot].count : 0;
          const want = Math.min(op.put.count ?? src.it.count, src.it.count);
          await click(src.at, 0, 0);
          if (want >= src.it.count) await click(slot, 0, 0);
          else for (let k = 0; k < want; k++) await click(slot, 1, 0);
          if (w.selectedItem || b.inventory.selectedItem) await click(src.at, 0, 0);
          await settle();
          const now = w.slots[slot]?.name === item ? w.slots[slot].count : 0;
          if (now <= before) return finish({ ok: false, reason: `PUT_REFUSED:${item}->${slot}`, view: this.guiView(w) });
          done.push(`第 ${slot} 格放入 ${item}×${now - before}`);
        } else if ('take' in op) {
          const { slot } = op.take;
          const it = w.slots[slot];
          if (slot < 0 || slot >= size()) return finish({ ok: false, reason: `BAD_SLOT:${slot}`, view: this.guiView(w) });
          if (!it) return finish({ ok: false, reason: `EMPTY_SLOT:${slot}`, view: this.guiView(w) });
          const before = invCount(it.name);
          await click(slot, 0, 1);
          await settle();
          const got = invCount(it.name) - before;
          if (got <= 0) return finish({ ok: false, reason: `TAKE_REFUSED:${it.name}（产物取不出：可能经验不够、背包满或配方不成立）`, view: this.guiView(w) });
          done.push(`从第 ${slot} 格取出 ${it.name}×${got}`);
        } else if ('button' in op) {
          // 附魔台：选项要等服务器把等级发过来才有（刚放进东西的那一下还没有），没准备好就点，服务器会悄悄不理
          const table = Array.isArray(w.enchantments);
          if (table) {
            const until = Date.now() + 1500;
            while (Date.now() < until && !(w.enchantments[op.button]?.level > 0)) await this.afterAction(() => sleep(100, signal), check);
          }
          const key = () => JSON.stringify((table ? w.slots.slice(0, 1) : w.slots.slice(0, size())).map((it: any) => it ? [it.name, it.count, this.itemEnchants(it) ?? null, it.nbt ?? null] : null));
          await paceButton();
          const before = key(), xpBefore = b.experience?.level ?? 0;
          b._client.write('enchant_item', { windowId: w.id, enchantment: op.button });
          const until = Date.now() + 1500;
          while (Date.now() < until && key() === before) await this.afterAction(() => sleep(100, signal), check);
          if (key() === before) {
            // 点了没反应：原样说出眼前的条件（要几级、身上几级、青金石几个），够不够、差什么由它自己看
            const need = table ? w.enchantments[op.button]?.level : undefined;
            const lapis = table ? (w.slots[1]?.name === 'lapis_lazuli' ? w.slots[1].count : 0) : undefined;
            const why = table ? `（这个选项需 ${need > 0 ? `${need} 级` : '——还没有选项（放进去的东西不能附魔，或者没放青金石）'}，身上 ${xpBefore} 级，台上青金石 ${lapis} 个；选项 ${op.button} 要 ${op.button + 1} 个青金石、扣 ${op.button + 1} 级）` : '';
            return finish({ ok: false, reason: `BUTTON_NO_EFFECT:点了按钮 ${op.button}，界面里什么都没变${why}`, view: this.guiView(w) });
          }
          const target = table ? w.slots[0] : null;
          const got = target ? this.itemEnchants(target) : undefined;
          if (table && !got?.length) return finish({ ok: false, reason: `ENCHANTMENT_NOT_CONFIRMED:点了按钮 ${op.button} 后目标物品变了，但未观察到附魔`, view: this.guiView(w) });
          done.push(table && got ? `附魔成功：${target.name} 得到 ${got.join('、')}（经验 ${xpBefore}→${b.experience?.level ?? '?'} 级）` : `点了按钮 ${op.button}，界面变了`);
        } else if ('rename' in op) {
          if (!/^(minecraft:)?anvil$/.test(String(w.type))) return finish({ ok: false, reason: 'RENAME_REQUIRES_ANVIL', view: this.guiView(w) });
          await paceButton();
          b._client.write('name_item', { name: op.rename });
          const accepted = () => [op.rename, JSON.stringify(op.rename), JSON.stringify({ text: op.rename })].includes(w.slots[2]?.customName);
          const confirmed = await this.waitForInteraction(accepted, check);
          if (!confirmed) return finish({ ok: false, reason: 'RENAME_NOT_CONFIRMED', view: this.guiView(w) });
          done.push(`改名预览已确认为「${op.rename}」；仍需取出产物才会完成改名`);
        } else if ('click' in op) {
          const { slot, button, mode } = op.click;
          if (slot !== -999 && (slot < 0 || slot >= w.slots.length)) return finish({ ok: false, reason: `BAD_SLOT:${slot}`, view: this.guiView(w) });
          const key = () => JSON.stringify([w.slots, w.selectedItem]);
          const before = key();
          await click(slot, button, mode);
          if (!(await this.waitForInteraction(() => key() !== before, check))) return finish({ ok: false, reason: 'CLICK_NOT_CONFIRMED', view: this.guiView(w) });
          done.push(`点击第 ${slot} 格（button=${button},mode=${mode}），已确认格子或光标变化`);
        } else if ('beacon' in op) {
          if (!/^(minecraft:)?beacon$/.test(String(w.type))) return finish({ ok: false, reason: 'NOT_BEACON', view: this.guiView(w) });
          const before = w.slots[0]?.count ?? 0;
          if (!before) return finish({ ok: false, reason: 'NO_BEACON_PAYMENT', view: this.guiView(w) });
          await paceButton();
          b._client.write('set_beacon_effect', { primary_effect: op.beacon.primary, secondary_effect: op.beacon.secondary });
          if (!(await this.waitForInteraction(() => (w.slots[0]?.count ?? 0) < before, check))) return finish({ ok: false, reason: 'BEACON_NOT_CONFIRMED', view: this.guiView(w) });
          done.push(`信标选择已提交，确认支付物品被消耗；效果是否作用于身体请检查状态`);
        }
      }
      return finish({ ok: true, view: this.guiView(w) });
    } finally {
      if (container) opts.onContainer?.(container);
      await this.uiCloseHold(signal);
      this.inFlight--;
      if (target === 'inventory') this.emit('inventory_close');
      else { try { b.closeWindow(w); } catch { /* ignore */ } }
      if (this.interactionDirty().some((d) => !d.startsWith('窗口'))) this.scheduleRepair('界面操作后残留', 150);
    }
  }

  async signText(pos: Vec3Like, signal: AbortSignal, opts: { lines?: string[]; back?: boolean } = {}): Promise<ActionResult & { lines?: string[] }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 15000 }), check);
    const block = b.blockAt(this.vec(pos));
    if (!block || !/_sign$/.test(block.name)) return { ok: false, reason: 'NOT_SIGN' };
    const read = (): string[] | undefined => {
      const current = b.blockAt(this.vec(pos));
      const text = current?.getSignText?.()[opts.back ? 1 : 0];
      return typeof text === 'string' ? text.split('\n') : undefined;
    };
    if (!opts.lines) {
      const lines = read();
      return lines ? { ok: true, lines } : { ok: false, reason: 'SIGN_TEXT_UNAVAILABLE' };
    }
    // Editing requires the server to open this sign's editor first. An ordinary
    // block use without that acknowledgement cannot authorize an update packet.
    const opened = new Promise<void>((resolve, reject) => {
      const editorSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
      const cleanup = () => { b.removeListener('signOpen', onOpen); editorSignal.removeEventListener('abort', onAbort); };
      const onOpen = (sign: { position?: Vec3Like }) => {
        if (!sign.position || sign.position.x !== pos.x || sign.position.y !== pos.y || sign.position.z !== pos.z) return;
        cleanup(); resolve();
      };
      const onAbort = () => { cleanup(); reject(editorSignal.reason); };
      b.on('signOpen', onOpen);
      editorSignal.addEventListener('abort', onAbort, { once: true });
    });
    await this.afterAction(() => Promise.all([opened, b.activateBlock(block)]).then(() => undefined), check);
    b.updateSign(block, opts.lines.join('\n'), opts.back === true);
    const expected = Array.from({ length: 4 }, (_, i) => opts.lines?.[i] ?? '');
    const matches = () => { const actual = read(); return !!actual && expected.every((line, i) => line === (actual[i] ?? '')); };
    if (!(await this.waitForInteraction(matches, check))) return { ok: false, reason: 'SIGN_NOT_CONFIRMED', lines: read() };
    return { ok: true, lines: read() };
  }

  async editBook(sourceSlot: number, pages: string[], signal: AbortSignal, title?: string): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    await this.interactionReady();
    check();
    const b = this.bot, book: Item | null = b.inventory.slots?.[sourceSlot];
    if (book?.name !== 'writable_book') return { ok: false, reason: 'SOURCE_ITEM_CHANGED' };
    const equipped = await this.equipItem('writable_book', 'hand', signal, { sourceSlot });
    if (!equipped.ok) return equipped;
    check();
    const slot = 36 + b.quickBarSlot;
    // The installed writeBook helper mutates its local NBT before sending.
    // Send the 1.20.1 edit directly so only server inventory updates prove it.
    b._client.write('edit_book', { hand: b.quickBarSlot, pages, title: title ?? null });
    const matches = () => {
      const actual: Item | null = b.inventory.slots?.[slot];
      if (!actual?.nbt || actual.name !== (title === undefined ? 'writable_book' : 'written_book')) return false;
      const nbt = simplify(actual.nbt) as { pages?: unknown; title?: unknown };
      const actualPages = nbt.pages;
      return Array.isArray(actualPages) && actualPages.length === pages.length
        && pages.every((page, i) => [page, JSON.stringify(page), JSON.stringify({ text: page })].includes(actualPages[i]))
        && (title === undefined || nbt.title === title);
    };
    return await this.waitForInteraction(matches, check) ? { ok: true } : { ok: false, reason: 'BOOK_NOT_CONFIRMED' };
  }

  private tradeViews(v: any): TradeView[] {
    const label = (it: any) => {
      if (!it) return '';
      const ench = this.itemEnchants(it) ?? (() => { try { return it.storedEnchants?.length ? it.storedEnchants.map((e: any) => `${e.name} ${e.lvl}`) : undefined; } catch { return undefined; } })();
      return `${it.name}×${it.count}${ench ? `（${ench.join('、')}）` : ''}`;
    };
    // 第一样要付的东西按现价算：村民会按需求涨价、按声望/治愈打折，交易表里的基础数量不是真正要付的
    const price = (t: any) => {
      const it = t.inputItem1;
      if (!it) return '';
      const real = Number.isFinite(t.realPrice) ? t.realPrice : it.count;
      return real === it.count ? label(it) : label({ ...it, name: it.name, count: real, nbt: it.nbt }) + `（原价 ${it.count}）`;
    };
    return (v.trades ?? []).map((t: any, index: number) => ({
      index,
      give: [price(t), t.hasItem2 === false ? null : t.inputItem2 ? label(t.inputItem2) : null].filter(Boolean) as string[],
      get: label(t.outputItem),
      uses: t.nbTradeUses ?? 0,
      maxUses: t.maximumNbTradeUses ?? 0,
      disabled: !!t.tradeDisabled,
    }));
  }

  /** 和村民/流浪商人交易：走到跟前右键打开交易界面，看交易表；给了 index 就按真实背包变化做几次 */
  async tradeWith(entityId: number, index: number | null, times: number, signal: AbortSignal): Promise<ActionResult & { trades: TradeView[]; traded: number }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', trades: [], traded: 0 };
    await this.interactionReady();
    check();
    const b = this.bot;
    const entity = b.entities?.[entityId];
    if (!entity?.isValid) return { ok: false, reason: 'TARGET_GONE', trades: [], traded: 0 };
    if (b.entity.position.distanceTo(entity.position) > 2.8) {
      await this.afterAction(() => this.moveTo({ kind: 'near', pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, range: 2 }, { signal, timeoutMs: 15000 }), check);
    }
    let v: any;
    try {
      // mineflayer 的 openVillager 只认 villager 实体类型；流浪商人打开的是同一种交易界面，借村民的类型号过一下它的检查
      const villagerType = this.mcData.entitiesByName?.villager?.id;
      const asVillager = entity.name === 'villager' || villagerType === undefined ? entity : Object.create(entity, { entityType: { value: villagerType } });
      v = await this.afterAction(() => raceAbort(b.openVillager(asVillager), signal, 8000, () => {}), check);
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      return { ok: false, reason: 'NO_TRADE_WINDOW（幼年村民、无业村民和傻子不交易）', trades: [], traded: 0 };
    }
    this.inFlight++;
    try {
      const trades = this.tradeViews(v);
      if (index === null) return { ok: true, trades, traded: 0 };
      const t = v.trades?.[index];
      if (!t) return { ok: false, reason: `NO_SUCH_TRADE:${index}`, trades, traded: 0 };
      if (t.tradeDisabled) return { ok: false, reason: 'TRADE_LOCKED（这条交易用完了，村民要回工作站补货）', trades, traded: 0 };
      // Mineflayer copies the player inventory from the merchant window back to
      // bot.inventory only when the window closes. Read the live window while
      // it is open, otherwise a completed trade can be reported as unconfirmed.
      const have = (it: any) => v.slots.slice(v.inventoryStart, v.inventoryEnd)
        .filter((i: any) => i?.type === it.type && i.metadata === it.metadata)
        .reduce((n: number, i: any) => n + i.count, 0);
      const out = t.outputItem;
      const cost = [{ it: t.inputItem1, n: Number.isFinite(t.realPrice) ? t.realPrice : t.inputItem1?.count }, ...(t.hasItem2 && t.inputItem2 ? [{ it: t.inputItem2, n: t.inputItem2.count }] : [])].filter((c) => c.it);
      const affordable = Math.min(...cost.map((c) => Math.floor(have(c.it) / Math.max(1, c.n))));
      const n = Math.min(times, affordable, Math.max(0, (t.maximumNbTradeUses ?? 99) - (t.nbTradeUses ?? 0)));
      if (n <= 0) return { ok: false, reason: `NOT_ENOUGH:${cost.map((c) => `${c.it.name}×${c.n}（有 ${have(c.it)}）`).join('+')}`, trades, traded: 0 };
      const before = have(out);
      await this.afterAction(() => b.trade(v, index, n), check);
      // Window clicks are predicted locally in 1.20.1. Ask the server for the
      // complete window state before treating the inventory delta as a trade.
      await this.afterAction(() => raceAbort(b._syncWindow(v), signal, 3000, () => {}), check);
      await this.afterAction(() => sleep(250, signal), check);
      const got = have(out) - before;
      return got > 0 ? { ok: true, trades: this.tradeViews(v), traded: Math.round(got / Math.max(1, out.count)) } : { ok: false, reason: 'TRADE_NOT_CONFIRMED', trades: this.tradeViews(v), traded: 0 };
    } finally {
      await this.uiCloseHold(signal);
      this.inFlight--;
      try { v.close?.() ?? b.closeWindow(v); } catch { /* ignore */ }
      if (this.interactionDirty().some((d) => !d.startsWith('窗口'))) this.scheduleRepair('交易后残留', 150);
    }
  }

  /** 扔出背包里的物品（Q 键）；可先转向某个位置，丢给村民/猪灵/队友或者清背包。按真实背包变化确认。 */
  async tossItem(name: string, count: number | null, signal: AbortSignal, face?: Vec3Like, opts: { gift?: boolean; sourceSlot?: number } = {}): Promise<ActionResult & { tossed: number }> {
    const checkpoint = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', tossed: 0 };
    await this.interactionReady();
    checkpoint();
    const b = this.bot;
    if (b.inventory.selectedItem || b.currentWindow?.selectedItem || b.currentWindow && opts.sourceSlot !== undefined) return { ok: false, reason: 'INVENTORY_NOT_READY', tossed: 0 };
    // An open container owns the authoritative player slots until it closes.
    // Its storage slots are never eligible for this inventory-only action.
    const window: Window = b.currentWindow ?? b.inventory;
    const check = Object.assign(() => {
      checkpoint();
      if ((b.currentWindow ?? b.inventory) !== window) throw new Error('TOSS_WINDOW_CHANGED');
    }, { signal });
    const total = () => (opts.sourceSlot === undefined ? window.items() : window.slots.slice(5, 46))
      .filter((item): item is Item => item?.name === name).reduce((n, item) => n + item.count, 0);
    const have = total();
    const item = opts.sourceSlot === undefined ? window.items().find((item) => item.name === name) : window.slots[opts.sourceSlot];
    if (!item || have <= 0) return { ok: false, reason: 'NO_ITEM', tossed: 0 };
    if (item.name !== name) return { ok: false, reason: 'SOURCE_ITEM_CHANGED', tossed: 0 };
    const available = opts.sourceSlot === undefined ? have : item.count;
    const want = count == null ? available : Math.min(count, available);
    const e = this.bot.entity;
    // 朝哪扔由调用的人定（toss_item 的 toward）；不指定就朝现在看的方向
    if (face) await this.afterAction(() => this.bot.lookAt(this.vec({ x: face.x, y: face.y + 1, z: face.z }), true), check);
    const yaw = e?.yaw ?? 0;
    // The selected inventory slots and their NBT determine what was asked to
    // be thrown. Prefer complete stacks only within the same identity quota.
    const identity = (stack: Item) => JSON.stringify([stack.type, stack.metadata, stack.nbt ?? null]);
    const stacks = opts.sourceSlot === undefined ? window.items().filter((stack) => stack.name === name) : [item];
    const quotas = new Map<string, number>();
    let remaining = want;
    for (const stack of stacks) {
      const take = Math.min(stack.count, remaining), key = identity(stack);
      if (take) quotas.set(key, (quotas.get(key) ?? 0) + take);
      remaining -= take;
      if (!remaining) break;
    }
    try {
      await this.withObservedInventory(signal, async () => {
        for (const [key, quota] of quotas) {
          let left = quota;
          while (left > 0) {
            check();
            const candidates = (opts.sourceSlot === undefined ? window.items() : [window.slots[opts.sourceSlot]])
              .filter((stack: Item | null): stack is Item => !!stack && stack.name === name && identity(stack) === key);
            const stack = candidates.filter((candidate) => candidate.count <= left).sort((a, c) => c.count - a.count)[0]
              ?? candidates.sort((a, c) => a.count - c.count)[0];
            if (!stack) throw new Error('SOURCE_ITEM_CHANGED');
            const take = Math.min(left, stack.count), slot = stack.slot;
            if (take === stack.count) {
              await this.afterAction(() => b.clickWindow(slot, 1, 4), check);
            } else {
              const half = Math.ceil(stack.count / 2);
              const wholeCost = 2 + stack.count - take, halfCost = take <= half ? 2 + half - take : Infinity;
              const split = take > 1;
              if (!split) {
                for (let n = 0; n < take; n++) await this.afterAction(() => b.clickWindow(slot, 0, 4), check);
              } else {
                const pickHalf = halfCost < wholeCost, picked = pickHalf ? half : stack.count;
                this.tossCursorReturn = { bot: b, window, slot, identity: key };
                await this.afterAction(() => b.clickWindow(slot, pickHalf ? 1 : 0, 0), check);
                for (let n = picked - take; n > 0; n--) await this.afterAction(() => b.clickWindow(slot, 1, 0), check);
                await this.syncInventory(check, window);
                const cursor = window.selectedItem;
                if (!cursor || identity(cursor) !== key || cursor.count !== take) throw new Error('TOSS_STATE_CHANGED');
                await this.afterAction(() => b.clickWindow(-999, 0, 0), check);
                await this.syncInventory(check, window);
                if (window.selectedItem) throw new Error('TOSS_STATE_CHANGED');
                this.tossCursorReturn = null;
              }
            }
            left -= take;
          }
        }
        await this.syncInventory(check, window);
      });
    } finally {
      if (this.tossCursorReturn) this.scheduleRepair('丢弃中断后归还光标', 250);
    }
    const tossed = have - total();
    // 记住扔掉了什么、大概落在哪（只是事实：哪些掉落物是自己刚扔的，被捡回来时能说清；不替它决定捡不捡）
    if (tossed > 0 && !opts.gift && e?.position) {
      const land = face ?? { x: e.position.x - Math.sin(yaw) * 2, y: e.position.y, z: e.position.z - Math.cos(yaw) * 2 };
      this.markDiscarded(name, land);
    }
    return tossed > 0 ? { ok: true, tossed } : { ok: false, reason: 'TOSS_NOT_CONFIRMED', tossed: 0 };
  }

  /** 把物品放到快捷栏第 index 格（0-8）并选中它，相当于整理快捷栏后按数字键。 */
  async arrangeHotbar(name: string, index: number, signal: AbortSignal, opts: { sourceSlot?: number } = {}): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    if (!Number.isInteger(index) || index < 0 || index > 8) return { ok: false, reason: 'BAD_SLOT' };
    await this.interactionReady();
    check();
    const b = this.bot;
    const target = 36 + index;
    const item = opts.sourceSlot === undefined ? this.invItem(name) : b.inventory.slots?.[opts.sourceSlot];
    if (!item) return { ok: false, reason: 'NO_ITEM' };
    if (item.name !== name) return { ok: false, reason: 'SOURCE_ITEM_CHANGED' };
    const identity = JSON.stringify([item.type, item.metadata, item.nbt ?? null]);
    if (opts.sourceSlot !== undefined ? opts.sourceSlot !== target : b.inventory.slots?.[target]?.name !== name) {
      await this.withObservedInventory(signal, async () => {
        await this.afterAction(() => b.moveSlotItem(item.slot, target), check);
        await this.syncInventory(check);
      });
    }
    if (b.inventory.slots?.[target]?.name !== name) return { ok: false, reason: 'HOTBAR_NOT_CONFIRMED' };
    if (opts.sourceSlot !== undefined && JSON.stringify([b.inventory.slots[target].type, b.inventory.slots[target].metadata, b.inventory.slots[target].nbt ?? null]) !== identity) return { ok: false, reason: 'HOTBAR_NOT_CONFIRMED' };
    b.setQuickBarSlot(index);
    if (b.heldItem?.name !== name) return { ok: false, reason: 'HOTBAR_NOT_CONFIRMED' };
    this.noteHandChoice(name);
    return { ok: true };
  }

  /** 找一对可以合并的同名散叠：把 src 并进 dst（dst 有空间且非同一格），没有就返回 null。 */
  private nextStackMerge(item?: string): { src: number; dst: number } | null {
    const b = this.bot;
    const groups = new Map<string, { size: number; slots: { slot: number; count: number }[] }>();
    for (const it of (b.inventory.items() ?? []) as any[]) {
      const size = this.mcData.itemsByName?.[it.name]?.stackSize ?? 1;
      if (size <= 1 || it.slot < 9 || it.slot > 44) continue;
      if (item && it.name !== item) continue;
      const key = JSON.stringify([it.type, it.metadata, it.nbt ?? null]);
      const g = groups.get(key) ?? { size, slots: [] as { slot: number; count: number }[] };
      g.slots.push({ slot: it.slot, count: it.count });
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const partial = g.slots.filter((s) => s.count < g.size);
      if (partial.length < 2) continue;
      partial.sort((a, b) => a.count - b.count);
      return { src: partial[0].slot, dst: partial[partial.length - 1].slot };
    }
    return null;
  }

  /** 把背包和快捷栏里同名可堆叠物品的散叠两两合并到堆叠上限，腾出空槽。 */
  async mergeStacks(signal: AbortSignal, item?: string): Promise<ActionResult & { merged: number; freed: number }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', merged: 0, freed: 0 };
    if (typeof this.bot.clickWindow !== 'function') return { ok: false, reason: 'NO_CLICK', merged: 0, freed: 0 };
    await this.interactionReady();
    check();
    const b = this.bot;
    const occupied = () => (b.inventory.items() as any[]).filter((it) => it.slot >= 9 && it.slot <= 44).length;
    const before = occupied();
    let merged = 0;
    await this.withObservedInventory(signal, async () => {
      for (let guard = 0; guard < 256; guard++) {
        const pair = this.nextStackMerge(item);
        if (!pair) break;
        // 左键 src 拿起 → 左键 dst 并入（dst 满则多余留在光标）→ 左键 src 把多余放回已掏空的源格
        await this.afterAction(() => b.clickWindow(pair.src, 0, 0), check);
        await this.afterAction(() => b.clickWindow(pair.dst, 0, 0), check);
        await this.afterAction(() => b.clickWindow(pair.src, 0, 0), check);
        merged++;
        await this.syncInventory(check);
      }
    });
    const freed = Math.max(0, before - occupied());
    return { ok: true, merged, freed };
  }

  async useBlockAt(pos: Vec3Like, item: string, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const block = b.blockAt(this.vec(pos));
    if (!block) return { ok: false, reason: 'UNLOADED' };
    const held = item ? this.invItem(item) : null;
    if (item && !held) return { ok: false, reason: 'NO_ITEM' };
    // A nearby visible block does not need another pathfinding run. In a tight
    // doorway that run can stall before an otherwise reachable right-click.
    const eye = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
    const direction = block.position.offset(0.5, 0.5, 0.5).minus(eye);
    const distance = direction.norm();
    const hit = distance <= 4.4 && distance > 0 && b.world?.raycast?.(eye, direction.normalize(), distance + 0.05, (candidate: any, ray: any) =>
      candidate.position.equals(block.position) || !!ray.intersect(candidate.shapes, candidate.position));
    if (!hit?.position?.equals(block.position)) {
      await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 15000, ...(item === '' ? { allowSwimming: false } : {}) }), check);
    }
    const current = b.blockAt(this.vec(pos));
    if (!current || current.name !== block.name) return { ok: false, reason: 'TARGET_CHANGED' };
    if (held) return this.afterAction(() => this.useItemOn(item, { kind: 'block', pos }, signal), check);
    if (b.heldItem) {
      if (typeof b.unequip !== 'function' || b.inventory.emptySlotCount?.() === 0) return { ok: false, reason: 'NO_EMPTY_HAND' };
      await this.afterAction(() => b.unequip('hand'), check);
    }
    const changed = this.blockInteractionChange(current);
    const beforeOpen = current.getProperties?.().open;
    const toggled = () => {
      const after = b.blockAt(this.vec(pos));
      const open = after?.getProperties?.().open;
      return after?.name === current.name && open !== undefined && String(open) !== String(beforeOpen);
    };
    await this.afterAction(() => raceAbort(b.activateBlock(current), signal, 3000, () => {}), check);
    const confirmed = await this.waitForInteraction(beforeOpen === undefined ? changed : toggled, check);
    return confirmed ? { ok: true, effectEvidence: { verified: true, changed: true, reasons: beforeOpen === undefined ? changed.reasons() : [`${current.name} 的 open 从 ${beforeOpen} 变为 ${b.blockAt(this.vec(pos))?.getProperties?.().open}`] } }
      : { ok: false, reason: beforeOpen === undefined ? 'NO_EFFECT:方块和背包均未变化' : 'DOOR_STATE_UNCHANGED:门的开关状态没有变化', effectEvidence: { verified: true, changed: false, reasons: ['右键后没有确认目标状态变化'] } };
  }

  /** Sending a right-click packet is not evidence that the server accepted it. */
  private async waitForInteraction(confirmed: () => boolean, check: (() => void) & { signal?: AbortSignal }, timeoutMs = 1200) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      check();
      if (confirmed()) return true;
      if (Date.now() >= deadline) return false;
      await this.afterAction(() => sleep(Math.min(50, deadline - Date.now()), check.signal), check);
    }
  }

  private blockInteractionChange(block: any) {
    const b = this.bot, window = b.currentWindow;
    const cells = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([x, y, z]) => block.position.offset(x, y, z));
    // 原样说出变了什么（哪格从什么变成什么、背包哪样多了少了）：桶空了却没出现水（下界会蒸发）这种事，要它自己看得出来
    const snap = () => cells.map((pos) => { const at = b.blockAt(pos); return at ? { name: at.name as string, key: JSON.stringify([at.name, at.stateId, at.getProperties?.()]) } : null; });
    const inventory = () => {
      const counts = new Map<string, number>();
      for (const item of b.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
      return counts;
    };
    const beforeBlocks = snap(), beforeInventory = inventory(), beforeDamage = b.heldItem?.durabilityUsed;
    const blockDiff = () => {
      const now = snap();
      return now.flatMap((at, i) => {
        const was = beforeBlocks[i];
        if ((at?.key ?? null) === (was?.key ?? null)) return [];
        const p = cells[i];
        return [`(${p.x},${p.y},${p.z}) ${was?.name ?? '?'}${was?.name === at?.name ? ' 状态变了' : `→${at?.name ?? '?'}`}`];
      });
    };
    const inventoryDiff = () => {
      const now = inventory(), names = new Set([...now.keys(), ...beforeInventory.keys()]);
      return [...names].sort().flatMap((n) => { const d = (now.get(n) ?? 0) - (beforeInventory.get(n) ?? 0); return d ? [`${n} ${d > 0 ? '+' : ''}${d}`] : []; });
    };
    const reasons = () => {
      const blocks = blockDiff(), items = inventoryDiff();
      return [
        ...(blocks.length ? [`方块变了：${blocks.slice(0, 4).join('、')}`] : []),
        ...(items.length ? [`背包：${items.slice(0, 6).join('、')}${blocks.length ? '' : '（周围方块没变）'}`] : []),
        ...(b.heldItem?.durabilityUsed !== beforeDamage ? ['手持工具耐久改变'] : []),
        ...(b.currentWindow && b.currentWindow !== window ? ['服务器打开了交互窗口'] : []),
      ];
    };
    // 失败时也要说清点的是哪一格、周围现在是什么；这不是推断，是观察。
    const names = () => cells.map((pos) => {
      const at = b.blockAt(pos);
      return `(${pos.x},${pos.y},${pos.z})=${at?.name ?? '未知'}`;
    });
    return Object.assign(() => reasons().length > 0, { reasons, names });
  }

  async useItem(item: string, signal: AbortSignal, opts: UseItemOptions = {}): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const held = this.invItem(item);
    if (!held) return { ok: false, reason: 'NO_ITEM' };
    await this.afterAction(() => b.equip(held, 'hand'), check);
    if (opts.aim) {
      if (![opts.aim.x, opts.aim.y, opts.aim.z].every(Number.isFinite)) return { ok: false, reason: 'BAD_AIM' };
      const point = this.vec(opts.aim), from = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0), vector = point.minus(from), distance = vector.norm();
      if (distance < 0.01 || distance > 64) return { ok: false, reason: 'OUT_OF_RANGE' };
      const direction = vector.normalize();
      for (let step = 0; step <= distance; step += 0.5) if (!b.blockAt(from.plus(direction.scaled(step)))) return { ok: false, reason: 'NOT_LOADED' };
      const hit = b.world?.raycast?.(from, direction, distance);
      if (hit?.position && !hit.position.equals(point.floored())) return { ok: false, reason: 'BLOCKED_AIM' };
      // Mineflayer's smooth-look promise follows yaw only, so a steep pitch can
      // still be in flight. Force both axes and wait for their physics packet.
      await this.afterAction(() => b.lookAt(point, true), check);
      if (typeof b.waitForTicks === 'function') await this.afterAction(() => raceAbort(b.waitForTicks(1), signal, 2000, () => {}), check);
      else await this.afterAction(() => sleep(60, signal), check);
    }
    this.actionContext.run(check, () => b.activateItem());
    if (opts.chargeMs) {
      await this.afterAction(() => sleep(Math.max(0, Math.min(3000, opts.chargeMs!)), signal), check);
      this.actionContext.run(check, () => b.deactivateItem());
    }
    return { ok: true };
  }

  async rangedAttack(entityId: number, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const target = b.entities[entityId];
    if (!target?.isValid) return { ok: false, reason: 'ENTITY_GONE' };
    const bow = this.invItem('bow');
    if (!bow || !b.inventory.items().some((i: any) => ['arrow', 'spectral_arrow', 'tipped_arrow'].includes(i.name))) return { ok: false, reason: 'NO_BOW_OR_ARROWS' };
    await this.afterAction(() => b.equip(bow, 'hand'), check);
    if (b.entity.position.distanceTo(target.position) > 48) return { ok: false, reason: 'OUT_OF_RANGE' };
    // Approximate full-draw flight and gravity locally. Read the entity again
    // after charging, so a moving target is not aimed at its old draw-start pose.
    const aim = () => {
      if (target.name === 'end_crystal') {
        const camera = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
        const shot = crystalArrowShot(camera.offset(0, -0.1, 0), target.position, target.height ?? 2, (from, to) => {
          if (typeof b.world?.raycast !== 'function') return true;
          const delta = this.vec(to).minus(this.vec(from)), length = delta.norm();
          return length < 1e-8 || !b.world.raycast(this.vec(from), delta.scaled(1 / length), length);
        });
        return shot ? camera.offset(shot.direction.x * 16, shot.direction.y * 16, shot.direction.z * 16) : null;
      }
      const ticks = b.entity.position.distanceTo(target.position) / 3;
      const velocity = target.velocity ?? { x: 0, y: 0, z: 0 };
      return target.position.offset(velocity.x * ticks, (target.height ?? 1.6) * 0.5 + 0.025 * ticks * ticks + velocity.y * ticks, velocity.z * ticks);
    };
    const firstAim = aim();
    if (!firstAim) return { ok: false, reason: 'BLOCKED_AIM' };
    await this.afterAction(() => b.lookAt(firstAim, true), check);
    this.actionContext.run(check, () => b.activateItem());
    await this.afterAction(() => sleep(1100, signal), check);
    if (!target.isValid) { this.cancelItemUse(b); return { ok: false, reason: 'ENTITY_GONE' }; }
    if (b.entity.position.distanceTo(target.position) > 48) { this.cancelItemUse(b); return { ok: false, reason: 'OUT_OF_RANGE' }; }
    const currentAim = aim();
    if (!currentAim) {
      // Changing slots cancels a drawn bow without firing into a newly blocked
      // path. A normal release here would spend an arrow despite the failure.
      check(); this.cancelItemUse(b);
      return { ok: false, reason: 'BLOCKED_AIM' };
    }
    await this.afterAction(() => b.lookAt(currentAim, true), check);
    if (typeof b.waitForTicks === 'function') await this.afterAction(() => raceAbort(b.waitForTicks(1), signal, 2000, () => {}), check);
    else await this.afterAction(() => sleep(60, signal), check);
    this.actionContext.run(check, () => b.deactivateItem());
    return { ok: true };
  }

  /** 门外安全站位（格中心）：给旅行记录和“回门厅”导航用，避免把门方块本身当落脚点。 */
  portalStance(pos: Vec3Like): Vec3Like | null {
    return computePortalStance((p) => this.blockAt(p), pos);
  }

  /** 身体是否压着门方块。传送触发看身体 AABB，不只看脚格；门边缘 0.01 格的重叠也可能触发。 */
  private bodyInPortal(kind?: string): boolean {
    const p = this.bot?.entity?.position;
    return !!p && bodyOverlapsPortal((q) => this.blockAt(q), p, kind ? [kind] : undefined);
  }

  /** 身体 AABB 此刻压着的门方块名；null = 当前没有确认压着门方块（也涵盖读不到方块的情况）。 */
  private bodyPortalKind(): string | null {
    const p = this.bot?.entity?.position;
    // 部分测试夹具只给 state() 需要的字段（没有 bot.blockAt）：读不到方块时按未知返回 null。
    if (!p || typeof this.bot?.blockAt !== 'function') return null;
    return [...PORTAL_KINDS].find((kind) => bodyOverlapsPortal((q) => this.blockAt(q), p, [kind])) ?? null;
  }

  /**
   * 从门方块里走出来。门方块不参与寻路，站/躺在门里 moveTo 起步不了，只能 drive 直接朝门外走。
   * 如实返回身体是否离开、过程中是否已经换维度或中断、以及有没有可站的门外交接格；
   * 没有门外可站格时 noExit=true，由上层决定继续等传送还是交回心智，不在门里硬推。
   */
  private async driveOutOfPortal(kind: string, signal: AbortSignal, timeoutMs = 4000, fromDim?: string): Promise<{ left: boolean; dimChanged: boolean; interrupted: boolean; noExit: boolean }> {
    const deadline = Date.now() + timeoutMs;
    // 不只是“离开门方块”：走到门外可站位的格心再停，并让身体面朝离开门的方向。
    // 否则普通的前进动作会从门口原地再次踩回门里，维度行程看起来像自己取消。
    let out: Vec3Like | null = null;
    let portalCenter: Vec3Like | null = null;
    let last = this.bot?.entity?.position?.clone?.() ?? null;
    let still = 0;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (!this.ready) return { left: false, dimChanged: false, interrupted: true, noExit: false };
      const probe = this.transitionProbe();
      if (!probe.connected || !probe.alive) return { left: false, dimChanged: false, interrupted: true, noExit: false };
      // 退出门的过程中已经传送：别再按旧维度的格走，交给落地等待验收。
      if (fromDim && probe.dim !== fromDim) return { left: false, dimChanged: true, interrupted: false, noExit: false };
      const p = this.bot.entity.position;
      const inside = this.bodyInPortal(kind);
      if (!inside && out && Math.hypot(p.x - out.x, p.z - out.z) <= 0.45) break;
      if (last && !inside && out && Math.hypot(p.x - last.x, p.z - last.z) < 0.01) {
        if (++still >= 4) break;
      } else still = 0;
      last = p.clone();
      if (inside || out === null) {
        const feet = p.floored();
        const near = [
          feet,
          ...[1, -1].flatMap((d) => [{ x: feet.x + d, y: feet.y, z: feet.z }, { x: feet.x + d, y: feet.y + 1, z: feet.z }]),
          ...[1, -1].flatMap((d) => [{ x: feet.x, y: feet.y, z: feet.z + d }, { x: feet.x, y: feet.y + 1, z: feet.z + d }]),
        ];
        const portalBlock = near.find((cell) => this.blockAt(cell) === kind);
        const approach = portalBlock ? computePortalApproach((q) => this.blockAt(q), portalBlock) : null;
        if (!approach) {
          if (inside) return { left: false, dimChanged: false, interrupted: false, noExit: true };
          break;
        }
        portalCenter = portalBlock ? { x: portalBlock.x + 0.5, y: portalBlock.y + 0.5, z: portalBlock.z + 0.5 } : portalCenter;
        out = { x: approach.cell.x + 0.5, y: approach.cell.y + 1.0, z: approach.cell.z + 0.5 };
      }
      await this.drive({ forward: true }, 150, signal, { facePoint: out });
    }
    const left = !this.bodyInPortal(kind);
    // 站稳后朝远离门的方向：普通前进（press_keys forward）不会立刻又踩回门里。
    if (left && portalCenter && typeof this.bot?.look === 'function') {
      const p = this.bot.entity.position;
      const yaw = Math.atan2(-(p.x - portalCenter.x), -(p.z - portalCenter.z));
      try { await this.bot.look(yaw, 0, true); } catch { /* 转身只是收尾，不改变已到达的事实 */ }
    }
    return { left, dimChanged: false, interrupted: false, noExit: false };
  }

  /** 传送循环专用轻量探针：只取维度/会话/存活/观测就绪，跳过全量背包与 structuredClone，避免饿死心跳 */
  private transitionProbe() {
    const b = this.bot;
    if (!this.ready || !b) return { connected: false, alive: false, dim: 'unknown', sessionId: this.sessionId, observationReady: false };
    const dim = this.currentDimension();
    const alive = (b.health ?? 0) > 0;
    let chunkReady = false;
    try { chunkReady = !!b.blockAt(b.entity.position); } catch { /* ignore */ }
    return { connected: true, alive, dim, sessionId: this.sessionId, observationReady: this.spawned && chunkReady && alive && dim !== 'unknown' };
  }

  async enterPortalAt(pos: Vec3Like, signal: AbortSignal, expectedDim?: string): Promise<ActionResult & { from?: AgentState; to?: AgentState; stand?: AgentState; leftPortal?: boolean; transition?: PortalTransitionFacts }> {
    const check = this.actionCheckpoint(signal);
    const from = this.state();
    if (!from.observationReady) return { ok: false, reason: 'NOT_CONNECTED' };
    const name = this.blockAt(pos);
    if (name !== 'nether_portal' && name !== 'end_portal') return { ok: false, reason: 'NO_PORTAL' };
    // 下界门：走到门面正前那个可站立的格再面向门洞中心走入；别对着不可站立的门块寻路
    // （传送门方块不参与普通步行节点，精确站位无法当作可达落点）。
    // 末地门：横铺一层、脚下常是岩浆/虚空，退回「走到门附近再短促前进」，让身体落进门格。
    const approach = computePortalApproach((p) => this.blockAt(p), pos);
    // 如实记录身体到底经历了什么：开始时是否已在门里、退出去多久、在门里连续待了多久。
    // 这些是判断“要不要先出门”的依据，不能只回一个超时码让心智去猜。
    const startedAt = Date.now();
    const startedInPortal = this.bodyInPortal(name);
    let firstExitAt: number | null = null;   // 第一次退出门方块（exitMs 用）
    let lastExitAt: number | null = null;    // 最近一次离开（outsideMs 用）
    let enteredAt: number | null = startedInPortal ? startedAt : null; // 本次连续停留的起点
    let everEntered = startedInPortal;       // 这次尝试里是否进过门（离开后仍保留）
    let inPortal = startedInPortal;          // 此刻是否在门方块里
    const markEntered = () => { if (enteredAt === null) enteredAt = Date.now(); inPortal = true; everEntered = true; };
    const markLeft = () => { if (inPortal) lastExitAt = Date.now(); inPortal = false; enteredAt = null; };
    const facts = (endDim: string): PortalTransitionFacts => ({
      startedInPortal,
      entered: everEntered,
      exitMs: firstExitAt === null ? null : firstExitAt - startedAt,
      // 最近一次离开门方块到重新进门的时间；中途在门里往返不并入
      outsideMs: lastExitAt !== null && enteredAt !== null && enteredAt >= lastExitAt ? enteredAt - lastExitAt : null,
      // 此刻是否仍连续待在门方块里；中途离开过就是 0，但 entered 保留“进过门”的事实
      insideMs: enteredAt !== null && inPortal ? Date.now() - enteredAt : 0,
      endDim,
    });
    const trace = (transition: PortalTransitionFacts) => {
      const p = this.bot?.entity?.position;
      this.bus.publish('portal_trace', 'P3', `穿门时间线：${transition.startedInPortal ? '开始就在门方块里' : '开始不在门里'}；${transition.entered ? '进入过门方块' : '没有进入门方块'}；退出门 ${transition.exitMs ?? '-'}ms；门外 ${transition.outsideMs ?? '-'}ms；门内连续 ${transition.insideMs}ms；维度 ${transition.endDim}`, {
        kind: name,
        portal: { x: pos.x, y: pos.y, z: pos.z },
        ...transition,
        ...(p ? { pos: { x: p.x, y: p.y, z: p.z } } : {}),
        ...(this.bot?.time?.age !== undefined ? { worldAgeTicks: this.bot.time.age } : {}),
      });
    };
    this.inPortalTransition = true;
    try {
      // 已经站在门方块里（重连出生在门旁、或刚穿过来）：先试着真正退出门，再重新踏入。
      // 门块不参与寻路，站在门里 moveTo 起步不了，只能 drive；没有门外可站格/退不出去时不硬推，
      // 继续走原来的接近+等待流程（站在门里等传送本身也可能成功），事实照实记录。
      if (startedInPortal && name === 'nether_portal') {
        const out = await this.driveOutOfPortal(name, signal, 5000, from.dim);
        if (out.interrupted) return { ok: false, reason: 'TRANSITION_INTERRUPTED' };
        if (out.dimChanged) {
          // 退出门途中已经传送：不再按旧维度的接近格走，直接交给下面的落地等待验收
        } else if (out.left) {
          firstExitAt = Date.now();
          lastExitAt = firstExitAt;
          inPortal = false;
          enteredAt = null; // 重新计时：只有真正重新进门才算一次新的连续停留
        }
      }
      // 退出门过程中已经换维度时，旧坐标的 approach 已经没有意义，跳过接近段直接等待落地。
      if (this.currentDimension() === from.dim) {
        if (approach) {
          // The approach cell can be a one-block step the route search refuses even
          // though the portal is within a couple of blocks. Do not abort the
          // portal action on a path failure: fall through to the short direct
          // drive toward the portal opening, which is what a player does.
          try {
            await this.moveTo({ kind: 'near', pos: approach.cell, range: 0.5 }, { signal, timeoutMs: 20000 });
          } catch (error) {
            if (signal.aborted || error instanceof AbortedError) throw error;
          }
          const stepDeadline = Date.now() + 12000;
          while (Date.now() < stepDeadline) {
            throwIfAborted(signal);
            const cur = this.transitionProbe();
            if (!cur.connected || !cur.alive) return { ok: false, reason: 'TRANSITION_INTERRUPTED' };
            // 已经换维度就不再按身体位置猜：交给落地等待；身体压上门方块才停止前进
            if (cur.dim !== from.dim) break;
            if (this.bodyInPortal(name)) { markEntered(); break; }
            await this.drive({ forward: true }, 350, signal, { facePoint: approach.center });
          }
        } else {
          // 没有可站立的接近格（门贴着崖/墙）：走到门附近再短促朝门洞中心冲，让身体落进门格
          await this.moveTo({ kind: 'near', pos, range: 1.5 }, { signal, timeoutMs: 20000 });
          const center = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 };
          const stepDeadline = Date.now() + 12000;
          while (Date.now() < stepDeadline) {
            throwIfAborted(signal);
            const cur = this.transitionProbe();
            if (!cur.connected || !cur.alive) return { ok: false, reason: 'TRANSITION_INTERRUPTED' };
            if (cur.dim !== from.dim) break;
            if (this.bodyInPortal(name)) { markEntered(); break; }
            await this.drive({ forward: true }, 350, signal, { facePoint: center });
          }
        }
      }
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        throwIfAborted(signal);
        const probe = this.transitionProbe();
        if (!probe.connected || !probe.alive) return { ok: false, reason: 'TRANSITION_INTERRUPTED' };
        if (probe.dim !== from.dim && probe.sessionId !== from.sessionId && probe.observationReady) {
          // 只在确认跨维度成功后取一次完整 state（给上层返回真实出生观察），平时只用轻量探针
          const to = this.state();
          const transition = facts(to.dim);
          if (expectedDim && to.dim !== expectedDim) {
            trace(transition);
            return { ok: false, reason: `WRONG_DIMENSION:${to.dim}`, from, to, transition };
          }
          // 到达后尽量把身体移出目的地门方块（只对能在门外找到可站格的下界门尝试）。
          // 移不出去不改变“已到达”的事实，把 leftPortal:false 如实交给上层；end_portal 不检查。
          if (name === 'nether_portal') {
            const out = await this.driveOutOfPortal(name, signal, 4000, to.dim);
            // 移出过程中又换了维度/断线：第一次到达的观察已不能代表当前状态，不记成功，交回心智重看。
            if (out.interrupted || out.dimChanged || this.transitionProbe().dim !== to.dim) {
              const after = { ...transition, endDim: this.transitionProbe().dim };
              trace(after);
              return { ok: false, reason: 'TRANSITION_INTERRUPTED', from, to, transition: after };
            }
            trace(transition);
            return { ok: true, from, to, stand: this.state(), leftPortal: out.left, transition };
          }
          trace(transition);
          return { ok: true, from, to, stand: this.state(), transition };
        }
        // No further world action is issued after the dimension changes. Loading
        // and the fresh spawn observation are the only evidence of arrival.
        if (probe.dim === from.dim) {
          // 等待期间身体可能被推离门面：inPortal 反映此刻是否仍连续待在门里，
          // enteredAt 保留“进过门”的历史，不再把一次脱离采样当成从没进过。
          if (this.bodyInPortal(name)) markEntered();
          else markLeft();
          check();
        }
        await sleep(200, signal);
      }
      const transition = facts(this.transitionProbe().dim);
      trace(transition);
      return { ok: false, reason: transition.entered ? 'PORTAL_TRANSITION_TIMEOUT' : 'PORTAL_NOT_ENTERED', transition };
    } finally {
      this.inPortalTransition = false;
    }
  }

  bossStatus() {
    const state = this.state();
    const death = this.dragonDeath;
    return { dragonDeath: death && death.worldId === state.worldId && death.dim === state.dim && death.sessionId === state.sessionId ? structuredClone(death) : null };
  }

  private invItem(name: string) {
    if (this.bot.heldItem?.name === name) return this.bot.heldItem;
    return this.bot.inventory.items().find((i: any) => i.name === name);
  }

  /** 同名里耐久最高的一件（不会磨损的东西就是第一件） */
  private bestInvItem(name: string) {
    const all = this.bot.inventory.items().filter((i: any) => i.name === name);
    return all.sort((a: any, c: any) => (a.durabilityUsed ?? 0) - (c.durabilityUsed ?? 0))[0];
  }

  private invCountOf(name: string): number {
    return this.bot.inventory.items().filter((i: any) => i.name === name).reduce((n: number, i: any) => n + i.count, 0);
  }

  async smelt(input: string, count: number, fuel: string, signal: AbortSignal, opts: SmeltOpts = {}): Promise<SmeltResult> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', made: 0 };
    await this.interactionReady();
    check();
    const b = this.bot;
    const inItem = this.invItem(input);
    const fuelItem = this.invItem(fuel);
    if (!inItem) return { ok: false, reason: `NO_INPUT:${input}`, made: 0 };
    if (!fuelItem) return { ok: false, reason: `NO_FUEL:${fuel}`, made: 0 };
    // 找熔炉：记得的 → 身边的 → 背包里的放下 → 现做一个（8 圆石）
    const furnaceIds = ['furnace', 'blast_furnace', 'smoker'].map((n) => this.mcData.blocksByName[n]?.id).filter((x: unknown) => x !== undefined);
    let block: any = null;
    if (opts.furnacePos && ['furnace'].includes(b.blockAt(this.vec(opts.furnacePos))?.name)) block = b.blockAt(this.vec(opts.furnacePos));
    block ??= b.findBlock({ matching: furnaceIds, maxDistance: 5 });
    if (!block) {
      if (!opts.prepare) return { ok: false, reason: 'NO_FURNACE', made: 0 };
      if (!this.invItem('furnace')) await this.afterAction(() => this.craft('furnace', 1, signal, { prepare: true }), check);
      if (!this.invItem('furnace')) return { ok: false, reason: 'NO_FURNACE', made: 0 };
      block = await this.placeNearby('furnace', false, signal, check);
      if (!block) return { ok: false, reason: 'NO_SPACE', made: 0 };
      this.bus.publish('place', 'P3', '放置了熔炉');
    }
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: block.position }, { signal, timeoutMs: 30000 }), check);
    const furnacePos = { x: block.position.x, y: block.position.y, z: block.position.z };
    const furnace: any = await this.afterAction(() => raceAbort(b.openFurnace(block), signal, 8000, () => {}), check);
    let made = 0;
    let outputName: string | undefined;
    let stopped: SmeltResult['stopped'];
    let returned = 0;
    const lit = () => { try { return b.blockAt(block.position)?.getProperties?.().lit === true; } catch { return false; } };
    const slot = (it: any) => (it && it.count > 0 ? { name: String(it.name), count: Number(it.count) } : null);
    const contents = () => ({ input: slot(furnace.inputItem()), output: slot(furnace.outputItem()), fuel: slot(furnace.fuelItem()) });
    const have = (name: string) => furnace.slots.slice(furnace.inventoryStart, furnace.inventoryEnd)
      .filter((item: Item | null) => item?.name === name).reduce((n: number, item: Item) => n + item.count, 0);
    const sync = () => this.afterAction(() => raceAbort(b._syncWindow(furnace), signal, 3000, () => {}), check);
    const fuels = [fuel, ...(opts.moreFuels ?? []).filter((f) => f !== fuel && f !== input)];
    // 燃料：一个能烧几件（原版燃烧时间 / 200 刻）
    const per = (f: string) => /coal_block/.test(f) ? 80 : /coal$|charcoal/.test(f) ? 8 : /_planks$|_log$|_wood$/.test(f) ? 1.5 : f === 'stick' ? 0.5 : 1;
    const addFuel = async (need: number) => {
      for (const f of fuels) {
        const it = this.invItem(f);
        if (!it) continue;
        const cur = furnace.fuelItem();
        if (cur && cur.name !== f) continue; // 燃料格里是别的燃料，同一格放不进
        // 按熔炉窗口里实际看得到的数量放（背包模型和窗口偶尔对不上，多放一个就会整个报错）
        const have = typeof furnace.count === 'function' ? furnace.count(it.type, null) : this.invCountOf(f);
        const k = Math.min(have, Math.max(1, Math.ceil(need / per(f))), 64 - (cur?.count ?? 0));
        if (k <= 0) continue;
        try {
          await this.afterAction(() => furnace.putFuel(it.type, null, k), check);
          return true;
        } catch (e) {
          if (e instanceof AbortedError) throw e;
          // 这一种放不进去：试下一种燃料
        }
      }
      return false;
    };
    let failure: unknown = null;
    const startedAt = Date.now();
    try {
      const n = Math.min(count, inItem.count, 64);
      if (!furnace.fuelItem()) await addFuel(n);
      await this.afterAction(() => furnace.putInput(inItem.type, null, n), check);
      const deadline = Date.now() + n * 11000 + 15000;
      // 判断有没有在往前走：原料在少、成品在多、进度条在动、火亮着，任何一样都算在烧
      let lastMove = Date.now(), lastProgress = furnace.progress, lastIn = furnace.inputItem()?.count ?? 0;
      while (made < n && Date.now() < deadline) {
        await this.afterAction(() => sleep(1000, signal), check);
        const out = furnace.outputItem();
        if (out && out.count > 0) {
          outputName = out.name;
          const before = have(out.name);
          await this.afterAction(() => furnace.takeOutput(), check);
          await sync();
          const taken = Math.max(0, have(out.name) - before);
          if (!taken) { stopped = 'stalled'; break; }
          made += taken;
          opts.onProgress?.(made);
          lastMove = Date.now();
        }
        const inNow = furnace.inputItem()?.count ?? 0;
        if (!inNow) break;
        if (inNow !== lastIn || furnace.progress !== lastProgress) { lastMove = Date.now(); lastIn = inNow; lastProgress = furnace.progress; }
        // 火灭了、燃料格空了，原料还在：燃料用完了。背包里还有燃料就补上，没有就别干等
        // （刚开工时熔炉还没把燃烧进度发过来、方块也还没亮：先等几秒再下结论）
        const burning = (furnace.fuel ?? 0) > 0 || lit() || (furnace.fuel === null && Date.now() - startedAt < 4000);
        if (!burning && !furnace.fuelItem()) {
          if (await addFuel(inNow)) { lastMove = Date.now(); continue; }
          stopped = 'out_of_fuel';
          break;
        }
        // 一件 10 秒；15 秒什么都没变就是卡住了（成品格堵着别的东西、放进去的烧不了……）
        if (Date.now() - lastMove > 15000) { stopped = 'stalled'; break; }
      }
      if (!stopped && made < n && furnace.inputItem()) stopped = 'deadline';
    } catch (e) {
      if (e instanceof AbortedError) {
        try { opts.onLeave?.({ pos: furnacePos, block: String(block.name), ...contents(), burning: lit() || (furnace.fuel ?? 0) > 0, why: 'interrupted' }); } catch { /* ignore */ }
        try { furnace.close(); } catch { /* ignore */ }
        throw e;
      }
      failure = e;
    }
    try {
      // 烧好的和没烧的都拿回来，按背包实际变化算（中途出错也要拿）
      if (furnace.outputItem()) {
        const o = furnace.outputItem(); outputName ??= o.name;
        const before = have(o.name);
        await this.afterAction(() => furnace.takeOutput().catch(() => {}), check);
        await sync();
        made += Math.max(0, have(o.name) - before);
      }
      if (furnace.inputItem()) {
        const before = have(input);
        await this.afterAction(() => furnace.takeInput().catch(() => {}), check);
        await sync();
        returned = Math.max(0, have(input) - before);
      }
    } finally {
      // 不管怎么离开（包括被打断），都把熔炉里还剩什么报出去：东西不会自己回到背包
      try { opts.onLeave?.({ pos: furnacePos, block: String(block.name), ...contents(), burning: lit() || (furnace.fuel ?? 0) > 0, ...(stopped ? { why: stopped } : {}) }); } catch { /* ignore */ }
      await this.uiCloseHold(signal);
      try { furnace.close(); } catch { /* ignore */ }
    }
    const left = contents();
    const base = { made, output: outputName, furnacePos, returned, ...(stopped ? { stopped } : {}), left };
    return made > 0 ? { ok: true, ...base } : { ok: false, reason: failure ? `ERROR:${String((failure as Error)?.message ?? failure).slice(0, 120)}` : stopped === 'out_of_fuel' ? 'OUT_OF_FUEL' : stopped === 'stalled' ? 'STALLED' : 'NOTHING_SMELTED', ...base };
  }

  /** 打开熔炉把烧好的、没烧的（可选连燃料）都取回背包；按背包实际变化算 */
  async emptyFurnace(pos: Vec3Like, signal: AbortSignal, opts: { fuel?: boolean } = {}): Promise<ActionResult & { taken: { name: string; count: number }[]; left: FurnaceSlots; burning: boolean }> {
    const check = this.actionCheckpoint(signal);
    const none = { taken: [], left: { input: null, output: null, fuel: null }, burning: false };
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', ...none };
    await this.interactionReady();
    const b = this.bot;
    const block = b.blockAt(this.vec(pos));
    if (!block || !/^(furnace|blast_furnace|smoker)$/.test(block.name)) return { ok: false, reason: `NOT_A_FURNACE:${block?.name ?? 'unloaded'}`, ...none };
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: block.position }, { signal, timeoutMs: 30000 }), check);
    const furnace: any = await this.afterAction(() => raceAbort(b.openFurnace(block), signal, 8000, () => {}), check);
    const slot = (it: any) => (it && it.count > 0 ? { name: String(it.name), count: Number(it.count) } : null);
    const have = (name: string) => furnace.slots.slice(furnace.inventoryStart, furnace.inventoryEnd)
      .filter((item: Item | null) => item?.name === name).reduce((n: number, item: Item) => n + item.count, 0);
    const taken: { name: string; count: number }[] = [];
    try {
      const grab = async (get: () => any, take: () => Promise<any>) => {
        const it = get();
        if (!it) return;
        const before = have(it.name);
        await this.afterAction(() => take().catch(() => {}), check);
        await this.afterAction(() => raceAbort(b._syncWindow(furnace), signal, 3000, () => {}), check);
        const got = have(it.name) - before;
        if (got > 0) taken.push({ name: it.name, count: got });
      };
      await grab(() => furnace.outputItem(), () => furnace.takeOutput());
      await grab(() => furnace.inputItem(), () => furnace.takeInput());
      if (opts.fuel) await grab(() => furnace.fuelItem(), () => furnace.takeFuel());
      const left = { input: slot(furnace.inputItem()), output: slot(furnace.outputItem()), fuel: slot(furnace.fuelItem()) };
      const burning = (furnace.fuel ?? 0) > 0;
      return { ok: true, taken, left, burning };
    } finally {
      await this.uiCloseHold(signal);
      try { furnace.close(); } catch { /* ignore */ }
    }
  }

  async useChest(pos: Vec3Like, deposits: InvItem[], withdraws: InvItem[], signal: AbortSignal, opts: { onContainer?: (observation: GuiContainerObservation) => void } = {}): Promise<ActionResult & { contents: InvItem[]; moved: number; container?: GuiContainerObservation }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', contents: [], moved: 0 };
    await this.interactionReady();
    check();
    const b = this.bot;
    const block = b.blockAt(this.vec(pos));
    // 那一片没加载（离得太远）：看不到那里是什么，不能当成“箱子没了”
    if (!block) return { ok: false, reason: 'UNLOADED', contents: [], moved: 0 };
    if (!isLocalStorage(block.name)) return { ok: false, reason: 'NO_CHEST', contents: [], moved: 0 };
    // 原版规则：箱子顶上压着实心不透明方块就开不了盖（木桶不受影响）。以前直接 openContainer 干等 8 秒超时，
    // 心智只看到 TIMEOUT，猜是“站不到旁边”，最后干脆把箱子挖了
    if (block.name === 'chest' || block.name === 'trapped_chest') {
      const up = b.blockAt(block.position.offset(0, 1, 0));
      if (up && up.boundingBox === 'block' && !up.transparent) return { ok: false, reason: `LID_BLOCKED:${up.name}`, contents: [], moved: 0 };
    }
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 30000 }), check);
    const chest: any = await this.afterAction(() => raceAbort(b.openContainer(block), signal, 8000, () => {}), check);
    let container: GuiContainerObservation | undefined;
    const synchronize = () => this.afterAction(() => raceAbort(b._syncWindow(chest), signal, 3000, () => {}).then((result) => {
      container = observeStorage(block.name, chest.containerItems() as Item[], container, chest.slots.slice(0, chest.inventoryStart) as (Item | null)[]);
      return result;
    }), check);
    try {
      await synchronize();
      for (const d of deposits) {
        check();
        const it = this.invItem(d.name);
        if (!it) continue;
        const have = b.inventory.items().filter((i: any) => i.name === d.name).reduce((a: number, i: any) => a + i.count, 0);
        if (have <= 0) continue;
        // 只存入箱子实际装得下的数量。mineflayer 的 deposit 会先把整叠捡到光标上，
        // 放不下时抛 'destination full'，光标上那叠就丢了（日志里“顺带用掉了 cobblestone×64”）。
        const stackSize = it.stackSize ?? this.mcData.itemsByName?.[it.name]?.stackSize ?? 64;
        let free = 0;
        for (let s = 0; s < chest.inventoryStart; s++) {
          const slot = chest.slots[s];
          if (!slot) free += stackSize;
          else if (slot.type === it.type && slot.count < stackSize) free += stackSize - slot.count;
        }
        const n = Math.min(d.count, have, free);
        if (n <= 0) continue; // 满了：一叠都放不进，避免捡起来再丢
        try { await this.afterAction(() => chest.deposit(it.type, null, n), check); } catch (e) {
          if (e instanceof AbortedError) throw e;
          // 意外失败（例如服务器端被占位）：把光标上剩下的东西放回背包，别丢了
          try { await this.afterAction(() => b.putSelectedItemRange(chest.inventoryStart, chest.inventoryEnd, chest, null), check); } catch { /* ignore */ }
        }
        await synchronize();
        check();
      }
      for (const w of withdraws) {
        check();
        const id = this.mcData.itemsByName[w.name]?.id;
        if (id === undefined) continue;
        const have = chest.containerItems().filter((i: any) => i.type === id).reduce((a: number, i: any) => a + i.count, 0);
        const n = Math.min(w.count, have);
        if (n > 0) {
          try { await this.afterAction(() => chest.withdraw(id, null, n), check); } catch (e) { if (e instanceof AbortedError) throw e; }
          await synchronize();
        }
        check();
      }
      return { ok: true, contents: container!.after, moved: [...container!.put, ...container!.took].reduce((sum, item) => sum + item.count, 0), container };
    } finally {
      if (container) opts.onContainer?.(container);
      await this.uiCloseHold(signal);
      try { chest.close(); } catch { /* ignore */ }
    }
  }

  async till(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const block = b.blockAt(this.vec(pos));
    if (!block) return { ok: false, reason: 'NO_BLOCK' };
    if (block.name === 'farmland') return { ok: true };
    if (!['dirt', 'grass_block', 'dirt_path', 'coarse_dirt'].includes(block.name)) return { ok: false, reason: `NOT_TILLABLE:${block.name}` };
    const above = b.blockAt(this.vec({ x: pos.x, y: pos.y + 1, z: pos.z }));
    if (above && above.boundingBox === 'block') return { ok: false, reason: 'BLOCKED' };
    if (above && ['short_grass', 'tall_grass', 'grass', 'fern'].includes(above.name)) await this.afterAction(() => raceAbort(b.dig(above, true), signal, 3000, () => {}), check);
    const hoe = b.inventory.items().find((i: any) => i.name.endsWith('_hoe'));
    if (!hoe) return { ok: false, reason: 'NO_HOE' };
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 15000 }), check);
    await this.afterAction(() => b.equip(hoe, 'hand'), check);
    await this.afterAction(() => raceAbort(b.activateBlock(block), signal, 3000, () => {}), check);
    await this.afterAction(() => sleep(150, signal), check);
    return b.blockAt(this.vec(pos))?.name === 'farmland' ? { ok: true } : { ok: false, reason: 'TILL_FAILED' };
  }

  async plant(pos: Vec3Like, seed: string, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const soil = b.blockAt(this.vec(pos));
    if (soil?.name !== 'farmland') return { ok: false, reason: 'NOT_FARMLAND' };
    const above = b.blockAt(this.vec({ x: pos.x, y: pos.y + 1, z: pos.z }));
    if (above && above.name !== 'air') return { ok: true }; // 已经种了
    const it = this.invItem(seed);
    if (!it) return { ok: false, reason: `NO_SEED:${seed}` };
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 15000 }), check);
    await this.afterAction(() => b.equip(it, 'hand'), check);
    await this.afterAction(() => raceAbort(b.activateBlock(soil), signal, 3000, () => {}), check);
    await this.afterAction(() => sleep(150, signal), check);
    const now = b.blockAt(this.vec({ x: pos.x, y: pos.y + 1, z: pos.z }));
    return now && now.name !== 'air' ? { ok: true } : { ok: false, reason: 'PLANT_FAILED' };
  }

  cropAge(pos: Vec3Like): { age: number; max: number } | null {
    if (!this.ready) return null;
    const blk = this.bot.blockAt(this.vec(pos));
    if (!blk) return null;
    const max = blk.name === 'beetroots' ? 3 : ['wheat', 'carrots', 'potatoes'].includes(blk.name) ? 7 : null;
    if (max === null) return null;
    const age = Number(blk.getProperties?.().age ?? blk.metadata ?? 0);
    return { age, max };
  }

  async sleepInBed(signal: AbortSignal, opts: { at?: Vec3Like } = {}): Promise<ActionResult & { bedPos?: Vec3Like }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    if (this.currentDimension() !== 'overworld') return { ok: false, reason: 'WRONG_DIMENSION' };
    const b = this.bot;
    const bedIds = Object.values<any>(this.mcData.blocksByName).filter((x) => x.name.endsWith('_bed')).map((x) => x.id);
    // findBlock 偶尔漏掉就在身边的床（日志里记得的床 1 格外，它却说附近没床）：再逐格看一遍
    const occupied = (blk: any) => { try { return blk?.getProperties?.().occupied === true; } catch { return false; } };
    // 村子里几张床挨着：指定了哪张就睡那张；否则先挑空着的，再挑近的
    const nearBed = (r: number) => {
      const c = b.entity.position.floored();
      const want = opts.at ? this.vec(opts.at) : null;
      const score = (blk: any) => (want ? blk.position.distanceTo(want) * 10 : 0) + (occupied(blk) ? 5 : 0) + blk.position.distanceTo(b.entity.position);
      let best: any = null;
      for (let dx = -r; dx <= r; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -r; dz <= r; dz++) {
        const blk = b.blockAt(c.offset(dx, dy, dz));
        if (blk && String(blk.name).endsWith('_bed') && (!best || score(blk) < score(best))) best = blk;
      }
      return best ?? b.findBlock({ matching: bedIds, maxDistance: r });
    };
    let bed = nearBed(4);
    if (!bed) {
      const bedItem = b.inventory.items().find((i: any) => i.name.endsWith('_bed'));
      if (!bedItem) return { ok: false, reason: 'NO_BED' };
      if (!this.findPlaceSpots(true, true).length) return { ok: false, reason: 'NO_SPACE' };
      await this.placeNearby(bedItem.name, true, signal, check);
      bed = nearBed(4);
      if (!bed) return { ok: false, reason: 'PLACE_FAILED' };
      this.bus.publish('place', 'P2', '放下了床');
    }
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: bed.position }, { signal, timeoutMs: 15000 }), check);
    // 原版里右键一张被村民睡着的床会把村民叫醒（BedBlock.kickVillagerOutOfBed），再右键就能自己睡；
    // mineflayer 的 sleep 看见 occupied 就直接报错，所以先像玩家一样点一下，等床空出来
    if (occupied(b.blockAt(bed.position))) {
      await this.afterAction(() => b.activateBlock(b.blockAt(bed.position)), check);
      for (let i = 0; i < 10 && occupied(b.blockAt(bed.position)); i++) await sleep(150, signal);
      if (occupied(b.blockAt(bed.position))) return { ok: false, reason: 'the bed is occupied (点了一下床，占着的人没有起来——可能是别的玩家)' };
      bed = b.blockAt(bed.position);
    }
    try {
      await this.afterAction(() => raceAbort(b.sleep(bed), signal, 5000, () => {}), check);
    } catch (e: any) {
      if (e?.name === 'AbortedError') throw e;
      return { ok: false, reason: String(e?.message ?? e) };
    }
    const bedPos = { x: bed.position.x, y: bed.position.y, z: bed.position.z };
    try {
      while (b.isSleeping) await this.afterAction(() => sleep(1000, signal), check);
    } catch (e: any) {
      throw e;
    }
    return { ok: true, bedPos };
  }

  private findPlaceSpots(requireHeadroom = true, bed = false): any[] {
    const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dead_bush', 'seagrass', 'tall_seagrass']);
    const b = this.bot;
    const base = b.entity.position.floored();
    const candidates: any[] = [];
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -3; dy <= 2; dy++) {
      if (dx === 0 && dz === 0) continue;
      const ref = b.blockAt(base.offset(dx, dy, dz));
      if (!ref || ref.boundingBox !== 'block' || PROTECTED_BLOCKS.includes(ref.name) || /_bed$|_door$|barrel|shulker_box/.test(ref.name)) continue;
      const above = b.blockAt(base.offset(dx, dy + 1, dz));
      const above2 = b.blockAt(base.offset(dx, dy + 2, dz));
      // 能放进去的格子：空气，也包括水和矮草、雪层这类一放方块就被顶掉的（人在水里也能把工作台放在水底）
      if (!(REPLACEABLE.has(above?.name) && (!requireHeadroom || REPLACEABLE.has(above2?.name)))) continue;
      if (bed) {
        // 床有两格：旁边至少要有一格同样能放的位置
        const roomy = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oz]) => {
          const g = b.blockAt(base.offset(dx + ox, dy, dz + oz)), a1 = b.blockAt(base.offset(dx + ox, dy + 1, dz + oz));
          return g?.boundingBox === 'block' && REPLACEABLE.has(a1?.name);
        });
        if (!roomy) continue;
      }
      candidates.push(ref);
    }
    const dist = (r: any) => r.position.distanceTo(b.entity.position);
    if (!bed) return candidates.sort((a, c) => dist(a) - dist(c)).slice(0, 12);
    // 床：像人一样放在有顶的地方（屋里、洞里），和脚下同一层，而不是随手放在屋顶或露天
    const covered = (r: any) => { for (let up = 2; up <= 5; up++) { const blk = b.blockAt(r.position.offset(0, up, 0)); if (blk && blk.boundingBox === 'block') return true; } return false; };
    const score = (r: any) => dist(r) + (covered(r) ? 0 : 6) + Math.abs(r.position.y + 1 - base.y) * 2;
    return candidates.sort((a, c) => score(a) - score(c)).slice(0, 12);
  }

  /**
   * 在身边找个地方把方块放下：先挑伸手就够得着、看得见那一面的位置直接放；都不行再走过去放。
   * 以前直接对着“最近的空位”发放置包，空位可能在 5、6 格外或被挡着，服务器默默不理，熔炉、床就放不下。
   */
  private async placeNearby(item: string, requireHeadroom: boolean, signal: AbortSignal, check: (() => void) & { signal?: AbortSignal }): Promise<any | null> {
    const b = this.bot, up = new Vec3(0, 1, 0);
    const spots = this.findPlaceSpots(requireHeadroom, /_bed$/.test(item));
    const ordered = [...spots.filter((r) => this.canClickPlacementFace(r, up)), ...spots.filter((r) => !this.canClickPlacementFace(r, up))].slice(0, 6);
    for (const ref of ordered) {
      const position = ref.position.offset(0, 1, 0);
      try {
        let placed = await this.afterAction(() => this.placeBlockAt(position, [item], signal), check);
        if (!placed.ok || b.blockAt(position)?.name !== item) {
          await this.afterAction(() => this.moveTo({ kind: 'place_block', pos: position }, { signal, timeoutMs: 8000 }), check);
          placed = await this.afterAction(() => this.placeBlockAt(position, [item], signal), check);
        }
        const observed = b.blockAt(position);
        if (placed.ok && observed?.name === item) return observed;
      } catch (error: any) { if (error?.name === 'AbortedError') throw error; check(); }
    }
    return null;
  }

  private findPlaceSpot(): any | null {
    return this.findPlaceSpots()[0] ?? null;
  }

  private invCount(id: number): number {
    return this.bot.inventory.items().filter((i: any) => i.type === id).reduce((n: number, i: any) => n + i.count, 0);
  }

  /** 这个物品是否只能在工作台上合成 */
  private needsTable(id: number, count = 1): boolean {
    const b = this.bot;
    // 只有“现在就能在背包 2×2 格里做出来”才不需要工作台。
    // 不能只看是否存在 2×2 配方：例如床有“染料+别色床”的 2×2 染色配方，但正常做床要 3×3（羊毛+木板）
    if (b.recipesFor(id, null, count, null)[0]) return false;
    return b.recipesAll(id, null, true).some((r: any) => r.requiresTable);
  }

  /**
   * 原版很多配方接受“任意木板”（床、箱子、工作台、木制工具…），minecraft-data 把它展开成“3 块同种木板”的多个变体，
   * 混着几种木板时一个变体都对不上。这里按背包里实际的木板拼一个等价配方（带木种名字的物品，如 oak_boat，仍要求同种木板）。
   */
  private mixedPlanksRecipe(id: number, count: number, table: any): any | null {
    const b = this.bot;
    const result = this.mcData.items[id]?.name ?? '';
    if (/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_/.test(result)) return null;
    const have = new Map<number, number>();
    for (const it of b.inventory.items()) have.set(it.type, (have.get(it.type) ?? 0) + it.count);
    const isPlank = (iid: number) => String(this.mcData.items[iid]?.name ?? '').endsWith('_planks');
    for (const r of b.recipesAll(id, null, table ?? true) as any[]) {
      if (!r.inShape) continue;
      const times = Math.max(1, Math.ceil(count / (r.result?.count ?? 1)));
      const cells: { y: number; x: number; id: number }[] = [];
      r.inShape.forEach((row: any[], y: number) => row.forEach((ing: any, x: number) => { if (ing && ing.id >= 0) cells.push({ y, x, id: ing.id }); }));
      const plankCells = cells.filter((c) => isPlank(c.id));
      if (!plankCells.length) continue;
      const others = new Map<number, number>();
      for (const c of cells) if (!isPlank(c.id)) others.set(c.id, (others.get(c.id) ?? 0) + times);
      if ([...others].some(([oid, n]) => (have.get(oid) ?? 0) < n)) continue;
      const pool = [...have].filter(([pid]) => isPlank(pid)).map(([pid, n]) => ({ pid, n: Math.floor(n / times) })).filter((p) => p.n > 0).sort((a, c) => c.n - a.n);
      if (pool.reduce((a, p) => a + p.n, 0) < plankCells.length) continue;
      const shape = r.inShape.map((row: any[]) => row.map((ing: any) => ing && ing.id >= 0 ? { ...ing } : ing));
      for (const c of plankCells) {
        const p = pool.find((q) => q.n > 0)!;
        p.n--;
        shape[c.y][c.x] = { ...shape[c.y][c.x], id: p.pid, metadata: null };
      }
      const delta = new Map<number, number>([[id, r.result?.count ?? 1]]);
      for (const row of shape) for (const ing of row) if (ing && ing.id >= 0) delta.set(ing.id, (delta.get(ing.id) ?? 0) - 1);
      return Object.assign(Object.create(Object.getPrototypeOf(r)), r, { inShape: shape, ingredients: null, delta: [...delta].map(([did, n]) => ({ id: did, metadata: null, count: n })) });
    }
    return null;
  }

  /** 失败时说清楚缺什么：在所有配方变体里找最接近的那个 */
  private missingReport(id: number, count: number, table: any): string {
    const b = this.bot;
    const name = (iid: number) => this.mcData.items[iid]?.name ?? String(iid);
    let best: { miss: { n: string; need: number; have: number }[]; total: number; table: boolean } | null = null;
    for (const r of b.recipesAll(id, null, true) as any[]) {
      const times = Math.max(1, Math.ceil(count / (r.result?.count ?? 1)));
      const miss = (r.delta ?? []).filter((d: any) => d.count < 0).map((d: any) => ({ n: name(d.id), need: -d.count * times, have: this.invCount(d.id) })).filter((m: any) => m.need > m.have);
      // “染料 + 别色的床 → 白床”这类改色配方需要先有一个同类成品；手上没有时它不是做出第一个的办法
      const family = (n: string) => n.replace(/^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_/, '');
      const recolor = miss.some((m: any) => m.n !== name(id) && family(m.n) === family(name(id)));
      const total = miss.reduce((a: number, m: any) => a + m.need - m.have, 0) + (recolor ? 1000 : 0);
      if (!best || total < best.total) best = { miss, total, table: !!r.requiresTable };
    }
    if (!best) return '没有已知配方';
    const planks = b.inventory.items().filter((i: any) => i.name.endsWith('_planks')).map((i: any) => `${i.name}×${i.count}`);
    const parts = best.miss.map((m) => `${m.n} 还差 ${m.need - m.have}（有 ${m.have}）`);
    if (best.table && !table) parts.push('需要工作台');
    return parts.length ? parts.join('，') + (planks.length && best.miss.some((m) => m.n.endsWith('_planks')) ? `；现有木板：${planks.join('、')}` : '')
      : '材料看起来够，但合成没有成功（可能是界面没响应），可以再试一次';
  }

  /** 合成 times 次；超时后先停止并核对真实库存，不能盲目重复扣料。 */
  /**
   * 一次合成一批：像玩家一样每个合成格放 times 个料，再 shift 点产物，服务器一口气合成到料用完。
   * 一批的上限由料决定：每格最多放一组（大多 64，鸡蛋/雪球 16，桶 1），背包放不下的产物服务器会停在那里。
   * 返回这一批实际做出了几次（按背包变化算）；仅无法执行批量操作时返回 null，由调用方退回逐个合成。
   */
  /**
   * 合成产物要进背包：按配方先扣掉材料（整叠用光的槽会空出来），再看产物能不能叠进已有的同类堆或空槽。
   * 放不下时 mineflayer 会一直等产物入包、20 秒后才报 “updateSlot:0 did not fire”，回执只像界面卡了。
   * 2026-11-09/10 四次合成超时都是背包 0 空槽。放不下就在点格子前如实报出，返回 null 表示放得下。
   */
  private craftResultShort(recipe: any, times: number): string | null {
    const inv = this.bot.inventory;
    // 没有槽位模型就判断不了，交给合成本身
    if (!Array.isArray(inv?.slots) || !recipe.result) return null;
    const start = inv.inventoryStart ?? 9, end = inv.inventoryEnd ?? 45;
    const slots = Array.from({ length: end - start }, (_, k) => inv.slots[start + k]).map((it) => it ? { type: it.type, count: it.count } : null);
    for (const d of (recipe.delta ?? []).filter((x: any) => x.count < 0)) {
      let need = -d.count * times;
      for (const it of slots) { if (need <= 0) break; if (it && it.type === d.id) { const take = Math.min(need, it.count); it.count -= take; need -= take; } }
    }
    const id = recipe.result.id, max = this.mcData.items[id]?.stackSize ?? 64;
    const total = recipe.result.count * times;
    const room = slots.reduce((n, it) => n + (!it || it.count <= 0 ? max : it.type === id ? Math.max(0, max - it.count) : 0), 0);
    return room >= total ? null : `INVENTORY_FULL: 背包放不下合成产物 ${this.mcData.items[id]?.name ?? id}×${total}（用掉材料后最多还能放 ${room} 个）；没有点合成格，材料没动。先腾出一格再合成`;
  }

  private async craftBatch(recipe: any, times: number, table: any, signal: AbortSignal): Promise<number | null> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    const short = this.craftResultShort(recipe, times);
    if (short) throw new Error(short);
    if (typeof b._syncWindow !== 'function' || typeof b.transfer !== 'function') return null;
    const w = table ? 3 : 2;
    const cells: { slot: number; id: number }[] = [];
    if (recipe.inShape) {
      recipe.inShape.forEach((row: any[], y: number) => row.forEach((c: any, x: number) => { if (c && c.id !== -1) cells.push({ slot: 1 + x + w * y, id: c.id }); }));
    } else {
      (recipe.ingredients ?? []).forEach((c: any, i: number) => cells.push({ slot: 1 + i, id: c.id }));
    }
    if (!cells.length || cells.some((c) => c.slot > w * w)) return null;
    // 每格最多一组：桶这种一组只有 1 个的料，一批就只能做 1 次
    const stack = (id: number) => this.mcData.items[id]?.stackSize ?? 64;
    const n = Math.min(times, ...cells.map((c) => stack(c.id)));
    if (n <= 0) return 0;
    const resultId = recipe.result?.id;
    const before = this.invCount(resultId);
    let produced = 0;
    let window: any = b.inventory;
    if (table) window = await this.afterAction(() => raceAbort(b.openBlock(table), signal, 8000, () => {}), check);
    try {
      // 背包 2×2 没有 windowOpen 事件；停留期间被打断也必须成对关闭观察端界面。
      if (!table) { this.emit('inventory_open'); await this.afterAction(() => sleep(this.cfg.ui?.openHoldMs ?? 0, signal), check); }
      if (table && !String(window.type ?? '').startsWith('minecraft:crafting')) throw new Error('打开的窗口不是工作台');
      // 合成格里不能有别的东西
      for (let i = 1; i <= w * w; i++) if (window.slots[i]) await this.afterAction(() => b.clickWindow(i, 0, 1), check);
      for (const c of cells) {
        await this.afterAction(() => b.transfer({ window, itemType: c.id, metadata: null, count: n, sourceStart: window.inventoryStart, sourceEnd: window.inventoryEnd, destStart: c.slot, destEnd: c.slot + 1 }), check);
      }
      await this.afterAction(() => raceAbort(b._syncWindow(window), signal, 8000, () => {}), check);
      if (window.slots[0]?.type === resultId) {
        // 整批材料已经摆好：只停一次让观察端看到配方，不按产物数量放慢。
        await this.afterAction(() => sleep(this.cfg.ui?.openHoldMs ?? 0, signal), check);
        await this.afterAction(() => b.clickWindow(0, 0, 1), check);
        await this.afterAction(() => raceAbort(b._syncWindow(window), signal, 8000, () => {}), check);
        produced = Math.max(0, this.invCount(resultId) - before);
      }
    } finally {
      // 剩在格子里的料（产物放不下、或桶这种合成后留下的容器）收回背包
      try {
        for (let i = 1; i <= w * w; i++) if (window.slots[i]) await b.clickWindow(i, 0, 1);
        if (window.selectedItem) await b.putSelectedItemRange?.(window.inventoryStart, window.inventoryEnd, window, null);
        await raceAbort(b._syncWindow(window), signal, 5000, () => {}).catch(() => {});
      } catch { /* 交给收拾残局 */ this.scheduleRepair('批量合成后残留', 250); }
      // 做完停一下再关（背包 2×2 合成没有窗口，也停一下，让观众看到产物进了背包）
      // Keep the confirmed batch total visible during the closing hold, after material cleanup.
      if (produced > 0) b.emit?.('observerCraft', produced, { name: this.mcData.items[resultId].name });
      await this.uiCloseHold(signal);
      if (table) { try { b.closeWindow(window); } catch { /* ignore */ } } else this.emit('inventory_close');
    }
    const per = recipe.result?.count ?? 1;
    return Math.max(0, Math.round((this.invCount(resultId) - before) / per));
  }

  private async craftOnce(recipe: any, table: any, signal: AbortSignal, times = 1) {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    const short = this.craftResultShort(recipe, times);
    if (short) throw new Error(short);
    const pace = this.cfg.ui?.pacingMs ?? 0;
    const timeout = 10000 + (this.cfg.ui?.openHoldMs ?? 0) + (this.cfg.ui?.closeHoldMs ?? 0) + (pace > 0 ? 3000 + pace * 12 * times : 0);
    const attempt = new AbortController();
    const attemptSignal = AbortSignal.any([signal, attempt.signal]);
    const attemptCheck = this.actionCheckpoint(attemptSignal);
    // 背包 2×2 合成格里有上一次被打断留下的东西：Mineflayer 默认格子是空的，照样往里摆、去拿结果，服务器那边对不上，
    // 合成就一直卡到超时（日志里一连串 craft 16 秒后“已取消”）。先把格子清回背包
    await this.interactionReady();
    check();
    let timedOut = false;
    // Mineflayer 的 bot.craft 用 activateBlock 打开工作台，绕过 openBlock 的停留包装。
    // 在窗口打开后暂停第一次点击，给观察端展示空工作台的时间。
    const hold = table ? (this.cfg.ui?.openHoldMs ?? 0) : 0;
    const beforeClick = b.beforeWindowClick;
    const closeWindow = b.closeWindow;
    const heldClose = async (...args: any[]) => { await this.uiCloseHold(attemptSignal); return closeWindow.apply(b, args); };
    let openedAt = 0;
    const opened = (window: any) => { if (String(window?.type ?? '').startsWith('minecraft:crafting')) openedAt = Date.now(); };
    const pacedClick = async (...args: any[]) => {
      if (openedAt) { const remaining = hold - (Date.now() - openedAt); openedAt = 0; if (remaining > 0) await sleep(remaining, attemptSignal); }
      await beforeClick.apply(b, args);
    };
    if (hold > 0 && typeof beforeClick === 'function') { b.on('windowOpen', opened); b.beforeWindowClick = pacedClick; }
    if (table && typeof closeWindow === 'function') b.closeWindow = heldClose;
    try {
      await this.afterAction(() => raceAbort(b.craft(recipe, times, table), attemptSignal, timeout, () => { timedOut = true; attempt.abort('craft transaction timed out'); }), attemptCheck);
    } catch (error) {
      attempt.abort('craft transaction ended without confirmation');
      this.actionContext.exit(() => { try { if (b.currentWindow) b.closeWindow(b.currentWindow); } catch { /* ignore */ } });
      // 被打断或超时：摆了一半的材料留在格子里，交给“收拾残局”（在动作上下文之外发包，不会被打断守卫吞掉）
      this.scheduleRepair(timedOut ? '合成超时' : '合成被打断', 250);
      if (timedOut && !signal.aborted) throw new Error('合成界面没响应（超时）；格子里的材料已收回背包，可以再试一次');
      throw error;
    } finally {
      if (hold > 0 && typeof beforeClick === 'function') {
        b.removeListener('windowOpen', opened);
        if (b.beforeWindowClick === pacedClick) b.beforeWindowClick = beforeClick;
      }
      if (b.closeWindow === heldClose) b.closeWindow = closeWindow;
    }
    // 2x2 inventory crafting resolves from Mineflayer's predicted slot model.
    // Wait for the server's authoritative inventory before using that output in
    // another recipe (notably logs -> planks -> crafting table).
    if (typeof b._syncWindow === 'function') {
      await this.afterAction(() => raceAbort(b._syncWindow(b.inventory), signal, 8000, () => {}), check);
    } else await this.afterAction(() => sleep(150, signal), check);
  }

  /** 把背包 2×2 合成格（1–4 号格）和光标上的东西放回背包 */
  private async clearCraftGrid() {
    const b = this.bot;
    if (!this.ready || b.currentWindow || !b.inventory?.slots) return;
    let moved = false;
    for (let slot = 1; slot <= 4; slot++) {
      if (!b.inventory.slots[slot]) continue;
      await b.clickWindow(slot, 0, 1); // shift 点击：移回背包
      moved = true;
    }
    if (b.inventory.selectedItem) {
      const empty = b.inventory.firstEmptyInventorySlot?.();
      if (empty !== null && empty !== undefined) { await b.clickWindow(empty, 0, 0); moved = true; }
    }
    if (moved && typeof b._syncWindow === 'function') await Promise.race([Promise.resolve(b._syncWindow(b.inventory)).catch(() => {}), sleep(3000)]);
  }

  /** 尽量一次合成所需数量（一次打开工作台），不行再逐个合成 */
  private async craftUpTo(id: number, count: number, table: any, signal: AbortSignal, batchSize = 64): Promise<number> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    let made = 0;
    while (made < count) {
      throwIfAborted(signal);
      const any = b.recipesFor(id, null, 1, table)[0];
      if (!any) break;
      const per = any.result?.count ?? 1;
      const times = Math.min(batchSize, Math.max(1, Math.ceil((count - made) / per)));
      const bulk = times > 1 ? b.recipesFor(id, null, times * per, table)[0] : null;
      const before = this.invCount(id);
      // 先按玩家的做法整批做（每格放一叠料、shift 点产物）；不行再退回一次一个
      // 料够做几次（配方里每样要几个 × 次数 ≤ 背包里有的）
      const afford = (r: any) => Math.min(...(r.delta ?? []).filter((d: any) => d.count < 0).map((d: any) => Math.floor(this.invCount(d.id) / -d.count)));
      const recipe = bulk ?? any;
      const want = Math.max(1, Math.min(times, afford(recipe) || 1));
      try {
        const batched = await this.afterAction(() => this.craftBatch(recipe, want, table, signal), check);
        if (batched === null) {
          if (bulk) {
            await this.afterAction(() => this.craftOnce(bulk, table, signal, times), check);
          } else {
            await this.afterAction(() => this.craftOnce(any, table, signal, 1), check);
          }
        }
      } catch (e) {
        // 已经做出一部分、剩下的放不进背包：保留已做成的数量，由 craft 回执说明“背包满了”
        if (made > 0 && /^INVENTORY_FULL/.test(String((e as Error)?.message))) break;
        throw e;
      }
      const produced = this.invCount(id) - before;
      if (produced <= 0) break;
      made += produced;
    }
    return made;
  }

  /**
   * 自动补齐前置材料（最多两层）：例如做木镐时缺木棍 → 先用木板做木棍；缺木板 → 先用原木做木板。
   * 返回 true 表示现在材料足够。
   */
  private async ensureIngredients(id: number, count: number, table: any, signal: AbortSignal, depth: number): Promise<boolean> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    if (b.recipesFor(id, null, count, table)[0]) return true;
    if (depth <= 0) return false;
    const recipes: any[] = b.recipesAll(id, null, table ?? null);
    for (const r of recipes) {
      const times = Math.max(1, Math.ceil(count / (r.result?.count ?? 1)));
      const needs: { id: number; n: number }[] = (r.delta ?? []).filter((d: any) => d.count < 0).map((d: any) => ({ id: d.id, n: -d.count * times }));
      // Subrecipes can consume a requirement checked earlier (sticks consume
      // the same planks a pickaxe also needs). Recheck the full recipe rather
      // than treating an earlier inventory count as still available.
      for (let pass = 0; pass < needs.length + 2; pass++) {
        let viable = true;
        for (const nd of needs) {
          const missing = nd.n - this.invCount(nd.id);
          if (missing <= 0) continue;
          if (!(await this.afterAction(() => this.craftSimple(nd.id, missing, table, signal, depth - 1), check))) { viable = false; break; }
        }
        if (viable && b.recipesFor(id, null, count, table)[0]) return true;
        if (!viable) break;
      }
    }
    return false;
  }

  /** 合成 count 个（先补前置材料）；返回是否成功做出至少所需数量 */
  private async craftSimple(id: number, count: number, table: any, signal: AbortSignal, depth: number): Promise<boolean> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    if (this.needsTable(id, count) && !table) return false;
    if (!(await this.afterAction(() => this.ensureIngredients(id, count, table, signal, depth), check))) return false;
    const name = this.mcData.items[id]?.name ?? String(id);
    const made = await this.afterAction(() => this.craftUpTo(id, count, table, signal), check);
    if (made > 0) this.bus.publish('craft_auto', 'P3', `自动补做前置材料：${name} ×${made}`);
    return made >= count;
  }

  /** 找到可用的工作台：记得的位置 → 身边 → 背包里的 → 现做一个；必要时放下 */
  private async ensureTable(signal: AbortSignal, knownPos?: Vec3Like, prepare = false): Promise<any | null> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    const tableId = this.mcData.blocksByName.crafting_table.id;
    let table: any = null;
    if (knownPos && b.blockAt(this.vec(knownPos))?.name === 'crafting_table') table = b.blockAt(this.vec(knownPos));
    const reachable = (block: any) => block.position.offset(0.5, 0.5, 0.5).distanceTo(b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0)) <= 4.4
      && (typeof b.canSeeBlock !== 'function' || b.canSeeBlock(block));
    const nearby = b.findBlock({ matching: tableId, maxDistance: 5 });
    if (nearby && (!table || reachable(nearby))) table = nearby;
    if (table && !reachable(table)) {
      try { await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: table.position }, { signal, timeoutMs: 30000 }), check); }
      catch (error: any) { if (error?.name === 'AbortedError') throw error; check(); table = null; }
      if (table && !reachable(table)) table = null;
    }
    if (!table && prepare) {
      let tableItem = b.inventory.items().find((i: any) => i.name === 'crafting_table');
      if (!tableItem && (await this.afterAction(() => this.craftSimple(this.mcData.itemsByName.crafting_table.id, 1, null, signal, 2), check))) {
        tableItem = b.inventory.items().find((i: any) => i.name === 'crafting_table');
      }
      // 工作台只占一格；狭窄洞穴的壁龛不必再空出一格供人站进去。
      const candidates = tableItem ? this.findPlaceSpots(false).slice(0, 6) : [];
      for (const ref of candidates) {
        const position = ref.position.offset(0, 1, 0);
        try {
          // 已能伸手放下就直接放，避免寻路器在一格宽空间里强行找另一个站位。
          let placed = await this.afterAction(() => this.placeBlockAt(position, ['crafting_table'], signal), check);
          if (!placed.ok) {
            await this.afterAction(() => this.moveTo({ kind: 'place_block', pos: position }, { signal, timeoutMs: 8000 }), check);
            placed = await this.afterAction(() => this.placeBlockAt(position, ['crafting_table'], signal), check);
          }
          const observed = b.blockAt(position);
          if (placed.ok && observed?.name === 'crafting_table') { table = observed; this.bus.publish('place', 'P3', '放置并核对了工作台'); break; }
        } catch (error: any) { if (error?.name === 'AbortedError') throw error; check(); }
      }
    }
    if (table && !reachable(table)) await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: table.position }, { signal, timeoutMs: 15000 }), check);
    if (table && !reachable(table)) return null;
    return table;
  }

  async craft(item: string, count: number, signal: AbortSignal, opts: { tablePos?: Vec3Like; prepare?: boolean; batchSize?: number } = {}): Promise<ActionResult & { crafted: number; detail?: string; tablePos?: Vec3Like }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', crafted: 0 };
    const b = this.bot;
    const data = this.mcData.itemsByName[item];
    if (!data) return { ok: false, reason: 'UNKNOWN_ITEM', crafted: 0 };
    if (b.recipesAll(data.id, null, true).length === 0) return { ok: false, reason: 'UNKNOWN_ITEM', crafted: 0 };

    let table: any = null;
    if (this.needsTable(data.id, count)) {
      table = await this.afterAction(() => this.ensureTable(signal, opts.tablePos, opts.prepare === true), check);
      if (!table) return { ok: false, reason: 'NO_CRAFTING_TABLE', crafted: 0, detail: this.missingReport(data.id, count, null) };
    }
    const tablePos = table?.position ? { x: table.position.x, y: table.position.y, z: table.position.z } : undefined;
    const before = this.invCount(data.id);
    if (opts.prepare) await this.afterAction(() => this.ensureIngredients(data.id, count, table, signal, 2), check);
    let crafted = await this.afterAction(() => this.craftUpTo(data.id, count, table, signal, opts.batchSize), check);
    crafted = Math.max(crafted, this.invCount(data.id) - before);
    // 同种木板凑不齐但混着几种木板够用：按实际的木板拼配方（原版允许）
    for (let tries = 0; crafted < count && tries < 8; tries++) {
      // 正常配方仍可用时，失败不代表需要换木板配方（例如背包已满）。
      if (b.recipesFor(data.id, null, 1, table)[0]) break;
      const mixed = this.mixedPlanksRecipe(data.id, 1, table);
      if (!mixed) break;
      const was = this.invCount(data.id);
      await this.afterAction(() => this.craftOnce(mixed, table, signal, 1), check);
      const made = this.invCount(data.id) - was;
      if (made <= 0) break;
      crafted += made;
    }
    // 没做够：说清卡在哪（料不够 / 背包满了），别让它以为做齐了
    const short = crafted > 0 && crafted < count
      ? (b.inventory.emptySlotCount?.() === 0 ? '背包满了，放不下更多产物' : this.missingReport(data.id, count - crafted, table))
      : undefined;
    return crafted > 0 ? { ok: true, crafted, ...(short ? { detail: short } : {}), ...(tablePos ? { tablePos } : {}) }
      : { ok: false, reason: 'MISSING_MATERIALS', crafted: 0, detail: this.missingReport(data.id, count, table), ...(tablePos ? { tablePos } : {}) };
  }

  private foodItems(): any[] {
    if (!this.ready) return [];
    const foods = this.mcData.foodsByName ?? {};
    const items = this.bot.inventory.items();
    const regular = items
      .filter((i: any) => foods[i.name] && !BAD_FOOD.has(i.name))
      // 有熟食先吃熟食（饱和度高），生肉留着烤
      .sort((a: any, c: any) => Number(RAW_FOOD.test(a.name)) - Number(RAW_FOOD.test(c.name)) || (foods[c.name].foodPoints ?? 0) - (foods[a.name].foodPoints ?? 0));
    // 腐肉只在没有正常食物且濒临饥饿时救急；每一口都重新核对阈值。
    return regular.length || (this.bot.food ?? 20) > 6 ? regular : items.filter((i: any) => i.name === 'rotten_flesh' && foods[i.name]);
  }

  hasFood(): boolean {
    return this.foodItems().length > 0;
  }

  async eat(signal: AbortSignal, want?: string): Promise<boolean> {
    const check = this.actionCheckpoint(signal);
    const item = want ? (this.mcData.foodsByName ?? {})[want] ? this.invItem(want) : null : this.foodItems()[0];
    if (!item) return false;
    const b = this.bot;
    await this.afterAction(() => b.equip(item, 'hand'), check);
    await this.afterAction(() => raceAbort(b.consume(), signal, 6000, () => {
      try { b.deactivateItem(); } catch { /* ignore */ }
    }), check);
    return true;
  }

  async equipWeapon(signal?: AbortSignal): Promise<void> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return;
    const items = this.bot.inventory.items();
    for (const kind of ['sword', 'axe']) {
      for (const mat of WEAPON_ORDER) {
        const it = items.find((i: any) => i.name === `${mat}_${kind}`);
        if (it) {
          if (this.bot.heldItem?.name !== it.name) await this.afterAction(() => this.bot.equip(it, 'hand'), check);
          return;
        }
      }
    }
  }

  async attack(entityId: number, signal?: AbortSignal): Promise<boolean> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return false;
    const ent = this.bot.entities[entityId];
    if (!ent || !ent.isValid) return false;
    // In the target 1.20.1 server, EnderDragon.hurt(source, amount) forwards to
    // hurt(body, source, amount). Use the observed parent id for reduced body
    // damage; multipart head ids/positions are not supplied by Mineflayer.
    const dragon = ent.name === 'ender_dragon';
    const aim = ent.position.offset(0, dragon ? 1.5 : (ent.height ?? 1.6) * 0.85, 0);
    if (dragon && aim.distanceTo(this.bot.entity.position.offset(0, this.bot.entity.eyeHeight ?? 1.62, 0)) > 4.5) return false;
    try {
      await this.afterAction(() => this.bot.lookAt(aim, true), check);
    } catch { /* ignore */ }
    check();
    this.bot.attack(ent);
    return true;
  }

  async look(yaw: number, pitch: number, signal?: AbortSignal) {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return;
    await this.afterAction(() => this.bot.look(yaw, pitch, false), check);
  }

  private drawStartedAt: number | null = null;

  async pillarUp(itemNames: string[], signal: AbortSignal): Promise<ActionResult & { y?: number; clearanceDetail?: string; clearance?: { at?: [number, number, number]; facing?: string; cells?: { at: [number, number, number]; facing: string }[] }; waterDepth?: number }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot, epoch = this.actionEpoch;
    // 要放方块的是脚踩着的那块上面一格：站在灵魂沙、半砖这类不足一格的方块上时，floor(脚高)
    // 是支撑方块自己（脚高 x.875 之类），不能拿它当放置格、拿它下面一格当贴面。
    const support = supportCell(b.entity.position);
    const feet = new Vec3(support.x, support.y + 1, support.z);
    const below = b.blockAt(feet.offset(0, -1, 0));
    const here = b.blockAt(feet);
    const inWater = !!here && here.name === 'water';
    if (!below || below.boundingBox !== 'block') {
      // 没贴着实心方块：悬空、在水里或梯子上。泡在水里就往下找最近池底，把事实带回去（够不着贴面时别只回一句“没有面”）
      if (inWater) {
        let floorBelow = 0;
        for (let dy = 1; dy <= 4; dy++) {
          const n = b.blockAt(feet.offset(0, -1 - dy, 0));
          if (n && n.boundingBox === 'block') { floorBelow = dy + 1; break; }
          if (n && n.name !== 'water') break; // 往下不是水了还没见实底，别继续猜
        }
        return { ok: false, reason: 'NO_REFERENCE', ...(floorBelow ? { waterDepth: floorBelow } : {}) };
      }
      return { ok: false, reason: 'NO_REFERENCE' };
    }
    if (here && here.boundingBox === 'block') return { ok: false, reason: 'OCCUPIED' };
    // 脚下这格有火把、花、铁轨、按钮这类没碰撞但也不会被顶掉的东西：服务器不让往里放方块
    if (here && !/^(air|cave_air|void_air|water|short_grass|grass|tall_grass|fern|large_fern|dead_bush|seagrass|tall_seagrass|snow)$/.test(here.name)) return { ok: false, reason: `BLOCKED:${here.name}` };
    const item = b.inventory.items().find((i: any) => itemNames.includes(i.name));
    if (!item) return { ok: false, reason: 'NO_ITEM' };
    await this.afterAction(() => b.equip(item, 'hand'), check);
    b.clearControlStates();
    await this.afterAction(() => b.look(b.entity.yaw, -Math.PI / 2, true), check);
    // 站在浅水里（脚泡在水里、脚下是实底）：水格可以直接放方块，不用跳，直接贴着脚下池底放进去
    if (inWater) {
      const clearance = this.pillarClearance();
      if (clearance) return { ok: false, reason: `NOT_PLACED:头顶跳跃空间${clearance.kind === 'blocked' ? '受阻' : '未加载'}`, clearanceDetail: describePillarClearance(clearance), clearance: clearance.kind === 'blocked' && clearance.blocks.length ? { at: clearance.blocks[0].rel, facing: clearance.blocks[0].facing, cells: clearance.blocks.flatMap((blk) => (blk.rel && blk.facing ? [{ at: blk.rel, facing: blk.facing }] : [])) } : undefined };
      try {
        await this.afterAction(() => raceAbort(b.placeBlock(below, new Vec3(0, 1, 0)), signal, 2500, () => {}), check);
      } catch (e: any) {
        if (e?.name === 'AbortedError') throw e;
        return { ok: false, reason: `NOT_PLACED:${String(e?.message ?? e).slice(0, 80)}`, y: Math.floor(b.entity.position.y) };
      }
      const block = b.blockAt(feet);
      if (!block || block.boundingBox !== 'block') return { ok: false, reason: 'NOT_PLACED', y: Math.floor(b.entity.position.y) };
      return { ok: true, y: Math.floor(b.entity.position.y) };
    }
    // 站稳了再跳
    for (let i = 0; i < 20 && !b.entity.onGround; i++) await this.afterAction(() => sleep(25, signal), check);
    if (!b.entity.onGround) return { ok: false, reason: 'NOT_PLACED:尚未站稳' };
    // 身体 AABB 压在两列上时先潜行归位到中心所在格的格心：中心下方已有实心方块（上面的
    // below 检查已确认），归位不会踩空；否则跳跃净空会把相邻那一列也算进来，每次垫高多清一格。
    const centre = this.spanningCell();
    if (centre) {
      await this.steady(centre, signal, check);
      // steady 会把视线摆平；放置前的俯视状态保持不变。
      await this.afterAction(() => b.look(b.entity.yaw, -Math.PI / 2, true), check);
    }
    const clearance = this.pillarClearance();
    if (clearance) return { ok: false, reason: `NOT_PLACED:头顶跳跃空间${clearance.kind === 'blocked' ? '受阻' : '未加载'}`, clearanceDetail: describePillarClearance(clearance), clearance: clearance.kind === 'blocked' && clearance.blocks.length ? { at: clearance.blocks[0].rel, facing: clearance.blocks[0].facing, cells: clearance.blocks.flatMap((blk) => (blk.rel && blk.facing ? [{ at: blk.rel, facing: blk.facing }] : [])) } : undefined };
    let placed = false, lastError = '';
    // 贴面放置常被服务器拒绝（方块和身体重叠、或客户端拿的参考块已陈旧）。still air 是
    // 快速失败：被拒不会消耗方块，可以在「身体离格 → 落回」的窗口里重抓参考块再放。
    for (let attempt = 0; attempt < 2 && !placed; attempt++) {
      // 起跳前仍先确认脚下贴面还在；内层每放一次会重新抓，覆盖窗口里方块变化。
      const beforeJump = b.blockAt(feet.offset(0, -1, 0));
      if (!beforeJump || beforeJump.boundingBox !== 'block') { lastError = lastError || '脚下贴面方块变了，没地方放'; break; }
      b.setControlState('jump', true);
      try {
        const t0 = Date.now();
        let reached = false, jumpPlaced = false;
        while (Date.now() - t0 < 900 && !jumpPlaced) {
          check();
          // 等脚底离开那一格（身体的底面高过方块顶面）才放，否则方块会和自己重叠，服务器不认
          if (b.entity.position.y < feet.y + 1.02) { await this.afterAction(() => sleep(15, signal), check); continue; }
          reached = true;
          const ref = b.blockAt(feet.offset(0, -1, 0));
          if (!ref || ref.boundingBox !== 'block') { lastError = lastError || '脚下贴面方块变了，没地方放'; break; }
          try {
            await this.afterAction(() => raceAbort(b.placeBlock(ref, new Vec3(0, 1, 0)), signal, 400, () => {}), check);
            jumpPlaced = true;
          } catch (e: any) {
            if (e?.name === 'AbortedError') throw e;
            lastError = String(e?.message ?? e).slice(0, 80);
          }
        }
        if (!reached && !lastError) lastError = '跳不起来';
      } finally {
        if (epoch === this.actionEpoch && b === this.bot) b.setControlState('jump', false);
      }
      // 落地
      const t1 = Date.now();
      while (!b.entity.onGround && Date.now() - t1 < 1500) await this.afterAction(() => sleep(25, signal), check);
      const block = b.blockAt(feet);
      placed = !!block && block.boundingBox === 'block' && b.entity.position.y >= feet.y + 0.9;
    }
    if (!placed) return { ok: false, reason: lastError ? `NOT_PLACED:${lastError}` : 'NOT_PLACED', y: Math.floor(b.entity.position.y) };
    return { ok: true, y: Math.floor(b.entity.position.y) };
  }

  async drive(keys: DriveKeys, ms: number, signal: AbortSignal, opts: DriveOptions = {}): Promise<DriveResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', moved: 0, ms: 0 };
    const b = this.bot, epoch = this.actionEpoch;
    const start = b.entity.position.clone(), t0 = Date.now(), total = Math.max(50, Math.min(10000, ms));
    const names = (Object.keys(keys) as (keyof DriveKeys)[]).filter((k) => keys[k]);
    const face = () => {
      const target = opts.faceEntity !== undefined ? b.entities[opts.faceEntity] : null;
      const p = target?.isValid ? target.position.offset(0, (target.height ?? 1.6) * 0.85, 0) : opts.facePoint ? this.vec(opts.facePoint) : null;
      if (p) { try { b.lookAt(p, true); } catch { /* ignore */ } }
    };
    // 身体本能：不迈进岩浆和火，不从三格以上的高处一脚踩空
    const danger = (): DriveResult['stopped'] | null => {
      if (opts.guard === false) return null;
      const v = b.entity.velocity ?? { x: 0, z: 0 };
      let speed = Math.hypot(v.x, v.z), dir = { x: v.x, z: v.z };
      // 刚起步时速度还很小：按按下的方向键和朝向推算要去的方向，不等身体已经迈出去才看
      if (speed < 0.02) {
        const f = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0), r = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
        if (!f && !r) return null; // 只跳/潜行：没有水平去向
        const yaw = b.entity.yaw ?? 0, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        dir = { x: fx * f - fz * r, z: fz * f + fx * r };
        speed = Math.hypot(dir.x, dir.z);
        if (speed < 0.01) return null;
      }
      const ahead = b.entity.position.offset((dir.x / speed) * 0.7, 0, (dir.z / speed) * 0.7);
      const at = (dy: number) => b.blockAt(ahead.offset(0, dy, 0))?.name ?? null;
      // 走进传送门（下界门/末地门/折跃门）不算地形危险：门会接住人并传送。
      // 是否允许非预期传送是调用方的显式委托（allowPortal），guard 本身不保证避开传送门。
      if (/^(nether_portal|end_portal|end_gateway)$/.test(at(0) ?? '')) return opts.allowPortal === false ? 'portal' : null;
      const hazard = (n: string | null) => /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/.test(n ?? '');
      if ([0, -1].some((dy) => hazard(at(dy)))) return 'lava';
      if (!b.entity.onGround) return null;
      const open = (n: string | null) => n === null || AIR_BLOCKS.has(n);
      // 前方脚下是空的：顺着往下找第一格非空气，是岩浆/火就是要掉进去（实机：举盾后撤从一格台阶退进下面的岩浆）
      if (open(at(-1))) for (let dy = -2; dy >= -5; dy--) { const n = at(dy); if (open(n)) continue; if (hazard(n)) return 'lava'; break; }
      if (open(at(-1)) && open(at(-2)) && open(at(-3)) && open(at(-4))) return 'cliff';
      return null;
    };
    let stopped: DriveResult['stopped'] | undefined;
    try {
      check();
      b.clearControlStates();
      for (const k of names) b.setControlState(k, true);
      while (Date.now() - t0 < total) {
        face();
        const d = danger();
        if (d) { stopped = d; break; }
        await this.afterAction(() => sleep(Math.min(50, total - (Date.now() - t0)), signal), check);
      }
    } finally {
      if (epoch === this.actionEpoch && b === this.bot) for (const k of names) b.setControlState(k, false);
    }
    const moved = Math.round(b.entity.position.distanceTo(start) * 100) / 100;
    return { ok: !stopped, ...(stopped ? { reason: stopped === 'lava' ? 'HAZARD' : 'CLIFF', stopped } : {}), moved, ms: Date.now() - t0 };
  }

  async raiseShield(on: boolean, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    if (!on) {
      this.stopShieldHold();
      this.actionContext.run(check, () => b.deactivateItem());
      return { ok: true };
    }
    const off = b.inventory.slots?.[45];
    if (off?.name !== 'shield') return { ok: false, reason: 'NO_SHIELD' };
    this.holdShield();
    return { ok: true };
  }

  private stopShieldHold() {
    if (!this.shieldHold) return;
    clearInterval(this.shieldHold.interval);
    this.shieldHold = null;
  }

  /** 盾举起来后持续按住：mineflayer 在 entity_status（挨打/格挡）/set_cooldown 时会把 usingHeldItem 清掉，盾就掉了；
   * 定时补举，直到 raiseShield(false) 或动作换主（stopAll 递增 actionEpoch）。只在 usingHeldItem 已掉时重举，避免重复 use_item。 */
  private holdShield() {
    this.stopShieldHold();
    const b = this.bot, epoch = this.actionEpoch;
    const raise = () => {
      if (this.actionEpoch !== epoch) { this.stopShieldHold(); return; }
      if (b.inventory.slots?.[45]?.name !== 'shield') { this.stopShieldHold(); return; }
      if (!b.usingHeldItem) { try { b.activateItem(true); } catch { /* ignore */ } }
    };
    raise();
    const interval = setInterval(raise, 250);
    interval.unref?.();
    this.shieldHold = { interval, epoch };
  }

  async startDraw(item: string, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const it = this.invItem(item);
    if (!it) return { ok: false, reason: 'NO_ITEM' };
    if ((item === 'bow' || item === 'crossbow') && !b.inventory.items().some((i: any) => /arrow$|firework_rocket/.test(i.name))) return { ok: false, reason: 'NO_AMMO' };
    if (b.heldItem?.name !== item) await this.afterAction(() => b.equip(it, 'hand'), check);
    this.actionContext.run(check, () => b.activateItem());
    this.drawStartedAt = Date.now();
    return { ok: true };
  }

  async releaseDraw(signal: AbortSignal, aim?: Vec3Like): Promise<ActionResult & { chargedMs: number }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', chargedMs: 0 };
    const b = this.bot;
    if (this.drawStartedAt === null) return { ok: false, reason: 'NOT_DRAWING', chargedMs: 0 };
    if (aim) {
      if (![aim.x, aim.y, aim.z].every(Number.isFinite)) return { ok: false, reason: 'BAD_AIM', chargedMs: 0 };
      await this.afterAction(() => b.lookAt(this.vec(aim), true), check);
      if (typeof b.waitForTicks === 'function') await this.afterAction(() => raceAbort(b.waitForTicks(1), signal, 2000, () => {}), check);
    }
    const chargedMs = Date.now() - this.drawStartedAt;
    this.drawStartedAt = null;
    this.actionContext.run(check, () => b.deactivateItem());
    return { ok: true, chargedMs };
  }

  combatState() {
    const b = this.bot;
    if (!this.ready) return { usingItem: false, offHand: null, drawingSinceMs: null };
    return { usingItem: !!b.usingHeldItem, offHand: b.inventory.slots?.[45]?.name ?? null, drawingSinceMs: this.drawStartedAt === null ? null : Date.now() - this.drawStartedAt };
  }

  async jump(ms: number, signal: AbortSignal) {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return;
    const epoch = this.actionEpoch;
    const b = this.bot;
    this.bot.setControlState('jump', true);
    try {
      await this.afterAction(() => sleep(ms, signal), check);
    } finally {
      if (epoch === this.actionEpoch && b === this.bot) b.setControlState('jump', false);
    }
  }

  /**
   * 在水里朝一格游过去：看着它往前游，目标在下面就按潜行往下沉，在上面就按跳往上游。
   * 到了（1.3 格内）、气不够了、出了水、或者超时就停，松开所有按键；不替它决定去哪、潜多深。
   */
  async diveTo(target: Vec3Like, signal: AbortSignal, opts: { minOxygen?: number; timeoutMs?: number } = {}): Promise<ActionResult & { reached: boolean; oxygen: number }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', reached: false, oxygen: 0 };
    const b = this.bot, epoch = this.actionEpoch;
    const minOxygen = opts.minOxygen ?? 6;
    const end = Date.now() + Math.max(500, Math.min(30000, opts.timeoutMs ?? 15000));
    const goal = this.vec(target).offset(0.5, 0.5, 0.5);
    const oxygen = () => this.state().oxygen;
    check();
    b.clearControlStates();
    try {
      while (Date.now() < end) {
        check();
        const eye = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
        const d = goal.distanceTo(b.entity.position.offset(0, 0.9, 0));
        if (d <= 1.3) return { ok: true, reached: true, oxygen: oxygen() };
        if (!b.entity.isInWater) return { ok: false, reason: 'OUT_OF_WATER', reached: false, oxygen: oxygen() };
        if (oxygen() <= minOxygen) return { ok: false, reason: 'LOW_OXYGEN', reached: false, oxygen: oxygen() };
        await this.afterAction(() => b.lookAt(goal, true), check);
        const dy = goal.y - eye.y;
        b.setControlState('forward', Math.hypot(goal.x - eye.x, goal.z - eye.z) > 0.6);
        b.setControlState('sneak', dy < -0.5);
        b.setControlState('jump', dy > 0.5);
        await this.afterAction(() => sleep(100, signal), check);
      }
      return { ok: false, reason: 'TIMEOUT', reached: false, oxygen: oxygen() };
    } finally {
      if (epoch === this.actionEpoch && b === this.bot) b.clearControlStates();
    }
  }

  /**
   * 鞘翅滑翔到已知坐标：起飞/巡航/避障/着陆在一趟连续控制里完成（速度约 30 格/秒，远超 LLM 反应窗口，所以不逐格问）。
   * 只执行 Agent 已选定的目的地与火箭预算；如实报告：是否落地、是否到达、是否撞伤、消耗几发火箭。
   * 俯仰控制是身体控制律（俯冲=加速下降、抬头=减速/短暂爬升），不是替 Agent 选目的地或手段。
   */
  async glideTo(target: Vec3Like, signal: AbortSignal, opts: { timeoutMs: number; allowRockets?: boolean; maxRockets?: number }): Promise<ActionResult & { arrived: boolean; landed: boolean; crashed: boolean; rocketsUsed: number; distance: number; position: Vec3Like; hpLost: number }> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    const pv = (p: Vec3Like) => ({ x: p.x, y: p.y, z: p.z });
    const out = (o: { ok?: boolean; reason?: string; arrived?: boolean; landed?: boolean; crashed?: boolean; rocketsUsed?: number; distance?: number; position?: Vec3Like; hpLost?: number }) => ({
      ok: o.ok ?? false, ...(o.reason ? { reason: o.reason } : {}),
      arrived: o.arrived ?? false, landed: o.landed ?? false, crashed: o.crashed ?? false,
      rocketsUsed: o.rocketsUsed ?? 0, distance: o.distance ?? 0, position: pv(o.position ?? this.state().pos), hpLost: o.hpLost ?? 0,
    });
    if (!this.ready) return out({ reason: 'NOT_CONNECTED' });
    const epoch = this.actionEpoch, dimension = this.currentDimension();
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot && dimension === this.currentDimension();
    const goal = this.vec(target);
    const start = b.entity.position.clone();
    const hp0 = b.health ?? 0;
    const allowRockets = opts.allowRockets === true;
    const maxRockets = Math.max(0, Math.min(64, Math.floor(opts.maxRockets ?? 0)));
    let rocketsUsed = 0;
    const end = Date.now() + Math.max(500, Math.min(120000, opts.timeoutMs ?? 60000));
    const distTo = (p: any) => Math.hypot(p.x - goal.x, p.z - goal.z);

    if (this.state().equipment?.find((e) => e.slot === 'torso')?.name !== 'elytra') return out({ reason: 'NO_ELYTRA', distance: Math.round(start.distanceTo(goal)), position: start });

    // 目标列向下找第一块实心方块作为“地平面”估计；找不到退化成目标 y。用于判断高度余量，不是精确地表。
    const groundY = () => {
      for (let y = Math.ceil(goal.y); y >= Math.ceil(goal.y) - 64; y--) {
        const blk = b.blockAt(new Vec3(Math.floor(goal.x), y, Math.floor(goal.z)));
        if (blk && blk.boundingBox === 'block') return y + 1;
      }
      return Math.ceil(goal.y);
    };

    const armRocket = async () => {
      const rocket = this.invItem('firework_rocket');
      if (!rocket) return false;
      if (b.heldItem?.name !== 'firework_rocket') await this.afterAction(() => b.equip(rocket, 'hand'), check);
      return b.heldItem?.name === 'firework_rocket';
    };
    const boost = async () => {
      if (!allowRockets || rocketsUsed >= maxRockets) return false;
      if (!(await armRocket())) return false;
      this.actionContext.run(check, () => b.activateItem());
      rocketsUsed++;
      return true;
    };

    b.clearControlStates();
    try {
      // 起飞：跳起离地；允许火箭时补一发获得高度并进入滑翔。
      check();
      b.setControlState('jump', true);
      if (allowRockets && maxRockets > 0 && b.entity.onGround) await boost();
      await this.afterAction(() => sleep(350, signal), check);
      if (ownsControls()) b.setControlState('jump', false);

      let lastHp = hp0;
      let freeFallSince = 0;
      while (Date.now() < end) {
        check();
        const p = b.entity.position;
        const air = !b.entity.onGround && !b.entity.isInWater;
        const horiz = distTo(p);
        const hp = b.health ?? 0;

        // 撞墙/天花板：空中突然掉血是致命危险，立即停，如实报撞了。
        if (air && lastHp - hp >= 3) {
          return out({ reason: 'CRASHED', crashed: true, rocketsUsed, distance: Math.round(start.distanceTo(p)), position: p, hpLost: Math.max(0, hp0 - hp) });
        }
        lastHp = hp;

        // 落地或落水：飞行结束。
        if (b.entity.onGround || b.entity.isInWater) {
          const arrived = horiz <= 4;
          return out({ ok: arrived, ...(arrived ? {} : { reason: 'LANDED_SHORT' }), arrived, landed: true, crashed: false, rocketsUsed, distance: Math.round(start.distanceTo(p)), position: p, hpLost: Math.max(0, hp0 - hp) });
        }

        // 起飞失败：一直在原地附近自由落体（没进入滑翔、水平没前进），没有高度来源，判定没飞起来。
        const v = b.entity.velocity ?? { x: 0, y: 0, z: 0 };
        if (air && v.y < -1.6 && Math.hypot(v.x, v.z) < 4 && start.distanceTo(p) < 3) {
          freeFallSince ||= Date.now();
          if (Date.now() - freeFallSince > 1500) return out({ reason: 'GLIDE_NOT_ENGAGED', distance: Math.round(start.distanceTo(p)), position: p, hpLost: Math.max(0, hp0 - hp) });
        } else freeFallSince = 0;

        // 转向 + 俯仰策略（身体控制律）：朝目标，低空/进近时抬升减速，高空巡航略俯冲。
        const yaw = Math.atan2(-(goal.x - p.x), -(goal.z - p.z));
        const altitude = p.y - groundY();
        let pitch = -0.35;
        if (altitude < 4 || (horiz <= 20 && altitude < 8)) pitch = 0.45;
        else if (horiz <= 30) pitch = Math.max(-0.3, (altitude - 12) / 30);
        pitch = Math.max(-0.6, Math.min(0.6, pitch));
        await this.afterAction(() => b.look(yaw, pitch, true), check);

        // 需要高度（低空/前方大概率未知）时，允许火箭就补一发。
        if (allowRockets && rocketsUsed < maxRockets && (altitude < 2 || (horiz > 40 && altitude < 6))) await boost();

        await this.afterAction(() => sleep(80, signal), check);
      }
      const p = b.entity.position;
      const hp = b.health ?? 0;
      return out({ reason: 'TIMEOUT', arrived: false, landed: b.entity.onGround || b.entity.isInWater, crashed: false, rocketsUsed, distance: Math.round(start.distanceTo(p)), position: p, hpLost: Math.max(0, hp0 - hp) });
    } finally {
      if (ownsControls()) b.clearControlStates();
    }
  }

  async swimTo(target: Vec3Like | null, signal: AbortSignal, opts: SwimOptions = {}): Promise<ActionResult & SwimFacts & { landed: boolean; surfaced: boolean; oxygen: number }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', landed: false, surfaced: false, oxygen: 0, goal: 'surface_ascent', stage: 'approach', enteredWater: false, advanced: 0 };
    const b = this.bot, epoch = this.actionEpoch;
    const end = Date.now() + Math.min(20000, opts.timeoutMs ?? 10000);
    const start = b.entity.position.clone();
    let drySince: number | null = null;
    let wetSince: number | null = null;
    let surfacedSince: number | null = null;
    let lastProgress = Date.now();
    // “换气”至少要看到氧气实际回升：头刚碰到空气就松手，下一次思考的几秒里又沉回去耗光。
    // 起点已接近满氧时按现有值；低于 12 时至少补到 12，其余在起点基础上多补 4 格。
    const breathTarget = Math.min(19, Math.max(12, ownOxygen(b) + 4));
    let enteredWater = false;
    let stage: SwimStage = 'approach';
    const destination = target;
    // 流体包含水和岩浆：岩浆不能被当成「非流体」或「干地」。
    const fluid = (block: any) => !!block && (['water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(block.name) || String(block.getProperties?.().waterlogged) === 'true');
    const water = (block: any) => !!block && (['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(block.name) || String(block.getProperties?.().waterlogged) === 'true');
    const headUnder = () => fluid(b.blockAt(b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0)));
    // 头格已知且是可呼吸的空气才算真正露头；岩浆/实心方块/未观察（null）都不算能呼吸。
    const headOut = () => { const h = b.blockAt(b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0)); return !!h && ['air', 'cave_air', 'void_air'].includes(h.name); };
    const feetInWater = () => !!b.entity.isInWater || water(b.blockAt(b.entity.position));
    const dryFooting = () => {
      const p = b.entity.position;
      const support = b.blockAt(p.offset(0, -0.05, 0));
      const head = b.blockAt(p.offset(0, b.entity.eyeHeight ?? 1.62, 0));
      return !!b.entity.onGround && !b.entity.isInWater && !b.entity.isInLava && !!head && ['air', 'cave_air', 'void_air'].includes(head.name) && support?.boundingBox === 'block' && !fluid(support);
    };
    // 目标格已被观察为水时，这是“到水里某个点”的目标；未知（null）不当作水，仍要求可靠干地支撑。
    const targetInWater = !!destination && water(b.blockAt(new Vec3(destination.x, destination.y, destination.z)));
    const goal: SwimGoal = !destination ? 'surface_ascent' : targetInWater ? 'surface_target' : 'dry_shore';
    const targetBlock = destination ? b.blockAt(new Vec3(destination.x, destination.y, destination.z)) : null;
    const targetCellName = targetBlock?.name ?? null;
    // 调用方常把方块坐标（整数 x/z）当脚坐标：整数 x/z 正好落在四格交界，身体会骑在列与列之间。
    // 这里只报告事实，不改写目标；要站到方块顶上应给方块中心（+0.5）。
    const targetOnEdge = !!destination && (Number.isInteger(destination.x) || Number.isInteger(destination.z));
    const distanceToTarget = (p: Vec3Like) => destination ? Math.hypot(destination.x - p.x, destination.y - p.y, destination.z - p.z) : 0;
    let bestTargetDistance = destination ? distanceToTarget(b.entity.position) : Infinity;
    const atTarget = () => {
      if (!destination) return false;
      const p = b.entity.position;
      return Math.hypot(destination.x - p.x, destination.z - p.z) <= 1.0 && Math.abs(destination.y - p.y) <= 1.5;
    };
    // 头此刻稳定露头（结束后重采样，不读陈旧样本；头一旦沉下，surfacedSince 立即归零）。
    const surfacedNow = () => {
      if (!headOut()) surfacedSince = null;
      return surfacedSince !== null && Date.now() - surfacedSince >= 600;
    };
    // 真正的剩余预算：每次等待前都检查是否仍为正；为 0/负说明预算已耗尽，不能再触发新的等待或写入动作。
    const remaining = () => end - Date.now();
    // 小于这个余量时不再启动新的等待：raceAbort 的定时器会先于 tick 触发，抛出的
    // “timeout after 73ms” 只是最后一小段预算，不是真实失败原因。直接按预算耗尽返回。
    const MIN_WAIT_MS = 50;
    // waitForTicks(2) 本身要等两个刻（约 100ms）。余量不够一次两刻等待时只等一刻，
    // 并且把这段末预算里的超时当作预算耗尽返回，不把 “timeout after 73ms” 当真实失败。
    const MIN_TICK_WAIT_MS = 150;
    const facts = (at: SwimStage) => ({
      goal, stage: at, enteredWater, targetInWater,
      advanced: Math.round(Math.hypot(b.entity.position.x - start.x, b.entity.position.z - start.z) * 100) / 100,
      ...(targetOnEdge ? { targetOnEdge: true } : {}),
      ...(targetCellName ? { targetCellName } : {}),
    });
    // 失败时把“为什么过不去”的实测事实交回：头顶挡块、附近开阔水面、目标相对偏移。
    // 只报告，不选路、不挖不垫；下一步由调用方决定。
    // 封顶只认「头部往上到第一个实心块之间连一格空气都没有」：桥下的空气间隙能让头浮上去换气，
    // 不能因为上方几格有个桥面就判成封顶。
    const blockedAboveAt = (p: any) => {
      const headY = Math.floor(p.y + (b.entity.eyeHeight ?? 1.62));
      for (let y = headY; y <= headY + 3; y++) {
        const blk = b.blockAt(new Vec3(p.x, y, p.z));
        if (!blk) return null; // 未加载不能证明封顶
        if (AIR_BLOCKS.has(blk.name)) return null;
        if (!fluid(blk)) return { x: Math.floor(p.x), y, z: Math.floor(p.z), name: blk.name };
      }
      return null;
    };
    const obstacleFacts = () => {
      const p = b.entity.position;
      const blockedAbove = blockedAboveAt(p);
      const open = (blk: any) => !!blk && (AIR_BLOCKS.has(blk.name) || water(blk));
      const dirs: [string, number, number][] = [['E', 1, 0], ['W', -1, 0], ['S', 0, 1], ['N', 0, -1], ['SE', 1, 1], ['SW', -1, 1], ['NE', 1, -1], ['NW', -1, -1]];
      const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
      let openWater: { x: number; y: number; z: number; dir: string; dist: number } | null = null;
      for (let d = 1; d <= 3 && !openWater; d++) for (const [dir, dx, dz] of dirs) {
        const x = fx + dx * d, z = fz + dz * d;
        const feet = b.blockAt(new Vec3(x, fy, z));
        if (feet && water(feet) && open(b.blockAt(new Vec3(x, fy + 1, z))) && open(b.blockAt(new Vec3(x, fy + 2, z)))) {
          openWater = { x, y: fy, z, dir, dist: d };
          break;
        }
      }
      return {
        ...(destination ? { targetDelta: { x: Math.round((destination.x - p.x) * 100) / 100, y: Math.round((destination.y - p.y) * 100) / 100, z: Math.round((destination.z - p.z) * 100) / 100 } } : {}),
        ...(blockedAbove ? { blockedAbove } : {}),
        ...(openWater ? { openWater } : {}),
      };
    };
    // 最后一次仍属于本动作的冻结样本（克隆坐标，不保留可变 Vec 引用；observedAt 记录本次采样的真实时刻）。
    // 取消/超时后不能再读 b.entity——替换任务或新连接可能已经更新它，把它当作旧动作的 partial 会把新主人的位置/氧气张冠李戴。
    let lastOwned: { pos: { x: number; y: number; z: number }; oxygen: number; surfaced: boolean; observedAt: number; stage: SwimStage } = { pos: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z }, oxygen: ownOxygen(b), surfaced: false, observedAt: Date.now(), stage };
    check();
    b.clearControlStates();
    try {
      while (Date.now() < end) {
        check();
        const p = b.entity.position;
        const distance = destination ? Math.hypot(destination.x - p.x, destination.z - p.z) : 0;
        const dry = dryFooting();
        const wet = feetInWater();
        if (wet || headUnder()) enteredWater = true;
        // 头稳定露出空气（不管有没有指定目标）：这是本次已观察到的部分事实，未到岸/超时也要保留。
        if (headOut()) surfacedSince ??= Date.now();
        else surfacedSince = null;
        // 阶段只描述身体现在在哪一步（进水前的接近、已入水、离水但未确认上岸）；到达仍由目标本身的完成条件确认。
        stage = dry && enteredWater ? 'exiting' : enteredWater ? 'swimming' : 'approach';
        if (goal === 'dry_shore') {
          // 指定干岸：必须在目标容差内、离水后站稳并持续稳定；途中任意干地/浅滩不算。
          if (dry && atTarget()) {
            drySince ??= Date.now();
            if (Date.now() - drySince >= 600) return { ok: true, landed: true, surfaced: surfacedNow(), oxygen: ownOxygen(b), ...facts('landed') };
          } else drySince = null;
        } else if (goal === 'surface_target') {
          // 指定水中点：到点且仍在水里并持续稳定即可完成；不强制上岸，也不把露头当到达。
          if (wet && atTarget()) {
            wetSince ??= Date.now();
            if (Date.now() - wetSince >= 600) return { ok: true, landed: false, surfaced: surfacedNow(), oxygen: ownOxygen(b), ...facts('surface_reached') };
          } else wetSince = null;
        }
        // 冻结本次仍拥有控制权时观察到的位置/氧气/露头状态（在后续 await 之前，避免迟到重采样读到新主人状态）。
        lastOwned = { pos: { x: p.x, y: p.y, z: p.z }, oxygen: ownOxygen(b), surfaced: surfacedNow(), observedAt: Date.now(), stage };
        // 垂直上浮模式（无目标）：头稳定离开流体、并且憋气已实际回升到可用的程度才算完成换气；
        // 只露一下头就返回会松开 jump 重新下沉，下一次思考的几秒又耗光。仍未上岸由 landed:false 如实表达。
        if (goal === 'surface_ascent' && surfacedNow() && ownOxygen(b) >= breathTarget) return { ok: true, landed: false, surfaced: true, oxygen: ownOxygen(b), ...facts('surfaced') };
        // 纯上浮时头顶连一格空气都没有（blockedAboveAt 只认真封顶）：按 jump 不会让头穿过方块。
        // 约 1.2 秒仍没浮出就尽快交回阻挡事实，别把整段上浮预算耗在不可能的上浮上；挖开/换方向由调用方决定。
        if (goal === 'surface_ascent' && Date.now() - lastProgress >= 1200) {
          const blocked = blockedAboveAt(p);
          if (blocked) return { ok: false, reason: 'SWIM_NO_PROGRESS', landed: false, surfaced: surfacedNow(), oxygen: ownOxygen(b), ...facts(stage), ...obstacleFacts() };
        }
        // 只在需要上升时按跳：目标在水里且不高于脚时松开，身体才会沉到目标深度；无目标（上浮）保持上浮。
        // 人出水但还没落稳时不按，避免落地那一刻又起跳。只在需要爬岸（目标在上方）时保持向前借撞岸上抬。
        const needUp = !destination || destination.y > p.y + 0.35;
        b.setControlState('jump', !dry && needUp && (!!b.entity.isInWater || headUnder()));
        b.setControlState('sprint', false);
        // 离目标还有水平距离就向前：干岸上要先走进水里（不游泳也要迈步），不能只在 !dry 时才前进，否则两岸间隔的水永远过不去。
        // 已经很近但目标在上方时也保持向前，借水里撞岸的那一下爬上去。
        const needForward = !!destination && (distance > 0.35 || (!dry && destination.y > p.y + 0.5));
        if (needForward) {
          const rem = remaining();
          if (rem < MIN_WAIT_MS) break;
          try {
            await this.afterAction(() => raceAbort(b.look(Math.atan2(p.x - destination!.x, p.z - destination!.z), 0, true), signal, rem, () => {}), check);
          } catch (e) {
            if (e instanceof TimeoutError && rem < MIN_TICK_WAIT_MS) break;
            throw e;
          }
          // 转头可能刚好把预算耗尽：不写 forward、不进入下一段等待，按超时结束。
          if (remaining() < MIN_WAIT_MS) break;
          b.setControlState('forward', true);
        } else b.setControlState('forward', false);
        // 进度按三维距离是否更接近目标计算：目标在上方时，沿水柱上升是真实推进；上下浮动不会刷新最近距离。
        // 水平净位移仍单独记在 advanced 里，供调用方核对。
        if (destination) {
          const d3 = distanceToTarget(p);
          if (d3 < bestTargetDistance - 0.3) { bestTargetDistance = d3; lastProgress = Date.now(); }
        }
        // 贴着岸往上爬时水平位置本来就不动（靠水里撞墙的上抬一点点爬上去）：多给点时间，别刚贴上岸就算没进展
        const climbingBank = !!b.entity.isCollidedHorizontally && distance <= 1.6;
        // 完成条件本身已经满足时由上面的分支收尾；其余情况（水里到不了、干地但没进目标格）同样算停滞。
        const inCompletionState = atTarget() && (goal === 'dry_shore' ? dry : goal === 'surface_target' ? wet : true);
        if (destination && !inCompletionState && Date.now() - lastProgress >= (climbingBank ? 5000 : 2500)) {
          return { ok: false, reason: 'SWIM_NO_PROGRESS', landed: false, surfaced: surfacedNow(), oxygen: ownOxygen(b), ...facts(stage), ...obstacleFacts() };
        }
        // 每次等待前都确认预算仍够一次有意义的等待：太短的 raceAbort 会先于 tick 触发，
        // 抛出 “timeout after Nms”，把最后一点剩余预算误报成失败原因。直接按预算耗尽返回，
        // 让调用方看到 obstacleFacts 里的真实阻挡事实。
        if (typeof b.waitForTicks === 'function') {
          const rem = remaining();
          if (rem < MIN_WAIT_MS) break;
          // 余量只够一个刻时不要硬等两个刻：100ms 的等待只剩 73ms，raceAbort 先触发，
          // 会把最后一点预算误报成“timeout after 73ms”。末预算里只等一刻，超时按预算耗尽返回。
          const ticks = rem < MIN_TICK_WAIT_MS ? 1 : 2;
          try {
            await this.afterAction(() => raceAbort(b.waitForTicks(ticks), signal, Math.min(2000, rem), () => {}), check);
          } catch (e) {
            if (e instanceof TimeoutError && rem < MIN_TICK_WAIT_MS) break;
            throw e;
          }
        } else {
          const rem = remaining();
          if (rem < MIN_WAIT_MS) break;
          // sleep 本身已经按 rem 截断并响应取消，不再叠一个同长的 raceAbort 定时器抢跑。
          await this.afterAction(() => sleep(Math.min(100, rem), signal), check);
        }
      }
      return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: surfacedNow(), oxygen: ownOxygen(b), ...facts(stage), ...obstacleFacts() };
    } catch (e) {
      // 取消/超时（AbortedError/TimeoutError）也要带回最后一次拥有的冻结样本，不重读可能已被替换的 b.entity。
      if (e instanceof Error && (e.name === 'AbortedError' || e.name === 'TimeoutError')) {
        (e as Error & { partial?: Record<string, unknown> }).partial = { landed: false, surfaced: lastOwned.surfaced, pos: lastOwned.pos, oxygen: lastOwned.oxygen, observedAt: lastOwned.observedAt, goal, stage: lastOwned.stage, enteredWater, targetInWater };
      }
      throw e;
    } finally {
      // 取消/超时后只释放本动作拥有的 3 个控制键（jump、forward、sprint）；替换任务已由 stopAll 接管。
      if (epoch === this.actionEpoch && b === this.bot) {
        b.setControlState('jump', false); b.setControlState('forward', false); b.setControlState('sprint', false);
      }
    }
  }

  // ---------------------------------------------------------------- 通用基础动作
  private async equipNamed(name: string, check: (() => void) & { signal?: AbortSignal }) {
    await this.interactionReady();
    check();
    const it = this.bot.inventory.items().find((i: any) => i.name === name);
    if (!it) return false;
    if (this.bot.heldItem?.name !== name) await this.afterAction(() => this.bot.equip(it, 'hand'), check);
    return true;
  }

  private async placeItemAgainst(item: string, reference: any, check: (() => void) & { signal?: AbortSignal }): Promise<ActionResult & { placed?: Vec3Like }> {
    const b = this.bot, count = () => b.inventory.items().filter((it: any) => it.name === item).reduce((sum: number, it: any) => sum + it.count, 0);
    const empty = (pos: any) => ['air', 'cave_air', 'void_air'].includes(b.blockAt(pos)?.name);
    const topOnly = /_(bed|door)$/.test(item);
    const face = (topOnly ? [[0, 1, 0]] : [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]])
      .map(([x, y, z]) => this.vec({ x, y, z })).find((side) => {
        const dest = reference.position.plus(side), p = b.entity.position;
        const overlapsPlayer = dest.x < p.x + 0.3 && dest.x + 1 > p.x - 0.3 && dest.z < p.z + 0.3 && dest.z + 1 > p.z - 0.3 && dest.y < p.y + 1.8 && dest.y + 1 > p.y;
        return empty(dest) && !overlapsPlayer && (!item.endsWith('_door') || empty(dest.offset(0, 1, 0))) && this.canClickPlacementFace(reference, side);
      });
    if (!face) return { ok: false, reason: 'NO_PLACEMENT_FACE:看不见可点击且有空位的放置面，换个站位或目标方块', effectEvidence: { verified: true, changed: false, reasons: ['没有可点击的空置面，未发送放置动作'] } };
    const dest = reference.position.plus(face), beforeCount = count();
    const matches = () => {
      const at = b.blockAt(dest), properties = at?.getProperties?.() ?? {};
      const aliases = [item, item.replace(/torch$/, 'wall_torch'), item.replace(/_sign$/, '_wall_sign'), item.replace(/_hanging_sign$/, '_wall_hanging_sign')];
      if (!at || !aliases.includes(at.name)) return false;
      if (item.endsWith('_door')) {
        const upper = b.blockAt(dest.offset(0, 1, 0));
        const upperProperties = upper?.getProperties?.() ?? {};
        return properties.half === 'lower' && upper?.name === item && upperProperties.half === 'upper'
          && ['facing', 'hinge', 'open'].every((key) => String(upperProperties[key]) === String(properties[key]));
      }
      if (item.endsWith('_bed')) {
        const offset = ({ north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] } as Record<string, number[]>)[String(properties.facing)];
        const head = offset && b.blockAt(dest.offset(offset[0], 0, offset[1]));
        return properties.part === 'foot' && head?.name === item && head.getProperties?.().part === 'head' && head.getProperties?.().facing === properties.facing;
      }
      return true;
    };
    await this.afterAction(() => raceAbort(b.placeBlock(reference, face), check.signal, 5000, () => {}), check);
    const confirmed = await this.waitForInteraction(() => matches() && count() < beforeCount, check);
    const reasons = [...(matches() ? [`${item} 已出现在 ${dest.x},${dest.y},${dest.z}${topOnly ? ' 且两部分完整' : ''}`] : []), ...(count() < beforeCount ? [`背包 ${item} 减少 ${beforeCount - count()}`] : [])];
    const effectEvidence = { verified: true, changed: reasons.length > 0, reasons: reasons.length ? reasons : ['放置后预期方块与物品消耗均未出现'] };
    if (!confirmed) return { ok: false, reason: matches() ? 'PLACEMENT_INVENTORY_UNCHANGED:没有确认放置物品的消耗' : 'PLACEMENT_NOT_CONFIRMED:目标位置没有出现完整的预期方块', effectEvidence };
    return { ok: true, placed: { x: dest.x, y: dest.y, z: dest.z }, effectEvidence };
  }

  /** 等转头真的发给服务器（下一个物理刻才发）；“对着看的方向用物品”的动作要在这之后 */
  private async lookSynced() {
    const b = this.bot;
    if (typeof b.waitForTicks === 'function') await b.waitForTicks(2);
    else await sleep(120);
  }

  async useItemOn(item: string, target: { kind: 'block'; pos: Vec3Like } | { kind: 'self' }, signal: AbortSignal): Promise<ActionResult & { spawned?: string; placed?: Vec3Like }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    if (!(await this.equipNamed(item, check))) return { ok: false, reason: `NO_ITEM:${item}` };
    try {
      if (target.kind === 'self') {
        // 原始使用完成不代表已确认玩法效果；只记录与该物品关联的变化，不把附带拾取当作使用证据。
        const before = this.invCountOf(item);
        const containers = item === 'bucket' ? ['water_bucket', 'lava_bucket', 'milk_bucket'] : ['water_bucket', 'lava_bucket'].includes(item) ? ['bucket'] : [];
        const beforeContainers = containers.map((name) => ({ name, count: this.invCountOf(name) }));
        await this.afterAction(async () => { b.activateItem(); await sleep(400, signal); b.deactivateItem(); }, check);
        const consumed = before - this.invCountOf(item);
        const received = beforeContainers.filter(({ name, count }) => this.invCountOf(name) > count);
        const changed = consumed > 0 && (!containers.length || received.length > 0);
        const reasons = [
          ...(consumed > 0 ? [`背包 ${item} 减少 ${consumed}`] : []),
          ...received.map(({ name, count }) => `背包 ${name} 增加 ${this.invCountOf(name) - count}`),
          ...(!changed ? [`已沿当前准星使用 ${item}，效果未确认`] : []),
        ];
        return { ok: true, effectEvidence: { verified: changed, changed, reasons } };
      }
      const block = b.blockAt(this.vec(target.pos));
      if (!block) return { ok: false, reason: 'NO_BLOCK' };
      // 树苗右键的落点由命中方块的顶面/侧面决定：先按物品确认目标方块是可种土壤（黏土只对红树苗有效），
      // 不是土壤就直接报 BAD_SUPPORT，不要发出去后只收到泛化的 PLACEMENT_NOT_CONFIRMED。
      if (isTreeSaplingItem(item) && !saplingSoilFor(item).has(block.name)) {
        return { ok: false, reason: `BAD_SUPPORT:${item} 不能种在 ${block.name} 上，只能种在${saplingSoilText(item)}上`, effectEvidence: { verified: true, changed: false, reasons: [`目标方块 ${block.name} 不是 ${item} 的可种土壤，未发送放置动作`] } };
      }
      if (this.mcData.blocksByName?.[item]) return await this.placeItemAgainst(item, block, check);
      if (/_boat$|_raft$/.test(item)) {
        // 放船/筏：船/筏是实体不是方块，服务器只认“右键用物品”（use_item）才落船，发 block_place（放方块）对它无效，
        // 所以不能走 placeBlock/_genericPlace。准星得先落在水面那一格的顶面上；转头包和 use_item 之间偶有竞态，落船实体
        // 也可能因区块/时序没进 b.entities。这里强制看向水面、多等 tick 再发 use_item，一次没确认就再试（最多 3 次），
        // 并同时核对背包是否扣船——扣了就算放成了。
        const ids = new Set(Object.keys(b.entities ?? {}));
        const count = () => (b.inventory.items() as InvItem[]).filter((held) => held.name === item).reduce((sum, held) => sum + held.count, 0);
        const before = count();
        const appeared = () => Object.values(b.entities ?? {}).find((en: any) => !ids.has(String(en.id))
          && /(^|_)(boat|raft)$/.test(String(en.name)) && en.position.distanceTo(block.position) < 4);
        // 水面没有碰撞形状（boundingBox=empty），通用 raycast 会直接穿过水格；船必须右键水面本身，所以给水面格补一个
        // 液面形状，再按与 placeItemAgainst/放桶路径相同的「current-view 射线首先命中目标」口径判断。不能只看 lookAt 是否发出。
        const boatSurface = (candidate: Block, ray: iterators.RaycastIterator) => {
          if (candidate.name !== 'water' && candidate.name !== 'bubble_column') return !!ray.intersect(candidate.shapes, candidate.position);
          const above = b.blockAt(candidate.position.offset(0, 1, 0));
          const surface = above?.name === candidate.name ? 1 : 8 / 9;
          return !!ray.intersect([...candidate.shapes, [0, 0, 0, 1, surface, 1]], candidate.position);
        };
        const raycastAvailable = typeof b.world?.raycast === 'function';
        const viewHitsSurface = () => {
          // this.ready 已保证 bot.entity（含 Vec3 position）存在，下面的失败归因也直接读它。
          // 没有真实射线接口时退回同一套放置面口径（距离/眼位）：只能证明位置可达，视线未验证；
          // 不能把“不知道视线”说成“视线预检通过”。
          if (!raycastAvailable) return this.canClickPlacementFace(block, new Vec3(0, 1, 0), undefined, true);
          const from = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
          const view = new Vec3(-Math.sin(b.entity.yaw) * Math.cos(b.entity.pitch), Math.sin(b.entity.pitch), -Math.cos(b.entity.yaw) * Math.cos(b.entity.pitch));
          return b.world.raycast(from, view, 4.4, boatSurface)?.position.equals(block.position) === true;
        };
        const where = (v: { x: number; y: number; z: number }) => `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;
        let sent = 0, entity: any = null;
        for (let attempt = 0; attempt < 3 && !entity && count() === before; attempt++) {
          // 原版液面高度是 y+8/9≈0.888，不是 y+1：瞄 y+1 时射线在目标水格中心前就高于液面，会 MISS。
          // 与放桶路径同一口径，瞄略低于液面的 0.85，保证预检和真实 use_item 落在同一方向。
          await this.afterAction(() => b.lookAt(block.position.offset(0.5, 0.85, 0.5), true), check);
          await this.afterAction(() => this.lookSynced(), check);
          // 预检只拒绝当前委托：不换水面、不移动、不换物品；未命中立刻返回，不空转等 3 秒。
          if (!viewHitsSurface()) {
            const feet = b.entity.position, eye = feet.offset(0, b.entity.eyeHeight ?? 1.62, 0);
            const feetName = b.blockAt(feet)?.name ?? '未知';
            const inWater = !!b.entity?.isInWater || feetName === 'water' || feetName === 'bubble_column';
            const sentText = sent ? `此前已发送 ${sent} 次使用动作均未确认新船实体，本轮未发送` : '未发送使用动作';
            const missText = raycastAvailable ? '实际视线未命中目标水面' : '位置/眼位回退校验未通过（无 raycast 能力，视线未验证）';
            return { ok: false, reason: `NO_PLACEMENT_FACE:使用前${missText}，${sentText}`, effectEvidence: { verified: true, changed: false, reasons: [
              `${missText}，${sentText}`,
              `目标格 ${where(block.position)} 是 ${block.name}（上方 ${b.blockAt(block.position.offset(0, 1, 0))?.name ?? '未知'}）`,
              `实测位置 ${where(feet)}，眼位 ${where(eye)}，脚下方块 ${feetName}，inWater=${inWater}`,
            ] } };
          }
          sent++;
          // 用 mineflayer 的 activateItem 发 use_item：1.19+ 的包必须带 sequence（手写 {hand} 缺字段）；船是瞬时使用，随即松开。
          await this.afterAction(async () => { b.swingArm('right'); b.activateItem(); b.deactivateItem(); }, check);
          await this.waitForInteraction(() => !!appeared(), check, 1000);
          entity = appeared();
        }
        const consumed = before - count();
        const reasons = [
          raycastAvailable
            ? `视线预检通过后发送使用动作 ${sent} 次`
            : `无 raycast 能力：仅通过位置/眼位回退校验（视线未验证）后发送使用动作 ${sent} 次`,
          `背包 ${item} 数量 ${before}→${before - consumed}`,
          ...(entity ? [`服务器返回新实体 ${entity.name}`] : ['没有出现新船实体']),
        ];
        const changed = !!entity || consumed > 0;
        if (!changed) return { ok: false, reason: 'ENTITY_NOT_SPAWNED:多次放置后没有确认新船实体，背包里的船也未减少', effectEvidence: { verified: true, changed: false, reasons } };
        return { ok: true, spawned: entity?.name ?? item, effectEvidence: { verified: true, changed, reasons } };
      }
      // Other entity items use their block-face placement API.
      if (/_spawn_egg$|^armor_stand$|^end_crystal$/.test(item)) {
        const ids = new Set(Object.keys(b.entities ?? {}));
        let entity: any;
        try { entity = await this.afterAction(() => raceAbort(b.placeEntity(block, new Vec3(0, 1, 0)), signal, 6000, () => {}), check); }
        catch (e) {
          if (e instanceof AbortedError) throw e;
          // mineflayer 等实体出现时，只要先冒出别的实体（掉落物、怪）就不再等了，会误报放置失败：自己再看一眼
          entity = Object.values(b.entities ?? {}).find((en: any) => !ids.has(String(en.id)) && /boat|raft|armor_stand|end_crystal/.test(String(en.name)) && en.position.distanceTo(block.position) < 4);
          if (!entity) throw e;
        }
        if (typeof (entity as any)?.id !== 'number') return { ok: false, reason: 'ENTITY_NOT_SPAWNED:没有确认放置的实体出现', effectEvidence: { verified: false, changed: false, reasons: ['放置API未返回实际实体'] } };
        return { ok: true, spawned: (entity as any)?.name ?? item, effectEvidence: { verified: true, changed: true, reasons: [`服务器返回新实体 ${(entity as any)?.name ?? item}`] } };
      }
      if (/_minecart$|^minecart$/.test(item)) {
        const ids = new Set(Object.keys(b.entities ?? {}));
        await this.afterAction(() => b.activateBlock(block), check);
        const appeared = await this.waitForInteraction(() => Object.values(b.entities ?? {}).some((entity: any) => !ids.has(String(entity.id)) && /minecart/.test(entity.name) && entity.position.distanceTo(block.position) < 3), check);
        return appeared ? { ok: true, spawned: 'minecart', effectEvidence: { verified: true, changed: true, reasons: ['目标附近实际出现新矿车'] } } : { ok: false, reason: 'ENTITY_NOT_SPAWNED:没有确认矿车出现', effectEvidence: { verified: true, changed: false, reasons: ['未出现新矿车'] } };
      }
      if (item === 'bucket' && ['water', 'lava'].includes(block.name)) {
        if (Number(block.getProperties().level) !== 0) return { ok: false, reason: 'NOT_SOURCE:指定流体不是源方块' };
        const from = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
        if (typeof b.world?.raycast !== 'function') return { ok: false, reason: 'TARGET_NOT_CONFIRMED:当前无法确认流体源的射线' };
        // SOURCE_ONLY 也会命中含水方块和水生植物中的水源，不只是名为 water 的格子。
        const waterSources = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);
        const fluidAt = (cell: Block | null) => {
          if (!cell) return null;
          if (cell.name === 'water' || cell.name === 'lava') return { name: cell.name, source: Number(cell.getProperties().level) === 0 };
          return cell.getProperties().waterlogged === true || waterSources.has(cell.name) ? { name: 'water', source: true } : null;
        };
        const sourceOrBlock = (candidate: Block, ray: iterators.RaycastIterator) => {
          const fluid = fluidAt(candidate);
          const height = fluid && fluidAt(b.blockAt(candidate.position.offset(0, 1, 0)))?.name === fluid.name ? 1 : 8 / 9;
          // 保留实心部分：含水顶半砖等实体形状可能高于液面；流水自身不挡源射线。
          return !!ray.intersect(fluid?.source ? [...candidate.shapes, [0, 0, 0, 1, height, 1]] : candidate.shapes, candidate.position);
        };
        // 同一指定源格尝试有限候选瞄准点（液面→中心→略低），按真实射线选第一个能首先命中源的点。
        // 顶部封石时液面被挡、中心被前方半砖挡等不同遮挡下各有适用的瞄准高度，不能单一朝液面或强制朝中心。
        // 距离按候选点判断，不能先用源中心做预检：中心可能超 4.4 而液面候选仍在交互范围内。
        let anyInRange = false;
        const aim = [0.85, 0.5, 0.3]
          .map((dy) => block.position.offset(0.5, dy, 0.5))
          .find((candidate) => {
            const direction = candidate.minus(from), distance = direction.norm();
            if (distance > 4.4 || distance < 0.01) return false;
            anyInRange = true;
            return b.world.raycast(from, direction.normalize(), distance + 0.05, sourceOrBlock)?.position.equals(block.position) === true;
          });
        if (!aim) {
          return anyInRange
            ? { ok: false, reason: 'TARGET_NOT_CONFIRMED:视线不能首先命中指定流体源，未发送使用动作' }
            : { ok: false, reason: 'OUT_OF_RANGE:指定流体源不在交互范围内' };
        }
        const filled = `${block.name}_bucket`, beforeEmpty = this.invCountOf('bucket'), beforeFilled = this.invCountOf(filled);
        await this.afterAction(() => b.lookAt(aim, true), check);
        await this.afterAction(() => this.lookSynced(), check);
        // 等待转头同步期间可能被水流推走。使用当前眼位和真实准星，不能重算一条尚未转向的理想射线。
        const currentEye = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
        const view = new Vec3(-Math.sin(b.entity.yaw) * Math.cos(b.entity.pitch), Math.sin(b.entity.pitch), -Math.cos(b.entity.yaw) * Math.cos(b.entity.pitch));
        const currentHit = b.world.raycast(currentEye, view, 4.4, sourceOrBlock);
        if (!currentHit?.position.equals(block.position)) return { ok: false, reason: 'TARGET_NOT_CONFIRMED:使用前实际视线已不能命中指定流体源，未发送使用动作' };
        await this.afterAction(async () => { b.activateItem(); await sleep(250, signal); b.deactivateItem(); }, check);
        const converted = await this.waitForInteraction(() => this.invCountOf('bucket') < beforeEmpty && this.invCountOf(filled) > beforeFilled, check);
        const spent = beforeEmpty - this.invCountOf('bucket'), gained = this.invCountOf(filled) - beforeFilled;
        const reasons = [...(spent > 0 ? [`背包 bucket 减少 ${spent}`] : []), ...(gained > 0 ? [`背包 ${filled} 增加 ${gained}`] : [])];
        const effectEvidence = { verified: true, changed: reasons.length > 0, reasons: reasons.length ? reasons : ['没有确认桶的容器转换'] };
        return converted ? { ok: true, effectEvidence } : { ok: false, reason: 'COLLECTION_NOT_CONFIRMED:没有确认空桶转成对应流体桶', effectEvidence };
      }
      // 对着液体用（水桶装水/倒水等）：先看向液面再“使用物品”；其他情况按“对方块右键”
      const fluid = ['water', 'lava'].includes(block.name);
      const changed = this.blockInteractionChange(block);
      await this.afterAction(() => b.lookAt(block.position.offset(0.5, fluid ? 0.85 : 0.5, 0.5), true), check);
      if (fluid) await this.afterAction(() => this.lookSynced(), check);
      if (fluid) await this.afterAction(async () => { b.activateItem(); await sleep(250, signal); b.deactivateItem(); }, check);
      else await this.afterAction(() => b.activateBlock(block), check);
      return await this.waitForInteraction(changed, check)
        ? { ok: true, effectEvidence: { verified: true, changed: true, reasons: changed.reasons() } }
        : { ok: false, reason: 'NO_EFFECT:目标方块、邻格和背包均未变化', effectEvidence: { verified: true, changed: false, reasons: [`点击格与六邻：${changed.names().join('、')}`, '目标、邻格和背包均未变化'] } };
    } catch (e: any) {
      if (e instanceof AbortedError) throw e;
      return { ok: false, reason: String(e?.message ?? e), effectEvidence: { verified: false, changed: false, reasons: ['交互异常，未能确认效果'] } };
    }
  }

  async interactEntity(entityId: number, item: string | null, signal: AbortSignal): Promise<ActionResult & { mounted?: string }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const ent = b.entities[entityId];
    if (!ent) return { ok: false, reason: 'ENTITY_GONE' };
    if (item && !(await this.equipNamed(item, check))) return { ok: false, reason: `NO_ITEM:${item}` };
    const rideable = /boat|raft|minecart|horse|donkey|mule|pig|strider|camel|llama/.test(String(ent.name));
    try {
      await this.afterAction(() => b.lookAt(ent.position.offset(0, (ent.height ?? 1) * 0.5, 0), true), check);
      if (rideable && !item) {
        const mounted = new Promise<boolean>((resolve) => {
          const t = setTimeout(() => { b.off('mount', on); resolve(false); }, 2500);
          const on = () => { clearTimeout(t); resolve(true); };
          b.once('mount', on);
        });
        b.mount(ent);
        const ok = await this.afterAction(() => mounted, check);
        if (ok && /boat|raft/.test(String(ent.name))) {
          // 坐在船里时不再模拟玩家自己的重力/碰撞（船的位置由 ride 推进）；下船后恢复
          b.physicsEnabled = false;
          b.once('dismount', () => { b.physicsEnabled = true; });
        }
        return ok ? { ok: true, mounted: String(ent.name) } : { ok: false, reason: 'MOUNT_FAILED' };
      }
      if (!item) {
        await this.afterAction(() => b.activateEntity(ent), check);
        return { ok: true };
      }
      // 拿着东西右键生物：喂食、繁殖、剪毛、挤奶、上鞍、命名……是否真起作用要看得见的反馈：
      // 背包变了（东西用掉/换成别的/工具磨损），或者对方冒出爱心、开始驯服之类的动静
      const sig = () => this.state().inventory.map((i) => `${i.name}:${i.count}:${i.durability?.left ?? ''}`).sort().join('|');
      const countOf = (n: string) => this.state().inventory.filter((i) => i.name === n).reduce((t, i) => t + i.count, 0);
      const before = sig(), heldBefore = countOf(item);
      const statuses: number[] = [];
      const onStatus = (pk: any) => { if (pk?.entityId === entityId) statuses.push(Number(pk.entityStatus)); };
      b._client.on('entity_status', onStatus);
      try {
        await this.afterAction(() => b.activateEntity(ent), check);
        for (let i = 0; i < 8 && sig() === before && !statuses.length; i++) await sleep(100, signal);
        await sleep(150, signal);
      } finally { b._client.off('entity_status', onStatus); }
      const reasons: string[] = [];
      const used = heldBefore - countOf(item);
      if (used > 0) reasons.push(`背包里的 ${item} 少了 ${used} 个`);
      else if (sig() !== before) reasons.push('背包有变化');
      // 原版 EntityEvent：18 冒爱心（进入求偶），6/7 驯服失败/成功（冒烟/冒心）
      if (statuses.includes(18)) reasons.push(`${ent.name} 冒出了爱心`);
      if (statuses.includes(7)) reasons.push(`${ent.name} 被驯服了`);
      if (statuses.includes(6)) reasons.push(`${ent.name} 冒烟（这次没驯服成）`);
      if (!reasons.length) return { ok: false, reason: `NO_EFFECT:拿着 ${item} 右键了 ${ent.name}，背包和它都没有反应`, effectEvidence: { verified: true, changed: false, reasons: ['背包未变化，对方也没有可见反应'] } };
      return { ok: true, effectEvidence: { verified: true, changed: true, reasons } };
    } catch (e: any) {
      if (e instanceof AbortedError) throw e;
      return { ok: false, reason: String(e?.message ?? e) };
    }
  }

  /** 自己扔掉的东西：落点和时间，3 分钟内落点 6 格以内的同名掉落物算“自己刚扔的” */
  private discarded: { name: string; pos: Vec3Like; ts: number }[] = [];
  private markDiscarded(name: string, pos: Vec3Like) {
    const now = Date.now();
    this.discarded = this.discarded.filter((d) => now - d.ts < DISCARD_MS).concat({ name, pos, ts: now }).slice(-32);
  }
  isDiscarded(item: string, pos: Vec3Like): boolean {
    const name = item.replace(/^item:/, ''), now = Date.now();
    return this.discarded.some((d) => d.name === name && now - d.ts < DISCARD_MS && Math.hypot(d.pos.x - pos.x, d.pos.y - pos.y, d.pos.z - pos.z) <= 6);
  }
  forgetDiscarded(item: string) { this.discarded = this.discarded.filter((d) => d.name !== item.replace(/^item:/, '')); }

  /** 正在进行的 dig()：目标与开始时间；完成回调按位置匹配后填实测 ms，其它挖法拿不到它 */
  private digStart: { pos: Vec3Like; ts: number; tool: string | null } | null = null;
  private dugLog: { pos: Vec3Like; name: string; ts: number; tool: string | null; ms: number }[] = [];
  recentDug(since: number) { return this.dugLog.filter((d) => d.ts > since); }

  private placedLog: { pos: Vec3Like; name: string; ts: number; status: 'attempted' | 'confirmed' }[] = [];
  recentPlaced(since: number) { return this.placedLog.filter((d) => d.ts > since); }

  /**
   * 读一次目标格，返回实际方块名和是否属于请求材料（含墙上变体）。
   * 这只是一次本地方块读取；上层 primitive 仍以它自己的世界核对为准，两层证据不合并。
   */
  private placementEvidence(target: Vec3Like, itemNames: string[], requested: string) {
    const now = this.bot?.blockAt?.(this.vec(target));
    const placedName = now?.name ? String(now.name) : null;
    const aliases = [
      requested,
      requested.replace(/torch$/, 'wall_torch'),
      requested.replace(/_sign$/, '_wall_sign'),
      requested.replace(/_hanging_sign$/, '_wall_hanging_sign'),
    ];
    const verified = placedName !== null && (itemNames.includes(placedName) || aliases.includes(placedName));
    return { placedName, verified };
  }

  /** status 区分「动作发出」和「已确认目标格出现请求材料」，不能把两者都记成已放置。 */
  private notePlaced(pos: Vec3Like, name: string, status: 'attempted' | 'confirmed') {
    this.placedLog.push({ pos: { x: pos.x, y: pos.y, z: pos.z }, name, ts: Date.now(), status });
    if (this.placedLog.length > 512) this.placedLog.splice(0, this.placedLog.length - 512);
  }

  /** 服务器说某载具的乘客里已经没有自己：清掉残留的 bot.vehicle，恢复物理，补发 dismount（见 connect 里的说明） */
  private syncDismount(b: any, pk: { entityId?: number; passengers?: number[] }) {
    const v = b.vehicle, me = b.entity?.id;
    if (!v || me === undefined || pk?.entityId !== v.id) return;
    if ((pk.passengers ?? []).includes(me)) return;
    this.clearStaleVehicle(b, v);
  }

  private clearStaleVehicle(b: any, v: any) {
    if (b.vehicle !== v) return;
    b.vehicle = null;
    if (Array.isArray(v?.passengers)) {
      const i = v.passengers.indexOf(b.entity);
      if (i !== -1) v.passengers.splice(i, 1);
    }
    if (b.entity && b.entity.vehicle === v) b.entity.vehicle = null;
    b.physicsEnabled = true;
    b.emit('dismount', v);
  }

  async dismount(signal: AbortSignal, opts: { toward?: Vec3Like } = {}): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    if (!b.vehicle) return { ok: false, reason: 'NOT_MOUNTED' };
    if (opts.toward && b.entity?.position) {
      // 原版 Boat.getDismountLocationForPassenger 沿乘客的朝向找落点（船身一侧约 1.3 格），找不到才把人放到船顶上。
      // 坐船时物理关着，mineflayer 不会自己发转头包：这里直接发，等一刻让服务器收到再下船
      const dx = opts.toward.x - b.entity.position.x, dz = opts.toward.z - b.entity.position.z;
      if (Math.hypot(dx, dz) > 0.1) {
        const yaw = Math.atan2(-dx, -dz);
        b.entity.yaw = yaw;
        b.entity.pitch = 0;
        try { b._client.write('look', { yaw: ((Math.PI - yaw) * 180) / Math.PI, pitch: 0, onGround: false }); } catch { /* ignore */ }
        await this.afterAction(() => sleep(100, signal), check);
      }
    }
    const off = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => { b.off('dismount', on); resolve(false); }, 2500);
      const on = () => { clearTimeout(t); resolve(true); };
      b.once('dismount', on);
    });
    const v = b.vehicle;
    b.dismount();
    let ok = await this.afterAction(() => off, check);
    // 兜底：没等到事件，但载具已经不在了，或者服务器已经把人挪到离载具一格多外，说明其实已经下来了
    if (!ok && b.vehicle === v) {
      const gone = !v || !b.entities?.[v.id];
      const apart = !!v?.position && !!b.entity?.position && b.entity.position.distanceTo(v.position) > 1.2;
      if (gone || apart) { this.clearStaleVehicle(b, v); ok = true; }
    }
    if (!ok && !b.vehicle) ok = true;
    // 下乘只以实际乘骑状态确认：事件/兜底都不能在 b.vehicle 仍指向原载具时报成功。
    if (ok && b.vehicle === v) ok = false;
    if (ok) b.physicsEnabled = true;
    return ok ? { ok: true } : { ok: false, reason: 'DISMOUNT_FAILED' };
  }

  /**
   * 操控载具。马、猪等坐骑由服务器计算运动，只需发送方向输入；
   * 船的运动由客户端计算（原版就是这样），Mineflayer 不模拟，所以这里照原版船的运动学自己推进并上报位置：
   * 每刻先乘水的阻力 0.9 再加一点桨力，船头每刻最多转 BOAT_TURN；桨力比原版小，极速约 5.6 格/秒（原版满桨 8 格/秒），
   * 像真人那样不总是满桨：方向差得多时先停桨转向，快到终点时提前收桨滑过去。前方是陆地/方块就停下（靠岸）。
   */
  /** 最近一次自己推进到的船位置（见 ride 里的说明） */
  private lastBoat: { v: any; pos: any; at: number } | null = null;
  async ride(target: { x: number; z: number }, signal: AbortSignal, opts: { timeoutMs: number; stop?: () => boolean; via?: { x: number; z: number }[]; arriveWithin?: number }): Promise<ActionResult & { arrived: boolean; blocked?: boolean; moved: number }> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    if (!this.ready || !b.vehicle) return { ok: false, reason: 'NOT_MOUNTED', arrived: false, moved: 0 };
    const epoch = this.actionEpoch, dimension = this.currentDimension();
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot && dimension === this.currentDimension();
    const v = b.vehicle;
    const start = v.position.clone();
    const end = Date.now() + (Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : 0);
    const isBoat = /boat|raft/.test(String(v.name));
    // 海草、海带长在水里，船照样浮在上面过去
    const water = (blk: any) => !!blk && (['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(blk.name) || String(blk.getProperties?.().waterlogged) === 'true');
    const via = (opts.via ?? []).filter((w) => Number.isFinite(w?.x) && Number.isFinite(w?.z));
    const arriveWithin = Math.max(0.3, opts.arriveWithin ?? 2);
    let leg = 0;
    const passable = (blk: any) => !blk || blk.boundingBox === 'empty';
    // 船速是一个向量（会滑行），船头朝向单独转（转得慢，像真的划船）
    let vx = 0, vz = 0, stuckTicks = 0;
    const rejections: number[] = []; // 服务器不认可、把船拉回的时刻
    let boatYaw = Number.isFinite(v.yaw) ? v.yaw : Math.atan2(-(target.x - v.position.x), -(target.z - v.position.z));
    let lastProgressAt = Date.now(), progressFrom = v.position.clone();
    // 船的位置以自己推进的为准：服务器会把船的移动（rel_entity_move）也广播给坐在船上的人，原版客户端对自己操控的载具忽略这些包，
    // mineflayer 却照样加到 v.position 上——等于每一步走了两遍，还会越滚越快（实测冲到四五十格/秒），船乱冲、冲过头撞岸。
    // 所以这里另存一份位置，每刻覆盖回去；服务器真不认可时会回发 vehicle_move，由 resync 改这份位置
    // 上一段刚划完、还坐在同一条船上：那时迟到的服务器广播也会叠进 v.position，用自己记下的位置
    const lb = this.lastBoat;
    let cur = (isBoat && lb && lb.v === v && Date.now() - lb.at < 30_000 ? lb.pos : v.position).clone();
    if (isBoat) { start.set(cur.x, cur.y, cur.z); progressFrom = cur.clone(); }
    // 服务器不认可上报的位置（撞到东西 / moved wrongly）时会回发 vehicle_move 把船拉回去：
    // 以服务器为准重新同步，否则本地以为在前进、服务器那边船其实没动，越错越远
    const Vec3c = Vec3;
    const resync = (pk: any) => {
      if (!ownsControls() || !isBoat || b.vehicle !== v || !Number.isFinite(pk?.x)) return;
      cur = new Vec3c(pk.x, pk.y, pk.z);
      v.position = cur.clone();
      b.entity.position = new Vec3c(pk.x, pk.y + 0.4, pk.z);
      vx = 0; vz = 0;
      rejections.push(Date.now());
      if (rejections.length > 10) rejections.shift();
    };
    if (isBoat) b._client.on('vehicle_move', resync);
    // Mineflayer stops emitting player physicsTick while mounted, and boats
    // additionally disable player physics here. Vehicle input needs its own
    // cancellable cadence rather than waitForTicks, which would never resolve.
    const tick = () => sleep(Math.max(0, Math.min(50, end - Date.now())), signal);
    let released = false;
    const releaseControls = () => {
      if (released || !ownsControls() || b.vehicle && b.vehicle !== v) return;
      released = true;
      // 只释放本载具实际用到的键：船是 2 个桨（leftPaddle/rightPaddle）；其他坐骑是
      // player_input 的 4 个方向键（forward/backward/left/right）。水面游泳另有 3 键
      // （jump/forward/sprint，见 swimTo 的 finally）：非船坐骑 4 + 游泳 3 共 7 个输入位。
      this.actionContext.exit(() => {
        if (isBoat) {
          try { b._client.write('steer_boat', { leftPaddle: false, rightPaddle: false }); } catch { /* ignore */ }
          if (!b.vehicle) b.physicsEnabled = true;
        }
        try { if (b.vehicle && !isBoat) b.moveVehicle(0, 0); } catch { /* ignore */ }
      });
    };
    // Arbiter aborts before stopAll advances the epoch. Release synchronously
    // while we still own the input, rather than racing the next task's finally.
    signal.addEventListener('abort', releaseControls, { once: true });
    try {
      if (isBoat) b.physicsEnabled = false; // 坐船期间不模拟玩家自身的重力/碰撞（下船时恢复）
      while (Date.now() < end) {
        check();
        if (b.vehicle !== v) return { ok: false, reason: 'DISMOUNTED', arrived: false, moved: cur.distanceTo(start) };
        if (opts.stop?.()) return { ok: true, arrived: false, moved: cur.distanceTo(start) };
        if (isBoat) v.position = cur.clone(); // 抹掉两刻之间 mineflayer 叠加上去的服务器广播
        const p = isBoat ? cur : v.position;
        // 依次经过拐点：到拐点 1 格内就转向下一个
        while (leg < via.length && Math.hypot(via[leg].x - p.x, via[leg].z - p.z) <= 1.5) leg++;
        const goal = leg < via.length ? via[leg] : target;
        const dx = goal.x - p.x, dz = goal.z - p.z, dist = Math.hypot(dx, dz);
        if (leg >= via.length && dist <= arriveWithin) return { ok: true, arrived: true, moved: p.distanceTo(start) };
        const yaw = Math.atan2(-dx, -dz);
        if (!isBoat) {
          await this.afterAction(() => b.look(yaw, 0, true), check);
          b.moveVehicle(0, 1);
          await this.afterAction(tick, check);
          continue;
        }
        // 船头慢慢转向目标（每刻最多 BOAT_TURN）
        const diff = Math.atan2(Math.sin(yaw - boatYaw), Math.cos(yaw - boatYaw));
        const turn = Math.max(-BOAT_TURN, Math.min(BOAT_TURN, diff));
        boatYaw += turn;
        // 划桨：方向差太多先停桨转向；快到终点按滑行距离（速度×9 刻）提前收桨
        const speed = Math.hypot(vx, vz);
        const last = leg >= via.length;
        const rowing = Math.abs(diff) < BOAT_ROW_ANGLE && (!last || dist > speed * 9 + arriveWithin * 0.5);
        vx *= 0.9; vz *= 0.9; // 水的阻力
        if (rowing) { vx += -Math.sin(boatYaw) * BOAT_THRUST; vz += -Math.cos(boatYaw) * BOAT_THRUST; }
        // 船身（1.375×0.5625）在 (x,z) 处会不会碰到方块：四角、四边中点和中心，船底和船舷两个高度。
        // 服务器按整个船身做碰撞，只看船头正前方一个点的话，侧面蹭到岸角会被服务器一刻刻拉回（卡在角上不动）
        const HALF = 0.69;
        const hits = (x: number, z: number) => {
          for (const ox of [-HALF, 0, HALF]) for (const oz of [-HALF, 0, HALF]) for (const oy of [0.05, 0.5]) {
            const blk = b.blockAt(new Vec3(x + ox, p.y + oy, z + oz));
            if (!passable(blk) && !water(blk) && blk?.name !== 'lily_pad') return true;
          }
          return false;
        };
        // 像原版的碰撞一样：撞上就沿着墙滑（只保留没被挡住的那个方向的速度），两边都挡住就停住
        let nx = p.x + vx, nz = p.z + vz;
        let collided = false;
        // 本来就和方块挨着（位置有误差）时不做碰撞，免得一开始就动不了
        if ((Math.abs(vx) > 1e-4 || Math.abs(vz) > 1e-4) && hits(nx, nz) && !hits(p.x, p.z)) {
          collided = true;
          if (!hits(p.x + vx, p.z)) { nz = p.z; vz = 0; }
          else if (!hits(p.x, p.z + vz)) { nx = p.x; vx = 0; }
          else { nx = p.x; nz = p.z; vx = 0; vz = 0; }
        }
        if (Math.hypot(nx - p.x, nz - p.z) > 1e-4) {
          const under = b.blockAt(new Vec3(nx, p.y - 0.2, nz));
          if (!water(under) && !water(b.blockAt(new Vec3(nx, p.y - 1, nz)))) return { ok: true, arrived: false, blocked: true, moved: p.distanceTo(start) }; // 船不能上岸行驶
        }
        // 顶着岸/卡在角上一秒多挪不动，或者服务器接连把船拉回：当作这边过不去，交给上层换路
        stuckTicks = collided && Math.hypot(nx - p.x, nz - p.z) < 0.03 ? stuckTicks + 1 : 0;
        if (stuckTicks >= 25 || rejections.filter((t) => Date.now() - t < 2000).length >= 5) return { ok: true, arrived: false, blocked: true, moved: p.distanceTo(start) };
        // 十秒都没挪开两格（顶着东西、原地打转）：当作走不通，交给上层重新找路
        if (Math.hypot(nx - progressFrom.x, nz - progressFrom.z) > 2) { progressFrom = new Vec3(nx, p.y, nz); lastProgressAt = Date.now(); }
        else if (Date.now() - lastProgressAt > 10000) return { ok: true, arrived: false, blocked: true, moved: p.distanceTo(start) };
        const deg = ((Math.PI - boatYaw) * 180) / Math.PI;
        cur = new Vec3(nx, p.y, nz);
        v.position = cur.clone();
        v.yaw = boatYaw;
        b.entity.position = new Vec3(nx, p.y + 0.4, nz);
        b.entity.yaw = boatYaw;
        // 桨的动画：往前划两支桨都动；只转向时划一边（原版：左桨 = 右转或前进，右桨 = 左转或前进）
        const turningLeft = turn > 1e-3, turningRight = turn < -1e-3;
        await this.afterAction(async () => {
          b._client.write('steer_boat', { leftPaddle: rowing || turningRight, rightPaddle: rowing || turningLeft });
          b._client.write('vehicle_move', { x: nx, y: p.y, z: nz, yaw: deg, pitch: 0 });
        }, check);
        await this.afterAction(tick, check);
      }
      return { ok: false, reason: 'TIMEOUT', arrived: false, moved: cur.distanceTo(start) };
    } finally {
      if (isBoat) {
        if (b.vehicle === v && ownsControls()) { v.position = cur.clone(); b.entity.position = cur.offset(0, 0.4, 0); this.lastBoat = { v, pos: cur.clone(), at: Date.now() }; }
        try { b._client.off('vehicle_move', resync); } catch { /* ignore */ }
      }
      signal.removeEventListener('abort', releaseControls);
      releaseControls();
    }
  }

  /**
   * 钓一次鱼：手持钓鱼竿看向 aim（水面方块）甩竿，mineflayer 的 bot.fish() 在浮漂下沉时自动收竿并 resolve。
   * timeoutMs 内没咬钩就主动收竿（NO_BITE）；浮漂挂到方块/实体上被收回算 CANCELLED。caught = 实际进背包的东西。
   */
  async fish(signal: AbortSignal, opts: { aim?: Vec3Like; timeoutMs: number }): Promise<ActionResult & { caught?: string }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    if (typeof b.fish !== 'function') return { ok: false, reason: 'UNSUPPORTED' };
    if (!(await this.equipNamed('fishing_rod', check))) return { ok: false, reason: 'NO_ROD' };
    const counts = () => {
      const m = new Map<string, number>();
      for (const it of b.inventory.items()) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
      return m;
    };
    const before = counts();
    if (opts.aim) {
      // 瞄准水面上方一点，浮漂抛物线落进水里
      await this.afterAction(() => b.lookAt(new Vec3(opts.aim!.x + 0.5, opts.aim!.y + 1.4, opts.aim!.z + 0.5), true), check);
      // 甩竿是立刻发的，转头要下一刻才到服务器：不等的话浮漂按转头前的方向甩出去（甩到岸上、挂在方块上）
      await this.afterAction(() => this.lookSynced(), check);
    }
    let pending = true;
    const reelIn = () => {
      // 只在手上还是钓鱼竿时收竿：任务已被接管、手上换了东西时右键可能误用别的物品
      if (pending && b === this.bot && b.heldItem?.name === 'fishing_rod') { try { b.activateItem(); } catch { /* ignore */ } }
      pending = false;
    };
    const cast: Promise<void> = b.fish();
    cast.then(() => { pending = false; }, () => { pending = false; });
    try {
      await this.afterAction(() => raceAbort(cast, signal, Math.max(3000, opts.timeoutMs), () => {}), check);
    } catch (e: any) {
      if (e instanceof TimeoutError || e?.name === 'TimeoutError') { reelIn(); return { ok: false, reason: 'NO_BITE' }; }
      if (e instanceof AbortedError || e?.name === 'AbortedError') { reelIn(); throw e; }
      return { ok: false, reason: /cancel/i.test(String(e?.message)) ? 'CANCELLED' : String(e?.message ?? e) };
    }
    // 收竿后鱼要飞过来一会儿才进背包
    const until = Date.now() + 2500;
    let gained: string[] = [];
    while (Date.now() < until) {
      await this.afterAction(() => sleep(150, signal), check);
      const now = counts();
      gained = [...now].filter(([n, c]) => n !== 'fishing_rod' && c > (before.get(n) ?? 0)).map(([n, c]) => (c - (before.get(n) ?? 0) > 1 ? `${n}×${c - (before.get(n) ?? 0)}` : n));
      if (gained.length) break;
    }
    return gained.length ? { ok: true, caught: gained.join('、') } : { ok: true, reason: 'NOT_COLLECTED' };
  }

  chat(text: string) {
    if (!this.ready || !text) return;
    try { this.bot.chat(safeChat(text)); } catch { /* ignore */ }
  }
}

import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import { simplify } from 'prismarine-nbt';
import { crystalArrowShot } from '../combat/ballistics.ts';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';
import { AbortedError, raceAbort, shortId, sleep, throwIfAborted, TimeoutError } from '../util.ts';
import { installClientGuard } from './click-guard.ts';
import { cornerSafe } from './corner-safe.ts';
import { AIR_BLOCKS, attachmentFaces } from '../perception/surroundings.ts';

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
  Optics,
  MoveOpts,
  MoveTarget,
  Vec3Like,
  BossDeathObservation,
  SwimOptions,
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

type PillarClearance = { kind: 'blocked' | 'unknown'; min: Vec3Like; max: Vec3Like };

function describePillarClearance(clearance: PillarClearance): string {
  const { min, max } = clearance;
  const range = `跳跃时身体扫过的方块范围 x=${min.x}..${max.x}, y=${min.y}..${max.y}, z=${min.z}..${max.z}`;
  return clearance.kind === 'blocked'
    ? `头顶跳跃空间受阻；${range}，具体障碍位置和方块名称未确认`
    : `头顶跳跃空间未加载；${range}，具体未加载位置未确认`;
}

class PillarClearanceError extends Error {
  override name = 'PillarClearanceError';
  constructor(clearance: PillarClearance) {
    super(`No path: 原地搭柱${describePillarClearance(clearance)}，未放置方块`);
  }
}

const require = createRequire(import.meta.url);
/**
 * 运行时依赖只在模块加载时取一次。以前 vec() 里每次都 require('vec3')：每次都要走一遍模块解析（运行器的钩子不缓存，
 * 每次都翻 node_modules、读 package.json），blockAt 一秒调用上万次时主线程能卡上 5~10 秒，服务器就以超时踢人（10-28 08:53 采样）
 */
const { Vec3 } = require('vec3');
let pathfinderGoals: any = null;
const goalsLib = () => (pathfinderGoals ??= require('mineflayer-pathfinder').goals);

/** 右键一点就打开、触发的方块：贴着它放东西要按住潜行 */
const OPENS_ON_CLICK = /chest$|barrel|crafting_table|furnace|smoker|_door$|_trapdoor$|_fence_gate$|_button$|lever|_bed$|anvil|enchanting_table|brewing_stand|loom|stonecutter|grindstone|smithing_table|cartography_table|hopper|dispenser|dropper|shulker_box|note_block|jukebox|beacon|lectern|bell|repeater|comparator|cake/;
const isLocalStorage = (name: string) => ['chest', 'trapped_chest', 'barrel'].includes(name) || name.endsWith('shulker_box');

/** Call only with acknowledged container slots, so partial operations remain factual. */
function observeStorage(block: string, items: { name: string; count: number }[], previous?: GuiContainerObservation): GuiContainerObservation {
  const totals = new Map<string, number>();
  items.forEach((item) => totals.set(item.name, (totals.get(item.name) ?? 0) + item.count));
  const after = [...totals].map(([name, count]) => ({ name, count }));
  if (!previous) return { block, before: after, after, put: [], took: [] };
  const before = new Map(previous.after.map((item) => [item.name, item.count]));
  const put = new Map(previous.put.map((item) => [item.name, item.count]));
  const took = new Map(previous.took.map((item) => [item.name, item.count]));
  [...new Set([...before.keys(), ...totals.keys()])].forEach((name) => {
    const delta = (totals.get(name) ?? 0) - (before.get(name) ?? 0);
    if (delta > 0) put.set(name, (put.get(name) ?? 0) + delta);
    if (delta < 0) took.set(name, (took.get(name) ?? 0) - delta);
  });
  return { block, before: previous.before, after, put: [...put].map(([name, count]) => ({ name, count })), took: [...took].map(([name, count]) => ({ name, count })) };
}

const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'creeper', 'spider',
  'cave_spider', 'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker',
  'vex', 'ravager', 'silverfish', 'endermite', 'blaze', 'ghast', 'wither_skeleton', 'guardian',
  'elder_guardian', 'hoglin', 'zoglin', 'piglin_brute', 'warden', 'shulker', 'ender_dragon',
]);
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'wolf', 'bee', 'iron_golem', 'llama', 'panda', 'polar_bear', 'dolphin', 'goat']);
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
  /** 正在进行的底层动作数（afterAction 包着的）；为 0 时才算空闲 */
  private inFlight = 0;
  /** 打断后的“收拾残局”：下一个碰背包/界面的动作要等它做完，免得两边的点击交错 */
  private repairing: Promise<void> | null = null;
  private hygieneTimer: NodeJS.Timeout | null = null;
  private guardedClients = new WeakSet<object>();
  private dragonDeath: BossDeathObservation | null = null;
  private normalMovements: any = null;

  private newSession() {
    this.dragonDeath = null;
    this.spawned = false;
    this.sessionId = shortId('session_');
    this.observationId = 0;
    this.stopAll();
  }

  private currentDimension() {
    return String(this.bot?.game?.dimension ?? 'unknown').replace('minecraft:', '');
  }

  private worldIdentity() { return this.cfg.memory?.worldId || `${this.cfg.mc.host}:${this.cfg.mc.port}`; }

  /** 连着点了多少下界面（两下之间没歇过 1 秒）：慢速版的点击失控保护 */
  private pacedClicks = 0;
  private lastPacedClick = 0;

  /**
   * 界面节奏（UI_PACING_MS / UI_OPEN_HOLD_MS / UI_CLOSE_HOLD_MS）：默认只在窗口开关时短暂停留，不逐次延迟点击。
   * Mineflayer 补丁（scripts/patch-deps.mjs）让 craft / transfer / deposit / withdraw / toss / equip 的点击经过 beforeWindowClick。
   */
  private installUiPacing(bot: any) {
    const ui = this.cfg.ui ?? { pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 };
    bot.beforeWindowClick = async (_slot: number, _button: number, mode: number) => {
      const now = Date.now();
      this.pacedClicks = now - this.lastPacedClick > 1000 ? 1 : this.pacedClicks + 1;
      this.lastPacedClick = now;
      // 点击失控（见 click-guard.ts）：放慢之后循环不再撑爆内存，但也不能让它无休止地点下去
      if (this.pacedClicks > 400) {
        this.pacedClicks = 0;
        this.scheduleRepair('界面点击失控（慢速）', 500);
        throw new Error('CLICK_LOOP: 连续点了 400 下界面还没停（多半是窗口已经关了），中止这次界面操作');
      }
      if (ui.pacingMs <= 0) return;
      // shift 点击是一下整叠移走，真人也点得快些
      const ms = mode === 1 ? Math.round(ui.pacingMs * 0.6) : ui.pacingMs;
      await sleep(ms, this.actionContext.getStore()?.signal);
    };
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

  /** Present inventory clicks as a virtual window, but leave hotbar-only changes invisible. */
  private async withObservedInventory<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const b = this.bot, beforeClick = b.beforeWindowClick;
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
    try { return await operation(); }
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
    const { pathfinder, Movements } = require('mineflayer-pathfinder');
    const { host, port, username, version } = this.cfg.mc;
    this.bus.publish('connect', 'P3', `连接 ${host}:${port} (${version}) 用户名 ${username}`);

    // 向服务器请求尽可能大的视距；服务器会按 view-distance 截断
    const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline', viewDistance: 32 });
    this.bot = bot;
    this.guardPrePlayWrites(bot);
    bot.loadPlugin(pathfinder);
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
    // 自己挖掉的每一格（不管是哪个动作、代码技能还是寻路挖的）：记自己挖过的通道用
    bot.on('diggingCompleted', (block: any) => {
      try {
        if (!block?.position) return;
        this.dugLog.push({ pos: { x: block.position.x, y: block.position.y, z: block.position.z }, name: String(block.name ?? ''), ts: Date.now() });
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
      if (!bot.__agentMovementsSet) {
        const mv = new Movements(bot);
        mv.canDig = true;
        mv.allowSprinting = true;
        // 跑酷跳跃对起跳位置极其敏感：起点不在格子中心就跳不上去，人会卡在方块边上来回抖。普通走路只跳一格台阶。
        mv.allowParkour = false;
        mv.allow1by1towers = true;
        // 垫脚/搭路用的方块：除了默认的泥土圆石，也用其他常见石头（不用木板原木，免得烧掉建材）
        for (const n of ['cobbled_deepslate', 'netherrack', 'andesite', 'granite', 'diorite', 'stone', 'deepslate', 'tuff']) {
          const it = this.mcData.itemsByName[n];
          if (it && !mv.scafoldingBlocks.includes(it.id)) mv.scafoldingBlocks.push(it.id);
        }
        // 海带/海草等含水植物在物理上就是水：不加进 liquids 的话寻路会以为脚下悬空，在海带丛里原地卡死
        for (const n of ['kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column']) {
          const b = this.mcData.blocksByName[n];
          if (b) mv.liquids.add(b.id);
        }
        mv.liquidCost = 10; // 能走陆路就别游泳：海岸边绕一点陆路也比下水强（游泳慢、会被溺尸打、会淹死）
        try {
          for (const n of PROTECTED_BLOCKS) {
            const b = this.mcData.blocksByName[n];
            if (b) mv.blocksCantBreak.add(b.id);
          }
        } catch { /* ignore */ }
        cornerSafe(mv);
        bot.pathfinder.setMovements(mv);
        // 远一点的目标默认 5 秒想不完就报错：多给点时间，想不完时 goto 会按“没找到路”处理
        bot.pathfinder.thinkTimeout = 10000;
        this.normalMovements = mv;
        bot.__agentMovementsSet = true;
      }
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
    try { const block = b.blockAt(e.position); chunkReady = !!block; biome = block?.biome?.name ?? null; } catch { /* ignore */ }
    const observationReady = this.spawned && chunkReady && (b.health ?? 0) > 0 && dim !== 'unknown';
    const worldAgeTicks = b.time?.age;
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
      oxygen: ownOxygen(b),
      timeOfDay: b.time?.timeOfDay ?? 0,
      ...(Number.isFinite(b.time?.day) ? { worldDay: b.time.day } : {}),
      ...(typeof worldAgeTicks === 'number' && Number.isFinite(worldAgeTicks) && worldAgeTicks >= 0 ? { worldAgeTicks } : {}),
      weather: (b.thunderState ?? 0) > 0.5 && (b.isRaining || (b.rainState ?? 0) > 0.2) ? 'thunder' : b.isRaining || (b.rainState ?? 0) > 0.2 ? 'rain' : 'clear',
      isDay: b.time?.isDay ?? true,
      biome,
      onGround: !!e.onGround,
      inWater: !!e.isInWater,
      inLava: !!e.isInLava,
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
        return [{ slot, name: item.name, durabilityRemaining: max ? max - (item.durabilityUsed ?? 0) : undefined }];
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

  private classify(ent: any): EntityKind {
    const name = String(ent.name ?? '');
    if (ent.type === 'player') return 'player';
    if (name === 'item') return 'item';
    if (name === 'enderman') {
      const keys: string[] = this.mcData?.entitiesByName?.enderman?.metadataKeys ?? [];
      if (['creepy', 'stared_at'].some((key) => keys.indexOf(key) >= 0 && ent.metadata?.[keys.indexOf(key)] === true)) return 'hostile';
    }
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
    if (ownOxygen(b) <= 0) out.push('没气了');
    if ((b.food ?? 20) <= 0) out.push('饿着');
    return out.slice(0, 4).join('、');
  }

  async moveTo(target: MoveTarget, opts: MoveOpts): Promise<void> {
    const check = this.actionCheckpoint(opts.signal);
    throwIfAborted(opts.signal);
    if (!this.ready) throw new Error('NOT_CONNECTED');
    const b = this.bot;
    if (b.vehicle) throw new Error(`RIDING：正在乘坐 ${b.vehicle.name}，走路前先 dismount，或用 ride 操控它前进`);
    if (opts.maxDropDown !== undefined && (!this.normalMovements || typeof b.pathfinder.setMovements !== 'function')) throw new Error('No path: 当前寻路器不能配置明确下行范围');
    if (this.normalMovements && typeof b.pathfinder.setMovements === 'function') {
      const movements = cornerSafe(Object.assign(Object.create(Object.getPrototypeOf(this.normalMovements)), this.normalMovements));
      if (opts.constructionSafe) {
        movements.canDig = false; movements.allow1by1towers = false; movements.scafoldingBlocks = [];
      } else if (!opts.allowTerrainChanges) {
        // 普通走路不挖墙、不搭柱、不架桥；但像真人一样可以随手拨开树叶（站在树冠上、钻过灌木丛时）。
        movements.canDig = true; movements.allow1by1towers = false; movements.scafoldingBlocks = [];
        movements.blocksCantBreak = this.allButLeaves(movements.blocksCantBreak);
      }
      if (!opts.constructionSafe) {
        const allowPlace = opts.allowPlace ?? !!opts.allowTerrainChanges;
        const allowTower = allowPlace && (opts.allowTower ?? allowPlace);
        movements.scafoldingBlocks = allowPlace ? [...this.normalMovements.scafoldingBlocks] : [];
        movements.allow1by1towers = allowTower && this.normalMovements.allow1by1towers;
      }
      movements.allowParkour = false;
      // 这一趟要绕开的方块（比如吃过亏的浆果丛、仙人掌）：由调用的人决定，身体不替它定
      if (opts.avoid?.length) {
        movements.blocksToAvoid = new Set(movements.blocksToAvoid);
        for (const n of opts.avoid) { const id = this.mcData?.blocksByName?.[n]?.id; if (id !== undefined) movements.blocksToAvoid.add(id); }
      }
      // 平时走路，只有说了要跑（赶路、逃命）才跑：冲刺每格都在消耗饥饿值，走路几乎不耗
      movements.allowSprinting = opts.sprint ?? target.kind === 'away_from';
      if (opts.maxDropDown !== undefined) {
        if (!Number.isInteger(opts.maxDropDown) || opts.maxDropDown < 1 || opts.maxDropDown > 32 || target.kind !== 'xyz') throw new Error('BAD_ARGS: 明确下行需要相邻 xyz 落点和 1–32 格上限');
        const from = b.entity.position.floored(), to = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
        if (Math.abs(from.x - to.x) + Math.abs(from.z - to.z) !== 1 || to.y >= Math.ceil(b.entity.position.y)) throw new Error('BAD_ARGS: 明确下行只支持相邻一列的较低落点');
        movements.maxDropDown = opts.maxDropDown;
        movements.infiniteLiquidDropdownDistance = false;
        movements.canDig = false; movements.allow1by1towers = false; movements.scafoldingBlocks = [];
        movements.allowParkour = false; movements.allowSprinting = false; movements.allowFreeMotion = false;
        const landingBlock = movements.getLandingBlock, neighbors = movements.getNeighbors;
        movements.getLandingBlock = function (node: any, ...args: any[]) {
          const landing = landingBlock.call(this, node, ...args);
          // Native water landings bypass the solid-floor drop bound.
          return landing && node.y - landing.position.y <= this.maxDropDown ? landing : null;
        };
        movements.getNeighbors = function (node: any) {
          // This is one observed edge, not permission to find another cliff.
          if (node.x !== from.x || node.z !== from.z) return [];
          return neighbors.call(this, node).filter((next: any) => next.x === to.x && next.y === to.y && next.z === to.z
            && !next.toBreak.length && !next.toPlace.length);
        };
      }
      if (opts.allowSwimming === false) {
        const water = (block: any) => !!block && (block.liquid || movements.liquids.has(block.type)
          || String(block.getProperties?.().waterlogged) === 'true');
        movements.exclusionAreasStep = [...movements.exclusionAreasStep, (block: any) => water(block) ? 100 : 0];
        movements.infiniteLiquidDropdownDistance = false;
        const landingBlock = movements.getLandingBlock;
        movements.getLandingBlock = function (...args: any[]) {
          const landing = landingBlock.apply(this, args);
          // Drop-down edges bypass exclusionAreasStep in installed Pathfinder.
          return landing && !water(landing) && !water(this.getBlock(landing.position, 0, 1, 0)) ? landing : null;
        };
      }
      // Installed Pathfinder handles gates, but omits two-block wooden doors.
      // Keep both halves out of the break list. Check the actual door panel for
      // each approach and open a closed door only when doing so clears the way.
      movements.canOpenDoors = opts.maxDropDown === undefined;
      const getBlock = movements.getBlock;
      movements.getBlock = function (...args: any[]) {
        const block = getBlock.apply(this, args);
        if (!block?.name?.endsWith('_door') || block.name === 'iron_door') return block;
        const properties = block.getProperties?.();
        if (!properties || !['upper', 'lower'].includes(properties.half)) return block;
        const open = properties.open === true || properties.open === 'true';
        return Object.assign(Object.create(Object.getPrototypeOf(block)), block, {
          physical: false, height: block.position.y,
          safe: open || properties.half === 'upper',
          openable: !open && properties.half === 'lower',
        });
      };
      let blockClass: any;
      for (const [method, dy] of [['getMoveForward', 0], ['getMoveJumpUp', 1]] as const) {
        const getMove = movements[method];
        movements[method] = function (node: any, dir: any, neighbors: any[]) {
          const door = this.getBlock(node, dir.x, dy, dir.z);
          const properties = door.getProperties?.();
          if (!door.name?.endsWith('_door') || door.name === 'iron_door' || properties?.half !== 'lower') {
            return getMove.call(this, node, dir, neighbors);
          }
          const startX = node.x + 0.5, startZ = node.z + 0.5;
          const minX = Math.min(startX, startX + dir.x) - 0.3, maxX = Math.max(startX, startX + dir.x) + 0.3;
          const minZ = Math.min(startZ, startZ + dir.z) - 0.3, maxZ = Math.max(startZ, startZ + dir.z) + 0.3;
          const collides = (shapes: number[][]) => shapes.some((shape) => door.position.x + shape[3] > minX && door.position.x + shape[0] < maxX
            && door.position.z + shape[5] > minZ && door.position.z + shape[2] < maxZ);
          const isOpen = properties.open === true || properties.open === 'true';
          let openDoor = false;
          if (collides(door.shapes)) {
            // An open door remains a panel; never change it behind the caller's back.
            if (isOpen || !this.canOpenDoors) return;
            blockClass ??= require('prismarine-block')(b.registry);
            const opened = blockClass.fromProperties(door.name, { ...properties, open: true }, 0);
            if (collides(opened.shapes)) return;
            openDoor = true;
          }
          // Preserve all the normal movement checks while treating only the verified
          // clear doorway as passable. Opening is added only when it clears the path.
          const before = neighbors.length, getBlock = this.getBlock;
          this.getBlock = function (...args: any[]) {
            const block = getBlock.apply(this, args);
            return block.position?.equals(door.position) ? Object.assign(Object.create(Object.getPrototypeOf(block)), block, { safe: true, openable: false }) : block;
          };
          try { getMove.call(this, node, dir, neighbors); }
          finally { this.getBlock = getBlock; }
          if (openDoor) for (const move of neighbors.slice(before)) move.toPlace.unshift({ x: door.position.x, y: door.position.y, z: door.position.z, dx: 0, dy: 0, dz: 0, useOne: true });
        };
      }
      b.pathfinder.setMovements(movements);
    }
    const goals = goalsLib();
    let goal: any;
    switch (target.kind) {
      case 'near':
        goal = new goals.GoalNear(target.pos.x, target.pos.y, target.pos.z, target.range);
        break;
      case 'xz':
        goal = new goals.GoalNearXZ(target.x, target.z, target.range);
        break;
      case 'xyz':
        goal = new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
        break;
      case 'reach_block': {
        // 浆果丛、作物、花草、火把这些没有碰撞箱的方块：视线射线会直接穿过去，“看得到这一格”永远不成立，
        // 寻路就一直在它旁边（甚至丛里）打转到超时，人站在浆果丛里半天不动手。这类方块按距离算够得着。
        const there = b.blockAt(this.vec(target.pos));
        const hollow = !!there && Array.isArray(there.shapes) && there.shapes.length === 0;
        goal = goals.GoalLookAtBlock && !hollow
          ? new goals.GoalLookAtBlock(this.vec(target.pos), b.world, { reach: 4 })
          : new goals.GoalNear(target.pos.x, target.pos.y, target.pos.z, 2);
        // GoalLookAtBlock 的距离判定偏向脚部节点；地下目标还须核对眼睛到方块中心的真实挖掘距离。
        const nominalEnd = goal.isEnd.bind(goal);
        goal.isEnd = (node: any) => nominalEnd(node) && Math.hypot(
          node.x + 0.5 - target.pos.x - 0.5,
          node.y + (b.entity.eyeHeight ?? 1.62) - target.pos.y - 0.5,
          node.z + 0.5 - target.pos.z - 0.5,
        ) <= 4;
        break;
      }
      case 'place_block': {
          const excluded = new Set<string>();
          const nodeKey = (node: any) => `${node.x},${node.y},${node.z}`;
          const deadline = Date.now() + opts.timeoutMs;
          for (let attempt = 0; attempt < 4; attempt++) {
            goal = new goals.GoalPlaceBlock(this.vec(target.pos), b.world, { range: 4, LOS: true, ...(target.facing ? { facing: target.facing } : {}) });
            const nominalEnd = goal.isEnd.bind(goal);
            // Pathfinder searches integer node centres and may stop before the
            // actual eye has reached that centre. Keep its search semantics,
            // then exclude any arrival whose real face is still occluded.
            goal.isEnd = (node: any) => !excluded.has(nodeKey(node)) && nominalEnd(node);
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('PLACEMENT_NOT_REACHABLE');
            await this.afterAction(() => raceAbort(b.pathfinder.goto(goal), opts.signal, remaining, () => this.stopAll()), check);
            if (typeof b.waitForTicks === 'function') await this.afterAction(() => raceAbort(b.waitForTicks(1), opts.signal, Math.max(1, Math.min(2000, deadline - Date.now())), () => {}), check);
            const actual = b.entity.position, floor = actual.floored();
            if (!goal.isStandingIn(floor) && goal.getFaceAndRef(actual.offset(0, b.entity.eyeHeight ?? 1.62, 0))) return;
            // goto can also resolve an empty noPath result. Never accept it as
            // reachability proof or retry the same unusable within-node pose.
            excluded.add(nodeKey(floor));
            excluded.add(nodeKey(floor.offset(0, 1, 0)));
          }
          throw new Error('PLACEMENT_NOT_REACHABLE');
      }
      case 'follow_entity': {
        const ent = b.entities[target.entityId];
        if (!ent) throw new Error('ENTITY_GONE');
        goal = new goals.GoalFollow(ent, target.range);
        break;
      }
      case 'away_from': {
        const me = b.entity.position;
        let dx = me.x - target.pos.x;
        let dz = me.z - target.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        goal = new goals.GoalNearXZ(me.x + dx * target.distance, me.z + dz * target.distance, 3);
        break;
      }
    }
    await this.gotoUnstalled(goal, opts, check);
    check();
    // Pathfinder can resolve an empty noPath result without reaching its goal.
    // Following is measured against the entity's current cell, not its old one.
    if (target.kind === 'follow_entity') {
      const ent = b.entities[target.entityId];
      if (!ent) throw new Error('ENTITY_GONE');
      goal = new goals.GoalFollow(ent, target.range);
    }
    const position = b.entity.position;
    if (!goal.isEnd(position.floored())) throw new Error(`No path: 寻路结束但尚未到达目标，实际位于 (${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})`);
  }

  private leafOnlyBreakable: Set<number> | null = null;
  /** 除树叶以外都不能拆：普通走路只允许拨开树叶 */
  private allButLeaves(base: Set<number>): Set<number> {
    if (!this.leafOnlyBreakable) {
      const registry = this.mcData ?? this.bot?.registry;
      const blocks: any[] = registry?.blocksArray ?? Object.values(registry?.blocks ?? {});
      this.leafOnlyBreakable = new Set(blocks.filter((b: any) => !/_leaves$/.test(String(b?.name))).map((b: any) => b.id));
    }
    return new Set([...base, ...this.leafOnlyBreakable]);
  }

  /**
   * 站在方块边缘、身体中心已经悬空时，Pathfinder 会从“脚下中心那一列”（空气）开始规划，
   * 第一步和真实物理对不上，于是在边上来回抖。先潜行挪回真正踩着的那一格中心（潜行不会掉下去），再寻路。
   */
  private edgeSupport(): { x: number; z: number } | null {
    const b = this.bot, e = b?.entity;
    if (!e?.onGround || e.isInWater || e.isInLava || b.vehicle || typeof b.blockAt !== 'function' || typeof b.setControlState !== 'function' || !e.position?.offset) return null;
    const p = e.position;
    const supports = (dx: number, dz: number) => {
      const foot = p.offset(dx, -0.05, dz), cell = foot.floored(), block = b.blockAt(foot);
      if (!block || /water|lava|magma|campfire|cactus|powder_snow/.test(block.name)) return null;
      const shapes: number[][] = block.shapes ?? (block.boundingBox === 'empty' ? [] : [[0, 0, 0, 1, 1, 1]]);
      return shapes.some((sh) => Math.abs(cell.y + sh[4] - p.y) < 0.1) ? cell : null;
    };
    if (supports(0, 0)) return null;
    const cells = [[0.3, 0.3], [0.3, -0.3], [-0.3, 0.3], [-0.3, -0.3]].map(([dx, dz]) => supports(dx, dz)).filter((c): c is any => !!c)
      .sort((a, c) => Math.hypot(a.x + 0.5 - p.x, a.z + 0.5 - p.z) - Math.hypot(c.x + 0.5 - p.x, c.z + 0.5 - p.z));
    return cells[0] ? { x: cells[0].x, z: cells[0].z } : null;
  }

  /**
   * 身体贴着脚边或头边的实心方块、又离格子中心偏了：Pathfinder 按格子中心规划，第一步就会蹭到这块方块。
   * 先挪回脚下那格的中心（潜行，不会掉下去）再走。返回要回到的格子；不需要时 null。
   */
  private hugging(): { x: number; z: number } | null {
    const b = this.bot, e = b?.entity;
    if (!e?.onGround || e.isInWater || e.isInLava || b.vehicle || typeof b.blockAt !== 'function' || typeof b.setControlState !== 'function' || !e.position?.offset) return null;
    const p = e.position, cx = Math.floor(p.x), cz = Math.floor(p.z);
    const ox = p.x - (cx + 0.5), oz = p.z - (cz + 0.5);
    if (Math.hypot(ox, oz) < 0.15) return null;
    const solid = (dx: number, dy: number, dz: number) => { const blk = b.blockAt(p.offset(dx, dy, dz)); return !!blk && blk.boundingBox === 'block' && !/water|lava/.test(blk.name); };
    const sx = Math.sign(ox), sz = Math.sign(oz);
    const touching = [0.1, 1.1].some((dy) => (Math.abs(ox) > 0.15 && solid(sx * 0.4, dy, 0)) || (Math.abs(oz) > 0.15 && solid(0, dy, sz * 0.4)));
    return touching ? { x: cx, z: cz } : null;
  }

  private async steady(cell: { x: number; z: number }, opts: MoveOpts, check: () => void): Promise<void> {
    const b = this.bot, e = b.entity, p = e.position;
    const epoch = this.actionEpoch;
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot;
    const tx = cell.x + 0.5, tz = cell.z + 0.5;
    check();
    if (typeof b.look === 'function') await this.afterAction(() => raceAbort(b.look(Math.atan2(-(tx - p.x), -(tz - p.z)), e.pitch ?? 0, true), opts.signal, 1000, () => {}), check);
    b.clearControlStates?.();
    b.setControlState('sneak', true);
    b.setControlState('forward', true);
    try {
      for (let t = 0; t < 900; t += 50) {
        await this.afterAction(() => sleep(50, opts.signal), check);
        const q = b.entity.position;
        if (Math.hypot(tx - q.x, tz - q.z) < 0.22) break;
      }
    } finally {
      if (ownsControls()) { b.setControlState('forward', false); b.setControlState('sneak', false); }
    }
    this.bus.publish('path_steady', 'P3', `站在方块边缘，先挪回脚下那一格中心再走`);
  }

  /** Check the actual player's head sweep before jumping high enough to place a block underfoot. */
  private pillarClearance(): PillarClearance | null {
    const b = this.bot, p = b.entity.position, feetY = Math.floor(p.y), epsilon = 1e-6;
    const top = feetY + 1.02 + 1.8;
    const min = { x: Math.floor(p.x - 0.3 + epsilon), y: Math.floor(p.y + 1.8), z: Math.floor(p.z - 0.3 + epsilon) };
    const max = { x: Math.floor(p.x + 0.3 - epsilon), y: Math.floor(top - epsilon), z: Math.floor(p.z + 0.3 - epsilon) };
    for (let x = min.x; x <= max.x; x++)
      for (let y = min.y; y <= max.y; y++)
        for (let z = min.z; z <= max.z; z++) {
          const block = b.blockAt(p.offset(x - p.x, y - p.y, z - p.z));
          if (!block) return { kind: 'unknown', min, max };
          const shapes: number[][] = block.shapes ?? (block.boundingBox === 'empty' ? [] : [[0, 0, 0, 1, 1, 1]]);
          if (shapes.some((shape) => x + shape[3] > p.x - 0.3 + epsilon && x + shape[0] < p.x + 0.3 - epsilon
            && z + shape[5] > p.z - 0.3 + epsilon && z + shape[2] < p.z + 0.3 - epsilon
            && y + shape[4] > p.y + 1.8 + epsilon && y + shape[1] < top - epsilon)) return { kind: 'blocked', min, max };
        }
    return null;
  }

  /** Inspect the nearby obstruction before trying a short correction, then replan. */
  private async gotoUnstalled(goal: any, opts: MoveOpts, check: () => void) {
    const b = this.bot;
    const epoch = this.actionEpoch, dimension = this.currentDimension();
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot && dimension === this.currentDimension();
    const deadline = Date.now() + opts.timeoutMs;
    const attempted = new Set<string>();
    let corrections = 0, recoveryOrigin = b.entity?.position?.clone?.() ?? null;
    for (;;) {
      check();
      const edge = this.edgeSupport() ?? (corrections === 0 && !attempted.has('recentre') ? this.hugging() : null);
      if (edge) { if (!this.edgeSupport()) attempted.add('recentre'); await this.steady(edge, opts, check); check(); }
      let stalled = false, blockedPillar: PillarClearance | null = null;
      let last = b.entity?.position?.clone?.() ?? null, since = Date.now();
      let groundedY = b.entity?.onGround ? last?.y ?? null : null;
      let verticalY = last?.y ?? null;
      let plannedPath: { status: string; nodes: { x: number; y: number; z: number }[] } | null = null;
      const onPathUpdate = (result: { status: string; path: { x: number; y: number; z: number }[] }) => {
        plannedPath = { status: result.status, nodes: result.path.slice(0, 6).map(({ x, y, z }) => ({ x, y, z })) };
      };
      const onPhysicsTick = () => {
        const p = b.entity?.position;
        if (!ownsControls() || !b.entity?.onGround || !p?.clone) return;
        // Pathfinder schedules jump-to-place on its physicsTick listener. This
        // listener runs afterward, before the next physics step, and checks
        // actual position after any planned digging has completed.
        if (b.pathfinder?.isBuilding?.() && b.getControlState?.('jump')) {
          blockedPillar = this.pillarClearance();
          if (blockedPillar) { b.pathfinder.stop(); b.pathfinder.setGoal(null); return; }
        }
        if (groundedY === null) { groundedY = p.y; return; }
        if (Math.abs(p.y - groundedY) < 0.5) return;
        groundedY = p.y;
        verticalY = p.y;
        last = p.clone();
        since = Date.now();
      };
      b.on?.('physicsTick', onPhysicsTick);
      b.on?.('path_update', onPathUpdate);
      const watch = setInterval(() => {
        try { check(); } catch { clearInterval(watch); return; }
        const p = b.entity?.position;
        if (!p?.clone || !last) { last = p?.clone?.() ?? null; return; }
        // A long trip may need several successful corrections. Only count
        // failures around the same obstruction, not across the whole route.
        if (recoveryOrigin && p.distanceTo(recoveryOrigin) >= 1.5) {
          corrections = 0; attempted.clear(); recoveryOrigin = p.clone();
        }
        // A jump oscillates vertically without advancing. Count horizontal
        // travel, a newly reached standing height, or sustained vertical travel
        // beyond a jump's height (for example a ladder), not the jump itself.
        const horizontal = Math.hypot(p.x - last.x, p.z - last.z);
        const grounded = !!b.entity?.onGround;
        if (grounded && groundedY === null) groundedY = p.y;
        const landedProgress = grounded && groundedY !== null && Math.abs(p.y - groundedY) >= 0.5;
        const verticalProgress = !b.entity?.isInWater && verticalY !== null && Math.abs(p.y - verticalY) >= 1.5;
        if (landedProgress) groundedY = p.y;
        if (horizontal >= 0.3 || landedProgress || verticalProgress || b.targetDigBlock || !b.pathfinder?.isMoving?.()) {
          last = p.clone(); verticalY = p.y; since = Date.now(); return;
        }
        // A jump-and-place may need several seconds for the server to confirm
        // the block; still bound retries if the placement never succeeds.
        if (Date.now() - since >= (b.pathfinder?.isBuilding?.() ? 4500 : 2500) && !stalled) {
          stalled = true;
          this.bus.publish('path_stalled', 'P3', '寻路执行停滞，记录位置和最近一次规划', {
            position: { x: p.x, y: p.y, z: p.z }, yaw: b.entity.yaw, onGround: b.entity.onGround,
            collidedHorizontally: b.entity.isCollidedHorizontally, goal: { x: goal.x, y: goal.y, z: goal.z }, plannedPath,
          });
          try { b.pathfinder.stop(); b.pathfinder.setGoal(null); } catch { /* ignore */ }
        }
      }, 300);
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('TIMEOUT');
        await this.afterAction(() => raceAbort(b.pathfinder.goto(goal), opts.signal, remaining, () => { if (ownsControls()) this.stopAll(); }), check);
        if (blockedPillar) throw new PillarClearanceError(blockedPillar);
        if (!stalled) return;
      } catch (e: any) {
        if (blockedPillar && ownsControls() && e?.name !== 'AbortedError') throw new PillarClearanceError(blockedPillar);
        if (!stalled || e?.name === 'AbortedError') throw e;
      } finally {
        clearInterval(watch);
        b.removeListener?.('physicsTick', onPhysicsTick);
        b.removeListener?.('path_update', onPathUpdate);
      }
      check();
      if (opts.maxDropDown !== undefined) throw new Error('No path: 明确下行未能完成，未改走其他边缘');
      if (corrections >= 3) throw new Error('No path: 附近连续调整后仍无法前进，换条路线');
      const action = await this.nudge(attempted, opts);
      check();
      if (!action) throw new Error(b.entity.isInWater
        ? 'No path: 当前在水中，寻路没有取得进展，未另选上岸位置'
        : 'No path: 附近没有可确认安全的调整空间，换条路线');
      corrections++;
      this.bus.publish('path_nudge', 'P3', `走路被挡住，第 ${corrections} 次调整：${action}`);
    }
  }

  private async nudge(attempted: Set<string>, opts: MoveOpts): Promise<string | null> {
    const check = this.actionCheckpoint(opts.signal);
    const b = this.bot, epoch = this.actionEpoch;
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot;
    const p = b.entity.position, yaw = b.entity.yaw;
    // Swimming and airborne recovery need their own controls; do not blindly
    // jump or step backwards before the feet have landed.
    if (!b.entity.onGround || b.entity.isInWater || b.entity.isInLava) return null;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const hazard = (block: any) => !block || /^(water|lava|bubble_column|fire|soul_fire|cactus|sweet_berry_bush|powder_snow|magma_block|.*campfire)$/.test(block.name)
      || String(block.getProperties?.().waterlogged) === 'true';
    const shapes = (block: any): number[][] => block.shapes ?? (block.boundingBox === 'empty' ? [] : [[0, 0, 0, 1, 1, 1]]);
    const bodyBlocks = (q: any) => {
      const blocks: any[] = [];
      for (let x = Math.floor(q.x - 0.3); x <= Math.floor(q.x + 0.3); x++)
        for (let y = Math.floor(q.y + 0.02); y <= Math.floor(q.y + 1.79); y++)
          for (let z = Math.floor(q.z - 0.3); z <= Math.floor(q.z + 0.3); z++) {
            const block = b.blockAt(q.offset(x - q.x, y - q.y, z - q.z));
            if (hazard(block) || shapes(block).some((s) => x + s[3] > q.x - 0.3 && x + s[0] < q.x + 0.3
              && y + s[4] > q.y + 0.02 && y + s[1] < q.y + 1.8 && z + s[5] > q.z - 0.3 && z + s[2] < q.z + 0.3)) blocks.push(block);
          }
      return blocks;
    };
    const supported = (q: any) => [-0.25, 0.25].every((x) => [-0.25, 0.25].every((z) => {
      const foot = q.offset(x, -0.05, z), cell = foot.floored(), block = b.blockAt(foot);
      return !hazard(block) && shapes(block).some((s) => foot.x >= cell.x + s[0] && foot.x <= cell.x + s[3]
        && foot.z >= cell.z + s[2] && foot.z <= cell.z + s[5] && Math.abs(cell.y + s[4] - q.y) < 0.1);
    }));
    // Include the body's width, the swept route and a little braking distance.
    // Unknown blocks, fluids and unsupported corners rule out that correction.
    const safeStep = (dx: number, dz: number) => [0, 0.2, 0.4, 0.6, 0.8].every((d) => {
      const q = p.offset(dx * d, 0, dz * d);
      return bodyBlocks(q).length === 0 && supported(q);
    });
    const hold = async (keys: string[], ms: number) => {
      check();
      b.clearControlStates();
      for (const k of keys) b.setControlState(k, true);
      try { await this.afterAction(() => sleep(ms, opts.signal), check); }
      finally { if (ownsControls()) for (const k of keys) b.setControlState(k, false); }
    };
    if (!opts.constructionSafe) {
      const soft = /(_leaves|grass|fern|vine|bush|_sapling|snow|flower|tulip|dandelion|poppy|azalea|cobweb)$/;
      for (const block of opts.allowTerrainChanges ? bodyBlocks(p.offset(fx * 0.75, 0, fz * 0.75)) : []) {
        if (!block || !soft.test(block.name) || !b.canDigBlock?.(block)) continue;
        const key = `dig:${block.position}`;
        if (attempted.has(key)) continue;
        attempted.add(key);
        await this.afterAction(() => raceAbort(b.dig(block), opts.signal, 2000, () => { if (ownsControls()) b.stopDigging?.(); }), check);
        return `清开挡路的 ${block.name}`;
      }
      const landing = p.offset(fx * 0.85, 1, fz * 0.85);
      if (!attempted.has('jump') && bodyBlocks(p.offset(0, 1, 0)).length === 0
        && [0.3, 0.6, 0.85, 1.1].every((d) => bodyBlocks(p.offset(fx * d, 1, fz * d)).length === 0)
        && supported(landing) && supported(p.offset(fx * 1.1, 1, fz * 1.1))) {
        attempted.add('jump');
        await hold(['jump', 'forward'], 180);
        return '前面是一格台阶，向前跳上去';
      }
    }
    for (const [key, dx, dz, label] of [['left', fz, -fx, '左'], ['right', -fz, fx, '右'], ['back', -fx, -fz, '后']] as const) {
      if (attempted.has(key) || !safeStep(dx, dz)) continue;
      attempted.add(key);
      await hold(opts.constructionSafe ? ['sneak', key] : [key], opts.constructionSafe ? 250 : 150);
      return `确认脚下有支撑，向${label}挪半步后重新寻路`;
    }
    return null;
  }

  stopAll() {
    this.actionEpoch++;
    this.actionContext.exit(() => {
      const b = this.bot;
      if (!b) return;
      try { b.pathfinder?.stop(); } catch { /* ignore */ }
      try { b.pathfinder?.setGoal(null); } catch { /* ignore */ }
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
  private tossCursorReturn: { bot: any; slot: number; identity: string } | null = null;

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
      if (b.currentWindow) return;
      if (typeof b._syncWindow !== 'function') return;
      const synced = await Promise.race([Promise.resolve(b._syncWindow(b.inventory)).then(() => true, () => false), sleep(3000).then(() => false)]);
      if (!synced) return;
      const cursor = b.inventory.selectedItem, source = b.inventory.slots[pending.slot];
      const identity = (item: any) => JSON.stringify([item.type, item.metadata, item.nbt ?? null]);
      if (cursor) {
        if (identity(cursor) !== pending.identity || source && (identity(source) !== pending.identity || source.count + cursor.count > source.stackSize)) return;
        const returnedName = cursor.name, returnedCount = cursor.count;
        await b.clickWindow(pending.slot, 0, 0);
        const returned = await Promise.race([Promise.resolve(b._syncWindow(b.inventory)).then(() => true, () => false), sleep(3000).then(() => false)]);
        if (!returned) return;
        if (b.inventory.selectedItem) return;
        this.bus.publish('interaction_repaired', 'P3', `收拾交互残留（${reason}）：光标上的 ${returnedName}×${returnedCount} 已归还原槽`, { reason, slot: pending.slot, item: returnedName, count: returnedCount });
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

  private async equipBestTool(block: any, signal?: AbortSignal) {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    const e = b.entity;
    let best: any = null;
    let bestTime = Infinity;
    const timeFor = (type: number | null, ench: any[] = []) => {
      try { return block.digTime(type, false, !!e.isInWater, !e.onGround, ench, e.effects ?? {}); } catch { return Infinity; }
    };
    const bare = timeFor(null);
    // 手上这把能挖（能掉东西、比空手快）：就用手上的。用哪把镐是它自己的决定（“钻石镐留着，这次用铁镐”），身体不替它换
    const held = b.heldItem;
    if (held && (block.harvestTools ? !!block.harvestTools[held.type] : timeFor(held.type, held.enchants ?? []) < bare)) return;
    // 手上的不行才去背包里找。它自己挑过这类工具（亲手拿过铁镐）就还拿那种；没挑过才按挖得最快的拿
    const kindOf = (name: string) => name.match(/_(pickaxe|axe|shovel|hoe)$/)?.[1] ?? (name === 'shears' ? 'shears' : null);
    for (const it of b.inventory.items()) {
      const kind = kindOf(it.name);
      if (!kind || this.toolChoice.get(kind) !== it.name) continue;
      if (block.harvestTools ? !block.harvestTools[it.type] : timeFor(it.type, it.enchants ?? []) >= bare) continue;
      const pick = this.bestInvItem(it.name) ?? it;
      if (b.heldItem?.type !== pick.type) await this.afterAction(() => b.equip(pick, 'hand'), check);
      return;
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
    // 没有更快的工具：别拿着剑、镐这些会掉耐久又不加速的东西去挖（真人会收起来空手砍，或换斧子）
    else if (!best && b.heldItem && /_(sword|pickaxe|axe|shovel|hoe)$|^(shears|bow|crossbow|trident|fishing_rod|flint_and_steel)$/.test(b.heldItem.name)) {
      await this.afterAction(() => b.unequip('hand'), check).catch(() => {});
    }
  }

  async dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult> {
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
    const harvest = this.canHarvest(pos);
    await this.afterAction(() => this.equipBestTool(block, signal), check);
    throwIfAborted(signal);
    if (!b.canDigBlock(block)) return { ok: false, reason: 'OUT_OF_REACH' };
    const e = b.entity;
    let ms = 0;
    try { ms = block.digTime(b.heldItem?.type ?? null, false, !!e?.isInWater, !e?.onGround, b.heldItem?.enchants ?? [], e?.effects ?? {}); } catch { ms = 0; }
    // Long legal hand digs exceed this bounded action's execution budget.
    if (!harvest && (!Number.isFinite(ms) || ms > HAND_DIG_MAX_MS)) return { ok: false, reason: 'HAND_DIG_TIMEOUT:预计挖掘时间超过本次身体动作预算；这不代表游戏禁止空手挖掘' };
    const t0 = Date.now();
    await this.afterAction(() => raceAbort(b.dig(block, true), signal, Math.max(20000, (Number.isFinite(ms) ? ms : 0) + 5000), () => {
      try { b.stopDigging(); } catch { /* ignore */ }
    }), check);
    return harvest ? { ok: true } : { ok: true, noDrop: true, digMs: Date.now() - t0 };
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
      const item = this.nearbyEntities(radius + 6).find((e) => e.kind === 'item' && !tried.has(e.id) && (tries.has(e.id) || e.dist <= radius));
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

  async placeBlockAt(pos: Vec3Like, itemNames: string[], signal: AbortSignal): Promise<ActionResult> {
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
    if (cur && cur.boundingBox === 'block') return { ok: true }; // 已经有方块了
    // 贴墙的东西（梯子、火把、按钮……）要以它能挂住的那一面为参照：梯子只能挂在实心墙的侧面，火把可以立在地上或挂在墙上；
    // 以前对什么方块都先试脚下那块的顶面，梯子就放不上，还只报“没有参照”，学不到“要贴墙放”
    const attach = attachmentFaces(item.name);
    const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
    const faces = attach === 'side' ? sides : attach === 'floor_or_side' ? [...sides, new Vec3(0, -1, 0)]
      : [new Vec3(0, -1, 0), new Vec3(0, 1, 0), ...sides];
    // 贴着箱子、工作台、门这类一点就打开的方块放：先试别的面；只能贴着它时按住潜行再放（不然是打开它，不是放方块）
    const refs = faces.map((f) => ({ f, ref: b.blockAt(target.plus(f)) })).filter((x) => x.ref && x.ref.boundingBox === 'block')
      .sort((x, y) => Number(OPENS_ON_CLICK.test(x.ref.name)) - Number(OPENS_ON_CLICK.test(y.ref.name)));
    if (!refs.length && attach) return { ok: false, reason: attach === 'side' ? 'NO_WALL' : 'NO_FLOOR_OR_WALL' };
    for (const { f, ref } of refs) {
      if (!this.canClickPlacementFace(ref, f.scaled(-1))) continue;
      const sneak = OPENS_ON_CLICK.test(ref.name);
      try {
        await this.afterAction(() => b.equip(item, 'hand'), check);
        if (sneak) { b.setControlState('sneak', true); await this.afterAction(() => sleep(120, signal), check); }
        try {
          await this.afterAction(() => raceAbort(b.placeBlock(ref, f.scaled(-1)), signal, 5000, () => {}), check);
        } finally { if (sneak) b.setControlState('sneak', false); }
        return { ok: true };
      } catch (e: any) {
        if (e?.name === 'AbortedError') throw e;
      }
    }
    return { ok: false, reason: 'NO_REFERENCE' };
  }

  private canClickPlacementFace(reference: any, face: any, delta?: any) {
    const b = this.bot;
    if (!b.entity?.position?.offset) return false;
    const from = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0);
    const to = delta ? reference.position.plus(delta) : reference.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
    const direction = to.minus(from);
    const distance = direction.norm();
    if (distance > 4.4 || distance < 0.01) return false;
    if (typeof b.world?.raycast !== 'function') return true;
    const hit = b.world.raycast(from, direction.normalize(), distance + 0.05);
    return !!hit?.position && hit.position.equals(reference.position);
  }

  blockStateAt(pos: Vec3Like) {
    if (!this.ready) return null;
    const block = this.bot.blockAt(this.vec(pos));
    if (!block) return null;
    return { name: String(block.name), properties: block.getProperties?.() ?? {} };
  }

  async placeBlockStateAt(pos: Vec3Like, name: string, properties: Record<string, string | number | boolean>, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const door = name.endsWith('_door'), stairs = name.endsWith('_stairs'), slab = name.endsWith('_slab'), bed = name.endsWith('_bed');
    if (!door && !stairs && !slab && !bed) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
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
    if ((door || stairs || bed) && !(facing in yaw) || typeof b._placeBlockWithOptions !== 'function') return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (String(properties.waterlogged ?? false) !== 'false') return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (door && (properties.half !== 'lower' || String(properties.open ?? false) !== 'false' || String(properties.powered ?? false) !== 'false')) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (stairs && (!['top', 'bottom'].includes(String(properties.half)) || String(properties.shape ?? 'straight') !== 'straight')) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (slab && !['top', 'bottom'].includes(String(properties.type))) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    if (bed && (properties.part !== 'foot' || String(properties.occupied ?? false) !== 'false')) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
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
    const offsets: Vec3Like[] = door || bed ? [{ x: 0, y: -1, z: 0 }] : [
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
        await this.afterAction(() => this.moveTo({ kind: 'near', pos: { x: landing.x + 0.5, y: landing.y, z: landing.z + 0.5 }, range: 0.4 }, { signal, timeoutMs: 8000, constructionSafe: true }), check);
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

  async equipItem(name: string | null, destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet', signal: AbortSignal, opts: { sourceSlot?: number } = {}): Promise<ActionResult> {
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
        return !actual ? { ok: true } : { ok: false, reason: 'UNEQUIP_NOT_CONFIRMED' };
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
      const actual = destination === 'hand' ? this.bot.heldItem : this.bot.inventory.slots?.[slot];
      if (destination === 'hand' && actual?.name === name) this.noteToolChoice(name);
      return actual?.name === name && (opts.sourceSlot === undefined || JSON.stringify([actual.type, actual.metadata, actual.nbt ?? null]) === identity) ? { ok: true } : { ok: false, reason: 'EQUIP_NOT_CONFIRMED' };
    });
  }

  private itemEnchants(item: any): string[] | undefined {
    try {
      const list = item?.enchants;
      return Array.isArray(list) && list.length ? list.map((e: any) => `${e.name} ${e.lvl}`) : undefined;
    } catch { return undefined; }
  }

  private async syncInventory(check: ReturnType<MineflayerAdapter['actionCheckpoint']>) {
    await this.afterAction(() => raceAbort(this.bot._syncWindow(this.bot.inventory), check.signal, 3000, () => {}), check);
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
        if (entity.position.distanceTo(b.entity.position) > 4.5) await this.afterAction(() => this.moveTo({ kind: 'follow_entity', entityId: target.entityId, range: 3 }, { signal, timeoutMs: 20000, constructionSafe: true }), check);
        if (b.entities?.[target.entityId] !== entity || entity.position.distanceTo(b.entity.position) > 4.5) return { ok: false, reason: 'ENTITY_OUT_OF_REACH', done };
        open = () => b.openEntity(entity);
      }
    } else {
      const block = b.blockAt(this.vec(target));
      if (!block) return { ok: false, reason: 'UNLOADED', done };
      if (isLocalStorage(block.name)) storageBlock = block.name;
      await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: target }, { signal, timeoutMs: 20000, constructionSafe: true, allowSwimming: false }), check);
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
      container = observeStorage(storageBlock, (w.slots.slice(0, size()) as (Item | null)[]).filter((item): item is Item => item !== null), container);
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
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 15000, constructionSafe: true }), check);
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
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', tossed: 0 };
    await this.interactionReady();
    check();
    const total = () => (opts.sourceSlot === undefined ? this.bot.inventory.items() : this.bot.inventory.slots.slice(5, 46)).filter((item: Item | null) => item?.name === name).reduce((n: number, item: Item) => n + item.count, 0);
    const have = total();
    const item = opts.sourceSlot === undefined ? this.invItem(name) : this.bot.inventory.slots?.[opts.sourceSlot];
    if (!item || have <= 0) return { ok: false, reason: 'NO_ITEM', tossed: 0 };
    if (item.name !== name) return { ok: false, reason: 'SOURCE_ITEM_CHANGED', tossed: 0 };
    const available = opts.sourceSlot === undefined ? have : item.count;
    const want = count == null ? available : Math.min(count, available);
    const e = this.bot.entity;
    // 朝哪扔由调用的人定（toss_item 的 toward）；不指定就朝现在看的方向
    if (face) await this.afterAction(() => this.bot.lookAt(this.vec({ x: face.x, y: face.y + 1, z: face.z }), true), check);
    const yaw = e?.yaw ?? 0;
    const b = this.bot;
    // The selected inventory slots and their NBT determine what was asked to
    // be thrown. Prefer complete stacks only within the same identity quota.
    const identity = (stack: Item) => JSON.stringify([stack.type, stack.metadata, stack.nbt ?? null]);
    const stacks: Item[] = opts.sourceSlot === undefined ? b.inventory.items().filter((stack: Item) => stack.name === name) : [item];
    const quotas = new Map<string, number>();
    let remaining = want;
    for (const stack of stacks) {
      const take = Math.min(stack.count, remaining), key = identity(stack);
      if (take) quotas.set(key, (quotas.get(key) ?? 0) + take);
      remaining -= take;
      if (!remaining) break;
    }
    if (b.inventory.selectedItem || b.currentWindow?.selectedItem || b.currentWindow && opts.sourceSlot !== undefined) return { ok: false, reason: 'INVENTORY_NOT_READY', tossed: 0 };
    if (b.currentWindow) {
      await this.withObservedInventory(signal, async () => {
        await this.afterAction(() => b.toss(item.type, null, want), check);
        await this.syncInventory(check);
      });
    } else {
      try {
        await this.withObservedInventory(signal, async () => {
          for (const [key, quota] of quotas) {
            let left = quota;
            while (left > 0) {
              check();
              const candidates: Item[] = (opts.sourceSlot === undefined ? b.inventory.items() : [b.inventory.slots[opts.sourceSlot]])
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
                  this.tossCursorReturn = { bot: b, slot, identity: key };
                  await this.afterAction(() => b.clickWindow(slot, pickHalf ? 1 : 0, 0), check);
                  for (let n = picked - take; n > 0; n--) await this.afterAction(() => b.clickWindow(slot, 1, 0), check);
                  await this.syncInventory(check);
                  const cursor = b.inventory.selectedItem;
                  if (!cursor || identity(cursor) !== key || cursor.count !== take) throw new Error('TOSS_STATE_CHANGED');
                  await this.afterAction(() => b.clickWindow(-999, 0, 0), check);
                  await this.syncInventory(check);
                  if (b.inventory.selectedItem) throw new Error('TOSS_STATE_CHANGED');
                  this.tossCursorReturn = null;
                }
              }
              left -= take;
            }
          }
          await this.syncInventory(check);
        });
      } finally {
        if (this.tossCursorReturn) this.scheduleRepair('丢弃中断后归还光标', 250);
      }
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
    this.noteToolChoice(name);
    return { ok: true };
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
      await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 15000, constructionSafe: item === '', ...(item === '' ? { allowSwimming: false } : {}) }), check);
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
    return Object.assign(() => reasons().length > 0, { reasons });
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

  async enterPortalAt(pos: Vec3Like, signal: AbortSignal, expectedDim?: string): Promise<ActionResult & { from?: AgentState; to?: AgentState }> {
    const check = this.actionCheckpoint(signal);
    const from = this.state();
    if (!from.observationReady) return { ok: false, reason: 'NOT_CONNECTED' };
    const name = this.blockAt(pos);
    if (name !== 'nether_portal' && name !== 'end_portal') return { ok: false, reason: 'NO_PORTAL' };
    try {
      await this.moveTo({ kind: 'near', pos, range: 0 }, { signal, timeoutMs: 20000 });
    } catch (error) {
      throwIfAborted(signal);
      if (this.currentDimension() === from.dim) throw error;
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const to = this.state();
      if (!to.connected || !to.alive) return { ok: false, reason: 'TRANSITION_INTERRUPTED' };
      if (to.dim !== from.dim && to.sessionId !== from.sessionId && to.observationReady) {
        if (expectedDim && to.dim !== expectedDim) return { ok: false, reason: `WRONG_DIMENSION:${to.dim}`, from, to };
        return { ok: true, from, to };
      }
      // No further world action is issued after the dimension changes. Loading
      // and the fresh spawn observation are the only evidence of arrival.
      if (to.dim === from.dim) check();
      await sleep(200, signal);
    }
    return { ok: false, reason: 'PORTAL_TRANSITION_TIMEOUT' };
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
      container = observeStorage(block.name, chest.containerItems() as Item[], container);
      return result;
    }), check);
    try {
      await synchronize();
      for (const d of deposits) {
        check();
        const it = this.invItem(d.name);
        if (!it) continue;
        const n = Math.min(d.count, b.inventory.items().filter((i: any) => i.name === d.name).reduce((a: number, i: any) => a + i.count, 0));
        try { await this.afterAction(() => chest.deposit(it.type, null, n), check); } catch (e) { if (e instanceof AbortedError) throw e; }
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
          await this.afterAction(() => this.moveTo({ kind: 'place_block', pos: position }, { signal, timeoutMs: 8000, constructionSafe: true }), check);
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
  private async craftBatch(recipe: any, times: number, table: any, signal: AbortSignal): Promise<number | null> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
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
      }
    } finally {
      // 剩在格子里的料（产物放不下、或桶这种合成后留下的容器）收回背包
      try {
        for (let i = 1; i <= w * w; i++) if (window.slots[i]) await b.clickWindow(i, 0, 1);
        if (window.selectedItem) await b.putSelectedItemRange?.(window.inventoryStart, window.inventoryEnd, window, null);
        await raceAbort(b._syncWindow(window), signal, 5000, () => {}).catch(() => {});
      } catch { /* 交给收拾残局 */ this.scheduleRepair('批量合成后残留', 250); }
      // 做完停一下再关（背包 2×2 合成没有窗口，也停一下，让观众看到产物进了背包）
      await this.uiCloseHold(signal);
      if (table) { try { b.closeWindow(window); } catch { /* ignore */ } } else this.emit('inventory_close');
    }
    const per = recipe.result?.count ?? 1;
    return Math.max(0, Math.round((this.invCount(resultId) - before) / per));
  }

  private async craftOnce(recipe: any, table: any, signal: AbortSignal, times = 1) {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
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
  private async craftUpTo(id: number, count: number, table: any, signal: AbortSignal): Promise<number> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    let made = 0;
    while (made < count) {
      throwIfAborted(signal);
      const any = b.recipesFor(id, null, 1, table)[0];
      if (!any) break;
      const per = any.result?.count ?? 1;
      const times = Math.max(1, Math.ceil((count - made) / per));
      const bulk = times > 1 ? b.recipesFor(id, null, times * per, table)[0] : null;
      const before = this.invCount(id);
      // 先按玩家的做法整批做（每格放一叠料、shift 点产物）；不行再退回一次一个
      // 料够做几次（配方里每样要几个 × 次数 ≤ 背包里有的）
      const afford = (r: any) => Math.min(...(r.delta ?? []).filter((d: any) => d.count < 0).map((d: any) => Math.floor(this.invCount(d.id) / -d.count)));
      const recipe = bulk ?? any;
      const want = Math.max(1, Math.min(times, afford(recipe) || 1));
      const batched = await this.afterAction(() => this.craftBatch(recipe, want, table, signal), check);
      if (batched === null) {
        if (bulk) {
          await this.afterAction(() => this.craftOnce(bulk, table, signal, times), check);
        } else {
          await this.afterAction(() => this.craftOnce(any, table, signal, 1), check);
        }
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
      try { await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: table.position }, { signal, timeoutMs: 30000, constructionSafe: true }), check); }
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
            await this.afterAction(() => this.moveTo({ kind: 'place_block', pos: position }, { signal, timeoutMs: 8000, constructionSafe: true }), check);
            placed = await this.afterAction(() => this.placeBlockAt(position, ['crafting_table'], signal), check);
          }
          const observed = b.blockAt(position);
          if (placed.ok && observed?.name === 'crafting_table') { table = observed; this.bus.publish('place', 'P3', '放置并核对了工作台'); break; }
        } catch (error: any) { if (error?.name === 'AbortedError') throw error; check(); }
      }
    }
    if (table && !reachable(table)) await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: table.position }, { signal, timeoutMs: 15000, constructionSafe: true }), check);
    if (table && !reachable(table)) return null;
    return table;
  }

  async craft(item: string, count: number, signal: AbortSignal, opts: { tablePos?: Vec3Like; prepare?: boolean } = {}): Promise<ActionResult & { crafted: number; detail?: string; tablePos?: Vec3Like }> {
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
    let crafted = await this.afterAction(() => this.craftUpTo(data.id, count, table, signal), check);
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

  async pillarUp(itemNames: string[], signal: AbortSignal): Promise<ActionResult & { y?: number; clearanceDetail?: string }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot, epoch = this.actionEpoch;
    const feet = b.entity.position.floored();
    const below = b.blockAt(feet.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block') return { ok: false, reason: 'NO_REFERENCE' };
    const here = b.blockAt(feet);
    if (here && here.boundingBox === 'block') return { ok: false, reason: 'OCCUPIED' };
    // 脚下这格有火把、花、铁轨、按钮这类没碰撞但也不会被顶掉的东西：服务器不让往里放方块
    if (here && !/^(air|cave_air|void_air|water|short_grass|grass|tall_grass|fern|large_fern|dead_bush|seagrass|tall_seagrass|snow)$/.test(here.name)) return { ok: false, reason: `BLOCKED:${here.name}` };
    const item = b.inventory.items().find((i: any) => itemNames.includes(i.name));
    if (!item) return { ok: false, reason: 'NO_ITEM' };
    await this.afterAction(() => b.equip(item, 'hand'), check);
    b.clearControlStates();
    await this.afterAction(() => b.look(b.entity.yaw, -Math.PI / 2, true), check);
    // 站稳了再跳
    for (let i = 0; i < 20 && !b.entity.onGround; i++) await this.afterAction(() => sleep(25, signal), check);
    if (!b.entity.onGround) return { ok: false, reason: 'NOT_PLACED:尚未站稳' };
    const clearance = this.pillarClearance();
    if (clearance) return { ok: false, reason: `NOT_PLACED:头顶跳跃空间${clearance.kind === 'blocked' ? '受阻' : '未加载'}`, clearanceDetail: describePillarClearance(clearance) };
    let placed = false, lastError = '';
    {
      b.setControlState('jump', true);
      try {
        const t0 = Date.now();
        // 等脚底离开那一格（身体的底面高过方块顶面）才放，否则方块会和自己重叠，服务器不认
        while (b.entity.position.y < feet.y + 1.02 && Date.now() - t0 < 700) await this.afterAction(() => sleep(15, signal), check);
        if (b.entity.position.y >= feet.y + 1.02) {
          try { await this.afterAction(() => raceAbort(b.placeBlock(below, new Vec3(0, 1, 0)), signal, 2500, () => {}), check); placed = true; }
          catch (e: any) { if (e?.name === 'AbortedError') throw e; lastError = String(e?.message ?? e).slice(0, 80); }
        } else lastError = '跳不起来';
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
      const speed = Math.hypot(v.x, v.z);
      if (speed < 0.02) return null;
      const ahead = b.entity.position.offset((v.x / speed) * 0.7, 0, (v.z / speed) * 0.7);
      const at = (dy: number) => b.blockAt(ahead.offset(0, dy, 0))?.name ?? null;
      if ([0, -1].some((dy) => /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/.test(at(dy) ?? ''))) return 'lava';
      if (!b.entity.onGround) return null;
      const open = (n: string | null) => n === null || AIR_BLOCKS.has(n);
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
    if (!on) { this.actionContext.run(check, () => b.deactivateItem()); return { ok: true }; }
    const off = b.inventory.slots?.[45];
    if (off?.name !== 'shield') return { ok: false, reason: 'NO_SHIELD' };
    this.actionContext.run(check, () => b.activateItem(true));
    return { ok: true };
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
    b.pathfinder?.setGoal(null);
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

  async swimTo(target: Vec3Like | null, signal: AbortSignal, opts: SwimOptions = {}): Promise<ActionResult & { landed: boolean; oxygen: number }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', landed: false, oxygen: 0 };
    const b = this.bot, epoch = this.actionEpoch;
    const end = Date.now() + Math.max(100, Math.min(20000, opts.timeoutMs ?? 10000));
    let drySince: number | null = null;
    let lastProgress = Date.now(), anchor = b.entity.position.clone();
    let destination = target, nextObservation = 0, nextTurn = Date.now() + 750;
    const water = (block: any) => !!block && (['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(block.name) || String(block.getProperties?.().waterlogged) === 'true');
    const headUnder = () => water(b.blockAt(b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0)));
    const dryFooting = () => {
      const p = b.entity.position;
      const support = b.blockAt(p.offset(0, -0.05, 0));
      const head = b.blockAt(p.offset(0, b.entity.eyeHeight ?? 1.62, 0));
      return !!b.entity.onGround && !b.entity.isInWater && !!head && !water(head) && support?.boundingBox === 'block' && !water(support);
    };
    check();
    b.pathfinder?.setGoal(null);
    b.clearControlStates();
    try {
      while (Date.now() < end) {
        check();
        const dry = dryFooting();
        if (dry && ownOxygen(b) >= 18) {
          drySince ??= Date.now();
          if (Date.now() - drySince >= 600) return { ok: true, landed: true, oxygen: ownOxygen(b) };
        } else drySince = null;
        // A brief breach of the water surface is not a landing. Keep ascending
        // until there is actual support, then release jump and let the body settle.
        // 只在水里按跳（上浮、借撞岸的那一下爬上去）。人已经出水、只是还没落稳时还按着，落地那一刻又起跳，
        // 就会在岸上一下一下地跳个不停，一直跳到超时
        b.setControlState('jump', !dry && (!!b.entity.isInWater || headUnder()));
        b.setControlState('sprint', false);
        if (!destination && opts.observeShore && Date.now() >= nextObservation) {
          destination = opts.observeShore();
          nextObservation = Date.now() + 250;
          if (destination) { lastProgress = Date.now(); anchor = b.entity.position.clone(); }
        }
        if (!destination && opts.observeShore && !dry && Date.now() >= nextTurn) {
          // Keep jump held while turning and refreshing the view; separate
          // jump/scan actions let the player sink during every camera turn.
          await this.afterAction(() => b.look(b.entity.yaw + Math.PI / 2, -0.1, true), check);
          nextTurn = Date.now() + 1000;
        }
        const p = b.entity.position;
        const distance = destination ? Math.hypot(destination.x - p.x, destination.z - p.z) : 0;
        if (destination && distance > 0.35 && !dry) {
          await this.afterAction(() => b.look(Math.atan2(p.x - destination!.x, p.z - destination!.z), 0, true), check);
          b.setControlState('forward', true);
        } else b.setControlState('forward', false);
        if (p.distanceTo(anchor) >= 0.3) { lastProgress = Date.now(); anchor = p.clone(); }
        // 贴着岸往上爬时水平位置本来就不动（靠水里撞墙的上抬一点点爬上去）：多给点时间，别刚贴上岸就算没进展
        const climbingBank = !!b.entity.isCollidedHorizontally && distance <= 1.6;
        if (!dry && destination && Date.now() - lastProgress >= (climbingBank ? 5000 : 2500)) return { ok: false, reason: 'SWIM_NO_PROGRESS', landed: false, oxygen: ownOxygen(b) };
        if (typeof b.waitForTicks === 'function') await this.afterAction(() => raceAbort(b.waitForTicks(2), signal, 2000, () => {}), check);
        else await this.afterAction(() => sleep(100, signal), check);
      }
      return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, oxygen: ownOxygen(b) };
    } finally {
      // A replaced task owns the controls now; stopAll already released ours.
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
        await this.afterAction(async () => { b.activateItem(); await sleep(400, signal); b.deactivateItem(); }, check);
        return { ok: true, effectEvidence: { verified: false, changed: false, reasons: ['已执行自用动作，尚未验证最终效果'] } };
      }
      const block = b.blockAt(this.vec(target.pos));
      if (!block) return { ok: false, reason: 'NO_BLOCK' };
      if (this.mcData.blocksByName?.[item]) return await this.placeItemAgainst(item, block, check);
      if (/_boat$|_raft$/.test(item)) {
        // Boat use raycasts from the player's eyes. Aim inside the requested fluid
        // surface instead of the air at y+1; placeEntity would overwrite this aim.
        const level = Number(block.getProperties?.().level ?? 0);
        const height = block.name === 'water' && b.blockAt(block.position.offset(0, 1, 0))?.name !== 'water'
          ? 1 - ((level >= 8 ? 0 : level) + 1) / 9 : 1;
        const aim = block.position.offset(0.5, height - 0.01, 0.5);
        await this.afterAction(() => b.lookAt(aim, true), check);
        await this.afterAction(() => this.lookSynced(), check);
        const ids = new Set(Object.keys(b.entities ?? {}));
        const count = () => (b.inventory.items() as InvItem[]).filter((held) => held.name === item).reduce((sum, held) => sum + held.count, 0);
        const before = count();
        const appeared = () => Object.values(b.entities as Record<number, Entity>).find((entity) => !ids.has(String(entity.id))
          && /(^|_)(boat|raft)$/.test(entity.name ?? '') && entity.position.distanceTo(aim) < 3);
        await this.afterAction(async () => { b.activateItem(); b.deactivateItem(); }, check);
        const confirmed = await this.waitForInteraction(() => !!appeared(), check, 5000);
        const entity = appeared(), consumed = before - count();
        const reasons = [...(entity ? [`目标附近出现新实体 ${entity.name} #${entity.id}`] : ['目标附近没有确认新船实体']),
          ...(consumed > 0 ? [`背包 ${item} 减少 ${consumed}`] : [])];
        const effectEvidence = { verified: true, changed: !!entity || consumed > 0, reasons };
        return confirmed && entity ? { ok: true, spawned: entity.name ?? item, effectEvidence }
          : { ok: false, reason: `ENTITY_NOT_SPAWNED:目标附近没有确认新船${consumed > 0 ? '，但背包里的船已减少' : '，背包里的船未减少'}`, effectEvidence };
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
      // 对着液体用（水桶装水/倒水等）：先看向液面再“使用物品”；其他情况按“对方块右键”
      const fluid = ['water', 'lava'].includes(block.name);
      const changed = this.blockInteractionChange(block);
      await this.afterAction(() => b.lookAt(block.position.offset(0.5, fluid ? 0.85 : 0.5, 0.5), true), check);
      if (fluid) await this.afterAction(() => this.lookSynced(), check);
      if (fluid) await this.afterAction(async () => { b.activateItem(); await sleep(250, signal); b.deactivateItem(); }, check);
      else await this.afterAction(() => b.activateBlock(block), check);
      return await this.waitForInteraction(changed, check) ? { ok: true, effectEvidence: { verified: true, changed: true, reasons: changed.reasons() } } : { ok: false, reason: 'NO_EFFECT:目标方块、邻格和背包均未变化', effectEvidence: { verified: true, changed: false, reasons: ['目标、邻格和背包均未变化'] } };
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

  private dugLog: { pos: Vec3Like; name: string; ts: number }[] = [];
  recentDug(since: number) { return this.dugLog.filter((d) => d.ts > since); }

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
    if (!this.ready || !b.vehicle) return { ok: false, reason: 'NOT_MOUNTED' };
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

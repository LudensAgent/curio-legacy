/**
 * GameAdapter：上层（技能、反射层、感知）访问游戏的唯一接口。
 * MVP 用 MineflayerAdapter 实现；以后接 Create 时换成服务端 Mod 适配器，上层代码不变。
 * 所有数据都是结构化的游戏状态，不依赖截图或多模态识图。
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type EntityKind = 'hostile' | 'passive' | 'player' | 'item' | 'other';

export interface EntityInfo {
  id: number;
  /** Hearing can orient a search or retreat, but is not a precise firing target. */
  perception?: 'seen' | 'heard';
  name: string;
  kind: EntityKind;
  pos: Vec3Like;
  dist: number;
  height?: number;
  velocity?: Vec3Like;
  phase?: number;
  hp?: number;
  /** 苦力怕正在嘶嘶作响、马上要炸 */
  fusing?: boolean;
  /** 一眼看得出的特征：羊毛颜色/剪没剪、幼崽、村民职业和等级、驯没驯服、带电…… */
  traits?: string;
  /** 掉落物的数量（name 形如 item:raw_rabbit） */
  count?: number;
}

export interface BossDeathObservation {
  entityId: number;
  worldId: string;
  dim: string;
  sessionId: string;
  observedAt: number;
  pos: Vec3Like;
  source?: 'entity_dead' | 'zero_health_dying';
}

/** 方块的“光学”属性：视线能否穿过 */
export type Opacity = 'clear' | 'water' | 'foliage' | 'solid';

export interface Optics {
  name: string;
  kind: Opacity;
  /** State-specific opaque AABBs in block-local coordinates; gaps are optical openings. */
  shapes?: ReadonlyArray<readonly [number, number, number, number, number, number]>;
}

/** 眼睛位置与朝向（yaw: 0 = 北(-Z)，正值向左转；pitch: 正值抬头） */
export interface Eye {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface BlockHit {
  name: string;
  pos: Vec3Like;
  dist: number;
}

export interface InvItem {
  name: string;
  count: number;
  /** 此物品每叠的数量上限，不代表同名物品一定能合并 */
  stackSize?: number;
  /** 普通背包和快捷栏中的实际分叠，不代表各叠数据相同 */
  stacks?: { slot: number; count: number }[];
  /** 会磨损的东西（工具、武器、护甲）：同名里最旧那件还剩多少耐久 / 满耐久 */
  durability?: { left: number; max: number };
  /** 同名每一件各剩多少耐久（从好到差）：只看最旧那件，会以为 11 把镐全是快坏的 */
  durabilities?: number[];
  /** 带附魔 */
  enchanted?: boolean;
}

/** Occupied player inventory slots, retaining the identity hidden by name totals. */
export interface InventorySlot {
  slot: number;
  name: string;
  count: number;
  stackSize?: number;
  durability?: { left: number; max: number };
  enchants?: string[];
  customName?: string;
  nbt?: unknown;
}

export interface AgentState {
  connected: boolean;
  alive: boolean;
  /** True only after spawn and the current position's chunk are available. */
  observationReady: boolean;
  /** Stable server/world namespace; dimensions are a separate scope. */
  worldId: string;
  /** Changes after reconnect, respawn or a dimension transition. */
  sessionId: string;
  observationId: number;
  username: string;
  pos: Vec3Like;
  dim: string;
  hp: number;
  food: number;
  oxygen: number;
  timeOfDay: number;
  /** 身上的状态效果（中毒、饥饿、缓慢……）：名字、等级、还剩几秒 */
  effects?: { name: string; level: number; seconds: number }[];
  /** 经验等级（附魔、修理要用） */
  xp?: { level: number; progress: number };
  /** 天气（服务端广播的雨、雷）：clear | rain | thunder */
  weather?: 'clear' | 'rain' | 'thunder';
  /** 世界的第几天（从 0 起，服务端的 time.day） */
  worldDay?: number;
  /** 累积服务器 tick（time.age）；睡觉或修改昼夜时间不会直接跳过这些 tick。 */
  worldAgeTicks?: number;
  /** 服务器当前的游戏难度（peaceful | easy | normal | hard）；未就绪时不提供 */
  difficulty?: 'peaceful' | 'easy' | 'normal' | 'hard';
  /** 服务端广播的规则（keepInventory、doDaylightCycle、mobGriefing 等）；值为字符串或数字 */
  gamerules?: Record<string, string | number | boolean>;
  isDay: boolean;
  biome: string | null;
  onGround: boolean;
  inWater: boolean;
  inLava: boolean;
  inventory: InvItem[];
  emptySlots: number;
  held: string | null;
  /** 手里那件还剩多少耐久（会磨损的东西才有） */
  heldDurability?: { left: number; max: number };
  /** 快捷栏 0-8 格的物品名，空格为 null */
  hotbar?: (string | null)[];
  hotbarSelected?: number;
  /** 正在乘坐的载具/坐骑（boat、minecart、horse…），没有为 null */
  riding?: string | null;
  equipment?: { slot: string; name: string; durabilityRemaining?: number }[];
}

export type MoveTarget =
  | { kind: 'near'; pos: Vec3Like; range: number }
  | { kind: 'xz'; x: number; z: number; range: number }
  /** 站到这一格；普通移动不改地形，明确挖掘/爬升动作可另行授权。 */
  | { kind: 'xyz'; x: number; y: number; z: number }
  | { kind: 'reach_block'; pos: Vec3Like }
  | { kind: 'place_block'; pos: Vec3Like; facing?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down' }
  | { kind: 'follow_entity'; entityId: number; range: number }
  | { kind: 'away_from'; pos: Vec3Like; distance: number };

export interface MoveOpts {
  signal: AbortSignal;
  timeoutMs: number;
  constructionSafe?: boolean;
  /** 仅明确的挖掘/爬升动作允许寻路挖块和搭建；日常移动默认绕行。 */
  allowTerrainChanges?: boolean;
  /** 是否允许寻路放置支撑方块；未指定时沿用 allowTerrainChanges 的旧行为。 */
  allowPlace?: boolean;
  /** 是否允许寻路原地搭柱；未指定时沿用 allowPlace。 */
  allowTower?: boolean;
  /** 步行引导可禁止入水；换气、游泳等动作保留自己的移动权限。 */
  allowSwimming?: boolean;
  /** 跑着去（快但很耗饥饿：每跑一格掉的饥饿相当于走路的很多倍）；不写就走路。逃离（away_from）默认跑 */
  sprint?: boolean;
  /** 明确落点的单步下行上限，含支撑格；仅用于相邻 xyz 目标，禁止改地形和绕行。 */
  maxDropDown?: number;
  /** 这一趟寻路要绕开的方块名（不踩进去、不穿过） */
  avoid?: string[];
}

export interface EffectEvidence {
  verified: boolean;
  changed: boolean;
  reasons: string[];
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  /** 挖掉了，但手上没有对应的工具，什么都没掉（空手挖石头） */
  noDrop?: boolean;
  /** 实际挖了多久（毫秒） */
  digMs?: number;
  effectEvidence?: EffectEvidence;
}

/** 界面操作：往某格放东西、从某格取（shift 点击）、点界面按钮（切石机配方、织布机图案、附魔选项）、铁砧改名 */
export type GuiOp =
  | { put: { item: string; slot: number; count?: number; sourceSlot?: number } }
  | { take: { slot: number } }
  | { button: number }
  | { rename: string }
  | { click: { slot: number; button: number; mode: 0 | 1 | 2 | 3 | 4 } }
  | { beacon: { primary: number | null; secondary: number | null } };

export type GuiTarget = Vec3Like | { entityId: number } | 'inventory';

export interface GuiSlot { slot: number; role?: string; name: string | null; count: number; enchants?: string[]; customName?: string; nbt?: unknown }

/** 打开的界面里看得见的东西：每一格放着什么，附魔台的三个选项 */
export interface GuiView {
  type: string;
  slots: GuiSlot[];
  enchantments?: { option: number; level: number; hint?: string }[];
  inventoryStart?: number;
  cursor?: InventorySlot | null;
}

/** Only synchronized observations of a local storage block, never a requested transfer plan. */
export interface GuiContainerObservation {
  block: string;
  /** 容器总格数：单箱/木桶 27、双箱 54、潜影盒 27（开箱时同步得到才有） */
  capacity?: number;
  /** 完全空着的格子数。注意不是「还能塞多少」也不是总容量（总容量看 capacity）：
   *  0 格空时，箱里已有的未满同名堆叠仍能继续补满同类物品 */
  freeSlots?: number;
  before: { name: string; count: number }[];
  after: { name: string; count: number }[];
  put: { name: string; count: number }[];
  took: { name: string; count: number }[];
}

export interface GuiResult extends ActionResult {
  view?: GuiView;
  done: string[];
  container?: GuiContainerObservation;
}

/** 熔炉三格里各有什么 */
export interface FurnaceSlots {
  input: { name: string; count: number } | null;
  output: { name: string; count: number } | null;
  fuel: { name: string; count: number } | null;
}
export interface FurnaceLeave extends FurnaceSlots { pos: Vec3Like; block: string; burning: boolean; why?: string }
export interface SmeltOpts {
  /** Explicit permission to manufacture/place a missing furnace. Defaults to false. */
  prepare?: boolean;
  furnacePos?: Vec3Like;
  onProgress?: (done: number) => void;
  /** 主燃料用完后可以接着补的燃料（按先后） */
  moreFuels?: string[];
  /** 离开熔炉时（包括被打断）里面还剩什么 */
  onLeave?: (state: FurnaceLeave) => void;
}
export interface SmeltResult extends ActionResult {
  made: number;
  output?: string;
  furnacePos?: Vec3Like;
  /** 没烧完的原料取回了几个 */
  returned?: number;
  /** 为什么没烧完：燃料用完 / 卡住不动 / 等太久 */
  stopped?: 'out_of_fuel' | 'stalled' | 'deadline';
  left?: FurnaceSlots;
}

export interface TradeView {
  index: number;
  give: string[];
  get: string;
  uses: number;
  maxUses: number;
  disabled: boolean;
}

export interface SwimOptions {
  timeoutMs?: number;
  /** Refresh only ordinary senses; returning null keeps the swimmer afloat while looking. */
  observeShore?: () => Vec3Like | null;
}

export interface BlockState {
  name: string;
  properties: Record<string, string | number | boolean>;
}

/** A fresh, line-of-sight observation; model supplied coordinates are not evidence. */
export interface BlockObservation extends BlockState {
  pos: Vec3Like;
  worldId: string;
  sessionId: string;
  dimension: string;
  observationId: number;
  observedAt: number;
  source: 'vision';
}

export interface UseItemOptions {
  chargeMs?: number;
  /** A concrete observed world point; the adapter verifies the clear ray and sends the aim before use. */
  aim?: Vec3Like;
}

/** 直接操纵身体时按住的键 */
export interface DriveKeys { forward?: boolean; back?: boolean; left?: boolean; right?: boolean; jump?: boolean; sprint?: boolean; sneak?: boolean }
export interface DriveOptions {
  /** 一边走一边一直盯着这个实体（打架时走位）或这个点 */
  faceEntity?: number; facePoint?: Vec3Like;
  /** 默认 true：前面是岩浆/火、或者一脚下去会摔三格以上就停下（身体本能，不是打法） */
  guard?: boolean;
}
export interface DriveResult extends ActionResult { moved: number; ms: number; stopped?: 'lava' | 'cliff' | 'hurt_stop' }

export interface GameAdapter {
  on(event: AdapterEvent, cb: (...args: any[]) => void): this;

  state(): AgentState;
  inventorySlots?(): InventorySlot[];

  // ---- 视觉原语（只给 Vision 模块使用；上层只能拿到 Vision 的结果，避免透视）
  eye(): Eye | null;
  /** 返回 null 表示区块未加载 */
  blockOptics(x: number, y: number, z: number): Optics | null;
  lightAt(x: number, y: number, z: number): { block: number; sky: number } | null;
  /** (x,y,z) 所在的 16³ 区段是否全是空气（视觉射线据此整段跳过；可选优化） */
  sectionEmpty?(x: number, y: number, z: number): boolean;
  /** 服务器实际下发的渲染距离（格），未知时返回 null */
  renderDistance?(): number | null;

  /** 原始实体列表（服务端追踪范围内，含墙后的）。上层请用 Vision.perceivedEntities。 */
  nearbyEntities(radius: number): EntityInfo[];
  /** 原始方块搜索（会穿墙）。上层请用 Vision.knownBlocks；这里只留给调试。 */
  findBlocks(names: string[], maxDist: number, count: number): BlockHit[];
  blockAt(pos: Vec3Like): string | null;
  blockStateAt?(pos: Vec3Like): BlockState | null;
  /** 'log' → 所有原木；'iron_ore' → iron_ore + deepslate_iron_ore；精确名 → 自身 */
  resolveBlockNames(query: string): string[];
  isKnownItem(name: string): boolean;
  /** 所有已知物品名（控制台「给予物品」搜索用） */
  listItems?(): string[];

  moveTo(target: MoveTarget, opts: MoveOpts): Promise<void>;
  /** 释放一切：停止寻路、清除按键、停止挖掘/使用物品。 */
  stopAll(): void;

  canHarvest(pos: Vec3Like): boolean;
  /** 估算用某个工具（null = 空手）挖一个方块需要的毫秒数；未知返回 null */
  digTimeEstimate(block: string, tool: string | null): number | null;
  /** 用背包里 itemNames 中的第一种方块，放到 pos（需要相邻有实心方块可依附） */
  placeBlockAt(pos: Vec3Like, itemNames: string[], signal: AbortSignal): Promise<ActionResult>;
  placeBlockStateAt?(pos: Vec3Like, name: string, properties: BlockState['properties'], signal: AbortSignal): Promise<ActionResult>;
  /** 打开看得见的方块界面（工作站、容器），依次执行操作，返回关之前看到的界面 */
  useGui?(target: GuiTarget, ops: GuiOp[], signal: AbortSignal, opts?: { onContainer?: (observation: GuiContainerObservation) => void }): Promise<GuiResult>;
  signText?(pos: Vec3Like, signal: AbortSignal, opts?: { lines?: string[]; back?: boolean }): Promise<ActionResult & { lines?: string[] }>;
  editBook?(sourceSlot: number, pages: string[], signal: AbortSignal, title?: string): Promise<ActionResult>;
  /** 打开村民/流浪商人的交易界面；index 为 null 时只看交易列表 */
  tradeWith?(entityId: number, index: number | null, times: number, signal: AbortSignal): Promise<ActionResult & { trades: TradeView[]; traded: number }>;
  /** face：朝这一点扔；gift：是扔给别人的（不记成自己扔掉的） */
  tossItem?(name: string, count: number | null, signal: AbortSignal, face?: Vec3Like, opts?: { gift?: boolean; sourceSlot?: number }): Promise<ActionResult & { tossed: number }>;
  arrangeHotbar?(name: string, index: number, signal: AbortSignal, opts?: { sourceSlot?: number }): Promise<ActionResult>;
  equipItem?(name: string | null, destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet', signal: AbortSignal, opts?: { sourceSlot?: number }): Promise<ActionResult>;
  /** item='' performs a legal empty-hand interaction (for example opening an owned door). */
  useBlockAt?(pos: Vec3Like, item: string, signal: AbortSignal): Promise<ActionResult>;
  useItem?(item: string, signal: AbortSignal, opts?: UseItemOptions): Promise<ActionResult>;
  rangedAttack?(entityId: number, signal: AbortSignal): Promise<ActionResult>;
  /**
   * 原地垫高一格：跳起来、等身体真的离开脚下那格再往脚下放方块、落地后确认真的站在新方块上。
   * （交给寻路去“走到上面一格”时，寻路在跳到最高点就认为到了、方块还没放，人又掉回去——看起来垫了，其实没有）
   */
  pillarUp?(itemNames: string[], signal: AbortSignal): Promise<ActionResult & { y?: number; clearanceDetail?: string; clearance?: { at?: [number, number, number]; facing?: string; cells?: { at: [number, number, number]; facing: string }[] }; waterDepth?: number }>;
  /** 按住移动键 ms 毫秒（≤1000）：拉开距离、侧移绕圈、跳劈、潜行都靠它 */
  drive?(keys: DriveKeys, ms: number, signal: AbortSignal, opts?: DriveOptions): Promise<DriveResult>;
  /** 举起/放下副手的盾 */
  raiseShield?(on: boolean, signal: AbortSignal): Promise<ActionResult>;
  /** 拉弓（或其它要蓄力的东西）开始蓄力；releaseDraw 朝 aim 松手，返回蓄了多久 */
  startDraw?(item: string, signal: AbortSignal): Promise<ActionResult>;
  releaseDraw?(signal: AbortSignal, aim?: Vec3Like): Promise<ActionResult & { chargedMs: number }>;
  /** 身体此刻的战斗相关状态：手上是否在用东西（举盾/拉弓）、副手拿着什么 */
  combatState?(): { usingItem: boolean; offHand: string | null; drawingSinceMs: number | null };
  enterPortalAt?(pos: Vec3Like, signal: AbortSignal, expectedDim?: string): Promise<ActionResult & { from?: AgentState; to?: AgentState }>;
  bossStatus?(): { dragonDeath: BossDeathObservation | null };
  dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult>;
  /** 这个掉落物是不是自己几分钟前扔掉的（只是事实，捡不捡由心智和技能自己定） */
  isDiscarded?(item: string, pos: Vec3Like): boolean;
  /** 改主意了（指名要捡回某样扔掉的东西）：不再当它是扔掉的，捡回来也不算“又捡回来了” */
  forgetDiscarded?(item: string): void;
  /** 自己挖掉的方块（动作、代码技能、寻路挖穿的都算），since 之后的；用来记自己挖过的通道 */
  recentDug?(since: number): { pos: Vec3Like; name: string; ts: number }[];
  collectNearbyDrops(signal: AbortSignal, radius: number, timeoutMs: number): Promise<number>;
  /** 只合成指定目标；prepare:true 才补做两层前置材料并制造/放置工作台。tablePos = 已知工作台位置；batchSize = 每批最多执行配方的次数（1–64），不是产物个数 */
  /** detail：失败时具体缺什么；tablePos：这次用到的工作台位置（便于记住、下次复用） */
  craft(item: string, count: number, signal: AbortSignal, opts?: { tablePos?: Vec3Like; prepare?: boolean; batchSize?: number }): Promise<ActionResult & { crafted: number; detail?: string; tablePos?: Vec3Like }>;
  /** 睡在身边的床上（没有就把背包里的床放下）；一直睡到醒来 */
  /** at：要睡的那张床（村子里几张床挨着时用来认准）；床被村民睡着会先把它叫醒 */
  sleepInBed(signal: AbortSignal, opts?: { at?: Vec3Like }): Promise<ActionResult & { bedPos?: Vec3Like }>;
  /** 用熔炉烧东西：furnacePos = 记得的熔炉；没有就用背包里的熔炉放下。返回烧出的数量 */
  smelt(input: string, count: number, fuel: string, signal: AbortSignal, opts?: SmeltOpts): Promise<SmeltResult>;
  /** 打开熔炉取回烧好的和没烧的（fuel:true 连燃料一起） */
  emptyFurnace?(pos: Vec3Like, signal: AbortSignal, opts?: { fuel?: boolean }): Promise<ActionResult & { taken: { name: string; count: number }[]; left: FurnaceSlots; burning: boolean }>;
  /** 打开箱子：存入 deposits / 取出 withdraws，返回箱子里现在的物品 */
  useChest(pos: Vec3Like, deposits: InvItem[], withdraws: InvItem[], signal: AbortSignal, opts?: { onContainer?: (observation: GuiContainerObservation) => void }): Promise<ActionResult & { contents: InvItem[]; moved: number; container?: GuiContainerObservation }>;
  /** 用锄头把泥土/草方块锄成耕地 */
  till(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult>;
  /** 在耕地上播种（seed: wheat_seeds / carrot / potato / beetroot_seeds） */
  plant(pos: Vec3Like, seed: string, signal: AbortSignal): Promise<ActionResult>;
  /** 作物生长阶段：{age, max}；不是作物返回 null */
  cropAge(pos: Vec3Like): { age: number; max: number } | null;
  hasFood(): boolean;
  /** item：指定吃哪样（不写挑背包里最好的） */
  eat(signal: AbortSignal, item?: string): Promise<boolean>;
  equipWeapon(signal?: AbortSignal): Promise<void>;
  attack(entityId: number, signal?: AbortSignal): Promise<boolean>;
  look(yaw: number, pitch: number, signal?: AbortSignal): Promise<void>;
  jump(ms: number, signal: AbortSignal): Promise<void>;
  /** Swim toward an observed shore, retaining buoyancy until dry footing is verified. */
  swimTo?(target: Vec3Like | null, signal: AbortSignal, opts?: SwimOptions): Promise<ActionResult & { landed: boolean; oxygen: number }>;
  /** 在水里朝一格游过去（往下潜或往上游）：到了、气不够了（oxygen ≤ minOxygen）、出了水或超时就停 */
  diveTo?(target: Vec3Like, signal: AbortSignal, opts?: { minOxygen?: number; timeoutMs?: number }): Promise<ActionResult & { reached: boolean; oxygen: number }>;

  // ---- 通用基础动作：玩家的“右键”和“方向键”。上层用它们组合出技能清单里没有的玩法
  /** 手持 item 右键：对着一个方块/水面（block），或对空中/自己（self） */
  useItemOn?(item: string, target: { kind: 'block'; pos: Vec3Like } | { kind: 'self' }, signal: AbortSignal): Promise<ActionResult & { spawned?: string; placed?: Vec3Like }>;
  /** 右键一个实体：船/矿车/马会坐上去，其他生物按手上物品交互（喂食、繁殖、剪毛、交易…） */
  interactEntity?(entityId: number, item: string | null, signal: AbortSignal): Promise<ActionResult & { mounted?: string }>;
  /** 从载具/坐骑上下来；toward = 先面朝这个点（原版下船时按乘客朝向挑落点，面朝岸边就会落到岸上） */
  dismount?(signal: AbortSignal, opts?: { toward?: Vec3Like }): Promise<ActionResult>;
  /**
   * 操控正在乘坐的载具朝 target 前进；stop() 返回 true 时停下。
   * via = 先依次经过的点（水路寻路拉直后的拐点）；arriveWithin = 离 target 多近算到（默认 2 格）
   */
  ride?(target: { x: number; z: number }, signal: AbortSignal, opts: { timeoutMs: number; stop?: () => boolean; via?: { x: number; z: number }[]; arriveWithin?: number }): Promise<ActionResult & { arrived: boolean; blocked?: boolean; moved: number }>;
  /**
   * 鞘翅滑翔到已知坐标：起飞/巡航/避障/着陆在一趟连续控制里完成（速度约 30 格/秒，不逐格问）。
   * 只执行 Agent 已选定的目的地与火箭预算，报告真实结果：是否落地、是否到达、是否撞伤、消耗几发火箭。
   */
  glideTo?(target: Vec3Like, signal: AbortSignal, opts: { timeoutMs: number; allowRockets?: boolean; maxRockets?: number }): Promise<ActionResult & { arrived: boolean; landed: boolean; crashed: boolean; rocketsUsed: number; distance: number; position: Vec3Like; hpLost: number }>;
  /**
   * 甩一次竿钓鱼：手持 fishing_rod 朝 aim（水面方块）甩出，咬钩自动收竿；timeoutMs 内没咬钩就收竿（reason NO_BITE）。
   * caught = 实际进了背包的东西（cod、salmon…）；没有钓鱼竿 reason = NO_ROD
   */
  fish?(signal: AbortSignal, opts: { aim?: Vec3Like; timeoutMs: number }): Promise<ActionResult & { caught?: string }>;
  chat(text: string): void;
}

/**
 * 适配器事件：
 * spawn / death / respawn / hurt / disconnected / kicked / chat(username, message) / game_message(text, position)
 */
export type AdapterEvent = 'spawn' | 'death' | 'respawn' | 'hurt' | 'disconnected' | 'kicked' | 'chat' | 'game_message'
  /** 捡起了自己刚扔掉的东西：{ item, count } */
  | 'recollected';

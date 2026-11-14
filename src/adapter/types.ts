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

/**
 * 连续脚位到达的实测容差（格）。与库 GROUNDED_ARRIVAL_DEFAULTS 的
 * horizontalTolerance=0.12、feetTolerance=0.05 一致；这是身体控制的
 * 实际精度声明，不是用来放宽调用者目标的吸附半径。
 */
export const FEET_ARRIVAL_TOLERANCE = { horizontal: 0.12, vertical: 0.05 } as const;

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

/** 一次穿门尝试里身体实际经历的时间线；失败时用它如实说明“人有没有进门、在门里待了多久”。 */
export interface PortalTransitionFacts {
  /** 开始时身体是否已经压在门方块上 */
  startedInPortal: boolean;
  /** 这次尝试期间身体是否真的与门方块重叠过（进入后又离开也算 true） */
  entered: boolean;
  /** 从开始到真正退出门方块的毫秒数；开始时不在门里为 null */
  exitMs: number | null;
  /** 退出门后到身体重新压回门方块的毫秒数；没有重新进入为 null */
  outsideMs: number | null;
  /** 结束时身体连续停留在门方块里的毫秒数；此刻不在门里为 0（曾经进入过看 entered） */
  insideMs: number;
  /** 结束时实际观察到的维度 */
  endDim: string;
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
  /** 身体 AABB 当前压着的门方块名（nether_portal/end_portal）；不在门里为 null。触觉事实，不受视野限制。 */
  bodyPortal?: string | null;
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
  equipment?: { slot: string; name: string; durabilityRemaining?: number; durabilityMax?: number }[];
}

export type MoveTarget =
  | { kind: 'near'; pos: Vec3Like; range: number }
  /** footY：可选的终点脚格高度范围 [min,max]（含端点）；不写则任何高度都算到达。 */
  | { kind: 'xz'; x: number; z: number; range: number; footY?: [number, number] }
  /** 站到这一格；y 是脚高，可为分数（半砖/雪层等薄层，如 64.5）。普通移动不改地形，明确挖掘/爬升动作可另行授权。 */
  | { kind: 'xyz'; x: number; y: number; z: number }
  /** 精确连续脚位（x/z 是身体中心连续坐标，不取格心）；用于 land-search 的格点执行，不改变 xyz 的旧语义。 */
  | { kind: 'feet'; x: number; y: number; z: number }
  /**
   * 已复验的梯子过渡：从当前格列进入/退出到相邻一格，或在同一列上下。
   * 身体控制只允许在这两个格列内移动，不挖、不放、不绕行；到达仍由调用方
   * 实测端点验收。
   */
  | { kind: 'ladder'; x: number; y: number; z: number }
  | { kind: 'reach_block'; pos: Vec3Like }
  | { kind: 'place_block'; pos: Vec3Like; facing?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down' }
  | { kind: 'follow_entity'; entityId: number; range: number }
  | { kind: 'away_from'; pos: Vec3Like; distance: number };

export interface MoveOpts {
  /** 只走/跳/下到已检查的相邻 xyz 格列。调用方可指定距目标格心的最大水平距离。 */
  adjacentStep?: boolean | { centerRadius: number };
  /**
   * feet 目标：允许一次同脚高的水平起跳跨越已证实的空腔。目标必须与实测
   * 脚高相同；身体控制走到起点格列边缘起跳、只在不疾跑可覆盖的有限距离内尝试，不改变目标或
   * 自动搭桥。
   */
  horizontalJump?: boolean;
  /**
   * 仅连续脚位（feet）身体控制消费：实测身体位置到原 origin→bearing 轴线的横向距离不得超过 maxLateral。
   * 超出即停止本动作、保留实测位置并返回事实；不用 FEET_ARRIVAL_TOLERANCE 当作横向授权，也不把身体挪回走廊。
   */
  corridor?: {
    origin: Vec3Like; bearing: { x: number; z: number }; maxLateral: number;
    /** 仅方向委托的末点需要：实测沿冻结轴线的进度达到此距离后才算停稳到位。 */
    minimumAlong?: number;
  };
  signal: AbortSignal;
  timeoutMs: number;
  /**
   * 允许（不是要求）入水。陆地路线不会因这份授权静默改成游泳模式；
   * 受控下落入水、swim_path/dive_to 仍按各自原语执行。
   */
  allowSwimming?: boolean;
  /** 跑着去（快但很耗饥饿：每跑一格掉的饥饿相当于走路的很多倍）；不写就走路（逃离也一样，要跑就写 true） */
  sprint?: boolean;
  /** 明确落点的单步下行上限（1–32 整数）；feet 按实测落差，xyz 旧接口含支撑格。仅相邻落点，禁止改地形和绕行；feet 省略时最多下落 1 格。 */
  maxDropDown?: number;
  /** 内部连续路线的中间 feet 点可 false：实测落地到位后交接，保留速度；调用方负责下一段当前几何复验。末点默认等到完全停稳。 */
  settleAtTarget?: boolean;
  /**
   * 只要求实测站进目标格列、脚高相符，不要求进入 0.12 格脚位窗。中间点（settleAtTarget:false）用于同向直行、
   * 台阶与小落差，调用方从实测位置复验下一段真实几何；停稳的末点用于原目标本身就是一个格子的情况。
   */
  passColumn?: boolean;
  /**
   * 连续路线接续：上一段在 physicsTick 里复验通过并保留了前进键，且本段方向未变。
   * 跳过重新转向和 clearControlStates，重新按下前进键；调用方必须在交接前复验下一步。
   */
  keepControls?: boolean;
  /**
   * 连续路线中间点交接：在 physicsTick 内到达当前脚位时调用，参数是当时的实测位置。
   * 返回 true 表示调用方已经预先复验下一步有效：本次控制不释放运动键，由调用方紧接着的
   * 下一段身体控制接续；返回 false 或省略时按原逻辑制动。仅在 settleAtTarget 为 false 时有意义。
   */
  onCheckpoint?: (measured: Vec3Like) => boolean;
}

/**
 * 非本地移动的导航委托：由 runSkill 在任务生命周期内通过 withNavigation 绑定，
 * 把通用 MoveTarget 的完成条件翻译成宿主已观测体素上的有界路线。
 * 委托负责路线搜索与执行；不得回调 moveTo 处理非本地目标（避免递归/旧后端回退）。
 */
export interface NavigationDelegate {
  navigate(target: MoveTarget, opts: MoveOpts): Promise<void>;
}

export interface EffectEvidence {
  verified: boolean;
  changed: boolean;
  reasons: string[];
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  /** Human-readable refinement of a refusal (e.g. no solid face vs. a face that cannot be clicked from here). */
  detail?: string;
  /** 挖掉了，但手上没有对应的工具，什么都没掉（空手挖石头） */
  noDrop?: boolean;
  /** 实际挖了多久（毫秒） */
  digMs?: number;
  effectEvidence?: EffectEvidence;
}

/**
 * 放置动作的附加事实：目标格实际出现的方块名，以及是否确认它是请求材料。
 * verified=false 只表示「有碰撞方块/未确认材料」，不能当成请求方块已放下。
 */
export interface PlacementEvidence {
  placedName?: string | null;
  verified?: boolean;
}

/** 放置失败时实际尝试过的参照方块与点击面；face 是从参照方块指向目标格的单位向量。 */
export interface PlacementFaceAttempt {
  ref: Vec3Like;
  face: [number, number, number];
  reason?: string;
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

/** What the caller's target was observed to be: dry footing, an in-water point, or no target (bounded ascent). */
export type SwimGoal = 'dry_shore' | 'surface_target' | 'surface_ascent';
/**
 * Observed body stage during one delegated swim. `landed` is a dry, stable
 * support result; `surface_reached` is reaching a caller-selected in-water
 * point; `surfaced` is the breathing-only ascent goal. They are not
 * interchangeable.
 */
export type SwimStage = 'approach' | 'swimming' | 'exiting' | 'landed' | 'surface_reached' | 'surfaced';

export interface SwimOptions {
  timeoutMs?: number;
}

/**
 * Facts the swim controller reports in addition to the legacy landed/surfaced/oxygen fields.
 * These are measured host body facts. The library land/water route evaluators are
 * `geometry_only` / `executable:false` and are never translated into execution
 * success or arrival evidence here.
 */
export interface SwimFacts {
  goal?: SwimGoal;
  stage?: SwimStage;
  /** Water contact was observed at least once during this delegation. */
  enteredWater?: boolean;
  /** Horizontal blocks moved since the delegation started (vertical bobbing is not progress). */
  advanced?: number;
  /** The caller's target cell was observed to be water. */
  targetInWater?: boolean;
  /** The caller's x or z is an integer, i.e. a block boundary rather than a block center. */
  targetOnEdge?: boolean;
  /** Observed block name at the caller's target feet cell. */
  targetCellName?: string | null;
  /** First non-air/non-fluid block above the head when the body stalls. */
  blockedAbove?: { x: number; y: number; z: number; name: string };
  /** Nearest observed water column with open space above, relative to the stalled body. */
  openWater?: { x: number; y: number; z: number; dir: string; dist: number };
  /** Target minus body position, measured when the body stalls. */
  targetDelta?: { x: number; y: number; z: number };
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
  /** false when only the name is known (blockStateAt unavailable); empty properties from a fallback are not complete state. */
  stateComplete?: boolean;
}

export interface UseItemOptions {
  chargeMs?: number;
  /** A concrete observed world point; the adapter verifies the clear ray and sends the aim before use. */
  aim?: Vec3Like;
}

/** 直接操纵身体时按住的键 */
export interface DriveKeys { forward?: boolean; back?: boolean; left?: boolean; right?: boolean; jump?: boolean; sprint?: boolean; sneak?: boolean }
export interface DriveOptions {
  /** 一边走一边一直盯着这个实体（打架时走位）；或水平朝向这个点、平视（贴近该点 0.3 格内不再转身） */
  faceEntity?: number; facePoint?: Vec3Like;
  /** 默认 true：前面是岩浆/火、或者一脚下去会摔三格以上就停下（身体本能，不是打法） */
  guard?: boolean;
  /**
   * 是否允许走进传送门（显式委托策略）。默认 true：门会接住人并传送，不是地形危险；
   * false 时把前方门方块当作停键条件。guard 不隐含“不会误入传送门”。
   */
  allowPortal?: boolean;
}
export interface DriveResult extends ActionResult { moved: number; ms: number; stopped?: 'lava' | 'cliff' | 'hurt_stop' | 'portal' }

export interface GameAdapter {
  on(event: AdapterEvent, cb: (...args: any[]) => void): this;
  /** Standard listener removal for host-owned lifecycle bindings; optional for minimal adapters. */
  off?(event: AdapterEvent, cb: (...args: unknown[]) => void): this;

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
  /** 连续路线终止时释放运动键并异步等待实际落稳；不前进、倒车或改写目标。 */
  settleMovement?(opts: Pick<MoveOpts, 'signal' | 'timeoutMs'>): Promise<void>;
  /**
   * 在 run 的异步生命周期内绑定非本地导航委托；嵌套技能会重新绑定自己的委托。
   * 绑定范围覆盖 runSkill 内部及适配器私有方法发起的全部 moveTo 调用。
   */
  withNavigation?<T>(delegate: NavigationDelegate, run: () => Promise<T>): Promise<T>;
  /** 释放一切：停止寻路、清除按键、停止挖掘/使用物品。 */
  stopAll(): void;

  canHarvest(pos: Vec3Like): boolean;
  /** 这一格需要哪些工具才能采集（空手采集不到掉落时非空）；只用于回执说明，不改变判定。 */
  harvestTools?(pos: Vec3Like): string[];
  /** 估算用某个工具（null = 空手）挖一个方块需要的毫秒数；未知返回 null */
  digTimeEstimate(block: string, tool: string | null): number | null;
  /** 用背包里 itemNames 中的第一种方块，放到 pos（需要相邻有实心方块可依附） */
  placeBlockAt(pos: Vec3Like, itemNames: string[], signal: AbortSignal): Promise<ActionResult & PlacementEvidence & { attemptedFaces?: PlacementFaceAttempt[] }>;
  /**
   * 以当前身体的真实眼睛与已加载世界几何核对：能否看见 pos 的一个面（place:true 时是
   * 能否从某个参照面放进这一格）。只用于实际动作后的完成验收，不作为规划证据。
   */
  canInteractAt?(pos: Vec3Like, opts?: { facing?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down'; place?: boolean }): boolean;
  /**
   * 跨空腔搭桥：在脚下实心方块的边缘潜行，向水平相邻、且在脚下一格或两格的空目标格放一块方块。
   * 脚下两格需要在支撑块下方有实心参照方块；没有时如实返回 EDGE_NO_REFERENCE，不伪造成功。
   * 只用于 place_support 的支撑位；会移动身体到边缘，放完保持站稳。
   * `stance` 是实际尝试放置时的身体位置（潜行到边缘后）；失败前没挪动就不返回。
   * `options.advance` 只给连续搭桥用：脚下一格的目标放置成功后，保持潜行向前迈到新方块
   * 靠前一侧的边缘（仍站在新方块列内），让下一次调用可以不再回格心、连续放下一块。
   * 返回 `advanced` 表示身体是否真的走到了新边缘；没走到不影响已放置的方块。
   */
  sneakPlaceAt?(target: Vec3Like, itemNames: string[], signal: AbortSignal, options?: { advance?: boolean }): Promise<ActionResult & PlacementEvidence & { placed?: Vec3Like; stance?: Vec3Like; advanced?: boolean; attemptedFaces?: PlacementFaceAttempt[] }>;
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
  /** 把背包和快捷栏里同名可堆叠物品的散叠两两合并到堆叠上限，腾出空槽；item 可指定只整理一种。不制造、不丢弃。 */
  mergeStacks?(signal: AbortSignal, item?: string): Promise<ActionResult & { merged: number; freed: number }>;
  equipItem?(name: string | null, destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet', signal: AbortSignal, opts?: { sourceSlot?: number; explicit?: boolean }): Promise<ActionResult>;
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
  /**
   * 走进门并等待真实维度切换。到达后（仅下界门）会尝试把身体移出目的地门方块：
   * leftPortal 如实报告是否移出，undefined = 这种门没有检查；移出失败或过程中再次换维度会如实返回。
   */
  enterPortalAt?(pos: Vec3Like, signal: AbortSignal, expectedDim?: string): Promise<ActionResult & { from?: AgentState; to?: AgentState; stand?: AgentState; leftPortal?: boolean; transition?: PortalTransitionFacts }>;
  /** 门外安全站位（格中心）；不知道门结构时返回 null。普通走路用它避免把“门厅”当成门方块本身。 */
  portalStance?(pos: Vec3Like): Vec3Like | null;
  bossStatus?(): { dragonDeath: BossDeathObservation | null };
  /**
   * 挖一格。opts.tool 给具体物品名时只准用这一把：背包没有 → TOOL_MISSING，不换别的工具、不退回空手；
   * 它采不到这块的掉落但仍能挖开时，照常挖开并返回 noDrop（清路不需要掉落）；预计耗时超过动作预算才 HAND_DIG_TIMEOUT。
   * opts.handOnly 为 true 时只用当前手持（空手就空手挖），不从背包换工具；
   * 两者都不传沿用自动换手：手上能挖就用，不能才按上次亲手选的同种工具→最快工具。
   */
  dig(pos: Vec3Like, signal: AbortSignal, opts?: { tool?: string | null; handOnly?: boolean }): Promise<ActionResult>;
  /** 这个掉落物是不是自己几分钟前扔掉的（只是事实，捡不捡由心智和技能自己定） */
  isDiscarded?(item: string, pos: Vec3Like): boolean;
  /** 改主意了（指名要捡回某样扔掉的东西）：不再当它是扔掉的，捡回来也不算“又捡回来了” */
  forgetDiscarded?(item: string): void;
  /** 自己挖掉的方块（动作、代码技能、寻路挖穿的都算），since 之后的；用来记自己挖过的通道和挖掘耗时 */
  recentDug?(since: number): { pos: Vec3Like; name: string; ts: number; tool?: string | null; ms?: number }[];
  /**
   * 放置动作记录，since 之后的。status=confirmed 才确认目标格出现了请求材料；
   * attempted 只是动作回执成功，不能当成已验证的世界修改。
   */
  recentPlaced?(since: number): { pos: Vec3Like; name: string; ts: number; status: 'attempted' | 'confirmed' }[];
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
  /**
   * Swim toward an observed shore, retaining buoyancy until dry footing is verified.
   * A target whose cell is observed water is an in-water goal: reaching it reports
   * `landed:false` / `stage:'surface_reached'` instead of forcing a landing.
   */
  swimTo?(target: Vec3Like | null, signal: AbortSignal, opts?: SwimOptions): Promise<ActionResult & SwimFacts & { landed: boolean; surfaced: boolean; oxygen: number }>;
  /** 在水里朝一格游过去（往下潜或往上游）：到了、气不够了（oxygen ≤ minOxygen）、出了水或超时就停 */
  diveTo?(target: Vec3Like, signal: AbortSignal, opts?: { minOxygen?: number; timeoutMs?: number }): Promise<ActionResult & { reached: boolean; oxygen: number }>;

  // ---- 通用基础动作：玩家的“右键”和“方向键”。上层用它们组合出技能清单里没有的玩法
  /** 手持 item 右键：对着一个方块/水面（block），或对空中/自己（self） */
  useItemOn?(item: string, target: { kind: 'block'; pos: Vec3Like } | { kind: 'self' }, signal: AbortSignal): Promise<ActionResult & { spawned?: string; placed?: Vec3Like }>;
  /** 满桶（water_bucket/lava_bucket）往指定空气格倒流体：按 use_item 物品使用语义，贴实心面发射线、核对桶消耗与目标格流体 */
  useBucketAt?(pos: Vec3Like, item: string, signal: AbortSignal): Promise<ActionResult & { placed?: Vec3Like }>;
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
  | 'recollected'
  /** The adapter's real sessionId changed (connect/spawn/death/respawn/end/dimension). No payload. */
  | 'session_reset';

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
  name: string;
  kind: EntityKind;
  pos: Vec3Like;
  dist: number;
}

export interface BlockHit {
  name: string;
  pos: Vec3Like;
  dist: number;
}

export interface InvItem {
  name: string;
  count: number;
}

export interface AgentState {
  connected: boolean;
  alive: boolean;
  username: string;
  pos: Vec3Like;
  dim: string;
  hp: number;
  food: number;
  oxygen: number;
  timeOfDay: number;
  isDay: boolean;
  biome: string | null;
  onGround: boolean;
  inWater: boolean;
  inLava: boolean;
  inventory: InvItem[];
  emptySlots: number;
  held: string | null;
}

export type MoveTarget =
  | { kind: 'near'; pos: Vec3Like; range: number }
  | { kind: 'xz'; x: number; z: number; range: number }
  | { kind: 'reach_block'; pos: Vec3Like }
  | { kind: 'follow_entity'; entityId: number; range: number }
  | { kind: 'away_from'; pos: Vec3Like; distance: number };

export interface MoveOpts {
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

export interface GameAdapter {
  on(event: AdapterEvent, cb: (...args: any[]) => void): this;

  state(): AgentState;
  nearbyEntities(radius: number): EntityInfo[];
  findBlocks(names: string[], maxDist: number, count: number): BlockHit[];
  blockAt(pos: Vec3Like): string | null;
  /** 'log' → 所有原木；'iron_ore' → iron_ore + deepslate_iron_ore；精确名 → 自身 */
  resolveBlockNames(query: string): string[];
  isKnownItem(name: string): boolean;

  moveTo(target: MoveTarget, opts: MoveOpts): Promise<void>;
  /** 释放一切：停止寻路、清除按键、停止挖掘/使用物品。 */
  stopAll(): void;

  canHarvest(pos: Vec3Like): boolean;
  dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult>;
  collectNearbyDrops(signal: AbortSignal, radius: number, timeoutMs: number): Promise<number>;
  craft(item: string, count: number, signal: AbortSignal): Promise<ActionResult & { crafted: number }>;
  hasFood(): boolean;
  eat(signal: AbortSignal): Promise<boolean>;
  equipWeapon(): Promise<void>;
  attack(entityId: number): Promise<boolean>;
  look(yaw: number, pitch: number): Promise<void>;
  jump(ms: number, signal: AbortSignal): Promise<void>;
  chat(text: string): void;
}

/**
 * 适配器事件：
 * spawn / death / respawn / hurt / disconnected / kicked / chat(username, message)
 */
export type AdapterEvent = 'spawn' | 'death' | 'respawn' | 'hurt' | 'disconnected' | 'kicked' | 'chat';

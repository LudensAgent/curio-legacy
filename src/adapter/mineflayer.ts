import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { crystalArrowShot } from '../combat/ballistics.ts';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';
import { AbortedError, raceAbort, shortId, sleep, throwIfAborted, TimeoutError } from '../util.ts';
import type {
  InvItem,
  ActionResult,
  AgentState,
  BlockHit,
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
} from './types.ts';

const require = createRequire(import.meta.url);

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
  private actionContext = new AsyncLocalStorage<() => void>();
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
      const write = client.write;
      const context = this.actionContext;
      client.write = function (...args: any[]) {
        const guard = context.getStore();
        try { guard?.(); } catch { return; }
        return write.apply(this, args);
      };
      this.guardedClients.add(client);
    }
    const promise = this.actionContext.run(check, operation);
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
    bot.loadPlugin(pathfinder);

    bot.on('spawn', () => {
      this.newSession();
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
        bot.pathfinder.setMovements(mv);
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
    bot.on('death', () => { this.newSession(); this.emit('death'); });
    bot.on('respawn', () => { this.newSession(); this.emit('respawn'); });
    bot.on('entityHurt', (e: any) => {
      if (e === bot.entity) this.emit('hurt');
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
    const Vec3 = require('vec3').Vec3;
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
    const inv = new Map<string, number>();
    for (const it of b.inventory.items()) inv.set(it.name, (inv.get(it.name) ?? 0) + it.count);
    let biome: string | null = null;
    let chunkReady = false;
    try { const block = b.blockAt(e.position); chunkReady = !!block; biome = block?.biome?.name ?? null; } catch { /* ignore */ }
    const observationReady = this.spawned && chunkReady && (b.health ?? 0) > 0 && dim !== 'unknown';
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
      oxygen: b.oxygenLevel ?? 20,
      timeOfDay: b.time?.timeOfDay ?? 0,
      isDay: b.time?.isDay ?? true,
      biome,
      onGround: !!e.onGround,
      inWater: !!e.isInWater,
      inLava: !!e.isInLava,
      inventory: [...inv.entries()].map(([name, count]) => ({ name, count })),
      emptySlots: b.inventory.emptySlotCount(),
      held: b.heldItem?.name ?? null,
      riding: b.vehicle ? String(b.vehicle.name ?? 'vehicle') : null,
      equipment: ['head', 'torso', 'legs', 'feet', 'off-hand'].flatMap((slot) => {
        const item = b.inventory.slots?.[b.getEquipmentDestSlot?.(slot)];
        if (!item) return [];
        const max = this.mcData.itemsByName?.[item.name]?.maxDurability;
        return [{ slot, name: item.name, durabilityRemaining: max ? max - (item.durabilityUsed ?? 0) : undefined }];
      }),
    };
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
      out.push({ id: ent.id, name, kind: this.classify(ent), pos: { x: ent.position.x, y: ent.position.y, z: ent.position.z }, dist: d, height: ent.height,
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
  async moveTo(target: MoveTarget, opts: MoveOpts): Promise<void> {
    const check = this.actionCheckpoint(opts.signal);
    throwIfAborted(opts.signal);
    if (!this.ready) throw new Error('NOT_CONNECTED');
    const b = this.bot;
    if (b.vehicle) throw new Error(`RIDING：正在乘坐 ${b.vehicle.name}，走路前先 dismount，或用 ride 操控它前进`);
    if (opts.maxDropDown !== undefined && (!this.normalMovements || typeof b.pathfinder.setMovements !== 'function')) throw new Error('No path: 当前寻路器不能配置明确下行范围');
    if (this.normalMovements && typeof b.pathfinder.setMovements === 'function') {
      const movements = Object.assign(Object.create(Object.getPrototypeOf(this.normalMovements)), this.normalMovements);
      if (opts.constructionSafe) {
        movements.canDig = false; movements.allow1by1towers = false; movements.scafoldingBlocks = [];
      } else if (!opts.allowTerrainChanges) {
        // 普通走路不挖墙、不搭柱、不架桥；但像真人一样可以随手拨开树叶（站在树冠上、钻过灌木丛时）。
        movements.canDig = true; movements.allow1by1towers = false; movements.scafoldingBlocks = [];
        movements.blocksCantBreak = this.allButLeaves(movements.blocksCantBreak);
      }
      movements.allowParkour = false;
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
      // Keep the upper half out of the break list; crossing the closed lower
      // half must issue its ordinary useOne interaction before walking through.
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
      b.pathfinder.setMovements(movements);
    }
    const { goals } = require('mineflayer-pathfinder');
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
      case 'reach_block':
        goal = goals.GoalLookAtBlock
          ? new goals.GoalLookAtBlock(this.vec(target.pos), b.world, { reach: 4 })
          : new goals.GoalNear(target.pos.x, target.pos.y, target.pos.z, 2);
        // GoalLookAtBlock 的距离判定偏向脚部节点；地下目标还须核对眼睛到方块中心的真实挖掘距离。
        {
          const nominalEnd = goal.isEnd.bind(goal);
          goal.isEnd = (node: any) => nominalEnd(node) && Math.hypot(
            node.x + 0.5 - target.pos.x - 0.5,
            node.y + (b.entity.eyeHeight ?? 1.62) - target.pos.y - 0.5,
            node.z + 0.5 - target.pos.z - 0.5,
          ) <= 4;
        }
        break;
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
      const edge = this.edgeSupport();
      if (edge) { await this.steady(edge, opts, check); check(); }
      let stalled = false;
      let last = b.entity?.position?.clone?.() ?? null, since = Date.now();
      const watch = setInterval(() => {
        try { check(); } catch { clearInterval(watch); return; }
        const p = b.entity?.position;
        if (!p?.clone || !last) { last = p?.clone?.() ?? null; return; }
        // A long trip may need several successful corrections. Only count
        // failures around the same obstruction, not across the whole route.
        if (recoveryOrigin && p.distanceTo(recoveryOrigin) >= 1.5) {
          corrections = 0; attempted.clear(); recoveryOrigin = p.clone();
        }
        if (p.distanceTo(last) >= 0.3 || b.targetDigBlock || !b.pathfinder?.isMoving?.()) { last = p.clone(); since = Date.now(); return; }
        if (Date.now() - since >= 2500 && !stalled) { stalled = true; try { b.pathfinder.stop(); b.pathfinder.setGoal(null); } catch { /* ignore */ } }
      }, 300);
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('TIMEOUT');
        await this.afterAction(() => raceAbort(b.pathfinder.goto(goal), opts.signal, remaining, () => { if (ownsControls()) this.stopAll(); }), check);
        if (!stalled) return;
      } catch (e: any) {
        if (!stalled || e?.name === 'AbortedError') throw e;
      } finally {
        clearInterval(watch);
      }
      check();
      if (opts.maxDropDown !== undefined) throw new Error('No path: 明确下行未能完成，未改走其他边缘');
      if (corrections >= 3) throw new Error('No path: 附近连续调整后仍无法前进，换条路线');
      const action = await this.nudge(attempted, opts);
      check();
      if (!action) throw new Error('No path: 附近没有可确认安全的调整空间，换条路线');
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

  private async equipBestTool(block: any, signal?: AbortSignal) {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    const e = b.entity;
    let best: any = null;
    let bestTime = Infinity;
    const timeFor = (type: number | null, ench: any[] = []) => {
      try { return block.digTime(type, false, !!e.isInWater, !e.onGround, ench, e.effects ?? {}); } catch { return Infinity; }
    };
    if (!block.harvestTools) bestTime = timeFor(null);
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
    // 没有对应工具时只是不掉东西：积雪、草这类一碰就碎的照样能清掉（拆雪层不用铲子）；石头矿石才真要镐
    const flimsy = typeof block.hardness === 'number' && block.hardness <= 0.5;
    if (!this.canHarvest(pos) && !flimsy) return { ok: false, reason: 'TOOL_MISSING' };
    await this.afterAction(() => this.equipBestTool(block, signal), check);
    throwIfAborted(signal);
    if (!b.canDigBlock(block)) return { ok: false, reason: 'OUT_OF_REACH' };
    await this.afterAction(() => raceAbort(b.dig(block, true), signal, 20000, () => {
      try { b.stopDigging(); } catch { /* ignore */ }
    }), check);
    return { ok: true };
  }

  async collectNearbyDrops(signal: AbortSignal, radius: number, timeoutMs: number): Promise<number> {
    let check = this.actionCheckpoint(signal);
    const bot = this.bot, session = this.sessionId, dimension = this.currentDimension();
    const start = Date.now();
    const deadline = start + Math.max(0, timeoutMs);
    const initialScanUntil = Math.min(deadline, start + 300);
    let picked = 0;
    const tried = new Set<number>();
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const item = this.nearbyEntities(radius).find((e) => e.kind === 'item' && !tried.has(e.id));
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
        picked++;
      } catch (e: any) {
        if (e?.name === 'AbortedError') throw e;
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
    const b = this.bot;
    const item = b.inventory.items().find((i: any) => itemNames.includes(i.name));
    if (!item) return { ok: false, reason: 'NO_ITEM' };
    const target = this.vec(pos);
    const cur = b.blockAt(target);
    if (cur && cur.boundingBox === 'block') return { ok: true }; // 已经有方块了
    const Vec3 = require('vec3').Vec3;
    const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
    for (const f of faces) {
      const ref = b.blockAt(target.plus(f));
      if (!ref || ref.boundingBox !== 'block') continue;
      if (!this.canClickPlacementFace(ref, f.scaled(-1))) continue;
      try {
        await this.afterAction(() => b.equip(item, 'hand'), check);
        await this.afterAction(() => raceAbort(b.placeBlock(ref, f.scaled(-1)), signal, 5000, () => {}), check);
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

  async equipItem(name: string, destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet', signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const item = this.invItem(name);
    if (!item) return { ok: false, reason: 'NO_ITEM' };
    await this.afterAction(() => this.bot.equip(item, destination), check);
    const slot = this.bot.getEquipmentDestSlot?.(destination);
    const actual = destination === 'hand' ? this.bot.heldItem : this.bot.inventory.slots?.[slot];
    return actual?.name === name ? { ok: true } : { ok: false, reason: 'EQUIP_NOT_CONFIRMED' };
  }

  async useBlockAt(pos: Vec3Like, item: string, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const block = b.blockAt(this.vec(pos));
    if (!block) return { ok: false, reason: 'UNLOADED' };
    const held = item ? this.invItem(item) : null;
    if (item && !held) return { ok: false, reason: 'NO_ITEM' };
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 15000, constructionSafe: item === '', ...(item === '' ? { allowSwimming: false } : {}) }), check);
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
    const blocks = () => JSON.stringify(cells.map((pos) => { const at = b.blockAt(pos); return at ? [at.name, at.stateId, at.getProperties?.()] : null; }));
    const inventory = () => {
      const counts = new Map<string, number>();
      for (const item of b.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
      return JSON.stringify([...counts].sort(([a], [c]) => a.localeCompare(c)));
    };
    const beforeBlocks = blocks(), beforeInventory = inventory(), beforeDamage = b.heldItem?.durabilityUsed;
    const reasons = () => [
      ...(blocks() !== beforeBlocks ? ['目标或相邻格的实际方块状态改变'] : []),
      ...(inventory() !== beforeInventory ? ['背包物品数量改变'] : []),
      ...(b.heldItem?.durabilityUsed !== beforeDamage ? ['手持工具耐久改变'] : []),
      ...(b.currentWindow && b.currentWindow !== window ? ['服务器打开了交互窗口'] : []),
    ];
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
    return this.bot.inventory.items().find((i: any) => i.name === name);
  }

  async smelt(input: string, count: number, fuel: string, signal: AbortSignal, opts: { furnacePos?: Vec3Like; onProgress?: (done: number) => void } = {}): Promise<ActionResult & { made: number; output?: string; furnacePos?: Vec3Like }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', made: 0 };
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
      if (!this.invItem('furnace')) await this.afterAction(() => this.craft('furnace', 1, signal), check);
      if (!this.invItem('furnace')) return { ok: false, reason: 'NO_FURNACE', made: 0 };
      const ref = this.findPlaceSpot();
      if (!ref) return { ok: false, reason: 'NO_SPACE', made: 0 };
      const Vec3 = require('vec3').Vec3;
      await this.afterAction(() => b.equip(this.invItem('furnace'), 'hand'), check);
      await this.afterAction(() => raceAbort(b.placeBlock(ref, new Vec3(0, 1, 0)), signal, 5000, () => {}), check);
      block = b.blockAt(ref.position.offset(0, 1, 0));
      this.bus.publish('place', 'P3', '放置了熔炉');
    }
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: block.position }, { signal, timeoutMs: 30000 }), check);
    const furnacePos = { x: block.position.x, y: block.position.y, z: block.position.z };
    const furnace: any = await this.afterAction(() => raceAbort(b.openFurnace(block), signal, 8000, () => {}), check);
    let made = 0;
    let outputName: string | undefined;
    try {
      const n = Math.min(count, inItem.count, 64);
      // 燃料：煤/木炭一个烧 8 个，木板/原木 1.5 个，木棍 0.5 个
      const per = /coal$|charcoal/.test(fuel) ? 8 : /_planks$|_log$/.test(fuel) ? 1.5 : fuel === 'stick' ? 0.5 : 1;
      const fuelN = Math.min(fuelItem.count, Math.ceil(n / per));
      if (!furnace.fuelItem()) await this.afterAction(() => furnace.putFuel(fuelItem.type, null, fuelN), check);
      await this.afterAction(() => furnace.putInput(inItem.type, null, n), check);
      const deadline = Date.now() + n * 11000 + 15000;
      while (made < n && Date.now() < deadline) {
        await this.afterAction(() => sleep(1000, signal), check);
        const out = furnace.outputItem();
        if (out && out.count > 0) {
          outputName = out.name;
          const taken = out.count;
          await this.afterAction(() => furnace.takeOutput(), check);
          made += taken;
          opts.onProgress?.(made);
        }
        if (!furnace.inputItem() && !furnace.outputItem()) break;
      }
      // 剩下的原料取回来
      if (furnace.inputItem()) await this.afterAction(() => furnace.takeInput().catch(() => {}), check);
    } finally {
      try { furnace.close(); } catch { /* ignore */ }
    }
    return made > 0 ? { ok: true, made, output: outputName, furnacePos } : { ok: false, reason: 'NOTHING_SMELTED', made: 0, furnacePos };
  }

  async useChest(pos: Vec3Like, deposits: InvItem[], withdraws: InvItem[], signal: AbortSignal): Promise<ActionResult & { contents: InvItem[]; moved: number }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', contents: [], moved: 0 };
    const b = this.bot;
    const block = b.blockAt(this.vec(pos));
    if (!block || !['chest', 'trapped_chest', 'barrel'].includes(block.name)) return { ok: false, reason: 'NO_CHEST', contents: [], moved: 0 };
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 30000 }), check);
    const chest: any = await this.afterAction(() => raceAbort(b.openContainer(block), signal, 8000, () => {}), check);
    let moved = 0;
    try {
      for (const d of deposits) {
        check();
        const it = this.invItem(d.name);
        if (!it) continue;
        const n = Math.min(d.count, b.inventory.items().filter((i: any) => i.name === d.name).reduce((a: number, i: any) => a + i.count, 0));
        try { await this.afterAction(() => chest.deposit(it.type, null, n), check); moved += n; } catch { /* 箱子满了 */ }
        check();
      }
      for (const w of withdraws) {
        check();
        const id = this.mcData.itemsByName[w.name]?.id;
        if (id === undefined) continue;
        const have = chest.containerItems().filter((i: any) => i.type === id).reduce((a: number, i: any) => a + i.count, 0);
        const n = Math.min(w.count, have);
        if (n > 0) { try { await this.afterAction(() => chest.withdraw(id, null, n), check); moved += n; } catch { /* 背包满了 */ } }
        check();
      }
      const m = new Map<string, number>();
      for (const i of chest.containerItems()) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
      return { ok: true, contents: [...m].map(([name, count]) => ({ name, count })), moved };
    } finally {
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

  async sleepInBed(signal: AbortSignal): Promise<ActionResult & { bedPos?: Vec3Like }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    if (this.currentDimension() !== 'overworld') return { ok: false, reason: 'WRONG_DIMENSION' };
    const b = this.bot;
    const bedIds = Object.values<any>(this.mcData.blocksByName).filter((x) => x.name.endsWith('_bed')).map((x) => x.id);
    let bed = b.findBlock({ matching: bedIds, maxDistance: 4 });
    if (!bed) {
      const bedItem = b.inventory.items().find((i: any) => i.name.endsWith('_bed'));
      if (!bedItem) return { ok: false, reason: 'NO_BED' };
      const ref = this.findPlaceSpot();
      if (!ref) return { ok: false, reason: 'NO_SPACE' };
      const Vec3 = require('vec3').Vec3;
      try {
        await this.afterAction(() => b.equip(bedItem, 'hand'), check);
        await this.afterAction(() => raceAbort(b.placeBlock(ref, new Vec3(0, 1, 0)), signal, 5000, () => {}), check);
      } catch (e: any) {
        if (e?.name === 'AbortedError') throw e;
      }
      bed = b.findBlock({ matching: bedIds, maxDistance: 4 });
      if (!bed) return { ok: false, reason: 'PLACE_FAILED' };
      this.bus.publish('place', 'P2', '放下了床');
    }
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: bed.position }, { signal, timeoutMs: 15000 }), check);
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

  private findPlaceSpots(requireHeadroom = true): any[] {
    const b = this.bot;
    const base = b.entity.position.floored();
    const candidates: any[] = [];
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -3; dy <= 2; dy++) {
      if (dx === 0 && dz === 0) continue;
      const ref = b.blockAt(base.offset(dx, dy, dz));
      if (!ref || ref.boundingBox !== 'block' || PROTECTED_BLOCKS.includes(ref.name) || /_bed$|_door$|barrel|shulker_box/.test(ref.name)) continue;
      const above = b.blockAt(base.offset(dx, dy + 1, dz));
      const above2 = b.blockAt(base.offset(dx, dy + 2, dz));
      if (['air', 'cave_air', 'void_air'].includes(above?.name) && (!requireHeadroom || ['air', 'cave_air', 'void_air'].includes(above2?.name))) candidates.push(ref);
    }
    return candidates.sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position)).slice(0, 12);
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
  private async craftOnce(recipe: any, table: any, signal: AbortSignal, times = 1) {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    const pace = Number(process.env.UI_PACING_MS ?? 250) || 0;
    const timeout = 10000 + (pace > 0 ? 3000 + pace * 12 * times : 0);
    const attempt = new AbortController();
    const attemptSignal = AbortSignal.any([signal, attempt.signal]);
    const attemptCheck = this.actionCheckpoint(attemptSignal);
    try {
      await this.afterAction(() => raceAbort(b.craft(recipe, times, table), attemptSignal, timeout, () => attempt.abort('craft transaction timed out')), attemptCheck);
    } catch (error) {
      attempt.abort('craft transaction ended without confirmation');
      this.actionContext.exit(() => { try { if (b.currentWindow) b.closeWindow(b.currentWindow); } catch { /* ignore */ } });
      throw error;
    }
    // 2x2 inventory crafting resolves from Mineflayer's predicted slot model.
    // Wait for the server's authoritative inventory before using that output in
    // another recipe (notably logs -> planks -> crafting table).
    if (typeof b._syncWindow === 'function') {
      await this.afterAction(() => raceAbort(b._syncWindow(b.inventory), signal, 8000, () => {}), check);
    } else await this.afterAction(() => sleep(150, signal), check);
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
      if (bulk) {
        await this.afterAction(() => this.craftOnce(bulk, table, signal, times), check);
      } else {
        await this.afterAction(() => this.craftOnce(any, table, signal, 1), check);
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
  private async ensureTable(signal: AbortSignal, knownPos?: Vec3Like): Promise<any | null> {
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
    if (!table) {
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

  async craft(item: string, count: number, signal: AbortSignal, opts: { tablePos?: Vec3Like } = {}): Promise<ActionResult & { crafted: number; detail?: string; tablePos?: Vec3Like }> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', crafted: 0 };
    const b = this.bot;
    const data = this.mcData.itemsByName[item];
    if (!data) return { ok: false, reason: 'UNKNOWN_ITEM', crafted: 0 };
    if (b.recipesAll(data.id, null, true).length === 0) return { ok: false, reason: 'UNKNOWN_ITEM', crafted: 0 };

    let table: any = null;
    if (this.needsTable(data.id, count)) {
      table = await this.afterAction(() => this.ensureTable(signal, opts.tablePos), check);
      if (!table) return { ok: false, reason: 'NO_CRAFTING_TABLE', crafted: 0, detail: this.missingReport(data.id, count, null) };
    }
    const tablePos = table?.position ? { x: table.position.x, y: table.position.y, z: table.position.z } : undefined;
    const before = this.invCount(data.id);
    await this.afterAction(() => this.ensureIngredients(data.id, count, table, signal, 2), check);
    let crafted = await this.afterAction(() => this.craftUpTo(data.id, count, table, signal), check);
    crafted = Math.max(crafted, this.invCount(data.id) - before);
    // 同种木板凑不齐但混着几种木板够用：按实际的木板拼配方（原版允许）
    for (let tries = 0; crafted < count && tries < 8; tries++) {
      const mixed = this.mixedPlanksRecipe(data.id, 1, table);
      if (!mixed) break;
      const was = this.invCount(data.id);
      await this.afterAction(() => this.craftOnce(mixed, table, signal, 1), check);
      const made = this.invCount(data.id) - was;
      if (made <= 0) break;
      crafted += made;
    }
    return crafted > 0 ? { ok: true, crafted, ...(tablePos ? { tablePos } : {}) }
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

  async eat(signal: AbortSignal): Promise<boolean> {
    const check = this.actionCheckpoint(signal);
    const item = this.foodItems()[0];
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

  async swimTo(target: Vec3Like | null, signal: AbortSignal, opts: SwimOptions = {}): Promise<ActionResult & { landed: boolean; oxygen: number }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', landed: false, oxygen: 0 };
    const b = this.bot, epoch = this.actionEpoch;
    const end = Date.now() + Math.max(100, Math.min(20000, opts.timeoutMs ?? 10000));
    let drySince: number | null = null;
    let lastProgress = Date.now(), anchor = b.entity.position.clone();
    let destination = target, nextObservation = 0, nextTurn = Date.now() + 750;
    const water = (block: any) => !!block && (['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(block.name) || String(block.getProperties?.().waterlogged) === 'true');
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
        if (dry && (b.oxygenLevel ?? 20) >= 18) {
          drySince ??= Date.now();
          if (Date.now() - drySince >= 600) return { ok: true, landed: true, oxygen: b.oxygenLevel ?? 20 };
        } else drySince = null;
        // A brief breach of the water surface is not a landing. Keep ascending
        // until there is actual support, then release jump and let the body settle.
        b.setControlState('jump', !dry);
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
        if (!dry && destination && Date.now() - lastProgress >= 2500) return { ok: false, reason: 'SWIM_NO_PROGRESS', landed: false, oxygen: b.oxygenLevel ?? 20 };
        if (typeof b.waitForTicks === 'function') await this.afterAction(() => raceAbort(b.waitForTicks(2), signal, 2000, () => {}), check);
        else await this.afterAction(() => sleep(100, signal), check);
      }
      return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, oxygen: b.oxygenLevel ?? 20 };
    } finally {
      // A replaced task owns the controls now; stopAll already released ours.
      if (epoch === this.actionEpoch && b === this.bot) {
        b.setControlState('jump', false); b.setControlState('forward', false); b.setControlState('sprint', false);
      }
    }
  }

  // ---------------------------------------------------------------- 通用基础动作
  private async equipNamed(name: string, check: (() => void) & { signal?: AbortSignal }) {
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
      const Vec3 = require('vec3').Vec3;
      if (this.mcData.blocksByName?.[item]) return await this.placeItemAgainst(item, block, check);
      // 放置实体类物品（船、矿车、盔甲架、刷怪蛋）：对着方块顶面放
      if (/_boat$|_raft$|_spawn_egg$|^armor_stand$|^end_crystal$/.test(item)) {
        // placeEntity 对船用 forceLook:'ignore' 再发 use_item：服务器按“当前视线”射线找水面，所以必须先看向目标水面，
        // 否则船会放到别处或根本放不下
        if (/_boat$|_raft$/.test(item)) await this.afterAction(() => b.lookAt(block.position.offset(0.5, ['water', 'bubble_column'].includes(block.name) ? 0.9 : 1, 0.5), true), check);
        const entity = await this.afterAction(() => raceAbort(b.placeEntity(block, new Vec3(0, 1, 0)), signal, 6000, () => {}), check);
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
      await this.afterAction(() => b.lookAt(block.position.offset(0.5, fluid ? 0.9 : 0.5, 0.5), true), check);
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
      await this.afterAction(() => b.activateEntity(ent), check);
      return { ok: true };
    } catch (e: any) {
      if (e instanceof AbortedError) throw e;
      return { ok: false, reason: String(e?.message ?? e) };
    }
  }

  async dismount(signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    if (!this.ready || !b.vehicle) return { ok: false, reason: 'NOT_MOUNTED' };
    const off = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => { b.off('dismount', on); resolve(false); }, 2500);
      const on = () => { clearTimeout(t); resolve(true); };
      b.once('dismount', on);
    });
    b.dismount();
    const ok = await this.afterAction(() => off, check);
    if (ok) b.physicsEnabled = true;
    return ok ? { ok: true } : { ok: false, reason: 'DISMOUNT_FAILED' };
  }

  /**
   * 操控载具。马、猪等坐骑由服务器计算运动，只需发送方向输入；
   * 船的运动由客户端计算（原版就是这样），Mineflayer 不模拟，所以这里按简化的船只运动学自己推进并上报位置：
   * 在水面上加速到约 8 格/秒，前方是陆地/方块就停下（靠岸），离目标 2 格内算到达。
   */
  async ride(target: { x: number; z: number }, signal: AbortSignal, opts: { timeoutMs: number; stop?: () => boolean }): Promise<ActionResult & { arrived: boolean; blocked?: boolean; moved: number }> {
    const check = this.actionCheckpoint(signal);
    const b = this.bot;
    if (!this.ready || !b.vehicle) return { ok: false, reason: 'NOT_MOUNTED', arrived: false, moved: 0 };
    const epoch = this.actionEpoch, dimension = this.currentDimension();
    const ownsControls = () => epoch === this.actionEpoch && b === this.bot && dimension === this.currentDimension();
    const v = b.vehicle;
    const start = v.position.clone();
    const end = Date.now() + (Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : 0);
    const isBoat = /boat|raft/.test(String(v.name));
    const water = (blk: any) => !!blk && (blk.name === 'water' || blk.name === 'bubble_column' || String(blk.getProperties?.().waterlogged) === 'true');
    const passable = (blk: any) => !blk || blk.boundingBox === 'empty';
    let speed = 0;
    // 服务器不认可上报的位置（撞到东西 / moved wrongly）时会回发 vehicle_move 把船拉回去：
    // 以服务器为准重新同步，否则本地以为在前进、服务器那边船其实没动，越错越远
    const Vec3c = require('vec3').Vec3;
    const resync = (pk: any) => {
      if (!ownsControls() || !isBoat || b.vehicle !== v || !Number.isFinite(pk?.x)) return;
      v.position = new Vec3c(pk.x, pk.y, pk.z);
      b.entity.position = new Vec3c(pk.x, pk.y + 0.4, pk.z);
      speed = 0;
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
        if (b.vehicle !== v) return { ok: false, reason: 'DISMOUNTED', arrived: false, moved: v.position.distanceTo(start) };
        if (opts.stop?.()) return { ok: true, arrived: false, moved: v.position.distanceTo(start) };
        const p = v.position;
        const dx = target.x - p.x, dz = target.z - p.z, dist = Math.hypot(dx, dz);
        if (dist <= 2) return { ok: true, arrived: true, moved: p.distanceTo(start) };
        const yaw = Math.atan2(-dx, -dz);
        if (!isBoat) {
          await this.afterAction(() => b.look(yaw, 0, true), check);
          b.moveVehicle(0, 1);
          await this.afterAction(tick, check);
          continue;
        }
        speed = Math.min(0.4, speed + 0.04);
        const step = Math.min(speed, dist);
        const nx = p.x + (dx / dist) * step, nz = p.z + (dz / dist) * step;
        const Vec3 = require('vec3').Vec3;
        const feet = b.blockAt(new Vec3(nx + (dx / dist) * 0.7, p.y, nz + (dz / dist) * 0.7));
        const under = b.blockAt(new Vec3(nx, p.y - 0.2, nz));
        if (!passable(feet) && !water(feet)) return { ok: true, arrived: false, blocked: true, moved: p.distanceTo(start) }; // 前面是岸或障碍：靠岸
        if (!water(under) && !water(b.blockAt(new Vec3(nx, p.y - 1, nz)))) return { ok: true, arrived: false, blocked: true, moved: p.distanceTo(start) }; // 船不能上岸行驶
        const deg = ((Math.PI - yaw) * 180) / Math.PI;
        v.position = new Vec3(nx, p.y, nz);
        v.yaw = yaw;
        b.entity.position = new Vec3(nx, p.y + 0.4, nz);
        b.entity.yaw = yaw;
        await this.afterAction(async () => {
          b._client.write('steer_boat', { leftPaddle: true, rightPaddle: true });
          b._client.write('vehicle_move', { x: nx, y: p.y, z: nz, yaw: deg, pitch: 0 });
        }, check);
        await this.afterAction(tick, check);
      }
      return { ok: false, reason: 'TIMEOUT', arrived: false, moved: v.position.distanceTo(start) };
    } finally {
      if (isBoat) {
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
      const Vec3 = require('vec3').Vec3;
      // 瞄准水面上方一点，浮漂抛物线落进水里
      await this.afterAction(() => b.lookAt(new Vec3(opts.aim!.x + 0.5, opts.aim!.y + 1.4, opts.aim!.z + 0.5), true), check);
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

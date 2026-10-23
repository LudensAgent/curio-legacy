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
        mv.allowParkour = true;
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
        mv.liquidCost = 3; // 能走陆路就别游泳
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
    if (name === 'iron_bars' && Number.isInteger(stateId)) {
      const definitions = this.mcData.blockCollisionShapes;
      const palette = definitions?.blocks?.iron_bars;
      const offset = stateId! - this.mcData.blocksByName.iron_bars.minStateId;
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
      out.push({ id: ent.id, name, kind: this.classify(ent), pos: { x: ent.position.x, y: ent.position.y, z: ent.position.z }, dist: d, height: ent.height,
        velocity: ent.velocity ? { x: ent.velocity.x, y: ent.velocity.y, z: ent.velocity.z } : undefined,
        phase: Number.isInteger(phase) ? phase : undefined, hp: Number.isFinite(hp) ? hp : undefined, ...(count ? { count } : {}) });
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
    if (this.normalMovements && typeof b.pathfinder.setMovements === 'function') {
      const movements = Object.assign(Object.create(Object.getPrototypeOf(this.normalMovements)), this.normalMovements);
      if (opts.constructionSafe) { movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.scafoldingBlocks = []; }
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

  /**
   * 寻路时被身前的方块“顶住”（树叶、半格、拐角）原地踏步：像玩家一样跳一下、挖开挡脸的树叶/草、
   * 或者退半步换个角度，再接着走；而不是原地顶 20 秒直到被判卡死。
   */
  private async gotoUnstalled(goal: any, opts: MoveOpts, check: () => void) {
    const b = this.bot;
    const deadline = Date.now() + opts.timeoutMs;
    for (let nudge = 0; ; nudge++) {
      let stalled = false;
      let last = b.entity?.position?.clone?.() ?? null, since = Date.now();
      const watch = setInterval(() => {
        const p = b.entity?.position;
        if (!p?.clone || !last) { last = p?.clone?.() ?? null; return; }
        if (p.distanceTo(last) >= 0.3 || b.targetDigBlock || !b.pathfinder?.isMoving?.()) { last = p.clone(); since = Date.now(); return; }
        if (Date.now() - since >= 2500 && nudge < 3) { stalled = true; try { b.pathfinder.stop(); b.pathfinder.setGoal(null); } catch { /* ignore */ } }
      }, 300);
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('TIMEOUT');
        await this.afterAction(() => raceAbort(b.pathfinder.goto(goal), opts.signal, remaining, () => this.stopAll()), check);
        if (!stalled) return;
      } catch (e: any) {
        if (!stalled || e?.name === 'AbortedError') throw e;
      } finally {
        clearInterval(watch);
      }
      throwIfAborted(opts.signal);
      this.bus.publish('path_nudge', 'P3', `走路被挡住，第 ${nudge + 1} 次调整（跳/挖开挡路的叶子/退半步）`);
      await this.nudge(nudge, opts);
      check();
    }
  }

  private async nudge(n: number, opts: MoveOpts) {
    const b = this.bot;
    const yaw = b.entity.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const feet = b.entity.position.floored();
    const front = [feet.offset(Math.round(fx), 0, Math.round(fz)), feet.offset(Math.round(fx), 1, Math.round(fz)), feet.offset(0, 2, 0)];
    const soft = /(_leaves|grass|fern|vine|bush|_sapling|snow|flower|tulip|dandelion|poppy|azalea|cobweb)$/;
    const hold = async (keys: string[], ms: number) => {
      for (const k of keys) b.setControlState(k, true);
      try { await sleep(ms, opts.signal); } finally { for (const k of keys) b.setControlState(k, false); }
    };
    // 施工中（脚手架、屋顶）只原地跳一下，不往前冲也不后退，免得从高处掉下去
    if (opts.constructionSafe) return hold(['jump'], 350);
    if (n === 0) return hold(['jump', 'forward'], 450);
    if (n === 1) {
      // 挡在脸前/头顶的树叶、草、藤蔓：顺手挖开（不挖别的东西）
      for (const pos of front) {
        const blk = b.blockAt(pos);
        if (blk && soft.test(blk.name) && b.canDigBlock?.(blk)) { try { await raceAbort(b.dig(blk), opts.signal, 3000, () => b.stopDigging?.()); } catch (e: any) { if (e?.name === 'AbortedError') throw e; } }
      }
      return hold(['jump', 'forward'], 450);
    }
    return hold(['back', Math.random() < 0.5 ? 'left' : 'right'], 500);
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
  }

  async dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult> {
    const check = this.actionCheckpoint(signal);
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const block = b.blockAt(this.vec(pos));
    if (!block || ['air', 'cave_air', 'void_air', 'water', 'lava'].includes(block.name)) return { ok: false, reason: 'NO_BLOCK' };
    if (!this.canHarvest(pos)) return { ok: false, reason: 'TOOL_MISSING' };
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
    await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos }, { signal, timeoutMs: 15000, constructionSafe: item === '' }), check);
    if (held) await this.afterAction(() => b.equip(held, 'hand'), check);
    else if (b.heldItem) {
      if (typeof b.unequip !== 'function' || b.inventory.emptySlotCount?.() === 0) return { ok: false, reason: 'NO_EMPTY_HAND' };
      await this.afterAction(() => b.unequip('hand'), check);
    }
    await this.afterAction(() => b.activateBlock(block), check);
    return { ok: true };
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

  private findPlaceSpots(): any[] {
    const b = this.bot;
    const base = b.entity.position.floored();
    const candidates: any[] = [];
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -3; dy <= 2; dy++) {
      if (dx === 0 && dz === 0) continue;
      const ref = b.blockAt(base.offset(dx, dy, dz));
      if (!ref || ref.boundingBox !== 'block' || PROTECTED_BLOCKS.includes(ref.name) || /_bed$|_door$|barrel|shulker_box/.test(ref.name)) continue;
      const above = b.blockAt(base.offset(dx, dy + 1, dz));
      const above2 = b.blockAt(base.offset(dx, dy + 2, dz));
      if (above?.name === 'air' && above2?.name === 'air') candidates.push(ref);
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
    table ??= b.findBlock({ matching: tableId, maxDistance: 5 }); // 伸手可及范围内
    if (!table) {
      let tableItem = b.inventory.items().find((i: any) => i.name === 'crafting_table');
      if (!tableItem && (await this.afterAction(() => this.craftSimple(this.mcData.itemsByName.crafting_table.id, 1, null, signal, 2), check))) {
        tableItem = b.inventory.items().find((i: any) => i.name === 'crafting_table');
      }
      const candidates = tableItem ? this.findPlaceSpots().slice(0, 6) : [];
      for (const ref of candidates) {
        const position = ref.position.offset(0, 1, 0);
        try {
          await this.afterAction(() => this.moveTo({ kind: 'place_block', pos: position }, { signal, timeoutMs: 8000, constructionSafe: true }), check);
          const placed = await this.afterAction(() => this.placeBlockAt(position, ['crafting_table'], signal), check);
          const observed = b.blockAt(position);
          if (placed.ok && observed?.name === 'crafting_table') { table = observed; this.bus.publish('place', 'P3', '放置并核对了工作台'); break; }
        } catch (error: any) { if (error?.name === 'AbortedError') throw error; check(); }
      }
    }
    if (table) await this.afterAction(() => this.moveTo({ kind: 'reach_block', pos: table.position }, { signal, timeoutMs: 30000 }), check);
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
    return this.bot.inventory
      .items()
      .filter((i: any) => foods[i.name] && !BAD_FOOD.has(i.name))
      // 有熟食先吃熟食（饱和度高），生肉留着烤
      .sort((a: any, c: any) => Number(RAW_FOOD.test(a.name)) - Number(RAW_FOOD.test(c.name)) || (foods[c.name].foodPoints ?? 0) - (foods[a.name].foodPoints ?? 0));
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

  async useItemOn(item: string, target: { kind: 'block'; pos: Vec3Like } | { kind: 'self' }, signal: AbortSignal): Promise<ActionResult & { spawned?: string }> {
    const check = this.actionCheckpoint(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    if (!(await this.equipNamed(item, check))) return { ok: false, reason: `NO_ITEM:${item}` };
    try {
      if (target.kind === 'self') {
        await this.afterAction(async () => { b.activateItem(); await sleep(400, signal); b.deactivateItem(); }, check);
        return { ok: true };
      }
      const block = b.blockAt(this.vec(target.pos));
      if (!block) return { ok: false, reason: 'NO_BLOCK' };
      const Vec3 = require('vec3').Vec3;
      // 放置实体类物品（船、矿车、盔甲架、刷怪蛋）：对着方块顶面放
      if (/_boat$|_raft$|_spawn_egg$|^armor_stand$|^end_crystal$/.test(item)) {
        const entity = await this.afterAction(() => raceAbort(b.placeEntity(block, new Vec3(0, 1, 0)), signal, 6000, () => {}), check);
        return { ok: true, spawned: (entity as any)?.name ?? item };
      }
      if (/_minecart$|^minecart$/.test(item)) {
        await this.afterAction(() => b.activateBlock(block), check);
        return { ok: true, spawned: 'minecart' };
      }
      // 对着液体用（水桶装水/倒水等）：先看向液面再“使用物品”；其他情况按“对方块右键”
      const fluid = ['water', 'lava'].includes(block.name);
      await this.afterAction(() => b.lookAt(block.position.offset(0.5, fluid ? 0.9 : 0.5, 0.5), true), check);
      if (fluid) await this.afterAction(async () => { b.activateItem(); await sleep(250, signal); b.deactivateItem(); }, check);
      else await this.afterAction(() => b.activateBlock(block), check);
      return { ok: true };
    } catch (e: any) {
      if (e instanceof AbortedError) throw e;
      return { ok: false, reason: String(e?.message ?? e) };
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
    const v = b.vehicle;
    const start = v.position.clone();
    const end = Date.now() + Math.max(1000, opts.timeoutMs);
    const isBoat = /boat|raft/.test(String(v.name));
    const water = (blk: any) => !!blk && (blk.name === 'water' || blk.name === 'bubble_column' || String(blk.getProperties?.().waterlogged) === 'true');
    const passable = (blk: any) => !blk || blk.boundingBox === 'empty';
    let speed = 0;
    const tick = () => (typeof b.waitForTicks === 'function' ? raceAbort(b.waitForTicks(1), signal, 1000, () => {}) : sleep(50, signal));
    try {
      if (isBoat) b.physicsEnabled = false; // 坐船期间不模拟玩家自身的重力/碰撞（下船时恢复）
      while (Date.now() < end) {
        check();
        if (!b.vehicle) return { ok: false, reason: 'DISMOUNTED', arrived: false, moved: v.position.distanceTo(start) };
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
        try { b._client.write('steer_boat', { leftPaddle: false, rightPaddle: false }); } catch { /* ignore */ }
        if (!b.vehicle) b.physicsEnabled = true;
      }
      try { if (b.vehicle && !isBoat) b.moveVehicle(0, 0); } catch { /* ignore */ }
    }
  }

  chat(text: string) {
    if (!this.ready || !text) return;
    try { this.bot.chat(text.replace(/\s+/g, ' ').slice(0, 240)); } catch { /* ignore */ }
  }
}

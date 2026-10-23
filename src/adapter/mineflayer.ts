import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';
import { raceAbort, sleep, throwIfAborted } from '../util.ts';
import type {
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
} from './types.ts';

const require = createRequire(import.meta.url);

const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'creeper', 'spider',
  'cave_spider', 'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker',
  'vex', 'ravager', 'silverfish', 'endermite', 'blaze', 'ghast', 'wither_skeleton', 'guardian',
  'elder_guardian', 'hoglin', 'zoglin', 'piglin_brute', 'warden', 'shulker',
]);
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'wolf', 'bee', 'iron_golem', 'llama', 'panda', 'polar_bear', 'dolphin', 'goat']);
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit']);
const WEAPON_ORDER = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
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

  constructor(private cfg: Config, private bus: EventBus) {
    super();
  }

  // ---------------------------------------------------------------- 连接管理
  connect() {
    const mineflayer = require('mineflayer');
    const { pathfinder, Movements } = require('mineflayer-pathfinder');
    const { host, port, username, version } = this.cfg.mc;
    this.bus.publish('connect', 'P3', `连接 ${host}:${port} (${version}) 用户名 ${username}`);

    // 向服务器请求尽可能大的视距；服务器会按 view-distance 截断
    const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline', viewDistance: 32 });
    this.bot = bot;
    bot.loadPlugin(pathfinder);

    bot.on('spawn', () => {
      if (!this.mcData) this.mcData = require('minecraft-data')(bot.version);
      if (!bot.__agentMovementsSet) {
        const mv = new Movements(bot);
        mv.canDig = true;
        mv.allowSprinting = true;
        mv.allowParkour = true;
        mv.allow1by1towers = true;
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
    bot.on('death', () => this.emit('death'));
    bot.on('respawn', () => this.emit('respawn'));
    bot.on('entityHurt', (e: any) => {
      if (e === bot.entity) this.emit('hurt');
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

  private classifyOptics(b: any): Optics {
    const name: string = b?.name ?? 'air';
    let kind: Optics['kind'] = 'solid';
    if (name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'light' || name === 'structure_void' || name === 'barrier') kind = 'clear';
    else if (name === 'water' || name === 'bubble_column' || name === 'kelp' || name === 'kelp_plant' || name === 'seagrass' || name === 'tall_seagrass') kind = 'water';
    else if (name === 'lava') kind = 'solid';
    else if (name.endsWith('_leaves')) kind = 'foliage';
    else if (name.includes('glass')) kind = 'clear';
    else if (b?.boundingBox === 'empty') kind = 'clear'; // 草、花、火把、铁轨等
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
        o = this.classifyOptics(this.mcData.blocksByStateId?.[sid]);
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
    if (!this.ready) {
      return {
        connected: false, alive: false, username: this.cfg.mc.username, pos: { x: 0, y: 0, z: 0 }, dim: 'unknown',
        hp: 0, food: 0, oxygen: 20, timeOfDay: 0, isDay: true, biome: null, onGround: false, inWater: false,
        inLava: false, inventory: [], emptySlots: 0, held: null,
      };
    }
    const e = b.entity;
    const inv = new Map<string, number>();
    for (const it of b.inventory.items()) inv.set(it.name, (inv.get(it.name) ?? 0) + it.count);
    let biome: string | null = null;
    try { biome = b.blockAt(e.position)?.biome?.name ?? null; } catch { /* ignore */ }
    return {
      connected: true,
      alive: (b.health ?? 0) > 0,
      username: b.username,
      pos: { x: e.position.x, y: e.position.y, z: e.position.z },
      dim: String(b.game?.dimension ?? 'unknown').replace('minecraft:', ''),
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
    };
  }

  private classify(ent: any): EntityKind {
    const name = String(ent.name ?? '');
    if (ent.type === 'player') return 'player';
    if (name === 'item') return 'item';
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
      const name = ent.type === 'player' ? `player:${ent.username ?? '?'}` : String(ent.name ?? 'unknown');
      if (name === 'experience_orb') continue;
      out.push({ id: ent.id, name, kind: this.classify(ent), pos: { x: ent.position.x, y: ent.position.y, z: ent.position.z }, dist: d, height: ent.height });
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
    throwIfAborted(opts.signal);
    if (!this.ready) throw new Error('NOT_CONNECTED');
    const b = this.bot;
    const { goals } = require('mineflayer-pathfinder');
    let goal: any;
    switch (target.kind) {
      case 'near':
        goal = new goals.GoalNear(target.pos.x, target.pos.y, target.pos.z, target.range);
        break;
      case 'xz':
        goal = new goals.GoalNearXZ(target.x, target.z, target.range);
        break;
      case 'reach_block':
        goal = goals.GoalLookAtBlock
          ? new goals.GoalLookAtBlock(this.vec(target.pos), b.world, { reach: 4 })
          : new goals.GoalNear(target.pos.x, target.pos.y, target.pos.z, 2);
        break;
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
    await raceAbort(b.pathfinder.goto(goal), opts.signal, opts.timeoutMs, () => this.stopAll());
  }

  stopAll() {
    const b = this.bot;
    if (!b) return;
    try { b.pathfinder?.stop(); } catch { /* ignore */ }
    try { b.pathfinder?.setGoal(null); } catch { /* ignore */ }
    try { b.clearControlStates(); } catch { /* ignore */ }
    try { if (b.targetDigBlock) b.stopDigging(); } catch { /* ignore */ }
    try { b.deactivateItem(); } catch { /* ignore */ }
  }

  canHarvest(pos: Vec3Like): boolean {
    if (!this.ready) return false;
    const block = this.bot.blockAt(this.vec(pos));
    if (!block) return false;
    if (!block.harvestTools) return true;
    const ids = Object.keys(block.harvestTools).map(Number);
    return this.bot.inventory.items().some((i: any) => ids.includes(i.type));
  }

  private async equipBestTool(block: any) {
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
    if (best && b.heldItem?.type !== best.type) await b.equip(best, 'hand');
  }

  async dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult> {
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
    const b = this.bot;
    const block = b.blockAt(this.vec(pos));
    if (!block || ['air', 'cave_air', 'void_air', 'water', 'lava'].includes(block.name)) return { ok: false, reason: 'NO_BLOCK' };
    if (!this.canHarvest(pos)) return { ok: false, reason: 'TOOL_MISSING' };
    await this.equipBestTool(block);
    throwIfAborted(signal);
    if (!b.canDigBlock(block)) return { ok: false, reason: 'OUT_OF_REACH' };
    await raceAbort(b.dig(block, true), signal, 20000, () => {
      try { b.stopDigging(); } catch { /* ignore */ }
    });
    return { ok: true };
  }

  async collectNearbyDrops(signal: AbortSignal, radius: number, timeoutMs: number): Promise<number> {
    const start = Date.now();
    let picked = 0;
    const tried = new Set<number>();
    while (Date.now() - start < timeoutMs) {
      throwIfAborted(signal);
      const item = this.nearbyEntities(radius).find((e) => e.kind === 'item' && !tried.has(e.id));
      if (!item) break;
      tried.add(item.id);
      try {
        await this.moveTo({ kind: 'near', pos: item.pos, range: 1 }, { signal, timeoutMs: Math.max(1000, Math.min(5000, timeoutMs - (Date.now() - start))) });
        picked++;
      } catch (e: any) {
        if (e?.name === 'AbortedError') throw e;
      }
      await sleep(200, signal);
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
      try {
        await b.equip(item, 'hand');
        await raceAbort(b.placeBlock(ref, f.scaled(-1)), signal, 5000, () => {});
        return { ok: true };
      } catch (e: any) {
        if (e?.name === 'AbortedError') throw e;
      }
    }
    return { ok: false, reason: 'NO_REFERENCE' };
  }

  async sleepInBed(signal: AbortSignal): Promise<ActionResult & { bedPos?: Vec3Like }> {
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED' };
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
        await b.equip(bedItem, 'hand');
        await raceAbort(b.placeBlock(ref, new Vec3(0, 1, 0)), signal, 5000, () => {});
      } catch (e: any) {
        if (e?.name === 'AbortedError') throw e;
      }
      bed = b.findBlock({ matching: bedIds, maxDistance: 4 });
      if (!bed) return { ok: false, reason: 'PLACE_FAILED' };
      this.bus.publish('place', 'P2', '放下了床');
    }
    await this.moveTo({ kind: 'reach_block', pos: bed.position }, { signal, timeoutMs: 15000 });
    try {
      await raceAbort(b.sleep(bed), signal, 5000, () => {});
    } catch (e: any) {
      if (e?.name === 'AbortedError') throw e;
      return { ok: false, reason: String(e?.message ?? e) };
    }
    const bedPos = { x: bed.position.x, y: bed.position.y, z: bed.position.z };
    try {
      while (b.isSleeping) await sleep(1000, signal);
    } catch (e: any) {
      try { await b.wake(); } catch { /* ignore */ }
      throw e;
    }
    return { ok: true, bedPos };
  }

  private findPlaceSpot(): any | null {
    const b = this.bot;
    const base = b.entity.position.floored();
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) < 2) continue; // 不要放在脚下或贴身
        const ref = b.blockAt(base.offset(dx, -1, dz));
        const above = b.blockAt(base.offset(dx, 0, dz));
        const above2 = b.blockAt(base.offset(dx, 1, dz));
        if (ref && ref.boundingBox === 'block' && above?.name === 'air' && above2?.name === 'air') return ref;
      }
    }
    return null;
  }

  private invCount(id: number): number {
    return this.bot.inventory.items().filter((i: any) => i.type === id).reduce((n: number, i: any) => n + i.count, 0);
  }

  /** 这个物品是否只能在工作台上合成 */
  private needsTable(id: number): boolean {
    const b = this.bot;
    return b.recipesAll(id, null, null).length === 0 && b.recipesAll(id, null, true).length > 0;
  }

  /** 合成 times 次（含超时重试一次：Mineflayer 偶尔会卡在窗口事务上）。观察者模组的合成节奏会拉长耗时，所以时限放宽 */
  private async craftOnce(recipe: any, table: any, signal: AbortSignal, times = 1) {
    const b = this.bot;
    const pace = Number(process.env.UI_PACING_MS ?? 250) || 0;
    const timeout = 10000 + (pace > 0 ? 3000 + pace * 12 * times : 0);
    try {
      await raceAbort(b.craft(recipe, times, table), signal, timeout, () => {});
    } catch (e: any) {
      if (e?.name !== 'TimeoutError') throw e;
      this.bus.publish('craft_retry', 'P1', '合成超时，关闭窗口后重试一次');
      try { if (b.currentWindow) b.closeWindow(b.currentWindow); } catch { /* ignore */ }
      await sleep(300, signal);
      await raceAbort(b.craft(recipe, times, table), signal, timeout + 5000, () => {});
    }
  }

  /** 尽量一次合成所需数量（一次打开工作台），不行再逐个合成 */
  private async craftUpTo(id: number, count: number, table: any, signal: AbortSignal): Promise<number> {
    const b = this.bot;
    let made = 0;
    while (made < count) {
      throwIfAborted(signal);
      const any = b.recipesFor(id, null, 1, table)[0];
      if (!any) break;
      const per = any.result?.count ?? 1;
      const times = Math.max(1, Math.ceil((count - made) / per));
      const bulk = times > 1 ? b.recipesFor(id, null, times * per, table)[0] : null;
      if (bulk) {
        await this.craftOnce(bulk, table, signal, times);
        made += times * per;
      } else {
        await this.craftOnce(any, table, signal, 1);
        made += per;
      }
    }
    return made;
  }

  /**
   * 自动补齐前置材料（最多两层）：例如做木镐时缺木棍 → 先用木板做木棍；缺木板 → 先用原木做木板。
   * 返回 true 表示现在材料足够。
   */
  private async ensureIngredients(id: number, count: number, table: any, signal: AbortSignal, depth: number): Promise<boolean> {
    const b = this.bot;
    if (b.recipesFor(id, null, 1, table)[0]) return true;
    if (depth <= 0) return false;
    const recipes: any[] = b.recipesAll(id, null, table ?? null);
    for (const r of recipes) {
      const times = Math.max(1, Math.ceil(count / (r.result?.count ?? 1)));
      const needs: { id: number; n: number }[] = (r.delta ?? []).filter((d: any) => d.count < 0).map((d: any) => ({ id: d.id, n: -d.count * times }));
      let ok = true;
      for (const nd of needs) {
        const missing = nd.n - this.invCount(nd.id);
        if (missing <= 0) continue;
        if (!(await this.craftSimple(nd.id, missing, table, signal, depth - 1))) {
          ok = false;
          break;
        }
      }
      if (ok && b.recipesFor(id, null, 1, table)[0]) return true;
    }
    return false;
  }

  /** 合成 count 个（先补前置材料）；返回是否成功做出至少所需数量 */
  private async craftSimple(id: number, count: number, table: any, signal: AbortSignal, depth: number): Promise<boolean> {
    const b = this.bot;
    if (this.needsTable(id) && !table) return false;
    if (!(await this.ensureIngredients(id, count, table, signal, depth))) return false;
    const name = this.mcData.items[id]?.name ?? String(id);
    const made = await this.craftUpTo(id, count, table, signal);
    if (made > 0) this.bus.publish('craft_auto', 'P3', `自动补做前置材料：${name} ×${made}`);
    return made >= count;
  }

  /** 找到可用的工作台：记得的位置 → 身边 → 背包里的 → 现做一个；必要时放下 */
  private async ensureTable(signal: AbortSignal, knownPos?: Vec3Like): Promise<any | null> {
    const b = this.bot;
    const tableId = this.mcData.blocksByName.crafting_table.id;
    let table: any = null;
    if (knownPos && b.blockAt(this.vec(knownPos))?.name === 'crafting_table') table = b.blockAt(this.vec(knownPos));
    table ??= b.findBlock({ matching: tableId, maxDistance: 5 }); // 伸手可及范围内
    if (!table) {
      let tableItem = b.inventory.items().find((i: any) => i.name === 'crafting_table');
      if (!tableItem && (await this.craftSimple(this.mcData.itemsByName.crafting_table.id, 1, null, signal, 2))) {
        tableItem = b.inventory.items().find((i: any) => i.name === 'crafting_table');
      }
      const ref = tableItem ? this.findPlaceSpot() : null;
      if (tableItem && ref) {
        const Vec3 = require('vec3').Vec3;
        await b.equip(tableItem, 'hand');
        await raceAbort(b.placeBlock(ref, new Vec3(0, 1, 0)), signal, 5000, () => {});
        table = b.blockAt(ref.position.offset(0, 1, 0));
        this.bus.publish('place', 'P3', '放置了工作台');
      }
    }
    if (table) await this.moveTo({ kind: 'reach_block', pos: table.position }, { signal, timeoutMs: 30000 });
    return table;
  }

  async craft(item: string, count: number, signal: AbortSignal, opts: { tablePos?: Vec3Like } = {}): Promise<ActionResult & { crafted: number }> {
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', crafted: 0 };
    const b = this.bot;
    const data = this.mcData.itemsByName[item];
    if (!data) return { ok: false, reason: 'UNKNOWN_ITEM', crafted: 0 };
    if (b.recipesAll(data.id, null, true).length === 0) return { ok: false, reason: 'UNKNOWN_ITEM', crafted: 0 };

    let table: any = null;
    if (this.needsTable(data.id)) {
      table = await this.ensureTable(signal, opts.tablePos);
      if (!table) return { ok: false, reason: 'NO_CRAFTING_TABLE', crafted: 0 };
    }
    const before = this.invCount(data.id);
    await this.ensureIngredients(data.id, count, table, signal, 2);
    let crafted = await this.craftUpTo(data.id, count, table, signal);
    crafted = Math.max(crafted, this.invCount(data.id) - before);
    return crafted > 0 ? { ok: true, crafted } : { ok: false, reason: 'MISSING_MATERIALS', crafted: 0 };
  }

  private foodItems(): any[] {
    if (!this.ready) return [];
    const foods = this.mcData.foodsByName ?? {};
    return this.bot.inventory
      .items()
      .filter((i: any) => foods[i.name] && !BAD_FOOD.has(i.name))
      .sort((a: any, c: any) => (foods[c.name].foodPoints ?? 0) - (foods[a.name].foodPoints ?? 0));
  }

  hasFood(): boolean {
    return this.foodItems().length > 0;
  }

  async eat(signal: AbortSignal): Promise<boolean> {
    const item = this.foodItems()[0];
    if (!item) return false;
    const b = this.bot;
    await b.equip(item, 'hand');
    await raceAbort(b.consume(), signal, 6000, () => {
      try { b.deactivateItem(); } catch { /* ignore */ }
    });
    return true;
  }

  async equipWeapon(): Promise<void> {
    if (!this.ready) return;
    const items = this.bot.inventory.items();
    for (const kind of ['sword', 'axe']) {
      for (const mat of WEAPON_ORDER) {
        const it = items.find((i: any) => i.name === `${mat}_${kind}`);
        if (it) {
          if (this.bot.heldItem?.name !== it.name) await this.bot.equip(it, 'hand');
          return;
        }
      }
    }
  }

  async attack(entityId: number): Promise<boolean> {
    if (!this.ready) return false;
    const ent = this.bot.entities[entityId];
    if (!ent || !ent.isValid) return false;
    try {
      await this.bot.lookAt(ent.position.offset(0, (ent.height ?? 1.6) * 0.85, 0), true);
    } catch { /* ignore */ }
    this.bot.attack(ent);
    return true;
  }

  async look(yaw: number, pitch: number) {
    if (!this.ready) return;
    await this.bot.look(yaw, pitch, false);
  }

  async jump(ms: number, signal: AbortSignal) {
    if (!this.ready) return;
    this.bot.setControlState('jump', true);
    try {
      await sleep(ms, signal);
    } finally {
      this.bot.setControlState('jump', false);
    }
  }

  chat(text: string) {
    if (!this.ready || !text) return;
    try { this.bot.chat(text.replace(/\s+/g, ' ').slice(0, 240)); } catch { /* ignore */ }
  }
}

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
  GameAdapter,
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

    const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline' });
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
      out.push({ id: ent.id, name, kind: this.classify(ent), pos: { x: ent.position.x, y: ent.position.y, z: ent.position.z }, dist: d });
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

  async craft(item: string, count: number, signal: AbortSignal): Promise<ActionResult & { crafted: number }> {
    throwIfAborted(signal);
    if (!this.ready) return { ok: false, reason: 'NOT_CONNECTED', crafted: 0 };
    const b = this.bot;
    const data = this.mcData.itemsByName[item];
    if (!data) return { ok: false, reason: 'UNKNOWN_ITEM', crafted: 0 };

    let table: any = null;
    let recipe = b.recipesFor(data.id, null, 1, null)[0];
    if (!recipe) {
      const tableId = this.mcData.blocksByName.crafting_table.id;
      table = b.findBlock({ matching: tableId, maxDistance: 32 });
      if (!table) {
        const tableItem = b.inventory.items().find((i: any) => i.name === 'crafting_table');
        const ref = tableItem ? this.findPlaceSpot() : null;
        if (tableItem && ref) {
          const Vec3 = require('vec3').Vec3;
          await b.equip(tableItem, 'hand');
          await raceAbort(b.placeBlock(ref, new Vec3(0, 1, 0)), signal, 5000, () => {});
          table = b.blockAt(ref.position.offset(0, 1, 0));
          this.bus.publish('place', 'P3', '放置了工作台');
        }
      }
      if (table) {
        await this.moveTo({ kind: 'reach_block', pos: table.position }, { signal, timeoutMs: 30000 });
        recipe = b.recipesFor(data.id, null, 1, table)[0];
      }
      if (!recipe) {
        const needsTable = !table && b.recipesAll(data.id, null, true).length > 0;
        return { ok: false, reason: needsTable ? 'NO_CRAFTING_TABLE' : 'MISSING_MATERIALS', crafted: 0 };
      }
    }
    const per = recipe.result?.count ?? 1;
    const times = Math.max(1, Math.ceil(count / per));
    // 材料可能只够做一部分：逐次合成直到失败
    let crafted = 0;
    for (let i = 0; i < times; i++) {
      throwIfAborted(signal);
      const r = b.recipesFor(data.id, null, 1, table)[0];
      if (!r) break;
      await raceAbort(b.craft(r, 1, table), signal, 10000, () => {});
      crafted += per;
    }
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

import { EventEmitter } from 'node:events';
import type { ActionResult, AgentState, BlockHit, BossDeathObservation, DriveKeys, DriveOptions, DriveResult, EntityInfo, Eye, GameAdapter, InvItem, MoveOpts, MoveTarget, Optics, Vec3Like } from '../src/adapter/types.ts';
import { dist3, raceAbort, sleep, throwIfAborted } from '../src/util.ts';

/** 离线测试用的模拟游戏：没有 Minecraft 也能验证仲裁、反射、规划与连贯性。 */
export class FakeAdapter extends EventEmitter implements GameAdapter {
  pos: Vec3Like = { x: 0, y: 64, z: 0 };
  hp = 20;
  food = 20;
  connected = true;
  observationReady = true;
  worldId = 'fake-world';
  sessionId = 'fake-session';
  observationId = 0;
  dim = 'overworld';
  inLava = false;
  blockProperties = new Map<string, Record<string, string | number | boolean>>();
  equipped = new Map<string, string>();
  portalDestinations = new Map<string, { dim: string; pos: Vec3Like; arrivalPortal?: boolean }>();
  dragonDeath: BossDeathObservation | null = null;
  inv = new Map<string, number>();
  blocks: { name: string; pos: Vec3Like }[] = [];
  entities: EntityInfo[] = [];
  speed = 20; // 格/秒（测试加速）
  actions: string[] = [];
  stopAllCount = 0;
  /** 朝向：默认面朝东（+X）；yaw 约定与 mineflayer 相同 */
  yaw = -Math.PI / 2;
  pitch = -0.15;
  /** 地面：y=63 为草方块，y<63 为石头（被挖掉的记在 removed） */
  groundY = 63;
  removed = new Set<string>();
  light = 15;
  oxygen = 20;
  inWater = false;
  onGround = true;
  /** 正在乘坐的东西（boat/horse…） */
  riding: string | null = null;
  private ridingId: number | null = null;

  private k(x: number, y: number, z: number) {
    return `${x},${y},${z}`;
  }
  /** 世界里 (x,y,z) 的方块名 */
  private idx = new Map<string, string>();
  private secs = new Set<string>();
  sectionEmpty(x: number, y: number, z: number): boolean {
    this.nameAt(0, 0, 0); // 确保索引最新
    if (((y >> 4) << 4) <= this.groundY) return false;
    return !this.secs.has(`${x >> 4},${y >> 4},${z >> 4}`);
  }
  private idxRef: unknown = null;
  private idxLen = -1;
  nameAt(x: number, y: number, z: number): string {
    if (this.idxRef !== this.blocks || this.idxLen !== this.blocks.length) {
      this.idx = new Map(this.blocks.map((bb) => [this.k(bb.pos.x, bb.pos.y, bb.pos.z), bb.name]));
      this.secs = new Set(this.blocks.map((bb) => `${bb.pos.x >> 4},${bb.pos.y >> 4},${bb.pos.z >> 4}`));
      this.idxRef = this.blocks;
      this.idxLen = this.blocks.length;
    }
    const b = this.idx.get(this.k(x, y, z));
    if (b) return b;
    if (this.removed.has(this.k(x, y, z))) return 'air';
    if (y === this.groundY) return 'grass_block';
    if (y < this.groundY) return 'stone';
    return 'air';
  }
  eye(): Eye | null {
    return this.connected ? { x: this.pos.x, y: this.pos.y + 1.62, z: this.pos.z, yaw: this.yaw, pitch: this.pitch } : null;
  }
  blockOptics(x: number, y: number, z: number): Optics | null {
    const name = this.nameAt(x, y, z);
    const kind = name === 'air' || name.includes('glass') ? 'clear' : name === 'water' ? 'water' : name.endsWith('_leaves') ? 'foliage' : 'solid';
    return { name, kind };
  }
  /** 简化光照：火把 14 级向外每格减 1；地面以上有天光（this.light），地下没有 */
  lightAt(x: number, y: number, z: number) {
    let block = 0;
    for (const b of this.blocks) if (b.name === 'torch') block = Math.max(block, 14 - (Math.abs(b.pos.x - x) + Math.abs(b.pos.y - y) + Math.abs(b.pos.z - z)));
    return { block, sky: y > this.groundY ? this.light : 0 };
  }

  state(): AgentState {
    return {
      connected: this.connected, alive: this.hp > 0, observationReady: this.observationReady && this.connected && this.hp > 0,
      worldId: this.worldId, sessionId: this.sessionId, observationId: ++this.observationId,
      username: 'FakeBot', pos: { ...this.pos }, dim: this.dim,
      hp: this.hp, food: this.food, oxygen: this.oxygen, timeOfDay: this.isDay ? 1000 : 15000, isDay: this.isDay, biome: 'plains', onGround: this.onGround,
      inWater: this.inWater, inLava: this.inLava, inventory: [...this.inv].map(([name, count]) => ({ name, count })), emptySlots: 30, held: null, riding: this.riding,
      equipment: [...this.equipped].map(([slot, name]) => ({ slot, name })),
    };
  }
  nearbyEntities(radius: number): EntityInfo[] {
    return this.entities.map((e) => ({ ...e, dist: dist3(e.pos, this.pos) })).filter((e) => e.dist <= radius).sort((a, b) => a.dist - b.dist);
  }
  findBlocks(names: string[], maxDist: number, count: number): BlockHit[] {
    return this.blocks
      .filter((b) => names.includes(b.name))
      .map((b) => ({ ...b, dist: dist3(b.pos, this.pos) }))
      .filter((b) => b.dist <= maxDist)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, count);
  }
  blockAt(pos: Vec3Like) {
    return this.nameAt(pos.x, pos.y, pos.z);
  }
  blockStateAt(pos: Vec3Like) {
    return { name: this.blockAt(pos), properties: this.blockProperties.get(this.k(pos.x, pos.y, pos.z)) ?? {} };
  }
  async placeBlockStateAt(pos: Vec3Like, name: string, properties: Record<string, string | number | boolean>, signal: AbortSignal) {
    throwIfAborted(signal);
    const door = name.endsWith('_door'), stairs = name.endsWith('_stairs'), slab = name.endsWith('_slab'), bed = name.endsWith('_bed'), gate = name.endsWith('_fence_gate');
    const direction: Record<string, Vec3Like> = { north: { x: 0, y: 0, z: -1 }, east: { x: 1, y: 0, z: 0 }, south: { x: 0, y: 0, z: 1 }, west: { x: -1, y: 0, z: 0 } };
    if (!door && !stairs && !slab && !bed && !gate || door && properties.half !== 'lower' || stairs && (!['top', 'bottom'].includes(String(properties.half)) || String(properties.shape ?? 'straight') !== 'straight') || slab && !['top', 'bottom'].includes(String(properties.type)) || bed && (properties.part !== 'foot' || !(String(properties.facing) in direction)) || gate && !(String(properties.facing) in direction)) return { ok: false, reason: 'UNSUPPORTED_BLOCK_STATE' };
    const offset = bed ? direction[String(properties.facing)] : { x: 0, y: 1, z: 0 };
    const paired = { x: pos.x + offset.x, y: pos.y + offset.y, z: pos.z + offset.z };
    if (this.blockAt(pos) !== 'air' || (door || bed) && this.blockAt(paired) !== 'air') return { ok: false, reason: 'BLOCKED' };
    if (bed && [pos, paired].some((p) => ['air', 'water', 'lava'].includes(this.blockAt({ ...p, y: p.y - 1 })))) return { ok: false, reason: 'NO_SUPPORT' };
    const result = await this.placeBlockAt(pos, [name], signal);
    throwIfAborted(signal);
    if (result.ok) {
      this.blockProperties.set(this.k(pos.x, pos.y, pos.z), { ...properties });
      if (door || bed) {
        this.blocks.push({ name, pos: paired });
        this.blockProperties.set(this.k(paired.x, paired.y, paired.z), bed ? { ...properties, part: 'head', occupied: false } : { ...properties, half: 'upper' });
      }
    }
    return result;
  }
  async equipItem(name: string, destination: 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet', signal: AbortSignal) {
    throwIfAborted(signal);
    if (!(this.inv.get(name) ?? 0)) return { ok: false, reason: 'NO_ITEM' };
    this.equipped.set(destination, name);
    this.actions.push(`equip:${name}:${destination}`);
    return { ok: true };
  }
  async useBlockAt(pos: Vec3Like, item: string, signal: AbortSignal) {
    throwIfAborted(signal);
    if (item && !(this.inv.get(item) ?? 0)) return { ok: false, reason: 'NO_ITEM' };
    await sleep(10, signal);
    if (item === 'flint_and_steel' && this.blockAt(pos) === 'obsidian') {
      this.blocks.push({ name: 'nether_portal', pos: { ...pos, y: pos.y + 1 } });
    } else if (item === 'ender_eye' && this.blockAt(pos) === 'end_portal_frame') {
      this.blockProperties.set(this.k(pos.x, pos.y, pos.z), { ...this.blockStateAt(pos).properties, eye: true });
      this.take(item, 1);
    } else if (item === '' && this.blockAt(pos).endsWith('_door')) {
      const here = this.blockStateAt(pos);
      const open = here.properties.open !== true;
      const other = { ...pos, y: pos.y + (here.properties.half === 'upper' ? -1 : 1) };
      for (const part of [pos, other]) if (this.blockAt(part) === here.name) this.blockProperties.set(this.k(part.x, part.y, part.z), { ...this.blockStateAt(part).properties, open });
    }
    this.actions.push(`useBlock:${item}`);
    return { ok: true };
  }
  async useItem(item: string, signal: AbortSignal, opts: { chargeMs?: number } = {}) {
    throwIfAborted(signal);
    if (!(this.inv.get(item) ?? 0)) return { ok: false, reason: 'NO_ITEM' };
    await sleep(opts.chargeMs ?? 0, signal);
    this.actions.push(`use:${item}`);
    return { ok: true };
  }
  async rangedAttack(entityId: number, signal: AbortSignal) {
    throwIfAborted(signal);
    if (!(this.inv.get('bow') ?? 0) || !(this.inv.get('arrow') ?? 0)) return { ok: false, reason: 'NO_BOW_OR_ARROWS' };
    if (!this.entities.some((e) => e.id === entityId)) return { ok: false, reason: 'ENTITY_GONE' };
    await sleep(10, signal);
    this.take('arrow', 1);
    this.actions.push(`ranged:${entityId}`);
    return { ok: true };
  }
  bossStatus() { return { dragonDeath: this.dragonDeath && this.dragonDeath.worldId === this.worldId && this.dragonDeath.dim === this.dim && this.dragonDeath.sessionId === this.sessionId ? this.dragonDeath : null }; }
  async enterPortalAt(pos: Vec3Like, signal: AbortSignal, expectedDim?: string) {
    throwIfAborted(signal);
    const from = this.state();
    const kind = this.blockAt(pos);
    if (!['nether_portal', 'end_portal'].includes(kind)) return { ok: false, reason: 'NO_PORTAL' };
    const destination = this.portalDestinations.get(`${this.worldId}:${this.dim}:${this.k(pos.x, pos.y, pos.z)}`);
    if (!destination) return { ok: false, reason: 'PORTAL_TRANSITION_TIMEOUT' };
    await sleep(20, signal);
    this.dim = destination.dim;
    this.pos = { ...destination.pos };
    this.sessionId = `${this.sessionId}-portal`;
    this.observationReady = true;
    if (destination.arrivalPortal !== false && this.blockAt(destination.pos) !== kind) this.blocks.push({ name: kind, pos: { ...destination.pos } });
    this.actions.push(`portal:${from.dim}->${this.dim}`);
    const to = this.state();
    return expectedDim && to.dim !== expectedDim ? { ok: false, reason: 'WRONG_DIMENSION', from, to } : { ok: true, from, to };
  }
  resolveBlockNames(q: string) {
    if (q === 'log') return ['oak_log'];
    if (q === 'stone') return ['stone'];
    return /^[a-z_]+$/.test(q) ? [q] : [];
  }
  isKnownItem(n: string) {
    return /^[a-z_]+$/.test(n);
  }
  async moveTo(t: MoveTarget, o: MoveOpts) {
    throwIfAborted(o.signal);
    this.actions.push(`moveTo:${t.kind}`);
    let dest: Vec3Like = this.pos;
    if (t.kind === 'near' || t.kind === 'reach_block' || t.kind === 'place_block') dest = t.pos;
    else if (t.kind === 'xz') dest = { x: t.x, y: this.pos.y, z: t.z };
    else if (t.kind === 'xyz') dest = { x: t.x + 0.5, y: t.y, z: t.z + 0.5 };
    else if (t.kind === 'away_from') dest = { x: this.pos.x + t.distance, y: this.pos.y, z: this.pos.z };
    else if (t.kind === 'follow_entity') {
      const e = this.entities.find((en) => en.id === t.entityId);
      if (!e) throw new Error('ENTITY_GONE');
      const d0 = dist3(e.pos, this.pos);
      const k = Math.max(0, (d0 - t.range) / d0);
      dest = { x: this.pos.x + (e.pos.x - this.pos.x) * k, y: this.pos.y, z: this.pos.z + (e.pos.z - this.pos.z) * k };
    }
    const d = dist3(dest, this.pos);
    if (Math.hypot(dest.x - this.pos.x, dest.z - this.pos.z) > 0.5) this.yaw = Math.atan2(-(dest.x - this.pos.x), -(dest.z - this.pos.z));
    const start = { ...this.pos };
    const t0 = Date.now();
    const total = (d / this.speed) * 1000;
    const iv = setInterval(() => {
      const f = Math.min(1, (Date.now() - t0) / Math.max(1, total));
      this.pos = { x: start.x + (dest.x - start.x) * f, y: start.y + (dest.y - start.y) * f, z: start.z + (dest.z - start.z) * f };
    }, 50);
    try {
      await raceAbort(sleep(total, o.signal), o.signal, o.timeoutMs, () => this.stopAll());
      this.pos = { ...dest };
      // 走到掉落物旁边就捡起来
      for (const e of this.entities.filter((en) => en.kind === 'item' && dist3(en.pos, this.pos) < 1.6)) {
        this.inv.set(e.name.replace(/^item:/, ''), (this.inv.get(e.name.replace(/^item:/, '')) ?? 0) + 1);
      }
      this.entities = this.entities.filter((en) => !(en.kind === 'item' && dist3(en.pos, this.pos) < 1.6));
    } finally {
      clearInterval(iv);
    }
  }
  stopAll() {
    this.stopAllCount++;
  }
  canHarvest() {
    return true;
  }
  /** 简化的挖掘时间表：空手砍木 3s，木斧 1.5s，石斧 0.75s */
  digTimeEstimate(block: string, tool: string | null) {
    if (!block.endsWith('_log')) return null;
    if (!tool) return 3000;
    if (tool === 'wooden_axe') return 1500;
    if (tool === 'stone_axe') return 750;
    return 3000;
  }
  async dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult> {
    await sleep(100, signal);
    const crop = this.crops.get(this.k(pos.x, pos.y, pos.z));
    if (crop) {
      this.crops.delete(this.k(pos.x, pos.y, pos.z));
      if (crop.age >= 7) { this.inv.set('wheat', (this.inv.get('wheat') ?? 0) + 1); this.inv.set('wheat_seeds', (this.inv.get('wheat_seeds') ?? 0) + 2); }
      return { ok: true };
    }
    const name = this.nameAt(pos.x, pos.y, pos.z);
    if (name === 'air') return { ok: false, reason: 'NO_BLOCK' };
    // 挖掉后该格必须是空气（加入 removed），否则会回退到默认方块，感知层也看不到挖空的结果。
    this.blocks = this.blocks.filter((b) => !(b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z));
    this.removed.add(this.k(pos.x, pos.y, pos.z));
    const b = { name };
    const drop = b.name === 'stone' ? 'cobblestone' : b.name === 'grass_block' ? 'dirt' : b.name;
    // 挖掉脚下的方块会掉下去
    if (Math.floor(this.pos.x) === pos.x && Math.floor(this.pos.z) === pos.z && Math.floor(this.pos.y) - 1 === pos.y) this.pos = { ...this.pos, y: this.pos.y - 1 };
    this.inv.set(drop, (this.inv.get(drop) ?? 0) + 1);
    this.actions.push(`dig:${b.name}`);
    return { ok: true };
  }
  async collectNearbyDrops() {
    return 0;
  }
  async placeBlockAt(pos: Vec3Like, itemNames: string[], signal: AbortSignal): Promise<ActionResult> {
    await sleep(50, signal);
    const name = itemNames.find((n) => (this.inv.get(n) ?? 0) > 0);
    if (!name) return { ok: false, reason: 'NO_ITEM' };
    if (this.nameAt(pos.x, pos.y, pos.z) !== 'air') return { ok: true };
    this.removed.delete(this.k(pos.x, pos.y, pos.z));
    this.blocks.push({ name, pos: { ...pos } });
    this.inv.set(name, (this.inv.get(name) ?? 1) - 1);
    this.actions.push(`place:${name}`);
    return { ok: true };
  }
  async useBucketAt(pos: Vec3Like, item: string, signal: AbortSignal): Promise<ActionResult & { placed?: Vec3Like }> {
    await sleep(20, signal);
    if (!(this.inv.get(item) ?? 0)) return { ok: false, reason: `NO_ITEM:${item}` };
    const fluid = item === 'water_bucket' ? 'water' : 'lava';
    if (this.nameAt(pos.x, pos.y, pos.z) !== 'air') return { ok: false, reason: `BLOCKED:(${pos.x},${pos.y},${pos.z}) 不是空气，是 ${this.nameAt(pos.x, pos.y, pos.z)}` };
    const sides = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    const solid = sides.some(([dx, dy, dz]) => !['air', 'water', 'lava'].includes(this.nameAt(pos.x + dx, pos.y + dy, pos.z + dz)));
    if (!solid) return { ok: false, reason: `NO_REFERENCE:(${pos.x},${pos.y},${pos.z}) 四周没有实心方块可贴面` };
    this.inv.set(item, (this.inv.get(item) ?? 0) - 1);
    this.inv.set('bucket', (this.inv.get('bucket') ?? 0) + 1);
    this.removed.delete(this.k(pos.x, pos.y, pos.z));
    this.blocks.push({ name: fluid, pos: { ...pos } });
    this.actions.push(`useBucket:${item}`);
    return { ok: true, placed: { x: pos.x, y: pos.y, z: pos.z }, effectEvidence: { verified: true, changed: true, reasons: [`(${pos.x},${pos.y},${pos.z}) 出现了 ${fluid}`, `背包 ${item} 减少 1`] } };
  }
  async craft(item: string, count: number, signal: AbortSignal) {
    await sleep(50, signal);
    this.inv.set(item, (this.inv.get(item) ?? 0) + count);
    this.actions.push(`craft:${item}`);
    return { ok: true, crafted: count };
  }
  isDay = true;
  chests = new Map<string, Map<string, number>>();
  /** 模拟箱子装满：置为 true 时 useChest 不搬任何东西，moved 恒为 0 */
  chestFull = false;
  crops = new Map<string, { age: number; crop: string }>();
  private take(name: string, n: number) {
    this.inv.set(name, Math.max(0, (this.inv.get(name) ?? 0) - n));
  }
  async smelt(input: string, count: number, fuel: string, signal: AbortSignal) {
    const SM: Record<string, string> = { raw_iron: 'iron_ingot', beef: 'cooked_beef', oak_log: 'charcoal', sand: 'glass', cobblestone: 'stone' };
    if (!(this.inv.get(input) ?? 0)) return { ok: false, reason: `NO_INPUT:${input}`, made: 0 };
    if (!(this.inv.get(fuel) ?? 0)) return { ok: false, reason: `NO_FUEL:${fuel}`, made: 0 };
    if (!this.blocks.some((b) => b.name === 'furnace') && !(this.inv.get('furnace') ?? 0)) {
      if ((this.inv.get('cobblestone') ?? 0) < 8) return { ok: false, reason: 'NO_FURNACE', made: 0 };
      this.take('cobblestone', 8);
    }
    const n = Math.min(count, this.inv.get(input)!);
    await sleep(100, signal);
    this.take(input, n);
    this.take(fuel, 1);
    const out = SM[input] ?? 'unknown';
    this.inv.set(out, (this.inv.get(out) ?? 0) + n);
    return { ok: true, made: n, output: out };
  }
  async useChest(pos: Vec3Like, deposits: InvItem[], withdraws: InvItem[], signal: AbortSignal) {
    if (this.nameAt(pos.x, pos.y, pos.z) !== 'chest') return { ok: false, reason: 'NO_CHEST', contents: [], moved: 0 };
    const lid = this.nameAt(pos.x, pos.y + 1, pos.z);
    if (lid && /stone|dirt|planks|andesite|diorite|granite|deepslate/.test(lid)) return { ok: false, reason: `LID_BLOCKED:${lid}`, contents: [], moved: 0 };
    await sleep(50, signal);
    const c = this.chests.get(this.k(pos.x, pos.y, pos.z)) ?? new Map<string, number>();
    let moved = 0;
    if (this.chestFull) return { ok: true, contents: [...c].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })), moved: 0 };
    for (const d of deposits) { const n = Math.min(d.count, this.inv.get(d.name) ?? 0); this.take(d.name, n); c.set(d.name, (c.get(d.name) ?? 0) + n); moved += n; }
    for (const w of withdraws) { const n = Math.min(w.count, c.get(w.name) ?? 0); c.set(w.name, (c.get(w.name) ?? 0) - n); this.inv.set(w.name, (this.inv.get(w.name) ?? 0) + n); moved += n; }
    this.chests.set(this.k(pos.x, pos.y, pos.z), c);
    return { ok: true, contents: [...c].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })), moved };
  }
  async till(pos: Vec3Like, signal: AbortSignal) {
    await sleep(20, signal);
    if (![...this.inv.keys()].some((n) => n.endsWith('_hoe') && (this.inv.get(n) ?? 0) > 0)) return { ok: false, reason: 'NO_HOE' };
    const n = this.nameAt(pos.x, pos.y, pos.z);
    if (n === 'farmland') return { ok: true };
    if (n !== 'grass_block' && n !== 'dirt') return { ok: false, reason: `NOT_TILLABLE:${n}` };
    this.blocks = this.blocks.filter((b) => !(b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z));
    this.blocks.push({ name: 'farmland', pos: { ...pos } });
    return { ok: true };
  }
  async plant(pos: Vec3Like, seed: string, signal: AbortSignal) {
    await sleep(20, signal);
    if (this.nameAt(pos.x, pos.y, pos.z) !== 'farmland') return { ok: false, reason: 'NOT_FARMLAND' };
    if (!(this.inv.get(seed) ?? 0)) return { ok: false, reason: `NO_SEED:${seed}` };
    this.take(seed, 1);
    this.crops.set(this.k(pos.x, pos.y + 1, pos.z), { age: 0, crop: seed === 'wheat_seeds' ? 'wheat' : seed });
    return { ok: true };
  }
  cropAge(pos: Vec3Like) {
    const c = this.crops.get(this.k(pos.x, pos.y, pos.z));
    return c ? { age: c.age, max: 7 } : null;
  }
  async sleepInBed(signal: AbortSignal) {
    if (this.dim !== 'overworld') return { ok: false, reason: 'WRONG_DIMENSION' };
    if (![...this.inv.keys()].some((n) => n.endsWith('_bed') && (this.inv.get(n) ?? 0) > 0)) return { ok: false, reason: 'NO_BED' };
    if (this.isDay) return { ok: false, reason: "it's not night" };
    await sleep(200, signal);
    this.isDay = true;
    return { ok: true, bedPos: { x: Math.floor(this.pos.x) + 2, y: Math.floor(this.pos.y), z: Math.floor(this.pos.z) } };
  }
  hasFood() {
    return (this.inv.get('bread') ?? 0) > 0;
  }
  async eat(signal: AbortSignal, item = 'bread') {
    await sleep(100, signal);
    if ((this.inv.get(item) ?? 0) <= 0) return false;
    this.inv.set(item, this.inv.get(item)! - 1);
    this.food = 20;
    return true;
  }
  async equipWeapon() {}
  async attack(id: number) {
    this.actions.push(`attack:${id}`);
    const hit = this.entities.find((e) => e.id === id);
    this.entities = this.entities.filter((e) => e.id !== id);
    // 打碎的船掉出船物品（放船时记下的是哪种船）
    if (hit && /boat|raft/.test(hit.name) && hit.kind !== 'item') {
      this.entities.push({ id: id + 500, name: `item:${this.boatItems.get(id) ?? 'oak_boat'}`, kind: 'item', pos: { ...hit.pos }, dist: 0, count: 1 });
    }
    return true;
  }
  /** 放下的船实体 id → 船物品名 */
  boatItems = new Map<number, string>();
  /** 每一竿钓到什么（用完后默认 cod）；写 null 表示这一竿没咬钩 */
  fishCatches: (string | null)[] = [];
  async fish(signal: AbortSignal, opts: { aim?: Vec3Like; timeoutMs: number }) {
    throwIfAborted(signal);
    if (!(this.inv.get('fishing_rod') ?? 0)) return { ok: false, reason: 'NO_ROD' };
    this.actions.push(`fish:${opts.aim ? this.nameAt(opts.aim.x, opts.aim.y, opts.aim.z) : '?'}`);
    await sleep(10, signal);
    const c = this.fishCatches.length ? this.fishCatches.shift()! : 'cod';
    if (!c) return { ok: false, reason: 'NO_BITE' };
    this.inv.set(c, (this.inv.get(c) ?? 0) + 1);
    return { ok: true, caught: c };
  }
  async look(yaw: number, pitch: number) {
    this.yaw = yaw;
    this.pitch = pitch;
  }
  /** 原地垫高：脚下实心才垫得上；放下方块、人升一格 */
  async pillarUp(itemNames: string[], signal: AbortSignal) {
    throwIfAborted(signal);
    const f = { x: Math.floor(this.pos.x), y: Math.floor(this.pos.y), z: Math.floor(this.pos.z) };
    const below = this.nameAt(f.x, f.y - 1, f.z);
    if (/^(air|water|lava)$/.test(below)) return { ok: false, reason: 'NO_REFERENCE' };
    const item = itemNames.find((n) => (this.inv.get(n) ?? 0) > 0);
    if (!item) return { ok: false, reason: 'NO_ITEM' };
    if (!/^(air|cave_air|void_air|water)$/.test(this.nameAt(f.x, f.y + 2, f.z))) return { ok: false, reason: 'NOT_PLACED:头顶跳跃空间受阻' };
    this.inv.set(item, this.inv.get(item)! - 1);
    this.removed.delete(`${f.x},${f.y},${f.z}`);
    this.blocks.push({ name: item, pos: f });
    this.pos = { ...this.pos, y: f.y + 1 };
    return { ok: true, y: f.y + 1 };
  }
  /** 按住移动键：朝 yaw 的前后左右走（测试里按时间直接算位移，走一步检查一次脚下） */
  shieldUp = false;
  drawingSince: number | null = null;
  async drive(keys: DriveKeys, ms: number, signal: AbortSignal, opts: DriveOptions = {}): Promise<DriveResult> {
    throwIfAborted(signal);
    this.actions.push(`drive:${Object.keys(keys).filter((k) => (keys as any)[k]).join('+')}`);
    const face = () => {
      const t = opts.faceEntity !== undefined ? this.entities.find((e) => e.id === opts.faceEntity)?.pos : opts.facePoint;
      if (t) this.yaw = Math.atan2(-(t.x - this.pos.x), -(t.z - this.pos.z));
    };
    face();
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const f = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0), r = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const len = Math.hypot(f, r) || 1;
    const speed = (this.shieldUp || keys.sneak ? 1.3 : keys.sprint ? 5.6 : 4.3) * Math.min(1, ms / 1000);
    const steps = 10, start = { ...this.pos };
    for (let i = 0; i < steps; i++) {
      const nx = this.pos.x + ((fx * f - fz * r) / len) * speed / steps, nz = this.pos.z + ((fz * f + fx * r) / len) * speed / steps;
      const at = (dy: number) => this.nameAt(Math.floor(nx), Math.floor(this.pos.y) + dy, Math.floor(nz));
      if (opts.guard !== false && [at(0), at(-1)].some((n) => /lava|fire/.test(n))) return { ok: false, reason: 'HAZARD', stopped: 'lava', moved: dist3(start, this.pos), ms };
      this.pos = { ...this.pos, x: nx, z: nz };
      face();
    }
    await sleep(Math.min(ms, 5), signal);
    return { ok: true, moved: Math.round(dist3(start, this.pos) * 100) / 100, ms };
  }
  async raiseShield(on: boolean) {
    if (on && this.equipped.get('off-hand') !== 'shield') return { ok: false, reason: 'NO_SHIELD' };
    this.shieldUp = on;
    return { ok: true };
  }
  async startDraw(item: string) {
    if (!this.inv.get(item)) return { ok: false, reason: 'NO_ITEM' };
    this.drawingSince = Date.now();
    return { ok: true };
  }
  async releaseDraw(_signal: AbortSignal, aim?: Vec3Like) {
    if (this.drawingSince === null) return { ok: false, reason: 'NOT_DRAWING', chargedMs: 0 };
    const chargedMs = Date.now() - this.drawingSince;
    this.drawingSince = null;
    this.actions.push(`release:${aim ? `${aim.x},${aim.y},${aim.z}` : 'ahead'}`);
    return { ok: true, chargedMs };
  }
  combatState() { return { usingItem: this.shieldUp || this.drawingSince !== null, offHand: this.equipped.get('off-hand') ?? null, drawingSinceMs: this.drawingSince === null ? null : Date.now() - this.drawingSince }; }
  async jump(ms: number, signal: AbortSignal) {
    await sleep(ms, signal);
    if (this.inWater) this.oxygen = Math.min(20, this.oxygen + 6); // 浮上水面换气
  }
  async swimTo(target: Vec3Like | null, signal: AbortSignal, _opts?: { timeoutMs?: number }) {
    throwIfAborted(signal);
    this.actions.push(`swim:${target ? `${target.x},${target.y},${target.z}` : 'up'}`);
    await sleep(10, signal);
    this.oxygen = 20;
    if (target) { this.pos = { ...target }; this.inWater = false; }
    return { ok: !this.inWater, landed: !this.inWater, surfaced: !this.inWater, oxygen: this.oxygen, ...(!target && this.inWater ? { reason: 'WATER_ESCAPE_TIMEOUT' } : {}) };
  }
  // ---- 通用基础动作（测试用的简化世界：船只能在 water 方块上行驶）
  async useItemOn(item: string, target: { kind: 'block'; pos: Vec3Like } | { kind: 'self' }, signal: AbortSignal): Promise<ActionResult & { spawned?: string; placed?: Vec3Like }> {
    await sleep(20, signal);
    if (!(this.inv.get(item) ?? 0)) return { ok: false, reason: `NO_ITEM:${item}` };
    this.actions.push(`use:${item}:${target.kind === 'block' ? this.nameAt(target.pos.x, target.pos.y, target.pos.z) : 'self'}`);
    if (target.kind === 'block' && /_boat$/.test(item)) {
      this.yaw = Math.atan2(-(target.pos.x + 0.5 - this.pos.x), -(target.pos.z + 0.5 - this.pos.z)); // 放船前看向那格水面（真适配器也是）
      // 和原版一样：船身（1.375 格宽）压着人就放不下
      if (Math.max(Math.abs(target.pos.x + 0.5 - this.pos.x), Math.abs(target.pos.z + 0.5 - this.pos.z)) < 0.99) {
        this.actions.push('boat:blocked-by-self');
        return { ok: false, reason: 'Failed to place entity' };
      }
      this.inv.set(item, this.inv.get(item)! - 1);
      const id = 9000 + this.entities.length;
      this.boatItems.set(id, item);
      this.entities.push({ id, name: 'boat', kind: 'other', pos: { x: target.pos.x + 0.5, y: target.pos.y + 1, z: target.pos.z + 0.5 }, dist: 0, height: 0.6 });
      return { ok: true, spawned: 'boat' };
    }
    if (target.kind === 'block' && item === 'bucket' && ['water', 'lava'].includes(this.nameAt(target.pos.x, target.pos.y, target.pos.z))) {
      const src = this.nameAt(target.pos.x, target.pos.y, target.pos.z);
      this.inv.set('bucket', (this.inv.get('bucket') ?? 0) - 1);
      this.inv.set(`${src}_bucket`, (this.inv.get(`${src}_bucket`) ?? 0) + 1);
      const i = this.blocks.findIndex((b) => b.pos.x === target.pos.x && b.pos.y === target.pos.y && b.pos.z === target.pos.z);
      if (i >= 0) this.blocks.splice(i, 1);
      else this.removed.add(this.k(target.pos.x, target.pos.y, target.pos.z));
      this.actions.push(`fill:${src}`);
      return { ok: true, effectEvidence: { verified: true, changed: true, reasons: [`背包 bucket 减少 1、${src}_bucket 增加 1`, `(${target.pos.x},${target.pos.y},${target.pos.z}) 的 ${src} 变成了空气`] } };
    }
    return { ok: true };
  }
  async interactEntity(entityId: number, item: string | null, signal: AbortSignal) {
    await sleep(20, signal);
    const e = this.entities.find((x) => x.id === entityId);
    if (!e) return { ok: false, reason: 'ENTITY_GONE' };
    this.actions.push(`interact:${e.name}${item ? `:${item}` : ''}`);
    if (!item && /boat|minecart|horse/.test(e.name)) {
      this.riding = e.name; this.ridingId = e.id; this.pos = { ...e.pos };
      return { ok: true, mounted: e.name };
    }
    if (item) {
      // 测试里放进 refuseFeed 的实体不接受（已经在求偶等），其余的吃掉一个
      if (this.refuseFeed.has(e.id) || !(this.inv.get(item) ?? 0)) return { ok: false, reason: `NO_EFFECT:拿着 ${item} 右键了 ${e.name}，背包和它都没有反应`, effectEvidence: { verified: true, changed: false, reasons: [] } };
      this.inv.set(item, this.inv.get(item)! - 1);
      this.refuseFeed.add(e.id);
      return { ok: true, effectEvidence: { verified: true, changed: true, reasons: [`背包里的 ${item} 少了 1 个`, `${e.name} 冒出了爱心`] } };
    }
    return { ok: true };
  }
  refuseFeed = new Set<number>();
  dismountToward: Vec3Like | null = null;
  async dismount(signal: AbortSignal, opts: { toward?: Vec3Like } = {}) {
    await sleep(20, signal);
    if (!this.riding) return { ok: false, reason: 'NOT_MOUNTED' };
    this.riding = null; this.ridingId = null;
    this.dismountToward = opts.toward ?? null;
    return { ok: true };
  }
  ridePaths: { x: number; z: number }[][] = [];
  async ride(target: { x: number; z: number }, signal: AbortSignal, opts: { timeoutMs: number; stop?: () => boolean; via?: { x: number; z: number }[]; arriveWithin?: number }) {
    if (!this.riding) return { ok: false, reason: 'NOT_MOUNTED', arrived: false, moved: 0 };
    const start = { ...this.pos };
    const boat = this.riding === 'boat';
    const via = opts.via ?? [];
    this.ridePaths.push([...via, target]);
    let leg = 0;
    for (let i = 0; i < 400; i++) {
      throwIfAborted(signal);
      if (opts.stop?.()) return { ok: true, arrived: false, moved: dist3(start, this.pos) };
      while (leg < via.length && Math.hypot(via[leg].x - this.pos.x, via[leg].z - this.pos.z) <= 1) leg++;
      const goal = leg < via.length ? via[leg] : target;
      const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z, d = Math.hypot(dx, dz);
      if (leg >= via.length && d <= (opts.arriveWithin ?? 2)) return { ok: true, arrived: true, moved: dist3(start, this.pos) };
      const nx = this.pos.x + (dx / d) * Math.min(1, d), nz = this.pos.z + (dz / d) * Math.min(1, d);
      if (boat && this.nameAt(Math.floor(nx), Math.floor(this.pos.y) - 1, Math.floor(nz)) !== 'water') return { ok: true, arrived: false, blocked: true, moved: dist3(start, this.pos) };
      this.pos = { x: nx, y: this.pos.y, z: nz };
      const e = this.entities.find((x) => x.id === this.ridingId);
      if (e) e.pos = { ...this.pos };
      await sleep(5, signal);
    }
    return { ok: false, reason: 'TIMEOUT', arrived: false, moved: dist3(start, this.pos) };
  }
  chat(text: string) {
    this.actions.push(`chat:${text}`);
  }
}

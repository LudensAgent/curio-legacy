import { EventEmitter } from 'node:events';
import type { ActionResult, AgentState, BlockHit, EntityInfo, GameAdapter, MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { dist3, raceAbort, sleep, throwIfAborted } from '../src/util.ts';

/** 离线测试用的模拟游戏：没有 Minecraft 也能验证仲裁、反射、规划与连贯性。 */
export class FakeAdapter extends EventEmitter implements GameAdapter {
  pos: Vec3Like = { x: 0, y: 64, z: 0 };
  hp = 20;
  food = 20;
  connected = true;
  inv = new Map<string, number>();
  blocks: { name: string; pos: Vec3Like }[] = [];
  entities: EntityInfo[] = [];
  speed = 20; // 格/秒（测试加速）
  actions: string[] = [];
  stopAllCount = 0;

  state(): AgentState {
    return {
      connected: this.connected, alive: this.hp > 0, username: 'FakeBot', pos: { ...this.pos }, dim: 'overworld',
      hp: this.hp, food: this.food, oxygen: 20, timeOfDay: 1000, isDay: true, biome: 'plains', onGround: true,
      inWater: false, inLava: false, inventory: [...this.inv].map(([name, count]) => ({ name, count })), emptySlots: 30, held: null,
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
    return this.blocks.find((b) => b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z)?.name ?? 'air';
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
    if (t.kind === 'near' || t.kind === 'reach_block') dest = t.pos;
    else if (t.kind === 'xz') dest = { x: t.x, y: this.pos.y, z: t.z };
    else if (t.kind === 'away_from') dest = { x: this.pos.x + t.distance, y: this.pos.y, z: this.pos.z };
    const d = dist3(dest, this.pos);
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
  async dig(pos: Vec3Like, signal: AbortSignal): Promise<ActionResult> {
    await sleep(100, signal);
    const i = this.blocks.findIndex((b) => b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z);
    if (i < 0) return { ok: false, reason: 'NO_BLOCK' };
    const [b] = this.blocks.splice(i, 1);
    const drop = b.name === 'stone' ? 'cobblestone' : b.name;
    this.inv.set(drop, (this.inv.get(drop) ?? 0) + 1);
    this.actions.push(`dig:${b.name}`);
    return { ok: true };
  }
  async collectNearbyDrops() {
    return 0;
  }
  async craft(item: string, count: number, signal: AbortSignal) {
    await sleep(50, signal);
    this.inv.set(item, (this.inv.get(item) ?? 0) + count);
    this.actions.push(`craft:${item}`);
    return { ok: true, crafted: count };
  }
  hasFood() {
    return (this.inv.get('bread') ?? 0) > 0;
  }
  async eat(signal: AbortSignal) {
    await sleep(100, signal);
    this.food = 20;
    return true;
  }
  async equipWeapon() {}
  async attack(id: number) {
    this.actions.push(`attack:${id}`);
    this.entities = this.entities.filter((e) => e.id !== id);
    return true;
  }
  async look() {}
  async jump(ms: number, signal: AbortSignal) {
    await sleep(ms, signal);
  }
  chat(text: string) {
    this.actions.push(`chat:${text}`);
  }
}

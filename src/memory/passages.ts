import type { Vec3Like } from '../adapter/types.ts';
import type { PassageRecord, WorldMemory } from './store.ts';

/** 一次观察：身体在哪、是在地表还是在地下（看【身体】where 的判断） */
export interface PassageSample {
  worldId: string;
  dim: string;
  pos: Vec3Like;
  /** surface：地表或屋里（头顶见天、能走）；underground：在地下；other：水里、坑里等，既不开始也不结束 */
  place: 'surface' | 'underground' | 'other';
}

export interface DugBlock { pos: Vec3Like; name: string; ts: number }

const flat = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.z - b.z);
const d3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cell = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** 自己挖掉至少这么多格，才算“我挖的通道”（走进天然洞穴不算） */
export const MIN_DUG = 4;
const STEP = 3;
const MAX_POINTS = 160;

/**
 * 跟着身体记通道：进了地下就开始一段，一路记脚下的点和自己挖掉的格子，回到地表就收尾。
 * 走进以前挖过的通道（离它的路线 3 格以内）就接着那一条记，算又用了一次。
 * 只看亲身走过、亲手挖过的；死了被传送、换了世界，就不把两头连起来。
 */
export class PassageTracker {
  private active: { rec: PassageRecord; existing: boolean } | null = null;
  private lastSurface: { pos: Vec3Like; dim: string; worldId: string; ts: number } | null = null;
  private lastPos: { pos: Vec3Like; dim: string; worldId: string } | null = null;

  constructor(private memory: Pick<WorldMemory, 'passages' | 'savePassage'> & Partial<Pick<WorldMemory, 'forgetPassage'>>, private newId: () => string = () => `psg_${Math.random().toString(36).slice(2, 8)}`) {}

  observe(s: PassageSample, dug: DugBlock[], now = Date.now()) {
    const pos = cell(s.pos);
    // 瞬移（死了重生、传送、换维度）：前后两段不能连成一条
    const jumped = !this.lastPos || this.lastPos.dim !== s.dim || this.lastPos.worldId !== s.worldId || d3(this.lastPos.pos, pos) > 24;
    this.lastPos = { pos, dim: s.dim, worldId: s.worldId };
    if (jumped) { this.finish(); this.lastSurface = null; }

    if (s.place === 'surface') {
      this.finish();
      this.lastSurface = { pos, dim: s.dim, worldId: s.worldId, ts: now };
      return;
    }
    if (s.place !== 'underground') {
      // 坑里、水里：不开始也不结束，但手上挖的照样算在这一段里
      if (this.active) this.count(this.active.rec, pos, dug);
      return;
    }

    if (!this.active) {
      const old = this.memory.passages(s.dim).find((p) => p.worldId === s.worldId && p.path.some((q) => d3(q, pos) <= 3));
      if (old) {
        old.uses += 1;
        old.lastUsedAt = now;
        this.active = { rec: old, existing: true };
      } else {
        this.active = { existing: false, rec: { id: this.newId(), worldId: s.worldId, dim: s.dim, entrances: [], path: [pos], deepestY: pos.y, dug: 0, ores: {}, createdAt: now, lastUsedAt: now, uses: 1 } };
      }
      // 刚从地表下来：那个地表点就是入口
      const surf = this.lastSurface;
      if (surf && surf.dim === s.dim && surf.worldId === s.worldId && now - surf.ts < 120_000 && flat(surf.pos, pos) <= 16) this.addEntrance(this.active.rec, surf.pos);
    }
    // 新挖的这一段走着走着接上了以前挖过的通道：并进那一条（多一个入口），不另记
    if (!this.active.existing) {
      const joined = this.memory.passages(s.dim).find((p) => p.worldId === s.worldId && p.id !== this.active!.rec.id && p.path.some((q) => d3(q, pos) <= 3));
      if (joined) {
        const fresh = this.active.rec;
        for (const e of fresh.entrances) this.addEntrance(joined, e);
        for (const q of fresh.path) if (!joined.path.some((o) => d3(o, q) < STEP)) joined.path.push(q);
        joined.dug += fresh.dug;
        for (const [n, c] of Object.entries(fresh.ores)) joined.ores[n] = (joined.ores[n] ?? 0) + c;
        joined.deepestY = Math.min(joined.deepestY, fresh.deepestY);
        joined.uses += 1;
        this.memory.forgetPassage?.(fresh.id);
        this.active = { rec: joined, existing: true };
      }
    }
    const rec = this.active.rec;
    const last = rec.path[rec.path.length - 1];
    if (!last || d3(last, pos) >= STEP) {
      // 走回已经记过的那段路上，不重复记点
      if (!rec.path.some((q) => d3(q, pos) < STEP)) rec.path.push(pos);
      if (rec.path.length > MAX_POINTS) rec.path = rec.path.filter((_, i) => i === 0 || i % 2 === 1 || i === rec.path.length - 1);
    }
    rec.deepestY = Math.min(rec.deepestY, pos.y);
    rec.lastUsedAt = now;
    this.count(rec, pos, dug);
    this.save();
  }

  /** 回到地表、瞬移或者关掉时收尾 */
  finish() {
    if (this.active) this.save();
    this.active = null;
  }

  private count(rec: PassageRecord, pos: Vec3Like, dug: DugBlock[]) {
    for (const b of dug) {
      if (d3(cell(b.pos), pos) > 6) continue;
      rec.dug += 1;
      if (/_ore$|^ancient_debris$/.test(b.name)) rec.ores[b.name] = (rec.ores[b.name] ?? 0) + 1;
    }
  }

  private addEntrance(rec: PassageRecord, p: Vec3Like) {
    if (rec.entrances.some((e) => d3(e, p) <= 4)) return;
    rec.entrances.push(p);
    if (rec.entrances.length > 3) rec.entrances.shift();
  }

  /** 自己挖够了才存（走进天然洞穴不记）；接着以前那条走的，随时存 */
  private save() {
    const a = this.active;
    if (!a) return;
    if (a.existing || a.rec.dug >= MIN_DUG) this.memory.savePassage(a.rec);
  }
}

/** 一条通道里横着推过的层：同一高度（±1）记了至少 4 个点的 */
export function passageLevels(rec: Pick<PassageRecord, 'path'>): number[] {
  const byY = new Map<number, number>();
  for (const p of rec.path) byY.set(p.y, (byY.get(p.y) ?? 0) + 1);
  const levels: number[] = [];
  for (const [y] of [...byY].sort((a, b) => a[0] - b[0])) {
    const n = (byY.get(y - 1) ?? 0) + (byY.get(y) ?? 0) + (byY.get(y + 1) ?? 0);
    if (n >= 4 && !levels.some((l) => Math.abs(l - y) <= 2)) levels.push(y);
  }
  return levels;
}

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import minecraftData from 'minecraft-data';
import type { AgentState, InvItem } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { Project } from './types.ts';

export interface ReservationOwner { worldId: string; projectId: string; revision: number }
export interface MaterialReservation extends ReservationOwner {
  items: InvItem[];
  at: number;
  source: 'observed_inventory';
  sessionId: string;
  observationId: string | number;
}
export interface MaterialAvailability {
  name: string;
  actual: number;
  ownReserved: number;
  protectedForOthers: number;
  available: number;
  reservationShortfall: number;
}
const countItems = (items: InvItem[]) => {
  const totals = new Map<string, number>();
  for (const item of items) if (Number.isFinite(item.count) && item.count > 0) totals.set(item.name, (totals.get(item.name) ?? 0) + Math.floor(item.count));
  return totals;
};
const sameOwner = (a: ReservationOwner, b: ReservationOwner) => a.worldId === b.worldId && a.projectId === b.projectId && a.revision === b.revision;
const aliveProject = (project: Project) => !['completed', 'cancelled'].includes(project.status);

/** A reservation protects current inventory, not hypothetical drops or a stale chest balance. */
export class ReservationLedger {
  private file: string | null;
  private records: MaterialReservation[] = [];
  constructor(directory: string | null) {
    this.file = directory ? path.join(directory, 'material-reservations.json') : null;
    if (this.file && fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.records) || saved.records.length > 100) throw new Error('不支持的材料预留档案');
      this.records = saved.records;
    }
  }
  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: this.records }, null, 2)); fs.renameSync(temporary, this.file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  list(worldId?: string): MaterialReservation[] { return structuredClone(this.records.filter((r) => !worldId || r.worldId === worldId)); }

  /** Call on project changes and before every reservation query/action: old revisions release immediately. */
  reconcile(projects: Project[]) {
    const valid = this.records.filter((record) => projects.some((p) => p.worldId === record.worldId && p.id === record.projectId && p.revision === record.revision && aliveProject(p)));
    const released = this.records.length - valid.length;
    if (released) { this.records = valid; this.save(); }
    return released;
  }

  private validateOwner(owner: ReservationOwner, state: AgentState, projects: Project[]) {
    if (!state.connected || !state.alive || !state.observationReady || owner.worldId !== state.worldId) throw new Error('预留材料需要同一世界的有效背包观测');
    if (!projects.some((p) => p.id === owner.projectId && p.worldId === owner.worldId && p.revision === owner.revision && aliveProject(p))) throw new Error('预留所有者的项目或修订已经失效');
  }

  reserve(owner: ReservationOwner, items: InvItem[], state: AgentState, projects: Project[]): MaterialReservation {
    this.reconcile(projects);
    this.validateOwner(owner, state, projects);
    if (!Array.isArray(items) || !items.length || items.length > 32 || items.some((i) => !i || !/^[a-z][a-z0-9_]{0,63}$/.test(i.name) || !Number.isInteger(i.count) || i.count < 1 || i.count > 2304) || new Set(items.map((i) => i.name)).size !== items.length) throw new Error('预留需要 1–32 种不重复的具体物品，每种 1–2304 个');
    const availability = new Map(this.query(state, owner).map((a) => [a.name, a]));
    for (const item of items) if ((availability.get(item.name)?.available ?? 0) < item.count) throw new Error(`MISSING_UNRESERVED_MATERIALS:${item.name} 请求 ${item.count}，当前未被其他项目占用的实际背包仅 ${availability.get(item.name)?.available ?? 0}`);
    const existing = this.records.findIndex((r) => sameOwner(r, owner));
    if (existing < 0 && this.records.length >= 100) throw new Error('材料预留所有者已达到 100 个');
    const record: MaterialReservation = { ...owner, items: structuredClone(items), at: Date.now(), source: 'observed_inventory', sessionId: state.sessionId, observationId: state.observationId };
    // Each reserve call sets the owner's full allocation; omitted old items are explicitly released.
    if (existing >= 0) this.records[existing] = record; else this.records.push(record);
    this.save();
    return structuredClone(record);
  }

  release(owner: ReservationOwner, names?: string[]): number {
    let released = 0;
    this.records = this.records.flatMap((record) => {
      if (!sameOwner(record, owner)) return [record];
      const items = names ? record.items.filter((item) => !names.includes(item.name)) : [];
      released += record.items.length - items.length;
      return items.length ? [{ ...record, items }] : [];
    });
    if (released) this.save();
    return released;
  }

  protectedItems(worldId: string, owner?: ReservationOwner): InvItem[] {
    const totals = countItems(this.records.filter((r) => r.worldId === worldId && (!owner || !sameOwner(r, owner))).flatMap((r) => r.items));
    return [...totals].map(([name, count]) => ({ name, count }));
  }

  query(state: AgentState, owner?: ReservationOwner): MaterialAvailability[] {
    if (!state.connected || !state.alive || !state.observationReady) throw new Error('未知背包不能计算可用物资');
    if (owner && owner.worldId !== state.worldId) throw new Error('不能把另一世界的预留与当前背包合并');
    const actual = countItems(state.inventory), others = countItems(this.protectedItems(state.worldId, owner));
    const own = countItems(this.records.filter((r) => owner && sameOwner(r, owner)).flatMap((r) => r.items));
    return [...new Set([...actual.keys(), ...others.keys(), ...own.keys()])].sort().map((name) => ({
      name, actual: actual.get(name) ?? 0, ownReserved: own.get(name) ?? 0, protectedForOthers: others.get(name) ?? 0,
      available: Math.max(0, (actual.get(name) ?? 0) - (others.get(name) ?? 0)),
      reservationShortfall: Math.max(0, (others.get(name) ?? 0) + (own.get(name) ?? 0) - (actual.get(name) ?? 0)),
    }));
  }
}

const ledgers = new WeakMap<WorldMemory, ReservationLedger>();
export function reservationsFor(memory: WorldMemory): ReservationLedger {
  let ledger = ledgers.get(memory);
  if (!ledger) { ledger = new ReservationLedger(memory.dataDirectory); ledgers.set(memory, ledger); }
  return ledger;
}

export function currentReservationOwner(memory: WorldMemory, state: AgentState): ReservationOwner | undefined {
  const project = memory.activeProject();
  return project && project.worldId === state.worldId && aliveProject(project) ? { worldId: state.worldId, projectId: project.id, revision: project.revision } : undefined;
}

export function availableInventoryFor(memory: WorldMemory, state: AgentState): InvItem[] {
  const ledger = reservationsFor(memory);
  ledger.reconcile(memory.projects());
  return ledger.query(state, currentReservationOwner(memory, state)).map((a) => ({ name: a.name, count: a.available })).filter((i) => i.count > 0);
}

/** Conservative preflight covering every recipe choice and the adapter's two auto-craft layers.
 * It can reject a safe alternative, but never approves spending a protected stack on an unproven route.
 */
export function craftReservationConflict(memory: WorldMemory, state: AgentState, item: string, count: number, version: string, tableAlreadyAvailable = false): { item: string; protected: number; actual: number; maximumConsumption: number; reason: string } | null {
  const ledger = reservationsFor(memory);
  ledger.reconcile(memory.projects());
  const owner = currentReservationOwner(memory, state), protectedItems = ledger.protectedItems(state.worldId, owner);
  if (!protectedItems.length) return null;
  const data = minecraftData(version);
  if (!data?.itemsByName[item]) return { item, protected: 0, actual: 0, maximumConsumption: 0, reason: '无法证明该版本合成不会消耗其他项目的预留' };
  let nodes = 0;
  const merge = (target: Map<string, number>, source: Map<string, number>, maximum = false) => { for (const [name, quantity] of source) target.set(name, maximum ? Math.max(target.get(name) ?? 0, quantity) : (target.get(name) ?? 0) + quantity); };
  const expand = (name: string, quantity: number, depth: number, visited: string[]): Map<string, number> => {
    const worst = new Map<string, number>();
    if (++nodes > 10000) throw new Error('合成预留分析达到预算');
    if (depth < 0 || visited.includes(name)) return worst;
    const id = data.itemsByName[name]?.id;
    for (const raw of id === undefined ? [] : data.recipes[id] ?? []) {
      const recipe = raw as any, batch = Math.ceil(quantity / Number(recipe.result?.count ?? 1));
      const direct = new Map<string, number>();
      for (const ingredient of recipe.inShape ? recipe.inShape.flat() : recipe.ingredients ?? []) {
        const ingredientId = typeof ingredient === 'number' ? ingredient : ingredient?.id;
        if (ingredientId === undefined || ingredientId === null || ingredientId < 0) continue;
        const ingredientName = data.items[ingredientId]?.name;
        if (ingredientName) direct.set(ingredientName, (direct.get(ingredientName) ?? 0) + Number(ingredient?.count ?? 1) * batch);
      }
      const route = new Map(direct);
      for (const [ingredient, amount] of direct) merge(route, expand(ingredient, amount, depth - 1, [...visited, name]));
      merge(worst, route, true);
    }
    return worst;
  };
  try {
    const worst = expand(item, count, 2, []);
    const recipes = data.recipes[data.itemsByName[item].id] ?? [];
    const mayNeedTable = recipes.some((raw: any) => raw.inShape ? raw.inShape.length > 2 || raw.inShape.some((row: unknown[]) => row.length > 2) : (raw.ingredients?.length ?? 0) > 4);
    if (mayNeedTable && !tableAlreadyAvailable) { worst.set('crafting_table', (worst.get('crafting_table') ?? 0) + 1); merge(worst, expand('crafting_table', 1, 2, [])); }
    const actual = countItems(state.inventory);
    for (const protectedItem of protectedItems) {
      const maximumConsumption = worst.get(protectedItem.name) ?? 0, held = actual.get(protectedItem.name) ?? 0;
      if (maximumConsumption > Math.max(0, held - protectedItem.count)) return { item: protectedItem.name, protected: protectedItem.count, actual: held, maximumConsumption, reason: '无法证明所有合成与自动前置材料路径都保留其他项目的预留；请先明确调整预留或方法' };
    }
    return null;
  } catch (error) { return { item, protected: 0, actual: 0, maximumConsumption: 0, reason: (error as Error).message }; }
}

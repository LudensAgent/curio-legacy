import minecraftData from 'minecraft-data';
import type { InvItem } from '../adapter/types.ts';
// Pure acquisition knowledge, independent of optional economy skills.
export const SMELTABLE: Record<string, string> = {
  raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
  sand: 'glass', red_sand: 'glass', cobblestone: 'stone', clay_ball: 'brick', kelp: 'dried_kelp', cactus: 'green_dye',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato',
  oak_log: 'charcoal', birch_log: 'charcoal', spruce_log: 'charcoal', jungle_log: 'charcoal', acacia_log: 'charcoal',
  dark_oak_log: 'charcoal', mangrove_log: 'charcoal', cherry_log: 'charcoal',
};

export interface MaterialRequirement { item: string; required: number; available: number; reserved: number; missing: number }
export interface AcquisitionMethod {
  kind: 'craft' | 'smelt' | 'gather';
  skill: string;
  outputCount: number;
  batches: number;
  inputs: MaterialRequirement[];
  facility?: string;
  fuelRequired?: boolean;
  tools?: string[];
  block?: string;
  availability: 'knowledge_only';
}

/** Version-matched mechanics and recipes. It cannot discover resource coordinates or dispatch tasks. */
export class ResourceKnowledge {
  private data: ReturnType<typeof minecraftData>;
  constructor(readonly version: string) { this.data = minecraftData(version); if (!this.data) throw new Error(`未知 Minecraft 版本: ${version}`); }

  query(item: string, count = 1, inventory: InvItem[] = [], reservations: InvItem[] = []) {
    if (!this.data.itemsByName[item]) throw new Error(`未知具体物品: ${item}`);
    if (!Number.isInteger(count) || count < 1 || count > 2304) throw new Error('查询数量须为 1–2304 的整数');
    const total = (items: InvItem[], name: string) => items.filter((i) => i.name === name).reduce((sum, i) => sum + (Number.isFinite(i.count) && i.count > 0 ? i.count : 0), 0);
    const requirement = (name: string, required: number): MaterialRequirement => {
      const reserved = total(reservations, name), available = Math.max(0, total(inventory, name) - reserved);
      return { item: name, required, available, reserved, missing: Math.max(0, required - available) };
    };
    const target = requirement(item, count);
    const itemId = this.data.itemsByName[item].id;
    const methods: AcquisitionMethod[] = [];
    for (const recipe of this.data.recipes[itemId] ?? []) {
      const raw = recipe as any;
      const outputCount = Number(raw.result?.count ?? 1);
      const batches = Math.ceil(target.missing / outputCount);
      const ingredients: any[] = raw.inShape ? raw.inShape.flat() : raw.ingredients ?? [];
      const totals = new Map<string, number>();
      for (const ingredient of ingredients) {
        const id = typeof ingredient === 'number' ? ingredient : ingredient?.id;
        if (id == null || id < 0) continue;
        const name = this.data.items[id]?.name;
        if (name) totals.set(name, (totals.get(name) ?? 0) + (ingredient?.count ?? 1) * batches);
      }
      const table = raw.inShape ? raw.inShape.length > 2 || raw.inShape.some((row: unknown[]) => row.length > 2) : ingredients.length > 4;
      methods.push({ kind: 'craft', skill: 'craft', outputCount, batches, inputs: [...totals].map(([name, required]) => requirement(name, required)), ...(table ? { facility: 'crafting_table' } : {}), availability: 'knowledge_only' });
    }
    for (const [input, output] of Object.entries(SMELTABLE)) {
      if (output === item && this.data.itemsByName[input]) methods.push({ kind: 'smelt', skill: 'smelt', outputCount: 1, batches: target.missing, inputs: [requirement(input, target.missing)], facility: 'furnace', fuelRequired: true, availability: 'knowledge_only' });
    }
    for (const block of this.data.blocksArray) {
      if (!(block.drops ?? []).some((drop: any) => (typeof drop === 'number' ? drop : drop?.id ?? drop?.drop) === itemId)) continue;
      const tools = Object.keys(block.harvestTools ?? {}).map((id) => this.data.items[Number(id)]?.name).filter((name): name is string => !!name);
      methods.push({ kind: 'gather', skill: 'gather', outputCount: 1, batches: target.missing, inputs: [], block: block.name, ...(tools.length ? { tools } : {}), availability: 'knowledge_only' });
      if (methods.filter((m) => m.kind === 'gather').length >= 8) break;
    }
    return { item, target, source: `minecraft-data:${this.version}`, methods: methods.slice(0, 24), locations: 'unknown' as const, note: 'Mechanics only. Recipe outputs, drops and storage are not current inventory; locate resources through observation and verify action results.' };
  }
}

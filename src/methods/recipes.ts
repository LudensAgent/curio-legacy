import minecraftData from 'minecraft-data';
import type { InvItem } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import { ResourceKnowledge } from './knowledge.ts';
import { describePlan, materialPlan } from './shortfall.ts';

/**
 * 配方记忆：像原版配方书一样，拿到过（进过背包）其中一种材料或成品，才“知道”这个配方。
 * LLM 分两级按需查询，不把配方表整个塞进上下文：
 *   1) {kind:"recipes", category:"transport"} → 这一类里已知的配方（变体合并）、现在材料够不够、大致需要什么；未解锁的只给数量
 *   2) {kind:"recipes", item:"oak_boat"} → 具体配方、还缺什么、缺的东西从哪来
 */

export const RECIPE_CATEGORIES: Record<string, { zh: string; test: RegExp }> = {
  tools: { zh: '工具', test: /_(pickaxe|axe|shovel|hoe)$|^(shears|flint_and_steel|fishing_rod|compass|recovery_compass|clock|spyglass|brush|lead|name_tag)$/ },
  weapons: { zh: '武器', test: /_sword$|^(bow|crossbow|arrow|spectral_arrow|tipped_arrow|shield)$/ },
  armor: { zh: '盔甲', test: /_(helmet|chestplate|leggings|boots)$|^turtle_helmet$/ },
  transport: { zh: '交通', test: /_boat$|_raft$|_chest_boat$|_chest_raft$|minecart$|rail$|^carrot_on_a_stick$|^warped_fungus_on_a_stick$/ },
  food: { zh: '食物', test: /^(bread|cake|cookie|pumpkin_pie|mushroom_stew|beetroot_soup|rabbit_stew|suspicious_stew|golden_apple|golden_carrot|honey_bottle|sugar|dried_kelp|cooked_.*|baked_potato)$/ },
  light: { zh: '照明', test: /torch$|lantern$|campfire$|^(jack_o_lantern|glowstone|sea_lantern|candle|.*_candle|end_rod|redstone_lamp)$/ },
  workstations: { zh: '工作台/功能方块', test: /^(crafting_table|furnace|smoker|blast_furnace|anvil|grindstone|stonecutter|loom|cartography_table|fletching_table|smithing_table|enchanting_table|brewing_stand|cauldron|composter|lectern|bell|beacon|conduit|respawn_anchor|lodestone|jukebox)$/ },
  storage: { zh: '储物/容器', test: /^(chest|trapped_chest|barrel|ender_chest|shulker_box|bundle|bucket|bowl|glass_bottle|flower_pot|item_frame|glow_item_frame|armor_stand)$|_bed$/ },
  building: { zh: '建筑方块', test: /_(planks|slab|stairs|wall|fence|fence_gate|door|trapdoor|bricks|tiles|pillar|block)$|^(ladder|scaffolding|glass|glass_pane|.*_glass|.*_glass_pane|bricks|stone_bricks|chiseled_.*|polished_.*|cut_.*|smooth_.*|terracotta|.*_terracotta|.*_concrete_powder|.*_wool|.*_carpet|bookshelf|iron_bars|chain|hay_block)$/ },
  redstone: { zh: '红石', test: /^(redstone_.*|repeater|comparator|piston|sticky_piston|observer|hopper|dispenser|dropper|lever|.*_button|.*_pressure_plate|tripwire_hook|daylight_detector|target|note_block|tnt|crafter|sculk_sensor|calibrated_sculk_sensor|lightning_rod)$/ },
  materials: { zh: '材料/中间品', test: /^(stick|.*_ingot|.*_nugget|paper|book|string|leather|.*_dye|bone_meal|blaze_powder|magma_cream|fermented_spider_eye|gunpowder|slime_ball|clay_ball|brick|nether_brick|charcoal|coal|diamond|emerald|lapis_lazuli|quartz|amethyst_shard|netherite_scrap|copper_ingot|iron_ingot|gold_ingot|wheat|melon_seeds|pumpkin_seeds|.*_banner_pattern)$/ },
};

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped'];
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
/** oak_boat → {group:"*木_boat", variant:"oak"}；white_bed → {group:"*色_bed"} */
function variantGroup(item: string): string {
  for (const w of WOODS) if (item.startsWith(w + '_')) return `<木>_${item.slice(w.length + 1)}`;
  for (const c of COLORS) if (item.startsWith(c + '_')) return `<色>_${item.slice(c.length + 1)}`;
  return item;
}

export function categoryOf(item: string): string {
  for (const [k, v] of Object.entries(RECIPE_CATEGORIES)) if (v.test.test(item)) return k;
  return 'misc';
}

interface RecipeEntry { item: string; inputs: string[]; table: boolean }

export class RecipeBook {
  private data: ReturnType<typeof minecraftData>;
  private knowledge: ResourceKnowledge;
  private entries: RecipeEntry[] = [];
  /** 材料 → 用到它的配方成品 */
  private usedIn = new Map<string, Set<string>>();

  constructor(version: string, private memory: WorldMemory) {
    this.data = minecraftData(version);
    this.knowledge = new ResourceKnowledge(version);
    for (const [id, recipes] of Object.entries(this.data.recipes ?? {})) {
      const item = this.data.items[Number(id)]?.name;
      if (!item) continue;
      const inputs = new Set<string>();
      let table = false;
      for (const raw of recipes as any[]) {
        const ingredients: any[] = raw.inShape ? raw.inShape.flat() : raw.ingredients ?? [];
        for (const ing of ingredients) {
          const iid = typeof ing === 'number' ? ing : ing?.id;
          const n = iid == null || iid < 0 ? undefined : this.data.items[iid]?.name;
          if (n) inputs.add(n);
        }
        table ||= raw.inShape ? raw.inShape.length > 2 || raw.inShape.some((r: unknown[]) => r.length > 2) : ingredients.length > 4;
      }
      this.entries.push({ item, inputs: [...inputs], table });
      for (const n of inputs) (this.usedIn.get(n) ?? this.usedIn.set(n, new Set()).get(n)!).add(item);
    }
  }

  /** 拿到过其中一种材料或成品 → 知道这个配方（原版配方书的解锁规则） */
  private known(e: RecipeEntry, held: Set<string>) {
    return held.has(e.item) || e.inputs.some((n) => held.has(n));
  }

  /** 新拿到一个物品时，它解锁了哪些配方（给事件流看，像原版右上角的配方提示） */
  unlockedBy(item: string, heldBefore: Set<string>): string[] {
    const out = new Set<string>();
    for (const r of this.usedIn.get(item) ?? []) {
      const e = this.entries.find((x) => x.item === r);
      if (e && !this.known(e, heldBefore)) out.add(variantGroup(r));
    }
    return [...out].slice(0, 8);
  }

  query(raw: { category?: unknown; item?: unknown; count?: unknown }, inventory: InvItem[]): unknown {
    const held = this.memory.heldItems();
    for (const i of inventory) held.add(i.name);
    const have = (n: string) => inventory.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
    if (typeof raw.item === 'string' && raw.item.trim()) {
      const item = raw.item.trim().replace(/^minecraft:/, '');
      const e = this.entries.find((x) => x.item === item);
      if (!this.data.itemsByName[item]) return { item, error: '没有这个物品' };
      if (e && !this.known(e, held)) return { item, known: false, note: '还不知道怎么做：还没拿到过它的任何材料。去探索、收集新东西后可能会想起来' };
      const count = Number.isInteger(raw.count) ? Math.max(1, Math.min(64, raw.count as number)) : 1;
      const q = this.knowledge.query(item, count, inventory);
      const craft = q.methods.filter((m) => m.kind === 'craft').slice(0, 2).map((m) => ({
        needs: m.inputs.map((x) => ({ item: x.item, need: x.required, have: x.available, missing: x.missing })),
        ...(m.facility ? { facility: m.facility, facility_nearby_or_held: have('crafting_table') > 0 ? 'held' : 'unknown' } : {}),
        makes: m.outputCount,
      }));
      const smelt = q.methods.filter((m) => m.kind === 'smelt').slice(0, 2).map((m) => ({ from: m.inputs[0]?.item, facility: 'furnace' }));
      const gather = q.methods.filter((m) => m.kind === 'gather').slice(0, 3).map((m) => ({ block: m.block, ...(m.tools ? { tools: m.tools.slice(0, 3) } : {}) }));
      // 缺的材料从哪来（再往下看一层，只看已知的做法）
      const missing = craft[0]?.needs.filter((n) => n.missing > 0) ?? [];
      const sources = missing.slice(0, 4).map((n) => {
        const sub = this.entries.find((x) => x.item === n.item);
        const subQ = this.knowledge.query(n.item, n.missing, inventory);
        return {
          item: n.item,
          ...(sub && this.known(sub, held) ? { craft_from: [...new Set(subQ.methods.filter((m) => m.kind === 'craft').flatMap((m) => m.inputs.map((x) => x.item)))].slice(0, 4) } : {}),
          ...(subQ.methods.some((m) => m.kind === 'smelt') ? { smelt_from: subQ.methods.find((m) => m.kind === 'smelt')!.inputs[0]?.item } : {}),
          ...(subQ.methods.some((m) => m.kind === 'gather') ? { gather_from: subQ.methods.filter((m) => m.kind === 'gather').slice(0, 2).map((m) => m.block) } : {}),
        };
      });
      // 整笔账：拿背包抵扣后，还要去采哪些原材料、要先做哪些中间品
      const plan = materialPlan(item, count, inventory, this.knowledge);
      const account = { summary: describePlan(plan), raw_needed: plan.raw.map((r) => ({ item: r.item, count: r.count, from: r.from.slice(0, 3) })),
        ...(plan.crafts.length > 1 ? { make_first: plan.crafts.slice(0, -1) } : {}), ...(plan.smelts.length ? { smelt_first: plan.smelts } : {}) };
      return { item, count, known: true, account, ...(craft.length ? { craft } : {}), ...(smelt.length ? { smelt } : {}), ...(gather.length ? { gather } : {}),
        ...(sources.length ? { missing_from: sources } : {}), craftable_now: craft.some((c) => c.needs.every((n) => n.missing === 0)) };
    }
    const category = typeof raw.category === 'string' ? raw.category.trim().toLowerCase() : '';
    if (!category || (category !== 'misc' && !RECIPE_CATEGORIES[category])) {
      return { categories: [...Object.entries(RECIPE_CATEGORIES).map(([k, v]) => k + `(${v.zh})`), 'misc(其他)'] };
    }
    const groups = new Map<string, { example: string; inputs: Set<string>; ready: boolean; table: boolean }>();
    let locked = 0;
    for (const e of this.entries) {
      if (categoryOf(e.item) !== category) continue;
      if (!this.known(e, held)) { locked++; continue; }
      const g = variantGroup(e.item);
      const ready = e.inputs.length > 0 && e.inputs.every((n) => have(n) > 0);
      const cur = groups.get(g);
      if (!cur) groups.set(g, { example: e.item, inputs: new Set(e.inputs.map(variantGroup)), ready, table: e.table });
      else { cur.ready ||= ready; if (ready) cur.example = e.item; }
    }
    const list = [...groups.entries()].sort((a, b) => Number(b[1].ready) - Number(a[1].ready)).slice(0, 40)
      .map(([g, x]) => ({ item: g === x.example ? x.example : `${g}（例：${x.example}）`, needs: [...x.inputs].slice(0, 5), ...(x.table ? { table: true } : {}), has_materials: x.ready }));
    return { category, known: list, ...(locked ? { locked_count: locked, locked_note: '还有配方没解锁：拿到过它们的材料后才会知道' } : {}),
      note: 'has_materials 只表示每种材料都有一些，数量够不够用 item 查询确认' };
  }
}

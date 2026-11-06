import minecraftData from 'minecraft-data';
import { config } from '../config.ts';
import type { GuiOp, InventorySlot } from '../adapter/types.ts';
import { throwIfAborted } from '../util.ts';
import { findStation } from './stations.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';
import { resolveItemAlias } from './work.ts';

const registry = minecraftData(config.mc.version);

/** 有耐久的工具/武器/护甲才谈得上「合并」；普通方块/材料没有合并配方 */
const isGear = (name: string) => (registry.itemsByName[name]?.maxDurability ?? 0) > 0;

type Station = 'crafting_table' | 'grindstone' | 'anvil';

/** 铁砧会被用坏（chipped/damaged 变种），同名三态都能打开同一个铁砧界面 */
const STATION_KINDS: Record<Station, string[]> = {
  crafting_table: ['crafting_table'],
  grindstone: ['grindstone'],
  anvil: ['anvil', 'chipped_anvil', 'damaged_anvil'],
};
const STATION_ZH: Record<Station, string> = {
  crafting_table: '工作台',
  grindstone: '砂轮',
  anvil: '铁砧',
};
/** 合成修理的奖励：工作台/砂轮是满耐久的 5%，铁砧是 12%（都是整数除法）；加在两件耐久之和上，再封顶到满耐久 */
const REPAIR_BONUS_PCT: Record<Station, number> = { crafting_table: 5, grindstone: 5, anvil: 12 };
/** 界面里玩家背包（背包+快捷栏）的起始槽：背包第 9 槽在对应界面里是第几个槽（指定 sourceSlot 时用） */
const INVENTORY_START: Record<Station, number> = { crafting_table: 10, grindstone: 3, anvil: 3 };

type GearSlot = InventorySlot & { durability: { left: number; max: number } };

export const mergeTools: Skill<{ item: string; station: Station; count: number; allow_loss?: boolean }> = {
  name: 'merge_tools',
  description: '同名同材质装备两两合并：工作台/砂轮 +5% 并移除普通附魔，铁砧 +12% 耗经验；超过满耐久会净丢耐久，默认停手，要腾槽传 allow_loss:true。不造工作站；穿着的先脱',
  argsDoc: '{"item":"装备名","station"?:crafting_table|grindstone|anvil,"count"?:保留件数，默认1,"allow_loss"?:true 允许净丢耐久}',
  timeoutMs: 120000,
  movement: true,
  outcomeBoundary: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const rawName = String(a.item ?? '').trim().replace(/^minecraft:/, '');
    const item = resolveItemAlias(rawName, adapter);
    if (!item) return { ok: false, error: `未知物品：${rawName}（请用完整物品 ID，如 iron_pickaxe）` };
    const stationRaw = String(a.station ?? 'crafting_table').trim().toLowerCase();
    if (!['crafting_table', 'grindstone', 'anvil'].includes(stationRaw)) return { ok: false, error: 'station 必须是 crafting_table / grindstone / anvil' };
    const station = stationRaw as Station;
    const count = clampInt(a.count, 1, 64, 1);
    return { ok: true, args: { item, station, count, allow_loss: a.allow_loss === true } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    if (!adapter.useGui) return fail('ERROR', '当前适配器不支持界面操作');
    if (!adapter.inventorySlots) return fail('ERROR', '当前适配器不能逐槽查看物品，无法在合并前核算耐久');
    const countOf = () => adapter.state().inventory.find((i) => i.name === args.item)?.count ?? 0;
    const cur = countOf();
    const worn = adapter.state().equipment?.filter((e) => e.name === args.item) ?? [];
    if (cur + worn.length < 2) return fail('MISSING_MATERIALS', `${args.item} 不足两件（背包 ${cur} 件、身上 ${worn.length} 件），没有可合并的`);
    if (!isGear(args.item)) return fail('BAD_ARGS', `${args.item} 不是有耐久的工具/武器/护甲，不能合并`);
    // 穿在身上的不能直接放进合成格：先把缺口说清楚，脱不脱由它决定
    if (cur < 2) {
      const slots = [...new Set(worn.map((e) => e.slot))];
      return fail('MISSING_MATERIALS', `${args.item} 有 ${worn.length} 件穿在身上（${slots.join('、')}）、背包里 ${cur} 件：穿着的不能直接放进合成格；先用 hold_item {"item":null,"to":"${slots[0]}"} 脱进背包，再合并`);
    }

    const zh = STATION_ZH[args.station];
    const found = findStation(ctx, STATION_KINDS[args.station], 48);
    if (!found) return fail('NOT_FOUND', `附近看不见也不记得有${zh}；先用 craft 或 plan_route → walk_path 弄到工作台或工作站，再 merge_tools`);
    // 工作站槽位：工作台产物在 0、合成格 1–9；砂轮/铁砧输入 0/1、产物 2
    const resultSlot = args.station === 'crafting_table' ? 0 : 2;
    const putSlots = args.station === 'crafting_table' ? [1, 2] : [0, 1];
    // 背包和快捷栏里的同名装备，按耐久从低到高；界面里的背包槽从 INVENTORY_START 起对应背包第 9 槽
    const gearSlots = (): GearSlot[] => adapter.inventorySlots!()
      .filter((s): s is GearSlot => s.name === args.item && s.slot >= 9 && s.slot <= 44 && !!s.durability)
      .sort((a, b) => a.durability.left - b.durability.left || a.slot - b.slot);
    const totalDurability = () => gearSlots().reduce((n, s) => n + s.durability.left, 0);
    const totalBefore = totalDurability();
    const total = cur - args.count;
    let merged = 0;
    let remaining = cur;
    let stopped: { kind: 'loss' | 'error'; text: string } | undefined;
    try {
      while (remaining > args.count && remaining >= 2) {
        throwIfAborted(signal);
        const [a, b] = gearSlots();
        if (!a || !b) { stopped = { kind: 'error', text: `${args.item} 可合并的两件已经不在背包里` }; break; }
        const max = a.durability.max;
        const sum = a.durability.left + b.durability.left;
        const predicted = Math.min(max, sum + Math.floor(max * REPAIR_BONUS_PCT[args.station] / 100));
        const loss = sum - predicted;
        // 两件之和超过满耐久：合并会把多出的耐久丢掉，只换来一个空槽。是否要这个交易由 agent 决定
        if (loss > 0 && !args.allow_loss) {
          stopped = { kind: 'loss', text: `再合会把 ${a.durability.left}/${max} 和 ${b.durability.left}/${max} 压成 ${predicted}/${max}：合计耐久 ${sum} → ${predicted}（净丢 ${loss}），只腾出 1 个槽；要换槽位就传 allow_loss:true` };
          break;
        }
        const invSlot = (s: GearSlot) => INVENTORY_START[args.station] + (s.slot - 9);
        const ops: GuiOp[] = [
          { put: { item: args.item, slot: putSlots[0], sourceSlot: invSlot(a) } },
          { put: { item: args.item, slot: putSlots[1], sourceSlot: invSlot(b) } },
          { take: { slot: resultSlot } },
        ];
        const r = await adapter.useGui(found.pos, ops, signal);
        if (!r.ok) { stopped = { kind: 'error', text: `第 ${merged + 1} 次没成：${r.reason ?? '未知原因'}` }; break; }
        const after = countOf();
        if (after >= remaining) { stopped = { kind: 'error', text: `第 ${merged + 1} 次没生效，${args.item} 把数没减少` }; break; }
        merged++;
        remaining = after;
        ctx.progress(Math.min(1, merged / total), `合并 ${args.item} ${merged}/${total}`);
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `合并出错：${(e as Error).message}`);
    }

    const totalAfter = totalDurability();
    const delta = totalAfter - totalBefore;
    const rest = adapter.state().inventory.find((i) => i.name === args.item);
    const durText = rest?.durabilities?.length ? `，剩余耐久 ${rest.durabilities.join('、')}` : '';
    const enchantNote = args.station === 'anvil' ? '' : '；本次合并会移除普通附魔';
    const accounting = `合计耐久 ${totalBefore} → ${totalAfter}（${delta >= 0 ? '+' : ''}${delta}）`;
    const data = { item: args.item, merged, remaining, durabilityBefore: totalBefore, durabilityAfter: totalAfter, durabilityLost: Math.max(0, -delta) };
    if (merged === 0) {
      if (stopped?.kind === 'loss') return fail('WOULD_WASTE', `没有合并：${stopped.text}`);
      if (stopped) return fail('ERROR', `第一次合并就没成：${stopped.text}`);
      return ok(`${args.item} 现在 ${remaining} 件，已经不超过要保留的 ${args.count} 件，不用合并${durText}`, data);
    }
    if (stopped) {
      const summary = `合并了 ${merged} 次后停下（${stopped.text}），${args.item} 现在还剩 ${remaining} 把${durText}，${accounting}${enchantNote}`;
      return ok(summary, data, stopped.kind === 'loss' ? stopped.text : undefined);
    }
    return ok(`合并了 ${merged} 次，${args.item} 现在还剩 ${remaining} 把${durText}，${accounting}${enchantNote}`, data);
  },
};

/** 把背包和快捷栏里同名可堆叠物品的散叠两两合并到堆叠上限，腾出空槽；不制造、不丢弃任何东西。 */
export const mergeStacks: Skill<{ item?: string }> = {
  name: 'merge_stacks',
  description: '把背包和快捷栏里同名可堆叠物品的散叠两两合并到堆叠上限，腾出空槽；item 可指定只整理这一种（如 cobblestone）。不会制造或丢弃任何东西',
  argsDoc: '{"item"?: "<物品名，只整理这一种；不写整理所有可堆叠物品>"}',
  timeoutMs: 60000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    if (a.item === undefined || a.item === null || a.item === '') return { ok: true, args: {} };
    const item = resolveItemAlias(String(a.item).trim().replace(/^minecraft:/, ''), adapter);
    if (!item) return { ok: false, error: `未知物品：${String(a.item)}` };
    return { ok: true, args: { item } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    if (!adapter.mergeStacks) return fail('ERROR', '当前适配器不支持合并堆叠');
    const r = await adapter.mergeStacks(signal, args.item);
    if (!r.ok) return fail(codeFromError({ message: r.reason }), `合并堆叠没成：${r.reason}`);
    return ok(r.freed > 0
      ? `合并了 ${r.merged} 次，腾出 ${r.freed} 格空槽`
      : `合并了 ${r.merged} 次，没有腾出空槽（散叠本来就不多或已经满叠）`, { merged: r.merged, freed: r.freed });
  },
};

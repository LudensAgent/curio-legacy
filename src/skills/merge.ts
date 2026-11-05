import minecraftData from 'minecraft-data';
import { config } from '../config.ts';
import type { GuiOp } from '../adapter/types.ts';
import { throwIfAborted } from '../util.ts';
import { findStation } from './stations.ts';
import { clampInt, codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';
import { resolveItemAlias } from './work.ts';

const registry = minecraftData(config.mc.version);

/** 有耐久的工具/武器/护甲才谈得上「合并」；普通方块/材料没有合并配方 */
const isGear = (name: string) => (registry.itemsByName[name]?.maxDurability ?? 0) > 0;

/** 铁砧会被用坏（chipped/damaged 变种），同名三态都能打开同一个铁砧界面 */
const STATION_KINDS: Record<'crafting_table' | 'grindstone' | 'anvil', string[]> = {
  crafting_table: ['crafting_table'],
  grindstone: ['grindstone'],
  anvil: ['anvil', 'chipped_anvil', 'damaged_anvil'],
};
const STATION_ZH: Record<'crafting_table' | 'grindstone' | 'anvil', string> = {
  crafting_table: '工作台',
  grindstone: '砂轮',
  anvil: '铁砧',
};

export const mergeTools: Skill<{ item: string; station: 'crafting_table' | 'grindstone' | 'anvil'; count: number }> = {
  name: 'merge_tools',
  description: '把背包里同名同材质的工具/武器/护甲两两合并耐久（相加 +5% 上限满耐久）；默认工作台（免费、移除普通附魔），station 可指定砂轮（返经验、也移除普通附魔）或铁砧（保留附魔、消耗经验）。不制造工作站。穿在身上的那件要先 hold_item 脱进背包',
  argsDoc: '{"item":"<装备名，如 iron_pickaxe、iron_chestplate>","station"?:"crafting_table|grindstone|anvil","count"?:合并后保留几件（默认 1，合并到只剩一件）}',
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
    const station = stationRaw as 'crafting_table' | 'grindstone' | 'anvil';
    const count = clampInt(a.count, 1, 64, 1);
    return { ok: true, args: { item, station, count } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    if (!adapter.useGui) return fail('ERROR', '当前适配器不支持界面操作');
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
    if (!found) return fail('NOT_FOUND', `附近看不见也不记得有${zh}；先用 craft/goto 弄到工作台或工作站，再 merge_tools`);
    // 工作站槽位：工作台产物在 0、合成格 1–9；砂轮/铁砧输入 0/1、产物 2
    const resultSlot = args.station === 'crafting_table' ? 0 : 2;
    const putSlots = args.station === 'crafting_table' ? [1, 2] : [0, 1];
    const total = cur - args.count;
    let merged = 0;
    let remaining = cur;
    try {
      while (remaining > args.count && remaining >= 2) {
        throwIfAborted(signal);
        const ops: GuiOp[] = [...putSlots.map((slot) => ({ put: { item: args.item, slot } })), { take: { slot: resultSlot } }];
        const r = await adapter.useGui(found.pos, ops, signal);
        if (!r.ok) return merged > 0
          ? ok(`合并了 ${merged} 次后停下（第 ${merged + 1} 次没成：${r.reason ?? '未知原因'}，${args.item} 还剩 ${remaining} 把）`, { item: args.item, merged, remaining })
          : fail('ERROR', `第一次合并就没成：${r.reason ?? '未知原因'}`);
        const after = countOf();
        if (after >= remaining) {
          return merged > 0
            ? ok(`合并了 ${merged} 次后停下（第 ${merged + 1} 次没生效，${args.item} 把数没减少）`, { item: args.item, merged, remaining })
            : fail('ERROR', `合并没生效：${args.item} 把数没减少（还是 ${after} 把）`);
        }
        merged++;
        remaining = after;
        ctx.progress(Math.min(1, merged / total), `合并 ${args.item} ${merged}/${total}`);
      }
      const rest = adapter.state().inventory.find((i) => i.name === args.item);
      const durText = rest?.durabilities?.length ? `，剩余耐久 ${rest.durabilities.join('、')}` : '';
      const enchantNote = args.station === 'anvil' ? '' : '；本次合并会移除普通附魔';
      return ok(`合并了 ${merged} 次，${args.item} 现在还剩 ${remaining} 把${durText}${enchantNote}`, { item: args.item, merged, remaining });
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `合并出错：${(e as Error).message}`);
    }
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

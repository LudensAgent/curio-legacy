import type { GameAdapter, Vec3Like } from '../../adapter/types.ts';

const TOOL_KIND: Record<string, string> = { pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', sword: '剑', shears: '剪刀' };

/** 工具名 → 工具类别（shears 是整名，其余按后缀）。 */
const kindOf = (name: string): string | undefined =>
  name === 'shears' ? 'shears' : name.match(/_(pickaxe|axe|shovel|hoe|sword)$/)?.[1];

/**
 * requireTool 拦下时的回执事实：哪一格、要什么工具、手上是什么、背包里没有。
 * 只说明缺口，不替调用方造工具/取工具/换目标。
 */
export function toolRequirementText(adapter: GameAdapter, cell: Vec3Like, block: string): string {
  const kinds = [...new Set((adapter.harvestTools?.(cell) ?? [])
    .map(kindOf)
    .filter((kind): kind is string => kind !== undefined)
    .map((kind) => TOOL_KIND[kind]))];
  const need = kinds.length === 0 ? '合适的工具' : `${kinds.join('/')}类工具`;
  const lack = kinds.length === 0 ? '合适工具' : `${kinds.join('/')}类工具`;
  return `(${Math.floor(cell.x)},${Math.floor(cell.y)},${Math.floor(cell.z)}) 是 ${block}，需要${need}才能采集（空手或不对的工具挖了也不掉）；当前主手是 ${adapter.state().held ?? '空手'}，背包里没有可用的${lack}，未挖`;
}

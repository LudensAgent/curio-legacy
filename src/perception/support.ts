import type { GameAdapter, Vec3Like } from '../adapter/types.ts';

/**
 * 目标方块自身及上下/下方的实际状态，用于交互失败时说明空间缺口。
 * 只列已加载方块；null 写“未加载”，不把未知当成空气或实心。
 * feetY 由调用方给出（身体实测脚高），避免在这里重新取一次完整 state。
 */
export function supportSketch(
  adapter: Pick<GameAdapter, 'blockAt'> & { blockStateAt?: GameAdapter['blockStateAt'] },
  target: Vec3Like,
  feetY?: number,
): { text: string; data: { target: string | null; above: string | null; below: { y: number; name: string | null }[]; otherHalf: { pos: Vec3Like; name: string | null } | null } } {
  const at = (x: number, y: number, z: number) => adapter.blockAt({ x, y, z });
  const name = at(target.x, target.y, target.z);
  const above = at(target.x, target.y + 1, target.z);
  const below = [1, 2, 3].map((d) => ({ y: target.y - d, name: at(target.x, target.y - d, target.z) }));
  // 床这类成对方块：另一格的上方/下方同样决定能不能用，别只看请求的那一格。
  // part 可用时只认 part 不同的同种床；属性拿不到时如实写“相邻同名床”，不硬称另一半。
  const targetPart = adapter.blockStateAt?.(target)?.properties?.part;
  const neighbor = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dz]) => ({ x: target.x + dx, y: target.y, z: target.z + dz }))
    .map((pos) => ({ pos, name: at(pos.x, pos.y, pos.z), part: adapter.blockStateAt?.(pos)?.properties?.part }))
    .find((n) => n.name !== null && n.name === name && /_bed$/.test(n.name ?? '') && (targetPart === undefined || n.part === undefined || n.part !== targetPart)) ?? null;
  const label = (n: string | null) => n ?? '未加载';
  const parts = [
    `目标 ${label(name)} @(${target.x},${target.y},${target.z})`,
    ...(feetY === undefined ? [] : [`身体脚高 y=${feetY.toFixed(2)}`]),
    `上方 y${target.y + 1}=${label(above)}`,
    `下方 ${below.map((b) => `y${b.y}=${label(b.name)}`).join('、')}`,
  ];
  if (neighbor) {
    const pair = targetPart !== undefined && neighbor.part !== undefined && targetPart !== neighbor.part ? '另一半' : '相邻同名床';
    const otherAbove = label(at(neighbor.pos.x, neighbor.pos.y + 1, neighbor.pos.z));
    const otherBelow = [1, 2, 3].map((d) => `y${neighbor.pos.y - d}=${label(at(neighbor.pos.x, neighbor.pos.y - d, neighbor.pos.z))}`).join('、');
    parts.push(`${pair} ${label(neighbor.name)} @(${neighbor.pos.x},${neighbor.pos.y},${neighbor.pos.z})，上方 y${neighbor.pos.y + 1}=${otherAbove}，下方 ${otherBelow}`);
  }
  return { text: parts.join('；'), data: { target: name, above, below, otherHalf: neighbor && { pos: neighbor.pos, name: neighbor.name } } };
}

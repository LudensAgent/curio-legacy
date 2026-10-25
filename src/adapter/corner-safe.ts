/**
 * 斜着走不切角：Mineflayer Pathfinder 的斜向一步只要求左右两侧“有一侧”能过就行，
 * 可人的碰撞箱有 0.6 格宽，贴着另一侧那格实心方块斜着走，身体会被方块角卡住，在脚边的方块旁原地蹭。
 * 这里把斜向一步改成两侧（脚和头的高度）都空着才允许；否则走两步直角，慢一点但不会卡。
 */
export function cornerSafe(movements: any): any {
  if (!movements || movements.__cornerSafe || typeof movements.getMoveDiagonal !== 'function') return movements;
  const original = movements.getMoveDiagonal;
  movements.getMoveDiagonal = function (node: any, dir: any, neighbors: any[]) {
    const landing = this.getBlock(node, dir.x, 0, dir.z);
    const y = landing?.physical ? 1 : 0;
    const clear = (dx: number, dz: number) => [y, y + 1].every((dy) => { const b = this.getBlock(node, dx, dy, dz); return !!b && !b.physical; })
      // 往上跳一格时起跳那一刻身体还在原高度：两侧脚边那格也要空
      && (y === 0 || (() => { const b = this.getBlock(node, dx, 0, dz); return !!b && !b.physical; })());
    if (!clear(0, dir.z) || !clear(dir.x, 0)) return;
    return original.call(this, node, dir, neighbors);
  };
  Object.defineProperty(movements, '__cornerSafe', { value: true, enumerable: true });
  return movements;
}

/** Pathfinder 想太久（"Took to long to decide path to goal!"）也是没找到路，不是程序错误 */
export const PATH_TOO_LONG = /took to+ long to decide path/i;

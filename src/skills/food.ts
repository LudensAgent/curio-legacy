/**
 * 食物的实际价值（原版 1.20 的数值：吃一块回多少饥饿值、给多少饱和度）。
 * 只是事实，不是规则：让它吃的时候、看背包的时候都看得到“生的值多少、烤熟了值多少”，自己判断划不划算。
 */
export const FOOD_VALUE: Record<string, { points: number; saturation: number }> = {
  beef: { points: 3, saturation: 1.8 }, cooked_beef: { points: 8, saturation: 12.8 },
  porkchop: { points: 3, saturation: 1.8 }, cooked_porkchop: { points: 8, saturation: 12.8 },
  mutton: { points: 2, saturation: 1.2 }, cooked_mutton: { points: 6, saturation: 9.6 },
  chicken: { points: 2, saturation: 1.2 }, cooked_chicken: { points: 6, saturation: 7.2 },
  rabbit: { points: 3, saturation: 1.8 }, cooked_rabbit: { points: 5, saturation: 6 },
  cod: { points: 2, saturation: 0.4 }, cooked_cod: { points: 5, saturation: 6 },
  salmon: { points: 2, saturation: 0.4 }, cooked_salmon: { points: 6, saturation: 9.6 },
  potato: { points: 1, saturation: 0.6 }, baked_potato: { points: 5, saturation: 6 },
  apple: { points: 4, saturation: 2.4 }, bread: { points: 5, saturation: 6 }, carrot: { points: 3, saturation: 3.6 },
  sweet_berries: { points: 2, saturation: 0.4 }, glow_berries: { points: 2, saturation: 0.4 }, melon_slice: { points: 2, saturation: 1.2 },
  beetroot: { points: 1, saturation: 1.2 }, dried_kelp: { points: 1, saturation: 0.6 }, cookie: { points: 2, saturation: 0.4 },
  pumpkin_pie: { points: 8, saturation: 4.8 }, mushroom_stew: { points: 6, saturation: 7.2 }, golden_carrot: { points: 6, saturation: 14.4 },
  golden_apple: { points: 4, saturation: 9.6 }, rotten_flesh: { points: 4, saturation: 0.8 },
};
/** 生的放进熔炉会变成什么 */
export const COOKED: Record<string, string> = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit',
  cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', kelp: 'dried_kelp',
};
/** 一句话说清一种食物值多少（有烤熟版的顺带说烤熟后值多少） */
export function foodNote(name: string): string | null {
  const v = FOOD_VALUE[name];
  if (!v) return null;
  const cooked = COOKED[name], c = cooked ? FOOD_VALUE[cooked] : null;
  return `+${v.points} 饥饿、饱和 ${v.saturation}${c ? `；烤熟成 ${cooked} 是 +${c.points}、饱和 ${c.saturation}` : ''}${name === 'rotten_flesh' ? '；有八成可能让人更饿' : ''}`;
}

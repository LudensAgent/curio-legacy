/**
 * 矿石按高度怎么分布：这是游戏版本决定的事实（1.18 “洞穴与山崖”之后整个改了，模型训练语料里大量是旧版的
 * “钻石在 y5–12”），不是行为规则。只在它打算下矿时摆出来当参考，下到哪层、挖什么由它自己定。
 * 使用生成分布的范围与偏向，不把世界采样峰值当作生成参数；详文由知识库主动查询。
 * 来源：https://minecraft.wiki/w/Ore_(feature)、https://minecraft.wiki/w/Java_Edition_1.18
 */
export interface OreLayer { kind: string; zh: string; words: RegExp; text: string }

const LAYERS_1_18: OreLayer[] = [
  { kind: 'diamond', zh: '钻石', words: /钻石|钻|diamond/i, text: '钻石 y-64~16，生成分布整体越低越多；部分生成尝试会跳过暴露于空气的位置，实际寻找效率还取决于地形与通路' },
  { kind: 'iron', zh: '铁', words: /铁|iron/i, text: '铁地下分布 y-64~72，其中一批偏向 y16；山地 y80 以上另有一批，偏向 y232，仍须实际存在岩石' },
  { kind: 'redstone', zh: '红石', words: /红石|redstone/i, text: '红石 y-64~15，y-32 以下有一批随深度增加' },
  { kind: 'gold', zh: '金', words: /金矿|挖金|找金|粗金|金锭|gold/i, text: '金的主要生成分布偏向 y-16，y-48 以下还有额外生成；恶地另有高处金矿' },
  { kind: 'lapis', zh: '青金石', words: /青金|lapis/i, text: '青金石 y-64~64（最多在 y0 附近）' },
  { kind: 'copper', zh: '铜', words: /铜|copper/i, text: '铜 y-16~112，生成分布偏向 y48，溶洞矿团较大' },
  { kind: 'coal', zh: '煤', words: /煤|coal/i, text: '煤主要在 y0 以上，一批偏向 y96，另有高处生成；下到深层不保证能补煤' },
  { kind: 'emerald', zh: '绿宝石', words: /绿宝石|emerald/i, text: '绿宝石只在山地生物群系，y-16 以上' },
];

function atLeast(version: string, major: number, minor: number): boolean {
  const m = version.match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a > major || (a === major && b >= minor);
}

/**
 * 这个版本里的矿层事实。intent 里提到了哪种矿就只给那几种；只说“找矿/下矿”没点名就全给。
 * 不认识的版本（1.18 以前）不给——宁可不说，也不说错。
 */
export function oreLayerFacts(version: string, intent = ''): string | null {
  if (!atLeast(version, 1, 18)) return null;
  const named = LAYERS_1_18.filter((l) => l.words.test(intent));
  const list = named.length ? named : LAYERS_1_18;
  return `这个世界是 ${version}（1.18 之后的基础矿层参考；y 可以是负数，主世界底界 y-64，y0 以下以深板岩为主；生成偏向不保证眼前有矿）：${list.map((l) => l.text).join('；')}`;
}

/**
 * 矿石按高度怎么分布：这是游戏版本决定的事实（1.18 “洞穴与山崖”之后整个改了，模型训练语料里大量是旧版的
 * “钻石在 y5–12”），不是行为规则。只在它打算下矿时摆出来当参考，下到哪层、挖什么由它自己定。
 * 数字取自 Minecraft Wiki 的 Java 版 1.18+ 分布表。
 */
export interface OreLayer { kind: string; zh: string; words: RegExp; text: string }

const LAYERS_1_18: OreLayer[] = [
  { kind: 'diamond', zh: '钻石', words: /钻石|钻|diamond/i, text: '钻石 y-64~16，越深越多，最多在 y-59 附近；暴露在空气里的会少一半，洞穴里不如平推巷道找' },
  { kind: 'iron', zh: '铁', words: /铁|iron/i, text: '铁 y-64~72（最多在 y14 附近）；山地 y80 以上还有一批，越高越多' },
  { kind: 'redstone', zh: '红石', words: /红石|redstone/i, text: '红石 y-64~15，越深越多，最多在 y-59 附近' },
  { kind: 'gold', zh: '金', words: /金矿|挖金|找金|粗金|金锭|gold/i, text: '金 y-64~32（最多在 y-18 附近）；恶地地表附近也多' },
  { kind: 'lapis', zh: '青金石', words: /青金|lapis/i, text: '青金石 y-64~64（最多在 y0 附近）' },
  { kind: 'copper', zh: '铜', words: /铜|copper/i, text: '铜 y-16~112（最多在 y45 附近），溶洞里成大片' },
  { kind: 'coal', zh: '煤', words: /煤|coal/i, text: '煤 y0~320（最多在 y45 附近），山上露头很多；y0 以下没有' },
  { kind: 'emerald', zh: '绿宝石', words: /绿宝石|emerald/i, text: '绿宝石只在山地生物群系，y-16 以上，一次一块' },
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
  return `这个世界是 ${version}（1.18 之后的矿层分布，和老版本不一样；y 可以是负数，最底是 y-64，y8 以下是深板岩）：${list.map((l) => l.text).join('；')}`;
}

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * 控制台背包用的物品贴图：取 prismarine-viewer 自带的原版贴图（items/、blocks/），按物品名找最像的一张。
 * 方块类物品没有单独的物品图时，用方块的正面/侧面；台阶、楼梯、栅栏这类用它的原料方块。
 * 找不到就返回 null（页面显示文字）。
 */
function texturesRoot(version: string): string | null {
  try {
    const base = path.join(path.dirname(createRequire(import.meta.url).resolve('prismarine-viewer/package.json')), 'public', 'textures');
    if (fs.existsSync(path.join(base, version, 'items'))) return path.join(base, version);
    // 没有完全对应的版本：用最新的一份（贴图几乎不变）
    const versions = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'items')))
      .sort((a, b) => a.split('.').map(Number).reduce((s, n, i) => s || n - (Number(b.split('.')[i]) || 0), 0));
    return versions.length ? path.join(base, versions.at(-1)!) : null;
  } catch { return null; }
}

const WOODS = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)$/;

export function textureCandidates(name: string): string[] {
  const n = name.replace(/^minecraft:/, '').replace(/^waxed_/, '');
  const out = [`items/${n}.png`, `blocks/${n}.png`, ...(n.endsWith('_pane') ? [`blocks/${n.slice(0, -5)}.png`] : []), `blocks/${n}_front.png`, `blocks/${n}_side.png`, `blocks/${n}_top.png`];
  const base = n.match(/^(.*?)_(stairs|slab|wall|fence|fence_gate|pressure_plate|button|door|trapdoor|sign|hanging_sign)$/)?.[1];
  if (base) {
    if (WOODS.test(base)) out.push(`blocks/${base}_planks.png`);
    out.push(`blocks/${base}.png`, `blocks/${base}s.png`, `blocks/${base}_planks.png`);
  }
  const wood = n.match(/^(stripped_)?(.+)_(wood|hyphae)$/);
  if (wood) out.push(`blocks/${wood[1] ?? ''}${wood[2]}_${wood[3] === 'wood' ? 'log' : 'stem'}.png`);
  if (n.endsWith('_bed')) out.push(`items/${n}.png`, 'items/red_bed.png');
  return out;
}

export function itemTextures(version: string) {
  const root = texturesRoot(version);
  const cache = new Map<string, string | null>();
  return {
    available: !!root,
    /** 物品名 → 贴图文件路径（找不到为 null） */
    resolve(name: string): string | null {
      if (!root || !/^[a-z0-9_:]{1,64}$/.test(name)) return null;
      if (cache.has(name)) return cache.get(name)!;
      const hit = textureCandidates(name).map((c) => path.join(root, c)).find((f) => fs.existsSync(f)) ?? null;
      cache.set(name, hit);
      return hit;
    },
  };
}

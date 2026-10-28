import type { Vec3Like } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import { describeRecall } from '../memory/chest-memory.ts';

/** 木头类：缺木板、木棍时，箱子里的原木也算（拿回来就能做） */
const WOODISH = /_(log|wood|stem|hyphae|planks)$/;
const FUEL = /^(coal|charcoal|coal_block)$|_(log|wood|stem|hyphae|planks)$/;

export interface Need { item: string; count: number }

/**
 * 缺的东西，记不记得往哪个箱子放过：记得就说一句“好像放过，去翻翻”，不说数量、不保证还在。
 * 以前这里直接报“(x,y,z) 里有 oak_log×38，拿 3 根”——那是抄清单的记忆，人没有；
 * 人记得的是“我往家里那个箱子放过木头”，剩多少得打开才知道。只在报缺材料时说，不常驻提示词。
 */
export function chestHint(memory: Pick<WorldMemory, 'recallChests'>, state: { dim: string; pos: Vec3Like; worldDay?: number }, needs: Need[], opts: { fuel?: boolean } = {}): string {
  if (!needs.length && !opts.fuel) return '';
  const wants: ((n: string) => boolean)[] = needs.slice(0, 8).map((need) => {
    const wood = /_planks$/.test(need.item) || need.item === 'stick';
    return (n: string) => n === need.item || (wood && WOODISH.test(n));
  });
  if (opts.fuel) wants.push((n) => FUEL.test(n));
  const parts: string[] = [];
  const said = new Set<string>();
  for (const accept of wants) {
    let recalls: ReturnType<WorldMemory['recallChests']>;
    try { recalls = memory.recallChests(accept, { dim: state.dim, day: state.worldDay }); } catch { continue; }
    // 同一样东西记得几个箱子：挑最有把握的；把握差不多就挑近的
    const best = recalls.sort((a, b) => (b.score - a.score) || (dist(a.chest.pos, state.pos) - dist(b.chest.pos, state.pos)))[0];
    if (!best) continue;
    const key = `${best.chest.pos.x},${best.chest.pos.y},${best.chest.pos.z}:${best.item}`;
    if (said.has(key)) continue;
    said.add(key);
    parts.push(describeRecall(best, dist(best.chest.pos, state.pos)));
    if (parts.length >= 2) break;
  }
  if (!parts.length) return '';
  return `；${parts.join('；')}——可以 take_items 去翻翻（翻到了比重新采快，翻不到再说）`;
}

const dist = (a: Vec3Like, b: Vec3Like) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));

/** 从 craft 的缺料说明里读出缺什么：“stick 还差 1（有 0），cobblestone 还差 2（有 6）” */
export function needsFromShortfall(text: string | undefined): Need[] {
  if (!text) return [];
  return [...text.matchAll(/([a-z0-9_]+) 还差 (\d+)/g)].map((m) => ({ item: m[1], count: Number(m[2]) }));
}

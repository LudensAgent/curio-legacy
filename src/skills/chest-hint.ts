import type { Vec3Like } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';

/** 木头类：缺木板、木棍时，箱子里的原木也算（拿回来就能做） */
const WOODISH = /_(log|wood|stem|hyphae|planks)$/;
const FUEL = /^(coal|charcoal|coal_block)$|_(log|wood|stem|hyphae|planks)$/;

export interface Need { item: string; count: number }

/**
 * 缺的东西，记得的箱子里有没有：有就说在哪个箱子、有多少、可以 take_items 拿。
 * 它会把东西存进箱子，却从来不去拿（10-26 晚：存了 4 次、拿了 0 次）——缺木板时箱子里有 38 根原木，
 * 缺铁锭时箱子里就放着一个。只在报缺材料时说，不常驻提示词。
 */
export function chestHint(memory: Pick<WorldMemory, 'chests'>, state: { dim: string; pos: Vec3Like }, needs: Need[], opts: { fuel?: boolean } = {}): string {
  if (!needs.length && !opts.fuel) return '';
  let chests: ReturnType<WorldMemory['chests']>;
  try { chests = memory.chests(state.dim); } catch { return ''; }
  if (!chests.length) return '';
  const wants: { label: string; accept: (n: string) => boolean; count: (have: string) => number }[] = needs.slice(0, 8).map((need) => {
    const wood = /_planks$/.test(need.item) || need.item === 'stick';
    return {
      label: need.item,
      accept: (n: string) => n === need.item || (wood && WOODISH.test(n)),
      // 同一样东西按缺多少拿；拿原木回来做木板/木棍：一根原木 4 块木板
      count: (n: string) => n === need.item ? need.count : Math.max(1, Math.ceil(need.count / (need.item === 'stick' ? 8 : 4))),
    };
  });
  if (opts.fuel) wants.push({ label: '燃料', accept: (n) => FUEL.test(n), count: () => 8 });
  // 每样缺的东西挑最近的、真有这样东西的箱子；同一个箱子里的合在一起说
  const byChest = new Map<string, { pos: Vec3Like; dist: number; items: Map<string, number>; take: Map<string, number> }>();
  for (const w of wants) {
    let best: { c: (typeof chests)[number]; dist: number; have: { name: string; count: number }[] } | null = null;
    for (const c of chests) {
      const have = c.items.filter((i) => i.count > 0 && w.accept(i.name));
      if (!have.length) continue;
      const dist = Math.round(Math.hypot(c.pos.x - state.pos.x, c.pos.z - state.pos.z));
      if (!best || dist < best.dist) best = { c, dist, have };
    }
    if (!best) continue;
    const key = `${best.c.pos.x},${best.c.pos.y},${best.c.pos.z}`;
    const entry = byChest.get(key) ?? { pos: best.c.pos, dist: best.dist, items: new Map(), take: new Map() };
    // 同名的优先；木头类挑最多的那种
    const pick = best.have.find((h) => h.name === w.label) ?? [...best.have].sort((a, b) => b.count - a.count)[0];
    for (const h of best.have.slice(0, 3)) entry.items.set(h.name, h.count);
    if (!entry.take.has(pick.name)) entry.take.set(pick.name, Math.min(pick.count, w.count(pick.name)));
    byChest.set(key, entry);
  }
  if (!byChest.size) return '';
  const parts = [...byChest.values()].sort((a, b) => a.dist - b.dist).slice(0, 2).map((e) => {
    const [item, count] = [...e.take][0];
    return `(${e.pos.x},${e.pos.y},${e.pos.z}) 的箱子（${e.dist} 格外）里有 ${[...e.items].map(([n, c]) => `${n}×${c}`).join('、')}，可以 take_items 拿（如 {"item":"${item}","count":${Math.min(64, count)}}）`;
  });
  return `；记得 ${parts.join('；')}，不用再去采（箱子里是上次看到的样子）`;
}

/** 从 craft 的缺料说明里读出缺什么：“stick 还差 1（有 0），cobblestone 还差 2（有 6）” */
export function needsFromShortfall(text: string | undefined): Need[] {
  if (!text) return [];
  return [...text.matchAll(/([a-z0-9_]+) 还差 (\d+)/g)].map((m) => ({ item: m[1], count: Number(m[2]) }));
}

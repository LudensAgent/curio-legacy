import { bucket, chestLocation, isContainerLandmark, qtyWord } from './chest-memory.ts';
import type { WorldMemory } from './store.ts';
import minecraftData from 'minecraft-data';

const CONTAINER_WORD = /箱|木桶|潜影盒|\b(?:chests?|(?:trapped|ender)_chest|barrels?|(?:[a-z]+_)*shulker_box(?:es)?|shulker[ -]box(?:es)?|store_items|take_items|use_gui)\b/i;
const ITEM_WORDS = [...new Set(minecraftData('1.20.1').itemsArray.flatMap(({ name, displayName }) => {
  const display = displayName.toLowerCase();
  const plural = /(?:s|x|z|ch|sh)$/.test(display) ? display + 'es' : /[^aeiou]y$/.test(display) ? display.slice(0, -1) + 'ies' : display + 's';
  return [name, 'minecraft:' + name, display, plural];
}))].sort((a, b) => b.length - a.length).map((word) => word.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|');
const ITEM_COUNT = '(?<![\\d:/+-])(?<!\\d[.,])\\d+(?!\\d|[.,:/+-]\\d)';
const ENGLISH_QUANTITY = new RegExp('(?<![\\p{L}\\p{N}_:])(?:(' + ITEM_COUNT + ')\\s+(' + ITEM_WORDS + ')|(' + ITEM_WORDS + ')\\s+(' + ITEM_COUNT + '))(?![\\p{L}\\p{N}_:])', 'giu');

/** Consolidated memories can contain several facts; only the container fact loses precision. */
function containerFactAt(text: string, offset: number) {
  const before = [...text.slice(0, offset).matchAll(/[；;。\n]|\.\s/g)].at(-1);
  const start = before ? before.index + before[0].length : 0;
  const after = text.slice(offset).search(/[；;。\n]|\.\s/);
  return CONTAINER_WORD.test(text.slice(start, after < 0 ? undefined : offset + after));
}

/** A later visual contradiction remains attached to historical coordinate claims. */
export function noteGoneSpots(text: string, memory: Partial<Pick<WorldMemory, 'goneNear'>> | undefined, dim: string): string {
  if (!memory?.goneNear) return text;
  return text.replace(/\(?(-?\d{1,7}),\s*(-?\d{1,3}),\s*(-?\d{1,7})\)?/g, (match: string, x: string, y: string, z: string, offset: number, whole: string) => {
    if (whole.lastIndexOf('〔历史容器区域：', offset) > whole.lastIndexOf('〕', offset) || /中心\s*$/.test(whole.slice(0, offset))) return match;
    if (whole.slice(offset + match.length).startsWith('〔亲眼看过：')) return match;
    const gone = memory.goneNear?.(dim, { x: +x, y: +y, z: +z }, 3)[0];
    return gone ? `${match}〔亲眼看过：这里的 ${gone.label} 已经没了，现在是 ${gone.now}〕` : match;
  });
}

/** Historical prose must not reconstruct a precise container inventory or location. */
export function recallText(text: string, memory: Pick<WorldMemory, 'chests' | 'landmarks'> & Partial<Pick<WorldMemory, 'goneNear'>>, dimension?: string, observedAt?: number, now = Date.now()): string {
  if (dimension) text = noteGoneSpots(text, memory, dimension);
  if (!CONTAINER_WORD.test(text)) return text;
  const containers = [
    ...memory.chests(dimension),
    ...memory.landmarks().filter((l) => (!dimension || l.dim === dimension) && isContainerLandmark(l.label)),
  ];
  const locations = new Map(containers.map((c) => [`${c.pos.x},${c.pos.y},${c.pos.z}`,
    chestLocation({ pos: c.pos, ts: observedAt === undefined ? c.ts : Math.min(observedAt, c.ts) }, { now })]));
  const replaceLocation = (match: string, x: string, y: string, z: string, offset: number, whole: string) => {
    // A projected region is an honest range, not another point to project again.
    if (whole.lastIndexOf('〔历史容器区域：', offset) > whole.lastIndexOf('〕', offset)) return match;
    const location = locations.get(`${Number(x)},${Number(y)},${Number(z)}`)
      ?? (observedAt === undefined || !containerFactAt(whole, offset) ? undefined : chestLocation({ pos: { x: Number(x), y: Number(y), z: Number(z) }, ts: observedAt }, { now }));
    return location && !location.precise ? `〔历史容器区域：${location.text}〕` : match;
  };
  return text
    .replace(/(?:\(|\[|（)\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*(?:\)|\]|）)/g, replaceLocation)
    .replace(/\{\s*"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"y"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"z"\s*:\s*(-?\d+(?:\.\d+)?)\s*\}/g, replaceLocation)
    .replace(/(?<![\d.])(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?![\d.])/g, replaceLocation)
    .replace(/@ ([a-z][a-z0-9_:]*) (-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/g,
      (match: string, dim: string, x: string, y: string, z: string, offset: number, whole: string) => {
        if (!containerFactAt(whole, offset)) return match;
        const location = chestLocation({ pos: { x: Number(x), y: Number(y), z: Number(z) }, ts: observedAt ?? 0 }, { now });
        return location.precise ? match : `@ ${dim} 〔历史容器区域：${location.text}〕`;
      })
    .replace(/([\p{L}\p{N}_:]+)×(\d+)/gu, (match: string, item: string, count: string, offset: number, whole: string) => containerFactAt(whole, offset) ? `${item}（${qtyWord(bucket(Number(count)))}，历史印象）` : match)
    .replace(/(\d+) 个 ([a-z][a-z0-9_]*)/g, (match: string, count: string, item: string, offset: number, whole: string) => containerFactAt(whole, offset) ? `${qtyWord(bucket(Number(count)))} ${item}（历史印象）` : match)
    .replace(ENGLISH_QUANTITY, (match: string, before: string | undefined, afterItem: string | undefined, beforeItem: string | undefined, after: string | undefined, offset: number, whole: string) =>
      containerFactAt(whole, offset) ? (beforeItem ?? afterItem) + '（' + qtyWord(bucket(Number(before ?? after))) + '，历史印象）' : match)
    .replace(/("(?:name|item)"\s*:\s*"[^"]+"\s*,\s*)"count"\s*:\s*(\d+)/g,
      (match: string, name: string, count: string, offset: number, whole: string) => containerFactAt(whole, offset) ? `${name}"quantity":"${qtyWord(bucket(Number(count)))}（历史印象）"` : match);
}

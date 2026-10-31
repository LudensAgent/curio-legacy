import { bucket, qtyWord } from './chest-memory.ts';
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
    if (whole.slice(offset + match.length).startsWith('〔亲眼看过：')) return match;
    const gone = memory.goneNear?.(dim, { x: +x, y: +y, z: +z }, 0)[0];
    return gone ? `${match}〔亲眼看过：当时这里的 ${gone.label} 没了，变成 ${gone.now}；观察时间 ${new Date(gone.ts).toISOString()}，历史记录不代表当前状态〕` : match;
  });
}

/** Historical prose fades container quantities to impressions; locations stay precise. */
export function recallText(text: string, memory: Pick<WorldMemory, 'chests' | 'landmarks'> & Partial<Pick<WorldMemory, 'goneNear'>>, dimension?: string, observedAt?: number, now = Date.now()): string {
  if (dimension) text = noteGoneSpots(text, memory, dimension);
  if (!CONTAINER_WORD.test(text)) return text;
  return text
    .replace(/([\p{L}\p{N}_:]+)×(\d+)/gu, (match: string, item: string, count: string, offset: number, whole: string) => containerFactAt(whole, offset) ? `${item}（${qtyWord(bucket(Number(count)))}，历史印象）` : match)
    .replace(/(\d+) 个 ([a-z][a-z0-9_]*)/g, (match: string, count: string, item: string, offset: number, whole: string) => containerFactAt(whole, offset) ? `${qtyWord(bucket(Number(count)))} ${item}（历史印象）` : match)
    .replace(ENGLISH_QUANTITY, (match: string, before: string | undefined, afterItem: string | undefined, beforeItem: string | undefined, after: string | undefined, offset: number, whole: string) =>
      containerFactAt(whole, offset) ? (beforeItem ?? afterItem) + '（' + qtyWord(bucket(Number(before ?? after))) + '，历史印象）' : match)
    .replace(/("(?:name|item)"\s*:\s*"[^"]+"\s*,\s*)"count"\s*:\s*(\d+)/g,
      (match: string, name: string, count: string, offset: number, whole: string) => containerFactAt(whole, offset) ? `${name}"quantity":"${qtyWord(bucket(Number(count)))}（历史印象）"` : match);
}

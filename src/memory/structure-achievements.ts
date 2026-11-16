/**
 * 游戏成就里明确说明“已经进入某个结构”的，转成可持久化的结构地标。
 * 只收结构位置；普通成就仍在 note/diary 里，不当成地点。
 */
const STRUCTURE_ACHIEVEMENTS: { match: RegExp; label: string }[] = [
  { match: /A Terrible Fortress/i, label: '下界要塞（暗红砖）' },
  { match: /Those Were the Days/i, label: '猪灵堡垒遗迹' },
  { match: /Hidden in the Depths/i, label: '远古城市' },
];
const STRUCTURE_LABELS = new Set(STRUCTURE_ACHIEVEMENTS.map((entry) => entry.label));

export const isStructureLabel = (label: string) => STRUCTURE_LABELS.has(label);

export const structureFromAchievement = (text: string) => {
  const name = text.match(/\[([^\]]+)\]/)?.[1] ?? text;
  const found = STRUCTURE_ACHIEVEMENTS.find((entry) => entry.match.test(name));
  return found ? { label: found.label, achievement: name } : null;
};

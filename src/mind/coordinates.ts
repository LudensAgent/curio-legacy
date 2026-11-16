import type { Vec3Like } from '../adapter/types.ts';

/** 提示词里展示的结构发现锚点；坐标来自发现/成就时的目击位置，不是结构中心。 */
export type StructureAnchor = { id: string; label: string; dim: string; pos: Vec3Like };

/** 一处需要核对的计划/议程文字。 */
export type CoordinateSource = { source: string; text: string };

export type StructureCoordinateConflict = {
  anchor: StructureAnchor;
  referenced: Vec3Like;
  /** 三维距离（格）；只用于说明两处不是同一个点。 */
  distance: number;
  sources: string[];
};

/** 只认括号里的整数三元组；分数坐标、时间、物品计数都不会被当成目的地。 */
const TRIPLE = /[(（]\s*(-?\d{1,6})\s*,\s*(-?\d{1,6})\s*,\s*(-?\d{1,6})\s*[)）]/g;
/** 与锚点相差不超过这么多格时按同一个点处理，不算冲突。 */
const SAME_TOLERANCE = 8;

const coreLabel = (label: string) => label.replace(/[（(][^）)]*[）)]/g, '').trim();

const coordinateTriples = (text: string): Vec3Like[] =>
  [...text.matchAll(TRIPLE)].map((match) => ({ x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }));

/**
 * 找“计划/议程里写的坐标”与“已发现结构锚点”不一致的地方。
 * 只读文本和地标事实，不改写任何目标；同一处坐标被多处引用时合并来源。
 */
export function structureCoordinateConflicts(
  anchors: readonly StructureAnchor[],
  sources: readonly CoordinateSource[],
): StructureCoordinateConflict[] {
  const conflicts = anchors.flatMap((anchor) => {
    const core = coreLabel(anchor.label);
    if (core.length < 2) return [];
    return sources.flatMap((source) => {
      if (!source.text.includes(core)) return [];
      return coordinateTriples(source.text).flatMap((referenced) => {
        const distance = Math.hypot(referenced.x - anchor.pos.x, referenced.y - anchor.pos.y, referenced.z - anchor.pos.z);
        if (distance <= SAME_TOLERANCE) return [];
        return [{ anchor, referenced, distance, sources: [source.source] }];
      });
    });
  });
  const conflictsByKey = conflicts.reduce((byKey, conflict) => {
    const key = `${conflict.anchor.id}:${conflict.referenced.x},${conflict.referenced.y},${conflict.referenced.z}`;
    const existing = byKey.get(key);
    const sourceName = conflict.sources[0]!;
    if (existing !== undefined) {
      if (!existing.sources.includes(sourceName)) existing.sources.push(sourceName);
    } else byKey.set(key, conflict);
    return byKey;
  }, new Map<string, StructureCoordinateConflict>());
  return [...conflictsByKey.values()].sort((a, b) => b.distance - a.distance);
}

export function structureConflictText(conflict: StructureCoordinateConflict): string {
  const { anchor, referenced } = conflict;
  return `计划/议程里的 (${referenced.x},${referenced.y},${referenced.z}) 与「${anchor.label}」[${anchor.id}]（${anchor.dim}）的锚点 (${Math.round(anchor.pos.x)},${Math.round(anchor.pos.y)},${Math.round(anchor.pos.z)}) 相距 ${Math.round(conflict.distance)} 格；来源：${conflict.sources.join('、')}。两处不是同一个点，以哪一处为目的由你核对。`;
}

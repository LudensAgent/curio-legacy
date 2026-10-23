import type { GameAdapter } from '../adapter/types.ts';
import type { SkillCtx } from '../skills/types.ts';
import type { BuildingArchive, BuildingDefect, BuildingProject } from './archive.ts';
import { cellKey, rotatePosition, type BuildingBlueprint, type BuildingCell } from './spec.ts';

/** A walkable staircase outside the front wall; the roof's stepped tiers provide further ascent. */
export function planScaffolding(blueprint: BuildingBlueprint): BuildingCell[] {
  if (blueprint.spec.layout !== 'house') return [];
  const cells: BuildingCell[] = [], height = blueprint.spec.height;
  const add = (x: number, y: number, z: number) => cells.push({ id: `scaffold:${x},${y},${z}`, pos: { x, y, z }, name: blueprint.spec.palette.foundation, properties: {}, tags: ['temporary_scaffold'], phase: 'foundation', dependsOn: [] });
  for (let step = 0; step <= height; step++) for (let y = 0; y <= step; y++) add(-2, y, -height - 2 + step);
  add(-2, height, -1); add(-2, height, 0); add(-1, height, 0);
  return cells;
}

export function inspectScaffoldSite(adapter: GameAdapter, cells: BuildingCell[], project: BuildingProject): BuildingDefect[] {
  const defects: BuildingDefect[] = [];
  const owned = new Map((project.temporaryBlocks ?? []).map((b) => [cellKey(b.pos), b.name]));
  const seenGround = new Set<string>();
  for (const cell of cells) {
    const pos = rotatePosition(cell.pos, project.origin, project.rotation), name = adapter.blockAt(pos);
    if (name !== 'air' && owned.get(cellKey(cell.pos)) !== name) defects.push({ cellId: cell.id, pos, kind: name === null ? 'unknown' : 'obstruction', expected: '临时脚手架空间 air 或本项目已放置的脚手架', actual: name });
    if (cell.pos.y !== 0 || seenGround.has(`${pos.x},${pos.z}`)) continue;
    seenGround.add(`${pos.x},${pos.z}`);
    const ground = { ...pos, y: project.origin.y - 1 }, base = adapter.blockAt(ground);
    if (base === null || !/^(?:grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mud|packed_mud|clay|stone|andesite|granite|diorite|tuff|calcite|cobblestone|cobbled_deepslate|deepslate|sandstone|terracotta|netherrack|end_stone|[a-z_]+_planks|[a-z_]+_log)$/.test(base)) defects.push({ cellId: `${cell.id}:support`, pos: ground, kind: base === null ? 'unknown' : 'terrain', expected: '脚手架下方安全实心地面', actual: base });
  }
  return defects;
}

export async function erectScaffolding(ctx: SkillCtx, archive: BuildingArchive, project: BuildingProject, cells: BuildingCell[], check: () => void) {
  let placed = 0;
  for (const cell of cells) {
    check();
    if (Date.now() >= ctx.deadline - 1000) throw new Error('TIMEOUT:脚手架尚未完成');
    const pos = rotatePosition(cell.pos, project.origin, project.rotation);
    const previous = (archive.get(project.id)?.temporaryBlocks ?? []).find((b) => cellKey(b.pos) === cellKey(cell.pos));
    if (previous && ctx.adapter.blockAt(pos) === previous.name) continue;
    if (ctx.adapter.blockAt(pos) !== 'air') throw new Error('SCAFFOLD_OBSTRUCTED');
    // A nearby target can still have its clickable face occluded by the previous
    // stair column. Distance alone is not a legal placement-standing proof.
    await ctx.adapter.moveTo({ kind: 'place_block', pos }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(15000, ctx.deadline - Date.now())), constructionSafe: true });
    check();
    archive.pending(project.id, { kind: 'temporary', pos: cell.pos, name: cell.name });
    const action = await ctx.adapter.placeBlockAt(pos, [cell.name], ctx.signal);
    check();
    if (!action.ok || ctx.adapter.blockAt(pos) !== cell.name) { archive.pending(project.id, null); throw new Error(`SCAFFOLD_PLACEMENT_FAILED:${cell.id}:${action.reason ?? 'NOT_VERIFIED'}`); }
    archive.temporary(project.id, { pos: cell.pos, name: cell.name });
    archive.pending(project.id, null);
    check(); placed++;
  }
  return placed;
}

/** Remove only recorded temporary blocks, from high to low, never digging beneath the bot. */
export async function removeScaffolding(ctx: SkillCtx, archive: BuildingArchive, project: BuildingProject, check: () => void): Promise<number> {
  const blocks = [...(archive.get(project.id)?.temporaryBlocks ?? [])].reverse().sort((a, b) => b.pos.y - a.pos.y);
  let removed = 0;
  for (const block of blocks) {
    check();
    if (Date.now() >= ctx.deadline - 1000) break;
    const pos = rotatePosition(block.pos, project.origin, project.rotation), name = ctx.adapter.blockAt(pos);
    if (name === 'air') { archive.temporary(project.id, block, true); continue; }
    if (name !== block.name) continue;
    const state = ctx.adapter.state();
    if (Math.hypot(pos.x - state.pos.x, pos.y - state.pos.y, pos.z - state.pos.z) > 4) await ctx.adapter.moveTo({ kind: 'reach_block', pos }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(15000, ctx.deadline - Date.now())), constructionSafe: true });
    check();
    let now = ctx.adapter.state();
    if (Math.floor(now.pos.x) === pos.x && Math.floor(now.pos.z) === pos.z && Math.floor(now.pos.y) - 1 === pos.y) {
      const support = (archive.get(project.id)?.temporaryBlocks ?? []).find((b) => b.pos.y === block.pos.y - 1 && Math.abs(b.pos.x - block.pos.x) + Math.abs(b.pos.z - block.pos.z) === 1 && ctx.adapter.blockAt(rotatePosition(b.pos, project.origin, project.rotation)) === b.name);
      const supportWorld = support ? rotatePosition(support.pos, project.origin, project.rotation) : null;
      const stand = supportWorld ? { x: supportWorld.x + 0.5, y: supportWorld.y + 1, z: supportWorld.z + 0.5 } : rotatePosition({ x: -3, y: 0, z: -project.versions.at(-1)!.spec.height - 2 }, project.origin, project.rotation);
      await ctx.adapter.moveTo({ kind: 'near', pos: stand, range: 0.5 }, { signal: ctx.signal, timeoutMs: Math.max(1, Math.min(15000, ctx.deadline - Date.now())), constructionSafe: true });
      check(); now = ctx.adapter.state();
      if (Math.floor(now.pos.x) === pos.x && Math.floor(now.pos.z) === pos.z) continue;
    }
    const result = await ctx.adapter.dig(pos, ctx.signal);
    check();
    if (result.ok && ctx.adapter.blockAt(pos) === 'air') { archive.temporary(project.id, block, true); removed++; }
    check();
  }
  return removed;
}

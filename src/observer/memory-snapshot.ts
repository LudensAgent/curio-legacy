import type { AgentState } from '../adapter/types.ts';
import { chestLocation, chestRecollectionLocation, describeChest, isContainerLandmark } from '../memory/chest-memory.ts';
import { oreKind } from '../memory/ore-spots.ts';
import { recallText } from '../memory/recollection.ts';
import type { WorldMemory } from '../memory/store.ts';
import { myFacilities } from '../mind/facilities.ts';

/** Dashboard spatial memory follows the Agent; summaries cover its current world. */
export function dashboardMemory(memory: WorldMemory, state: Pick<AgentState, 'worldId' | 'dim' | 'pos' | 'worldDay'>, facingYaw: number | null) {
  const inWorld = (record: { worldId?: string }) => (record.worldId ?? 'default') === state.worldId;
  const inDimension = (record: { worldId?: string; dim: string }) => inWorld(record) && record.dim === state.dim;
  const landmarks = memory.landmarks().filter(inWorld);
  const chests = memory.chests().filter(inWorld);
  const passages = memory.passages().filter(inWorld);
  const hazards = memory.hazards().filter(inWorld);
  const farms = memory.farms().filter(inWorld);
  const clock = memory.chestClock(state.worldDay);
  const facilities = memory.worldId === state.worldId ? myFacilities(memory, state) : [];
  const dimensions = [...new Set(['overworld', 'the_nether', 'the_end', state.dim,
    ...landmarks.map((l) => l.dim), ...chests.map((c) => c.dim), ...passages.map((p) => p.dim), ...hazards.map((h) => h.dim), ...farms.map((f) => f.dim)])]
    .map((dim) => {
      const places = landmarks.filter((l) => l.dim === dim);
      return {
        dim, landmarks: places.length,
        resources: places.filter((l) => l.kind === 'resource').length,
        creatures: places.filter((l) => l.kind === 'herd').length,
        chests: chests.filter((c) => c.dim === dim).length,
        passages: passages.filter((p) => p.dim === dim).length,
        facilities: memory.worldId === state.worldId ? myFacilities(memory, { ...state, dim }).filter((f) => f.kind !== 'passage').length : 0,
        hazards: hazards.filter((h) => h.dim === dim).length + places.filter((l) => l.kind === 'danger').length,
      };
    });
  const currentLandmarks = landmarks.filter(inDimension);
  return {
    worldId: state.worldId, dimension: state.dim, dimensions, facingYaw,
    landmarks: currentLandmarks.map((l) => isContainerLandmark(l.label) ? { ...l, ...chestLocation(l, clock) } : l),
    creatures: currentLandmarks.filter((l) => l.kind === 'herd').sort((a, b) => b.ts - a.ts),
    resources: currentLandmarks.filter((l) => l.kind === 'resource' || l.kind === 'danger')
      .map((l) => ({ ...l, type: l.kind === 'danger' ? `danger:${l.label}` : oreKind(l.label),
        dist: Math.round(Math.hypot(l.pos.x - state.pos.x, l.pos.y - state.pos.y, l.pos.z - state.pos.z)) }))
      .sort((a, b) => a.dist - b.dist),
    passages: passages.filter(inDimension).sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 12),
    facilities: facilities.slice(0, 16).map((f) => ({ ...f, worldId: state.worldId, dim: state.dim })),
    chests: chests.filter(inDimension).map((c) => ({ worldId: c.worldId, dim: c.dim, ...chestRecollectionLocation(c, clock), note: c.note, uses: c.uses,
      items: c.contents.items.length, text: describeChest(c, clock) })),
    hazards: hazards.filter(inDimension).slice(-10),
    farms: farms.filter(inDimension).map((f) => ({ dim: f.dim, crop: f.crop, cells: f.cells.length, harvests: f.harvests })),
    notes: memory.notesFor({ dimension: state.dim, n: 8 }).filter(inWorld)
      .map((n) => ({ ...n, text: recallText(n.text, memory, n.dimension, n.kind === 'fact' ? n.ts : 0) })),
    goals: memory.recentGoals(100).filter((g) => inWorld(g) && (!g.dimension || g.dimension === state.dim)).slice(-8)
      .map(({ goal, summary, plan: _plan, ...g }) => ({ ...g, goal: recallText(goal, memory, g.dimension, g.ts), summary: recallText(summary, memory, g.dimension, g.ts) })),
  };
}

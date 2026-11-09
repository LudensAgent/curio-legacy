export { moveStep, mineCell, placeCell, placeSupport, pillarOne, l1Primitives } from './primitives.ts';
export { L1_MANIFEST, type PrimitiveContract } from './manifest.ts';
export { PRIMITIVE_PROBLEM_KINDS, type EffectKind, type PrimitiveProblemKind } from './receipt.ts';
export { resolveTarget } from './target.ts';
export { planRoute, consumeRoutePlan, releaseRoutePlan, clearRouteRecords, noteRouteScope } from './route.ts';
export { walkPath } from './walk.ts';
export { navigateTo } from './navigate.ts';
export { advance } from './advance.ts';
export {
  clearMovementSessions, createMovementSession, findMovementSession, activeMovementSession,
  intentKeyOf, MOVEMENT_SESSION_CAPACITY, MOVEMENT_SESSION_TTL_MS,
  type CardinalDirection, type MoveMode, type MovementIntent, type MovementSession, type StopReason,
} from './session.ts';
export { runMovementCoordinator } from './coordinator.ts';
export { runNavigationSegment } from './segment.ts';
export { goNear } from './approach.ts';
export { approachVisible } from './approach-visible.ts';
export { descendTo } from './descend.ts';
export { swimPath } from './water.ts';
export { boatPath } from './boat.ts';
export { excavateRun } from './excavate.ts';

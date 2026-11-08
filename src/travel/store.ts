import type { AgentState, Vec3Like } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import { SpatialTravelStore } from './spatial-store.ts';

export interface PortalEndpoint {
  id: string;
  worldId: string;
  dim: string;
  pos: Vec3Like;
  kind: 'nether_portal' | 'end_portal' | 'end_gateway';
  portalObserved: boolean;
  observedAt: number;
}

export interface PortalTraversal {
  fromId: string;
  toId: string;
  ts: number;
  fromSession: string;
  toSession: string;
  fromObservation: number;
  toObservation: number;
}

const stores = new WeakMap<WorldMemory, SpatialTravelStore>();
export function travelStore(memory: WorldMemory): SpatialTravelStore {
  let store = stores.get(memory);
  if (!store || store.world !== memory.worldId) {
    store = new SpatialTravelStore(memory.semanticStore.stores, memory.worldId);
    stores.set(memory, store);
  }
  return store;
}

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

/** observedAt 是端点记录/核对的时刻；portalObserved=false 时它只是到达位置。 */
export function portalAgeText(observedAt: number, now = Date.now()) {
  const minutes = Math.floor((now - observedAt) / 60_000);
  return minutes < 1 ? '不到 1 分钟前'
    : minutes < 90 ? `${minutes} 分钟前`
    : minutes < 48 * 60 ? `${Math.round(minutes / 60)} 小时前`
    : `${Math.round(minutes / 1440)} 天前`;
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

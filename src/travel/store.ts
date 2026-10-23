import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, Vec3Like } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import { dist3, shortId } from '../util.ts';

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

/** Positions are received observations. Coordinate scaling is never a route. */
export class TravelStore {
  private endpoints: PortalEndpoint[] = [];
  private traversals: PortalTraversal[] = [];
  private gateways: PortalTraversal[] = [];

  constructor(private file: string | null) {
    if (!file || !fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.endpoints = (Array.isArray(raw.endpoints) ? raw.endpoints : []).filter((e: any) => e && typeof e.id === 'string' && typeof e.worldId === 'string' && typeof e.dim === 'string' && ['nether_portal', 'end_portal', 'end_gateway'].includes(e.kind) && [e.pos?.x, e.pos?.y, e.pos?.z, e.observedAt].every(Number.isFinite));
    this.traversals = (Array.isArray(raw.traversals) ? raw.traversals : []).filter((t: any) => t && typeof t.fromId === 'string' && typeof t.toId === 'string' && typeof t.fromSession === 'string' && typeof t.toSession === 'string' && [t.ts, t.fromObservation, t.toObservation].every(Number.isFinite));
    this.gateways = (Array.isArray(raw.gateways) ? raw.gateways : []).filter((t: any) => t && typeof t.fromId === 'string' && typeof t.toId === 'string' && typeof t.fromSession === 'string' && typeof t.toSession === 'string' && [t.ts, t.fromObservation, t.toObservation].every(Number.isFinite));
  }

  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, endpoints: this.endpoints, traversals: this.traversals, gateways: this.gateways }, null, 2));
    fs.renameSync(temporary, this.file);
  }

  observe(state: AgentState, pos: Vec3Like, kind: PortalEndpoint['kind'], portalObserved = true): PortalEndpoint {
    if (!state.observationReady || !state.connected || !state.alive || ![pos.x, pos.y, pos.z].every(Number.isFinite)) throw new Error('A portal requires a live observation');
    let endpoint = this.endpoints.find((e) => e.worldId === state.worldId && e.dim === state.dim && e.kind === kind && dist3(e.pos, pos) <= 4);
    if (endpoint) {
      if (portalObserved) { endpoint.pos = { ...pos }; endpoint.portalObserved = true; }
      endpoint.observedAt = Date.now();
    } else {
      endpoint = { id: shortId('portal_'), worldId: state.worldId, dim: state.dim, pos: { ...pos }, kind, portalObserved, observedAt: Date.now() };
      this.endpoints.push(endpoint);
    }
    this.save();
    return structuredClone(endpoint);
  }

  record(fromId: string, toId: string, from: AgentState, to: AgentState) {
    if (!from.observationReady || !to.observationReady || !to.connected || !to.alive || from.worldId !== to.worldId || from.dim === to.dim || from.sessionId === to.sessionId) throw new Error('Unverified dimension transition');
    const source = this.get(fromId, from.worldId);
    const destination = this.get(toId, to.worldId);
    if (!source || !destination || source.dim !== from.dim || destination.dim !== to.dim) throw new Error('Portal scope does not match transition');
    this.traversals.push({ fromId, toId, ts: Date.now(), fromSession: from.sessionId, toSession: to.sessionId, fromObservation: from.observationId, toObservation: to.observationId });
    this.traversals = this.traversals.slice(-500);
    this.save();
  }

  get(id: string, worldId: string) { const endpoint = this.endpoints.find((e) => e.id === id && e.worldId === worldId); return endpoint ? structuredClone(endpoint) : undefined; }

  recordGateway(fromId: string, toId: string, from: AgentState, to: AgentState) {
    if (!from.observationReady || !to.observationReady || !to.connected || !to.alive || from.worldId !== to.worldId || from.dim !== 'the_end' || to.dim !== 'the_end' || from.sessionId !== to.sessionId || dist3(from.pos, to.pos) < 48) throw new Error('Unverified End gateway teleport');
    const source = this.get(fromId, from.worldId), destination = this.get(toId, to.worldId);
    if (source?.kind !== 'end_gateway' || destination?.kind !== 'end_gateway' || source.dim !== from.dim || destination.dim !== to.dim) throw new Error('Gateway scope does not match teleport');
    this.gateways.push({ fromId, toId, ts: Date.now(), fromSession: from.sessionId, toSession: to.sessionId, fromObservation: from.observationId, toObservation: to.observationId });
    this.gateways = this.gateways.slice(-500);
    this.save();
  }

  /** A return is verified only after an actual traversal in the opposite direction. */
  snapshot(worldId: string) {
    const endpoints = this.endpoints.filter((e) => e.worldId === worldId).map((e) => structuredClone(e));
    const ids = new Set(endpoints.map((e) => e.id));
    const routes = this.traversals.filter((t) => ids.has(t.fromId) && ids.has(t.toId)).map((t) => ({ ...t, returnVerified: this.traversals.some((r) => r.fromId === t.toId && r.toId === t.fromId) }));
    const gateways = this.gateways.filter((t) => ids.has(t.fromId) && ids.has(t.toId)).map((t) => ({ ...t, returnVerified: this.gateways.some((r) => r.fromId === t.toId && r.toId === t.fromId) }));
    return { endpoints, routes, gateways };
  }
}

const stores = new WeakMap<WorldMemory, TravelStore>();
export function travelStore(memory: WorldMemory) {
  let store = stores.get(memory);
  if (!store) { store = new TravelStore(memory.dataDirectory ? path.join(memory.dataDirectory, 'travel-memory.json') : null); stores.set(memory, store); }
  return store;
}

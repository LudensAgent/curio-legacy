import type { JsonValue } from 'curio-minecraft-3d-memory';
import type { AgentState, Vec3Like } from '../adapter/types.ts';
import { shortId } from '../util.ts';
import type { SpatialLibraryStores } from '../spatial/semantic-store.ts';
import type { PortalEndpoint, PortalTraversal } from './store.ts';

type EndpointKind = PortalEndpoint['kind'];

interface EndpointRecord extends PortalEndpoint {}

const clone = <T>(value: T): T => structuredClone(value);
const jsonRecord = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue;

function endpoints(session: SpatialLibraryStores, worldId: string): EndpointRecord[] {
  const out: EndpointRecord[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = session.topology.nodes({ after, limit: 100 });
    for (const node of page.items) {
      const curio = (node.metadata as { curio?: { type?: string; record?: unknown } } | undefined)?.curio;
      if (curio?.type !== 'endpoint' || !curio.record || typeof curio.record !== 'object') continue;
      const record = curio.record as EndpointRecord;
      if ((record.worldId ?? worldId) !== worldId) continue;
      out.push(clone(record));
    }
    if (page.nextAfter === undefined) break;
    after = page.nextAfter;
  }
  return out;
}

/**
 * TravelStore-compatible portal memory backed by spatial nodes + the ledger.
 * Endpoints stay as `endpoint` nodes; crossings stay raw in `portal_traversals`.
 */
export class SpatialTravelStore {
  constructor(private readonly session: SpatialLibraryStores, private readonly worldId: string) {}

  get world(): string { return this.worldId; }

  private saveEndpoint(endpoint: EndpointRecord) {
    const node = {
      id: endpoint.id,
      kind: 'place' as const,
      source: 'program' as const,
      tag: 'portal' as const,
      label: endpoint.kind,
      worldId: this.worldId,
      dim: endpoint.dim,
      location: { kind: 'exact' as const, pos: { ...endpoint.pos } },
      observedAt: endpoint.observedAt,
      externalRef: endpoint.id,
      durable: true,
      metadata: { curio: { v: 1, type: 'endpoint', record: jsonRecord(endpoint) } },
    };
    const existing = this.session.topology.getNode(endpoint.id);
    if (!existing) this.session.topology.saveNode(node);
    else {
      try {
        this.session.topology.updateNode(endpoint.id, {
          label: node.label, location: node.location, observedAt: node.observedAt,
          externalRef: node.externalRef, durable: true, metadata: node.metadata,
        });
      } catch {
        // A recorded portal edge may pin the location; keep the existing node and
        // only refresh its evidence/metadata.
        this.session.topology.updateNode(endpoint.id, {
          label: node.label, observedAt: node.observedAt, externalRef: node.externalRef, metadata: node.metadata,
        });
      }
    }
  }

  observe(state: AgentState, pos: Vec3Like, kind: EndpointKind, portalObserved = true): PortalEndpoint {
    if (!state.observationReady || !state.connected || !state.alive || ![pos.x, pos.y, pos.z].every(Number.isFinite)) throw new Error('A portal requires a live observation');
    const all = endpoints(this.session, state.worldId);
    const near = all.find((e) => e.worldId === state.worldId && e.dim === state.dim && e.kind === kind && Math.hypot(e.pos.x - pos.x, e.pos.y - pos.y, e.pos.z - pos.z) <= 4);
    const endpoint: EndpointRecord = near ?? {
      id: shortId('portal_'), worldId: state.worldId, dim: state.dim, pos: { ...pos }, kind,
      portalObserved, observedAt: 0,
    };
    if (near) {
      if (portalObserved) { near.pos = { ...pos }; near.portalObserved = true; }
      near.observedAt = Date.now();
    }
    endpoint.observedAt = near ? near.observedAt : Date.now();
    this.saveEndpoint(endpoint);
    return clone(endpoint);
  }

  record(fromId: string, toId: string, from: AgentState, to: AgentState) {
    if (!from.observationReady || !to.observationReady || !to.connected || !to.alive || from.worldId !== to.worldId || from.dim === to.dim || from.sessionId === to.sessionId) throw new Error('Unverified dimension transition');
    const all = endpoints(this.session, from.worldId);
    const source = all.find((e) => e.id === fromId && e.worldId === from.worldId);
    const destination = all.find((e) => e.id === toId && e.worldId === to.worldId);
    if (!source || !destination || source.dim !== from.dim || destination.dim !== to.dim) throw new Error('Portal scope does not match transition');
    this.session.ledger.recordPortalTraversal({
      fromId, toId, ts: Date.now(),
      fromSession: from.sessionId, toSession: to.sessionId,
      fromObservation: from.observationId, toObservation: to.observationId,
      kind: 'traversal', direction: 'unclassified', worldId: this.worldId,
      fromEndpoint: source, toEndpoint: destination, source: 'live',
    });
  }

  get(id: string, worldId: string): PortalEndpoint | undefined {
    return endpoints(this.session, worldId).find((e) => e.id === id);
  }

  recordGateway(fromId: string, toId: string, from: AgentState, to: AgentState) {
    if (!from.observationReady || !to.observationReady || !to.connected || !to.alive || from.worldId !== to.worldId || from.dim !== 'the_end' || to.dim !== 'the_end' || from.sessionId !== to.sessionId || Math.hypot(from.pos.x - to.pos.x, from.pos.y - to.pos.y, from.pos.z - to.pos.z) < 48) throw new Error('Unverified End gateway teleport');
    const all = endpoints(this.session, from.worldId);
    const source = all.find((e) => e.id === fromId && e.worldId === from.worldId);
    const destination = all.find((e) => e.id === toId && e.worldId === to.worldId);
    if (source?.kind !== 'end_gateway' || destination?.kind !== 'end_gateway' || source.dim !== from.dim || destination.dim !== to.dim) throw new Error('Gateway scope does not match teleport');
    this.session.ledger.recordPortalTraversal({
      fromId, toId, ts: Date.now(),
      fromSession: from.sessionId, toSession: to.sessionId,
      fromObservation: from.observationId, toObservation: to.observationId,
      kind: 'gateway', direction: 'unclassified', worldId: this.worldId,
      fromEndpoint: source, toEndpoint: destination, source: 'live',
    });
  }

  snapshot(worldId: string) {
    const all = endpoints(this.session, worldId);
    const ids = new Set(all.map((e) => e.id));
    const routes = this.session.ledger.portalTraversals({ kind: 'traversal' })
      .filter((t) => ids.has(t.fromId) && ids.has(t.toId))
      .map((t) => ({
        fromId: t.fromId, toId: t.toId, ts: t.ts,
        fromSession: t.fromSession, toSession: t.toSession,
        fromObservation: t.fromObservation, toObservation: t.toObservation,
        returnVerified: this.session.ledger.portalReturnVerified(t),
      }));
    const gateways = this.session.ledger.portalTraversals({ kind: 'gateway' })
      .filter((t) => ids.has(t.fromId) && ids.has(t.toId))
      .map((t) => ({
        fromId: t.fromId, toId: t.toId, ts: t.ts,
        fromSession: t.fromSession, toSession: t.toSession,
        fromObservation: t.fromObservation, toObservation: t.toObservation,
        returnVerified: this.session.ledger.portalReturnVerified(t),
      }));
    return { endpoints: all, routes, gateways } satisfies { endpoints: PortalEndpoint[]; routes: PortalTraversal[]; gateways: PortalTraversal[] };
  }
}

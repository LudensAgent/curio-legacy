import type { AgentState, Vec3Like } from '../adapter/types.ts';
import { shortId } from '../util.ts';
import type { SpatialLibraryStores } from '../spatial/semantic-store.ts';
import {
  PORTAL_ARRIVAL_SOURCE,
  PORTAL_OBSERVED_SOURCE,
  type PlaceFact,
} from '../spatial/facts-adapter.ts';
import type { PortalEndpoint, PortalTraversal } from './store.ts';

type EndpointKind = PortalEndpoint['kind'];

const ENDPOINT_KINDS: ReadonlySet<string> = new Set<EndpointKind>(['nether_portal', 'end_portal', 'end_gateway']);

const clone = <T>(value: T): T => structuredClone(value);

function pageAll<T>(query: (after: string | undefined) => { items: T[]; nextAfter?: string }): T[] {
  const out: T[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = query(after);
    out.push(...page.items);
    if (page.nextAfter === undefined) break;
    after = page.nextAfter;
  }
  return out;
}

/** Portal endpoints are place facts with `kind: "portal"`; crossings stay in the ledger. */
function endpoints(session: SpatialLibraryStores, worldId: string): PortalEndpoint[] {
  return pageAll((after) => session.facts.places({ worldId, includeGone: false, after, limit: 100 }))
    .filter((fact): fact is PlaceFact => fact.kind === 'portal' && fact.location.kind === 'exact')
    .flatMap((fact) => {
      if (fact.location.kind !== 'exact' || !ENDPOINT_KINDS.has(fact.label)) return [];
      return [{
        id: fact.id,
        worldId: fact.worldId,
        dim: fact.dim,
        pos: { ...fact.location.pos },
        kind: fact.label as EndpointKind,
        // The provenance label records whether the endpoint block was actually
        // observed or only reached; legacy facts without the convention were
        // recorded as observations.
        portalObserved: fact.source.source !== PORTAL_ARRIVAL_SOURCE,
        observedAt: fact.observedAt,
      }];
    });
}

/**
 * TravelStore-compatible portal memory backed by semantic place facts and the
 * ledger. Endpoints are portal place facts; crossings stay raw in
 * `portal_traversals`.
 */
export class SpatialTravelStore {
  constructor(private readonly session: SpatialLibraryStores, private readonly worldId: string) {}

  get world(): string { return this.worldId; }

  private saveEndpoint(endpoint: PortalEndpoint) {
    const fact: PlaceFact = {
      id: endpoint.id,
      kind: 'portal',
      label: endpoint.kind,
      worldId: this.worldId,
      dim: endpoint.dim,
      location: { kind: 'exact', pos: { ...endpoint.pos } },
      observedAt: endpoint.observedAt,
      source: {
        source: endpoint.portalObserved ? PORTAL_OBSERVED_SOURCE : PORTAL_ARRIVAL_SOURCE,
      },
      gone: false,
    };
    this.session.facts.upsertPlace(fact);
  }

  observe(state: AgentState, pos: Vec3Like, kind: EndpointKind, portalObserved = true): PortalEndpoint {
    if (!state.observationReady || !state.connected || !state.alive || ![pos.x, pos.y, pos.z].every(Number.isFinite)) throw new Error('A portal requires a live observation');
    const all = endpoints(this.session, state.worldId);
    const near = all.find((e) => e.worldId === state.worldId && e.dim === state.dim && e.kind === kind && Math.hypot(e.pos.x - pos.x, e.pos.y - pos.y, e.pos.z - pos.z) <= 4);
    const endpoint: PortalEndpoint = near ?? {
      id: shortId('portal_'), worldId: state.worldId, dim: state.dim, pos: { ...pos }, kind,
      portalObserved, observedAt: 0,
    };
    if (near) {
      if (portalObserved) { near.pos = { ...pos }; near.portalObserved = true; }
      // Two observations can land in the same millisecond; the fact store
      // treats a same-time changed record as a conflict, so order them.
      near.observedAt = Math.max(Date.now(), near.observedAt + 1);
    }
    endpoint.observedAt = near ? near.observedAt : Date.now();
    this.saveEndpoint(endpoint);
    return clone(endpoint);
  }

  record(fromId: string, toId: string, from: AgentState, to: AgentState) {
    if (!from.observationReady || !to.observationReady || !to.connected || !to.alive || from.worldId !== to.worldId || from.dim === to.dim || from.sessionId === to.sessionId) throw new Error('Unverified dimension transition');
    const all = endpoints(this.session, from.worldId);
    const source = all.find((e) => e.id === fromId && e.worldId === from.worldId);
    const destination = all.find((e) => e.id === toId && e.worldId === from.worldId);
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
    return endpoints(this.session, worldId).find((endpoint) => endpoint.id === id);
  }

  recordGateway(fromId: string, toId: string, from: AgentState, to: AgentState) {
    if (!from.observationReady || !to.observationReady || !to.connected || !to.alive || from.worldId !== to.worldId || from.dim !== 'the_end' || to.dim !== 'the_end' || from.sessionId !== to.sessionId || Math.hypot(from.pos.x - to.pos.x, from.pos.y - to.pos.y, from.pos.z - to.pos.z) < 48) throw new Error('Unverified End gateway teleport');
    const all = endpoints(this.session, from.worldId);
    const source = all.find((e) => e.id === fromId && e.worldId === from.worldId);
    const destination = all.find((e) => e.id === toId && e.worldId === from.worldId);
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

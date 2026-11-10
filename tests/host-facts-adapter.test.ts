import assert from 'node:assert/strict';
import { memoryFrom, semanticMemory } from './semantic-fixture.ts';
import { test } from 'node:test';
import {
  applyHostSemanticMigration,
  containerLedgerKey,
  convertHostSemanticNode,
  createInMemoryHostFactsPort,
  isContainerFact,
  isPlaceFact,
  isResourceFact,
  planHostSemanticMigration,
  PORTAL_ARRIVAL_SOURCE,
  PORTAL_OBSERVED_SOURCE,
  type HostSemanticNode,
} from '../src/spatial/facts-adapter.ts';

const W = 'world-1';
const D = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });
const curio = (meta: Record<string, unknown>) => ({ metadata: { curio: meta } });

function factOf(conversion: ReturnType<typeof convertHostSemanticNode>) {
  assert.equal(conversion.kind, 'fact');
  if (conversion.kind !== 'fact') throw new Error('expected fact');
  return conversion;
}

test('chest nodes become container anchors with stable identity, ledger ref and provenance', () => {
  const node: HostSemanticNode = {
    id: 'chest-1', kind: 'place', tag: 'resource', label: 'chest: ores', worldId: W, dim: D,
    location: { kind: 'exact', pos: at(4, 64, 4) }, observedAt: 1234, source: 'program',
    sessionId: 'session-a', observationIds: ['obs-9'], externalRef: `${W}:${D}:4,64,4`,
    ...curio({ v: 2, type: 'container', block: 'chest', record: { ts: 1234, uses: 2, block: 'chest' } }),
  };
  const { fact, role, classifiedBy, legacyId } = factOf(convertHostSemanticNode(node));
  assert.equal(role, 'container');
  assert.equal(classifiedBy, 'curio');
  assert.equal(legacyId, 'chest-1');
  assert.ok(isContainerFact(fact));
  if (!isContainerFact(fact)) return;
  assert.equal(fact.id, 'chest-1');
  assert.equal(fact.worldId, W);
  assert.equal(fact.dim, D);
  assert.deepEqual(fact.pos, at(4, 64, 4));
  assert.equal(fact.observedAt, 1234, 'original observation time is preserved');
  assert.equal(fact.externalRef, `${W}:${D}:4,64,4`);
  assert.equal(fact.ledgerRef, `${W}:${D}:4,64,4`);
  assert.equal(fact.gone, false);
  assert.equal(fact.legacyId, 'chest-1');
  assert.equal(fact.source.source, 'program');
  assert.equal(fact.source.sessionId, 'session-a');
  assert.deepEqual(fact.source.observationIds, ['obs-9']);
});

test('furnace nodes are container anchors associated with the host ledger key', () => {
  const node: HostSemanticNode = {
    id: 'furnace-1', kind: 'place', tag: 'resource', label: 'furnace (burning)', worldId: W, dim: D,
    location: { kind: 'exact', pos: at(5, 64, 5) }, observedAt: 2000, source: 'program',
    ...curio({ v: 2, type: 'furnace', block: 'furnace', record: { ts: 2000, block: 'furnace' } }),
  };
  const { fact, role } = factOf(convertHostSemanticNode(node));
  assert.equal(role, 'container');
  assert.ok(isContainerFact(fact));
  if (!isContainerFact(fact)) return;
  const ledgerKey = containerLedgerKey(W, D, at(5, 64, 5));
  assert.equal(fact.externalRef, ledgerKey);
  assert.equal(fact.ledgerRef, ledgerKey);
  assert.equal(fact.gone, false);
});

test('a farm tagged resource stays a station place, never a resource', () => {
  const node: HostSemanticNode = {
    id: 'farm-1', kind: 'place', tag: 'resource', label: 'farm: wheat', worldId: W, dim: D,
    location: { kind: 'region', center: at(10, 64, 10), radius: 3 }, observedAt: 3000, source: 'program',
    ...curio({ v: 2, type: 'farm', record: { crop: 'wheat', cells: [at(10, 64, 10), at(11, 64, 10)], plantedAt: 3000, harvests: 2 } }),
  };
  const { fact, role } = factOf(convertHostSemanticNode(node));
  assert.equal(role, 'farm');
  assert.ok(isPlaceFact(fact));
  assert.equal(isResourceFact(fact), false, 'metadata.curio.type wins over tag:"resource"');
  if (!isPlaceFact(fact)) return;
  assert.equal(fact.kind, 'station');
  assert.equal(fact.label, 'farm: wheat');
  assert.deepEqual(fact.location, { kind: 'area', center: at(10, 64, 10), radius: 3 }, 'area stays an area');
});

test('a single-cell farm stays exact; a multi-cell farm stays an area', () => {
  const exact = factOf(convertHostSemanticNode({
    id: 'farm-x', worldId: W, dim: D, location: { kind: 'exact', pos: at(1, 64, 1) }, observedAt: 10,
    ...curio({ type: 'farm', record: { crop: 'carrot', cells: [at(1, 64, 1)] } }),
  })).fact;
  assert.ok(isPlaceFact(exact));
  if (isPlaceFact(exact)) assert.deepEqual(exact.location, { kind: 'exact', pos: at(1, 64, 1) });

  const area = factOf(convertHostSemanticNode({
    id: 'farm-y', worldId: W, dim: D, observedAt: 10,
    ...curio({ type: 'farm', record: { crop: 'potato', cells: [at(0, 64, 0), at(2, 64, 0), at(0, 64, 2)] } }),
  })).fact;
  assert.ok(isPlaceFact(area));
  if (isPlaceFact(area)) {
    assert.equal(area.location.kind, 'area');
    if (area.location.kind === 'area') {
      assert.deepEqual(area.location.center, at(1, 64, 1));
      assert.ok(area.location.radius >= 1);
    }
  }
});

test('base and death nodes become matching place facts', () => {
  const base = factOf(convertHostSemanticNode({
    id: 'base-1', kind: 'place', tag: 'base', label: '主基地', worldId: W, dim: D,
    location: { kind: 'exact', pos: at(0, 64, 0) }, observedAt: 5000,
    ...curio({ v: 2, type: 'landmark', record: { kind: 'base', label: '主基地', primary: true } }),
  }));
  assert.equal(base.role, 'base');
  assert.ok(isPlaceFact(base.fact));
  if (isPlaceFact(base.fact)) {
    assert.equal(base.fact.kind, 'base');
    assert.equal(base.fact.label, '主基地');
    assert.equal(base.fact.observedAt, 5000);
  }

  const death = factOf(convertHostSemanticNode({
    id: 'death-1', kind: 'place', tag: 'death', label: 'death', worldId: W, dim: D,
    location: { kind: 'exact', pos: at(9, 20, 9) }, observedAt: 6000,
    ...curio({ v: 2, type: 'landmark', record: { kind: 'death', label: 'death' } }),
  }));
  assert.equal(death.role, 'death');
  if (isPlaceFact(death.fact)) assert.equal(death.fact.kind, 'death');
});

test('portal endpoints become portal place facts and preserve observed-vs-arrival provenance', () => {
  const arrived = factOf(convertHostSemanticNode({
    id: 'portal-1', kind: 'place', tag: 'portal', label: 'nether_portal', worldId: W, dim: 'the_nether',
    location: { kind: 'exact', pos: at(2, 70, 2) }, observedAt: 7000,
    ...curio({ v: 1, type: 'endpoint', record: { kind: 'nether_portal', portalObserved: false } }),
  }));
  assert.equal(arrived.role, 'portal');
  assert.ok(isPlaceFact(arrived.fact));
  if (isPlaceFact(arrived.fact)) {
    assert.equal(arrived.fact.kind, 'portal');
    assert.equal(arrived.fact.label, 'nether_portal');
    assert.equal(arrived.fact.source.source, PORTAL_ARRIVAL_SOURCE);
  }

  const observed = factOf(convertHostSemanticNode({
    id: 'portal-2', kind: 'place', tag: 'portal', label: 'end_portal', worldId: W, dim: 'the_end',
    location: { kind: 'exact', pos: at(3, 64, 3) }, observedAt: 7001,
    ...curio({ v: 1, type: 'endpoint', record: { kind: 'end_portal', portalObserved: true } }),
  }));
  if (isPlaceFact(observed.fact)) assert.equal(observed.fact.source.source, PORTAL_OBSERVED_SOURCE);
});

test('gone resources migrate as revoked anchors, not unknown', () => {
  const node: HostSemanticNode = {
    id: 'res-1', kind: 'place', tag: 'resource', label: 'iron_ore', worldId: W, dim: D,
    location: { kind: 'exact', pos: at(8, 40, 8) }, observedAt: 8000, gone: true, goneAt: 9000,
    ...curio({ v: 2, type: 'resource', record: { now: 'stone' } }),
  };
  const conversion = convertHostSemanticNode(node);
  assert.equal(conversion.kind, 'fact');
  if (conversion.kind !== 'fact' || !isResourceFact(conversion.fact)) return assert.fail('expected resource fact');
  assert.equal(conversion.fact.revoked, true);
  assert.equal(conversion.fact.revokedAt, 9000);
  assert.equal(conversion.fact.label, 'iron_ore');
  assert.equal(conversion.fact.observedAt, 8000);
});

test('gone containers migrate as gone container anchors, not unknown', () => {
  const node: HostSemanticNode = {
    id: 'chest-gone', kind: 'place', tag: 'resource', label: 'chest', worldId: W, dim: D,
    location: { kind: 'exact', pos: at(4, 64, 4) }, observedAt: 1000, gone: true, goneAt: 1100,
    externalRef: `${W}:${D}:4,64,4`,
    ...curio({ v: 2, type: 'container', record: { now: 'air' } }),
  };
  const conversion = convertHostSemanticNode(node);
  assert.equal(conversion.kind, 'fact', 'a gone container is a supported fact, not a gap');
  if (conversion.kind !== 'fact' || !isContainerFact(conversion.fact)) return assert.fail('expected container fact');
  assert.equal(conversion.fact.gone, true);
  assert.equal(conversion.fact.goneAt, 1100);
  assert.equal(conversion.fact.observedAt, 1000, 'shell observation time is not replaced by goneAt');
  assert.equal(conversion.fact.externalRef, `${W}:${D}:4,64,4`);
});

test('curio metadata is authoritative; unknown or incomplete nodes become explicit gaps', () => {
  const unknown = convertHostSemanticNode({
    id: 'x', kind: 'place', tag: 'resource', worldId: W, dim: D,
    location: { kind: 'exact', pos: at(1, 1, 1) }, observedAt: 1,
    ...curio({ type: 'mystery_role' }),
  });
  assert.equal(unknown.kind, 'gap');
  if (unknown.kind === 'gap') assert.equal(unknown.gap.reason, 'unclassifiable');

  const missingTime = convertHostSemanticNode({
    id: 'y', kind: 'place', tag: 'base', worldId: W, dim: D, location: { kind: 'exact', pos: at(1, 1, 1) },
  });
  assert.equal(missingTime.kind, 'gap');
  if (missingTime.kind === 'gap') assert.equal(missingTime.gap.reason, 'missing_observation');

  const inexactResource = convertHostSemanticNode({
    id: 'z', kind: 'place', tag: 'resource', worldId: W, dim: D,
    location: { kind: 'region', center: at(1, 1, 1), radius: 4 }, observedAt: 1,
  });
  assert.equal(inexactResource.kind, 'gap');
  if (inexactResource.kind === 'gap') assert.equal(inexactResource.gap.reason, 'inexact_location');
});

test('host migration reports route geometry separately and is idempotent on re-apply', () => {
  const nodes: HostSemanticNode[] = [
    {
      id: 'chest-1', kind: 'place', tag: 'resource', label: 'chest', worldId: W, dim: D,
      location: { kind: 'exact', pos: at(4, 64, 4) }, observedAt: 1234, externalRef: `${W}:${D}:4,64,4`,
      ...curio({ v: 2, type: 'container', record: { ts: 1234 } }),
    },
    {
      id: 'farm-1', kind: 'place', tag: 'resource', label: 'farm: wheat', worldId: W, dim: D,
      location: { kind: 'region', center: at(10, 64, 10), radius: 3 }, observedAt: 3000,
      ...curio({ v: 2, type: 'farm', record: { crop: 'wheat' } }),
    },
    {
      id: 'chest-gone', kind: 'place', tag: 'resource', label: 'chest', worldId: W, dim: D,
      location: { kind: 'exact', pos: at(5, 64, 5) }, observedAt: 1000, gone: true, goneAt: 1100,
      externalRef: `${W}:${D}:5,64,5`, ...curio({ v: 2, type: 'container' }),
    },
    { id: 'walk-node', kind: 'turn', source: 'program', worldId: W, dim: D, location: { kind: 'exact', pos: at(0, 64, 0) } },
    { id: 'nonsense', kind: 'place', tag: 'discovery', label: 'x', worldId: W, dim: D, location: { kind: 'exact', pos: at(1, 1, 1) } },
  ];
  const plan = planHostSemanticMigration(nodes, { worldId: W });
  assert.equal(plan.facts.length, 3);
  assert.equal(plan.report.migrated, 3);
  assert.equal(plan.report.skippedRoute, 1);
  assert.equal(plan.report.unknown, 1);
  assert.equal(plan.report.gone, 1);
  assert.deepEqual(plan.report.goneIds, ['chest-gone']);

  const port = createInMemoryHostFactsPort();
  const first = applyHostSemanticMigration(port, plan);
  assert.deepEqual(first, { inserted: 3, updated: 0, duplicate: 0, conflict: 0 });

  const second = applyHostSemanticMigration(port, plan);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicate, 3, 'replaying the same plan creates no new facts');

  const gone = port.containers({ includeGone: true }).items.find((fact) => fact.id === 'chest-gone');
  assert.equal(gone?.gone, true, 'container gone is retained in the port');
  assert.equal(port.containers().items.some((fact) => fact.id === 'chest-gone'), false);

  const rerun = planHostSemanticMigration(nodes, { worldId: W, existing: plan.facts });
  assert.equal(rerun.report.migrated, 0);
  assert.equal(rerun.report.duplicates, 3);
});

test('markContainerGone keeps the anchor shell and excludes it from default queries', () => {
  const port = createInMemoryHostFactsPort();
  const ledgerKey = containerLedgerKey(W, D, at(4, 64, 4));
  const fact = {
    id: 'chest-1', worldId: W, dim: D, pos: at(4, 64, 4), externalRef: ledgerKey, ledgerRef: ledgerKey,
    observedAt: 100, source: { source: 'program' }, gone: false,
  };
  assert.equal(port.upsertContainer(fact).outcome, 'inserted');
  const gone = port.markContainerGone('chest-1', { observedAt: 200, source: { source: 'program' } });
  assert.equal(gone.outcome, 'updated');
  assert.equal(gone.record.gone, true);
  assert.equal(gone.record.goneAt, 200);
  assert.equal(port.containers().items.length, 0);
  assert.equal(port.containers({ includeGone: true }).items.length, 1);
});

test('host conversion keeps business fields, role and real ledger key across reconstruction', () => {
  const { stores, containers } = semanticMemory(W);
  const furnace = factOf(convertHostSemanticNode({
    id: 'foreign-furnace-id', worldId: W, dim: D, observedAt: 20, externalRef: 'stable-object-id',
    location: { kind: 'exact', pos: at(5, 64, 5) }, label: 'workshop furnace',
    ...curio({ type: 'station', types: ['station', 'furnace'], block: 'blast_furnace', record: { block: 'blast_furnace' } }),
  })).fact;
  assert.ok(isContainerFact(furnace));
  if (!isContainerFact(furnace)) return;
  assert.equal(furnace.externalRef, 'stable-object-id');
  assert.equal(furnace.ledgerRef, containerLedgerKey(W, D, at(5, 64, 5)));
  assert.equal(furnace.hostData?.subtype, 'furnace');
  assert.deepEqual(furnace.hostData?.types, ['station', 'furnace']);
  stores.facts.upsertContainer(furnace);
  const reopened = memoryFrom(stores, containers, W).memory;
  assert.equal(reopened.chests(D).length, 0, 'a furnace is not projected as an unknown chest');
  reopened.forgetFurnace(D, at(5, 64, 5));
  assert.equal(stores.facts.containers({ worldId: W, includeGone: true }).items[0]?.gone, true);

  const farm = factOf(convertHostSemanticNode({
    id: 'legacy-field', worldId: W, dim: D, observedAt: 99, label: 'farm: wheat',
    location: { kind: 'region', center: at(10, 64, 10), radius: 2 },
    ...curio({ type: 'farm', record: { crop: 'wheat', cells: [at(10, 64, 10), at(11, 64, 10)], harvests: 4, plantedAt: 12 } }),
  })).fact;
  assert.ok(isPlaceFact(farm));
  if (!isPlaceFact(farm)) return;
  stores.facts.upsertPlace(farm);
  const migrated = memoryFrom(stores, containers, W).memory.farms()[0]!;
  assert.deepEqual(migrated.cells, [at(10, 64, 10), at(11, 64, 10)]);
  assert.equal(migrated.harvests, 4);
  assert.equal(migrated.plantedAt, 12);
});

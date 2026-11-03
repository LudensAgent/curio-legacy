import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReservationLedger, availableInventoryFor, craftReservationConflict, reservationsFor } from '../src/projects/reservations.ts';
import type { Project } from '../src/projects/types.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { materialReservations } from '../src/skills/reservations.ts';
import { build } from '../src/skills/build.ts';
import { EventBus } from '../src/events.ts';
import type { SkillCtx } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { SKILLS } from '../src/skills/index.ts';

function project(id: string, status: Project['status'] = 'deferred', revision = 1, worldId = 'fake-world'): Project {
  return { id, intentId: `intent-${id}`, title: id, status, revision, worldId, successCondition: { type: 'inventory_min', item: 'cobblestone', count: 16 }, milestones: [], currentMilestone: 0, noProgressAttempts: 0, pauseReasons: [], checkpoint: { ts: Date.now(), reason: 'test' }, createdAt: Date.now(), updatedAt: Date.now() };
}
const owner = (p: Project) => ({ worldId: p.worldId, projectId: p.id, revision: p.revision });
const context = (adapter: FakeAdapter, memory: WorldMemory, signal = new AbortController().signal): SkillCtx => ({ adapter, memory, signal, taskId: 'reservation-test', deadline: Date.now() + 10000, bus: new EventBus(), senses: { knownBlocks: () => [], perceivedEntities: () => [], refresh() {}, markSweep() {} }, progress() {} });

test('a failed project transaction cannot release its existing material allocation', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), planned = project('retained');
  memory.setWorld(adapter.worldId); memory.saveProject(planned);
  adapter.inv.set('cobblestone', 16);
  const ledger = reservationsFor(memory);
  ledger.reserve(owner(planned), [{ name: 'cobblestone', count: 16 }], adapter.state(), memory.projects());
  assert.throws(() => memory.transaction(() => {
    memory.saveProject({ ...planned, revision: 2 });
    throw new Error('later decision update rejected');
  }), /rejected/);
  assert.equal(memory.projects()[0].revision, 1);
  assert.equal(ledger.list()[0].revision, 1);
  assert.equal(ledger.list()[0].items[0].count, 16);
  memory.close();
});

test('reservation ledger protects actual inventory for deferred owners and own owner can use its allocation', () => {
  const adapter = new FakeAdapter(), ledger = new ReservationLedger(null), a = project('a'), b = project('b', 'active');
  adapter.inv.set('cobblestone', 20);
  ledger.reserve(owner(a), [{ name: 'cobblestone', count: 12 }], adapter.state(), [a, b]);
  assert.equal(ledger.query(adapter.state(), owner(b)).find((i) => i.name === 'cobblestone')!.available, 8);
  assert.equal(ledger.query(adapter.state(), owner(a)).find((i) => i.name === 'cobblestone')!.available, 20);
  assert.throws(() => ledger.reserve(owner(b), [{ name: 'cobblestone', count: 9 }], adapter.state(), [a, b]), /MISSING_UNRESERVED_MATERIALS/);
  ledger.reserve(owner(b), [{ name: 'cobblestone', count: 8 }], adapter.state(), [a, b]);
  assert.equal(ledger.query(adapter.state()).find((i) => i.name === 'cobblestone')!.available, 0);
  assert.equal(ledger.list().length, 2);
});

test('lost items produce explicit reservation deficits and stale chest contents never fund new reservations', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), ledger = new ReservationLedger(null), a = project('a');
  memory.setChest('overworld', { x: 1, y: 64, z: 1 }, [{ name: 'cobblestone', count: 999 }]);
  assert.throws(() => ledger.reserve(owner(a), [{ name: 'cobblestone', count: 1 }], adapter.state(), [a]), /实际背包仅 0/);
  adapter.inv.set('cobblestone', 10);
  ledger.reserve(owner(a), [{ name: 'cobblestone', count: 7 }], adapter.state(), [a]);
  adapter.inv.set('cobblestone', 2);
  const lost = ledger.query(adapter.state()).find((i) => i.name === 'cobblestone')!;
  assert.equal(lost.actual, 2);
  assert.equal(lost.available, 0);
  assert.equal(lost.reservationShortfall, 5);
  assert.equal(ledger.query(adapter.state(), owner(a)).find((i) => i.name === 'cobblestone')!.available, 2);
});

test('reservation quantities are bounded and allocation updates are atomic full-owner replacements', () => {
  const adapter = new FakeAdapter(), ledger = new ReservationLedger(null), a = project('a');
  adapter.inv.set('cobblestone', 20); adapter.inv.set('glass', 3);
  ledger.reserve(owner(a), [{ name: 'cobblestone', count: 10 }], adapter.state(), [a]);
  assert.throws(() => ledger.reserve(owner(a), [{ name: 'cobblestone', count: 8 }, { name: 'glass', count: 4 }], adapter.state(), [a]));
  assert.deepEqual(ledger.list()[0].items, [{ name: 'cobblestone', count: 10 }]);
  ledger.reserve(owner(a), [{ name: 'glass', count: 2 }], adapter.state(), [a]);
  assert.deepEqual(ledger.list()[0].items, [{ name: 'glass', count: 2 }]);
  assert.throws(() => ledger.reserve(owner(a), [{ name: 'glass', count: 0 }], adapter.state(), [a]));
  assert.throws(() => ledger.reserve(owner(a), [{ name: 'glass', count: 2305 }], adapter.state(), [a]));
  assert.equal(ledger.release(owner(a), ['glass']), 1);
  assert.deepEqual(ledger.list(), []);
});

test('old revisions, closed or missing projects release while paused/deferred projects retain allocations', () => {
  const adapter = new FakeAdapter(), ledger = new ReservationLedger(null), a = project('a'), b = project('b', 'paused');
  adapter.inv.set('glass', 20);
  ledger.reserve(owner(a), [{ name: 'glass', count: 3 }], adapter.state(), [a, b]);
  ledger.reserve(owner(b), [{ name: 'glass', count: 3 }], adapter.state(), [a, b]);
  assert.equal(ledger.reconcile([a, b]), 0);
  a.revision++;
  assert.equal(ledger.reconcile([a, b]), 1);
  b.status = 'completed';
  assert.equal(ledger.reconcile([a, b]), 1);
  assert.deepEqual(ledger.list(), []);
  assert.throws(() => ledger.reserve({ ...owner(a), revision: 1 }, [{ name: 'glass', count: 1 }], adapter.state(), [a, b]), /失效/);
});

test('reservation storage reloads from DATA_DIR and remains isolated across worlds', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reservations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledger = new ReservationLedger(directory), adapter = new FakeAdapter(), a = project('a');
  adapter.inv.set('glass', 5);
  ledger.reserve(owner(a), [{ name: 'glass', count: 3 }], adapter.state(), [a]);
  const reopened = new ReservationLedger(directory);
  assert.equal(reopened.query(adapter.state()).find((i) => i.name === 'glass')!.available, 2);
  adapter.worldId = 'another-world';
  assert.equal(reopened.query(adapter.state()).find((i) => i.name === 'glass')!.available, 5);
  assert.throws(() => reopened.reserve(owner(a), [{ name: 'glass', count: 1 }], adapter.state(), [a]), /同一世界/);
  assert.equal(fs.existsSync(path.join(directory, 'material-reservations.json')), true);
});

test('runtime available inventory and conservative craft proof protect other owners including auto ingredients', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), a = project('a'), b = project('b', 'active');
  memory.setWorld(adapter.worldId); memory.saveProject(a); memory.saveProject(b);
  adapter.inv.set('cobblestone', 10);
  const ledger = reservationsFor(memory);
  ledger.reserve(owner(a), [{ name: 'cobblestone', count: 8 }], adapter.state(), memory.projects());
  assert.equal(availableInventoryFor(memory, adapter.state()).find((i) => i.name === 'cobblestone')!.count, 2);
  assert.equal(craftReservationConflict(memory, adapter.state(), 'stone_pickaxe', 1, '1.20.1')!.item, 'cobblestone');
  adapter.inv.set('cobblestone', 11);
  assert.equal(craftReservationConflict(memory, adapter.state(), 'stone_pickaxe', 1, '1.20.1'), null);
  ledger.release(owner(a)); adapter.inv.set('oak_log', 1);
  ledger.reserve(owner(a), [{ name: 'oak_log', count: 1 }], adapter.state(), memory.projects());
  assert.equal(craftReservationConflict(memory, adapter.state(), 'wooden_pickaxe', 1, '1.20.1')!.item, 'oak_log');
});

test('build preflight cannot spend another deferred project reserve and cancelled ledger skills never write', async () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), a = project('a'), b = project('b', 'active');
  memory.setWorld(adapter.worldId); memory.saveProject(a); memory.saveProject(b);
  adapter.inv.set('cobblestone', 200); adapter.inv.set('glass', 3); adapter.inv.set('oak_door', 1);
  reservationsFor(memory).reserve(owner(a), [{ name: 'cobblestone', count: 190 }], adapter.state(), memory.projects());
  const validated = build.validate({ blueprint: 'hut', prefab: true, rotation: 0, origin: { x: 3, y: 64, z: 3 } }, adapter);
  assert.equal(validated.ok, true);
  if (validated.ok) {
    const result = await build.run(context(adapter, memory), validated.args);
    assert.equal(result.failureCode, 'MISSING_MATERIALS');
    assert.ok((result.data!.missingMaterials as Record<string, number>).cobblestone > 0);
    // 料不全时会先用自己能用的那部分开工，但别的工程预留的 190 块一块不动
    assert.ok((adapter.inv.get('cobblestone') ?? 0) >= 190, `预留的圆石被动了：剩 ${adapter.inv.get('cobblestone')}`);
  }
  const signal = new AbortController(); signal.abort();
  const before = reservationsFor(memory).list();
  await assert.rejects(materialReservations.run(context(adapter, memory, signal.signal), { operation: 'release', projectId: a.id, revision: a.revision }));
  assert.deepEqual(reservationsFor(memory).list(), before);
});

test('nested methods cannot bypass reservation guards with raw adapter craft/place, while the owner can spend', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), a = project('a'), b = project('b', 'active');
  memory.setWorld(adapter.worldId); memory.saveProject(a); memory.saveProject(b);
  adapter.inv.set('cobblestone', 4);
  reservationsFor(memory).reserve(owner(a), [{ name: 'cobblestone', count: 4 }], adapter.state(), memory.projects());
  const arbiter = new Arbiter(adapter, memory, new EventBus(), context(adapter, memory).senses);
  SKILLS.test_reserved_nested = {
    name: 'test_reserved_nested', description: 'nested primitive fixture', argsDoc: '{}', timeoutMs: 5000, movement: false,
    validate: (raw: any) => ({ ok: true, args: { operation: raw.operation } }),
    async run(ctx, args) {
      // 用 actionAdapter 调原始动作，才会经过仲裁器的预留守卫（ctx.adapter 只做 make 授权）
      if (args.operation === 'craft') await ctx.actionAdapter.craft('stone_pickaxe', 1, ctx.signal);
      else await ctx.actionAdapter.placeBlockAt({ x: 2, y: 64, z: 2 }, ['cobblestone'], ctx.signal);
      return { status: 'succeeded', summary: 'raw adapter call finished' };
    },
  };
  t.after(() => { delete SKILLS.test_reserved_nested; });
  const run = async (operation: string) => {
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    const started = arbiter.start({ skill: 'test_reserved_nested', args: { operation } }, 'llm');
    assert.ok(!('error' in started));
    return (await done).result;
  };
  assert.equal((await run('craft')).status, 'failed');
  assert.equal((await run('place')).status, 'failed');
  assert.ok(!adapter.actions.some((action) => /^(place|craft):/.test(action)));
  b.status = 'deferred'; memory.saveProject(b); a.status = 'active'; memory.saveProject(a);
  assert.equal((await run('craft')).status, 'succeeded');
  assert.equal((await run('place')).status, 'succeeded');
  assert.equal(adapter.inv.get('cobblestone'), 3);
});

test('useBucketAt cannot consume another project reserved bucket, owner can', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), a = project('a'), b = project('b', 'active');
  memory.setWorld(adapter.worldId); memory.saveProject(a); memory.saveProject(b);
  adapter.inv.set('water_bucket', 2);
  reservationsFor(memory).reserve(owner(a), [{ name: 'water_bucket', count: 2 }], adapter.state(), memory.projects());
  const arbiter = new Arbiter(adapter, memory, new EventBus(), context(adapter, memory).senses);
  SKILLS.test_reserved_bucket = {
    name: 'test_reserved_bucket', description: 'bucket reservation fixture', argsDoc: '{}', timeoutMs: 5000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      await ctx.actionAdapter.useBucketAt({ x: 0, y: 64, z: 2 }, 'water_bucket', ctx.signal);
      return { status: 'succeeded', summary: 'bucket poured' };
    },
  };
  t.after(() => { delete SKILLS.test_reserved_bucket; });
  const run = () => new Promise<TaskOutcome>((resolve) => {
    arbiter.once('done', resolve);
    const started = arbiter.start({ skill: 'test_reserved_bucket', args: {} }, 'llm');
    assert.ok(!('error' in started));
  });
  assert.equal((await run()).result.status, 'failed', '别的项目预留的水桶不能被 useBucketAt 消耗');
  assert.equal(adapter.inv.get('water_bucket'), 2, '预留的水桶没被消耗');
  b.status = 'deferred'; memory.saveProject(b); a.status = 'active'; memory.saveProject(a);
  assert.equal((await run()).result.status, 'succeeded', 'owner 可以用自己的水桶');
  assert.equal(adapter.inv.get('water_bucket'), 1);
});

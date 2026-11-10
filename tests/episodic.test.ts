import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { EventBus } from '../src/events.ts';
import { EpisodicMemory } from '../src/memory/episodic.ts';
import { MemoryRequestError } from '../src/memory/hindsight.ts';
import { readMemoryRegistry, registerMemoryBackend, unregisterMemoryBackend } from '../src/memory/registry.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { MemoryBackend, MemoryEntry, MemoryEpisode, MemorySettings, RecallRequest } from '../src/memory/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for memory worker');
    await pause(5);
  }
}
const settings = (extra: Partial<MemorySettings> = {}): MemorySettings => ({
  provider: 'hindsight', worldId: 'fake-world', agentId: 'Curio', baseUrl: 'http://127.0.0.1:8888',
  apiKey: 'never-save-this-key', bankId: 'mc-test', timeoutMs: 20, retainTimeoutMs: 30, maxContextBytes: 1200, ...extra,
});
const context = () => ({ percept: { self: { dim: 'overworld', pos: [0, 64, 0] as [number, number, number] },
  objective: 'build a portal', nearby: { resources: ['obsidian'] } }, lastFailure: null as unknown, userSuggestion: null as string | null });
class Backend implements MemoryBackend {
  retained: MemoryEpisode[] = [];
  recalled: RecallRequest[] = [];
  retainImpl: (episode: MemoryEpisode, signal: AbortSignal) => Promise<void> = async () => {};
  recallImpl: (request: RecallRequest, signal: AbortSignal) => Promise<MemoryEntry[]> = async () => [];
  async retain(episode: MemoryEpisode, signal: AbortSignal) { this.retained.push(episode); await this.retainImpl(episode, signal); }
  async recall(request: RecallRequest, signal: AbortSignal) { this.recalled.push(request); return this.recallImpl(request, signal); }
  async clear() {}
}
function setup(t: TestContext, config: MemorySettings = settings(), backend = new Backend()) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-episodic-'));
  const memory = new WorldMemory(null);
  (memory as WorldMemory & { setWorld?: (worldId: string) => void }).setWorld?.('fake-world');
  const bus = new EventBus();
  const adapter = new FakeAdapter();
  const service = new EpisodicMemory(config, memory, bus, () => adapter.state(), dataDir, backend);
  const services = [service];
  t.after(() => { for (const s of services) s.stop(); memory.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, memory, bus, adapter, service, backend, config, services };
}

test('episodic: only meaningful events are retained and model interpretations remain inferences', async (t) => {
  const x = setup(t);
  x.backend.retainImpl = async () => {
    assert.deepEqual(readMemoryRegistry(x.dataDir), [{ baseUrl: x.config.baseUrl, bankId: x.config.bankId }]);
  };
  x.service.start();
  for (const type of ['tick', 'hurt', 'chat', 'memory_status']) x.bus.publish(type, 'P3', 'irrelevant');
  for (const type of ['discovery', 'death', 'attempt_end', 'goal_end', 'built', 'lesson', 'objective', 'skill_learned']) x.bus.publish(type, 'P2', type);
  await until(() => x.service.snapshot().queued === 0 && x.backend.retained.length === 8);
  assert.deepEqual(x.backend.retained.map((e) => [e.source, e.kind]), [
    ['discovery', 'experience'], ['death', 'experience'], ['attempt_end', 'experience'], ['goal_end', 'experience'], ['built', 'experience'],
    ['lesson', 'inference'], ['objective', 'inference'], ['skill_learned', 'inference'],
  ]);
  assert.ok(x.backend.retained.every((e) => e.worldId === 'fake-world' && e.dimension === 'overworld'));
  assert.equal(new Set(x.backend.retained.map((e) => e.id)).size, 8);
  const registry = fs.readFileSync(path.join(x.dataDir, 'memory', 'backends.json'), 'utf8');
  assert.ok(!registry.includes(x.config.apiKey));
});

test('episodic: associative local recall finds older relevant memories and scopes spatial records', async (t) => {
  const x = setup(t, settings({ provider: 'local' }));
  x.memory.addNote('fact', 'portal lava needs careful obsidian footing');
  for (let i = 0; i < 20; i++) x.memory.addNote('fact', `unrelated farming wheat ${i}`);
  x.memory.recordGoal({ goal: 'portal repair', goalType: 'build', source: 'llm', status: 'failed', summary: 'lava blocked the portal' });
  x.memory.addLandmark('resource', 'obsidian portal', 'overworld', { x: 10, y: 64, z: 0 });
  x.memory.addLandmark('resource', 'portal lava secret', 'the_nether', { x: 20, y: 64, z: 0 });
  x.service.start();
  x.bus.publish('lesson', 'P2', 'portal lava danger remains a hypothesis until observed');
  const c = context();
  c.userSuggestion = 'try the old portal again';
  c.lastFailure = { code: 'lava', summary: 'portal approach blocked' };
  const recalled = await x.service.recall(c);
  assert.equal(recalled.source, 'local');
  assert.ok(recalled.memories.some((e) => e.text.includes('careful obsidian')));
  assert.ok(recalled.memories.some((e) => e.kind === 'inference'));
  assert.ok(recalled.memories.some((e) => e.source.endsWith('goal_end')));
  assert.ok(!JSON.stringify(recalled.memories).includes('the_nether'));
  assert.ok(!JSON.stringify(recalled.memories).includes('unrelated farming'));
  assert.equal(x.backend.recalled.length, 0);
  assert.equal(x.backend.retained.length, 0);
});

test('episodic: configured recall path drops know_how mirror lessons but keeps independent observations', async (t) => {
  const x = setup(t, settings({ provider: 'local' }));
  x.memory.addLesson('卡住时向上开巷', { source: 'model', key: 'know_how:k_deleted' });
  x.memory.addLesson('河对岸有露天铁矿', { source: 'observed' });
  const recalled = await x.service.recall(context(), '卡住时向上开巷 河对岸 铁矿');
  assert.equal(recalled.source, 'local');
  assert.ok(!JSON.stringify(recalled.memories).includes('卡住时向上开巷'), '被删除/合并的 know_how 镜像不能经 recall 服务入口重新出现');
  const observation = recalled.memories.find((entry) => entry.text.includes('河对岸有露天铁矿'));
  assert.ok(observation, '独立真实观察保留');
  assert.equal(observation.kind, 'experience');
  assert.match(observation.source, /observed/);
});

test('episodic: events without a known dimension stay local and cannot contaminate a remote scope', async (t) => {
  const x = setup(t);
  x.adapter.dim = 'unknown';
  x.service.start();
  x.bus.publish('death', 'P0', 'dimension was not available during disconnection');
  await pause();
  assert.equal(x.service.snapshot().archived, 1);
  assert.equal(x.service.snapshot().queued, 0);
  assert.equal(x.backend.retained.length, 0);
  assert.equal((await x.service.recall(context())).memories.length, 0);
});

test('episodic: remote recall uses intent, failures, suggestions and resources with a complete JSON byte budget', async (t) => {
  const x = setup(t, settings({ maxContextBytes: 512 }));
  x.backend.recallImpl = async () => [{ id: 'x'.repeat(500), text: '下界传送门失败的教训'.repeat(500), source: 's'.repeat(500), observedAt: 'date'.repeat(200), kind: 'inference'.repeat(50) }];
  x.service.start();
  const c = context();
  c.lastFailure = { code: 'missing_material' };
  c.userSuggestion = 'consider the old home';
  const recalled = await x.service.recall(c);
  assert.equal(recalled.source, 'hindsight');
  assert.match(x.backend.recalled[0].query, /build a portal/);
  assert.match(x.backend.recalled[0].query, /old home/);
  assert.match(x.backend.recalled[0].query, /missing_material/);
  assert.match(x.backend.recalled[0].query, /obsidian/);
  assert.ok(Buffer.byteLength(JSON.stringify(recalled), 'utf8') <= 512);
});

test('episodic: an unavailable or uncooperative backend times out and recalls locally without request floods', async (t) => {
  const x = setup(t);
  x.memory.addNote('fact', 'the portal was blocked by lava');
  let aborted = false;
  x.backend.recallImpl = (_request, signal) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  };
  x.service.start();
  const started = Date.now();
  const results = await Promise.all([x.service.recall(context()), x.service.recall(context())]);
  assert.ok(Date.now() - started < 500);
  assert.ok(aborted);
  assert.ok(results.every((r) => r.source === 'local' && r.memories.some((e) => e.text.includes('lava'))));
  await x.service.recall(context());
  assert.equal(x.backend.recalled.length, 1);
});

test('episodic: degraded recall logs backend, elapsed, error type/status, hits and selected IDs without response bodies', async (t) => {
  const x = setup(t);
  x.memory.addNote('fact', 'the portal was blocked by lava near home');
  x.backend.recallImpl = async () => { throw new MemoryRequestError('Hindsight recall failed (HTTP 503)', 'HindsightError', 503); };
  x.service.start();
  const result = await x.service.recall(context());
  assert.equal(result.source, 'local');
  assert.ok(result.memories.some((e) => e.text.includes('blocked by lava')));
  const recall = x.bus.recent().filter((e) => e.type === 'memory_recall').at(-1);
  assert.ok(recall);
  assert.equal(recall.data?.backend, 'local');
  assert.equal(recall.data?.degraded, true);
  assert.equal(recall.data?.errorType, 'HindsightError');
  assert.equal(recall.data?.status, 503);
  assert.equal(recall.data?.requestId, null);
  assert.equal(typeof recall.data?.durationMs, 'number');
  assert.equal(recall.data?.hits, result.memories.length);
  assert.deepEqual(recall.data?.selectedIds, result.memories.map((e) => e.id));
  assert.ok(Array.isArray(recall.data?.dropped));
  const warning = x.bus.recent().filter((e) => e.type === 'memory_status').at(-1);
  assert.ok(warning);
  assert.match(warning.msg, /记忆检索暂不可用；使用当前情境相关的本地回忆/);
  assert.match(warning.msg, /backend=local/);
  assert.match(warning.msg, /requestId=missing/);
  assert.match(warning.msg, /error=HindsightError status=503/);
  assert.ok(!JSON.stringify([recall, warning]).includes(x.config.apiKey));
  assert.ok(!JSON.stringify([recall, warning]).includes('sensitive-server-value'));
});

test('episodic: successful recall diagnostics keep hits, selected IDs and trim reasons but never memory text', async (t) => {
  const x = setup(t, settings({ maxContextBytes: 2000 }));
  x.backend.recallImpl = async (request) => {
    request.onRequestId?.('req-42');
    return [
      { id: 'portal-note', text: 'portal lava evidence', source: 'experience' },
      { id: 7 as unknown as string, text: 'invalid id', source: 'experience' },
      { id: 'gate-note', text: 'gate evidence', source: 'experience' },
    ];
  };
  x.service.start();
  const result = await x.service.recall(context());
  assert.equal(result.source, 'hindsight');
  assert.deepEqual(result.memories.map((e) => e.id), ['portal-note', 'gate-note']);
  const recall = x.bus.recent().filter((e) => e.type === 'memory_recall').at(-1);
  assert.ok(recall);
  assert.equal(recall.data?.backend, 'hindsight');
  assert.equal(recall.data?.degraded, false);
  assert.equal(recall.data?.requestId, 'req-42');
  assert.equal(recall.data?.hits, 3);
  assert.deepEqual(recall.data?.selectedIds, ['portal-note', 'gate-note']);
  assert.ok((recall.data?.dropped as string[]).includes('invalid'));
  assert.ok(!JSON.stringify(recall.data).includes('portal lava evidence'));
});

test('episodic: a timed-out recall is classified as a timeout in diagnostics', async (t) => {
  const x = setup(t);
  x.backend.recallImpl = () => new Promise(() => {});
  x.service.start();
  const result = await x.service.recall(context());
  assert.equal(result.source, 'local');
  const recall = x.bus.recent().filter((e) => e.type === 'memory_recall').at(-1);
  assert.ok(recall);
  assert.equal(recall.data?.degraded, true);
  assert.equal(recall.data?.errorType, 'Timeout');
  assert.equal(recall.data?.status, null);
});

test('episodic: a successful contextual recall does not suppress an immediate different explicit question', async (t) => {
  const x = setup(t);
  x.backend.recallImpl = async (request) => [{ id: 'answer', text: request.query, source: 'experience' }];
  x.service.start();
  assert.equal((await x.service.recall(context())).source, 'hindsight');
  assert.equal((await x.service.recall(context(), 'where did the last expedition fail?')).source, 'hindsight');
  assert.equal(x.backend.recalled.length, 2);
  assert.match(x.backend.recalled[1].query, /last expedition fail/);
});

test('episodic: durable outbox retries with exponential backoff and survives process restart', async (t) => {
  const x = setup(t);
  x.backend.retainImpl = async () => { throw new Error('offline'); };
  x.service.start();
  x.bus.publish('death', 'P0', 'died in lava');
  await until(() => x.backend.retained.length === 1 && x.service.snapshot().queued === 1);
  await pause(50);
  assert.equal(x.backend.retained.length, 1);
  const outboxFile = path.join(x.dataDir, 'memory', fs.readdirSync(path.join(x.dataDir, 'memory')).find((f) => f.startsWith('outbox-'))!);
  const saved = JSON.parse(fs.readFileSync(outboxFile, 'utf8'));
  assert.equal(saved.items[0].attempts, 1);
  assert.ok(saved.items[0].nextAttemptAt > Date.now());
  assert.equal(x.bus.recent().filter((e) => e.type === 'memory_status').length, 1);
  x.service.stop();
  // Move the persisted deadline into the past to exercise startup retry without waiting a full second.
  saved.items[0].nextAttemptAt = 0;
  fs.writeFileSync(outboxFile, JSON.stringify(saved));
  const backend2 = new Backend();
  const service2 = new EpisodicMemory(x.config, x.memory, x.bus, () => x.adapter.state(), x.dataDir, backend2);
  x.services.push(service2);
  service2.start();
  await until(() => backend2.retained.length === 1 && service2.snapshot().queued === 0);
  assert.equal(backend2.retained[0].id, x.backend.retained[0].id);
  assert.equal(JSON.parse(fs.readFileSync(outboxFile, 'utf8')).items.length, 0);
  assert.ok(!fs.readFileSync(outboxFile, 'utf8').includes(x.config.apiKey));
});

test('episodic: stop aborts in-flight writes, preserves the outbox, and ignores late results', async (t) => {
  const x = setup(t, settings({ retainTimeoutMs: 1000 }));
  let release!: () => void;
  let aborted = false;
  x.backend.retainImpl = (_episode, signal) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise((resolve) => { release = resolve; });
  };
  x.service.start();
  x.bus.publish('built', 'P2', 'built a portal');
  await until(() => x.backend.retained.length === 1);
  x.service.stop();
  assert.ok(aborted);
  assert.equal(x.bus.listenerCount('event'), 0);
  x.bus.publish('death', 'P0', 'must not be retained after stop');
  const backend2 = new Backend();
  const service2 = new EpisodicMemory(x.config, x.memory, x.bus, () => x.adapter.state(), x.dataDir, backend2);
  x.services.push(service2);
  service2.start();
  await until(() => backend2.retained.length === 1 && service2.snapshot().queued === 0);
  release();
  await pause(30);
  assert.equal(backend2.retained.length, 1);
  assert.equal(service2.snapshot().queued, 0);
  const local = await service2.recall(context());
  assert.ok(local.memories.some((e) => e.text.includes('built a portal')));
});

test('episodic: archive remains available locally after restarts and provider changes', async (t) => {
  const x = setup(t, settings({ provider: 'local' }));
  x.service.start();
  x.bus.publish('discovery', 'P2', 'found obsidian near the portal');
  x.service.stop();
  const restored = new EpisodicMemory(x.config, x.memory, x.bus, () => x.adapter.state(), x.dataDir);
  x.services.push(restored);
  const recalled = await restored.recall(context());
  assert.ok(recalled.memories.some((e) => e.text.includes('found obsidian')));
  assert.equal(readMemoryRegistry(x.dataDir).length, 0);
});

test('episodic: logical save scope differs from connection identity and legacy places do not supply coordinates', async (t) => {
  const x = setup(t, settings({ provider: 'local', worldId: 'save-alpha' }));
  x.memory.recentNotes = () => [
    { ts: Date.now(), kind: 'fact', text: 'portal from this logical save', worldId: 'save-alpha' },
    { ts: Date.now(), kind: 'fact', text: 'portal from old physical server', worldId: 'fake-world' },
  ];
  x.memory.landmarks = () => [{ id: 'old', kind: 'resource', label: 'portal from legacy map', dim: 'overworld',
    pos: { x: 111, y: 222, z: 333 }, ts: Date.now() }];
  x.service.start();
  x.bus.publish('discovery', 'P2', 'found portal in this save');
  const recalled = await x.service.recall(context());
  assert.ok(recalled.memories.some((e) => e.text.includes('found portal in this save')));
  assert.ok(recalled.memories.some((e) => e.text.includes('this logical save')));
  assert.ok(!recalled.memories.some((e) => e.text.includes('old physical server')));
  const place = recalled.memories.find((e) => e.id === 'landmark:old');
  assert.equal(place?.kind, 'inference');
  assert.equal(place?.source, 'legacy:landmark');
  assert.ok(!place?.text.includes('111'));
  const archive = fs.readdirSync(path.join(x.dataDir, 'memory')).find((f) => f.startsWith('episodes-'))!;
  const episode = JSON.parse(fs.readFileSync(path.join(x.dataDir, 'memory', archive), 'utf8').trim());
  assert.equal(episode.worldId, 'save-alpha');
});

test('episodic: archive keeps a bounded local working set while preserving complete history on disk', async (t) => {
  const x = setup(t, settings({ provider: 'local' }));
  x.service.start();
  x.bus.publish('discovery', 'P2', 'initialize archive');
  x.service.stop();
  const archive = path.join(x.dataDir, 'memory', fs.readdirSync(path.join(x.dataDir, 'memory')).find((f) => f.startsWith('episodes-'))!);
  const episodes = Array.from({ length: 2005 }, (_, i) => ({ id: `episode-${i}`, ts: Date.now() + i,
    worldId: 'fake-world', dimension: 'overworld', kind: 'experience', source: 'discovery', text: `portal evidence ${i}` }));
  fs.writeFileSync(archive, episodes.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const restored = new EpisodicMemory(x.config, x.memory, x.bus, () => x.adapter.state(), x.dataDir);
  x.services.push(restored);
  assert.equal(restored.snapshot().archived, 2000);
  assert.equal(fs.readFileSync(archive, 'utf8').trim().split('\n').length, 2005);
  const recalled = await restored.recall(context(), 'portal evidence 2004');
  assert.ok(recalled.memories.some((e) => e.id === 'episode-2004'));
});

test('memory registry: identities are deduplicated, survive provider changes, and cannot contain endpoint credentials', (t) => {
  const x = setup(t, settings({ provider: 'local' }));
  registerMemoryBackend(x.dataDir, { baseUrl: 'http://localhost:8888/', bankId: 'mc-1' });
  registerMemoryBackend(x.dataDir, { baseUrl: 'http://localhost:8888', bankId: 'mc-1' });
  registerMemoryBackend(x.dataDir, { baseUrl: 'http://localhost:8888', bankId: 'mc-2' });
  assert.equal(readMemoryRegistry(x.dataDir).length, 2);
  unregisterMemoryBackend(x.dataDir, { baseUrl: 'http://localhost:8888///', bankId: 'mc-1' });
  assert.deepEqual(readMemoryRegistry(x.dataDir), [{ baseUrl: 'http://localhost:8888', bankId: 'mc-2' }]);
  assert.throws(() => registerMemoryBackend(x.dataDir, { baseUrl: 'http://user:secret@localhost', bankId: 'mc-3' }));
  assert.throws(() => registerMemoryBackend(x.dataDir, { baseUrl: 'http://localhost?key=secret', bankId: 'mc-3' }));
});

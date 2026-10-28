import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { EpisodicMemory } from '../src/memory/episodic.ts';
import { recallText } from '../src/memory/recollection.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { MemoryBackend, MemoryEntry, MemoryEpisode, MemorySettings } from '../src/memory/types.ts';
import { buildMindMessages, buildReflectionMessages, type MindContext } from '../src/mind/prompt.ts';
import { recallLocal } from '../src/mind/recall.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { rememberPlace } from '../src/skills/observation.ts';
import { dashboardMemory } from '../src/observer/memory-snapshot.ts';
import { findStation } from '../src/skills/stations.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const pos = { x: 123, y: 67, z: -234 };

test('historical container prose is scoped, fuzzy and idempotent without changing stored observations', (t) => {
  const memory = new WorldMemory(null), now = Date.now(), ts = now - 121_000;
  t.after(() => memory.close());
  memory.setWorld('w');
  memory.noteChestUse('overworld', pos, { put: [{ name: 'diamond', count: 64 }], now: ts });
  const text = `往箱子 (123,67,-234) 放过 diamond×64 @ overworld 123,67,-234\n{"container":"chest","pos":{"x":123,"y":67,"z":-234},"items":[{"name":"diamond","count":64}]}`;
  const projected = recallText(text, memory, 'overworld', ts, now);
  assert.match(projected, /区域/);
  assert.match(projected, /不少/);
  assert.doesNotMatch(projected, /123,67,-234|"x":123|diamond×64|"count":64/);
  assert.equal(recallText(projected, memory, 'overworld', ts, now), projected);
  const otherDimension = recallText(text, memory, 'the_end', ts, now);
  assert.doesNotMatch(otherDimension, /123,67,-234|"x":123/);
  assert.equal(otherDimension, recallText(text, { chests: () => [], landmarks: () => [] }, 'the_end', ts, now),
    'unknown local containers still lose historical precision without borrowing another dimension record');
  assert.deepEqual(memory.chests()[0].pos, pos);
  assert.equal(memory.chests()[0].ts, ts);
});

test('mixed historical facts retain resource locations and quantities beside a container fact', () => {
  const memory = { chests: () => [], landmarks: () => [] }, now = Date.now(), ts = now - 121_000;
  const resource = '铁矿 (80,10,80) @ overworld 80,10,80 iron_ore×32 {"name":"iron_ore","count":32}';
  const container = '箱子 (123,67,-234) @ overworld 123,67,-234 diamond×64 {"name":"diamond","count":64}';
  ['；', ';', '。', '\n', '. '].flatMap((separator) => [
    `${resource}${separator}${container}`, `${container}${separator}${resource}`,
  ]).forEach((text) => {
    const projected = recallText(text, memory, 'overworld', ts, now);
    assert.ok(projected.includes(resource), `resource evidence changed in ${JSON.stringify(text)}`);
    assert.match(projected, /历史容器区域/);
    assert.doesNotMatch(projected, /123,67,-234|diamond×64|"count":64/);
    assert.equal(recallText(projected, memory, 'overworld', ts, now), projected);
  });
});

test('English container quantities use registered item names and display names', () => {
  const memory = { chests: () => [], landmarks: () => [] }, now = Date.now(), ts = now - 121_000;
  ['Chest', 'chests', 'BARREL', 'barrels', 'Shulker Box', 'Shulker Boxes', 'red_shulker_box',
    'light_blue_shulker_box', 'trapped_chest', 'Ender_Chest', '潜影盒'].forEach((container) => {
    const text = container + ' at (123,67,-234) held granite 64, 64 cobblestone, 32 iron ingots, minecraft:diamond 16 and 12 Torches';
    const projected = recallText(text, memory, 'overworld', ts, now);
    assert.match(projected, /历史容器区域/);
    assert.match(projected, /granite（不少，历史印象）/);
    assert.match(projected, /cobblestone（不少，历史印象）/);
    assert.match(projected, /iron ingots（不少，历史印象）/);
    assert.doesNotMatch(projected, /123,67,-234|granite 64|64 cobblestone|32 iron ingots|diamond 16|12 Torches/);
    assert.equal(recallText(projected, memory, 'overworld', ts, now), projected);
  });
});

test('English item quantities do not turn chestplates, dates or other numbers into container inventory', () => {
  const memory = { chests: () => [], landmarks: () => [] }, now = Date.now(), ts = now - 121_000;
  [
    'I wore a diamond_chestplate at (123,67,-234), with 32 iron ingots and granite 64',
    'A Chestplate at (123,67,-234) had durability 64',
    'Chest record 2026-10-28 at 12:34:56, version 1.20.1, 64 attempts and 32 metres',
    'Chest dated granite 2026-10-28, iron_ingot 32.5, Clock 12:34:56 and 1,024 cobblestone',
  ].forEach((text) => assert.equal(recallText(text, memory, 'overworld', ts, now), text));
});

test('English mixed facts keep resource evidence precise while container quantities become impressions', () => {
  const memory = { chests: () => [], landmarks: () => [] }, now = Date.now(), ts = now - 121_000;
  const resource = 'Iron ore at (80,10,80), 32 iron_ore and granite 64';
  const container = 'Chest at (123,67,-234) held 32 iron ingots and 64 cobblestone';
  [';', '. ', '\n'].flatMap((separator) => [resource + separator + container, container + separator + resource]).forEach((text) => {
    const projected = recallText(text, memory, 'overworld', ts, now);
    assert.ok(projected.includes(resource));
    assert.match(projected, /历史容器区域/);
    assert.doesNotMatch(projected, /123,67,-234|32 iron ingots|64 cobblestone/);
  });
});

test('old container locations do not leak through recall, dashboard or station name navigation', (t) => {
  const world = new TestWorld(), memory = new WorldMemory(null), ts = Date.now() - 121_000;
  t.after(() => memory.close());
  memory.setWorld(world.worldId);
  const landmark = memory.addLandmark('discovery', '我的箱子', world.dim, pos)!;
  landmark.ts = ts;
  memory.noteChestUse(world.dim, pos, { put: [{ name: 'diamond', count: 32 }], now: ts });
  const recalled = recallLocal('我的箱子', { self: new SelfModel(null), memory });
  assert.ok(recalled.some((entry) => entry.kind === 'place'));
  assert.doesNotMatch(JSON.stringify(recalled), /123,67,-234|"x":123/);
  const snapshot = dashboardMemory(memory, world.state(), null);
  assert.equal(snapshot.chests[0].precise, false);
  assert.equal(snapshot.landmarks[0].precise, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /"x":123/);
  const ctx = makeCtx(world, { memory, senses: { knownBlocks: () => [], observeBlocks: () => [] } });
  const station = findStation(ctx, ['chest'], 500);
  assert.ok(station);
  assert.equal(station.radius, 24);
  assert.notDeepEqual(station.pos, pos);
});

test('dashboard notes, ended goals and reflection project old container prose without rewriting history', (t) => {
  const world = new TestWorld(), memory = new WorldMemory(null), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  memory.setWorld(world.worldId);
  const ts = Date.now() - 121_000, text = '箱子 (123,67,-234) 存过 diamond×64';
  memory.noteChestUse(world.dim, pos, { put: [{ name: 'diamond', count: 64 }], now: ts });
  memory.addNote('fact', text, world.dim);
  memory.recentNotes().at(-1)!.ts = ts;
  memory.recordGoal({ dimension: world.dim, goal: text, goalType: 'tidy', source: 'test', status: 'done', summary: text,
    plan: [{ skill: 'take_items', args: { target: pos, item: 'diamond', count: 64 } }] });
  memory.recentGoals().at(-1)!.ts = ts;
  const snapshot = dashboardMemory(memory, world.state(), null);
  assert.match(snapshot.notes[0].text, /历史容器区域/);
  assert.match(snapshot.goals[0].goal, /历史容器区域/);
  assert.match(snapshot.goals[0].summary, /历史容器区域/);
  assert.equal('plan' in snapshot.goals[0], false);
  assert.doesNotMatch(JSON.stringify(snapshot), /123,67,-234|"x":123|diamond×64|"count":64/);

  self.data.knowHow.push({ id: 'old-observation', text, tags: [], wins: 1, losses: 0,
    createdAt: ts, updatedAt: Date.now(), source: 'observed' });
  self.data.knowHow.push({ id: 'new-inference', text: '另一个箱子 (345,66,-456) 存过 emerald×32', tags: [], wins: 0, losses: 0,
    createdAt: Date.now(), updatedAt: Date.now(), source: 'reflection' });
  self.data.insights = [{ at: Date.now(), text }];
  self.data.diary.push({ at: ts, text, dim: world.dim, pos: [123, 67, -234] });
  const reflected = buildReflectionMessages(self, 'test', [], [], memory)[1].content;
  assert.match(reflected, /历史容器区域/);
  assert.doesNotMatch(reflected, /123,67,-234|345,66,-456|diamond×64|emerald×32/);
  assert.equal(memory.recentNotes()[0].text, text);
  assert.equal(memory.recentGoals()[0].summary, text);
  assert.deepEqual(memory.recentGoals()[0].plan?.[0].args, { target: pos, item: 'diamond', count: 64 });
  assert.equal(self.data.knowHow[0].text, text);
  assert.equal(self.data.diary[0].at, ts);
});

test('main mind receives past entity sightings as historical evidence rather than current targets', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), self = new SelfModel(null);
  t.after(() => { memory.close(); self.close(); });
  const vision = new Vision(adapter), perception = new Perception(adapter, memory, new EventBus(), vision);
  const percept = perception.update();
  assert.ok(percept.vision);
  percept.vision.recent_sightings = [{ id: 42, name: 'boat', pos: { x: 2, y: 64, z: 0 }, source: 'past_visual_observation',
    currently_visible: false, dir: 'E', dist: 2, seconds_ago: 10 }];
  const context: MindContext = { tier: 'deliberate', reason: 'test', percept, state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null,
    notes: [], mySkills: [], persona: 'test' };
  const prompt = buildMindMessages(context)[1].content;
  assert.match(prompt, /recent_sightings/);
  assert.match(prompt, /past_visual_observation/);
  assert.match(prompt, /"currently_visible":false/);
  assert.match(prompt, /boat/);
});

test('Agent can mark an arbitrary visible block without a resource or interaction whitelist', async (t) => {
  const world = new TestWorld(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(world.worldId);
  const target = { x: 2, y: 64, z: 0 };
  world.setBlock(target, 'bedrock');
  const ctx = makeCtx(world, { memory, senses: { observeBlocks: (positions) => positions.map((point) => ({
    name: world.blockAt(point), pos: point, properties: {}, worldId: world.worldId, dimension: world.dim,
    sessionId: world.sessionId, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) } });
  const parsed = rememberPlace.validate({ target, label: '自己选的研究点' }, world);
  assert.ok(parsed.ok);
  const result = await rememberPlace.run(ctx, parsed.args);
  assert.equal(result.status, 'succeeded');
  assert.match(memory.landmarks()[0].label, /研究点.*bedrock/);
  ctx.senses.observeBlocks = () => [];
  assert.equal((await rememberPlace.run(ctx, { target: pos, label: '未知处' })).failureCode, 'NOT_FOUND');
  assert.equal(memory.landmarks().length, 1);
});

test('Hindsight recall projects legacy container facts without rewriting the remote bank', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-recall-boundary-'));
  const memory = new WorldMemory(null), adapter = new FakeAdapter(), ts = Date.now() - 121_000;
  t.after(() => { memory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  memory.setWorld(adapter.worldId);
  memory.noteChestUse('overworld', pos, { put: [{ name: 'diamond', count: 64 }], now: ts });
  memory.markGone('lava', 'overworld', { x: 8, y: 64, z: 8 }, 'obsidian');
  let writes = 0;
  const backend: MemoryBackend = {
    async retain(_episode: MemoryEpisode) { writes++; },
    async clear() { writes++; },
    async recall(): Promise<MemoryEntry[]> { return [{ id: 'old', source: 'hindsight', observedAt: new Date(ts).toISOString(),
      text: '箱子 (123,67,-234) 放过 diamond×64；记得 lava 在 (8,64,8)' }]; },
  };
  const settings: MemorySettings = { provider: 'hindsight', worldId: adapter.worldId, agentId: 'test', baseUrl: 'http://unused.test',
    bankId: 'test', apiKey: '', timeoutMs: 100, maxContextBytes: 5000 };
  const service = new EpisodicMemory(settings, memory, new EventBus(), () => adapter.state(), directory, backend);
  service.start();
  t.after(() => service.stop());
  const result = await service.recall({ percept: { self: { dim: 'overworld', pos: [0, 64, 0] }, objective: null, nearby: {} },
    lastFailure: null, userSuggestion: null }, '箱子和岩浆');
  assert.equal(result.source, 'hindsight');
  assert.equal(result.memories[0].historical, true);
  assert.equal(result.memories[0].worldId, adapter.worldId);
  assert.equal(result.memories[0].dimension, 'overworld');
  assert.match(result.memories[0].text, /区域/);
  assert.match(result.memories[0].text, /当时这里的 lava 没了，变成 obsidian；观察时间 .*，历史记录不代表当前状态/);
  assert.doesNotMatch(result.memories[0].text, /123,67,-234|diamond×64/);
  assert.equal(writes, 0);
});

test('Hindsight inference never refreshes container precision and keeps mention time separate', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-inference-boundary-'));
  const memory = new WorldMemory(null), adapter = new FakeAdapter(), mentionedAt = new Date().toISOString();
  t.after(() => { memory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  memory.setWorld(adapter.worldId);
  let writes = 0;
  const backend: MemoryBackend = {
    async retain() { writes++; }, async clear() { writes++; },
    async recall() { return [{ id: 'consolidated', source: 'hindsight:consolidation', kind: 'inference',
      observedAt: mentionedAt, mentionedAt, text: '箱子 (123,67,-234) 放过 diamond×64' }]; },
  };
  const settings: MemorySettings = { provider: 'hindsight', worldId: adapter.worldId, agentId: 'test', baseUrl: 'http://unused.test',
    bankId: 'test', apiKey: '', timeoutMs: 100, maxContextBytes: 5000 };
  const service = new EpisodicMemory(settings, memory, new EventBus(), () => adapter.state(), directory, backend);
  service.start();
  t.after(() => service.stop());
  const result = await service.recall({ percept: { self: { dim: 'overworld', pos: [0, 64, 0] }, objective: null, nearby: {} },
    lastFailure: null, userSuggestion: null }, '箱子');
  const entry = result.memories[0];
  assert.equal(entry.kind, 'inference');
  assert.equal(entry.historical, true);
  assert.equal(entry.observedAt, mentionedAt);
  assert.equal(entry.mentionedAt, mentionedAt);
  assert.match(entry.text, /历史容器区域/);
  assert.doesNotMatch(entry.text, /123,67,-234|diamond×64/);
  assert.equal(writes, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result.memories)) <= settings.maxContextBytes);
});

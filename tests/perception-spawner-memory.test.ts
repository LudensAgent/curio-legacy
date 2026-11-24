import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('看见刷怪笼后记成 discovery 地标，并在提示词里单独列出', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null, { worldId: 'fake-world' }), bus = new EventBus();
  t.after(() => memory.close());
  adapter.worldId = 'fake-world';
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'spawner', pos: { x: 2, y: 64, z: 0 } });
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = perception.update();
  const spawner = memory.landmarks().find((landmark) => landmark.label === 'spawner');
  assert.ok(spawner, '刷怪笼进入空间记忆');
  assert.equal(spawner.kind, 'discovery', '永久结构地标，不是会过期的 danger');
  assert.deepEqual(spawner.pos, { x: 2, y: 64, z: 0 });
  assert.equal(memory.landmarks().some((landmark) => landmark.label === 'spawner' && landmark.kind === 'danger'), false);
  // 旧存档里可能还有 danger 形式的刷怪笼记录：它不是 live discovery，不能在 spawner_spots 里冒充。
  memory.addLandmark('danger', 'spawner', adapter.dim, { x: 6, y: 64, z: 6 }, 24);

  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '查看刷怪笼', percept, state: adapter.state(),
    self: new SelfModel(null), memory, activity: null, plan: null, recentActionFailures: [], suspended: [],
    lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: 'P' });
  const line = user.content.split('\n').find((entry) => entry.startsWith('【记得的地方】'))!;
  const section = JSON.parse(line.slice('【记得的地方】'.length));
  assert.match(section.spawner_spots[0], /刷怪笼\[dis_/);
  assert.match(section.spawner_spots[0], /\(2,64,0\)/);
  assert.equal(section.spawner_spots.length, 1);
  assert.doesNotMatch(section.spawner_spots.join(' '), /\(6,64,6\)/, '旧 danger 记录不冒充 live 刷怪笼');
  assert.match(section.spawner_spots_note, /刷出什么怪、是否还在要现场确认/);
  assert.equal((section.places ?? []).some((place: string) => place.startsWith('spawner[')), false, '不在 places 重复');

  const [, glanceUser] = buildMindMessages({ tier: 'glance', reason: '瞥一眼', percept, state: adapter.state(),
    self: new SelfModel(null), memory, activity: null, plan: null, recentActionFailures: [], suspended: [],
    lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: 'P' });
  const glanceSection = JSON.parse(glanceUser.content.split('\n').find((entry) => entry.startsWith('【记得的地方】'))!.slice('【记得的地方】'.length));
  assert.match(glanceSection.spawner_spots[0], /刷怪笼\[dis_/);
});

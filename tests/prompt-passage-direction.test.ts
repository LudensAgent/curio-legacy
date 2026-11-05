import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity } from '../src/mind/activity.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

/** 地下 y60 站着，往上的竖井通到地表 y66、往下通到 y48：旧矿道两条方向都走得通。 */
function undergroundShaft(what: string, why: string, archived?: { id: string; deepestY: number; path: { x: number; y: number; z: number }[]; entrance: { x: number; y: number; z: number } }) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  memory.setWorld(adapter.worldId);
  adapter.pos = { x: 0.5, y: 60, z: 0.5 };
  adapter.removed = new Set(['0,60,0', '0,61,0']);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  // 先取一次感知再存通道，免得通道记录器把这次站位当成“重进旧道”补边，改变图的形状。
  const percept = perception.update(), state = adapter.state();
  memory.savePassage({
    id: 'old-mine', worldId: adapter.worldId, dim: adapter.dim, kind: 'dug',
    entrances: [{ x: 0, y: 66, z: 0 }], deepestY: 48, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: 66, z: 0 }, { x: 0, y: 62, z: 0 }, { x: 0, y: 58, z: 0 }, { x: 0, y: 54, z: 0 }, { x: 0, y: 50, z: 0 }, { x: 0, y: 48, z: 0 }],
  });
  if (archived) {
    memory.archivePassage({
      id: archived.id, worldId: adapter.worldId, dim: adapter.dim, kind: 'dug',
      entrances: [archived.entrance], deepestY: archived.deepestY, dug: 20, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, path: archived.path,
    });
  }
  const activity = createActivity({ what, why, kind: 'explore', repeat: 1,
    steps: [{ skill: 'follow_passage', args: { to: 'entrance' } }] }, '', 'llm', state);
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept, state, self, memory, activity,
    suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' });
  return { user, close: () => { memory.close(); self.close(); } };
}

test('活动同时含「矿道」和「回地面」时，只给回入口方向，不给往最深处走', (t) => {
  const { user, close } = undergroundShaft('沿旧矿道回地面', '上到 y64 见天');
  t.after(close);
  assert.equal(user.content.includes('【身体】'), true);
  assert.match(user.content, /回入口的下一步/, '回地面的方向要保留');
  assert.doesNotMatch(user.content, /往最深处走的下一步/, '活动里出现“回地面”时不能同时给出相反方向');
});

test('下矿时把归档里的深矿道也摆出来，不能只给 live 的浅记录', (t) => {
  const path = Array.from({ length: 30 }, (_, i) => ({ x: 0, y: 60 - i * 3, z: 0 }));
  const { user, close } = undergroundShaft('沿旧矿道往深处走', '下矿找铁', {
    id: 'psg_deep_archive', deepestY: -27, path, entrance: { x: 0, y: 62, z: 0 },
  });
  t.after(close);
  assert.match(user.content, /历史归档的旧矿道/);
  assert.match(user.content, /psg_deep_archive（最低 y-27，30 个脚点）/);
  assert.match(user.content, /follow_passage \{"to":"deepest","id":"<记录ID>"\}/);
});

test('活动只说沿矿道往下时，仍给出往最深处走的下一步', (t) => {
  const { user, close } = undergroundShaft('沿旧矿道往下挖', '找铁矿');
  t.after(close);
  assert.match(user.content, /往最深处走的下一步/, '没有回地面/回入口的方向时，下矿提示照常给出');
});

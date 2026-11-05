import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory, type PassageRecord } from '../src/memory/store.ts';
import { createActivity } from '../src/mind/activity.ts';
import { describePassage } from '../src/mind/facilities.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

/** 一级级台阶（相邻脚点只差 1 格高）：稀疏记录不能当成可反向爬的台阶。 */
const STAIR = Array.from({ length: 19 }, (_, i) => ({ x: i, y: 66 - i, z: 0 }));

/** 地下 y60 的台阶上，沿旧矿道一级级往上到 y66、往下到 y48：两条方向都走得通。 */
function undergroundShaft(what: string, why: string, opts: {
  archived?: { id: string; deepestY: number; path: { x: number; y: number; z: number }[]; entrance: { x: number; y: number; z: number } };
  record?: PassageRecord;
  pos?: { x: number; y: number; z: number };
  blockAt?: (p: { x: number; y: number; z: number }) => string | null;
} = {}) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  memory.setWorld(adapter.worldId);
  adapter.pos = opts.pos ?? { x: 6.5, y: 60, z: 0.5 };
  adapter.removed = new Set(['0,60,0', '0,61,0']);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  // 先取一次感知再存通道，免得通道记录器把这次站位当成“重进旧道”补边，改变图的形状。
  const percept = perception.update(), state = adapter.state();
  memory.savePassage(opts.record
    ? { ...opts.record, worldId: adapter.worldId, dim: adapter.dim }
    : {
      id: 'old-mine', worldId: adapter.worldId, dim: adapter.dim, kind: 'dug',
      entrances: [{ x: 0, y: 66, z: 0 }], deepestY: 48, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
      path: STAIR,
    });
  if (opts.archived) {
    memory.archivePassage({
      id: opts.archived.id, worldId: adapter.worldId, dim: adapter.dim, kind: 'dug',
      entrances: [opts.archived.entrance], deepestY: opts.archived.deepestY, dug: 20, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, path: opts.archived.path,
    });
  }
  const activity = createActivity({ what, why, kind: 'explore', repeat: 1,
    steps: [{ skill: 'follow_passage', args: { to: 'entrance' } }] }, '', 'llm', state);
  const [, user] = buildMindMessages({ tier: 'deliberate', reason: '测试', percept, state, self, memory, activity,
    suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P',
    ...(opts.blockAt ? { blockAt: opts.blockAt } : {}) });
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
    archived: { id: 'psg_deep_archive', deepestY: -27, path, entrance: { x: 0, y: 62, z: 0 } },
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
  // dig:true 是 follow_passage 的一条可选路线，不是唯一手段：自己 dig_at / place_at 也仍然可用。
  assert.match(user.content, /follow_passage 只有带 dig:true 才会沿线挖开\/垫（会消耗方块和工具耐久），也可以自己 dig_at \/ place_at/);
  assert.doesNotMatch(user.content, /只有 dig:true 会挖开/);
});

test('通道说明分开报当前连通分量可达深度与记录全局最低点', () => {
  // 一条 record 里两团互不相连的脚点：here 所在的浅段只到 y-28，更低的 y-61 在另一段。
  const rec: PassageRecord = {
    id: 'psg_frag', dim: 'overworld', kind: 'dug',
    entrances: [{ x: 0, y: -20, z: 0 }], deepestY: -61, dug: 40, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: -20, z: 0 }, { x: 0, y: -24, z: 0 }, { x: 0, y: -28, z: 0 },
      { x: 0, y: -61, z: 0 }, { x: 0, y: -55, z: 0 }, { x: 0, y: -49, z: 0 }],
  };
  const { text } = describePassage(rec, { x: 0, y: -28, z: 0 });
  assert.match(text, /从你现在连通的一段能到 y-28/);
  assert.match(text, /记录里更低的 y-61 在另一段，两段之间还没接上/);
  assert.doesNotMatch(text, /能到 y-61/, '另一段的 y-61 不能说成当前可达');
  assert.doesNotMatch(text, /你应该|建议先去|必须/);
});

test('下矿提示里同样区分当前可达深度与记录最低点', (t) => {
  const { user, close } = undergroundShaft('沿旧矿道往下挖', '找钻石', {
    pos: { x: 0.5, y: -28, z: 0.5 },
    record: {
      id: 'psg_frag', dim: 'overworld', kind: 'dug',
      entrances: [{ x: 0, y: -20, z: 0 }], deepestY: -61, dug: 40, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
      path: [{ x: 0, y: -20, z: 0 }, { x: 0, y: -24, z: 0 }, { x: 0, y: -28, z: 0 },
        { x: 0, y: -61, z: 0 }, { x: 0, y: -55, z: 0 }, { x: 0, y: -49, z: 0 }],
    },
  });
  t.after(close);
  assert.match(user.content, /从你现在连通的一段能到 y-28/);
  assert.doesNotMatch(user.content, /能到 y-61/);
});

test('下一步脚/头可走但下方不是实心时，只报支撑格事实与垫或下落', (t) => {
  // 站在台阶网外 4 格：next 是台阶上的 (7,59,0)；脚/头/下方都设为空气。
  const air = new Set(['7,59,0', '7,60,0', '7,58,0']);
  const { user, close } = undergroundShaft('沿旧矿道往下挖', '找铁矿', {
    pos: { x: 6.5, y: 60, z: 4.5 },
    blockAt: (p) => air.has(`${p.x},${p.y},${p.z}`) ? 'air' : 'stone',
  });
  t.after(close);
  const line = user.content.split('\n').find((l) => l.includes('下一步落脚点下方是'));
  assert.ok(line, '要给出下方支撑格的事实');
  assert.match(line, /下一步落脚点下方是 air，走过去需要垫或下落（由你定）/);
  assert.doesNotMatch(line, /你应该|建议先去|必须/);
  assert.match(line, /follow_passage \{"to":"deepest","dig":true\}.*会消耗方块和工具耐久/);
});

test('下一步脚/头可走且下方是实心时，保持可以直接走过去', (t) => {
  const { user, close } = undergroundShaft('沿旧矿道往下挖', '找铁矿', {
    pos: { x: 6.5, y: 60, z: 4.5 },
    blockAt: (p) => p.y === 59 || p.y === 60 ? 'air' : 'stone',
  });
  t.after(close);
  assert.match(user.content, /往最深处走的下一步 \(\d+,\d+,\d+\) 现在仍是 2 格高的空走廊，可以直接走过去/);
  assert.doesNotMatch(user.content, /下一步落脚点下方是/);
});

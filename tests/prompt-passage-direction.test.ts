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
  dim?: string;
} = {}) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  memory.setWorld(adapter.worldId);
  adapter.dim = opts.dim ?? 'overworld';
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
  // 每次下矿都无条件注入的 dig:true 说明已删：通道行和 follow_passage 提示已经给出这条可选路线与代价。
  assert.doesNotMatch(user.content, /只有 dig:true 会挖开|follow_passage 只有带 dig:true/);
});

test('通道说明只报沿记录方向走得到的深度，并区分记录里更低的脚点', () => {
  // 一条 record 里两团互不相连的脚点：here 所在的浅段只到 y-28，更低的 y-61 走不到。
  const rec: PassageRecord = {
    id: 'psg_frag', dim: 'overworld', kind: 'dug',
    entrances: [{ x: 0, y: -20, z: 0 }], deepestY: -61, dug: 40, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: -20, z: 0 }, { x: 0, y: -24, z: 0 }, { x: 0, y: -28, z: 0 },
      { x: 0, y: -61, z: 0 }, { x: 0, y: -55, z: 0 }, { x: 0, y: -49, z: 0 }],
  };
  const { text } = describePassage(rec, { x: 0, y: -28, z: 0 });
  assert.match(text, /从你现在的位置沿记录方向能到 y-28/);
  assert.match(text, /记录里更低的脚点 y-61 这次走不到（可能是反向落差或另一段，尚未验证）/);
  assert.doesNotMatch(text, /能到 y-61/, '走不到的 y-61 不能说成当前可达');
  assert.doesNotMatch(text, /你应该|建议先去|必须/);
});

test('离通道很远时不会把记录最低点说成现在能到', () => {
  const rec: PassageRecord = {
    id: 'psg_far', dim: 'overworld', kind: 'dug',
    entrances: [{ x: 0, y: -20, z: 0 }], deepestY: -61, dug: 40, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: -20, z: 0 }, { x: 0, y: -26, z: 0 }, { x: 0, y: -32, z: 0 },
      { x: 0, y: -38, z: 0 }, { x: 0, y: -44, z: 0 }, { x: 0, y: -50, z: 0 }, { x: 0, y: -56, z: 0 }, { x: 0, y: -61, z: 0 }],
  };
  const { text } = describePassage(rec, { x: 170, y: 64, z: 0 });
  assert.doesNotMatch(text, /沿记录方向/, '离网 170 格时 passageDeepestAnchor 回退到全网最深，不能当作现在能到');
  assert.doesNotMatch(text, /脚点表未保留/);
});

test('抽稀后 deepestY 更低时，不把它断言成另一段', () => {
  // path 抽稀只剩到 y-53，deepestY 仍保留抽稀前的观测 y-61。
  const rec: PassageRecord = {
    id: 'psg_thin', dim: 'overworld', kind: 'dug',
    entrances: [{ x: 0, y: -20, z: 0 }], deepestY: -61, dug: 40, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: -20, z: 0 }, { x: 0, y: -26, z: 0 }, { x: 0, y: -32, z: 0 },
      { x: 0, y: -38, z: 0 }, { x: 0, y: -44, z: 0 }, { x: 0, y: -50, z: 0 }, { x: 0, y: -53, z: 0 }],
  };
  const { text } = describePassage(rec, { x: 0, y: -53, z: 0 });
  assert.match(text, /记录里还有更低的观测点 y-61，脚点表未保留\/没在这一段/);
  assert.doesNotMatch(text, /沿记录方向|另一段|别的段/);
});

test('连通且能走到记录最低脚点时不给深度差异说明', () => {
  const rec: PassageRecord = {
    id: 'psg_ok', dim: 'overworld', kind: 'dug',
    entrances: [{ x: 0, y: 66, z: 0 }], deepestY: 48, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: STAIR,
  };
  const { text } = describePassage(rec, { x: 6, y: 60, z: 0 });
  assert.doesNotMatch(text, /沿记录方向|脚点表未保留/);
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
  assert.match(user.content, /从你现在的位置沿记录方向能到 y-28/);
  assert.match(user.content, /记录里更低的脚点 y-61 这次走不到/);
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

test('下方支撑格未观测时不猜成空气', (t) => {
  const air = new Set(['7,59,0', '7,60,0']);
  const { user, close } = undergroundShaft('沿旧矿道往下挖', '找铁矿', {
    pos: { x: 6.5, y: 60, z: 4.5 },
    blockAt: (p) => {
      const k = `${p.x},${p.y},${p.z}`;
      return air.has(k) ? 'air' : k === '7,58,0' ? null : 'stone';
    },
  });
  t.after(close);
  assert.match(user.content, /下方支撑格未观测/);
  assert.doesNotMatch(user.content, /下一步落脚点下方是/);
});

test('下方支撑格是液体时照样只说垫或下落', (t) => {
  const air = new Set(['7,59,0', '7,60,0']);
  const { user, close } = undergroundShaft('沿旧矿道往下挖', '找铁矿', {
    pos: { x: 6.5, y: 60, z: 4.5 },
    blockAt: (p) => {
      const k = `${p.x},${p.y},${p.z}`;
      return air.has(k) ? 'air' : k === '7,58,0' ? 'water' : 'stone';
    },
  });
  t.after(close);
  const line = user.content.split('\n').find((l) => l.includes('下一步落脚点下方是'));
  assert.ok(line, '要给出下方液体的当前事实');
  assert.match(line, /下一步落脚点下方是 water，走过去需要垫或下落（由你定）/);
});

test('下界找要塞/开平巷时给旧道的水平最远口径，而不是只给最深', (t) => {
  // 一条水平延伸 30+ 格的旧道，同时有一个很深的旁支；找要塞需要“更远”而不是“更深”。
  const farPath = [
    { x: 0, y: 60, z: 0 }, { x: 4, y: 60, z: 0 }, { x: 8, y: 60, z: 0 }, { x: 12, y: 60, z: 0 },
    { x: 16, y: 60, z: 0 }, { x: 20, y: 60, z: 0 }, { x: 24, y: 60, z: 0 }, { x: 28, y: 60, z: 0 },
    { x: 32, y: 60, z: 0 }, { x: 36, y: 60, z: 0 }, { x: 20, y: 40, z: 0 },
  ];
  const links = farPath.slice(1).map((p, i) => ({ a: farPath[i]!, b: p }));
  const { user, close } = undergroundShaft('下界找要塞、开平巷往前推进', '在 y30~35 开平巷扫要塞砖', {
    dim: 'the_nether',
    record: {
      id: 'psg_nether_far', dim: 'the_nether', kind: 'dug', entrances: [{ x: 0, y: 61, z: 0 }],
      deepestY: 40, dug: 40, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, path: farPath, links,
    },
  });
  t.after(close);
  assert.match(user.content, /水平最远/, '下界找要塞需要水平延伸事实');
  assert.match(user.content, /follow_passage \{"to":"farthest"/, '要给出往远处走的显式入口');
  assert.doesNotMatch(user.content, /往最深处走的下一步/, '找要塞/平巷不能只给最深方向');
});

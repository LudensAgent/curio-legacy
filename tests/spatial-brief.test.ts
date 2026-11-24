import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity } from '../src/mind/activity.ts';
import { buildMindMessages, spatialBrief, type MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), self = new SelfModel(null);
  memory.setWorld(adapter.state().worldId);
  const bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const ctx: MindContext = { tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: '' };
  t.after(() => { self.close(); memory.close(); });
  const activity = (kind: 'build' | 'explore' | 'gather' | 'tidy', skill: string, args: Record<string, unknown> = {}) =>
    createActivity({ what: '测试活动', why: '测试', kind, steps: [{ skill, args }], repeat: 1 }, '测试。', 'llm', ctx.state);
  return { adapter, memory, self, ctx, perceive: () => perception.update(), activity };
}

test('建设时给工地空间证据：未知不是空气、可查 terrain', (t) => {
  const { memory, ctx, activity } = fixture(t);
  memory.addLandmark('discovery', '我的箱子', 'overworld', { x: 3, y: 64, z: 2 }, 4);
  const lines = spatialBrief({ ...ctx, activity: activity('build', 'place_cell', { xyz: [2, 64, 0], item: 'cobblestone' }) });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0]!, /工地空间：近 32 格已记录设施 1 处/);
  assert.match(lines[0]!, /农田 (0 块|状态未读取)/);
  assert.match(lines[0]!, /未记录区域未知，不能当空气或空地/);
  assert.match(lines[0]!, /terrain/);
});

test('路线受阻时给最后停止点与到访范围；出行时说明历史路线不等于现在可通行', (t) => {
  const { ctx, activity } = fixture(t);
  const reach = { dim: 'overworld', origin: { x: 0, y: 64, z: 0 }, at: Date.now() - 60_000, truncated: false,
    sectors: { E: { pos: { x: 40, y: 64, z: 2 }, distance: 40 }, N: { pos: { x: 1, y: 64, z: -12 }, distance: 12 } } };
  const lines = spatialBrief({ ...ctx, activity: activity('explore', 'travel_to', { to: { x: 80, y: 64, z: 0 } }), reach,
    recentActionFailures: [{ skill: 'travel_to', args: {}, failure_code: 'PATH_NOT_FOUND', summary: '边缘策略拒绝', position: ctx.state.pos, observed_at: new Date().toISOString() }] });
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0]!, /路线记录：最近一次 travel_to 失败（PATH_NOT_FOUND）/);
  assert.match(lines[0]!, /最远 40 格向 E/);
  assert.match(lines[0]!, /失败\/到访记录不证明现在可通行/);
  assert.match(lines[1]!, /出行证据/);
  assert.match(lines[1]!, /spatial_extrema/);
});

test('找资源时把当前看见与记得的资源分开，不把记得当成现在', (t) => {
  const { ctx, activity } = fixture(t);
  const percept = { ...ctx.percept, nearby: { ...ctx.percept.nearby, resources: [
    { block: 'oak_log', count: 3, nearest: 8, dir: 'E', seen: 'now' as const },
    { block: 'iron_ore', count: 5, nearest: 22, dir: 'N', seen: 'memory' as const },
  ] } };
  const lines = spatialBrief({ ...ctx, percept, activity: activity('gather', 'gather', { block: 'log', count: 4 }) });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0]!, /当前看见 oak_log×3 E8格/);
  assert.match(lines[0]!, /记得 iron_ore×5 N22格/);
  assert.match(lines[0]!, /不等于现在可走或已经搜全/);
  assert.match(lines[0]!, /spatial_query/);
});

test('无关活动没有空间判断；User Prompt 只在需要时放在【此刻】前，Glance 不带', (t) => {
  const { ctx, activity } = fixture(t);
  assert.deepEqual(spatialBrief({ ...ctx, activity: activity('tidy', 'store_items', { items: [] }) }), []);
  const building = { ...ctx, activity: activity('build', 'place_cell', { xyz: [2, 64, 0], item: 'cobblestone' }) };
  const [, user] = buildMindMessages(building);
  assert.match(user.content, /【空间判断】/);
  assert.ok(user.content.indexOf('【空间判断】') < user.content.indexOf('【此刻】'));
  const [, glance] = buildMindMessages({ ...building, tier: 'glance' });
  assert.doesNotMatch(glance.content, /【空间判断】/);
});

test('到访范围只在同维度使用；非导航超时不算路线受阻；挖矿走搜索证据而不是施工空间', (t) => {
  const { ctx, activity } = fixture(t);
  const reach = { dim: 'the_nether', origin: { x: 0, y: 64, z: 0 }, at: Date.now(), truncated: true,
    sectors: { E: { pos: { x: 40, y: 64, z: 0 }, distance: 40 } } };
  const craftTimeout = [{ skill: 'craft', args: {}, failure_code: 'TIMEOUT', summary: '合成超时', position: ctx.state.pos, observed_at: new Date().toISOString() }];
  const lines = spatialBrief({ ...ctx, reach, recentActionFailures: craftTimeout, activity: activity('gather', 'mine_cell', { at: [0, -1, 0] }) });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.doesNotMatch(lines.join('\n'), /路线记录|工地空间/);
  assert.match(lines[0]!, /搜索证据/);
});

test('到访范围标注起点与截断，但不把跨维度记录当当前维度', (t) => {
  const { ctx, activity } = fixture(t);
  const reach = { dim: 'overworld', origin: { x: 5, y: 64, z: 5 }, at: Date.now() - 120_000, truncated: true,
    sectors: { E: { pos: { x: 40, y: 64, z: 0 }, distance: 35 } } };
  const [line] = spatialBrief({ ...ctx, reach, activity: activity('explore', 'travel_to', { to: { x: 80, y: 64, z: 0 } }) });
  assert.match(line!, /从 \(5,64,5\) 起算，未读完全部区段/);
  assert.match(line!, /最远 35 格向 E/);
});

test('设施/农田数量带来源限制；没有资源事实时说明没有记录而不是推断为空', (t) => {
  const { ctx, activity } = fixture(t);
  const build = spatialBrief({ ...ctx, activity: activity('build', 'place_cell', { xyz: [2, 64, 0], item: 'cobblestone' }) });
  assert.match(build[0]!, /历史坐标/);
  assert.match(build[0]!, /农田状态未读取|农田 \d+ 块/);
  const gather = spatialBrief({ ...ctx, activity: activity('gather', 'gather', { block: 'log', count: 4 }) });
  assert.match(gather[0]!, /当前看见 没有记录到资源；记得 没有记录到资源/);
  assert.match(gather[0]!, /不等于是现在可走|不等于现在可走/);
});

test('空间判断不改 System', (t) => {
  const { ctx, activity } = fixture(t);
  const building = { ...ctx, activity: activity('build', 'place_cell', { xyz: [2, 64, 0], item: 'cobblestone' }) };
  const [system] = buildMindMessages(building);
  const [plain] = buildMindMessages({ ...ctx, activity: null });
  assert.equal(system.content, plain.content);
});

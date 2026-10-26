import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { Attention } from '../src/mind/attention.ts';

const data = (await import('minecraft-data')).default('1.20.1');
const adapter = () => { const a = new MineflayerAdapter(config, new EventBus()); a.mcData = data; return a; };
const keys = (n: string) => data.entitiesByName[n].metadataKeys as string[];
const md = (n: string, values: Record<string, unknown>) => { const k = keys(n); const out: unknown[] = []; for (const [key, v] of Object.entries(values)) out[k.indexOf(key)] = v; return out; };

test('一眼看得出的生物特征：羊毛颜色和剪没剪、幼崽、村民职业、驯服、带电', () => {
  const a = adapter() as any;
  assert.equal(a.traitsOf({ name: 'sheep', metadata: md('sheep', { wool: 15 }) }, keys('sheep')), '黑色');
  assert.equal(a.traitsOf({ name: 'sheep', metadata: md('sheep', { wool: 0x10, baby: true }) }, keys('sheep')), '幼崽、白色、已剪毛');
  assert.equal(a.traitsOf({ name: 'villager', metadata: md('villager', { villager_data: { villagerType: 0, villagerProfession: 5, level: 2 } }) }, keys('villager')), '农民 2 级');
  assert.equal(a.traitsOf({ name: 'wolf', metadata: md('wolf', { flags: 0x04 }) }, keys('wolf')), '已驯服');
  assert.equal(a.traitsOf({ name: 'creeper', metadata: md('creeper', { is_powered: true }) }, keys('creeper')), '带电（爆炸更猛）');
  assert.equal(a.traitsOf({ name: 'cow', metadata: [] }, keys('cow')), undefined);
});

test('状态效果按中文名、等级和剩余秒数给出', () => {
  const a = adapter() as any;
  const poison = Object.values<any>(data.effects).find((e) => e.name === 'Poison').id;
  assert.deepEqual(a.effectsOf({ entity: { effects: { [poison]: { id: poison, amplifier: 1, duration: 200 } } } }), [{ name: '中毒（掉血到半颗心为止）', level: 2, seconds: 10 }]);
});

test('注意到：身上多了状态效果、工具快磨坏了', () => {
  const att = new Attention();
  const p = (effects: string[], left: number) => ({ time: { timeOfDay: 3000, phase: 'day' }, self: { food: 20, hp: 20, inWater: false }, emptySlots: 5, effects,
    inventory: [{ name: 'stone_pickaxe', count: 1, durability: { left, max: 131 } }], nearby: { hostile: [], resources: [] }, light: null } as any);
  att.fromPercept(p([], 100));
  const n = att.fromPercept(p(['中毒（掉血到半颗心为止）'], 10));
  assert.ok(n.some((x) => x.key.startsWith('effect:') && x.level === 'reconsider'));
  assert.ok(n.some((x) => x.key === 'worn:stone_pickaxe'));
});

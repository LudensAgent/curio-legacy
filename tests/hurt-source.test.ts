import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);

const fixture = (entity: { id: number; name: string; pos: { x: number; y: number; z: number }; dist: number }) => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.mcData = require('minecraft-data')('1.20.1');
  (adapter as any).bot = {
    entity: { id: 1, yaw: 0, position: { x: 0, y: 64, z: 0 } },
    entities: { [entity.id - 1]: { id: entity.id, name: entity.name, position: { ...entity.pos, distanceTo: () => entity.dist } } },
  };
  (adapter as any).damageTypes = new Map([[7, 'arrow']]);
  return adapter as any;
};

test('伤害来源记下名字、距离和身体相对方位；来源实体进入攻击者名单', () => {
  const adapter = fixture({ id: 42, name: 'skeleton', pos: { x: 3, y: 64, z: 0 }, dist: 3 });
  adapter.noteDamage({ entityId: 1, sourceTypeId: 7, sourceCauseId: 42, sourceDirectId: 0 });
  assert.equal(adapter.lastDamage.type, 'arrow');
  assert.match(adapter.lastDamage.cause, /skeleton 3\.0 格，在你右侧/, '面朝北时东边的骷髅在右手边');
  assert.ok(adapter.attackers.has(42), '打我们的骷髅进入攻击者名单');
});

test('没有可归属的来源时，直接命中的弹体也带方位', () => {
  const adapter = fixture({ id: 52, name: 'arrow', pos: { x: 0, y: 64, z: 3 }, dist: 3 });
  adapter.noteDamage({ entityId: 1, sourceTypeId: 7, sourceCauseId: 0, sourceDirectId: 52 });
  assert.equal(adapter.lastDamage.cause, undefined);
  assert.match(adapter.lastDamage.direct, /arrow 3\.0 格，在你正后/, '面朝北时南边的箭在正后');
});

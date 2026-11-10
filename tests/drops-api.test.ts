import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { failureFor } from '../src/mind/mind.ts';
import { EventBus } from '../src/events.ts';

test('api.drops：眼前看得见的掉落物 + 刚才见过、转身后看不见的（记得的位置）', async () => {
  const ctx: any = { bus: new EventBus(),
    adapter: { state: () => ({ pos: { x: 0, y: 64, z: 0 } }) },
    senses: {
      refresh() {},
      perceivedEntities: () => [{ id: 1, name: 'item:granite', kind: 'item', pos: { x: 2, y: 64, z: 0 }, dist: 2, count: 18 }, { id: 2, name: 'zombie', kind: 'hostile', pos: { x: 5, y: 64, z: 0 }, dist: 5 }],
      recentDrops: () => [{ id: 3, name: 'white_bed', pos: { x: -4, y: 64, z: 0 }, ageMs: 5000 }, { id: 1, name: 'granite', pos: { x: 2, y: 64, z: 0 }, ageMs: 100 }],
    },
  };
  const out = await makeBridge(ctx)('drops', [16]) as any[];
  assert.deepEqual(out.map((d) => [d.item, d.seen]), [['granite', true], ['white_bed', false]]);
  assert.equal(out[0].count, 18);
  assert.equal(out[1].ageSec, 5);
});

test('交给恢复技能的失败带上动作算出的目标坐标和当时位置', () => {
  const f = failureFor({ skill: 'navigate_to', args: { to: { x: 1, y: 64, z: 0 } } }, { failureCode: 'PATH_NOT_FOUND', summary: '没走通', data: { target: { x: 10, y: 64, z: -10 }, position: { x: 1.23, y: 64, z: 2 }, waterAhead: true } }, { x: 9, y: 9, z: 9 });
  assert.deepEqual(f.target, { x: 10, y: 64, z: -10 });
  assert.deepEqual(f.position, { x: 1.23, y: 64, z: 2 });
  assert.equal(f.waterAhead, true);
  const g = failureFor({ skill: 'step' }, { failureCode: 'PATH_NOT_FOUND', summary: 'x' }, { x: 3, y: 64, z: 4 });
  assert.equal(g.target, undefined);
  assert.deepEqual(g.position, { x: 3, y: 64, z: 4 });
});

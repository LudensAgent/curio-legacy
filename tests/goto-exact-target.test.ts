import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goTo } from '../src/skills/movement.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('goto accepts coordinate objects without turning them into landmark names', async (t) => {
  const adapter = new TestWorld();
  adapter.pos = { x: 1381.5, y: 63, z: 305.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const validated = goTo.validate({ target: { x: 1382, y: 63, z: 305 } }, adapter);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(validated.args.target, '1382,63,305');
  t.mock.method(adapter, 'moveTo', async () => { adapter.pos = { x: 1382.5, y: 63, z: 305.5 }; });
  const result = await goTo.run(ctx, validated.args);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.data?.targetCell, { x: 1382, y: 63, z: 305 });
  for (const target of [{ x: 1, z: 2 }, { x: 1, y: '63', z: 2 }, [1, 63, 2], 123]) {
    assert.equal(goTo.validate({ target }, adapter).ok, false);
  }
});

test('goto reports arriving nearby with measured progress when it stops beside an exact coordinate', async (t) => {
  const adapter = new TestWorld();
  adapter.pos = { x: 1381.5, y: 70, z: 285.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'moveTo', async () => {
    adapter.pos = { x: 1382.52, y: 70, z: 285.56 };
    throw new Error('No path: 附近没有可确认安全的调整空间，换条路线');
  });
  const result = await goTo.run(ctx, { target: '1383,70,284', dig: true });
  assert.equal(result.status, 'succeeded');
  assert.match(result.summary, /到达 .*附近.*差 [\d.]+ 格.*No path: 附近没有可确认安全的调整空间/);
  assert.deepEqual(result.data?.targetCell, { x: 1383, y: 70, z: 284 });
  assert.deepEqual(result.data?.positionCell, { x: 1382, y: 70, z: 285 });
  assert.equal(result.data?.arrivedCell, false);
  assert.equal(result.data?.nextTo, true);
  assert.equal(result.data?.arrivedNearby, true);
  assert.ok((result.data?.moved as number) > 1);
});

test('goto preserves timeout and does not report an adjacent unknown cell as blocked', async (t) => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'moveTo', async () => { throw new Error('timeout after 20000ms'); });
  const result = await goTo.run(ctx, { target: '1,64,0', dig: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.match(result.summary, /timeout after 20000ms/);
  assert.doesNotMatch(result.summary, /那一格本身走不进去/);
  assert.equal(result.data?.arrivedCell, false);
  assert.equal(result.data?.moved, 0);
});

test('an adjacent goto reports a freshly observed target door without claiming why it blocked movement', async (t) => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const s = adapter.state(), pos = { x: 1, y: 65, z: 0 };
  const ctx = makeCtx(adapter, { senses: { observeBlocks: () => [{ name: 'oak_door', pos, properties: { open: true },
    source: 'vision', worldId: s.worldId, sessionId: s.sessionId, dimension: s.dim, observedAt: Date.now(), observationId: 1 }] } });
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'blockOptics', () => ({ name: 'oak_door', kind: 'solid', shapes: [[0, 0, 0.8125, 1, 1, 1]] }));
  t.mock.method(adapter, 'moveTo', async () => { throw new Error('No path'); });
  const result = await goTo.run(ctx, { target: '1,65,0', dig: true });
  assert.equal(result.status, 'succeeded');
  assert.match(result.summary, /目标格看到 oak_door，门目前打开，尚未确认它是否挡住路线/);
  assert.equal((result.data?.observedDoor as { properties: { open: boolean } }).properties.open, true);
});

test('goto cannot report arrival when pathfinding resolves without reaching the adjacent cell', async (t) => {
  const adapter = new TestWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'moveTo', async () => {});
  const result = await goTo.run(ctx, { target: '1,64,0', dig: true });
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.match(result.summary, /尚未到达.*没有取得进展/);
  assert.equal(result.data?.arrivedCell, false);
});

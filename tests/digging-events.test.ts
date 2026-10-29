import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { PassageTracker, type DugBlock } from '../src/memory/passages.ts';
import { WorldMemory } from '../src/memory/store.ts';

const require = createRequire(import.meta.url);
const registry = require('minecraft-data')('1.20.1');
const injectDigging = require('mineflayer/lib/plugins/digging');
const { pathfinder } = require('mineflayer-pathfinder');
type TestBlock = { name: string; type: number; position: Vec3 };

function fixture() {
  const block = (name: string, position: Vec3): TestBlock => ({ name, type: registry.blocksByName[name].id, position });
  const bot = Object.assign(new EventEmitter(), {
    registry,
    inventory: { items: () => [] },
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, effects: {} },
    _client: { write: () => {} },
    swingArm: () => {},
    lookAt: async () => {},
    setControlState: () => {},
    clearControlStates: () => {},
    blockAt: (position: Vec3) => block('stone', position),
    targetDigBlock: null as TestBlock | null,
    dig: async (_block: TestBlock, _forceLook?: boolean | string) => {},
    stopDigging: () => {},
    digTime: () => 60_000,
    pathfinder: {
      setGoal: (_goal: object | null) => {},
      getPathTo: () => ({ status: 'success', path: [] as object[] }),
    },
  });
  injectDigging(bot);
  bot.digTime = () => 60_000;
  pathfinder(bot);
  const complete = async (name: string, position: Vec3) => {
    const original = block(name, position);
    const digging = bot.dig(original, 'ignore');
    bot.emit(`blockUpdate:${position}`, original, block('air', position));
    await digging;
    return original;
  };
  const startNavigationDig = async () => {
    bot.pathfinder.getPathTo = () => ({ status: 'success', path: [{ x: 1, y: 64, z: 0,
      toBreak: [{ x: 1, y: 64, z: 0 }], toPlace: [] }] });
    bot.pathfinder.setGoal({ isValid: () => true, hasChanged: () => false, isEnd: () => false });
    bot.emit('physicsTick');
    await setImmediate();
    assert.ok(bot.targetDigBlock, 'the real Pathfinder plugin started a dig');
  };
  return { bot, block, complete, startNavigationDig };
}

test('diggingCompleted reports the mined block, not its replacement air', async () => {
  const { bot, complete } = fixture();
  const completed: TestBlock[] = [];
  bot.on('diggingCompleted', (block: TestBlock) => completed.push(block));
  const original = await complete('iron_ore', new Vec3(1, 63, 0));
  assert.equal(completed.length, 1);
  assert.equal(completed[0], original);
  assert.equal(completed[0].name, 'iron_ore');
});

for (const interruption of ['navigation cancellation', 'death and respawn'] as const) {
  test(`${interruption} preserves digging observers and records the next mine entrance and passage`, async (t) => {
    const { bot, complete, startNavigationDig } = fixture();
    t.after(() => bot.stopDigging());
    const memory = new WorldMemory(null);
    memory.setWorld('test-world');
    t.after(() => memory.close());
    const tracker = new PassageTracker(memory, () => 'new-mine');
    const dug: DugBlock[] = [], aborted: string[] = [];
    let now = 1_000;
    const record = (block: TestBlock) => dug.push({ pos: { ...block.position }, name: block.name, ts: ++now });
    const recordAbort = (block: TestBlock) => aborted.push(block.name);
    bot.on('diggingCompleted', record);
    bot.on('diggingAborted', recordAbort);

    await startNavigationDig();
    if (interruption === 'navigation cancellation') bot.pathfinder.setGoal(null);
    else { bot.emit('death'); bot.pathfinder.setGoal(null); bot.emit('spawn'); }
    await setImmediate();
    assert.equal(bot.targetDigBlock, null, 'the interrupted dig has stopped');
    assert.deepEqual(dug, [], 'an interrupted dig is not a completed excavation');
    assert.deepEqual(aborted, ['stone']);
    assert.ok(bot.listeners('diggingCompleted').includes(record), 'external completion observer survives');
    assert.ok(bot.listeners('diggingAborted').includes(recordAbort), 'external abort observer survives');

    tracker.observe({ worldId: 'test-world', dim: 'overworld', pos: { x: 0, y: 64, z: 0 }, place: 'surface' }, [], now);
    for (let level = 1; level <= 6; level++) {
      const position = new Vec3(level, 64 - level, 0);
      await complete(level === 4 ? 'iron_ore' : 'stone', position);
      tracker.observe({ worldId: 'test-world', dim: 'overworld', pos: { ...position }, place: 'underground' }, dug.splice(0), now);
    }
    const [passage] = memory.passages('overworld');
    assert.ok(passage, 'the new mine is saved once enough actual digging is observed');
    assert.deepEqual(passage.entrances, [{ x: 0, y: 64, z: 0 }]);
    assert.equal(passage.deepestY, 58);
    assert.equal(passage.dug, 6);
    assert.equal(passage.ores.iron_ore, 1);
    assert.ok(passage.path.length >= 2, 'the descent leaves route points, not only a mine label');
  });
}

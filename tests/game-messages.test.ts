import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deathCauseOf, parseGameMessage } from '../src/memory/game-messages.ts';
import { WorldMemory } from '../src/memory/store.ts';

test('游戏播报：认出自己的死亡、死因和凶手，以及成就、别人的死亡、进出服务器', () => {
  const me = 'Curio';
  const d = parseGameMessage('Curio was blown up by Creeper', me);
  assert.equal(d.kind, 'death_self');
  assert.equal(d.cause, 'mob');
  assert.equal(d.by, 'Creeper');
  assert.equal(parseGameMessage('Curio fell from a high place', me).cause, 'fall');
  assert.equal(parseGameMessage('Curio tried to swim in lava', me).cause, 'lava');
  assert.equal(parseGameMessage('Curio drowned', me).cause, 'drowning');
  assert.equal(parseGameMessage('Curio starved to death', me).cause, 'starvation');
  assert.equal(parseGameMessage('Steve was slain by Zombie', me).kind, 'death_other');
  assert.equal(parseGameMessage('Curio has made the advancement [Stone Age]', me).kind, 'advancement_self');
  assert.equal(parseGameMessage('Alex joined the game', me).kind, 'join');
  assert.equal(parseGameMessage('Server restarting in 5 minutes', me).kind, 'server');
  assert.equal(deathCauseOf('Curio experienced kinetic energy'), 'fall');
});

test('死亡播报晚到时补到这次死亡记录上', () => {
  const memory = new WorldMemory(null);
  memory.setDeath({ ts: Date.now(), dim: 'overworld', pos: { x: 1, y: 64, z: 2 }, lost: [], cause: 'unknown' });
  memory.updateDeathMessage('Curio was shot by Skeleton', 'mob');
  const d = memory.lastDeath();
  assert.equal(d?.message, 'Curio was shot by Skeleton');
  assert.equal(d?.cause, 'mob');
  memory.close();
});

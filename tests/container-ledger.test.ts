import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ContainerLedger } from '../src/memory/container-ledger.ts';

const W = 'world-1';
const D = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });

test('container ledger stores exact contents, chestOps and furnace state across reload', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-containers-'));
  const file = path.join(dir, 'containers.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ledger = new ContainerLedger(file, W);
  assert.deepEqual(ledger.chests(), []);
  const entry = ledger.noteChestUse(D, at(3, 64, 2), {
    seen: [{ name: 'coal', count: 5 }, { name: 'iron_ingot', count: 2 }],
    block: 'chest', note: '放矿的', day: 4,
  }, 'chest:n1');
  assert.equal(entry.contents.items.find((item) => item.name === 'coal')?.count, 5);
  assert.equal(entry.nodeId, 'chest:n1');
  assert.equal(ledger.chestOps, 1);
  ledger.setFurnace({
    dim: D, pos: at(4, 64, 2), block: 'furnace',
    input: { name: 'iron_ore', count: 3 }, output: { name: 'iron_ingot', count: 1 },
    fuel: { name: 'coal', count: 2 }, burning: true,
  }, 'furnace:n1');
  ledger.flush();

  const reopened = new ContainerLedger(file, W);
  assert.equal(reopened.chestAt(D, at(3, 64, 2))?.contents.items.find((item) => item.name === 'iron_ingot')?.count, 2);
  assert.equal(reopened.chestOps, 1);
  assert.equal(reopened.furnaces(D)[0]?.burning, true);
  assert.equal(reopened.furnaces(D)[0]?.input?.count, 3);

  reopened.forgetChest(D, at(3, 64, 2));
  reopened.forgetFurnace(D, at(4, 64, 2));
  reopened.flush();
  const empty = new ContainerLedger(file, W);
  assert.deepEqual(empty.chests(), []);
  assert.deepEqual(empty.furnaces(), []);
});

test('取空后的熔炉保留“已确认为空”的记录，重新加载仍在', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-containers-'));
  const file = path.join(dir, 'containers.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ts = 1_700_000_000_000;
  const first = new ContainerLedger(file, W);
  first.setFurnace({ dim: D, pos: at(4, 64, 2), block: 'furnace', input: null, output: null, fuel: null, burning: false, ts });
  first.flush();
  const reopened = new ContainerLedger(file, W);
  assert.equal(reopened.furnaces(D).length, 1, '空状态是“查过了”，不能当成没记录');
  assert.equal(reopened.furnaces(D)[0]?.input, null);
  assert.equal(reopened.furnaces(D)[0]?.output, null);
  assert.equal(reopened.furnaces(D)[0]?.ts, ts);
  reopened.forgetFurnace(D, at(4, 64, 2));
  assert.deepEqual(reopened.furnaces(), [], '熔炉真的消失时才清除');
});

test('container ledger is world-scoped', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-containers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'containers.json');
  new ContainerLedger(file, 'a').noteChestUse(D, at(1, 64, 1), { seen: [{ name: 'dirt', count: 1 }] });
  const b = new ContainerLedger(file, 'b');
  assert.deepEqual(b.chests(), []);
});

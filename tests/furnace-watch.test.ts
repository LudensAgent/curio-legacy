import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const data = (await import('minecraft-data')).default('1.20.1');

/** 一个按“每看一次走半件”推进的假熔炉：燃料一根木棍只够烧半件 */
function rig(fuelCount: number) {
  const inv = new Map<string, number>([['raw_iron', 7], ['stick', fuelCount]]);
  const it = (name: string, count: number) => (count > 0 ? { name, count, type: data.itemsByName[name].id } : null);
  const f: any = { input: 0, fuel: 0, output: 0, burn: 0, progress: 0 };
  const step = () => {
    if (f.burn <= 0 && f.fuelN > 0 && f.input > 0) { f.fuelN--; f.burn = 0.5; }
    if (f.burn > 0 && f.input > 0) { f.burn -= 0.5; f.progress += 0.5; if (f.progress >= 1) { f.progress = 0; f.input--; f.output++; } }
  };
  f.fuelN = 0;
  const furnace: any = {
    inventoryStart: 3, inventoryEnd: 39,
    get slots() { return [null, null, null, ...[...inv].map(([name, count]) => it(name, count))]; },
    get fuel() { return f.burn > 0 ? 1 : 0; }, get progress() { return f.progress; },
    inputItem: () => it('raw_iron', f.input), fuelItem: () => it('stick', f.fuelN), outputItem: () => { step(); return it('iron_ingot', f.output); },
    async putFuel(_t: number, _m: null, n: number) { inv.set('stick', inv.get('stick')! - n); f.fuelN += n; },
    async putInput(_t: number, _m: null, n: number) { inv.set('raw_iron', inv.get('raw_iron')! - n); f.input += n; },
    async takeOutput() { inv.set('iron_ingot', (inv.get('iron_ingot') ?? 0) + f.output); f.output = 0; },
    async takeInput() { inv.set('raw_iron', (inv.get('raw_iron') ?? 0) + f.input); f.input = 0; },
    close() {},
  };
  const furnaceBlock = { name: 'furnace', position: new Vec3(2, 64, 0), getProperties: () => ({ lit: f.burn > 0 }) };
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    blockAt: () => furnaceBlock, findBlock: () => furnaceBlock,
    inventory: { slots: [], items: () => [...inv].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count, type: data.itemsByName[name].id })) },
    async openFurnace() { return furnace; },
    async _syncWindow(window: unknown) { assert.equal(window, furnace); },
  };
  const a = new MineflayerAdapter(config, new EventBus()) as any;
  a.mcData = data; a.bot = bot; a.connectedFlag = true; a.moveTo = async () => {};
  a.interactionReady = async () => {};
  return { a, inv };
}

test('燃料烧完就不再干等：报出燃料用完，没烧的原料拿回背包，离开时说清熔炉里还剩什么', async () => {
  const { a, inv } = rig(1);
  const left: any[] = [];
  const t0 = Date.now();
  const r = await a.smelt('raw_iron', 7, 'stick', new AbortController().signal, { onLeave: (l: any) => left.push(l) });
  assert.ok(Date.now() - t0 < 10_000, '不会等到 7×11 秒的期限');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OUT_OF_FUEL');
  assert.equal(r.returned, 7);
  assert.equal(inv.get('raw_iron'), 7);
  assert.equal(left.length, 1);
  assert.equal(left[0].input, null, '原料都取回了');
});

test('主燃料用完时用背包里别的燃料接着烧', async () => {
  const { a, inv } = rig(1);
  inv.set('oak_planks', 0);
  inv.set('coal', 1);
  const r = await a.smelt('raw_iron', 2, 'stick', new AbortController().signal, { moreFuels: ['coal'] });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.made, 2);
});

test('取熔炉内容时读取窗口背包并以服务器同步结果确认', async () => {
  for (const accept of [true, false]) {
    const make = (name: string, count: number) => ({ name, count, type: data.itemsByName[name].id });
    const slots: any[] = [null, null, make('iron_ingot', 3), null];
    const furnace = {
      slots, inventoryStart: 3, inventoryEnd: 4, fuel: 0,
      outputItem: () => slots[2], inputItem: () => null, fuelItem: () => null,
      async takeOutput() { slots[3] = slots[2]; slots[2] = null; },
      close() {},
    };
    const block = { name: 'furnace', position: new Vec3(2, 64, 0) };
    const bot: any = {
      entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
      blockAt: () => block, inventory: { slots: [], items: () => [] },
      async openFurnace() { return furnace; },
      async _syncWindow(window: unknown) {
        assert.equal(window, furnace);
        if (!accept) { slots[2] = slots[3]; slots[3] = null; }
      },
    };
    const a = new MineflayerAdapter(config, new EventBus()) as any;
    a.mcData = data; a.bot = bot; a.connectedFlag = true; a.moveTo = async () => {}; a.interactionReady = async () => {};
    const r = await a.emptyFurnace(block.position, new AbortController().signal);
    assert.deepEqual(r.taken, accept ? [{ name: 'iron_ingot', count: 3 }] : [], JSON.stringify(r));
    assert.deepEqual(r.left.output, accept ? null : { name: 'iron_ingot', count: 3 });
  }
});

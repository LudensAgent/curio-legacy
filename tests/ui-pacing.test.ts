import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { AbortedError } from '../src/util.ts';

function rig(ui: { pacingMs: number; openHoldMs: number; closeHoldMs: number }) {
  const a = new MineflayerAdapter({ ...config, ui } as any, new EventBus()) as any;
  const opened: string[] = [];
  const bot: any = {
    async openBlock(block: any) { opened.push(`open ${block.name}`); return { type: 'minecraft:crafting', close() { opened.push('close'); } }; },
    async openEntity() { return { type: 'minecraft:merchant' }; },
    closeWindow() { opened.push('close'); },
  };
  a.installUiPacing(bot);
  return { a, bot, opened };
}

test('每次界面点击前按 UI_PACING_MS 停顿，shift 点击快一些', async () => {
  const { bot } = rig({ pacingMs: 100, openHoldMs: 0, closeHoldMs: 0 });
  assert.equal(typeof bot.beforeWindowClick, 'function', '补丁钩子要装上');
  let t = Date.now();
  await bot.beforeWindowClick(1, 0, 0);
  assert.ok(Date.now() - t >= 90, '普通点击停满一拍');
  t = Date.now();
  await bot.beforeWindowClick(0, 0, 1);
  const shift = Date.now() - t;
  assert.ok(shift >= 50 && shift < 100, `shift 点击停 60%（实际 ${shift}ms）`);
});

test('UI_PACING_MS=0 时点击不停顿', async () => {
  const { bot } = rig({ pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 });
  const t = Date.now();
  for (let i = 0; i < 20; i++) await bot.beforeWindowClick(i, 0, 0);
  assert.ok(Date.now() - t < 50);
});

test('窗口打开后先停留 UI_OPEN_HOLD_MS 再交给调用方；箱子/熔炉都从 openBlock 走，只停一次', async () => {
  const { bot, opened } = rig({ pacingMs: 0, openHoldMs: 120, closeHoldMs: 0 });
  const t = Date.now();
  const w = await bot.openBlock({ name: 'crafting_table' });
  assert.ok(Date.now() - t >= 110);
  assert.equal(w.type, 'minecraft:crafting');
  assert.deepEqual(opened, ['open crafting_table']);
});

test('附魔台先安装选项监听，再执行打开窗口停留', async () => {
  const a = new MineflayerAdapter({ ...config, ui: { pacingMs: 0, openHoldMs: 120, closeHoldMs: 0 } } as any, new EventBus()) as any;
  let listening = false, received = false;
  const bot: any = {
    async openBlock() {
      setTimeout(() => { received = listening; }, 20);
      return { close() {} };
    },
    async openEnchantmentTable(block: unknown) {
      const window = await bot.openBlock(block);
      listening = true;
      return window;
    },
  };
  a.installUiPacing(bot);
  const start = Date.now();
  await bot.openEnchantmentTable({ name: 'enchanting_table' });
  assert.ok(Date.now() - start >= 110);
  assert.equal(received, true, '停留期间也能接收服务器发来的附魔选项');
  const direct = Date.now();
  await bot.openBlock({ name: 'enchanting_table' });
  assert.ok(Date.now() - direct >= 110, '直接打开附魔台也会停留');
});

test('熔炉先安装进度监听，再执行打开窗口停留', async () => {
  const a = new MineflayerAdapter({ ...config, ui: { pacingMs: 0, openHoldMs: 120, closeHoldMs: 0 } } as any, new EventBus()) as any;
  let listening = false, received = false;
  const bot: any = {
    async openBlock() {
      setTimeout(() => { received = listening; }, 20);
      return { close() {} };
    },
    async openFurnace(block: unknown) {
      const window = await bot.openBlock(block);
      listening = true;
      return window;
    },
  };
  a.installUiPacing(bot);
  const start = Date.now();
  await bot.openFurnace({ name: 'furnace' });
  assert.ok(Date.now() - start >= 110);
  assert.equal(received, true, '停留期间也能接收服务器发来的熔炉属性');
  const direct = Date.now();
  await bot.openBlock({ name: 'furnace' });
  assert.ok(Date.now() - direct >= 110, '直接打开熔炉也会停留');
});

test('动作被打断时停顿立刻结束，并把刚打开的窗口关掉', async () => {
  const { a, bot, opened } = rig({ pacingMs: 500, openHoldMs: 500, closeHoldMs: 500 });
  const ac = new AbortController();
  const check = Object.assign(() => { if (ac.signal.aborted) throw new AbortedError('x'); }, { signal: ac.signal });
  const t = Date.now();
  const p = a.actionContext.run(check, () => bot.openBlock({ name: 'chest' }));
  setTimeout(() => ac.abort('interrupted'), 30);
  await assert.rejects(p, AbortedError);
  assert.ok(Date.now() - t < 300, '不用等满停留时间');
  assert.ok(opened.includes('close'), '开到一半被打断的窗口要关掉');
  // 关窗前的停留：已经打断就不停
  const t2 = Date.now();
  await a.uiCloseHold(ac.signal);
  assert.ok(Date.now() - t2 < 50);
});

test('慢速点击失控保护：连着点 400 下还不停就中止', async () => {
  const { a, bot } = rig({ pacingMs: 0, openHoldMs: 0, closeHoldMs: 0 });
  a.scheduleRepair = () => {};
  for (let i = 0; i < 400; i++) await bot.beforeWindowClick(1, 0, 0);
  await assert.rejects(bot.beforeWindowClick(1, 0, 0), /CLICK_LOOP/);
});


test('the real click target is announced at the start of its pacing wait', async () => {
  const { bot } = rig({ pacingMs: 80, openHoldMs: 0, closeHoldMs: 0 });
  const seen: { event: string; slot: number; duration: number; at: number }[] = [];
  bot.emit = (event: string, slot: number, duration: number) => seen.push({ event, slot, duration, at: Date.now() });
  const pending = bot.beforeWindowClick(36, 0, 0);
  assert.equal(seen.length, 1, 'the observer can move before the click executes');
  assert.equal(seen[0].event, 'observerWindowClick');
  assert.equal(seen[0].slot, 36);
  assert.equal(seen[0].duration, 80);
  await pending;
  assert.ok(Date.now() - seen[0].at >= 70);
});

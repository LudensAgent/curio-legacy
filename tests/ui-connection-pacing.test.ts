import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);

test('连接后在 Mineflayer 注入插件完成时才安装开窗停留', async () => {
  const mineflayer = require('mineflayer');
  const originalCreate = mineflayer.createBot;
  const client = Object.assign(new EventEmitter(), { state: 'play', version: '1.20.1', write() {}, end() {} });
  const bot = originalCreate({ version: '1.20.1', client, loadInternalPlugins: false, plugins: {
    window(bot: any) {
      bot.openBlock = async () => ({ type: 'minecraft:generic_9x3' });
      bot.openEntity = async () => ({ type: 'minecraft:merchant' });
      bot.clickWindow = async () => {};
    },
  } });
  bot.loadPlugin = () => {};
  mineflayer.createBot = () => bot;
  try {
    const bus = new EventBus();
    const adapter = new MineflayerAdapter({ ...config, ui: { pacingMs: 10, openHoldMs: 100, closeHoldMs: 0 } }, bus);
    adapter.connect();
    await once(bot, 'inject_allowed');
    assert.match(bus.recent().find((event) => event.type === 'ui_pacing_unavailable')?.msg ?? '', /patch-deps/);
    const start = Date.now();
    await bot.openBlock({ name: 'chest' });
    assert.ok(Date.now() - start >= 80, '箱子打开后停留');
    const entityStart = Date.now();
    await bot.openEntity({});
    assert.ok(Date.now() - entityStart >= 80, '实体交互打开后停留');
  } finally {
    mineflayer.createBot = originalCreate;
  }
});

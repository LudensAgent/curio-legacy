import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { ObserverFeed, createObserverHandler, installMineflayerObserver } from 'curio-observer';
import { EventBus } from '../src/events.ts';
import { startDashboard } from '../src/observer/dashboard.ts';

/** 一个最小的 Mineflayer 形状对象：只包含观察数据流读取的字段 */
function fakeBot() {
  const inventory = Object.assign(new EventEmitter(), { id: 0, type: 'minecraft:inventory', slots: new Array(46).fill(null) as any[] });
  inventory.slots[36] = { name: 'stone_pickaxe', count: 1, durabilityUsed: 3, maxDurability: 131 };
  return Object.assign(new EventEmitter(), {
    username: 'Curio', version: '1.20.1', health: 17, food: 18, foodSaturation: 2,
    experience: { level: 1, progress: 0.5 }, quickBarSlot: 0, inventory, currentWindow: null,
    craft: async () => {}, clickWindow: async () => {}, closeWindow: () => {},
  });
}

function read(port: number, path: string, until: (text: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c;
        if (until(text)) { req.destroy(); resolve(text); }
      });
    });
    req.on('error', (e: any) => (e.code === 'ECONNRESET' ? undefined : reject(e)));
    setTimeout(() => { req.destroy(); reject(new Error('timeout: ' + path)); }, 3000);
  });
}

test('控制台同端口提供 Curio Observer 数据流：hello / state / thought，且不影响控制台路由', async () => {
  const bus = new EventBus();
  const feed = new ObserverFeed({ botName: 'Curio', agentVersion: '0.3.0' });
  const bot = fakeBot();
  const obs = installMineflayerObserver(bot as any, feed, { pacingMs: 0 });
  feed.thought('制作石镐', '圆石够了');
  const server = startDashboard('127.0.0.1', 0, bus, { snapshot: () => ({ ok: 1 }), pause() {}, resume() {}, replan() {}, suggest() {} }, [createObserverHandler(feed)]);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  try {
    const text = await read(port, '/api/observer/stream', (t) => t.includes('event: thought'));
    assert.match(text, /event: hello\ndata: \{"protocol":1,"bot":"Curio"/);
    assert.match(text, /"health":17/);
    assert.match(text, /"id":"minecraft:stone_pickaxe","count":1,"damage":3,"maxDamage":131/);
    assert.match(text, /"goal":"制作石镐"/);
    const state = await new Promise<string>((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/state' }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(b)); }));
    assert.equal(state, '{"ok":1}');
  } finally {
    obs.dispose();
    feed.dispose();
    server.close();
  }
});

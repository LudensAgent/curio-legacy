import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installClientGuard, MAX_CLICKS_PER_TURN } from '../src/adapter/click-guard.ts';

/** 1.20 的 Mineflayer：点击在本地改完模型、发个包就算完成，不让出事件循环 */
function fakeBot() {
  const sent: string[] = [];
  const client = { write: (name: string, _data?: unknown) => { sent.push(name); } };
  const clickWindow = async () => { client.write('window_click'); };
  return { client, clickWindow, sent };
}

test('点界面失控（窗口已关、Mineflayer 还在 while 里一直点）：同一轮点了太多下就中止，不再塞满内存、卡死事件循环', async () => {
  const { client, clickWindow, sent } = fakeBot();
  let loops = 0;
  installClientGuard(client, { onLoop: () => { loops++; } });
  // 照着 putSelectedItemRange：看的是一个永远不会变的窗口，所以一直点
  const stale = { selectedItem: { name: 'stone_pickaxe' } };
  const putSelectedItemRange = async () => { while (stale.selectedItem) await clickWindow(); };
  let timerRan = false;
  setTimeout(() => { timerRan = true; }, 0);
  await assert.rejects(putSelectedItemRange(), /CLICK_LOOP/);
  assert.equal(sent.length, MAX_CLICKS_PER_TURN, '超出上限的那一下没发出去');
  assert.equal(loops, 1);
  assert.equal(timerRan, false, '中止发生在同一轮事件循环里（以前这里永远到不了定时器）');
});

test('正常的界面操作不受影响：每轮十几下、中间会等服务器，计数会清零；其他包照常发', async () => {
  const { client, clickWindow, sent } = fakeBot();
  installClientGuard(client);
  for (let round = 0; round < 50; round++) {
    for (let i = 0; i < 20; i++) await clickWindow();
    await new Promise((r) => setImmediate(r)); // 等服务器回包
  }
  client.write('position', {});
  assert.equal(sent.filter((n) => n === 'window_click').length, 1000);
  assert.equal(sent.at(-1), 'position');
});

test('动作已经被取消：包照旧丢掉（打断守卫）', () => {
  const { client, sent } = fakeBot();
  installClientGuard(client, { guard: () => () => { throw new Error('cancelled'); } });
  client.write('window_click');
  assert.equal(sent.length, 0);
});

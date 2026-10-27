/**
 * 界面点击失控保护。
 *
 * 1.20 的 Mineflayer 点界面是“本地先改、包发出去就算完”：clickWindow 返回的 Promise 立刻就是完成的，中间不让出事件循环。
 * 它的 putSelectedItemRange 一直点到“光标上没东西”为止，看的却是传进来的那个窗口；clickWindow 点的是 bot.currentWindow || 背包。
 * 合成到一半工作台窗口被关掉（超时、被打断、收拾残局）时，这个循环就永远停不下来：一直点、一直往网络缓冲里塞 window_click 包，
 * 定时器（心跳）、网络、日志全停，十几秒堆就从一两百 MB 涨到 4 GB 崩溃（10-26 02:23、10-27 10:12 两次都是放下工作台、开始合成之后）。
 *
 * 这里在发包那一层数：同一轮事件循环里连着发了太多点击包，就让这次点击抛错，打断那个循环。
 * 正常的合成一次只点十几下，而且等服务器回包时会让出事件循环，计数会清零。
 */
export const MAX_CLICKS_PER_TURN = 400;

export interface ClickGuardOptions {
  /** 当前动作的打断守卫：抛错表示这个动作已经被取消，包直接丢掉 */
  guard?: () => (() => void) | undefined;
  onLoop?: (clicks: number) => void;
  limit?: number;
}

export function installClientGuard(client: { write: (...args: any[]) => any }, opts: ClickGuardOptions = {}) {
  const write = client.write;
  const limit = opts.limit ?? MAX_CLICKS_PER_TURN;
  let clicks = 0, resetScheduled = false, reported = false;
  client.write = function (this: unknown, ...args: any[]) {
    if (args[0] === 'window_click') {
      if (!resetScheduled) {
        resetScheduled = true;
        setImmediate(() => { clicks = 0; resetScheduled = false; reported = false; });
      }
      if (++clicks > limit) {
        if (!reported) { reported = true; try { opts.onLoop?.(clicks); } catch { /* ignore */ } }
        throw new Error(`CLICK_LOOP: 同一轮里连续点了 ${clicks} 下界面还没停（多半是窗口已经关了，Mineflayer 还在往里放东西），中止这次界面操作`);
      }
    }
    const g = opts.guard?.();
    try { g?.(); } catch { return; }
    return write.apply(this, args);
  };
}

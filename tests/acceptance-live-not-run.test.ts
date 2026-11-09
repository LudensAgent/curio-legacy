/**
 * V4-QA-01 验收矩阵：实机 Java 1.20.1 单列（v4 §14.6）。
 *
 * 本卡是离线 / Fake / 回放验收；实机验收属于 **V4-QA-02（blocked-human）**。
 * 这里每个条目都显式 NOT_RUN，不用 Fake 结果冒充实机。原因一致：
 * 本 worktree 没有连接 test-server，也没有真实 Mineflayer 身体与 Java 1.20.1
 * 物理/服务端位置纠正；FakeAdapter 的连续插值不能证明实机落地、时延与权威纠正。
 */
import { test } from 'node:test';

const NOT_RUN = 'V4-QA-02 blocked-human：需要 Java 1.20.1 test-server 与真实身体；离线 Fake 不能冒充实机';
const live = (name: string) => test(name, { skip: NOT_RUN }, () => {});

live('LIVE-1 普通地表移动一段有意义的距离');
live('LIVE-2 带障碍与已知替代接近方式的路线');
live('LIVE-3 一格高差');
live('LIVE-4 安全下降到较低的洞穴');
live('LIVE-5 挖入并进入短隧道');
live('LIVE-6 会话重载后复用曾挖/曾走的隧道');
live('LIVE-7 检测并停在新近阻挡的历史隧道');
live('LIVE-8 显式清障后重新规划');
live('LIVE-9 多段探索到初始观测区域之外');
live('LIVE-10 搜索附近不可见资源并扩大区域');
live('LIVE-11 复现并消除无进展换维循环');
live('LIVE-12 路线/记忆状态跨重启保留为历史证据，当前可通行性重新复验');

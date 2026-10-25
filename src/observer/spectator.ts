import type { GameAdapter } from '../adapter/types.ts';
import type { Config } from '../config.ts';
import type { EventBus } from '../events.ts';
import { Rcon } from './rcon.ts';

export interface SpectatorStatus {
  enabled: boolean;
  /** 运行中可以在控制台切换：true 自动附着到 Bot；false 解除附着，你在旁观模式里自由看 */
  active: boolean;
  reason: string;
  rconOk: boolean;
  lastResult: string;
  lastAt: number | null;
  attempts: number;
}

/**
 * Agent 视角观察：通过 RCON 让你的客户端进入旁观模式并 /spectate 到 Bot 身上（按 F5 切第三人称）。
 * Bot 死亡、重生、换维度、重连后自动重新附着；每 20 秒做一次健康检查。
 * 只发送观察相关命令，不参与 Bot 控制。
 */
export class Spectator {
  status: SpectatorStatus;
  private rcon: Rcon | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pendingT: NodeJS.Timeout | null = null;
  private lastPublished = '';

  constructor(private cfg: Config, private adapter: GameAdapter, private bus: EventBus) {
    const o = cfg.observer;
    const reason = !o.player ? '未设置 OBSERVER_PLAYER' : !o.rconPassword ? '未设置 RCON_PASSWORD' : '';
    this.status = { enabled: !reason, active: !reason, reason, rconOk: false, lastResult: '', lastAt: null, attempts: 0 };
    // 只要有 RCON 密码就建立连接：测试规则（keepInventory 等）不依赖是否开启自动旁观
    if (o.rconPassword) this.rcon = new Rcon(o.rconHost, o.rconPort, o.rconPassword);
  }

  start() {
    let first = true;
    if (this.rcon) {
      this.adapter.on('spawn', () => {
        if (first) {
          first = false;
          void this.setupWorld();
        }
      });
    }
    if (!this.status.enabled) {
      this.bus.publish('spectator', 'P1', `自动旁观未启用：${this.status.reason}`);
      return;
    }
    this.adapter.on('spawn', () => this.schedule(1500, 'spawn'));
    this.adapter.on('respawn', () => this.schedule(2000, 'respawn'));
    this.adapter.on('death', () => this.schedule(3500, 'death'));
    this.timer = setInterval(() => void this.attach('health_check'), 20000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.rcon?.close();
  }

  /** 控制台的开关：打开就马上附着；关掉就解除附着（留在旁观模式，自由飞着看） */
  async setActive(on: boolean): Promise<SpectatorStatus> {
    if (!this.status.enabled) return this.status;
    this.status.active = on;
    if (this.pendingT) { clearTimeout(this.pendingT); this.pendingT = null; }
    if (on) await this.attach('dashboard');
    else {
      try {
        await this.command(`spectate`);
        this.status.lastResult = '已解除附着，自由旁观';
        this.bus.publish('spectator', 'P2', `自动旁观已关闭：${this.cfg.observer.player} 可以自由看了`);
      } catch (e: any) { this.status.lastResult = `RCON 错误：${e?.message ?? e}`; }
      this.lastPublished = '';
    }
    return this.status;
  }

  private schedule(ms: number, why: string) {
    if (this.pendingT) clearTimeout(this.pendingT);
    this.pendingT = setTimeout(() => void this.attach(why), ms);
  }

  async command(cmd: string): Promise<string> {
    if (!this.rcon) throw new Error(this.status.reason || '未设置 RCON_PASSWORD');
    try {
      const r = await this.rcon.send(cmd);
      this.status.rconOk = true;
      return r;
    } catch (e) {
      this.status.rconOk = false;
      throw e;
    }
  }

  private async setupWorld() {
    if (!this.cfg.observer.setupGamerules) return;
    for (const cmd of [`gamerule keepInventory ${this.cfg.observer.keepInventory}`, 'gamerule doImmediateRespawn true']) {
      try {
        await this.command(cmd);
      } catch (e: any) {
        this.bus.publish('rcon', 'P1', `RCON 命令失败（${cmd}）：${e?.message ?? e}`);
        return;
      }
    }
    this.bus.publish('rcon', 'P3', `已设置规则：keepInventory=${this.cfg.observer.keepInventory}、doImmediateRespawn=true`);
  }

  async attach(why: string) {
    const s = this.adapter.state();
    if (!s.connected || !this.status.active) return;
    const player = this.cfg.observer.player;
    this.status.attempts++;
    try {
      await this.command(`gamemode spectator ${player}`);
      const r = (await this.command(`spectate ${s.username} ${player}`)).trim();
      this.status.lastResult = r || 'ok';
      this.status.lastAt = Date.now();
      const bad = /no player|not found|unknown|incorrect|expected|cannot/i.test(r);
      const msg = bad ? `旁观附着失败（${why}）：${r}（确认 ${player} 已在线）` : `旁观已附着到 ${s.username}（${why}）`;
      if (msg !== this.lastPublished || why !== 'health_check') {
        if (!(why === 'health_check' && !bad)) this.bus.publish('spectator', bad ? 'P1' : 'P3', msg);
        this.lastPublished = msg;
      }
    } catch (e: any) {
      this.status.lastResult = `RCON 错误：${e?.message ?? e}`;
      const msg = `旁观附着失败：${this.status.lastResult}`;
      if (msg !== this.lastPublished) this.bus.publish('spectator', 'P1', msg);
      this.lastPublished = msg;
    }
  }
}

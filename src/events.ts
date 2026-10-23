import { EventEmitter } from 'node:events';

/** P0 紧急 / P1 重要 / P2 机会 / P3 普通 */
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export interface AgentEvent {
  ts: number;
  type: string;
  severity: Severity;
  msg: string;
  data?: Record<string, unknown>;
}

/** 全局事件总线：所有模块只通过它广播事件，观测层只订阅、不写控制通道。 */
export class EventBus extends EventEmitter {
  private ring: AgentEvent[] = [];

  publish(type: string, severity: Severity, msg: string, data?: Record<string, unknown>) {
    const ev: AgentEvent = { ts: Date.now(), type, severity, msg, data };
    this.ring.push(ev);
    if (this.ring.length > 300) this.ring.shift();
    this.emit('event', ev);
    return ev;
  }

  recent(n = 100): AgentEvent[] {
    return this.ring.slice(-n);
  }
}

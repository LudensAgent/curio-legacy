import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, EventBus } from './events.ts';

export function day() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 追加写 JSONL：每行一条记录，方便事后用脚本/表格分析与回放。 */
export class JsonlWriter {
  constructor(private dir: string, private prefix: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  write(obj: unknown) {
    const file = path.join(this.dir, `${this.prefix}-${day()}.jsonl`);
    fs.appendFile(file, JSON.stringify(obj) + '\n', () => {});
  }
}

const COLORS: Record<string, string> = { P0: '\x1b[31m', P1: '\x1b[33m', P2: '\x1b[36m', P3: '\x1b[90m' };

export function attachLogger(bus: EventBus, dataDir: string) {
  const w = new JsonlWriter(path.join(dataDir, 'logs'), 'events');
  bus.on('event', (ev: AgentEvent) => {
    w.write(ev);
    if (ev.severity === 'P3' && ev.type === 'tick') return;
    const t = new Date(ev.ts).toLocaleTimeString();
    console.log(`${COLORS[ev.severity] ?? ''}[${t}] ${ev.severity} ${ev.type}\x1b[0m ${ev.msg}`);
  });
}

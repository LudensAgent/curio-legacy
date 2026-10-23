import net from 'node:net';

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;

interface Pending {
  resolve: (body: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** 极简 RCON 客户端（Source RCON 协议，Minecraft 服务端内置）。 */
export class Rcon {
  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private connecting: Promise<void> | null = null;

  constructor(private host: string, private port: number, private password: string, private timeoutMs = 5000) {}

  static encode(id: number, type: number, body: string): Buffer {
    const b = Buffer.from(body, 'utf8');
    const len = 4 + 4 + b.length + 2;
    const out = Buffer.alloc(4 + len);
    out.writeInt32LE(len, 0);
    out.writeInt32LE(id, 4);
    out.writeInt32LE(type, 8);
    b.copy(out, 12);
    return out; // 末尾两个 0 字节已由 alloc 填充
  }

  static decode(buf: Buffer): { packets: { id: number; type: number; body: string }[]; rest: Buffer } {
    const packets: { id: number; type: number; body: string }[] = [];
    let off = 0;
    while (buf.length - off >= 4) {
      const len = buf.readInt32LE(off);
      if (buf.length - off < 4 + len) break;
      packets.push({ id: buf.readInt32LE(off + 4), type: buf.readInt32LE(off + 8), body: buf.toString('utf8', off + 12, off + 4 + len - 2) });
      off += 4 + len;
    }
    return { packets, rest: buf.subarray(off) };
  }

  get connected() {
    return !!this.sock && !this.sock.destroyed && !this.connecting;
  }

  private request(type: number, body: string): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RCON 响应超时'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock!.write(Rcon.encode(id, type, body));
    });
  }

  private failAll(e: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.sock = sock;
      this.buf = Buffer.alloc(0);
      sock.setTimeout(this.timeoutMs, () => sock.destroy(new Error('RCON 连接超时')));
      sock.on('data', (chunk: Buffer) => {
        const { packets, rest } = Rcon.decode(Buffer.concat([this.buf, chunk]));
        this.buf = rest;
        for (const pk of packets) {
          if (pk.id === -1) {
            this.failAll(new Error('RCON 认证失败：密码错误'));
            sock.destroy();
            continue;
          }
          const p = this.pending.get(pk.id);
          if (!p) continue;
          clearTimeout(p.timer);
          this.pending.delete(pk.id);
          p.resolve(pk.body);
        }
      });
      sock.on('error', (e) => {
        this.failAll(e);
        if (this.connecting) reject(e);
      });
      sock.on('close', () => {
        this.failAll(new Error('RCON 连接已关闭'));
        this.sock = null;
      });
      sock.on('connect', () => {
        sock.setTimeout(0);
        // 认证期间 connecting 仍非空，所以直接写入
        const id = this.nextId++;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('RCON 认证超时'));
          sock.destroy();
        }, this.timeoutMs);
        this.pending.set(id, { resolve: () => resolve(), reject, timer });
        sock.write(Rcon.encode(id, TYPE_AUTH, this.password));
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async send(command: string): Promise<string> {
    await this.connect();
    return this.request(TYPE_EXEC, command);
  }

  close() {
    this.sock?.destroy();
    this.sock = null;
  }
}

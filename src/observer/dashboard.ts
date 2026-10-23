import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, EventBus } from '../events.ts';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));

export interface DashboardHandlers {
  snapshot(): unknown;
  pause(): void;
  resume(): void;
  replan(): void;
  suggest(text: string): void;
}

/**
 * 本地控制台：只绑定 127.0.0.1。
 * - /          控制台
 * - /overlay   OBS 浏览器源（透明背景的状态叠加）
 * - /api/stream  Server-Sent Events：每秒推送状态 + 实时事件
 */
/** extraRoutes：在控制台路由之前尝试的处理器（返回 true 表示已处理），用于挂载 Curio Observer 数据流 */
export function startDashboard(host: string, port: number, bus: EventBus, h: DashboardHandlers, extraRoutes: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean)[] = []) {
  const clients = new Set<http.ServerResponse>();

  bus.on('event', (ev: AgentEvent) => {
    if (ev.type === 'tick') return;
    const line = `event: ev\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(line);
  });
  setInterval(() => {
    if (!clients.size) return;
    const line = `event: state\ndata: ${JSON.stringify(h.snapshot())}\n\n`;
    for (const c of clients) c.write(line);
  }, 1000).unref();

  const send = (res: http.ServerResponse, code: number, body: string, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const file = (res: http.ServerResponse, name: string) => {
    fs.readFile(PUBLIC + name, (err, data) => (err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, data.toString(), 'text/html; charset=utf-8')));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
      });
    });

  const server = http.createServer(async (req, res) => {
    for (const route of extraRoutes) if (route(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/') return file(res, 'dashboard.html');
    if (req.method === 'GET' && p === '/overlay') return file(res, 'overlay.html');
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, JSON.stringify(h.snapshot()));
    if (req.method === 'GET' && p === '/api/events') return send(res, 200, JSON.stringify(bus.recent(200)));
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(h.snapshot())}\n\n`);
      for (const ev of bus.recent(60)) res.write(`event: ev\ndata: ${JSON.stringify(ev)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST') {
      if (p === '/api/pause') { h.pause(); return send(res, 200, '{"ok":true}'); }
      if (p === '/api/resume') { h.resume(); return send(res, 200, '{"ok":true}'); }
      if (p === '/api/replan') { h.replan(); return send(res, 200, '{"ok":true}'); }
      if (p === '/api/suggest') {
        const body = await readBody(req);
        const text = String(body?.text ?? '').trim();
        if (!text) return send(res, 400, '{"error":"text required"}');
        h.suggest(text);
        return send(res, 200, '{"ok":true}');
      }
    }
    send(res, 404, '{"error":"not found"}');
  });
  server.on('error', (e) => bus.publish('dashboard', 'P1', `控制台启动失败：${e.message}`));
  server.listen(port, host, () => bus.publish('dashboard', 'P3', `控制台 http://${host}:${port}  ·  OBS 叠加 http://${host}:${port}/overlay`));
  return server;
}

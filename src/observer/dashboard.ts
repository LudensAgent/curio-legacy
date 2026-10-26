import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AgentEvent, EventBus } from '../events.ts';
import type { LlmTrace } from '../planner/llm-trace.ts';
import { itemTextures } from './item-textures.ts';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));

/** 本地 node_modules 里的 gridstack（npm install 后可离线使用；没有时页面回退到 CDN） */
function gridstackDist(): string | null {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve('gridstack/package.json')), 'dist');
  } catch {
    return null;
  }
}
const VENDOR_FILES: Record<string, string> = { 'gridstack-all.js': 'application/javascript; charset=utf-8', 'gridstack.min.css': 'text/css; charset=utf-8' };

export interface DashboardHandlers {
  snapshot(): unknown;
  pause(): void;
  resume(): void;
  replan(): void;
  suggest(text: string): void;
  /** 切换自动旁观（附着到 Bot / 自由旁观） */
  spectate?(on: boolean): Promise<unknown> | unknown;
  /** 弹幕存档：?dates=1 列出有存档的日期；否则按 date / q / questions / blocked / limit 查询 */
  danmaku?(query: URLSearchParams): unknown;
}

/**
 * 本地控制台：只绑定 127.0.0.1。
 * - /          控制台
 * - /overlay   OBS 浏览器源（透明背景的状态叠加）
 * - /api/stream  Server-Sent Events：每秒推送状态 + 实时事件
 */
/** extraRoutes：在控制台路由之前尝试的处理器（返回 true 表示已处理），用于挂载 Curio Observer 数据流 */
export function startDashboard(
  host: string,
  port: number,
  bus: EventBus,
  h: DashboardHandlers,
  extraRoutes: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean)[] = [],
  opts: { llmTrace?: LlmTrace; mcVersion?: string } = {},
) {
  const clients = new Set<http.ServerResponse>();
  const textures = itemTextures(opts.mcVersion ?? '1.20.1');
  const vendorDir = gridstackDist();

  // LLM 调用的实时追踪（请求全文 + 流式增量）
  opts.llmTrace?.on('llm', (ev: unknown) => {
    const line = `event: llm\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(line);
  });

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
    // 背包里的物品贴图：/textures/item/oak_log.png
    if (req.method === 'GET' && p.startsWith('/textures/item/')) {
      const file = textures.resolve(decodeURIComponent(p.slice('/textures/item/'.length)).replace(/\.png$/, ''));
      if (!file) return send(res, 404, 'not found', 'text/plain');
      return fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, 'not found', 'text/plain');
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        res.end(data);
      });
    }
    if (req.method === 'GET' && p.startsWith('/vendor/gridstack/')) {
      const name = p.slice('/vendor/gridstack/'.length);
      if (!vendorDir || !VENDOR_FILES[name]) return send(res, 404, 'not found', 'text/plain');
      return fs.readFile(path.join(vendorDir, name), (err, data) => (err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, data.toString(), VENDOR_FILES[name])));
    }
    if (req.method === 'GET' && p === '/api/llm') return send(res, 200, JSON.stringify(opts.llmTrace?.recent() ?? []));
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, JSON.stringify(h.snapshot()));
    if (req.method === 'GET' && p === '/api/events') return send(res, 200, JSON.stringify(bus.recent(200)));
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(h.snapshot())}\n\n`);
      for (const ev of bus.recent(60)) res.write(`event: ev\ndata: ${JSON.stringify(ev)}\n\n`);
      if (opts.llmTrace) res.write(`event: llm_init\ndata: ${JSON.stringify(opts.llmTrace.recent())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && p === '/api/danmaku') {
      if (!h.danmaku) return send(res, 404, '{"error":"not supported"}');
      return send(res, 200, JSON.stringify(h.danmaku(url.searchParams)));
    }
    if (req.method === 'POST') {
      if (p === '/api/pause') { h.pause(); return send(res, 200, '{"ok":true}'); }
      if (p === '/api/resume') { h.resume(); return send(res, 200, '{"ok":true}'); }
      if (p === '/api/replan') { h.replan(); return send(res, 200, '{"ok":true}'); }
      if (p === '/api/spectate') {
        const body = await readBody(req);
        if (!h.spectate) return send(res, 404, '{"error":"not supported"}');
        const r = await h.spectate(body?.on !== false);
        return send(res, 200, JSON.stringify({ ok: true, status: r }));
      }
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

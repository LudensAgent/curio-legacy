import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AgentEvent, EventBus } from '../events.ts';
import type { LlmTrace } from '../planner/llm-trace.ts';
import { itemTextures } from './item-textures.ts';
import { envStore, type EnvStoreOptions } from './env-config.ts';
import { parseHudLayout, type HudLayout } from './hud-layout.ts';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
/** 一个实时连接最多积压多少没读走的数据，超过就断开 */
export const MAX_BACKLOG = 16 * 1024 * 1024;

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
  /** 紧急救援：找最近的露天平地，用 RCON 把 Bot 传送过去 */
  rescue?(): Promise<unknown>;
  /** 一键天亮：用 RCON /time set day 把游戏时间跳到白天 */
  dawn?(): Promise<{ ok: boolean; error?: string }>;
  /** 给予物品：用 RCON /give 把物品塞进 Bot 背包 */
  give?(item: string, count: number): Promise<{ ok: boolean; error?: string; item?: string; count?: number }>;
  /** 所有已知物品（英文名 + 中文名，控制台「给予物品」搜索） */
  listItems?(): { name: string; zh: string }[];
  /** 清除实体：用 RCON /kill 杀掉 Bot 周围指定类型、指定半径内的所有实体（不含玩家） */
  killEntities?(type: string, radius: number): Promise<{ ok: boolean; error?: string; type?: string; radius?: number }>;
  /** 周围现有的实体类型（英文名 + 中文名，控制台「清除实体」搜索） */
  listEntities?(): { name: string; zh: string }[];
  /** 手动整理技能，运行中返回 busy，完成后返回可读结果。 */
  curateSkills?(): Promise<{ ok: true; result: string } | { ok: false; error: string; busy?: boolean }>;
  /** 列出当前技能（内置 + 自学）与禁用状态 */
  listSkills?(): { name: string; kind: 'builtin' | 'self'; disabled: boolean; retired?: string; description?: string; version?: number; candidate?: boolean }[];
  /** 禁用/启用一个技能，作用到运行进程并持久化 */
  setSkill?(name: string, disabled: boolean): { ok: boolean; error?: string };
  /** 删除一个自学技能（内置技能只能禁用，不能删除） */
  deleteSkill?(name: string): { ok: boolean; error?: string };
  /** 清除所有自学技能（内置技能不受影响，只能禁用） */
  clearSkills?(): Promise<{ ok: boolean; error?: string; cleared?: number }>;
  /** 从记忆里移除一个地点（含基地）；只动记忆，不改世界里的方块 */
  forgetPlace?(id: string): { ok: boolean; error?: string; place?: { id: string; kind: string; label: string; dim: string; pos: { x: number; y: number; z: number } } };
  /** 列出全部窍门与日记，供控制台人工清理 */
  listMindNotes?(): { knowHow: { id: string; text: string; kind: string | null; source: string; wins: number; losses: number; unverified: boolean; createdAt: number; updatedAt: number }[]; diary: { at: number; text: string; dim: string }[] };
  /** 人工删除窍门（按 id）或日记（按写下时间 at）；作用到运行中的心智并随定时保存写回 mind.json */
  forgetMindNotes?(kind: 'knowHow' | 'diary', ids: string[] | number[]): { ok: boolean; error?: string; removed?: { id?: string; at?: number; text: string }[] };
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
/** extraRoutes：在布局遥测之外的控制台路由之前尝试的处理器（返回 true 表示已处理），用于挂载 Curio Observer 数据流 */
export function startDashboard(
  host: string,
  port: number,
  bus: EventBus,
  h: DashboardHandlers,
  extraRoutes: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean)[] = [],
  opts: { llmTrace?: LlmTrace; mcVersion?: string; env?: EnvStoreOptions } = {},
) {
  const clients = new Set<http.ServerResponse>();
  let slowDropped = 0;
  let hudLayout: (HudLayout & { receivedAt: number }) | null = null;
  /**
   * 往一个 SSE 连接里写一帧。不看背压的话，对方不读（浏览器标签被冻结、OBS 源卡住、半开的连接）时，
   * 每秒一整份状态快照和每次 LLM 调用的全文都会堆在这个进程的内存里，几个小时就能把堆撑满。
   * - 状态帧本身就是整份快照：对方还没读完上一批就跳过这一帧，下一秒的会补上；
   * - 事件和 LLM 帧照常写，但积压超过 MAX_BACKLOG 就断开这个连接（EventSource 会自己重连，重连时补发最近的事件）。
   */
  const push = (c: http.ServerResponse, line: string, droppable = false) => {
    if (c.destroyed || c.writableEnded) { clients.delete(c); return; }
    if (droppable && c.writableNeedDrain) return;
    c.write(line);
    if (c.writableLength > MAX_BACKLOG) {
      const mb = Math.round(c.writableLength / 1048576);
      clients.delete(c);
      c.destroy();
      slowDropped++;
      // 在总线的事件回调里，别同步再发事件
      queueMicrotask(() => bus.publish('dashboard_slow_client', 'P1', `控制台/叠加页的一个实时连接 ${mb} MB 没读走，断开它（它会自己重连）`, { mb }));
    }
  };
  const broadcast = (line: string, droppable = false) => { for (const c of [...clients]) push(c, line, droppable); };
  /** 实时连接的数量和积压（写进内存日志，事后能看出是不是它） */
  const streamStats = () => {
    let backlog = 0;
    for (const c of clients) backlog += c.writableLength;
    return { sseClients: clients.size, sseBacklog: backlog, sseDropped: slowDropped };
  };
  const textures = itemTextures(opts.mcVersion ?? '1.20.1');
  const vendorDir = gridstackDist();
  const env = envStore(opts.env);

  /**
   * 改 .env 能换掉 LLM 地址、密钥这些东西，所以比别的接口多三道门：
   * 只认本机连接、Host 必须是本机（防 DNS 重绑定）、有 Origin 时必须同源（防别的网页偷偷 POST）。
   */
  const localOnly = (req: http.IncomingMessage) => {
    const ra = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) return false;
    const h = String(req.headers.host ?? '');
    const listenPort = req.socket.localPort ?? port;
    if (![`127.0.0.1:${listenPort}`, `localhost:${listenPort}`, `[::1]:${listenPort}`].includes(h)) return false;
    const origin = req.headers.origin;
    return !origin || origin === `http://${h}`;
  };

  // LLM 调用的实时追踪（请求全文 + 流式增量）
  opts.llmTrace?.on('llm', (ev: unknown) => {
    if (!clients.size) return;
    broadcast(`event: llm\ndata: ${JSON.stringify(ev)}\n\n`);
  });

  bus.on('event', (ev: AgentEvent) => {
    if (ev.type === 'tick' || !clients.size) return;
    broadcast(`event: ev\ndata: ${JSON.stringify(ev)}\n\n`);
  });
  setInterval(() => {
    // 所有连接都还没读完上一帧就不必算新快照
    if (![...clients].some((c) => !c.writableNeedDrain)) return;
    broadcast(`event: state\ndata: ${JSON.stringify(h.snapshot())}\n\n`, true);
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
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/api/observer/layout') {
      if (!localOnly(req)) return send(res, 403, '{"error":"只允许本机访问 HUD 布局"}');
      if (req.method === 'GET') return send(res, 200, JSON.stringify(hudLayout));
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) return send(res, 415, '{"error":"需要 application/json"}');
        const layout = parseHudLayout(await readBody(req));
        if (!layout) return send(res, 400, '{"error":"HUD 布局格式无效"}');
        hudLayout = { ...layout, receivedAt: Date.now() };
        return send(res, 200, JSON.stringify(hudLayout));
      }
      return send(res, 405, '{"error":"method not allowed"}');
    }
    for (const route of extraRoutes) if (route(req, res)) return;
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
    if (p === '/api/env') {
      if (!localOnly(req)) return send(res, 403, '{"error":"只允许在本机的控制台页面里修改配置"}');
      if (req.method === 'GET') return send(res, 200, JSON.stringify(env.view()));
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) return send(res, 415, '{"error":"需要 application/json"}');
        try {
          const r = env.update(await readBody(req));
          if (!r.ok) return send(res, 400, JSON.stringify(r));
          bus.publish('config', 'P1', `控制台修改了 .env：${r.changed.join('、')}（重启 Curio 后生效）`);
          return send(res, 200, JSON.stringify(r));
        } catch (e: any) {
          return send(res, 500, JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      }
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
      // 以响应（连接）关闭为准：IncomingMessage 的 close 在请求读完时就可能触发
      res.on('close', () => clients.delete(res));
      req.on('close', () => { if (res.destroyed) clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && p === '/api/danmaku') {
      if (!h.danmaku) return send(res, 404, '{"error":"not supported"}');
      return send(res, 200, JSON.stringify(h.danmaku(url.searchParams)));
    }
    if (req.method === 'GET' && p === '/api/skills') {
      if (!h.listSkills) return send(res, 404, '{"error":"not supported"}');
      return send(res, 200, JSON.stringify(h.listSkills()));
    }
    if (req.method === 'GET' && p === '/api/mind/notes') {
      if (!h.listMindNotes) return send(res, 404, '{"ok":false,"error":"当前运行不支持清理窍门与日记"}');
      return send(res, 200, JSON.stringify(h.listMindNotes()));
    }
    if (req.method === 'GET' && p === '/api/items') {
      if (!h.listItems) return send(res, 404, '{"error":"not supported"}');
      return send(res, 200, JSON.stringify({ items: h.listItems() }));
    }
    if (req.method === 'GET' && p === '/api/entities') {
      if (!h.listEntities) return send(res, 404, '{"error":"not supported"}');
      return send(res, 200, JSON.stringify({ entities: h.listEntities() }));
    }
    if (req.method === 'POST') {
      if (p === '/api/pause') { h.pause(); return send(res, 200, '{"ok":true}'); }
      if (p === '/api/resume') { h.resume(); return send(res, 200, '{"ok":true}'); }
      if (p === '/api/replan') { h.replan(); return send(res, 200, '{"ok":true}'); }
      if (p === '/api/skills/curate') {
        if (!h.curateSkills) return send(res, 404, '{"ok":false,"error":"当前运行不支持手动整理技能"}');
        try {
          const result = await h.curateSkills();
          return send(res, result.ok ? 200 : result.busy ? 409 : 500, JSON.stringify(result));
        } catch (error) {
          return send(res, 500, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      }
      if (p === '/api/skills/disable' || p === '/api/skills/enable' || p === '/api/skills/delete') {
        if (!h.setSkill) return send(res, 404, '{"ok":false,"error":"当前运行不支持单独禁用技能"}');
        const body = await readBody(req);
        const name = String(body?.name ?? '').trim();
        if (!name) return send(res, 400, '{"ok":false,"error":"name 不能为空"}');
        try {
          const r = p.endsWith('/disable') ? h.setSkill(name, true)
            : p.endsWith('/enable') ? h.setSkill(name, false)
              : h.deleteSkill ? h.deleteSkill(name) : { ok: false, error: '当前运行不支持删除技能' };
          return send(res, r.ok ? 200 : 400, JSON.stringify(r));
        } catch (error) {
          return send(res, 500, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      }
      if (p === '/api/memory/forget') {
        if (!h.forgetPlace) return send(res, 404, '{"ok":false,"error":"当前运行不支持移除地点记忆"}');
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) return send(res, 400, '{"ok":false,"error":"id 不能为空"}');
        const r = h.forgetPlace(id);
        return send(res, r.ok ? 200 : 400, JSON.stringify(r));
      }
      if (p === '/api/mind/notes/forget') {
        if (!h.forgetMindNotes) return send(res, 404, '{"ok":false,"error":"当前运行不支持清理窍门与日记"}');
        const body = await readBody(req);
        const kind = body?.kind;
        const ids: unknown[] = Array.isArray(body?.ids) ? body.ids : [];
        if (kind === 'knowHow') {
          const names = ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
          if (!names.length) return send(res, 400, '{"ok":false,"error":"ids 需要非空的窍门 id 列表"}');
          const r = h.forgetMindNotes('knowHow', names);
          return send(res, r.ok ? 200 : 400, JSON.stringify(r));
        }
        if (kind === 'diary') {
          const ats = ids.filter((id): id is number => Number.isSafeInteger(id));
          if (!ats.length) return send(res, 400, '{"ok":false,"error":"ids 需要非空的日记写下时间（at）列表"}');
          const r = h.forgetMindNotes('diary', ats);
          return send(res, r.ok ? 200 : 400, JSON.stringify(r));
        }
        return send(res, 400, '{"ok":false,"error":"kind 只能是 knowHow 或 diary"}');
      }
      if (p === '/api/skills/clear') {
        if (!h.clearSkills) return send(res, 404, '{"ok":false,"error":"当前运行不支持清除所有技能"}');
        try {
          const r = await h.clearSkills();
          return send(res, r.ok ? 200 : 500, JSON.stringify(r));
        } catch (error) {
          return send(res, 500, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      }
      if (p === '/api/rescue') {
        if (!h.rescue) return send(res, 404, '{"error":"not supported"}');
        const r = await h.rescue();
        return send(res, 200, JSON.stringify(r));
      }
      if (p === '/api/dawn') {
        if (!h.dawn) return send(res, 404, '{"error":"not supported"}');
        const r = await h.dawn();
        return send(res, r.ok ? 200 : 500, JSON.stringify(r));
      }
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
      if (p === '/api/give') {
        if (!h.give) return send(res, 404, '{"error":"not supported"}');
        const body = await readBody(req);
        const item = String(body?.item ?? '').trim();
        const count = Number(body?.count ?? 1);
        if (!item) return send(res, 400, '{"error":"item required"}');
        if (!Number.isInteger(count) || count < 1) return send(res, 400, '{"error":"count must be a positive integer"}');
        const r = await h.give(item, Math.min(Math.floor(count), 640));
        return send(res, r.ok ? 200 : 500, JSON.stringify(r));
      }
      if (p === '/api/kill-entities') {
        if (!h.killEntities) return send(res, 404, '{"error":"not supported"}');
        const body = await readBody(req);
        const type = String(body?.type ?? '').trim();
        const radius = Number(body?.radius ?? 10);
        if (!type) return send(res, 400, '{"error":"type required"}');
        if (!Number.isInteger(radius) || radius < 1) return send(res, 400, '{"error":"radius must be a positive integer"}');
        const r = await h.killEntities(type, Math.min(Math.floor(radius), 128));
        return send(res, r.ok ? 200 : 500, JSON.stringify(r));
      }
    }
    send(res, 404, '{"error":"not found"}');
  });
  server.on('error', (e) => bus.publish('dashboard', 'P1', `控制台启动失败：${e.message}`));
  server.listen(port, host, () => bus.publish('dashboard', 'P3', `控制台 http://${host}:${port}  ·  OBS 叠加 http://${host}:${port}/overlay`));
  return Object.assign(server, { streamStats });
}

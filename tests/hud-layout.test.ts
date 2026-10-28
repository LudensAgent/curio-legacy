import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { startDashboard } from '../src/observer/dashboard.ts';
import { parseHudLayout } from '../src/observer/hud-layout.ts';

const layout = {
  viewport: { framebufferWidth: 3840, framebufferHeight: 2160, guiWidth: 1280, guiHeight: 720, guiScale: 3 },
  panels: { inventory: { x: 589, y: 8, width: 102, height: 69.6 } },
};

test('HUD layout retains exact 4K GUI bounds and permits an empty or clipped display', () => {
  assert.deepEqual(parseHudLayout(layout), layout);
  const empty = { ...layout, panels: {} };
  assert.deepEqual(parseHudLayout(empty), empty);
  const clipped = { ...layout, panels: { vitals: { x: -200, y: -30, width: 1500, height: 800 } } };
  assert.deepEqual(parseHudLayout(clipped), clipped);
});

test('HUD layout rejects inconsistent viewports, unknown panels and invalid numbers', () => {
  const invalid = [
    null, [], {}, { viewport: layout.viewport, panels: [] },
    { ...layout, viewport: { ...layout.viewport, framebufferWidth: 0 } },
    { ...layout, viewport: { ...layout.viewport, guiWidth: 640 } },
    { ...layout, viewport: { ...layout.viewport, guiScale: 1.25 } },
    { ...layout, viewport: { ...layout.viewport, guiScale: NaN } },
    { ...layout, panels: { unknown: layout.panels.inventory } },
    { ...layout, panels: { inventory: null } },
    ...[NaN, Infinity, '8'].map((x) => ({ ...layout, panels: { inventory: { ...layout.panels.inventory, x } } })),
    ...[0, -1, Infinity].map((width) => ({ ...layout, panels: { inventory: { ...layout.panels.inventory, width } } })),
  ];
  invalid.forEach((value) => assert.equal(parseHudLayout(value), null));
});

test('HUD layout endpoint stores only valid telemetry, precedes observer routes and never controls the bot', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-hud-layout-'));
  let controls = 0;
  let delegated = 0;
  const control = () => { controls++; };
  const server = startDashboard('127.0.0.1', 0, new EventBus(), {
    snapshot: () => { controls++; return {}; }, pause: control, resume: control, replan: control, suggest: control,
  }, [(_req, res) => { delegated++; res.writeHead(404); res.end(); return true; }], {
    env: { file: path.join(dir, '.env'), backupDir: dir },
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/observer/layout`;
  const get = () => fetch(url);
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(await (await get()).json(), null);
  const before = Date.now();
  const saved = await (await post(layout)).json();
  assert.deepEqual(saved.viewport, layout.viewport);
  assert.deepEqual(saved.panels, layout.panels);
  assert.ok(saved.receivedAt >= before && saved.receivedAt <= Date.now());
  assert.deepEqual(await (await get()).json(), saved);
  assert.equal((await post({ ...layout, panels: { bogus: {} } })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(layout) })).status, 415);
  assert.deepEqual(await (await get()).json(), saved);
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 405);
  assert.deepEqual((await (await post({ ...layout, panels: {} })).json()).panels, {});
  assert.equal(controls, 0);
  assert.equal(delegated, 0);
  assert.deepEqual(fs.readdirSync(dir), []);

  const request = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    http.get(url, { headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
  assert.equal(await request({ host: 'other.example' }), 403);
  assert.equal(await request({ origin: 'https://other.example' }), 403);
  assert.equal(await request({ origin: `http://127.0.0.1:${address.port}` }), 200);
  assert.deepEqual((await (await get()).json()).panels, {});
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { EventBus } from '../src/events.ts';
import { SelfModel } from '../src/mind/self.ts';
import { startDashboard } from '../src/observer/dashboard.ts';

async function dashboard(t: TestContext, self: SelfModel) {
  const noop = () => {};
  const server = startDashboard('127.0.0.1', 0, new EventBus(), {
    snapshot: () => ({}), pause: noop, resume: noop, replan: noop, suggest: noop,
    listMindNotes: () => self.notesForReview(),
    forgetMindNotes: (kind, ids) => {
      const removed = kind === 'knowHow' ? self.forgetKnowHow(ids as string[]) : self.forgetDiary(ids as number[]);
      return removed.length ? { ok: true, removed } : { ok: false, error: '没有匹配的条目（可能已经删了）' };
    },
  }, [], { env: { file: path.join(os.tmpdir(), randomUUID(), '.env') } });
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('控制台列出并删除窍门与日记：作用到运行中的心智，保存后写回 mind.json，其余条目不动', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-notes-'));
  const file = path.join(dir, 'mind.json');
  const self = new SelfModel(file);
  t.after(() => { self.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  self.learn('explore_toward 在封闭石腔里不会挖穿，先用 excavate_run 打通', { source: 'reflection' });
  self.learn('天黑前回已知床', { source: 'reflection' });
  self.writeDiary('今天在下界挖了很久平巷', 'the_nether', [0, 70, 0]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  self.writeDiary('回门厅清包', 'overworld', [0, 64, 0]);
  const base = await dashboard(t, self);

  const listed = await (await fetch(`${base}/api/mind/notes`)).json() as { knowHow: { id: string; text: string }[]; diary: { at: number; text: string }[] };
  assert.equal(listed.knowHow.length, 2);
  assert.equal(listed.diary.length, 2);
  const target = listed.knowHow.find((k) => k.text.includes('excavate_run'))!;

  const kh = await post(`${base}/api/mind/notes/forget`, { kind: 'knowHow', ids: [target.id] });
  assert.equal(kh.status, 200);
  assert.deepEqual((await kh.json() as { removed: { id: string }[] }).removed.map((r) => r.id), [target.id]);
  const dy = await post(`${base}/api/mind/notes/forget`, { kind: 'diary', ids: [listed.diary[0]!.at] });
  assert.equal(dy.status, 200);

  self.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { knowHow: { text: string }[]; diary: { text: string }[] };
  assert.deepEqual(saved.knowHow.map((k) => k.text), ['天黑前回已知床'], '只删掉选中的窍门');
  assert.deepEqual(saved.diary.map((d) => d.text), ['回门厅清包'], '只删掉选中的日记');

  const again = await post(`${base}/api/mind/notes/forget`, { kind: 'knowHow', ids: [target.id] });
  assert.equal(again.status, 400, '已删的条目再删报找不到');
  assert.equal((await post(`${base}/api/mind/notes/forget`, { kind: 'agenda', ids: ['x'] })).status, 400, 'kind 只认 knowHow/diary');
  assert.equal((await post(`${base}/api/mind/notes/forget`, { kind: 'diary', ids: ['not-a-number'] })).status, 400);
});

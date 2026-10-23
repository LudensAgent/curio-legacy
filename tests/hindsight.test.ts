import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { HindsightBackend } from '../src/memory/hindsight.ts';
import type { MemoryEpisode } from '../src/memory/types.ts';

const bankId = 'minecraft-agent-test';
const bankRoute = `/v1/default/banks/${bankId}`;
const scope = ['world:survival-1', 'dimension:overworld'];
const episode: MemoryEpisode = {
  id: 'episode-123', ts: Date.UTC(2026, 9, 23, 12), worldId: 'survival-1',
  dimension: 'overworld', source: 'skill:explore', kind: 'experience',
  text: 'I found a village north of home.',
};
const activeSignal = () => new AbortController().signal;

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fixture(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    Promise.resolve(handle(request, response)).catch(error => {
      json(response, { detail: String(error) }, 500);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return new HindsightBackend({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-only-key', bankId });
}

test('Hindsight retain uses the official SDK route, synchronous stable document IDs and explicit provenance', async t => {
  const requests: any[] = [];
  const backend = await fixture(t, async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `${bankRoute}/memories`);
    assert.equal(request.headers.authorization, 'Bearer test-only-key');
    assert.match(String(request.headers['user-agent']), /hindsight-client-typescript/);
    requests.push(await body(request));
    json(response, { success: true, bank_id: bankId, items_count: 1, async: false });
  });
  await backend.retain(episode, activeSignal());
  await backend.retain({ ...episode, kind: 'inference', text: 'This village might be safe.' }, activeSignal());
  for (const request of requests) {
    assert.equal(request.async, false);
    const item = request.items[0];
    assert.equal(item.document_id, episode.id);
    assert.equal(item.update_mode, 'replace');
    assert.equal(item.timestamp, '2026-10-23T12:00:00.000Z');
    assert.equal(item.metadata.source, episode.source);
    assert.equal(item.metadata.world_id, episode.worldId);
    assert.equal(item.metadata.dimension, episode.dimension);
    assert.deepEqual(item.observation_scopes, [scope]);
    for (const tag of [...scope, `source:${episode.source}`, 'time:2026-10-23T12:00:00.000Z']) assert.ok(item.tags.includes(tag));
  }
  assert.equal(requests[0].items[0].metadata.kind, 'experience');
  assert.match(requests[0].items[0].content, /First-person gameplay experience/);
  assert.equal(requests[1].items[0].metadata.kind, 'inference');
  assert.match(requests[1].items[0].content, /hypothesis.*may be wrong/);
});

test('Hindsight recall uses all_strict scope, rejects leaked results and bounds context fields', async t => {
  const backend = await fixture(t, async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `${bankRoute}/memories/recall`);
    assert.equal(request.headers.authorization, 'Bearer test-only-key');
    const query = await body(request);
    assert.deepEqual(query.tags, scope);
    assert.equal(query.tags_match, 'all_strict');
    assert.equal(query.budget, 'low');
    assert.equal(query.max_tokens, 1200);
    assert.equal(query.include.entities, null);
    assert.equal(query.include.chunks, undefined);
    assert.equal(query.prefer_observations, true);
    const good = Array.from({ length: 10 }, (_, i) => ({
      id: `good-${i}`, text: 'village '.repeat(200), tags: scope, type: i === 0 ? 'observation' : 'experience',
      metadata: { source: 's'.repeat(200), observed_at: episode.ts.toString().repeat(10), kind: 'experience' },
    }));
    json(response, { results: [
      { id: 'untagged', text: 'leak' },
      { id: 'other-world', text: 'leak', tags: ['world:creative', scope[1]] },
      { id: 'other-dimension', text: 'leak', tags: [scope[0], 'dimension:the_nether'] },
      { id: 'empty', text: ' ', tags: scope },
      good[0], ...good,
    ] });
  });
  const entries = await backend.recall({ worldId: episode.worldId, dimension: episode.dimension, query: 'Where is the village?' }, activeSignal());
  assert.equal(entries.length, 8);
  assert.deepEqual(entries.map(entry => entry.id), Array.from({ length: 8 }, (_, i) => `good-${i}`));
  assert.equal(entries[0].kind, 'inference', 'Consolidation must not masquerade as an observed fact');
  assert.equal(entries[1].kind, 'experience');
  for (const entry of entries) {
    assert.equal(entry.text.length, 800);
    assert.equal(entry.source.length, 160);
    assert.equal(entry.observedAt?.length, 64);
  }
});

test('Hindsight recall preserves inference provenance and document source', async t => {
  const backend = await fixture(t, (_request, response) => json(response, { results: [
    { id: 'guess', text: 'Maybe there is a cave', tags: scope, type: 'world', document_id: 'episode-guess', occurred_start: '2026-10-23T00:00:00Z', metadata: { kind: 'inference' } },
    { id: 'guess-no-metadata', text: 'Maybe there is a mine', tags: [...scope, 'kind:inference'], type: 'experience' },
  ] }));
  const [entry, noMetadata] = await backend.recall({ worldId: episode.worldId, dimension: episode.dimension, query: 'cave' }, activeSignal());
  assert.equal(entry.kind, 'inference');
  assert.equal(entry.source, 'episode-guess');
  assert.equal(entry.observedAt, '2026-10-23T00:00:00Z');
  assert.equal(noMetadata.kind, 'inference');
});

test('Hindsight errors fail closed without echoing server bodies, and incomplete retain is rejected', async t => {
  let status = 500;
  const backend = await fixture(t, (_request, response) => json(response,
    status === 200 ? { success: false, async: false } : { detail: 'sensitive-server-value' }, status));
  for (const action of [
    () => backend.retain(episode, activeSignal()),
    () => backend.recall({ worldId: episode.worldId, dimension: episode.dimension, query: 'village' }, activeSignal()),
  ]) {
    await assert.rejects(action, error => error instanceof Error && /HTTP 500/.test(error.message) && !error.message.includes('sensitive-server-value'));
  }
  status = 200;
  await assert.rejects(backend.retain(episode, activeSignal()), /Hindsight retain failed/);
});

test('Hindsight propagates cancellation through the real SDK and refuses already aborted work', async t => {
  let received!: () => void;
  const pendingRequest = new Promise<void>(resolve => { received = resolve; });
  let calls = 0;
  const backend = await fixture(t, () => { calls++; received(); });
  const controller = new AbortController();
  const reason = new Error('memory deadline reached');
  const pending = backend.recall({ worldId: episode.worldId, dimension: episode.dimension, query: 'village' }, controller.signal);
  await pendingRequest;
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  await assert.rejects(backend.retain(episode, controller.signal), error => error === reason);
  await assert.rejects(backend.clear(controller.signal), error => error === reason);
  assert.equal(calls, 1);
});

test('Hindsight clear deletes only the dedicated bank, then verifies absence; real 404 is idempotent', async t => {
  const requests: string[] = [];
  let alreadyAbsent = false;
  const backend = await fixture(t, (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push(`${request.method} ${url.pathname}`);
    assert.equal(request.headers.authorization, 'Bearer test-only-key');
    if (request.method === 'DELETE') {
      assert.equal(url.pathname, bankRoute);
      json(response, alreadyAbsent ? { detail: 'not found' } : { success: true }, alreadyAbsent ? 404 : 200);
    } else {
      assert.equal(request.method, 'GET');
      assert.equal(url.pathname, '/v1/default/banks');
      assert.equal(url.searchParams.get('q'), bankId);
      assert.equal(url.searchParams.get('limit'), '100');
      assert.equal(url.searchParams.get('offset'), '0');
      json(response, { banks: [{ bank_id: `${bankId}-other` }], total: 1, limit: 100, offset: 0 });
    }
  });
  await backend.clear(activeSignal());
  alreadyAbsent = true;
  await backend.clear(activeSignal());
  assert.deepEqual(requests, [
    `DELETE ${bankRoute}`, 'GET /v1/default/banks',
    `DELETE ${bankRoute}`, 'GET /v1/default/banks',
  ]);
});

test('Hindsight clear never reports success for deletion errors, surviving banks or failed verification', async t => {
  for (const scenario of ['delete-error', 'delete-false', 'still-exists', 'verify-error']) {
    await t.test(scenario, async subtest => {
      let listed = false;
      const backend = await fixture(subtest, (request, response) => {
        if (request.method === 'DELETE') {
          json(response, { success: scenario !== 'delete-false' }, scenario === 'delete-error' ? 403 : 200);
        } else {
          listed = true;
          json(response, { banks: [{ bank_id: bankId }], total: 1, limit: 100, offset: 0 }, scenario === 'verify-error' ? 500 : 200);
        }
      });
      await assert.rejects(backend.clear(activeSignal()), /Hindsight clear failed/);
      assert.equal(listed, scenario === 'still-exists' || scenario === 'verify-error');
    });
  }
});

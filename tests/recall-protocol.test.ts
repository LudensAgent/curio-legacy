import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { OpenAICompatibleProvider } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('optional visual messages use standard image_url parts without changing text-only request format', async (t) => {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200 });
  });
  const provider = new OpenAICompatibleProvider({ ...config.llm, apiKey: '', stream: false, fakeDelayMs: 0 });
  await provider.complete([{ role: 'user', content: '比较实际轮廓', images: [{ url: 'data:image/png;base64,eA==', detail: 'low' }] }], new AbortController().signal);
  assert.deepEqual(bodies[0].messages[0].content, [{ type: 'text', text: '比较实际轮廓' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,eA==', detail: 'low' } }]);
  await provider.complete([{ role: 'user', content: '普通观察' }], new AbortController().signal);
  assert.equal(bodies[1].messages[0].content, '普通观察');
});

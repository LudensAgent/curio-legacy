import assert from 'node:assert/strict';
import { test } from 'node:test';
import { llmCategory } from '../src/planner/llm-trace.ts';

test('LLM 调用按发起的模块分类：心智三种、建筑师、技能三种', () => {
  assert.equal(llmCategory('mind:上一段活结束了，接下来做什么'), 'think');
  assert.equal(llmCategory('mind:手上这段活快干完了，想想接下来·瞥一眼'), 'glance');
  assert.equal(llmCategory('mind:回想'), 'reflect');
  assert.equal(llmCategory('architect'), 'architect');
  assert.equal(llmCategory('skill:总结（死亡）'), 'forge');
  assert.equal(llmCategory('skill:改进 local-path'), 'improve');
  assert.equal(llmCategory('skill:整理'), 'curate');
  assert.equal(llmCategory('something else'), 'other');
});

test('LLM 调用的完整记录（提示词、思考过程、完整回复）按天存到本地，重启后控制台还能读回最近的', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { LlmTrace } = await import('../src/planner/llm-trace.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-llm-'));
  const a = new LlmTrace({ dir });
  const long = '很长的回复'.repeat(1000);
  const id = a.begin({ reason: 'mind:想想现在做什么', attempt: 0, provider: 'test' }, [{ role: 'system', content: '你是 Curio' }, { role: 'user', content: '现在怎么办' }]);
  a.delta(id, { reasoning: '先想想', content: long.slice(0, 10) });
  a.end(id, { status: 'ok', text: long, latencyMs: 120, usage: { total_tokens: 99 } });
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^llm-calls-\d{8}\.jsonl$/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8').trim());
  assert.equal(saved.messages[1].content, '现在怎么办');
  assert.equal(saved.reasoning, '先想想');
  assert.equal(saved.category, 'think');
  const b = new LlmTrace({ dir });
  assert.equal(b.recent().length, 1, '重启后读回来');
  assert.equal(b.recent()[0].id, id);
});

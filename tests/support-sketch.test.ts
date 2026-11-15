import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supportSketch } from '../src/perception/support.ts';
import type { GameAdapter } from '../src/adapter/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('支撑草图列出目标上方/下方与床的另一半，不推断未知为空气', () => {
  const w = new FakeAdapter();
  w.blocks.push({ name: 'white_bed', pos: { x: 2, y: 65, z: 0 } }, { name: 'white_bed', pos: { x: 2, y: 65, z: 1 } });
  w.blocks.push({ name: 'cobblestone', pos: { x: 2, y: 66, z: 0 } });
  w.blockProperties.set('2,65,0', { part: 'foot', facing: 'south' });
  w.blockProperties.set('2,65,1', { part: 'head', facing: 'south' });
  const facts = supportSketch(w, { x: 2, y: 65, z: 0 });
  assert.match(facts.text, /目标 white_bed @\(2,65,0\)/);
  assert.match(facts.text, /上方 y66=cobblestone/, '床脚上方有阻挡要如实列出');
  assert.match(facts.text, /下方 y64=air、y63=grass_block、y62=stone/);
  assert.match(facts.text, /另一半 white_bed @\(2,65,1\)，上方 y66=air，下方 y64=air、y63=grass_block/, '另一半的上方/下方也要列出');
  assert.equal(facts.data.below[0]?.name, 'air');
  assert.equal(facts.data.otherHalf?.pos.z, 1);
});

test('未加载的方块写“未加载”，不当作空气或实心', () => {
  const nowhere: Pick<GameAdapter, 'blockAt'> = { blockAt: () => null };
  const facts = supportSketch(nowhere, { x: 0, y: 80, z: 0 });
  assert.match(facts.text, /目标 未加载 @\(0,80,0\)/);
  assert.match(facts.text, /下方 y79=未加载、y78=未加载、y77=未加载/);
  assert.doesNotMatch(facts.text, /空气|air/);
});

test('reach_block 失败时错误摘要真的带上目标上方/下方事实', async () => {
  const w = new FakeAdapter();
  w.blocks.push({ name: 'white_bed', pos: { x: 6, y: 64, z: 0 } }, { name: 'cobblestone', pos: { x: 6, y: 65, z: 0 } });
  const { createBodyNavigation } = await import('../src/skills/movement/body-navigation.ts');
  const { makeCtx } = await import('./survival-helpers.ts');
  const ctx = makeCtx(w);
  const nav = createBodyNavigation(ctx);
  await assert.rejects(nav.navigate({ kind: 'reach_block', pos: { x: 6, y: 64, z: 0 } }, { signal: ctx.signal, timeoutMs: 1000 }),
    (e: Error) => /目标 white_bed @\(6,64,0\)/.test(e.message) && /上方 y65=cobblestone/.test(e.message) && /下方 y63=grass_block/.test(e.message));
});

test('reach_block 失败只附一次支撑事实，Abort 错误不附', async () => {
  const w = new FakeAdapter();
  w.blocks.push({ name: 'white_bed', pos: { x: 6, y: 64, z: 0 } });
  const { createBodyNavigation } = await import('../src/skills/movement/body-navigation.ts');
  const { makeCtx } = await import('./survival-helpers.ts');
  const ctx = makeCtx(w);
  const nav = createBodyNavigation(ctx);
  const captured = await nav.navigate({ kind: 'reach_block', pos: { x: 6, y: 64, z: 0 } }, { signal: ctx.signal, timeoutMs: 1000 }).then(() => null, (e: Error & { data?: { support?: unknown }; partial?: { support?: unknown } }) => e);
  assert.ok(captured);
  assert.equal((captured.message.match(/目标 white_bed/g) ?? []).length, 1);
  assert.ok(captured.data?.support);
  assert.ok(captured.partial?.support, '结构化支撑事实要进 partial，才能被 runSkill 带回');
  const aborted = new AbortController(); aborted.abort();
  const err = await nav.navigate({ kind: 'reach_block', pos: { x: 6, y: 64, z: 0 } }, { signal: aborted.signal, timeoutMs: 1000 }).then(() => null, (e: Error) => e);
  assert.ok(err);
  assert.doesNotMatch(err.message, /目标 white_bed/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { KnowledgeBase } from '../src/knowledge/library.ts';
import { SKILLS } from '../src/skills/index.ts';
import { ok } from '../src/skills/types.ts';

function fixture(t: TestContext, documents: { id: string; title: string; aliases: string[]; version?: string; body: string }[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-knowledge-'));
  documents.forEach(({ body, version, ...metadata }) => fs.writeFileSync(path.join(directory, `${metadata.id}.md`), `---\n${Object.entries({ ...metadata,
    kind: 'mechanic', edition: 'java', versions: [version ?? '1.20.1'], versionNote: '测试夹具，非游戏事实',
    sources: [{ url: 'https://minecraft.wiki/w/Villager', title: 'Villager' }] }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return new KnowledgeBase('1.20.1', directory);
}

test('bilingual questions retrieve a relevant section and reading preserves conditions, references and related links', (t) => {
  const library = fixture(t, [{ id: 'trading', title: '村民交易', aliases: ['villager', 'restocking', '村民'], body:
    '## profession | 职业\n测试资料：村民职业和工作站。\n\n## restock | 补货条件\n测试资料：村民需要能接触自己的工作站才能补货；交易次数不是当前库存。\n\n另见 [职业](knowledge:trading#profession)。' }]);
  for (const query of ['村民为什么不补货', 'restocking', 'villager']) {
    const search = library.query({ query });
    assert.equal(search.action, 'search');
    assert.ok('matches' in search);
    assert.ok(search.matches.some((match) => match.id === 'trading' && match.section === 'restock'), query);
  }
  const read = library.query({ id: 'trading', section: 'restock' });
  assert.ok('document' in read);
  assert.equal(read.evidence, 'reference_not_current_state');
  assert.equal(read.document.kind, 'mechanic');
  assert.deepEqual(read.document.versions, ['1.20.1']);
  assert.match(read.document.sections[0].text, /工作站才能补货/);
  assert.match(read.document.sections[0].text, /knowledge:trading#profession/);
  assert.equal(read.document.sources[0].url, 'https://minecraft.wiki/w/Villager');
});

test('catalog and searches exclude incompatible documents and report unknown or invalid requests without inventing answers', (t) => {
  const library = fixture(t, [
    { id: 'current', title: '当前测试资料', aliases: ['fixture-current'], body: '## facts | 说明\n本版本的测试内容。' },
    { id: 'future', title: '未来测试资料', aliases: ['fixture-future'], version: '1.21', body: '## facts | 说明\n只属于未来版本的特别机制。' },
  ]);
  const catalog = library.query({});
  assert.ok('documents' in catalog);
  assert.ok(catalog.documents.some((document) => document.id === 'current'));
  assert.ok(!catalog.documents.some((document) => document.id === 'future'));
  const search = library.query({ query: 'quantumtelekinesis999' });
  assert.ok('matches' in search);
  assert.deepEqual(search.matches, []);
  for (const input of [{ id: 'future' }, { id: '../outside' }, { id: 'current', section: 'absent' }, { section: 'facts' }, { query: 7 }, { query: 'x', id: 'current' }]) {
    assert.equal(library.query(input).action, 'error');
  }
});

test('operation references reflect the live registry exactly without invoking or registering an action', (t) => {
  const library = fixture(t, []), name = 'knowledge_fixture_control';
  let invoked = false;
  SKILLS[name] = { name, description: '接口测试：只移动指定物品，不准备其他资源。', argsDoc: '{"item":"具体物品"}',
    timeoutMs: 1000, movement: false, validate: () => ({ ok: true, args: {} }), run: async () => { invoked = true; return ok('done'); } };
  t.after(() => { delete SKILLS[name]; });
  const registered = Object.entries(SKILLS);
  const read = library.query({ id: 'agent-controls', section: name });
  assert.ok('document' in read);
  assert.equal(read.document.kind, 'control');
  assert.match(read.document.sections[0].text, /只移动指定物品/);
  assert.ok(read.document.sections[0].text.includes(SKILLS[name].argsDoc));
  assert.equal(invoked, false);
  assert.deepEqual(Object.entries(SKILLS), registered);
  const hidden = library.query({ id: 'agent-controls', section: 'unstuck' });
  assert.equal(hidden.action, 'error');
});

test('long document responses stay bounded and omitted sections remain individually readable', (t) => {
  const library = fixture(t, [{ id: 'long-topic', title: '长资料', aliases: ['long-reference'], body:
    ['first', 'second', 'third'].map((id) => `## ${id} | ${id}\n${'完整条件和例外。'.repeat(400)}`).join('\n\n') }]);
  const read = library.query({ id: 'long-topic' });
  assert.ok('document' in read);
  assert.ok(JSON.stringify(read).length < 6500);
  assert.ok(read.document.sections.some((section) => section.truncated));
  assert.equal(read.document.nextSection, 'third');
  const section = library.query({ id: 'long-topic', section: 'second' });
  assert.ok('document' in section);
  assert.equal(section.document.sections[0].truncated, false);
  assert.equal(section.document.sections[0].text, '完整条件和例外。'.repeat(400));
});

test('bundled Java 1.20.1 references load, answer representative questions and have resolvable chapter links', () => {
  const library = new KnowledgeBase('1.20.1'), catalog = library.query({});
  assert.ok('documents' in catalog);
  assert.ok(catalog.documents.filter((document) => document.kind !== 'control').length >= 10);
  for (const [query, id] of [['村民为什么不补货', 'villagers-and-trading'], ['羊毛怎样重新长出来', 'animal-husbandry'],
    ['nether_portal', 'portals-and-dimensions'], ['grindstone', 'enchanting-and-repair']]) {
    const search = library.query({ query });
    assert.ok('matches' in search);
    assert.equal(search.matches[0]?.id, id, query);
  }
  catalog.documents.filter((document) => document.kind !== 'control').forEach(({ id }) => {
    const read = library.query({ id });
    assert.ok('document' in read);
    assert.deepEqual(read.document.versions, ['1.20.1']);
    read.document.sections.forEach(({ text }) => [...text.matchAll(/\]\(knowledge:([a-z0-9-]+)(?:#([a-z0-9-]+))?\)/g)].forEach((link) => {
      const target = library.query({ id: link[1], ...(link[2] ? { section: link[2] } : {}) });
      assert.equal(target.action, 'read', link[0]);
    }));
  });
});

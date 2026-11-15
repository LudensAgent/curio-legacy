import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { KnowledgeBase } from '../src/knowledge/library.ts';
import { SKILLS } from '../src/skills/index.ts';
import { ok } from '../src/skills/types.ts';

test('inventory stack knowledge is searchable and distinguishes slots from item quantities', () => {
  const library = new KnowledgeBase('1.20.1');
  for (const query of ['背包物品堆叠', '铁锭一格能放多少', 'inventory stack']) {
    const result = library.query({ query, limit: 12 });
    assert.ok('matches' in result);
    assert.ok(result.matches.some((match) => match.id === 'inventory-and-stacks'), query);
  }
  const result = library.query({ id: 'inventory-and-stacks', section: 'stacking' });
  assert.ok('document' in result);
  assert.match(result.document.sections[0].text, /粗铁和铁锭/);
  assert.match(result.document.sections[0].text, /没有空槽位并不必然/);
  assert.ok(result.document.sources.some((source) => source.url === 'https://minecraft.wiki/w/Item'));
});

test('英文机制词只写在别名里也能定位文档；只有别名命中时给目录摘要，不硬选章节', () => {
  const library = new KnowledgeBase('1.20.1');
  const result = library.query({ query: 'hoe farmland grass block' });
  assert.ok('matches' in result);
  const hit = result.matches.find((match) => match.id === 'crop-farming');
  assert.ok(hit, JSON.stringify(result.matches));
  assert.equal(hit.section, undefined, '别名只定位文章，不把某个章节冒充成最相关');
  assert.match(hit.excerpt, /耕地种植/);
});

function fixture(t: TestContext, documents: { id: string; title: string; aliases: string[]; version?: string; sources?: { url: string; title: string }[]; body: string }[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-knowledge-'));
  documents.forEach(({ body, version, sources, ...metadata }) => fs.writeFileSync(path.join(directory, `${metadata.id}.md`), `---\n${Object.entries({ ...metadata,
    kind: 'mechanic', edition: 'java', versions: [version ?? '1.20.1'], versionNote: '测试夹具，非游戏事实',
    sources: sources ?? [{ url: 'https://minecraft.wiki/w/Villager', title: 'Villager' }] }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`));
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
    assert.ok(search.matches.some((match) => match.id === 'trading'), query);
    if (query === '村民为什么不补货') assert.equal(search.matches[0]?.section, 'restock');
  }
  const contents = library.query({ id: 'trading' });
  assert.ok('document' in contents);
  assert.deepEqual(contents.document.sections, []);
  assert.ok('contents' in contents.document);
  assert.ok(contents.document.contents.some((section) => section.id === 'restock'));
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
  const search = library.query({ query: name });
  assert.ok('matches' in search);
  assert.equal(search.matches.some((match) => match.kind === 'control'), false);
  const hidden = library.query({ id: 'agent-controls', section: 'unstuck' });
  assert.equal(hidden.action, 'error');
});

test('long Chinese sections and source metadata obey byte budgets and cursor pages preserve the full text and references', (t) => {
  const text = '完整条件与例外，光照和降落空间。'.repeat(500);
  const sources = [0, 1].map((i) => ({ url: `https://minecraft.wiki/w/Reference${i}?context=${'a'.repeat(600)}`, title: '来源说明'.repeat(80) }));
  const library = fixture(t, [{ id: 'long-topic', title: '长中文资料', aliases: ['long-reference'], sources,
    body: `## first | 完整条件\n${text}\n\n## second | 其他条件\n第二章仍可单独阅读。` }]);
  const catalog = library.query({}), search = library.query({ query: '完整条件' }), contents = library.query({ id: 'long-topic' });
  assert.ok(Buffer.byteLength(JSON.stringify(catalog), 'utf8') <= 2400);
  assert.ok(Buffer.byteLength(JSON.stringify(search), 'utf8') <= 2400);
  assert.ok(Buffer.byteLength(JSON.stringify(contents), 'utf8') <= 6000);
  assert.ok('document' in contents);
  assert.deepEqual(contents.document.sections, []);
  assert.ok('contents' in contents.document);
  assert.ok(contents.document.contents.some((section) => section.id === 'second'));
  const chunks: string[] = [];
  let cursor = 0;
  while (chunks.join('').length < text.length) {
    const read = library.query({ id: 'long-topic', section: 'first', cursor });
    assert.ok('document' in read);
    assert.ok(Buffer.byteLength(JSON.stringify(read), 'utf8') <= 6000);
    assert.deepEqual(read.document.sources, sources);
    const section = read.document.sections[0];
    assert.ok(section.text.length > 0, 'each page must make progress');
    chunks.push(section.text);
    const end = cursor + section.text.length;
    assert.ok('nextCursor' in read.document);
    if (end < text.length) {
      assert.equal(section.truncated, true);
      assert.equal(read.document.nextCursor, end);
      cursor = read.document.nextCursor!;
    } else {
      assert.equal(section.truncated, false);
      assert.equal(read.document.nextCursor, undefined);
      cursor = end;
    }
    assert.ok(chunks.length < 100, 'cursor reading must terminate');
  }
  assert.equal(chunks.join(''), text);
  const second = library.query({ id: 'long-topic', section: 'second' });
  assert.ok('document' in second);
  assert.equal(second.document.sections[0].text, '第二章仍可单独阅读。');
});

test('shared document aliases return a short diverse result list without pretending every chapter matches', (t) => {
  const library = fixture(t, ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({ id, title: `测试主题 ${id}`, aliases: ['共有别名'],
    body: '## first | 第一章\n第一章只讨论矿石。\n\n## second | 第二章\n第二章只讨论船只。\n\n## third | 第三章\n第三章只讨论方块。' })));
  const search = library.query({ query: '共有别名' });
  assert.ok('matches' in search);
  assert.equal(search.matches.length, 2);
  assert.equal(new Set(search.matches.map((match) => match.id)).size, search.matches.length);
  search.matches.forEach((match) => {
    assert.equal(match.section, undefined, 'a document alias alone does not identify a relevant chapter');
    assert.ok(match.excerpt.length <= 120);
    assert.equal('sources' in match || 'versions' in match || 'versionNote' in match, false);
  });
  const expanded = library.query({ query: '共有别名', limit: 12 });
  assert.ok('matches' in expanded);
  assert.ok(expanded.matches.length <= 3);
  assert.equal(new Set(expanded.matches.map((match) => match.id)).size, expanded.matches.length);
  assert.ok(Buffer.byteLength(JSON.stringify(expanded), 'utf8') <= 2400);
});

test('a specific wool question selects the wool chapter without returning unrelated breeding or torch material', (t) => {
  const library = fixture(t, [
    { id: 'animal-husbandry', title: '动物引诱、繁殖与羊毛', aliases: ['羊毛', '羊', 'sheep', 'wool'], body:
      '## food | 喜爱的食物\n牛羊可以被小麦引诱。\n\n## breeding | 繁殖条件\n两只成年动物吃合适食物后可繁殖幼体。\n\n## wool | 羊毛重新生长\n剪毛后的羊吃草才能重新长出羊毛；没有草时等着也不会重新长毛。' },
    { id: 'torches-and-light', title: '火把与光照', aliases: ['火把', 'torch'], body: '## lighting | 照明\n火把能照亮周围方块。' },
  ]);
  const search = library.query({ query: '羊毛怎样重新长出来' });
  assert.ok('matches' in search);
  assert.equal(search.matches[0]?.id, 'animal-husbandry');
  assert.equal(search.matches[0]?.section, 'wool');
  assert.equal(search.matches.some((match) => match.section === 'breeding' || match.id === 'torches-and-light'), false);
  assert.equal(new Set(search.matches.map((match) => match.id)).size, search.matches.length);
  assert.ok(search.matches.every((match) => match.excerpt.length <= 120 && match.kind !== 'control'));
});

test('bundled Java 1.20.1 references load, answer representative questions and have resolvable chapter links', () => {
  const library = new KnowledgeBase('1.20.1');
  const documents: { id: string; kind: string }[] = [];
  let offset = 0;
  while (true) {
    const catalog = library.query({ offset });
    assert.ok('documents' in catalog);
    assert.ok(Buffer.byteLength(JSON.stringify(catalog), 'utf8') <= 2400);
    documents.push(...catalog.documents);
    if (!('nextOffset' in catalog) || catalog.nextOffset === undefined) break;
    assert.ok(catalog.nextOffset > offset);
    offset = catalog.nextOffset;
  }
  assert.ok(documents.filter((document) => document.kind !== 'control').length >= 10);
  for (const [query, id] of [['村民为什么不补货', 'villagers-and-trading'], ['羊毛怎样重新长出来', 'animal-husbandry'],
    ['nether_portal', 'portals-and-dimensions'], ['grindstone', 'enchanting-and-repair']]) {
    const search = library.query({ query });
    assert.ok('matches' in search);
    assert.equal(search.matches[0]?.id, id, query);
  }
  documents.filter((document) => document.kind !== 'control').forEach(({ id }) => {
    const contents = library.query({ id });
    assert.ok('document' in contents);
    assert.deepEqual(contents.document.versions, ['1.20.1']);
    assert.deepEqual(contents.document.sections, []);
    assert.ok('contents' in contents.document);
    contents.document.contents.forEach((section) => {
      const read = library.query({ id, section: section.id });
      assert.ok('document' in read);
      read.document.sections.forEach(({ text }) => [...text.matchAll(/\]\(knowledge:([a-z0-9-]+)(?:#([a-z0-9-]+))?\)/g)].forEach((link) => {
        const target = library.query({ id: link[1], ...(link[2] ? { section: link[2] } : {}) });
        assert.equal(target.action, 'read', link[0]);
      }));
    });
  });
});

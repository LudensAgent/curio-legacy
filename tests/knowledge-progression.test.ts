import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeBase } from '../src/knowledge/library.ts';

test('Free the End prerequisites and common blockers are discoverable within the compact search budget', () => {
  const library = new KnowledgeBase('1.20.1');
  const questions = [
    ['解放末地', 'free-the-end'],
    ['没有煤怎样烧铁', 'early-survival-and-resources'],
    ['在哪里找铁矿', 'ore-distribution-and-search'],
    ['没有钻石镐怎么造下界门', 'obsidian-and-portal-building'],
    ['下界的水桶为什么不能放水', 'nether-exploration'],
    ['哪里找烈焰棒', 'blazes-and-fortresses'],
    ['猪灵交易不给珍珠', 'ender-pearls-and-eyes'],
    ['末影之眼怎么合成', 'ender-pearls-and-eyes'],
    ['找不到要塞里的传送门房', 'strongholds-and-end-entry'],
    ['末地门需要几个末影之眼', 'portals-and-dimensions'],
    ['末地水晶怎样给龙回血', 'ender-dragon-and-crystals'],
    ['龙栖息时射箭有没有用', 'ender-dragon-and-crystals'],
    ['缓降药水怎么酿造', 'brewing-and-potions'],
    ['打完末影龙怎么回主世界', 'end-exit-and-recovery'],
    ['死后掉落物多久消失', 'end-exit-and-recovery'],
  ];
  questions.forEach(([query, id]) => {
    const search = library.query({ query });
    assert.ok('matches' in search);
    assert.ok(search.matches.some((match) => match.id === id), `${query}: ${JSON.stringify(search.matches)}`);
    assert.ok(search.matches.length <= 2);
    assert.ok(Buffer.byteLength(JSON.stringify(search), 'utf8') <= 2400);
  });
});

test('mechanic references preserve requirements, version conditions and effects in individual chapters', () => {
  const library = new KnowledgeBase('1.20.1');
  const chapters = [
    { id: 'free-the-end', section: 'goal-and-evidence', facts: [/击杀末影龙/, /多人/, /进度/] },
    { id: 'obsidian-and-portal-building', section: 'harvesting-or-casting', facts: [/熔岩源/, /钻石镐/, /形成黑曜石的过程不需要钻石镐/] },
    { id: 'ender-pearls-and-eyes', section: 'piglin-bartering', facts: [/成年猪灵/, /金锭/, /幼年猪灵/, /随机/] },
    { id: 'strongholds-and-end-entry', section: 'portal-frames', facts: [/十二/, /朝向环内/, /无法取回/] },
    { id: 'ender-dragon-and-crystals', section: 'dragon-phases', facts: [/1\.20\.1/, /栖息时.*免疫箭/, /龙息/] },
    { id: 'end-exit-and-recovery', section: 'exit-portal', facts: [/重生锚/, /世界出生点/, /个人重生点/] },
    { id: 'end-exit-and-recovery', section: 'death-and-items', facts: [/六千游戏刻/, /实体运算/, /暂停/] },
  ];
  chapters.forEach(({ id, section, facts }) => {
    const read = library.query({ id, section });
    assert.ok('document' in read);
    assert.equal(read.evidence, 'reference_not_current_state');
    assert.deepEqual(read.document.versions, ['1.20.1']);
    assert.ok(read.document.sources.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(read), 'utf8') <= 6000);
    assert.equal(read.document.sections[0].truncated, false);
    facts.forEach((fact) => assert.match(read.document.sections[0].text, fact, `${id}#${section}`));
  });
});

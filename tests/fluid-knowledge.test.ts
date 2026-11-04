import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeBase } from '../src/knowledge/library.ts';

test('fluid questions retrieve versioned references and distinguish water from lava fall damage', () => {
  const library = new KnowledgeBase('1.20.1');
  for (const query of ['落地水', 'fall damage', 'water bucket']) {
    const search = library.query({ query, limit: 12 });
    assert.ok('matches' in search);
    assert.ok(search.matches.some((match) => match.id === 'water-and-fluids'), query);
  }
  const read = library.query({ id: 'water-and-fluids', section: 'water-and-fall-damage' });
  assert.ok('document' in read);
  assert.equal(read.evidence, 'reference_not_current_state');
  assert.equal(read.document.kind, 'mechanic');
  assert.deepEqual(read.document.versions, ['1.20.1']);
  assert.ok(read.document.sources.some((source) => source.url === 'https://minecraft.wiki/w/Lava'));
  const text = read.document.sections[0].text;
  assert.match(text, /落地前实际进入了水/);
  assert.match(text, /tick.*摔落距离减半/);
  assert.match(text, /浅层熔岩.*仍可能摔伤/);
  assert.doesNotMatch(text, /落入熔岩同样免除摔落伤害/);
});

test('bucket references retain source refill conditions and falling-flow distinctions when read', () => {
  const library = new KnowledgeBase('1.20.1');
  const source = library.query({ id: 'water-and-fluids', section: 'source-and-flow' });
  const bucket = library.query({ id: 'water-and-fluids', section: 'bucket-use' });
  assert.ok('document' in source);
  assert.ok('document' in bucket);
  assert.match(source.document.sections[0].text, /level=0.*水源/);
  assert.match(source.document.sections[0].text, /level 8–15.*下落流水/);
  assert.match(source.document.sections[0].text, /waterSourceConversion.*true/);
  assert.ok('versionNote' in source.document);
  assert.match(source.document.versionNote ?? '', /Java 1.20.1/);
  assert.ok(source.document.sources.some((entry) => entry.url.includes('Minecraft-Java-Edition-Snapshot-22w44a')));
  assert.match(bucket.document.sections[0].text, /邻近流水填入.*重新成为水源/s);
  assert.match(bucket.document.sections[0].text, /knowledge:water-and-fluids#source-and-flow/);
  assert.equal(source.document.sections[0].truncated, false);
  assert.equal(bucket.document.sections[0].truncated, false);
});

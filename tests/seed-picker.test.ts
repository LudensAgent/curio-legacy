import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ALL_BIOMES, BIOME_TIER, spawnFilter, tierDistance } from '../src/seeds/biome-tiers.ts';
import { parseLocate, pickSeed, setLevelSeed } from '../src/seeds/seed-picker.ts';
import { seedSettings } from '../src/seeds/new-world.ts';
import { prepareNewWorld } from '../src/seeds/new-world.ts';

function server() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curio-seed-')));
  const dir = path.join(root, 'world');
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\r\nlevel-seed=1\r\nserver-port=25565\r\n');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  return { root, dir };
}
const props = (dir: string) => fs.readFileSync(path.join(dir, 'server.properties'), 'latin1');

test('出生难度分级覆盖所有主世界群系；配置可以写难度、几档或具体群系', () => {
  assert.ok(ALL_BIOMES.length >= 50);
  assert.equal(BIOME_TIER.plains, 'easy');
  assert.equal(BIOME_TIER.desert, 'hard');
  assert.ok(spawnFilter('easy', '').accept.has('cherry_grove'));
  assert.ok(!spawnFilter('easy', '').accept.has('taiga'));
  assert.ok(spawnFilter('easy,normal', '').accept.has('taiga'));
  assert.equal(spawnFilter('any', '').accept.size, 0);
  assert.deepEqual([...spawnFilter('hard', 'plains, minecraft:Meadow').accept], ['plains', 'meadow'], '写了群系就不看难度');
  assert.throws(() => spawnFilter('veryhard', ''), /easy/);
  assert.throws(() => spawnFilter('', 'narnia'), /不认识/);
  const f = spawnFilter('easy', '');
  assert.ok(tierDistance('taiga', f) < tierDistance('desert', f));
  assert.equal(tierDistance('forest', f), 0);
});

test('改种子只动 level-seed 一行，保留换行符', () => {
  const { dir } = server();
  setLevelSeed(dir, '-42');
  assert.equal(props(dir), 'level-name=world\r\nserver-port=25565\r\nlevel-seed=-42\r\n');
  setLevelSeed(dir, null);
  assert.ok(!/level-seed/.test(props(dir)));
});

test('试种子：不符合就删掉地图重来，符合就留下；都不符合用最接近的', async () => {
  const { root, dir } = server();
  setLevelSeed(dir, null);
  const biomes = ['desert', 'taiga', 'forest'];
  const seen: string[] = [];
  const trial = async (seed: string) => {
    seen.push(seed);
    assert.match(props(dir), new RegExp(`level-seed=${seed}`), '每次试之前写好种子');
    assert.ok(!fs.existsSync(path.join(dir, 'world')), '上一次的地图已经删掉');
    fs.mkdirSync(path.join(dir, 'world'));
    return { biome: biomes[seen.length - 1], spawn: { x: 0, y: 64, z: 0 } };
  };
  const ok = await pickSeed({ serverDir: dir, projectDir: root, filter: spawnFilter('easy', ''), tries: 5, java: 'java', javaArgs: [], rcon: { host: '', port: 0, password: '' }, trial });
  assert.equal(ok.matched, true);
  assert.equal(ok.biome, 'forest');
  assert.equal(seen.length, 3);
  assert.ok(fs.existsSync(path.join(dir, 'world')), '选中的世界留着，不用再生成');

  fs.rmSync(path.join(dir, 'world'), { recursive: true });
  seen.length = 0;
  biomes.splice(0, 3, 'ice_spikes', 'taiga', 'desert');
  const near = await pickSeed({ serverDir: dir, projectDir: root, filter: spawnFilter('easy', ''), tries: 3, java: 'java', javaArgs: [], rcon: { host: '', port: 0, password: '' }, trial });
  assert.equal(near.matched, false);
  assert.equal(near.biome, 'taiga', '最接近 easy 的是 normal');
  assert.match(props(dir), new RegExp(`level-seed=${near.seed}`), '种子写好，下次启动生成同一个世界');
  assert.ok(!fs.existsSync(path.join(dir, 'world')));
  await assert.rejects(async () => { fs.mkdirSync(path.join(dir, 'world')); await pickSeed({ serverDir: dir, projectDir: root, filter: spawnFilter('easy', ''), tries: 1, java: 'java', javaArgs: [], rcon: { host: '', port: 0, password: '' }, trial }); }, /已经存在/);
});

test('新世界：固定种子直接写；没配筛选就保持随机', async () => {
  const { root, dir } = server();
  setLevelSeed(dir, null);
  const w = { serverDir: dir, projectDir: root, rcon: { host: '', port: 0, password: '' } };
  assert.deepEqual(await prepareNewWorld(w, () => {}, { WORLD_SEED: '12345' }), { seed: '12345' });
  assert.match(props(dir), /level-seed=12345/);
  setLevelSeed(dir, null);
  assert.equal(await prepareNewWorld(w, () => {}, { WORLD_SPAWN_DIFFICULTY: 'any' }), null);
  assert.ok(!/level-seed/.test(props(dir)));
});

test('强制附近有村庄：读 locate 的回答；没村庄的种子不当备选，群系合适也不要', async () => {
  assert.deepEqual(parseLocate('The nearest #minecraft:village is at [123, ~, -456] (480 blocks away)', { x: 0, z: 0 }), { x: 123, z: -456, dist: 480 });
  assert.equal(parseLocate('Could not find a structure of type "#minecraft:village" nearby', { x: 0, z: 0 }), null);
  assert.equal(seedSettings({ WORLD_REQUIRE_VILLAGE: 'true' }).villageWithin, 512);
  assert.equal(seedSettings({ WORLD_REQUIRE_VILLAGE: 'false', WORLD_VILLAGE_RADIUS: '300' }).villageWithin, 0);
  assert.throws(() => seedSettings({ WORLD_REQUIRE_VILLAGE: 'on', WORLD_VILLAGE_RADIUS: '5' }), /WORLD_VILLAGE_RADIUS/);

  const { root, dir } = server();
  setLevelSeed(dir, null);
  const runs = [
    { biome: 'forest', village: null },
    { biome: 'plains', village: { x: 900, z: 0, dist: 900 } },
    { biome: 'taiga', village: { x: 200, z: 0, dist: 200 } },
    { biome: 'plains', village: { x: 300, z: 100, dist: 316 } },
  ];
  let i = 0;
  const trial = async () => { fs.mkdirSync(path.join(dir, 'world')); return { ...runs[i++], spawn: { x: 0, y: 64, z: 0 } }; };
  const base = { serverDir: dir, projectDir: root, filter: spawnFilter('easy', ''), java: 'java', javaArgs: [], rcon: { host: '', port: 0, password: '' }, trial, villageWithin: 512 };
  const ok = await pickSeed({ ...base, tries: 4 });
  assert.equal(ok.matched, true);
  assert.equal(ok.village?.dist, 316);
  fs.rmSync(path.join(dir, 'world'), { recursive: true });

  i = 0;
  const near = await pickSeed({ ...base, tries: 3 });
  assert.equal(near.matched, false);
  assert.equal(near.biome, 'taiga', '难度退而求其次，但村庄必须有');

  i = 0;
  await assert.rejects(() => pickSeed({ ...base, tries: 2 }), /都没有村庄/);
  assert.ok(!/level-seed/.test(props(dir)));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SKILLS } from '../src/skills/index.ts';

const readSource = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const readLines = (file: string) => readSource(file).split(/\r?\n/);
/** 按非标识符字符切词；不用 \b，避免转义在跨平台编辑中变成控制字符。 */
const oldNameIn = (line: string, name: string) => line.split(/[^A-Za-z0-9_]/).includes(name);
const pair = (line: number, name: string) => ({ line, name });

/**
 * C-L1-07 / D-068：可到达提示不得推荐未注册动作。base `7ba18aa` 的 `SKILLS` 实测没有
 * `goto`/`explore`/`follow_passage`/`excavate_path`/`swim_to`；旧名 `place_at`/`dig_at`/
 * `climb_up`/`descend` 也不再注册。扫描是裸词，`名字 {...}` 与「回家用 goto」这类写法都会被命中。
 *
 * C-CLEAN-01a 删掉了死技能对象（movement.ts 的 goto/explore/follow_passage、excavation.ts 的
 * excavate_path、body.ts 的 dig），它们的名字不再出现在提示源；D-069 的行号豁免随之失效。
 * 唯一保留的豁免是 movement.ts 的 surface 里 `backend: 'climb_up'` 内部标签（不是可到达提示）。
 * 守卫断言逐对确认旧名仍在，豁免过期会立即报错。
 */
const MOVEMENT = 'src/skills/movement.ts';
const CARD_FILES = ['src/skills/build.ts', 'src/skills/survival.ts', MOVEMENT];
const OLD_NAMES = ['goto', 'explore', 'follow_passage', 'excavate_path', 'swim_to', 'place_at', 'dig_at', 'climb_up', 'descend'];

const EXEMPT = [
  {
    file: MOVEMENT,
    pairs: [pair(149, 'climb_up'), pair(153, 'climb_up'), pair(155, 'climb_up')],
    why: 'surface 的 backend 内部标签，不是可到达提示',
  },
];

test('exemptions stay valid: every (line, name) pair still contains its old name', () => {
  for (const e of EXEMPT) {
    const lines = readLines(e.file);
    for (const { line, name } of e.pairs) {
      assert.ok(oldNameIn(lines[line - 1] ?? '', name), `${e.file}:${line} 已不含豁免旧名 ${name}（${e.why}）`);
    }
  }
});

test('card prompt files never recommend an unregistered legacy action name', () => {
  for (const file of CARD_FILES) {
    const exempt = new Set(EXEMPT.filter((e) => e.file === file).flatMap((e) => e.pairs.map(({ line, name }) => `${line}:${name}`)));
    readLines(file).forEach((line, i) => {
      for (const name of OLD_NAMES) {
        if (exempt.has(`${i + 1}:${name}`)) continue;
        if (oldNameIn(line, name)) assert.fail(`${file}:${i + 1} 仍推荐未注册旧名 ${name}：${line.trim().slice(0, 120)}`);
      }
    });
  }
});

test('survival hunt fallback recommends registered expedition with its real arguments', () => {
  const source = readSource('src/skills/survival.ts');
  const advice = '可以 expedition {"direction":"N|NE|E|SE|S|SW|W|NW"} 换个方向走远点（100–600 格；至少带 3 个熟食';
  assert.ok(source.includes(advice), '没有猎物时推荐的 expedition 要带真实参数与门槛');
  assert.equal(source.includes('explore 换个地方'), false, 'survival.ts 不应再推荐未注册的 explore');
  assert.ok(Object.hasOwn(SKILLS, 'expedition'));
  assert.equal(Object.hasOwn(SKILLS, 'explore'), false, 'explore 未注册时本断言才成立；若 C-CLEAN-01 后注册，需同步');
});

test('movement prompts no longer mention removed goto/explore/follow_passage names', () => {
  const source = readSource(MOVEMENT);
  for (const name of ['goto', 'explore', 'follow_passage']) {
    assert.equal(oldNameIn(source, name), false, `movement.ts 已删除死技能 ${name}，不应再出现该名`);
  }
});

test('surface guidance points at registered swim_path with a real mode, not legacy swim_to', () => {
  const source = readSource(MOVEMENT);
  const advice = 'swim_path {"xyz":[x,y,z],"mode":"water_point|dry_shore"}';
  assert.equal(source.includes('swim_to'), false, 'swim_to 未注册，surface 提示不能推荐它');
  assert.ok(source.includes(advice), 'surface 提示应给出 swim_path 的真实参数');
  assert.equal(Object.hasOwn(SKILLS, 'swim_to'), false, 'swim_to 未注册时本断言才成立');
  assert.ok(Object.hasOwn(SKILLS, 'swim_path'));
});

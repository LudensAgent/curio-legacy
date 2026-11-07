import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SKILLS, skillCatalog } from '../src/skills/index.ts';

/** 撤下且无歧义的旧技能名；动作目录和提示源扫描共用这一清单。 */
const LEGACY_SKILL_NAMES = ['place_at', 'dig_at', 'climb_up', 'goto', 'follow_passage'];
/** 只用于 SKILLS 精确键检查：step/descend 是英文常用词，文本扫描会与普通描述歧义。 */
const AMBIGUOUS_LEGACY_NAMES = ['step', 'descend'];

/** 本卡清理过提示的源文件；不含延期文件（primitives.ts / movement/water.ts / movement.ts）。 */
const CLEANED_PROMPT_SOURCES = [
  'src/skills/actions.ts',
  'src/adapter/mineflayer.ts',
  'src/perception/perception.ts',
  'src/skills/overland.ts',
  'src/skills/work.ts',
];

/** 本次修复的三类提示：不要再把未注册的导航名当动作推荐。 */
const NAV_PROMPT_SOURCES = ['src/skills/actions.ts', 'src/skills/work.ts', 'src/skills/overland.ts'];
const STALE_NAV_PROMPT = /用\s*goto|就\s*goto|goto\s*\{|用\s*follow_passage/;

const readSource = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('SKILLS registry no longer exposes legacy skill names', () => {
  // step/descend 只按精确键在这里检查：它们是英文常用词，扫描目录/源码会命中普通描述而误报。
  for (const name of [...LEGACY_SKILL_NAMES, ...AMBIGUOUS_LEGACY_NAMES]) {
    assert.equal(Object.hasOwn(SKILLS, name), false, `${name} 不应再注册为技能`);
  }
});

test('skillCatalog does not recommend legacy skill names', () => {
  // swim_path 的 argsDoc 保留真实的迁移说明（“旧名 step/dig_at/place_at 不再注册”），
  // 由 tests/water-movement-catalog.test.ts 显式断言；只排除这一句，该行其余文字仍参与检查。
  const migrationNote = '旧名 step/dig_at/place_at 不再注册（改用 move_step/mine_cell/place_cell）；';
  const lines = skillCatalog().split('\n');
  const swimLine = lines.find((line) => line.startsWith('- swim_path '));
  assert.ok(swimLine, 'swim_path 必须仍在目录里');
  assert.ok(swimLine.includes(migrationNote), 'swim_path 的迁移说明必须仍在，排除才有依据');
  const reachable = lines.map((line) => line === swimLine ? line.replace(migrationNote, '') : line).join('\n');
  for (const name of LEGACY_SKILL_NAMES) {
    assert.doesNotMatch(reachable, new RegExp(`\\b${name}\\b`), `动作目录仍推荐未注册的旧技能名 ${name}`);
  }
});

test('cleaned prompt sources no longer mention removed dig/place/climb names', () => {
  for (const file of CLEANED_PROMPT_SOURCES) {
    assert.doesNotMatch(readSource(file), /place_at|dig_at|climb_up/, `${file} 仍含旧技能名`);
  }
});

test('navigation prompts use registered plan_route/walk_path instead of legacy goto/follow_passage', () => {
  for (const file of NAV_PROMPT_SOURCES) {
    assert.doesNotMatch(readSource(file), STALE_NAV_PROMPT, `${file} 仍推荐未注册的 goto/follow_passage`);
  }
});

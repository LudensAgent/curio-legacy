import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SKILLS } from '../src/skills/index.ts';

/**
 * C-L1-07 / C-CLEAN-01c（D-067/D-068/D-071）：可到达提示不得推荐未注册动作。
 *
 * 旧名→替代映射仍需手写（替代名随能力不同而不同），与 tests/skill-prompt-names.test.ts 同口径；
 * 旧名清单由映射减掉已重新注册的键派生。检测集合不是手写：从提示字符串抽「动作命令形」token
 * （反引号包裹的 snake_case、或后跟 `{` 的调用名），要求 token 在 `SKILLS` 注册、属已登记旧名，
 * 或落在整句豁免里，这样映射外新增的未注册动作推荐会报。
 * `step`/`descend` 是英文常用词，只在 SKILLS 精确键用例里检查。
 */
const readSource = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '');
const oldNameIn = (text: string, name: string) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);

const LEGACY_NAME_MAP = new Map<string, string>([
  ['place_at', 'place_cell'], ['dig_at', 'mine_cell'], ['step', 'move_step'], ['climb_up', 'pillar_one'],
  ['descend', 'descend_to'], ['excavate_path', 'excavate_run'], ['swim_to', 'swim_path'],
  ['goto', 'resolve_target/navigate_to/advance 或 excavate_run/mine_cell/place_cell/place_support/pillar_one'],
  ['explore', 'resolve_target/navigate_to/advance'], ['follow_passage', 'resolve_target/navigate_to/advance'],
  ['walk_to', 'resolve_target/navigate_to/advance'], ['walk_route', 'navigate_to/advance'],
  ['walk_known_route', 'navigate_to/advance'],
]);
const UNMAPPED = [...LEGACY_NAME_MAP].filter(([name]) => !Object.hasOwn(SKILLS, name)).map(([name]) => name);
const AMBIGUOUS = ['step', 'descend'];
const SCANNED_NAMES = UNMAPPED.filter((name) => !AMBIGUOUS.includes(name));

const MOVEMENT = 'src/skills/movement.ts';
/** 可到达提示所在文件（01c grep 结果，与 tests/skill-prompt-names.test.ts 同一集合）。 */
const TEXT_SCAN_SOURCES = [
  'src/skills/actions.ts', 'src/skills/work.ts', 'src/skills/overland.ts', 'src/skills/build.ts',
  'src/skills/survival.ts', MOVEMENT, 'src/skills/landing.ts', 'src/skills/movement/water.ts',
];
/** C8 明列但整文件裸词会误扫引擎符号的文件：只扫字符串字面量（提示文案）。 */
const STRING_SCAN_SOURCES = ['src/skills/excavation.ts', 'src/adapter/mineflayer.ts', 'src/perception/perception.ts'];
const ALL_PROMPT_SOURCES = [...TEXT_SCAN_SOURCES, ...STRING_SCAN_SOURCES];

/** 抽取单/双/反引号字符串字面量的内容，跳过注释；提示文案就是这些内容。 */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { const n = source.indexOf('\n', i); i = n < 0 ? source.length : n; continue; }
    if (c === '/' && source[i + 1] === '*') { const n = source.indexOf('*/', i + 2); i = n < 0 ? source.length : n + 1; continue; }
    if (c !== "'" && c !== '"' && c !== '`') continue;
    const quote = c;
    let value = '';
    for (i++; i < source.length; i++) {
      if (source[i] === '\\') { value += source[++i] ?? ''; continue; }
      if (source[i] === quote) break;
      value += source[i];
    }
    out.push(value);
  }
  return out;
}
const literalsFor = (file: string) => stringLiterals(readSource(file));

const EXEMPT = [
  {
    file: MOVEMENT,
    sentence: "backend: 'climb_up',",
    names: ['climb_up'],
    why: 'surface 搭柱回执的适配器内部阶段标签，不是可到达提示；D-089(4) 保留',
  },
  {
    file: MOVEMENT,
    sentence:
      "boundary: 'blocksPlaced 按本次背包净减少的可垫方块统计；climb_up 不区分搭柱/梯子，挖开头顶的同类掉落可能抵消净差，未逐块确认放置位置',",
    names: ['climb_up'],
    why: 'surface 对内部 climbUp 能力边界的说明，不是推荐未注册技能；D-089(4) 保留',
  },
  {
    file: 'src/skills/movement/water.ts',
    sentence:
      '旧名 step/dig_at/place_at 不再注册（改用 move_step/mine_cell/place_cell）；自动 ≤4 格落差已移交 descend_to/move_step，水中上岸由 swim_path 完成；jump/climb_one 的替代是 pillar_one 与 move_step [1,1,0]。',
    names: ['step', 'dig_at', 'place_at'],
    why: 'swim_path 的迁移说明，tests/water-movement-catalog.test.ts 逐句断言；C-CLEAN-01c 保留项',
  },
  {
    file: 'src/skills/actions.ts',
    sentence: "name: 'swim_to',",
    names: ['swim_to'],
    why: 'swim_path 的未注册执行基座（water.ts 委托 swimTo.run），归属 swim_path 注册/移除收口另卡',
  },
];

/** 字符串字面量级豁免（只给抽字符串扫描用）；先断言字面量仍存在，再跳过。 */
const STRING_EXEMPT = [
  {
    file: 'src/skills/excavation.ts',
    literal: 'excavate_path',
    names: ['excavate_path'],
    why: 'D-089(3)：excavate_path 是 excavate_run/search_structure 的内部引擎基座，不是可到达推荐；未注册收口另卡',
  },
];

/** 逐句移除该文件登记的豁免句；只有扫描名单包含该句的旧名时才移除。 */
const scannedText = (file: string, names: string[] = SCANNED_NAMES) =>
  EXEMPT.filter((e) => e.file === file)
    .filter((e) => e.names.some((n) => names.includes(n)))
    .reduce((text, e) => text.replace(e.sentence, ''), stripComments(readSource(file)));
const isStringExempt = (file: string, literal: string) => STRING_EXEMPT.some((e) => e.file === file && e.literal === literal);

/** TypeScript 关键字不是动作名；`${(x as { … })}` 这类表达式会在模板字面量里产生 `as {`。 */
const TS_KEYWORDS = new Set(['as', 'if', 'else', 'for', 'while', 'do', 'try', 'catch', 'finally', 'switch', 'case', 'default', 'return', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of', 'satisfies', 'keyof', 'is', 'function', 'class', 'interface', 'type', 'const', 'let', 'var', 'await', 'yield', 'async', 'delete', 'void', 'this', 'super', 'extends', 'implements', 'enum', 'declare', 'readonly']);
/** 动作命令形：反引号包裹的 snake_case 名，或后跟 `{` 的调用名。 */
function commandTokensIn(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/`([a-z][a-z0-9_]*)`/g)) tokens.add(match[1]);
  for (const match of text.matchAll(/(?<![A-Za-z0-9_.])([a-z][a-z0-9_]*)\s*\{/g)) tokens.add(match[1]);
  return [...tokens].filter((token) => !TS_KEYWORDS.has(token));
}

test('exemptions stay valid: every registered sentence still contains its legacy names', () => {
  for (const e of EXEMPT) {
    assert.ok(readSource(e.file).includes(e.sentence), `${e.file} 已不含豁免句子（${e.why}）`);
    for (const name of e.names) assert.ok(oldNameIn(e.sentence, name), `豁免句子已不含 ${name}（${e.why}）`);
  }
});

test('string-literal exemptions stay valid: literal exists and still carries its name', () => {
  for (const e of STRING_EXEMPT) {
    assert.ok(literalsFor(e.file).includes(e.literal), `${e.file} 已不含豁免字符串（${e.why}）`);
    for (const name of e.names) assert.ok(oldNameIn(e.literal, name), `豁免字符串已不含 ${name}（${e.why}）`);
  }
});

test('prompt text sources never recommend an unregistered legacy action name', () => {
  for (const file of TEXT_SCAN_SOURCES) {
    const text = scannedText(file);
    for (const name of SCANNED_NAMES) {
      assert.equal(oldNameIn(text, name), false, `${file} 仍推荐未注册旧名 ${name}：应指向 ${LEGACY_NAME_MAP.get(name)}`);
    }
  }
});

test('C8 engine prompt files expose no unregistered legacy name in string literals', () => {
  for (const file of STRING_SCAN_SOURCES) {
    for (const literal of literalsFor(file)) {
      if (isStringExempt(file, literal)) continue;
      for (const name of SCANNED_NAMES) {
        assert.equal(oldNameIn(literal, name), false, `${file} 提示字符串仍含未注册旧名 ${name}：${literal.slice(0, 120)}`);
      }
    }
  }
});

test('prompt command-form action names are registered, mapped legacy, or sentence-exempt', () => {
  for (const file of ALL_PROMPT_SOURCES) {
    for (const literal of literalsFor(file)) {
      if (isStringExempt(file, literal)) continue;
      for (const token of commandTokensIn(literal)) {
        assert.ok(
          Object.hasOwn(SKILLS, token) || UNMAPPED.includes(token),
          `${file} 提示推荐未注册动作 ${token}：${literal.slice(0, 120)}`,
        );
      }
    }
  }
});

test('legacy map targets are registered actions', () => {
  for (const [legacy, target] of LEGACY_NAME_MAP) {
    if (Object.hasOwn(SKILLS, legacy)) continue;
    for (const name of target.split(/[\s/]+/).filter((n) => /^[a-z][a-z0-9_]*$/.test(n))) {
      assert.ok(Object.hasOwn(SKILLS, name), `${legacy} → ${name} 未在 SKILLS 注册`);
    }
  }
});

test('survival hunt fallback recommends registered expedition with its real arguments', () => {
  const source = readSource('src/skills/survival.ts');
  const advice = '可以 expedition {"direction":"N|NE|E|SE|S|SW|W|NW"} 换个方向走远点（100–600 格）';
  assert.ok(source.includes(advice), '没有猎物时推荐的 expedition 要带真实参数');
  assert.equal(source.includes('至少带 3 个熟食'), false, 'expedition 已不设食物门槛，提示不能再承诺 MISSING_MATERIALS');
  assert.equal(source.includes('explore 换个地方'), false, 'survival.ts 不应再推荐未注册的 explore');
  assert.ok(Object.hasOwn(SKILLS, 'expedition'));
  assert.equal(Object.hasOwn(SKILLS, 'explore'), false, 'explore 未注册时本断言才成立；若 C-CLEAN-01 后注册，需同步');
});

test('movement prompts no longer mention removed goto/explore/follow_passage names', () => {
  const text = scannedText(MOVEMENT, ['goto', 'explore', 'follow_passage']);
  for (const name of ['goto', 'explore', 'follow_passage']) {
    assert.equal(oldNameIn(text, name), false, `movement.ts 已删除死技能 ${name}，不应在提示里出现`);
  }
});

test('surface guidance points at registered swim_path with a real mode, not legacy swim_to', () => {
  const text = stripComments(readSource(MOVEMENT));
  const advice = 'swim_path {"xyz":[x,y,z],"mode":"water_point|dry_shore"}';
  assert.equal(text.includes('swim_to'), false, 'swim_to 未注册，surface 提示不能推荐它');
  assert.ok(text.includes(advice), 'surface 提示应给出 swim_path 的真实参数');
  assert.equal(Object.hasOwn(SKILLS, 'swim_to'), false, 'swim_to 未注册时本断言才成立');
  assert.ok(Object.hasOwn(SKILLS, 'swim_path'));
});

test('assess_landings names the registered step/landing actions, not the removed bare step/descend', () => {
  const source = readSource('src/skills/landing.ts');
  assert.ok(source.includes('与 move_step/descend_to 相同的碰撞形状'));
  assert.doesNotMatch(stripComments(source), /与 step\/descend 相同/, 'landing.ts 仍引用未注册的 step/descend');
});

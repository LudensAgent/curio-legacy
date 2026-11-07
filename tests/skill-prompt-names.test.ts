import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SKILLS, skillCatalog } from '../src/skills/index.ts';

/**
 * C-CLEAN-01c（C8）：可到达提示只用已注册动作名。
 *
 * 旧名→替代映射仍需手写（替代名随能力不同而不同）；旧名清单由该映射减掉已重新注册的键派生。
 * 检测集合不是手写：从提示字符串抽「动作命令形」token（反引号包裹的 snake_case、或后跟 `{`
 * 的调用名），要求 token 在 `SKILLS` 注册、属已登记旧名，或落在整句豁免里。
 * 这样映射外新增的未注册动作推荐会报，而不是只检查手写表里的旧名。
 */
const LEGACY_NAME_MAP = new Map<string, string>([
  ['dig_at', 'mine_cell'],
  ['place_at', 'place_cell'],
  ['step', 'move_step'],
  ['climb_up', 'pillar_one'],
  ['descend', 'descend_to'],
  ['excavate_path', 'excavate_run'],
  ['swim_to', 'swim_path'],
  // 导航旧名没有单一注册等价物：原 goto 同时带步行与挖/放能力，按实际能力分别指向两类动作。
  ['goto', 'resolve_target/plan_route/walk_path 或 excavate_run/mine_cell/place_cell/place_support/pillar_one'],
  ['explore', 'resolve_target/plan_route/walk_path'],
  ['follow_passage', 'resolve_target/plan_route/walk_path'],
  ['walk_to', 'resolve_target/plan_route/walk_path'],
  ['walk_route', 'plan_route/walk_path'],
  ['walk_known_route', 'plan_route/walk_path'],
]);

/** 未注册的旧名；文本扫描名单在此基础上排除英文常用词（step/descend），它们只按 SKILLS 精确键检查。 */
const LEGACY_NAMES = [...LEGACY_NAME_MAP].filter(([name]) => !Object.hasOwn(SKILLS, name)).map(([name]) => name);
const AMBIGUOUS_NAMES = ['step', 'descend'];
const TEXT_LEGACY_NAMES = LEGACY_NAMES.filter((name) => !AMBIGUOUS_NAMES.includes(name));
const oldNamePattern = (name: string) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);

/**
 * 可到达提示所在文件（01c grep 结果）：技能 description/argsDoc、失败摘要与迁移说明。
 * 注释不是可到达提示，扫描前剥掉；豁免只登记确实保留的引擎名/迁移说明。
 */
const PROMPT_SCAN_SOURCES = [
  'src/skills/actions.ts',
  'src/skills/work.ts',
  'src/skills/overland.ts',
  'src/skills/build.ts',
  'src/skills/survival.ts',
  'src/skills/movement.ts',
  'src/skills/landing.ts',
  'src/skills/movement/water.ts',
];

/**
 * C8 明列但整文件裸词会误扫引擎符号的文件：只抽字符串字面量（提示文案）来扫。
 * mineflayer 的 `pathfinder.goto` 是库 API，excavation.ts 的 `excavate_path` 是内部引擎基座（D-089(3)）。
 */
const STRING_SCAN_SOURCES = ['src/skills/excavation.ts', 'src/adapter/mineflayer.ts', 'src/perception/perception.ts'];
const ALL_PROMPT_SOURCES = [...PROMPT_SCAN_SOURCES, ...STRING_SCAN_SOURCES];

const readSource = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '');

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
    file: 'src/skills/movement/water.ts',
    sentence:
      '旧名 step/dig_at/place_at 不再注册（改用 move_step/mine_cell/place_cell）；自动 ≤4 格落差已移交 descend_to/move_step，水中上岸由 swim_path 完成；jump/climb_one 的替代是 pillar_one 与 move_step [1,1,0]。',
    names: ['step', 'dig_at', 'place_at'],
    why: 'swim_path 的迁移说明：tests/water-movement-catalog.test.ts 逐句断言，C-CLEAN-01c 保留项',
  },
  {
    file: 'src/skills/actions.ts',
    sentence: "name: 'swim_to',",
    names: ['swim_to'],
    why: 'swim_path 的未注册执行基座（water.ts 委托 swimTo.run）；D-089(3) 同类，改注册另卡',
  },
  {
    file: 'src/skills/movement.ts',
    sentence: "backend: 'climb_up',",
    names: ['climb_up'],
    why: 'surface 搭柱回执的适配器内部阶段标签，不是可到达动作推荐；D-089(4) 保留',
  },
  {
    file: 'src/skills/movement.ts',
    sentence:
      "boundary: 'blocksPlaced 按本次背包净减少的可垫方块统计；climb_up 不区分搭柱/梯子，挖开头顶的同类掉落可能抵消净差，未逐块确认放置位置',",
    names: ['climb_up'],
    why: 'surface 对适配器 climbUp 结果的统计边界说明，描述内部能力而非推荐未注册技能；D-089(4) 保留',
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

const exemptSentencesFor = (file: string) => EXEMPT.filter((e) => e.file === file);
/** 逐句移除该文件登记的豁免句；只有扫描名单包含该句的旧名时才移除。 */
const scannedText = (file: string, names: string[] = TEXT_LEGACY_NAMES) => exemptSentencesFor(file)
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

test('SKILLS registry no longer exposes any unmapped legacy skill name', () => {
  for (const name of LEGACY_NAMES) {
    assert.equal(Object.hasOwn(SKILLS, name), false, `${name} 仍未注册，提示应指向 ${LEGACY_NAME_MAP.get(name)}`);
  }
});

test('skillCatalog does not recommend legacy skill names', () => {
  const catalog = EXEMPT.reduce((text, e) => text.replace(e.sentence, ''), skillCatalog());
  for (const name of TEXT_LEGACY_NAMES) {
    assert.doesNotMatch(catalog, oldNamePattern(name), `动作目录仍推荐未注册的旧技能名 ${name}`);
  }
});

test('legacy map targets are registered actions (or the documented route combination)', () => {
  for (const [legacy, target] of LEGACY_NAME_MAP) {
    if (Object.hasOwn(SKILLS, legacy)) continue;
    for (const name of target.split(/[\s/]+/).filter((n) => /^[a-z][a-z0-9_]*$/.test(n))) {
      assert.ok(Object.hasOwn(SKILLS, name), `${legacy} → ${name} 未在 SKILLS 注册`);
    }
  }
});

test('prompt sources contain no unregistered legacy skill name outside registered exemptions', () => {
  for (const file of PROMPT_SCAN_SOURCES) {
    const text = scannedText(file);
    for (const name of TEXT_LEGACY_NAMES) {
      assert.doesNotMatch(text, oldNamePattern(name), `${file} 仍含未注册旧名 ${name}：应指向 ${LEGACY_NAME_MAP.get(name)}`);
    }
  }
});

test('C8 engine prompt files expose no unregistered legacy name in string literals', () => {
  for (const file of STRING_SCAN_SOURCES) {
    for (const literal of literalsFor(file)) {
      if (isStringExempt(file, literal)) continue;
      for (const name of TEXT_LEGACY_NAMES) {
        assert.doesNotMatch(literal, oldNamePattern(name), `${file} 提示字符串仍含未注册旧名 ${name}：${literal.slice(0, 120)}`);
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
          Object.hasOwn(SKILLS, token) || LEGACY_NAMES.includes(token),
          `${file} 提示推荐未注册动作 ${token}：${literal.slice(0, 120)}`,
        );
      }
    }
  }
});

test('ambiguous legacy names are not registered as actions', () => {
  // step/descend 是英文常用词：不纳入文本扫描，只按精确键检查注册表。
  for (const name of AMBIGUOUS_NAMES) {
    assert.equal(Object.hasOwn(SKILLS, name), false, `${name} 不应再注册为技能`);
  }
});

test('exemptions stay valid: sentences exist and their names appear nowhere else in the file', () => {
  for (const e of EXEMPT) {
    assert.ok(readSource(e.file).includes(e.sentence), `${e.file} 已不含豁免句子（${e.why}）`);
  }
  // 同一文件可能有多句豁免：先逐条移除该文件全部登记句，再确认旧名没有在其余提示里复现。
  for (const file of new Set(EXEMPT.map((e) => e.file))) {
    const exempt = exemptSentencesFor(file);
    const rest = exempt.reduce((text, e) => text.replace(e.sentence, ''), stripComments(readSource(file)));
    for (const name of new Set(exempt.flatMap((e) => e.names))) {
      if (AMBIGUOUS_NAMES.includes(name)) continue;
      assert.doesNotMatch(rest, oldNamePattern(name), `${file} 豁免句之外仍含 ${name}`);
    }
  }
});

test('string-literal exemptions stay valid: literal exists and still carries its name', () => {
  for (const e of STRING_EXEMPT) {
    assert.ok(literalsFor(e.file).includes(e.literal), `${e.file} 已不含豁免字符串（${e.why}）`);
    for (const name of e.names) assert.match(e.literal, oldNamePattern(name), `豁免字符串已不含 ${name}（${e.why}）`);
  }
});

test('movement prompts no longer present goto as a callable action with args', () => {
  const source = readSource('src/skills/movement.ts');
  assert.doesNotMatch(source, /goto\s*\{/, 'movement.ts 仍推荐 goto {...} 参数写法');
  assert.doesNotMatch(source, /goto\/travel_portal/, 'movement.ts 仍推荐 goto/travel_portal 组合');
});

test('navigation prompts use registered route actions', () => {
  for (const file of ['src/skills/actions.ts', 'src/skills/work.ts', 'src/skills/overland.ts', 'src/skills/build.ts', 'src/skills/survival.ts', 'src/skills/movement.ts']) {
    // 「回家用 goto」/「回家用goto」都要命中；裸词扫描在上面的整仓用例兜底。
    assert.doesNotMatch(scannedText(file), /(用|就)\s*goto|goto\s*\{|用\s*follow_passage/, `${file} 仍推荐未注册的 goto/follow_passage`);
  }
});

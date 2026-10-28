import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCheck, runSandboxed, VERIFY_METHODS } from '../src/codeskills/sandbox.ts';

test('技能保存前检查未定义名称和词法作用域，并保留代码行号', () => {
  assert.match(compileCheck('let stalled = 0;\nstall++;')!, /第 2 行.*stall/);
  assert.match(compileCheck('if (args.ready) { const landing = 1; }\nreturn landing;')!, /第 2 行.*landing/);
  assert.match(compileCheck('return { missingResult };')!, /missingResult/);
  assert.equal(compileCheck('let stalled = 0; stalled++; return { stalled };'), null);
  assert.equal(compileCheck('const advance = ({ x }) => x + 1; return advance({ x: args.x });'), null);
});

test('技能 API 拼写检查识别别名、字符串下标和解构，不匹配注释或字符串', () => {
  [
    'await api.statte();',
    'const body = api; await body.statte();',
    'await api["statte"]();',
    'const method = "statte"; await api[method]();',
    'const { statte: read } = api; await read();',
  ].forEach((code) => assert.match(compileCheck(code)!, /没有 api\.statte/, code));
  assert.equal(compileCheck('const body = api; const { state: read } = body; return await read();'), null);
  assert.equal(compileCheck('const method = args.method; return await api[method]();'), null, '动态选择已知方法仍交给运行时');
  assert.equal(compileCheck('// api.statte()、process、require、eval 都只是记录\nreturn "api.statte() process require eval Function()";'), null);
  assert.equal(compileCheck('/** @type {UnresolvedDocumentationType} */ const point = args.point; return point;'), null, '注释里的类型名不是运行时名称');
});

test('判定代码的 API 校验沿用只读方法，缓存不混淆执行和判定权限', () => {
  const code = 'const body = api; await body["digAt"](0, 1, 2);';
  assert.equal(compileCheck(code), null);
  assert.match(compileCheck(code, { allowed: VERIFY_METHODS })!, /没有 api\.digAt/);
  assert.equal(compileCheck(code), null);
  assert.equal(compileCheck('const { state } = api; return await state();', { allowed: VERIFY_METHODS }), null);
});

test('名称检查允许 vm 内建和普通 JS 的类型推断，不引入宿主全局', () => {
  assert.equal(compileCheck(`
    const positions = new Map();
    const keys = new Set(Object.keys(args));
    const now = Date.now();
    const labels = Array.from(keys).map((key) => String(key));
    const vector = new Float32Array([1, 2]);
    return JSON.stringify({ now, labels, length: Math.hypot(...vector), id: Symbol.for('skill').description, n: BigInt(2), positions });
  `), null);
  assert.equal(compileCheck('return [typeof setTimeout, typeof (adapter), typeof globalThis["process"]];'), null);
  assert.match(compileCheck('return typeof missing.value;')!, /missing/);
  ['adapter.state()', 'global.fetch("https://example.com")', 'fetch("https://example.com")', 'Buffer.from("x")'].forEach((code) => {
    assert.match(compileCheck(code)!, /引用错误/, code);
  });
  assert.match(compileCheck('require("node:fs")')!, /不能 require/);
  assert.match(compileCheck('process.exit()')!, /不能 require/);
  assert.match(compileCheck('eval("1")')!, /不能 require/);
  assert.match(compileCheck('new Function("return 1")')!, /不能 require/);
  assert.match(compileCheck('await import("node:fs")')!, /不能 require/);
  assert.equal(compileCheck('const process = { result: 1 }; const Function = () => 2; return process.result + Function();'), null);
});

test('运行前的静态错误不会先执行技能里的游戏动作', async () => {
  let calls = 0;
  const result = await runSandboxed('await api.digAt(0, 63, 0);\nlet stalled = 0;\nstall++;', {}, async () => { calls++; return { ok: true }; }, {
    signal: new AbortController().signal, deadline: Date.now() + 5000,
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /第 3 行.*stall/);
  assert.equal(calls, 0);
  assert.equal(result.calls, 0);
});

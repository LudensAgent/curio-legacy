import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyAdapterEnd,
  classifyCancellationResult,
  classifyKnownRouteResult,
  classifyWalkToResult,
  parseCliArgs,
  validateFragmentsQuery,
  validateFragmentQuery,
  validateTraversalsQuery,
} from '../scripts/navigation-acceptance.ts';

const script = fileURLToPath(new URL('../scripts/navigation-acceptance.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const tolerance = { horizontalTolerance: 0.12, feetTolerance: 0.05 };

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ['--import', tsx, script, ...args], { cwd: path.dirname(script), env, encoding: 'utf8', timeout: 30_000 });
}

test('--help exits 0 without loading config', () => {
  const env = { ...process.env, CURIO_ROOT: path.join(os.tmpdir(), 'navigation-acceptance-no-such-root') };
  const result = runCli(['--help'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /navigation-acceptance/);
  assert.match(result.stdout, /--curio=test/);
  assert.equal(result.stderr, '');
});

test('CLI rejects missing, non-test, unknown and out-of-lane arguments before runtime imports', () => {
  const root = path.join(os.tmpdir(), 'navigation-acceptance-no-such-root');
  const env = { ...process.env, CURIO_ROOT: root };
  const cases = [
    [[], /--curio=test/],
    [['--curio=live', '--start=200.5,64,216.5'], /only --curio=test/],
    [['--curio=test', '--start=200.5,64,216.5', '--unknown=1'], /unknown argument/],
    [['--curio=test', '--start=199.5,64,216.5'], /outside the reserved dry lane/],
    [['--curio=test', '--start=200.5,63,216.5'], /feet y must be 64/],
    [['--curio=test', '--start=200.5,64,218'], /outside the reserved dry lane/],
    [['--curio=test', '--start=200.5,64'], /x,y,z/],
  ] as const;
  for (const [args, pattern] of cases) {
    const result = runCli([...args], env);
    assert.notEqual(result.status, 0, `expected rejection for ${args.join(' ')}`);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr, /找不到配置文件|ENOENT/);
  }
});

test('parseCliArgs accepts only the explicit test lane start', () => {
  const parsed = parseCliArgs(['--curio=test', '--start=200.5,64,216.5']);
  assert.equal(parsed.ok, true);
  if (parsed.ok && !parsed.help) {
    assert.deepEqual(parsed.start, { x: 200.5, y: 64, z: 216.5 });
    assert.equal(parsed.startRaw, '200.5,64,216.5');
  }
  assert.equal(parseCliArgs(['--curio=test', '--start=200,64,216']).ok, true);
  assert.equal(parseCliArgs(['--curio=test', '--start=219,64,216.5']).ok, false);
});

test('missing ARRIVED or tolerance evidence cannot PASS walk_to', () => {
  const start = { x: 200.5, y: 64, z: 216.5 };
  const target = { x: 202.5, y: 64, z: 216.5 };
  const notArrived = { status: 'succeeded', summary: 'ok', data: { nav: { outcome: 'PARTIAL', confirmed: false, lastPosition: { ...target }, lastObservation: {} } } };
  assert.equal(classifyWalkToResult(notArrived, start, target, tolerance).ok, false);
  const unconfirmed = { status: 'succeeded', summary: 'ok', data: { nav: { outcome: 'ARRIVED', confirmed: false, lastPosition: { ...target }, lastObservation: {} } } };
  assert.equal(classifyWalkToResult(unconfirmed, start, target, tolerance).ok, false);
  const outsideTolerance = { status: 'succeeded', summary: 'ok', data: { nav: { outcome: 'ARRIVED', confirmed: true, lastPosition: { x: target.x + 0.5, y: target.y, z: target.z }, lastObservation: {} } } };
  assert.equal(classifyWalkToResult(outsideTolerance, start, target, tolerance).ok, false);
  const noMovement = { status: 'succeeded', summary: 'ok', data: { nav: { outcome: 'ARRIVED', confirmed: true, lastPosition: { ...start }, lastObservation: {} } } };
  assert.equal(classifyWalkToResult(noMovement, start, target, tolerance).ok, false);
});

test('missing known-route geometry or terminal ARRIVED cannot PASS', () => {
  const start = { x: 200.5, y: 64, z: 216.5 };
  const points = [{ ...start }, { x: 201.5, y: 64, z: 216.5 }, { x: 202.5, y: 64, z: 216.5 }];
  const missingStart = { status: 'succeeded', summary: 'ok', data: { nav: { outcome: 'ARRIVED', confirmed: true, lastPosition: { ...points[2] }, lastObservation: {} } } };
  assert.equal(classifyKnownRouteResult(missingStart, points, start, tolerance).ok, false);
  const changedGeometry = {
    status: 'succeeded', summary: 'ok',
    data: {
      knownStart: { kind: 'STARTED', route: { points: [...points, { x: 203.5, y: 64, z: 216.5 }], target: { x: 203.5, y: 64, z: 216.5 } } },
      nav: { outcome: 'ARRIVED', confirmed: true, lastPosition: { ...points[2] }, lastObservation: {} },
    },
  };
  assert.equal(classifyKnownRouteResult(changedGeometry, points, start, tolerance).ok, false);
  const startedNotArrived = {
    status: 'succeeded', summary: 'ok',
    data: { knownStart: { kind: 'STARTED', route: { points: [...points], target: { ...points[2] } } }, nav: { outcome: 'PARTIAL', confirmed: false } },
  };
  assert.equal(classifyKnownRouteResult(startedNotArrived, points, start, tolerance).ok, false);
});

test('cancellation needs cancelled/unconfirmed plus original partial sample and released controls', () => {
  const sample = { at: 1_000, position: { x: 200.8, y: 64, z: 216.5 }, worldId: 'world', dim: 'overworld', sessionId: 'session' };
  const nav = {
    outcome: 'CANCELLED', confirmed: false,
    lastPosition: { ...sample.position },
    lastObservation: { worldId: 'world', dim: 'overworld', sessionId: 'session', observedAt: sample.at, onGround: true, inWater: false },
  };
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  assert.equal(classifyCancellationResult({ status: 'cancelled', summary: 'cancelled', data: { nav } }, [sample], controls, false).ok, true);
  assert.equal(classifyCancellationResult({ status: 'cancelled', summary: 'cancelled', data: { nav } }, [], controls, false).ok, false);
  const noPartial = { outcome: 'CANCELLED', confirmed: false };
  assert.equal(classifyCancellationResult({ status: 'cancelled', summary: 'cancelled', data: { nav: noPartial } }, [sample], controls, false).ok, false);
  assert.equal(classifyCancellationResult({ status: 'failed', summary: 'failed', data: { nav } }, [sample], controls, false).ok, false);
  assert.equal(classifyCancellationResult({ status: 'cancelled', summary: 'cancelled', data: { nav } }, [sample], { ...controls, jump: true }, false).ok, false);
  assert.equal(classifyCancellationResult({ status: 'cancelled', summary: 'cancelled', data: { nav } }, [sample], controls, true).ok, false);
  const missingKey = { ...controls } as Record<string, unknown>;
  delete missingKey.sneak;
  assert.equal(classifyCancellationResult({ status: 'cancelled', summary: 'cancelled', data: { nav } }, [sample], missingKey, false).ok, false);
});

test('spatial query contracts reject missing fields and keep raw records', () => {
  assert.equal(validateFragmentsQuery({}).ok, false);
  assert.equal(validateFragmentsQuery({ fragments: [], page: { after: null, limit: 8, total: 0, returned: 0, scan: 'wrong', scanNote: 'x' } }).ok, false);
  assert.equal(validateFragmentQuery({}, 'f1').ok, false);
  assert.equal(validateFragmentQuery({ found: false, reason: 'missing' }, 'f1').ok, false);
  assert.equal(validateFragmentQuery({ found: true, fragment: { id: 'f1', polyline: { recorded: true, total: 3, offset: 0, returned: 2, items: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 1 }] } } }, 'f1').ok, false);
  assert.equal(validateTraversalsQuery({}, 'f1', { worldId: 'w', dim: 'overworld', sessionId: 's' }).ok, false);
  const record = { id: 't1', fragmentId: 'f1', from: { x: 1, y: 64, z: 1 }, to: { x: 2, y: 64, z: 1 }, worldId: 'w', dim: 'overworld', sessionId: 's', observedAt: 10, source: 'confirmed_walk' };
  assert.equal(validateTraversalsQuery({ items: [{ status: 'found', record }], page: { total: 1, returned: 1, limit: 8 } }, 'f1', { worldId: 'w', dim: 'overworld', sessionId: 's' }).ok, false);
  assert.equal(validateTraversalsQuery({ items: [{ status: 'found', record: { ...record, actionId: 't_1' } }], page: { total: 1, returned: 1, limit: 8 } }, 'f1', { worldId: 'w', dim: 'overworld', sessionId: 's' }).ok, true);
});

test('adapter end classification requires both real observations', () => {
  assert.equal(classifyAdapterEnd(true, true, false).ok, true);
  assert.equal(classifyAdapterEnd(false, true, false).ok, false);
  assert.equal(classifyAdapterEnd(true, false, false).ok, false);
  assert.equal(classifyAdapterEnd(true, true, true).ok, false);
});

test('script help does not create run evidence or require a config file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-acceptance-'));
  const result = runCli(['--help'], { ...process.env, CURIO_ROOT: directory });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(directory), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

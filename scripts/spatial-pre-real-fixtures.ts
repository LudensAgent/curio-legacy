/**
 * WP8 预实机夹具入口：在跑真实服务器前执行 W4/W5/W7 与活动委托断线的离线验收，
 * 并把可读证据写入独立临时目录。
 *
 * 本脚本故意不启动 Minecraft 服务器或 Bot，也不替换真实 soak 脚本。`--dry-run`
 * 驱动 tests/fixtures/spatial-w4-w5-w7.ts 中的真实 SharedSpatialSession /
 * RouteVerifier / WalkRouteExecutor（身体 MoveExecutor 为夹具）。真实 W4/W5/W7
 * 仍标记为 NOT_RUN；`--real` 只记录该事实并以非零退出，避免把“未运行”当成通过。
 *
 * 退出码：0 = 离线夹具全部通过；1 = 至少一个夹具失败或证据写入失败；
 * 2 = 参数错误或请求了尚未实现的真实运行。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runDisconnectDelegationScenario,
  runW4Scenario,
  runW5Scenario,
  runW7NoFrameCancelScenario,
  runW7TimeoutScenario,
} from '../tests/fixtures/spatial-w4-w5-w7.ts';

const HELP = `spatial-pre-real-fixtures — W4/W5/W7 + activity delegation disconnect offline fixtures

Usage:
  tsx scripts/spatial-pre-real-fixtures.ts [--dry-run] [--evidence-dir <dir>]
  tsx scripts/spatial-pre-real-fixtures.ts --real

  --dry-run         Run the offline fixtures (default). No server/Bot is started.
  --evidence-dir    Write events.jsonl/summary.json into <dir>; default is a fresh
                    mkdtemp directory under the OS temp root.
  --real            Explicitly request the real W4/W5/W7 run. Not implemented in
                    WP8: records NOT_RUN and exits 2.
  --help            Print this help.
`;

const REAL_TEST_STATUS = {
  W4: 'NOT_RUN',
  W5: 'NOT_RUN',
  W7: 'NOT_RUN',
  activityDelegationDisconnect: 'NOT_RUN',
} as const;

const REAL_TEST_REASON =
  'Real W4/W5/W7 and disconnect runs require a live Minecraft server and Bot. WP8 performs offline fixtures only; the real runs remain NOT_RUN until after the readiness gate.';

const SCENARIOS = [
  { id: 'W4-support-removal', run: () => runW4Scenario('support_removal') },
  { id: 'W4-obstacle-placed', run: () => runW4Scenario('obstacle_placed') },
  { id: 'W5-occluded-change', run: () => runW5Scenario() },
  { id: 'W7-timeout-stop-frames', run: () => runW7TimeoutScenario() },
  { id: 'W7-no-frame-cancel', run: () => runW7NoFrameCancelScenario() },
  { id: 'activity-delegation-disconnect', run: () => runDisconnectDelegationScenario() },
] as const;

interface ScenarioRecord {
  id: string;
  realRun: 'NOT_RUN';
  status: 'PASS' | 'FAIL';
  durationMs: number;
  facts?: unknown;
  error?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeEvidence(
  evidenceDir: string,
  runId: string,
  mode: 'offline_fixture' | 'real_requested',
  scenarios: readonly ScenarioRecord[],
  extra: Record<string, unknown>,
): void {
  const finishedAt = new Date().toISOString();
  const events = scenarios.map((scenario) => JSON.stringify({
    runId,
    at: finishedAt,
    mode,
    scenario: scenario.id,
    status: scenario.status,
    realRun: scenario.realRun,
    durationMs: scenario.durationMs,
    ...(scenario.facts === undefined ? {} : { facts: scenario.facts }),
    ...(scenario.error === undefined ? {} : { error: scenario.error }),
  }));
  writeFileSync(join(evidenceDir, 'events.jsonl'), `${events.join('\n')}\n`, 'utf8');
  writeFileSync(join(evidenceDir, 'summary.json'), `${JSON.stringify({
    runId,
    mode,
    finishedAt,
    evidenceDir,
    realTestStatus: REAL_TEST_STATUS,
    realTestReason: REAL_TEST_REASON,
    scenarios,
    ...extra,
  }, null, 2)}\n`, 'utf8');
}

async function runOfflineFixtures(evidenceDir: string): Promise<number> {
  const runId = `wp8-${Date.now()}`;
  const scenarios: ScenarioRecord[] = [];
  for (const scenario of SCENARIOS) {
    const startedAt = Date.now();
    try {
      const facts = await scenario.run();
      scenarios.push({
        id: scenario.id,
        realRun: 'NOT_RUN',
        status: 'PASS',
        durationMs: Date.now() - startedAt,
        facts,
      });
    } catch (error) {
      scenarios.push({
        id: scenario.id,
        realRun: 'NOT_RUN',
        status: 'FAIL',
        durationMs: Date.now() - startedAt,
        error: errorText(error),
      });
    }
  }
  const failed = scenarios.filter((scenario) => scenario.status === 'FAIL');
  const offlineFixtures = failed.length === 0 ? 'PASS' : 'FAIL';
  writeEvidence(evidenceDir, runId, 'offline_fixture', scenarios, { offlineFixtures });
  for (const scenario of scenarios) {
    process.stdout.write(`${scenario.status} ${scenario.id}${scenario.error === undefined ? '' : `: ${scenario.error}`}\n`);
  }
  process.stdout.write(`evidence: ${evidenceDir}\n`);
  if (failed.length > 0) {
    process.stderr.write(`offline dry-run FAIL (${failed.length} scenario(s))\n`);
    return 1;
  }
  process.stdout.write(
    `offline dry-run PASS; real W4/W5/W7/disconnect: ${Object.values(REAL_TEST_STATUS).join('/')} (${REAL_TEST_REASON})\n`,
  );
  return 0;
}

function recordRealNotRun(evidenceDir: string): number {
  const runId = `wp8-real-${Date.now()}`;
  writeEvidence(evidenceDir, runId, 'real_requested', [], {
    offlineFixtures: 'NOT_RUN',
    reason: REAL_TEST_REASON,
  });
  process.stderr.write(`real W4/W5/W7/disconnect: NOT_RUN — ${REAL_TEST_REASON}\n`);
  process.stderr.write(`evidence: ${evidenceDir}\n`);
  return 2;
}

async function main(argv: readonly string[]): Promise<number> {
  let evidenceDir: string | null = null;
  let real = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help') {
      process.stdout.write(HELP);
      return 0;
    }
    if (arg === '--dry-run') continue;
    if (arg === '--real') {
      real = true;
      continue;
    }
    if (arg === '--evidence-dir') {
      const value = argv[index + 1];
      if (value === undefined) {
        process.stderr.write('--evidence-dir requires a path\n');
        return 2;
      }
      evidenceDir = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    process.stderr.write(`unknown argument: ${arg}\n\n${HELP}`);
    return 2;
  }

  const dir = evidenceDir ?? mkdtempSync(join(tmpdir(), 'spatial-pre-real-fixtures-'));
  mkdirSync(dir, { recursive: true });
  return real ? recordRealNotRun(dir) : runOfflineFixtures(dir);
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    process.stderr.write(`offline dry-run FAIL: ${errorText(error)}\n`);
    process.exitCode = 1;
  });
}

/**
 * Read-only legacy spatial-memory preflight.
 *
 * Reads only the JSON paths named on the command line, hashes the exact bytes
 * that were parsed and prints a bounded analysis report. It never loads runtime
 * configuration, instantiates a memory/travel service, writes files or touches
 * a database.
 *
 * Usage:
 *   node --import tsx scripts/spatial-migration-preflight.ts \
 *     --world-memory <path> [--placed <path>] [--travel <path>] [--max-bytes <bytes>]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectLegacySpatialMemory } from '../src/spatial/legacy-preflight.ts';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const SOURCE_FLAGS = ['--world-memory', '--placed', '--travel'] as const;
const KNOWN_FLAGS = new Set<string>([...SOURCE_FLAGS, '--max-bytes']);

class CliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type SourceFlag = (typeof SOURCE_FLAGS)[number];

function parseArguments(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!KNOWN_FLAGS.has(flag)) throw new CliError('ARGUMENTS', `unknown argument: ${flag}`);
    if (values.has(flag)) throw new CliError('ARGUMENTS', `duplicate argument: ${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new CliError('ARGUMENTS', `missing value for ${flag}`);
    values.set(flag, value);
  }

  const sourcePaths = SOURCE_FLAGS.flatMap((flag) => {
    const value = values.get(flag);
    return value === undefined ? [] : [{ flag, value }];
  });
  if (sourcePaths.length === 0) {
    throw new CliError('ARGUMENTS', 'at least one explicitly named source is required: --world-memory, --placed or --travel');
  }

  const maxBytesRaw = values.get('--max-bytes');
  const maxBytes = maxBytesRaw === undefined ? DEFAULT_MAX_BYTES : Number(maxBytesRaw);
  if (maxBytesRaw !== undefined && (!/^\d+$/.test(maxBytesRaw) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new CliError('ARGUMENTS', '--max-bytes must be a positive safe integer');
  }

  const byFlag = new Map(sourcePaths.map(({ flag, value }) => [flag, value]));
  return {
    worldMemory: byFlag.get('--world-memory'),
    placed: byFlag.get('--placed'),
    travel: byFlag.get('--travel'),
    maxBytes,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readSource(inputPath: string, maxBytes: number) {
  const absolutePath = path.resolve(inputPath);
  const stat = (() => {
    try {
      return fs.statSync(absolutePath);
    } catch (error) {
      throw new CliError('IO_ERROR', `cannot read ${absolutePath}: ${errorMessage(error)}`);
    }
  })();
  if (!stat.isFile()) throw new CliError('IO_ERROR', `${absolutePath} is not a regular file`);
  if (stat.size > maxBytes) throw new CliError('BYTE_LIMIT', `${absolutePath} is ${stat.size} bytes, over the ${maxBytes}-byte limit`);

  const bytes = (() => {
    try {
      return fs.readFileSync(absolutePath);
    } catch (error) {
      throw new CliError('IO_ERROR', `cannot read ${absolutePath}: ${errorMessage(error)}`);
    }
  })();
  if (bytes.byteLength > maxBytes) throw new CliError('BYTE_LIMIT', `${absolutePath} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit`);

  const value = (() => {
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      // Parser messages can quote file content; report the path and category only.
      throw new CliError('INVALID_JSON', `invalid JSON in ${absolutePath}`);
    }
  })();

  return {
    value,
    identity: {
      path: absolutePath,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const input: { worldMemory?: unknown; placed?: unknown; travel?: unknown } = {};
  const files: Record<string, { path: string; bytes: number; sha256: string }> = {};

  const named: { target: 'worldMemory' | 'placed' | 'travel'; value: string | undefined }[] = [
    { target: 'worldMemory', value: args.worldMemory },
    { target: 'placed', value: args.placed },
    { target: 'travel', value: args.travel },
  ];
  for (const { target, value } of named) {
    if (value === undefined) continue;
    const source = readSource(value, args.maxBytes);
    input[target] = source.value;
    files[target] = source.identity;
  }

  const report = inspectLegacySpatialMemory(input);
  process.stdout.write(`${JSON.stringify({ ...report, files }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: {
      code: error instanceof CliError ? error.code : 'UNEXPECTED',
      message: errorMessage(error),
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
}

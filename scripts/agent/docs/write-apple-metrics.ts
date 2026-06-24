#!/usr/bin/env node
/**
 * docs/write-apple-metrics.ts — canonical writer for per-session apple metrics.
 *
 * Usage:
 *   npx tsx scripts/agent/docs/write-apple-metrics.ts \
 *     --date 2026-06-24 \
 *     --session floor1-balance-pass \
 *     --estimated 3 \
 *     --actual 2
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { fromRepo } from '../shared/report.js';

const APPLES_DIR = 'docs/knowledge/metrics/apples';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Verdict = 'exact' | 'under' | 'over' | 'miss';

export interface AppleEntry {
  readonly date: string;
  readonly session: string;
  readonly estimated_apples: number;
  readonly actual_apples: number;
  readonly delta: number;
  readonly verdict: Verdict;
  readonly hello_kitties: number;
}

interface ParsedArgs {
  readonly date: string;
  readonly session: string;
  readonly estimated: number;
  readonly actual: number;
  readonly overwrite: boolean;
}

function parseIntFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected integer for ${flag}, got "${value}".`);
  }
  return parsed;
}

export function verdictFromDelta(delta: number): Verdict {
  if (delta === 0) return 'exact';
  if (Math.abs(delta) >= 2) return 'miss';
  return delta > 0 ? 'under' : 'over';
}

export function helloKittiesFromActual(actualApples: number): number {
  return Math.round((actualApples / 5) * 100) / 100;
}

export function buildAppleEntry(input: {
  date: string;
  session: string;
  estimated: number;
  actual: number;
}): AppleEntry {
  const delta = input.actual - input.estimated;
  return {
    date: input.date,
    session: input.session,
    estimated_apples: input.estimated,
    actual_apples: input.actual,
    delta,
    verdict: verdictFromDelta(delta),
    hello_kitties: helloKittiesFromActual(input.actual),
  };
}

export function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const args = new Map<string, string>();
  let overwrite = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--overwrite') {
      overwrite = true;
      continue;
    }
    if (!token?.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}.`);
    }
    args.set(token.slice(2), value);
    i += 1;
  }

  const date = args.get('date');
  const session = args.get('session');
  const estimatedRaw = args.get('estimated');
  const actualRaw = args.get('actual');

  if (!date || !DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('Flag --date is required and must be YYYY-MM-DD.');
  }
  if (!session || !SESSION_RE.test(session)) {
    throw new Error(
      'Flag --session is required and must be kebab-case (lowercase letters/numbers).',
    );
  }
  if (!estimatedRaw) {
    throw new Error('Flag --estimated is required.');
  }
  if (!actualRaw) {
    throw new Error('Flag --actual is required.');
  }

  const estimated = parseIntFlag(estimatedRaw, '--estimated');
  const actual = parseIntFlag(actualRaw, '--actual');

  if (estimated < 1 || estimated > 5) {
    throw new Error('--estimated must be between 1 and 5.');
  }
  if (actual < 0 || actual > 10) {
    throw new Error('--actual must be between 0 and 10.');
  }

  return { date, session, estimated, actual, overwrite };
}

export function outputPathFor(args: { date: string; session: string }): string {
  return fromRepo(APPLES_DIR, `${args.date}-${args.session}.json`);
}

function usage(): string {
  return [
    'Usage:',
    '  npm run docs:apple:write -- --date YYYY-MM-DD --session my-session --estimated 3 --actual 2 [--overwrite]',
  ].join('\n');
}

export function run(argv: ReadonlyArray<string>): string {
  const parsed = parseCliArgs(argv);
  const outPath = outputPathFor(parsed);
  if (existsSync(outPath) && !parsed.overwrite) {
    throw new Error(`Refusing to overwrite existing file: ${outPath}. Re-run with --overwrite.`);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const entry = buildAppleEntry(parsed);
  writeFileSync(outPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  return outPath;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const path = run(argv);
    process.stdout.write(`Wrote apple metrics entry: ${path}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${usage()}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main();
}

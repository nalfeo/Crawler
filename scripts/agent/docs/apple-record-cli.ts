#!/usr/bin/env tsx
/**
 * apple-record-cli.ts — Write a per-session apple entry file.
 *
 * Usage:
 *   npm run apples:record -- --session <slug> --estimated <1-5> --actual <1-5>
 *
 * The script derives delta, verdict, and hello_kitties automatically, uses
 * today's date, and writes to docs/knowledge/metrics/apples/<date>-<slug>.json.
 *
 * Only required for ≥3🍎 sessions (see docs/agent-os/policies/complexity-policy.md).
 * 1–2🍎 sessions do not need a file.
 */

import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verdictFromDelta } from './apple-calibration-lib.js';

const APPLES_DIR = 'docs/knowledge/metrics/apples';

export interface AppleRecordEntry {
  date: string;
  session: string;
  estimated_apples: number;
  actual_apples: number;
  delta: number;
  verdict: ReturnType<typeof verdictFromDelta>;
  hello_kitties: number;
}

export function usage(): void {
  process.stderr.write(
    'Usage: npm run apples:record -- --session <slug> --estimated <1-5> --actual <1-5>\n',
  );
}

function parseStrictAppleCount(flag: '--estimated' | '--actual', raw: string): number {
  if (!/^[1-5]$/.test(raw)) {
    throw new Error(`${flag} must be an integer 1-5, got: ${raw}`);
  }
  return Number(raw);
}

export function parseArgs(argv: string[]): { session: string; estimated: number; actual: number } {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const session = get('--session');
  const estimatedRaw = get('--estimated');
  const actualRaw = get('--actual');

  if (!session || !estimatedRaw || !actualRaw) {
    throw new Error('Missing required flags: --session, --estimated, --actual');
  }

  const estimated = parseStrictAppleCount('--estimated', estimatedRaw);
  const actual = parseStrictAppleCount('--actual', actualRaw);

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(session)) {
    throw new Error(`--session must be a kebab-case slug, got: ${session}`);
  }

  return { session, estimated, actual };
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function writeAppleRecordFile(outPath: string, entry: Record<string, unknown>): void {
  try {
    writeFileSync(outPath, JSON.stringify(entry, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === 'EEXIST') {
      throw new Error(`File already exists: ${outPath}\nTo update it, delete it first.`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function buildAppleRecord(
  params: { date: string; session: string; estimated: number; actual: number },
  outputDir = APPLES_DIR,
): { outPath: string; entry: AppleRecordEntry } {
  const { date, session, estimated, actual } = params;
  const delta = actual - estimated;
  const verdict = verdictFromDelta(delta);
  const hello_kitties = round2(actual / 5);

  const entry: AppleRecordEntry = {
    date,
    session,
    estimated_apples: estimated,
    actual_apples: actual,
    delta,
    verdict,
    hello_kitties,
  };

  const filename = `${date}-${session}.json`;
  const outPath = join(outputDir, filename);
  return { outPath, entry };
}

export function main(): void {
  try {
    const { session, estimated, actual } = parseArgs(process.argv);

    const date = todayISO();
    const { outPath, entry } = buildAppleRecord({ date, session, estimated, actual });
    const delta = entry.delta;
    const verdict = entry.verdict;

    writeAppleRecordFile(outPath, entry);
    process.stdout.write(`✅ Wrote ${outPath}\n`);
    process.stdout.write(
      `   ${estimated}🍎 estimated → ${actual}🍎 actual (delta ${delta >= 0 ? '+' : ''}${delta}, ${verdict})\n`,
    );
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.startsWith('Missing required flags')) {
        usage();
      }
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main();
}

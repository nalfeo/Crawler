#!/usr/bin/env node
/**
 * health/extended-property.ts — Re-run the property-based test suite with
 * `FAST_CHECK_NUM_RUNS` (or equivalent env we set: `EXTENDED_FAST_CHECK_RUNS`)
 * cranked up by 10x to catch invariants that only break under deeper search.
 *
 * Skips with exit 0 when `tests/property/` doesn't exist or contains no test
 * files yet.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const PROPERTY_DIR = 'tests/property';
const RUNS_MULTIPLIER = 10;
const DEFAULT_RUNS = 100;

function hasAnyTests(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const e of entries) {
    const abs = path.join(dir, e);
    if (statSync(abs).isDirectory()) {
      if (hasAnyTests(abs)) return true;
    } else if (e.endsWith('.test.ts') || e.endsWith('.spec.ts')) {
      return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const report = new Report('health-extended-property');
  const absDir = fromRepo(PROPERTY_DIR);
  if (!hasAnyTests(absDir)) {
    report.skip(`No property tests under ${PROPERTY_DIR}.`);
    report.finish();
  }
  const runs = String(DEFAULT_RUNS * RUNS_MULTIPLIER);
  process.stdout.write(`Running property tests with EXTENDED_FAST_CHECK_RUNS=${runs}\n`);
  const result = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--dir', PROPERTY_DIR, '--reporter=verbose'],
    {
      cwd: fromRepo(),
      env: {
        ...process.env,
        EXTENDED_FAST_CHECK_RUNS: runs,
        FAST_CHECK_NUM_RUNS: runs,
      },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    report.error(`Extended property suite failed (vitest exit ${result.status}).`, {
      remediation:
        'Investigate the new counterexample(s); they reveal an invariant violation the default-depth run missed.',
    });
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`extended-property crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});

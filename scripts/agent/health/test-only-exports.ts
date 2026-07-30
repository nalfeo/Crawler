#!/usr/bin/env tsx
/**
 * test-only-exports.ts — Blocking guard: reports `src/` exports whose only
 * consumers live under `tests/**`.
 *
 * exit 0 → no test-only exports found (or only warnings).
 * exit 1 → at least one test-only export detected.
 * exit 2 → the guard itself crashed.
 *
 * Pure logic lives in `test-only-exports-lib.ts` for unit testing.
 *
 * ## Remediation
 *
 * For each flagged export:
 * - If the export IS needed by production code: add the missing caller and
 *   remove it from the dead-code blind spot.
 * - If the export is genuinely unused in production: either delete it (and its
 *   tests if they only validate dead behaviour) or leave the tests and accept
 *   the export as test scaffolding — but in that case prefix the export with an
 *   underscore or move it to a `test-helpers/` file so the intent is explicit.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import {
  collectNamedExports,
  findDuplicateExportNames,
  findTestOnlyExports,
  type SourceFile,
} from './test-only-exports-lib.js';

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/** Recursively collect `.ts` files under a directory (skipping `.d.ts` files). */
function walkTsFiles(absDir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...walkTsFiles(abs));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function readSourceFile(absPath: string): SourceFile {
  const rel = path.relative(fromRepo(), absPath).replace(/\\/g, '/');
  return { path: rel, content: readFileSync(absPath, 'utf8') };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const report = new Report('health-test-only-exports');

  const srcRoot = fromRepo('src');
  const testsRoot = fromRepo('tests');

  const srcFiles = walkTsFiles(srcRoot).map(readSourceFile);
  const testFiles = walkTsFiles(testsRoot).map(readSourceFile);

  if (srcFiles.length === 0) {
    report.error('No src/**/*.ts files found — the guard is not scanning anything.', {
      remediation: 'Check that the src/ directory exists and contains TypeScript files.',
    });
    report.finish();
  }

  // Warn about duplicate export names; they can cause false negatives.
  const allExports = collectNamedExports(srcFiles);
  for (const dup of findDuplicateExportNames(allExports)) {
    report.warn(
      `Duplicate export name "${dup.name}" found in multiple src/ files: ${dup.files.join(', ')}.`,
      {
        remediation:
          `Name-based import scanning cannot distinguish which file a given import targets. ` +
          `Consider renaming one of the exports to avoid ambiguity.`,
      },
    );
  }

  const testOnlyExports = findTestOnlyExports(srcFiles, testFiles);

  for (const exp of testOnlyExports) {
    const consumers = exp.testConsumers.join(', ');
    report.error(
      `"${exp.name}" is exported from ${exp.file} but has no production callers — only test consumers: ${consumers}.`,
      {
        file: exp.file,
        remediation:
          `Either (a) add a production caller, (b) delete the export and its test-only tests, ` +
          `or (c) if the export is intentional test scaffolding, move it to a test-helpers file ` +
          `or prefix it with an underscore to signal its purpose.`,
      },
    );
  }

  if (testOnlyExports.length === 0) {
    report.info(
      `${allExports.length} src/ export(s) checked; none are consumed exclusively by tests.`,
    );
  }

  report.finish();
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `test-only-exports crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(2);
}

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
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import {
  collectNamedExports,
  collectNamedImports,
  findDuplicateExportNames,
  isTestScaffoldAllowlisted,
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

function isProductionSrcPath(relPath: string): boolean {
  return (
    relPath.startsWith('src/') &&
    !relPath.startsWith('src/labs/') &&
    relPath.endsWith('.ts') &&
    !relPath.endsWith('.d.ts')
  );
}

function readSourceFile(absPath: string): SourceFile {
  const rel = path.relative(fromRepo(), absPath).replace(/\\/g, '/');
  return { path: rel, content: readFileSync(absPath, 'utf8') };
}

function resolveBaseRef(): string | null {
  if (process.env.GITHUB_BASE_SHA) return process.env.GITHUB_BASE_SHA;

  for (const candidate of ['origin/main', 'main']) {
    const result = spawnSync('git', ['merge-base', 'HEAD', candidate], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  }

  return null;
}

function listChangedSrcPaths(baseRef: string | null): string[] {
  const changed = new Set<string>();
  const diffSpecs = baseRef
    ? [`${baseRef}...HEAD`, undefined, '--cached']
    : [undefined, '--cached'];

  for (const diffSpec of diffSpecs) {
    const args = ['diff', '--name-only', '--diff-filter=ACMR'];
    if (diffSpec) {
      args.push(diffSpec);
    }
    args.push('--', 'src');

    const result = spawnSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) continue;

    for (const line of result.stdout.split(/\r?\n/)) {
      const rel = line.trim().replace(/\\/g, '/');
      if (!isProductionSrcPath(rel)) continue;
      changed.add(rel);
    }
  }

  return [...changed];
}

/**
 * Read the content of a file at a specific git ref. Returns null if the file
 * did not exist at that ref (e.g. it is newly added in this branch).
 */
function readFileAtRef(relPath: string, ref: string): string | null {
  const result = spawnSync('git', ['show', `${ref}:${relPath}`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/**
 * For each changed src file, collect the import names it had at `baseRef`.
 * These are candidates for "last caller removed": if the name is no longer
 * imported anywhere in production at HEAD, the export may now be test-only
 * even though the exporting file itself is unchanged.
 *
 * Note: the returned set is deliberately over-inclusive — names still
 * imported by any src file at HEAD are filtered out downstream by the
 * per-export `srcConsumers` check in the caller.
 */
function collectDeletedImportNames(
  changedSrcPaths: Set<string>,
  baseRef: string | null,
): Set<string> {
  if (!baseRef || changedSrcPaths.size === 0) return new Set();

  const candidates = new Set<string>();
  for (const relPath of changedSrcPaths) {
    const baseContent = readFileAtRef(relPath, baseRef);
    if (baseContent === null) continue; // newly added file — no prior imports

    const baseFile = { path: relPath, content: baseContent };
    const baseImports = collectNamedImports([baseFile]);
    for (const name of baseImports.keys()) {
      candidates.add(name);
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const report = new Report('health-test-only-exports');

  const srcRoot = fromRepo('src');
  const testsRoot = fromRepo('tests');

  const srcFiles = walkTsFiles(srcRoot)
    .map(readSourceFile)
    .filter((file) => isProductionSrcPath(file.path));
  const testFiles = walkTsFiles(testsRoot).map(readSourceFile);
  const baseRef = resolveBaseRef();
  const changedSrcPaths = new Set(listChangedSrcPaths(baseRef));

  if (srcFiles.length === 0) {
    report.error('No src/**/*.ts files found — the guard is not scanning anything.', {
      remediation: 'Check that the src/ directory exists and contains TypeScript files.',
    });
    report.finish();
  }

  if (changedSrcPaths.size === 0) {
    report.info('No changed src/**/*.ts files detected in this branch or working tree; skipping.');
    report.finish();
  }

  const changedSrcFiles = srcFiles.filter((file) => changedSrcPaths.has(file.path));
  const allExports = collectNamedExports(srcFiles);
  const changedExports = collectNamedExports(changedSrcFiles);
  const srcImports = collectNamedImports(srcFiles);
  const testImports = collectNamedImports(testFiles);

  // Warn about duplicate export names in changed files; they can cause false negatives.
  const changedExportNames = new Set(changedExports.map((exp) => exp.name));
  for (const dup of findDuplicateExportNames(allExports).filter((dup) =>
    changedExportNames.has(dup.name),
  )) {
    report.warn(
      `Duplicate export name "${dup.name}" found in multiple src/ files: ${dup.files.join(', ')}.`,
      {
        remediation:
          `Name-based import scanning cannot distinguish which file a given import targets. ` +
          `Consider renaming one of the exports to avoid ambiguity.`,
      },
    );
  }

  // Also check exports whose *last production caller* may have been removed in
  // a changed file.  Removing an import from a changed file leaves the
  // exporting file unchanged, so it would otherwise be absent from
  // `changedExports` and the guard would silently pass.
  const deletedImportNames = collectDeletedImportNames(changedSrcPaths, baseRef);
  const deletedImportCandidates = allExports.filter(
    (exp) => deletedImportNames.has(exp.name) && !changedExportNames.has(exp.name),
  );
  const candidates = [...changedExports, ...deletedImportCandidates];
  const testOnlyExports = candidates.flatMap((exp) => {
    if (exp.name.startsWith('_')) return []; // explicit test scaffolding by convention
    if (isTestScaffoldAllowlisted(exp)) return []; // documented test scaffold

    const srcConsumers = srcImports.get(exp.name) ?? new Set<string>();
    const outsideSrcConsumers = [...srcConsumers].filter((file) => file !== exp.file);
    if (outsideSrcConsumers.length > 0) return [];

    const testConsumers = [...(testImports.get(exp.name) ?? new Set<string>())];
    if (testConsumers.length === 0) return [];

    return [{ ...exp, testConsumers }];
  });

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
      `${candidates.length} src/ export(s) checked (${changedExports.length} from changed files, ${deletedImportCandidates.length} from deleted importers); none are consumed exclusively by tests.`,
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

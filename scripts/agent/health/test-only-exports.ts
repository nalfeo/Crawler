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
  findDuplicateExportNames,
  findNewlyTestOnlyExports,
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

function listChangedPaths(baseRef: string | null, roots: readonly string[]): string[] {
  const changed = new Set<string>();
  const diffSpecs = baseRef
    ? [`${baseRef}...HEAD`, undefined, '--cached']
    : [undefined, '--cached'];

  for (const diffSpec of diffSpecs) {
    const args = ['diff', '--name-only', '--diff-filter=ACMRD'];
    if (diffSpec) {
      args.push(diffSpec);
    }
    args.push('--', ...roots);

    const result = spawnSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) continue;

    for (const line of result.stdout.split(/\r?\n/)) {
      const rel = line.trim().replace(/\\/g, '/');
      if (rel) changed.add(rel);
    }
  }

  return [...changed];
}

function readSourceFileAtRef(ref: string, relPath: string): SourceFile | null {
  const result = spawnSync('git', ['show', `${ref}:${relPath}`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return { path: relPath, content: result.stdout };
}

function buildBaseSnapshot(
  currentFiles: readonly SourceFile[],
  changedPaths: ReadonlySet<string>,
  baseRef: string,
  roots: readonly string[],
): SourceFile[] {
  const baseFiles = new Map(currentFiles.map((file) => [file.path, file]));

  for (const relPath of changedPaths) {
    const isUnderRoot = roots.some((root) => relPath === root || relPath.startsWith(`${root}/`));
    if (!isUnderRoot) continue;
    const baseFile = readSourceFileAtRef(baseRef, relPath);
    if (baseFile) {
      baseFiles.set(relPath, baseFile);
    } else {
      baseFiles.delete(relPath);
    }
  }

  return [...baseFiles.values()];
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

  const allExports = collectNamedExports(srcFiles);
  const changedExports = allExports.filter((exp) => changedSrcPaths.has(exp.file));
  const testOnlyExports = (() => {
    if (!baseRef) return [];
    const changedPaths = new Set(listChangedPaths(baseRef, ['src', 'tests']));
    const baseSrcFiles = buildBaseSnapshot(srcFiles, changedPaths, baseRef, ['src']);
    const baseTestFiles = buildBaseSnapshot(testFiles, changedPaths, baseRef, ['tests']);
    return findNewlyTestOnlyExports(srcFiles, testFiles, baseSrcFiles, baseTestFiles);
  })();

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
      `${changedExports.length} changed src/ export(s) checked; none newly became test-only.`,
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

#!/usr/bin/env tsx
/**
 * check-allowlist-expiry.ts — Blocking guard that gives EVERY allowlist,
 * suppression, and exception list in the repo the same governance:
 *
 * 1. Each registered list declares a governance policy:
 *    - `time-bounded`      → every entry needs a specific reason and a real,
 *                            unexpired `expiresOn`.
 *    - `tracked-permanent` → every entry needs a specific reason, a tracking
 *                            reference, and a removal condition — and must NOT
 *                            carry `expiresOn`.
 * 2. Fail-closed anti-bypass: any exported const under `scripts/` or
 *    `.github/scripts/` whose name looks like an allowlist and is not registered
 *    here is a finding (precedent: `KNOWN_EXPIRY_ARRAY_NAMES` in npm-audit.mjs).
 *
 * exit 0 → every governed entry is valid and every allowlist is registered.
 * exit 1 → at least one governance finding.
 * exit 2 → the guard itself crashed.
 *
 * Pure logic lives in `allowlist-expiry-lib.ts` for unit testing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import {
  findAllowlistFindings,
  findExportedConstNames,
  findUnregisteredAllowlists,
  isAllowlistExportName,
  type AllowlistFinding,
  type DiscoveredAllowlistExport,
  type GovernedAllowlistSource,
} from './allowlist-expiry-lib.js';
import { KNIP_SUPPRESSIONS } from './knip-suppressions.js';
import { ALLOWLIST as ORPHANED_SYSTEMS_ALLOWLIST } from './orphaned-systems-lib.js';
import { TEST_SCAFFOLD_ALLOWLIST_ENTRIES } from './test-only-exports-lib.js';

// ---------------------------------------------------------------------------
// npm-audit exception lists (plain JS module — loaded via a runtime specifier)
// ---------------------------------------------------------------------------

interface NpmAuditException {
  readonly packageName: string;
  readonly reason?: string;
  readonly expiresOn?: string;
}

interface NpmAuditModule {
  readonly AUDIT_EXCEPTIONS: readonly NpmAuditException[];
  readonly TEMP_DEPENDENCY_EXCEPTIONS: readonly NpmAuditException[];
}

const NPM_AUDIT_FILE = 'scripts/agent/security/npm-audit.mjs';
const KNIP_FILE = 'scripts/agent/health/knip-suppressions.ts';
const ORPHANED_SYSTEMS_FILE = 'scripts/agent/health/orphaned-systems-lib.ts';
const TEST_SCAFFOLD_FILE = 'scripts/agent/health/test-only-exports-lib.ts';

const npmAudit = (await import(
  new URL('../security/npm-audit.mjs', import.meta.url).href
)) as NpmAuditModule;

// ---------------------------------------------------------------------------
// Registered sources — the single place every governed allowlist is declared
// ---------------------------------------------------------------------------

function fromNpmAuditExceptions(
  name: string,
  exceptions: readonly NpmAuditException[],
): GovernedAllowlistSource {
  return {
    name,
    file: NPM_AUDIT_FILE,
    policy: 'time-bounded',
    entries: exceptions.map((exception) => ({
      key: exception.packageName,
      reason: exception.reason,
      expiresOn: exception.expiresOn,
    })),
  };
}

const GOVERNED_SOURCES: readonly GovernedAllowlistSource[] = [
  fromNpmAuditExceptions('AUDIT_EXCEPTIONS', npmAudit.AUDIT_EXCEPTIONS),
  fromNpmAuditExceptions('TEMP_DEPENDENCY_EXCEPTIONS', npmAudit.TEMP_DEPENDENCY_EXCEPTIONS),
  {
    name: 'KNIP_SUPPRESSIONS',
    file: KNIP_FILE,
    policy: 'time-bounded',
    entries: KNIP_SUPPRESSIONS.map((suppression) => ({
      key: suppression.file,
      reason: suppression.reason,
      expiresOn: suppression.expiresOn,
    })),
  },
  {
    // Orphaned systems are deliberate, indefinite design decisions (a lab-only
    // helper is not going to acquire a pipeline caller on a deadline), so this
    // list is governed as tracked-permanent rather than time-bounded.
    name: 'ALLOWLIST',
    file: ORPHANED_SYSTEMS_FILE,
    policy: 'tracked-permanent',
    entries: Object.entries(ORPHANED_SYSTEMS_ALLOWLIST).map(([systemName, entry]) => ({
      key: systemName,
      reason: entry.reason,
      trackingRef: entry.trackedIssue,
      removeWhen: entry.removeWhen,
    })),
  },
  {
    name: 'TEST_SCAFFOLD_ALLOWLIST_ENTRIES',
    file: TEST_SCAFFOLD_FILE,
    policy: 'time-bounded',
    // The derived `TEST_SCAFFOLD_ALLOWLIST` Set is a view of these entries, so
    // registering it here keeps the anti-bypass scan from double-reporting it.
    alsoCoversExportNames: ['TEST_SCAFFOLD_ALLOWLIST'],
    entries: TEST_SCAFFOLD_ALLOWLIST_ENTRIES.map((entry) => ({
      key: `${entry.file}#${entry.name}`,
      reason: entry.reason,
      expiresOn: entry.expiresOn,
    })),
  },
];

/**
 * Exported consts whose NAME matches the allowlist pattern but which are not
 * exemption lists, so there is nothing to govern. Each needs a written reason —
 * this is the one escape hatch and it stays auditable.
 */
const NON_GOVERNED_ALLOWLIST_EXPORTS: Readonly<Record<string, string>> = {
  ALLOWLIST_EXPORT_NAME_RE:
    'The detection regex used by this guard itself (allowlist-expiry-lib.ts). It grants no ' +
    'exemptions; it is what finds them.',
  REQUIRED_ALLOWLIST_FIELDS:
    'Schema metadata: the list of field NAMES every orphaned-systems allowlist entry must ' +
    'carry. It grants no exemptions, so it has nothing to expire.',
  ART_SURFACE_ALLOWLIST:
    'Path-classification constant that must match detect-art-only.sh exactly; it defines which ' +
    'paths count as art, not which findings are suppressed.',
};

// ---------------------------------------------------------------------------
// Discovery scan (the impure half of the anti-bypass rule)
// ---------------------------------------------------------------------------

const SCAN_ROOTS: readonly string[] = ['scripts', '.github/scripts'];
const SCANNED_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
];
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'dist', '.git']);

/**
 * Test files declare allowlist-shaped FIXTURE strings (npm-audit.test.mjs builds
 * `export const FOO_EXCEPTIONS = ...` source snippets to exercise its own
 * guard). Those are test data, not real allowlists, so they must not trip
 * discovery.
 */
function isTestFile(fileName: string): boolean {
  return /\.(test|spec)\./.test(fileName);
}

function collectScannableFiles(absoluteRoot: string, relativeRoot: string): string[] {
  let dirEntries;
  try {
    dirEntries = readdirSync(absoluteRoot, { withFileTypes: true });
  } catch {
    return []; // root does not exist in this checkout — nothing to scan.
  }

  const files: string[] = [];
  for (const dirEntry of dirEntries) {
    const relativePath = `${relativeRoot}/${dirEntry.name}`;
    if (dirEntry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(dirEntry.name)) continue;
      files.push(...collectScannableFiles(path.join(absoluteRoot, dirEntry.name), relativePath));
      continue;
    }
    if (!dirEntry.isFile()) continue;
    if (isTestFile(dirEntry.name)) continue;
    if (!SCANNED_EXTENSIONS.includes(path.extname(dirEntry.name))) continue;
    files.push(relativePath);
  }
  return files;
}

function discoverAllowlistExports(): readonly DiscoveredAllowlistExport[] {
  const discovered: DiscoveredAllowlistExport[] = [];
  for (const root of SCAN_ROOTS) {
    for (const relativePath of collectScannableFiles(fromRepo(root), root)) {
      const content = readFileSync(fromRepo(relativePath), 'utf8');
      for (const name of findExportedConstNames(content)) {
        if (!isAllowlistExportName(name)) continue;
        discovered.push({ name, file: relativePath });
      }
    }
  }
  return discovered;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function registeredExportNames(): readonly string[] {
  return [
    ...GOVERNED_SOURCES.flatMap((source) => [source.name, ...(source.alsoCoversExportNames ?? [])]),
    ...Object.keys(NON_GOVERNED_ALLOWLIST_EXPORTS),
  ];
}

function reportFinding(report: Report, finding: AllowlistFinding): void {
  report.error(`[${finding.kind}] ${finding.message}`, {
    file: finding.file,
    remediation: finding.remediation,
  });
}

function main(): void {
  const report = new Report('health-allowlist-expiry');
  const today = new Date().toISOString().slice(0, 10);

  const governanceFindings = findAllowlistFindings(GOVERNED_SOURCES, today);
  const unregisteredFindings = findUnregisteredAllowlists(
    discoverAllowlistExports(),
    registeredExportNames(),
  );

  for (const finding of [...governanceFindings, ...unregisteredFindings]) {
    reportFinding(report, finding);
  }

  if (governanceFindings.length === 0 && unregisteredFindings.length === 0) {
    const entryCount = GOVERNED_SOURCES.reduce((sum, source) => sum + source.entries.length, 0);
    report.info(
      `${entryCount} entries across ${GOVERNED_SOURCES.length} governed allowlists checked ` +
        `(as of ${today}); none expired, malformed, or unregistered.`,
    );
  }

  report.finish();
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `check-allowlist-expiry crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(2);
}

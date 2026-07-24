import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

// Exhaustive allowlist of exported numeric-literal constants per harness file.
// Adding a new constant to any of these files without registering it here will
// cause the scan test below to fail — forcing an explicit registration decision.
const NUMERIC_KNOBS: Record<string, string[]> = {
  '.github/scripts/ci-recovery/router.mjs': [
    'RUNNER_CEILING',
    'VALIDATION_RESERVED_TRAIN_BUSY',
    'VALIDATION_RESERVED_TRAIN_IDLE',
    'MAX_DISPATCH_BUDGET_TRAIN_BUSY',
    'MAX_DISPATCH_BUDGET_TRAIN_IDLE',
    'SWEEP_RUNNER_WEIGHT',
    'VALIDATION_RUNNER_WEIGHT',
    'REAPER_LANE_CAP',
  ],
  '.github/scripts/ci-recovery/state.mjs': [
    'DEFAULT_LEASE_TTL_MINUTES',
    'DEFAULT_LEASE_GRACE_MINUTES',
    'AUTOMATION_STALE_MINUTES',
  ],
  '.github/scripts/merge-train/state.mjs': ['MAX_TRAIN_SIZE', 'CANDIDATE_VALIDATION_STALE_MS'],
  '.github/scripts/ci-conflict-coordinator/state.mjs': [
    'MIN_CLUSTER_SIZE',
    'MAX_OVERLAP_FILES',
    'DISPATCH_LEASE_MS',
  ],
};

// Matches `export const UPPER_CASE = <numeric literal or arithmetic expression>;`
// Excludes derived constants (right-hand side starts with a letter, e.g. GLOBAL_FOO = OTHER_CONST).
const NUMERIC_EXPORT_RE = /^export const ([A-Z][A-Z0-9_]*)\s*=\s*\d/gm;

describe('CI harness knobs guard', () => {
  it('keeps ci-recovery dispatch budget knobs explicit and exported', () => {
    const source = read('.github/scripts/ci-recovery/router.mjs');
    expect(source).toContain('export const MAX_DISPATCH_BUDGET_TRAIN_BUSY = 5;');
    expect(source).toContain('export const MAX_DISPATCH_BUDGET_TRAIN_IDLE = 8;');
    expect(source).toContain(
      'export const GLOBAL_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_BUSY;',
    );
    expect(source).toContain(
      'export const GLOBAL_IDLE_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_IDLE;',
    );
  });

  it('keeps ownership and train-size safety knobs pinned', () => {
    const recoveryState = read('.github/scripts/ci-recovery/state.mjs');
    const trainState = read('.github/scripts/merge-train/state.mjs');
    const conflictState = read('.github/scripts/ci-conflict-coordinator/state.mjs');

    expect(recoveryState).toContain('export const DEFAULT_LEASE_TTL_MINUTES = 30;');
    expect(recoveryState).toContain('export const DEFAULT_LEASE_GRACE_MINUTES = 5;');
    expect(recoveryState).toContain('export const AUTOMATION_STALE_MINUTES = 30;');

    expect(trainState).toContain('export const MAX_TRAIN_SIZE = 6;');

    expect(conflictState).toContain(
      'export const DISPATCH_LEASE_MS = 30 * 60 * 1000; // 30 minutes',
    );
  });

  it('scans all exported numeric-literal constants and rejects unregistered ones', () => {
    for (const [filePath, allowlist] of Object.entries(NUMERIC_KNOBS)) {
      const source = read(filePath);
      const found = [...source.matchAll(NUMERIC_EXPORT_RE)].map((m) => m[1]);

      for (const name of found) {
        expect(
          allowlist,
          `Unregistered numeric constant '${name}' in ${filePath} — add it to NUMERIC_KNOBS or convert it to a structural (non-exported) constant`,
        ).toContain(name);
      }

      for (const name of allowlist) {
        expect(
          source,
          `Allowlisted constant '${name}' missing from ${filePath} — remove it from NUMERIC_KNOBS`,
        ).toMatch(new RegExp(`export const ${name}\\s*=`));
      }
    }
  });

  it('verifies each allowlisted constant is used within its own module (not an orphaned export)', () => {
    for (const [filePath, allowlist] of Object.entries(NUMERIC_KNOBS)) {
      const source = read(filePath);
      for (const name of allowlist) {
        // Count occurrences: more than one means the constant is referenced
        // beyond the export declaration (i.e., actually wired into the module logic).
        const occurrences = (source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
        expect(
          occurrences,
          `Constant '${name}' in ${filePath} appears only once — it is declared but never used within its module`,
        ).toBeGreaterThan(1);
      }
    }
  });
});

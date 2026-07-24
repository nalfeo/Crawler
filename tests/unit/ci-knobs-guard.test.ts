import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

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

    expect(conflictState).toContain('export const DISPATCH_LEASE_MS = 30 * 60 * 1000; // 30 minutes');
  });
});

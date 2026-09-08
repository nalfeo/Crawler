#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeCheckinFileLock } from './checkin-runtime.js';
import {
  applyDislikedLifecyclePlan,
  loadDislikedLifecyclePlan,
  summarizeDislikedLifecycle,
  validateDislikedLifecycleClosure,
} from './disliked-lifecycle.js';

export async function main(argv: readonly string[], repoRoot: string): Promise<number> {
  const apply = argv.includes('--apply');
  const closureOnly = argv.includes('--closure-only');
  const dryRun = argv.includes('--dry-run') || (!apply && !closureOnly);
  if (argv.some((arg) => arg !== '--apply' && arg !== '--dry-run' && arg !== '--closure-only')) {
    process.stderr.write(
      'Usage: npm run sprites:disliked-lifecycle -- [--dry-run|--apply|--closure-only]\n',
    );
    return 1;
  }
  if ([apply, argv.includes('--dry-run'), closureOnly].filter(Boolean).length > 1) {
    process.stderr.write('Choose exactly one of --dry-run, --apply, or --closure-only.\n');
    return 1;
  }

  try {
    const run = async (): Promise<void> => {
      if (closureOnly) {
        validateDislikedLifecycleClosure(repoRoot, { removed: [] });
        process.stdout.write(
          `${JSON.stringify({ mode: 'closure-only', status: 'ok' }, null, 2)}\n`,
        );
        return;
      }
      const plan = loadDislikedLifecyclePlan(repoRoot);
      const summary = summarizeDislikedLifecycle(plan);
      process.stdout.write(
        `${JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', ...summary }, null, 2)}\n`,
      );
      if (apply) {
        applyDislikedLifecyclePlan(repoRoot, plan);
      } else {
        // HARD ZERO-DANGLING GATE. Every HISTORICAL tombstone must still be
        // closed (shard gone, PNG gone, tombstone intact, zero exact references
        // left). Validated with `removed: []` so the ledger is checked on its
        // own terms: this is a pre-apply dry run, so THIS plan's proposed
        // removals legitimately still have their shard and PNG on disk and must
        // not be scored as dangling. Previously this ran only when the plan
        // proposed nothing, which silently retired the check for exactly the
        // repos that had lifecycle work pending.
        validateDislikedLifecycleClosure(repoRoot, { ...plan, removed: [] });
      }
    };
    if (apply) {
      await makeCheckinFileLock(repoRoot)(run);
    } else {
      await run();
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `disliked lifecycle failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

const invokedAsScript = (() => {
  try {
    return path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  void main(process.argv.slice(2), process.cwd()).then((code) => {
    process.exitCode = code;
  });
}

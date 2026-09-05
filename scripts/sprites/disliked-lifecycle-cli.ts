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
  const dryRun = argv.includes('--dry-run') || !apply;
  if (argv.some((arg) => arg !== '--apply' && arg !== '--dry-run' && arg !== '--json')) {
    process.stderr.write(
      'Usage: npm run sprites:disliked-lifecycle -- [--dry-run|--apply] [--json]\n',
    );
    return 1;
  }
  if (apply && argv.includes('--dry-run')) {
    process.stderr.write('Choose exactly one of --dry-run or --apply.\n');
    return 1;
  }

  try {
    const run = async (): Promise<void> => {
      const plan = loadDislikedLifecyclePlan(repoRoot);
      const summary = summarizeDislikedLifecycle(plan);
      process.stdout.write(
        `${JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', ...summary }, null, 2)}\n`,
      );
      if (apply) {
        applyDislikedLifecyclePlan(repoRoot, plan);
      } else if (plan.removed.length === 0) {
        validateDislikedLifecycleClosure(repoRoot, plan);
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

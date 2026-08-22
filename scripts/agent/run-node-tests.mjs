/**
 * CLI wrapper: `node scripts/agent/run-node-tests.mjs <group>`.
 *
 * Replaces the hand-maintained `node --test <161 paths>` registries that used
 * to live in `package.json`. Discovery logic (and its tests) live in
 * `run-node-tests-lib.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runGroup } from './run-node-tests-lib.mjs';

// Anchor on this file, not the caller's CWD, so the discovered roots are the
// same no matter where the script is invoked from.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const group = process.argv[2];
if (!group) {
  process.stderr.write('Usage: node scripts/agent/run-node-tests.mjs <group>\n');
  process.exit(2);
}

try {
  process.exitCode = runGroup({
    group,
    repoRoot: REPO_ROOT,
    spawn: spawnSync,
    log: (message) => process.stdout.write(`${message}\n`),
  });
} catch (error) {
  process.stderr.write(`run-node-tests failed: ${error.message}\n`);
  process.exit(2);
}

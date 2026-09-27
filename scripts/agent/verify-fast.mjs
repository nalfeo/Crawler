#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { npmCliForNode } from './run-tsx.mjs';

// A running workflow can retain an older stage definition that invokes only
// `npm run verify:fast`. Bootstrap here, before tsx, in that stage's worktree.
// Keep the existing verifier and all its checks unchanged.
export function main({
  root = process.cwd(),
  env = process.env,
  nodeExecutable = process.execPath,
  exists = existsSync,
  spawn = spawnSync,
  log = console.log,
} = {}) {
  const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const options = { cwd: root, env, stdio: 'inherit' };
  function run(args) {
    const result = spawn(nodeExecutable, args, options);
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  if (!exists(tsx)) {
    log('Fresh verification worktree: installing lockfile dependencies…');
    const status = run([
      env.CRAWLER_NPM_CLI || npmCliForNode(nodeExecutable),
      'ci',
      '--ignore-scripts',
      '--prefer-offline',
    ]);
    if (status !== 0) return status;
    if (!exists(tsx)) {
      throw new Error('Dependency installation did not provide tsx; verification cannot start.');
    }
  }
  return run([tsx, 'scripts/agent/run-bash-wrapper.ts', 'scripts/agent/verify-fast.sh']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main();

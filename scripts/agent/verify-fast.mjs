#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main as runAgent } from './run-tsx.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A persisted workflow may invoke this gate in a new worktree without preflight.
// Bootstrap here so recovery does not depend on reloading that workflow snapshot.
export async function main({ root = repositoryRoot, exists = existsSync, run = runAgent } = {}) {
  const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!exists(tsx)) {
    const status = await run(['--npm', 'ci', '--ignore-scripts', '--prefer-offline']);
    if (status !== 0) return status;
    if (!exists(tsx)) {
      throw new Error('Dependency bootstrap completed without tsx; rerun npm run preflight.');
    }
  }
  return run(['scripts/agent/run-bash-wrapper.ts', 'scripts/agent/verify-fast.sh']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();

#!/usr/bin/env node
/** Bootstrap dependencies in isolated gate worktrees, then run the unchanged verifier. */
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { main as bootstrap } from './preflight.mjs';

export function main(options = {}) {
  // Reuse dependency/Git Bash setup without running preflight.sh: verification
  // must not sync main or change the commit selected by the workflow stage.
  return bootstrap({ ...options, bashScript: 'scripts/agent/verify-fast.sh' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main();

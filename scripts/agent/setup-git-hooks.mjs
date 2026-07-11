#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

if (existsSync(resolve('.git'))) {
  try {
    execSync('git config core.hooksPath .githooks', { stdio: 'inherit' });
  } catch (error) {
    process.stderr.write(
      `[setup-git-hooks] Skipping git hook setup: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

for (const hook of ['pre-commit', 'pre-push', 'commit-msg']) {
  const hookPath = resolve('.githooks', hook);
  if (existsSync(hookPath)) {
    chmodSync(hookPath, 0o755);
  }
}

#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (existsSync(resolve('.git'))) {
  try {
    execSync('git config core.hooksPath .githooks', { stdio: 'inherit' });
  } catch (error) {
    console.warn(
      `[setup-git-hooks] Skipping git hook setup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

for (const hook of ['pre-commit', 'pre-push']) {
  const hookPath = resolve('.githooks', hook);
  if (existsSync(hookPath)) {
    chmodSync(hookPath, 0o755);
  }
}

#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

execSync('git config core.hooksPath .githooks', { stdio: 'inherit' })

for (const hook of ['pre-commit', 'pre-push']) {
  const hookPath = resolve('.githooks', hook)
  if (existsSync(hookPath)) {
    chmodSync(hookPath, 0o755)
  }
}

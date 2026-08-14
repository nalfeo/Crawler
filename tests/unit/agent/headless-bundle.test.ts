import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LAUNCHER = path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'headless-bundle.mjs');
const BUNDLE = path.join(REPO_ROOT, 'files', 'headless-runner-cli.bundle.mjs');

function runLauncher(args: string[]) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

describe('ai:headless launcher', () => {
  it('bundles the CLI and forwards argv and exit code', () => {
    // Removing the bundle first proves the launcher builds it rather than
    // relying on an artifact a previous run happened to leave behind.
    rmSync(BUNDLE, { force: true });

    const result = runLauncher(['--help']);

    expect(existsSync(BUNDLE)).toBe(true);
    expect(result.stdout).toContain('Headless AI Runner CLI');
    expect(result.status).toBe(0);
  }, 120_000);

  it('propagates a non-zero exit code from the CLI verbatim', () => {
    // The CLI's exit code reports whether the AI *won the run*, so the launcher
    // must never normalize it. One frame cannot win, so this must be non-zero.
    const result = runLauncher(['--seed', '1', '--max-frames', '1']);

    expect(result.status).not.toBe(0);
  }, 120_000);
});

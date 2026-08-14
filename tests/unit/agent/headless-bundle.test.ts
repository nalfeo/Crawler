import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LAUNCHER = path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'headless-bundle.mjs');
const BUNDLE_PREFIX = 'headless-runner-cli.bundle-';

function runLauncher(args: string[]) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function runLauncherConcurrently(args: string[]) {
  return new Promise<{ status: number | null; stderr: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [LAUNCHER, ...args], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (status) => {
        resolve({ status, stderr, stdout });
      });
    },
  );
}

describe('ai:headless launcher', () => {
  it('bundles the CLI and forwards argv and exit code', () => {
    const result = runLauncher(['--help']);

    expect(readdirSync(path.join(REPO_ROOT, 'files'))).toContainEqual(
      expect.stringMatching(new RegExp(`^${BUNDLE_PREFIX}[a-f0-9]{16}\\.mjs$`)),
    );
    expect(result.stdout).toContain('Headless AI Runner CLI');
    expect(result.status).toBe(0);
  }, 120_000);

  it('propagates a non-zero exit code from the CLI verbatim', () => {
    // The CLI's exit code reports whether the AI *won the run*, so the launcher
    // must never normalize it. One frame cannot win, so this must be non-zero.
    const result = runLauncher(['--seed', '1', '--max-frames', '1']);

    expect(result.status).not.toBe(0);
  }, 120_000);

  it('supports concurrent launchers without exposing a partial bundle', async () => {
    const results = await Promise.all([
      runLauncherConcurrently(['--help']),
      runLauncherConcurrently(['--help']),
    ]);

    for (const result of results) {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Headless AI Runner CLI');
      expect(result.stderr).not.toContain('SyntaxError');
    }
  }, 120_000);
});

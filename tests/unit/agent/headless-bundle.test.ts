import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LAUNCHER = path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'headless-bundle.mjs');
const PREBUNDLE_LAUNCHER = path.join(REPO_ROOT, 'scripts', 'agent', 'perf', 'prebundle-cli.mjs');
const BUNDLE = path.join(REPO_ROOT, 'files', 'headless-runner-cli.bundle.mjs');
const FINGERPRINT_OUTPUT = path.join(REPO_ROOT, 'files', 'headless-bundle-test-fingerprint.json');

function runLauncher(args: string[]) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function runPrebundle(entry: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [PREBUNDLE_LAUNCHER, '--entry', entry, ...args], {
    cwd: REPO_ROOT,
    env: env ? { ...process.env, ...env } : process.env,
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

  it('preserves workflow provenance through the bundled sweep launcher', () => {
    const workflowSha = '1'.repeat(40);
    const result = runPrebundle('sweep-eval', ['--print-meta'], { GITHUB_SHA: workflowSha });
    const expectedLockHash = createHash('sha256')
      .update(readFileSync(path.join(REPO_ROOT, 'package-lock.json')))
      .digest('hex');

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workflowSha,
      packageLockHash: expectedLockHash,
    });
  }, 120_000);

  it('bundles every sweep entrypoint and runs a bundled worker', () => {
    const entries = [
      [
        'winrate-sweep',
        [
          '--seeds',
          '1-2',
          '--weapons',
          'sword',
          '--max-frames',
          '1',
          '--workers',
          '2',
          '--skip-events',
        ],
      ],
      ['sweep-eval', ['--print-meta']],
      [
        'sim-fingerprint',
        [
          '--seeds',
          '1-2',
          '--weapons',
          'sword',
          '--workers',
          '2',
          '--max-frames',
          '1',
          '--write',
          FINGERPRINT_OUTPUT,
        ],
      ],
      [
        'weapon-sweep',
        ['--seeds', '1', '--weapons', 'sword', '--max-frames', '1', '--no-weapon-personas'],
      ],
      [
        'hill-climb',
        ['--seeds', '1', '--max-iters', '0', '--max-frames', '1', '--out', 'files/hill-test.json'],
      ],
    ] as const;

    try {
      let bundledWorkerOutput = '';
      for (const [entry, args] of entries) {
        const result = runPrebundle(entry, [...args]);
        expect(result.status, `${entry}: ${result.stderr}`).toBe(0);
        expect(existsSync(path.join(REPO_ROOT, 'files', `${entry}.bundle.mjs`))).toBe(true);
        if (entry === 'sim-fingerprint') {
          bundledWorkerOutput = result.stderr;
        }
      }
      expect(bundledWorkerOutput).not.toContain('tsx-worker-hooks');
    } finally {
      rmSync(FINGERPRINT_OUTPUT, { force: true });
      rmSync(path.join(REPO_ROOT, 'files', 'hill-test.json'), { force: true });
    }
  }, 120_000);
});

/**
 * Tests for the queue-commit primitive (`runQueueCommit`).
 *
 * Two layers:
 *   1. CONTROL-FLOW tests drive a fully-faked `exec` (recording commands) to
 *      assert the branchy logic — CI refusal, path allowlist, no-op guard, the
 *      exact git command sequence, plain (non-force) push, retry-on-rejection,
 *      and retry exhaustion — with no real repo or network.
 *   2. REAL-GIT tests run the primitive against a temp bare "origin" + live
 *      clone to prove the load-bearing durability claims that a mock cannot:
 *      the caller's branch/index/HEAD are never touched, a concurrent writer's
 *      manifest entry survives a forced push-rejection retry (NO clobber),
 *      binary PNGs round-trip byte-identical, and the queue branch carries only
 *      the asset delta.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckinAsset, Exec, ExecResult } from '../../../scripts/sprites/checkin.js';
import {
  runQueueCommit,
  isNonFastForwardRejection,
  assertSafeBriefPaths,
  assertSafeAnnotationUpdates,
  type QueueCommitDeps,
} from '../../../scripts/sprites/queue-commit.js';
import { createDefaultQueueCommitDeps } from '../../../scripts/sprites/queue-commit-runtime.js';

function asset(overrides: Partial<CheckinAsset> = {}): CheckinAsset {
  return {
    assetPath: 'generated/skull-mace-var-2.png',
    manifestKey: 'skull-mace-var-2',
    briefId: 'skull-mace',
    variantIndex: 2,
    ...overrides,
  };
}

function stageBriefOnDisk(liveDir: string, briefPath: string, yaml: string): void {
  const abs = path.join(liveDir, ...briefPath.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, yaml);
}

// ---------------------------------------------------------------------------
// Layer 1: control-flow (faked exec)
// ---------------------------------------------------------------------------

function makeFakeExec(
  responder: (command: string, args: readonly string[]) => Partial<ExecResult>,
): {
  exec: Exec;
  calls: Array<{ command: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const exec: Exec = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options?.cwd });
    const result = { stdout: '', stderr: '', code: 0, ...responder(command, args) };
    // Historical tests use `code: 1` for every `git diff` to model the later
    // `--cached --quiet` check. A name-only deletion scan has no --exit-code and
    // succeeds with an empty result in real git, so normalize that fixture-only
    // shorthand without hiding an explicit simulated error/output.
    if (
      command === 'git' &&
      args[0] === 'diff' &&
      args.includes('--diff-filter=D') &&
      result.code === 1 &&
      result.stdout === '' &&
      result.stderr === ''
    ) {
      result.code = 0;
    }
    return Promise.resolve(result);
  };
  return { exec, calls };
}

function controlDeps(exec: Exec, overrides: Partial<QueueCommitDeps> = {}): QueueCommitDeps {
  return {
    exec,
    copyArtSurface: () => Promise.resolve(),
    makeTempDir: () => Promise.resolve('/tmp/qc-xyz'),
    removeDir: () => Promise.resolve(),
    withCrossProcessLock: (fn) => fn(),
    sleep: () => Promise.resolve(),
    env: {} as NodeJS.ProcessEnv,
    ...overrides,
  };
}

/** Happy-path responder: branch absent, staged diff present, push accepted. */
function happyResponder(_command: string, args: readonly string[]): Partial<ExecResult> {
  if (args[0] === 'ls-remote') return { stdout: '' }; // queue branch absent
  if (args[0] === 'diff') return { code: 1 }; // --cached --quiet: there IS a staged diff
  if (args[0] === 'rev-parse') return { stdout: 'abc123def456\n' };
  return {}; // fetch / worktree / add / commit / push / remove -> code 0
}

describe('runQueueCommit (control flow)', () => {
  it('refuses to run under CI and makes no git calls', async () => {
    const { exec, calls } = makeFakeExec(() => ({}));
    await expect(
      runQueueCommit('/repo', [asset()], controlDeps(exec, { env: { CI: 'true' } }), {
        message: 'm',
      }),
    ).rejects.toMatchObject({ kind: 'ci-refused' });
    expect(calls).toHaveLength(0);
  });

  it('allows the trusted publisher capability under CI', async () => {
    const { exec, calls } = makeFakeExec(happyResponder);
    const result = await runQueueCommit(
      '/repo',
      [asset()],
      controlDeps(exec, {
        env: {
          CI: 'true',
          GITHUB_ACTIONS: 'true',
          GITHUB_WORKFLOW_REF: 'nalfeo/Crawler/.github/workflows/asset-request.yml@refs/heads/main',
          SPRITES_ALLOW_CI_ASSET_PUBLISH: 'true',
        },
      }),
      {
        message: 'm',
        ciAuthorization: { caller: 'asset-request-publisher' },
      },
    );

    expect(result.status).toBe('committed');
    expect(calls.some((call) => call.args[0] === 'push')).toBe(true);
  });

  it('allows the narrow theme-equipment-publisher capability under CI', async () => {
    const { exec, calls } = makeFakeExec(happyResponder);
    const result = await runQueueCommit(
      '/repo',
      [asset()],
      controlDeps(exec, {
        env: {
          CI: 'true',
          GITHUB_ACTIONS: 'true',
          GITHUB_WORKFLOW_REF:
            'nalfeo/Crawler/.github/workflows/theme-equipment.yml@refs/heads/main',
          SPRITES_ALLOW_CI_THEME_PUBLISH: 'true',
        },
      }),
      {
        message: 'm',
        ciAuthorization: { caller: 'theme-equipment-publisher' },
      },
    );

    expect(result.status).toBe('committed');
    expect(calls.some((call) => call.args[0] === 'push')).toBe(true);
  });

  it('refuses the theme-equipment-publisher capability if the asset-request env flag was set instead', async () => {
    const { exec, calls } = makeFakeExec(() => ({}));
    await expect(
      runQueueCommit(
        '/repo',
        [asset()],
        controlDeps(exec, {
          env: {
            CI: 'true',
            GITHUB_ACTIONS: 'true',
            GITHUB_WORKFLOW_REF:
              'nalfeo/Crawler/.github/workflows/theme-equipment.yml@refs/heads/main',
            // Wrong flag for this caller — the asset-request publisher's flag
            // must not also unlock the theme-equipment-publisher caller.
            SPRITES_ALLOW_CI_ASSET_PUBLISH: 'true',
          },
        }),
        { message: 'm', ciAuthorization: { caller: 'theme-equipment-publisher' } },
      ),
    ).rejects.toMatchObject({ kind: 'ci-refused' });
    expect(calls).toHaveLength(0);
  });

  it('refuses the theme-equipment-publisher capability when the workflow-ref does not match', async () => {
    const { exec, calls } = makeFakeExec(() => ({}));
    await expect(
      runQueueCommit(
        '/repo',
        [asset()],
        controlDeps(exec, {
          env: {
            CI: 'true',
            GITHUB_ACTIONS: 'true',
            // An unrecognized workflow path must not authorize publication,
            // even with the right flag set.
            GITHUB_WORKFLOW_REF:
              'nalfeo/Crawler/.github/workflows/some-other-workflow.yml@refs/heads/main',
            SPRITES_ALLOW_CI_THEME_PUBLISH: 'true',
          },
        }),
        { message: 'm', ciAuthorization: { caller: 'theme-equipment-publisher' } },
      ),
    ).rejects.toMatchObject({ kind: 'ci-refused' });
    expect(calls).toHaveLength(0);
  });

  it('rejects unsafe asset paths before touching git', async () => {
    const { exec, calls } = makeFakeExec(() => ({}));
    for (const bad of ['../evil.png', '/abs/evil.png', 'generated/../../etc.png', 'a\\b.png']) {
      await expect(
        runQueueCommit('/repo', [asset({ assetPath: bad })], controlDeps(exec), { message: 'm' }),
      ).rejects.toMatchObject({ kind: 'invalid-asset-path' });
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects clean paths that escape the staged generated/ surface (silent no-op guard)', async () => {
    const { exec, calls } = makeFakeExec(() => ({}));
    // Traversal-free, absolute-free POSIX paths — but OUTSIDE `generated/`, so
    // copyArtSurface would copy them yet `git add -- <surface>` never stages them,
    // silently producing a no-op commit. assertSafeAssetPaths must reject them.
    for (const bad of ['icons/foo.png', 'public/assets/other.png', 'sprite-catalog.json']) {
      await expect(
        runQueueCommit('/repo', [asset({ assetPath: bad })], controlDeps(exec), { message: 'm' }),
      ).rejects.toMatchObject({ kind: 'invalid-asset-path' });
    }
    expect(calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // assertSafeBriefPaths
  // -------------------------------------------------------------------------

  it('assertSafeBriefPaths: accepts valid paths under briefs/', () => {
    expect(() =>
      assertSafeBriefPaths([
        'briefs/enemies/panda-boba-sniper.yaml',
        'briefs/weapons/soul-reaper.yaml',
      ]),
    ).not.toThrow();
  });

  it('assertSafeBriefPaths: rejects empty string', () => {
    expect(() => assertSafeBriefPaths([''])).toThrow();
  });

  it('assertSafeBriefPaths: rejects absolute paths', () => {
    expect(() => assertSafeBriefPaths(['/briefs/enemies/foo.yaml'])).toThrow();
  });

  it('assertSafeBriefPaths: rejects traversal sequences', () => {
    expect(() => assertSafeBriefPaths(['briefs/../etc/passwd'])).toThrow();
    expect(() => assertSafeBriefPaths(['../briefs/enemies/foo.yaml'])).toThrow();
  });

  it('assertSafeBriefPaths: rejects paths not under briefs/', () => {
    expect(() => assertSafeBriefPaths(['src/game/foo.ts'])).toThrow();
    expect(() => assertSafeBriefPaths(['public/assets/generated/foo.png'])).toThrow();
  });

  // -------------------------------------------------------------------------
  // assertSafeAnnotationUpdates
  // -------------------------------------------------------------------------

  it('assertSafeAnnotationUpdates: accepts a valid annotation update', () => {
    expect(() =>
      assertSafeAnnotationUpdates([
        { key: 'skull-mace-var-2', favorite: true, disliked: false, comment: 'Great silhouette.' },
      ]),
    ).not.toThrow();
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'assertSafeAnnotationUpdates: rejects the reserved key %s',
    (key) => {
      expect(() =>
        assertSafeAnnotationUpdates([{ key, favorite: false, disliked: true, comment: '' }]),
      ).toThrow(/Invalid sprite annotation key/);
    },
  );

  it('assertSafeAnnotationUpdates: rejects duplicate keys', () => {
    expect(() =>
      assertSafeAnnotationUpdates([
        { key: 'alpha', favorite: true, disliked: false, comment: '' },
        { key: 'alpha', favorite: false, disliked: true, comment: '' },
      ]),
    ).toThrow(/Duplicate sprite annotation key/);
  });

  it('throws invalid-brief-path when briefs supplied but copyBriefFiles dep is absent', async () => {
    const { exec } = makeFakeExec(happyResponder);
    const deps: QueueCommitDeps = controlDeps(exec);
    // copyBriefFiles is optional — verify the invariant guard throws rather than silently drops.
    await expect(
      runQueueCommit('/repo', [asset()], deps, {
        message: 'm',
        briefs: ['briefs/enemies/panda-boba-sniper.yaml'],
      }),
    ).rejects.toMatchObject({ kind: 'invalid-brief-path' });
  });

  it('stages copied briefs before the no-op diff guard', async () => {
    const { exec, calls } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: '' };
      if (args[0] === 'diff') return { code: 0 };
      return {};
    });
    let copiedBriefs = 0;
    const result = await runQueueCommit(
      '/repo',
      [asset()],
      controlDeps(exec, {
        copyBriefFiles: async () => {
          copiedBriefs++;
        },
      }),
      {
        message: 'm',
        briefs: ['briefs/enemies/panda-boba-sniper.yaml'],
      },
    );
    expect(result.status).toBe('noop');
    expect(copiedBriefs).toBe(1);

    const line = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    const addBriefIdx = line.findIndex((l) => l === 'git add -- briefs/');
    const diffIdx = line.findIndex((l) => l === 'git diff --cached --quiet');
    expect(addBriefIdx).toBeGreaterThan(-1);
    expect(diffIdx).toBeGreaterThan(-1);
    expect(addBriefIdx).toBeLessThan(diffIdx);
  });

  it('returns a no-op for an empty asset list without touching git', async () => {
    const { exec, calls } = makeFakeExec(() => ({}));
    const result = await runQueueCommit('/repo', [], controlDeps(exec), { message: 'm' });
    expect(result).toEqual({ status: 'noop', branch: 'assets/queue', attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  it('drives the expected git sequence and a PLAIN (non-force) push', async () => {
    const { exec, calls } = makeFakeExec(happyResponder);
    const copyCalls: Array<{ src: string; dest: string; assets: readonly CheckinAsset[] }> = [];
    const result = await runQueueCommit(
      '/repo',
      [asset()],
      controlDeps(exec, {
        copyArtSurface: (src, dest, assets) => {
          copyCalls.push({ src, dest, assets });
          return Promise.resolve();
        },
      }),
      { message: 'chore(assets): edit skull-mace-var-2' },
    );

    expect(result).toEqual({
      status: 'committed',
      branch: 'assets/queue',
      commit: 'abc123def456',
      attempts: 1,
    });
    // copyArtSurface unions the LIVE repo's entry onto the worktree checkout.
    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0]!.src).toBe('/repo');
    expect(copyCalls[0]!.dest).toBe('/tmp/qc-xyz');

    const line = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(line[0]).toBe('git ls-remote --heads origin assets/queue');
    expect(
      line.some((l) => l === 'git fetch --no-tags origin +main:refs/queue-commit/base-qc-xyz'),
    ).toBe(true);
    expect(
      line.some((l) => l === 'git worktree add /tmp/qc-xyz --detach refs/queue-commit/base-qc-xyz'),
    ).toBe(true);
    expect(line.some((l) => l === 'git add -- public/assets/generated')).toBe(true);
    expect(line.some((l) => l === 'git diff --cached --quiet')).toBe(true);
    expect(line.some((l) => l.startsWith('git commit --no-verify -m'))).toBe(true);
    expect(
      line.some((l) => l === 'git push --no-verify origin abc123def456:refs/heads/assets/queue'),
    ).toBe(true);
    expect(line.some((l) => l.includes('worktree remove'))).toBe(true);
    // The private scratch ref (unique per worktree) is always cleaned up.
    expect(line.some((l) => l === 'git update-ref -d refs/queue-commit/base-qc-xyz')).toBe(true);
    // The PUSH is never a force push — the CAS relies on plain
    // fast-forward-only semantics (worktree remove --force is unrelated).
    const pushLines = line.filter((l) => l.startsWith('git push'));
    expect(pushLines).toHaveLength(1);
    expect(pushLines[0]!.includes('--force')).toBe(false);
  });

  it('fetches the queue branch and aligns it with current main when it already exists', async () => {
    const { exec, calls } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: 'deadbeef\trefs/heads/assets/queue\n' };
      if (args[0] === 'diff') return { code: 1 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n' };
      return {};
    });
    await runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm' });
    const line = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(
      line.some(
        (l) => l === 'git fetch --no-tags origin +assets/queue:refs/queue-commit/base-qc-xyz',
      ),
    ).toBe(true);
    expect(
      line.some((l) => l === 'git fetch --no-tags origin +main:refs/queue-commit/main-qc-xyz'),
    ).toBe(true);
    expect(line.some((l) => l === 'git merge --no-edit refs/queue-commit/main-qc-xyz')).toBe(true);
  });

  it('classifies a queue/main merge conflict as a permanent destination conflict', async () => {
    const { exec } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: 'deadbeef\trefs/heads/assets/queue\n' };
      if (args[0] === 'merge') return { code: 1, stderr: 'CONFLICT (content): manifest.json' };
      return {};
    });

    await expect(
      runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm', maxAttempts: 3 }),
    ).rejects.toMatchObject({ kind: 'destination-conflict' });
  });

  // ---------------------------------------------------------------------------
  // Regression: unrelated-histories fallback (orphan queue branch)
  // ---------------------------------------------------------------------------

  it('on unrelated-histories: resets to main then layers art from the orphan tip', async () => {
    let mergeCount = 0;
    const { exec, calls } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: 'deadbeef\trefs/heads/assets/queue\n' };
      if (args[0] === 'merge') {
        mergeCount++;
        // Only the first (normal) merge is called; the fallback no longer uses merge.
        return mergeCount === 1
          ? { code: 1, stderr: 'fatal: refusing to merge unrelated histories' }
          : {}; // should never be reached
      }
      if (args[0] === 'reset') return { code: 0 }; // reset --hard
      if (args[0] === 'checkout') return { code: 0 }; // checkout baseRef -- art surface
      if (args[0] === 'diff') return { code: 1 }; // staged diff present
      if (args[0] === 'rev-parse') {
        // Return distinguishable SHAs: HEAD → new commit, baseRef → orphan tip
        return args[1] === 'HEAD' ? { stdout: 'newcommitsha\n' } : { stdout: 'orphansha\n' };
      }
      return {};
    });

    const result = await runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm' });
    expect(result.status).toBe('committed');

    const line = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    // Only one merge attempt — the normal one.
    const mergeLines = line.filter((l) => l.startsWith('git merge'));
    expect(mergeLines).toHaveLength(1);
    expect(mergeLines[0]).toBe('git merge --no-edit refs/queue-commit/main-qc-xyz');
    // reset --hard mainRef
    expect(line.some((l) => l === 'git reset --hard refs/queue-commit/main-qc-xyz')).toBe(true);
    // checkout baseRef -- <art surface>
    expect(
      line.some(
        (l) =>
          l.startsWith('git checkout refs/queue-commit/base-qc-xyz --') &&
          l.includes('public/assets/generated'),
      ),
    ).toBe(true);
    // No --allow-unrelated-histories flag anywhere.
    expect(line.some((l) => l.includes('allow-unrelated-histories'))).toBe(false);
    // Push uses --force-with-lease scoped to the orphan SHA (usedOrphanReset = true).
    const pushLine = line.find((l) => l.startsWith('git push'));
    expect(pushLine).toContain('--force-with-lease=refs/heads/assets/queue:orphansha');
    expect(pushLine).not.toContain('--force-with-lease=refs/heads/assets/queue:newcommitsha');
  });

  it('does NOT reset/checkout for other merge failures (content conflict)', async () => {
    const { exec, calls } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: 'deadbeef\trefs/heads/assets/queue\n' };
      if (args[0] === 'merge')
        return { code: 1, stderr: 'CONFLICT (content): sprite-catalog.json' };
      return {};
    });

    await expect(
      runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm' }),
    ).rejects.toMatchObject({ kind: 'destination-conflict' });

    // Only one merge attempt; no reset or checkout called.
    const mergeCalls = calls.filter((c) => c.args[0] === 'merge');
    expect(mergeCalls).toHaveLength(1);
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false);
    expect(
      calls
        .filter((c) => c.args[0] === 'checkout')
        .some((c) => c.args.includes('--allow-unrelated-histories') || c.args.includes('--hard')),
    ).toBe(false);
  });

  it('throws destination-conflict when the orphan art checkout fails with a non-pathspec error', async () => {
    const { exec } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: 'deadbeef\trefs/heads/assets/queue\n' };
      if (args[0] === 'merge')
        return { code: 1, stderr: 'fatal: refusing to merge unrelated histories' };
      if (args[0] === 'reset') return { code: 0 }; // reset --hard succeeds
      if (args[0] === 'checkout')
        return { code: 128, stderr: 'fatal: bad object refs/queue-commit/base-qc-xyz' };
      return {};
    });

    await expect(
      runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm' }),
    ).rejects.toMatchObject({ kind: 'destination-conflict' });
  });

  it('succeeds when the orphan has no art (pathspec error is treated as empty queue)', async () => {
    const { exec, calls } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: 'deadbeef\trefs/heads/assets/queue\n' };
      if (args[0] === 'merge')
        return { code: 1, stderr: 'fatal: refusing to merge unrelated histories' };
      if (args[0] === 'reset') return { code: 0 };
      if (args[0] === 'checkout')
        return { code: 1, stderr: 'error: pathspec did not match any file(s) known to git' };
      if (args[0] === 'diff') return { code: 1 }; // staged diff present
      if (args[0] === 'rev-parse') {
        return args[1] === 'HEAD' ? { stdout: 'newcommitsha\n' } : { stdout: 'orphansha\n' };
      }
      return {};
    });

    const result = await runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm' });
    expect(result.status).toBe('committed');
    // Even with no existing art on the orphan, the push uses --force-with-lease.
    const line = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    const pushLine = line.find((l) => l.startsWith('git push'));
    expect(pushLine).toContain('--force-with-lease=refs/heads/assets/queue:orphansha');
  });

  it('returns a no-op (no commit/push) when nothing is staged', async () => {
    const { exec, calls } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: '' };
      if (args[0] === 'diff') return { code: 0 }; // nothing staged
      return {};
    });
    const result = await runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm' });
    expect(result.status).toBe('noop');
    const line = calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(line.some((l) => l.startsWith('git commit'))).toBe(false);
    expect(line.some((l) => l.startsWith('git push'))).toBe(false);
    // The worktree is still cleaned up on the no-op path.
    expect(line.some((l) => l.includes('worktree remove'))).toBe(true);
  });

  it('retries after a non-fast-forward push rejection, then succeeds', async () => {
    let pushCount = 0;
    const { exec, calls } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: '' };
      if (args[0] === 'diff') return { code: 1 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n' };
      if (args[0] === 'push') {
        pushCount++;
        return pushCount === 1
          ? { code: 1, stderr: '! [rejected] (non-fast-forward)' }
          : { code: 0 };
      }
      return {};
    });
    const result = await runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm' });
    expect(result.status).toBe('committed');
    expect(result.attempts).toBe(2);
    // Two full fetch cycles => the union re-ran against the fresh tip.
    expect(calls.filter((c) => c.args[0] === 'fetch')).toHaveLength(2);
    expect(pushCount).toBe(2);
  });

  it('revalidates the destination inside every CAS retry', async () => {
    let pushCount = 0;
    let validationCount = 0;
    const { exec } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: '' };
      if (args[0] === 'diff') return { code: 1 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n' };
      if (args[0] === 'push') {
        pushCount++;
        return pushCount === 1
          ? { code: 1, stderr: '! [rejected] (non-fast-forward)' }
          : { code: 0 };
      }
      return {};
    });

    await runQueueCommit('/repo', [asset()], controlDeps(exec), {
      message: 'm',
      validateDestination: async () => {
        validationCount++;
      },
    });

    expect(validationCount).toBe(2);
  });

  it('copies assets from an explicit disposable staging root', async () => {
    const { exec } = makeFakeExec(happyResponder);
    const copySources: string[] = [];
    await runQueueCommit(
      '/repo',
      [asset()],
      controlDeps(exec, {
        copyArtSurface: async (sourceRoot) => {
          copySources.push(sourceRoot);
        },
      }),
      {
        message: 'm',
        sourceRoot: '/staged/approvals',
      },
    );

    expect(copySources).toEqual(['/staged/approvals']);
  });

  it('throws push-retries-exhausted when the branch keeps advancing', async () => {
    const { exec } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: '' };
      if (args[0] === 'diff') return { code: 1 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n' };
      if (args[0] === 'push') return { code: 1, stderr: 'non-fast-forward' };
      return {};
    });
    await expect(
      runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm', maxAttempts: 3 }),
    ).rejects.toMatchObject({ kind: 'push-retries-exhausted' });
  });

  it('throws git-failed immediately (no retry) when a push fails for a non-fast-forward reason', async () => {
    // Auth/permission/network/hook failures are NOT a concurrent-advance CAS
    // miss: retrying just burns the budget and then mislabels the cause as
    // "a concurrent writer kept advancing". They must fail fast as git-failed.
    let pushCount = 0;
    const { exec } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: '' };
      if (args[0] === 'diff') return { code: 1 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n' };
      if (args[0] === 'push') {
        pushCount++;
        return { code: 128, stderr: 'fatal: Authentication failed for origin' };
      }
      return {};
    });
    await expect(
      runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm', maxAttempts: 5 }),
    ).rejects.toMatchObject({ kind: 'git-failed' });
    expect(pushCount).toBe(1); // fatal push not retried
  });

  it('throws git-failed (no retry) on a hook/protected-branch rejection carrying the generic trailer', async () => {
    // git prints `error: failed to push some refs` for EVERY rejected push,
    // including pre-receive-hook and protected-branch declines. That generic
    // trailer must NOT be treated as a retryable non-fast-forward: the only
    // retryable case is a genuine concurrent-advance (which always also carries
    // `(non-fast-forward)`/`(fetch first)`). Without this the loop would burn
    // all attempts and mislabel a terminal failure as a phantom concurrent writer.
    let pushCount = 0;
    const { exec } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: '' };
      if (args[0] === 'diff') return { code: 1 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n' };
      if (args[0] === 'push') {
        pushCount++;
        return {
          code: 1,
          stderr:
            ' ! [remote rejected] sha -> assets/queue (pre-receive hook declined)\n' +
            "error: failed to push some refs to 'origin'",
        };
      }
      return {};
    });
    await expect(
      runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm', maxAttempts: 5 }),
    ).rejects.toMatchObject({ kind: 'git-failed' });
    expect(pushCount).toBe(1); // hook decline is terminal, not a CAS race
  });

  it('classifies push-rejection stderr precisely (isNonFastForwardRejection)', () => {
    // Retryable: genuine concurrent-advance signals (case-insensitive).
    for (const s of [
      ' ! [rejected]        main -> main (non-fast-forward)',
      ' ! [rejected]        main -> main (fetch first)',
      'hint: Updates were rejected because the tip of your current branch is behind',
      'hint: Updates were rejected because the remote contains work that you do not have',
      'NON-FAST-FORWARD',
      // Force-with-lease failure: remote advanced past the expected SHA.
      ' ! [rejected]        sha -> assets/queue (stale info)',
      'STALE INFO',
      // Lost server-side ref-transaction race: the expected-old-OID mismatch. A
      // plain push CAN hit this on GitHub without a non-ff phrase; re-fetch +
      // re-union + re-push is the correct CAS response, so it must retry.
      " ! [remote rejected] sha -> assets/queue (cannot lock ref 'refs/heads/assets/queue': " +
        'is at abc123 but expected def456)',
    ]) {
      expect(isNonFastForwardRejection(s)).toBe(true);
    }
    // Terminal: the generic trailer alone, and other fatal causes, are NOT retryable.
    for (const s of [
      "error: failed to push some refs to 'origin'",
      ' ! [remote rejected] sha -> assets/queue (pre-receive hook declined)',
      ' ! [remote rejected] sha -> assets/queue (protected branch hook declined)',
      // Bare `cannot lock ref` WITHOUT the expected-OID mismatch is not a remote
      // advance — e.g. local contention `cannot lock ref '...': .lock: File exists`.
      'error: cannot lock ref',
      "error: cannot lock ref 'refs/heads/assets/queue': " +
        "Unable to create '.git/refs/heads/assets/queue.lock': File exists.",
      'fatal: Authentication failed',
      'fatal: unable to access: Could not resolve host',
      '',
    ]) {
      expect(isNonFastForwardRejection(s)).toBe(false);
    }
  });

  it('returns the committed result even when cleanup (removeDir) throws synchronously', async () => {
    // The production removeDir runs rmSync BEFORE it returns a promise, and
    // Windows can throw EPERM on a transiently-locked worktree dir. A finally
    // that let that throw escape would clobber a successful commit — assert it
    // is swallowed and the committed result survives.
    const { exec } = makeFakeExec(happyResponder);
    const result = await runQueueCommit(
      '/repo',
      [asset()],
      controlDeps(exec, {
        removeDir: () => {
          throw new Error('EPERM: worktree dir locked');
        },
      }),
      { message: 'm' },
    );
    expect(result).toEqual({
      status: 'committed',
      branch: 'assets/queue',
      commit: 'abc123def456',
      attempts: 1,
    });
  });

  it('cleans up the worktree and surfaces git-failed when a git step fails', async () => {
    const removed: string[] = [];
    const { exec, calls } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: '' };
      if (args[0] === 'commit') return { code: 1, stderr: 'commit boom' };
      if (args[0] === 'diff') return { code: 1 };
      return {};
    });
    await expect(
      runQueueCommit(
        '/repo',
        [asset()],
        controlDeps(exec, { removeDir: (d) => (removed.push(d), Promise.resolve()) }),
        { message: 'm' },
      ),
    ).rejects.toMatchObject({ kind: 'git-failed' });
    // finally: git worktree remove + removeDir both ran.
    expect(calls.some((c) => c.args.includes('remove'))).toBe(true);
    expect(removed).toEqual(['/tmp/qc-xyz']);
  });

  it('fails closed when a 1c-style generated queue deletion is detected before ingestion', async () => {
    let validations = 0;
    const { exec, calls } = makeFakeExec((_command, args) => {
      if (args[0] === 'ls-remote') return { stdout: 'queue-sha\trefs/heads/assets/queue\n' };
      if (args[0] === 'diff' && args.includes('--diff-filter=D')) {
        return {
          stdout: 'public/assets/generated/lost.png\npublic/assets/generated/entries/lost.json\n',
        };
      }
      if (args[0] === 'diff') return { code: 1 }; // staged incoming asset exists
      if (args[0] === 'rev-parse') return { stdout: 'abc123def456\n' };
      return {};
    });

    await expect(
      runQueueCommit('/repo', [asset()], controlDeps(exec), {
        message: 'm',
        validateDestination: async () => {
          validations++;
        },
      }),
    ).rejects.toMatchObject({ kind: 'generated-deletion-refused' });
    await expect(
      runQueueCommit('/repo', [asset()], controlDeps(exec), { message: 'm' }),
    ).rejects.toThrow('sprites:repair-queue -- --audit --policy acc25eda-selective-v1');
    expect(validations).toBe(0);
    const deletionDiff = calls.find(
      (call) =>
        call.command === 'git' && call.args[0] === 'diff' && call.args.includes('--diff-filter=D'),
    );
    expect(deletionDiff?.args).toContain('--no-renames');
  });
});

// ---------------------------------------------------------------------------
// Layer 2: real git (temp bare origin + live clone)
// ---------------------------------------------------------------------------

/**
 * These four tests shell out to real `git` against a temp bare origin, so their
 * wall time is dominated by process spawns rather than by the assertion. Vitest
 * runs test FILES in parallel workers, so under a full-project run (~120 files)
 * they contend for the machine with every other file's git/fs work: this file
 * takes ~33s in isolation and ~76s under full load, which put the no-clobber
 * test intermittently over a 30s budget. Raised to 60s — the property under test
 * is "a concurrent writer's entry survives the retry", never "the retry is fast",
 * so a generous budget costs nothing and removes a load-sensitive flake.
 */
const GIT_TIMEOUT_MS = 60_000;
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0xfe, 0xdc, 0xba, 0x98,
]);
const PNG_BYTES_B = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
]);

function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

interface Repos {
  root: string;
  originDir: string;
  liveDir: string;
}

/**
 * Production deps, but with a CI-free env so the primitive does not (correctly)
 * refuse under `process.env.CI`. These integration tests exercise the local
 * dev-box path; the CI-refusal contract itself is covered by the control-flow
 * suite above.
 */
function realGitDeps(liveDir: string): QueueCommitDeps {
  const env = { ...process.env };
  delete env.CI;
  return createDefaultQueueCommitDeps(liveDir, env);
}

function toUrl(p: string): string {
  return p.split(path.sep).join('/');
}

function shardFilePath(repo: string, key: string): string {
  return path.join(repo, 'public', 'assets', 'generated', 'entries', `${key}.json`);
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function setupRepos(): Repos {
  const root = mkdtempSync(path.join(tmpdir(), 'qc-git-'));
  const originDir = path.join(root, 'origin.git');
  const liveDir = path.join(root, 'live');
  mkdirSync(originDir);
  mkdirSync(liveDir);
  gitSync(originDir, 'init', '--bare', '-b', 'main');
  gitSync(liveDir, 'init', '-b', 'main');
  gitSync(liveDir, 'config', 'user.email', 'test@example.com');
  gitSync(liveDir, 'config', 'user.name', 'Queue Commit Test');
  gitSync(liveDir, 'config', 'commit.gpgsign', 'false');
  gitSync(liveDir, 'remote', 'add', 'origin', toUrl(originDir));
  // Seed an asset-free base on main so the queue branch's diff is asset-only.
  // The aggregate manifest + catalog are derived/gitignored now, so the base
  // just carries an empty shards dir (kept via .gitkeep).
  const keepPath = path.join(liveDir, 'public', 'assets', 'generated', 'entries', '.gitkeep');
  mkdirSync(path.dirname(keepPath), { recursive: true });
  writeFileSync(keepPath, '');
  gitSync(liveDir, 'add', '-A');
  gitSync(liveDir, 'commit', '-m', 'base');
  gitSync(liveDir, 'push', 'origin', 'main');
  return { root, originDir, liveDir };
}

/** Write an asset's PNG + manifest shard into the live working tree (uncommitted). */
function stageAssetOnDisk(liveDir: string, key: string, png: Buffer): void {
  const genDir = path.join(liveDir, 'public', 'assets', 'generated');
  mkdirSync(genDir, { recursive: true });
  writeFileSync(path.join(genDir, `${key}.png`), png);
  writeJson(shardFilePath(liveDir, key), { assetPath: `generated/${key}.png`, spriteName: key });
}

/**
 * Compose the manifest from the per-asset shards committed on origin's
 * assets/queue branch (the aggregate manifest.json is no longer committed).
 */
function queueManifest(liveDir: string): { entries: Record<string, unknown> } {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/queue');
  const listing = gitSync(
    liveDir,
    'ls-tree',
    '-r',
    '--name-only',
    'FETCH_HEAD',
    'public/assets/generated/entries',
  );
  const entries: Record<string, unknown> = {};
  for (const relPath of listing.split('\n').map((l) => l.trim())) {
    if (!relPath.endsWith('.json')) continue;
    const key = relPath.slice('public/assets/generated/entries/'.length, -'.json'.length);
    const raw = gitSync(liveDir, 'show', `FETCH_HEAD:${relPath}`);
    entries[key] = JSON.parse(raw);
  }
  return { entries };
}

function queueAnnotations(liveDir: string): {
  version: number;
  sprites: Record<string, { favorite: boolean; disliked: boolean; comment: string }>;
} {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/queue');
  return JSON.parse(
    gitSync(liveDir, 'show', 'FETCH_HEAD:public/assets/generated/sprite-editor-annotations.json'),
  );
}

function advanceQueueAnnotationOutOfBand(
  liveDir: string,
  key: string,
  annotation: { favorite: boolean; disliked: boolean; comment: string },
): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/queue');
  const wt = mkdtempSync(path.join(tmpdir(), 'qc-oob-annotation-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'FETCH_HEAD');
    writeJson(path.join(wt, 'public', 'assets', 'generated', 'sprite-editor-annotations.json'), {
      version: 1,
      sprites: { [key]: annotation },
    });
    gitSync(wt, 'add', '--', 'public/assets/generated/sprite-editor-annotations.json');
    gitSync(wt, 'commit', '--no-verify', '-m', `oob annotation ${key}`);
    const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
    gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/assets/queue`);
  } finally {
    gitSync(liveDir, 'worktree', 'remove', '--force', wt);
    rmSync(wt, { recursive: true, force: true });
  }
}

/** Out-of-band writer: add `key` to assets/queue and push it, simulating a concurrent writer. */
function advanceQueueOutOfBand(liveDir: string, key: string, png: Buffer): void {
  gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/queue');
  const wt = mkdtempSync(path.join(tmpdir(), 'qc-oob-'));
  try {
    gitSync(liveDir, 'worktree', 'add', wt, '--detach', 'FETCH_HEAD');
    const genDir = path.join(wt, 'public', 'assets', 'generated');
    mkdirSync(genDir, { recursive: true });
    writeFileSync(path.join(genDir, `${key}.png`), png);
    writeJson(shardFilePath(wt, key), { assetPath: `generated/${key}.png`, spriteName: key });
    gitSync(wt, 'add', '--', 'public/assets/generated');
    gitSync(wt, 'commit', '--no-verify', '-m', `oob ${key}`);
    const sha = gitSync(wt, 'rev-parse', 'HEAD').trim();
    gitSync(liveDir, 'push', 'origin', `${sha}:refs/heads/assets/queue`);
  } finally {
    gitSync(liveDir, 'worktree', 'remove', '--force', wt);
    rmSync(wt, { recursive: true, force: true });
  }
}

describe('runQueueCommit (real git)', () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          // Windows can briefly hold a just-removed worktree dir; retry.
        }
      }
    }
  });

  it(
    'creates a durable annotation-only queue commit with favorite/disliked/comment data',
    async () => {
      const { root, liveDir } = setupRepos();
      cleanups.push(root);
      const annotationPath = path.join(
        liveDir,
        'public',
        'assets',
        'generated',
        'sprite-editor-annotations.json',
      );
      writeJson(annotationPath, { version: 1, sprites: {} });
      gitSync(liveDir, 'add', '--', annotationPath);
      gitSync(liveDir, 'commit', '-m', 'track annotations');
      gitSync(liveDir, 'push', 'origin', 'main');

      const result = await runQueueCommit(liveDir, [], realGitDeps(liveDir), {
        message: 'chore(assets): annotate alpha',
        annotations: [
          {
            key: 'alpha',
            favorite: false,
            disliked: true,
            comment: 'Regenerate the silhouette.',
          },
        ],
      });

      expect(result.status).toBe('committed');
      expect(queueAnnotations(liveDir).sprites.alpha).toEqual({
        favorite: false,
        disliked: true,
        comment: 'Regenerate the silhouette.',
      });
      expect(gitSync(liveDir, 'status', '--porcelain')).toBe('');
    },
    GIT_TIMEOUT_MS,
  );

  it(
    'retries against the fresh queue tip so concurrent non-overlapping annotations survive',
    async () => {
      const { root, liveDir } = setupRepos();
      cleanups.push(root);
      writeJson(
        path.join(liveDir, 'public', 'assets', 'generated', 'sprite-editor-annotations.json'),
        { version: 1, sprites: {} },
      );
      gitSync(liveDir, 'add', '-A');
      gitSync(liveDir, 'commit', '-m', 'track annotations');
      gitSync(liveDir, 'push', 'origin', 'main');
      gitSync(liveDir, 'push', 'origin', 'main:refs/heads/assets/queue');

      const deps = realGitDeps(liveDir);
      let raced = false;
      const exec: Exec = async (command, args, options) => {
        if (command === 'git' && args[0] === 'push' && !raced) {
          raced = true;
          advanceQueueAnnotationOutOfBand(liveDir, 'alpha', {
            favorite: true,
            disliked: false,
            comment: 'Exemplar.',
          });
        }
        return deps.exec(command, args, options);
      };

      const result = await runQueueCommit(
        liveDir,
        [],
        { ...deps, exec },
        {
          message: 'chore(assets): annotate beta',
          annotations: [
            {
              key: 'beta',
              favorite: false,
              disliked: true,
              comment: 'Needs another pass.',
            },
          ],
        },
      );

      expect(result.status).toBe('committed');
      expect(result.attempts).toBe(2);
      expect(queueAnnotations(liveDir).sprites).toEqual({
        alpha: { favorite: true, disliked: false, comment: 'Exemplar.' },
        beta: { favorite: false, disliked: true, comment: 'Needs another pass.' },
      });
    },
    GIT_TIMEOUT_MS,
  );

  it(
    'creates the queue branch from main with only the asset delta and never touches the caller',
    async () => {
      const { root, liveDir } = setupRepos();
      cleanups.push(root);
      stageAssetOnDisk(liveDir, 'alpha', PNG_BYTES);

      // Pre-existing staged + unstaged changes in the caller must survive intact.
      writeFileSync(path.join(liveDir, 'unstaged-tracked.txt'), 'v1');
      gitSync(liveDir, 'add', 'unstaged-tracked.txt');
      gitSync(liveDir, 'commit', '-m', 'add tracked');
      writeFileSync(path.join(liveDir, 'unstaged-tracked.txt'), 'DIRTY'); // unstaged edit
      writeFileSync(path.join(liveDir, 'staged-new.txt'), 'staged');
      gitSync(liveDir, 'add', 'staged-new.txt'); // staged addition

      const headBefore = gitSync(liveDir, 'rev-parse', 'HEAD').trim();
      const branchBefore = gitSync(liveDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      const statusBefore = gitSync(liveDir, 'status', '--porcelain');

      const result = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        realGitDeps(liveDir),
        { message: 'chore(assets): edit alpha' },
      );

      expect(result.status).toBe('committed');
      expect(result.branch).toBe('assets/queue');
      // Queue branch carries the asset entry...
      const m = queueManifest(liveDir);
      expect(m.entries.alpha).toBeDefined();
      // ...and the PNG blob round-trips byte-identical.
      const blob = execFileSync('git', ['show', 'FETCH_HEAD:public/assets/generated/alpha.png'], {
        cwd: liveDir,
        maxBuffer: 1 << 20,
      });
      expect(Buffer.compare(blob, PNG_BYTES)).toBe(0);
      // ...but NOT the caller's uncommitted files.
      expect(() => gitSync(liveDir, 'cat-file', '-e', 'FETCH_HEAD:staged-new.txt')).toThrow();

      // Caller repo is byte-for-byte unchanged: HEAD, branch, and index/worktree.
      expect(gitSync(liveDir, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
      expect(gitSync(liveDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branchBefore);
      expect(gitSync(liveDir, 'status', '--porcelain')).toBe(statusBefore);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    'commits when art is unchanged but a queued brief changes',
    async () => {
      const { root, liveDir } = setupRepos();
      cleanups.push(root);

      const briefPath = 'briefs/enemies/alpha.yaml';
      stageAssetOnDisk(liveDir, 'alpha', PNG_BYTES);
      stageBriefOnDisk(liveDir, briefPath, 'id: alpha\nversion: 1\n');
      const deps = realGitDeps(liveDir);
      const opts = {
        message: 'chore(assets): edit alpha brief',
        briefs: [briefPath],
      };

      const first = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        deps,
        opts,
      );
      expect(first.status).toBe('committed');

      // Art bytes remain identical; only the brief changes.
      stageAssetOnDisk(liveDir, 'alpha', PNG_BYTES);
      stageBriefOnDisk(liveDir, briefPath, 'id: alpha\nversion: 2\n');
      const second = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        deps,
        opts,
      );
      expect(second.status).toBe('committed');

      gitSync(liveDir, 'fetch', '--no-tags', 'origin', 'assets/queue');
      const brief = gitSync(liveDir, 'show', `FETCH_HEAD:${briefPath}`);
      expect(brief).toContain('version: 2');
    },
    GIT_TIMEOUT_MS,
  );

  it(
    'is a no-op when the identical asset is already queued',
    async () => {
      const { root, liveDir } = setupRepos();
      cleanups.push(root);
      stageAssetOnDisk(liveDir, 'alpha', PNG_BYTES);
      const deps = realGitDeps(liveDir);
      const opts = {
        message: 'chore(assets): edit alpha',
      };
      const first = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        deps,
        opts,
      );
      expect(first.status).toBe('committed');
      const second = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        deps,
        opts,
      );
      expect(second.status).toBe('noop');
    },
    GIT_TIMEOUT_MS,
  );

  it(
    'durably lands a Tag/metadata edit (shard catalog override) on assets/queue',
    async () => {
      // Replaces the retired `catalogEntryIds`-opt-in durability test. Under the
      // shard design a Tag edit is a `catalog` override written ONTO the existing
      // per-asset shard (exactly what the sidecar /api/workflow/metadata route
      // does via writeShard), so it stages naturally under public/assets/generated
      // and must reach assets/queue with NO separate catalog write path. This
      // proves the durability GUARANTEE (the edit lands on the queue), only the
      // mechanism changed from the sibling's catalog-only flow.
      const { root, liveDir } = setupRepos();
      cleanups.push(root);

      // 1) Seed the queue with the base asset (PNG + minimal shard).
      stageAssetOnDisk(liveDir, 'alpha', PNG_BYTES);
      const deps = realGitDeps(liveDir);
      const first = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        deps,
        { message: 'chore(assets): add alpha' },
      );
      expect(first.status).toBe('committed');

      // 2) The Tag edit: rewrite alpha's shard with a `catalog` override (same
      //    PNG). This is a metadata-only change to a file already under the art
      //    surface — no sprite-catalog.json touched, no opt-in list.
      writeJson(shardFilePath(liveDir, 'alpha'), {
        assetPath: 'generated/alpha.png',
        spriteName: 'alpha',
        catalog: { description: 'Hand-tuned alpha blade.', tags: ['weapon', 'generated'] },
      });

      // 3) Re-queue: a metadata-only shard change IS a change, so it commits.
      const edit = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        deps,
        { message: 'chore(assets): metadata for alpha' },
      );
      expect(edit.status).toBe('committed');

      // 4) The override is DURABLE: it is present on the assets/queue branch, not
      //    just the local working tree.
      const queued = queueManifest(liveDir);
      const alpha = queued.entries.alpha as { catalog?: { description?: string; tags?: string[] } };
      expect(alpha.catalog?.description).toBe('Hand-tuned alpha blade.');
      expect(alpha.catalog?.tags).toEqual(['weapon', 'generated']);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "preserves a concurrent writer's entry across a forced push-rejection retry (no clobber)",
    async () => {
      const { root, liveDir } = setupRepos();
      cleanups.push(root);

      // Seed the queue with alpha.
      stageAssetOnDisk(liveDir, 'alpha', PNG_BYTES);
      await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        realGitDeps(liveDir),
        { message: 'edit alpha' },
      );

      // Now commit beta, but wrap exec so the FIRST push is preceded by an
      // out-of-band writer advancing the queue with gamma. beta's push is then
      // a non-fast-forward -> rejected -> retry re-fetches (alpha+gamma) and
      // unions beta on top. If the retry clobbered, gamma would vanish.
      stageAssetOnDisk(liveDir, 'beta', PNG_BYTES_B);
      const base = realGitDeps(liveDir);
      let advanced = false;
      const wrappedExec: Exec = async (command, args, options) => {
        if (command === 'git' && args[0] === 'push' && !advanced) {
          advanced = true;
          advanceQueueOutOfBand(liveDir, 'gamma', PNG_BYTES);
        }
        return base.exec(command, args, options);
      };

      const result = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/beta.png',
            manifestKey: 'beta',
            briefId: null,
            variantIndex: null,
          },
        ],
        { ...base, exec: wrappedExec },
        { message: 'edit beta' },
      );

      expect(result.status).toBe('committed');
      expect(result.attempts).toBe(2); // rejected once, succeeded on retry
      const m = queueManifest(liveDir);
      // All three entries coexist — the retry unioned, it did not clobber.
      expect(Object.keys(m.entries).sort()).toEqual(['alpha', 'beta', 'gamma']);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    'same-key concurrent edits are last-writer-wins (accepted whole-asset projection tradeoff)',
    async () => {
      // Documents (and pins) the accepted copyArtSurface semantics: for the SAME
      // manifest key this is a whole-asset overlay, NOT a field-level merge. A
      // writer working from stale local content can supersede a NEWER queued
      // entry for that key via a valid fast-forward push. This is intended per
      // the "manifest = sole authority, whole-asset" design (ADR 0066 + the PR1
      // queue-commit ADR): it never corrupts the branch and never clobbers OTHER
      // keys (proven by the no-clobber test above), but a newer same-key edit
      // CAN be superseded by an older one. Pinned here so the tradeoff is
      // explicit rather than silent.
      const { root, liveDir } = setupRepos();
      cleanups.push(root);

      // Writer A lands the "newer" alpha=PNG_BYTES_B on the queue.
      stageAssetOnDisk(liveDir, 'alpha', PNG_BYTES_B);
      const first = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        realGitDeps(liveDir),
        { message: 'edit alpha (newer)' },
      );
      expect(first.status).toBe('committed');

      // Writer B overwrites the SAME key from stale content (alpha=PNG_BYTES),
      // with a distinguishing shard field so we can prove whose entry wins.
      stageAssetOnDisk(liveDir, 'alpha', PNG_BYTES);
      const localShard = readJson<Record<string, unknown>>(shardFilePath(liveDir, 'alpha'));
      localShard.editor = 'writer-B';
      writeJson(shardFilePath(liveDir, 'alpha'), localShard);

      const result = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/alpha.png',
            manifestKey: 'alpha',
            briefId: null,
            variantIndex: null,
          },
        ],
        realGitDeps(liveDir),
        { message: 'edit alpha (stale)' },
      );

      expect(result.status).toBe('committed');
      expect(result.attempts).toBe(1); // plain fast-forward, no rejection/retry

      // Last writer wins: the queue now carries writer B's (older) PNG bytes and
      // manifest entry, having wholesale-superseded writer A's newer version.
      const m = queueManifest(liveDir);
      expect((m.entries.alpha as { editor?: string }).editor).toBe('writer-B');
      const blob = execFileSync('git', ['show', 'FETCH_HEAD:public/assets/generated/alpha.png'], {
        cwd: liveDir,
        maxBuffer: 1 << 20,
      });
      expect(Buffer.compare(blob, PNG_BYTES)).toBe(0);
      expect(Buffer.compare(blob, PNG_BYTES_B)).not.toBe(0);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    'migrates an orphan assets/queue and preserves both writers on a stale-lease retry',
    async () => {
      // Regression for the orphan-reset path (Bug #3 fix).
      //
      // Scenario:
      //   1. Seed main as normal.
      //   2. Create an orphan assets/queue that has NO common ancestor with main
      //      (simulates the real live state: the branch was seeded with --orphan).
      //      Put one existing asset (delta) on the orphan so we verify it survives.
      //   3. Stage a NEW asset (beta) in the live working tree.
      //   4. Intercept the push so that BEFORE the first push attempt, an
      //      out-of-band writer advances assets/queue with gamma. The orphan-tip
      //      SHA the callee fetched is now stale → `--force-with-lease` fails with
      //      `(stale info)` → retry re-fetches the new tip and unions beta on top.
      //   5. Assert:
      //      - result.status === 'committed', result.attempts === 2
      //      - All three entries (delta from orphan, beta from this writer, gamma
      //        from the concurrent writer) coexist on assets/queue — no clobber.
      //      - PNG bytes for beta round-trip correctly.
      //      - Caller's HEAD/branch/index are untouched.

      const { root, liveDir } = setupRepos();
      cleanups.push(root);

      // ── Step 2: craft an orphan assets/queue on the bare origin ──────────────
      //
      // Use a scratch clone to build the orphan commit, then push it to origin.
      const scratchDir = mkdtempSync(path.join(tmpdir(), 'qc-orphan-'));
      cleanups.push(scratchDir);

      const originUrl = gitSync(liveDir, 'remote', 'get-url', 'origin').trim();
      gitSync(scratchDir, 'init', '-b', 'orphan-work');
      gitSync(scratchDir, 'config', 'user.email', 'test@example.com');
      gitSync(scratchDir, 'config', 'user.name', 'Orphan Seeder');
      gitSync(scratchDir, 'config', 'commit.gpgsign', 'false');
      gitSync(scratchDir, 'remote', 'add', 'origin', originUrl);

      // Seed the orphan with an existing asset+brief so we confirm both survive.
      const genDir = path.join(scratchDir, 'public', 'assets', 'generated');
      mkdirSync(genDir, { recursive: true });
      writeFileSync(path.join(genDir, 'delta.png'), PNG_BYTES);
      writeJson(path.join(scratchDir, 'public', 'assets', 'generated', 'entries', 'delta.json'), {
        assetPath: 'generated/delta.png',
        spriteName: 'delta',
      });
      stageBriefOnDisk(scratchDir, 'briefs/enemies/delta.yaml', 'id: delta\n');
      gitSync(scratchDir, 'add', '-A');
      gitSync(scratchDir, 'commit', '-m', 'orphan seed delta');
      // Force-push as assets/queue so origin has an orphan branch.
      gitSync(scratchDir, 'push', '--force', 'origin', 'HEAD:refs/heads/assets/queue');

      // ── Step 3: stage beta in the LIVE clone ─────────────────────────────────
      stageAssetOnDisk(liveDir, 'beta', PNG_BYTES_B);

      // ── Step 4: intercept push, inject out-of-band advance BEFORE first push ─
      const base = realGitDeps(liveDir);
      let advanced = false;
      const wrappedExec: Exec = async (command, args, options) => {
        if (command === 'git' && args[0] === 'push' && !advanced) {
          advanced = true;
          // Advance assets/queue out-of-band with gamma BEFORE the first push
          // attempt.  The callee's force-with-lease is scoped to the orphan SHA
          // it fetched; gamma's push moves the tip beyond that SHA → the lease
          // returns `(stale info)` → should retry and union beta on top of gamma.
          advanceQueueOutOfBand(liveDir, 'gamma', PNG_BYTES);
        }
        return base.exec(command, args, options);
      };

      const headBefore = gitSync(liveDir, 'rev-parse', 'HEAD').trim();
      const branchBefore = gitSync(liveDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      const statusBefore = gitSync(liveDir, 'status', '--porcelain');

      // ── Step 5: run and assert ────────────────────────────────────────────────
      const result = await runQueueCommit(
        liveDir,
        [
          {
            assetPath: 'generated/beta.png',
            manifestKey: 'beta',
            briefId: null,
            variantIndex: null,
          },
        ],
        { ...base, exec: wrappedExec },
        { message: 'orphan-migration beta' },
      );

      expect(result.status).toBe('committed');
      expect(result.attempts).toBe(2); // first push stale → retry succeeds

      const m = queueManifest(liveDir);
      // All three entries must coexist — orphan art (delta), this write (beta),
      // concurrent writer (gamma) — the retry unioned, it did not clobber.
      expect(Object.keys(m.entries).sort()).toEqual(['beta', 'delta', 'gamma']);
      const brief = gitSync(liveDir, 'show', 'FETCH_HEAD:briefs/enemies/delta.yaml');
      expect(brief).toContain('id: delta');

      // beta's PNG round-trips correctly through the migration.
      const blob = execFileSync('git', ['show', 'FETCH_HEAD:public/assets/generated/beta.png'], {
        cwd: liveDir,
        maxBuffer: 1 << 20,
      });
      expect(Buffer.compare(blob, PNG_BYTES_B)).toBe(0);

      // Caller repo is untouched.
      expect(gitSync(liveDir, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
      expect(gitSync(liveDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branchBefore);
      expect(gitSync(liveDir, 'status', '--porcelain')).toBe(statusBefore);
    },
    GIT_TIMEOUT_MS,
  );
});

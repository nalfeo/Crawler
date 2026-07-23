/**
 * Queue-commit: durably persist an approved/edited asset onto a single
 * long-lived remote `assets/queue` branch WITHOUT touching the caller's working
 * branch, index, or HEAD.
 *
 * Why this exists: sprite edits (anchors/metadata via the canvas editor) and new
 * approvals mutate the *committed* manifest/catalog/PNG surface, but nothing
 * auto-commits them. An edit made in a worktree/session is lost unless manually
 * committed. This primitive makes every approved-asset mutation instantly
 * durable on the remote — regardless of which branch/worktree/process made it —
 * so it survives across sessions. A later PR adds the hourly cron that
 * integrates `assets/queue` into `main`.
 *
 * Design (mirrors `runAssetCheckin`, minus the gh-issue step, targeting a
 * PERSISTENT branch with a compare-and-swap push):
 *   - PURE core here (`runQueueCommit`) drives everything through injected
 *     `deps` (an exec runner + the same `copyArtSurface`/temp-dir/lock hooks the
 *     check-in flow uses), so it is unit-testable against a real temp git repo
 *     without any network.
 *   - The mutation is applied in a THROWAWAY detached worktree cut from the
 *     freshly-fetched queue tip; `copyArtSurface` UNIONS the changed asset's
 *     live manifest/catalog entries onto that tip via `mergeManifests`/
 *     `mergeCatalogs`. Because the union re-runs against the latest tip on every
 *     retry, a concurrent writer's entry is preserved — no whole-file clobber.
 *   - The push is a plain fast-forward-only push of the new commit to
 *     `refs/heads/assets/queue`: our commit's parent IS the fetched tip, so a
 *     concurrent advance makes the push a non-fast-forward → git rejects it →
 *     we re-fetch and retry. This is a strictly-safer compare-and-swap than
 *     `--force-with-lease` (it can never overwrite a concurrent update).
 *
 * Constitutional §3 (local-only mutation): like check-in/approve, this pushes to
 * a remote from locally-approved assets, so it REFUSES when `process.env.CI` is
 * set. PR1 stays local-only; there is no auto-merge/CI-bypass yet.
 */

import { ASSET_SURFACE_PATHS, type CheckinAsset, type Exec } from './checkin.js';

/** How the queue-commit resolved. */
export type QueueCommitStatus = 'committed' | 'noop';

export class QueueCommitError extends Error {
  constructor(
    readonly kind:
      | 'ci-refused'
      | 'invalid-asset-path'
      | 'git-failed'
      | 'push-retries-exhausted',
    message: string,
  ) {
    super(message);
    this.name = 'QueueCommitError';
  }
}

export interface QueueCommitResult {
  readonly status: QueueCommitStatus;
  /** The queue branch the commit landed on (or would have). */
  readonly branch: string;
  /** New commit SHA when `status === 'committed'`; absent for a no-op. */
  readonly commit?: string;
  /** Number of push attempts made (1 on the happy path). */
  readonly attempts: number;
}

export interface QueueCommitDeps {
  /** Runs an external command (git). */
  readonly exec: Exec;
  /**
   * Project ONLY `assets`' PNGs plus their manifest/catalog entries from the
   * live `srcRepoRoot` onto the worktree `destRepoRoot`, UNIONing manifest and
   * catalog entries onto the worktree's (queue-tip) copy. Shared with the
   * check-in flow so the merge semantics are identical.
   */
  readonly copyArtSurface: (
    srcRepoRoot: string,
    destRepoRoot: string,
    assets: readonly CheckinAsset[],
  ) => Promise<void>;
  /** Create + return an empty temp directory for the throwaway worktree. */
  readonly makeTempDir: () => Promise<string>;
  /** Remove a directory tree (best-effort cleanup). */
  readonly removeDir: (dir: string) => Promise<void>;
  /**
   * Acquire (and release) a cross-process lock spanning the whole
   * fetch→merge→push. Reusing the check-in file lock (keyed by repo root)
   * serializes the sidecar approve route, the approve CLI, and the canvas
   * editor's CLI subprocess so same-repo writers never race. Defaults to a
   * no-op passthrough (tests that do not exercise concurrency can omit it).
   */
  readonly withCrossProcessLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Sleep between push retries (injectable so tests don't wait). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Env consulted for the CI refusal. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface QueueCommitOptions {
  /** Commit message. Required — callers supply a stable, clock-free message. */
  readonly message: string;
  /** Remote name. Defaults to `origin`. */
  readonly remote?: string;
  /** The persistent queue branch. Defaults to `assets/queue`. */
  readonly queueBranch?: string;
  /** Branch the queue is seeded from when it does not exist yet. Defaults to `main`. */
  readonly baseBranch?: string;
  /** Max push attempts under concurrent advance. Defaults to 5. */
  readonly maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Validate that each asset path is a safe repo-relative POSIX path under the art
 * surface (no absolute paths, no `..` traversal). Combined with the fixed
 * `git add -- <ASSET_SURFACE_PATHS>` allowlist, this guarantees a queue commit
 * can only ever touch generated art + the catalog.
 */
export function assertSafeAssetPaths(assets: readonly CheckinAsset[]): void {
  for (const asset of assets) {
    const p = asset.assetPath;
    if (typeof p !== 'string' || p.trim() === '') {
      throw new QueueCommitError('invalid-asset-path', `Empty asset path`);
    }
    if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.includes('\\')) {
      throw new QueueCommitError(
        'invalid-asset-path',
        `Asset path must be a repo-relative POSIX path, got: ${p}`,
      );
    }
    const segments = p.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new QueueCommitError('invalid-asset-path', `Unsafe asset path: ${p}`);
    }
  }
}

async function runGit(
  exec: Exec,
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return exec('git', args, { cwd });
}

/** Throwing git: raises `QueueCommitError('git-failed')` on a non-zero exit. */
async function mustGit(exec: Exec, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(exec, cwd, args);
  if (result.code !== 0) {
    throw new QueueCommitError(
      'git-failed',
      `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/**
 * Commit `assets`' current live state onto the remote `assets/queue` branch.
 * Never mutates the caller's working branch/index/HEAD.
 */
export async function runQueueCommit(
  repoRoot: string,
  assets: readonly CheckinAsset[],
  deps: QueueCommitDeps,
  options: QueueCommitOptions,
): Promise<QueueCommitResult> {
  const env = deps.env ?? process.env;
  if (env.CI !== undefined) {
    throw new QueueCommitError(
      'ci-refused',
      'Per Constitutional §3, queue-commit is local-only: it pushes locally-approved ' +
        'assets to the remote assets/queue branch. Run it on a dev box.',
    );
  }

  assertSafeAssetPaths(assets);

  const remote = options.remote ?? 'origin';
  const queueBranch = options.queueBranch ?? 'assets/queue';
  const baseBranch = options.baseBranch ?? 'main';
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const withLock = deps.withCrossProcessLock ?? ((fn) => fn());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (assets.length === 0) {
    return { status: 'noop', branch: queueBranch, attempts: 0 };
  }

  return withLock(async () => {
    let lastRejection = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Does the queue branch exist on the remote? `ls-remote` cleanly
      // distinguishes "branch absent" (empty stdout) from a real network/auth
      // error (non-zero exit). When absent we seed the queue from the base
      // branch so the eventual PR diff is asset-only (all of main's other files
      // are already present on the branch).
      const lsr = await runGit(deps.exec, repoRoot, ['ls-remote', '--heads', remote, queueBranch]);
      if (lsr.code !== 0) {
        throw new QueueCommitError(
          'git-failed',
          `git ls-remote --heads ${remote} ${queueBranch} failed (exit ${lsr.code}): ${
            lsr.stderr || lsr.stdout
          }`,
        );
      }
      const branchExists = lsr.stdout.trim() !== '';
      const fetchRef = branchExists ? queueBranch : baseBranch;
      await mustGit(deps.exec, repoRoot, ['fetch', '--no-tags', remote, fetchRef]);

      const worktree = await deps.makeTempDir();
      try {
        // Detached checkout of the freshly-fetched tip: we push by refspec and
        // never check the queue branch out by name, so there is no
        // "branch already checked out" clash with the caller's worktree.
        await mustGit(deps.exec, repoRoot, ['worktree', 'add', worktree, '--detach', 'FETCH_HEAD']);
        // UNION the live asset entries onto the tip's manifest/catalog + copy PNGs.
        await deps.copyArtSurface(repoRoot, worktree, assets);
        // Fixed allowlist: only generated art + the catalog can ever be staged.
        await mustGit(deps.exec, worktree, ['add', '--', ...ASSET_SURFACE_PATHS]);

        // No-op guard: if nothing staged, the queue already carries identical
        // bytes — skip the commit+push so repeated identical saves don't churn.
        const staged = await runGit(deps.exec, worktree, ['diff', '--cached', '--quiet']);
        if (staged.code === 0) {
          return { status: 'noop', branch: queueBranch, attempts: attempt };
        }

        await mustGit(deps.exec, worktree, ['commit', '--no-verify', '-m', options.message]);
        const newCommit = (await mustGit(deps.exec, worktree, ['rev-parse', 'HEAD'])).trim();

        // Plain (non-force) push: our commit's parent is the fetched tip, so a
        // concurrent advance makes this a non-fast-forward → git rejects it and
        // we retry. This is the compare-and-swap: it can NEVER overwrite a
        // concurrent update (unlike --force-with-lease).
        const push = await runGit(deps.exec, repoRoot, [
          'push',
          '--no-verify',
          remote,
          `${newCommit}:refs/heads/${queueBranch}`,
        ]);
        if (push.code === 0) {
          return { status: 'committed', branch: queueBranch, commit: newCommit, attempts: attempt };
        }
        // Rejected (likely non-fast-forward from a concurrent advance, or a
        // creation race). Re-fetch and retry; the union re-applies onto the new tip.
        lastRejection = push.stderr || push.stdout;
      } finally {
        await runGit(deps.exec, repoRoot, ['worktree', 'remove', worktree, '--force']).catch(
          () => undefined,
        );
        await deps.removeDir(worktree).catch(() => undefined);
      }

      if (attempt < maxAttempts) {
        await sleep(50 * attempt);
      }
    }
    throw new QueueCommitError(
      'push-retries-exhausted',
      `Failed to push to ${remote} ${queueBranch} after ${maxAttempts} attempts ` +
        `(last rejection: ${lastRejection || 'unknown'}). A concurrent writer kept advancing the branch.`,
    );
  });
}

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
      | 'destination-conflict'
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
  /**
   * Overlay ONLY the named catalog ids from the source tree onto the worktree.
   * Required by catalog-only flows (see
   * {@link QueueCommitOptions.catalogEntryIds}); defaults to a no-op for callers
   * that never set `catalogEntryIds`.
   */
  readonly overlayCatalogEntries?: (
    srcRepoRoot: string,
    destRepoRoot: string,
    ids: readonly string[],
  ) => Promise<boolean>;
  /** Create + return an empty temp directory for the throwaway worktree. */
  readonly makeTempDir: () => Promise<string>;
  /** Remove a directory tree (best-effort cleanup). */
  readonly removeDir: (dir: string) => Promise<void>;
  /**
   * Acquire (and release) a cross-process lock spanning this primitive's git
   * work (fetch→merge→commit→push on the queue branch). Reusing the check-in
   * file lock (keyed by repo root) serializes those git operations across the
   * sidecar approve route, the approve CLI, and the canvas editor's CLI
   * subprocess, so the queue-branch history stays linear and two processes never
   * race on the push. NOTE: it does NOT cover callers' upstream local-disk writes
   * — the manifest/catalog/PNG writes that happen BEFORE `runQueueCommit` is
   * invoked. A concurrent same-repo writer's non-atomic local manifest
   * read-modify-write is a pre-existing hazard tracked separately (the per-asset
   * UNION in `copyArtSurface` bounds the blast radius to a sub-second clobber of
   * a commit's own entry, and the PNG survives on disk), not something this lock
   * closes. Defaults to a no-op passthrough (tests that do not exercise
   * concurrency can omit it).
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
  /**
   * Art source root. Defaults to `repoRoot`; the CI publisher points this at a
   * disposable, fully validated staging tree while git still runs in repoRoot.
   */
  readonly sourceRoot?: string;
  /**
   * Narrow CI capability for the trusted asset-request publisher, or the
   * equally narrow theme-equipment-set publisher (ADR 0073). Ordinary
   * CLI/sidecar callers omit this and remain hard-refused under CI. Each
   * caller is authorized by its own env flag + workflow-ref check (see
   * `isAuthorizedAssetPublisher`) — this union intentionally does NOT open a
   * generic "any CI caller" path.
   */
  readonly ciAuthorization?: {
    readonly caller: 'asset-request-publisher' | 'theme-equipment-publisher';
  };
  /**
   * Optional same-key conflict guard. Runs inside every CAS attempt against the
   * freshly fetched and main-aligned destination before any asset is copied.
   */
  readonly validateDestination?: (
    sourceRoot: string,
    destinationRoot: string,
    assets: readonly CheckinAsset[],
  ) => Promise<void>;
  /**
   * Catalog ids whose rows must also be carried into the queue commit.
   *
   * Art check-ins leave this unset: a generated catalog row merely restates its
   * manifest entry, so staging both made every pair of parallel art check-ins
   * conflict by construction.
   *
   * Catalog-ONLY flows (the sidecar Tag/metadata route) MUST set it. Their edits
   * exist nowhere but `sprite-catalog.json`, so without it `git add` stages
   * nothing, the no-op guard fires, and the edit is silently dropped across
   * worktrees/sessions.
   */
  readonly catalogEntryIds?: readonly string[];
}

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Repo-relative catalog path staged by catalog-only flows. POSIX separators:
 * this is a git pathspec, not a filesystem path.
 */
const CATALOG_STAGE_PATH = 'src/shared/data/sprite-catalog.json';

/**
 * Validate that each asset path is a safe repo-relative POSIX path under the art
 * surface (no absolute paths, no `..` traversal) AND under the `generated/`
 * subtree that `git add -- <ASSET_SURFACE_PATHS>` actually stages. Without the
 * `generated/` check a path like `icons/foo.png` would be copied by
 * `copyArtSurface` yet never staged, producing a silent no-op queue commit.
 * Combined with the fixed allowlist, this guarantees a queue commit can only ever
 * touch generated art + the catalog.
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
    if (!p.startsWith('generated/')) {
      throw new QueueCommitError(
        'invalid-asset-path',
        `Asset path must be under the staged art surface (generated/), got: ${p}. ` +
          `Paths outside generated/ are copied but never staged, silently no-op'ing the commit.`,
      );
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
 * A rejected push is only safe to RETRY when it is a genuine non-fast-forward —
 * i.e. a concurrent writer advanced the queue branch, so re-fetch + re-union +
 * re-push is the correct compare-and-swap response. Every OTHER push failure
 * (auth/permission, network, pre-receive hook, protected-branch, disk) is
 * terminal: retrying it just wastes attempts and then mislabels the real cause
 * as "a concurrent writer kept advancing the branch".
 *
 * We deliberately match ONLY phrases that are specific to a non-ff rejection.
 * The generic summary line `failed to push some refs` is NOT a sufficient
 * signal: git emits `error: failed to push some refs` for EVERY rejected push —
 * including protected-branch and pre-receive-hook declines — so keying on it
 * would misclassify a terminal failure as a retryable CAS race (burning all
 * attempts, then blaming a phantom concurrent writer). The parenthetical
 * `(non-fast-forward)`/`(fetch first)` reasons and the two hint lines are only
 * produced for an actual non-ff rejection.
 *
 * We DO match the expected-old-OID mismatch (`cannot lock ref '…': is at <a> but
 * expected <b>`). Even a plain (non-lease) push can lose a server-side ref
 * TRANSACTION race on GitHub: two pushes land concurrently, the loser is
 * `[remote rejected] … (cannot lock ref '…': is at X but expected Y)` and does
 * NOT necessarily carry `non-fast-forward`/`fetch first`. That is a genuine
 * concurrent advance — re-fetch + re-union + re-push is the correct CAS
 * response. We key on the specific `but expected` discriminator, NOT the bare
 * `cannot lock ref` (which also covers a purely-local `.lock: File exists`
 * contention that is not a remote advance).
 */
export function isNonFastForwardRejection(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes('non-fast-forward') ||
    s.includes('fetch first') ||
    s.includes('tip of your current branch is behind') ||
    s.includes('remote contains work that you do') ||
    // Expected-old-OID mismatch: a lost server-side ref-transaction race.
    (s.includes('cannot lock ref') && s.includes('but expected'))
  );
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
  if (env.CI !== undefined && !isAuthorizedAssetPublisher(env, options)) {
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
  const sourceRoot = options.sourceRoot ?? repoRoot;
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

      const worktree = await deps.makeTempDir();
      // Fetch the tip into a DEDICATED private ref, never the shared, mutable
      // FETCH_HEAD (which is process-global for the repo, so an unrelated
      // `git fetch` — a human, an IDE auto-fetch, another tool — landing between
      // our fetch and `worktree add` could replace it; on first-ever queue
      // creation, seeding from `main`, that would silently base the new
      // `assets/queue` branch on whatever unrelated history that fetch pulled).
      // The ref is made UNIQUE PER SCRATCH WORKTREE (derived from the
      // mkdtemp-unique dir) because the cross-process lock is keyed by repo root:
      // two LINKED worktrees of the same clone (e.g. parallel agent sessions)
      // share the common ref store but have distinct roots, so they take
      // DIFFERENT locks and would otherwise clobber or delete each other's
      // scratch ref — making one side's `worktree add` fail and its edit
      // non-durable. Force (`+`) so a ref left behind by a crashed prior run is
      // overwritten, not a blocker.
      const scratchId = (worktree.split(/[\\/]/).pop() || 'base').replace(/[^A-Za-z0-9._-]/g, '-');
      const baseRef = `refs/queue-commit/base-${scratchId}`;
      const mainRef = `refs/queue-commit/main-${scratchId}`;
      try {
        await mustGit(deps.exec, repoRoot, [
          'fetch',
          '--no-tags',
          remote,
          `+${fetchRef}:${baseRef}`,
        ]);
        if (branchExists) {
          await mustGit(deps.exec, repoRoot, [
            'fetch',
            '--no-tags',
            remote,
            `+${baseBranch}:${mainRef}`,
          ]);
        }
        // Detached checkout of the freshly-fetched tip: we push by refspec and
        // never check the queue branch out by name, so there is no
        // "branch already checked out" clash with the caller's worktree.
        await mustGit(deps.exec, repoRoot, ['worktree', 'add', worktree, '--detach', baseRef]);
        if (branchExists) {
          const merge = await runGit(deps.exec, worktree, ['merge', '--no-edit', mainRef]);
          if (merge.code !== 0) {
            throw new QueueCommitError(
              'destination-conflict',
              `assets/queue could not merge current ${baseBranch}: ${merge.stderr || merge.stdout}`,
            );
          }
        }
        if (options.validateDestination) {
          try {
            await options.validateDestination(sourceRoot, worktree, assets);
          } catch (error) {
            throw new QueueCommitError(
              'destination-conflict',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        // UNION the live asset entries onto the tip's manifest + copy PNGs.
        await deps.copyArtSurface(sourceRoot, worktree, assets);

        // Catalog-only flows additionally overlay their edited rows; art
        // check-ins do not, so they touch exactly one shared committed file.
        const catalogEntryIds = options.catalogEntryIds ?? [];
        const stagePaths: string[] = [...ASSET_SURFACE_PATHS];
        if (catalogEntryIds.length > 0) {
          if (deps.overlayCatalogEntries === undefined) {
            throw new QueueCommitError(
              'invalid-asset-path',
              'catalogEntryIds was supplied but deps.overlayCatalogEntries is missing; ' +
                'the catalog edit would be silently dropped from the queue commit.',
            );
          }
          await deps.overlayCatalogEntries(sourceRoot, worktree, catalogEntryIds);
          stagePaths.push(CATALOG_STAGE_PATH);
        }

        // Fixed allowlist: only generated art (+ the catalog, for catalog-only
        // flows that opted in above) can ever be staged.
        await mustGit(deps.exec, worktree, ['add', '--', ...stagePaths]);

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
        // A non-zero push is only retryable when it is a genuine
        // non-fast-forward (a concurrent advance): re-fetch and retry so the
        // union re-applies onto the new tip. Any OTHER failure (auth, network,
        // hook, protected branch) is terminal — fail fast as `git-failed` with
        // the real stderr rather than burning retries and then blaming a
        // phantom concurrent writer.
        const rejection = push.stderr || push.stdout;
        if (!isNonFastForwardRejection(rejection)) {
          throw new QueueCommitError(
            'git-failed',
            `git push ${remote} ${queueBranch} failed (exit ${push.code}) and was not a ` +
              `non-fast-forward rejection, so it was not retried: ${rejection || 'no output'}`,
          );
        }
        lastRejection = rejection;
      } finally {
        // Cleanup must NEVER mask the primary result/error. `deps.removeDir` may
        // throw SYNCHRONOUSLY (the production impl calls `rmSync` before it
        // returns a promise, and Windows can throw EPERM on a transiently-locked
        // worktree dir), so `.catch()` alone is insufficient — a synchronous
        // throw would escape this `finally` and clobber a successful commit.
        // Wrap both cleanup calls so sync throws AND rejections are swallowed.
        try {
          await runGit(deps.exec, repoRoot, ['worktree', 'remove', worktree, '--force']);
        } catch {
          /* best-effort */
        }
        try {
          await deps.removeDir(worktree);
        } catch {
          /* best-effort */
        }
        // Delete our private scratch ref so it never accumulates. Harmless if a
        // fetch failed before it was created (update-ref -d then no-ops/errors).
        try {
          await runGit(deps.exec, repoRoot, ['update-ref', '-d', baseRef]);
        } catch {
          /* best-effort */
        }
        try {
          await runGit(deps.exec, repoRoot, ['update-ref', '-d', mainRef]);
        } catch {
          /* best-effort */
        }
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

function isAuthorizedAssetPublisher(env: NodeJS.ProcessEnv, options: QueueCommitOptions): boolean {
  const caller = options.ciAuthorization?.caller;
  if (caller === 'asset-request-publisher') {
    return (
      env.SPRITES_ALLOW_CI_ASSET_PUBLISH === 'true' &&
      env.GITHUB_ACTIONS === 'true' &&
      typeof env.GITHUB_WORKFLOW_REF === 'string' &&
      env.GITHUB_WORKFLOW_REF.includes('/.github/workflows/asset-request.yml@')
    );
  }
  if (caller === 'theme-equipment-publisher') {
    return (
      env.SPRITES_ALLOW_CI_THEME_PUBLISH === 'true' &&
      env.GITHUB_ACTIONS === 'true' &&
      typeof env.GITHUB_WORKFLOW_REF === 'string' &&
      env.GITHUB_WORKFLOW_REF.includes('/.github/workflows/theme-equipment.yml@')
    );
  }
  return false;
}

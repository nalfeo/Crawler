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
 *   - **Normal path**: the push is a plain fast-forward-only push of the new
 *     commit to `refs/heads/assets/queue`.  Our commit's parent IS the fetched
 *     tip, so a concurrent advance makes the push a non-fast-forward → git
 *     rejects it → we re-fetch and retry.
 *   - **Orphan-reset path**: when `assets/queue` has no common ancestry with
 *     `main` (an orphan branch), we `reset --hard mainRef` then layer queued art
 *     back on top via `checkout baseRef -- <art-surface>`.  The resulting commit's
 *     parent is `mainRef`, NOT the orphan tip, so a plain fast-forward push is
 *     permanently non-fast-forward.  Instead we push with
 *     `--force-with-lease=refs/heads/assets/queue:<orphan-sha>` (an explicit-SHA
 *     lease).  This is still a compare-and-swap: if another writer advances
 *     `assets/queue` between our fetch and our push, the lease fails with
 *     `(stale info)` → we re-fetch and retry, preserving the concurrent writer's
 *     assets in the union.
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
      | 'invalid-annotation'
      | 'invalid-brief-path'
      | 'generated-deletion-refused'
      | 'git-failed'
      | 'push-retries-exhausted',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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

/** One normalized Sprite Editor curation update. */
export interface SpriteAnnotationUpdate {
  readonly key: string;
  readonly favorite: boolean;
  readonly disliked: boolean;
  readonly comment: string;
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
   * Copy brief YAML files from `sourceRoot` into the worktree at the same
   * repo-relative path. Optional: only called when `QueueCommitOptions.briefs`
   * is non-empty. A default fs-based implementation is provided by
   * `createDefaultQueueCommitDeps`.
   */
  readonly copyBriefFiles?: (
    sourceRoot: string,
    worktree: string,
    briefPaths: readonly string[],
  ) => Promise<void>;
  /**
   * Merge only the named sprite annotations into the aggregate annotations file
   * already present in the freshly-fetched queue-tip worktree. This MUST be a
   * per-key merge, never a whole-file copy from the caller's stale worktree.
   */
  readonly mergeSpriteAnnotations?: (
    worktree: string,
    updates: readonly SpriteAnnotationUpdate[],
  ) => Promise<void>;
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
   * Repo-relative POSIX paths of brief YAML files to include alongside the art
   * surface in this commit (e.g. `briefs/enemies/panda-boba-sniper.yaml`).
   * Each path must be under `briefs/` with no traversal. The file is read from
   * `sourceRoot + briefPath` and written to the worktree at the same path.
   * Staged BEFORE the no-op guard so a commit that updates only a brief (with
   * identical art bytes) still lands as `committed` rather than `noop`.
   */
  readonly briefs?: readonly string[];
  /**
   * Per-sprite annotation updates to merge into the fresh queue tip. The shared
   * aggregate file is intentionally updated by key so concurrent, non-overlapping
   * editor saves survive every CAS retry.
   */
  readonly annotations?: readonly SpriteAnnotationUpdate[];
  /**
   * Narrow CI capability for the trusted asset-request publisher, or the
   * equally narrow theme-equipment-set publisher (ADR 0073). Ordinary
   * CLI/sidecar callers omit this and remain hard-refused under CI. Each
   * caller is authorized by its own env flag + workflow-ref check (see
   * `isAuthorizedAssetPublisher`) — this union intentionally does NOT open a
   * generic "any CI caller" path.
   */
  readonly ciAuthorization?: {
    readonly caller:
      | 'asset-request-publisher'
      | 'theme-equipment-publisher'
      | 'icon-batch-publisher';
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
}

const DEFAULT_MAX_ATTEMPTS = 5;

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

/**
 * Validate that each brief path is a safe repo-relative POSIX path under
 * `briefs/` with no absolute paths or traversal (`..`). Throws
 * `QueueCommitError('invalid-brief-path')` on the first violation.
 */
export function assertSafeBriefPaths(briefs: readonly string[]): void {
  for (const p of briefs) {
    if (typeof p !== 'string' || p.trim() === '') {
      throw new QueueCommitError('invalid-brief-path', `Empty brief path`);
    }
    if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.includes('\\')) {
      throw new QueueCommitError(
        'invalid-brief-path',
        `Brief path must be a repo-relative POSIX path, got: ${p}`,
      );
    }
    const segments = p.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new QueueCommitError('invalid-brief-path', `Unsafe brief path: ${p}`);
    }
    if (!p.startsWith('briefs/')) {
      throw new QueueCommitError(
        'invalid-brief-path',
        `Brief path must be under briefs/, got: ${p}`,
      );
    }
  }
}

/**
 * Object.prototype keys that must never be used as sprite annotation map
 * keys: assigning into `sprites[key]` for one of these mutates the object's
 * prototype/inherited members instead of creating an own enumerable JSON
 * property, silently dropping the annotation while the queue-commit still
 * reports success.
 */
const RESERVED_ANNOTATION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Validate normalized Sprite Editor annotations at the queue trust boundary. */
export function assertSafeAnnotationUpdates(updates: readonly SpriteAnnotationUpdate[]): void {
  const seen = new Set<string>();
  for (const update of updates) {
    if (
      typeof update.key !== 'string' ||
      update.key.trim() === '' ||
      update.key.length > 512 ||
      RESERVED_ANNOTATION_KEYS.has(update.key) ||
      [...update.key].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      })
    ) {
      throw new QueueCommitError(
        'invalid-annotation',
        `Invalid sprite annotation key ${JSON.stringify(update.key)}. Use a non-empty sprite key without control characters or reserved object properties.`,
      );
    }
    if (seen.has(update.key)) {
      throw new QueueCommitError(
        'invalid-annotation',
        `Duplicate sprite annotation key ${JSON.stringify(update.key)}. Send one update per sprite.`,
      );
    }
    seen.add(update.key);
    if (
      typeof update.favorite !== 'boolean' ||
      typeof update.disliked !== 'boolean' ||
      typeof update.comment !== 'string' ||
      update.comment.length > 1000 ||
      (update.favorite && update.disliked)
    ) {
      throw new QueueCommitError(
        'invalid-annotation',
        `Invalid annotation for ${update.key}. favorite/disliked must be booleans, cannot both be true, and comment must be at most 1000 characters.`,
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
    // Force-with-lease rejection: the remote ref advanced past the expected SHA.
    // Git outputs "(stale info)" when the lease's expected SHA no longer matches.
    s.includes('stale info') ||
    // Expected-old-OID mismatch: a lost server-side ref-transaction race.
    (s.includes('cannot lock ref') && s.includes('but expected'))
  );
}

function generatedDeletionRepairCommand(): string {
  return (
    'npm run sprites:repair-queue -- --audit --policy acc25eda-selective-v1 ' +
    '(then re-run with --apply --expect-main <sha> --expect-queue <sha>)'
  );
}

/**
 * Normal queue ingestion is additive.  A generated deletion in the remote queue
 * is corruption until a deliberately invoked, source-bound maintenance recovery
 * proves otherwise; never auto-heal it by rewriting the branch mid-ingestion.
 */
export function assertNoGeneratedQueueDeletions(paths: readonly string[]): void {
  const assetPaths = paths.filter(
    (path) =>
      /^public\/assets\/generated\/.+\.png$/u.test(path) ||
      /^public\/assets\/generated\/entries\/.+\.json$/u.test(path),
  );
  if (assetPaths.length === 0) return;
  throw new QueueCommitError(
    'generated-deletion-refused',
    `assets/queue deletes generated asset path(s): ${assetPaths.join(', ')}. ` +
      `Normal ingestion refuses to publish over a destructive queue. Run ${generatedDeletionRepairCommand()}.`,
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

  const briefs = options.briefs ?? [];
  assertSafeBriefPaths(briefs);
  const annotations = options.annotations ?? [];
  assertSafeAnnotationUpdates(annotations);

  const remote = options.remote ?? 'origin';
  const queueBranch = options.queueBranch ?? 'assets/queue';
  const baseBranch = options.baseBranch ?? 'main';
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sourceRoot = options.sourceRoot ?? repoRoot;
  const withLock = deps.withCrossProcessLock ?? ((fn) => fn());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (assets.length === 0 && briefs.length === 0 && annotations.length === 0) {
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
          const deleted = await runGit(deps.exec, repoRoot, [
            'diff',
            '--no-renames',
            '--name-only',
            '--diff-filter=D',
            mainRef,
            baseRef,
            '--',
            'public/assets/generated/',
          ]);
          if (deleted.code !== 0) {
            throw new QueueCommitError(
              'git-failed',
              `Could not inspect ${queueBranch} for generated-path deletions: ${deleted.stderr || deleted.stdout}`,
            );
          }
          assertNoGeneratedQueueDeletions(
            deleted.stdout.split(/\r?\n/).filter((path) => path.trim() !== ''),
          );
        }
        // Detached checkout of the freshly-fetched tip: we push by refspec and
        // never check the queue branch out by name, so there is no
        // "branch already checked out" clash with the caller's worktree.
        await mustGit(deps.exec, repoRoot, ['worktree', 'add', worktree, '--detach', baseRef]);
        // Track whether we resolved an orphan-history condition via reset+checkout.
        // When true, the new commit's parent is mainRef (NOT the orphan queue tip),
        // so a plain fast-forward push is impossible — we must use --force-with-lease
        // scoped to the exact orphan SHA we fetched.  That is still a compare-and-swap:
        // if another writer advanced assets/queue between our fetch and push,
        // the lease fails and we retry (just like the non-fast-forward retry).
        let usedOrphanReset = false;
        if (branchExists) {
          // First try a normal merge.
          let merge = await runGit(deps.exec, worktree, ['merge', '--no-edit', mainRef]);
          if (merge.code !== 0 && merge.stderr.toLowerCase().includes('unrelated histories')) {
            // The queue branch is an orphan (no common ancestor with main).
            // This can happen when the branch was seeded with --orphan or had
            // its history squashed.  A straight merge would produce conflicts
            // on every non-art file because git has no merge base to compute
            // the three-way diff from.
            //
            // Strategy: reset the worktree to main's clean state, then layer
            // the queued art AND brief files back on top from the orphan tip.
            // Non-art/non-brief files on the orphan are discarded (they violate
            // the art-only queue discipline and main always has the canonical
            // version).  The art+brief surfaces are fully preserved: queued
            // sprites and briefs already on the branch survive, and
            // copyArtSurface/copyBriefFiles adds the newly approved ones in the
            // next step.
            await mustGit(deps.exec, worktree, ['reset', '--hard', mainRef]);
            const artCheckout = await runGit(deps.exec, worktree, [
              'checkout',
              baseRef,
              '--',
              ...ASSET_SURFACE_PATHS,
            ]);
            // "pathspec did not match any file(s)" → the orphan has no staged
            // art yet; that is fine — copyArtSurface will add the first batch.
            if (artCheckout.code !== 0 && !artCheckout.stderr.toLowerCase().includes('pathspec')) {
              throw new QueueCommitError(
                'destination-conflict',
                `assets/queue orphan art checkout failed: ${artCheckout.stderr}`,
              );
            }
            // Restore any brief files that are already on the orphan queue tip so
            // they are not lost by the hard reset. Like art, a "pathspec did not
            // match" is fine (no briefs queued yet).
            const briefCheckout = await runGit(deps.exec, worktree, [
              'checkout',
              baseRef,
              '--',
              'briefs/',
            ]);
            if (
              briefCheckout.code !== 0 &&
              !briefCheckout.stderr.toLowerCase().includes('pathspec')
            ) {
              throw new QueueCommitError(
                'destination-conflict',
                `assets/queue orphan brief checkout failed: ${briefCheckout.stderr}`,
              );
            }
            await runGit(deps.exec, worktree, ['add', '--', ...ASSET_SURFACE_PATHS]);
            await runGit(deps.exec, worktree, ['add', '--', 'briefs/']);
            merge = { code: 0, stdout: '', stderr: '' };
            usedOrphanReset = true;
          }
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
        // Copy each asset's PNG + its manifest shard onto the tip. The
        // aggregate manifest and sprite-catalog rows are derived, never staged.
        await deps.copyArtSurface(sourceRoot, worktree, assets);
        // Fixed allowlist: only the generated art surface (PNGs + shards) can
        // ever be staged.
        await mustGit(deps.exec, worktree, ['add', '--', ...ASSET_SURFACE_PATHS]);

        // Copy brief YAML files (if any) and stage them. This MUST happen before
        // the no-op guard so a commit that touches only a brief file (identical
        // art bytes already on the queue) still lands as `committed` rather than
        // `noop`, preventing the brief from silently disappearing.
        if (briefs.length > 0) {
          if (!deps.copyBriefFiles) {
            throw new QueueCommitError(
              'invalid-brief-path',
              'briefs provided but deps.copyBriefFiles is not wired — cannot stage brief files',
            );
          }
          await deps.copyBriefFiles(sourceRoot, worktree, briefs);
          await runGit(deps.exec, worktree, ['add', '--', 'briefs/']);
        }

        // The annotations document is one shared aggregate, so copying the
        // caller's whole file would be last-writer-wins data loss. Merge only
        // these sprite keys into the freshly-fetched queue-tip document on every
        // CAS attempt, then stage that one known path.
        if (annotations.length > 0) {
          if (!deps.mergeSpriteAnnotations) {
            throw new QueueCommitError(
              'invalid-annotation',
              'annotations provided but deps.mergeSpriteAnnotations is not wired — cannot safely merge the shared Sprite Editor annotations file',
            );
          }
          try {
            await deps.mergeSpriteAnnotations(worktree, annotations);
          } catch (error) {
            throw new QueueCommitError(
              'invalid-annotation',
              `Failed to merge Sprite Editor annotations into the fresh queue tip: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            );
          }
          await mustGit(deps.exec, worktree, [
            'add',
            '--',
            'public/assets/generated/sprite-editor-annotations.json',
          ]);
        }

        // No-op guard: if nothing staged, the queue already carries identical
        // bytes — skip the commit+push so repeated identical saves don't churn.
        const staged = await runGit(deps.exec, worktree, ['diff', '--cached', '--quiet']);
        if (staged.code === 0) {
          return { status: 'noop', branch: queueBranch, attempts: attempt };
        }

        await mustGit(deps.exec, worktree, ['commit', '--no-verify', '-m', options.message]);
        const newCommit = (await mustGit(deps.exec, worktree, ['rev-parse', 'HEAD'])).trim();

        // Push strategy depends on whether we resolved an orphan-history situation.
        //
        // Normal path: our commit's parent IS the fetched queue tip — a plain
        // fast-forward push is a strict CAS that can never overwrite a concurrent
        // update.  A non-ff rejection means a concurrent writer advanced the branch
        // while we worked; we re-fetch and retry.
        //
        // Orphan-reset path: our commit's parent is mainRef, NOT the orphan tip, so
        // the plain fast-forward push is permanently non-fast-forward regardless of
        // any concurrent advance.  We must use --force-with-lease scoped to the exact
        // orphan SHA we fetched (baseRef).  This is still a CAS: if another writer
        // advanced assets/queue between our fetch and our push, the lease mismatches
        // and we retry (same as the non-ff retry on the normal path).
        let pushArgs: string[];
        if (usedOrphanReset) {
          const baseSha = (await mustGit(deps.exec, repoRoot, ['rev-parse', baseRef])).trim();
          pushArgs = [
            'push',
            '--no-verify',
            `--force-with-lease=refs/heads/${queueBranch}:${baseSha}`,
            remote,
            `${newCommit}:refs/heads/${queueBranch}`,
          ];
        } else {
          pushArgs = ['push', '--no-verify', remote, `${newCommit}:refs/heads/${queueBranch}`];
        }
        const push = await runGit(deps.exec, repoRoot, pushArgs);
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
  if (caller === 'icon-batch-publisher') {
    return (
      env.SPRITES_ALLOW_CI_ICON_BATCH_PUBLISH === 'true' &&
      env.GITHUB_ACTIONS === 'true' &&
      typeof env.GITHUB_WORKFLOW_REF === 'string' &&
      env.GITHUB_WORKFLOW_REF.includes('/.github/workflows/icon-batch.yml@')
    );
  }
  return false;
}

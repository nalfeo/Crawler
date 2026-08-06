/**
 * Reconcile-queue: the hourly acceptance path that lands durable sprite edits
 * accumulated on the long-lived `assets/queue` branch back into `main`.
 *
 * Why this exists (PR2 of the durable-asset-queue feature): PR1's queue-commit
 * primitive makes every approve/edit/revert instantly durable on the remote
 * `assets/queue` branch, but nothing integrates that branch into the shipped
 * game on `main`. This reconciler is the automated cron that opens/updates ONE
 * art-only PR and arms auto-merge, so queued edits reach `main` on a cadence.
 *
 * Architecture (chosen over a direct `assets/queue → main` PR after an
 * adversarial plan review flagged a head-drift TOCTOU — see
 * `docs/knowledge/adr/2026-07-24-sprite-queue-reconciler.md`):
 *
 *   `assets/queue` is a HIGH-CHURN, mutable ref (it takes every editor save), so
 *   arming auto-merge directly on it is unsafe: a save that lands in the merge
 *   window would ride the armed merge without ever passing the guard. Instead,
 *   each cycle we HARVEST queue's art surface onto CURRENT `origin/main` in a
 *   throwaway detached worktree, commit, and force-update a SOLE-WRITER,
 *   bot-owned promotion branch (`assets/promote`). The PR is `assets/promote →
 *   main`; auto-merge is armed on THAT. Because:
 *     - the reconciler is the only writer of `assets/promote` (single CI
 *       `concurrency:` lane) and only ever force-updates it to a commit it just
 *       built + guard-validated, and
 *     - the promotion commit is built directly ON current `origin/main` by
 *       overlaying only the art-surface allowlist,
 *   an untrusted push to `assets/queue` can never ride the armed merge, and the
 *   promotion diff is art-surface-only BY CONSTRUCTION (two-dot == three-dot
 *   since merge-base(main, promote) == main, so the guarded diff is exactly what
 *   the squash-merge lands). The trust boundary is enforced on the diff CONTENT
 *   the reconciler produces, not on any author identity.
 *
 * The trust-boundary guard re-validates the staged diff as DEFENSE-IN-DEPTH: if
 * it ever observes a path outside the art surface (which should be impossible by
 * construction — a path-escape or bug), it REFUSES to push/arm and escalates
 * rather than landing a non-art change to `main` via the PAT.
 *
 * `assets/queue` is NEVER reset as part of building the promotion itself. It
 * churns during the ~1h cycle; resetting it to `main` before merge proof would
 * silently drop edits that landed after the harvest snapshot — the exact loss
 * vector this feature eliminates. After a promotion is PROVABLY merged, a
 * separate lease-guarded tidy-up may retire the harvested queue/orphan tips, but
 * only when each source still matches the exact OID the promotion recorded.
 *
 * This module is PURE (IO-free): every effect is driven through injected `deps`
 * (an exec runner + temp-dir/lock hooks + an injected `now`), so it is unit
 * tested against a real temp git repo with a mocked `gh`, fully deterministic
 * (no `Date.now()` / `Math.random()`).
 *
 * Unlike the queue-commit primitive, this reconciler does NOT refuse under `CI`
 * — running in CI (the hourly workflow) is the entire point of PR2.
 */

import { parseAssetIssueBody } from './asset-issues.js';
import {
  ART_SURFACE_ALLOWLIST,
  ASSET_CHECKIN_LABEL,
  ASSET_SURFACE_PATHS,
  type Exec,
} from './checkin.js';

/** How the reconcile cycle resolved. */
export type ReconcileStatus = 'noop' | 'pr-open';

export class ReconcileError extends Error {
  constructor(
    readonly kind: 'git-failed' | 'gh-failed' | 'untrusted-diff' | 'invalid-state',
    message: string,
  ) {
    super(message);
    this.name = 'ReconcileError';
  }
}

export interface ReconcileResult {
  readonly status: ReconcileStatus;
  /** Promotion branch the PR is opened from. */
  readonly promoteBranch: string;
  /** Open PR number when `status === 'pr-open'`. */
  readonly prNumber?: number;
  /** True when this cycle CREATED the PR (vs. updated an existing open one). */
  readonly created?: boolean;
  /** True once `gh pr merge --auto --squash` was armed. */
  readonly armed?: boolean;
  /** The promotion commit SHA force-pushed to the promote branch. */
  readonly promoteCommit?: string;
  /** Art-surface paths that differ between queue and main (the batch). */
  readonly changedPaths?: readonly string[];
  /**
   * Number of orphaned `assets/checkin-*` branches folded into this promotion
   * (branches with no open PR that weren't captured in `assets/queue`).
   */
  readonly orphanedBranchCount?: number;
  /**
   * Issue numbers for open `asset-checkin` issues whose complete asset payload
   * is fully covered by this promotion (and will therefore be closed by it).
   * Empty when no issues are fully covered or the issue list query fails.
   */
  readonly closingIssueNumbers?: readonly number[];
  /** True when `assets/queue` was retired onto `main` by this cycle's tidy-up. */
  readonly tidiedQueue?: boolean;
  /** Orphan branches deleted by this cycle's tidy-up (already-landed snapshots). */
  readonly tidiedBranches?: readonly string[];
  /** True when issue-closure discovery completed successfully. */
  readonly closingIssueDiscoveryComplete?: boolean;
  /**
   * Art paths a source offered that the convergence guard withheld (stale
   * re-assertions, or edits that would clobber a main-side change the source
   * never saw). Surfaced so a genuinely-blocked approval is visible in the
   * workflow log rather than silently dropped.
   */
  readonly withheldPaths?: readonly string[];
}

export interface ReconcileDeps {
  /** Runs an external command (git + gh). */
  readonly exec: Exec;
  /** Create + return an empty temp directory for the throwaway worktree. */
  readonly makeTempDir: () => Promise<string>;
  /** Remove a directory tree (best-effort cleanup). */
  readonly removeDir: (dir: string) => Promise<void>;
  /**
   * Acquire + release a cross-process lock spanning the cycle's git work.
   * Reuses the SAME repo-keyed check-in file lock the queue-commit primitive
   * holds, so a reconcile cycle and a concurrent dev-box queue-commit never race
   * on fetch/worktree/ref operations in the same clone. Defaults to a no-op
   * passthrough. NOTE: this is a same-clone lock only; cross-RUNNER serialization
   * (two GitHub Actions runners) is provided by the workflow's `concurrency:`.
   */
  readonly withCrossProcessLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Injected clock for the PR body timestamp. Keeps the core deterministic. */
  readonly now: () => Date;
  /** Env (unused for CI-refusal — reconciler runs in CI by design). */
  readonly env?: NodeJS.ProcessEnv;
}

export interface ReconcileOptions {
  /** Remote name. Defaults to `origin`. */
  readonly remote?: string;
  /** The persistent, high-churn source queue branch. Defaults to `assets/queue`. */
  readonly queueBranch?: string;
  /** The sole-writer promotion branch the PR is opened from. Defaults to `assets/promote`. */
  readonly promoteBranch?: string;
  /** Integration branch. Defaults to `main`. */
  readonly baseBranch?: string;
  /** `owner/repo` for `gh --repo`. Defaults to `gh`'s inferred repo when omitted. */
  readonly repo?: string;
}

const DEFAULT_REMOTE = 'origin';
const DEFAULT_QUEUE_BRANCH = 'assets/queue';
const DEFAULT_PROMOTE_BRANCH = 'assets/promote';
const DEFAULT_BASE_BRANCH = 'main';

/**
 * Merge-train label constants. These MUST mirror
 * `.github/scripts/merge-train/state.mjs` exactly (source of truth) — see
 * that file for the full label lifecycle.
 *
 * The ONLY merge gate on `main` is the "Merge Train Required Checks" ruleset,
 * which requires the `merge-train` STATUS context. That status is posted only
 * by the merge-train GitHub App after it ADMITS a PR, and admission requires
 * the PR to carry the `merge-train` LABEL (`QUEUE_LABEL`,
 * `queueEntries()`/`promotionStaleReason()` in `state.mjs`/`reconcile-lib.mjs`).
 * There is no auto-labeler for `assets/promote` PRs, so without re-ensuring
 * this label the reconciler's armed `--auto --squash` PRs sit BLOCKED
 * forever — silently defeating the whole hourly-reconcile feature.
 */
const MERGE_TRAIN_LABEL = 'merge-train';

/**
 * Labels under which the train has DELIBERATELY revoked/withheld enrollment.
 * Re-adding `merge-train` while any of these is present would fight the
 * train's own decision instead of respecting it. Confirmed by reading
 * `.github/scripts/merge-train/reconcile-lib.mjs` and `reconcile.mjs`:
 *
 *   - `merge-train-blocked` / `merge-train-recovery-pending`: the train
 *     explicitly REMOVES `merge-train` whenever it sets either of these
 *     (`reconcile-lib.mjs` `applyLandedRecoveryDecision` and the
 *     retry/blocked paths) — re-adding it here would re-enroll a PR the
 *     train just intentionally pulled from the queue.
 *   - `merge-train-noop` / `merge-train-validation-failed`: always set
 *     ALONGSIDE `merge-train-blocked` in the same call (`reconcile.mjs`
 *     lines setting BLOCKED_LABEL together with each), so excluding on
 *     `merge-train-blocked` alone would already cover these, but they are
 *     listed explicitly so the exclusion is self-documenting and does not
 *     silently depend on that co-occurrence continuing to hold.
 *   - `merge-train-landed`: the one PERMANENT label — only ever added, never
 *     removed (see the comment in `state.mjs`). Once present the PR's change
 *     has already landed on `main`; re-adding `merge-train` is pointless and
 *     the skip here is effectively final for that PR.
 *
 * For the non-terminal labels, skipping the re-add is only for THIS cycle —
 * the reconciler re-evaluates fresh state on the next run.
 */
const MERGE_TRAIN_RE_ENSURE_EXCLUDE_LABELS = [
  'merge-train-blocked',
  'merge-train-recovery-pending',
  'merge-train-noop',
  'merge-train-validation-failed',
  'merge-train-landed',
] as const;
const ISSUE_LIST_INITIAL_LIMIT = 200;
const ISSUE_LIST_MAX_LIMIT = 5000;

/**
 * True when `labels` carries any label under which the train has
 * deliberately revoked/withheld enrollment (or already landed the PR) — see
 * `MERGE_TRAIN_RE_ENSURE_EXCLUDE_LABELS` above for the per-label rationale.
 */
function hasMergeTrainExcludeLabel(labels: readonly string[]): boolean {
  return labels.some((label) =>
    (MERGE_TRAIN_RE_ENSURE_EXCLUDE_LABELS as readonly string[]).includes(label),
  );
}

/**
 * Re-ensure the `merge-train` enrollment label on an ALREADY-EXISTING promote
 * PR (one this cycle did not just create), unless the train has deliberately
 * revoked/withheld enrollment or already landed it. Used both by the normal
 * update path (existing open PR found up front) and by the create-race
 * fallback path (an existing PR discovered only after `gh pr create` failed
 * because a concurrent run/dispatch already opened one) — both cases reuse a
 * PR that may not carry our label yet, so both must re-ensure it the same way.
 */
async function reEnsureMergeTrainLabel(
  exec: Exec,
  repoRoot: string,
  repo: string | undefined,
  pr: OpenPromotePr,
): Promise<void> {
  if (hasMergeTrainExcludeLabel(pr.labels)) return;
  await mustGh(exec, repoRoot, [
    'pr',
    'edit',
    String(pr.number),
    ...repoArgs(repo),
    '--add-label',
    MERGE_TRAIN_LABEL,
  ]);
}

/** git args that write to a specific worktree/cwd. */
async function runGit(
  exec: Exec,
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return exec('git', args, { cwd });
}

/** Throwing git: raises `ReconcileError('git-failed')` on a non-zero exit. */
async function mustGit(exec: Exec, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(exec, cwd, args);
  if (result.code !== 0) {
    throw new ReconcileError(
      'git-failed',
      `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/** Throwing gh: raises `ReconcileError('gh-failed')` on a non-zero exit. */
async function mustGh(exec: Exec, cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec('gh', args, { cwd });
  if (result.code !== 0) {
    throw new ReconcileError(
      'gh-failed',
      `gh ${args.join(' ')} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/**
 * Is `p` inside the art-surface allowlist? A path is trusted iff it is exactly
 * an allowlisted file (for example `src/shared/data/sprite-catalog.json`) OR
 * lives under an allowlisted directory (`public/assets/generated/`, `briefs/`).
 * Matches `detect-art-only.sh` EXACTLY so the guard and the CI art-only
 * classifier agree by construction — a promote→main diff the guard accepts is
 * precisely one `ci.yml` classifies `art_only=true`.
 *
 * Path handling is strict: reject absolute paths, backslashes, and any `.`/`..`
 * segment so a crafted entry can never escape the allowlist via traversal.
 */
export function isArtSurfacePath(p: string): boolean {
  if (typeof p !== 'string' || p.trim() === '') return false;
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.includes('\\')) return false;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  for (const surface of ART_SURFACE_ALLOWLIST) {
    // A surface entry is a single file (e.g. the catalog JSON) or a directory
    // (e.g. `public/assets/generated`). File entries match EXACTLY; directory
    // entries match DESCENDANTS ONLY. Never accept a bare directory path as
    // art: `git diff --name-only` reports the root path when a tree entry
    // changes type, so exact-matching `public/assets/generated` would let a
    // queue tip that replaces the whole directory with a file/symlink slip past
    // the guard. Requiring a descendant closes that type-change escape.
    if (surface.endsWith('.json')) {
      if (p === surface) return true;
    } else if (p.startsWith(`${surface}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Trust-boundary guard (security-critical, defense-in-depth). Given the set of
 * paths a promotion commit changes vs `main`, throw `untrusted-diff` unless
 * EVERY path is in the art-surface allowlist. Returns the (validated) paths.
 *
 * By construction the promotion commit only overlays the art surface, so this
 * should never reject — a rejection means a path-escape or bug produced a
 * non-art path, in which case REFUSING to push/arm (and escalating) is the
 * correct fail-closed response: the reconciler must only ever land art on
 * `main` via the PAT.
 */
export function assertArtSurfaceOnly(
  changedPaths: readonly string[],
  baseBranch = DEFAULT_BASE_BRANCH,
): readonly string[] {
  const offenders = changedPaths.filter((p) => !isArtSurfacePath(p));
  if (offenders.length > 0) {
    throw new ReconcileError(
      'untrusted-diff',
      `Refusing to arm auto-merge: the promotion diff touches ${offenders.length} path(s) ` +
        `outside the art-surface allowlist (${ART_SURFACE_ALLOWLIST.join(', ')}): ` +
        `${offenders.join(', ')}. This should be impossible by construction; refusing ` +
        `to land a non-art change on ${baseBranch} and escalating.`,
    );
  }
  return changedPaths;
}

/** Split porcelain `--name-only` output into a trimmed, non-empty path list. */
function parseNameOnly(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Returns true for top-level JSON files directly under `public/assets/generated/`
 * that predate the shard migration (e.g. the aggregate `manifest.json`).
 * Shard files live under `entries/` and are safe to harvest; those are NOT matched.
 */
function isLegacyAggregateManifestPath(p: string): boolean {
  return /^public\/assets\/generated\/[^/]+\.json$/.test(p);
}

/**
 * Read the blob object id a ref holds at each of `paths` (one git process).
 * `ls-tree -r` prints "<mode> <type> <sha>\t<path>"; paths absent from the ref
 * are simply omitted. Returns `null` on any git failure so callers fail closed.
 */
async function blobsAtPaths(
  exec: Exec,
  repoRoot: string,
  ref: string,
  paths: readonly string[],
): Promise<Map<string, string> | null> {
  const lsTree = await runGit(exec, repoRoot, [
    '-c',
    'core.quotePath=false',
    'ls-tree',
    '-r',
    ref,
    '--',
    ...paths,
  ]);
  if (lsTree.code !== 0) return null;
  const blobs = new Map<string, string>();
  for (const line of parseNameOnly(lsTree.stdout)) {
    const [meta, filePath] = line.split('\t');
    const sha = meta?.split(/\s+/)[2] ?? '';
    if (filePath === undefined || !OBJECT_ID_PATTERN.test(sha)) continue;
    blobs.set(filePath, sha);
  }
  return blobs;
}

/**
 * Every blob a ref's HISTORY has ever held at each of `paths` (one git process).
 * `--raw` lines look like ":100644 100644 <src> <dst> M\t<path>"; both sides are
 * recorded so bytes that were landed and later changed still count as seen.
 * Returns `null` on any git failure so callers fail closed.
 */
async function historicBlobsAtPaths(
  exec: Exec,
  repoRoot: string,
  ref: string,
  paths: readonly string[],
): Promise<Map<string, Set<string>> | null> {
  const history = await runGit(exec, repoRoot, [
    '-c',
    'core.quotePath=false',
    'log',
    '--format=',
    '--raw',
    '--no-renames',
    '--no-abbrev',
    ref,
    '--',
    ...paths,
  ]);
  if (history.code !== 0) return null;
  const seenByPath = new Map<string, Set<string>>();
  for (const line of parseNameOnly(history.stdout)) {
    if (!line.startsWith(':')) continue;
    const [meta, filePath] = line.split('\t');
    if (filePath === undefined) continue;
    const fields = meta?.slice(1).split(/\s+/) ?? [];
    const seen = seenByPath.get(filePath) ?? new Set<string>();
    for (const sha of [fields[2], fields[3]]) {
      if (sha !== undefined && OBJECT_ID_PATTERN.test(sha)) seen.add(sha);
    }
    seenByPath.set(filePath, seen);
  }
  return seenByPath;
}

/**
 * Keep only the candidate paths a source may actually promote onto `base` — the
 * convergence guard that stops the hourly promotion ping-pong.
 *
 * Why this exists: the two-dot `AM` delta answers "do the source's bytes differ
 * from base's *right now*", which is TRUE both for genuinely-new art and for a
 * STALE copy that `main` already landed and has since superseded. Several
 * sources hold different bytes for the same path (the long-lived `assets/queue`
 * plus dozens of never-retired `assets/checkin-*` branches), so whichever source
 * is not currently reflected on `main` re-asserts its bytes every cycle and
 * flips the path back — an art-only PR opened EVERY HOUR even when no asset had
 * been approved for days, and no source was ever retirable because each one
 * always "adds" something. Observed in production as e.g.
 * `public/assets/generated/cave-floor-var-8.png` alternating between two blobs
 * on consecutive reconcile commits (PRs #2696…#2770).
 *
 * A path is promotable only when BOTH hold:
 *   1. STALENESS — `base`'s history has never carried the source's exact bytes
 *      at that path. Re-landing bytes `main` already had and moved on from is,
 *      by definition, a revert; it also guarantees another delta next cycle.
 *   2. NO CONFLICT — `base`'s CURRENT bytes at that path are ones this source's
 *      own history contains (or `base` does not have the path at all). That is
 *      three-way merge reasoning without needing a fresh merge base: a source
 *      may advance a path it demonstrably knows the current state of, but may
 *      never clobber a change it has never seen (e.g. a July check-in branch
 *      overwriting today's `sprite-catalog.json`). `main` wins conflicts, which
 *      is also the only direction that cannot regress the shipped game.
 *
 * Genuinely-new art (a path `main` has never held) satisfies both trivially, so
 * real approvals still land, and repeat edits of an asset the reconciler itself
 * promoted keep landing (main's current bytes came from the source's history).
 *
 * Fail closed: any git failure drops every path for that source. Promoting when
 * we cannot read the history is exactly the unbounded-regression case this guard
 * prevents, and dropping is non-destructive — the source keeps its bytes and a
 * later cycle promotes them once git answers again.
 */
export async function filterPromotablePaths(
  exec: Exec,
  repoRoot: string,
  baseRef: string,
  sourceRef: string,
  paths: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  const sourceBlobs = await blobsAtPaths(exec, repoRoot, sourceRef, paths);
  const baseBlobs = await blobsAtPaths(exec, repoRoot, baseRef, paths);
  const baseHistory = await historicBlobsAtPaths(exec, repoRoot, baseRef, paths);
  const sourceHistory = await historicBlobsAtPaths(exec, repoRoot, sourceRef, paths);
  if (
    sourceBlobs === null ||
    baseBlobs === null ||
    baseHistory === null ||
    sourceHistory === null
  ) {
    return [];
  }

  return paths.filter((p) => {
    const sourceSha = sourceBlobs.get(p);
    // A path the source does not actually have cannot be promoted from it.
    if (sourceSha === undefined) return false;
    // 1. Stale re-assertion of bytes base already carried.
    if (baseHistory.get(p)?.has(sourceSha) === true) return false;
    // 2. Conflict: base holds bytes this source has never seen.
    const baseSha = baseBlobs.get(p);
    if (baseSha === undefined) return true;
    return sourceHistory.get(p)?.has(baseSha) === true;
  });
}

/** Destination tree-entry modes the reconciler will allow onto `main`. */
const ALLOWED_DST_MODES = new Set([
  '100644', // regular non-executable file (PNG / manifest.json / catalog.json)
  '000000', // deletion (removes art only — can never inject code)
]);

/**
 * Mode-aware trust-boundary guard (security-critical, defense-in-depth).
 *
 * `git diff --name-only` reports only pathnames, so a tree-entry TYPE change at
 * an allowlisted path — e.g. `public/assets/generated/manifest.json` turned into
 * a symlink (mode 120000) or a submodule/gitlink (160000), or a PNG made
 * executable (100755) — passes a path-only allowlist check yet would land a
 * non-blob / non-art entry on `main`. This inspects the staged **raw** diff and
 * refuses any changed entry whose DESTINATION mode is not a plain regular file
 * (a pure deletion is allowed — it can only remove art, never inject code), in
 * addition to re-enforcing the path allowlist. Parse a `git diff --cached --raw
 * --no-renames -c core.quotePath=false` (vs the worktree HEAD == origin/main)
 * `stdout`.
 */
export function assertArtSurfaceModes(rawStdout: string, baseBranch = DEFAULT_BASE_BRANCH): void {
  for (const raw of rawStdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '' || !line.startsWith(':')) continue;
    // Format (no -z, renames disabled): `:<srcMode> <dstMode> <srcSha> <dstSha> <status>\t<path>`
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) {
      throw new ReconcileError(
        'untrusted-diff',
        `Refusing to arm auto-merge: unparseable staged raw-diff line "${line}".`,
      );
    }

    const fields = line.slice(1, tabIdx).trim().split(/\s+/);
    const dstMode = fields[1];
    const status = fields[4] ?? '?';
    // A rename/copy would emit two tab-separated paths; renames are disabled, so
    // take the last tab field as the (destination) path defensively.
    const path =
      line
        .slice(tabIdx + 1)
        .split('\t')
        .pop()
        ?.trim() ?? '';
    if (path === '' || !isArtSurfacePath(path)) {
      throw new ReconcileError(
        'untrusted-diff',
        `Refusing to arm auto-merge: staged raw diff touches a non-art path "${path}". ` +
          `This should be impossible by construction; refusing to land it on ` +
          `${baseBranch} and escalating.`,
      );
    }
    if (dstMode === undefined || !ALLOWED_DST_MODES.has(dstMode)) {
      throw new ReconcileError(
        'untrusted-diff',
        `Refusing to arm auto-merge: art path "${path}" has a non-regular-file ` +
          `destination mode ${dstMode ?? '?'} (status ${status}). Symlinks, gitlinks, ` +
          `and executables are refused — only plain art files may land on ` +
          `${baseBranch}. Escalating.`,
      );
    }
  }
}

/** Build the (deterministic) PR title + body for the current batch. */
function buildPrContent(
  changedPaths: readonly string[],
  promoteCommit: string,
  now: Date,
  queueBranch: string,
  promoteBranch: string,
  baseBranch: string,
  closingIssueNumbers: readonly number[] = [],
  orphanedBranchCount = 0,
): { title: string; body: string } {
  const iso = now.toISOString();
  const count = changedPaths.length;
  const title = `chore(assets): reconcile queued sprite edits (${count} art path${count === 1 ? '' : 's'})`;
  const list = changedPaths.map((p) => `- \`${p}\``).join('\n');
  const parts = [
    `Automated art-only reconciliation of the durable \`${queueBranch}\` branch into`,
    `\`${baseBranch}\` (durable sprite-edit persistence, PR2).`,
    '',
    `- Promotion branch: \`${promoteBranch}\` @ \`${promoteCommit}\``,
    `- Batched at: ${iso}`,
    '- Diff is art-surface-only **by construction** (harvested onto current',
    `  \`${baseBranch}\`); the trust-boundary guard re-validated it before arming auto-merge.`,
  ];
  if (orphanedBranchCount > 0) {
    parts.push(
      `- Also folded **${orphanedBranchCount}** orphaned \`assets/checkin-*\` branch(es) ` +
        `not previously captured in \`${queueBranch}\`.`,
    );
  }
  parts.push(
    '',
    '### Changed art-surface paths',
    '',
    list,
    '',
    '<sub>Opened by the hourly sprite-queue reconciler',
    '(`scripts/sprites/reconcile-queue.ts`). See',
    'ADR `2026-07-24-sprite-queue-reconciler`.</sub>',
    '',
  );
  // Auto-close each fully-covered tracking issue when the PR merges.
  for (const n of closingIssueNumbers) {
    parts.push(`Closes #${n}`);
  }
  const body = parts.join('\n');
  return { title, body };
}

/** Common `gh` args that pin `--repo` when supplied. */
function repoArgs(repo: string | undefined): string[] {
  return repo ? ['--repo', repo] : [];
}

/**
 * Determine which open `asset-checkin` issues are fully covered by the current
 * promotion and should therefore be closed when the promotion PR merges.
 *
 * An issue is "fully covered" when every asset in its payload is present in the
 * post-promotion tree (`promotedRef`) and its payload `contentHash` exactly
 * matches the manifest entry for that path. Hash-less legacy payload entries are
 * treated as ambiguous and excluded (fail closed).
 *
 * The function returns `{ complete: false }` on discovery failures (issue list,
 * promoted tree, manifest parse) so callers can defer merge arming rather than
 * silently dropping `Closes #N` keywords.
 *
 * Exported for deterministic unit testing with a faked exec.
 */
export async function computeClosingIssueNumbers(
  exec: Exec,
  repoRoot: string,
  baseRef: string,
  repo: string | undefined,
  // `promotedRef` is the post-harvest tree we are about to publish/merge.
  // Defaults to `baseRef` in unit tests that don't pass it explicitly.
  promotedRef = baseRef,
): Promise<{ readonly issueNumbers: readonly number[]; readonly complete: boolean }> {
  const listOpenIssues = async (): Promise<
    | {
        readonly ok: true;
        readonly issues: Array<{ number?: unknown; body?: unknown }>;
      }
    | { readonly ok: false }
  > => {
    // `gh issue list` has a caller-provided cap (`--limit`). Re-query with a
    // larger limit until the returned count is strictly below that limit, which
    // proves we have the complete open set up to `ISSUE_LIST_MAX_LIMIT`.
    let limit = ISSUE_LIST_INITIAL_LIMIT;
    while (true) {
      const issueResult = await exec(
        'gh',
        [
          'issue',
          'list',
          ...repoArgs(repo),
          '--label',
          ASSET_CHECKIN_LABEL,
          '--state',
          'open',
          '--json',
          'number,body',
          '--limit',
          String(limit),
        ],
        { cwd: repoRoot },
      );
      if (issueResult.code !== 0) return { ok: false };
      let rawIssues: Array<{ number?: unknown; body?: unknown }>;
      try {
        rawIssues = JSON.parse(issueResult.stdout.trim() || '[]') as Array<{
          number?: unknown;
          body?: unknown;
        }>;
      } catch {
        return { ok: false };
      }
      if (!Array.isArray(rawIssues)) return { ok: false };
      if (rawIssues.length < limit) return { ok: true, issues: rawIssues };
      if (limit >= ISSUE_LIST_MAX_LIMIT) return { ok: false };
      limit = Math.min(limit * 2, ISSUE_LIST_MAX_LIMIT);
    }
  };

  const listed = await listOpenIssues();
  if (!listed.ok) return { issueNumbers: [], complete: false };
  if (listed.issues.length === 0) return { issueNumbers: [], complete: true };

  // Inspect the exact post-promotion tree, not just path names:
  // an asset is closable only when path + manifest contentHash both match.
  const lsResult = await exec(
    'git',
    ['ls-tree', '--name-only', '-r', promotedRef, '--', ...ASSET_SURFACE_PATHS],
    { cwd: repoRoot },
  );
  if (lsResult.code !== 0) return { issueNumbers: [], complete: false };
  const promotedPaths = new Set<string>(
    lsResult.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
  );

  // The aggregate manifest.json is no longer committed (it is a gitignored
  // build artifact), so compose the assetPath -> contentHash map directly from
  // the per-asset shards present in the promoted tree. `promotedPaths` already
  // lists every file under the generated surface at `promotedRef`.
  const shardPaths = [...promotedPaths].filter(
    (p) => p.startsWith('public/assets/generated/entries/') && p.endsWith('.json'),
  );
  const manifestHashes = new Map<string, string>();
  for (const shardPath of shardPaths) {
    const shardResult = await exec('git', ['show', `${promotedRef}:${shardPath}`], {
      cwd: repoRoot,
    });
    if (shardResult.code !== 0) continue;
    let entry: { assetPath?: unknown; contentHash?: unknown };
    try {
      entry = JSON.parse(shardResult.stdout) as { assetPath?: unknown; contentHash?: unknown };
    } catch {
      continue;
    }
    const assetPath = entry.assetPath;
    const contentHash = entry.contentHash;
    if (typeof assetPath !== 'string' || typeof contentHash !== 'string') continue;
    manifestHashes.set(assetPath, contentHash);
  }

  const closing: number[] = [];
  for (const raw of listed.issues) {
    if (typeof raw.number !== 'number') continue;
    if (typeof raw.body !== 'string') continue;
    const payload = parseAssetIssueBody(raw.body);
    if (payload === null || payload.assets.length === 0) continue;
    const allCovered = payload.assets.every((asset) => {
      if (typeof asset.contentHash !== 'string' || asset.contentHash === '') return false;
      const fullPath = `public/assets/${asset.assetPath}`;
      if (!promotedPaths.has(fullPath)) return false;
      return manifestHashes.get(asset.assetPath) === asset.contentHash;
    });
    if (allCovered) closing.push(raw.number);
  }

  return { issueNumbers: closing.sort((a, b) => a - b), complete: true };
}

/**
 * Trailer keys recording the EXACT source snapshots a promotion harvested.
 *
 * Why the promotion must record its own inputs: the reconciler used to derive
 * "what has already been promoted?" by comparing trees, and that is provably
 * unsound. Each source's contribution is computed as
 * `git diff --diff-filter=AM <base> <source>` — "differs from `main`", NOT
 * "newer than `main`". With two sources that disagree about a path (the durable
 * `assets/queue` and an orphaned `assets/checkin-*` branch), whichever source
 * currently AGREES with `main` drops out of its own AM set, so the other source
 * always wins the overlay — and `main` flips between the two, every hour,
 * forever. Observed live on
 * `public/assets/generated/entries/gnome-boss-var-7.json`, where `assets/queue`
 * and `assets/checkin-20260801-181522-7be968` held one blob while `main` and
 * `assets/checkin-20260731-204023-b1e0cb` held another; PRs #2704 and #2706
 * (one hour apart) carried an identical 100-file set with exactly inverse
 * patches.
 *
 * Blob equality cannot distinguish "already promoted" from "deliberately
 * re-asserted", and the merged PR head is a COMPOSITE (queue + orphan overlays,
 * plus any CI-recovery repair commits), so it does not preserve any single
 * source's bytes. The only sound acknowledgement is the source OID itself, so
 * every promotion records the SHAs it harvested and the next cycle retires
 * exactly those snapshots — under a compare-and-swap lease — once the promotion
 * has MERGED.
 */
const QUEUE_SOURCE_TRAILER = 'Queue-Source:';
const ORPHAN_SOURCE_TRAILER = 'Orphan-Source:';

/** How many commits back from a merged promotion head to scan for trailers. */
const LANDED_TRAILER_SCAN_DEPTH = 20;

/** Exact subject line a promotion commit must carry to be trusted for trailers. */
const PROMOTION_SUBJECT = 'chore(assets): reconcile queued sprite edits';

/** Scratch refs the tidy-up clobbers each cycle (namespaced, never user-visible). */
const LANDED_SCRATCH_REF = 'refs/sprite-reconcile/landed-promotion';
const BASE_SCRATCH_REF = 'refs/sprite-reconcile/landed-base';
const SOURCE_SCRATCH_REF = 'refs/sprite-reconcile/retire-candidate';

/** Full 40-hex object id. Anything else is rejected (fail closed). */
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Orphan branch names the reconciler will record and later DELETE. Deliberately
 * as narrow as `scanOrphanedCheckinBranches`' own filter: a trailer is an
 * instruction to destroy a remote ref, so anything that is not obviously an
 * `assets/checkin-*` branch is ignored rather than trusted.
 */
const ORPHAN_BRANCH_PATTERN = /^assets\/checkin-[A-Za-z0-9._-]+$/;

/** One orphan source snapshot: the branch and the exact tip that was harvested. */
export interface OrphanSource {
  readonly branch: string;
  readonly sha: string;
}

/** The exact source snapshots a promotion commit harvested. */
export interface PromotionSources {
  /** Harvested `assets/queue` tip, or null when the queue contributed nothing. */
  readonly queueSha: string | null;
  /** Harvested orphan branch tips (deterministically ordered by branch name). */
  readonly orphans: readonly OrphanSource[];
}

/** Deterministic branch-name ordering (byte-wise; no locale dependence). */
function byBranchName(a: OrphanSource, b: OrphanSource): number {
  if (a.branch < b.branch) return -1;
  if (a.branch > b.branch) return 1;
  return 0;
}

/**
 * Render {@link PromotionSources} as commit-message trailers. Pure + ordered, so
 * the same harvest always produces byte-identical trailers.
 */
export function formatSourceTrailers(sources: PromotionSources): string {
  const lines: string[] = [];
  if (sources.queueSha !== null && OBJECT_ID_PATTERN.test(sources.queueSha)) {
    lines.push(`${QUEUE_SOURCE_TRAILER} ${sources.queueSha}`);
  }
  for (const orphan of [...sources.orphans].sort(byBranchName)) {
    if (!ORPHAN_BRANCH_PATTERN.test(orphan.branch)) continue;
    if (!OBJECT_ID_PATTERN.test(orphan.sha)) continue;
    lines.push(`${ORPHAN_SOURCE_TRAILER} ${orphan.branch} ${orphan.sha}`);
  }
  return lines.join('\n');
}

/**
 * Parse source trailers back out of a commit message. FAIL CLOSED: a malformed
 * trailer is dropped, never guessed at, because every parsed value is used to
 * authorize a destructive ref update.
 */
export function parseSourceTrailers(message: string): PromotionSources {
  let queueSha: string | null = null;
  const orphans: OrphanSource[] = [];
  for (const rawLine of message.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith(QUEUE_SOURCE_TRAILER)) {
      const value = line.slice(QUEUE_SOURCE_TRAILER.length).trim();
      if (OBJECT_ID_PATTERN.test(value)) queueSha = value;
      continue;
    }
    if (!line.startsWith(ORPHAN_SOURCE_TRAILER)) continue;
    const fields = line.slice(ORPHAN_SOURCE_TRAILER.length).trim().split(/\s+/);
    if (fields.length !== 2) continue;
    const [branch, sha] = fields;
    if (branch === undefined || sha === undefined) continue;
    if (!ORPHAN_BRANCH_PATTERN.test(branch) || !OBJECT_ID_PATTERN.test(sha)) continue;
    if (orphans.some((existing) => existing.branch === branch)) continue;
    orphans.push({ branch, sha });
  }
  return { queueSha, orphans: orphans.sort(byBranchName) };
}

/** Resolve a remote branch tip, or null when absent/unreadable (fail closed). */
async function remoteBranchSha(
  exec: Exec,
  repoRoot: string,
  remote: string,
  branch: string,
): Promise<string | null> {
  const result = await runGit(exec, repoRoot, ['ls-remote', '--heads', remote, branch]);
  if (result.code !== 0) return null;
  const first = result.stdout.split('\n')[0]?.trim() ?? '';
  const sha = first.split(/\s+/)[0] ?? '';
  return OBJECT_ID_PATTERN.test(sha) ? sha : null;
}

/** A merged promotion together with the source snapshots it recorded. */
export interface LandedPromotion {
  readonly prNumber: number;
  readonly headSha: string;
  readonly sources: PromotionSources;
}

/**
 * Locate the most recently MERGED `<promoteBranch> -> <baseBranch>` PR and read
 * the source snapshots its promotion commit recorded.
 *
 * The promote branch is auto-deleted by GitHub when the PR merges, so the head
 * commit is reached through the permanent `refs/pull/<n>/head` ref rather than
 * through the branch. Every failure path returns `null` (fail closed) because
 * the result authorizes destructive ref updates.
 *
 * SECURITY: `gh pr list --head <branch>` filters by branch NAME only, so a fork
 * PR reusing the name would otherwise be accepted — `isCrossRepository` is
 * required to be `false`, mirroring the guard in `findOpenPromotePr`.
 */
export async function findLandedPromotion(
  exec: Exec,
  repoRoot: string,
  remote: string,
  repo: string | undefined,
  promoteBranch: string,
  baseBranch: string,
): Promise<LandedPromotion | null> {
  const listed = await exec(
    'gh',
    [
      'pr',
      'list',
      ...repoArgs(repo),
      '--head',
      promoteBranch,
      '--base',
      baseBranch,
      '--state',
      'merged',
      '--json',
      'number,headRefOid,headRefName,baseRefName,mergedAt,isCrossRepository',
      '--limit',
      '20',
    ],
    { cwd: repoRoot },
  );
  if (listed.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout.trim() || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  interface RawPr {
    number?: unknown;
    headRefOid?: unknown;
    headRefName?: unknown;
    baseRefName?: unknown;
    mergedAt?: unknown;
    isCrossRepository?: unknown;
  }
  const candidates = (parsed as RawPr[]).filter(
    (pr): pr is { number: number; headRefOid: string; mergedAt: string } =>
      pr !== null &&
      typeof pr === 'object' &&
      pr.isCrossRepository === false &&
      pr.headRefName === promoteBranch &&
      pr.baseRefName === baseBranch &&
      typeof pr.number === 'number' &&
      Number.isInteger(pr.number) &&
      pr.number > 0 &&
      typeof pr.headRefOid === 'string' &&
      OBJECT_ID_PATTERN.test(pr.headRefOid) &&
      typeof pr.mergedAt === 'string' &&
      pr.mergedAt !== '',
  );
  if (candidates.length === 0) return null;
  // Newest merge wins. PRs can merge out of numeric order, so `mergedAt` is
  // authoritative and the number is only a deterministic tiebreak.
  candidates.sort((a, b) => {
    if (a.mergedAt !== b.mergedAt) return a.mergedAt < b.mergedAt ? 1 : -1;
    return b.number - a.number;
  });
  const landed = candidates[0];
  if (landed === undefined) return null;

  const fetched = await runGit(exec, repoRoot, [
    'fetch',
    '--no-tags',
    remote,
    `+refs/pull/${landed.number}/head:${LANDED_SCRATCH_REF}`,
    `+refs/heads/${baseBranch}:${BASE_SCRATCH_REF}`,
  ]);
  if (fetched.code !== 0) return null;
  const resolved = await runGit(exec, repoRoot, ['rev-parse', LANDED_SCRATCH_REF]);
  // The fetched commit MUST be exactly the head GitHub reported; a mismatch
  // means the ref moved or the API answer is stale — refuse to act on it.
  if (resolved.code !== 0 || resolved.stdout.trim() !== landed.headRefOid) return null;
  // Scan ONLY the PR-exclusive ancestry (`--not <base>`): the repo squash-merges,
  // so the promotion's own commits never become ancestors of `main`. Without
  // this bound a deep CI-recovery stack would push the scan into inherited
  // `main` history, where any commit message could be read as an instruction to
  // delete a branch. Every candidate must additionally carry the exact generated
  // promotion subject, so a repair commit cannot forge a source snapshot.
  const log = await runGit(exec, repoRoot, [
    'log',
    `-${LANDED_TRAILER_SCAN_DEPTH}`,
    '--format=%B%x00',
    LANDED_SCRATCH_REF,
    '--not',
    BASE_SCRATCH_REF,
  ]);
  if (log.code !== 0) return null;
  // A subject alone is not provenance: a repair commit could simply reuse it and
  // shadow the genuine promotion. A promotion PR contains EXACTLY ONE commit
  // with this subject (the reconciler creates one per branch, and the branch is
  // deleted on merge), so more than one means something forged it — fail closed.
  const promotionCommits = log.stdout
    .split('\0')
    .filter((m) => m.trimStart().split('\n')[0]?.trim() === PROMOTION_SUBJECT);
  if (promotionCommits.length !== 1) return null;
  const sources = parseSourceTrailers(promotionCommits[0] ?? '');
  if (sources.queueSha === null && sources.orphans.length === 0) return null;
  return { prNumber: landed.number, headSha: landed.headRefOid, sources };
}

/**
 * True when `sourceRef` provably adds NOTHING to the current `baseRef` across
 * the art surface — the precondition for retiring it.
 *
 * This is the revert guard. "The promotion merged" alone does NOT prove the art
 * is still on `main`: a later revert (or a force-reset of `main`) puts the bytes
 * back only on the source branches, and retiring them then would destroy the
 * last copy. Re-deriving the source's delta against `main` AT TIDY-UP TIME makes
 * that impossible — a reverted path is once again an `AM` difference, so the
 * source is left in place.
 *
 * NOTE: this deliberately does NOT apply {@link filterPromotablePaths}. That
 * filter answers "should we PROMOTE these bytes again", and a reverted-off-main
 * path is exactly a superseded one — treating it as "adds nothing" would delete
 * the branch holding the only remaining copy. Convergence does not need
 * retirement: a superseded source contributes no promotable path, so it produces
 * a `noop` cycle whether or not it is ever retired.
 *
 * Fail closed: any git failure answers `false` (do not retire).
 */
async function sourceAddsNothingToBase(
  exec: Exec,
  repoRoot: string,
  baseRef: string,
  sourceRef: string,
  options?: { readonly dropLegacyAggregateManifestPaths?: boolean },
): Promise<boolean> {
  const delta = await runGit(exec, repoRoot, [
    'diff',
    '--no-renames',
    '--name-only',
    '--diff-filter=AM',
    baseRef,
    sourceRef,
    '--',
    ...ART_SURFACE_ALLOWLIST,
  ]);
  if (delta.code !== 0) return false;
  const paths = parseNameOnly(delta.stdout);
  return (
    (options?.dropLegacyAggregateManifestPaths === true
      ? paths.filter((p) => !isLegacyAggregateManifestPath(p))
      : paths
    ).length === 0
  );
}

/** What a tidy-up pass retired. */
export interface TidyUpResult {
  /** True when `assets/queue` was fast-forwarded onto `main` this cycle. */
  readonly queueReset: boolean;
  /** Orphan branches deleted this cycle (deterministically ordered). */
  readonly deletedBranches: readonly string[];
}

/**
 * Retire the source snapshots that a MERGED promotion already landed.
 *
 * This is the step that makes the reconciler CONVERGE. Without it no source is
 * ever retired: `assets/queue` keeps re-offering art that `main` has since
 * superseded, and every orphaned `assets/checkin-*` branch is re-harvested every
 * hour forever (44 of them, the oldest from 2026-07-08), so the `noop` guard is
 * unreachable and a promotion PR is opened on every single cycle.
 *
 * Safety model — every destructive step is a compare-and-swap against the EXACT
 * OID the merged promotion recorded harvesting:
 *   - the queue is reset ONLY when its tip is still byte-identical to the
 *     harvested snapshot, so an approve/edit that landed after the harvest can
 *     never be discarded (its push moves the tip, the lease misses, we skip);
 *   - an orphan branch is deleted ONLY when its tip still equals the harvested
 *     snapshot, so a branch that gained new art after the harvest survives;
 *   - the promotion must be MERGED (`--state merged`), so the harvested art is
 *     provably already on `main` before anything is retired.
 * Every failure is non-fatal and simply leaves the source in place for the next
 * cycle.
 */
export async function tidyUpLandedPromotion(
  exec: Exec,
  repoRoot: string,
  options: {
    readonly remote: string;
    readonly repo: string | undefined;
    readonly promoteBranch: string;
    readonly baseBranch: string;
    readonly queueBranch: string;
  },
): Promise<TidyUpResult> {
  const { remote, repo, promoteBranch, baseBranch, queueBranch } = options;
  const landed = await findLandedPromotion(exec, repoRoot, remote, repo, promoteBranch, baseBranch);
  if (landed === null) return { queueReset: false, deletedBranches: [] };

  // `findLandedPromotion` left the CURRENT base tip in BASE_SCRATCH_REF. EVERY
  // retirement below is proven against — and pushed against — that ONE snapshot,
  // so a proof can never be paired with a different base than the one it used.
  const baseResolved = await runGit(exec, repoRoot, ['rev-parse', BASE_SCRATCH_REF]);
  if (baseResolved.code !== 0) return { queueReset: false, deletedBranches: [] };
  const mainSha = baseResolved.stdout.trim();
  if (!OBJECT_ID_PATTERN.test(mainSha)) return { queueReset: false, deletedBranches: [] };

  /**
   * Re-assert the base snapshot immediately before a destructive push. `git push`
   * can only lease the ref it is writing, so the base cannot be part of the same
   * atomic update; re-reading it here narrows the window to the push itself.
   * Any movement aborts the remaining tidy-up rather than acting on a stale proof.
   *
   * Residual window: a revert landing inside that window could still let a
   * deletion through. It is recoverable — the merged promotion commit durably
   * records every retired branch's exact OID in its `Orphan-Source:` trailers, so
   * `git push origin <sha>:refs/heads/<branch>` restores it.
   */
  const baseUnchanged = async (): Promise<boolean> =>
    (await remoteBranchSha(exec, repoRoot, remote, baseBranch)) === mainSha;

  /**
   * Fetch a source tip locally, CAS-check it, and prove it adds nothing to base.
   * Pre-shard orphan branches may differ only by the legacy aggregate manifest,
   * which `runReconcile` already refuses to promote; queue snapshots are checked
   * against the FULL promoted art surface because queue harvest still includes
   * tolerated top-level generated JSON such as `manifest.json`.
   */
  const retirable = async (
    branch: string,
    expectedSha: string,
    options?: { readonly dropLegacyAggregateManifestPaths?: boolean },
  ): Promise<boolean> => {
    const currentTip = await remoteBranchSha(exec, repoRoot, remote, branch);
    // Already gone, or advanced past the harvested snapshot → never retire.
    if (currentTip === null || currentTip !== expectedSha) return false;
    const fetched = await runGit(exec, repoRoot, [
      'fetch',
      '--no-tags',
      remote,
      `+refs/heads/${branch}:${SOURCE_SCRATCH_REF}`,
    ]);
    if (fetched.code !== 0) return false;
    const resolved = await runGit(exec, repoRoot, ['rev-parse', SOURCE_SCRATCH_REF]);
    if (resolved.code !== 0 || resolved.stdout.trim() !== expectedSha) return false;
    return sourceAddsNothingToBase(exec, repoRoot, BASE_SCRATCH_REF, SOURCE_SCRATCH_REF, options);
  };

  let queueReset = false;
  const { queueSha } = landed.sources;
  if (
    queueSha !== null &&
    mainSha !== queueSha &&
    (await retirable(queueBranch, queueSha)) &&
    (await baseUnchanged())
  ) {
    const push = await runGit(exec, repoRoot, [
      'push',
      '--no-verify',
      `--force-with-lease=refs/heads/${queueBranch}:${queueSha}`,
      remote,
      `${mainSha}:refs/heads/${queueBranch}`,
    ]);
    queueReset = push.code === 0;
  }

  const deletedBranches: string[] = [];
  for (const orphan of landed.sources.orphans) {
    if (!(await retirable(orphan.branch, orphan.sha, { dropLegacyAggregateManifestPaths: true })))
      continue;
    // Abort the whole sweep (not just this branch) the moment the base moves.
    if (!(await baseUnchanged())) break;
    const deleted = await runGit(exec, repoRoot, [
      'push',
      '--no-verify',
      `--force-with-lease=refs/heads/${orphan.branch}:${orphan.sha}`,
      remote,
      `:refs/heads/${orphan.branch}`,
    ]);
    if (deleted.code === 0) deletedBranches.push(orphan.branch);
  }

  return { queueReset, deletedBranches: deletedBranches.sort() };
}

/**
 * Discover `assets/checkin-*` branches on the remote that have no currently-open
 * PR pointing to them. These represent approved art that was checked in locally
 * but never consolidated into a batch or promote PR.
 *
 * Non-fatal: any query failure returns an empty list so the reconciler degrades
 * gracefully. Exported for deterministic unit testing.
 */
export async function scanOrphanedCheckinBranches(
  exec: Exec,
  repoRoot: string,
  remote: string,
  repo: string | undefined,
): Promise<string[]> {
  // 1. List all assets/checkin-* branches on the remote.
  const lsr = await exec('git', ['ls-remote', '--heads', remote, 'assets/checkin-*'], {
    cwd: repoRoot,
  });
  if (lsr.code !== 0 || lsr.stdout.trim() === '') return [];
  const allBranches = lsr.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => {
      const tab = l.indexOf('\t');
      return tab < 0 ? '' : l.slice(tab + 1).replace(/^refs\/heads\//, '');
    })
    .filter((b) => b.startsWith('assets/checkin-'));

  if (allBranches.length === 0) return [];

  // 2. Get open PR head branches to cross-reference. Fail closed on any error:
  //    harvesting branches whose PRs are unknown risks overwriting active art.
  const prResult = await exec(
    'gh',
    ['pr', 'list', ...repoArgs(repo), '--state', 'open', '--json', 'headRefName', '--limit', '500'],
    { cwd: repoRoot },
  );
  if (prResult.code !== 0) return [];
  const openBranches = new Set<string>();
  try {
    const parsed = JSON.parse(prResult.stdout.trim() || '[]') as Array<{
      headRefName?: string;
    }>;
    for (const pr of parsed) {
      if (typeof pr.headRefName === 'string') openBranches.add(pr.headRefName);
    }
  } catch {
    // JSON parse failure: fail closed — don't harvest when PR state is unknown.
    return [];
  }

  // 3. Return branches not referenced by any open PR.
  // 3. Return branches not referenced by any open PR, in a deterministic order.
  //    Overlay order decides the winner when two sources disagree about a path,
  //    so it must never depend on the remote's `ls-remote` output ordering.
  return allBranches.filter((b) => !openBranches.has(b)).sort();
}

/** Result of locating the open promote PR: its number and current labels. */
interface OpenPromotePr {
  readonly number: number;
  /** Label names currently on the PR (used to decide whether to re-ensure `MERGE_TRAIN_LABEL`). */
  readonly labels: readonly string[];
}

/**
 * Find the single open PR for `promoteBranch → baseBranch` **in the base repo**.
 * Returns its number + current labels, or null when none is open.
 *
 * SECURITY: `gh pr list --head <branch>` filters by branch NAME only — it cannot
 * scope the head to the base repository, so a fork PR whose head branch is also
 * named `assets/promote` would otherwise be matched, edited, and armed for
 * `--auto --squash` on a foreign (unguarded) diff. We therefore request
 * `isCrossRepository` + `headRefName` and DISCARD any cross-repository PR (and
 * any whose head branch name does not exactly match), so only a same-repo
 * `assets/promote → main` PR — the one the reconciler itself owns — is ever
 * reused/armed.
 */
async function findOpenPromotePr(
  exec: Exec,
  cwd: string,
  repo: string | undefined,
  promoteBranch: string,
  baseBranch: string,
): Promise<OpenPromotePr | null> {
  const out = await mustGh(exec, cwd, [
    'pr',
    'list',
    ...repoArgs(repo),
    '--head',
    promoteBranch,
    '--base',
    baseBranch,
    '--state',
    'open',
    '--json',
    'number,headRefName,isCrossRepository,labels',
    '--limit',
    '100',
  ]);
  let parsed: Array<{
    number?: number;
    headRefName?: string;
    isCrossRepository?: boolean;
    // `gh`'s `labels` JSON field is an array of `{ name }` objects, not bare strings.
    labels?: Array<{ name?: string }>;
  }>;
  try {
    parsed = JSON.parse(out.trim() || '[]') as Array<{
      number?: number;
      headRefName?: string;
      isCrossRepository?: boolean;
      labels?: Array<{ name?: string }>;
    }>;
  } catch (err) {
    throw new ReconcileError(
      'gh-failed',
      `Could not parse gh pr list JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const matches = parsed
    .filter((p) => p.isCrossRepository !== true && p.headRefName === promoteBranch)
    .filter((p): p is typeof p & { number: number } => typeof p.number === 'number');
  // Deterministic: pick the lowest-numbered open PR if (unexpectedly) more than
  // one exists, so re-runs converge on the same PR instead of flapping.
  matches.sort((a, b) => a.number - b.number);
  const first = matches[0];
  if (!first) return null;
  return {
    number: first.number,
    labels: (first.labels ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === 'string'),
  };
}

/**
 * Run one reconcile cycle. See the module doc for the full architecture.
 * Never mutates any local working branch/index/HEAD (all work happens in a
 * throwaway detached worktree); remote mutations are limited to lease-guarded
 * source retirement (`assets/queue` reset + orphan branch deletions) plus a
 * force-update of the sole-writer promotion branch and PR open/edit/arm.
 */
export async function runReconcile(
  repoRoot: string,
  deps: ReconcileDeps,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const remote = options.remote ?? DEFAULT_REMOTE;
  const queueBranch = options.queueBranch ?? DEFAULT_QUEUE_BRANCH;
  const promoteBranch = options.promoteBranch ?? DEFAULT_PROMOTE_BRANCH;
  const baseBranch = options.baseBranch ?? DEFAULT_BASE_BRANCH;
  const repo = options.repo;
  const withLock = deps.withCrossProcessLock ?? ((fn) => fn());

  return withLock(async () => {
    // 0. TIDY-UP: retire the source snapshots a previously-MERGED promotion
    //    already landed. This runs FIRST, before any ref is read, so the rest of
    //    the cycle sees the post-tidy state. It is what makes the reconciler
    //    converge instead of oscillating — see the trailer documentation above.
    //    Non-fatal by design: a tidy-up failure must never block a promotion.
    let tidyUp: TidyUpResult = { queueReset: false, deletedBranches: [] };
    try {
      tidyUp = await tidyUpLandedPromotion(deps.exec, repoRoot, {
        remote,
        repo,
        promoteBranch,
        baseBranch,
        queueBranch,
      });
    } catch {
      /* non-fatal: leave every source in place and reconcile as usual */
    }

    // 1. Check whether the queue branch exists. `ls-remote` cleanly distinguishes
    //    "absent" (empty stdout) from a real network/auth error (non-zero exit).
    const lsr = await runGit(deps.exec, repoRoot, ['ls-remote', '--heads', remote, queueBranch]);
    if (lsr.code !== 0) {
      throw new ReconcileError(
        'git-failed',
        `git ls-remote --heads ${remote} ${queueBranch} failed (exit ${lsr.code}): ${
          lsr.stderr || lsr.stdout
        }`,
      );
    }
    const queueExists = lsr.stdout.trim() !== '';

    // 1b. Discover orphaned branches BEFORE the cold-start return so a repo
    //     with no queue branch but with orphaned assets/checkin-* branches still
    //     reconciles. Non-fatal: scan failure → treat as empty orphan set.
    const orphanedBranches = await scanOrphanedCheckinBranches(
      deps.exec,
      repoRoot,
      remote,
      repo,
    ).catch(() => [] as string[]);

    if (!queueExists && orphanedBranches.length === 0) {
      return {
        status: 'noop',
        promoteBranch,
        tidiedQueue: tidyUp.queueReset,
        tidiedBranches: tidyUp.deletedBranches,
      };
    }

    // 2. Fetch the branches we compare/branch from. The promote branch may not
    //    exist yet (first run), so probe it before adding it to the fetch set.
    const promoteLsr = await runGit(deps.exec, repoRoot, [
      'ls-remote',
      '--heads',
      remote,
      promoteBranch,
    ]);
    if (promoteLsr.code !== 0) {
      throw new ReconcileError(
        'git-failed',
        `git ls-remote --heads ${remote} ${promoteBranch} failed (exit ${promoteLsr.code}): ${
          promoteLsr.stderr || promoteLsr.stdout
        }`,
      );
    }
    const promoteExists = promoteLsr.stdout.trim() !== '';
    // Only include queue branch in the fetch when it actually exists.
    const fetchRefs = queueExists ? [queueBranch, baseBranch] : [baseBranch];
    if (promoteExists) fetchRefs.push(promoteBranch);
    await mustGit(deps.exec, repoRoot, ['fetch', '--no-tags', remote, ...fetchRefs]);

    // 2b. Fetch orphaned branches so we can compute deltas. Non-fatal: a fetch
    //     failure for any single branch is ignored (branch is silently skipped).
    for (const branch of orphanedBranches) {
      await runGit(deps.exec, repoRoot, ['fetch', '--no-tags', remote, branch]).catch(
        () => undefined,
      );
    }

    const queueRef = queueExists ? `${remote}/${queueBranch}` : null;
    const baseRef = `${remote}/${baseBranch}`;
    const promoteRef = promoteExists ? `${remote}/${promoteBranch}` : null;

    // 3. Do-we-act detection: TWO-DOT, art-surface-restricted comparison. Two-dot
    //    (direct tree compare of the two tips, not merge-base three-dot) is
    //    REQUIRED here: after a promote PR squash-merges, main gains the art but
    //    the merge-base of main and queue is still pre-squash, so a three-dot
    //    diff would still show the already-landed art forever (PR reopens in a
    //    loop). Two-dot correctly reports "queue's art already in main" ⇒ noop.
    //    --diff-filter=AM limits to Added/Modified paths: files present on main
    //    but ABSENT from queue (D = deleted-in-queue) are skipped deliberately —
    //    they are art that reached main via an independent flow (e.g. the legacy
    //    asset-PR) that queue never saw; promoting a D would revert them, which
    //    is a data-loss bug. We only promote what queue positively contributes.
    //    --no-renames is REQUIRED: git's rename heuristic would otherwise pair a
    //    file deleted-in-queue (a main-only asset, our intended D) with a
    //    content-identical file added-in-queue (genuinely-new queue art, our
    //    intended A) into a single R entry — which --diff-filter=AM drops,
    //    silently omitting real queue art from the promotion. Disabling rename
    //    detection keeps A and D independent and the delta deterministic.
    // Paths a source offered that the convergence guard withheld. Reported on
    // the result (and therefore in the workflow log) so a genuinely-blocked
    // approval is visible instead of silently dropped.
    const withheld = new Set<string>();
    const keepPromotable = async (
      ref: string,
      candidates: readonly string[],
    ): Promise<string[]> => {
      const promotable = await filterPromotablePaths(deps.exec, repoRoot, baseRef, ref, candidates);
      const kept = new Set(promotable);
      for (const p of candidates) if (!kept.has(p)) withheld.add(p);
      return promotable;
    };

    let queueVsMainArt: readonly string[] = [];
    if (queueRef !== null) {
      const delta = await mustGit(deps.exec, repoRoot, [
        'diff',
        '--no-renames',
        '--name-only',
        '--diff-filter=AM',
        baseRef,
        queueRef,
        '--',
        ...ART_SURFACE_ALLOWLIST,
      ]);
      // Convergence guard: promote only bytes `main` has never carried and that
      // do not clobber a main-side change the queue never saw (see
      // `filterPromotablePaths`) — that ping-pong reopened this PR every hour.
      queueVsMainArt = await keepPromotable(queueRef, parseNameOnly(delta));
    }

    // 3b. Compute art deltas for each orphaned branch (two-dot AM only, art
    //     surface restricted — same rationale as the queue delta above). Branches
    //     that are inaccessible after fetch are silently skipped.
    //     Pre-sharding aggregate manifest paths (e.g. manifest.json directly
    //     under public/assets/generated/) are filtered out: those files are
    //     gitignored build artifacts in the sharded layout and must never be
    //     raw-checked-out onto main.
    const orphanedPathsByBranch: Array<{ branch: string; ref: string; paths: string[] }> = [];
    for (const branch of orphanedBranches) {
      const ref = `${remote}/${branch}`;
      const orphanDelta = await runGit(deps.exec, repoRoot, [
        'diff',
        '--no-renames',
        '--name-only',
        '--diff-filter=AM',
        baseRef,
        ref,
        '--',
        ...ART_SURFACE_ALLOWLIST,
      ]);
      if (orphanDelta.code !== 0) continue;
      const candidates = parseNameOnly(orphanDelta.stdout).filter(
        (p) => !isLegacyAggregateManifestPath(p),
      );
      // Same convergence guard as the queue delta: an orphan branch that has sat
      // unmerged for weeks holds art `main` has long since superseded (and a
      // stale `sprite-catalog.json`), and re-overlaying it is what kept every
      // source permanently "dirty".
      const paths = await keepPromotable(ref, candidates);
      if (paths.length > 0) orphanedPathsByBranch.push({ branch, ref, paths });
    }

    if (queueVsMainArt.length === 0 && orphanedPathsByBranch.length === 0) {
      // Queue's art surface already matches main and no orphaned branches
      // contribute new art. This noop path does NOT reset assets/queue; any
      // safe retirement already happened in the leased tidy-up step above.
      return {
        status: 'noop',
        promoteBranch,
        tidiedQueue: tidyUp.queueReset,
        tidiedBranches: tidyUp.deletedBranches,
        withheldPaths: [...withheld].sort(),
      };
    }

    // 4. Harvest queue's art surface onto CURRENT main in a throwaway worktree.
    const worktree = await deps.makeTempDir();
    let promoteCommit: string;
    let changedPaths: readonly string[];
    try {
      // Detached checkout of current main; we push the promote ref by refspec and
      // never check the promote branch out by name, so there is no
      // "branch already checked out" clash with the caller's worktree.
      await mustGit(deps.exec, repoRoot, ['worktree', 'add', worktree, '--detach', baseRef]);

      // Overlay ONLY the art surface from the queue tip. `git checkout <ref> --
      // <specific-paths>` takes exactly those paths from queue (all of which the
      // --diff-filter=AM above guarantees exist in queueRef — no D/deleted paths
      // are in the list), leaving everything else in main's worktree untouched.
      // This prevents reverting art that reached main via an independent flow
      // (e.g. the legacy asset-PR) without ever being committed to the queue.
      if (queueVsMainArt.length > 0 && queueRef !== null) {
        await mustGit(deps.exec, worktree, ['checkout', queueRef, '--', ...queueVsMainArt]);
        await mustGit(deps.exec, worktree, ['add', '--', ...queueVsMainArt]);
      }

      // Also overlay art from orphaned checkin branches. Each branch contributes
      // only its AM paths (pre-computed above, two-dot vs main), so we never
      // revert art that arrived via another flow. Later overlays win on collision
      // (last-writer semantics, consistent with the queue union).
      for (const { ref, paths } of orphanedPathsByBranch) {
        await mustGit(deps.exec, worktree, ['checkout', ref, '--', ...paths]);
        await mustGit(deps.exec, worktree, ['add', '--', ...paths]);
      }

      // No-op guard: if nothing staged, main already carries identical art bytes
      // (the two-dot path delta can list paths whose CONTENT is unchanged after
      // normalization — e.g. line-ending or ordering — so re-check post-add).
      const staged = await runGit(deps.exec, worktree, ['diff', '--cached', '--quiet']);
      if (staged.code === 0) {
        return {
          status: 'noop',
          promoteBranch,
          tidiedQueue: tidyUp.queueReset,
          tidiedBranches: tidyUp.deletedBranches,
        };
      }

      // The authoritative set of paths this promotion will change vs main.
      // --no-renames for the same determinism/robustness reason as the delta
      // diff above: never let a rename heuristic collapse staged art paths into
      // an R entry the guard would then have to unpick.
      const stagedNames = await mustGit(deps.exec, worktree, [
        'diff',
        '--cached',
        '--no-renames',
        '--name-only',
      ]);
      changedPaths = parseNameOnly(stagedNames);

      // 5. TRUST-BOUNDARY GUARD (defense-in-depth). Refuse + escalate on ANY
      //    non-art path before we commit/push/arm.
      assertArtSurfaceOnly(changedPaths, baseBranch);

      // 5b. MODE-AWARE guard: `--name-only` cannot see a tree-entry TYPE change
      //     (file → symlink/gitlink/executable) at an allowlisted path, which
      //     would land a non-blob entry on main. Inspect the staged raw diff and
      //     refuse any non-regular-file destination mode. `--no-renames` +
      //     `core.quotePath=false` keep the output deterministic and unescaped.
      const stagedRaw = await mustGit(deps.exec, worktree, [
        '-c',
        'core.quotePath=false',
        'diff',
        '--cached',
        '--raw',
        '--no-renames',
      ]);
      assertArtSurfaceModes(stagedRaw, baseBranch);

      // Deterministic commit message (injected clock). The `Queue-Source` /
      // `Orphan-Source` trailers record the EXACT tips this promotion harvested
      // so the next cycle can retire precisely those snapshots once this
      // promotion merges (see the trailer documentation above).
      const harvestedSources: PromotionSources = {
        queueSha:
          queueVsMainArt.length > 0 && queueRef !== null
            ? (await mustGit(deps.exec, repoRoot, ['rev-parse', queueRef])).trim()
            : null,
        orphans: await Promise.all(
          orphanedPathsByBranch.map(async ({ branch, ref }) => ({
            branch,
            sha: (await mustGit(deps.exec, repoRoot, ['rev-parse', ref])).trim(),
          })),
        ),
      };
      const trailers = formatSourceTrailers(harvestedSources);
      const message =
        `${PROMOTION_SUBJECT}\n\n` +
        `Art-surface harvest of ${queueBranch} onto ${baseBranch} ` +
        `(${changedPaths.length} path(s)).` +
        (trailers === '' ? '' : `\n\n${trailers}`);
      await mustGit(deps.exec, worktree, ['commit', '--no-verify', '-m', message]);
      promoteCommit = (await mustGit(deps.exec, worktree, ['rev-parse', 'HEAD'])).trim();

      // 6. Publish the promotion commit to the sole-writer promote branch.
      //    - First creation (ref absent): a PLAIN push — there is nothing to
      //      clobber, and it fails loudly if the ref raced into existence.
      //    - Update (ref present): `--force-with-lease` with an EXPLICIT expected
      //      OID (the tip we fetched) makes the force-update a safe
      //      compare-and-swap. The reconciler is the ONLY writer (workflow
      //      `concurrency:` single lane), so a lease miss means an unexpected
      //      concurrent writer — fail loudly rather than clobber.
      if (promoteExists) {
        const expected = promoteRef
          ? (await mustGit(deps.exec, repoRoot, ['rev-parse', promoteRef])).trim()
          : '';
        await mustGit(deps.exec, repoRoot, [
          'push',
          '--no-verify',
          `--force-with-lease=refs/heads/${promoteBranch}:${expected}`,
          remote,
          `${promoteCommit}:refs/heads/${promoteBranch}`,
        ]);
      } else {
        await mustGit(deps.exec, repoRoot, [
          'push',
          '--no-verify',
          remote,
          `${promoteCommit}:refs/heads/${promoteBranch}`,
        ]);
      }
    } finally {
      // Cleanup must never mask the primary result/error. `deps.removeDir` may
      // throw synchronously (rmSync + Windows EPERM on a transiently-locked
      // worktree dir), so wrap both cleanup calls.
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
    }

    // 7. Open or update the ONE promote → main PR (idempotent; never duplicate).
    //    Compute closing issue numbers non-fatally (transient gh failure must
    //    never abort the reconcile cycle; we just omit the closing keywords).
    const closingIssueDiscovery = await computeClosingIssueNumbers(
      deps.exec,
      repoRoot,
      baseRef,
      repo,
      promoteCommit,
    );
    const closingIssueNumbers = closingIssueDiscovery.issueNumbers;
    const { title, body } = buildPrContent(
      changedPaths,
      promoteCommit,
      deps.now(),
      queueBranch,
      promoteBranch,
      baseBranch,
      closingIssueNumbers,
      orphanedPathsByBranch.length,
    );
    const existing = await findOpenPromotePr(deps.exec, repoRoot, repo, promoteBranch, baseBranch);
    let prNumber: number;
    let created: boolean;
    if (existing === null) {
      // Create. Handle the create-race (a concurrent run or a manual dispatch
      // opened it between our list and create) by re-querying and reusing.
      // A brand-new PR can never carry any of the train's revocation labels
      // yet, so the enrollment label is always safe to apply at create time.
      const createResult = await deps.exec(
        'gh',
        [
          'pr',
          'create',
          ...repoArgs(repo),
          '--head',
          promoteBranch,
          '--base',
          baseBranch,
          '--title',
          title,
          '--body',
          body,
          '--label',
          MERGE_TRAIN_LABEL,
        ],
        { cwd: repoRoot },
      );
      if (createResult.code === 0) {
        const reQueried = await findOpenPromotePr(
          deps.exec,
          repoRoot,
          repo,
          promoteBranch,
          baseBranch,
        );
        if (reQueried === null) {
          throw new ReconcileError(
            'gh-failed',
            `gh pr create reported success but no open ${promoteBranch} → ${baseBranch} PR was found.`,
          );
        }
        prNumber = reQueried.number;
        created = true;
      } else {
        // Create failed — most commonly because a PR already exists (race). Fall
        // back to re-query + reuse; only if there is STILL no open PR is this a
        // real failure.
        const reQueried = await findOpenPromotePr(
          deps.exec,
          repoRoot,
          repo,
          promoteBranch,
          baseBranch,
        );
        if (reQueried === null) {
          throw new ReconcileError(
            'gh-failed',
            `gh pr create failed (exit ${createResult.code}) and no open PR exists: ${
              createResult.stderr || createResult.stdout
            }`,
          );
        }
        // This PR was NOT created by the `--label` call above (our create
        // attempt failed) — it was opened by a concurrent run/dispatch, so it
        // may not carry `merge-train` yet. Re-ensure it the same way the
        // normal update path does, so this race can't silently reproduce the
        // blocked-forever bug this reconciler is meant to fix.
        await reEnsureMergeTrainLabel(deps.exec, repoRoot, repo, reQueried);
        prNumber = reQueried.number;
        created = false;
      }
    } else {
      // Update the existing open PR's title/body to describe the current batch.
      await mustGh(deps.exec, repoRoot, [
        'pr',
        'edit',
        String(existing.number),
        ...repoArgs(repo),
        '--title',
        title,
        '--body',
        body,
      ]);
      // Re-ensure the enrollment label EVERY cycle: `crawler-ci[bot]` has been
      // observed stripping it mid-cycle (see #1916's event log), so a
      // one-time apply at create is insufficient. Only skip when the train
      // has deliberately revoked/withheld enrollment (or landed the PR) —
      // see MERGE_TRAIN_RE_ENSURE_EXCLUDE_LABELS above.
      await reEnsureMergeTrainLabel(deps.exec, repoRoot, repo, existing);
      prNumber = existing.number;
      created = false;
    }

    // 8. Arm auto-merge (squash) only when issue-closure discovery completed.
    // If discovery fails, defer arming so the next cycle can restore the PR body
    // closure contract before merge.
    let armed = false;
    if (closingIssueDiscovery.complete) {
      await mustGh(deps.exec, repoRoot, [
        'pr',
        'merge',
        String(prNumber),
        ...repoArgs(repo),
        '--auto',
        '--squash',
        '--match-head-commit',
        promoteCommit,
      ]);
      armed = true;
    }

    return {
      status: 'pr-open',
      promoteBranch,
      prNumber,
      created,
      armed,
      promoteCommit,
      changedPaths,
      closingIssueNumbers,
      closingIssueDiscoveryComplete: closingIssueDiscovery.complete,
      orphanedBranchCount: orphanedPathsByBranch.length,
      tidiedQueue: tidyUp.queueReset,
      tidiedBranches: tidyUp.deletedBranches,
      withheldPaths: [...withheld].sort(),
    };
  });
}

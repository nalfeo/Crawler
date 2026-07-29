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
 * `assets/queue` is DELIBERATELY never reset here. It churns during the ~1h
 * cycle; resetting it to `main` post-merge would silently drop edits that landed
 * after the harvest snapshot — the exact loss vector this feature eliminates.
 * The no-op condition (queue's art already present in main) makes an explicit
 * reset unnecessary: once editing stops, the delta goes to zero and the
 * reconciler no-ops. (Deferred tidy-up is PR3.)
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
import { ART_SURFACE_ALLOWLIST, ASSET_CHECKIN_LABEL, type Exec } from './checkin.js';

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
   * Issue numbers for open `asset-checkin` issues whose complete asset payload
   * is fully covered by this promotion (and will therefore be closed by it).
   * Empty when no issues are fully covered or the issue list query fails.
   */
  readonly closingIssueNumbers?: readonly number[];
  /** True when issue-closure discovery completed successfully. */
  readonly closingIssueDiscoveryComplete?: boolean;
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
 * `src/shared/data/sprite-catalog.json` OR lives under `public/assets/generated/`.
 * Matches `detect-art-only.sh` (and PR1's `ART_SURFACE_ALLOWLIST`) EXACTLY so the
 * guard and the CI art-only classifier agree by construction — a promote→main
 * diff the guard accepts is precisely one `ci.yml` classifies `art_only=true`.
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
    '',
    '### Changed art-surface paths',
    '',
    list,
    '',
    '<sub>Opened by the hourly sprite-queue reconciler',
    '(`scripts/sprites/reconcile-queue.ts`). See',
    'ADR `2026-07-24-sprite-queue-reconciler`.</sub>',
    '',
  ];
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
    ['ls-tree', '--name-only', '-r', promotedRef, '--', ...ART_SURFACE_ALLOWLIST],
    { cwd: repoRoot },
  );
  if (lsResult.code !== 0) return { issueNumbers: [], complete: false };
  const promotedPaths = new Set<string>(
    lsResult.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
  );

  const manifestResult = await exec(
    'git',
    ['show', `${promotedRef}:public/assets/generated/manifest.json`],
    { cwd: repoRoot },
  );
  if (manifestResult.code !== 0) return { issueNumbers: [], complete: false };
  let parsedManifest: { entries?: Record<string, unknown> };
  try {
    parsedManifest = JSON.parse(manifestResult.stdout) as { entries?: Record<string, unknown> };
  } catch {
    return { issueNumbers: [], complete: false };
  }
  const manifestEntries = parsedManifest.entries ?? {};
  const manifestHashes = new Map<string, string>();
  for (const entry of Object.values(manifestEntries)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const assetPath = (entry as { assetPath?: unknown }).assetPath;
    const contentHash = (entry as { contentHash?: unknown }).contentHash;
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
 * throwaway detached worktree); the only remote mutation is a force-update of
 * the sole-writer promotion branch + PR open/edit/arm.
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
    // 1. Cold start: if the queue branch does not exist yet, there is nothing to
    //    reconcile. `ls-remote` cleanly distinguishes "absent" (empty stdout)
    //    from a real network/auth error (non-zero exit).
    const lsr = await runGit(deps.exec, repoRoot, ['ls-remote', '--heads', remote, queueBranch]);
    if (lsr.code !== 0) {
      throw new ReconcileError(
        'git-failed',
        `git ls-remote --heads ${remote} ${queueBranch} failed (exit ${lsr.code}): ${
          lsr.stderr || lsr.stdout
        }`,
      );
    }
    if (lsr.stdout.trim() === '') {
      return { status: 'noop', promoteBranch };
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
    const fetchRefs = [queueBranch, baseBranch];
    if (promoteExists) fetchRefs.push(promoteBranch);
    await mustGit(deps.exec, repoRoot, ['fetch', '--no-tags', remote, ...fetchRefs]);

    const queueRef = `${remote}/${queueBranch}`;
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
    const queueVsMainArt = parseNameOnly(delta);
    if (queueVsMainArt.length === 0) {
      // Queue's art surface already matches main (steady state after a merge, or
      // no pending edits). Deliberately DO NOT reset assets/queue (data-loss
      // trap): it keeps accumulating and the next non-empty delta re-harvests.
      return { status: 'noop', promoteBranch };
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
      await mustGit(deps.exec, worktree, ['checkout', queueRef, '--', ...queueVsMainArt]);
      await mustGit(deps.exec, worktree, ['add', '--', ...queueVsMainArt]);

      // No-op guard: if nothing staged, main already carries identical art bytes
      // (the two-dot path delta can list paths whose CONTENT is unchanged after
      // normalization — e.g. line-ending or ordering — so re-check post-add).
      const staged = await runGit(deps.exec, worktree, ['diff', '--cached', '--quiet']);
      if (staged.code === 0) {
        return { status: 'noop', promoteBranch };
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

      // Deterministic commit message (injected clock).
      const message =
        `chore(assets): reconcile queued sprite edits\n\n` +
        `Art-surface harvest of ${queueBranch} onto ${baseBranch} ` +
        `(${changedPaths.length} path(s)).`;
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
    };
  });
}

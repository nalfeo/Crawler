/**
 * Asset check-in: publish locally-approved generated art as a dedicated remote
 * branch + a tracking GitHub issue, WITHOUT opening a pull request.
 *
 * Why no PR? Approving art is a high-frequency, low-risk local action. Opening
 * a PR per approval would drown the queue. Instead each check-in pushes a
 * self-contained `assets/<slug>` branch (the art-surface delta off the default
 * branch) and files an `asset-checkin` issue describing it. A separate skill
 * (`.github/skills/asset-pr/`) later consolidates every open asset-checkin
 * issue into ONE game PR. See docs/knowledge/adr for the rationale.
 *
 * Design for testability:
 *   - `planAssetCheckin()` is PURE — it turns a set of approved assets into the
 *     branch name, commit message, issue title/body (with an embedded
 *     machine-readable payload), and the paths to stage. No IO.
 *   - `runAssetCheckin()` performs the side effects through injected `deps`
 *     (an exec runner + small fs hooks), so unit tests can assert the exact
 *     git/gh command sequence without touching the network or a real repo.
 *
 * Constitutional §3 (Deterministic CI Only / local-only mutation): check-in
 * mutates remote state (push + issue) from locally-approved assets, so it
 * REFUSES when `process.env.CI` is set — same guard as approve.ts's sidecar.
 */

import { hashStringToSeed } from '../../src/shared/random.js';
import { FLOOR2_EQUIPMENT_ART_DEFINITIONS } from '../../src/shared/data/floor2-equipment-art.js';
import { ASSET_REQUEST_LABEL, parseAssetRequestIssueBody } from './asset-request.js';

/**
 * The art surface a check-in WRITES (repo-relative, POSIX separators).
 *
 * Only `public/assets/generated` — which holds both the approved PNGs and the
 * per-asset manifest shards under `entries/`. The aggregate `manifest.json` is a
 * gitignored build artifact and the `generated:` sprite-catalog rows are derived
 * at read-time from the shards, so NEITHER the aggregate nor
 * `src/shared/data/sprite-catalog.json` is part of the check-in write surface
 * anymore. This is what keeps two disjoint check-ins from ever touching the same
 * file.
 *
 * This is NOT the same list as {@link ART_SURFACE_ALLOWLIST}: we stopped
 * producing catalog changes, but in-flight branches and CI's own art-only
 * classifier must still tolerate them.
 */
export const ASSET_SURFACE_PATHS = ['public/assets/generated'] as const;

/**
 * The art surface guards TOLERATE on an existing diff (repo-relative, POSIX).
 *
 * Must match `detect-art-only.sh` EXACTLY so the reconcile guard and the CI
 * art-only classifier agree by construction. It stays a superset of
 * {@link ASSET_SURFACE_PATHS} so branches created before check-ins stopped
 * writing the catalog still reconcile.
 */
export const ART_SURFACE_ALLOWLIST = [
  'public/assets/generated',
  'src/shared/data/sprite-catalog.json',
] as const;

/** Label applied to every check-in tracking issue. */
export const ASSET_CHECKIN_LABEL = 'asset-checkin';

/** Marker that opens the machine-readable JSON payload in an issue body. */
export const ASSET_CHECKIN_MARKER = 'asset-checkin:v1';

/** One approved asset being checked in. */
export interface CheckinAsset {
  /** Repo-relative-under-`public/assets` path, e.g. `generated/foo-var-1.png`. */
  readonly assetPath: string;
  /** Manifest entry key (unique per variant), or null if not in the manifest. */
  readonly manifestKey: string | null;
  /** Owning brief id, or null when unknown. */
  readonly briefId: string | null;
  /** Variant index, or null when unknown. */
  readonly variantIndex: number | null;
  /**
   * SHA-256 (hex) of the approved PNG's bytes, sourced from the manifest
   * entry's `contentHash` (`approve.ts`). Optional so pre-existing issue
   * payloads (filed before this field existed) remain parseable — a missing
   * hash just means durable dedupe can't verify content equality for that
   * asset and must fail closed (see `asset-issues.ts`).
   */
  readonly contentHash?: string;
}

/** Machine-readable payload embedded in the issue body for the consolidator. */
export interface AssetCheckinPayload {
  readonly version: 1;
  /** Workflow state marker for tooling that consumes issue payloads. */
  readonly state?: 'checked-in';
  /** ISO timestamp for when the tracking issue was filed. */
  readonly filedAt?: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly assets: readonly CheckinAsset[];
  /** Source asset-request issues covered by this check-in (if any). */
  readonly assetRequestIssueNumbers?: readonly number[];
}

export interface AssetCheckinPlan {
  readonly branch: string;
  readonly baseBranch: string;
  readonly commitMessage: string;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly labels: readonly string[];
  readonly assets: readonly CheckinAsset[];
  /** Source asset-request issues covered by this check-in (if any). */
  readonly assetRequestIssueNumbers: readonly number[];
  /** Repo-relative paths to stage in the dedicated branch. */
  readonly paths: readonly string[];
}

export type CheckinErrorKind =
  | 'ci-refused'
  | 'nothing-to-checkin'
  | 'git-failed'
  | 'gh-failed'
  /** Queued elsewhere at the SAME assetPath but with a DIFFERENT content hash. */
  | 'content-conflict'
  /** Queued at the SAME assetPath but either side's content hash is unrecorded
   *  (a legacy issue or manifest entry filed before hashes existed) — equality
   *  can never be established from a missing hash, so this fails closed. */
  | 'ambiguous-queued-content'
  /** Another check-in is already in progress in this repository (cross-process
   *  file lock held). The caller should retry after a brief delay. */
  | 'checkin-locked';

export class CheckinError extends Error {
  constructor(
    readonly kind: CheckinErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CheckinError';
  }
}

export interface PlanAssetCheckinInput {
  readonly assets: readonly CheckinAsset[];
  /** Timestamp used for the slug + issue body. */
  readonly now: Date;
  /** Default branch the asset branch is cut from. Defaults to `main`. */
  readonly baseBranch?: string;
  /** Override the generated slug (tests). Defaults to a timestamp + hash slug. */
  readonly slug?: string;
  /** Source asset-request issue numbers covered by this check-in (optional). */
  readonly assetRequestIssueNumbers?: readonly number[];
}

/**
 * Build a deterministic check-in plan from a set of approved assets. Pure.
 */
export function planAssetCheckin(input: PlanAssetCheckinInput): AssetCheckinPlan {
  const baseBranch = input.baseBranch ?? 'main';
  const assets = [...input.assets].sort((a, b) => a.assetPath.localeCompare(b.assetPath));
  const slug = input.slug ?? defaultSlug(assets, input.now);
  const branch = `assets/${slug}`;
  const count = assets.length;
  const noun = count === 1 ? 'asset' : 'assets';

  const commitMessage = `feat(sprites): check in ${count} approved ${noun}`;
  const issueTitle = `Asset check-in: ${count} approved ${noun} (${slug})`;

  const assetRequestIssueNumbers = normalizeIssueNumbers(input.assetRequestIssueNumbers ?? []);
  const payload: AssetCheckinPayload = {
    version: 1,
    state: 'checked-in',
    filedAt: input.now.toISOString(),
    branch,
    baseBranch,
    assets,
    ...(assetRequestIssueNumbers.length > 0 ? { assetRequestIssueNumbers } : {}),
  };
  const issueBody = renderIssueBody(branch, baseBranch, assets, payload);

  return {
    branch,
    baseBranch,
    commitMessage,
    issueTitle,
    issueBody,
    labels: [ASSET_CHECKIN_LABEL],
    assets,
    assetRequestIssueNumbers,
    paths: [...ASSET_SURFACE_PATHS],
  };
}

function defaultSlug(assets: readonly CheckinAsset[], now: Date): string {
  const stamp = formatStamp(now);
  // Short, stable hash of the asset set so two check-ins in the same second
  // still land on distinct branches.
  const key = assets.map((a) => a.manifestKey ?? a.assetPath).join('|');
  const hash = (hashStringToSeed(key) >>> 0).toString(16).padStart(8, '0').slice(0, 6);
  return `checkin-${stamp}-${hash}`;
}

function formatStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

function renderIssueBody(
  branch: string,
  baseBranch: string,
  assets: readonly CheckinAsset[],
  payload: AssetCheckinPayload,
): string {
  const lines: string[] = [];
  lines.push('## Asset check-in');
  lines.push('');
  lines.push(
    `Approved generated art is staged on branch \`${branch}\` (cut from \`${baseBranch}\`).`,
  );
  lines.push('No pull request was opened — the **asset-pr** skill consolidates open');
  lines.push('`asset-checkin` issues into a single game PR.');
  lines.push('');
  lines.push(`### Assets (${assets.length})`);
  for (const asset of assets) {
    const brief = asset.briefId ? ` — brief \`${asset.briefId}\`` : '';
    const variant = asset.variantIndex !== null ? ` (variant ${asset.variantIndex})` : '';
    lines.push(`- \`${asset.assetPath}\`${brief}${variant}`);
  }
  const sourceIssues = payload.assetRequestIssueNumbers ?? [];
  if (sourceIssues.length > 0) {
    lines.push('');
    lines.push(`### Source asset requests (${sourceIssues.length})`);
    for (const issueNumber of sourceIssues) {
      lines.push(`- #${issueNumber}`);
    }
  }
  lines.push('');
  lines.push(
    '<!-- The block below is machine-read by the asset-pr skill. Do not edit by hand. -->',
  );
  lines.push(`<!-- ${ASSET_CHECKIN_MARKER}`);
  lines.push(JSON.stringify(payload));
  lines.push('-->');
  return `${lines.join('\n')}\n`;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type Exec = (
  command: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    /**
     * Environment for the child process. Defaults to the parent `process.env`.
     * Callers that shell out to `git` should inject a non-interactive env
     * (e.g. `GIT_TERMINAL_PROMPT=0`) so a credential prompt can never hang the
     * process indefinitely.
     */
    readonly env?: NodeJS.ProcessEnv;
    /**
     * Hard wall-clock deadline (ms) for the child process. When set and
     * exceeded the process is killed and the exec resolves with a non-zero
     * code. Defaults to no timeout (today's behavior) so existing callers are
     * unaffected.
     */
    readonly timeoutMs?: number;
  },
) => Promise<ExecResult>;

/** Minimal manifest shape the check-in reads to enrich the issue body. */
export interface CheckinManifest {
  readonly entries?: Record<
    string,
    {
      readonly assetPath?: string;
      readonly briefId?: string;
      readonly variantIndex?: number;
      readonly contentHash?: string;
    }
  >;
}

export interface CheckinRunnerDeps {
  /** Runs an external command (git/gh). */
  readonly exec: Exec;
  /**
   * Copy ONLY `assets`' PNGs (plus their manifest/catalog entries) from the
   * live `srcRepoRoot` into the worktree `destRepoRoot`. Must NOT copy the
   * full art surface — assets excluded from `assets` (e.g. already durably
   * queued by another open issue) must be absent from the resulting branch
   * diff so the branch content and the issue payload stay aligned.
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
  /** Read the live manifest (to enrich assets). Defaults to empty on any error. */
  readonly readManifest?: () => Promise<CheckinManifest>;
  /** Open asset-checkin issues keyed by asset path for durable queue deduplication. */
  readonly listQueuedAssets?: () => Promise<ReadonlyMap<string, QueuedAssetCheckin>>;
  /** Env consulted for the CI refusal. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Clock. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Acquire (and release) a cross-process lock for the entire check-in
   * operation. Without this, two concurrent processes (e.g. a sidecar and a
   * CLI) can both observe the same asset as un-queued, then both push
   * a branch and file a tracking issue — producing duplicate `asset-checkin`
   * issues. The lock serializes concurrent `runAssetCheckin` calls across
   * processes: the second caller's `listQueuedAssets` reads the issue filed by
   * the first and returns `nothing-to-checkin` (or `ambiguous-queued-content`)
   * instead of publishing again.
   *
   * Defaults to a no-op passthrough. Production callers must supply a
   * file-based implementation (see `createDefaultCheckinDeps` in
   * `checkin-runtime.ts`). Tests that do not exercise concurrent execution
   * can omit this field.
   */
  readonly withCrossProcessLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface RunAssetCheckinOptions {
  readonly baseBranch?: string;
  readonly slug?: string;
  /** Git remote name. Defaults to `origin`. */
  readonly remote?: string;
}

export interface AssetCheckinResult {
  readonly branch: string;
  readonly issueUrl: string;
  readonly plan: AssetCheckinPlan;
}

export interface QueuedAssetCheckin {
  readonly issueUrl: string;
  readonly branch: string;
  /**
   * SHA-256 (hex) recorded in the issue payload for this asset, when the
   * issue was filed after content hashes were added. Absent for legacy
   * issues — callers doing hash-based reconciliation must fail closed
   * (cannot establish equality) rather than assume a match.
   */
  readonly contentHash?: string;
}

export interface PreparedAssetCheckin {
  readonly plan: AssetCheckinPlan;
  readonly queuedAssets: ReadonlyMap<string, QueuedAssetCheckin>;
  readonly changedAssetCount: number;
}

/**
 * Classification of one asset's content hash against whatever the durable
 * queue records for the SAME `assetPath` (or `undefined` when nothing is
 * queued there). A single, pure rule set shared by `prepareAssetCheckin`
 * (batch check-in / preview) and the sidecar's atomic `/accept` route
 * (single-variant reconciliation) so match/mismatch/legacy handling can never
 * drift between the two callers:
 *   - `'new'`             — no queued record at this path; proceed normally.
 *   - `'duplicate'`        — queued AND both hashes are recorded AND equal;
 *                            already durably queued with identical content.
 *   - `'content-conflict'` — queued AND both hashes are recorded AND
 *                            DIFFERENT; the same path is queued with
 *                            genuinely different content and must not be
 *                            silently dropped or silently re-queued.
 *   - `'ambiguous'`        — queued but EITHER side's hash is unrecorded (a
 *                            legacy issue filed before content hashes
 *                            existed, or a legacy manifest entry that
 *                            predates them). Equality can never be
 *                            established from a missing hash, so this fails
 *                            closed rather than guessing.
 */
export type QueuedContentReconciliation = 'new' | 'duplicate' | 'content-conflict' | 'ambiguous';

export function reconcileQueuedContent(
  queued: QueuedAssetCheckin | undefined,
  contentHash: string | undefined,
): QueuedContentReconciliation {
  if (!queued) return 'new';
  if (queued.contentHash === undefined || contentHash === undefined) return 'ambiguous';
  return queued.contentHash === contentHash ? 'duplicate' : 'content-conflict';
}

function assertLocalCheckin(env: NodeJS.ProcessEnv): void {
  if (env.CI !== undefined) {
    throw new CheckinError(
      'ci-refused',
      'Per Constitutional §3, sprite check-in is local-only: it pushes approved ' +
        'assets and files a GitHub issue. Run it on a dev box (npm run sprites:checkin).',
    );
  }
}

/**
 * Resolve the exact unqueued batch that a check-in would publish.
 *
 * Open asset-checkin issue payloads are the durable queue record. Each
 * changed asset is reconciled against it via `reconcileQueuedContent` (shared
 * with the atomic `/accept` route) rather than a path-only filter: a queued
 * path with the SAME content hash is deduped silently (the historical
 * behavior), but a queued path with a DIFFERENT hash — or a legacy queued/
 * manifest entry with no recorded hash at all — must never be silently
 * dropped from (or silently re-added to) the batch. Both cases throw a typed
 * `CheckinError` instead, so the caller (CLI, `/api/checkin`, and now
 * `/api/checkin/prepare`) can surface a real conflict rather than quietly
 * losing newly-approved content that happens to share a path with something
 * already queued.
 */
export async function prepareAssetCheckin(
  repoRoot: string,
  deps: CheckinRunnerDeps,
  options: RunAssetCheckinOptions = {},
): Promise<PreparedAssetCheckin> {
  assertLocalCheckin(deps.env ?? process.env);

  const remote = options.remote ?? 'origin';
  const baseBranch = options.baseBranch ?? 'main';
  const now = deps.now ?? (() => new Date());

  await git(deps.exec, repoRoot, ['fetch', remote, baseBranch]);

  const manifest = deps.readManifest ? await deps.readManifest().catch(() => ({})) : {};
  const changedAssets = await detectApprovedAssets(
    deps.exec,
    repoRoot,
    remote,
    baseBranch,
    manifest,
  );
  const queuedAssets = deps.listQueuedAssets
    ? await deps.listQueuedAssets()
    : new Map<string, QueuedAssetCheckin>();

  const assets: CheckinAsset[] = [];
  for (const asset of changedAssets) {
    const queued = queuedAssets.get(asset.assetPath);
    const reconciliation = reconcileQueuedContent(queued, asset.contentHash);
    if (reconciliation === 'new') {
      assets.push(asset);
      continue;
    }
    if (reconciliation === 'duplicate') {
      // Already durably queued with identical content — dedupe silently,
      // same as the historical path-only filter did unconditionally.
      continue;
    }
    // 'content-conflict' / 'ambiguous' both require a queued record to
    // compare against, so `queued` is guaranteed defined here.
    const issueUrl = queued!.issueUrl;
    if (reconciliation === 'content-conflict') {
      throw new CheckinError(
        'content-conflict',
        `${asset.assetPath} is already queued (${issueUrl}) with different content. ` +
          'Approve a different variant, or resolve the existing issue first.',
      );
    }
    throw new CheckinError(
      'ambiguous-queued-content',
      `${asset.assetPath} is already queued (${issueUrl}) by an issue filed before content ` +
        'hashes were recorded, so it cannot be verified against the current content. Resolve ' +
        'the open issue manually before re-checking-in this asset.',
    );
  }

  if (assets.length === 0) {
    const detail =
      changedAssets.length > 0
        ? 'All approved art is already represented by an open asset-checkin issue.'
        : `No approved art differs from ${remote}/${baseBranch}. Approve a sprite first ` +
          '(npm run sprites:gallery), then re-run check-in.';
    throw new CheckinError('nothing-to-checkin', detail);
  }

  return {
    plan: planAssetCheckin({ assets, now: now(), baseBranch, slug: options.slug }),
    queuedAssets,
    changedAssetCount: changedAssets.length,
  };
}

/**
 * Execute a check-in: cut a dedicated branch off the remote base, stage the
 * live art surface, commit, push (NO PR), and file the tracking issue. All side
 * effects flow through `deps` so this is unit-testable with a fake exec.
 */
export async function runAssetCheckin(
  repoRoot: string,
  deps: CheckinRunnerDeps,
  options: RunAssetCheckinOptions = {},
): Promise<AssetCheckinResult> {
  const remote = options.remote ?? 'origin';
  const now = deps.now ?? (() => new Date());
  const withLock = deps.withCrossProcessLock ?? ((fn) => fn());
  return withLock(async () => {
    const { plan: preparedPlan } = await prepareAssetCheckin(repoRoot, deps, options);
    const sourceAssetRequestIssueNumbers = await discoverLinkedAssetRequestIssueNumbers(
      deps.exec,
      repoRoot,
      preparedPlan.assets,
    );
    const plan =
      sourceAssetRequestIssueNumbers.length > 0
        ? planAssetCheckin({
            assets: preparedPlan.assets,
            now: now(),
            baseBranch: preparedPlan.baseBranch,
            slug: branchSlug(preparedPlan.branch),
            assetRequestIssueNumbers: sourceAssetRequestIssueNumbers,
          })
        : preparedPlan;

    const worktree = await deps.makeTempDir();
    try {
      await git(deps.exec, repoRoot, [
        'worktree',
        'add',
        worktree,
        '-b',
        plan.branch,
        `${remote}/${plan.baseBranch}`,
      ]);
      await deps.copyArtSurface(repoRoot, worktree, plan.assets);
      await git(deps.exec, worktree, ['add', '--', ...plan.paths]);
      await git(deps.exec, worktree, ['commit', '--no-verify', '-m', plan.commitMessage]);
      await git(deps.exec, worktree, ['push', '--no-verify', '-u', remote, plan.branch]);

      // The branch is now on the remote. asset-pr consolidation discovers branches
      // ONLY through their tracking issue, so a failed `gh issue create` would
      // leave the branch orphaned (invisible to the consolidator, never cleaned by
      // the worktree teardown below). Ensure the label exists first — a fresh repo
      // has no `asset-checkin` label, which makes `gh issue create --label` fail —
      // and delete the pushed branch if the issue still can't be filed.
      let issueUrl: string;
      try {
        await ensureLabel(deps.exec, repoRoot, ASSET_CHECKIN_LABEL);
        issueUrl = await createIssue(deps.exec, repoRoot, plan);
      } catch (err) {
        await git(deps.exec, repoRoot, ['push', remote, '--delete', plan.branch]).catch(() => {});
        throw err;
      }
      return { branch: plan.branch, issueUrl, plan };
    } finally {
      // Detach the throwaway worktree, then delete the dir. Best-effort: a failed
      // cleanup must not mask a real error from the try block.
      await git(deps.exec, repoRoot, ['worktree', 'remove', worktree, '--force']).catch(() => {});
      await deps.removeDir(worktree).catch(() => {});
    }
  });
}

function branchSlug(branch: string): string {
  return branch.startsWith('assets/') ? branch.slice('assets/'.length) : branch;
}

function normalizeIssueNumbers(numbers: readonly number[]): number[] {
  return [...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

interface RawIssueRequestItem {
  readonly number?: unknown;
  readonly body?: unknown;
}

const FLOOR2_RUNTIME_BRIEF_IDS = new Set(
  FLOOR2_EQUIPMENT_ART_DEFINITIONS.map((entry) =>
    entry.stableId.slice(entry.stableId.indexOf('.') + 1),
  ),
);

async function discoverLinkedAssetRequestIssueNumbers(
  exec: Exec,
  repoRoot: string,
  assets: readonly CheckinAsset[],
): Promise<number[]> {
  // Conservative runtime-reachability gate: only close source asset-request
  // issues for Floor 2 equipment concepts that are actually wired in the art
  // map (`FLOOR2_EQUIPMENT_ART_DEFINITIONS`), not for file-only presence.
  const closableBriefIds = new Set(
    assets
      .map((asset) => asset.briefId)
      .filter((briefId): briefId is string => typeof briefId === 'string' && briefId.length > 0)
      .filter((briefId) => FLOOR2_RUNTIME_BRIEF_IDS.has(briefId)),
  );
  if (closableBriefIds.size === 0) return [];

  const listed = await exec(
    'gh',
    [
      'issue',
      'list',
      '--label',
      ASSET_REQUEST_LABEL,
      '--state',
      'open',
      '--json',
      'number,body',
      '--limit',
      '200',
    ],
    { cwd: repoRoot },
  );
  if (listed.code !== 0) {
    const detail = listed.stderr.trim() || `gh issue list exited with code ${listed.code}`;
    throw new CheckinError(
      'gh-failed',
      `Failed to list open ${ASSET_REQUEST_LABEL} issues: ${detail}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(listed.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new CheckinError(
      'gh-failed',
      `Failed to parse open ${ASSET_REQUEST_LABEL} issues from gh output: ${detail}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new CheckinError(
      'gh-failed',
      `Failed to parse open ${ASSET_REQUEST_LABEL} issues from gh output: expected an array.`,
    );
  }

  const matches: number[] = [];
  for (const item of raw as RawIssueRequestItem[]) {
    if (typeof item.number !== 'number' || typeof item.body !== 'string') continue;
    const parsed = parseAssetRequestIssueBody(item.body);
    if (parsed === null) continue;
    if (closableBriefIds.has(parsed.name)) {
      matches.push(item.number);
    }
  }
  return normalizeIssueNumbers(matches);
}

/**
 * List the art-surface PNGs that differ from the remote base, enriched with
 * manifest metadata when present. Compares the WORKING TREE (so freshly
 * approved, uncommitted assets count) against `<remote>/<baseBranch>`.
 *
 * `git diff` only reports TRACKED files, but a freshly approved variant PNG is
 * written with `copyFileSync` and never `git add`ed — it is untracked. Since
 * `public/assets/generated/**` is un-ignored, those brand-new PNGs must be
 * collected separately via `git ls-files --others`; otherwise the primary
 * approve→check-in flow sees no assets and throws `nothing-to-checkin`.
 */
export async function detectApprovedAssets(
  exec: Exec,
  repoRoot: string,
  remote: string,
  baseBranch: string,
  manifest: CheckinManifest = {},
): Promise<CheckinAsset[]> {
  const diff = await git(exec, repoRoot, [
    'diff',
    '--name-only',
    `${remote}/${baseBranch}`,
    '--',
    ...ASSET_SURFACE_PATHS,
  ]);
  const untracked = await git(exec, repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...ASSET_SURFACE_PATHS,
  ]);
  const seen = new Set<string>();
  const changed = [...diff.stdout.split('\n'), ...untracked.stdout.split('\n')]
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.png'))
    .filter((file) => {
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    });

  const assets: CheckinAsset[] = [];
  for (const file of changed) {
    // `public/assets/generated/foo-var-1.png` -> `generated/foo-var-1.png`
    const assetPath = file.startsWith('public/assets/')
      ? file.slice('public/assets/'.length)
      : file;
    const match = findManifestEntry(manifest, assetPath);
    assets.push({
      assetPath,
      manifestKey: match?.key ?? null,
      briefId: match?.briefId ?? null,
      variantIndex: match?.variantIndex ?? null,
      ...(match?.contentHash !== undefined ? { contentHash: match.contentHash } : {}),
    });
  }
  return assets;
}

function findManifestEntry(
  manifest: CheckinManifest,
  assetPath: string,
): {
  key: string;
  briefId: string | null;
  variantIndex: number | null;
  contentHash: string | undefined;
} | null {
  const entries = manifest.entries ?? {};
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.assetPath === assetPath) {
      return {
        key,
        briefId: entry.briefId ?? null,
        variantIndex: typeof entry.variantIndex === 'number' ? entry.variantIndex : null,
        contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : undefined,
      };
    }
  }
  return null;
}

async function createIssue(exec: Exec, repoRoot: string, plan: AssetCheckinPlan): Promise<string> {
  const args = [
    'issue',
    'create',
    '--title',
    plan.issueTitle,
    '--body',
    plan.issueBody,
    ...plan.labels.flatMap((label) => ['--label', label]),
  ];
  const result = await exec('gh', args, { cwd: repoRoot });
  if (result.code !== 0) {
    throw new CheckinError(
      'gh-failed',
      `gh issue create failed: ${result.stderr || result.stdout}`,
    );
  }
  // `gh issue create` prints the issue URL on stdout.
  const url = result.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  return url;
}

/**
 * Idempotently ensure the check-in label exists so `gh issue create --label`
 * doesn't fail on a fresh repo. `--force` creates the label or updates it in
 * place. Best-effort: a non-zero exit here is non-fatal because `createIssue`
 * surfaces (and triggers branch cleanup for) a genuine inability to file.
 */
async function ensureLabel(exec: Exec, repoRoot: string, label: string): Promise<void> {
  await exec(
    'gh',
    [
      'label',
      'create',
      label,
      '--color',
      'FBCA04',
      '--description',
      'Approved sprite art awaiting consolidation into a game PR',
      '--force',
    ],
    { cwd: repoRoot },
  );
}

async function git(exec: Exec, cwd: string, args: readonly string[]): Promise<ExecResult> {
  const result = await exec('git', args, { cwd });
  if (result.code !== 0) {
    throw new CheckinError(
      'git-failed',
      `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

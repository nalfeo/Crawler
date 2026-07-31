/**
 * asset-pr: consolidate every open `asset-checkin` issue into ONE game PR.
 *
 * Each check-in pushed an `assets/<slug>` branch (art-surface delta off main)
 * and filed an issue carrying a machine-readable payload (see checkin.ts).
 * This module turns those issues into a single `assets/batch-<stamp>` branch
 * that unions all their manifests + catalogs (via the pure helpers in
 * asset-issues.ts) and copies every approved PNG, then opens one PR that closes
 * the source issues.
 *
 * It also picks up orphaned `assets/checkin-*` branches that have no open PR —
 * these represent approved art checked in locally but never consolidated. Both
 * issue-backed and orphaned branches are unioned into the same batch PR.
 *
 * Split, like checkin.ts, into a PURE planner/parser (this file's
 * `parseOpenAssetIssues` + `planConsolidation`) and an injected-IO executor
 * (`runAssetPrConsolidation`) so the decision logic is unit-tested without git.
 */

import { parseAssetIssueBody } from './asset-issues.js';
import {
  ASSET_CHECKIN_LABEL,
  ASSET_SURFACE_PATHS,
  CheckinError,
  type AssetCheckinPayload,
  type CheckinAsset,
  type Exec,
} from './checkin.js';

/** One open check-in issue paired with its decoded payload. */
export interface AssetIssue {
  readonly number: number;
  readonly title: string;
  readonly payload: AssetCheckinPayload;
}

interface RawIssue {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
}

/**
 * Parse the JSON emitted by `gh issue list --json number,title,body` into the
 * subset of issues that carry a valid check-in payload. Issues without a
 * payload (hand-filed, malformed) are dropped. Pure.
 */
export function parseOpenAssetIssues(issuesJson: string): AssetIssue[] {
  let raw: unknown;
  try {
    raw = JSON.parse(issuesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const issues: AssetIssue[] = [];
  for (const item of raw as RawIssue[]) {
    if (typeof item.number !== 'number') continue;
    if (typeof item.body !== 'string') continue;
    const payload = parseAssetIssueBody(item.body);
    if (payload === null) continue;
    issues.push({
      number: item.number,
      title: typeof item.title === 'string' ? item.title : '',
      payload,
    });
  }
  // Stable order: oldest issue number first, so the PR body reads chronologically.
  return issues.sort((a, b) => a.number - b.number);
}

export interface ConsolidationPlan {
  readonly batchBranch: string;
  readonly baseBranch: string;
  readonly prTitle: string;
  readonly prBody: string;
  readonly commitMessage: string;
  /** Distinct source branches to fold in, in issue order. */
  readonly sourceBranches: readonly string[];
  /** Issue numbers being consolidated (closed by the PR). */
  readonly issueNumbers: readonly number[];
  /** Source asset-request issues linked from the consolidated check-ins. */
  readonly assetRequestIssueNumbers: readonly number[];
  /** Every approved asset across all issues (deduped by assetPath). */
  readonly assets: readonly CheckinAsset[];
  /**
   * Orphaned `assets/checkin-*` branches that have no open PR and no issue
   * payload. Their art surface is unioned in alongside the issue-backed
   * branches during the worktree step.
   */
  readonly orphanedBranches: readonly string[];
}

export interface PlanConsolidationInput {
  readonly issues: readonly AssetIssue[];
  /** Orphaned checkin branches without any open PR or issue payload. */
  readonly orphanedBranches?: readonly string[];
  readonly now: Date;
  readonly baseBranch?: string;
  readonly slug?: string;
}

/**
 * Build the single-PR consolidation plan from open issues and/or orphaned
 * branches. Pure. Throws if there is nothing to consolidate.
 */
export function planConsolidation(input: PlanConsolidationInput): ConsolidationPlan {
  const orphanedBranches = input.orphanedBranches ?? [];
  if (input.issues.length === 0 && orphanedBranches.length === 0) {
    throw new Error('planConsolidation: no asset-checkin issues to consolidate');
  }
  const baseBranch = input.issues[0]?.payload.baseBranch ?? input.baseBranch ?? 'main';
  const slug = input.slug ?? `batch-${formatStamp(input.now)}`;
  const batchBranch = `assets/${slug}`;

  const sourceBranches = dedupe(input.issues.map((i) => i.payload.branch));
  const issueNumbers = input.issues.map((i) => i.number);
  const assetRequestIssueNumbers = dedupeNumbers(
    input.issues.flatMap((i) => i.payload.assetRequestIssueNumbers ?? []),
  );
  const assets = dedupeAssets(input.issues.flatMap((i) => i.payload.assets));

  const totalSources = sourceBranches.length + orphanedBranches.length;
  const noun = assets.length === 1 ? 'asset' : 'assets';
  const checkinLabel = totalSources === 1 ? 'check-in' : 'check-ins';
  const commitMessage =
    assets.length > 0
      ? `feat(sprites): consolidate ${assets.length} approved ${noun} from ${totalSources} ${checkinLabel}`
      : `feat(sprites): consolidate ${totalSources} orphaned ${checkinLabel}`;
  const prTitle =
    assets.length > 0
      ? `feat(sprites): add ${assets.length} approved ${noun} (${totalSources} ${checkinLabel})`
      : `feat(sprites): consolidate ${totalSources} orphaned check-in${totalSources === 1 ? '' : 's'}`;
  const prBody = renderPrBody(
    input.issues,
    assets,
    baseBranch,
    orphanedBranches,
    issueNumbers,
    assetRequestIssueNumbers,
  );

  return {
    batchBranch,
    baseBranch,
    prTitle,
    prBody,
    commitMessage,
    sourceBranches,
    issueNumbers,
    assetRequestIssueNumbers,
    assets,
    orphanedBranches,
  };
}

function renderPrBody(
  issues: readonly AssetIssue[],
  assets: readonly CheckinAsset[],
  baseBranch: string,
  orphanedBranches: readonly string[] = [],
  checkinIssueNumbers: readonly number[] = [],
  assetRequestIssueNumbers: readonly number[] = [],
): string {
  const lines: string[] = [];
  lines.push('## Consolidated asset check-ins');
  lines.push('');
  lines.push(
    `Folds ${assets.length} approved generated sprite(s) from ${issues.length} ` +
      `\`${ASSET_CHECKIN_LABEL}\` issue(s) into one branch off \`${baseBranch}\`.`,
  );
  if (orphanedBranches.length > 0) {
    lines.push(
      `Also includes art from **${orphanedBranches.length}** orphaned ` +
        `\`assets/checkin-*\` branch(es) with no open PR.`,
    );
  }
  lines.push('');
  lines.push('### Source check-ins');
  for (const issue of issues) {
    lines.push(
      `- #${issue.number} — \`${issue.payload.branch}\` (${issue.payload.assets.length} asset(s))`,
    );
  }
  if (orphanedBranches.length > 0) {
    lines.push('');
    lines.push('### Orphaned branches (no issue)');
    for (const branch of orphanedBranches) {
      lines.push(`- \`${branch}\``);
    }
  }
  lines.push('');
  lines.push('### Assets');
  for (const asset of assets) {
    const brief = asset.briefId ? ` — brief \`${asset.briefId}\`` : '';
    const variant = asset.variantIndex !== null ? ` (variant ${asset.variantIndex})` : '';
    lines.push(`- \`${asset.assetPath}\`${brief}${variant}`);
  }
  lines.push('');
  // Auto-close each tracking issue when the PR merges.
  for (const issueNumber of dedupeNumbers([...checkinIssueNumbers, ...assetRequestIssueNumbers])) {
    lines.push(`Closes #${issueNumber}`);
  }
  return `${lines.join('\n')}\n`;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dedupeNumbers(values: readonly number[]): number[] {
  return [...new Set(values.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

function dedupeAssets(assets: readonly CheckinAsset[]): CheckinAsset[] {
  const seen = new Map<string, CheckinAsset>();
  for (const asset of assets) {
    if (!seen.has(asset.assetPath)) seen.set(asset.assetPath, asset);
  }
  return [...seen.values()].sort((a, b) => a.assetPath.localeCompare(b.assetPath));
}

function formatStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

export interface AssetPrRunnerDeps {
  readonly exec: Exec;
  readonly makeTempDir: () => Promise<string>;
  readonly removeDir: (dir: string) => Promise<void>;
  /** Read + parse a JSON file inside the worktree. */
  readonly readJson: <T>(absPath: string) => Promise<T>;
  /** Serialize + write a JSON file inside the worktree. */
  readonly writeJson: (absPath: string, value: unknown) => Promise<void>;
  /** Join path segments (defaults to POSIX-style join; injected for tests). */
  readonly joinPath?: (...segments: string[]) => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

export interface AssetPrOptions {
  readonly baseBranch?: string;
  readonly remote?: string;
  readonly slug?: string;
}

export interface AssetPrResult {
  readonly prUrl: string;
  readonly plan: ConsolidationPlan;
}

/**
 * Execute the consolidation: list open issues, union their art surfaces into a
 * fresh batch branch, push it, and open one PR. Side effects are injected.
 *
 * Binary safety + conflict-free union: both PNGs AND per-asset manifest shards
 * are materialized with `git checkout <branch> -- <path>` (object-store →
 * worktree, never through stdout). Because each shard is a self-contained file
 * keyed by manifestKey, disjoint check-ins never share a path, so the union is a
 * plain per-file overlay with no JSON merge and no aggregate/catalog write.
 *
 * Orphaned branches (assets/checkin-* on the remote with no open PR) are also
 * folded in: their art surface (--diff-filter=AM paths within ASSET_SURFACE_PATHS)
 * is overlaid on top of the issue-backed sources, with later branches winning on
 * collision.
 */
export async function runAssetPrConsolidation(
  repoRoot: string,
  deps: AssetPrRunnerDeps,
  options: AssetPrOptions = {},
): Promise<AssetPrResult | null> {
  const env = deps.env ?? process.env;
  if (env.CI !== undefined) {
    throw new CheckinError(
      'ci-refused',
      'Per Constitutional §3, asset-PR consolidation is local-only: it pushes a ' +
        'batch branch and opens a PR. Run it on a dev box (npm run sprites:asset-pr).',
    );
  }

  const remote = options.remote ?? 'origin';
  const baseBranch = options.baseBranch ?? 'main';
  const now = deps.now ?? (() => new Date());

  const listed = await exec(deps.exec, repoRoot, 'gh', [
    'issue',
    'list',
    '--label',
    ASSET_CHECKIN_LABEL,
    '--state',
    'open',
    '--json',
    'number,title,body',
    '--limit',
    '200',
  ]);
  const issues = parseOpenAssetIssues(listed.stdout);

  const orphanedBranches = await scanOrphanedCheckinBranches(deps.exec, repoRoot, remote);

  if (issues.length === 0 && orphanedBranches.length === 0) return null;

  const plan = planConsolidation({
    issues,
    orphanedBranches,
    now: now(),
    baseBranch,
    slug: options.slug,
  });

  await exec(deps.exec, repoRoot, 'git', ['fetch', remote, baseBranch]);
  for (const branch of plan.sourceBranches) {
    await exec(deps.exec, repoRoot, 'git', ['fetch', remote, branch]);
  }
  for (const branch of orphanedBranches) {
    await exec(deps.exec, repoRoot, 'git', ['fetch', remote, branch]).catch(() => undefined);
  }

  // Pre-compute the AM paths for each orphaned branch vs current main.
  // Two-dot (not three-dot): comparing tips directly ensures an orphan whose art
  // already landed on main via a previous batch merge shows an empty delta and is
  // skipped, preventing stale re-replay. --no-renames matches the reconciler.
  // Legacy aggregate manifest.json (pre-shard-migration) is filtered out; only
  // per-asset entries/*.json shards and PNGs are safe to harvest.
  const orphanedPathsByBranch = new Map<string, string[]>();
  for (const branch of orphanedBranches) {
    const ref = `${remote}/${branch}`;
    const diffResult = await exec(deps.exec, repoRoot, 'git', [
      'diff',
      '--no-renames',
      '--name-only',
      '--diff-filter=AM',
      `${remote}/${baseBranch}`,
      ref,
    ]).catch(() => ({ stdout: '', stderr: '', code: 0 }));
    const paths = diffResult.stdout
      .split('\n')
      .map((p) => p.trim())
      .filter(
        (p) =>
          p.length > 0 &&
          ASSET_SURFACE_PATHS.some((prefix) => p.startsWith(prefix)) &&
          !isLegacyAggregateManifestPath(p),
      );
    if (paths.length > 0) orphanedPathsByBranch.set(branch, paths);
  }

  const worktree = await deps.makeTempDir();
  try {
    await exec(deps.exec, repoRoot, 'git', [
      'worktree',
      'add',
      worktree,
      '-b',
      plan.batchBranch,
      `${remote}/${baseBranch}`,
    ]);

    // File-level union: materialize each source branch's approved PNGs AND
    // their per-asset manifest shards into the worktree. Because every shard is
    // a self-contained file keyed by manifestKey, disjoint check-ins never touch
    // the same path, so a plain per-file checkout unions them with no
    // manifest/catalog merge (the aggregate + catalog rows are derived).
    for (const branch of plan.sourceBranches) {
      const ref = `${remote}/${branch}`;
      for (const asset of plan.assets) {
        const repoRels = [`public/assets/${asset.assetPath}`];
        if (typeof asset.manifestKey === 'string' && asset.manifestKey.length > 0) {
          repoRels.push(`public/assets/generated/entries/${asset.manifestKey}.json`);
        }
        for (const repoRel of repoRels) {
          await exec(deps.exec, worktree, 'git', ['checkout', ref, '--', repoRel]).catch(() => ({
            stdout: '',
            stderr: '',
            code: 0,
          }));
        }
      }
    }

    // Overlay orphaned branches: checkout only the AM-scoped paths identified
    // above. Later branches win on collision (last-writer semantics).
    for (const branch of orphanedBranches) {
      const paths = orphanedPathsByBranch.get(branch);
      if (!paths || paths.length === 0) continue;
      const ref = `${remote}/${branch}`;
      for (const p of paths) {
        await exec(deps.exec, worktree, 'git', ['checkout', ref, '--', p]).catch(() => undefined);
      }
    }

    await exec(deps.exec, worktree, 'git', ['add', '--', 'public/assets/generated']);
    await exec(deps.exec, worktree, 'git', ['commit', '-m', plan.commitMessage]);
    await exec(deps.exec, worktree, 'git', ['push', '-u', remote, plan.batchBranch]);

    const created = await exec(deps.exec, repoRoot, 'gh', [
      'pr',
      'create',
      '--base',
      baseBranch,
      '--head',
      plan.batchBranch,
      '--title',
      plan.prTitle,
      '--body',
      plan.prBody,
    ]);
    const prUrl = created.stdout.trim().split('\n').filter(Boolean).pop() ?? '';

    // Delete the orphan source branches that were folded into this batch so
    // subsequent invocations don't re-open a duplicate PR for the same content.
    // Non-fatal: a delete failure is not a reason to fail the whole operation.
    for (const branch of orphanedBranches) {
      if (orphanedPathsByBranch.has(branch)) {
        await exec(deps.exec, repoRoot, 'git', ['push', remote, '--delete', branch]).catch(
          () => undefined,
        );
      }
    }

    return { prUrl, plan };
  } finally {
    await exec(deps.exec, repoRoot, 'git', ['worktree', 'remove', worktree, '--force']).catch(
      () => undefined,
    );
    await deps.removeDir(worktree).catch(() => undefined);
  }
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
 * Return `assets/checkin-*` branches on `remote` that have no open PR pointing
 * at them. Non-fatal: on any query failure returns `[]` (conservative — the
 * trust-boundary guard in the worktree step validates paths regardless).
 */
async function scanOrphanedCheckinBranches(
  run: Exec,
  repoRoot: string,
  remote: string,
): Promise<string[]> {
  const lsResult = await run('git', ['ls-remote', '--heads', remote, 'assets/checkin-*'], {
    cwd: repoRoot,
  }).catch(() => ({ stdout: '', stderr: '', code: 0 }));
  const remoteBranches = lsResult.stdout
    .split('\n')
    .map((line) => line.split('\t')[1]?.replace('refs/heads/', '').trim() ?? '')
    .filter((b) => b.startsWith('assets/checkin-'));

  if (remoteBranches.length === 0) return [];

  const prResult = await run(
    'gh',
    ['pr', 'list', '--state', 'open', '--json', 'headRefName', '--limit', '500'],
    { cwd: repoRoot },
  ).catch(() => ({ stdout: '[]', stderr: '', code: 0 }));

  let openHeads = new Set<string>();
  try {
    const parsed = JSON.parse(prResult.stdout) as Array<{ headRefName: string }>;
    openHeads = new Set(parsed.map((p) => p.headRefName));
  } catch {
    // If parse fails, treat all branches as potentially in-PR (conservative).
    return [];
  }

  return remoteBranches.filter((b) => !openHeads.has(b));
}

async function exec(
  run: Exec,
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await run(command, args, { cwd });
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

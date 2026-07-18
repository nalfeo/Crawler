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
 * Split, like checkin.ts, into a PURE planner/parser (this file's
 * `parseOpenAssetIssues` + `planConsolidation`) and an injected-IO executor
 * (`runAssetPrConsolidation`) so the decision logic is unit-tested without git.
 */

import {
  mergeCatalogs,
  mergeManifests,
  parseAssetIssueBody,
  type CatalogEntry,
  type GeneratedManifest,
} from './asset-issues.js';
import {
  ASSET_CHECKIN_LABEL,
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

export const ASSET_PR_MARKER = '<!-- crawler-asset-pr:v1 -->';

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
  /** Every approved asset across all issues (deduped by assetPath). */
  readonly assets: readonly CheckinAsset[];
}

export interface PlanConsolidationInput {
  readonly issues: readonly AssetIssue[];
  readonly now: Date;
  readonly baseBranch?: string;
  readonly slug?: string;
}

/**
 * Build the single-PR consolidation plan from the open issues. Pure. Throws if
 * there are no issues (callers should special-case the empty queue first).
 */
export function planConsolidation(input: PlanConsolidationInput): ConsolidationPlan {
  if (input.issues.length === 0) {
    throw new Error('planConsolidation: no asset-checkin issues to consolidate');
  }
  const baseBranches = new Set(input.issues.map((issue) => issue.payload.baseBranch));
  if (baseBranches.size !== 1) {
    throw new Error('planConsolidation: check-in issues have mixed base branches');
  }
  const baseBranch = input.issues[0]!.payload.baseBranch ?? input.baseBranch ?? 'main';
  const slug = input.slug ?? `batch-${formatStamp(input.now)}`;
  const batchBranch = `assets/${slug}`;

  const sourceBranches = dedupe(input.issues.map((i) => i.payload.branch));
  const issueNumbers = input.issues.map((i) => i.number);
  const assets = dedupeAssets(input.issues.flatMap((i) => i.payload.assets));

  const noun = assets.length === 1 ? 'asset' : 'assets';
  const commitMessage = `feat(sprites): consolidate ${assets.length} approved ${noun} from ${input.issues.length} check-in(s)`;
  const prTitle = `feat(sprites): add ${assets.length} approved ${noun} (${input.issues.length} check-in${input.issues.length === 1 ? '' : 's'})`;
  const prBody = renderPrBody(input.issues, assets, baseBranch);

  return {
    batchBranch,
    baseBranch,
    prTitle,
    prBody,
    commitMessage,
    sourceBranches,
    issueNumbers,
    assets,
  };
}

function renderPrBody(
  issues: readonly AssetIssue[],
  assets: readonly CheckinAsset[],
  baseBranch: string,
): string {
  const lines: string[] = [];
  lines.push(ASSET_PR_MARKER);
  lines.push('## Consolidated asset check-ins');
  lines.push('');
  lines.push(
    `Folds ${assets.length} approved generated sprite(s) from ${issues.length} ` +
      `\`${ASSET_CHECKIN_LABEL}\` issue(s) into one branch off \`${baseBranch}\`.`,
  );
  lines.push('');
  lines.push('### Source check-ins');
  for (const issue of issues) {
    lines.push(
      `- #${issue.number} — \`${issue.payload.branch}\` (${issue.payload.assets.length} asset(s))`,
    );
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
  for (const issue of issues) {
    lines.push(`Closes #${issue.number}`);
  }
  return `${lines.join('\n')}\n`;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
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

const MANIFEST_REL = 'public/assets/generated/manifest.json';
const CATALOG_REL = 'src/shared/data/sprite-catalog.json';

/**
 * Execute the consolidation: list open issues, union their art surfaces into a
 * fresh batch branch, push it, and open one PR. Side effects are injected.
 *
 * Binary safety: PNGs are materialized with `git checkout <branch> -- <path>`
 * (object-store → worktree, never through stdout); only the JSON manifest +
 * catalog are read as text and unioned with the pure helpers.
 */
export async function runAssetPrConsolidation(
  repoRoot: string,
  deps: AssetPrRunnerDeps,
  options: AssetPrOptions = {},
): Promise<AssetPrResult | null> {
  const env = deps.env ?? process.env;
  const workflowRef = 'nalfeo/Crawler/.github/workflows/asset-pr.yml@refs/heads/main';
  const authorizedCi =
    env.SPRITES_ALLOW_CI_ASSET_PR === 'true' &&
    env.GITHUB_REPOSITORY === 'nalfeo/Crawler' &&
    env.GITHUB_WORKFLOW_REF === workflowRef;
  if (env.CI !== undefined && !authorizedCi) {
    throw new CheckinError(
      'ci-refused',
      'asset-PR consolidation is local-only except for the dedicated asset-pr workflow.',
    );
  }

  const remote = options.remote ?? 'origin';
  const baseBranch = options.baseBranch ?? 'main';
  const now = deps.now ?? (() => new Date());
  const join = deps.joinPath ?? ((...s: string[]) => s.join('/'));

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
  if (issues.length === 0) return null;

  const openPrs = await exec(deps.exec, repoRoot, 'gh', [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'body',
    '--limit',
    '500',
  ]);
  try {
    const prs = JSON.parse(openPrs.stdout) as Array<{ body?: unknown }>;
    if (prs.some((pr) => typeof pr.body === 'string' && pr.body.includes(ASSET_PR_MARKER))) {
      return null;
    }
  } catch {
    throw new Error('asset-pr: gh returned invalid open pull-request JSON');
  }

  const plan = planConsolidation({ issues, now: now(), baseBranch, slug: options.slug });
  if (plan.baseBranch !== baseBranch) {
    throw new Error(
      `asset-pr: check-in base branch ${plan.baseBranch} does not match requested base ${baseBranch}`,
    );
  }

  await exec(deps.exec, repoRoot, 'git', ['fetch', remote, baseBranch]);
  for (const branch of plan.sourceBranches) {
    await exec(deps.exec, repoRoot, 'git', ['fetch', remote, branch]);
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

    // Start from the base art surface, then union each source branch on top.
    const manifests: GeneratedManifest[] = [];
    const catalogs: CatalogEntry[][] = [];
    for (const branch of plan.sourceBranches) {
      const ref = `${remote}/${branch}`;
      manifests.push(await readJsonFromRef(deps, repoRoot, ref, MANIFEST_REL));
      catalogs.push(await readCatalogFromRef(deps, repoRoot, ref, CATALOG_REL));
      // Materialize that branch's approved PNGs into the worktree (binary-safe).
      for (const asset of plan.assets) {
        const repoRel = `public/assets/${asset.assetPath}`;
        await exec(deps.exec, worktree, 'git', ['checkout', ref, '--', repoRel]).catch(() => ({
          stdout: '',
          stderr: '',
          code: 0,
        }));
      }
    }

    const baseManifest = await deps.readJson<GeneratedManifest>(join(worktree, MANIFEST_REL));
    const baseCatalog = await deps.readJson<CatalogEntry[]>(join(worktree, CATALOG_REL));
    const mergedManifest = mergeManifests(baseManifest, ...manifests);
    const mergedCatalog = mergeCatalogs(baseCatalog, ...catalogs);
    await deps.writeJson(join(worktree, MANIFEST_REL), mergedManifest);
    await deps.writeJson(join(worktree, CATALOG_REL), mergedCatalog);

    await exec(deps.exec, worktree, 'git', ['add', '--', 'public/assets/generated', CATALOG_REL]);
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
    return { prUrl, plan };
  } finally {
    await exec(deps.exec, repoRoot, 'git', ['worktree', 'remove', worktree, '--force']).catch(
      () => undefined,
    );
    await deps.removeDir(worktree).catch(() => undefined);
  }
}

async function readJsonFromRef(
  deps: AssetPrRunnerDeps,
  repoRoot: string,
  ref: string,
  relPath: string,
): Promise<GeneratedManifest> {
  const result = await deps.exec('git', ['show', `${ref}:${relPath}`], { cwd: repoRoot });
  if (result.code !== 0) return { entries: {} };
  try {
    return JSON.parse(result.stdout) as GeneratedManifest;
  } catch {
    return { entries: {} };
  }
}

async function readCatalogFromRef(
  deps: AssetPrRunnerDeps,
  repoRoot: string,
  ref: string,
  relPath: string,
): Promise<CatalogEntry[]> {
  const result = await deps.exec('git', ['show', `${ref}:${relPath}`], { cwd: repoRoot });
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? (parsed as CatalogEntry[]) : [];
  } catch {
    return [];
  }
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

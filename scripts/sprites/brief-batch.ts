/**
 * brief-batch: consolidate every open brief-only PR into ONE game PR.
 *
 * Brief-only PRs are those where every changed file lives under `briefs/`
 * (no art, no game logic). They accumulate when Copilot agents author brief
 * YAML files individually, creating CI churn and merge conflicts in shared
 * test fixtures.
 *
 * This module is split, like `asset-pr.ts`, into:
 *  - PURE planner/parser (`parseBriefOnlyPRs`, `planBriefBatch`) — unit-testable
 *    without git or network.
 *  - Injected-IO executor (`runBriefBatchConsolidation`) — all side effects via
 *    `BriefBatchDeps`.
 */

import type { Exec } from './checkin.js';

/** One open PR that only modifies files under `briefs/`. */
export interface BriefOnlyPR {
  readonly number: number;
  readonly title: string;
  readonly headRefName: string;
  /** Repo-relative paths of the brief files modified in this PR. */
  readonly briefPaths: readonly string[];
}

export interface BriefBatchPlan {
  readonly batchBranch: string;
  readonly baseBranch: string;
  readonly prTitle: string;
  readonly prBody: string;
  readonly commitMessage: string;
  readonly sourcePRs: readonly BriefOnlyPR[];
  /** All distinct brief paths to include (last-writer-wins on same-path conflicts). */
  readonly allBriefPaths: readonly string[];
}

export interface BriefBatchDeps {
  readonly exec: Exec;
  readonly makeTempDir: () => Promise<string>;
  readonly removeDir: (dir: string) => Promise<void>;
}

export interface BriefBatchOptions {
  readonly baseBranch?: string;
  readonly remote?: string;
  /** Slug for the batch branch; defaults to `briefs-<timestamp>`. */
  readonly slug?: string;
}

export interface BriefBatchResult {
  readonly prUrl: string;
  readonly plan: BriefBatchPlan;
}

interface RawPR {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly headRefName?: unknown;
}

/**
 * Parse the JSON from `gh pr list --json number,title,headRefName` and combine
 * with per-PR git diffs to identify brief-only PRs. A PR is brief-only when
 * every changed file (AM-filtered vs the merge base with main) is under
 * `briefs/`. PRs with no changed files or an absent diff are skipped.
 *
 * `diffsByHeadRef` maps `headRefName → newline-separated paths` (the output of
 * `git diff --name-only --diff-filter=AM origin/main...origin/<headRef>`).
 *
 * Pure. Throws nothing — skips malformed input silently.
 */
export function parseBriefOnlyPRs(
  prsJson: string,
  diffsByHeadRef: Map<string, string>,
): BriefOnlyPR[] {
  let raw: unknown;
  try {
    raw = JSON.parse(prsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const result: BriefOnlyPR[] = [];
  for (const item of raw as RawPR[]) {
    if (typeof item.number !== 'number') continue;
    if (typeof item.headRefName !== 'string' || !item.headRefName) continue;

    const diffOutput = diffsByHeadRef.get(item.headRefName);
    if (diffOutput === undefined) continue; // branch missing on remote — skip

    const paths = diffOutput
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (paths.length === 0) continue; // nothing changed vs main — skip

    const allBriefs = paths.every((p) => p.startsWith('briefs/'));
    if (!allBriefs) continue;

    result.push({
      number: item.number,
      title: typeof item.title === 'string' ? item.title : '',
      headRefName: item.headRefName,
      briefPaths: paths,
    });
  }

  // Stable order: oldest PR number first.
  return result.sort((a, b) => a.number - b.number);
}

/**
 * Build the consolidation plan from a set of brief-only PRs. Pure. Throws if
 * there is nothing to consolidate.
 */
export function planBriefBatch(input: {
  readonly prs: readonly BriefOnlyPR[];
  readonly now: Date;
  readonly baseBranch?: string;
  readonly slug?: string;
}): BriefBatchPlan {
  if (input.prs.length === 0) {
    throw new Error('planBriefBatch: no brief-only PRs to consolidate');
  }

  const baseBranch = input.baseBranch ?? 'main';
  const slug = input.slug ?? `briefs-${formatStamp(input.now)}`;
  const batchBranch = `batch/${slug}`;

  // Deduplicate brief paths: last PR wins if two PRs touch the same file.
  const seen = new Map<string, string>(); // path → headRefName
  for (const pr of input.prs) {
    for (const p of pr.briefPaths) {
      seen.set(p, pr.headRefName);
    }
  }
  const allBriefPaths = [...seen.keys()].sort();

  const noun = input.prs.length === 1 ? 'PR' : 'PRs';
  const briefNoun = allBriefPaths.length === 1 ? 'brief' : 'briefs';
  const commitMessage = `chore(briefs): batch ${allBriefPaths.length} ${briefNoun} from ${input.prs.length} ${noun}`;
  const prTitle = `chore(briefs): consolidate ${allBriefPaths.length} ${briefNoun} from ${input.prs.length} ${noun}`;
  const prBody = renderPrBody(input.prs, allBriefPaths, baseBranch);

  return {
    batchBranch,
    baseBranch,
    prTitle,
    prBody,
    commitMessage,
    sourcePRs: [...input.prs],
    allBriefPaths,
  };
}

function renderPrBody(
  prs: readonly BriefOnlyPR[],
  allBriefPaths: readonly string[],
  baseBranch: string,
): string {
  const lines: string[] = [];
  lines.push('## Consolidated brief files');
  lines.push('');
  lines.push(
    `Folds ${allBriefPaths.length} brief YAML file(s) from ${prs.length} ` +
      `brief-only PR(s) into one branch off \`${baseBranch}\`.`,
  );
  lines.push('');
  lines.push('### Source PRs');
  for (const pr of prs) {
    lines.push(`- #${pr.number} — \`${pr.headRefName}\` (${pr.briefPaths.length} brief(s))`);
  }
  lines.push('');
  lines.push(`### Briefs (${allBriefPaths.length})`);
  for (const p of allBriefPaths) {
    lines.push(`- \`${p}\``);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**After this PR merges:** close the source PRs listed above.');
  lines.push('Their branches remain on the remote and can be reopened if needed.');
  return lines.join('\n');
}

function formatStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/**
 * Execute the brief-batch consolidation:
 *
 * 1. List open PRs via `gh pr list`.
 * 2. For each, compute a three-dot diff vs main to identify brief-only PRs.
 * 3. Create a batch branch from `remote/baseBranch`.
 * 4. Check out each brief file from its source branch.
 * 5. Commit + push + open ONE PR.
 *
 * Returns `null` when there are no brief-only PRs to consolidate.
 */
export async function runBriefBatchConsolidation(
  repoRoot: string,
  deps: BriefBatchDeps,
  options: BriefBatchOptions = {},
): Promise<BriefBatchResult | null> {
  const remote = options.remote ?? 'origin';
  const baseBranch = options.baseBranch ?? 'main';

  // Step 1: list all open PRs.
  const listed = await exec(deps.exec, repoRoot, 'gh', [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,headRefName',
    '--limit',
    '500',
  ]);
  let rawPRs: RawPR[] = [];
  try {
    rawPRs = JSON.parse(listed.stdout) as RawPR[];
  } catch {
    rawPRs = [];
  }

  if (!rawPRs.length) return null;

  // Step 2: fetch base branch so three-dot diffs work.
  const remoteBaseRef = `refs/remotes/${remote}/${baseBranch}`;
  await exec(deps.exec, repoRoot, 'git', [
    'fetch',
    '--no-tags',
    remote,
    `+${baseBranch}:${remoteBaseRef}`,
  ]);

  // Step 3: for each PR, compute the three-dot diff. Skip if the branch is
  // missing on the remote (fork PRs or already-deleted branches).
  const diffsByHeadRef = new Map<string, string>();
  for (const pr of rawPRs) {
    if (typeof pr.headRefName !== 'string' || !pr.headRefName) continue;
    const remoteHeadRef = `refs/remotes/${remote}/${pr.headRefName}`;
    const fetchRes = await deps.exec(
      'git',
      ['fetch', '--no-tags', remote, `+${pr.headRefName}:${remoteHeadRef}`],
      { cwd: repoRoot },
    );
    if (fetchRes.code !== 0) continue; // branch absent on remote — skip gracefully

    const diffRes = await deps.exec(
      'git',
      [
        'diff',
        '--name-only',
        '--diff-filter=AM',
        `${remote}/${baseBranch}...${remote}/${pr.headRefName}`,
      ],
      { cwd: repoRoot },
    );
    if (diffRes.code !== 0) continue; // diff failed — skip gracefully
    diffsByHeadRef.set(pr.headRefName, diffRes.stdout);
  }

  const briefPRs = parseBriefOnlyPRs(listed.stdout, diffsByHeadRef);
  if (briefPRs.length === 0) return null;

  const plan = planBriefBatch({
    prs: briefPRs,
    now: new Date(),
    baseBranch,
    slug: options.slug,
  });

  // Step 4: create the batch branch and materialize the brief files.
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

    // Check out each brief file from its owning source branch. Iterate source
    // PRs in order; later PRs win on same-path conflicts (consistent with
    // planBriefBatch's last-writer-wins dedup).
    for (const pr of plan.sourcePRs) {
      for (const briefPath of pr.briefPaths) {
        await exec(deps.exec, worktree, 'git', [
          'checkout',
          `${remote}/${pr.headRefName}`,
          '--',
          briefPath,
        ]);
      }
    }

    await exec(deps.exec, worktree, 'git', ['add', '--', 'briefs/']);
    await exec(deps.exec, worktree, 'git', ['commit', '--no-verify', '-m', plan.commitMessage]);
    await exec(deps.exec, worktree, 'git', ['push', '--no-verify', '-u', remote, plan.batchBranch]);

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

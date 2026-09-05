import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Workflow checkout contract.
 *
 * Live intake went down the moment intake parity landed: the `reserve` job of
 * goobers-run.yml executes `.github/scripts/goobers/intake-selection.mjs`, but
 * its checkout was sparse on `scripts/agent` only, so every issue-event
 * dispatch died in "Resolve Goobers recovery target" with MODULE_NOT_FOUND and
 * no issue could reach selection at all. Nothing deterministic caught it,
 * because the previous contract test asserted the sparse pattern LITERALLY
 * ('scripts/agent') instead of deriving it from what the job actually runs.
 *
 * This suite parses job step ORDERING and derives the requirement from the
 * steps themselves, so any future step that executes or sources a repository
 * path fails the build unless the job first performs a trusted, credential-free
 * checkout whose (optionally sparse) tree actually contains that path.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * Workflows whose jobs execute checked-in repository code as part of the issue
 * lifecycle. Every Goobers workflow is covered by the glob; the two legacy
 * intake workflows are named because intake parity wired the same shared
 * eligibility library into them.
 */
const EXTRA_WORKFLOWS = ['issue-copilot-intake.yml', 'epic-reprocess.yml'];

/**
 * Events where the job runs with repository write permissions against content
 * an issue/PR opener can influence. On these, a checkout MUST pin the default
 * branch (or, for a manual dispatch, the dispatcher's own ref) so the elevated
 * job never executes attacker-authored code. `schedule` is deliberately absent:
 * GitHub itself only ever schedules the default branch, so an unpinned checkout
 * there is already trusted.
 */
const PRIVILEGED_EVENTS = ['issues', 'issue_comment', 'pull_request_target', 'workflow_run'];

/** Ref expressions controlled by whoever opened the PR — never trusted. */
const UNTRUSTED_REF_TOKENS = [
  'github.event.pull_request.head',
  'github.head_ref',
  'github.event.workflow_run.head_branch',
  'github.event.workflow_run.head_sha',
  'github.event.issue.pull_request',
];

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean | undefined>;
}

interface WorkflowJob {
  name?: string;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown> | string | string[];
  jobs?: Record<string, WorkflowJob | undefined>;
}

interface RepoAccess {
  stepIndex: number;
  stepName: string;
  repoPath: string;
}

function listWorkflows(): string[] {
  const goobers = readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.startsWith('goobers-') && file.endsWith('.yml'))
    .sort();
  return [...goobers, ...EXTRA_WORKFLOWS];
}

function loadWorkflow(file: string): Workflow {
  return parse(readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')) as Workflow;
}

function triggerNames(workflow: Workflow): string[] {
  const on = workflow.on;
  if (typeof on === 'string') {
    return [on];
  }
  if (Array.isArray(on)) {
    return on;
  }
  return Object.keys(on ?? {});
}

/**
 * Shell comments are stripped first so a remediation message that merely NAMES
 * a repository path (they routinely do) is never mistaken for an execution of
 * it. Only execution/sourcing positions count.
 */
function stripComments(script: string): string {
  return script
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const REPO_ROOTS = String.raw`\.github|\.goobers|scripts|src|tests|docs`;
const PATH_TAIL = String.raw`[A-Za-z0-9._/-]+`;

const ACCESS_PATTERNS: RegExp[] = [
  // node/bash/sh/python executing a checked-in file by repo-relative path.
  new RegExp(
    String.raw`(?:^|[\s;&|(])(?:node|bash|sh|python3?)\s+(?:-\S+\s+)*"?(?:\$\{?GITHUB_WORKSPACE\}?/)?((?:${REPO_ROOTS})/${PATH_TAIL})`,
    'g',
  ),
  // `. path` / `source path`, including the `lease_lib="$…"; . "$lease_lib"` form.
  new RegExp(
    String.raw`(?:^|[\s;&|(])(?:\.|source)\s+"?(?:\$\{?GITHUB_WORKSPACE\}?/)?((?:${REPO_ROOTS})/${PATH_TAIL})`,
    'g',
  ),
  // Any absolute workspace path: nothing builds one except to read the tree.
  new RegExp(String.raw`\$\{?GITHUB_WORKSPACE\}?/((?:${REPO_ROOTS})(?:/${PATH_TAIL})?)`, 'g'),
  // Copying a checked-in source tree (e.g. `cp -R .goobers …`).
  new RegExp(String.raw`(?:^|[\s;&|(])cp\s+(?:-\S+\s+)*((?:${REPO_ROOTS})[A-Za-z0-9._/-]*)`, 'g'),
];

/**
 * `actions/github-script` bodies are JavaScript, not shell, and they reach the
 * checked-out tree through workspace-joined dynamic imports rather than through
 * an executable invocation. They are just as checkout-dependent as a `run:`
 * step, so they get their own detector.
 */
const SCRIPT_ACCESS_PATTERNS: RegExp[] = [
  // path.join(process.env.GITHUB_WORKSPACE, '<repo path>')
  new RegExp(
    String.raw`process\.env\.GITHUB_WORKSPACE\s*,\s*['"\`]((?:${REPO_ROOTS})/${PATH_TAIL})`,
    'g',
  ),
  // `${process.env.GITHUB_WORKSPACE}/<repo path>`
  new RegExp(
    String.raw`\$\{\s*process\.env\.GITHUB_WORKSPACE\s*\}/((?:${REPO_ROOTS})/${PATH_TAIL})`,
    'g',
  ),
  // require('<repo path>') / import('<repo path>')
  new RegExp(String.raw`(?:require|import)\(\s*['"\`]\.?/?((?:${REPO_ROOTS})/${PATH_TAIL})`, 'g'),
];

/** Line and block comments are stripped so a commented path is not an access. */
function stripJsComments(script: string): string {
  return script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function matchPaths(body: string, patterns: RegExp[]): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const captured = match[1]?.replace(/["'`;|&)]+$/, '').replace(/\/+$/, '');
      if (captured) {
        found.add(captured);
      }
    }
  }
  return [...found].sort();
}

function repoPathsIn(script: string): string[] {
  return matchPaths(stripComments(script), ACCESS_PATTERNS);
}

function repoPathsInScript(script: string): string[] {
  return matchPaths(stripJsComments(script), SCRIPT_ACCESS_PATTERNS);
}

/**
 * A `uses: ./path` step runs a checked-in composite/JS action: the action
 * directory itself must be in the (possibly sparse) tree, or the run dies with
 * "Can't find 'action.yml'".
 */
function localActionPath(step: WorkflowStep): string | null {
  if (typeof step.uses !== 'string' || !step.uses.startsWith('./')) {
    return null;
  }
  return step.uses.slice(2).replace(/\/+$/, '');
}

function repoAccesses(steps: WorkflowStep[]): RepoAccess[] {
  const accesses: RepoAccess[] = [];
  steps.forEach((step, stepIndex) => {
    const stepName = step.name ?? `step #${stepIndex + 1}`;
    const push = (repoPath: string) => accesses.push({ stepIndex, stepName, repoPath });

    if (typeof step.run === 'string') {
      repoPathsIn(step.run).forEach(push);
    }

    const localAction = localActionPath(step);
    if (localAction) {
      push(localAction);
    }

    const script = step.with?.script;
    if (typeof script === 'string') {
      repoPathsInScript(script).forEach(push);
    }
  });
  return accesses;
}

function checkoutSteps(steps: WorkflowStep[]): Array<{ index: number; step: WorkflowStep }> {
  return steps
    .map((step, index) => ({ index, step }))
    .filter(
      ({ step }) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    );
}

function sparsePatterns(step: WorkflowStep): string[] | null {
  const raw = step.with?.['sparse-checkout'];
  if (typeof raw !== 'string') {
    return null;
  }
  return raw
    .split('\n')
    .map((entry) =>
      entry
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/^\/+|\/+$/g, ''),
    )
    .filter((entry) => entry.length > 0);
}

function sparseCovers(patterns: string[], repoPath: string): boolean {
  return patterns.some((pattern) => repoPath === pattern || repoPath.startsWith(`${pattern}/`));
}

interface JobUnderTest {
  workflowFile: string;
  jobId: string;
  steps: WorkflowStep[];
  privileged: boolean;
}

function jobsUnderTest(): JobUnderTest[] {
  const jobs: JobUnderTest[] = [];
  for (const workflowFile of listWorkflows()) {
    const workflow = loadWorkflow(workflowFile);
    const privileged = triggerNames(workflow).some((trigger) =>
      PRIVILEGED_EVENTS.includes(trigger),
    );
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      jobs.push({ workflowFile, jobId, steps: job?.steps ?? [], privileged });
    }
  }
  return jobs;
}

describe('Goobers workflow checkout contract', () => {
  it('covers every Goobers workflow plus the shared legacy intake workflows', () => {
    const files = listWorkflows();
    expect(files).toContain('goobers-run.yml');
    for (const extra of EXTRA_WORKFLOWS) {
      expect(files).toContain(extra);
    }
    // A job list that silently emptied out would make every assertion below
    // vacuously true, which is exactly how this class of outage stays invisible.
    expect(jobsUnderTest().length).toBeGreaterThan(5);
  });

  it('checks out trusted repository contents before the first repo-path access', () => {
    const failures: string[] = [];
    for (const { workflowFile, jobId, steps } of jobsUnderTest()) {
      const accesses = repoAccesses(steps);
      if (accesses.length === 0) {
        continue;
      }
      const first = accesses.reduce((earliest, access) =>
        access.stepIndex < earliest.stepIndex ? access : earliest,
      );
      const checkouts = checkoutSteps(steps);
      if (checkouts.length === 0) {
        failures.push(
          `${workflowFile} job '${jobId}': step '${first.stepName}' runs '${first.repoPath}' but the job never checks the repository out. Add an actions/checkout step (ref: \${{ github.event.repository.default_branch }}, persist-credentials: false) as the first step that precedes it.`,
        );
        continue;
      }
      const firstCheckout = checkouts[0]!.index;
      if (firstCheckout > first.stepIndex) {
        failures.push(
          `${workflowFile} job '${jobId}': step '${first.stepName}' runs '${first.repoPath}' at position ${first.stepIndex + 1}, before the checkout at position ${firstCheckout + 1}. Move the checkout ahead of the first repo-file access.`,
        );
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('never executes an untrusted ref and never persists credentials', () => {
    const failures: string[] = [];
    for (const { workflowFile, jobId, steps, privileged } of jobsUnderTest()) {
      for (const { index, step } of checkoutSteps(steps)) {
        const label = `${workflowFile} job '${jobId}' checkout at position ${index + 1}`;
        if (step.with?.['persist-credentials'] !== false) {
          failures.push(
            `${label}: must set 'persist-credentials: false' so a repo-script step cannot push with the job's token.`,
          );
        }
        const ref = typeof step.with?.ref === 'string' ? step.with.ref : '';
        for (const token of UNTRUSTED_REF_TOKENS) {
          if (ref.includes(token)) {
            failures.push(
              `${label}: ref '${ref}' resolves to PR-author-controlled content via '${token}'. Pin \${{ github.event.repository.default_branch }} instead.`,
            );
          }
        }
        if (privileged && !ref.includes('github.event.repository.default_branch')) {
          failures.push(
            `${label}: this workflow is triggered by a privileged event (${PRIVILEGED_EVENTS.join(', ')}), so the checkout must pin 'ref: \${{ github.event.repository.default_branch }}' (a workflow_dispatch fallback to github.ref_name is allowed alongside it). Found ref '${ref || '<unset>'}'.`,
          );
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('sparse-checks-out every repository path the job actually runs', () => {
    const failures: string[] = [];
    for (const { workflowFile, jobId, steps } of jobsUnderTest()) {
      const accesses = repoAccesses(steps);
      const checkouts = checkoutSteps(steps);
      if (accesses.length === 0 || checkouts.length === 0) {
        continue;
      }
      const patterns = sparsePatterns(checkouts[0]!.step);
      if (patterns === null) {
        continue;
      }
      for (const access of accesses) {
        if (access.stepIndex < checkouts[0]!.index || sparseCovers(patterns, access.repoPath)) {
          continue;
        }
        failures.push(
          `${workflowFile} job '${jobId}': step '${access.stepName}' runs '${access.repoPath}', which the sparse-checkout patterns [${patterns.join(', ')}] do not fetch — the step will fail with ENOENT/MODULE_NOT_FOUND at runtime. Add the containing directory to that step's sparse-checkout list.`,
        );
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('keeps the reservation job able to reach intake selection', () => {
    const workflow = loadWorkflow('goobers-run.yml');
    const reserve = workflow.jobs?.reserve?.steps ?? [];
    const checkout = checkoutSteps(reserve)[0];
    expect(checkout?.index).toBe(0);
    const patterns = sparsePatterns(checkout!.step) ?? [];
    // The regression that took live intake down: the selector and the
    // eligibility library it imports both live under `.github/scripts`.
    expect(patterns).toContain('.github/scripts');
    expect(patterns).toContain('scripts/agent');

    const accesses = repoAccesses(reserve).map((access) => access.repoPath);
    expect(accesses).toContain('.github/scripts/goobers/intake-selection.mjs');
    expect(accesses).toContain('scripts/agent/goobers-reservation-lease.sh');
    for (const repoPath of accesses) {
      expect(sparseCovers(patterns, repoPath), `${repoPath} is not sparse-checked-out`).toBe(true);
    }
  });

  it('detects the non-`run` repository accesses that exist today', () => {
    // Anti-vacuity: the local-action and github-script detectors must actually
    // fire on the workflows under test, or the two clauses added for them are
    // dead code that would keep a broken checkout green.
    const accessesFor = (file: string, jobId: string) =>
      repoAccesses(loadWorkflow(file).jobs?.[jobId]?.steps ?? []).map((access) => access.repoPath);

    expect(accessesFor('goobers-run.yml', 'run')).toContain('.github/actions/host-profile');
    expect(accessesFor('goobers-contract-validation.yml', 'validate-contracts')).toContain(
      '.github/actions/setup-node',
    );
    expect(accessesFor('goobers-lifecycle-owner.yml', 'ownership')).toContain(
      '.github/scripts/lifecycle-ownership.mjs',
    );
    expect(accessesFor('goobers-review-threads.yml', 'review-threads')).toContain(
      '.github/scripts/ci-recovery/github.mjs',
    );
  });

  it('detects the exact regression it exists to prevent', () => {
    // A self-test on the detector: with the pre-fix pattern list, the live
    // selector invocation must be reported as uncovered. Without this, a
    // detector that silently stopped matching would keep the suite green.
    const brokenPatterns = ['scripts/agent'];
    expect(sparseCovers(brokenPatterns, '.github/scripts/goobers/intake-selection.mjs')).toBe(
      false,
    );
    expect(sparseCovers(brokenPatterns, 'scripts/agent/goobers-reservation-lease.sh')).toBe(true);
    expect(
      repoPathsIn('node .github/scripts/goobers/intake-selection.mjs --issue "${issue_file}"'),
    ).toEqual(['.github/scripts/goobers/intake-selection.mjs']);
    expect(
      repoPathsIn('lease_lib="${GITHUB_WORKSPACE}/scripts/agent/goobers-reservation-lease.sh"'),
    ).toEqual(['scripts/agent/goobers-reservation-lease.sh']);
    // Comments and error messages name paths constantly; they are not accesses.
    expect(repoPathsIn('# see .github/workflows/goobers-run.yml for the shared list')).toEqual([]);

    // Local composite actions are repository code too: the action directory
    // must be in the tree before `uses: ./…` can resolve action.yml.
    expect(localActionPath({ uses: './.github/actions/host-profile' })).toBe(
      '.github/actions/host-profile',
    );
    expect(localActionPath({ uses: 'actions/checkout@v4' })).toBeNull();
    expect(sparseCovers(brokenPatterns, '.github/actions/host-profile')).toBe(false);

    // actions/github-script bodies import from the workspace; those imports are
    // checkout-dependent in exactly the same way as a `node …` invocation.
    expect(
      repoPathsInScript(
        [
          "const { pathToFileURL } = require('node:url');",
          'const ownership = await import(pathToFileURL(path.join(',
          '  process.env.GITHUB_WORKSPACE,',
          "  '.github/scripts/lifecycle-ownership.mjs',",
          ')));',
        ].join('\n'),
      ),
    ).toEqual(['.github/scripts/lifecycle-ownership.mjs']);
    expect(
      repoPathsInScript('const p = `${process.env.GITHUB_WORKSPACE}/.github/scripts/x.mjs`;'),
    ).toEqual(['.github/scripts/x.mjs']);
    expect(
      repoPathsInScript("// disabled: process.env.GITHUB_WORKSPACE, '.github/scripts/x.mjs'"),
    ).toEqual([]);

    // And the whole-step collector must surface both non-`run` forms.
    const collected = repoAccesses([
      { name: 'local action', uses: './.github/actions/setup-node' },
      {
        name: 'script import',
        uses: 'actions/github-script@v7',
        with: {
          script:
            "await import(path.join(process.env.GITHUB_WORKSPACE, '.github/scripts/ci-recovery/github.mjs'));",
        },
      },
    ]).map((access) => access.repoPath);
    expect(collected).toEqual([
      '.github/actions/setup-node',
      '.github/scripts/ci-recovery/github.mjs',
    ]);
  });
});

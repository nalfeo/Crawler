import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  GOOBERS_RUN_START_MARKER_PREFIX,
  GOOBERS_RUN_RESULT_MARKER_PREFIX,
} from '../../.github/scripts/ci-recovery/markers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface GoobersActionsWorkflow {
  on: {
    issues?: { types?: string[] };
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: {
      inputs?: {
        goobers_version?: { default?: string };
        issue_number?: { default?: string };
        abandon_existing?: { default?: boolean };
      };
    };
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: {
    run?: {
      if?: string;
      name?: string;
      env?: Record<string, string>;
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
      steps?: Array<{
        name?: string;
        id?: string;
        if?: string;
        uses?: string;
        env?: Record<string, string>;
        run?: string;
        with?: Record<string, string | boolean>;
      }>;
    };
  };
}

interface GoobersValidateWorkflow {
  on: { workflow_dispatch?: { inputs?: { goobers_version?: { default?: string } } } };
  jobs: {
    validate?: {
      steps?: Array<{
        name?: string;
        run?: string;
      }>;
    };
  };
}

interface GoobersDefinition {
  spec: {
    runControls?: { maxRepasses?: number };
    tasks: Array<{
      name: string;
      next?: string;
      run?: { command?: string[]; script?: string };
      inputsFrom?: Record<string, string>;
      capabilities?: string[];
      contextFrom?: string[];
      expectedOutputs?: string[];
      retry?: { maxAttempts?: number; backoffSeconds?: number };
    }>;
    gates: Array<{
      name: string;
      agentic?: { retry?: { maxAttempts?: number; backoffSeconds?: number } };
      branches?: Record<string, string>;
    }>;
  };
}

interface GoobersInstance {
  repos: Array<{ token?: { env?: string } }>;
  credentials?: Array<{ capability?: string; token?: { env?: string } }>;
  runner?: { envPassthrough?: string[] };
}

interface CiRecoveryWorkflow {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { options?: string[] }>;
    };
  };
  jobs?: {
    reconcile?: {
      steps?: Array<{ name?: string; env?: Record<string, string> }>;
    };
  };
}

interface CompositeAction {
  inputs?: Record<string, { default?: string }>;
  runs: {
    steps: Array<{
      name?: string;
      if?: string;
      uses?: string;
      run?: string;
      with?: Record<string, string | boolean>;
    }>;
  };
}

function loadYaml<T>(...segments: string[]): T {
  return parse(readFileSync(path.join(REPO_ROOT, ...segments), 'utf8')) as T;
}

/**
 * Reads the `runner.envPassthrough` entries out of the instance manifest that
 * the "Materialize checked-in source into the instance" step writes with a
 * heredoc, so contract assertions test the generated list itself rather than
 * substring matches against the whole script.
 */
function readGeneratedEnvPassthrough(script: string | null | undefined): string[] {
  if (!script) {
    return [];
  }
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'envPassthrough:');
  if (start === -1) {
    return [];
  }
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s*-\s+(\S+)\s*$/);
    if (!match?.[1]) {
      break;
    }
    entries.push(match[1]);
  }
  return entries;
}

function extractPinnedSha(script: string | null | undefined): string | null {
  if (!script) {
    return null;
  }
  const match = script.match(/GOOBERS_SHA256=([0-9a-f]{64})/);
  return match?.[1] ?? null;
}

describe('Goobers automatic dispatch and recovery', () => {
  it('dispatches immediately for eligible issue events and performs an hourly recovery sweep', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');

    // `opened`/`reopened` are the immediate-dispatch path for the transferred
    // legacy intake cohort; `labeled` remains the explicit approval path.
    expect(workflow.on.issues?.types).toEqual(['opened', 'reopened', 'labeled']);
    expect(workflow.on.schedule).toEqual([{ cron: '37 * * * *' }]);
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.jobs.run?.if).toContain("github.event_name != 'issues'");
    expect(workflow.jobs.run?.if).toContain("github.event.label.name == 'goobers:approved'");
    expect(workflow.jobs.run?.if).toContain("github.event.action != 'labeled'");
    expect(workflow.jobs.run?.if).toContain("github.event.issue.state == 'open'");
    expect(workflow.jobs.run?.if).toContain("vars.LIFECYCLE_MUTATION_OWNER == 'goobers'");
    expect(workflow.concurrency).toBeUndefined();
    expect(workflow.jobs.run?.concurrency).toEqual({
      group: 'goobers-run',
      'cancel-in-progress': false,
    });
  });

  it('routes the whole legacy intake cohort through the canonical selector', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const recovery =
      steps.find((step) => step.name === 'Resolve Goobers recovery target')?.run ?? '';
    const start = steps.find((step) => step.name === 'Comment on Goobers run start')?.run ?? '';

    // The selectors themselves must never be restated in YAML/jq — that
    // duplication is what let the approved-only cohort drift from legacy's.
    expect(recovery).toContain('node .github/scripts/goobers/intake-selection.mjs');
    // The payload is handed over as a file, never piped: a non-blocking pipe on
    // the Actions runner made a synchronous stdin read fail with EAGAIN and
    // burned live intake runs before any issue could be claimed.
    expect(start).toContain(
      'node .github/scripts/goobers/intake-selection.mjs --issue "$issue_file"',
    );
    expect(recovery).not.toContain('intake-selection.mjs --issue -');
    expect(start).not.toContain('intake-selection.mjs --issue -');
    // The shared query carries no cohort filter; the extra narrow approved
    // query exists only so the approved queue cannot fall off the far side of
    // GitHub Search's 1000-result cap.
    const sharedQuery = recovery.slice(
      recovery.indexOf('search_open_unassigned() {'),
      recovery.indexOf('search_open_unassigned --label'),
    );
    expect(sharedQuery).not.toContain("--label 'goobers:approved'");
    expect(recovery).toContain("search_open_unassigned --label 'goobers:approved'");
    expect(recovery).toContain('jq -s \'add\' "${approved_file}" "${parity_file}"');
    expect(start).not.toContain('index("goobers:approved") != null');
    expect(workflow.jobs.run?.env?.LIFECYCLE_MUTATION_OWNER).toBe(
      '${{ vars.LIFECYCLE_MUTATION_OWNER }}',
    );
    expect(workflow.jobs.run?.env?.ISSUE_OWNER).toBe('nalfeo');

    // Node must be installed before the selector runs, including on runs that
    // then skip, so eligibility never depends on the runner image's Node.
    const nodeIndex = steps.findIndex((step) => step.name === 'Set up Node.js');
    const recoveryIndex = steps.findIndex(
      (step) => step.name === 'Resolve Goobers recovery target',
    );
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(nodeIndex).toBeLessThan(recoveryIndex);
    expect(steps[nodeIndex]?.if).toBeUndefined();
    expect(steps.filter((step) => step.name === 'Set up Node.js')).toHaveLength(1);
  });

  it('skips ineligible issues without claiming, and exempts resumes from fresh-intake gates', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const recovery =
      steps.find((step) => step.name === 'Resolve Goobers recovery target')?.run ?? '';
    const start = steps.find((step) => step.name === 'Comment on Goobers run start')?.run ?? '';

    expect(recovery).toContain('is not in the Goobers intake cohort');
    expect(recovery).toContain('should_run=false');
    expect(recovery).toContain('INTAKE_COHORT="resume"');
    expect(recovery).toContain('GOOBERS_INTAKE_COHORT=${INTAKE_COHORT}');
    expect(start).toContain('if [ "${GOOBERS_INTAKE_COHORT:-}" != "resume" ]');
    expect(start).toContain('is no longer in the Goobers intake cohort');
    // The revalidated cohort must overwrite GOOBERS_INTAKE_COHORT so the
    // downstream claim fence trusts a fresh verdict, not a possibly-stale one
    // from the earlier resolve step.
    expect(start).toContain('revalidated_cohort="$(jq -r \'.cohort // ""\' <<<"$decision")"');
    expect(start).toContain(
      'echo "GOOBERS_INTAKE_COHORT=${revalidated_cohort}" >> "${GITHUB_ENV}"',
    );
    // The claim fence downstream must accept the cohort the workflow resolved.
    const definition = readFileSync(
      path.join(REPO_ROOT, '.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml'),
      'utf8',
    );
    expect(definition).toContain('GOOBERS_INTAKE_COHORT');
    expect(definition).toContain('(approved|legacy-parity|resume) claimable=true ;;');
    // The fence must trust the canonical cohort verdict outright rather than
    // re-deriving approval via its own label lookup, which drifted out of
    // sync with the case-insensitive canonical selector.
    expect(definition).not.toContain('index("goobers:approved") != null');
  });

  it('uses trusted pinned defaults outside manual dispatches', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const job = workflow.jobs.run;
    const checkout = job?.steps?.find((step) => step.name === 'Checkout');
    const installDeps = job?.steps?.find((step) => step.name === 'Install project dependencies');
    const install = job?.steps?.find((step) => step.name === 'Install Copilot CLI');
    const upload = job?.steps?.find((step) => step.name === 'Upload run journal');

    expect(job?.name).toContain("inputs.workflow || 'crawler-feature-pr'");
    expect(job?.env).toMatchObject({
      GOOBERS_VERSION: "${{ inputs.goobers_version || 'goobers-dev-6d33b160' }}",
      GOOBERS_WORKFLOW: "${{ inputs.workflow || 'crawler-feature-pr' }}",
    });
    expect(workflow.on.workflow_dispatch?.inputs?.goobers_version?.default).toBe(
      'goobers-dev-6d33b160',
    );
    expect(workflow.permissions?.checks).toBe('write');
    expect(checkout?.with).toEqual({
      ref: "${{ github.event_name == 'workflow_dispatch' && github.ref_name || github.event.repository.default_branch }}",
      'persist-credentials': false,
    });
    expect(installDeps?.run).toBe('npm ci');
    expect(install?.env?.COPILOT_CLI_VERSION).toBe("${{ inputs.copilot_cli_version || '1.0.80' }}");
    expect(upload?.with?.name).toContain("inputs.workflow || 'crawler-feature-pr'");
  });

  it('bounds same-run retries without retrying claim or provider mutations', () => {
    const definition = loadYaml<GoobersDefinition>(
      '.goobers',
      'gaggles',
      'crawler',
      'workflows',
      'crawler-feature-pr.yaml',
    );
    const tasks = new Map(definition.spec.tasks.map((task) => [task.name, task]));
    const hydrate = tasks.get('hydrate-requirements');
    const plan = tasks.get('plan');
    const materializePlan = tasks.get('materialize-plan');
    const implement = tasks.get('implement');
    const review = definition.spec.gates.find((gate) => gate.name === 'review');
    const runStep = loadYaml<GoobersActionsWorkflow>(
      '.github',
      'workflows',
      'goobers-run.yml',
    ).jobs.run?.steps?.find((step) => step.name === 'Run the workflow');

    expect(definition.spec.runControls?.maxRepasses).toBe(6);
    expect(hydrate).toBeDefined();
    expect(tasks.get('query-backlog')?.expectedOutputs).toEqual([
      'id',
      'title',
      'body',
      'url',
      'workspaceBranch',
    ]);
    expect(tasks.get('query-backlog')?.run?.script).toContain('GOOBERS_RECOVERY_ISSUE');
    // GOOBERS_INSTANCE is Actions-only (set + envPassthrough'd by goobers-run.yml);
    // the documented local instance.yaml.example does not pass it through, so the
    // fresh-claim command must fall back to GOOBERS_INSTANCE_ROOT (the value a local
    // Goobers run always has) and finally '.' rather than crashing under `set -eu`.
    expect(tasks.get('query-backlog')?.run?.script).toContain(
      'goobers backlog-query --claim "${GOOBERS_INSTANCE:-${GOOBERS_INSTANCE_ROOT:-.}}"',
    );
    expect(tasks.get('query-backlog')?.run?.script).toContain('goobers:approved');
    expect(tasks.get('query-backlog')?.run?.script).toContain('assignees');
    expect(tasks.get('query-backlog')?.run?.script).toContain('GOOBERS_RESUME_BRANCH');
    expect(tasks.get('query-backlog')?.expectedOutputs).toContain('workspaceBranch');
    const recoveryStep = loadYaml<GoobersActionsWorkflow>(
      '.github',
      'workflows',
      'goobers-run.yml',
    ).jobs.run?.steps?.find((step) => step.name === 'Resolve Goobers recovery target');
    // Eligibility filters and the oldest-first ordering must be applied by
    // GitHub's server-side search qualifiers, not a local sort after `gh
    // issue list`'s 100-issue page: a local sort/filter can both miss an
    // older eligible issue and falsely report "no work" when the fetched
    // page happens to be all assigned/in-review.
    expect(recoveryStep?.run).toContain('gh search issues');
    expect(recoveryStep?.run).toContain('--repo "${GITHUB_REPOSITORY}"');
    expect(recoveryStep?.run).toContain('--state open');
    // Deliberately NOT filtered to `goobers:approved` in the shared query:
    // Goobers must claim at least the whole legacy intake cohort, and the
    // canonical selector decides membership from the returned payloads. The
    // separate narrow approved query keeps the approved queue reachable past
    // GitHub Search's 1000-result cap.
    const sharedQuery = (recoveryStep?.run ?? '').slice(
      (recoveryStep?.run ?? '').indexOf('search_open_unassigned() {'),
      (recoveryStep?.run ?? '').indexOf('search_open_unassigned --label'),
    );
    expect(sharedQuery).not.toContain("--label 'goobers:approved'");
    expect(recoveryStep?.run).toContain("search_open_unassigned --label 'goobers:approved'");
    expect(recoveryStep?.run).toContain(
      '--json number,state,labels,assignees,author,isPullRequest',
    );
    expect(recoveryStep?.run).toContain('--no-assignee');
    expect(recoveryStep?.run).toContain(
      '-- \'-label:"goobers/status:in-review" -label:"goobers/status:completed-existing-work"\'',
    );
    expect(recoveryStep?.run).toContain('--sort created --order asc --limit 1000');
    expect(recoveryStep?.run).not.toContain('"repo:${GITHUB_REPOSITORY} is:issue');
    expect(recoveryStep?.run).toContain(
      '"repos/${GITHUB_REPOSITORY}/issues/$1/dependencies/blocked_by"',
    );
    expect(recoveryStep?.run).toMatch(
      /gh api --paginate \\\n\s+"repos\/\$\{GITHUB_REPOSITORY\}\/issues\/\$1\/dependencies\/blocked_by"/,
    );
    expect(recoveryStep?.run).toContain('find_open_dependency_blockers "${candidate_issue}"');
    expect(recoveryStep?.run).toMatch(
      /Scheduled recovery skipped blocked issue #\$\{candidate_issue\}.*continue/s,
    );
    expect(recoveryStep?.run).toMatch(
      /for candidate_issue in \$\([\s\S]*gh search issues[\s\S]*find_open_dependency_blockers "\$\{candidate_issue\}"[\s\S]*continue[\s\S]*ISSUE_NUMBER="\$\{candidate_issue\}"/,
    );
    expect(recoveryStep?.run).toContain('find_open_dependency_blockers "${ISSUE_NUMBER}"');
    expect(recoveryStep?.run).toContain('Skipping before Goobers claim or repository mutation.');
    expect(recoveryStep?.run).toContain('should_run=false');
    expect(runStep?.if).toBe("steps.recovery.outputs.should_run != 'false'");
    // An empty backlog sweep must skip every costly setup step (binary
    // download/verify, npm ci, Copilot CLI install, instance materialization),
    // not just the final `goobers run` invocation, so hourly no-work sweeps
    // stay cheap.
    const goobersRunSteps = loadYaml<GoobersActionsWorkflow>(
      '.github',
      'workflows',
      'goobers-run.yml',
    ).jobs.run?.steps;
    const gatedStepNames = [
      'Require Goobers auth token',
      'Resolve pinned archive checksum',
      'Cache pinned Goobers archive',
      'Verify archive against pinned checksum',
      'Extract binary',
      'Verify binary version',
      'Install project dependencies',
      'Install Copilot CLI',
      'Validate .goobers source tree',
      'Scaffold throwaway instance root',
      'Materialize checked-in source into the instance',
    ];
    // `Set up Node.js` is deliberately ungated and ahead of resolution: the
    // eligibility selector itself runs on Node, so gating it on the resolve
    // step's own output would be circular. It is a cached ~2s step.
    const setupNode = goobersRunSteps?.find((step) => step.name === 'Set up Node.js');
    expect(setupNode?.if).toBeUndefined();
    for (const stepName of gatedStepNames) {
      const step = goobersRunSteps?.find((candidate) => candidate.name === stepName);
      expect(step?.if, `expected "${stepName}" to be gated on should_run`).toBe(
        "steps.recovery.outputs.should_run != 'false'",
      );
    }
    for (const stepName of [
      'Download pinned private Goobers draft',
      'Download pinned public Goobers release',
    ]) {
      const step = goobersRunSteps?.find((candidate) => candidate.name === stepName);
      expect(step?.if, `expected "${stepName}" to be gated on should_run`).toContain(
        "steps.recovery.outputs.should_run != 'false'",
      );
    }
    expect(hydrate?.inputsFrom).toEqual({
      issueNumber: 'query-backlog.id',
      issueTitle: 'query-backlog.title',
      issueBody: 'query-backlog.body',
      issueUrl: 'query-backlog.url',
    });
    expect(hydrate?.run?.script).not.toContain('gh issue view');
    expect(hydrate?.run?.script).toContain('GOOBERS_INPUT_ISSUENUMBER');
    expect(hydrate?.run?.script).toContain('GOOBERS_INPUT_ISSUEBODY');
    expect(hydrate?.run?.script).not.toContain('.goobers/context');
    expect(hydrate?.run?.script).toContain('requirements-result.json');
    expect(hydrate?.capabilities).toBeUndefined();
    expect(hydrate?.retry).toBeUndefined();
    expect(plan?.expectedOutputs).toEqual([
      'implementationPlan',
      'hardGate',
      'verdict',
      'appleEstimate',
    ]);
    expect(plan?.next).toBe('materialize-plan');
    expect(materializePlan?.inputsFrom).toEqual({
      implementationPlan: 'plan.implementationPlan',
      hardGate: 'plan.hardGate',
      verdict: 'plan.verdict',
      appleEstimate: 'plan.appleEstimate',
    });
    expect(materializePlan?.run?.script).toContain('implementation-plan-result.json');
    expect(materializePlan?.run?.script).toContain('GOOBERS_INPUT_IMPLEMENTATIONPLAN');
    expect(materializePlan?.next).toBe('implement');
    expect(implement?.contextFrom).toContain('hydrate-requirements');
    expect(implement?.contextFrom).toContain('materialize-plan');
    expect(implement?.contextFrom).not.toContain('plan');
    expect(tasks.get('push-branch')?.run?.script).toContain('npm ci');
    expect(tasks.get('push-branch')?.run?.script).toContain('goobers push-branch');
    // The pre-review `checkpoint-branch` stage was removed; `implement` now
    // hands straight to the review gate and no checkpoint task remains.
    expect(implement?.next).toBe('review');
    expect(tasks.get('push-branch')?.next).toBe('local-ci');
    expect(tasks.get('local-ci')?.next).toBe('local-gate');
    expect(tasks.get('checkpoint-branch')).toBeUndefined();
    for (const name of ['plan', 'implement']) {
      expect(tasks.get(name)?.retry).toEqual({ maxAttempts: 2, backoffSeconds: 30 });
    }
    for (const name of [
      'query-backlog',
      'push-branch',
      'local-ci',
      'open-pr',
      'close-out',
      'park-needs-human',
      'needs-remediation',
    ]) {
      expect(tasks.get(name)?.retry).toBeUndefined();
    }
    expect(review?.agentic?.retry).toEqual({ maxAttempts: 2, backoffSeconds: 30 });
    expect(runStep?.env).toMatchObject({
      GITHUB_TOKEN: '${{ github.token }}',
      GH_TOKEN: '${{ secrets.GOOBERS_GITHUB_TOKEN || secrets.CRAWLER_CI_PAT }}',
      GOOBERS_GITHUB_TOKEN: '${{ secrets.GOOBERS_GITHUB_TOKEN || secrets.CRAWLER_CI_PAT }}',
      COPILOT_GITHUB_TOKEN: '${{ secrets.COPILOT_GITHUB_TOKEN }}',
    });
    expect(runStep?.run).not.toMatch(/\b(for|while|until)\b/);
  });

  it('pins the private draft trial while retaining the validated v0.3.3 release', () => {
    const runWorkflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const validateWorkflow = loadYaml<GoobersValidateWorkflow>(
      '.github',
      'workflows',
      'goobers-validate.yml',
    );
    const runShaScript = runWorkflow.jobs.run?.steps?.find(
      (step) => step.name === 'Resolve pinned archive checksum',
    )?.run;
    const validateShaScript = validateWorkflow.jobs.validate?.steps?.find(
      (step) => step.name === 'Resolve pinned archive checksum',
    )?.run;
    const runDefault = runWorkflow.jobs.run?.env?.GOOBERS_VERSION;
    const validateDefault = validateWorkflow.on.workflow_dispatch?.inputs?.goobers_version?.default;
    const draftSha = '4758e471e845925c364621db61bdaddefc4a46f45de65aa1cf8a970e3376adde';
    const releaseSha = '47b09d6bff1578726b52716ca7b8fba0f416171723090663c0b25ae924d36a82';

    expect(runDefault).toBe("${{ inputs.goobers_version || 'goobers-dev-6d33b160' }}");
    expect(validateDefault).toBe('v0.3.3');
    expect(runShaScript).toContain(`GOOBERS_SHA256=${draftSha}`);
    expect(runShaScript).toContain(`GOOBERS_SHA256=${releaseSha}`);
    expect(runShaScript).toContain('GOOBERS_ASSET=goobers_dev_linux_amd64.tar.gz');
    expect(extractPinnedSha(validateShaScript)).toBe(releaseSha);
  });

  it('downloads the draft asset with authenticated gh and projects hosted progress', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const privateDownload = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Download pinned private Goobers draft',
    );
    const publicDownload = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Download pinned public Goobers release',
    );
    const run = workflow.jobs.run?.steps?.find((step) => step.name === 'Run the workflow');
    const upload = workflow.jobs.run?.steps?.find((step) => step.name === 'Upload run journal');

    expect(privateDownload?.if).toContain("env.GOOBERS_VERSION == 'goobers-dev-6d33b160'");
    expect(privateDownload?.env?.GH_TOKEN).toBe('${{ secrets.CRAWLER_CI_PAT }}');
    expect(privateDownload?.run).toContain('gh release download "${GOOBERS_VERSION}"');
    expect(privateDownload?.run).toContain('--repo "${GITHUB_REPOSITORY}"');
    expect(privateDownload?.run).toContain('--pattern "${GOOBERS_ASSET}"');
    expect(publicDownload?.if).toContain("env.GOOBERS_VERSION != 'goobers-dev-6d33b160'");
    expect(publicDownload?.env?.GH_TOKEN).toBeUndefined();
    expect(publicDownload?.run).toContain('curl -fsSL -o dl/goobers.tar.gz');
    expect(run?.env).toMatchObject({
      GITHUB_TOKEN: '${{ github.token }}',
      GOOBERS_GITHUB_TOKEN: '${{ secrets.GOOBERS_GITHUB_TOKEN || secrets.CRAWLER_CI_PAT }}',
      GH_TOKEN: '${{ secrets.GOOBERS_GITHUB_TOKEN || secrets.CRAWLER_CI_PAT }}',
      COPILOT_GITHUB_TOKEN: '${{ secrets.COPILOT_GITHUB_TOKEN }}',
    });

    expect(run?.run).toContain(
      'goobers run --github-progress "$GOOBERS_WORKFLOW" "$GOOBERS_INSTANCE"',
    );
    expect(upload?.with).toEqual({
      name: "goobers-run-${{ inputs.workflow || 'crawler-feature-pr' }}-${{ github.run_id }}",
      path: '${{ env.GOOBERS_INSTANCE }}/gaggles/*/runs/',
      'if-no-files-found': 'warn',
      'retention-days': 30,
    });
  });

  it('profiles every real Goobers run without profiling no-work sweeps', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const installIndex = steps.findIndex((step) => step.name === 'Install project dependencies');
    const runSteps = steps.filter((step) => /^\s*goobers run(?:\s|$)/m.test(step.run ?? ''));
    const runIndex = steps.findIndex((step) => step === runSteps[0]);
    const startIndex = steps.findIndex((step) => step.name === 'Start Goobers host profile');
    const reportIndex = steps.findIndex((step) => step.name === 'Report Goobers host profile');
    const start = steps[startIndex];
    const report = steps[reportIndex];

    expect(runSteps).toHaveLength(1);
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(installIndex);
    expect(startIndex + 1).toBe(runIndex);
    expect(runIndex + 1).toBe(reportIndex);
    expect(start).toMatchObject({
      id: 'host-profile-start',
      if: "steps.recovery.outputs.should_run != 'false'",
      uses: './.github/actions/host-profile',
      with: { mode: 'start', label: 'goobers-run' },
    });
    expect(report).toMatchObject({
      if: "always() && steps.host-profile-start.outcome == 'success'",
      uses: './.github/actions/host-profile',
      with: { mode: 'report', label: 'goobers-run' },
    });
  });

  it('inherits summary publication and the labeled JSON artifact from host-profile', () => {
    const action = loadYaml<CompositeAction>('.github', 'actions', 'host-profile', 'action.yml');
    const publish = action.runs.steps.find((step) => step.name === 'Publish host resource profile');
    const upload = action.runs.steps.find((step) => step.name === 'Upload host resource profile');

    expect(action.inputs?.['upload-artifact']?.default).toBe('true');
    expect(publish?.run).toContain('--step-summary');
    expect(upload).toMatchObject({
      if: "${{ inputs.mode == 'report' && inputs.upload-artifact == 'true' }}",
      uses: 'actions/upload-artifact@v4',
      with: {
        name: 'host-profile-${{ inputs.label }}-${{ github.run_attempt }}',
        path: 'files/host-resources.json',
        'if-no-files-found': 'ignore',
      },
    });
  });

  it('rebinds recovered runs inside Goobers-managed worktrees', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const recoveryCheckout = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Checkout recovered Goobers branch',
    );
    const materialize = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Materialize checked-in source into the instance',
    );
    const instance = loadYaml<GoobersInstance>('.goobers', 'instance.yaml.example');

    expect(recoveryCheckout).toBeUndefined();
    expect(materialize?.run).toContain('envPassthrough:');
    expect(readGeneratedEnvPassthrough(materialize?.run)).toEqual([
      'GOOBERS_INSTANCE',
      'GOOBERS_RECOVERY_ISSUE',
      'GOOBERS_INTAKE_COHORT',
      'GOOBERS_RESUME_BRANCH',
      'GH_TOKEN',
      'GITHUB_REPOSITORY',
    ]);
    expect(instance.runner?.envPassthrough).toEqual([
      'GOOBERS_RECOVERY_ISSUE',
      'GOOBERS_INTAKE_COHORT',
      'GOOBERS_RESUME_BRANCH',
    ]);
  });

  it('never forwards the hosted-progress GITHUB_TOKEN into runner stages', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const materialize = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Materialize checked-in source into the instance',
    );
    const runStep = workflow.jobs.run?.steps?.find((step) => step.name === 'Run the workflow');
    const instance = loadYaml<GoobersInstance>('.goobers', 'instance.yaml.example');

    // GITHUB_TOKEN carries checks/issues/PR write scopes for hosted progress on
    // the top-level `goobers run` process only. Forwarding it through the
    // runner would hand those scopes to stages that never declared them.
    expect(runStep?.env?.GITHUB_TOKEN).toBe('${{ github.token }}');
    expect(readGeneratedEnvPassthrough(materialize?.run)).not.toContain('GITHUB_TOKEN');
    expect(instance.runner?.envPassthrough ?? []).not.toContain('GITHUB_TOKEN');
  });

  it('keeps Goobers repository and model credentials separate', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const instance = loadYaml<GoobersInstance>('.goobers', 'instance.yaml.example');
    const requireToken = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Require Goobers auth token',
    );

    expect(instance.repos[0]?.token?.env).toBe('GOOBERS_GITHUB_TOKEN');
    expect(instance.credentials).toContainEqual({
      capability: 'agent:model',
      token: { env: 'COPILOT_GITHUB_TOKEN' },
    });
    expect(requireToken?.env?.GOOBERS_AUTH_TOKEN_SET).toBe(
      '${{ secrets.GOOBERS_GITHUB_TOKEN || secrets.CRAWLER_CI_PAT }}',
    );
  });

  it('supports deterministic issue-linked PR recovery and explicit abandon', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const recovery = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Resolve Goobers recovery target',
    );

    expect(workflow.on.workflow_dispatch?.inputs).toMatchObject({
      issue_number: { default: '' },
      abandon_existing: { default: false },
    });
    expect(recovery?.env).toMatchObject({
      GOOBERS_AUTH_TOKEN_SET: '${{ secrets.GOOBERS_GITHUB_TOKEN || secrets.CRAWLER_CI_PAT }}',
      ISSUE_NUMBER: '${{ inputs.issue_number || github.event.issue.number }}',
      ABANDON_EXISTING: "${{ inputs.abandon_existing || 'false' }}",
    });
    expect(recovery?.run).toContain('issues/${issue_number}/timeline');
    expect(recovery?.run).toContain('cross-referenced');
    expect(recovery?.run).toContain('GOOBERS_GITHUB_TOKEN or CRAWLER_CI_PAT secret is required');
    expect(recovery?.run).toContain('goobers/status:in-review');
    expect(recovery?.run).toContain('Scheduled recovery selected issue');
    expect(recovery?.run).toContain('goobers/crawler/*');
    expect(recovery?.run).not.toContain('gh pr checkout "${pr_number}"');
    expect(recovery?.run).toContain('gh pr close "${pr_number}"');
    expect(recovery?.run).toContain('starting over');
    expect(recovery?.run).toContain('GOOBERS_RECOVERY_ISSUE=${ISSUE_NUMBER}');
    expect(recovery?.run).toContain('headRepository');
    expect(recovery?.run).toContain('abandon_existing=true requires an explicit issue_number');
    expect(
      workflow.jobs.run?.steps?.find((step) => step.name === 'Checkout recovered Goobers branch'),
    ).toBeUndefined();
    const definition = loadYaml<GoobersDefinition>(
      '.goobers',
      'gaggles',
      'crawler',
      'workflows',
      'crawler-feature-pr.yaml',
    );
    expect(
      definition.spec.gates.find((gate) => gate.name === 'pr-opened-gate')?.branches,
    ).toMatchObject({
      fail: 'close-out',
    });
    expect(
      workflow.jobs.run?.steps?.find((step) => step.name === 'Preserve trusted Goobers source')
        ?.run,
    ).toContain('crawler-goobers-source');
    const run = workflow.jobs.run?.steps?.find((step) => step.name === 'Run the workflow');
    expect(run?.env).toMatchObject({
      GOOBERS_RESUME_PR: '${{ env.GOOBERS_RESUME_PR }}',
      GOOBERS_RESUME_BRANCH: '${{ env.GOOBERS_RESUME_BRANCH }}',
      GOOBERS_RECOVERY_ISSUE: '${{ env.GOOBERS_RECOVERY_ISSUE }}',
    });
    const materialize = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Materialize checked-in source into the instance',
    );
    expect(materialize?.run).toContain('path: ${GOOBERS_SOURCE}');
    expect(
      workflow.jobs.run?.steps?.find((step) => step.name === 'Validate .goobers source tree')?.run,
    ).toContain('"$GOOBERS_SOURCE"');
  });

  it('filters external PR cross-references and fails closed when every candidate is unreadable', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const scripts = [
      steps.find((step) => step.name === 'Resolve Goobers recovery target')?.run ?? '',
      steps.find((step) => step.name === 'Handle no-work disposition')?.run ?? '',
      steps.find((step) => step.name === 'Comment on Goobers run result')?.run ?? '',
    ].join('\n');

    expect(scripts.match(/\.source\.issue\.repository_url == \$repo_url/g)).toHaveLength(3);
    expect(scripts.match(/if ! details="\$\(gh pr view /g)).toHaveLength(3);
    expect(scripts.match(/unreadable_candidate=true/g)).toHaveLength(3);
    expect(scripts.match(/return 2/g)).toHaveLength(3);
    expect(scripts).toContain('candidate_pr="$(find_open_goobers_pr "$candidate_issue")"');
    expect(scripts).toContain('pr_number="$(find_open_goobers_pr "$ISSUE_NUMBER")"');
    expect(scripts).toContain('open_pr="$(find_open_goobers_pr "$issue_number")"');
    expect(scripts).toContain('pr_number="$(find_open_goobers_pr "$issue_number")"');
    expect(scripts).toContain('if [ "$lookup_status" -ne 0 ]');
  });

  it('posts separate durable start and result comments with explicit run and PR links', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const start = steps.find((step) => step.name === 'Comment on Goobers run start');
    const run = steps.find((step) => step.name === 'Run the workflow');
    const result = steps.find((step) => step.name === 'Comment on Goobers run result');

    expect(start).toBeDefined();
    expect(result).toBeDefined();
    expect(start).not.toBe(result);
    expect(steps.indexOf(start!)).toBeLessThan(steps.indexOf(run!));
    expect(steps.indexOf(result!)).toBeGreaterThan(steps.indexOf(run!));

    expect(start?.if).toBe("steps.recovery.outputs.should_run != 'false'");
    expect(start?.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(start?.run).toContain('gh issue view "$issue_number"');
    expect(start?.run).toContain(
      'node .github/scripts/goobers/intake-selection.mjs --issue "$issue_file"',
    );
    expect(start?.run).toContain('[.assignees[]] | length == 0');
    expect(start?.run).toContain('issues/${issue_number}/dependencies/blocked_by');
    expect(start?.run).toContain('No start comment or Goobers claim was created');
    expect(start?.run).toContain(
      'https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}',
    );
    expect(start?.run).toContain('crawler-goobers-run-start:v1');
    expect(start?.run).toContain(GOOBERS_RUN_START_MARKER_PREFIX);
    expect(start?.run).toMatch(/echo "\$marker"\s*\n\s*echo\s*\n\s*echo "Goobers started work/);
    expect(start?.run).toContain('find_issue_comment_id');
    expect(start?.run).toContain('gh issue comment "$issue_number"');

    expect(result?.if).toBe('always()');
    expect(result?.env).toMatchObject({
      GH_TOKEN: '${{ github.token }}',
      JOB_STATUS: '${{ job.status }}',
      ARTIFACT_NAME:
        "goobers-run-${{ inputs.workflow || 'crawler-feature-pr' }}-${{ github.run_id }}",
    });
    expect(result?.run).toContain('.outputs.prNumber // empty');
    expect(result?.run).toContain('.outputs["pull-request-url"] // empty');
    expect(result?.run).toContain('.externalRef.kind == "pr"');
    expect(result?.run).toContain('pr_number="${GOOBERS_RESUME_PR:-}"');
    expect(result?.run).toContain('issues/${issue_number}/timeline');
    expect(result?.run).toContain('[[ "$branch" == goobers/crawler/* ]]');
    expect(result?.run).toContain(
      'pr_url="https://github.com/${GITHUB_REPOSITORY}/pull/${pr_number}"',
    );
    expect(result?.run).toContain('echo "- Pull request: #${pr_number} — ${pr_url}"');
    expect(result?.run).toContain(GOOBERS_RUN_RESULT_MARKER_PREFIX);
    expect(result?.run).toMatch(
      /echo "\$marker"\s*\n\s*echo\s*\n\s*echo "Goobers GitHub Actions run/,
    );
    expect(result?.run).toContain('find_issue_comment_id');
    expect(result?.run).toContain('gh api --silent --method PATCH');
    expect(result?.run).toContain('gh issue comment "$issue_number"');
    expect(result?.run).toContain('no PR number could be recovered');
  });

  it('posts a terminal result for a numeric recovery issue even when no journal exists', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const result = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Comment on Goobers run result',
    );
    const script = result?.run ?? '';
    const issueResolutionIndex = script.indexOf('issue_number="${GOOBERS_RECOVERY_ISSUE:-}"');
    const journalLookupIndex = script.indexOf('events_file=""');

    expect(issueResolutionIndex).toBeGreaterThanOrEqual(0);
    expect(issueResolutionIndex).toBeLessThan(journalLookupIndex);
    expect(script).toContain('events_input="/dev/null"');
    expect(script).not.toContain('No Goobers journal events found; skipping issue comment.');
    expect(script).toContain('if ! [[ "$issue_number" =~ ^[0-9]+$ ]]');
    expect(script).toContain('Goobers run id(s): \\`${run_ids:-unknown}\\`');
    expect(script).toContain('Terminal journal events: none recorded.');
    expect(script).toContain('gh issue comment "$issue_number"');
  });

  it('tolerates malformed trailing journal lines while retaining valid terminal events', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const disposition = steps.find((step) => step.name === 'Handle no-work disposition')?.run ?? '';
    const result = steps.find((step) => step.name === 'Comment on Goobers run result')?.run ?? '';

    for (const script of [disposition, result]) {
      expect(script).toContain('jq -Rrc \'try fromjson catch empty\' "$events_file"');
      expect(script).toContain('source_line_count="$(awk');
      expect(script).toContain('valid_line_count="$(awk');
      expect(script).toContain('malformed Goobers journal line(s)');
      expect(script).toContain('"$events_input" | tail');
    }
  });

  it('renders PR resolution errors as terminal failures before failing the result step', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const result = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Comment on Goobers run result',
    );
    const script = result?.run ?? '';
    const postIndex = script.indexOf('gh issue comment "$issue_number"');
    const failIndex = script.lastIndexOf('if [ -n "$pr_resolution_error" ]');

    expect(script).toContain('display_status="failure"');
    expect(script).toContain('finished with **${display_status}**');
    expect(script).toContain('### PR resolution failure');
    expect(script).toContain('echo "$pr_resolution_error"');
    expect(script).toContain('echo "::error::${pr_resolution_error}"');
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(failIndex).toBeGreaterThan(postIndex);
    expect(script.match(/marker="<!-- crawler-goobers-run-result:v1 /g)).toHaveLength(1);
    expect(script).toContain('echo "$marker"');
  });

  it('releases failed claims without a PR while preserving resumable PR ownership', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const disposition = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Handle no-work disposition',
    );
    const script = disposition?.run ?? '';
    const openPrCheckIndex = script.indexOf('if [ -n "$open_pr" ]');
    const releaseIndex = script.indexOf('release_claim "$issue_number"', openPrCheckIndex);

    expect(disposition?.env?.JOB_STATUS).toBe('${{ job.status }}');
    expect(script).toContain('[ "$JOB_STATUS" = "failure" ]');
    expect(script).toContain('[ "$JOB_STATUS" = "cancelled" ]');
    expect(script).toContain('issues/${issue_number}/timeline');
    expect(script).toContain('[[ "$branch" == goobers/crawler/* ]]');
    expect(script).toContain('open Goobers PR #${open_pr} preserves resumable work');
    expect(script).toContain('if [ -n "${GOOBERS_RESUME_PR:-}" ]');
    expect(script).toContain('open_pr="$(find_open_goobers_pr "$issue_number")"');
    expect(script).toContain('resume PR #${GOOBERS_RESUME_PR} is no longer open');
    expect(script).toContain('stale_resume=true');
    expect(script).toContain('no replacement PR or no-work disposition was recorded');
    expect(openPrCheckIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(openPrCheckIndex);
    expect(script).toContain('without an open Goobers PR. Restored retry eligibility');
    expect(script).toContain('gh workflow run goobers-run.yml -f issue_number=${issue_number}');
  });

  // Production incident: Goobers runs 33925493716 (issue #4252) and
  // 33926202682 (issue #4253) failed in "Resolve Goobers recovery target", and
  // the failure handler then reported that the claimed issue number could not
  // be recovered — even though both runs were `issues` events that named their
  // target — because GOOBERS_RECOVERY_ISSUE was only written after every
  // fallible lookup had already had its chance to fail.
  it('records an explicitly named issue before any fallible lookup can fail', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const recovery =
      workflow.jobs.run?.steps?.find((step) => step.name === 'Resolve Goobers recovery target')
        ?.run ?? '';

    expect(recovery).toContain('persist_recovery_issue() {');
    expect(recovery).toContain('echo "GOOBERS_RECOVERY_ISSUE=$1" >> "${GITHUB_ENV}"');

    const persistIndex = recovery.indexOf('persist_recovery_issue "${ISSUE_NUMBER}"');
    expect(persistIndex).toBeGreaterThan(0);
    expect(persistIndex).toBeLessThan(recovery.indexOf('find_open_goobers_pr "$ISSUE_NUMBER"'));
    expect(persistIndex).toBeLessThan(recovery.indexOf('decision="$(decide_issue'));
    // Every sweep-selected target is recorded at selection time too, so a
    // failure between selection and the final env write stays attributable.
    expect(recovery.match(/persist_recovery_issue "\$\{ISSUE_NUMBER\}"/g)).toHaveLength(3);
    // Falling through to the sweep must un-attribute the run, or the handler
    // would release a claim that was never made against the event's issue.
    expect(recovery).toContain('persist_recovery_issue ""');
  });

  it('leaves no stale in-review claim when a run fails before Goobers ever starts', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const disposition =
      workflow.jobs.run?.steps?.find((step) => step.name === 'Handle no-work disposition')?.run ??
      '';

    // No journal means the gaggle's query-backlog claim never ran, so no
    // goobers/status:in-review label can exist for this run. Hard-failing there
    // buried the real failure under a second, false "stale claim" error.
    expect(disposition).toContain('if [ -z "$events_file" ]; then');
    expect(disposition).toContain('no goobers/status:in-review label was created by this run');
    const noJournalIndex = disposition.indexOf('if [ -z "$events_file" ]; then');
    const unrecoverableIndex = disposition.indexOf(
      'but the claimed issue number could not be recovered. Inspect artifact',
    );
    expect(noJournalIndex).toBeGreaterThan(0);
    expect(noJournalIndex).toBeLessThan(unrecoverableIndex);

    // Releasing the claim is this step's whole purpose, so a failed release
    // must name the manual remediation instead of a bare `gh` error.
    expect(disposition).toContain('release_claim() {');
    expect(disposition).toMatch(
      /--remove-label 'goobers\/status:in-review'; then\n\s+echo "::error::Could not remove/,
    );
    expect(disposition).toContain('Remove it manually, then retry with: gh workflow run');
    expect(disposition.match(/release_claim "\$issue_number"/g)).toHaveLength(3);
  });

  it('does not strand claimed issues when an implementer incorrectly returns no-work', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const retry = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Handle no-work disposition',
    );
    const diagnostics = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Comment on Goobers run result',
    );
    const coderInstructions = readFileSync(
      path.join(REPO_ROOT, '.goobers', 'gaggles', 'crawler', 'goobers', 'coder', 'instructions.md'),
      'utf8',
    );
    const producerInstructions = readFileSync(
      path.join(
        REPO_ROOT,
        '.goobers',
        'gaggles',
        'crawler',
        'goobers',
        'producer',
        'instructions.md',
      ),
      'utf8',
    );

    expect(coderInstructions).toContain('Do not return `no-work` merely');
    expect(coderInstructions).toContain('linked merged pull request');
    expect(coderInstructions).toContain('outputs.disposition');
    expect(coderInstructions).toContain('completed-existing-work');
    expect(producerInstructions).toContain("repository's existing canonical configuration");
    expect(producerInstructions).toContain('do not by themselves');
    expect(producerInstructions).toContain('require a maintainer decision');
    expect(retry?.if).toBe("always() && steps.recovery.outputs.should_run != 'false'");
    expect(retry?.env?.GOOBERS_RESUME_PR).toBe('${{ env.GOOBERS_RESUME_PR }}');
    expect(retry?.run).toContain('if [ -n "${GOOBERS_RESUME_PR:-}" ]');
    expect(retry?.run).toContain('preserving in-review ownership');
    expect(retry?.run).toContain('.status == "no-work"');
    expect(retry?.run).toContain('outputs.disposition // empty');
    expect(retry?.run).toContain('no_work_disposition" = "completed-existing-work"');
    expect(retry?.run).toContain("gh label view 'goobers/status:completed-existing-work'");
    expect(retry?.run).toContain("--add-label 'goobers/status:completed-existing-work'");
    expect(retry?.run).toContain("--remove-label 'goobers/status:in-review'");
    expect(retry?.run).toContain('returned invalid no-work');
    expect(retry?.run).toContain('gh workflow run goobers-run.yml -f issue_number=${issue_number}');
    expect(diagnostics?.run).toContain('GOOBERS_RECOVERY_ISSUE');
    expect(diagnostics?.run).toContain('.stage == "query-backlog"');
  });

  it('preserves single-writer lease fields in ci-recovery dispatch wiring', () => {
    const workflow = loadYaml<CiRecoveryWorkflow>('.github', 'workflows', 'ci-recovery.yml');
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
    const reconcileStep = workflow.jobs?.reconcile?.steps?.find(
      (step) => step.name === 'Reconcile PR or update shepherd lease',
    );

    expect(inputs.lease_id).toBeDefined();
    expect(inputs.expected_head_sha).toBeDefined();
    expect(inputs.expected_base_ref).toBeDefined();
    expect(inputs.operation?.options).toEqual(
      expect.arrayContaining(['reconcile', 'lease-acquire', 'lease-heartbeat', 'lease-release']),
    );
    expect(reconcileStep?.env).toMatchObject({
      LEASE_ID: '${{ inputs.lease_id }}',
      EXPECTED_HEAD_SHA: '${{ inputs.expected_head_sha }}',
      EXPECTED_BASE_REF: '${{ inputs.expected_base_ref }}',
    });
  });
});

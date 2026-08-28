import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

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
      steps?: Array<{
        name?: string;
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

function loadYaml<T>(...segments: string[]): T {
  return parse(readFileSync(path.join(REPO_ROOT, ...segments), 'utf8')) as T;
}

function extractPinnedSha(script: string | null | undefined): string | null {
  if (!script) {
    return null;
  }
  const match = script.match(/GOOBERS_SHA256=([0-9a-f]{64})/);
  return match?.[1] ?? null;
}

describe('Goobers automatic dispatch and recovery', () => {
  it('runs for the exact approval label and performs an hourly recovery sweep', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');

    expect(workflow.on.issues?.types).toEqual(['labeled']);
    expect(workflow.on.schedule).toEqual([{ cron: '37 * * * *' }]);
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.jobs.run?.if).toContain("github.event_name != 'issues'");
    expect(workflow.jobs.run?.if).toContain("github.event.label.name == 'goobers:approved'");
    expect(workflow.jobs.run?.if).toContain("github.event.issue.state == 'open'");
    expect(workflow.concurrency).toEqual({
      group: 'goobers-run',
      'cancel-in-progress': false,
    });
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
    const checkpoint = tasks.get('checkpoint-branch');
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
    expect(tasks.get('query-backlog')?.run?.script).toContain('goobers:approved');
    expect(tasks.get('query-backlog')?.run?.script).toContain('assignees');
    expect(tasks.get('query-backlog')?.run?.script).toContain('GOOBERS_RESUME_BRANCH');
    expect(tasks.get('query-backlog')?.expectedOutputs).toContain('workspaceBranch');
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
    expect(implement?.next).toBe('checkpoint-branch');
    expect(checkpoint?.run?.script).toContain('goobers push-branch');
    expect(checkpoint?.run?.script).toContain('npm ci');
    expect(checkpoint?.run?.script).toContain('goobers open-pr');
    expect(checkpoint?.next).toBe('review');
    for (const name of ['plan', 'implement']) {
      expect(tasks.get(name)?.retry).toEqual({ maxAttempts: 2, backoffSeconds: 30 });
    }
    for (const name of [
      'query-backlog',
      'push-branch',
      'checkpoint-branch',
      'open-pr',
      'close-out',
      'park-needs-human',
      'needs-remediation',
    ]) {
      expect(tasks.get(name)?.retry).toBeUndefined();
    }
    expect(review?.agentic?.retry).toEqual({ maxAttempts: 2, backoffSeconds: 30 });
    expect(runStep?.env).toMatchObject({
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
    expect(materialize?.run).toContain('GOOBERS_RESUME_BRANCH');
    expect(instance.runner?.envPassthrough).toEqual([
      'GOOBERS_RECOVERY_ISSUE',
      'GOOBERS_RESUME_BRANCH',
    ]);
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
    expect(recovery?.run).toContain('issues/${ISSUE_NUMBER}/timeline');
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
});

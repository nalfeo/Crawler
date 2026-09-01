import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// Contract test for .github/workflows/dev-ingest-lifecycle.yml, the
// automation that (a) deploys infra/dev-build-ingest.bicep + Function code
// via Azure OIDC federated login and (b) runs a scheduled live canary
// against the deployed /runs endpoint to detect a broken/expired/revoked
// CRAWLER_CI_PAT before a real player report silently fails. This test
// parses the workflow as YAML (no GitHub Actions runtime dependency, so it
// runs fast and deterministically in `npm run test:unit`) and fails if:
//   - the deploy job is changed to use an Azure client secret instead of
//     OIDC federated login (id-token: write + client-id/tenant-id/
//     subscription-id, no client-secret),
//   - the canary's schedule trigger is removed (silently downgrading the
//     credential check from "automatic and periodic" to "manual only"),
//   - the Bicep `githubCiPat` parameter stops being sourced from the
//     `CRAWLER_CI_PAT` repo secret (e.g. is hardcoded or renamed away).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'dev-ingest-lifecycle.yml');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface WorkflowJob {
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowDoc {
  // YAML parses the bare `on:` key as the boolean `true` under YAML 1.1
  // rules; the `yaml` package preserves it as the string key `"on"` only
  // when parsed with `merge`/schema options we don't set, so read via a
  // small helper that checks both to stay robust either way.
  on?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(): WorkflowDoc {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  return parse(raw) as WorkflowDoc;
}

function getTriggers(doc: WorkflowDoc): Record<string, unknown> {
  const asRecord = doc as unknown as Record<string, unknown>;
  const triggers = asRecord.on ?? asRecord['true'] ?? asRecord[String(true)];
  expect(triggers, 'expected the workflow to declare an "on:" trigger block').toBeTruthy();
  return triggers as Record<string, unknown>;
}

function allSteps(job: WorkflowJob | undefined): WorkflowStep[] {
  return job?.steps ?? [];
}

describe('dev-ingest-lifecycle.yml credential + trigger wiring', () => {
  it('parses as valid YAML with deploy and canary jobs', () => {
    const doc = loadWorkflow();
    expect(doc.jobs.deploy, 'expected a "deploy" job').toBeTruthy();
    expect(doc.jobs.canary, 'expected a "canary" job').toBeTruthy();
  });

  it('deploys via Azure OIDC federated login, never an Azure client secret', () => {
    const doc = loadWorkflow();
    const deploySteps = allSteps(doc.jobs.deploy);
    const loginStep = deploySteps.find((s) => (s.uses ?? '').startsWith('azure/login@'));
    expect(loginStep, 'expected an azure/login step in the deploy job').toBeTruthy();

    const withBlock = loginStep?.with ?? {};
    expect(withBlock['client-id'], 'azure/login must supply client-id for OIDC').toBeTruthy();
    expect(withBlock['tenant-id'], 'azure/login must supply tenant-id for OIDC').toBeTruthy();
    expect(
      withBlock['subscription-id'],
      'azure/login must supply subscription-id for OIDC',
    ).toBeTruthy();
    expect(
      withBlock['client-secret'],
      'azure/login must NOT use client-secret — this workflow is required to use OIDC federated login, never a stored Azure client secret',
    ).toBeUndefined();

    // Belt-and-suspenders: scan the raw file text too, so a future step
    // added anywhere else in the workflow can't reintroduce a client secret
    // under a different step/key name.
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    expect(
      /client-secret\s*:/i.test(raw),
      'no step in this workflow may reference an Azure client-secret; use OIDC federated login instead',
    ).toBe(false);
  });

  it('grants id-token: write only to the OIDC-authenticating deploy job', () => {
    const doc = loadWorkflow();
    expect(doc.jobs.deploy, 'expected a "deploy" job').toBeTruthy();
    expect(doc.jobs.deploy?.permissions?.['id-token']).toBe('write');
    // The top-level default and every other job must stay least-privilege —
    // id-token: write should not leak to jobs that don't need to federate.
    for (const [name, job] of Object.entries(doc.jobs)) {
      if (name === 'deploy') continue;
      expect(
        job.permissions?.['id-token'],
        `job "${name}" should not have id-token: write`,
      ).not.toBe('write');
    }
  });

  it('runs the canary on a schedule, not only on manual/dispatch triggers', () => {
    const doc = loadWorkflow();
    const triggers = getTriggers(doc);
    expect(
      triggers.schedule,
      'expected a schedule: trigger so the canary runs automatically without a human kicking it off',
    ).toBeTruthy();
    expect(Array.isArray(triggers.schedule) ? triggers.schedule.length : 0).toBeGreaterThan(0);
  });

  it('sources the Bicep githubCiPat parameter from the CRAWLER_CI_PAT repo secret', () => {
    const doc = loadWorkflow();
    const deploySteps = allSteps(doc.jobs.deploy);
    const deployStep = deploySteps.find((s) => (s.run ?? '').includes('deployment group create'));
    expect(
      deployStep,
      'expected an `az deployment group create` step in the deploy job',
    ).toBeTruthy();
    // The secret is passed through an `env:` indirection (not interpolated
    // directly into the shell script via `${{ secrets.* }}`) so a secret
    // value containing shell metacharacters can't be misparsed or, worse,
    // executed — see https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-an-intermediate-environment-variable.
    // So this asserts on the step's `run` + `env` together rather than
    // requiring a literal `secrets.CRAWLER_CI_PAT` substring inside `run:`.
    expect(
      deployStep?.run,
      'expected the deploy step to pass a shell-variable-sourced githubCiPat parameter',
    ).toMatch(/githubCiPat=(?!.*\$\{\{).*\$\w+/);
    const envValues = Object.values(deployStep?.env ?? {}).map(String);
    expect(
      envValues.some((v) => /secrets\.CRAWLER_CI_PAT/.test(v)),
      "expected the deploy step's env: block to source a variable from secrets.CRAWLER_CI_PAT",
    ).toBe(true);
  });

  it("never gives the canary job access to the CRAWLER_CI_PAT secret it's meant to detect failures of", () => {
    const raw = readFileSync(WORKFLOW_PATH, 'utf8');
    const doc = loadWorkflow();
    const canaryJobText = extractJobBlock(raw, 'canary');
    // Strip full-line comments before checking so an explanatory comment
    // naming CRAWLER_CI_PAT (documenting that it's deliberately excluded)
    // doesn't trip this assertion — only an actual secrets.* reference
    // should fail it.
    const withoutComments = canaryJobText
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(
      withoutComments.includes('CRAWLER_CI_PAT'),
      'the canary job must rely only on GITHUB_TOKEN so a broken CRAWLER_CI_PAT cannot also suppress the alert',
    ).toBe(false);
    expect(doc.jobs.canary?.permissions?.issues).toBe('write');
  });

  it('serializes runs with a workflow-level concurrency gate so overlapping canary runs cannot race the alert dedup logic', () => {
    // alert-lib.mjs does a list-then-create with no server-side lock: two
    // canary runs racing (e.g. a scheduled run overlapping a manual
    // workflow_dispatch) could otherwise create duplicate alert issues, or
    // one run could reopen an alert a concurrent healthy run just closed.
    // A workflow-level `concurrency:` group serializes every trigger onto
    // one queue instead of letting runs execute in parallel.
    const doc = loadWorkflow();
    expect(doc.concurrency?.group, 'expected a top-level concurrency.group').toBeTruthy();
    // cancel-in-progress must stay false (or unset, which GitHub Actions
    // treats as false) — cancelling an in-flight deploy because a scheduled
    // canary queued up would be worse than waiting for it.
    expect(doc.concurrency?.['cancel-in-progress']).not.toBe(true);
  });

  it('every `run:` shell block in the workflow has balanced if/fi (and for/done, while/done) blocks', () => {
    // Regression guard: a prior revision of this workflow had an `if/then/
    // else` in the preflight job with no closing `fi`, which made the step
    // fail its shell syntax check on every push/workflow_dispatch run
    // (silently skipping the whole deploy job every time). YAML parsing
    // alone can't catch this because the multi-line `run:` block is just a
    // scalar string to the YAML parser — only counting bash keyword tokens
    // inside it can.
    const doc = loadWorkflow();
    for (const [jobName, job] of Object.entries(doc.jobs)) {
      for (const [stepIdx, step] of allSteps(job).entries()) {
        if (!step.run) continue;
        const tokens = (line: string) =>
          line
            .replace(/#.*$/, '') // strip trailing comments so `# ...fi...` text doesn't count
            // Strip double-quoted string contents (e.g. `echo "...prose..."`) so
            // human-readable messages can freely use words like "if"/"for"
            // without being mistaken for bash keywords — only unquoted shell
            // syntax should be counted.
            .replace(/"[^"]*"/g, '""')
            .split(/[\s;]+/)
            .filter(Boolean);
        const wordCounts = { if: 0, fi: 0, for: 0, while: 0, done: 0 };
        for (const rawLine of step.run.split('\n')) {
          for (const word of tokens(rawLine)) {
            if (word in wordCounts) {
              wordCounts[word as keyof typeof wordCounts] += 1;
            }
          }
        }
        expect(
          wordCounts.if,
          `job "${jobName}" step ${stepIdx} (${step.name ?? 'unnamed'}): every "if" must be closed with "fi"`,
        ).toBe(wordCounts.fi);
        expect(
          wordCounts.for + wordCounts.while,
          `job "${jobName}" step ${stepIdx} (${step.name ?? 'unnamed'}): every "for"/"while" must be closed with "done"`,
        ).toBe(wordCounts.done);
      }
    }
  });

  it('fails the run (not just a warning) when release-triggered deploy is missing OIDC secrets', () => {
    // The preflight step must exit non-zero on the missing-secrets branch so
    // a push-to-main (or an implicit workflow_dispatch) can never silently
    // report success while omitting the Function publish. Only the explicit
    // skip_deploy=true branch may exit 0 without deploying.
    const doc = loadWorkflow();
    const preflightSteps = allSteps(doc.jobs.preflight);
    const checkStep = preflightSteps.find((s) => (s.run ?? '').includes('configured=false'));
    expect(checkStep, 'expected the OIDC-secrets-check step in the preflight job').toBeTruthy();
    const script = checkStep?.run ?? '';

    const missingSecretsBranch = script.split('configured=false')[1] ?? '';
    expect(
      /::error::/.test(missingSecretsBranch),
      'the missing-OIDC-secrets branch must use ::error:: (fails the run), not ::warning:: (which would only annotate a run that still reports success)',
    ).toBe(true);
    expect(
      /\bexit 1\b/.test(missingSecretsBranch.split('\n').slice(0, 3).join('\n')),
      'the missing-OIDC-secrets branch must `exit 1` so the preflight job — and therefore the whole release-triggered run — fails',
    ).toBe(true);

    // The explicit opt-out path (skip_deploy=true) is the only branch allowed
    // to exit 0 without configuring OIDC. `skip_deploy` appears multiple
    // times in the script (the `if` condition, comments, and echo prose), so
    // `.split('skip_deploy')[1]` would only grab the text between the 1st
    // and 2nd occurrence, not "everything from the first occurrence on" —
    // use indexOf to slice from the first occurrence to the end instead, then
    // stop at the next standalone `fi` (word-boundary regex, not a bare
    // substring match — a plain `.split('fi')` would incorrectly cut inside
    // words like "configured").
    const skipDeployIdx = script.indexOf('skip_deploy');
    expect(
      skipDeployIdx,
      'expected a skip_deploy reference in the preflight script',
    ).toBeGreaterThanOrEqual(0);
    const afterSkipDeploy = script.slice(skipDeployIdx);
    const fiMatch = /\bfi\b/.exec(afterSkipDeploy);
    const skipBranch = fiMatch ? afterSkipDeploy.slice(0, fiMatch.index) : afterSkipDeploy;
    expect(/exit 0/.test(skipBranch)).toBe(true);
  });
});

// Minimal helper: slice out one top-level job's YAML block from the raw
// source by indentation, so we can assert on job-scoped text without a full
// GitHub-Actions-aware YAML schema.
function extractJobBlock(raw: string, jobName: string): string {
  const lines = raw.split('\n');
  const startIdx = lines.findIndex((l) => new RegExp(`^  ${jobName}:\\s*$`).test(l));
  expect(startIdx, `expected to find a top-level "${jobName}:" job block`).toBeGreaterThanOrEqual(
    0,
  );
  const rest = lines.slice(startIdx + 1);
  const endOffset = rest.findIndex((l) => /^ {2}\S/.test(l));
  const block = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return block.join('\n');
}

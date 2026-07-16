import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for a real review finding on merge-train-validate.yml's
 * "publish" job: the "Publish immutable candidate result" step used to
 * compute `PASSED: ${{ needs.verify.result == 'success' }}` and then map
 * `passed ? 'success' : 'failure'` -- collapsing every non-success verify
 * outcome (including `cancelled` and `skipped`, and a timed-out job, which
 * GitHub Actions also surfaces as `cancelled`) into a `failure` check-run
 * conclusion.
 *
 * `trainCheckState()` (.github/scripts/merge-train/state.mjs) treats a
 * `cancelled` conclusion as `'missing'` (retryable/infrastructure) but any
 * other non-success conclusion as `'failure'` (a genuine candidate defect
 * that triggers bisection). Publishing `failure` for an infrastructure
 * cancellation/skip would have falsely told the merge train the candidate's
 * code was broken and kicked off an unnecessary bisection instead of a
 * simple retry.
 *
 * This test parses the REAL workflow YAML (no reimplementation of the
 * mapping), extracts the actual `with.script` text from the publish step,
 * and executes it for real (with `github.rest.checks.create` stubbed) so a
 * regression that re-collapses the mapping is caught even if the wording
 * changes.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkflowStep {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: { script?: string; [key: string]: unknown };
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(): WorkflowDoc {
  const raw = readFileSync(
    path.join(REPO_ROOT, '.github/workflows/merge-train-validate.yml'),
    'utf8',
  );
  return parse(raw) as WorkflowDoc;
}

function getPublishScript(doc: WorkflowDoc): string {
  const steps = doc.jobs.publish?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === 'Publish immutable candidate result');
  if (!step) throw new Error('"Publish immutable candidate result" step not found');
  if (!step.uses?.startsWith('actions/github-script')) {
    throw new Error('expected the publish step to use actions/github-script');
  }
  const script = step.with?.script;
  if (typeof script !== 'string') throw new Error('expected step.with.script to be a string');
  return script;
}

/** Runs the real, unmodified publish script against a fake `github` client. */
async function runPublishScript(verifyResult: string): Promise<{
  conclusion: string;
  title: string;
  calls: string[];
  dispatch: { owner: string; repo: string; workflow_id: string; ref: string } | undefined;
}> {
  const doc = loadWorkflow();
  const script = getPublishScript(doc);

  let createArgs: { conclusion: string; output: { title: string } } | undefined;
  let dispatchArgs: { owner: string; repo: string; workflow_id: string; ref: string } | undefined;
  const calls: string[] = [];
  const github = {
    rest: {
      checks: {
        create: async (args: { conclusion: string; output: { title: string } }) => {
          calls.push('check');
          createArgs = args;
          return { data: {} };
        },
      },
      actions: {
        createWorkflowDispatch: async (args: {
          owner: string;
          repo: string;
          workflow_id: string;
          ref: string;
        }) => {
          calls.push('dispatch');
          dispatchArgs = args;
          return { data: {} };
        },
      },
    },
  };
  const context = {
    repo: { owner: 'nalfeo', repo: 'Crawler' },
    payload: { repository: { default_branch: 'main' } },
  };
  const previousEnv = {
    VERIFY_RESULT: process.env.VERIFY_RESULT,
    CANDIDATE_SHA: process.env.CANDIDATE_SHA,
    FINGERPRINT: process.env.FINGERPRINT,
    PR_NUMBERS: process.env.PR_NUMBERS,
  };
  process.env.VERIFY_RESULT = verifyResult;
  process.env.CANDIDATE_SHA = 'a'.repeat(40);
  process.env.FINGERPRINT = 'deadbeef';
  process.env.PR_NUMBERS = '42,43';
  try {
    const run = new Function('github', 'context', `return (async () => {\n${script}\n})();`) as (
      github: unknown,
      context: unknown,
    ) => Promise<void>;
    await run(github, context);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (!createArgs) throw new Error('github.rest.checks.create was not called');
  return {
    conclusion: createArgs.conclusion,
    title: createArgs.output.title,
    calls,
    dispatch: dispatchArgs,
  };
}

describe('merge-train-validate.yml publish step (verify result -> check conclusion mapping)', () => {
  it('maps a genuine executed failure to a failure conclusion', async () => {
    const { conclusion, title } = await runPublishScript('failure');
    expect(conclusion).toBe('failure');
    expect(title).toMatch(/failed/i);
  });

  it('maps a genuine success to a success conclusion', async () => {
    const { conclusion, title } = await runPublishScript('success');
    expect(conclusion).toBe('success');
    expect(title).toMatch(/passed/i);
  });

  it('maps an infrastructure cancellation to cancelled, not failure', async () => {
    const { conclusion, title } = await runPublishScript('cancelled');
    expect(conclusion).toBe('cancelled');
    expect(title).not.toMatch(/failed/i);
  });

  it('maps a skipped verify job (e.g. a superseded run) to cancelled, not failure', async () => {
    const { conclusion } = await runPublishScript('skipped');
    expect(conclusion).toBe('cancelled');
  });

  it('treats any other/unexpected verify result as cancelled (fails safe, not closed)', async () => {
    // A timed-out job surfaces as `cancelled` per GitHub Actions, but this
    // also guards against any future/unknown result string.
    const { conclusion } = await runPublishScript('timed_out');
    expect(conclusion).toBe('cancelled');
  });

  it('keeps the App-authenticated github-token wiring for the publish step', () => {
    const raw = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/merge-train-validate.yml'),
      'utf8',
    );
    const doc = parse(raw) as WorkflowDoc;
    const steps = doc.jobs.publish?.steps ?? [];
    const step = steps.find((candidate) => candidate.name === 'Publish immutable candidate result');
    expect(step?.with?.['github-token']).toBe('${{ steps.app-token.outputs.token }}');
  });

  it('wakes reconciliation with the trusted token only after publishing on the default branch', async () => {
    const { calls, dispatch } = await runPublishScript('success');
    expect(calls).toEqual(['check', 'dispatch']);
    expect(dispatch).toEqual({
      owner: 'nalfeo',
      repo: 'Crawler',
      workflow_id: 'merge-train.yml',
      ref: 'main',
    });
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

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
  id?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: { script?: string; [key: string]: unknown };
}

interface WorkflowJob {
  permissions?: Record<string, string>;
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

async function runPublishScript(verifyResult: string): Promise<{
  conclusion: string;
  title: string;
  calls: string[];
}> {
  const doc = loadWorkflow();
  const script = getPublishScript(doc);

  let createArgs: { conclusion: string; output: { title: string } } | undefined;
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

  it('grants the publish job actions: write so the GITHUB_TOKEN wake-up dispatch does not 403', () => {
    const raw = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/merge-train-validate.yml'),
      'utf8',
    );
    const doc = parse(raw) as WorkflowDoc;
    expect(doc.jobs.publish?.permissions?.actions).toBe('write');
  });

  it('publish script only calls checks.create (no dispatch — dispatch is a separate GITHUB_TOKEN step)', async () => {
    const { calls } = await runPublishScript('success');
    expect(calls).toEqual(['check']);
  });

  it('reconciliation wake-up step uses GITHUB_TOKEN, not the App token', () => {
    const raw = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/merge-train-validate.yml'),
      'utf8',
    );
    const doc = parse(raw) as WorkflowDoc;
    const steps = doc.jobs.publish?.steps ?? [];
    const wakeStep = steps.find((s) => s.name === 'Wake merge-train reconciliation');
    expect(wakeStep).toBeDefined();
    // Must be the default GITHUB_TOKEN — the App token receives 403 on
    // workflow_dispatch. Accept either equivalent default-token expression,
    // but reject anything else (App token, an unrelated PAT/secret, etc.).
    const tokenExpr = wakeStep?.with?.['github-token'] as string | undefined;
    expect(tokenExpr).not.toBe('${{ steps.app-token.outputs.token }}');
    expect(['${{ secrets.GITHUB_TOKEN }}', '${{ github.token }}']).toContain(tokenExpr);
  });

  it('reconciliation wake-up script dispatches to merge-train.yml on the default branch', () => {
    const raw = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/merge-train-validate.yml'),
      'utf8',
    );
    const doc = parse(raw) as WorkflowDoc;
    const steps = doc.jobs.publish?.steps ?? [];
    const wakeStep = steps.find((s) => s.name === 'Wake merge-train reconciliation');
    const script = wakeStep?.with?.script as string | undefined;
    expect(script).toBeDefined();
    expect(script).toContain('merge-train.yml');
    expect(script).toContain('default_branch');
  });

  it('reconciliation wake-up step runs after the publish step (not before it)', () => {
    // The wake-up dispatch is meant to fire *after* the immutable check is
    // published (so reconcile has something durable to act on). A future
    // refactor could reorder the steps while still keeping `if: always()` on
    // the wake step, which would cause a premature wake before the check
    // exists. Lock in the relative ordering.
    const raw = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/merge-train-validate.yml'),
      'utf8',
    );
    const doc = parse(raw) as WorkflowDoc;
    const steps = doc.jobs.publish?.steps ?? [];
    const publishIndex = steps.findIndex((s) => s.name === 'Publish immutable candidate result');
    const wakeIndex = steps.findIndex((s) => s.name === 'Wake merge-train reconciliation');
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(wakeIndex).toBeGreaterThan(publishIndex);
  });

  describe('retryable-check fallback for a failed publish step', () => {
    // Regression coverage for a real review finding: `if: always()` alone
    // makes the wake-up *dispatch* fire when "Publish immutable candidate
    // result" fails, but that alone does not make the wake *effective*. The
    // fingerprinted check is still whatever the original dispatch posted --
    // `in_progress` -- and trainCheckState() (state.mjs) only demotes a
    // stuck in_progress check to retryable ("missing") after
    // CANDIDATE_VALIDATION_STALE_MS (40 minutes); before that it reports
    // `pending`, which planPrefixPromotion() maps to the `wait` action. So an
    // immediate wake would just see `pending` and do nothing -- no better
    // than the unreliable schedule fallback it was meant to replace. A
    // fallback step must post a `cancelled` conclusion (mirroring
    // reconcile.mjs's own dispatchValidation catch block) BEFORE the wake
    // dispatches, so the woken reconciliation redispatches validation
    // immediately instead of waiting.
    function getFallbackStep(doc: WorkflowDoc): WorkflowStep {
      const steps = doc.jobs.publish?.steps ?? [];
      const step = steps.find(
        (candidate) => candidate.name === 'Mark candidate check retryable if publishing failed',
      );
      if (!step) throw new Error('retryable-check fallback step not found');
      return step;
    }

    it("exists, is gated on (failure() || cancelled()) AND the app-token/publish steps' own outcomes, and uses a separately-minted recovery App token", () => {
      const doc = loadWorkflow();
      const step = getFallbackStep(doc);
      // Regression coverage for three real review/verification findings:
      //
      // 1. A bare `steps.app-token.outcome == 'failure' ||
      //    steps.publish.outcome == 'failure'` condition (no status-check
      //    function) gets an implicit `success()` ANDed in by GitHub
      //    Actions -- which can NEVER be true alongside an outcome-failed
      //    check, making the fallback permanently dead code. Verified
      //    empirically in this repo (run 29467286711): a step with exactly
      //    this shape of bare condition was SKIPPED even though the step it
      //    referenced genuinely failed. The `failure() &&` prefix is
      //    required to actually run the step.
      // 2. Scoping to the step-local `outcome`s (rather than bare
      //    `failure()` alone) is defense-in-depth against `failure()`
      //    reflecting an ancestor `needs:` job's result: a genuine candidate
      //    defect fails `verify`, but "Publish immutable candidate result"
      //    still runs and correctly posts a `failure` conclusion in that
      //    case -- this fallback must not overwrite that correct `failure`
      //    with `cancelled`, which would make reconcile retry the same
      //    broken candidate forever instead of bisecting it.
      // 3. `cancelled()` (and the `outcome == 'cancelled'` checks) are needed
      //    alongside `failure()`: if "Publish immutable candidate result" is
      //    itself cancelled mid-flight (e.g. a manually-cancelled run) before
      //    its checks.create call completes, its outcome is 'cancelled', not
      //    'failure', and bare failure() is false -- without cancelled()
      //    this fallback would never fire for that case, leaving the
      //    original check in_progress indefinitely.
      expect(step.if).toBe(
        "(failure() || cancelled()) && steps.recovery-app-token.outcome == 'success' && (steps.app-token.outcome == 'failure' || steps.app-token.outcome == 'cancelled' || steps.publish.outcome == 'failure' || steps.publish.outcome == 'cancelled')",
      );
      expect(step.uses).toMatch(/^actions\/github-script/);
      // Must NOT reuse steps.app-token.outputs.token: if the ORIGINAL
      // "Generate repository app token" step is what failed, that output is
      // empty, and checks.create needs a token from the trusted App identity
      // (trainCheckState() filters by app.id). A separately-minted recovery
      // token gets an independent chance to succeed even when the original
      // mint step is the thing that failed.
      expect(step.with?.['github-token']).toBe('${{ steps.recovery-app-token.outputs.token }}');
    });

    it('gives the publish step an explicit id so later steps can check its own outcome', () => {
      const doc = loadWorkflow();
      const steps = doc.jobs.publish?.steps ?? [];
      const step = steps.find((s) => s.name === 'Publish immutable candidate result');
      expect(step?.id).toBe('publish');
    });

    it("does NOT fire when only an ancestor job (verify) failed and this job's own steps succeeded, but DOES fire on a genuine app-token/publish failure or cancellation", () => {
      // Simulates the exact bug the review finding described, plus the
      // dead-code regression the bare-outcome condition introduced, plus the
      // cancelled-publish gap.
      const doc = loadWorkflow();
      const step = getFallbackStep(doc);
      const condition = step.if ?? '';
      const evaluate = (
        failureValue: boolean,
        cancelledValue: boolean,
        appTokenOutcome: string,
        publishOutcome: string,
        recoveryTokenOutcome = 'success',
      ): boolean =>
        new Function(
          'steps',
          'failure',
          'cancelled',
          `return (${condition
            .replaceAll('steps.app-token', "steps['app-token']")
            .replaceAll('steps.recovery-app-token', "steps['recovery-app-token']")});`,
        )(
          {
            'app-token': { outcome: appTokenOutcome },
            'recovery-app-token': { outcome: recoveryTokenOutcome },
            publish: { outcome: publishOutcome },
          },
          () => failureValue,
          () => cancelledValue,
        ) as boolean;

      // Ancestor-only failure (verify failed, but publish's own steps
      // succeeded and already posted the correct `failure` conclusion):
      // failure() and cancelled() are both false in the real job (verified
      // empirically, run 29467076748), so this must not fire.
      expect(evaluate(false, false, 'success', 'success')).toBe(false);
      // Defense-in-depth: even if failure()/cancelled() were (hypothetically)
      // true here, the step-local outcome checks alone must still gate it
      // off unless app-token or publish itself is what failed/cancelled.
      expect(evaluate(true, false, 'success', 'success')).toBe(false);
      expect(evaluate(false, true, 'success', 'success')).toBe(false);
      // Genuine same-job failures: both failure() and the relevant outcome
      // check are true, so the fallback must fire.
      expect(evaluate(true, false, 'failure', 'skipped')).toBe(true);
      expect(evaluate(true, false, 'success', 'failure')).toBe(true);
      // Genuine same-job cancellation (e.g. a manually-cancelled run):
      // cancelled() true, and the outcome check reflects the cancelled step.
      expect(evaluate(false, true, 'cancelled', 'skipped')).toBe(true);
      expect(evaluate(false, true, 'success', 'cancelled')).toBe(true);
      // A failed recovery mint leaves no valid App token for checks.create.
      expect(evaluate(true, false, 'failure', 'skipped', 'failure')).toBe(false);
    });

    it('mints the recovery app token from a dedicated step gated the same way (failure()/cancelled() plus outcomes)', () => {
      const doc = loadWorkflow();
      const steps = doc.jobs.publish?.steps ?? [];
      const recoveryTokenStep = steps.find((s) => s.name === 'Generate recovery app token');
      expect(recoveryTokenStep).toBeDefined();
      expect(recoveryTokenStep?.if).toBe(
        "(failure() || cancelled()) && (steps.app-token.outcome == 'failure' || steps.app-token.outcome == 'cancelled' || steps.publish.outcome == 'failure' || steps.publish.outcome == 'cancelled')",
      );
      expect(recoveryTokenStep?.uses).toMatch(/^actions\/create-github-app-token/);
      const publishIndex = steps.findIndex((s) => s.name === 'Publish immutable candidate result');
      const recoveryTokenIndex = steps.findIndex((s) => s.name === 'Generate recovery app token');
      const fallbackIndex = steps.findIndex(
        (s) => s.name === 'Mark candidate check retryable if publishing failed',
      );
      expect(recoveryTokenIndex).toBeGreaterThan(publishIndex);
      expect(fallbackIndex).toBeGreaterThan(recoveryTokenIndex);
    });

    it('runs after the publish step and before the wake-up dispatch', () => {
      const doc = loadWorkflow();
      const steps = doc.jobs.publish?.steps ?? [];
      const publishIndex = steps.findIndex((s) => s.name === 'Publish immutable candidate result');
      const fallbackIndex = steps.findIndex(
        (s) => s.name === 'Mark candidate check retryable if publishing failed',
      );
      const wakeIndex = steps.findIndex((s) => s.name === 'Wake merge-train reconciliation');
      expect(fallbackIndex).toBeGreaterThan(publishIndex);
      expect(wakeIndex).toBeGreaterThan(fallbackIndex);
    });

    it('posts a cancelled conclusion for the fingerprinted candidate check', async () => {
      const doc = loadWorkflow();
      const step = getFallbackStep(doc);
      const script = step.with?.script;
      expect(typeof script).toBe('string');

      let createArgs:
        | { conclusion: string; head_sha: string; external_id: string; output: { title: string } }
        | undefined;
      let createCalls = 0;
      const github = {
        rest: {
          checks: {
            listForRef: async () => ({ data: { check_runs: [] } }),
            create: async (args: typeof createArgs) => {
              createCalls += 1;
              createArgs = args;
              return { data: {} };
            },
          },
        },
      };
      const context = { repo: { owner: 'nalfeo', repo: 'Crawler' } };
      const previousEnv = {
        CANDIDATE_SHA: process.env.CANDIDATE_SHA,
        FINGERPRINT: process.env.FINGERPRINT,
        APP_ID: process.env.APP_ID,
      };
      process.env.CANDIDATE_SHA = 'b'.repeat(40);
      process.env.FINGERPRINT = 'cafef00d';
      process.env.APP_ID = '12345';
      try {
        const run = new Function(
          'github',
          'context',
          `return (async () => {\n${script}\n})();`,
        ) as (github: unknown, context: unknown) => Promise<void>;
        await run(github, context);
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(createArgs).toBeDefined();
      expect(createArgs?.conclusion).toBe('cancelled');
      expect(createArgs?.head_sha).toBe('b'.repeat(40));
      expect(createArgs?.external_id).toBe('cafef00d');
      expect(createCalls).toBe(1);
    });

    it('does not overwrite an already-persisted terminal check (accepted-but-response-lost race)', async () => {
      // "Publish immutable candidate result" can succeed server-side (the
      // checks.create call is actually accepted and a terminal success/
      // failure check is durably created) while the step itself still
      // reports failure/cancelled to the runner (e.g. the HTTP response was
      // lost to a transient network error, or the job was cancelled between
      // the request completing and the step returning). Since
      // trainCheckState() (state.mjs latestChecksByName) picks the
      // HIGHEST-ID check run matching name/fingerprint/app, blindly creating
      // a new `cancelled` check here would mask the already-persisted,
      // genuinely correct terminal result. The fallback script must detect
      // this and skip creating a new check.
      const doc = loadWorkflow();
      const step = getFallbackStep(doc);
      const script = step.with?.script;
      expect(typeof script).toBe('string');

      let createCalls = 0;
      let updateCalls = 0;
      const github = {
        rest: {
          checks: {
            listForRef: async () => ({
              data: {
                check_runs: [
                  {
                    id: 999,
                    external_id: 'cafef00d',
                    app: { id: 12345 },
                    status: 'completed',
                    conclusion: 'success',
                  },
                ],
              },
            }),
            create: async () => {
              createCalls += 1;
              return { data: {} };
            },
            update: async () => {
              updateCalls += 1;
              return { data: {} };
            },
          },
        },
      };
      const context = { repo: { owner: 'nalfeo', repo: 'Crawler' } };
      const previousEnv = {
        CANDIDATE_SHA: process.env.CANDIDATE_SHA,
        FINGERPRINT: process.env.FINGERPRINT,
        APP_ID: process.env.APP_ID,
      };
      process.env.CANDIDATE_SHA = 'b'.repeat(40);
      process.env.FINGERPRINT = 'cafef00d';
      process.env.APP_ID = '12345';
      try {
        const run = new Function(
          'github',
          'context',
          `return (async () => {\n${script}\n})();`,
        ) as (github: unknown, context: unknown) => Promise<void>;
        await run(github, context);
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(createCalls).toBe(0);
      expect(updateCalls).toBe(0);
    });

    it('updates the existing in_progress check run in place (preserving its ID) instead of creating a new one, to avoid a TOCTOU window where an in-flight publish could land with a fresher, higher ID after the lookup but before this write', async () => {
      const doc = loadWorkflow();
      const step = getFallbackStep(doc);
      const script = step.with?.script;
      expect(typeof script).toBe('string');

      let createCalls = 0;
      let updateArgs: { check_run_id: number; conclusion: string; head_sha?: string } | undefined;
      let listArgs: { per_page?: number } | undefined;
      const github = {
        rest: {
          checks: {
            listForRef: async (args: { per_page?: number }) => {
              listArgs = args;
              return {
                data: {
                  check_runs: [
                    {
                      id: 700,
                      external_id: 'cafef00d',
                      app: { id: 12345 },
                      status: 'completed',
                      conclusion: 'cancelled',
                    },
                    {
                      id: 777,
                      external_id: 'cafef00d',
                      app: { id: 12345 },
                      status: 'in_progress',
                      conclusion: null,
                    },
                  ],
                },
              };
            },
            create: async () => {
              createCalls += 1;
              return { data: {} };
            },
            update: async (args: {
              check_run_id: number;
              conclusion: string;
              head_sha?: string;
            }) => {
              updateArgs = args;
              return { data: {} };
            },
          },
        },
      };
      const context = { repo: { owner: 'nalfeo', repo: 'Crawler' } };
      const previousEnv = {
        CANDIDATE_SHA: process.env.CANDIDATE_SHA,
        FINGERPRINT: process.env.FINGERPRINT,
        APP_ID: process.env.APP_ID,
      };
      process.env.CANDIDATE_SHA = 'b'.repeat(40);
      process.env.FINGERPRINT = 'cafef00d';
      process.env.APP_ID = '12345';
      try {
        const run = new Function(
          'github',
          'context',
          `return (async () => {\n${script}\n})();`,
        ) as (github: unknown, context: unknown) => Promise<void>;
        await run(github, context);
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(createCalls).toBe(0);
      expect(updateArgs).toBeDefined();
      expect(updateArgs?.check_run_id).toBe(777);
      expect(updateArgs?.conclusion).toBe('cancelled');
      expect(listArgs?.per_page).toBe(100);
      // head_sha is create-only on the Checks API -- the update call must
      // not send it (the PATCH endpoint does not accept it and could 422).
      expect(updateArgs?.head_sha).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(updateArgs ?? {}, 'head_sha')).toBe(false);
    });

    it('re-lists once after a short delay when no matching check is found on the first read, and updates in place if one appears (residual visibility-lag hardening)', async () => {
      vi.useFakeTimers();
      const doc = loadWorkflow();
      const step = getFallbackStep(doc);
      const script = step.with?.script;
      expect(typeof script).toBe('string');

      let listCalls = 0;
      let createCalls = 0;
      let updateArgs: { check_run_id: number; conclusion: string; head_sha?: string } | undefined;
      const github = {
        rest: {
          checks: {
            listForRef: async () => {
              listCalls += 1;
              if (listCalls === 1) {
                // First read finds nothing -- simulates the initial
                // in_progress check not yet being visible.
                return { data: { check_runs: [] } };
              }
              return {
                data: {
                  check_runs: [
                    {
                      id: 555,
                      external_id: 'cafef00d',
                      app: { id: 12345 },
                      status: 'in_progress',
                      conclusion: null,
                    },
                  ],
                },
              };
            },
            create: async () => {
              createCalls += 1;
              return { data: {} };
            },
            update: async (args: {
              check_run_id: number;
              conclusion: string;
              head_sha?: string;
            }) => {
              updateArgs = args;
              return { data: {} };
            },
          },
        },
      };
      const context = { repo: { owner: 'nalfeo', repo: 'Crawler' } };
      const previousEnv = {
        CANDIDATE_SHA: process.env.CANDIDATE_SHA,
        FINGERPRINT: process.env.FINGERPRINT,
        APP_ID: process.env.APP_ID,
      };
      process.env.CANDIDATE_SHA = 'd'.repeat(40);
      process.env.FINGERPRINT = 'cafef00d';
      process.env.APP_ID = '12345';
      try {
        const run = new Function(
          'github',
          'context',
          `return (async () => {\n${script}\n})();`,
        ) as (github: unknown, context: unknown) => Promise<void>;
        const runPromise = run(github, context);
        await vi.runAllTimersAsync();
        await runPromise;
      } finally {
        vi.useRealTimers();
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(listCalls).toBe(2);
      expect(createCalls).toBe(0);
      expect(updateArgs?.check_run_id).toBe(555);
      expect(updateArgs?.conclusion).toBe('cancelled');
      // head_sha is create-only on the Checks API -- must not leak into update.
      expect(updateArgs?.head_sha).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(updateArgs ?? {}, 'head_sha')).toBe(false);
    });

    it('re-lists once after a short delay and skips as a no-op if the genuine terminal check becomes visible on the second read', async () => {
      vi.useFakeTimers();
      const doc = loadWorkflow();
      const step = getFallbackStep(doc);
      const script = step.with?.script;
      expect(typeof script).toBe('string');

      let listCalls = 0;
      let createCalls = 0;
      let updateCalls = 0;
      const github = {
        rest: {
          checks: {
            listForRef: async () => {
              listCalls += 1;
              if (listCalls === 1) {
                return { data: { check_runs: [] } };
              }
              return {
                data: {
                  check_runs: [
                    {
                      id: 556,
                      external_id: 'cafef00d',
                      app: { id: 12345 },
                      status: 'completed',
                      conclusion: 'failure',
                    },
                  ],
                },
              };
            },
            create: async () => {
              createCalls += 1;
              return { data: {} };
            },
            update: async () => {
              updateCalls += 1;
              return { data: {} };
            },
          },
        },
      };
      const context = { repo: { owner: 'nalfeo', repo: 'Crawler' } };
      const previousEnv = {
        CANDIDATE_SHA: process.env.CANDIDATE_SHA,
        FINGERPRINT: process.env.FINGERPRINT,
        APP_ID: process.env.APP_ID,
      };
      process.env.CANDIDATE_SHA = 'e'.repeat(40);
      process.env.FINGERPRINT = 'cafef00d';
      process.env.APP_ID = '12345';
      try {
        const run = new Function(
          'github',
          'context',
          `return (async () => {\n${script}\n})();`,
        ) as (github: unknown, context: unknown) => Promise<void>;
        const runPromise = run(github, context);
        await vi.runAllTimersAsync();
        await runPromise;
      } finally {
        vi.useRealTimers();
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(listCalls).toBe(2);
      expect(createCalls).toBe(0);
      expect(updateCalls).toBe(0);
    });

    it('falls back to creating a new check only when no matching check-run exists at all yet, even after the residual-race re-list', async () => {
      vi.useFakeTimers();
      const doc = loadWorkflow();
      const step = getFallbackStep(doc);
      const script = step.with?.script;
      expect(typeof script).toBe('string');

      let createCalls = 0;
      let updateCalls = 0;
      const github = {
        rest: {
          checks: {
            listForRef: async () => ({
              data: { check_runs: [] },
            }),
            create: async () => {
              createCalls += 1;
              return { data: {} };
            },
            update: async () => {
              updateCalls += 1;
              return { data: {} };
            },
          },
        },
      };
      const context = { repo: { owner: 'nalfeo', repo: 'Crawler' } };
      const previousEnv = {
        CANDIDATE_SHA: process.env.CANDIDATE_SHA,
        FINGERPRINT: process.env.FINGERPRINT,
        APP_ID: process.env.APP_ID,
      };
      process.env.CANDIDATE_SHA = 'b'.repeat(40);
      process.env.FINGERPRINT = 'cafef00d';
      process.env.APP_ID = '12345';
      try {
        const run = new Function(
          'github',
          'context',
          `return (async () => {\n${script}\n})();`,
        ) as (github: unknown, context: unknown) => Promise<void>;
        const runPromise = run(github, context);
        await vi.runAllTimersAsync();
        await runPromise;
      } finally {
        vi.useRealTimers();
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(updateCalls).toBe(0);
      expect(createCalls).toBe(1);
    });

    it('retries transient check publication failures twice before succeeding', async () => {
      vi.useFakeTimers();
      const doc = loadWorkflow();
      const script = getFallbackStep(doc).with?.script;
      expect(typeof script).toBe('string');

      let createCalls = 0;
      let createArgs:
        | { conclusion: string; head_sha: string; external_id: string; output: { title: string } }
        | undefined;
      const github = {
        rest: {
          checks: {
            listForRef: async () => ({ data: { check_runs: [] } }),
            create: async (args: typeof createArgs) => {
              createCalls += 1;
              if (createCalls < 3) throw new Error(`transient failure ${createCalls}`);
              createArgs = args;
              return { data: {} };
            },
          },
        },
      };
      const context = { repo: { owner: 'nalfeo', repo: 'Crawler' } };
      const previousEnv = {
        CANDIDATE_SHA: process.env.CANDIDATE_SHA,
        FINGERPRINT: process.env.FINGERPRINT,
        APP_ID: process.env.APP_ID,
      };
      process.env.CANDIDATE_SHA = 'c'.repeat(40);
      process.env.FINGERPRINT = 'deadbeef';
      process.env.APP_ID = '12345';
      try {
        const run = new Function(
          'github',
          'context',
          `return (async () => {\n${script}\n})();`,
        ) as (github: unknown, context: unknown) => Promise<void>;
        const runPromise = run(github, context);
        await vi.runAllTimersAsync();
        await runPromise;
      } finally {
        vi.useRealTimers();
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(createCalls).toBe(3);
      expect(createArgs?.conclusion).toBe('cancelled');
      expect(createArgs?.head_sha).toBe('c'.repeat(40));
      expect(createArgs?.external_id).toBe('deadbeef');
    });
  });

  it('reconciliation wake-up step runs with if: always(), even if publishing the check failed', () => {
    // Regression coverage: this step previously had no `if:` at all, which
    // defaults to the implicit `success()` condition. That silently skipped
    // the dispatch whenever "Publish immutable candidate result" itself
    // failed (e.g. a transient checks.create API error) -- exactly the
    // failure/cancelled case reconcile most needs to be woken for, so it can
    // consume/retry/bisect instead of stalling on the unreliable
    // workflow_run/schedule fallback.
    const raw = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/merge-train-validate.yml'),
      'utf8',
    );
    const doc = parse(raw) as WorkflowDoc;
    const steps = doc.jobs.publish?.steps ?? [];
    const wakeStep = steps.find((s) => s.name === 'Wake merge-train reconciliation');
    expect(wakeStep).toBeDefined();
    expect(wakeStep?.if).toBe('always()');
  });
});

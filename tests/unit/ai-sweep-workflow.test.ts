import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Structural regression coverage for the AI Sweep Eval round-DAG redesign
 * (`.github/workflows/ai-sweep.yml`).
 *
 * BACKGROUND: the prior design flattened one round's candidates × weapons ×
 * seeds into ONE 4-worker job per combo, so wall time scaled as
 * totalTasks/workers -- one round (13 configs × 3 weapons × 80 seeds = 3,120
 * runs) projected ~5h25m, well past the workflow timeout. Run 29606086471 was
 * cancelled after ~3h40 with ZERO artifacts, because the old `search` job
 * only emitted its shard at the very end (no checkpointing).
 *
 * This test parses the REAL YAML (not a re-implementation) so a future edit
 * cannot silently reintroduce either failure mode:
 *   - the monolithic `search` job must be gone (replaced by baseline +
 *     checkpoint-init + an explicit bounded round1-3 DAG);
 *   - every round's candidate-eval matrix job must be independently timed at
 *     <=90 minutes (the hard timing gate), with a `max-parallel: 8` cap
 *     matching every other matrix job in this workflow (baseline,
 *     checkpoint-init, round-select, validate) -- an UNCAPPED round-eval
 *     matrix previously fanned out 20 concurrent jobs with 44 more queued
 *     (run 29786216369), saturating the account's entire GitHub-hosted
 *     concurrent-runner pool and starving the shared merge-train queue's own
 *     validation jobs repo-wide;
 *   - every round-select (checkpoint fold-in) job must be gated with
 *     `!cancelled()` so a `fail-fast:false` partial candidate failure upstream
 *     never causes the checkpoint-persistence step itself to be skipped --
 *     that is the actual "timeout/failure never discards prior progress"
 *     mechanism -- while a MANUAL workflow cancellation still stops the DAG
 *     (unlike `always()`, which runs through cancellation too and would keep
 *     burning runner minutes on every downstream job the user just asked to
 *     stop; multi-model review, gemini-3.1-pro-preview);
 *   - `validate` and `aggregate` must ALSO be gated with `!cancelled()`, so a
 *     partially-failed round or partially-failed validate matrix still
 *     produces a leaderboard from whatever DID succeed, while still
 *     respecting a manual cancellation;
 *   - every round-eval candidate's shard artifact must be uploaded under a
 *     per-candidate-unique local filename (not a fixed `shard.json`), since
 *     round-select downloads all of a round's shards with
 *     `merge-multiple: true` into one shared directory -- same-named files
 *     across merged artifacts are silently overwritten, which previously
 *     collapsed every candidate but the last down to one shard per combo per
 *     round (multi-model review, gemini-3.1-pro-preview);
 *   - `rounds` must remain hard-capped at the explicit bounded 0-3 DAG this
 *     workflow implements (a `rounds` value beyond what the DAG has explicit
 *     job triples for must be rejected before any runner spins up);
 *   - every original `workflow_dispatch` input must still be present, valid,
 *     and untouched in shape (no default-mode flip).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface WorkflowStrategy {
  'fail-fast'?: boolean;
  'max-parallel'?: number;
  matrix?: Record<string, unknown>;
}

interface WorkflowJob {
  name?: string;
  needs?: string | string[];
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  strategy?: WorkflowStrategy;
  outputs?: Record<string, string>;
  steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }>;
}

interface WorkflowInput {
  type: string;
  default?: unknown;
  description?: string;
}

interface WorkflowDoc {
  on: { workflow_dispatch: { inputs: Record<string, WorkflowInput> } };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(): WorkflowDoc {
  const raw = readFileSync(path.join(REPO_ROOT, '.github/workflows/ai-sweep.yml'), 'utf8');
  return parse(raw) as WorkflowDoc;
}

function getJob(doc: WorkflowDoc, name: string): WorkflowJob {
  const job = doc.jobs[name];
  if (!job) throw new Error(`job "${name}" not found in ai-sweep.yml`);
  return job;
}

function needsList(job: WorkflowJob): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function allRunSteps(job: WorkflowJob): string {
  return (job.steps ?? []).map((s) => s.run ?? '').join('\n---\n');
}

const ROUND_NUMBERS = [1, 2, 3] as const;

describe('ai-sweep.yml structure (round-DAG redesign)', () => {
  it('parses and no longer contains the old monolithic `search` job', () => {
    const doc = loadWorkflow();
    expect(doc.jobs.search).toBeUndefined();
  });

  it('keeps every original workflow_dispatch input present with an unchanged shape (no default-mode flip)', () => {
    const doc = loadWorkflow();
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(
      [
        'combos',
        'rounds',
        'secondary',
        'train_seeds',
        'validate_seeds',
        'weapons',
        'workers',
      ].sort(),
    );
    expect(inputs.combos).toMatchObject({ type: 'string', default: 'all' });
    expect(inputs.train_seeds).toMatchObject({ type: 'string', default: '1-24' });
    expect(inputs.validate_seeds).toMatchObject({ type: 'string', default: '1-40' });
    expect(inputs.weapons).toMatchObject({ type: 'string', default: 'sword,bow,baseball-bat' });
    expect(inputs.workers).toMatchObject({ type: 'string', default: '4' });
    // `rounds` keeps its original type/default -- only its semantics/description
    // and the preflight cap change, per "no default mode flip".
    expect(inputs.rounds).toMatchObject({ type: 'string', default: '2' });
    expect(inputs.secondary).toMatchObject({ type: 'boolean', default: false });
  });

  it('stays read-only (contents: read) with no elevated default permissions', () => {
    const doc = loadWorkflow();
    expect(doc.permissions).toEqual({ contents: 'read' });
  });

  it('preflight hard-caps rounds to the explicit bounded 0-3 DAG before any runner spins up', () => {
    const doc = loadWorkflow();
    const preflight = getJob(doc, 'preflight');
    const script = allRunSteps(preflight);
    expect(script).toMatch(/ROUNDS/);
    expect(script).toMatch(/-gt 3/);
  });

  it('has a baseline + checkpoint-init stage that runs once per combo before any round', () => {
    const doc = loadWorkflow();
    const baseline = getJob(doc, 'baseline');
    const checkpointInit = getJob(doc, 'checkpoint-init');
    expect(needsList(baseline)).toContain('preflight');
    expect(allRunSteps(baseline)).toContain('--stage search-baseline');
    expect(needsList(checkpointInit)).toContain('baseline');
    expect(allRunSteps(checkpointInit)).toContain('--mode init');
    // Checkpoint artifact uses a per-round immutable name (search-checkpoint-init-*)
    // rather than overwriting a single artifact, so a later-round upload failure
    // cannot destroy the init checkpoint.
    const uploadStep = (checkpointInit.steps ?? []).find((s) =>
      s.uses?.startsWith('actions/upload-artifact'),
    );
    expect(uploadStep?.with?.overwrite).toBeFalsy();
    expect(uploadStep?.with?.name).toContain('search-checkpoint-init-');
  });

  it('gates checkpoint-init and round1-candidates with !cancelled() (not always()) so a partial baseline matrix failure never skips them for every combo, while a manual cancellation still stops the DAG', () => {
    // A `baseline` matrix leg failing for ONE combo must not, under the
    // implicit if:success() default, skip checkpoint-init/round1-candidates
    // for ALL combos -- that would discard every other combo's otherwise-
    // successful baseline results. Both downstream jobs re-scope to their own
    // `matrix.combo` and must run per-combo regardless of sibling failures.
    // `always()` would ALSO run through a user-initiated cancellation
    // (gemini-3.1-pro-preview finding); `!cancelled()` gets the partial-
    // failure tolerance without that footgun.
    const doc = loadWorkflow();
    expect(getJob(doc, 'checkpoint-init').if).toContain('!cancelled()');
    expect(getJob(doc, 'checkpoint-init').if).not.toContain('always()');
    expect(getJob(doc, 'round1-candidates').if).toContain('!cancelled()');
    expect(getJob(doc, 'round1-candidates').if).not.toContain('always()');
  });

  it('never reintroduces if: always() anywhere in the workflow (must be !cancelled() for cancellation-safety)', () => {
    const doc = loadWorkflow();
    for (const [name, job] of Object.entries(doc.jobs ?? {})) {
      const condition = (job as { if?: string }).if;
      if (condition === undefined) continue;
      expect(condition, `job "${name}" if: condition`).not.toContain('always()');
    }
  });

  describe.each(ROUND_NUMBERS)('round %d job triple', (n) => {
    const candidatesJob = `round${n}-candidates`;
    const evalJob = `round${n}-eval`;
    const selectJob = `round${n}-select`;

    it(`${candidatesJob} is gated on rounds >= ${n} and fans in every combo's checkpoint`, () => {
      const doc = loadWorkflow();
      const job = getJob(doc, candidatesJob);
      expect(job.if).toContain(`fromJSON(inputs.rounds) >= ${n}`);
      expect(job.outputs?.hasCandidates).toBeDefined();
      expect(job.outputs?.matrix).toBeDefined();
      const script = allRunSteps(job);
      expect(script).toContain(`--mode plan --round ${n}`);
      expect(script).toContain('--cap 200');
    });

    it(`${evalJob} is one independent matrix job per candidate, timed <=90min, capped at max-parallel:8 (shared-runner-pool protection)`, () => {
      const doc = loadWorkflow();
      const job = getJob(doc, evalJob);
      expect(job.if).toContain(`needs.${candidatesJob}.outputs.hasCandidates == 'true'`);
      expect(job.strategy?.matrix).toBeDefined();
      // max-parallel: 8 caps this round's candidate fan-out so a full
      // 8-combo graduation run cannot saturate the account's entire
      // GitHub-hosted concurrent-runner pool and starve unrelated repo-wide
      // work (e.g. the shared merge-train queue's own validation jobs).
      // Run 29786216369 fanned out 20 concurrent Round 3 eval jobs with 44
      // more queued before it was manually cancelled -- this cap must never
      // silently regress back to unbounded concurrency.
      expect(job.strategy?.['max-parallel']).toBe(8);
      expect(job.strategy?.['fail-fast']).toBe(false);
      const timeout = job['timeout-minutes'];
      expect(timeout).toBeDefined();
      expect(timeout!).toBeLessThanOrEqual(90);
      const script = allRunSteps(job);
      expect(script).toContain('--stage search-eval');
      expect(script).toContain('--config-id');
      expect(script).toContain('--config-json');
    });

    it(`${selectJob} is gated with !cancelled() (not always()) so a partial ${evalJob} failure never skips checkpoint persistence, while a manual cancellation still stops it`, () => {
      const doc = loadWorkflow();
      const job = getJob(doc, selectJob);
      expect(job.if).toContain('!cancelled()');
      expect(job.if).not.toContain('always()');
      expect(job.if).toContain(`fromJSON(inputs.rounds) >= ${n}`);
      expect(needsList(job)).toContain(evalJob);
      // Must also depend on this round's own candidates job so it can
      // download the candidate plan and compute how many were actually
      // planned (gate-aware promotion + infra-failure detection fix).
      expect(needsList(job)).toContain(candidatesJob);
      const script = allRunSteps(job);
      expect(script).toContain(`--mode select --round ${n}`);
      expect(script).toContain('--planned-count');
      // The infra-failure fix: when candidates.json is missing entirely
      // (roundN-candidates crashed before uploading), PLANNED must fall back
      // to the 'unknown' sentinel, NOT 0 — 0 is a legitimate "planner ran,
      // decided nothing was needed" signal that correctly halves/converges,
      // whereas 'unknown' must always suppress halving/convergence (see
      // applyRoundResult's plannedCount doc comment).
      expect(script).toContain('PLANNED=unknown');
      expect(script).not.toContain('PLANNED=0');
      // Uploads to an immutable per-round artifact name (search-checkpoint-rN-*)
      // rather than overwriting a shared artifact, so a round-N upload failure
      // cannot destroy round-(N-1)'s already-safe checkpoint.
      const uploadStep = (job.steps ?? []).find((s) =>
        s.uses?.startsWith('actions/upload-artifact'),
      );
      expect(uploadStep?.with?.overwrite).toBeFalsy();
      expect(String(uploadStep?.with?.name)).toContain(`search-checkpoint-r${n}-`);
      // Shard download tolerates zero candidates this round for this combo
      // (e.g. every knob already converged) without hard-failing.
      const downloadShards = (job.steps ?? []).find(
        (s) =>
          s.uses?.startsWith('actions/download-artifact') &&
          s.name?.toLowerCase().includes('shard'),
      );
      expect(downloadShards?.with?.['if-no-artifact-found']).toBe('warn');
      // Candidate-plan download must use pattern (not `name`) so that a missing
      // artifact is non-fatal — `if-no-artifact-found: warn` is only honoured by
      // the pattern download path (actions/download-artifact@v4 uses listArtifacts
      // for pattern, which succeeds with zero matches; named downloads use
      // getArtifact, which throws 404 regardless of the parameter value).
      const downloadCandidates = (job.steps ?? []).find(
        (s) =>
          s.uses?.startsWith('actions/download-artifact') &&
          s.name?.toLowerCase().includes('candidate'),
      );
      expect(downloadCandidates?.with?.['if-no-artifact-found']).toBe('warn');
      expect(downloadCandidates?.with?.['pattern']).toBeDefined();
      expect(downloadCandidates?.with?.['name']).toBeUndefined();
    });

    it(`${evalJob} uploads its shard under a per-candidate-unique filename, not a fixed shard.json (merge-multiple collision fix)`, () => {
      // round-select downloads every candidate's shard artifact for this round
      // with `merge-multiple: true` into one shared directory. If every
      // candidate wrote to the SAME local filename (e.g. `shard.json`),
      // download-artifact would silently overwrite same-named files across
      // merged artifacts, leaving only the last-downloaded candidate's shard
      // -- permanently starving the leaderboard of every other candidate's
      // result (multi-model review, gemini-3.1-pro-preview).
      const doc = loadWorkflow();
      const job = getJob(doc, evalJob);
      const script = allRunSteps(job);
      expect(script).not.toContain('--out shard.json');
      expect(script).toMatch(/--out "shard-\$HASH\.json"/);
      const uploadStep = (job.steps ?? []).find((s) =>
        s.uses?.startsWith('actions/upload-artifact'),
      );
      expect(uploadStep?.with?.path).not.toBe('shard.json');
      expect(String(uploadStep?.with?.path)).toContain('shard-');
      expect(String(uploadStep?.with?.path)).toContain('steps.hash.outputs.hash');
    });
  });

  it('chains the rounds so round N depends on round N-1 select (or checkpoint-init for round 1)', () => {
    const doc = loadWorkflow();
    expect(needsList(getJob(doc, 'round1-candidates'))).toContain('checkpoint-init');
    expect(needsList(getJob(doc, 'round2-candidates'))).toContain('round1-select');
    expect(needsList(getJob(doc, 'round3-candidates'))).toContain('round2-select');
  });

  it('validate is gated with !cancelled() (not always()) and downloads the (possibly partial-round) checkpoint directly', () => {
    const doc = loadWorkflow();
    const job = getJob(doc, 'validate');
    expect(job.if).toContain('!cancelled()');
    expect(job.if).not.toContain('always()');
    for (const dep of [
      'preflight',
      'checkpoint-init',
      'round1-select',
      'round2-select',
      'round3-select',
    ]) {
      expect(needsList(job)).toContain(dep);
    }
    const script = allRunSteps(job);
    expect(script).toContain('--stage validate');
    // validate uses a variable reference to the latest checkpoint rather than a
    // fixed filename, since multiple immutable per-round checkpoint artifacts
    // may exist and the fallback-selection script picks the latest available.
    expect(script).toContain('--search-artifact "$CHECKPOINT"');
  });

  it('aggregate is gated with !cancelled() (not always()) so a partial validate failure still produces a leaderboard', () => {
    const doc = loadWorkflow();
    const job = getJob(doc, 'aggregate');
    expect(job.if).toContain('!cancelled()');
    expect(job.if).not.toContain('always()');
    expect(needsList(job)).toContain('validate');
  });

  it('every round-eval and round-select job stays within the 200-job matrix cap used by planRoundMatrix', () => {
    const doc = loadWorkflow();
    for (const n of ROUND_NUMBERS) {
      const candidatesScript = allRunSteps(getJob(doc, `round${n}-candidates`));
      expect(candidatesScript).toContain('--cap 200');
    }
  });

  it('every matrix job in the workflow caps concurrency at max-parallel:8 (shared GitHub-hosted runner pool protection)', () => {
    // Every fan-out matrix job -- baseline, checkpoint-init, round1-3 eval,
    // round1-3 select, and validate -- must cap concurrency at the same
    // max-parallel:8, so a full 8-combo graduation run can never saturate
    // the account's entire concurrent-runner pool and starve unrelated
    // repo-wide work (e.g. the shared merge-train queue's own validation
    // jobs). round1-eval, round2-eval, and round3-eval previously had NO
    // cap at all: run 29786216369 fanned out 20 concurrent Round 3 eval
    // jobs with 44 more queued behind them before it was manually
    // cancelled. This test guards every matrix job in the file at once so
    // the cap cannot silently regress on any of them.
    const doc = loadWorkflow();
    const matrixJobNames = Object.entries(doc.jobs)
      .filter(([, job]) => (job as WorkflowJob).strategy?.matrix !== undefined)
      .map(([name]) => name);
    expect(matrixJobNames.sort()).toEqual(
      [
        'baseline',
        'checkpoint-init',
        'round1-eval',
        'round1-select',
        'round2-eval',
        'round2-select',
        'round3-eval',
        'round3-select',
        'validate',
      ].sort(),
    );
    for (const name of matrixJobNames) {
      const job = getJob(doc, name);
      expect(job.strategy?.['max-parallel'], `job "${name}" strategy.max-parallel`).toBe(8);
    }
  });
});

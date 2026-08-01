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
 *     and untouched in shape (no default-mode flip), PLUS the new
 *     `resume_run_id` input (blank default) that lets a fresh dispatch import
 *     compatible checkpoints from a prior (e.g. manually-cancelled) run --
 *     the `resume-import` job it drives must ALWAYS emit well-formed
 *     `freshCombos`/`resumedCombos` JSON array outputs (even on the default
 *     blank input) so `baseline`/`checkpoint-init`'s `fromJSON(...)` matrix
 *     source never sees an empty/missing output, and must select the latest
 *     compatible checkpoint tier per combo in strict r3 > r2 > r1 > init
 *     order, deferring to the existing strict provenance checks
 *     (`assertResumeCompatible` in round-plan.ts) so an incompatible or
 *     missing prior checkpoint always falls back to a fresh run for that one
 *     combo instead of silently merging mismatched search state.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface WorkflowStrategy {
  'fail-fast'?: boolean;
  'max-parallel'?: number | string;
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
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: boolean;
    queue?: string;
  };
  steps?: Array<{
    name?: string;
    run?: string;
    uses?: string;
    if?: string;
    env?: Record<string, unknown>;
    with?: Record<string, unknown>;
    'continue-on-error'?: boolean;
  }>;
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

  it('keeps every original workflow_dispatch input present with an unchanged shape (no default-mode flip), plus the new resume_run_id input', () => {
    const doc = loadWorkflow();
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(
      [
        'combos',
        'resume_run_id',
        'rounds',
        'secondary',
        'train_seeds',
        'validate_seeds',
        'weapons',
        'workers',
        'xp_collection',
        'xp_floor',
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
    // New resume input: blank by default so a fresh dispatch with no
    // resume_run_id keeps the same combo set/search semantics as before this
    // feature existed (not scheduling-identical -- baseline now always waits
    // on the new resume-import job's checkout/Node-setup/metadata step).
    expect(inputs.resume_run_id).toMatchObject({ type: 'string', default: '' });
    expect(inputs.xp_collection).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.xp_floor).toMatchObject({ type: 'string', default: 'floor1' });
  });

  it('offers fresh-process XP telemetry for the validation panel', () => {
    const doc = loadWorkflow();
    const validate = getJob(doc, 'validate');
    const script = allRunSteps(validate);
    expect(script).toContain('--fresh-process');
    expect(script).toContain('--record-xp');
    expect(script).toContain('XP_COLLECTION');
  });

  it('runs non-Floor-1 XP panels in a dedicated fresh-process job', () => {
    const doc = loadWorkflow();
    const job = getJob(doc, 'xp-measure');
    expect(job.if).toContain('inputs.xp_collection');
    expect(job.if).toContain("inputs.xp_floor != 'floor1'");
    const script = allRunSteps(job);
    expect(script).toContain('--stage xp-measure');
    expect(script).toContain('--fresh-process');
    expect(script).toContain('--record-xp');
  });

  it('stays read-only with only the metadata permissions required by queue-aware admission and cross-run artifact download', () => {
    const doc = loadWorkflow();
    // actions: read is required by actions/download-artifact@v4's cross-run
    // `run-id` support (resume-import job). pull-requests/issues: read is
    // required by the queue-aware sweep budget (sweep-budget.mjs).
    expect(doc.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      'pull-requests': 'read',
      issues: 'read',
    });
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
    expect(needsList(baseline)).toContain('resume-import');
    expect(allRunSteps(baseline)).toContain('--stage search-baseline');
    expect(needsList(checkpointInit)).toContain('baseline');
    expect(needsList(checkpointInit)).toContain('resume-import');
    expect(allRunSteps(checkpointInit)).toContain('--mode init');
    // Checkpoint artifact uses a per-round immutable name (search-checkpoint-init-*)
    // rather than overwriting a single artifact, so a later-round upload failure
    // cannot destroy the init checkpoint.
    const uploadStep = (checkpointInit.steps ?? []).find((s) =>
      s.uses?.startsWith('actions/upload-artifact'),
    );
    expect(uploadStep?.with?.overwrite).toBeFalsy();
    expect(uploadStep?.with?.name).toContain('search-checkpoint-init-');
    // Both jobs' matrix source is resume-import's freshCombos output (NOT the
    // full preflight combo list) -- a combo that was successfully resumed
    // from a prior run must skip baseline+checkpoint-init entirely rather
    // than recomputing round-0 work the resumed checkpoint already has.
    expect(String(baseline.strategy?.matrix?.combo)).toContain(
      'needs.resume-import.outputs.freshCombos',
    );
    // checkpoint-init uses checkpoint-budget's matrix (fresh combos with sweepSlots)
    expect(String(checkpointInit.strategy?.matrix?.combo)).toContain(
      'needs.checkpoint-budget.outputs.matrix',
    );
  });

  it('checkpoint-init passes --train-seeds/--weapons to round-plan.ts --mode init so every checkpoint carries runInputs (required for assertResumeCompatible to ever succeed)', () => {
    // Without these flags, initCheckpoint's runInputs stays undefined on
    // EVERY checkpoint this workflow produces, so assertResumeCompatible's
    // fail-closed `!checkpoint.runInputs` check would reject every checkpoint
    // as a resume candidate, unconditionally -- resume would never work.
    const doc = loadWorkflow();
    const checkpointInit = getJob(doc, 'checkpoint-init');
    const script = allRunSteps(checkpointInit);
    expect(script).toContain('--train-seeds "$TRAIN_SEEDS"');
    expect(script).toContain('--weapons "$WEAPONS"');
    const initStep = (checkpointInit.steps ?? []).find((s) => s.run?.includes('--mode init'));
    expect(initStep?.env).toMatchObject({
      TRAIN_SEEDS: '${{ inputs.train_seeds }}',
      WEAPONS: '${{ inputs.weapons }}',
    });
  });

  it('checkpoint-init hard-fails unconditionally when the riskRewardFused+legacy baseline shard is missing for a non-incumbent combo -- no resumed-combo exemption', () => {
    // A prior version of this check silently fell back to each non-LEGACY
    // combo's own base as incumbent whenever `legacy+legacy` appeared in
    // `resumedCombos`, reasoning that the derivation might have failed
    // independently of resume-import's own job result. That reasoning no
    // longer holds: `resume-import`'s "Derive riskRewardFused+legacy baseline
    // shard"/"Upload derived riskRewardFused+legacy baseline shard" steps have no
    // `continue-on-error`, and `checkpoint-init` already requires
    // `needs.resume-import.result == 'success'` -- so a successful
    // resume-import that resumed riskRewardFused+legacy GUARANTEES the derived
    // baseline artifact was uploaded. A still-missing artifact here can now
    // ONLY mean a genuine infra fault (e.g. an artifact-download race), which
    // must fail loudly rather than silently narrow the in-search safety net
    // for every non-incumbent combo (found in review, superseding the earlier
    // resumed-combo exemption).
    const doc = loadWorkflow();
    const script = allRunSteps(getJob(doc, 'checkpoint-init'));
    expect(script).not.toContain('RESUMED_COMBOS');
    expect(script).not.toMatch(/jq -e --arg c "legacy\+legacy" 'index\(\$c\) != null'/);
    expect(script).not.toContain('falls back to its own base as the in-search incumbent');
    expect(script).toContain('is required for non-incumbent combo');
    expect(script).toContain('exit 1');
    // The unconditional hard-fail branch must not be gated behind any
    // resumedCombos check -- it is the ONLY branch left when the file is
    // missing.
    const ifMissingBlock = script.split(
      'if [ ! -f "baseline-riskRewardFused+legacy.json" ]; then',
    )[1];
    expect(ifMissingBlock).toBeDefined();
    const beforeElse = ifMissingBlock?.split(/\belse\b/)[0] ?? '';
    expect(beforeElse).toContain('exit 1');
  });

  it("checkpoint-init's riskRewardFused+legacy download step's if-no-artifact-found:warn is a display-only choice -- the actual gate is the Build round-0 checkpoint step's own explicit file check + exit 1, not the download step's own error handling", () => {
    const doc = loadWorkflow();
    const checkpointInit = getJob(doc, 'checkpoint-init');
    const downloadStep = (checkpointInit.steps ?? []).find(
      (s) => s.with?.pattern === 'search-baseline-riskRewardFused+legacy',
    );
    expect(downloadStep?.with?.['if-no-artifact-found']).toBe('warn');
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

    it(`${evalJob} is one independent matrix job per candidate, timed <=90min, with dynamic max-parallel concurrency cap (shared-runner-pool protection)`, () => {
      const doc = loadWorkflow();
      const job = getJob(doc, evalJob);
      expect(job.if).toContain(`needs.${candidatesJob}.outputs.hasCandidates == 'true'`);
      expect(job.strategy?.matrix).toBeDefined();
      // Dynamic max-parallel + sweep semaphore cap this round's candidate fan-out so
      // a full 8-combo graduation run cannot saturate the account's concurrent runner
      // pool. Run 29786216369 fanned out 20 concurrent Round 3 eval jobs with 44
      // more queued before cancellation -- this cap must never silently regress.
      expect(String(job.strategy?.['max-parallel']), `${evalJob} strategy.max-parallel`).toContain(
        'max_parallel',
      );
      expect(job.concurrency?.group).toContain('crawler-sweep-slot-');
      expect(job.concurrency?.group).toContain('sweepSlot');
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

  it('every matrix job in the workflow uses dynamic max-parallel plus global sweep semaphore slots', () => {
    // Every fan-out matrix job must consume the dynamic share calculated at
    // its batch boundary and one of the ten hard global semaphore tokens
    // (crawler-sweep-slot-*). The dynamic share prevents runner saturation
    // (run 29786216369 fanned out 20 concurrent Round 3 eval jobs with 44
    // more queued before cancellation).
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
      expect(
        String(job.strategy?.['max-parallel']),
        `job "${name}" strategy.max-parallel`,
      ).toContain('max_parallel');
      expect(job.concurrency?.group, `job "${name}" concurrency.group`).toContain(
        'crawler-sweep-slot-',
      );
      expect(job.concurrency?.group, `job "${name}" concurrency.group`).toContain('sweepSlot');
    }
  });

  describe('cross-run resume (resume_run_id, run 29786216369 runner-starvation fix)', () => {
    it('every matrix/fan-out job strategy in the workflow uses dynamic max-parallel (no uncapped eval rounds)', () => {
      // Exhaustive sweep, not a fixed job-name list -- a future job that adds
      // a `strategy.matrix` without a dynamic max-parallel cap must fail this
      // test rather than silently reintroducing unrestricted concurrency (the
      // exact failure mode that caused run 29786216369's runner-starvation
      // cancellation). The dynamic share is computed by sweep-budget.mjs at
      // each batch boundary so concurrency yields to CI/recovery backlog.
      const doc = loadWorkflow();
      const matrixJobs = Object.entries(doc.jobs).filter(([, job]) => job.strategy?.matrix);
      expect(matrixJobs.length).toBeGreaterThan(0);
      for (const [name, job] of matrixJobs) {
        expect(
          String(job.strategy?.['max-parallel']),
          `job "${name}" strategy.max-parallel`,
        ).toContain('max_parallel');
      }
    });

    it('resume-import runs unconditionally right after preflight and always emits well-formed freshCombos/resumedCombos/hasFreshCombos outputs', () => {
      const doc = loadWorkflow();
      const job = getJob(doc, 'resume-import');
      expect(needsList(job)).toContain('preflight');
      expect(job.outputs?.freshCombos).toBeDefined();
      expect(job.outputs?.resumedCombos).toBeDefined();
      expect(job.outputs?.hasFreshCombos).toBeDefined();
      expect(job.outputs?.freshCombosBudgetMatrix).toBeDefined();
      const script = allRunSteps(job);
      // Both outputs are ALWAYS written (unconditional echo to $GITHUB_OUTPUT)
      // regardless of the if/else branch taken -- a missing/empty output
      // would crash baseline/checkpoint-init's fromJSON(...) matrix source,
      // not just skip resume.
      expect(script).toContain('echo "freshCombos=$FRESH" >> "$GITHUB_OUTPUT"');
      expect(script).toContain('echo "resumedCombos=$RESUMED" >> "$GITHUB_OUTPUT"');
      expect(script).toContain('echo "hasFreshCombos=$HAS_FRESH" >> "$GITHUB_OUTPUT"');
      expect(script).toContain('echo "freshCombosBudgetMatrix=');
    });

    it("baseline and checkpoint-init are guarded by hasFreshCombos so an all-combos-resumed run (freshCombos=[]) never hits GitHub Actions' hard-fail on an empty matrix array", () => {
      const doc = loadWorkflow();
      // GitHub Actions hard-FAILS a job whose strategy.matrix source resolves
      // to an empty array (`fromJSON('[]')`) rather than skipping it -- an
      // all-combos-resumed run must therefore gate these jobs on an explicit
      // string output, not rely on the (always-truthy) JSON array itself.
      expect(getJob(doc, 'baseline').if).toContain(
        "needs.resume-import.outputs.hasFreshCombos == 'true'",
      );
      const checkpointInitIf = getJob(doc, 'checkpoint-init').if;
      expect(checkpointInitIf).toContain('!cancelled()');
      expect(checkpointInitIf).toContain("needs.resume-import.outputs.hasFreshCombos == 'true'");
    });

    it('baseline and checkpoint-init also require needs.resume-import.result == \'success\' so a hard-failed resume-import (e.g. its "Select latest compatible checkpoint" step) cannot silently let downstream jobs proceed on stale/incomplete outputs', () => {
      const doc = loadWorkflow();
      // A custom job-level `if:` REPLACES GitHub Actions' implicit
      // `success()` gate rather than ANDing with it. Because
      // `hasFreshCombos`/`freshCombos`/`resumedCombos` are set by an EARLIER
      // step within `resume-import`, a LATER step in that same job failing
      // (e.g. the "Upload resumed checkpoints bundle" step) would still
      // leave those outputs readable -- so `baseline`/`checkpoint-init`'s
      // `if:` must explicitly require `needs.resume-import.result ==
      // 'success'` to avoid running on a run whose resume-import job did not
      // fully succeed. `resume-import` is a single (non-matrix) job, so
      // unlike `baseline`'s own `needs.baseline` conclusion (which is
      // 'failure' if even one combo's leg failed, hence `!cancelled()`
      // instead), its `result` is a genuine all-or-nothing signal safe to
      // gate on directly.
      expect(getJob(doc, 'baseline').if).toContain("needs.resume-import.result == 'success'");
      expect(getJob(doc, 'checkpoint-init').if).toContain(
        "needs.resume-import.result == 'success'",
      );
    });

    it('only downloads prior-run artifacts when resume_run_id is non-empty (cross-run download-artifact step is conditional)', () => {
      const doc = loadWorkflow();
      const job = getJob(doc, 'resume-import');
      const downloadStep = (job.steps ?? []).find(
        (s) => s.uses?.startsWith('actions/download-artifact') && s.with?.['run-id'] !== undefined,
      );
      expect(downloadStep).toBeDefined();
      expect(downloadStep?.with?.['run-id']).toBe('${{ inputs.resume_run_id }}');
      expect(downloadStep?.with?.['github-token']).toBeDefined();
      expect(downloadStep?.if).toBeDefined();
      expect(downloadStep?.if).toContain("inputs.resume_run_id != ''");
    });

    it('selects the latest compatible checkpoint tier in strict r3 > r2 > r1 > init order, bounded by the dispatch rounds input', () => {
      const doc = loadWorkflow();
      const script = allRunSteps(getJob(doc, 'resume-import'));
      // The scan loop iterates over `$TIERS`, a shell variable set by a
      // `case "$ROUNDS" in` block immediately above it -- NOT a hardcoded
      // literal list. A prior run's r3/r2 checkpoint reflects MORE
      // optimization than e.g. a rounds=1 dispatch asked for, so importing
      // it unconditionally would silently perform more search than
      // requested. Assert the loop variable AND that every rounds value maps
      // to the correct strictly-bounded, strictly-descending tier subset.
      const tierLoopMatch = script.match(/for r in (\S+); do/);
      expect(tierLoopMatch).not.toBeNull();
      expect(tierLoopMatch![1]).toBe('$TIERS');
      expect(script).toMatch(/case "\$ROUNDS" in/);
      expect(script).toMatch(/3\)\s*TIERS="r3 r2 r1 init"\s*;;/);
      expect(script).toMatch(/2\)\s*TIERS="r2 r1 init"\s*;;/);
      expect(script).toMatch(/1\)\s*TIERS="r1 init"\s*;;/);
      expect(script).toMatch(/\*\)\s*TIERS="init"\s*;;/);
    });

    it('an INCOMPATIBLE newer tier does not stop the scan -- it keeps trying strictly-older tiers for that combo instead of unconditionally breaking', () => {
      const doc = loadWorkflow();
      const script = allRunSteps(getJob(doc, 'resume-import'));
      // Exactly one `break` in the whole job: it must fire ONLY on a
      // COMPATIBLE match (right after recording FOUND="$r"), never
      // unconditionally after the plain file-existence check -- an
      // unconditional break there would stop scanning at the first EXISTING
      // tier file even when it's incompatible, permanently blocking an older
      // (possibly compatible) tier from ever being tried for that combo.
      const breakCount = (script.match(/\bbreak\b/g) ?? []).length;
      expect(breakCount).toBe(1);
      expect(script).toMatch(/FOUND="\$r"\s*\n\s*break/);
    });

    it("routes each combo's compatibility check through round-plan.ts --mode resume-check (reuses existing strict provenance checks, fails closed on mismatch)", () => {
      const doc = loadWorkflow();
      const script = allRunSteps(getJob(doc, 'resume-import'));
      expect(script).toContain('--mode resume-check');
      expect(script).toContain('--expect-meta current-meta.json');
      expect(script).toContain('--expect-train-seeds');
      expect(script).toContain('--expect-weapons');
      // `--out` writes the NORMALIZED checkpoint (workflowSha re-stamped to
      // THIS run's value via `normalizeResumedCheckpoint`) directly from the
      // CLI, replacing a separate `cp` of the raw prior-run checkpoint --
      // copying it through unchanged would leave the accepted checkpoint
      // carrying the PRIOR run's workflowSha, silently failing every
      // downstream same-run `assertShardCompatible` check one round later.
      expect(script).toMatch(/--out "resumed\/search-checkpoint-init-\$\{COMBO\}\.json"/);
      // The `secondary` dispatch input changes the knob search space
      // (`knobsFor(combo, secondary)`), so it must also flow through the
      // compatibility check -- same `--expect-*` presence-flag pattern the
      // job already uses for the boolean `secondary` input elsewhere
      // (SECONDARY_FLAG built from `inputs.secondary`).
      expect(script).toContain('SECONDARY_FLAG="--expect-secondary"');
      expect(script).toMatch(/--expect-weapons "\$WEAPONS" \$SECONDARY_FLAG/);
      // Incompatible/missing checkpoints fall back to a fresh run for that
      // ONE combo with a visible log line -- never a silent merge of
      // mismatched search state.
      expect(script).toMatch(/::warning::.*INCOMPATIBLE/);
      expect(script).toMatch(/::notice::.*running fresh/);
    });

    it('binds each resume-check call to its combo/round SLOT via --combo/--round (not just the artifact filename), mapping tier name -> exact round number (r3=3, r2=2, r1=1, init=0)', () => {
      const doc = loadWorkflow();
      const script = allRunSteps(getJob(doc, 'resume-import'));
      // Tier -> numeric-round mapping must be exhaustive over every tier name
      // ever produced in TIERS (r3/r2/r1/init) so no tier silently falls
      // through without an EXPECT_ROUND value.
      expect(script).toMatch(/r3\)\s*EXPECT_ROUND=3\s*;;/);
      expect(script).toMatch(/r2\)\s*EXPECT_ROUND=2\s*;;/);
      expect(script).toMatch(/r1\)\s*EXPECT_ROUND=1\s*;;/);
      expect(script).toMatch(/init\)\s*EXPECT_ROUND=0\s*;;/);
      // The resume-check invocation itself must pass both bounds -- a
      // mislabeled artifact (wrong combo, or a round exceeding the tier
      // being imported) must be rejected by assertResumeCompatible instead
      // of trusted purely because its FILENAME matched the expected pattern.
      expect(script).toMatch(/--combo "\$COMBO" --round "\$EXPECT_ROUND"/);
    });

    it('default blank resume_run_id preserves fresh-run behavior byte-for-byte (freshCombos = every combo, resumedCombos = [])', () => {
      const doc = loadWorkflow();
      const script = allRunSteps(getJob(doc, 'resume-import'));
      expect(script).toContain('if [ -z "$RESUME_RUN_ID" ]; then');
      expect(script).toContain('FRESH="$COMBOS"');
      // RESUMED stays at its initial '[]' in the blank-input branch (no
      // reassignment of RESUMED inside the `if [ -z ... ]` branch).
      const blankBranch = script.split('if [ -z "$RESUME_RUN_ID" ]; then')[1]?.split('else')[0];
      expect(blankBranch).toBeDefined();
      expect(blankBranch).not.toContain('RESUMED=');
    });

    it('emits/uploads the additive sweep-lineage artifact from resume_run_id only after the resume-selection step, with the exact durable filename and artifact name', () => {
      const doc = loadWorkflow();
      const job = getJob(doc, 'resume-import');
      const steps = job.steps ?? [];
      const indexOf = (predicate: (s: (typeof steps)[number]) => boolean): number =>
        steps.findIndex(predicate);
      const selectIdx = indexOf((s) =>
        Boolean(s.name?.startsWith('Select latest compatible checkpoint per combo')),
      );
      const emitIdx = indexOf((s) =>
        Boolean(s.name?.startsWith('Emit sweep-lineage payload from resume_run_id')),
      );
      const uploadIdx = indexOf((s) =>
        Boolean(s.name?.startsWith('Upload sweep-lineage artifact')),
      );
      expect(selectIdx).toBeGreaterThanOrEqual(0);
      expect(emitIdx).toBeGreaterThan(selectIdx);
      expect(uploadIdx).toBeGreaterThan(emitIdx);

      const emitStep = steps[emitIdx];
      expect(emitStep?.if).toContain("inputs.resume_run_id != ''");
      // CRITICAL: must also gate on resumedCombos != '[]' so an expired/invalid
      // source run (where every combo fell back to fresh) does not produce a
      // resume-lineage artifact claiming resume ancestry on what is actually a
      // 100% fresh run (reviewer finding on ai-sweep.yml:406).
      expect(emitStep?.if).toContain("steps.resume.outputs.resumedCombos != '[]'");
      expect(emitStep?.env).toMatchObject({ RESUME_RUN_ID: '${{ inputs.resume_run_id }}' });
      expect(emitStep?.run).toContain('--mode emit-resume-lineage');
      expect(emitStep?.run).toContain('--resume-run-id "$RESUME_RUN_ID"');
      expect(emitStep?.run).toContain('--out "sweep-lineage.json"');

      const uploadStep = steps[uploadIdx];
      expect(uploadStep?.if).toContain("hashFiles('sweep-lineage.json') != ''");
      expect(uploadStep?.uses).toBe('actions/upload-artifact@v4');
      expect(uploadStep?.with?.name).toBe('sweep-lineage');
      expect(uploadStep?.with?.path).toBe('sweep-lineage.json');
    });

    it('round1-candidates, round1-select, and validate all tolerate the optional resumed-checkpoints bundle without hard-failing when absent', () => {
      const doc = loadWorkflow();
      for (const jobName of ['round1-candidates', 'round1-select', 'validate']) {
        const job = getJob(doc, jobName);
        const resumedDownload = (job.steps ?? []).find(
          (s) =>
            s.uses?.startsWith('actions/download-artifact') &&
            s.with?.pattern === 'resumed-checkpoints',
        );
        expect(resumedDownload, `job "${jobName}" resumed-checkpoints download step`).toBeDefined();
        // `if-no-artifact-found` is NOT a real input on actions/download-artifact@v4
        // (confirmed against the action's own action.yml — only name, artifact-ids,
        // path, pattern, merge-multiple, github-token, repository, run-id exist).
        // Tolerance for a missing bundle comes from using `pattern` (which the
        // action resolves via listArtifacts and succeeds with zero matches),
        // NOT from this dead input — so it must be absent, not asserted 'warn'.
        expect(resumedDownload?.with?.['if-no-artifact-found']).toBeUndefined();
        expect(resumedDownload?.with?.['pattern']).toBe('resumed-checkpoints');
        expect(resumedDownload?.with?.['merge-multiple']).toBe(true);
      }
    });

    it('round1-select fails loudly (not silently) if a combo has neither a fresh nor a resumed init checkpoint', () => {
      const doc = loadWorkflow();
      const script = allRunSteps(getJob(doc, 'round1-select'));
      expect(script).toMatch(/::error::.*no init checkpoint found/);
      expect(script).toContain('exit 1');
    });

    it('derives and uploads a fresh riskRewardFused+legacy baseline shard from its OWN resumed checkpoint, ONLY when riskRewardFused+legacy is itself in resumedCombos (closes the non-incumbent gap for a resumed riskRewardFused+legacy run)', () => {
      const doc = loadWorkflow();
      const job = getJob(doc, 'resume-import');
      const deriveStep = (job.steps ?? []).find((s) =>
        s.name?.startsWith('Derive riskRewardFused+legacy baseline shard'),
      );
      expect(deriveStep).toBeDefined();
      expect(deriveStep?.if).toContain(
        "contains(fromJSON(steps.resume.outputs.resumedCombos), 'riskRewardFused+legacy')",
      );
      // `continue-on-error` was REMOVED (found in review): a resumed
      // riskRewardFused+legacy checkpoint has ALREADY passed `resume-check` (which
      // requires a complete, duplicate-free, rectangular baseline panel),
      // so extraction failing here means this step's own invariant is
      // broken. Silently tolerating that failure would fall back to the
      // narrowed per-combo incumbent gate -- reintroducing the exact
      // safety-net gap this step exists to close. It must now fail the job
      // hard instead.
      expect(deriveStep?.['continue-on-error']).toBeUndefined();
      expect(deriveStep?.run).toContain('--mode extract-legacy-baseline');
      expect(deriveStep?.run).toContain(
        '--checkpoint "resumed/search-checkpoint-init-riskRewardFused+legacy.json"',
      );
      // Local output filename MUST match the `baseline` job's own convention
      // (`baseline-$COMBO.json`) -- `checkpoint-init`'s existing
      // pattern-based download step looks for exactly this filename, and
      // actions/download-artifact@v4 restores files under their ORIGINALLY
      // uploaded name, not the artifact name.
      expect(deriveStep?.run).toContain('--out "baseline-riskRewardFused+legacy.json"');

      const uploadStep = (job.steps ?? []).find((s) =>
        s.name?.startsWith('Upload derived riskRewardFused+legacy baseline shard'),
      );
      expect(uploadStep).toBeDefined();
      expect(uploadStep?.uses).toBe('actions/upload-artifact@v4');
      expect(uploadStep?.if).toContain(
        "contains(fromJSON(steps.resume.outputs.resumedCombos), 'riskRewardFused+legacy')",
      );
      // The `hashFiles(...) != ''` guard was REMOVED along with
      // `continue-on-error` -- the derive step now either succeeds (file
      // exists) or fails the job outright, so this upload step's `if:` no
      // longer needs to defensively check for the file's existence.
      expect(uploadStep?.if).not.toContain("hashFiles('baseline-riskRewardFused+legacy.json')");
      expect(uploadStep?.with?.name).toBe('search-baseline-riskRewardFused+legacy');
      expect(uploadStep?.with?.path).toBe('baseline-riskRewardFused+legacy.json');
    });

    it('uploads the resumed-checkpoints bundle SECOND-TO-LAST -- strictly after both the riskRewardFused+legacy derive AND upload steps -- so its existence depends on the WHOLE job succeeding', () => {
      const doc = loadWorkflow();
      const job = getJob(doc, 'resume-import');
      const steps = job.steps ?? [];
      const indexOf = (predicate: (s: (typeof steps)[number]) => boolean): number =>
        steps.findIndex(predicate);
      const deriveIdx = indexOf((s) =>
        Boolean(s.name?.startsWith('Derive riskRewardFused+legacy baseline shard')),
      );
      const uploadDerivedIdx = indexOf((s) =>
        Boolean(s.name?.startsWith('Upload derived riskRewardFused+legacy baseline shard')),
      );
      const uploadResumedIdx = indexOf((s) =>
        Boolean(s.name?.startsWith('Upload resumed checkpoints bundle')),
      );
      const tierUploadIdx = indexOf((s) =>
        Boolean(s.name?.startsWith('Upload resumed tier checkpoints for chained resume')),
      );
      expect(deriveIdx).toBeGreaterThanOrEqual(0);
      expect(uploadDerivedIdx).toBeGreaterThanOrEqual(0);
      expect(uploadResumedIdx).toBeGreaterThanOrEqual(0);
      expect(tierUploadIdx).toBeGreaterThanOrEqual(0);
      // Without `continue-on-error`, a step failure stops every LATER step in
      // the same job from running -- so ordering the resumed-checkpoints
      // upload after both incumbent-baseline steps means: if either of those
      // fails, this upload never runs and `resumed-checkpoints` is never
      // created this run. Placing it BEFORE them (the original ordering)
      // would let it survive a later derive/upload failure, silently handing
      // `round1-candidates`/`round1-select`/`validate` a partial bundle
      // missing the riskRewardFused+legacy baseline while `resume-import`'s own job
      // conclusion was 'failure' (found in review).
      expect(uploadResumedIdx).toBeGreaterThan(deriveIdx);
      expect(uploadResumedIdx).toBeGreaterThan(uploadDerivedIdx);
      // The tier-upload step (chained resume, continue-on-error) is the
      // true last step. It uses continue-on-error so a transient upload
      // failure cannot make resume-import's conclusion 'failure' and
      // misleadingly block current-run downstream jobs. The resumed-checkpoints
      // bundle upload must come BEFORE it (and LAST among the non-best-effort
      // steps) so its existence still depends on the whole job succeeding.
      expect(tierUploadIdx).toBeGreaterThan(uploadResumedIdx);
      expect(tierUploadIdx).toBe(steps.length - 1);
      expect(uploadResumedIdx).toBe(steps.length - 2);
    });

    it('copies accepted r1/r2/r3 checkpoints to tier-named files for chained resume, and uploads them under a search-checkpoint-* discoverable artifact name with continue-on-error', () => {
      const doc = loadWorkflow();
      const job = getJob(doc, 'resume-import');
      const steps = job.steps ?? [];

      // Shell script must copy init-named normalized checkpoints to their
      // original tier name (r1/r2/r3) so a future run's `search-checkpoint-*`
      // download finds them. Only non-init tiers need a copy (init-tier
      // resumes are named correctly already).
      const script = allRunSteps(job);
      expect(script).toMatch(
        /if \[ "\$FOUND" != "init" \]; then\s+cp "resumed\/search-checkpoint-init-\$\{COMBO\}\.json" \\\s+"resumed\/search-checkpoint-\$\{FOUND\}-\$\{COMBO\}\.json"/,
      );

      // Upload step: artifact name must match `search-checkpoint-*` so the
      // next run's cross-run download (pattern: search-checkpoint-*) can
      // find it. Path must be the tier-named files (not init-named).
      const tierUploadStep = steps.find((s) =>
        s.name?.startsWith('Upload resumed tier checkpoints for chained resume'),
      );
      expect(tierUploadStep).toBeDefined();
      expect(tierUploadStep?.uses).toBe('actions/upload-artifact@v4');
      // Must be best-effort: a transient failure here must NOT block
      // current-run downstream jobs via resume-import conclusion='failure'.
      expect(tierUploadStep?.['continue-on-error']).toBe(true);
      expect(tierUploadStep?.if).toContain("hashFiles('resumed/search-checkpoint-r*.json') != ''");
      expect(tierUploadStep?.with?.name).toBe('search-checkpoint-resumed');
      expect(tierUploadStep?.with?.path).toBe('resumed/search-checkpoint-r*.json');
    });
  });
});

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  validateRecoveredCheckpoints,
  type RecoveredCombo,
} from '../../scripts/agent/perf/recover-checkpoint-validate.js';
import type { RoundCheckpoint } from '../../scripts/agent/perf/round-plan.js';
import type { RunRow } from '../../scripts/agent/perf/aggregate-shards.js';
import { SHARD_SCHEMA_VERSION } from '../../scripts/agent/perf/aggregate-shards.js';
import { enumerateCombos, comboId, LEGACY_COMBO_ID } from '../../scripts/agent/perf/gen-configs.js';
import { bashEnv } from '../helpers/bash-script-path.js';

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

/**
 * Coverage for the VALIDATE-ONLY recovery of cancelled AI Sweep Eval run
 * 29786216369's completed round-2 checkpoints:
 *   - `recover-checkpoint-validate.ts`'s pure all-or-nothing gate (every SSOT
 *     combo present exactly once, workflowSha matches the externally-resolved
 *     source-run head_sha, cross-checkpoint provenance consistency, no
 *     secondary-knob tuning, complete duplicate-free TRAIN row panels); and
 *   - `.github/workflows/ai-sweep-recover.yml`'s structure (SHA resolution,
 *     historical-commit checkout pinning, GITHUB_SHA env overrides,
 *     queue-aware validate max-parallel wiring, job graph) parsed from the
 *     REAL YAML, not
 *     re-implemented, so a future edit cannot silently regress the SHA-pinning
 *     this recovery depends on to pass sweep-eval.ts's own unchanged
 *     `assertSearchArtifactProvenance` gate.
 */

const EXPECTED_SHA = 'a'.repeat(40);
const SSOT_COMBOS = enumerateCombos().map(comboId);
const TRAIN_SEEDS = [1, 2];
const WEAPONS = ['sword', 'bow'];

function buildRows(combo: string, configId: string): RunRow[] {
  const rows: RunRow[] = [];
  for (const seed of TRAIN_SEEDS) {
    for (const weapon of WEAPONS) {
      rows.push({
        combo,
        configId,
        weapon,
        seed,
        outcome: 'victory',
        officialWin: true,
        gameTimeMs: 100_000,
        safeRoomMs: 0,
        score: 100,
        xp: 10,
        gold: 5,
        minHealthPercent: 50,
        finalLevel: 3,
      });
    }
  }
  return rows;
}

function makeCheckpoint(
  combo: string,
  overrides: Partial<RoundCheckpoint> & { metaOverrides?: Partial<RoundCheckpoint['meta']> } = {},
): RoundCheckpoint {
  const { metaOverrides, ...rest } = overrides;
  // Mirrors round-plan.ts's initCheckpoint(): for LEGACY_COMBO_ID itself,
  // incumbentCombo stays equal to the combo's own string (no separate legacy
  // baseline needed); for every other combo it's pinned to LEGACY_COMBO_ID.
  // Either way incumbentConfigId is always a DISTINCT config id from
  // bestConfigId, so the incumbent row panel is a real, independently
  // checkable set even when incumbentCombo === combo (the LEGACY case).
  const incumbentCombo = combo === LEGACY_COMBO_ID ? combo : LEGACY_COMBO_ID;
  const bestConfigId = `${combo}-best`;
  const incumbentConfigId = `${incumbentCombo}-incumbent`;
  const finalistRows = buildRows(combo, bestConfigId);
  const incumbentRows = buildRows(incumbentCombo, incumbentConfigId);
  return {
    meta: {
      schemaVersion: SHARD_SCHEMA_VERSION,
      budgetMs: 360_000,
      floorId: 'floor1',
      maxFrames: 9900,
      stage: 'search',
      runnerOs: 'linux',
      nodeVersion: 'v20',
      packageLockHash: 'lockhash-1',
      workflowSha: EXPECTED_SHA,
      ...metaOverrides,
    },
    combo,
    round: 2,
    bestConfigId,
    bestScore: 100,
    incumbentConfigId,
    incumbentCombo,
    steps: {},
    converged: false,
    configs: {
      [bestConfigId]: { pathingMode: 'legacy', decisionMode: 'legacy' },
      [incumbentConfigId]: { pathingMode: 'legacy', decisionMode: 'legacy' },
    },
    rows: [...finalistRows, ...incumbentRows],
    ...rest,
  } as RoundCheckpoint;
}

function makeAllRecovered(
  overrideFor?: (combo: string, checkpoint: RoundCheckpoint) => RoundCheckpoint,
): RecoveredCombo[] {
  return SSOT_COMBOS.map((combo) => {
    let checkpoint = makeCheckpoint(combo);
    if (overrideFor) checkpoint = overrideFor(combo, checkpoint);
    return { combo, checkpoint };
  });
}

describe('validateRecoveredCheckpoints', () => {
  it('passes when all 8 combos are present, consistent, complete, and match expectedWorkflowSha', () => {
    const recovered = makeAllRecovered();
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails closed when a combo is missing', () => {
    const recovered = makeAllRecovered().slice(1);
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Missing') && e.includes(SSOT_COMBOS[0]!))).toBe(
      true,
    );
  });

  it('fails closed on a duplicate combo (two files claim the same combo)', () => {
    const recovered = makeAllRecovered();
    recovered.push({ combo: SSOT_COMBOS[0]!, checkpoint: makeCheckpoint(SSOT_COMBOS[0]!) });
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  it('fails closed on an unexpected/unknown combo id', () => {
    const recovered = makeAllRecovered();
    recovered[0] = { combo: 'bogus+combo', checkpoint: makeCheckpoint('bogus+combo') };
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Unexpected') && e.includes('bogus+combo'))).toBe(
      true,
    );
  });

  it('fails closed when a checkpoint.combo does not match its filename-derived combo', () => {
    const target = SSOT_COMBOS[0]!;
    const recovered = makeAllRecovered((combo, checkpoint) =>
      combo === target ? makeCheckpoint('fake+mismatch') : checkpoint,
    );
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(target) && e.includes('does not match'))).toBe(
      true,
    );
  });

  it('fails closed on round !== 2 (round 1, round 3, or init masquerading as round 2)', () => {
    const target = SSOT_COMBOS[0]!;
    const recovered = makeAllRecovered((combo, checkpoint) =>
      combo === target ? makeCheckpoint(combo, { round: 3 }) : checkpoint,
    );
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(target) && e.includes('round'))).toBe(true);
  });

  it('fails closed on a schemaVersion mismatch', () => {
    const target = SSOT_COMBOS[0]!;
    const recovered = makeAllRecovered((combo, checkpoint) =>
      combo === target
        ? makeCheckpoint(combo, { metaOverrides: { schemaVersion: SHARD_SCHEMA_VERSION + 1 } })
        : checkpoint,
    );
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('schemaVersion'))).toBe(true);
  });

  it('fails closed on a floorId mismatch', () => {
    const target = SSOT_COMBOS[0]!;
    const recovered = makeAllRecovered((combo, checkpoint) =>
      combo === target
        ? makeCheckpoint(combo, { metaOverrides: { floorId: 'floor2' } })
        : checkpoint,
    );
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('floorId'))).toBe(true);
  });

  it('fails closed when one checkpoint.meta.workflowSha differs from expectedWorkflowSha, even though it still agrees with the other checkpoints (proves the check is against the EXTERNAL expected value, not just mutual agreement)', () => {
    const target = SSOT_COMBOS[0]!;
    const recovered = makeAllRecovered((combo, checkpoint) =>
      combo === target
        ? makeCheckpoint(combo, { metaOverrides: { workflowSha: 'b'.repeat(40) } })
        : checkpoint,
    );
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(target) && e.includes('workflowSha'))).toBe(true);
    // Other, still-consistent-with-each-other combos are NOT falsely flagged.
    expect(result.errors.some((e) => e.includes(SSOT_COMBOS[1]!))).toBe(false);
  });

  it('fails closed for EVERY combo when all 8 mutually agree on workflowSha but that shared value differs from expectedWorkflowSha (mutual consistency alone is insufficient)', () => {
    const sharedWrongSha = 'c'.repeat(40);
    const recovered = makeAllRecovered((combo) =>
      makeCheckpoint(combo, { metaOverrides: { workflowSha: sharedWrongSha } }),
    );
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    for (const combo of SSOT_COMBOS) {
      expect(result.errors.some((e) => e.includes(combo) && e.includes('workflowSha'))).toBe(true);
    }
  });

  it('fails closed immediately when expectedWorkflowSha is empty, regardless of checkpoint content', () => {
    const recovered = makeAllRecovered();
    const result = validateRecoveredCheckpoints(recovered, SSOT_COMBOS, TRAIN_SEEDS, WEAPONS, '');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('expectedWorkflowSha is empty'))).toBe(true);
  });

  it('fails closed when a checkpoint.steps includes a SECONDARY_KNOBS key (secondary tuning was performed)', () => {
    const target = SSOT_COMBOS[0]!;
    const recovered = makeAllRecovered((combo, checkpoint) =>
      combo === target ? makeCheckpoint(combo, { steps: { scanRadius: 10 } }) : checkpoint,
    );
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes(target) && e.includes('secondary-knob'))).toBe(
      true,
    );
  });

  it('fails closed when the finalist row panel is missing one (seed, weapon) pair', () => {
    const target = SSOT_COMBOS[0]!;
    const recovered = makeAllRecovered((combo, checkpoint) => {
      if (combo !== target) return checkpoint;
      const full = makeCheckpoint(combo);
      const bestConfigId = full.bestConfigId;
      const incumbentRows = full.rows.filter((r) => r.configId !== bestConfigId);
      const finalistRows = full.rows.filter((r) => r.configId === bestConfigId).slice(1);
      return { ...full, rows: [...finalistRows, ...incumbentRows] };
    });
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes(target) && e.includes('missing') && e.includes('finalist'),
      ),
    ).toBe(true);
  });

  it('fails closed when the finalist row panel contains a duplicate (seed, weapon) pair', () => {
    const target = SSOT_COMBOS[0]!;
    const recovered = makeAllRecovered((combo, checkpoint) => {
      if (combo !== target) return checkpoint;
      const full = makeCheckpoint(combo);
      const bestConfigId = full.bestConfigId;
      const finalistRows = full.rows.filter((r) => r.configId === bestConfigId);
      const otherRows = full.rows.filter((r) => r.configId !== bestConfigId);
      return { ...full, rows: [...finalistRows, finalistRows[0]!, ...otherRows] };
    });
    const result = validateRecoveredCheckpoints(
      recovered,
      SSOT_COMBOS,
      TRAIN_SEEDS,
      WEAPONS,
      EXPECTED_SHA,
    );
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes(target) && e.includes('duplicate') && e.includes('finalist'),
      ),
    ).toBe(true);
  });

  it('confirms LEGACY_COMBO_ID is present among the SSOT combos (explicit assertion, not just implied by check #1)', () => {
    expect(SSOT_COMBOS).toContain(LEGACY_COMBO_ID);
  });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}

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
  env?: Record<string, string>;
  strategy?: WorkflowStrategy;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowDoc {
  on: { workflow_dispatch: { inputs: Record<string, { type: string; default?: unknown }> } };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

function loadRecoverWorkflow(): WorkflowDoc {
  const raw = readFileSync(path.join(REPO_ROOT, '.github/workflows/ai-sweep-recover.yml'), 'utf8');
  return parse(raw) as WorkflowDoc;
}

function getJob(doc: WorkflowDoc, name: string): WorkflowJob {
  const job = doc.jobs[name];
  if (!job) throw new Error(`job "${name}" not found in ai-sweep-recover.yml`);
  return job;
}

function needsList(job: WorkflowJob): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function allSteps(job: WorkflowJob): WorkflowStep[] {
  return job.steps ?? [];
}

function allRunScript(job: WorkflowJob): string {
  return allSteps(job)
    .map((s) => s.run ?? '')
    .join('\n---\n');
}

describe('ai-sweep-recover.yml structure', () => {
  it('is dispatch-only with source_run_id defaulting to the incident run', () => {
    const doc = loadRecoverWorkflow();
    expect(doc.on.workflow_dispatch.inputs.source_run_id).toMatchObject({
      type: 'string',
      default: '29786216369',
    });
  });

  it('requires actions: read (beyond contents: read) for cross-run gh api + download-artifact', () => {
    const doc = loadRecoverWorkflow();
    expect(doc.permissions).toMatchObject({ contents: 'read', actions: 'read' });
  });

  it('recover-preflight resolves head_sha via the GitHub API and exposes it as a job output', () => {
    const doc = loadRecoverWorkflow();
    const preflight = getJob(doc, 'recover-preflight');
    const script = allRunScript(preflight);
    expect(script).toMatch(/gh api "repos\/.*\/actions\/runs\/\$SOURCE_RUN_ID"/);
    expect(script).toMatch(/head_sha=\$HEAD_SHA.*GITHUB_OUTPUT/);
    expect(preflight.outputs?.head_sha).toBeDefined();
  });

  it("recover-preflight keeps a default checkout (no custom ref) since it needs this branch's new validator script", () => {
    const doc = loadRecoverWorkflow();
    const preflight = getJob(doc, 'recover-preflight');
    const checkoutStep = allSteps(preflight).find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkoutStep).toBeDefined();
    expect(checkoutStep?.with?.ref).toBeUndefined();
  });

  it('recover-validate and recover-aggregate both pin checkout to recover-preflight.outputs.head_sha', () => {
    const doc = loadRecoverWorkflow();
    for (const jobName of ['recover-validate', 'recover-aggregate']) {
      const job = getJob(doc, jobName);
      const checkoutStep = allSteps(job).find((s) => s.uses?.startsWith('actions/checkout'));
      expect(checkoutStep?.with?.ref, `${jobName} checkout ref`).toBe(
        '${{ needs.recover-preflight.outputs.head_sha }}',
      );
    }
  });

  it('recover-validate never sets GITHUB_SHA via a step/job env: key (GitHub Actions silently discards overrides of reserved GITHUB_*/RUNNER_* variables, so a naive env: override never reaches the child — this is exactly what broke run 29869238382)', () => {
    const doc = loadRecoverWorkflow();
    for (const jobName of ['recover-validate', 'recover-aggregate']) {
      const job = getJob(doc, jobName);
      expect(job.env?.GITHUB_SHA, `${jobName} job-level env.GITHUB_SHA`).toBeUndefined();
      for (const step of allSteps(job)) {
        expect(
          step.env?.GITHUB_SHA,
          `${jobName} step "${step.name}" env.GITHUB_SHA`,
        ).toBeUndefined();
      }
    }
  });

  it('recover-validate and recover-aggregate both thread the historical SHA through a non-reserved RECOVER_HEAD_SHA env var to match the historical commit', () => {
    const doc = loadRecoverWorkflow();
    const expectedShaExpr = '${{ needs.recover-preflight.outputs.head_sha }}';

    const validateJob = getJob(doc, 'recover-validate');
    const validateStep = allSteps(validateJob).find((s) =>
      s.run?.includes('prebundle-cli.mjs --entry sweep-eval'),
    );
    expect(validateStep?.env?.RECOVER_HEAD_SHA).toBe(expectedShaExpr);

    const aggregateJob = getJob(doc, 'recover-aggregate');
    const aggregateStep = allSteps(aggregateJob).find((s) => s.run?.includes('gen-configs.ts'));
    expect(aggregateStep?.env?.RECOVER_HEAD_SHA).toBe(expectedShaExpr);
  });

  it('recover-validate and recover-aggregate assign GITHUB_SHA inline at the exec boundary (immediately before each runner invocation), not via env:', () => {
    const doc = loadRecoverWorkflow();
    const validateScript = allRunScript(getJob(doc, 'recover-validate'));
    expect(validateScript).toMatch(
      /GITHUB_SHA="\$RECOVER_HEAD_SHA"\s+node scripts\/agent\/perf\/prebundle-cli\.mjs --entry sweep-eval/,
    );

    const aggregateScript = allRunScript(getJob(doc, 'recover-aggregate'));
    expect(aggregateScript).toMatch(
      /GITHUB_SHA="\$RECOVER_HEAD_SHA"\s+npx tsx scripts\/agent\/perf\/gen-configs\.ts/,
    );
    expect(aggregateScript).toMatch(
      /GITHUB_SHA="\$RECOVER_HEAD_SHA"\s+npx tsx scripts\/agent\/perf\/aggregate-shards\.ts/,
    );
  });

  it('EXECUTION regression: the exec-boundary GITHUB_SHA assignment extracted from the real workflow actually propagates the historical SHA into a spawned child process, even when the ambient job env carries a different (dispatch) GITHUB_SHA — proving the mechanism works, not merely that the YAML declares it', () => {
    if (!hasBash) return; // environment without bash on PATH: structural coverage above still applies.

    const doc = loadRecoverWorkflow();
    const job = getJob(doc, 'recover-validate');
    const step = allSteps(job).find((s) => s.run?.includes('prebundle-cli.mjs --entry sweep-eval'));
    const runScript = step?.run ?? '';

    // Extract the literal exec-boundary prefix (e.g. `GITHUB_SHA="$RECOVER_HEAD_SHA"`)
    // used immediately before the runner in the REAL workflow file — not a
    // hand-duplicated copy — so a future edit that regresses the idiom (e.g.
    // reverting to a step-level env: key) fails this test.
    const match = runScript.match(
      /(GITHUB_SHA="\$RECOVER_HEAD_SHA")\s+node scripts\/agent\/perf\/prebundle-cli\.mjs/,
    );
    expect(
      match,
      'exec-boundary GITHUB_SHA assignment not found in recover-validate run script',
    ).not.toBeNull();
    const execBoundaryPrefix = match![1]!;

    // Simulate exactly the failure mode observed in run 29869238382: the
    // runner's ambient GITHUB_SHA is the dispatch SHA (different from the
    // historical SHA we need). Stand in for `npx tsx sweep-eval.ts`'s
    // `currentBuildFingerprint()` read with a minimal child process that
    // reads process.env.GITHUB_SHA directly.
    const dispatchSha = '4'.repeat(40);
    const historicalSha = '1'.repeat(40);
    // `printenv` is a standalone binary (not a shell builtin), so invoking it
    // genuinely proves the override crosses a real process-exec boundary —
    // exactly what the prebundle launcher spawning the sweep-eval child does — without
    // depending on `node` being resolvable inside whichever `bash` is on PATH
    // (e.g. the WSL interop shim, which has its own separate PATH/toolchain).
    const probeScript = `${execBoundaryPrefix} printenv GITHUB_SHA`;

    const result = spawnSync('bash', ['-c', probeScript], {
      encoding: 'utf8',
      env: bashEnv({
        GITHUB_SHA: dispatchSha,
        RECOVER_HEAD_SHA: historicalSha,
      }),
    });

    expect(result.status, `probe script failed:\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(historicalSha);
    expect(result.stdout.trim()).not.toBe(dispatchSha);
  });

  it('recover-validate matrix uses the queue-aware max-parallel output', () => {
    const doc = loadRecoverWorkflow();
    const job = getJob(doc, 'recover-validate');
    expect(String(job.strategy?.['max-parallel'])).toContain('validate_max_parallel');
    expect(job.strategy?.['fail-fast']).toBe(false);
  });

  it('recover-validate and recover-aggregate are gated with !cancelled(), never always()', () => {
    const doc = loadRecoverWorkflow();
    for (const jobName of ['recover-validate', 'recover-aggregate']) {
      const job = getJob(doc, jobName);
      expect(job.if, jobName).toContain('!cancelled()');
      expect(job.if, jobName).not.toContain('always()');
    }
  });

  it('job graph: recover-preflight -> recover-validate -> recover-aggregate (needing both priors)', () => {
    const doc = loadRecoverWorkflow();
    expect(needsList(getJob(doc, 'recover-validate'))).toContain('recover-preflight');
    const aggregateNeeds = needsList(getJob(doc, 'recover-aggregate'));
    expect(aggregateNeeds).toContain('recover-preflight');
    expect(aggregateNeeds).toContain('recover-validate');
  });

  it('recover-validate invokes sweep-eval.ts --stage validate only (never search/search-eval/search-baseline or round-plan.ts plan/select)', () => {
    const doc = loadRecoverWorkflow();
    const script = allRunScript(getJob(doc, 'recover-validate'));
    expect(script).toContain('--stage validate');
    expect(script).not.toContain('--stage search');
    expect(script).not.toContain('--stage search-eval');
    expect(script).not.toContain('--stage search-baseline');
    expect(script).not.toContain('round-plan.ts');
  });

  it('has no round-3/roundN-* jobs — this is a validate-only recovery, never a round-eval resume', () => {
    const doc = loadRecoverWorkflow();
    expect(Object.keys(doc.jobs).sort()).toEqual(
      ['recover-aggregate', 'recover-preflight', 'recover-validate'].sort(),
    );
  });

  it('recover-preflight downloads round-2 checkpoints cross-run via run-id + github-token', () => {
    const doc = loadRecoverWorkflow();
    const preflight = getJob(doc, 'recover-preflight');
    const downloadStep = allSteps(preflight).find(
      (s) => s.uses?.startsWith('actions/download-artifact') && s.with?.pattern,
    );
    expect(downloadStep?.with?.pattern).toBe('search-checkpoint-r2-*');
    expect(downloadStep?.with?.['run-id']).toBe('${{ inputs.source_run_id }}');
    expect(downloadStep?.with?.['github-token']).toBeDefined();
  });

  it('recover-preflight runs recover-checkpoint-validate.ts with --expected-workflow-sha wired to the resolved head_sha', () => {
    const doc = loadRecoverWorkflow();
    const script = allRunScript(getJob(doc, 'recover-preflight'));
    expect(script).toContain('recover-checkpoint-validate.ts');
    expect(script).toContain('--expected-workflow-sha');
  });
});

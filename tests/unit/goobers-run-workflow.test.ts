import { existsSync, readFileSync, statSync } from 'node:fs';
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
    push?: { paths?: string[] };
    pull_request?: { paths?: string[] };
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
  jobs: Record<string, GoobersActionsJob | undefined> & {
    reserve?: GoobersActionsJob;
    run?: GoobersActionsJob;
    'release-unstarted-reservation'?: GoobersActionsJob;
  };
}

interface GoobersActionsJob {
  if?: string;
  name?: string;
  needs?: string | string[];
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { matrix?: { lane?: number[] }; 'max-parallel'?: number; 'fail-fast'?: boolean };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  'timeout-minutes'?: number;
  steps?: Array<GoobersActionsStep>;
}

interface GoobersActionsStep {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  'timeout-minutes'?: number;
  with?: Record<string, string | boolean>;
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
    readiness?: { maxConcurrentRuns?: number; desiredConcurrentRuns?: number };
    runControls?: { maxRepasses?: number };
    tasks: Array<{
      name: string;
      next?: string;
      run?: { command?: string[]; script?: string };
      inputs?: Record<string, string>;
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
  runConditions?: { maxParallelRuns?: number };
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
 * the "Materialize checked-in source into each slot instance" step writes with a
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

function readSparseCheckoutPaths(step: GoobersActionsStep | undefined): string[] {
  const sparseCheckout = step?.with?.['sparse-checkout'];
  if (typeof sparseCheckout !== 'string') {
    return [];
  }
  return sparseCheckout
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function extractReferencedRepoFiles(steps: GoobersActionsStep[]): string[] {
  const references = new Set<string>();
  const repoFilePattern =
    /(?:\$\{GITHUB_WORKSPACE\}\/)?((?:\.github|scripts)\/[A-Za-z0-9._/-]+\.(?:cjs|js|json|mjs|sh|ts|yaml|yml))/g;

  for (const step of steps) {
    for (const match of step.run?.matchAll(repoFilePattern) ?? []) {
      if (match[1]) {
        references.add(match[1]);
      }
    }
  }
  return [...references].sort();
}

function sparseCheckoutIncludes(repoFile: string, sparsePaths: string[]): boolean {
  return sparsePaths.some(
    (sparsePath) => repoFile === sparsePath || repoFile.startsWith(`${sparsePath}/`),
  );
}

/**
 * A sparse cone only populates the directories it names, so a script the
 * workflow invokes by path is not enough: every module that script pulls in --
 * including siblings of a *different* directory, like the `ci-recovery`
 * eligibility library the Goobers intake selector imports -- has to be in the
 * cone too, or the step dies with `ERR_MODULE_NOT_FOUND` at run time.
 */
function resolveRelativeImport(fromRepoFile: string, specifier: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRepoFile), specifier));
  const candidates = [
    base,
    ...['.mjs', '.cjs', '.js', '.ts'].flatMap((extension) => [
      `${base}${extension}`,
      path.posix.join(base, `index${extension}`),
    ]),
  ];
  return (
    candidates.find((candidate) => {
      if (candidate === '..' || candidate.startsWith('../')) return false;
      // Must be an existing *file*: a directory that shares a module's name
      // (`./lib` next to `lib.mjs`) would otherwise satisfy the bare `base`
      // candidate and silently truncate the import walk.
      const absolute = path.join(REPO_ROOT, candidate);
      return existsSync(absolute) && statSync(absolute).isFile();
    }) ?? null
  );
}

function collectTransitiveRepoFiles(entryFiles: string[]): {
  files: string[];
  unresolved: string[];
} {
  const moduleExtensions = new Set(['.mjs', '.cjs', '.js', '.ts']);
  // Statement forms (`import ... from '<x>'`, bare `import '<x>'`,
  // `export ... from '<x>'`) are anchored to the start of a line, and the call
  // forms (`import('<x>')`, `require('<x>')`) require the call parenthesis, so
  // prose in a doc comment or a path quoted inside an error message is not
  // mistaken for a real dependency edge.
  const specifierPatterns = [
    // `import ... from '<x>'` / `export ... from '<x>'`, including the
    // multi-line named form. The gap excludes `;` and quotes so it cannot run
    // past the end of one statement.
    /(?:^|\n)[ \t]*(?:import|export)\b[^;'"]*?\bfrom[ \t]*['"]([^'"]+)['"]/g,
    /(?:^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const repoFile = queue.shift() as string;
    if (files.has(repoFile)) continue;
    files.add(repoFile);
    if (!moduleExtensions.has(path.posix.extname(repoFile))) continue;
    const absolute = path.join(REPO_ROOT, repoFile);
    if (!existsSync(absolute)) continue;

    const source = readFileSync(absolute, 'utf8');
    for (const specifierPattern of specifierPatterns) {
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1];
        if (!specifier?.startsWith('.')) continue;
        const resolved = resolveRelativeImport(repoFile, specifier);
        if (resolved) {
          queue.push(resolved);
        } else {
          unresolved.push(`${repoFile} -> ${specifier}`);
        }
      }
    }
  }
  return { files: [...files].sort(), unresolved };
}

describe('Goobers automatic dispatch and recovery', () => {
  it('dispatches immediately for eligible issue events and performs an hourly recovery sweep', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');

    // `opened`/`reopened` are the immediate-dispatch path for the transferred
    // legacy intake cohort; `labeled` remains the explicit approval path.
    expect(workflow.on.issues?.types).toEqual(['opened', 'reopened', 'labeled']);
    expect(workflow.on.schedule).toEqual([{ cron: '37 * * * *' }]);
    expect(workflow.on.workflow_dispatch).toBeDefined();
    // The event filter lives on the reserve job now: it is the first job of
    // the graph, and everything else hangs off it via `needs:`, so an
    // irrelevant label event is skipped there and never reaches a lane. It
    // still carries the full intake-parity expression, so `opened`/`reopened`
    // reach the canonical selector while `labeled` stays approval-gated.
    expect(workflow.jobs.reserve?.if).toContain("github.event_name != 'issues'");
    expect(workflow.jobs.reserve?.if).toContain("github.event.label.name == 'goobers:approved'");
    expect(workflow.jobs.reserve?.if).toContain("github.event.action != 'labeled'");
    expect(workflow.jobs.reserve?.if).toContain("github.event.issue.state == 'open'");
    expect(workflow.jobs.reserve?.if).toContain("vars.LIFECYCLE_MUTATION_OWNER == 'goobers'");
    expect(workflow.concurrency).toBeUndefined();
    expect(workflow.jobs.reserve?.concurrency).toEqual({
      group: 'goobers-run-reserve',
      'cancel-in-progress': false,
    });
    expect(workflow.jobs.run?.concurrency).toEqual({
      group: 'goobers-run-lane-${{ matrix.lane }}',
      'cancel-in-progress': false,
    });
  });

  it('includes every checked-in file — and its transitive imports — used after a sparse checkout', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const sparseJobs = Object.entries(workflow.jobs).filter(([, job]) =>
      job?.steps?.some((step) => readSparseCheckoutPaths(step).length > 0),
    );
    const requiredByJob = new Map<string, string[]>();

    expect(sparseJobs.map(([jobName]) => jobName)).toEqual(
      expect.arrayContaining(['release-unstarted-reservation', 'reserve']),
    );
    for (const [jobName, job] of sparseJobs) {
      const steps = job?.steps ?? [];
      const checkoutIndex = steps.findIndex((step) => readSparseCheckoutPaths(step).length > 0);
      const sparsePaths = readSparseCheckoutPaths(steps[checkoutIndex]);
      const referencedFiles = extractReferencedRepoFiles(steps.slice(checkoutIndex + 1));

      expect(
        referencedFiles,
        `"${jobName}" sparse job must reference checked-in tooling`,
      ).not.toEqual([]);
      for (const repoFile of referencedFiles) {
        expect(
          existsSync(path.join(REPO_ROOT, repoFile)),
          `"${jobName}" references missing repository file "${repoFile}"`,
        ).toBe(true);
      }

      const { files: requiredFiles, unresolved } = collectTransitiveRepoFiles(referencedFiles);
      requiredByJob.set(jobName, requiredFiles);
      expect(
        unresolved,
        `"${jobName}" pulls in relative imports that do not resolve on disk: ${unresolved.join(', ')}`,
      ).toEqual([]);

      for (const repoFile of requiredFiles) {
        expect(
          sparseCheckoutIncludes(repoFile, sparsePaths),
          `"${jobName}" needs "${repoFile}" at run time (directly or via an import chain), but sparse-checkout includes only: ${sparsePaths.join(', ')}. Add the file or its parent directory to that checkout.`,
        ).toBe(true);
      }
    }

    // The regression this test was written for: the reserve job invokes the
    // intake selector, which imports the `ci-recovery` eligibility library, so
    // both cones have to be checked out.
    expect(requiredByJob.get('reserve')).toEqual(
      expect.arrayContaining([
        '.github/scripts/goobers/intake-selection.mjs',
        '.github/scripts/ci-recovery/issue-intake-lib.mjs',
        // Reached only through the multi-line named import in
        // `issue-intake-lib.mjs`, so these also pin that the walk parses that
        // statement form.
        '.github/scripts/ci-recovery/markers.mjs',
        '.github/scripts/ci-recovery/state.mjs',
      ]),
    );
  });

  it('runs two lanes of two isolated slots each — exactly four simultaneous issue workflows', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const job = workflow.jobs.run;
    const runStep = job?.steps?.find((step) => step.name === 'Run the workflow');
    const script = runStep?.run ?? '';

    // Two GitHub-hosted runner jobs...
    expect(job?.strategy?.matrix?.lane).toEqual([1, 2]);
    expect(job?.strategy?.['max-parallel']).toBe(2);
    expect(job?.strategy?.['fail-fast']).toBe(false);

    // ...each running two concurrent slots. 2 x 2 = the hard maximum of four.
    expect(job?.env?.GOOBERS_SLOTS).toBe('1 2');
    expect((job?.env?.GOOBERS_SLOTS ?? '').trim().split(/\s+/)).toHaveLength(2);
    expect(job?.env?.GOOBERS_LANE).toBe('${{ matrix.lane }}');
    expect(job?.env?.GOOBERS_LANE_ROOT).toBe(
      '${{ github.workspace }}/.goobers-lane-${{ matrix.lane }}',
    );
    // No lane-wide instance root survives: an instance root shared by two
    // concurrent runs is exactly the checkout/lock collision this design
    // exists to avoid.
    expect(job?.env?.GOOBERS_INSTANCE).toBeUndefined();

    // Both slots are launched before either is waited on (real concurrency,
    // not the sequential recovery-then-fresh shape that only ever had one
    // task in flight at a time), and each blocks on its OWN instance root.
    const launchIndex = script.indexOf(
      'exec goobers run --github-progress "$GOOBERS_WORKFLOW" "$slot_root"',
    );
    const backgroundIndex = script.indexOf(') >"$slot_log" 2>&1 &');
    const waitIndex = script.indexOf('wait "$pid"');
    expect(launchIndex).toBeGreaterThanOrEqual(0);
    expect(backgroundIndex).toBeGreaterThan(launchIndex);
    expect(waitIndex).toBeGreaterThan(backgroundIndex);
    expect(script).toContain('for slot in ${GOOBERS_SLOTS}; do');
    expect(script).toContain('export GOOBERS_INSTANCE="$slot_root"');
    expect(script).toContain('slot_root="${GOOBERS_LANE_ROOT}/slot-${slot}"');

    // The daemon-delegation design is gone: no `goobers up`, and no
    // `--no-wait` dispatch that would leave completion untracked. Comments are
    // stripped first so prose that explains why the daemon shape was rejected
    // does not read as an invocation.
    const executableScript = script.replace(/^\s*#.*$/gm, '');
    expect(executableScript).not.toContain('goobers up');
    expect(executableScript).not.toContain('--no-wait');

    // The four-claim ceiling is structural — one run per instance root, four
    // roots — rather than an arithmetic budget that can drift.
    const definition = loadYaml<GoobersDefinition>(
      '.goobers',
      'gaggles',
      'crawler',
      'workflows',
      'crawler-feature-pr.yaml',
    );
    expect(definition.spec.readiness?.maxConcurrentRuns).toBe(1);
    expect(definition.spec.readiness?.desiredConcurrentRuns).toBeUndefined();
    const instance = loadYaml<GoobersInstance>('.goobers', 'instance.yaml.example');
    expect(instance.runConditions?.maxParallelRuns).toBe(1);

    const materialize = job?.steps?.find(
      (step) => step.name === 'Materialize checked-in source into each slot instance',
    );
    expect(materialize?.run).toContain('maxParallelRuns: 1');
    expect(materialize?.run).not.toContain('maxParallelRuns: 2');
  });

  it('isolates each slot in its own instance root and never shares a checkout', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const job = workflow.jobs.run;
    const scaffold = job?.steps?.find(
      (step) => step.name === 'Scaffold throwaway slot instance roots',
    );
    const materialize = job?.steps?.find(
      (step) => step.name === 'Materialize checked-in source into each slot instance',
    );

    // Every mutable thing a Goobers run touches — scheduler/up.lock, the claim
    // ledger and its lock, gaggles/<gaggle>/workcopies (the git checkout plus
    // its GIT_ASKPASS helper), the telemetry/read DBs and the run journals —
    // is rooted at the instance root, so per-slot roots are what make two
    // simultaneous runs on one runner safe. Both slots must therefore be
    // scaffolded and materialized independently.
    for (const step of [scaffold, materialize]) {
      expect(step?.run).toContain('for slot in ${GOOBERS_SLOTS}; do');
      expect(step?.run).toContain('${GOOBERS_LANE_ROOT}/slot-${slot}');
    }
    expect(scaffold?.run).toContain('mkdir -p "${GOOBERS_LANE_ROOT}/slot-${slot}/config"');
    expect(materialize?.run).toContain('goobers config materialize "$slot_root"');
    expect(materialize?.run).toContain('goobers validate "$slot_root"');
    // GOOBERS_INSTANCE has to reach each stage as THAT slot's root, because
    // query-backlog passes it to `goobers backlog-query --claim`.
    expect(readGeneratedEnvPassthrough(materialize?.run)).toContain('GOOBERS_INSTANCE');
  });

  it('bounds every slot inside the job timeout so cleanup and upload always run', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const job = workflow.jobs.run;
    const steps = job?.steps ?? [];
    const script = steps.find((step) => step.name === 'Run the workflow')?.run ?? '';
    const reap = steps.find((step) => step.name === 'Reap surviving Goobers stage processes');

    const deadlineSeconds = Number(job?.env?.GOOBERS_SLOT_DEADLINE_SECONDS);
    const reserveSeconds = Number(job?.env?.GOOBERS_CLEANUP_RESERVE_SECONDS);
    const budgetMinutes = Number(job?.env?.GOOBERS_JOB_TIMEOUT_MINUTES);
    expect(Number.isInteger(deadlineSeconds)).toBe(true);
    expect(Number.isInteger(reserveSeconds)).toBe(true);
    // The arithmetic has to be done against the SAME budget the runner
    // enforces, so the restated minutes and `timeout-minutes` cannot drift.
    expect(budgetMinutes).toBe(job?.['timeout-minutes']);

    // The job's budget starts at job start, not at "Run the workflow", so the
    // deadline is derived from an absolute anchor recorded by the very first
    // step. Without it, a slow setup (checkout, npm ci, Copilot CLI install,
    // four instance materializations) silently eats the window the teardown,
    // journal uploads and claim/label cleanup need at the far end.
    expect(steps[0]?.name).toBe('Record job start');
    expect(steps[0]?.run).toContain('GOOBERS_JOB_START_EPOCH=$(date +%s)');
    expect(script).toContain('job_observed_elapsed=$(( $(date +%s) - GOOBERS_JOB_START_EPOCH ))');
    // ...and that anchor is still not authoritative: the runner began counting
    // `timeout-minutes` at job start, which precedes the first step by however
    // long scheduling, runner acquisition and bootstrap took. The allowance
    // makes the elapsed figure an OVER-estimate, which biases toward more
    // cleanup headroom rather than less.
    const startSlack = Number(job?.env?.GOOBERS_JOB_START_SLACK_SECONDS);
    expect(Number.isInteger(startSlack)).toBe(true);
    expect(startSlack).toBeGreaterThan(0);
    expect(script).toContain(
      'job_elapsed=$(( job_observed_elapsed + GOOBERS_JOB_START_SLACK_SECONDS ))',
    );
    expect(script).toContain(
      'run_budget=$(( GOOBERS_JOB_TIMEOUT_MINUTES * 60 - job_elapsed - GOOBERS_CLEANUP_RESERVE_SECONDS ))',
    );
    expect(script).toContain('deadline=$((SECONDS + run_budget))');
    // The poll never sleeps past the deadline: a fixed interval overshoots by
    // up to a full interval, and every second of overshoot is stolen from the
    // cleanup reserve.
    expect(script).toContain('remaining=$(( deadline - SECONDS ))');
    expect(script).toContain('if [ "$remaining" -lt "$GOOBERS_SLOT_POLL_SECONDS" ]; then');
    expect(script).toContain('sleep "$remaining"');
    expect(Number.isInteger(Number(job?.env?.GOOBERS_SLOT_POLL_SECONDS))).toBe(true);
    // The declared slot deadline is a CAP on the derived budget, never a
    // replacement for it, and a setup that leaves no room refuses to start a
    // slot rather than starting one it could not clean up after.
    expect(script).toContain('if [ "$run_budget" -gt "$GOOBERS_SLOT_DEADLINE_SECONDS" ]; then');
    expect(script).toContain('if [ "$run_budget" -le 0 ]; then');
    expect(script).toContain('Refusing to start a slot that could not be cleaned up');

    // Even at the cap, the run window plus the reserve must fit the budget.
    expect(deadlineSeconds + reserveSeconds).toBeLessThanOrEqual(budgetMinutes * 60);

    // And the reserve must cover every ENFORCED ceiling in the cleanup tail,
    // recomputed here from the workflow's own literals rather than asserted as
    // a magic number. Two components:
    //
    //   (a) the deadline teardown inside "Run the workflow", which the runner
    //       does not bound for us — every slot in turn, each able to spend its
    //       full grace period, the teardown script's verification window and
    //       its /proc sweep slack;
    //   (b) every cleanup step's own `timeout-minutes`, which the runner DOES
    //       enforce, plus an allowance for the runner's post-job steps.
    //
    // (b) is what turns the reserve from an estimate into a proof: a wedged
    // cleanup step is killed by its own bound, so the 90-minute job timeout
    // cannot interrupt the steps after it.
    const slotCount = (job?.env?.GOOBERS_SLOTS ?? '').trim().split(/\s+/).length;
    const deadlineGrace = Number(
      /goobers_teardown_tree "\$\{GOOBERS_LANE_ROOT\}\/slot-\$\{slot\}" (\d+) "\$\{pid\}:\$\{start\}"/.exec(
        script,
      )?.[1],
    );
    const reapGrace = Number(
      /goobers_teardown_tree "\$\{GOOBERS_LANE_ROOT\}\/slot-\$\{slot\}" (\d+)/.exec(
        reap?.run ?? '',
      )?.[1],
    );
    const teardownScript = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'agent', 'goobers-stage-teardown.sh'),
      'utf8',
    );
    const verifyWindow = Number(/GOOBERS_TEARDOWN_VERIFY_SECONDS=(\d+)/.exec(teardownScript)?.[1]);
    const sweepSlack = Number(
      /GOOBERS_TEARDOWN_SWEEP_SLACK_SECONDS=(\d+)/.exec(teardownScript)?.[1],
    );
    expect(Number.isInteger(deadlineGrace)).toBe(true);
    expect(Number.isInteger(reapGrace)).toBe(true);
    expect(Number.isInteger(verifyWindow)).toBe(true);
    expect(Number.isInteger(sweepSlack)).toBe(true);
    // The teardown script really uses the named constant, so the literal this
    // arithmetic reads is the one the loop runs on.
    expect(teardownScript).toContain(
      'while [ "$waited" -lt "$GOOBERS_TEARDOWN_VERIFY_SECONDS" ]; do',
    );
    const deadlineTeardownWorstCase = slotCount * (deadlineGrace + verifyWindow + sweepSlack);
    // The reap's own enforced ceiling has to cover the sweep it performs, or
    // the runner would kill it mid-teardown and the disposition gate would read
    // a failure it could not act on.
    expect(Number(reap?.['timeout-minutes']) * 60).toBeGreaterThanOrEqual(
      slotCount * (reapGrace + verifyWindow + sweepSlack),
    );

    // Every step from the host-profile report onward is cleanup, and every one
    // of them must declare its own ceiling. Enumerated by position rather than
    // by name so a newly added cleanup step cannot escape the budget.
    const reapIndex = steps.indexOf(reap!);
    const profileIndex = steps.findIndex((step) => step.name === 'Report Goobers host profile');
    const cleanupSteps = steps.slice(profileIndex);
    expect(profileIndex).toBeGreaterThan(0);
    expect(reapIndex).toBeGreaterThan(profileIndex);
    let cleanupCeilingSeconds = 0;
    for (const cleanupStep of cleanupSteps) {
      expect(
        cleanupStep['timeout-minutes'],
        `cleanup step "${cleanupStep.name}" has no timeout-minutes, so nothing but the 90-minute job timeout bounds it`,
      ).toEqual(expect.any(Number));
      cleanupCeilingSeconds += Number(cleanupStep['timeout-minutes']) * 60;
    }
    const postStepAllowance = Number(job?.env?.GOOBERS_CLEANUP_POST_STEP_SECONDS);
    expect(Number.isInteger(postStepAllowance)).toBe(true);
    expect(reserveSeconds).toBeGreaterThanOrEqual(
      deadlineTeardownWorstCase + cleanupCeilingSeconds + postStepAllowance,
    );

    // The deadline tears down each slot's WHOLE process tree rather than
    // signalling the `goobers run` pid. Goobers detaches every stage into its
    // own session (Setsid, internal/platform/proc/proc_unix.go) and runs an
    // in-flight attempt on context.WithoutCancel (internal/runner/run.go), so a
    // pid-only signal leaves Copilot and verification children alive while the
    // steps below release provider claims and issue labels.
    expect(script).toContain('scripts/agent/goobers-stage-teardown.sh');
    expect(script).toContain(
      'goobers_teardown_tree "${GOOBERS_LANE_ROOT}/slot-${slot}" 120 "${pid}:${start}"',
    );
    // A root is (pid, start time), never a bare pid: Linux recycles pids, and a
    // slot's deadline lands up to ~55 minutes after its launch, so seeding the
    // sweep from a recycled pid would kill an unrelated process, its children
    // and its whole session. The start time is captured at the launch site, one
    // statement after `$!`, with the same library function the sweep verifies
    // against.
    expect(script).toContain('slot_start="$(goobers_teardown_pid_start "$slot_pid")"');
    const launchIndex = script.indexOf('slot_pid=$!');
    const startIndex = script.indexOf('slot_start="$(goobers_teardown_pid_start "$slot_pid")"');
    const sourceIndex = script.indexOf('teardown_lib="${GITHUB_WORKSPACE}');
    expect(launchIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(launchIndex);
    // ...which means the library has to be sourced before the launch loop.
    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    expect(sourceIndex).toBeLessThan(launchIndex);
    // The slot table carries the start time alongside the pid, and every reader
    // of the table binds it.
    expect(script).toContain('"$slot" "$slot_pid" "$slot_log" "$recovery_slot" "${slot_start:-0}"');
    expect(
      script.match(/read -r slot pid log recovery start/g)?.length,
      'every slot-table reader must bind the start-time column',
    ).toBe(3);
    expect(script).not.toMatch(/read -r slot pid log recovery\s*;/);

    expect(script).toContain('terminate_slots || teardown_failed=1');
    // A teardown that cannot prove the tree is gone fails the step rather than
    // letting cleanup proceed.
    expect(script).toContain('if [ "$teardown_failed" != "0" ]; then');
    expect(script).not.toContain('signal_slots');

    // ...and it must NOT then block on the root it just failed to kill. An
    // unconditional `wait` on a surviving root runs until the job timeout,
    // which is the single path that skips the reap, both uploads and every
    // claim/label mutation. The blocking wait is reachable only for a slot the
    // teardown proved clean, and the refusal is tracked PER SLOT so a healthy
    // sibling keeps its real exit status and is not reported as unreaped.
    expect(script.match(/wait "\$pid"/g), 'exactly one blocking wait may exist').toHaveLength(1);
    expect(script).toContain('unreaped_slots="${unreaped_slots}${slot} "');
    const guardIndex = script.indexOf('case "$unreaped_slots" in');
    const waitIndex = script.indexOf('wait "$pid"');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(guardIndex);
    expect(script).toContain('is NOT blocking on its root pid');

    // The same teardown covers cancellation, where the deadline never fires,
    // and it is the single authoritative gate: "Handle no-work disposition"
    // does not run unless it succeeded, so a surviving stage tree stops the
    // release rather than only warning about it.
    expect(reap?.id).toBe('reap-stage-processes');
    expect(reap?.if).toBe('always()');
    expect(reap?.run).toContain('scripts/agent/goobers-stage-teardown.sh');
    expect(reap?.run).toContain('goobers_teardown_tree "${GOOBERS_LANE_ROOT}/slot-${slot}" 30');
    expect(reap?.run).toContain('is being SKIPPED');
    expect(steps.find((step) => step.name === 'Handle no-work disposition')?.if).toBe(
      "always() && steps.reap-stage-processes.outcome == 'success'",
    );
    // ...and it must precede every claim/label mutation and the journal upload.
    for (const laterStep of [
      'Write slot diagnostics sentinel',
      'Upload run journal',
      'Handle no-work disposition',
      'Comment on Goobers run result',
    ]) {
      const laterIndex = steps.findIndex((step) => step.name === laterStep);
      expect(
        laterIndex,
        `expected "${laterStep}" to run after the stage-tree reap`,
      ).toBeGreaterThan(reapIndex);
    }

    // Every slot's exit status is collected and reported, not just the first.
    expect(script).toContain('exit "$overall"');
    expect(script).toMatch(/Lane \$\{GOOBERS_LANE\} slot \$\{slot\}.*exited \$\{status\}/);
  });

  it('requires a verified terminal journal before any claim or label mutation', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const disposition = steps.find((step) => step.name === 'Handle no-work disposition');
    const script = disposition?.run ?? '';

    // `goobers run abort` is journal repair, and repair can fail (no binary, a
    // corrupt journal). When it does, the journal still reports a live run, so
    // NOTHING about that run may be released: the claim ledger would disagree
    // with the journal, and removing goobers/status:in-review hands a possibly
    // still-running issue to a second agent.
    expect(script).toContain('terminal_verified=false');
    expect(script).toContain('if [ "$terminal_verified" != "true" ]; then');
    expect(script).toContain('has no verified terminal run.finished');
    expect(script).toContain('Refusing to release its provider claim or change');
    // Both failure modes of the repair report closed, not open.
    expect(script).toMatch(/goobers binary is unavailable[\s\S]{0,240}?return 1/);
    expect(script).toMatch(/did not mark the run aborted[\s\S]{0,200}?return 1/);
    // The barrier is evaluated before the claim release and before every label
    // mutation.
    const barrierIndex = script.indexOf('if [ "$terminal_verified" != "true" ]; then');
    expect(script.indexOf('release_claim_marker "$slot_root" "$run_id"')).toBeGreaterThan(
      barrierIndex,
    );
    for (const mutation of script.matchAll(/gh issue edit "\$issue_number"/g)) {
      expect(mutation.index).toBeGreaterThan(barrierIndex);
    }

    // A claim that could not be retired is itself a barrier: an issue whose
    // status label is removed while its claim survives becomes permanently
    // unclaimable, because claimWinner resolves by the earliest surviving
    // breadcrumb.
    expect(script).toContain('if ! release_claim_marker "$slot_root" "$run_id"; then');
    expect(script).toContain('still holds its Goobers provider claim');
    expect(script).toContain('becomes permanently unclaimable');
    expect(script).not.toContain('release_claim_marker "$slot_root" "$run_id" || status=1');

    // The journal the repair produced has to be recoverable by a human: the
    // first upload captures the journal as the run left it (no run.finished at
    // all), so a second, deterministically named artifact captures the repaired
    // state that `goobers run abort` appended during this step.
    const repaired = steps.find((step) => step.name === 'Upload repaired run journal');
    expect(repaired?.if).toBe('always()');
    expect(repaired?.uses).toBe('actions/upload-artifact@v7');
    expect(repaired?.with?.name).toBe(
      "goobers-run-repaired-${{ inputs.workflow || 'crawler-feature-pr' }}-lane-${{ matrix.lane }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(repaired?.with?.name).not.toBe(
      steps.find((step) => step.name === 'Upload run journal')?.with?.name,
    );
    expect(steps.indexOf(repaired!)).toBeGreaterThan(steps.indexOf(disposition!));
    expect(script).toContain('goobers-run-repaired-');
  });

  it('probes label existence with a `gh label` subcommand that actually exists', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const script = steps.find((step) => step.name === 'Handle no-work disposition')?.run ?? '';
    // Comments legitimately name the broken command they replaced, so the
    // assertions below run against the executable lines only.
    const commands = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    // `gh label` exposes clone/create/delete/edit/list and nothing else. `gh
    // label view` therefore always exited non-zero, so the create it guarded
    // always ran and always failed with "already exists; use `--force`" --
    // killing this step under `set -e` before the terminal label landed
    // (issues #3541, #4140).
    expect(commands).not.toContain('gh label view');
    expect(commands).toContain('gh label list --repo "$GITHUB_REPOSITORY" \\');
    expect(commands).toContain('--search "$label" --limit 100 --json name --jq');

    // `--force` would overwrite a repo-managed label's colour and description
    // on every disposition, so idempotency is achieved by not creating an
    // existing label rather than by overwriting it.
    expect(commands).not.toContain('--force');
  });

  it('keeps oversized shell steps free of GitHub expression interpolation', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const oversizedSteps = Object.values(workflow.jobs)
      .flatMap((job) => job?.steps ?? [])
      .filter((step) => (step.run?.length ?? 0) > 21_000);
    const disposition = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Handle no-work disposition',
    );

    expect(oversizedSteps.map((step) => step.name)).toContain('Handle no-work disposition');
    for (const step of oversizedSteps) {
      expect(
        step.run,
        `"${step.name}" exceeds GitHub's 21,000-character expression limit`,
      ).not.toContain('${{');
    }
    expect(disposition?.env?.RUN_JOURNAL_ARTIFACT_ID).toBe(
      '${{ steps.upload-run-journal.outputs.artifact-id }}',
    );
    expect(disposition?.run).toContain("'${RUN_JOURNAL_ARTIFACT_ID}'");
  });

  it('treats an expected empty slot as a successful no-claim outcome', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const script = steps.find((step) => step.name === 'Handle no-work disposition')?.run ?? '';

    // Preflight only proves at least one eligible issue exists; four slots then
    // race for it, so a slot legitimately finding the backlog drained is a
    // normal outcome, not a failure. Goobers reports it as a no-work at the
    // CLAIM stage with no issue id, which is proof that nothing was claimed.
    expect(script).toContain(
      'if [ "$no_work_stage" = "query-backlog" ] && [ -z "$issue_number" ]; then',
    );
    expect(script).toContain('found no unclaimed backlog item');
    expect(script).toContain('there is nothing to release or relabel');

    // ...and the stage name is the workflow's real claim stage, so a rename
    // cannot silently turn empty slots back into lane failures.
    const definition = loadYaml<GoobersDefinition>(
      '.goobers',
      'gaggles',
      'crawler',
      'workflows',
      'crawler-feature-pr.yaml',
    );
    expect(definition.spec.tasks[0]?.name).toBe('query-backlog');
    expect(definition.spec.tasks[0]?.run?.script).toContain('goobers backlog-query --claim');

    // The clean exit has to come before the "invalid no-work" error path that
    // would otherwise fail the lane for a missing issue number.
    const emptyIndex = script.indexOf(
      'if [ "$no_work_stage" = "query-backlog" ] && [ -z "$issue_number" ]; then',
    );
    expect(emptyIndex).toBeGreaterThanOrEqual(0);
    expect(
      script.indexOf("Goobers stage '${no_work_stage}' returned no-work in slot"),
    ).toBeGreaterThan(emptyIndex);

    // The result comment stays silent for a slot that claimed nothing: there is
    // no issue to comment on.
    const commentScript =
      steps.find((step) => step.name === 'Comment on Goobers run result')?.run ?? '';
    expect(commentScript).toContain('skipping issue comment');
    expect(commentScript).toContain('return 0');
  });

  it('terminates a Goobers stage tree by identity, never by process name', () => {
    const teardown = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'agent', 'goobers-stage-teardown.sh'),
      'utf8',
    );

    // Three exact selectors, each traceable to how Goobers actually spawns a
    // stage: the /proc parent chain, the Setsid session a stage leads, and the
    // per-slot GOOBERS_INSTANCE identity that survives the root's death.
    expect(teardown).toContain('goobers_teardown_owns_instance');
    expect(teardown).toContain('GOOBERS_INSTANCE=${root}');
    expect(teardown).toContain('self_session');
    // Start-time guarded signalling, exactly as Goobers' own
    // processIdentity.signal does, so a recycled pid can never be hit.
    expect(teardown).toContain('[ "$current" = "$start" ] || continue');
    // Never a broad pattern kill.
    expect(teardown).not.toMatch(/pkill|killall|kill -9 -1/);
    // The script's own ancestors are excluded, so it cannot signal the runner.
    expect(teardown).toContain('goobers_teardown_ancestors');
    // The snapshot must not be built by handing the /proc glob to awk as argv:
    // a pid that exits between the glob and the open makes awk fatally exit,
    // truncating the snapshot silently. A truncated snapshot can both report a
    // live tree as terminated and drop this script's own entry, which is what
    // keeps the sweep off the runner. `getline` returns -1 instead.
    expect(teardown).toContain('if ((getline line < path) <= 0)');
    expect(teardown).not.toMatch(/awk[\s\S]{0,600}?\/proc\/\[0-9\]\*\/stat/);
    // Fail closed rather than widening: no self entry, no sweep.
    expect(teardown).toContain('could not find its own process');
    expect(teardown).toContain('Refusing to signal anything');
    expect(teardown).toContain('read an empty /proc snapshot');
    // Failing to prove the tree is gone is an actionable error, not a warning.
    expect(teardown).toMatch(/::error::Goobers stage tree for instance .* still has/);
    expect(teardown).toContain('must NOT be released');

    // A root is (pid, start time), never a bare pid. A pid alone cannot be told
    // apart from one Linux recycled onto an unrelated process during the slot's
    // tens-of-minutes run window, and seeding the closure from it would sweep
    // that process, its children and its whole session.
    expect(teardown).toContain('goobers_teardown_valid_root');
    expect(teardown).toContain('^[0-9]+:[0-9]+$');
    expect(teardown).toContain('seed_pid="${seed%%:*}"');
    expect(teardown).toContain('seed_start="${seed#*:}"');
    // The seed is verified against the LIVE start time before it becomes a
    // member — which is also what keeps its session out of the sweep.
    expect(teardown).toContain('if [ "$observed_start" != "$seed_start" ]; then');
    expect(teardown).toContain('was recycled onto an unrelated process');
    // A bare pid is a usage error, not a best-effort sweep.
    expect(teardown).toContain('<pid>:<start-time>');
    expect(teardown).toMatch(/goobers_teardown_valid_root "\$seed"[\s\S]{0,400}?return 2/);
    // One definition of "start time", shared by the launch site and the sweep.
    expect(teardown).toContain('goobers_teardown_pid_start() {');
    expect(
      teardown.match(/if \(\(getline line < path\) <= 0\)|split\(rest, f, " "\)/g)?.length,
      'the start-time field arithmetic must live in exactly one function',
    ).toBe(2);
  });

  it('routes the whole legacy intake cohort through the canonical selector', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    // Resolution and reservation both live in the `reserve` job now: it is the
    // single ordering point every lane waits on via `needs:`.
    const steps = workflow.jobs.reserve?.steps ?? [];
    const recovery =
      steps.find((step) => step.name === 'Resolve Goobers recovery target')?.run ?? '';
    const start =
      steps.find(
        (step) => step.name === 'Reserve the recovery target and comment on Goobers run start',
      )?.run ?? '';

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
    expect(recovery).toContain('if [ "${candidate_cohort}" = "legacy-parity" ]; then');
    expect(recovery).toContain('ISSUE_NUMBER="${candidate_issue}"');
    expect(recovery).toContain('INTAKE_COHORT="${candidate_cohort}"');
    expect(start).not.toContain('index("goobers:approved") != null');
    expect(workflow.jobs.reserve?.env?.LIFECYCLE_MUTATION_OWNER).toBe(
      '${{ vars.LIFECYCLE_MUTATION_OWNER }}',
    );
    expect(workflow.jobs.reserve?.env?.ISSUE_OWNER).toBe('nalfeo');

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

  it('checks out the canonical selector before every job that invokes it', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const selectorPath = '.github/scripts/goobers/intake-selection.mjs';
    const selectorJobs = Object.entries(workflow.jobs).filter(([, job]) =>
      job?.steps?.some((step) => step.run?.includes(selectorPath)),
    );

    expect(selectorJobs.length).toBeGreaterThan(0);
    for (const [jobName, job] of selectorJobs) {
      const steps = job?.steps ?? [];
      const firstInvocation = steps.findIndex((step) => step.run?.includes(selectorPath));
      const checkout = steps
        .slice(0, firstInvocation)
        .find((step) => step.uses?.startsWith('actions/checkout@'));

      expect(
        checkout,
        `${jobName} must check out ${selectorPath} before invoking it`,
      ).toBeDefined();
      const sparseCheckout = checkout?.with?.['sparse-checkout'];
      if (typeof sparseCheckout === 'string') {
        const sparsePaths = sparseCheckout.split(/\s+/).map((entry) => entry.replace(/\/+$/, ''));
        expect(
          sparsePaths.some(
            (sparsePath) =>
              sparsePath === selectorPath || selectorPath.startsWith(`${sparsePath}/`),
          ),
          `${jobName}'s sparse checkout must include ${selectorPath}`,
        ).toBe(true);
      }
    }
  });

  it('skips ineligible issues without claiming, and exempts resumes from fresh-intake gates', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.reserve?.steps ?? [];
    const recovery =
      steps.find((step) => step.name === 'Resolve Goobers recovery target')?.run ?? '';
    const start =
      steps.find(
        (step) => step.name === 'Reserve the recovery target and comment on Goobers run start',
      )?.run ?? '';

    expect(recovery).toContain('is not in the Goobers intake cohort');
    expect(recovery).toContain('should_run=false');
    expect(recovery).toContain('INTAKE_COHORT="resume"');
    // The cohort crosses a JOB boundary to reach a lane, and GITHUB_ENV cannot
    // do that, so it is published as an output rather than exported.
    expect(recovery).toContain('echo "intake_cohort=${INTAKE_COHORT}" >> "${GITHUB_OUTPUT}"');
    expect(recovery).not.toContain('GOOBERS_INTAKE_COHORT=${INTAKE_COHORT}');
    expect(start).toContain('if [ "${RESOLVED_INTAKE_COHORT:-}" != "resume" ]');
    expect(start).toContain('is no longer in the Goobers intake cohort');
    // The revalidated cohort must overwrite the job's published cohort so the
    // downstream claim fence trusts a fresh verdict, not a possibly-stale one
    // from the earlier resolve step.
    expect(start).toContain('revalidated_cohort="$(jq -r \'.cohort // ""\' <<<"$decision")"');
    expect(start).toContain('echo "intake_cohort=${revalidated_cohort}" >> "${GITHUB_OUTPUT}"');
    expect(workflow.jobs.reserve?.outputs?.intake_cohort).toBe(
      '${{ steps.reserve.outputs.intake_cohort || steps.recovery.outputs.intake_cohort }}',
    );
    // ...and it must actually reach the slot that runs Goobers: adopted into
    // the lane's environment, then passed through to every stage. Without the
    // envPassthrough entry the claim fence sees an empty cohort and refuses
    // every recovery claim.
    const runSteps = workflow.jobs.run?.steps ?? [];
    const adoptStep = runSteps.find((step) => step.name === 'Adopt the reserved recovery target');
    expect(adoptStep?.env?.RESERVED_INTAKE_COHORT).toBe(
      '${{ needs.reserve.outputs.intake_cohort }}',
    );
    expect(adoptStep?.run).toContain('GOOBERS_INTAKE_COHORT=${RESERVED_INTAKE_COHORT}');
    const materializeStep = runSteps.find(
      (step) => step.name === 'Materialize checked-in source into each slot instance',
    );
    expect(materializeStep?.run).toContain('- GOOBERS_INTAKE_COHORT');
    expect(
      runSteps.find((step) => step.name === 'Run the workflow')?.env?.GOOBERS_INTAKE_COHORT,
    ).toBe('${{ env.GOOBERS_INTAKE_COHORT }}');
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
    ).jobs.reserve?.steps?.find((step) => step.name === 'Resolve Goobers recovery target');
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
    // The fresh scan runs BOTH cohort queries through the hardened wrapper (a
    // failed search must never read as an empty backlog), hands them to the
    // canonical selector, reserves legacy-parity issues that provider claims
    // cannot see, and records approved work only as `eligible_fresh_issue`.
    expect(recoveryStep?.run).toMatch(
      /list_backlog_candidates 'the maintainer-approved Goobers queue'[\s\S]*search_open_unassigned --label 'goobers:approved' > "\$\{approved_file\}"[\s\S]*list_backlog_candidates 'the Goobers intake parity backlog'[\s\S]*intake-selection\.mjs[\s\S]*find_open_dependency_blockers "\$\{candidate_issue\}"[\s\S]*continue[\s\S]*eligible_fresh_issue="\$\{candidate_issue\}"[\s\S]*done < "\$\{selected_file\}"/,
    );
    expect(recoveryStep?.run).toContain('if [ "${candidate_cohort}" = "legacy-parity" ]; then');
    expect(recoveryStep?.run).toContain('ISSUE_NUMBER="${candidate_issue}"');
    expect(recoveryStep?.run).toContain('INTAKE_COHORT="${candidate_cohort}"');
    expect(recoveryStep?.run).toContain('plain fresh claims require goobers:approved');
    // ...and it must NOT designate an approved fresh issue as this dispatch's
    // target. The recovery branch of query-backlog bypasses the provider claim
    // protocol, so a preflight-picked approved issue would be invisible to it
    // and the four slots would race onto the same issue. They claim atomically
    // instead.
    const freshScan = (recoveryStep?.run ?? '').slice(
      (recoveryStep?.run ?? '').indexOf('eligible_fresh_issue="${candidate_issue}"'),
      (recoveryStep?.run ?? '').indexOf('Eligible fresh backlog work exists'),
    );
    expect(freshScan).not.toBe('');
    expect(freshScan).not.toContain('ISSUE_NUMBER="${candidate_issue}"');
    expect(recoveryStep?.run).toContain('find_open_dependency_blockers "${ISSUE_NUMBER}"');
    expect(recoveryStep?.run).toContain('Skipping before Goobers claim or repository mutation.');
    expect(recoveryStep?.run).toContain('should_run=false');
    // An empty backlog sweep skips the ENTIRE lane job -- no runner is even
    // started for it -- because the gate is on the job, not on each costly
    // setup step. The `run` job never re-resolves the target either: it reads
    // the reserve job's outputs.
    const workflowShape = loadYaml<GoobersActionsWorkflow>(
      '.github',
      'workflows',
      'goobers-run.yml',
    );
    expect(workflowShape.jobs.run?.needs).toBe('reserve');
    expect(workflowShape.jobs.run?.if).toBe("needs.reserve.outputs.should_run != 'false'");
    expect(workflowShape.jobs.reserve?.outputs).toEqual({
      should_run: '${{ steps.recovery.outputs.should_run }}',
      recovery_issue: '${{ steps.recovery.outputs.recovery_issue }}',
      resume_pr: '${{ steps.recovery.outputs.resume_pr }}',
      resume_branch: '${{ steps.recovery.outputs.resume_branch }}',
      // The cohort crosses a JOB boundary, which GITHUB_ENV cannot do, so the
      // reserve job publishes it. The reserve step's revalidated verdict wins
      // over the resolve step's earlier one.
      intake_cohort:
        '${{ steps.reserve.outputs.intake_cohort || steps.recovery.outputs.intake_cohort }}',
    });
    // `Set up Node.js` is deliberately ungated and ahead of target resolution:
    // the eligibility selector itself runs on Node, so gating it on the
    // resolve step's own output would be circular. It is a cached ~2s step,
    // and it lives in `reserve` because that is where the selector now runs.
    const reserveStepNames = (workflowShape.jobs.reserve?.steps ?? []).map((step) => step.name);
    const reserveSetupNode = workflowShape.jobs.reserve?.steps?.find(
      (step) => step.name === 'Set up Node.js',
    );
    expect(reserveSetupNode).toBeDefined();
    expect(reserveSetupNode?.if).toBeUndefined();
    expect(reserveStepNames.indexOf('Set up Node.js')).toBeLessThan(
      reserveStepNames.indexOf('Resolve Goobers recovery target'),
    );
    const goobersRunSteps = workflowShape.jobs.run?.steps;
    expect(
      goobersRunSteps?.find((step) => step.name === 'Resolve Goobers recovery target'),
    ).toBeUndefined();
    for (const step of goobersRunSteps ?? []) {
      expect(step.if ?? '').not.toContain('steps.recovery.outputs.should_run');
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
    // "Run the workflow" legitimately loops now: it launches this lane's two
    // concurrent slots, watches them against GOOBERS_SLOT_DEADLINE_SECONDS,
    // and collects every slot's exit status. It must not reintroduce the
    // `goobers up` daemon shape, which could only ever hold ONE task per lane
    // while its recovery target ran to completion.
    expect(runStep?.run).toContain(
      'exec goobers run --github-progress "$GOOBERS_WORKFLOW" "$slot_root"',
    );
    // Comments are stripped first: prose explaining why the daemon shape was
    // rejected is not an invocation of it.
    expect((runStep?.run ?? '').replace(/^\s*#.*$/gm, '')).not.toContain('goobers up');
    expect(runStep?.run).toMatch(/\bwhile\b/);
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
      'exec goobers run --github-progress "$GOOBERS_WORKFLOW" "$slot_root"',
    );
    expect(upload?.with).toEqual({
      name: "goobers-run-${{ inputs.workflow || 'crawler-feature-pr' }}-lane-${{ matrix.lane }}-${{ github.run_id }}-${{ github.run_attempt }}",
      path: '${{ env.GOOBERS_LANE_ROOT }}/slot-*/diagnostics/\n${{ env.GOOBERS_LANE_ROOT }}/slot-*/gaggles/*/runs/\n',
      'include-hidden-files': true,
      'if-no-files-found': 'error',
      'retention-days': 30,
    });
  });

  it('guarantees the artifact every error message and result comment points at', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const sentinel = steps.find((step) => step.name === 'Write slot diagnostics sentinel');
    const uploads = [
      steps.find((step) => step.name === 'Upload run journal'),
      steps.find((step) => step.name === 'Upload repaired run journal'),
    ];

    // The journal globs match only when a slot actually produced a journal, but
    // the synthetic no-journal disposition and result-comment records exist
    // precisely for the case where none did — and they name that artifact. The
    // sentinel is what closes that gap.
    expect(sentinel?.if).toBe('always()');
    expect(sentinel?.run).toContain('diagnostics_dir="${slot_root}/diagnostics"');
    expect(sentinel?.run).toContain('mkdir -p "$diagnostics_dir"');
    expect(sentinel?.run).toContain('for slot in ${GOOBERS_SLOTS}; do');
    // It identifies which lane/slot/instance the file belongs to, or it is
    // useless in a four-slot artifact.
    for (const field of ['lane=', 'slot=', 'instance=', 'actions-run=', 'run-journals:']) {
      expect(sentinel?.run).toContain(field);
    }

    const sentinelIndex = steps.indexOf(sentinel!);
    for (const upload of uploads) {
      expect(steps.indexOf(upload!)).toBeGreaterThan(sentinelIndex);
      // Both artifacts carry the sentinel, so both always exist...
      expect(upload?.with?.path).toContain('/slot-*/diagnostics/');
      expect(upload?.with?.path).toContain('/slot-*/gaggles/*/runs/');
      // ...which is what makes a missing artifact a FAILURE rather than a
      // warning buried in the log.
      expect(upload?.with?.['if-no-files-found']).toBe('error');
      // GOOBERS_LANE_ROOT is a DOT directory and the least common ancestor of
      // both globs, so it is the traversal root the uploader starts from.
      // @actions/glob refuses to descend into an item whose basename starts
      // with `.` unless hidden files are included — and it applies that test to
      // the search root itself. Without this the globber finds ZERO files and
      // `if-no-files-found: error` fails every single run.
      expect(
        upload?.with?.['include-hidden-files'],
        `"${upload?.name}" uploads from a dot directory, so it must include hidden files`,
      ).toBe(true);
    }
    expect(workflow.jobs.run?.env?.GOOBERS_LANE_ROOT).toContain('/.goobers-lane-');

    // The result comment points at the guaranteed file by name.
    const comment = steps.find((step) => step.name === 'Comment on Goobers run result');
    expect(comment?.run).toContain('slot-${slot}/diagnostics/slot-diagnostics.txt');
  });

  it('names every artifact per attempt so a re-run cannot collide with itself', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const uploads = [
      steps.find((step) => step.name === 'Upload run journal'),
      steps.find((step) => step.name === 'Upload repaired run journal'),
    ];

    // Artifact names are unique per RUN, not per attempt. Re-running a failed
    // run keeps `github.run_id`, so without the attempt the second attempt's
    // upload collides with the first's and fails — losing the journals for the
    // very attempt someone re-ran to diagnose.
    const names = uploads.map((upload) => String(upload?.with?.name ?? ''));
    for (const name of names) {
      expect(name).toContain('${{ github.run_id }}');
      expect(name).toContain('${{ github.run_attempt }}');
      expect(name).toContain('lane-${{ matrix.lane }}');
    }
    // Two attempts of two lanes are four distinct names.
    const rendered = new Set(
      names.flatMap((name) =>
        [1, 2].flatMap((lane) =>
          [1, 2].map((attempt) =>
            name
              .replaceAll('${{ github.run_id }}', '9')
              .replaceAll('${{ github.run_attempt }}', String(attempt))
              .replaceAll('${{ matrix.lane }}', String(lane)),
          ),
        ),
      ),
    );
    expect(rendered.size).toBe(names.length * 4);

    // Every string a human is told to look at names the same run+attempt key.
    const commentStep = steps.find((step) => step.name === 'Comment on Goobers run result');
    expect(commentStep?.env?.ARTIFACT_NAME).toBe(names[0]);
    // ...including the free-text references inside the step scripts, which are
    // not generated from the upload's `name:` and so can silently drift.
    const references = steps
      .flatMap((step) => (step.run ?? '').split('\n'))
      .flatMap(
        (line) => line.match(/goobers-run(?:-repaired)?-\$\{GOOBERS_WORKFLOW\}[^ '"]*/g) ?? [],
      );
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference, `"${reference}" does not name the run attempt`).toContain(
        '${GITHUB_RUN_ATTEMPT}',
      );
    }
    // The result comment marker is attempt-keyed too, so a re-run posts its own
    // comment instead of overwriting attempt 1's pointer to attempt 1's
    // artifact.
    expect(commentStep?.run).toContain(
      `marker="${GOOBERS_RUN_RESULT_MARKER_PREFIX} run-id=\${GITHUB_RUN_ID} attempt=\${GITHUB_RUN_ATTEMPT}`,
    );
  });

  it('dispositions and reports the recovery slot on its OWN journal presence', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const disposition = steps.find((step) => step.name === 'Handle no-work disposition');
    const comment = steps.find((step) => step.name === 'Comment on Goobers run result');

    for (const step of [disposition, comment]) {
      const script = step?.run ?? '';
      // The synthesis is keyed on whether the RECOVERY SLOT produced a journal,
      // never on whether the lane produced one: a healthy sibling slot's
      // journal used to satisfy the check, leaving the reserved issue with no
      // disposition and no terminal comment while the step still exited 0.
      expect(script, `"${step?.name}" still keys the synthesis off the whole lane`).not.toContain(
        'if [ ! -s "$run_records" ]',
      );
      expect(script).toContain('-v slot="${GOOBERS_RECOVERY_SLOT}"');
      expect(script).toContain(
        '\'$1 == slot { found = 1 } END { exit(found ? 0 : 1) }\' "$run_records"',
      );
      expect(script).toContain('"${GOOBERS_LANE_ROOT}/slot-${GOOBERS_RECOVERY_SLOT}"');
      // ...and only for the lane that actually holds the reservation.
      expect(script).toContain(
        '[ "${GOOBERS_LANE}" = "${GOOBERS_RECOVERY_LANE}" ] && [ -n "${GOOBERS_RECOVERY_ISSUE:-}" ]',
      );
    }

    // And the disposition step ASSERTS it happened, because the disposal
    // receipt is written on this step's exit status alone.
    const dispositionScript = disposition?.run ?? '';
    expect(dispositionScript).toContain('recovery_processed=1');
    expect(dispositionScript).toContain('[ "$recovery_processed" != "1" ]');
    expect(dispositionScript).toContain('was never dispositioned');
    const disposal = steps.find((step) => step.name === 'Record reservation disposal');
    expect(disposal?.env?.DISPOSITION_OUTCOME).toBe('${{ steps.handle-disposition.outcome }}');
  });

  it('fails closed when a backlog scan cannot be read', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const resolve = workflow.jobs.reserve?.steps?.find(
      (step) => step.name === 'Resolve Goobers recovery target',
    );
    const script = resolve?.run ?? '';

    // `for candidate in $(gh …)` throws the exit status away, so an auth
    // failure, an API outage or a secondary rate limit produces an empty list
    // that reads as "no recovery work" / "no eligible work". Neither scan may
    // be written that way.
    expect(script).not.toMatch(/for\s+candidate_issue\s+in\s+\$\(/);
    expect(script).toContain('list_backlog_candidates()');
    expect(script).toContain('if ! captured="$("$@" 2> "$err_file")"; then');
    expect(script).toContain('Refusing to continue on an unverified backlog');
    // stderr never reaches the candidate list: gh writes advisory notices there
    // on SUCCESSFUL calls, and a spliced notice would be handed to the PR and
    // blocker lookups as an issue number.
    expect(script).not.toContain('captured="$("$@" 2>&1)"');
    expect(script).toContain('require_candidate_number()');
    expect(script).toContain('require_candidate_number "$candidate_issue" \'the recovery scan\'');
    expect(script).toContain(
      'require_candidate_number "$candidate_issue" \'the fresh eligibility scan\'',
    );
    // Both scans go through it, and both iterate CAPTURED output.
    expect(script).toContain(
      "list_backlog_candidates 'the open goobers/status:in-review recovery backlog'",
    );
    expect(script).toContain("list_backlog_candidates 'the maintainer-approved Goobers queue'");
    expect(script).toContain("list_backlog_candidates 'the Goobers intake parity backlog'");
    expect(script).toContain('done <<<"$recovery_candidates"');
    // The fresh scan iterates the canonical selector's output file rather than
    // a raw captured list, but both queries feeding it are still hardened.
    expect(script).toContain('done < "${selected_file}"');
    // The blocker reads are checked too: an unreadable dependency list must not
    // read as "unblocked".
    expect(script).toMatch(/if ! blocked_by="\$\(find_open_dependency_blockers/);
    expect(script).not.toMatch(/^\s*blocked_by="\$\(\s*$/m);
  });

  it('refuses to re-adopt an issue whose prior lease was never disposed', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const resolve = workflow.jobs.reserve?.steps?.find(
      (step) => step.name === 'Resolve Goobers recovery target',
    );
    const script = resolve?.run ?? '';

    // An Actions run reports `completed` while a Setsid-detached stage
    // descendant keeps pushing, so `goobers/status:in-review` alone cannot mean
    // "this issue is free". The durable lease receipt is what says so.
    expect(script).toContain('scripts/agent/goobers-reservation-lease.sh');
    expect(script).toContain('lease_blocks_selection()');
    expect(script).toContain('goobers_lease_fetch');
    expect(script).toContain('goobers_lease_state');
    // Three distinct outcomes: free, held (skip/fail), unreadable (fail).
    expect(script).toContain('reservation lease is still held by');
    expect(script).toContain('undisposed Goobers reservation lease');
    // The gate runs BEFORE the issue is published as this dispatch's target.
    const gateIndex = script.indexOf('undisposed Goobers reservation lease');
    const outputIndex = script.indexOf('recovery_issue=${ISSUE_NUMBER}');
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBeGreaterThan(gateIndex);
    // The scheduled scan defers with a warning; a directly requested issue is
    // an instruction, so it fails loudly instead of being silently dropped.
    expect(script).toMatch(/::warning::Scheduled recovery skipped issue[\s\S]{0,400}?continue/);
    expect(script).toMatch(/::error::Issue #\$\{ISSUE_NUMBER\} still carries an undisposed/);
  });

  it('forces the executable Goobers suites to actually run in CI', () => {
    const validation = loadYaml<GoobersActionsWorkflow>(
      '.github',
      'workflows',
      'goobers-contract-validation.yml',
    );
    const steps = validation.jobs['validate-contracts']?.steps ?? [];
    const precondition = steps.find(
      (step) => step.name === 'Prove the Linux-only executable suites can run here',
    );
    const tests = steps.find((step) => step.name === 'Run contract unit tests');

    // The executable suites gate themselves on jq, /proc and setsid so a
    // Windows workstation reports a skip rather than a false failure. That gate
    // must never quietly disarm the suite on the runner that is supposed to be
    // enforcing the contract.
    expect(precondition?.run).toContain('command -v jq');
    expect(precondition?.run).toContain('command -v setsid');
    expect(precondition?.run).toContain('[ -r /proc/self/stat ]');
    expect(precondition?.run).toContain('would SKIP instead of running');
    expect(steps.indexOf(precondition!)).toBeLessThan(steps.indexOf(tests!));
    expect(tests?.env?.GOOBERS_REQUIRE_LINUX_SUITES).toBe('1');
    expect(tests?.run).toContain('tests/unit/goobers-run-slot-cleanup.test.ts');
    // A change to either shell library must re-run this validation.
    const triggers = [
      ...(validation.on.push?.paths ?? []),
      ...(validation.on.pull_request?.paths ?? []),
    ];
    expect(triggers).toContain('scripts/agent/goobers-stage-teardown.sh');
    expect(triggers).toContain('scripts/agent/goobers-reservation-lease.sh');
  });

  it('profiles every real Goobers run without profiling no-work sweeps', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const installIndex = steps.findIndex((step) => step.name === 'Install project dependencies');
    const runSteps = steps.filter((step) => /goobers run --github-progress/.test(step.run ?? ''));
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
      uses: './.github/actions/host-profile',
      with: { mode: 'start', label: 'goobers-run-lane-${{ matrix.lane }}' },
    });
    expect(start?.if).toBeUndefined();
    expect(report).toMatchObject({
      if: "always() && steps.host-profile-start.outcome == 'success'",
      uses: './.github/actions/host-profile',
      with: { mode: 'report', label: 'goobers-run-lane-${{ matrix.lane }}' },
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
      (step) => step.name === 'Materialize checked-in source into each slot instance',
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
      (step) => step.name === 'Materialize checked-in source into each slot instance',
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
    const recovery = workflow.jobs.reserve?.steps?.find(
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
    expect(recovery?.run).toContain('recovery_issue=${ISSUE_NUMBER}');
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
    // The reservation resolved once, in the reserve job, reaches exactly one
    // lane through job outputs -- never by re-resolving it per lane.
    const adopt = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Adopt the reserved recovery target',
    );
    expect(adopt?.env).toEqual({
      // The receipt write needs an issues-write token; the reservation values
      // still arrive only as `reserve` job outputs, never re-resolved per lane.
      GH_TOKEN: '${{ github.token }}',
      RESERVED_ISSUE: '${{ needs.reserve.outputs.recovery_issue }}',
      RESERVED_RESUME_PR: '${{ needs.reserve.outputs.resume_pr }}',
      RESERVED_RESUME_BRANCH: '${{ needs.reserve.outputs.resume_branch }}',
      RESERVED_INTAKE_COHORT: '${{ needs.reserve.outputs.intake_cohort }}',
    });
    expect(adopt?.run).toContain('if [ "${GOOBERS_LANE}" != "${GOOBERS_RECOVERY_LANE}" ]');
    expect(adopt?.run).toContain('GOOBERS_RECOVERY_ISSUE=${RESERVED_ISSUE}');
    const run = workflow.jobs.run?.steps?.find((step) => step.name === 'Run the workflow');
    expect(run?.env).toMatchObject({
      GOOBERS_RESUME_PR: '${{ env.GOOBERS_RESUME_PR }}',
      GOOBERS_RESUME_BRANCH: '${{ env.GOOBERS_RESUME_BRANCH }}',
      GOOBERS_RECOVERY_ISSUE: '${{ env.GOOBERS_RECOVERY_ISSUE }}',
    });
    const materialize = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Materialize checked-in source into each slot instance',
    );
    expect(materialize?.run).toContain('path: ${GOOBERS_SOURCE}');
    expect(
      workflow.jobs.run?.steps?.find((step) => step.name === 'Validate .goobers source tree')?.run,
    ).toContain('"$GOOBERS_SOURCE"');
  });

  it('reserves the recovery target in a preflight job both lanes wait on', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const reserve = workflow.jobs.reserve;
    const reserveStep = reserve?.steps?.find(
      (step) => step.name === 'Reserve the recovery target and comment on Goobers run start',
    );
    const runSteps = workflow.jobs.run?.steps ?? [];

    // The `needs:` edge is the whole ordering guarantee. Two matrix legs start
    // simultaneously, so a per-lane reservation step can never order itself
    // ahead of the sibling lane's fresh `backlog-query --claim`.
    expect(workflow.jobs.run?.needs).toBe('reserve');
    expect(reserve?.steps?.map((step) => step.name)).toEqual([
      'Fetch reservation tooling',
      'Detect a live sibling dispatch',
      // Node is installed before resolution because the canonical eligibility
      // selector runs on it.
      'Set up Node.js',
      'Resolve Goobers recovery target',
      'Reserve the recovery target and comment on Goobers run start',
    ]);

    // Exactly one writer of the reservation label in the entire workflow, and
    // it is not in a lane.
    const laneAddsReservation = runSteps.filter((step) =>
      (step.run ?? '').includes("--add-label 'goobers/status:in-review'"),
    );
    expect(laneAddsReservation).toHaveLength(0);
    expect(reserveStep?.run).toMatch(
      /gh issue edit "\$issue_number" --repo "\$GITHUB_REPOSITORY" \\\n\s*--add-label 'goobers\/status:in-review'/,
    );

    // `needs:` orders the jobs; this loop closes the read-after-write gap by
    // replaying the exact provider query a fresh claim performs (REST issues
    // list filtered by the trust label, exclusions applied to the returned
    // label array) rather than the eventually consistent search index.
    expect(reserveStep?.run).toContain('reservation_visible()');
    expect(reserveStep?.run).toContain("-f state=open -f labels='goobers:approved'");
    expect(reserveStep?.run).toContain("grep -qxF 'goobers/status:in-review'");
    expect(reserveStep?.run).toContain('confirmed it through the backlog read path');
    // Fails closed: an unconfirmed reservation must stop the dispatch, not
    // start four slots and hope.
    expect(reserveStep?.run).toMatch(/::error::Reserved issue #\$\{issue_number\}/);
    expect(reserveStep?.run).toContain('Refusing to start any slot');

    // Both declarations of the owning lane/slot must agree, or the reserve
    // job's messages would name a slot that never adopts the reservation.
    expect(reserve?.env?.GOOBERS_RECOVERY_LANE).toBe(workflow.jobs.run?.env?.GOOBERS_RECOVERY_LANE);
    expect(reserve?.env?.GOOBERS_RECOVERY_SLOT).toBe(workflow.jobs.run?.env?.GOOBERS_RECOVERY_SLOT);
    expect(workflow.jobs['release-unstarted-reservation']?.env?.GOOBERS_RECOVERY_LANE).toBe(
      workflow.jobs.run?.env?.GOOBERS_RECOVERY_LANE,
    );
    expect(workflow.jobs['release-unstarted-reservation']?.env?.GOOBERS_RECOVERY_SLOT).toBe(
      workflow.jobs.run?.env?.GOOBERS_RECOVERY_SLOT,
    );
  });

  it('lets only one live dispatch at a time own a recovery reservation', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const reserve = workflow.jobs.reserve;
    const detect = reserve?.steps?.find((step) => step.name === 'Detect a live sibling dispatch');
    const resolve = reserve?.steps?.find((step) => step.name === 'Resolve Goobers recovery target');
    const detectScript = detect?.run ?? '';
    const resolveScript = resolve?.run ?? '';

    // The `goobers-run-reserve` group only holds for this job, but its lanes
    // run for up to 90 more minutes, so the group alone cannot stop a second
    // dispatch from designating a recovery target for an issue this dispatch's
    // recovery slot is still resuming. That designation bypasses the provider
    // claim protocol, so nothing else would settle it.
    expect(detect?.id).toBe('singleflight');
    expect(detectScript).toContain('actions/workflows/goobers-run.yml/runs');
    expect(detectScript).toContain('select(.status != "completed")');
    expect(detectScript).toContain('(.id | tostring) != env.GITHUB_RUN_ID');
    // Listing runs needs actions:read, and the check is only meaningful if the
    // permission is actually granted.
    expect(workflow.permissions?.actions).toBe('read');
    expect(detect?.env?.GH_TOKEN).toBe('${{ github.token }}');

    // Fails closed on the safe side: an unreadable run list means "assume a
    // sibling is live" (no recovery designation), never "assume we are alone".
    expect(detectScript).toMatch(/recovery_allowed=false[\s\S]*recovery_allowed=false/);
    expect(detectScript.match(/recovery_allowed=true/g)).toHaveLength(1);

    // The decision is consumed everywhere a target could be designated: the
    // in-review recovery sweep, an issue-labeled event's issue, and an explicit
    // manual issue_number (which fails loudly rather than being downgraded).
    expect(resolve?.env?.RECOVERY_ALLOWED).toBe(
      '${{ steps.singleflight.outputs.recovery_allowed }}',
    );
    expect(resolveScript).toContain(
      'if [ -z "${ISSUE_NUMBER}" ] && [ "${RECOVERY_ALLOWED}" = "true" ]; then',
    );
    expect(resolveScript).toContain('if [ "${RECOVERY_ALLOWED}" != "true" ]; then');
    expect(resolveScript).toContain('::error::Refusing to resume issue #${EXPLICIT_ISSUE_NUMBER}');
    expect(resolve?.env?.EXPLICIT_ISSUE_NUMBER).toBe('${{ inputs.issue_number }}');

    // Deferring recovery must NOT serialize the two lanes of this dispatch:
    // the per-lane groups stay per-lane, and they are static (no run id), which
    // is what keeps lane <n> of a second dispatch queued behind lane <n> of
    // this one and holds the four-slot ceiling globally.
    expect(workflow.jobs.run?.concurrency?.group).toBe('goobers-run-lane-${{ matrix.lane }}');
    expect(workflow.jobs.run?.concurrency?.group).not.toContain('run_id');
    expect(workflow.jobs.run?.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('binds the reservation to an owner and holds that evidence through cleanup', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const adopt = steps.find((step) => step.name === 'Adopt the reserved recovery target');
    const dispose = steps.find((step) => step.name === 'Record reservation disposal');
    const guard = workflow.jobs['release-unstarted-reservation']?.steps?.find(
      (step) => step.name === 'Release the reservation when no lane ever owned it',
    );
    const adoptScript = adopt?.run ?? '';
    const disposeScript = dispose?.run ?? '';
    const guardScript = guard?.run ?? '';

    // The receipt is written BEFORE the lane exports any recovery metadata, so
    // a lane that could not write it never starts a recovery slot — which is
    // what makes "no receipt" deterministic proof of "never adopted".
    const receiptIndex = adoptScript.indexOf('gh issue comment "$RESERVED_ISSUE"');
    const exportIndex = adoptScript.indexOf('GOOBERS_RECOVERY_ISSUE=${RESERVED_ISSUE}');
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThan(receiptIndex);
    // The marker grammar lives in one checked-in library, never inline, so a
    // writer and a reader cannot drift apart. It is scoped to run id AND
    // attempt: a re-run keeps the same run id, and its adoption must be a NEW
    // lease rather than something the previous attempt's disposal closed.
    expect(adoptScript).toContain(
      'adopted_marker="$(goobers_lease_marker adopted "${GITHUB_RUN_ID}" "${GITHUB_RUN_ATTEMPT}" "${RESERVED_ISSUE}")"',
    );
    expect(adoptScript).toContain('scripts/agent/goobers-reservation-lease.sh');
    // Cross-dispatch re-adoption guard: an undisposed lease from ANY other
    // run/attempt stops this lane before it exports recovery metadata.
    expect(adoptScript).toContain('if [ "$lease_state" = "adopted" ] &&');
    expect(adoptScript).toContain('Refusing to adopt reserved issue');
    const guardIndex = adoptScript.indexOf('Refusing to adopt reserved issue');
    expect(guardIndex).toBeLessThan(exportIndex);

    // Disposal is recorded only on proof of BOTH a clean reap and a clean
    // disposition; anything else leaves the receipt adopted-but-undisposed.
    expect(dispose?.if).toBe("always() && env.GOOBERS_RECOVERY_ISSUE != ''");
    expect(dispose?.env?.REAP_OUTCOME).toBe('${{ steps.reap-stage-processes.outcome }}');
    expect(dispose?.env?.DISPOSITION_OUTCOME).toBe('${{ steps.handle-disposition.outcome }}');
    expect(steps.find((step) => step.name === 'Handle no-work disposition')?.id).toBe(
      'handle-disposition',
    );
    expect(disposeScript).toContain(
      'if [ "${REAP_OUTCOME}" != "success" ] || [ "${DISPOSITION_OUTCOME}" != "success" ]; then',
    );
    expect(disposeScript).toContain('Leaving the adoption receipt undisposed');
    expect(disposeScript).toContain(
      'disposed_marker="$(goobers_lease_marker disposed "${GITHUB_RUN_ID}" "${GITHUB_RUN_ATTEMPT}" "${issue_number}")"',
    );
    // It must run after the reap and the disposition it reports on.
    const disposeIndex = steps.indexOf(dispose!);
    for (const earlier of [
      'Reap surviving Goobers stage processes',
      'Handle no-work disposition',
    ]) {
      expect(steps.findIndex((step) => step.name === earlier)).toBeLessThan(disposeIndex);
    }

    // The guard reads the receipt instead of trusting the AGGREGATE matrix
    // result, which cannot distinguish "never adopted" from "adopted, reap
    // failed, descendant may be live" or from "healthy recovery lane, failed
    // sibling lane".
    const readIndex = guardScript.indexOf('goobers_lease_state');
    const releaseIndex = guardScript.indexOf("--remove-label 'goobers/status:in-review'");
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(readIndex);
    expect(guardScript).toContain('WAS adopted by lane');
    expect(guardScript).toContain('a DIFFERENT dispatch');
    expect(guardScript).toContain('Refusing to remove goobers/status:in-review');
    expect(guardScript).toContain('never took ownership of the reservation');
    // No substring matching anywhere in the lease path: a public comment that
    // merely CONTAINS the marker must not move the lease.
    for (const script of [adoptScript, disposeScript, guardScript]) {
      expect(script).not.toContain('contains($marker)');
    }
    // Both jobs that read the lease must actually have the library on disk.
    // The asymmetry is deliberate. `release-unstarted-reservation` only ever
    // needs the lease script, so its cone is pinned exactly -- widening it
    // should be a conscious edit here. `reserve` additionally invokes the
    // intake selector, so its cone legitimately carries more entries and is
    // only checked for the lease path; the sparse-checkout coverage test above
    // is what proves the rest of that cone is complete.
    expect(
      readSparseCheckoutPaths(workflow.jobs['release-unstarted-reservation']?.steps?.[0]),
    ).toStrictEqual(['scripts/agent']);
    expect(readSparseCheckoutPaths(workflow.jobs.reserve?.steps?.[0])).toContain('scripts/agent');
  });

  it('trusts only the GitHub Actions identity and only whole-line receipts', () => {
    const lease = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'agent', 'goobers-reservation-lease.sh'),
      'utf8',
    );

    // Issue comments are public and this marker text is predictable, so author
    // trust is the only thing that makes a receipt evidence rather than a
    // suggestion. `[` and `]` are not legal in a GitHub username, so the bot
    // login cannot be held by a human account.
    expect(lease).toContain('GOOBERS_LEASE_TRUSTED_LOGIN:-github-actions[bot]');
    expect(lease).toContain('GOOBERS_LEASE_TRUSTED_APP_SLUG:-github-actions');
    expect(lease).toContain('((.user.type // "") == "Bot")');
    // The app association is preferred when the API supplies one, with the
    // exact bot login as the fallback when it does not.
    expect(lease).toContain('if (.performed_via_github_app // null) == null');
    expect(lease).toContain('((.performed_via_github_app.slug // "") == $slug)');

    // Whole-line, anchored parsing. A substring match would accept a quoted
    // marker inside prose or a code fence.
    expect(lease).toContain(
      '^<!-- crawler-goobers-reservation-(adopted|disposed):v1 run-id=[0-9]+ attempt=[0-9]+ issue=[0-9]+ -->$',
    );
    expect(lease).toContain('(?<kind>adopted|disposed)');
    expect(lease).toContain('(?<attempt>[0-9]+)');

    // A disposal closes only the lease that names the SAME run/attempt, so a
    // stale disposal cannot satisfy a later adoption.
    expect(lease).toContain('.run == $adoption.run');
    expect(lease).toContain('.attempt == $adoption.attempt');
    expect(lease).toContain('($adoptions | last) as $latest');

    // ...and only when it lives in the ADOPTION'S OWN COMMENT. Trusted
    // authorship is not enough on its own: this workflow posts other
    // Actions-authored comments that embed free-form Goobers journal text
    // written by the agent under test, so a disposal accepted from any trusted
    // comment could be injected through a journal message.
    expect(lease).toContain('$comment.receipts');
    expect(lease).toContain('disposed: (');
    // The old cross-comment disposal set must be gone, not merely narrowed.
    expect(lease).not.toContain('as $disposed');
    expect(lease).not.toContain('$disposed | index');

    // Fail closed: unreadable, empty and unparsable payloads all refuse rather
    // than reading as "this issue is free".
    expect(lease).toContain('Refusing to treat the issue as free');
    expect(lease).toContain('if [ ! -s "$out" ]; then');
  });

  it('renders journal text so it can never own a lease-marker line', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const comment = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Comment on Goobers run result',
    );
    const script = comment?.run ?? '';

    // The source half of the same hazard. `jq -r` emits embedded newlines
    // verbatim, so a Goobers stage error message containing a newline plus a
    // well-formed marker would render as a standalone marker line inside an
    // Actions-authored comment. Collapsing CR/LF means every rendered line
    // starts with the event type token, which the anchored marker grammar can
    // never match.
    expect(script).toContain('gsub("[\\r\\n]+"; " ")');
    const summaryStart = script.indexOf('terminal_summary="$(');
    const collapseIndex = script.indexOf('gsub("[\\r\\n]+"; " ")');
    expect(summaryStart).toBeGreaterThanOrEqual(0);
    expect(collapseIndex).toBeGreaterThan(summaryStart);
    // The event type is pinned to three literals, so the leading token of every
    // rendered line is workflow-controlled rather than journal-controlled.
    expect(script).toContain(
      'select(.type == "stage.finished" or .type == "error" or .type == "run.finished")',
    );
  });

  it('resolves the receipt comment through the reader both guards use', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const adopt = steps.find((step) => step.name === 'Adopt the reserved recovery target');
    const dispose = steps.find((step) => step.name === 'Record reservation disposal');
    const lease = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'agent', 'goobers-reservation-lease.sh'),
      'utf8',
    );

    // Writer and reader must agree on WHICH comment holds the lease, or a
    // disposal can be appended to a comment no guard will read — or to another
    // Actions-authored comment whose journal text merely carried the marker.
    // Both writers resolve it through `goobers_lease_state`, the same function
    // the guards use, so they agree by construction.
    expect(adopt?.run).toContain('receipt_id="$lease_comment"');
    expect(dispose?.run).toContain('goobers_lease_state "$comments" "${issue_number}"');
    expect(dispose?.run).toContain('read -r lease_state lease_run lease_attempt receipt_id');
    expect(dispose?.run).toContain('issues/comments/${receipt_id}');
    // A standalone marker search over every trusted comment is exactly the
    // thing that could resolve to the wrong comment, so it no longer exists.
    expect(lease).not.toContain('goobers_lease_receipt_id');
    for (const step of [adopt, dispose]) {
      expect(step?.run).not.toContain('goobers_lease_receipt_id');
    }
    // The disposal is only ever appended to THIS dispatch's own live lease.
    expect(dispose?.run).toContain('[ "$lease_state" != "adopted" ]');
    expect(dispose?.run).toContain('[ "$lease_run" != "${GITHUB_RUN_ID}" ]');
    expect(dispose?.run).toContain('[ "$lease_attempt" != "${GITHUB_RUN_ATTEMPT}" ]');
  });

  it('releases a reservation no lane ever started', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const guard = workflow.jobs['release-unstarted-reservation'];
    const script =
      guard?.steps?.find(
        (step) => step.name === 'Release the reservation when no lane ever owned it',
      )?.run ?? '';

    // Splitting the reservation into its own job opened two new ways to strand
    // the label: `reserve` succeeds and the workflow is cancelled while `run`
    // is queued, or the recovery lane fails BEFORE its "Adopt the reserved
    // recovery target" step, so its always()-gated disposition never learns the
    // issue number. Every non-success `run` result must therefore reach the
    // guard; only a successful lane owns its own disposition.
    expect(guard?.needs).toEqual(['reserve', 'run']);
    expect(guard?.if).toContain('always()');
    expect(guard?.if).toContain("needs.reserve.outputs.recovery_issue != ''");
    expect(guard?.if).toContain("needs.run.result == 'skipped'");
    expect(guard?.if).toContain("needs.run.result == 'cancelled'");
    expect(guard?.if).toContain("needs.run.result == 'failure'");
    expect(guard?.if).not.toContain("needs.run.result == 'success'");

    // It applies the same rule the lane's disposition would have applied for a
    // journal-less recovery slot: preserve while an open Goobers PR holds
    // resumable work, release otherwise. It never releases on an unreadable
    // timeline or PR.
    expect(script).toContain('issues/${issue_number}/timeline');
    expect(script).toContain('[[ "$branch" == goobers/crawler/* ]]');
    expect(script).toContain('preserving goobers/status:in-review');
    expect(script).toContain("--remove-label 'goobers/status:in-review'");
    expect(script).toContain('gh workflow run goobers-run.yml -f issue_number=${issue_number}');
  });

  it('gives exactly one slot the recovery target and never lets preflight claim fresh work', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const job = workflow.jobs.run;
    const recovery = workflow.jobs.reserve?.steps?.find(
      (step) => step.name === 'Resolve Goobers recovery target',
    );
    const start = workflow.jobs.reserve?.steps?.find(
      (step) => step.name === 'Reserve the recovery target and comment on Goobers run start',
    );
    const adopt = job?.steps?.find((step) => step.name === 'Adopt the reserved recovery target');
    const runStep = job?.steps?.find((step) => step.name === 'Run the workflow');
    const script = recovery?.run ?? '';

    // A single, named recovery slot for the whole dispatch.
    expect(job?.env?.GOOBERS_RECOVERY_LANE).toBe('1');
    expect(job?.env?.GOOBERS_RECOVERY_SLOT).toBe('1');

    // Resolution happens once, in a job with no matrix at all, so there is no
    // "other leg" that could resolve the same issue and race. The lane gate
    // that used to live in the resolution script is gone with it.
    expect(script).not.toContain('GOOBERS_LANE');
    expect(script).toContain('recovery_issue=${ISSUE_NUMBER}');
    const exportIndex = script.indexOf('recovery_issue=${ISSUE_NUMBER}');
    const abandonIndex = script.indexOf('gh pr close "${pr_number}"');
    expect(exportIndex).toBeGreaterThanOrEqual(0);
    expect(abandonIndex).toBeGreaterThan(exportIndex);

    // Adoption is where a lane takes ownership, and only the recovery lane may.
    const adoptScript = adopt?.run ?? '';
    expect(adoptScript).toContain('if [ "${GOOBERS_LANE}" != "${GOOBERS_RECOVERY_LANE}" ]');
    const adoptGateIndex = adoptScript.indexOf(
      'if [ "${GOOBERS_LANE}" != "${GOOBERS_RECOVERY_LANE}" ]',
    );
    const adoptExportIndex = adoptScript.indexOf('GOOBERS_RECOVERY_ISSUE=${RESERVED_ISSUE}');
    expect(adoptGateIndex).toBeGreaterThanOrEqual(0);
    expect(adoptExportIndex).toBeGreaterThan(adoptGateIndex);

    // The scheduled fresh-backlog scan may only answer "is there approved
    // work?" for provider-claimable issues; legacy-parity issues must be
    // promoted into the single reserved target because plain fresh claims can
    // only see goobers:approved.
    expect(script).toContain('eligible_fresh_issue=""');
    expect(script).toContain('if [ "${candidate_cohort}" = "legacy-parity" ]; then');
    expect(script).toContain('ISSUE_NUMBER="${candidate_issue}"');
    expect(script).toContain('INTAKE_COHORT="${candidate_cohort}"');
    expect(script).toContain('eligible_fresh_issue="${candidate_issue}"');
    expect(script).not.toContain(
      'ISSUE_NUMBER="${candidate_issue}"\n              echo "Selected fresh approved issue',
    );
    expect(script).toContain('no recovery target, so all four slots claim atomically.');
    // The cheap no-work exit is preserved. Its wording now names the intake
    // cohort rather than `goobers:approved`, because eligibility is decided by
    // the canonical selector across the approved + legacy-parity cohorts.
    expect(script).toContain('No unblocked issue in the Goobers intake cohort; skipping this run.');
    expect(script).toContain('should_run=false');

    // Whatever recovery target does exist is reserved with
    // goobers/status:in-review by a job BOTH lanes wait on, and the fresh
    // claim scan excludes that label, so the recovery slot and the fresh slots
    // can never select the same issue.
    const startScript = start?.run ?? '';
    expect(startScript).toMatch(
      /gh issue edit "\$issue_number" --repo "\$GITHUB_REPOSITORY" \\\n\s*--add-label 'goobers\/status:in-review'/,
    );
    expect(startScript).toContain('[ "${RESOLVED_INTAKE_COHORT:-}" = "legacy-parity" ]');
    expect(startScript).toContain('gh issue view "${issue_number}" --repo "${GITHUB_REPOSITORY}"');
    expect(startScript).toContain('--json state,labels,assignees');
    expect(startScript).toContain('[ "$state" != "OPEN" ] || [ "$unassigned" != "true" ]');
    expect(job?.needs).toBe('reserve');
    const definition = loadYaml<GoobersDefinition>(
      '.goobers',
      'gaggles',
      'crawler',
      'workflows',
      'crawler-feature-pr.yaml',
    );
    const queryBacklog = definition.spec.tasks.find((task) => task.name === 'query-backlog');
    // Plural: `goobers backlog-query` reads excludeLabels, so the singular
    // spelling silently excluded nothing.
    expect(queryBacklog?.inputs?.excludeLabels).toBe(
      'goobers/status:in-review,goobers/status:completed-existing-work',
    );
    expect(queryBacklog?.inputs?.excludeLabel).toBeUndefined();

    // Only the recovery slot keeps recovery/resume metadata; the other three
    // unset it so their query-backlog stage takes the atomic claim path.
    const runScript = runStep?.run ?? '';
    expect(runScript).toContain('[ "${GOOBERS_LANE}" = "${GOOBERS_RECOVERY_LANE}" ] &&');
    expect(runScript).toContain('[ "${slot}" = "${GOOBERS_RECOVERY_SLOT}" ] &&');
    expect(runScript).toContain(
      'unset GOOBERS_RECOVERY_ISSUE GOOBERS_RESUME_PR GOOBERS_RESUME_BRANCH',
    );

    // A dispatch with no recovery target must reserve nothing at all rather
    // than posting a start comment about an issue no slot owns.
    expect(start?.if).toContain("steps.recovery.outputs.recovery_issue != ''");
  });

  it('filters external PR cross-references and fails closed when every candidate is unreadable', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const runSteps = workflow.jobs.run?.steps ?? [];
    const scripts = [
      workflow.jobs.reserve?.steps?.find((step) => step.name === 'Resolve Goobers recovery target')
        ?.run ?? '',
      runSteps.find((step) => step.name === 'Handle no-work disposition')?.run ?? '',
      runSteps.find((step) => step.name === 'Comment on Goobers run result')?.run ?? '',
    ].join('\n');

    expect(scripts.match(/\.source\.issue\.repository_url == \$repo_url/g)).toHaveLength(3);
    expect(scripts.match(/if ! details="\$\(gh pr view /g)).toHaveLength(3);
    expect(scripts.match(/unreadable_candidate=true/g)).toHaveLength(3);
    // One `return 2` per find_open_goobers_pr: the "at least one candidate was
    // unreadable" exit that the caller re-raises. Counted against that helper
    // specifically so the lease gate's own refusal code cannot inflate it.
    expect(
      scripts.match(
        /At least one same-repository PR for issue #\$\{issue_number\} was unreadable[\s\S]{0,240}?return 2/g,
      ),
    ).toHaveLength(3);
    expect(scripts).toContain('candidate_pr="$(find_open_goobers_pr "$candidate_issue")"');
    expect(scripts).toContain('pr_number="$(find_open_goobers_pr "$ISSUE_NUMBER")"');
    expect(scripts).toContain('open_pr="$(find_open_goobers_pr "$issue_number")"');
    expect(scripts).toContain('pr_number="$(find_open_goobers_pr "$issue_number")"');
    expect(scripts).toContain('if [ "$lookup_status" -ne 0 ]');

    // The reservation guard reads the same cross-references but fails closed on
    // the FIRST unreadable candidate: it exists to release a label, so an
    // ambiguous read must preserve ownership rather than continue scanning.
    const guard =
      workflow.jobs['release-unstarted-reservation']?.steps?.find(
        (step) => step.name === 'Release the reservation when no lane ever owned it',
      )?.run ?? '';
    expect(guard).toContain('.source.issue.repository_url == $repo_url');
    expect(guard).toContain('cannot be released safely');
  });

  it('posts separate durable start and result comments with explicit run and PR links', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const reserveSteps = workflow.jobs.reserve?.steps ?? [];
    const steps = workflow.jobs.run?.steps ?? [];
    // Both live in the reserve job now: it resolves the target and posts the
    // durable start comment before any lane exists.
    const recovery = reserveSteps.find((step) => step.name === 'Resolve Goobers recovery target');
    const start = reserveSteps.find(
      (step) => step.name === 'Reserve the recovery target and comment on Goobers run start',
    );
    const run = steps.find((step) => step.name === 'Run the workflow');
    const result = steps.find((step) => step.name === 'Comment on Goobers run result');

    expect(recovery?.id).toBe('recovery');
    expect(start).toBeDefined();
    expect(result).toBeDefined();
    // The start comment is posted in the reserve job, which every lane needs,
    // so it always precedes any slot launching.
    expect(workflow.jobs.run?.needs).toBe('reserve');
    expect(steps.indexOf(result!)).toBeGreaterThan(steps.indexOf(run!));

    expect(start?.if).toContain("steps.recovery.outputs.should_run != 'false'");
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

    // Main gates this step on `steps.recovery.outputs.should_run`. Here the
    // whole `run` JOB is gated on the reserve job's should_run, so no lane —
    // and therefore no result comment — is ever started for an empty backlog.
    // The step itself stays `always()` so a failed lane still reports.
    expect(result?.if).toBe('always()');
    expect(workflow.jobs.run?.if).toBe("needs.reserve.outputs.should_run != 'false'");
    expect(result?.env).toMatchObject({
      GH_TOKEN: '${{ github.token }}',
      JOB_STATUS: '${{ job.status }}',
      ARTIFACT_NAME:
        "goobers-run-${{ inputs.workflow || 'crawler-feature-pr' }}-lane-${{ matrix.lane }}-${{ github.run_id }}-${{ github.run_attempt }}",
    });
    expect(result?.run).toContain('.outputs.prNumber // empty');
    expect(result?.run).toContain('.outputs["pull-request-url"] // empty');
    expect(result?.run).toContain('.externalRef.kind == "pr"');
    expect(result?.run).toContain('pr_number="${resume_pr}"');
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

    // The recovery issue is adopted before any journal is read, and a
    // journal-less recovery slot still gets a synthetic record so its issue
    // receives a terminal comment instead of silence.
    const issueResolutionIndex = script.indexOf('issue_number="${GOOBERS_RECOVERY_ISSUE}"');
    const journalLookupIndex = script.indexOf('if [ -n "$events_file" ]; then');
    expect(issueResolutionIndex).toBeGreaterThanOrEqual(0);
    expect(journalLookupIndex).toBeGreaterThanOrEqual(0);
    expect(issueResolutionIndex).toBeLessThan(journalLookupIndex);
    expect(script).toContain('events_input="/dev/null"');
    // Keyed on the RECOVERY SLOT's own journal, not the lane's: a sibling
    // slot's journal must not stand in for it (see "dispositions and reports
    // the recovery slot on its OWN journal presence").
    expect(script).toContain('-v slot="${GOOBERS_RECOVERY_SLOT}"');
    expect(script).toContain('[ -n "${GOOBERS_RECOVERY_ISSUE:-}" ]');
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
    const releaseIndex = script
      .slice(openPrCheckIndex)
      .search(
        /if ! gh issue edit "\$issue_number" --repo "\$GITHUB_REPOSITORY" \\\n\s*--remove-label 'goobers\/status:in-review'; then/,
      );

    expect(disposition?.env?.JOB_STATUS).toBe('${{ job.status }}');
    // Per-run outcome, derived from that run's own run.finished phase, with
    // the lane-wide job status only as the fallback when a run never reached a
    // terminal state. One slot failing must not restate a sibling slot's
    // healthy issue as failed.
    expect(script).toContain('[ "$run_outcome" = "failure" ]');
    expect(script).toContain('[ "$run_outcome" = "cancelled" ]');
    expect(script).toContain('[ "$JOB_STATUS" = "cancelled" ]');
    expect(script).toContain('select(.type == "run.finished") | .status // empty');
    expect(script).toContain('issues/${issue_number}/timeline');
    expect(script).toContain('[[ "$branch" == goobers/crawler/* ]]');
    expect(script).toContain('open Goobers PR #${open_pr} preserves resumable work');
    expect(script).toContain('resume_pr="${GOOBERS_RESUME_PR:-}"');
    expect(script).toContain('if [ -n "$resume_pr" ]');
    expect(script).toContain('open_pr="$(find_open_goobers_pr "$issue_number")"');
    expect(script).toContain('resume PR #${resume_pr} is no longer open');
    expect(script).toContain('stale_resume=true');
    expect(script).toContain('no replacement PR or no-work disposition was recorded');
    expect(openPrCheckIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(0);
    expect(script).toContain('without an open Goobers PR. Restored retry eligibility');
    expect(script).toContain('gh workflow run goobers-run.yml -f issue_number=${issue_number}');
  });

  // Production incident: Goobers runs 33925493716 (issue #4252) and
  // 33926202682 (issue #4253) failed in "Resolve Goobers recovery target", and
  // the failure handler then reported that the claimed issue number could not
  // be recovered — even though both runs were `issues` events that named their
  // target — because the recovery issue was only recorded after every fallible
  // lookup had already had its chance to fail.
  //
  // Main fixed that with a `persist_recovery_issue` GITHUB_ENV helper. This
  // branch cannot use GITHUB_ENV for it, because resolution (`reserve`) and
  // execution (`run`) are now separate jobs and env does not cross a job
  // boundary. The SAME invariant is enforced structurally instead, and that is
  // what this test pins: the recovery issue is published as a job OUTPUT before
  // any fallible lookup, and `release-unstarted-reservation` reads that output
  // on `always()`, so a mid-flight death anywhere after it stays attributable.
  it('records the recovery issue before any fallible lookup can fail', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const recovery =
      workflow.jobs.reserve?.steps?.find((step) => step.name === 'Resolve Goobers recovery target')
        ?.run ?? '';

    const persistIndex = recovery.indexOf(
      'echo "recovery_issue=${ISSUE_NUMBER}" >> "${GITHUB_OUTPUT}"',
    );
    expect(persistIndex).toBeGreaterThan(0);
    // The fallible lookup that sits between resolution and reservation. Anchored
    // on the assignment, because the same helper is also called earlier in the
    // issues-event branch.
    const postPublishLookup = recovery.indexOf(
      'pr_number="$(find_open_goobers_pr "$ISSUE_NUMBER")"',
    );
    expect(postPublishLookup).toBeGreaterThan(0);
    expect(persistIndex).toBeLessThan(postPublishLookup);

    // A GITHUB_ENV write would be silently inert here (it cannot reach a
    // lane), so it must not come back as cargo-culted dead code. Matched on
    // the redirect, not the bare word: the step's own comment explains why it
    // is absent.
    expect(recovery).not.toMatch(/>>\s*"?\$\{?GITHUB_ENV\}?"?/);

    // The stronger structural guarantee, and the reason ordering against the
    // EARLIER lookups does not matter here the way it does upstream: this step
    // never mutates a label at all, so nothing it does can strand a claim. The
    // reservation is written by the next step, which cannot run unless
    // `recovery_issue` was already published. Checked on EXECUTED lines only —
    // `gh issue edit` also appears inside this step's remediation messages.
    const executedIssueEdits = recovery
      .split('\n')
      .filter((line) => /^\s*(if !\s+)?gh issue edit\b/.test(line));
    expect(executedIssueEdits).toEqual([]);
    const reserveSteps = workflow.jobs.reserve?.steps ?? [];
    const reserveStepNames = reserveSteps.map((step) => step.name);
    expect(reserveStepNames.indexOf('Resolve Goobers recovery target')).toBeLessThan(
      reserveStepNames.indexOf('Reserve the recovery target and comment on Goobers run start'),
    );
    expect(
      reserveSteps.find(
        (step) => step.name === 'Reserve the recovery target and comment on Goobers run start',
      )?.if,
    ).toContain("steps.recovery.outputs.recovery_issue != ''");
    const release = workflow.jobs['release-unstarted-reservation'];
    expect(release?.needs).toEqual(['reserve', 'run']);
    expect(release?.if).toContain('needs.reserve.outputs.recovery_issue');
    expect(release?.if).toContain('always()');
  });

  it('leaves no stale in-review claim when a slot fails before Goobers ever starts', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const disposition =
      workflow.jobs.run?.steps?.find((step) => step.name === 'Handle no-work disposition')?.run ??
      '';

    // No journal means the gaggle's query-backlog claim never ran, so no
    // goobers/status:in-review label can exist for that slot. Hard-failing
    // there buried the real failure under a second, false "stale claim" error.
    // Keyed on the SLOT's own run id rather than a lane-wide journal, so a
    // sibling slot's journal cannot stand in for it.
    const noJournalIndex = disposition.indexOf('if [ -z "$run_id" ]; then');
    const unrecoverableIndex = disposition.indexOf(
      'but the claimed issue number could not be recovered. Inspect artifact',
    );
    expect(noJournalIndex).toBeGreaterThan(0);
    expect(unrecoverableIndex).toBeGreaterThan(0);
    expect(noJournalIndex).toBeLessThan(unrecoverableIndex);
    expect(disposition).toContain(
      'produced no run journal and claimed no issue; nothing to release',
    );

    // Releasing the claim is this step's whole purpose, so EVERY release site
    // must check the call and name the manual remediation rather than surfacing
    // a bare `gh` error. Asserted over all sites, not just a shared helper, so
    // a new unchecked release cannot slip in beside a checked one.
    const releaseSites = disposition.match(/--remove-label 'goobers\/status:in-review'/g) ?? [];
    expect(releaseSites.length).toBeGreaterThanOrEqual(3);
    const checkedSites =
      disposition.match(
        /if ! gh issue edit "\$issue_number"[\s\S]{0,200}?--remove-label 'goobers\/status:in-review'; then\n\s+echo "::error::Could not /g,
      ) ?? [];
    expect(checkedSites).toHaveLength(releaseSites.length);
    expect(disposition).toMatch(
      /clear it with: gh issue edit \$\{issue_number\} --repo \$\{GITHUB_REPOSITORY\} --remove-label goobers\/status:in-review/,
    );
  });

  it('retires every concurrent run’s provider claim marker so no issue is stranded', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const disposition = workflow.jobs.run?.steps?.find(
      (step) => step.name === 'Handle no-work disposition',
    );
    const script = disposition?.run ?? '';

    // A run killed before its in-process terminal cleanup (slot deadline, OOM,
    // cancellation) would otherwise leave goobers:claimed and its claim
    // breadcrumb behind, and claimWinner resolves by the earliest surviving
    // breadcrumb — the issue would become permanently unclaimable. This repo
    // runs no backlog-curation reconciliation, so the release is explicit.
    expect(script).toContain('goobers backlog-query --release "$slot_root"');
    expect(script).toContain('release_claim_marker "$slot_root" "$run_id"');
    expect(script).toContain('GOOBERS_RUN_ID="$run_id"');
    // The marker was authored by the PAT identity, so the release must be too:
    // github.token is an App installation token whose GET /user is
    // unsupported, and claimWinner needs the marker author.
    expect(disposition?.env?.GOOBERS_CLAIM_TOKEN).toBe(
      '${{ secrets.GOOBERS_GITHUB_TOKEN || secrets.CRAWLER_CI_PAT }}',
    );
    expect(script).toContain('GOOBERS_CRED_GITHUB_ISSUES_WRITE="${GOOBERS_CLAIM_TOKEN}"');
    // Failing to release is surfaced with the manual remediation, not swallowed.
    expect(script).toContain('--remove-label goobers:claimed');
    expect(script).toMatch(
      /::error::Could not release run \$\{run_id\}'s Goobers provider claim marker/,
    );
  });

  it('processes every slot run for disposition and reporting, never just the newest journal', () => {
    const workflow = loadYaml<GoobersActionsWorkflow>('.github', 'workflows', 'goobers-run.yml');
    const steps = workflow.jobs.run?.steps ?? [];
    const disposition = steps.find((step) => step.name === 'Handle no-work disposition')?.run ?? '';
    const result = steps.find((step) => step.name === 'Comment on Goobers run result')?.run ?? '';

    for (const script of [disposition, result]) {
      // Exhaustive enumeration across both slots...
      expect(script).toContain('for slot in ${GOOBERS_SLOTS}; do');
      expect(script).toContain(
        'find "${slot_root}/gaggles" -path \'*/runs/*/events.jsonl\' -type f |',
      );
      expect(script).toContain('done < "$run_records"');
      // ...and never latest-run-only selection, which is what stranded a
      // concurrent slot's claim on goobers/status:in-review.
      expect(script).not.toMatch(/events\.jsonl['"]? -type f \| sort \| tail -n 1/);
      expect(script).not.toContain('| sort | tail -n 1');
    }

    // One result comment per Goobers run: four runs share a single Actions run
    // id, so the marker has to be keyed by the Goobers run too.
    expect(result).toContain('goobers-run=${run_id:-none}');
    expect(result).toContain('lane=${GOOBERS_LANE} slot=${slot}');
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
    expect(retry?.if).toBe("always() && steps.reap-stage-processes.outcome == 'success'");
    expect(retry?.env?.GOOBERS_RESUME_PR).toBe('${{ env.GOOBERS_RESUME_PR }}');
    expect(retry?.run).toContain('resume_pr="${GOOBERS_RESUME_PR:-}"');
    expect(retry?.run).toContain('preserving in-review ownership');
    expect(retry?.run).toContain('.status == "no-work"');
    expect(retry?.run).toContain('outputs.disposition // empty');
    expect(retry?.run).toContain('no_work_disposition" = "completed-existing-work"');
    expect(retry?.run).toContain(
      "ensure_repository_label 'goobers/status:completed-existing-work' '0e8a16'",
    );
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

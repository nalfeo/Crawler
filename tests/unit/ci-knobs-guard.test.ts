/**
 * ci-knobs-guard.test.ts — deterministic guard for CI script constants.
 *
 * Scans the three key CI scripts for file-scope numeric constant declarations
 * (e.g. `const FOO = 42;`) and fails if any appear that are not registered in
 * one of two buckets:
 *
 *  1. OPERATIONALLY_TWEAKABLE — constants that have been promoted to env-var
 *     knobs. The test also verifies each one actually reads from process.env
 *     somewhere in its source file.
 *
 *  2. STRUCTURAL_ALLOWLIST — constants that are intentionally hardcoded
 *     (retry parameters, comment-size truncation limits, internal batch sizes).
 *
 * When you add a new behavior-shaping constant:
 *  - If operationally tweakable: add a `process.env.YOUR_VAR` read in the
 *    script, wire it in the relevant workflow YAML, add a row to
 *    docs/agent-os/policies/ci-config-knobs.md, then add it to
 *    OPERATIONALLY_TWEAKABLE below.
 *  - If structural: add a row to ci-config-knobs.md's structural-constants
 *    table, then add it to STRUCTURAL_ALLOWLIST below.
 *
 * See docs/agent-os/policies/ci-config-knobs.md for the full reference.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROUTER_PATH = '.github/scripts/ci-recovery/router.mjs';
const ROUTER_WORKFLOW_PATH = '.github/workflows/ci-recovery-router.yml';
const ROUTER_TEST_PATH = '.github/scripts/ci-recovery/router.test.mjs';
const RECONCILE_TEST_PATH = '.github/scripts/ci-recovery/reconcile.test.mjs';
const REVIEW_REQUEST_TEST_PATH = '.github/scripts/ci-recovery/review-request.test.mjs';
const PR_CONCURRENCY_TEST_PATH = 'tests/unit/pr-workflow-concurrency.test.ts';
const CI_GATING_POLICY_TEST_PATH = 'tests/unit/ci-gating-policy.test.ts';
const CI_WORKFLOW_OVERHEAD_TEST_PATH = 'tests/unit/ci-workflow-overhead.test.ts';
const SWEEP_WORKFLOW_BUDGET_TEST_PATH = 'tests/unit/sweep-workflow-budget.test.ts';
const AI_SWEEP_WORKFLOW_TEST_PATH = 'tests/unit/ai-sweep-workflow.test.ts';
const POLICY_PATH = 'docs/agent-os/policies/ci-config-knobs.md';

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

// Exhaustive allowlist of exported numeric-literal constants per harness file.
// Adding a new constant to any of these files without registering it here will
// cause the scan test below to fail — forcing an explicit registration decision.
const NUMERIC_KNOBS: Record<string, string[]> = {
  '.github/scripts/ci-recovery/router.mjs': [
    'RUNNER_CEILING',
    'VALIDATION_RESERVED_TRAIN_BUSY',
    'VALIDATION_RESERVED_TRAIN_IDLE',
    'MAX_DISPATCH_BUDGET_TRAIN_BUSY',
    'MAX_DISPATCH_BUDGET_TRAIN_IDLE',
    'SWEEP_RUNNER_WEIGHT',
    'VALIDATION_RUNNER_WEIGHT',
    'REAPER_LANE_CAP',
    'RECONCILIATION_LANE_CAP',
  ],
  '.github/scripts/ci-recovery/state.mjs': [
    'DEFAULT_LEASE_TTL_MINUTES',
    'DEFAULT_LEASE_GRACE_MINUTES',
    'AUTOMATION_STALE_MINUTES',
  ],
  '.github/scripts/merge-train/state.mjs': ['MAX_TRAIN_SIZE', 'CANDIDATE_VALIDATION_STALE_MS'],
  '.github/scripts/ci-conflict-coordinator/state.mjs': [
    'MIN_CLUSTER_SIZE',
    'MAX_OVERLAP_FILES',
    'DISPATCH_LEASE_MS',
  ],
};

// Matches `export const UPPER_CASE = <numeric literal or arithmetic expression>;`
// Excludes derived constants (right-hand side starts with a letter, e.g. GLOBAL_FOO = OTHER_CONST).
const NUMERIC_EXPORT_RE = /^export const ([A-Z][A-Z0-9_]*)\s*=\s*\d/gm;

// Scripts we audit.  Each entry lists its path (relative to repo root) and the
// env-var names whose `process.env.<VAR>` reads we expect to find.
// The 'env-var reads' list covers scripts that have been PROMOTED to runtime
// knobs — i.e., they actively read from process.env.  Purely structural scripts
// (no operationally-tweakable vars) appear only in the all-scripts scan below.
const AUDITED_SCRIPTS = [
  {
    relPath: '.github/scripts/ci-recovery/router.mjs',
    // Env vars that must appear as `process.env.XXX` or `env.XXX` (runFromEnv
    // passes env as a local variable) somewhere in this file.
    expectedEnvReads: [
      'CI_RECOVERY_MAX_DISPATCH_PER_RUN',
      'CI_GLOBAL_TRAIN_DISPATCH_CAP',
      'CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP',
      'MERGE_TRAIN_ENABLED',
    ],
  },
  {
    relPath: '.github/scripts/merge-train/reconcile.mjs',
    // CI_GLOBAL_TRAIN_DISPATCH_CAP is read indirectly via resolveGlobalDispatchCaps(process.env)
    // imported from ci-recovery/router.mjs.  Only the vars that appear directly are listed here;
    // the indirect read is verified separately in the 'indirect reads via resolver' describe block.
    expectedEnvReads: ['MERGE_TRAIN_ENABLED', 'MERGE_TRAIN_ADMISSION_CHECKS'],
  },
  {
    relPath: '.github/scripts/ci-conflict-coordinator/reconcile.mjs',
    expectedEnvReads: [
      'MERGE_TRAIN_ENABLED',
      'MERGE_TRAIN_ADMISSION_CHECKS',
      'CI_CONFLICT_REOPEN_RETRY_DELAY_MS',
    ],
  },
];

/**
 * Constants in ci-recovery/router.mjs that have been promoted to runtime
 * variables.  Listed as `<constantName>: <envVarName>` pairs.
 */
const OPERATIONALLY_TWEAKABLE_ROUTER: Record<string, string> = {
  // Numeric defaults for the env-driven dispatch caps (aliased by GLOBAL_*).
  // CI_GLOBAL_TRAIN_DISPATCH_CAP and CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP override
  // these at runtime via resolveGlobalDispatchCaps(env).
  MAX_DISPATCH_BUDGET_TRAIN_BUSY: 'CI_GLOBAL_TRAIN_DISPATCH_CAP',
  MAX_DISPATCH_BUDGET_TRAIN_IDLE: 'CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP',
  // Legacy alias exports — no longer numeric literals, so not caught by the
  // unregistered-constant guard, but kept here so the env-readable test still
  // documents that CI_GLOBAL_TRAIN/IDLE_DISPATCH_CAP are live knobs.
  GLOBAL_TRAIN_DISPATCH_CAP: 'CI_GLOBAL_TRAIN_DISPATCH_CAP',
  GLOBAL_IDLE_TRAIN_DISPATCH_CAP: 'CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP',
  DEFAULT_MAX_DISPATCH_PER_RUN: 'CI_RECOVERY_MAX_DISPATCH_PER_RUN',
};

/**
 * All file-scope numeric constants that are intentionally hardcoded — not
 * operationally tweakable but structurally necessary.  The set spans ALL
 * production scripts under .github/scripts/ (names are unique across files).
 * See docs/agent-os/policies/ci-config-knobs.md for the canonical table.
 */
const STRUCTURAL_ALLOWLIST = new Set([
  // router.mjs — retry / timing / structural
  'DEFAULT_RETRY_MAX_ATTEMPTS',
  'DEFAULT_RETRY_BASE_DELAY_MS',
  'DEFAULT_RETRY_MAX_DELAY_MS',
  'FLAG_OFF_SWEEP_ROTATION_WINDOW_MS',
  'DEFAULT_OUTSTANDING_VISIBILITY_TIMEOUT_MS',
  'DEFAULT_OUTSTANDING_VISIBILITY_POLL_INTERVAL_MS',
  'OWNERSHIP_HYDRATION_BATCH_SIZE',
  'REPAIR_WINDOW_SIZE',
  // router.mjs — load-aware budget architecture (2026-07-22+)
  // These constants encode measured GitHub Free runner capacity and tuned
  // safety margins; changing them requires evidence from incident metrics,
  // not just a repo-variable update, so they remain structural.
  'RUNNER_CEILING', // GitHub Free standard-hosted concurrency ceiling (~20)
  'VALIDATION_RESERVED_TRAIN_BUSY', // reserved runner slots for Validation when queue non-empty
  'VALIDATION_RESERVED_TRAIN_IDLE', // reserved slots when queue empty / train off
  'SWEEP_RUNNER_WEIGHT', // estimated concurrent jobs per in-progress sweep run
  'VALIDATION_RUNNER_WEIGHT', // estimated concurrent jobs per Validation run
  'REAPER_LANE_CAP', // max PRs per reaper sweep window
  'RECONCILIATION_LANE_CAP', // reserved stale-PR fairness lane in non-sweep routing
  // router.mjs — runner-safety ceilings for env-driven cap overrides.
  // Changing these requires evidence from incident metrics, not a repo variable.
  'TRAIN_CAP_MAX', // enforced ceiling for CI_GLOBAL_TRAIN_DISPATCH_CAP (safe range 1-10)
  'IDLE_CAP_MAX', // enforced ceiling for CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP (safe range 1-20)
  // ci-recovery/reconcile.mjs — rebase backoff
  'REBASE_FAILURE_MAX_ATTEMPTS',
  'REBASE_FAILURE_BASE_BACKOFF_MS',
  'REBASE_FAILURE_MAX_BACKOFF_MS',
  'RELEASE_HANDOFF_ATTEMPTS',
  'RELEASE_HANDOFF_DELAY_MS',
  // ci-recovery/reconcile.mjs — D5 terminal dispatch loop bound (2026-07-27)
  'MAX_TERMINAL_PASSES', // structural safety cap on the terminal-table retry loop, not an operational knob
  // ci-recovery/decision-log.mjs — observability log-line truncation (2026-07-27)
  'MAX_TRIGGER_LEN', // max chars retained for a logged trigger value; a log-format bound, not an operational knob
  // merge-train/reconcile-lib.mjs — empty-train liveness threshold
  'EMPTY_TRAIN_LIVENESS_THRESHOLD_MS', // incident-open threshold for stalled empty-train; changing requires incident-metric evidence
  // merge-train/reconcile.mjs — structural lookback window
  'MAIN_HEALTH_PUSH_RUN_LOOKBACK',
  // merge-train/state.mjs
  'MAX_TRAIN_SIZE', // merge train batch size (matches REPAIR_WINDOW_SIZE)
  'CANDIDATE_VALIDATION_STALE_MS', // validation stale threshold
  // merge-train/protection-lib.mjs
  'GITHUB_ACTIONS_APP_ID', // fixed GitHub Actions App ID (not operator-tunable)
  // merge-train/check-runs.mjs
  'PAGE_SIZE', // GitHub API pagination page size
  'MAX_PAGES', // pagination page limit
  'MAX_TRUSTED_APP_CHECK_SUITES', // max check suites per trusted app
  // merge-train/resolve-landed-pr.mjs
  'EXIT_API_FAILURE', // exit code for API failure (structural, not a behavior knob)
  'ASSOCIATED_PULLS_PER_PAGE', // GitHub API page size for associated pulls
  // ci-recovery/github.mjs
  'MAX_RETRY_ATTEMPTS', // GitHub API request retry limit
  // ci-recovery/state.mjs
  'DEFAULT_LEASE_TTL_MINUTES', // automation lease time-to-live
  'DEFAULT_LEASE_GRACE_MINUTES', // grace period after lease expiry
  'AUTOMATION_STALE_MINUTES', // age after which an automation comment is stale
  // ci-recovery/harvest-liveness.mjs
  'DEFAULT_HARVEST_THRESHOLD_MINUTES', // default stale-session harvest liveness alarm threshold
  'DEFAULT_DISPATCH_LIVENESS_WINDOW_HOURS', // default decision-log lookback window for dispatch-liveness sweep
  'DEFAULT_PR_DISPATCH_GAP_HOURS', // default per-PR dispatch gap threshold for blocked PRs
  // ci-recovery/issue-intake-lib.mjs
  'RECOVERY_PLAN_CHECKLIST_MAX_ITEMS', // max checklist items in a recovery plan
  'RECOVERY_PLAN_CHECKLIST_ITEM_MAX_LENGTH', // max length per checklist item
  // ci-recovery/duplicate-detect.mjs — auto-close grace window (incident PR #2948)
  'EMPTY_DIFF_MIN_AGE_MS', // min PR age before an empty diff is duplicate proof
  'EMPTY_DIFF_MIN_QUIET_MS', // min quiet period since last update before an empty diff counts
  // pr-ready-reviewer-guard.mjs
  'COPILOT_CLOUD_AGENT_WORKFLOW_ID', // fixed Copilot cloud agent workflow ID
  'EMPTY_DRAFT_REPAIR_GRACE_MS', // grace period for empty-draft repair
  'WORKFLOW_RUNS_PAGE_SIZE', // page size for workflow runs API
  'WORKFLOW_RUNS_MAX_PAGES', // max pages to fetch for workflow runs
  // ci-conflict-coordinator/state.mjs
  'MIN_CLUSTER_SIZE', // minimum PR count for a conflict-coordination cluster
  'MAX_OVERLAP_FILES', // max overlap files stored per cluster
  // sweep-budget.mjs
  'SWEEP_POOL_SIZE', // max concurrent sweep runs in the pool
  'ACCOUNT_RUNNER_LIMIT', // GitHub Free account-level runner concurrency limit
]);

/** Regex that matches a top-level `const NAME = <number>;` declaration. */
const TOP_LEVEL_NUMERIC_CONST_RE =
  /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*[\d.]+\s*(?:\*\s*[\d.]+\s*)*(?:\/\/.*)?;?$/gm;

function extractTopLevelNumericConsts(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(TOP_LEVEL_NUMERIC_CONST_RE)) {
    const name = match[1];
    if (name) names.push(name);
  }
  return names;
}

describe('CI harness knobs guard', () => {
  it('keeps ci-recovery dispatch budget knobs explicit and exported', () => {
    const source = read(ROUTER_PATH);
    expect(source).toContain('export const MAX_DISPATCH_BUDGET_TRAIN_BUSY = 5;');
    expect(source).toContain('export const MAX_DISPATCH_BUDGET_TRAIN_IDLE = 8;');
    expect(source).toContain(
      'export const GLOBAL_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_BUSY;',
    );
    expect(source).toContain(
      'export const GLOBAL_IDLE_TRAIN_DISPATCH_CAP = MAX_DISPATCH_BUDGET_TRAIN_IDLE;',
    );
  });

  it('keeps ownership and train-size safety knobs pinned', () => {
    const recoveryState = read('.github/scripts/ci-recovery/state.mjs');
    const trainState = read('.github/scripts/merge-train/state.mjs');
    const conflictState = read('.github/scripts/ci-conflict-coordinator/state.mjs');

    expect(recoveryState).toContain('export const DEFAULT_LEASE_TTL_MINUTES = 30;');
    expect(recoveryState).toContain('export const DEFAULT_LEASE_GRACE_MINUTES = 5;');
    expect(recoveryState).toContain('export const AUTOMATION_STALE_MINUTES = 30;');

    expect(trainState).toContain('export const MAX_TRAIN_SIZE = 6;');

    expect(conflictState).toContain(
      'export const DISPATCH_LEASE_MS = 30 * 60 * 1000; // 30 minutes',
    );
  });

  it('scans all exported numeric-literal constants and rejects unregistered ones', () => {
    for (const [filePath, allowlist] of Object.entries(NUMERIC_KNOBS)) {
      const source = read(filePath);
      const found = [...source.matchAll(NUMERIC_EXPORT_RE)].map((m) => m[1]);

      for (const name of found) {
        expect(
          allowlist,
          `Unregistered numeric constant '${name}' in ${filePath} — add it to NUMERIC_KNOBS or convert it to a structural (non-exported) constant`,
        ).toContain(name);
      }

      for (const name of allowlist) {
        expect(
          source,
          `Allowlisted constant '${name}' missing from ${filePath} — remove it from NUMERIC_KNOBS`,
        ).toMatch(new RegExp(`export const ${name}\\s*=`));
      }
    }
  });

  it('verifies each allowlisted constant is used within its own module (not an orphaned export)', () => {
    for (const [filePath, allowlist] of Object.entries(NUMERIC_KNOBS)) {
      const source = read(filePath);
      for (const name of allowlist) {
        const occurrences = (source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
        expect(
          occurrences,
          `Constant '${name}' in ${filePath} appears only once — it is declared but never used within its module`,
        ).toBeGreaterThan(1);
      }
    }
  });
});

describe('CI knobs guard', () => {
  describe('operationally-tweakable constants are env-readable', () => {
    const routerPath = path.join(REPO_ROOT, '.github/scripts/ci-recovery/router.mjs');
    const routerSource = readFileSync(routerPath, 'utf8');

    for (const [constName, envVarName] of Object.entries(OPERATIONALLY_TWEAKABLE_ROUTER)) {
      it(`${constName} has a corresponding process.env / env.${envVarName} read in router.mjs`, () => {
        const readsEnv =
          routerSource.includes(`process.env.${envVarName}`) ||
          routerSource.includes(`env.${envVarName}`);
        expect(readsEnv).toBe(true);
      });
    }
  });

  describe('each audited script reads all expected env vars', () => {
    for (const { relPath, expectedEnvReads } of AUDITED_SCRIPTS) {
      const fullPath = path.join(REPO_ROOT, relPath);
      const source = readFileSync(fullPath, 'utf8');

      for (const envVar of expectedEnvReads) {
        it(`${relPath} reads process.env.${envVar} (or env.${envVar})`, () => {
          const reads =
            source.includes(`process.env.${envVar}`) || source.includes(`env.${envVar}`);
          expect(
            reads,
            `${relPath} must read ${envVar} from the environment. ` +
              `If this knob was removed, delete it from the expectedEnvReads list in ci-knobs-guard.test.ts ` +
              `and update docs/agent-os/policies/ci-config-knobs.md.`,
          ).toBe(true);
        });
      }
    }
  });

  describe('no unregistered file-scope numeric constants in router.mjs', () => {
    const routerPath = path.join(REPO_ROOT, '.github/scripts/ci-recovery/router.mjs');
    const routerSource = readFileSync(routerPath, 'utf8');
    const found = extractTopLevelNumericConsts(routerSource);
    const knownTweakable = new Set(Object.keys(OPERATIONALLY_TWEAKABLE_ROUTER));

    for (const name of found) {
      it(`${name} is registered as tweakable or structural`, () => {
        const isKnown = knownTweakable.has(name) || STRUCTURAL_ALLOWLIST.has(name);
        expect(
          isKnown,
          `Found unregistered file-scope numeric constant '${name}' in router.mjs. ` +
            `If this is a new operationally-meaningful knob, add a process.env read for it, ` +
            `wire it in the relevant workflow YAML, document it in ` +
            `docs/agent-os/policies/ci-config-knobs.md, and add it to ` +
            `OPERATIONALLY_TWEAKABLE_ROUTER in ci-knobs-guard.test.ts. ` +
            `If it is a structural constant, add it to STRUCTURAL_ALLOWLIST.`,
        ).toBe(true);
      });
    }
  });

  describe('no unregistered file-scope numeric constants in ci-recovery/reconcile.mjs', () => {
    const reconcilePath = path.join(REPO_ROOT, '.github/scripts/ci-recovery/reconcile.mjs');
    const source = readFileSync(reconcilePath, 'utf8');
    const found = extractTopLevelNumericConsts(source);

    for (const name of found) {
      it(`${name} is in the structural allowlist`, () => {
        expect(
          STRUCTURAL_ALLOWLIST.has(name),
          `Found unregistered file-scope numeric constant '${name}' in ci-recovery/reconcile.mjs. ` +
            `Add it to STRUCTURAL_ALLOWLIST or promote it to an env-driven knob ` +
            `(see docs/agent-os/policies/ci-config-knobs.md).`,
        ).toBe(true);
      });
    }
  });

  describe('no unregistered file-scope numeric constants in merge-train/reconcile.mjs', () => {
    const reconcilePath = path.join(REPO_ROOT, '.github/scripts/merge-train/reconcile.mjs');
    const source = readFileSync(reconcilePath, 'utf8');
    const found = extractTopLevelNumericConsts(source);

    for (const name of found) {
      it(`${name} is in the structural allowlist`, () => {
        expect(
          STRUCTURAL_ALLOWLIST.has(name),
          `Found unregistered file-scope numeric constant '${name}' in merge-train/reconcile.mjs. ` +
            `Add it to STRUCTURAL_ALLOWLIST or promote it to an env-driven knob ` +
            `(see docs/agent-os/policies/ci-config-knobs.md).`,
        ).toBe(true);
      });
    }
  });

  describe('workflow files wire the promoted env vars', () => {
    const routerWorkflow = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/ci-recovery-router.yml'),
      'utf8',
    );
    const mergeTrainWorkflow = readFileSync(
      path.join(REPO_ROOT, '.github/workflows/merge-train.yml'),
      'utf8',
    );

    it('ci-recovery-router.yml passes CI_GLOBAL_TRAIN_DISPATCH_CAP', () => {
      expect(routerWorkflow).toContain('CI_GLOBAL_TRAIN_DISPATCH_CAP');
    });

    it('ci-recovery-router.yml passes CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP', () => {
      expect(routerWorkflow).toContain('CI_GLOBAL_IDLE_TRAIN_DISPATCH_CAP');
    });

    it('merge-train.yml passes CI_GLOBAL_TRAIN_DISPATCH_CAP', () => {
      expect(mergeTrainWorkflow).toContain('CI_GLOBAL_TRAIN_DISPATCH_CAP');
    });
  });

  describe('merge-train/reconcile.mjs delegates dispatch caps via resolver', () => {
    const reconcilePath = path.join(REPO_ROOT, '.github/scripts/merge-train/reconcile.mjs');
    const source = readFileSync(reconcilePath, 'utf8');

    it('imports resolveGlobalDispatchCaps from router.mjs (indirect read of CI_GLOBAL_TRAIN_DISPATCH_CAP)', () => {
      // merge-train/reconcile.mjs reads CI_GLOBAL_TRAIN_DISPATCH_CAP indirectly by calling
      // resolveGlobalDispatchCaps(process.env) rather than accessing the env var directly.
      // This test verifies that delegation pattern is preserved.
      expect(source).toContain('resolveGlobalDispatchCaps');
    });

    it('calls resolveGlobalDispatchCaps with process.env', () => {
      expect(source).toContain('resolveGlobalDispatchCaps(process.env)');
    });
  });

  describe('dispatch budget log includes effective budget field', () => {
    const routerPath = path.join(REPO_ROOT, '.github/scripts/ci-recovery/router.mjs');
    const routerSource = readFileSync(routerPath, 'utf8');

    it('backpressure log line contains budget= field', () => {
      // Prevents regression to the pre-fix state where cap= showed a
      // potentially-misleading "cap=5 while dispatching 0" message.
      expect(routerSource).toContain('budget=${boundedDispatchBudget}');
    });
  });

  describe('no unregistered file-scope numeric constants in any production CI script', () => {
    // Auto-discovers ALL .github/scripts/**/*.mjs files (excluding tests) and
    // asserts every file-scope numeric constant is registered in either
    // OPERATIONALLY_TWEAKABLE_ROUTER or STRUCTURAL_ALLOWLIST.
    //
    // This prevents the gap identified in the 2026-07 review: the per-file
    // describe blocks above only covered 3 entrypoints; constants in supporting
    // scripts (merge-train/state.mjs, ci-recovery/github.mjs, etc.) were
    // invisible to the guard.  The auto-discovery approach covers the complete
    // .github/scripts/** scope without requiring a per-file test scaffold.
    const scriptsDir = path.join(REPO_ROOT, '.github/scripts');
    const knownTweakable = new Set(Object.keys(OPERATIONALLY_TWEAKABLE_ROUTER));

    function collectMjsFiles(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...collectMjsFiles(full));
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.mjs') &&
          !entry.name.endsWith('.test.mjs')
        ) {
          files.push(full);
        }
      }
      return files;
    }

    const allProductionScripts = collectMjsFiles(scriptsDir);

    for (const scriptPath of allProductionScripts) {
      const relPath = path.relative(REPO_ROOT, scriptPath);
      const source = readFileSync(scriptPath, 'utf8');
      const found = extractTopLevelNumericConsts(source);
      if (found.length === 0) continue;

      for (const name of found) {
        it(`${relPath}: ${name} is registered as tweakable or structural`, () => {
          const isKnown = knownTweakable.has(name) || STRUCTURAL_ALLOWLIST.has(name);
          expect(
            isKnown,
            `Found unregistered file-scope numeric constant '${name}' in ${relPath}. ` +
              `If this is a new operationally-meaningful knob, add a process.env read for it, ` +
              `wire it in the relevant workflow YAML, document it in ` +
              `docs/agent-os/policies/ci-config-knobs.md, and register it in ` +
              `OPERATIONALLY_TWEAKABLE_ROUTER in ci-knobs-guard.test.ts. ` +
              `If it is a structural constant, add it to STRUCTURAL_ALLOWLIST in ` +
              `ci-knobs-guard.test.ts and add a row to the structural constants table in ` +
              `docs/agent-os/policies/ci-config-knobs.md.`,
          ).toBe(true);
        });
      }
    }
  });

  describe('ci-config-knobs.md documents every registered constant', () => {
    // Cross-check between the test-local registry and the canonical knobs doc.
    // Prevents the failure mode: a constant is added to STRUCTURAL_ALLOWLIST
    // (making the guard pass) but the doc is never updated, so operators have
    // no way to know the constant exists.
    //
    // Enforcement: every entry in STRUCTURAL_ALLOWLIST and every key in
    // OPERATIONALLY_TWEAKABLE_ROUTER must appear by name somewhere in
    // docs/agent-os/policies/ci-config-knobs.md.
    const knobsDocPath = path.join(REPO_ROOT, 'docs/agent-os/policies/ci-config-knobs.md');
    const knobsDoc = readFileSync(knobsDocPath, 'utf8');

    for (const name of STRUCTURAL_ALLOWLIST) {
      it(`STRUCTURAL_ALLOWLIST: ${name} appears in ci-config-knobs.md`, () => {
        expect(
          knobsDoc.includes(name),
          `Structural constant '${name}' is in STRUCTURAL_ALLOWLIST but not mentioned in ` +
            `docs/agent-os/policies/ci-config-knobs.md. Add a row to the structural-constants ` +
            `table so operators know this constant is intentionally hardcoded.`,
        ).toBe(true);
      });
    }

    for (const [constName, envVarName] of Object.entries(OPERATIONALLY_TWEAKABLE_ROUTER)) {
      it(`OPERATIONALLY_TWEAKABLE: ${constName}/${envVarName} appears in ci-config-knobs.md`, () => {
        const mentionsConst = knobsDoc.includes(constName);
        const mentionsEnvVar = knobsDoc.includes(envVarName);
        expect(
          mentionsConst || mentionsEnvVar,
          `Tweakable knob '${constName}' (env: '${envVarName}') is registered in ` +
            `OPERATIONALLY_TWEAKABLE_ROUTER but neither name appears in ` +
            `docs/agent-os/policies/ci-config-knobs.md. Add a row to the ` +
            `runtime-tweakable knobs table so operators can find and use this variable.`,
        ).toBe(true);
      });
    }
  });
});

describe('ci-config knobs + invariants guard', () => {
  it('router resolves runtime dispatch caps from env and keeps invariant defaults', () => {
    const source = read(ROUTER_PATH);
    expect(source).toContain('export function resolveGlobalDispatchCaps');
    expect(source).toContain('CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY');
    expect(source).toContain('CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE');
    expect(source).toContain('CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP');
    expect(source).toContain('CI_RECOVERY_MAX_DISPATCH_PER_RUN');
    expect(source).toContain('MAX_DISPATCH_BUDGET_TRAIN_BUSY');
    expect(source).toContain('MAX_DISPATCH_BUDGET_TRAIN_IDLE');
    expect(source).toContain('GLOBAL_TRAIN_DISPATCH_CAP');
    expect(source).toContain('DEFAULT_MAX_DISPATCH_PER_RUN');
  });

  it('router workflow wires knob vars with fail-closed defaults', () => {
    const source = read(ROUTER_WORKFLOW_PATH);
    expect(source).toContain(
      "CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY: ${{ vars.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY || '5' }}",
    );
    expect(source).toContain(
      "CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE: ${{ vars.CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE || '8' }}",
    );
    expect(source).toContain(
      "CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP: ${{ vars.CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP || '5' }}",
    );
    expect(source).toContain(
      "CI_RECOVERY_MAX_DISPATCH_PER_RUN: ${{ vars.CI_RECOVERY_MAX_DISPATCH_PER_RUN || '8' }}",
    );
  });

  it('policy doc enumerates every must-preserve invariant from the redesign baseline', () => {
    const source = read(POLICY_PATH);
    expect(source).toContain('Load-aware dispatch budget caps');
    expect(source).toContain('Review-round throttle');
    expect(source).toContain('Per-PR concurrency');
    expect(source).toContain('`expected_head_sha` fail-closed binding');
    expect(source).toContain('CI-fix-first + blocked-PR exclusion + global FIFO admission');
    expect(source).toContain('Superseded-run cancellation + impact-gated CI dispatch');
    expect(source).toContain('Thundering-herd backpressure and queue-aware sweep behavior');
  });

  it('named regression coverage exists for each invariant family', () => {
    const routerTests = read(ROUTER_TEST_PATH);
    const reconcileTests = read(RECONCILE_TEST_PATH);
    const reviewRequestTests = read(REVIEW_REQUEST_TEST_PATH);
    const concurrencyTests = read(PR_CONCURRENCY_TEST_PATH);
    const ciGatingPolicyTests = read(CI_GATING_POLICY_TEST_PATH);
    const ciWorkflowOverheadTests = read(CI_WORKFLOW_OVERHEAD_TEST_PATH);
    const sweepWorkflowBudgetTests = read(SWEEP_WORKFLOW_BUDGET_TEST_PATH);
    const aiSweepWorkflowTests = read(AI_SWEEP_WORKFLOW_TEST_PATH);

    expect(routerTests).toContain(
      '25 concurrent router-trigger events are bounded by runner headroom while the train queue is non-empty',
    );
    expect(routerTests).toContain(
      'flag-off schedule dispatches CI-fix PRs before normal PRs, both oldest-first',
    );
    expect(routerTests).toContain(
      'flag-off schedule sweeps exclude blocked-labeled PRs from dispatch',
    );
    expect(routerTests).toContain(
      'flag-off sweeps order PRs oldest-first (global FIFO) across sweeps',
    );
    expect(routerTests).toContain(
      'runFromEnv respects runtime busy/global caps under a simulated schedule burst',
    );
    expect(reviewRequestTests).toContain('allows exactly one review per conflict episode');
    expect(reconcileTests).toContain(
      'expected_head_sha mismatch: reconcile fails closed before any mutation, even in live mode',
    );
    expect(reconcileTests).toContain(
      'reconcile ignores stale action-required run when a newer run of the same workflow succeeded',
    );
    expect(reconcileTests).toContain(
      'reconcile escalates required-check action-required runs as ci-retrigger blockers',
    );
    expect(concurrencyTests).toContain('cancels superseded runs only for pull_request');
    expect(concurrencyTests).toContain('keeps PR groups isolated and separate from non-PR runs');
    expect(ciGatingPolicyTests).toContain(
      'ci-coverage skips on PR only when coverage_touched is explicitly false (fail-closed)',
    );
    expect(ciWorkflowOverheadTests).toContain(
      'scope-gated jobs carry allow_skipped=true so art/sprites-only changes pass',
    );
    expect(sweepWorkflowBudgetTests).toContain(
      'gives every job a non-cancelling global semaphore token',
    );
    expect(aiSweepWorkflowTests).toContain(
      'stays read-only with only the metadata permissions required by queue-aware admission and cross-run artifact download',
    );
  });
});

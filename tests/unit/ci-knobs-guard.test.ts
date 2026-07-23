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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Scripts we audit.  Each entry lists its path (relative to repo root) and the
// env-var names whose `process.env.<VAR>` reads we expect to find.
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
 * operationally tweakable but structurally necessary.  The set spans all three
 * audited scripts combined (since a name only needs to be in one script's
 * allowlist to be valid globally — names are unique across these files).
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
  // router.mjs — load-aware budget architecture (main 2026-07-22+)
  // These constants encode measured GitHub Free runner capacity and tuned
  // safety margins; changing them requires evidence from incident metrics,
  // not just a repo-variable update, so they remain structural.
  'RUNNER_CEILING', // GitHub Free standard-hosted concurrency ceiling (~20)
  'VALIDATION_RESERVED_TRAIN_BUSY', // reserved runner slots for Validation when queue non-empty
  'VALIDATION_RESERVED_TRAIN_IDLE', // reserved slots when queue empty / train off
  'SWEEP_RUNNER_WEIGHT', // estimated concurrent jobs per in-progress sweep run
  'VALIDATION_RUNNER_WEIGHT', // estimated concurrent jobs per Validation run
  'REAPER_LANE_CAP', // max PRs per reaper sweep window
  // ci-conflict-coordinator/state.mjs (imported constants, not checked here but listed for clarity)
  // ci-conflict-coordinator/reconcile.mjs — reopen retry (delay is already env-driven; attempts is structural)
  // reconcile.mjs (ci-recovery) — rebase backoff
  'REBASE_FAILURE_MAX_ATTEMPTS',
  'REBASE_FAILURE_BASE_BACKOFF_MS',
  'REBASE_FAILURE_MAX_BACKOFF_MS',
  'RELEASE_HANDOFF_ATTEMPTS',
  'RELEASE_HANDOFF_DELAY_MS',
  // merge-train/reconcile.mjs — structural lookback window
  'MAIN_HEALTH_PUSH_RUN_LOOKBACK',
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

describe('CI knobs guard', () => {
  describe('operationally-tweakable constants are env-readable', () => {
    const routerPath = path.join(REPO_ROOT, '.github/scripts/ci-recovery/router.mjs');
    const routerSource = readFileSync(routerPath, 'utf8');

    for (const [constName, envVarName] of Object.entries(OPERATIONALLY_TWEAKABLE_ROUTER)) {
      it(`${constName} has a corresponding process.env / env.${envVarName} read in router.mjs`, () => {
        // Accept either process.env.VAR or env.VAR (runFromEnv passes env as a param)
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
      expect(routerSource).toContain('budget=${dispatchBudget}');
    });
  });
});

/**
 * knip-suppressions.ts — authoritative list of `ignoreIssues` suppressions
 * for the knip dead-code detector, with required `reason` and `expiresOn`
 * fields.
 *
 * ## How to add a suppression
 *
 * 1. Add an entry to `KNIP_SUPPRESSIONS` with:
 *    - `file`: repo-relative path of the file being suppressed
 *    - `issues`: the knip issue categories being suppressed (e.g. `["exports"]`)
 *    - `reason`: a CURRENT justification for why the export has no production
 *      caller yet (e.g. "wiring PR #1234 is open but not yet merged").
 *    - `expiresOn`: a date by which the deadness must be resolved (YYYY-MM-DD).
 *      Choose a realistic deadline. If the deadline passes before you resolve the
 *      issue, the CI check will fail — fix the deadness, don't extend the date
 *      without also updating the reason.
 *
 * ## Why `expiresOn`?
 *
 * Suppressions without expiry dates accumulate silently, turning the list into
 * a written record of "this system has no real consumers" that nobody reads as
 * a whole. The `expiresOn` + reason-restatement rule forces periodic
 * re-evaluation and ensures extensions are deliberate.
 *
 * ## Reference implementation
 *
 * Pattern follows `AUDIT_EXCEPTIONS` in `scripts/agent/security/npm-audit.mjs`.
 * The validation logic (expiry check, reason-restatement, git comparison) lives
 * below so it can be unit-tested directly against synthetic entry lists.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Suppression type
// ---------------------------------------------------------------------------

export interface KnipSuppression {
  /** Repo-relative POSIX path of the file whose knip issues are suppressed. */
  readonly file: string;
  /** Knip issue categories to suppress (e.g. `["exports"]`). */
  readonly issues: readonly string[];
  /**
   * CURRENT justification for why the export is not yet live in production.
   * Must be updated (i.e. changed) any time `expiresOn` is extended so
   * extensions are deliberate.
   */
  readonly reason: string;
  /**
   * ISO date (YYYY-MM-DD) by which the suppression must be resolved.
   * An expired suppression causes the CI check to fail with a message:
   * "fix the deadness, don't extend the date".
   */
  readonly expiresOn: string;
}

// ---------------------------------------------------------------------------
// Suppressions list — the single source of truth
// ---------------------------------------------------------------------------

export const KNIP_SUPPRESSIONS: readonly KnipSuppression[] = [
  {
    file: 'src/devtools/sprite-approval-api.ts',
    issues: ['exports'],
    reason:
      'devtools-main.ts is an entry point; some internal API exports are only consumed ' +
      'by devtools/sprite-run-cache.ts (via type import) and not re-exported publicly. ' +
      'Tracked for clean-up when devtools surface stabilises.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/shared/mob-motion.ts',
    issues: ['exports'],
    reason:
      'mob-motion.ts exports are currently only consumed by src/labs/ (ai-runner-lab). ' +
      'A non-lab production caller (engine mob-animation system) is planned once the ' +
      'mob-motion polish pass ships. Tracked in issue #2391.',
    expiresOn: '2026-09-30',
  },
  // --- Reward / equipment surface (triaged in issue #2362) ---
  // The FILES are all wired and called from production code, but specific exports
  // within each file (constants, type aliases, interface definitions that are part
  // of the documented public API but not yet consumed by external callers) are
  // still flagged by knip. Each suppression below is for residual dead exports
  // only; remove the entry once the dead exports are cleaned up or consumed.
  {
    file: 'src/engine/generated-equipment-icon.ts',
    issues: ['exports'],
    reason:
      'GENERATED_EQUIPMENT_RARITY_COLORS is exported as part of the icon API surface ' +
      'but has no external caller yet. The file itself is fully wired; this suppresses ' +
      'the one residual dead-export finding. Clean up when UI adopts the constant.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/engine/RewardOpeningUI.ts',
    issues: ['exports'],
    reason:
      'OpenRewardOpeningParams is exported as part of the reward-opening UI public API ' +
      'but is not imported by any current caller. The file is fully wired into production. ' +
      'Remove once the interface is consumed or deleted.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/game/ai/equipment-loadout-evaluator.ts',
    issues: ['exports'],
    reason:
      'Several evaluation-result types and the schema-version constant ' +
      '(EquipmentErvComponent, EvaluateEquipmentLoadoutInput, EquipmentLoadoutScore, ' +
      'EquipmentLoadoutEvaluation, RejectedEquipmentLoadoutCandidate, ' +
      'EquipmentLoadoutEvaluationResult, EQUIPMENT_ERV_CONFIG_SCHEMA_VERSION) are exported ' +
      'as the evaluator public API but not yet imported by any external caller. The evaluator ' +
      'is called from production (settlement-maintenance-planner). Clean up or consume ' +
      'these types in a follow-on PR.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/game/ai/settlement-maintenance-planner.ts',
    issues: ['exports'],
    reason:
      'SettlementMaintenanceDecisionKind, SettlementMaintenanceDecision, ' +
      'SettlementMaintenanceTerminationReason, and buildOpportunityFingerprint are exported ' +
      'as API/debugging surface but have no external callers. The planner itself is wired ' +
      'into headless-runner and floor2Scenario. Remove once these types are consumed or deleted.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/game/boss-chest-resolver.ts',
    issues: ['exports'],
    reason:
      'BOSS_CHEST_REWARD_BASE_IDS and SpawnBossChestResult are exported but not imported ' +
      'by any external caller. The resolver is wired into production (bossChestRewards system). ' +
      'Remove once these exports are consumed or deleted.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/game/floor1-lootbox-reward-resolver.ts',
    issues: ['exports'],
    reason:
      'LOOT_BOX_RESOLVER_VERSION is exported but used only internally in the same file ' +
      'for constructing grant-ID strings. No external caller imports it. Remove the export ' +
      'keyword or delete the constant once the version scheme is finalised.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/game/floor2-reward-bundle-resolver.ts',
    issues: ['exports'],
    reason:
      'REWARD_BUNDLE_RESOLVER_VERSION and RewardBundleBuildAffinity are exported but have ' +
      'no external callers. The resolver itself is wired into production (bossChestRewards). ' +
      'Remove the version constant export (it is used only internally) and either consume ' +
      'or delete the type alias.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/shared/reward-audio-cues.ts',
    issues: ['exports'],
    reason:
      'REWARD_AUDIO_CUE_KINDS and RewardItemRevealResult are exported as part of the ' +
      'audio-cue API surface but not imported externally. The file is wired into production ' +
      '(reward-opening-audio). Remove once these exports are consumed or deleted.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/shared/reward-opening-sequence.ts',
    issues: ['exports'],
    reason:
      'REWARD_OPENING_PHASES and RewardOpeningConfig are exported as part of the sequence ' +
      'API surface but not imported externally. The file is wired into production ' +
      '(RewardOpeningUI). Remove once these exports are consumed or deleted.',
    expiresOn: '2026-09-30',
  },
  {
    file: 'src/shared/generated-assets.ts',
    issues: ['exports'],
    reason:
      'resolveOpaqueBox is an internal helper used only within the same file; the export ' +
      'is a leftover from PR #2391 and should be removed once a follow-up cleanup lands.',
    expiresOn: '2026-10-31',
  },
];

// ---------------------------------------------------------------------------
// Validation helpers (pure — no I/O, suitable for unit tests)
// ---------------------------------------------------------------------------

/**
 * Return suppressions whose `expiresOn` date is on or before `now`.
 * `now` defaults to today's UTC date string (YYYY-MM-DD).
 */
export function findExpiredSuppressions(
  suppressions: readonly KnipSuppression[],
  now: string = new Date().toISOString().slice(0, 10),
): KnipSuppression[] {
  return suppressions.filter((s) => s.expiresOn <= now);
}

/**
 * Detect entries where `expiresOn` was extended to a later date without
 * updating `reason`
 * (same pattern as `findReasonRestatementViolations` in npm-audit.mjs).
 *
 * Returns a list of `{ file, previousExpiresOn, currentExpiresOn }` tuples.
 */
export function findReasonRestatementViolations(
  previousSuppressions: readonly KnipSuppression[],
  currentSuppressions: readonly KnipSuppression[],
): Array<{ file: string; previousExpiresOn: string; currentExpiresOn: string }> {
  const previousByFile = new Map(previousSuppressions.map((s) => [s.file, s]));
  const violations: Array<{
    file: string;
    previousExpiresOn: string;
    currentExpiresOn: string;
  }> = [];

  for (const current of currentSuppressions) {
    const previous = previousByFile.get(current.file);
    if (!previous) continue; // new entry — no prior to compare against
    if (current.expiresOn > previous.expiresOn && previous.reason === current.reason) {
      violations.push({
        file: current.file,
        previousExpiresOn: previous.expiresOn,
        currentExpiresOn: current.expiresOn,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Source-extraction helper (for reason-restatement check against base branch)
// ---------------------------------------------------------------------------

const SUPPRESSIONS_SCRIPT_PATH = 'scripts/agent/health/knip-suppressions.ts';

/**
 * Extract the `KNIP_SUPPRESSIONS` array from a raw TypeScript source string
 * without executing it. Used to compare against the base-branch version for
 * the reason-restatement check.
 *
 * Limitation: uses Function() eval on the extracted array literal — safe
 * because this only runs in a trusted CI/dev environment, not in the browser.
 */
export function extractSuppressionsFromSource(source: string): readonly KnipSuppression[] {
  // Match the exported KNIP_SUPPRESSIONS array literal.
  const match = source.match(/export const KNIP_SUPPRESSIONS[^=]*=\s*(\[\]|\[[\s\S]*?\n\]);/);
  if (!match) {
    throw new Error(`Could not find KNIP_SUPPRESSIONS declaration in ${SUPPRESSIONS_SCRIPT_PATH}`);
  }
  const result = Function(`"use strict"; return (${match[1]});`)();
  if (!Array.isArray(result)) {
    throw new Error('KNIP_SUPPRESSIONS declaration is not an array');
  }
  return result as KnipSuppression[];
}

// ---------------------------------------------------------------------------
// Git helpers (for reason-restatement check)
// ---------------------------------------------------------------------------

function readFileAtRef(ref: string, relativePath: string): string | null {
  const result = spawnSync('git', ['show', `${ref}:${relativePath}`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function resolveBaseRef(): string | null {
  if (process.env.GITHUB_BASE_SHA) return process.env.GITHUB_BASE_SHA;

  for (const candidate of ['origin/main', 'main']) {
    const result = spawnSync('git', ['merge-base', 'HEAD', candidate], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  }

  return null;
}

/**
 * Compare the current `KNIP_SUPPRESSIONS` with the base-branch version and
 * return any reason-restatement violations.
 *
 * Returns an empty array when no base ref is available (e.g. a standalone
 * local run without `origin/main` fetched) — this is safe because the
 * reason-restatement check is advisory when no comparison is possible.
 */
export function getReasonRestatementViolationsForCurrentBranch(): Array<{
  file: string;
  previousExpiresOn: string;
  currentExpiresOn: string;
}> {
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    if (process.env.GITHUB_BASE_SHA) {
      throw new Error(
        'GITHUB_BASE_SHA is set but the base ref could not be resolved. ' +
          'Ensure the repository checkout includes the base commit (fetch-depth: 0).',
      );
    }
    return [];
  }

  const baseSrc = readFileAtRef(baseRef, SUPPRESSIONS_SCRIPT_PATH);
  if (!baseSrc) return []; // file didn't exist on base — no prior to compare

  let previousSuppressions: readonly KnipSuppression[];
  try {
    previousSuppressions = extractSuppressionsFromSource(baseSrc);
  } catch (err) {
    throw new Error(
      `Could not parse KNIP_SUPPRESSIONS from base ref ${baseRef}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return findReasonRestatementViolations(previousSuppressions, KNIP_SUPPRESSIONS);
}

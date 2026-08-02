// Review-ledger validator: the single source of truth for the apple-scaled
// review harness. Pure ESM (node built-ins only) so the copilot-guards
// `pr-review-ledger` guard can import it directly without tsx.
//
// A "review ledger" is a small JSON artifact committed under
// docs/knowledge/review-ledgers/ that records WHICH review stages a change
// went through (plan review, dual-plan synthesis, code review, multi-model
// review). The guard validates the ledger's COMPLETENESS for the declared
// apple tier — it deliberately does NOT try to verify truthfulness (that is
// an artifact-trust model, same as handoffs).
//
// See docs/agent-os/policies/review-harness-policy.md for the policy and
// .github/skills/review-harness/ for the operator playbook.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Current schema version, written by `review:ledger -- init`.
 *
 * v2 (2026-08-02) added the REQUIRED >=3🍎 `independent_grade` stage. Bumping
 * the version is what keeps the ~350 historical >=3🍎 v1 ledgers valid: the new
 * stage is required only on v2 ledgers (see `requiredStagesForApples`), so the
 * cutover is forward-only and no merged ledger is retroactively invalidated.
 */
export const SCHEMA_VERSION = 'review-ledger/v2';

/** Every schema version this validator accepts. */
export const LEGACY_SCHEMA_VERSION = 'review-ledger/v1';
export const SUPPORTED_SCHEMA_VERSIONS = [LEGACY_SCHEMA_VERSION, SCHEMA_VERSION];

export const LEDGER_DIR = 'docs/knowledge/review-ledgers';

// docs/knowledge/review-ledgers/YYYY-MM-DD-<slug>.review-ledger.json
export const LEDGER_PATH_RE =
  /^docs\/knowledge\/review-ledgers\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.review-ledger\.json$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Canonical review-stage names, in tier order.
 *
 * NOTE: `dual_plan_synthesis` is a LEGACY / OPTIONAL stage as of ADR 0051
 * (2026-07-08). It is no longer REQUIRED at any tier (see
 * `requiredStagesForApples`), but it stays in this list so the ~17 historical
 * ledgers that recorded it remain parseable + validated if present. New 4-5🍎
 * changes use an ADVERSARIAL `plan_review` instead — do NOT add
 * `dual_plan_synthesis` to a new ledger.
 */
export const STAGE_NAMES = [
  'plan_review',
  'dual_plan_synthesis',
  'code_review',
  'multi_model_review',
  'independent_grade',
];

/**
 * Criteria the independent grader scores, each on a 1..5 integer scale. The set
 * is fixed so grades are comparable across sessions and can be aggregated.
 */
export const GRADE_CRITERIA = [
  'correctness',
  'scope_discipline',
  'test_coverage',
  'policy_compliance',
  'maintainability',
];

/** Allowed `independent_grade.verdict` values. */
export const GRADE_VERDICTS = ['pass', 'fail'];

/**
 * Ledgers dated on or after this must declare the current schema version.
 * `independent_grade` became required at >=3🍎 on 2026-08-02, and the cutover is
 * the day AFTER so that ledgers already authored by in-flight sessions on the
 * cutover day are not retroactively invalidated. Every pre-cutover ledger
 * predates the stage and stays valid as `LEGACY_SCHEMA_VERSION`.
 */
export const SCHEMA_V2_CUTOVER_DATE = '2026-08-03';

/** Allowed `independent_grade` finding severities. Exact match only. */
export const GRADE_SEVERITIES = ['blocker', 'major', 'minor'];

/** A grade's `head_sha` must look like a real git object id, so a grade cannot
 * be recorded against a placeholder and then claimed to cover real code. */
export function isGitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim());
}

/** Allowed values for `plan_review.plan_divergence` — the fork-rate instrumentation signal (ADR 0051). */
export const PLAN_DIVERGENCE_VALUES = ['convergent', 'minor', 'major_fork'];

/** YYYY-MM-DD matcher for ledger dates (shared with the CLI). */
export { DATE_RE };

/** Kebab-case slug matcher for ledger filenames and session identifiers (shared with the CLI). */
export { SLUG_RE };

/**
 * Required review stages for a given apple estimate.
 *   1-2   -> (none; the ledger records the tier, no stages required)
 *   3     -> plan_review, code_review
 *   4-5   -> plan_review (adversarial), code_review, multi_model_review
 *
 * The plan-review floor was raised 2🍎 -> 3🍎 (2026-07-07) to match the
 * code-review floor, which already moved to 3🍎 on 2026-07-02 (ADR 0036 /
 * handoff docs/knowledge/handoffs/2026-07-02-streamline-verify-ci-gates.md).
 * A 2-apple change now records its tier but requires no review stages.
 *
 * `dual_plan_synthesis` was REMOVED from the required 4-5🍎 set (ADR 0051,
 * 2026-07-08): the 4-5🍎 `plan_review` is now ADVERSARIAL instead (one reviewer
 * enumerates >=2 alternatives + argues against the chosen design). The two
 * independent plan authors earned their 3x cost on only 2/17 historical
 * firings, so the redundant second author was folded into a stronger critic.
 * `dual_plan_synthesis` stays a validated LEGACY-OPTIONAL stage (see
 * STAGE_NAMES / validateDualPlanSynthesis) so historical ledgers stay parseable.
 * @param {number} apples
 * @returns {string[]}
 */
export function requiredStagesForApples(apples, schemaVersion = SCHEMA_VERSION) {
  // `independent_grade` is a v2-only requirement so pre-cutover v1 ledgers stay
  // valid (see SCHEMA_VERSION). An unknown/missing version is treated as v1 —
  // the schema_version error already fires separately.
  const graded = schemaVersion === 'review-ledger/v2' ? ['independent_grade'] : [];
  if (apples >= 4) {
    return ['plan_review', 'code_review', 'multi_model_review', ...graded];
  }
  if (apples >= 3) {
    return ['plan_review', 'code_review', ...graded];
  }
  return [];
}

/**
 * Every model id already involved in authoring or reviewing the change, drawn
 * from the other recorded stages. The independent grader must not be any of
 * them — "independent" is the entire point of the stage, and a grader that also
 * did the plan or code review would be marking its own homework.
 * @param {unknown} stages
 * @returns {string[]}
 */
export function priorReviewModels(stages) {
  if (!isPlainObject(stages)) return [];
  const models = [];
  const push = (v) => {
    if (isNonEmptyString(v)) models.push(v.trim());
  };
  const pushRounds = (stage) => {
    if (!isPlainObject(stage) || !Array.isArray(stage.rounds)) return;
    for (const round of stage.rounds) {
      if (isPlainObject(round) && Array.isArray(round.models)) round.models.forEach(push);
    }
  };
  if (isPlainObject(stages.plan_review)) push(stages.plan_review.reviewer_model);
  if (isPlainObject(stages.dual_plan_synthesis)) {
    const dps = stages.dual_plan_synthesis;
    if (Array.isArray(dps.plan_models)) dps.plan_models.forEach(push);
    push(dps.judge_model);
  }
  pushRounds(stages.code_review);
  pushRounds(stages.multi_model_review);
  if (isPlainObject(stages.multi_model_review)) push(stages.multi_model_review.adjudicator_model);
  return [...new Set(models)];
}

/** Normalize a repo-relative path to forward slashes, stripping a leading `./`. */
export function normalizeRepoPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True if `p` is a review-ledger path (docs/knowledge/review-ledgers/<date>-<slug>.review-ledger.json). */
export function isReviewLedgerPath(p) {
  return LEDGER_PATH_RE.test(normalizeRepoPath(p));
}

/** Filter a list of changed files down to the review-ledger artifacts. */
export function findReviewLedgerPaths(files) {
  if (!Array.isArray(files)) return [];
  return files.map(normalizeRepoPath).filter((f) => LEDGER_PATH_RE.test(f));
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function hasDistinct(arr) {
  return new Set(arr).size === arr.length;
}

function validatePlanReview(stage, errors, apples) {
  const tag = 'plan_review';
  if (!isPlainObject(stage)) {
    errors.push(`${tag}: must be an object`);
    return;
  }
  if (stage.completed !== true) errors.push(`${tag}.completed must be true`);
  if (!isNonEmptyString(stage.reviewer_model)) {
    errors.push(`${tag}.reviewer_model must be a non-empty string`);
  }
  if (!isNonNegInt(stage.concerns_count))
    errors.push(`${tag}.concerns_count must be an integer >= 0`);
  if (!isNonNegInt(stage.resolved_count))
    errors.push(`${tag}.resolved_count must be an integer >= 0`);
  if (isNonNegInt(stage.concerns_count) && isNonNegInt(stage.resolved_count)) {
    if (stage.resolved_count < stage.concerns_count) {
      errors.push(
        `${tag}: resolved_count (${stage.resolved_count}) must be >= concerns_count (${stage.concerns_count})`,
      );
    }
  }

  // Tier-conditional adversarial + instrumentation fields (ADR 0051).
  // `apples` is null/undefined when the estimate is invalid; the top-level
  // estimate error already fired, so we skip tier-conditional REQUIRES but
  // still type/enum-check any field that is present.
  const tier = Number.isInteger(apples) ? apples : null;
  const adversarialRequired = tier != null && tier >= 4;
  const divergenceRequired = tier != null && tier >= 3;

  // adversarial: required `true` at 4-5🍎 (the reviewer must red-team); boolean-if-present below.
  if (adversarialRequired) {
    if (stage.adversarial !== true) {
      errors.push(
        `${tag}.adversarial must be true at 4-5🍎 (reviewer must red-team: enumerate alternatives + argue against the chosen design)`,
      );
    }
  } else if (stage.adversarial !== undefined && typeof stage.adversarial !== 'boolean') {
    errors.push(`${tag}.adversarial must be a boolean if present`);
  }

  // alternatives_considered: required integer >= 2 at 4-5🍎; int>=0-if-present below.
  if (adversarialRequired) {
    if (!isNonNegInt(stage.alternatives_considered) || stage.alternatives_considered < 2) {
      errors.push(`${tag}.alternatives_considered must be an integer >= 2 at 4-5🍎`);
    }
  } else if (
    stage.alternatives_considered !== undefined &&
    !isNonNegInt(stage.alternatives_considered)
  ) {
    errors.push(`${tag}.alternatives_considered must be an integer >= 0 if present`);
  }

  // plan_divergence: required enum at 3🍎+ (whenever plan_review is a required
  // stage); enum-if-present below. The fork-rate instrumentation signal.
  if (divergenceRequired) {
    if (!PLAN_DIVERGENCE_VALUES.includes(stage.plan_divergence)) {
      errors.push(
        `${tag}.plan_divergence must be one of: ${PLAN_DIVERGENCE_VALUES.join(', ')} at 3🍎+`,
      );
    }
  } else if (
    stage.plan_divergence !== undefined &&
    !PLAN_DIVERGENCE_VALUES.includes(stage.plan_divergence)
  ) {
    errors.push(
      `${tag}.plan_divergence must be one of: ${PLAN_DIVERGENCE_VALUES.join(', ')} if present`,
    );
  }
}

function validateDualPlanSynthesis(stage, errors) {
  const tag = 'dual_plan_synthesis';
  if (!isPlainObject(stage)) {
    errors.push(`${tag}: must be an object`);
    return;
  }
  if (stage.completed !== true) errors.push(`${tag}.completed must be true`);
  const models = stage.plan_models;
  if (!Array.isArray(models) || models.length !== 2 || !models.every(isNonEmptyString)) {
    errors.push(`${tag}.plan_models must be an array of exactly 2 non-empty model ids`);
  } else if (!hasDistinct(models)) {
    errors.push(`${tag}.plan_models must be 2 DISTINCT models (got duplicate '${models[0]}')`);
  }
  if (!isNonEmptyString(stage.judge_model)) {
    errors.push(`${tag}.judge_model must be a non-empty string`);
  } else if (Array.isArray(models) && models.includes(stage.judge_model)) {
    errors.push(`${tag}.judge_model ('${stage.judge_model}') must differ from both plan_models`);
  }
}

function validateLastRoundCommon(stage, errors, tag) {
  if (!Array.isArray(stage.rounds) || stage.rounds.length < 1) {
    errors.push(`${tag}.rounds must be a non-empty array`);
    return null;
  }
  const last = stage.rounds[stage.rounds.length - 1];
  if (!isPlainObject(last)) {
    errors.push(`${tag}: last round must be an object`);
    return null;
  }
  if (last.clean !== true)
    errors.push(`${tag}: last round.clean must be true (loop until no concerns remain)`);
  return last;
}

/**
 * Validate the shape of a SINGLE round (models + non-negative-int counts). Used
 * per-round on the escalation path, where every attempted round must record its
 * provenance. The clean-terminal path keeps its historical last-round-only
 * checks (see validateCodeReview / validateMultiModelReview) so existing
 * single- and multi-round ledgers are unaffected.
 * @param {unknown} round
 * @param {string[]} errors
 * @param {string} tag
 * @param {number} idx
 * @param {{minModels:number, requireDistinct:boolean, countKeys:string[]}} opts
 */
function validateRoundShape(round, errors, tag, idx, { minModels, requireDistinct, countKeys }) {
  const where = `${tag}: round[${idx}]`;
  if (!isPlainObject(round)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (
    !Array.isArray(round.models) ||
    round.models.length < minModels ||
    !round.models.every(isNonEmptyString)
  ) {
    errors.push(`${where}.models must list >= ${minModels} non-empty model id(s)`);
  } else if (requireDistinct && !hasDistinct(round.models)) {
    errors.push(`${where}.models must be DISTINCT models`);
  }
  for (const k of countKeys) {
    if (!isNonNegInt(round[k])) errors.push(`${where}.${k} must be an integer >= 0`);
  }
  if (
    countKeys.includes('valid_count') &&
    countKeys.includes('concerns_count') &&
    isNonNegInt(round.valid_count) &&
    isNonNegInt(round.concerns_count) &&
    round.valid_count > round.concerns_count
  ) {
    errors.push(`${where}: valid_count must be <= concerns_count`);
  }
}

/**
 * Validate the terminal `escalated_to_human` state shared by code_review and
 * multi_model_review. This is the bounded-loop escape hatch: after >= 2
 * genuinely-attempted rounds still leave concerns, the stage may terminate by
 * escalating to a human instead of looping forever. It is NOT clean — it is a
 * recorded terminal state a human must act on.
 *
 * Requirements (all strengthening, none a silent skip):
 *   - stage.clean must be `false` (clean:true + escalation is a contradiction).
 *   - at least 2 attempted rounds (never escalate on round 1).
 *   - after_round is an integer that EQUALS the final round index (escalation
 *     is terminal — no rounds may follow it) and is >= 2.
 *   - reason is a non-empty string; unresolved_concerns is an integer >= 1.
 *   - the final round must be genuinely unresolved (not clean, and
 *     resolved_count below the relevant concern count) so the escalation is
 *     consistent with the recorded rounds.
 * @param {object} stage
 * @param {string[]} errors
 * @param {string} tag
 * @param {(last:object, errors:string[], tag:string)=>void} unresolvedCheck
 */
function validateEscalationTerminal(stage, errors, tag, unresolvedCheck) {
  if (stage.clean === true) {
    errors.push(
      `${tag}: escalated_to_human is incompatible with clean:true (escalation is NOT clean)`,
    );
  } else if (stage.clean !== false) {
    errors.push(`${tag}.clean must be false when escalated_to_human is present`);
  }

  const rounds = stage.rounds;
  const roundCount = Array.isArray(rounds) ? rounds.length : 0;
  if (roundCount < 2) {
    errors.push(
      `${tag}: escalated_to_human requires at least 2 attempted review rounds (never escalate on round 1)`,
    );
  }

  const esc = stage.escalated_to_human;
  if (!isPlainObject(esc)) {
    errors.push(`${tag}.escalated_to_human must be an object`);
    return;
  }
  if (
    !Number.isInteger(esc.after_round) ||
    esc.after_round < 2 ||
    (roundCount > 0 && esc.after_round !== roundCount)
  ) {
    errors.push(
      `${tag}.escalated_to_human.after_round (${JSON.stringify(esc.after_round)}) must equal the final round index (${roundCount}) and be >= 2 — escalation is terminal`,
    );
  }
  if (!isNonEmptyString(esc.reason)) {
    errors.push(`${tag}.escalated_to_human.reason must be a non-empty string`);
  }
  if (!Number.isInteger(esc.unresolved_concerns) || esc.unresolved_concerns < 1) {
    errors.push(`${tag}.escalated_to_human.unresolved_concerns must be an integer >= 1`);
  }

  if (roundCount >= 1) {
    const last = rounds[roundCount - 1];
    if (isPlainObject(last)) {
      if (last.clean === true) {
        errors.push(
          `${tag}: final round.clean must not be true when escalating (a clean round should resolve, not escalate)`,
        );
      }
      unresolvedCheck(last, errors, tag);
    }
  }
}

function validateCodeReview(stage, errors) {
  const tag = 'code_review';
  if (!isPlainObject(stage)) {
    errors.push(`${tag}: must be an object`);
    return;
  }
  // Escalation terminal state: bounded loop -> forced human attention.
  if (stage.escalated_to_human !== undefined) {
    if (!Array.isArray(stage.rounds) || stage.rounds.length < 1) {
      errors.push(`${tag}.rounds must be a non-empty array`);
    } else {
      stage.rounds.forEach((r, i) =>
        validateRoundShape(r, errors, tag, i, {
          minModels: 1,
          requireDistinct: false,
          countKeys: ['concerns_count', 'resolved_count'],
        }),
      );
    }
    validateEscalationTerminal(stage, errors, tag, (last, errs, t) => {
      if (
        isNonNegInt(last.concerns_count) &&
        isNonNegInt(last.resolved_count) &&
        last.resolved_count >= last.concerns_count
      ) {
        errs.push(
          `${t}: escalated_to_human requires unresolved concerns in the final round (resolved_count < concerns_count)`,
        );
      }
    });
    return;
  }
  // Clean terminal state (loop until no concerns remain).
  if (stage.clean !== true) errors.push(`${tag}.clean must be true`);
  const last = validateLastRoundCommon(stage, errors, tag);
  if (!last) return;
  if (
    !Array.isArray(last.models) ||
    last.models.length < 1 ||
    !last.models.every(isNonEmptyString)
  ) {
    errors.push(`${tag}: last round.models must list >= 1 non-empty model id`);
  }
  if (!isNonNegInt(last.concerns_count))
    errors.push(`${tag}: last round.concerns_count must be an integer >= 0`);
  if (!isNonNegInt(last.resolved_count))
    errors.push(`${tag}: last round.resolved_count must be an integer >= 0`);
  if (
    isNonNegInt(last.concerns_count) &&
    isNonNegInt(last.resolved_count) &&
    last.resolved_count < last.concerns_count
  ) {
    errors.push(`${tag}: last round.resolved_count must be >= concerns_count`);
  }
}

function validateMultiModelReview(stage, errors) {
  const tag = 'multi_model_review';
  if (!isPlainObject(stage)) {
    errors.push(`${tag}: must be an object`);
    return;
  }
  if (!isNonEmptyString(stage.adjudicator_model)) {
    errors.push(`${tag}.adjudicator_model must be a non-empty string`);
  }
  // Escalation terminal state: bounded loop -> forced human attention.
  if (stage.escalated_to_human !== undefined) {
    if (!Array.isArray(stage.rounds) || stage.rounds.length < 1) {
      errors.push(`${tag}.rounds must be a non-empty array`);
    } else {
      stage.rounds.forEach((r, i) =>
        validateRoundShape(r, errors, tag, i, {
          minModels: 2,
          requireDistinct: true,
          countKeys: ['concerns_count', 'valid_count', 'resolved_count'],
        }),
      );
    }
    validateEscalationTerminal(stage, errors, tag, (last, errs, t) => {
      if (
        isNonNegInt(last.valid_count) &&
        isNonNegInt(last.resolved_count) &&
        last.resolved_count >= last.valid_count
      ) {
        errs.push(
          `${t}: escalated_to_human requires unresolved valid concerns in the final round (resolved_count < valid_count)`,
        );
      }
    });
    return;
  }
  // Clean terminal state (loop until no concerns remain).
  if (stage.clean !== true) errors.push(`${tag}.clean must be true`);
  const last = validateLastRoundCommon(stage, errors, tag);
  if (!last) return;
  if (
    !Array.isArray(last.models) ||
    last.models.length < 2 ||
    !last.models.every(isNonEmptyString)
  ) {
    errors.push(`${tag}: last round.models must list >= 2 non-empty model ids`);
  } else if (!hasDistinct(last.models)) {
    errors.push(`${tag}: last round.models must be DISTINCT models`);
  }
  for (const k of ['concerns_count', 'valid_count', 'resolved_count']) {
    if (!isNonNegInt(last[k])) errors.push(`${tag}: last round.${k} must be an integer >= 0`);
  }
  if (
    isNonNegInt(last.concerns_count) &&
    isNonNegInt(last.valid_count) &&
    last.valid_count > last.concerns_count
  ) {
    errors.push(`${tag}: last round.valid_count must be <= concerns_count`);
  }
  if (
    isNonNegInt(last.valid_count) &&
    isNonNegInt(last.resolved_count) &&
    last.resolved_count < last.valid_count
  ) {
    errors.push(`${tag}: last round.resolved_count must be >= valid_count`);
  }
}

/**
 * Validate the `independent_grade` stage — the compensating control introduced
 * alongside dropping the 1-2🍎 ledger requirement (schema v2).
 *
 * Unlike the other stages, this one is graded from the ACTUAL DIFF by a model
 * that took no part in authoring or reviewing the change. Requirements:
 *   - `grader_model` is non-empty AND distinct from every model recorded in the
 *     other stages (see `priorReviewModels`).
 *   - `head_sha` records WHICH tree was graded, so a grade cannot be silently
 *     carried across a rewrite.
 *   - every criterion in GRADE_CRITERIA is scored with an integer 1..5.
 *   - `verdict` is `pass` or `fail`; a `fail` is NOT a dead end but it is also
 *     NOT a silent pass — it must carry the same terminal `escalated_to_human`
 *     record the review loops use, so a human is forced to look.
 * @param {unknown} stage
 * @param {string[]} errors
 * @param {number|null} _apples
 * @param {{stages?:unknown}} [ctx]
 */
function validateIndependentGrade(stage, errors, _apples, ctx = {}) {
  const tag = 'independent_grade';
  if (!isPlainObject(stage)) {
    errors.push(`${tag}: must be an object`);
    return;
  }
  if (stage.completed !== true) errors.push(`${tag}.completed must be true`);

  if (!isNonEmptyString(stage.grader_model)) {
    errors.push(`${tag}.grader_model must be a non-empty string`);
  } else {
    const prior = priorReviewModels(ctx.stages);
    if (prior.includes(stage.grader_model.trim())) {
      errors.push(
        `${tag}.grader_model ('${stage.grader_model}') must be INDEPENDENT — it already appears in another review stage (${prior.join(', ')})`,
      );
    }
  }

  if (!isNonEmptyString(stage.implementer_model)) {
    errors.push(
      `${tag}.implementer_model must name the model that AUTHORED the change, so grader independence from the author is checkable`,
    );
  } else if (
    isNonEmptyString(stage.grader_model) &&
    stage.implementer_model.trim() === stage.grader_model.trim()
  ) {
    errors.push(
      `${tag}.grader_model ('${stage.grader_model}') must be INDEPENDENT — it is the model that authored the change`,
    );
  }

  if (!isGitSha(stage.head_sha)) {
    errors.push(`${tag}.head_sha must be a 7-40 character hex git sha identifying the graded tree`);
  }

  const criteria = stage.criteria;
  if (!isPlainObject(criteria)) {
    errors.push(`${tag}.criteria must be an object scoring: ${GRADE_CRITERIA.join(', ')}`);
  } else {
    for (const key of GRADE_CRITERIA) {
      const score = criteria[key];
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        errors.push(`${tag}.criteria.${key} must be an integer 1..5`);
      }
    }
    const unknown = Object.keys(criteria).filter((k) => !GRADE_CRITERIA.includes(k));
    if (unknown.length > 0) {
      errors.push(`${tag}.criteria has unknown criteria: ${unknown.join(', ')}`);
    }
  }

  if (!GRADE_VERDICTS.includes(stage.verdict)) {
    errors.push(`${tag}.verdict must be one of: ${GRADE_VERDICTS.join(', ')}`);
  }

  if (!isNonNegInt(stage.findings_count)) {
    errors.push(`${tag}.findings_count must be an integer >= 0`);
  } else if (stage.findings_count > 0 && stage.findings === undefined) {
    errors.push(`${tag}.findings must be present when findings_count is non-zero`);
  }

  // `parseGradeResponse` recomputes the verdict from the scores and findings,
  // but the guard trusts THIS validator, not the CLI — a hand-authored ledger
  // would otherwise be able to claim `pass` over failing scores or an
  // unaddressed blocker. Re-derive the same rule here so the two agree.
  let findings = null;
  if (stage.findings !== undefined) {
    if (!Array.isArray(stage.findings)) {
      errors.push(`${tag}.findings must be an array`);
    } else {
      findings = stage.findings;
      stage.findings.forEach((finding, i) => {
        if (!isPlainObject(finding)) {
          errors.push(`${tag}.findings[${i}] must be an object`);
          return;
        }
        if (!GRADE_SEVERITIES.includes(finding.severity)) {
          errors.push(
            `${tag}.findings[${i}].severity must be exactly one of: ${GRADE_SEVERITIES.join(', ')}`,
          );
        }
        if (!isNonEmptyString(finding.file)) {
          errors.push(`${tag}.findings[${i}].file must be a non-empty string`);
        }
        if (!isNonEmptyString(finding.detail)) {
          errors.push(`${tag}.findings[${i}].detail must be a non-empty string`);
        }
      });
      if (isNonNegInt(stage.findings_count) && stage.findings.length !== stage.findings_count) {
        errors.push(
          `${tag}.findings_count (${stage.findings_count}) must equal findings.length (${stage.findings.length})`,
        );
      }
    }
  }

  if (stage.verdict === 'pass') {
    const low = isPlainObject(criteria)
      ? GRADE_CRITERIA.filter((c) => Number.isInteger(criteria[c]) && criteria[c] < 3)
      : [];
    if (low.length > 0) {
      errors.push(
        `${tag}.verdict cannot be 'pass' with criteria below 3: ${low.join(', ')} — a low score is a failing grade`,
      );
    }
    const blockers = (findings ?? []).filter(
      (f) => isPlainObject(f) && f.severity === 'blocker',
    ).length;
    if (blockers > 0) {
      errors.push(
        `${tag}.verdict cannot be 'pass' with ${blockers} unresolved blocker finding(s) — fix them and re-grade`,
      );
    }
  }

  // A failing grade is a terminal state a human must act on — never a silent
  // pass, and never a reason to weaken the grade (project rule #11).
  if (stage.verdict === 'fail') {
    const esc = stage.escalated_to_human;
    if (!isPlainObject(esc)) {
      errors.push(
        `${tag}: verdict 'fail' requires an escalated_to_human record { reason, unresolved_findings } — fix the findings and re-grade, or escalate to a human`,
      );
    } else {
      if (!isNonEmptyString(esc.reason)) {
        errors.push(`${tag}.escalated_to_human.reason must be a non-empty string`);
      }
      if (!Number.isInteger(esc.unresolved_findings) || esc.unresolved_findings < 1) {
        errors.push(`${tag}.escalated_to_human.unresolved_findings must be an integer >= 1`);
      }
    }
  } else if (stage.escalated_to_human !== undefined) {
    errors.push(`${tag}.escalated_to_human is only valid alongside verdict 'fail'`);
  }
}

const STAGE_VALIDATORS = {
  plan_review: validatePlanReview,
  dual_plan_synthesis: validateDualPlanSynthesis,
  code_review: validateCodeReview,
  multi_model_review: validateMultiModelReview,
  independent_grade: validateIndependentGrade,
};

/**
 * Validate a parsed ledger object.
 * @param {unknown} obj
 * @returns {{ok:boolean, estimatedApples:number|null, requiredStages:string[], errors:string[], summary:string}}
 */
export function validateLedger(obj, opts = {}) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return {
      ok: false,
      estimatedApples: null,
      requiredStages: [],
      errors: ['ledger must be a JSON object'],
      summary: 'invalid ledger (not an object)',
    };
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(obj.schema_version)) {
    errors.push(
      `schema_version must be one of: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')} (got ${JSON.stringify(obj.schema_version)}); new ledgers use '${SCHEMA_VERSION}'`,
    );
  }
  if (!isNonEmptyString(obj.date) || !DATE_RE.test(obj.date)) {
    errors.push('date must be a YYYY-MM-DD string');
  } else if (opts.requireCurrentSchema === true && obj.schema_version !== SCHEMA_VERSION) {
    errors.push(
      `schema_version must be '${SCHEMA_VERSION}' for newly added ledgers at PR/guard boundaries (got ${JSON.stringify(obj.schema_version)}); '${LEGACY_SCHEMA_VERSION}' is accepted only for historical corpus validation`,
    );
  } else if (obj.date >= SCHEMA_V2_CUTOVER_DATE && obj.schema_version !== SCHEMA_VERSION) {
    // v1 is accepted ONLY as history. Without this, a new >=3🍎 ledger could
    // simply declare v1 and skip `independent_grade` entirely, since the v2
    // gate in requiredStagesForApples() keys off the declared version.
    errors.push(
      `schema_version must be '${SCHEMA_VERSION}' for ledgers dated ${SCHEMA_V2_CUTOVER_DATE} or later (got ${JSON.stringify(obj.schema_version)}); '${LEGACY_SCHEMA_VERSION}' is accepted only for pre-cutover ledgers`,
    );
  }
  if (!isNonEmptyString(obj.session_slug) || !SLUG_RE.test(obj.session_slug)) {
    errors.push('session_slug must be a kebab-case string');
  }
  if (!isNonEmptyString(obj.task_title)) {
    errors.push('task_title must be a non-empty string');
  }

  let estimatedApples = null;
  let requiredStages = [];
  if (
    !Number.isInteger(obj.estimated_apples) ||
    obj.estimated_apples < 1 ||
    obj.estimated_apples > 5
  ) {
    errors.push('estimated_apples must be an integer 1..5');
  } else {
    estimatedApples = obj.estimated_apples;
    requiredStages = requiredStagesForApples(estimatedApples, obj.schema_version);
  }

  // Downward-only, diff-justified re-scoring. An apple estimate may be revised
  // AFTER planning, but ONLY strictly downward and ONLY when the actual diff
  // justifies it (honor-system + policy text — not mechanically provable). A
  // downward re-score makes required stages follow the NEW lower tier. Upward
  // or no-op re-scores are rejected outright.
  if (obj.apples_rescored_from !== undefined) {
    const from = obj.apples_rescored_from;
    if (!Number.isInteger(from) || from < 1 || from > 5) {
      errors.push('apples_rescored_from must be an integer 1..5 when present');
    } else if (estimatedApples != null && from <= estimatedApples) {
      errors.push(
        `apples_rescored_from (${from}) must be strictly greater than estimated_apples (${estimatedApples}) — re-scoring is downward-only`,
      );
    }
    if (!isNonEmptyString(obj.rescore_reason)) {
      errors.push('rescore_reason must be a non-empty string when apples_rescored_from is present');
    }
  } else if (obj.rescore_reason !== undefined) {
    errors.push('rescore_reason is only valid alongside apples_rescored_from');
  }

  const stages = obj.stages;
  if (!isPlainObject(stages)) {
    errors.push('stages must be an object');
  } else {
    for (const name of STAGE_NAMES) {
      const required = requiredStages.includes(name);
      const present = stages[name] != null;
      if (required && !present) {
        errors.push(`required stage '${name}' is missing for a ${estimatedApples}-apple change`);
        continue;
      }
      if (present) {
        // Thread the declared tier so tier-conditional validators
        // (validatePlanReview) can enforce per-tier field rules, and the whole
        // stage map so cross-stage validators (validateIndependentGrade's
        // model-independence check) can see the other stages. Validators that
        // need neither ignore the extra args.
        STAGE_VALIDATORS[name](stages[name], errors, estimatedApples, { stages });
      }
    }
  }

  const ok = errors.length === 0;
  const applesLabel = estimatedApples == null ? '?' : String(estimatedApples);
  const summary = ok
    ? `valid ${applesLabel}-apple ledger (stages: ${requiredStages.join(', ')})`
    : `invalid ledger: ${errors.length} problem(s)`;
  return { ok, estimatedApples, requiredStages, errors, summary };
}

/** Parse + validate ledger JSON text. */
export function validateLedgerText(text, opts = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      estimatedApples: null,
      requiredStages: [],
      errors: [`invalid JSON: ${err.message}`],
      summary: 'invalid ledger (JSON parse error)',
    };
  }
  return validateLedger(parsed, opts);
}

/** Read + validate a ledger file. `filePath` may be absolute or relative to `cwd`. */
export function validateLedgerFile(filePath, cwd = '.', opts = {}) {
  let text;
  try {
    text = readFileSync(resolve(cwd, filePath), 'utf-8');
  } catch (err) {
    return {
      ok: false,
      estimatedApples: null,
      requiredStages: [],
      errors: [`cannot read ledger ${filePath}: ${err.message}`],
      summary: 'invalid ledger (read error)',
    };
  }
  return validateLedgerText(text, opts);
}

/** Format a validation result for human/CLI output. */
export function formatLedgerResult(result, label = 'ledger') {
  const head = result.ok ? `✅ ${label}: ${result.summary}` : `❌ ${label}: ${result.summary}`;
  if (result.ok) return head;
  const lines = [head];
  for (const e of result.errors) lines.push(`   • ${e}`);
  return lines.join('\n');
}

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

export const SCHEMA_VERSION = 'review-ledger/v1';
export const LEDGER_DIR = 'docs/knowledge/review-ledgers';

// docs/knowledge/review-ledgers/YYYY-MM-DD-<slug>.review-ledger.json
export const LEDGER_PATH_RE =
  /^docs\/knowledge\/review-ledgers\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.review-ledger\.json$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Canonical review-stage names, in tier order. */
export const STAGE_NAMES = [
  'plan_review',
  'dual_plan_synthesis',
  'code_review',
  'multi_model_review',
];

/** YYYY-MM-DD matcher for ledger dates (shared with the CLI). */
export { DATE_RE };

/** Kebab-case slug matcher for ledger filenames and session identifiers (shared with the CLI). */
export { SLUG_RE };

/**
 * Required review stages for a given apple estimate.
 *   1     -> code_review
 *   2-3   -> plan_review, code_review
 *   4-5   -> plan_review, dual_plan_synthesis, code_review, multi_model_review
 * @param {number} apples
 * @returns {string[]}
 */
export function requiredStagesForApples(apples) {
  if (apples >= 4) {
    return ['plan_review', 'dual_plan_synthesis', 'code_review', 'multi_model_review'];
  }
  if (apples >= 2) {
    return ['plan_review', 'code_review'];
  }
  return ['code_review'];
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

function validatePlanReview(stage, errors) {
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

function validateCodeReview(stage, errors) {
  const tag = 'code_review';
  if (!isPlainObject(stage)) {
    errors.push(`${tag}: must be an object`);
    return;
  }
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
  if (stage.clean !== true) errors.push(`${tag}.clean must be true`);
  if (!isNonEmptyString(stage.adjudicator_model)) {
    errors.push(`${tag}.adjudicator_model must be a non-empty string`);
  }
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

const STAGE_VALIDATORS = {
  plan_review: validatePlanReview,
  dual_plan_synthesis: validateDualPlanSynthesis,
  code_review: validateCodeReview,
  multi_model_review: validateMultiModelReview,
};

/**
 * Validate a parsed ledger object.
 * @param {unknown} obj
 * @returns {{ok:boolean, estimatedApples:number|null, requiredStages:string[], errors:string[], summary:string}}
 */
export function validateLedger(obj) {
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

  if (obj.schema_version !== SCHEMA_VERSION) {
    errors.push(
      `schema_version must be '${SCHEMA_VERSION}' (got ${JSON.stringify(obj.schema_version)})`,
    );
  }
  if (!isNonEmptyString(obj.date) || !DATE_RE.test(obj.date)) {
    errors.push('date must be a YYYY-MM-DD string');
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
    requiredStages = requiredStagesForApples(estimatedApples);
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
        STAGE_VALIDATORS[name](stages[name], errors);
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
export function validateLedgerText(text) {
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
  return validateLedger(parsed);
}

/** Read + validate a ledger file. `filePath` may be absolute or relative to `cwd`. */
export function validateLedgerFile(filePath, cwd = '.') {
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
  return validateLedgerText(text);
}

/** Format a validation result for human/CLI output. */
export function formatLedgerResult(result, label = 'ledger') {
  const head = result.ok ? `✅ ${label}: ${result.summary}` : `❌ ${label}: ${result.summary}`;
  if (result.ok) return head;
  const lines = [head];
  for (const e of result.errors) lines.push(`   • ${e}`);
  return lines.join('\n');
}

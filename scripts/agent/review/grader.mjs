// Independent grader for the apple-scaled review harness (>=3🍎).
//
// WHY THIS EXISTS
// ---------------
// Dropping the 1-2🍎 ledger requirement necessarily softened the
// `pr-review-ledger` guard: the apple tier is only readable FROM a ledger, so a
// MISSING ledger can no longer be a hard deny. The compensating control is this
// grader — a model that took NO part in authoring or reviewing the change reads
// the ACTUAL DIFF (not the ledger's self-report) and scores it against a fixed
// rubric. Its verdict is recorded as the required >=3🍎 `independent_grade`
// stage, so the remaining ledger gate now rests on an outside opinion rather
// than purely on self-attestation.
//
// SHAPE
// -----
// Like every other harness stage, the model call itself is dispatched by the
// AGENT (via the `task` tool with an explicitly different model), not by this
// script — nothing here calls a model API. This module owns the deterministic,
// unit-testable half:
//
//   1. `collectDiff`         — the real diff for the branch (git, merge-base vs main).
//   2. `buildGradingPacket`  — the exact prompt + rubric handed to the grader model.
//   3. `parseGradeResponse`  — parse the model's JSON reply into a stage object.
//   4. `applyGradeToLedger`  — merge that stage into the ledger.
//
// Pure ESM (node built-ins only), matching ledger.mjs, so it can be `node --test`ed.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GRADE_CRITERIA, GRADE_VERDICTS, priorReviewModels } from './ledger.mjs';

/** Truncation ceiling for the diff embedded in the prompt (characters). */
export const DEFAULT_DIFF_CHAR_LIMIT = 200_000;

/**
 * What each criterion means. Kept next to the criteria list so the rubric the
 * grader sees and the criteria the validator enforces can never drift apart.
 */
export const GRADE_RUBRIC = {
  correctness:
    'Does the change actually do what it claims, including edge cases, error paths, and state/ordering? 1 = provably broken, 5 = correct with edge cases handled.',
  scope_discipline:
    'Is the diff the smallest correct change for the stated task, with no unrelated refactors or drive-by rewrites? 1 = sprawling, 5 = surgical.',
  test_coverage:
    'Are the changed behaviors covered by tests that would fail without the change, and is existing coverage preserved? 1 = none, 5 = every changed behavior covered.',
  policy_compliance:
    'Does it obey the repo rules that apply to the touched paths (determinism/SeededRandom, no Date.now(), layer import boundaries, systems wired sim-side, labs for new systems)? 1 = violates, 5 = fully compliant.',
  maintainability:
    'Will the next agent understand and safely change this? Naming, structure, comments where non-obvious, no dead or duplicated code. 1 = opaque, 5 = clear.',
};

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Resolve the base commit to diff against: the merge-base with the given base
 * ref (default `main`, falling back to `origin/main`).
 * @param {{cwd?:string, baseRef?:string, runGit?:(cwd:string,args:string[])=>string}} [opts]
 * @returns {string}
 */
export function resolveBase({ cwd = '.', baseRef = 'main', runGit = git } = {}) {
  const candidates = [baseRef, `origin/${baseRef}`, `refs/remotes/origin/${baseRef}`];
  const failures = [];
  for (const ref of candidates) {
    try {
      return runGit(cwd, ['merge-base', 'HEAD', ref]).trim();
    } catch (err) {
      failures.push(`${ref}: ${err.message}`);
    }
  }
  throw new Error(`could not resolve a merge-base against '${baseRef}' (${failures.join('; ')})`);
}

/**
 * Collect the branch's real diff, plus its file list and head sha. This is what
 * makes the grade independent of the ledger's self-report.
 * @param {{cwd?:string, baseRef?:string, runGit?:(cwd:string,args:string[])=>string, diffCharLimit?:number}} [opts]
 * @returns {{baseSha:string, headSha:string, files:string[], diff:string, truncated:boolean}}
 */
export function collectDiff({
  cwd = '.',
  baseRef = 'main',
  runGit = git,
  diffCharLimit = DEFAULT_DIFF_CHAR_LIMIT,
} = {}) {
  const baseSha = resolveBase({ cwd, baseRef, runGit });
  const headSha = runGit(cwd, ['rev-parse', 'HEAD']).trim();
  const files = runGit(cwd, ['diff', '--name-only', `${baseSha}..HEAD`])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  const full = runGit(cwd, ['diff', `${baseSha}..HEAD`]);
  const truncated = full.length > diffCharLimit;
  return {
    baseSha,
    headSha,
    files,
    diff: truncated ? `${full.slice(0, diffCharLimit)}\n\n[... diff truncated ...]` : full,
    truncated,
  };
}

/** The exact JSON the grader model must return. */
export function responseSchemaText() {
  const criteria = GRADE_CRITERIA.map((c) => `    "${c}": <integer 1..5>`).join(',\n');
  return [
    '{',
    '  "criteria": {',
    criteria,
    '  },',
    `  "verdict": "${GRADE_VERDICTS.join('" | "')}",`,
    '  "findings": [',
    '    { "severity": "blocker" | "major" | "minor", "file": "<path>", "detail": "<what is wrong and the smallest correct remedy>" }',
    '  ],',
    '  "notes": "<one paragraph justifying the verdict>"',
    '}',
  ].join('\n');
}

/**
 * Build the full grading packet handed to the independent grader model.
 *
 * The packet deliberately includes the models that already reviewed this change
 * so the dispatching agent can pick a genuinely different one — the ledger
 * validator rejects a `grader_model` that appears in any other stage.
 *
 * @param {{ledger:object, diff:{files:string[],diff:string,headSha:string,baseSha:string,truncated:boolean}}} args
 * @returns {{prompt:string, headSha:string, excludedModels:string[], criteria:string[]}}
 */
export function buildGradingPacket({ ledger, diff }) {
  const excludedModels = priorReviewModels(ledger?.stages);
  const apples = ledger?.estimated_apples;
  const rubric = GRADE_CRITERIA.map((c) => `- **${c}** — ${GRADE_RUBRIC[c]}`).join('\n');
  const fileList = diff.files.map((f) => `  • ${f}`).join('\n') || '  (no files)';

  const prompt = [
    'You are an INDEPENDENT grader for a change in the Crawler repository. You did not',
    'write this change and you did not review it. Grade the DIFF ITSELF — do not trust',
    "any summary, commit message, or the change author's own description of it.",
    '',
    `Task: ${ledger?.task_title ?? '(untitled)'}`,
    `Declared complexity: ${apples ?? '?'} apple(s)`,
    `Graded tree: ${diff.headSha} (base ${diff.baseSha})`,
    diff.truncated
      ? 'NOTE: the diff below was truncated; grade what you can see and say so in notes.'
      : null,
    '',
    `Changed files (${diff.files.length}):`,
    fileList,
    '',
    'Score each criterion as an integer 1..5:',
    rubric,
    '',
    'Verdict rules:',
    '- "pass" only if NO criterion scores below 3 and you found no blocker-severity finding.',
    '- "fail" otherwise. A fail is not a rejection of the work; it forces a human to look.',
    '- Report only high-confidence, actionable findings. No style or formatting nits.',
    '',
    'Reply with ONE fenced ```json block and nothing else, matching exactly:',
    '```json',
    responseSchemaText(),
    '```',
    '',
    'DIFF:',
    '```diff',
    diff.diff,
    '```',
  ]
    // Only the conditional truncation notice is dropped (null); intentional
    // blank separators are kept so the prompt stays readable.
    .filter((line) => line !== null)
    .join('\n');

  return { prompt, headSha: diff.headSha, excludedModels, criteria: [...GRADE_CRITERIA] };
}

/**
 * Extract the JSON object from a model reply. Accepts a bare JSON object or one
 * wrapped in a fenced code block (with or without a `json` language tag), which
 * is what models actually emit.
 * @param {string} text
 * @returns {unknown}
 */
export function extractJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('grader response is empty');
  }
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('grader response contains no JSON object');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function countBySeverity(findings, severity) {
  return findings.filter((f) => f && f.severity === severity).length;
}

/**
 * Parse a grader model's reply into the `independent_grade` ledger stage.
 *
 * The verdict is RECOMPUTED from the scores and findings rather than taken on
 * the model's word: a reply that scores a criterion below 3, or reports a
 * blocker, cannot be recorded as a pass. That keeps the stage from being
 * softened by a model that hedges (project rule #11 applies to graders too).
 *
 * @param {string} text - raw model reply
 * @param {{graderModel:string, headSha:string}} meta
 * @returns {{stage:object, findings:object[], verdictOverridden:boolean}}
 */
export function parseGradeResponse(text, { graderModel, headSha }) {
  if (typeof graderModel !== 'string' || graderModel.trim() === '') {
    throw new Error('graderModel is required');
  }
  if (typeof headSha !== 'string' || headSha.trim() === '') {
    throw new Error('headSha is required');
  }
  const parsed = extractJson(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('grader response must be a JSON object');
  }

  const rawCriteria =
    typeof parsed.criteria === 'object' && parsed.criteria !== null ? parsed.criteria : {};
  const criteria = {};
  const missing = [];
  for (const key of GRADE_CRITERIA) {
    const score = rawCriteria[key];
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      missing.push(key);
      continue;
    }
    criteria[key] = score;
  }
  if (missing.length > 0) {
    throw new Error(`grader response is missing valid 1..5 scores for: ${missing.join(', ')}`);
  }

  const findings = Array.isArray(parsed.findings) ? parsed.findings.filter(Boolean) : [];
  const claimed = GRADE_VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'fail';
  const lowScore = GRADE_CRITERIA.some((c) => criteria[c] < 3);
  const blockers = countBySeverity(findings, 'blocker');
  const earned = lowScore || blockers > 0 ? 'fail' : claimed;

  const stage = {
    completed: true,
    grader_model: graderModel.trim(),
    head_sha: headSha.trim(),
    criteria,
    verdict: earned,
    findings_count: findings.length,
    ...(typeof parsed.notes === 'string' && parsed.notes.trim() !== ''
      ? { notes: parsed.notes.trim() }
      : {}),
  };

  if (earned === 'fail') {
    const reasons = [];
    if (lowScore) {
      reasons.push(`criteria below 3: ${GRADE_CRITERIA.filter((c) => criteria[c] < 3).join(', ')}`);
    }
    if (blockers > 0) reasons.push(`${blockers} blocker finding(s)`);
    if (reasons.length === 0) reasons.push('grader returned a failing verdict');
    stage.escalated_to_human = {
      reason: reasons.join('; '),
      unresolved_findings: Math.max(1, findings.length),
    };
  }

  return { stage, findings, verdictOverridden: earned !== claimed };
}

/**
 * Merge an `independent_grade` stage into a ledger object (non-mutating).
 * @param {object} ledger
 * @param {object} stage
 * @returns {object}
 */
export function applyGradeToLedger(ledger, stage) {
  return { ...ledger, stages: { ...(ledger?.stages ?? {}), independent_grade: stage } };
}

/** Read + parse a ledger JSON file. */
export function readLedger(path, cwd = '.') {
  return JSON.parse(readFileSync(resolve(cwd, path), 'utf-8'));
}

/** Human-readable one-line summary of a recorded grade. */
export function formatGrade(stage) {
  const scores = GRADE_CRITERIA.map((c) => `${c}=${stage.criteria?.[c] ?? '?'}`).join(' ');
  const mark = stage.verdict === 'pass' ? '✅' : '❌';
  return `${mark} independent_grade: ${stage.verdict} by ${stage.grader_model} @ ${String(
    stage.head_sha,
  ).slice(0, 8)} — ${scores} (${stage.findings_count} finding(s))`;
}

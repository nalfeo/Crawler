// pr-review-ledger: hard-denies create_pull_request for a code-touching branch
// that committed an INCOMPLETE or INVALID review ledger.
//
// The ledger (docs/knowledge/review-ledgers/YYYY-MM-DD-<slug>.review-ledger.json)
// records WHICH apple-scaled review stages the change went through. This guard
// validates COMPLETENESS for the declared apple tier — it does not (and cannot)
// verify truthfulness; that is an artifact-trust model, same as the handoff
// requirement in pr-preflight.
//
// A MISSING ledger no longer denies. 1–2🍎 changes require no review stages, so
// their ledgers were content-free files that existed only to satisfy this guard
// (49% of the committed corpus). The tier is only knowable FROM the ledger, so
// dropping the low-tier file necessarily makes the ≥3🍎 ledger an artifact-trust
// gate rather than a hard one — a missing ledger now surfaces a reminder instead.
// The compensating control is the independent grader (`npm run review:grade`),
// whose `independent_grade` stage is a REQUIRED ≥3🍎 stage validated here.
//
// Scope: only code-touching diffs. Docs-only / art-only / dependency-lockfile-
// only diffs are skipped (see lib/pr-scope.mjs for the strict allowlist).
//
// failClosed: true — an unexpected crash denies (this guard is a hard gate).
// The ONE intentional allow-through is a git failure (shallow clone, detached
// state), surfaced as additionalContext so a human can verify manually.
//
// Bypass (genuine edge cases): COPILOT_GUARDS_DISABLE=pr-review-ledger.

import { branchFiles, branchAddedFiles } from '../lib/git.mjs';
import { isNonCodeOnlyDiff, codeFiles } from '../lib/pr-scope.mjs';
import {
  findReviewLedgerPaths,
  validateLedgerFile,
  formatLedgerResult,
  LEDGER_DIR,
} from '../../../../scripts/agent/review/ledger.mjs';

function missingLedgerNotice(files) {
  const code = codeFiles(files);
  const shown = code.slice(0, 12);
  const more = code.length > 12 ? ` (+${code.length - 12} more)` : '';
  return [
    `pr-review-ledger: no review ledger on this code-touching branch. That is CORRECT for a 1–2🍎 change (no review stages are required, so no ledger is needed). If you estimated this change at 3🍎 or more, per docs/agent-os/policies/review-harness-policy.md you MUST commit one under ${LEDGER_DIR}/ before merging.`,
    '',
    `Code files in this diff:\n${shown.map((f) => `  • ${f}`).join('\n')}${more}`,
    '',
    'If this is ≥3🍎, author one with the review-harness skill, then commit it on this branch:',
    '  npm run review:ledger -- init --apples <3..5> --slug <kebab-slug> --title "<title>"',
    "  npm run review:ledger -- stage <path> <stage> --json '{...}'   # per review stage",
    '  npm run review:grade -- <path>                                 # independent grader',
    '  npm run review:ledger -- validate <path>',
    '',
    'Required stages by apple tier: 1–2 → (none, no ledger); 3 → plan_review + code_review + independent_grade; 4–5 → + multi_model_review (the plan_review must be ADVERSARIAL — see ADR 0051).',
  ].join('\n');
}

/**
 * Pure decision logic — given the branch's changed/added files, decide whether
 * a review ledger is required and present. `validateFile` is injectable for
 * tests; by default it reads + validates the on-disk ledger.
 *
 * @param {string[]} files - all files changed on the branch
 * @param {string[]} addedFiles - files ADDED on the branch
 * @param {{cwd?:string, validateFile?:(p:string)=>{ok:boolean,summary:string,errors:string[]}}} [opts]
 * @returns {{decision:'allow'|'deny'|'skip', reason?:string, additionalContext?:string}}
 */
function decideLedger(files, addedFiles, opts = {}) {
  const cwd = opts.cwd || '.';
  const validateFile = opts.validateFile || ((p) => validateLedgerFile(p, cwd));

  if (!Array.isArray(files) || files.length === 0) {
    return { decision: 'skip' };
  }
  if (isNonCodeOnlyDiff(files)) {
    return {
      decision: 'skip',
      additionalContext:
        'pr-review-ledger: docs/art/deps-only diff — review ledger not required for this change.',
    };
  }

  const ledgers = findReviewLedgerPaths(addedFiles);
  if (ledgers.length === 0) {
    // Artifact-trust: a 1–2🍎 change legitimately has no ledger, and the tier is
    // only readable FROM a ledger, so this cannot be a hard gate without
    // reinstating the content-free low-tier file. Remind, do not deny.
    return { decision: 'allow', additionalContext: missingLedgerNotice(files) };
  }

  const results = ledgers.map((p) => ({ path: p, result: validateFile(p) }));
  const invalid = results.filter((x) => !x.result.ok);
  if (invalid.length > 0) {
    const reason = [
      'Review ledger present but incomplete for its declared apple tier:',
      '',
      ...invalid.map((x) => formatLedgerResult(x.result, x.path)),
      '',
      'Finish the required review stages, then re-run `npm run review:ledger -- validate <path>` until it passes.',
    ].join('\n');
    return { decision: 'deny', reason };
  }

  const summary = results.map((x) => `${x.path} (${x.result.summary})`).join('; ');
  return {
    decision: 'allow',
    additionalContext: `pr-review-ledger: ✅ valid review ledger — ${summary}.`,
  };
}

/**
 * Gather branch file lists (via injectable git fns) and decide. The git
 * helpers are injectable so the documented "git error -> allow with context"
 * branch can be tested without a degenerate repo.
 *
 * @param {{cwd?:string, branchFilesFn?:(cwd:string)=>string[], branchAddedFilesFn?:(cwd:string)=>string[], validateFile?:(p:string)=>{ok:boolean,summary:string,errors:string[]}}} [opts]
 * @returns {{decision:'allow'|'deny'|'skip', reason?:string, additionalContext?:string}}
 */
function gatherDecision(opts = {}) {
  const cwd = opts.cwd || '.';
  const branchFilesFn = opts.branchFilesFn || branchFiles;
  const branchAddedFilesFn = opts.branchAddedFilesFn || branchAddedFiles;

  let files;
  let addedFiles;
  try {
    files = branchFilesFn(cwd);
    addedFiles = branchAddedFilesFn(cwd);
  } catch (err) {
    // Intentional allow-through: without git (shallow clone, unresolved
    // merge-base, detached state) we cannot compute scope. Surface it so a
    // human verifies the review ledger manually.
    return {
      decision: 'allow',
      additionalContext: `pr-review-ledger: skipped (git error: ${err.message}). Verify the review ledger manually.`,
    };
  }

  return decideLedger(files, addedFiles, { cwd, validateFile: opts.validateFile });
}

export default {
  id: 'pr-review-ledger',
  category: 'pr',
  failClosed: true,
  matches(toolName) {
    return toolName === 'create_pull_request';
  },
  async check(toolArgs, ctx) {
    return gatherDecision({ cwd: ctx?.cwd || process.cwd() });
  },
};

export { decideLedger, missingLedgerNotice, gatherDecision };

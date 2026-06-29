// pr-review-ledger: hard-denies create_pull_request for a code-touching
// branch that has not committed a valid, complete review ledger.
//
// The ledger (docs/knowledge/review-ledgers/YYYY-MM-DD-<slug>.review-ledger.json)
// records WHICH apple-scaled review stages the change went through. This guard
// validates COMPLETENESS for the declared apple tier — it does not (and cannot)
// verify truthfulness; that is an artifact-trust model, same as the handoff
// requirement in pr-preflight.
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

function missingLedgerReason(files) {
  const code = codeFiles(files);
  const shown = code.slice(0, 12);
  const more = code.length > 12 ? ` (+${code.length - 12} more)` : '';
  return [
    `No review ledger found for this code-touching change. Per docs/agent-os/policies/review-harness-policy.md, every code change must commit a review ledger under ${LEDGER_DIR}/ recording the apple-scaled review stages it went through.`,
    '',
    `Code files in this diff:\n${shown.map((f) => `  • ${f}`).join('\n')}${more}`,
    '',
    'Author one with the review-harness skill, then commit it on this branch:',
    '  npm run review:ledger -- init --apples <1..5> --slug <kebab-slug> --title "<title>"',
    "  npm run review:ledger -- stage <path> <stage> --json '{...}'   # per review stage",
    '  npm run review:ledger -- validate <path>',
    '',
    'Required stages by apple tier: 1 → code_review; 2–3 → + plan_review; 4–5 → + dual_plan_synthesis + multi_model_review.',
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
    return { decision: 'deny', reason: missingLedgerReason(files) };
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

export { decideLedger, missingLedgerReason, gatherDecision };

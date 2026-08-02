import test from 'node:test';
import assert from 'node:assert/strict';
import prReviewLedger, {
  decideLedger,
  missingLedgerNotice,
  gatherDecision,
} from '../guards/pr-review-ledger.mjs';
import { classifyPath, isSkippablePath, isNonCodeOnlyDiff, codeFiles } from '../lib/pr-scope.mjs';

// ---------------------------------------------------------------------------
// pr-scope classifier (strict allowlist)
// ---------------------------------------------------------------------------

test('classifyPath: docs', () => {
  assert.equal(classifyPath('docs/foo.md'), 'docs');
  assert.equal(classifyPath('docs/agent-os/policies/x.md'), 'docs');
  assert.equal(classifyPath('README.md'), 'docs');
  assert.equal(classifyPath('LICENSE.txt'), 'docs');
  assert.equal(classifyPath('./CHANGELOG.md'), 'docs');
});

test('classifyPath: art', () => {
  assert.equal(classifyPath('public/assets/sprites/rat.png'), 'art');
  assert.equal(classifyPath('briefs/floor-1.md'), 'art');
  assert.equal(classifyPath('data/palettes/dungeon.json'), 'art');
});

test('classifyPath: deps (lockfiles only)', () => {
  assert.equal(classifyPath('package-lock.json'), 'deps');
  assert.equal(classifyPath('pnpm-lock.yaml'), 'deps');
  assert.equal(classifyPath('yarn.lock'), 'deps');
});

test('classifyPath: code (everything else)', () => {
  // package.json is NOT a lockfile -> code (a dep add can change build/runtime).
  assert.equal(classifyPath('package.json'), 'code');
  assert.equal(classifyPath('scripts/agent/review/cli.mjs'), 'code');
  assert.equal(classifyPath('.github/workflows/ci.yml'), 'code');
  assert.equal(classifyPath('.github/extensions/copilot-guards/extension.mjs'), 'code');
  assert.equal(classifyPath('eslint.config.js'), 'code');
  assert.equal(classifyPath('tsconfig.json'), 'code');
});

test('classifyPath: config (whitelisted src/shared/data config files)', () => {
  assert.equal(classifyPath('src/shared/data/entity-sprite-mappings.json'), 'config');
  assert.equal(classifyPath('src/shared/data/sprite-catalog.json'), 'config');
  // Non-whitelisted src/shared/data files are still code (including tuning.json for gameplay)
  assert.equal(classifyPath('src/shared/data/tuning.json'), 'code');
  assert.equal(classifyPath('src/shared/data/enemies.floor1.json'), 'code');
  assert.equal(classifyPath('src/shared/data/weapons.json'), 'code');
});

test('classifyPath: non-src .md/.txt files are docs (markdown cannot hold game logic)', () => {
  assert.equal(classifyPath('.github/skills/review-harness/SKILL.md'), 'docs');
  assert.equal(classifyPath('.github/copilot-instructions.md'), 'docs');
  assert.equal(classifyPath('.specify/specs/foo.md'), 'docs');
  assert.equal(classifyPath('.github/instructions/game.instructions.md'), 'docs');
  assert.equal(classifyPath('CONTRIBUTING.md'), 'docs');
});

test('classifyPath: src/** is NEVER skippable, even a markdown under src', () => {
  assert.equal(classifyPath('src/core/foo.ts'), 'code');
  assert.equal(classifyPath('src/labs/demo.ts'), 'code');
  // defense-in-depth: a doc-looking file under src/ must still be code
  assert.equal(classifyPath('src/notes.md'), 'code');
  assert.equal(classifyPath('src\\core\\bar.ts'), 'code'); // windows sep
});

test('isSkippablePath mirrors classifyPath', () => {
  assert.equal(isSkippablePath('docs/x.md'), true);
  assert.equal(isSkippablePath('public/assets/x.png'), true);
  assert.equal(isSkippablePath('package-lock.json'), true);
  assert.equal(isSkippablePath('.github/copilot-instructions.md'), true);
  assert.equal(isSkippablePath('.specify/specs/foo.md'), true);
  assert.equal(isSkippablePath('src/core/x.ts'), false);
  assert.equal(isSkippablePath('package.json'), false);
});

test('isNonCodeOnlyDiff: empty is NOT non-code-only', () => {
  assert.equal(isNonCodeOnlyDiff([]), false);
  assert.equal(isNonCodeOnlyDiff(null), false);
});

test('isNonCodeOnlyDiff: all docs/art/deps -> true', () => {
  assert.equal(isNonCodeOnlyDiff(['docs/a.md', 'README.md', 'package-lock.json']), true);
});

test('isNonCodeOnlyDiff: any code file -> false', () => {
  assert.equal(isNonCodeOnlyDiff(['docs/a.md', 'src/core/x.ts']), false);
  assert.equal(isNonCodeOnlyDiff(['docs/a.md', 'package.json']), false);
});

test('codeFiles returns only code paths, normalized', () => {
  assert.deepEqual(
    codeFiles(['docs/a.md', 'src\\core\\x.ts', 'public/assets/y.png', 'scripts/z.mjs']),
    ['src/core/x.ts', 'scripts/z.mjs'],
  );
});

// ---------------------------------------------------------------------------
// decideLedger (pure decision logic with injectable validateFile)
// ---------------------------------------------------------------------------

const okResult = { ok: true, summary: 'valid 4-apple ledger', errors: [] };
const badResult = {
  ok: false,
  summary: 'invalid ledger: 1 problem(s)',
  errors: ['plan_review.completed must be true'],
};
const LEDGER = 'docs/knowledge/review-ledgers/2026-06-29-improve-local-harness.review-ledger.json';

test('decideLedger: empty diff -> skip', () => {
  const d = decideLedger([], []);
  assert.equal(d.decision, 'skip');
});

test('decideLedger: docs-only diff -> skip with context', () => {
  const d = decideLedger(['docs/a.md', 'README.md'], []);
  assert.equal(d.decision, 'skip');
  assert.match(d.additionalContext, /docs\/art\/deps-only/);
});

test('decideLedger: config-only diff (entity-sprite-mappings) -> skip with context', () => {
  const d = decideLedger(['src/shared/data/entity-sprite-mappings.json'], []);
  assert.equal(d.decision, 'skip');
  assert.match(d.additionalContext, /docs\/art\/deps-only/);
});

test('decideLedger: config-only diff (sprite-catalog) -> skip with context', () => {
  const d = decideLedger(['src/shared/data/sprite-catalog.json'], []);
  assert.equal(d.decision, 'skip');
  assert.match(d.additionalContext, /docs\/art\/deps-only/);
});

test('decideLedger: non-docs-dir .md files (e.g. .github/copilot-instructions.md) -> skip', () => {
  const d = decideLedger(['.github/copilot-instructions.md', '.specify/specs/foo.md'], []);
  assert.equal(d.decision, 'skip');
  assert.match(d.additionalContext, /docs\/art\/deps-only/);
});

test('decideLedger: code diff, no ledger added -> allow with reminder (1-2🍎 need none)', () => {
  const d = decideLedger(['src/core/x.ts'], []);
  assert.equal(d.decision, 'allow');
  assert.match(d.additionalContext, /no review ledger on this code-touching branch/);
  assert.match(d.additionalContext, /src\/core\/x\.ts/);
});

test('decideLedger: code diff, ledger added but on main (not added) -> allow with reminder', () => {
  // ledger exists in `files` (modified) but NOT in addedFiles -> not a ledger
  // authored by this branch, so it neither satisfies nor is validated here.
  const d = decideLedger(['src/core/x.ts', LEDGER], [], {
    validateFile: () => okResult,
  });
  assert.equal(d.decision, 'allow');
  assert.match(d.additionalContext, /no review ledger on this code-touching branch/);
});

test('decideLedger: code diff, valid ledger ADDED -> allow with context', () => {
  const d = decideLedger(['src/core/x.ts', LEDGER], [LEDGER], {
    validateFile: () => okResult,
  });
  assert.equal(d.decision, 'allow');
  assert.match(d.additionalContext, /valid review ledger/);
});

test('decideLedger: code diff, invalid ledger ADDED -> deny aggregating errors', () => {
  const d = decideLedger(['src/core/x.ts', LEDGER], [LEDGER], {
    validateFile: () => badResult,
  });
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /incomplete/);
  assert.match(d.reason, /plan_review\.completed must be true/);
});

test('decideLedger: two ledgers added, one invalid -> deny (one valid cannot mask)', () => {
  const L2 = 'docs/knowledge/review-ledgers/2026-06-29-other.review-ledger.json';
  const d = decideLedger(['src/game/y.ts', LEDGER, L2], [LEDGER, L2], {
    validateFile: (p) => (p === L2 ? badResult : okResult),
  });
  assert.equal(d.decision, 'deny');
});

test('decideLedger: ledger-only added but code in diff still requires VALID ledger', () => {
  const d = decideLedger(['src/game/y.ts', LEDGER], [LEDGER], {
    validateFile: () => okResult,
  });
  assert.equal(d.decision, 'allow');
});

// ---------------------------------------------------------------------------
// gatherDecision (injectable git fns — covers the failClosed allow-through)
// ---------------------------------------------------------------------------

test('gatherDecision: git error (e.g. unresolved merge-base) -> allow with context', () => {
  const d = gatherDecision({
    cwd: '/repo',
    branchFilesFn: () => {
      throw new Error('could not resolve merge-base with main');
    },
    branchAddedFilesFn: () => [],
  });
  assert.equal(d.decision, 'allow');
  assert.match(d.additionalContext, /git error: could not resolve merge-base/);
  assert.match(d.additionalContext, /Verify the review ledger manually/);
});

test('gatherDecision: error thrown by branchAddedFilesFn -> allow with context', () => {
  const d = gatherDecision({
    cwd: '/repo',
    branchFilesFn: () => ['src/core/x.ts'],
    branchAddedFilesFn: () => {
      throw new Error('boom');
    },
  });
  assert.equal(d.decision, 'allow');
  assert.match(d.additionalContext, /git error: boom/);
});

test('gatherDecision: no error passes through to decideLedger (code, no ledger -> allow)', () => {
  const d = gatherDecision({
    cwd: '/repo',
    branchFilesFn: () => ['src/core/x.ts'],
    branchAddedFilesFn: () => [],
  });
  assert.equal(d.decision, 'allow');
  assert.match(d.additionalContext, /no review ledger on this code-touching branch/);
});

test('gatherDecision: valid added ledger passes through to allow', () => {
  const d = gatherDecision({
    cwd: '/repo',
    branchFilesFn: () => ['src/core/x.ts', LEDGER],
    branchAddedFilesFn: () => [LEDGER],
    validateFile: () => okResult,
  });
  assert.equal(d.decision, 'allow');
  assert.match(d.additionalContext, /valid review ledger/);
});

// ---------------------------------------------------------------------------
// missingLedgerNotice
// ---------------------------------------------------------------------------

test('missingLedgerNotice lists code files and points to policy + CLI', () => {
  const msg = missingLedgerNotice(['src/core/a.ts', 'docs/x.md', 'scripts/b.mjs']);
  assert.match(msg, /src\/core\/a\.ts/);
  assert.match(msg, /scripts\/b\.mjs/);
  assert.doesNotMatch(msg, /docs\/x\.md/); // docs are not code, not listed
  assert.match(msg, /review-harness-policy\.md/);
  assert.match(msg, /npm run review:ledger -- init/);
});

test('missingLedgerNotice truncates long code lists', () => {
  const many = Array.from({ length: 20 }, (_, i) => `src/core/f${i}.ts`);
  const msg = missingLedgerNotice(many);
  assert.match(msg, /\+8 more/);
});

test('missingLedgerNotice says a 1–2🍎 change legitimately has no ledger', () => {
  const msg = missingLedgerNotice(['src/core/a.ts']);
  assert.match(msg, /CORRECT for a 1–2🍎 change/);
  assert.match(msg, /3🍎 or more/);
});

test('missingLedgerNotice states the current tier matrix (adversarial fold, ADR 0051)', () => {
  const msg = missingLedgerNotice(['src/core/a.ts']);
  assert.match(msg, /1–2 → \(none/);
  assert.match(msg, /3 → plan_review \+ code_review \+ independent_grade/);
  assert.match(msg, /4–5 → \+ multi_model_review/);
  assert.match(msg, /ADVERSARIAL/);
  // dual_plan_synthesis is no longer a required 4–5🍎 stage (ADR 0051).
  assert.doesNotMatch(msg, /dual_plan_synthesis/);
  // The pre-2026-07-07 "2 → plan_review" phrasing must be gone.
  assert.doesNotMatch(msg, /2 → plan_review/);
});

// ---------------------------------------------------------------------------
// guard metadata
// ---------------------------------------------------------------------------

test('guard metadata: pr category, failClosed, matches create_pull_request only', () => {
  assert.equal(prReviewLedger.id, 'pr-review-ledger');
  assert.equal(prReviewLedger.category, 'pr');
  assert.equal(prReviewLedger.failClosed, true);
  assert.equal(prReviewLedger.matches('create_pull_request'), true);
  assert.equal(prReviewLedger.matches('edit'), false);
  assert.equal(prReviewLedger.matches('powershell'), false);
});

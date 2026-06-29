import test from 'node:test';
import assert from 'node:assert/strict';
import prReviewLedger, { decideLedger, missingLedgerReason } from '../guards/pr-review-ledger.mjs';
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
  assert.equal(classifyPath('.github/skills/review-harness/SKILL.md'), 'code');
  assert.equal(classifyPath('.github/copilot-instructions.md'), 'code');
  assert.equal(classifyPath('.specify/specs/foo.md'), 'code');
  assert.equal(classifyPath('eslint.config.js'), 'code');
  assert.equal(classifyPath('tsconfig.json'), 'code');
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

test('decideLedger: code diff, no ledger added -> deny', () => {
  const d = decideLedger(['src/core/x.ts'], []);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /No review ledger found/);
  assert.match(d.reason, /src\/core\/x\.ts/);
});

test('decideLedger: code diff, ledger added but on main (not added) -> deny', () => {
  // ledger exists in `files` (modified) but NOT in addedFiles -> must not satisfy
  const d = decideLedger(['src/core/x.ts', LEDGER], [], {
    validateFile: () => okResult,
  });
  assert.equal(d.decision, 'deny');
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
// missingLedgerReason
// ---------------------------------------------------------------------------

test('missingLedgerReason lists code files and points to policy + CLI', () => {
  const msg = missingLedgerReason(['src/core/a.ts', 'docs/x.md', 'scripts/b.mjs']);
  assert.match(msg, /src\/core\/a\.ts/);
  assert.match(msg, /scripts\/b\.mjs/);
  assert.doesNotMatch(msg, /docs\/x\.md/); // docs are not code, not listed
  assert.match(msg, /review-harness-policy\.md/);
  assert.match(msg, /npm run review:ledger -- init/);
});

test('missingLedgerReason truncates long code lists', () => {
  const many = Array.from({ length: 20 }, (_, i) => `src/core/f${i}.ts`);
  const msg = missingLedgerReason(many);
  assert.match(msg, /\+8 more/);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkHandoff,
  checkForbiddenPaths,
  checkCrossSystemAdr,
  checkMainSync,
  checkIndexMdNotModified,
  evaluatePreflightChecks,
  HANDOFF_DATED_RE,
  TRIVIAL_PATH_RE,
} from '../guards/pr-preflight.mjs';

test('HANDOFF_DATED_RE matches required form', () => {
  assert.match('docs/knowledge/handoffs/2026-06-04-enforcement-hooks.md', HANDOFF_DATED_RE);
  assert.match('docs\\knowledge\\handoffs\\2025-12-31-final.md', HANDOFF_DATED_RE);
  assert.doesNotMatch('docs/knowledge/handoffs/no-date.md', HANDOFF_DATED_RE);
  assert.doesNotMatch('docs/knowledge/handoffs/2026-06-04.md', HANDOFF_DATED_RE);
});

test('TRIVIAL_PATH_RE classifies docs-only diffs', () => {
  assert.match('docs/foo.md', TRIVIAL_PATH_RE);
  assert.match('README.md', TRIVIAL_PATH_RE);
  assert.match('package-lock.json', TRIVIAL_PATH_RE);
  assert.match('package.json', TRIVIAL_PATH_RE);
  assert.match('.github/workflows/ci.yml', TRIVIAL_PATH_RE);
  // any .md/.txt file outside src/ is trivial — markdown/plaintext cannot hold game logic
  assert.match('.github/copilot-instructions.md', TRIVIAL_PATH_RE);
  assert.match('.github/skills/review-harness/SKILL.md', TRIVIAL_PATH_RE);
  assert.match('.specify/specs/floor-1.md', TRIVIAL_PATH_RE);
  assert.match('public/assets/kenney/tiny-battle/Tilesheet.txt', TRIVIAL_PATH_RE);
  // src/**/*.md and src/**/*.txt are NOT trivial — they live alongside real code
  assert.doesNotMatch('src/core/foo.ts', TRIVIAL_PATH_RE);
  assert.doesNotMatch('src/core/NOTES.md', TRIVIAL_PATH_RE);
  assert.doesNotMatch('src/shared/README.md', TRIVIAL_PATH_RE);
  assert.doesNotMatch('src/core/NOTES.txt', TRIVIAL_PATH_RE);
});

test('checkHandoff allows trivial diffs without handoff', () => {
  assert.equal(checkHandoff(['docs/foo.md', 'README.md'], []), null);
});

test('checkHandoff allows md-only diffs outside docs/ without handoff', () => {
  assert.equal(
    checkHandoff(['.github/copilot-instructions.md', '.specify/specs/foo.md'], []),
    null,
  );
});

test('checkHandoff allows txt-only diffs outside src/ without handoff', () => {
  assert.equal(checkHandoff(['public/assets/kenney/tiny-battle/Tilesheet.txt'], []), null);
});

test('checkHandoff requires handoff for code diffs', () => {
  assert.ok(checkHandoff(['src/core/foo.ts'], []));
});

test('checkHandoff passes when a NEW handoff is added', () => {
  assert.equal(
    checkHandoff(
      ['src/core/foo.ts', 'docs/knowledge/handoffs/2026-06-04-test.md'],
      ['docs/knowledge/handoffs/2026-06-04-test.md'],
    ),
    null,
  );
});

test('checkHandoff rejects merely-edited existing handoff', () => {
  // The handoff file appears in `files` (modified) but NOT in
  // `addedFiles`. Editing an old handoff must not satisfy the guard.
  const result = checkHandoff(
    ['src/core/foo.ts', 'docs/knowledge/handoffs/2026-01-01-old.md'],
    [], // nothing added
  );
  assert.ok(result, 'expected deny when handoff is edited, not added');
  assert.match(result, /Editing an existing handoff does not count/);
});

test('checkHandoff deny message points to full policy path', () => {
  const result = checkHandoff(['src/core/foo.ts'], []);
  assert.match(result, /docs\/agent-os\/policies\/memory-policy\.md/);
});

test('checkForbiddenPaths catches secrets', () => {
  assert.ok(checkForbiddenPaths(['.env']));
  assert.ok(checkForbiddenPaths(['.env.local']));
  assert.ok(checkForbiddenPaths(['secrets/id_rsa']));
  assert.ok(checkForbiddenPaths(['certs/server.pem']));
  assert.ok(checkForbiddenPaths(['session-state/foo']));
  assert.ok(checkForbiddenPaths(['.copilot/repos/foo']));
});

test('checkForbiddenPaths allows normal files', () => {
  assert.equal(checkForbiddenPaths(['src/core/foo.ts', 'README.md']), null);
});

test('checkCrossSystemAdr warns when 2+ layers and no ADR', () => {
  const warn = checkCrossSystemAdr(['src/core/a.ts', 'src/game/b.ts']);
  assert.ok(warn);
});

test('checkCrossSystemAdr silent when only one layer', () => {
  assert.equal(checkCrossSystemAdr(['src/core/a.ts', 'src/core/b.ts']), null);
});

test('checkCrossSystemAdr silent when ADR added', () => {
  const r = checkCrossSystemAdr([
    'src/core/a.ts',
    'src/game/b.ts',
    'docs/knowledge/adr/0001-cross-cutting-change.md',
  ]);
  assert.equal(r, null);
});

test('checkMainSync is silent when pre-publish sync is current', () => {
  const warning = checkMainSync('/repo', () => ({
    status: 'success',
    branchChanged: false,
    message: 'current',
  }));
  assert.equal(warning, null);
});

test('checkMainSync warns without denying when sync is deferred', () => {
  const warning = checkMainSync('/repo', () => ({
    status: 'deferred-dirty',
    branchChanged: false,
    message: 'dirty worktree',
  }));
  assert.match(warning, /Publication remains allowed/);
  assert.match(warning, /dirty worktree/);
});

test('checkMainSync invalidates prior validation when the branch changed', () => {
  const warning = checkMainSync('/repo', () => ({
    status: 'success',
    branchChanged: true,
    message: 'rebased',
  }));
  assert.match(warning, /Rerun affected validation/);
});

test('checkIndexMdNotModified denies when INDEX.md is in the diff', () => {
  const result = checkIndexMdNotModified(['docs/knowledge/handoffs/INDEX.md']);
  assert.ok(result, 'expected deny when INDEX.md is modified');
  assert.match(result, /INDEX\.md must not be committed to a feature PR branch/);
  assert.match(result, /git restore --source=\$\(git merge-base origin\/main HEAD\)/);
  assert.match(result, /automation\/docs-update PR/);
});

test('checkIndexMdNotModified denies when INDEX.md appears alongside other files', () => {
  const result = checkIndexMdNotModified(['src/core/foo.ts', 'docs/knowledge/handoffs/INDEX.md']);
  assert.ok(result, 'expected deny when INDEX.md is present with other changes');
});

test('checkIndexMdNotModified allows diffs that do not touch INDEX.md', () => {
  assert.equal(checkIndexMdNotModified(['src/core/foo.ts']), null);
  assert.equal(checkIndexMdNotModified(['docs/knowledge/handoffs/2026-07-28-test.md']), null);
  assert.equal(checkIndexMdNotModified([]), null);
});

test('checkIndexMdNotModified matches Windows-style paths', () => {
  const result = checkIndexMdNotModified(['docs\\knowledge\\handoffs\\INDEX.md']);
  assert.ok(result, 'expected deny for Windows-style path');
});

test('checkIndexMdNotModified allows automation/docs-update branch', () => {
  const result = checkIndexMdNotModified(['docs/knowledge/handoffs/INDEX.md'], {
    currentBranch: 'automation/docs-update',
  });
  assert.equal(result, null);
});

test('checkIndexMdNotModified supports explicit merge-base restoration source', () => {
  const result = checkIndexMdNotModified(['docs/knowledge/handoffs/INDEX.md'], {
    mergeBase: 'abc123def',
  });
  assert.ok(result, 'expected deny when INDEX.md is present');
  assert.match(result, /git restore --source=abc123def/);
});

test('preflight preserves sync warning alongside an unrelated deny', () => {
  const result = evaluatePreflightChecks({
    files: ['src/core/foo.ts'],
    addedFiles: [],
    cwd: '/repo',
    warnings: ['sync deferred'],
  });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /No new handoff/);
  assert.equal(result.additionalContext, 'sync deferred');
});

test('preflight allows a sync warning when no hard findings exist', () => {
  const result = evaluatePreflightChecks({
    files: ['docs/foo.md'],
    addedFiles: [],
    cwd: '/repo',
    warnings: ['sync deferred'],
  });
  assert.deepEqual(result, {
    decision: 'allow',
    additionalContext: 'sync deferred',
  });
});

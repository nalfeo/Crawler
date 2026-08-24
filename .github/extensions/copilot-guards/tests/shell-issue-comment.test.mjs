import test from 'node:test';
import assert from 'node:assert/strict';
import guard from '../guards/shell-issue-comment.mjs';

function run(cmd) {
  return guard.check({ command: cmd });
}

function denies(cmd) {
  assert.equal(guard.matches('bash', { command: cmd }), true, `expected match for: ${cmd}`);
  const r = run(cmd);
  assert.equal(r.decision, 'deny', `expected deny for: ${cmd}`);
  assert.match(r.reason, /progress-report tool/);
  return r;
}

function allows(cmd) {
  const r = run(cmd);
  assert.equal(r.decision, 'allow', `expected allow for: ${cmd}`);
}

// ── denied: the CLI comment subcommands ─────────────────────────────────────

test('denies gh issue comment', () => {
  denies('gh issue comment 3477 --body-file /tmp/plan.md');
});

test('denies gh issue comment with -R repo selector', () => {
  denies('gh issue comment -R nalfeo/Crawler 3477 --body "plan"');
});

test('denies gh pr comment', () => {
  denies('gh pr comment 3480 --body "status update"');
});

test('denies a comment command chained after another command', () => {
  denies('npm run verify:fast && gh issue comment 3477 --body "plan"');
});

test('denies a comment command wrapped in bash -c', () => {
  denies('bash -c "gh issue comment 3477 --body plan"');
});

// ── denied: raw REST / GraphQL comment writes ───────────────────────────────

test('denies an explicit POST to the issue comments endpoint', () => {
  denies('gh api -X POST repos/nalfeo/Crawler/issues/3477/comments -f body=plan');
});

test('denies an implicit POST (fields only) to the issue comments endpoint', () => {
  denies('gh api repos/nalfeo/Crawler/issues/3477/comments -f body=plan');
});

test('denies the --method=POST attached form', () => {
  denies('gh api --method=POST repos/nalfeo/Crawler/issues/3477/comments -f body=plan');
});

test('denies a GraphQL addComment mutation', () => {
  denies(
    'gh api graphql -f query=\'mutation { addComment(input: {subjectId: "X", body: "plan"}) { clientMutationId } }\'',
  );
});

// ── allowed: reads and review-thread replies ────────────────────────────────

test('allows reading issue comments', () => {
  allows('gh issue view 3477 --comments');
});

test('allows a GET of the comments endpoint', () => {
  allows('gh api repos/nalfeo/Crawler/issues/3477/comments');
});

test('allows an explicit GET of the comments endpoint', () => {
  allows('gh api --method GET repos/nalfeo/Crawler/issues/3477/comments');
});

test('allows a PR review-thread reply', () => {
  allows(
    'gh api -X POST repos/nalfeo/Crawler/pulls/3480/comments/12345/replies -f body="✅ Addressed in abc123"',
  );
});

test('allows a PR review comment POST', () => {
  allows('gh api -X POST repos/nalfeo/Crawler/pulls/3480/comments -f body=review');
});

test('allows unrelated gh commands', () => {
  allows('gh pr view 3480 --json mergeStateStatus');
});

test('does not match commands without gh', () => {
  assert.equal(
    guard.matches('bash', { command: 'git commit -m "comment tweak"' }),
    false,
    'expected no match for a non-gh command',
  );
});

test('ignores non-shell tools', () => {
  assert.equal(guard.matches('edit', { command: 'gh issue comment 1 --body x' }), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import guard from '../guards/shell-gh-pr-create.mjs';

const run = (cmd) => guard.check({ command: cmd });

test('denies gh pr create', () => {
  assert.equal(run('gh pr create --title x').decision, 'deny');
});

test('denies gh.exe pr create with quoted body', () => {
  assert.equal(run('gh.exe pr create --title "feat: x" --body "y"').decision, 'deny');
});

test('allows gh pr view', () => {
  assert.equal(run('gh pr view 42').decision, 'allow');
});

test('allows gh issue create', () => {
  assert.equal(run('gh issue create --title x').decision, 'allow');
});

test('matches() ignores edit tools', () => {
  assert.equal(guard.matches('edit', { path: 'foo' }), false);
});

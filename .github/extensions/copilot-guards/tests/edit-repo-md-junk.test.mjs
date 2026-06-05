import test from 'node:test';
import assert from 'node:assert/strict';
import guard, { isAllowed } from '../guards/edit-repo-md-junk.mjs';

test('root allowlist accepted', () => {
  assert.equal(isAllowed('README.md'), true);
  assert.equal(isAllowed('AGENTS.md'), true);
  assert.equal(isAllowed('CONTRIBUTING.md'), true);
  assert.equal(isAllowed('LICENSE.md'), true);
  assert.equal(isAllowed('SECURITY.md'), true);
  assert.equal(isAllowed('CHANGELOG.md'), true);
  assert.equal(isAllowed('CODE_OF_CONDUCT.md'), true);
});

test('docs/, .github/, .specify/ accepted', () => {
  assert.equal(isAllowed('docs/foo.md'), true);
  assert.equal(isAllowed('docs/knowledge/handoffs/2025-01-01-x.md'), true);
  assert.equal(isAllowed('.github/instructions/core.instructions.md'), true);
  assert.equal(isAllowed('.github/extensions/copilot-guards/README.md'), true);
  assert.equal(isAllowed('.specify/memory/constitution.md'), true);
});

test('src/labs/ allows README and SPEC only', () => {
  assert.equal(isAllowed('src/labs/foo-lab/README.md'), true);
  assert.equal(isAllowed('src/labs/foo-lab/SPEC.md'), true);
  assert.equal(isAllowed('src/labs/foo-lab/NOTES.md'), false);
});

test('public/assets accepts README only', () => {
  assert.equal(isAllowed('public/assets/foo/README.md'), true);
  assert.equal(isAllowed('public/assets/foo/CHANGES.md'), false);
});

test('random stray .md files denied', () => {
  assert.equal(isAllowed('NOTES.md'), false);
  assert.equal(isAllowed('PLAN.md'), false);
  assert.equal(isAllowed('src/foo.md'), false);
});

test('guard denies stray root .md create', () => {
  const r = guard.check({ path: 'NOTES.md' });
  assert.equal(r.decision, 'deny');
});

test('guard allows allowlisted .md create', () => {
  const r = guard.check({ path: 'docs/guides/new-guide.md' });
  assert.equal(r.decision, 'allow');
});

test('guard does not match on edit (only create)', () => {
  assert.equal(guard.matches('edit', { path: 'NOTES.md' }), false);
  assert.equal(guard.matches('create', { path: 'NOTES.md' }), true);
});

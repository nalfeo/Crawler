import test from 'node:test';
import assert from 'node:assert/strict';
import guard, { APPLE_FILE_RE, normalizePath } from '../guards/edit-apple-metrics-write-only.mjs';

test('matches only apple metrics json paths', () => {
  assert.equal(APPLE_FILE_RE.test('docs/knowledge/metrics/apples/2026-06-24-session.json'), true);
  assert.equal(APPLE_FILE_RE.test('docs/knowledge/metrics/apples/.gitkeep'), false);
  assert.equal(APPLE_FILE_RE.test('docs/knowledge/metrics/apple-log.json'), false);
});

test('normalizes windows slashes', () => {
  assert.equal(
    normalizePath('docs\\knowledge\\metrics\\apples\\2026-06-24-session.json'),
    'docs/knowledge/metrics/apples/2026-06-24-session.json',
  );
});

test('denies create on apple metric files', () => {
  const result = guard.check({ path: 'docs/knowledge/metrics/apples/2026-06-24-session.json' });
  assert.equal(result.decision, 'deny');
});

test('does not match non-edit tools', () => {
  assert.equal(
    guard.matches('bash', { path: 'docs/knowledge/metrics/apples/2026-06-24-session.json' }),
    false,
  );
});

test('allows unrelated files', () => {
  assert.equal(guard.matches('create', { path: 'docs/knowledge/metrics/apple-log.json' }), false);
});

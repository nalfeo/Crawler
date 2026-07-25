import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExactVersion, findRangeViolations } from './check-exact-deps.mjs';

// ---------------------------------------------------------------------------
// isExactVersion unit tests
// ---------------------------------------------------------------------------

test('isExactVersion: accepts plain semver', () => {
  assert.equal(isExactVersion('1.2.3'), true);
  assert.equal(isExactVersion('0.0.0'), true);
  assert.equal(isExactVersion('4.1.0'), true);
  assert.equal(isExactVersion('10.20.30'), true);
});

test('isExactVersion: accepts pre-release suffix', () => {
  assert.equal(isExactVersion('1.0.0-beta.1'), true);
  assert.equal(isExactVersion('4.0.0-alpha'), true);
  assert.equal(isExactVersion('1.2.3-rc.0'), true);
});

test('isExactVersion: accepts build-metadata suffix', () => {
  assert.equal(isExactVersion('1.0.0+build.123'), true);
  assert.equal(isExactVersion('1.0.0-beta.1+build.1'), true);
});

test('isExactVersion: rejects caret range', () => {
  assert.equal(isExactVersion('^1.2.3'), false);
});

test('isExactVersion: rejects tilde range', () => {
  assert.equal(isExactVersion('~1.2.3'), false);
});

test('isExactVersion: rejects >=, >, <, <=', () => {
  assert.equal(isExactVersion('>=1.0.0'), false);
  assert.equal(isExactVersion('>1.0.0'), false);
  assert.equal(isExactVersion('<2.0.0'), false);
  assert.equal(isExactVersion('<=2.0.0'), false);
});

test('isExactVersion: rejects wildcard and x-range', () => {
  assert.equal(isExactVersion('*'), false);
  assert.equal(isExactVersion('1.x'), false);
  assert.equal(isExactVersion('1.2.x'), false);
  assert.equal(isExactVersion('1.X'), false);
});

test('isExactVersion: rejects dist-tag', () => {
  assert.equal(isExactVersion('latest'), false);
  assert.equal(isExactVersion('next'), false);
});

test('isExactVersion: rejects two-part version', () => {
  assert.equal(isExactVersion('1.2'), false);
});

test('isExactVersion: rejects hyphen range', () => {
  assert.equal(isExactVersion('1.2.3 - 2.3.4'), false);
});

test('isExactVersion: rejects OR range', () => {
  assert.equal(isExactVersion('1.0.0 || 2.0.0'), false);
});

test('isExactVersion: rejects non-string', () => {
  assert.equal(isExactVersion(null), false);
  assert.equal(isExactVersion(undefined), false);
  assert.equal(isExactVersion(123), false);
});

// ---------------------------------------------------------------------------
// findRangeViolations: clean packages pass
// ---------------------------------------------------------------------------

test('findRangeViolations: no violations for exact deps', () => {
  const pkg = {
    dependencies: { phaser: '4.1.0', bitecs: '0.4.0' },
    devDependencies: { typescript: '6.0.3' },
    overrides: { qs: '6.15.2' },
  };
  assert.deepEqual(findRangeViolations(pkg), []);
});

// ---------------------------------------------------------------------------
// findRangeViolations: range violations are detected
// ---------------------------------------------------------------------------

test('findRangeViolations: detects caret in dependencies', () => {
  const pkg = { dependencies: { bitecs: '^0.4.0' } };
  const violations = findRangeViolations(pkg);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, 'dependencies');
  assert.equal(violations[0].name, 'bitecs');
  assert.equal(violations[0].version, '^0.4.0');
});

test('findRangeViolations: detects caret in devDependencies', () => {
  const pkg = { devDependencies: { typescript: '^6.0.3' } };
  const violations = findRangeViolations(pkg);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, 'devDependencies');
  assert.equal(violations[0].name, 'typescript');
});

test('findRangeViolations: detects range in optionalDependencies', () => {
  const pkg = { optionalDependencies: { fsevents: '^2.3.0' } };
  const violations = findRangeViolations(pkg);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, 'optionalDependencies');
});

test('findRangeViolations: detects range in overrides (flat)', () => {
  const pkg = { overrides: { qs: '^6.15.2' } };
  const violations = findRangeViolations(pkg);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, 'overrides');
  assert.equal(violations[0].name, 'qs');
});

test('findRangeViolations: detects range in nested overrides', () => {
  const pkg = {
    overrides: {
      parent: {
        child: '^1.0.0',
      },
    },
  };
  const violations = findRangeViolations(pkg);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, 'child');
  assert.ok(violations[0].field.startsWith('overrides/'));
});

test('findRangeViolations: multiple violations across fields', () => {
  const pkg = {
    dependencies: { phaser: '^4.1.0' },
    devDependencies: { vite: '^8.0.0' },
    overrides: { qs: '~6.0.0' },
  };
  const violations = findRangeViolations(pkg);
  assert.equal(violations.length, 3);
});

test('findRangeViolations: ignores missing fields gracefully', () => {
  assert.deepEqual(findRangeViolations({}), []);
  assert.deepEqual(findRangeViolations({ dependencies: null }), []);
  assert.deepEqual(findRangeViolations({ overrides: null }), []);
});

test('findRangeViolations: exact versions with pre-release pass', () => {
  const pkg = { dependencies: { mypkg: '1.0.0-beta.2' } };
  assert.deepEqual(findRangeViolations(pkg), []);
});

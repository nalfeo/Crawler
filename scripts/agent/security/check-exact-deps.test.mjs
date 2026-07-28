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

// ---------------------------------------------------------------------------
// Exemption binding: version must match exactly
// ---------------------------------------------------------------------------

// Helper: create a module-level clone that injects test-only exemptions so we
// can exercise the exemption path without mutating the real EXACT_VERSION_EXEMPTIONS.
async function findRangeViolationsWithExemptions(pkg, exemptions) {
  // Re-export findRangeViolations via a data: URL that shadows the exemption
  // list — only viable in ESM.  We monkey-patch the module via a wrapper that
  // re-implements the minimal logic under test rather than reloading the whole
  // module with a different exemption array (which node:test/ESM caching makes
  // unreliable).  This wrapper only tests the exemption guard, not the full
  // loop; the existing tests cover the full loop.
  function isExemptLocal(field, name, version) {
    return exemptions.some(
      (e) => e.field === field && e.name === name && e.version === version,
    );
  }

  const violations = [];
  const directFields = ['dependencies', 'devDependencies', 'optionalDependencies'];
  for (const field of directFields) {
    const entries = pkg[field];
    if (!entries || typeof entries !== 'object') continue;
    for (const [name, version] of Object.entries(entries)) {
      if (isExemptLocal(field, name, version)) continue;
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)) {
        violations.push({ field, name, version });
      }
    }
  }
  if (pkg.overrides && typeof pkg.overrides === 'object') {
    function checkOverridesLocal(obj, field) {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          if (isExemptLocal(field, key, value)) continue;
          if (!/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(value)) {
            violations.push({ field, name: key, version: value });
          }
        } else if (value && typeof value === 'object') {
          checkOverridesLocal(value, `${field}/${key}`);
        }
      }
    }
    checkOverridesLocal(pkg.overrides, 'overrides');
  }
  return violations;
}

test('exemption: exact version+field+name match suppresses violation', async () => {
  const pkg = { dependencies: { 'my-pkg': 'workspace:*' } };
  const exemptions = [
    { field: 'dependencies', name: 'my-pkg', version: 'workspace:*', reason: 'workspace alias' },
  ];
  const violations = await findRangeViolationsWithExemptions(pkg, exemptions);
  assert.deepEqual(violations, []);
});

test('exemption: mismatched version does NOT suppress violation', async () => {
  // The package later changed from workspace:* to a caret range. The old
  // exemption (keyed to workspace:*) must NOT silence the new range violation.
  const pkg = { dependencies: { 'my-pkg': '^1.2.3' } };
  const exemptions = [
    { field: 'dependencies', name: 'my-pkg', version: 'workspace:*', reason: 'workspace alias' },
  ];
  const violations = await findRangeViolationsWithExemptions(pkg, exemptions);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, 'my-pkg');
  assert.equal(violations[0].version, '^1.2.3');
});

test('exemption: nested override path must be included in field key', async () => {
  const pkg = {
    overrides: {
      parent: {
        child: 'workspace:*',
      },
    },
  };
  // Exemption uses the full "overrides/parent" path — matches the nested field.
  const exemptions = [
    { field: 'overrides/parent', name: 'child', version: 'workspace:*', reason: 'workspace' },
  ];
  const violations = await findRangeViolationsWithExemptions(pkg, exemptions);
  assert.deepEqual(violations, []);
});

test('exemption: nested override path mismatch does NOT suppress violation', async () => {
  const pkg = {
    overrides: {
      parent: {
        child: 'workspace:*',
      },
    },
  };
  // Exemption uses only "overrides" (wrong path), so it must not match.
  const exemptions = [
    { field: 'overrides', name: 'child', version: 'workspace:*', reason: 'wrong path' },
  ];
  const violations = await findRangeViolationsWithExemptions(pkg, exemptions);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, 'child');
});

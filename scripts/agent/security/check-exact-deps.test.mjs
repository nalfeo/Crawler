import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isExactVersion, findRangeViolations } from './check-exact-deps.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// SemVer boundary cases — regression tests for false-positives/negatives
test('isExactVersion: accepts pre-release with internal hyphen (e.g. beta-1)', () => {
  // "1.0.0-beta-1" is valid SemVer: pre-release identifier "beta-1" contains a hyphen
  assert.equal(isExactVersion('1.0.0-beta-1'), true);
  assert.equal(isExactVersion('2.3.4-rc-2.build-5'), true);
});

test('isExactVersion: rejects leading zeros in version core', () => {
  // SemVer 2.0.0 §2: numeric identifiers must not have leading zeros
  assert.equal(isExactVersion('01.2.3'), false);
  assert.equal(isExactVersion('1.02.3'), false);
  assert.equal(isExactVersion('1.2.03'), false);
});

test('isExactVersion: rejects underscore in pre-release identifier', () => {
  // SemVer identifiers are [0-9A-Za-z-] only; underscore is not allowed
  assert.equal(isExactVersion('1.0.0-alpha_1'), false);
  assert.equal(isExactVersion('1.0.0-_bad'), false);
});

test('isExactVersion: rejects trailing dot in pre-release', () => {
  // "1.0.0-alpha." has an empty identifier after the trailing dot
  assert.equal(isExactVersion('1.0.0-alpha.'), false);
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
// Exemptions: version-bound — a later change to a different specifier must
// NOT be silently covered by an exemption for the original specifier.
// ---------------------------------------------------------------------------

test('findRangeViolations: workspace: specifier is not an exact version without exemption', () => {
  // workspace:* should be detected as a non-exact specifier
  const pkg = { dependencies: { 'my-local-pkg': 'workspace:*' } };
  const violations = findRangeViolations(pkg);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, 'my-local-pkg');
});

test('findRangeViolations: workspace: specifier passes when exempted for that exact version string', () => {
  // Exercise the injectable exemptions parameter — verifies that the version-binding
  // bug (keying only on field+name) cannot regress. The exemption below covers
  // workspace:* but NOT ^1.0.0; a specifier change must still trigger a violation.
  const exemptions = [
    { field: 'dependencies', name: 'my-local-pkg', version: 'workspace:*', reason: 'test fixture' },
  ];

  // Exact triple passes
  const pkgA = { dependencies: { 'my-local-pkg': 'workspace:*' } };
  assert.deepEqual(findRangeViolations(pkgA, exemptions), []);

  // Different specifier on the same field/name is NOT covered — regression guard
  const pkgB = { dependencies: { 'my-local-pkg': '^1.0.0' } };
  const violations = findRangeViolations(pkgB, exemptions);
  assert.equal(
    violations.length,
    1,
    'version-bound exemption: changed specifier must still be reported',
  );
  assert.equal(violations[0].version, '^1.0.0');

  // Nested override triple also uses version-binding
  const overrideExemptions = [
    {
      field: 'overrides/parent',
      name: 'child',
      version: 'workspace:*',
      reason: 'test fixture',
    },
  ];
  const pkgC = { overrides: { parent: { child: 'workspace:*' } } };
  assert.deepEqual(findRangeViolations(pkgC, overrideExemptions), []);

  const pkgD = { overrides: { parent: { child: '^1.0.0' } } };
  const overrideViolations = findRangeViolations(pkgD, overrideExemptions);
  assert.equal(
    overrideViolations.length,
    1,
    'nested override: changed specifier must still be reported',
  );
});

test('findRangeViolations: violation includes version field so callers can match exemption', () => {
  const pkg = { dependencies: { lodash: '^4.0.0' } };
  const [violation] = findRangeViolations(pkg);
  assert.equal(typeof violation.version, 'string');
  assert.equal(violation.version, '^4.0.0');
});

test('findRangeViolations: nested override field path is stable for exemption matching', () => {
  // The field for a nested override child uses "/" separator, e.g. "overrides/parent".
  // This is the stable path that an exemption entry would use in its `field` key.
  const pkg = {
    overrides: {
      grandparent: {
        parent: {
          child: '^1.0.0',
        },
      },
    },
  };
  const violations = findRangeViolations(pkg);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, 'overrides/grandparent/parent');
  assert.equal(violations[0].name, 'child');
  assert.equal(violations[0].version, '^1.0.0');
});

test('findRangeViolations: exact version with different specifier triggers violation even if name matches', () => {
  // Illustrates the security of the version-bound exemption approach: two entries
  // with the same name but different specifiers are independently evaluated. If only
  // one specifier is exempt, the other still triggers.
  const pkg = {
    dependencies: { mypkg: 'workspace:*' },
    devDependencies: { mypkg: '^1.0.0' },
  };
  const violations = findRangeViolations(pkg);
  // Both are non-exact; neither is exempt (empty EXACT_VERSION_EXEMPTIONS)
  assert.equal(violations.length, 2);
});

// ---------------------------------------------------------------------------
// Percent-encoded path regression — fileURLToPath vs URL.pathname
// ---------------------------------------------------------------------------

test('repoRoot: resolves package.json correctly from a path containing spaces', () => {
  // Regression test for the percent-encoded-path bug:
  //   Old code: new URL(import.meta.url).pathname  → leaves %20 in the path
  //   New code: fileURLToPath(import.meta.url)     → decodes %20 → space
  //
  // We copy the script to a temp directory whose name contains a space, then
  // run it as a subprocess. If repoRoot() resolves incorrectly, node cannot
  // find package.json and exits with code 2. The fixture package.json has
  // all-exact versions so exit 0 proves the full path round-trip works.
  const tmpBase = mkdtempSync(join(tmpdir(), 'check exact deps '));
  try {
    const scriptDir = join(tmpBase, 'scripts', 'agent', 'security');
    mkdirSync(scriptDir, { recursive: true });

    // Minimal all-exact package.json at the fake repo root
    writeFileSync(
      join(tmpBase, 'package.json'),
      JSON.stringify({ name: 'space-test-fixture', dependencies: { pkg: '1.0.0' } }),
    );

    // Copy the script to the spaced path so import.meta.url carries %20
    const destScript = join(scriptDir, 'check-exact-deps.mjs');
    copyFileSync(join(__dirname, 'check-exact-deps.mjs'), destScript);

    const result = spawnSync(process.execPath, [destScript], { encoding: 'utf8' });
    assert.notEqual(
      result.status,
      2,
      `repoRoot crashed (could not read package.json): ${result.stderr}`,
    );
    assert.equal(result.status, 0, `Unexpected exit code ${result.status}: ${result.stderr}`);
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

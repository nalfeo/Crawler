import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import {
  AUDIT_EXCEPTIONS,
  evaluateAudit,
  extractAuditExceptionsFromSource,
  findReasonRestatementViolations,
} from './npm-audit.mjs';

const ACTIVE_DATE = new Date('2026-07-24T00:00:00Z');
const SCRIPT = fileURLToPath(new URL('./npm-audit.mjs', import.meta.url));

// Synthetic fixtures for the suppression algorithm itself. These must NEVER be
// changed to track the real, live AUDIT_EXCEPTIONS list — that list churns as
// advisories get fixed/expire, and these tests validate matching/derivation
// behavior, not any specific package's current state.
const ALPHA_EXCEPTION = {
  packageName: 'alpha-pkg',
  source: 5001,
  url: 'https://github.com/advisories/GHSA-alpha-0001',
  expiresOn: '2026-07-31',
  reason: 'Synthetic fixture: no patched release available yet.',
};
const BETA_EXCEPTION = {
  packageName: 'beta-pkg',
  source: 5002,
  url: 'https://github.com/advisories/GHSA-beta-0002',
  expiresOn: '2026-07-29',
  reason: 'Synthetic fixture: registry proxy does not yet mirror the fix.',
};
const SYNTHETIC_EXCEPTIONS = [ALPHA_EXCEPTION, BETA_EXCEPTION];

const ALPHA_ADVISORY = {
  source: ALPHA_EXCEPTION.source,
  url: ALPHA_EXCEPTION.url,
  severity: 'high',
};
const BETA_ADVISORY = {
  source: BETA_EXCEPTION.source,
  url: BETA_EXCEPTION.url,
  severity: 'high',
};

function report(vulnerabilities) {
  return { auditReportVersion: 2, vulnerabilities };
}

test('fails when expiresOn changes without a matching reason update', () => {
  const previous = [{ ...ALPHA_EXCEPTION, expiresOn: '2026-07-01' }];
  const current = [ALPHA_EXCEPTION];

  assert.deepEqual(findReasonRestatementViolations(previous, current), [
    {
      packageName: 'alpha-pkg',
      previousExpiresOn: '2026-07-01',
      currentExpiresOn: '2026-07-31',
    },
  ]);
});

test('passes when expiresOn and reason both change', () => {
  const previous = [
    {
      ...ALPHA_EXCEPTION,
      expiresOn: '2026-07-01',
      reason: 'Previous investigation text.',
    },
  ];
  const current = [ALPHA_EXCEPTION];

  assert.deepEqual(findReasonRestatementViolations(previous, current), []);
});

test('does not flag added or removed exception entries', () => {
  const base = [ALPHA_EXCEPTION];
  const withAddition = [ALPHA_EXCEPTION, BETA_EXCEPTION];

  assert.deepEqual(findReasonRestatementViolations(base, withAddition), []);
  assert.deepEqual(findReasonRestatementViolations(withAddition, base), []);
});

test('passes for unrelated edits when exceptions are unchanged', () => {
  const sourceWithUnrelatedEdit = `
const SOME_UNRELATED_VALUE = 'changed';
export const AUDIT_EXCEPTIONS = ${JSON.stringify(SYNTHETIC_EXCEPTIONS, null, 2)};
`;
  const previous = extractAuditExceptionsFromSource(sourceWithUnrelatedEdit);

  assert.deepEqual(findReasonRestatementViolations(previous, SYNTHETIC_EXCEPTIONS), []);
});

test('extractAuditExceptionsFromSource handles an empty array declaration', () => {
  const emptySource = `export const AUDIT_EXCEPTIONS = [];`;
  const result = extractAuditExceptionsFromSource(emptySource);
  assert.deepEqual(result, []);
});

test('CLI exits 1 with package-specific error when expiresOn extends without reason update', (t) => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'npm-audit-cli-guard-test-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const scriptRelPath = path.join('scripts', 'agent', 'security', 'npm-audit.mjs');
  const scriptDir = path.join(tempDir, 'scripts', 'agent', 'security');
  mkdirSync(scriptDir, { recursive: true });

  const realSource = readFileSync(SCRIPT, 'utf8');
  // Replace the AUDIT_EXCEPTIONS block to get a minimal, self-contained base version.
  const baseSource = realSource.replace(
    /export const AUDIT_EXCEPTIONS = \[[\s\S]*?\];/,
    `export const AUDIT_EXCEPTIONS = [
  {
    packageName: 'test-pkg',
    source: 9999,
    url: 'https://example.test/advisory',
    expiresOn: '2026-07-01',
    reason: 'Test reason — unchanged.',
  },
];`,
  );
  const currentSource = realSource.replace(
    /export const AUDIT_EXCEPTIONS = \[[\s\S]*?\];/,
    `export const AUDIT_EXCEPTIONS = [
  {
    packageName: 'test-pkg',
    source: 9999,
    url: 'https://example.test/advisory',
    expiresOn: '2026-09-01',
    reason: 'Test reason — unchanged.',
  },
];`,
  );

  const git = (args) =>
    spawnSync('git', args, {
      cwd: tempDir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: tempDir },
    });

  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);

  writeFileSync(path.join(scriptDir, 'npm-audit.mjs'), baseSource);
  git(['add', scriptRelPath]);
  git(['commit', '-m', 'base: old expiry']);
  const baseSha = git(['rev-parse', 'HEAD']).stdout.trim();

  writeFileSync(path.join(scriptDir, 'npm-audit.mjs'), currentSource);
  git(['add', scriptRelPath]);
  git(['commit', '-m', 'bump expiry without updating reason']);

  const scriptInTempRepo = path.join(scriptDir, 'npm-audit.mjs');
  const result = spawnSync(process.execPath, [scriptInTempRepo], {
    cwd: tempDir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_BASE_SHA: baseSha },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /AUDIT_EXCEPTIONS extension for "test-pkg"/);
  assert.match(result.stderr, /2026-07-01 -> 2026-09-01/);
  assert.match(result.stderr, /restated, current justification/);
});


test('reports every matched exception in the success diagnostic', (t) => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'npm-audit-test-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const fakeNpmCli = path.join(tempDir, 'fake-npm-cli.cjs');
  writeFileSync(
    fakeNpmCli,
    `process.stdout.write(JSON.stringify(${JSON.stringify(
      report({
        'brace-expansion': {
          name: 'brace-expansion',
          severity: 'high',
          via: [
            {
              source: 1124334,
              url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
              severity: 'high',
            },
          ],
        },
        minimatch: { name: 'minimatch', severity: 'high', via: ['brace-expansion'] },
      }),
    )}));`,
  );

  const result = spawnSync(process.execPath, [SCRIPT, '--audit-level=high'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_execpath: fakeNpmCli,
    },
  });

  assert.equal(result.status, 0);
  assert.match(
    result.stderr,
    /Temporary audit exception through 2026-08-13: https:\/\/github\.com\/advisories\/GHSA-mh99-v99m-4gvg/,
  );
  assert.match(result.stderr, /Suppressed derived findings: brace-expansion, minimatch/);
});

test('suppresses the exact advisory and findings derived solely from it', () => {
  const result = evaluateAudit(
    report({
      'alpha-pkg': { name: 'alpha-pkg', severity: 'high', via: [ALPHA_ADVISORY] },
      downstream: { name: 'downstream', severity: 'high', via: ['alpha-pkg'] },
    }),
    { now: ACTIVE_DATE, exceptions: SYNTHETIC_EXCEPTIONS },
  );

  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.ignored, ['alpha-pkg', 'downstream']);
  assert.deepEqual(
    result.matchedExceptions.map((item) => item.packageName),
    ['alpha-pkg'],
  );
});

test('fails closed after the exception expires', () => {
  const result = evaluateAudit(
    report({
      'alpha-pkg': { name: 'alpha-pkg', severity: 'high', via: [ALPHA_ADVISORY] },
    }),
    { now: new Date('2026-08-01T00:00:00Z'), exceptions: SYNTHETIC_EXCEPTIONS },
  );

  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.matchedExceptions, []);
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['alpha-pkg'],
  );
});

test('suppresses a second, independent exception and findings derived solely from it', () => {
  const result = evaluateAudit(
    report({
      'beta-pkg': { name: 'beta-pkg', severity: 'high', via: [BETA_ADVISORY] },
      transitive: { name: 'transitive', severity: 'high', via: ['beta-pkg'] },
      leaf: { name: 'leaf', severity: 'high', via: ['transitive'] },
    }),
    { now: ACTIVE_DATE, exceptions: SYNTHETIC_EXCEPTIONS },
  );

  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.ignored, ['beta-pkg', 'leaf', 'transitive']);
  assert.deepEqual(
    result.matchedExceptions.map((item) => item.packageName),
    ['beta-pkg'],
  );
});

test('fails closed for a mixed dependency chain', () => {
  const unrelated = { source: 99, url: 'https://example.test/other', severity: 'high' };
  const result = evaluateAudit(
    report({
      'alpha-pkg': { name: 'alpha-pkg', severity: 'high', via: [ALPHA_ADVISORY] },
      downstream: { name: 'downstream', severity: 'high', via: ['alpha-pkg', unrelated] },
    }),
    { now: ACTIVE_DATE, exceptions: SYNTHETIC_EXCEPTIONS },
  );

  assert.deepEqual(result.ignored, ['alpha-pkg']);
  assert.deepEqual(
    result.matchedExceptions.map((item) => item.packageName),
    ['alpha-pkg'],
  );
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['downstream'],
  );
});

test('does not suppress a different advisory for the same package', () => {
  const result = evaluateAudit(
    report({
      'alpha-pkg': {
        name: 'alpha-pkg',
        severity: 'critical',
        via: [{ ...ALPHA_ADVISORY, source: 123 }],
      },
    }),
    { now: ACTIVE_DATE, exceptions: SYNTHETIC_EXCEPTIONS },
  );

  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.matchedExceptions, []);
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['alpha-pkg'],
  );
});

test('does not suppress an excepted finding with malformed severity', () => {
  const result = evaluateAudit(
    report({
      'alpha-pkg': { name: 'alpha-pkg', severity: null, via: [ALPHA_ADVISORY] },
    }),
    { now: ACTIVE_DATE, exceptions: SYNTHETIC_EXCEPTIONS },
  );

  assert.deepEqual(result.ignored, ['alpha-pkg']);
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['alpha-pkg'],
  );
});

test('fails closed when severity is null', () => {
  const result = evaluateAudit(report({ pkg: { name: 'pkg', severity: null, via: [] } }), {
    now: ACTIVE_DATE,
  });

  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['pkg'],
  );
});

test('fails closed when severity is an array', () => {
  const result = evaluateAudit(report({ pkg: { name: 'pkg', severity: ['high'], via: [] } }), {
    now: ACTIVE_DATE,
  });

  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['pkg'],
  );
});

test('fails closed when severity is an unknown string', () => {
  const result = evaluateAudit(
    report({ pkg: { name: 'pkg', severity: 'unknown-level', via: [] } }),
    { now: ACTIVE_DATE },
  );

  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['pkg'],
  );
});

test('fails closed when severity is missing (undefined)', () => {
  const result = evaluateAudit(report({ pkg: { name: 'pkg', via: [] } }), { now: ACTIVE_DATE });

  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['pkg'],
  );
});

// Properties of the real, live AUDIT_EXCEPTIONS list. Keep these small and
// generic so they don't churn every time an advisory is fixed or expires.
// New entries: add the advisory URL, expiry date, and the reason text here.
// Expired or fixed entries: remove the entry entirely (upgrade the package).
test('every real audit exception has a well-formed expiresOn date', () => {
  for (const exception of AUDIT_EXCEPTIONS) {
    assert.match(
      exception.expiresOn,
      /^\d{4}-\d{2}-\d{2}$/,
      `${exception.packageName} expiresOn must be YYYY-MM-DD`,
    );
    const parsed = new Date(`${exception.expiresOn}T23:59:59.999Z`);
    assert.equal(
      Number.isNaN(parsed.getTime()),
      false,
      `${exception.packageName} expiresOn must parse as a valid date`,
    );
    // Round-trip: reject impossible calendar dates like 2026-02-31 that JS
    // silently normalises to a neighbouring day.
    const roundTripped = parsed.toISOString().slice(0, 10);
    assert.equal(
      roundTripped,
      exception.expiresOn,
      `${exception.packageName} expiresOn '${exception.expiresOn}' is not a real calendar date (normalises to ${roundTripped})`,
    );
  }
});

test('no real audit exception is already expired', () => {
  const now = new Date();
  const expired = AUDIT_EXCEPTIONS.filter((exception) => {
    const expiresAt = new Date(`${exception.expiresOn}T23:59:59.999Z`);
    return now > expiresAt;
  });

  assert.deepEqual(
    expired.map((exception) => `${exception.packageName} expired on ${exception.expiresOn}`),
    [],
    'One or more audit exceptions have expired. Fix the underlying vulnerability ' +
      '(upgrade to a patched version) rather than extending the expiry date.',
  );
});

test('blocks fast-uri — no exception after package upgrade to 3.1.4', () => {
  // fast-uri was upgraded to 3.1.4 in this repo (GHSA-v2hh-gcrm-f6hx is patched).
  // Regression guard: no exception should suppress it if it reappears in a future audit.
  const fastUriAdvisory = {
    source: 1124064,
    url: 'https://github.com/advisories/GHSA-v2hh-gcrm-f6hx',
    severity: 'high',
  };
  const result = evaluateAudit(
    report({ 'fast-uri': { name: 'fast-uri', severity: 'high', via: [fastUriAdvisory] } }),
    { now: ACTIVE_DATE },
  );

  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.matchedExceptions, []);
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['fast-uri'],
  );
});

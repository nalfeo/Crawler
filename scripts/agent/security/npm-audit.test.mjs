import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { evaluateAudit } from './npm-audit.mjs';

const ACTIVE_DATE = new Date('2026-07-24T00:00:00Z');
const SCRIPT = fileURLToPath(new URL('./npm-audit.mjs', import.meta.url));
const BRACE_EXPANSION_ADVISORY = {
  source: 1124334,
  url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
  severity: 'high',
};
const ADVISORY = {
  source: 1124064,
  url: 'https://github.com/advisories/GHSA-v2hh-gcrm-f6hx',
  severity: 'high',
};
const FIND_MY_WAY_ADVISORY = {
  source: 1124273,
  url: 'https://github.com/advisories/GHSA-c96f-x56v-gq3h',
  severity: 'high',
};

function report(vulnerabilities) {
  return { auditReportVersion: 2, vulnerabilities };
}

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
          via: [BRACE_EXPANSION_ADVISORY],
        },
        'fast-uri': { name: 'fast-uri', severity: 'high', via: [ADVISORY] },
        'find-my-way': {
          name: 'find-my-way',
          severity: 'high',
          via: [FIND_MY_WAY_ADVISORY],
        },
        fastify: { name: 'fastify', severity: 'high', via: ['find-my-way'] },
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
  assert.match(
    result.stderr,
    /Temporary audit exception through 2026-08-13: https:\/\/github\.com\/advisories\/GHSA-v2hh-gcrm-f6hx/,
  );
  assert.match(
    result.stderr,
    /Temporary audit exception through 2026-08-13: https:\/\/github\.com\/advisories\/GHSA-c96f-x56v-gq3h/,
  );
  assert.match(
    result.stderr,
    /Suppressed derived findings: brace-expansion, fast-uri, fastify, find-my-way, minimatch/,
  );
});

test('suppresses the exact brace-expansion advisory and findings derived solely from it', () => {
  const result = evaluateAudit(
    report({
      'brace-expansion': {
        name: 'brace-expansion',
        severity: 'high',
        via: [BRACE_EXPANSION_ADVISORY],
      },
      minimatch: { name: 'minimatch', severity: 'high', via: ['brace-expansion'] },
    }),
    { now: ACTIVE_DATE },
  );

  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.ignored, ['brace-expansion', 'minimatch']);
  assert.deepEqual(
    result.matchedExceptions.map((item) => item.packageName),
    ['brace-expansion'],
  );
});

test('fails closed after the brace-expansion exception expires', () => {
  const result = evaluateAudit(
    report({
      'brace-expansion': {
        name: 'brace-expansion',
        severity: 'high',
        via: [BRACE_EXPANSION_ADVISORY],
      },
    }),
    { now: new Date('2026-08-14T00:00:00Z') },
  );

  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.matchedExceptions, []);
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['brace-expansion'],
  );
});

test('suppresses the exact fast-uri advisory and findings derived solely from it', () => {
  const result = evaluateAudit(
    report({
      'fast-uri': { name: 'fast-uri', severity: 'high', via: [ADVISORY] },
      ajv: { name: 'ajv', severity: 'high', via: ['fast-uri'] },
      fastify: { name: 'fastify', severity: 'high', via: ['ajv'] },
    }),
    { now: ACTIVE_DATE },
  );

  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.ignored, ['ajv', 'fast-uri', 'fastify']);
  assert.deepEqual(
    result.matchedExceptions.map((item) => item.packageName),
    ['fast-uri'],
  );
});

test('fails closed for a mixed dependency chain', () => {
  const unrelated = { source: 99, url: 'https://example.test/other', severity: 'high' };
  const result = evaluateAudit(
    report({
      'fast-uri': { name: 'fast-uri', severity: 'high', via: [ADVISORY] },
      ajv: { name: 'ajv', severity: 'high', via: ['fast-uri', unrelated] },
    }),
    { now: ACTIVE_DATE },
  );

  assert.deepEqual(result.ignored, ['fast-uri']);
  assert.deepEqual(
    result.matchedExceptions.map((item) => item.packageName),
    ['fast-uri'],
  );
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['ajv'],
  );
});

test('fails closed after the exception expires', () => {
  const result = evaluateAudit(
    report({
      'fast-uri': { name: 'fast-uri', severity: 'high', via: [ADVISORY] },
    }),
    { now: new Date('2026-08-14T00:00:00Z') },
  );

  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.matchedExceptions, []);
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['fast-uri'],
  );
});

test('does not suppress a different advisory for fast-uri', () => {
  const result = evaluateAudit(
    report({
      'fast-uri': {
        name: 'fast-uri',
        severity: 'critical',
        via: [{ ...ADVISORY, source: 123 }],
      },
    }),
    { now: ACTIVE_DATE },
  );

  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.matchedExceptions, []);
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['fast-uri'],
  );
});

test('suppresses the exact find-my-way advisory and findings derived solely from it', () => {
  const result = evaluateAudit(
    report({
      'find-my-way': { name: 'find-my-way', severity: 'high', via: [FIND_MY_WAY_ADVISORY] },
      fastify: { name: 'fastify', severity: 'high', via: ['find-my-way'] },
    }),
    { now: ACTIVE_DATE },
  );

  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.ignored, ['fastify', 'find-my-way']);
  assert.deepEqual(
    result.matchedExceptions.map((item) => item.packageName),
    ['find-my-way'],
  );
});

test('fails closed after the find-my-way exception expires', () => {
  const result = evaluateAudit(
    report({
      'find-my-way': { name: 'find-my-way', severity: 'high', via: [FIND_MY_WAY_ADVISORY] },
    }),
    { now: new Date('2026-08-14T00:00:00Z') },
  );

  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.matchedExceptions, []);
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['find-my-way'],
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

test('does not suppress an excepted finding with malformed severity', () => {
  const result = evaluateAudit(
    report({
      'fast-uri': { name: 'fast-uri', severity: null, via: [ADVISORY] },
    }),
    { now: ACTIVE_DATE },
  );

  assert.deepEqual(result.ignored, ['fast-uri']);
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['fast-uri'],
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

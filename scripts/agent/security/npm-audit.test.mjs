import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAudit } from './npm-audit.mjs';

const ACTIVE_DATE = new Date('2026-07-22T00:00:00Z');
const ADVISORY = {
  source: 1124064,
  url: 'https://github.com/advisories/GHSA-v2hh-gcrm-f6hx',
  severity: 'high',
};

function report(vulnerabilities) {
  return { auditReportVersion: 2, vulnerabilities };
}

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
    result.blocking.map((item) => item.name),
    ['ajv'],
  );
});

test('fails closed after the exception expires', () => {
  const result = evaluateAudit(
    report({
      'fast-uri': { name: 'fast-uri', severity: 'high', via: [ADVISORY] },
    }),
    { now: new Date('2026-07-30T00:00:00Z') },
  );

  assert.deepEqual(result.ignored, []);
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
  assert.deepEqual(
    result.blocking.map((item) => item.name),
    ['fast-uri'],
  );
});

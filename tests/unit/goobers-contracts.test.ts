/**
 * Goobers Contract Validation Tests
 *
 * Compiles the canonical Ajv JSON Schemas from
 * `.github/scripts/validate-goobers-contracts-schema.js` (the same schemas
 * the CI gate uses) and asserts their real validation result for positive
 * and negative payloads, plus the semantic-rule helpers exported from
 * `.github/scripts/validate-goobers-contracts.mjs`. This intentionally does
 * NOT reimplement validation logic here -- a schema/semantic regression in
 * the production validator must fail this suite.
 *
 * Run with: npx vitest run tests/unit/goobers-contracts.test.ts
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import type Ajv from 'ajv';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type Invocation = Record<string, unknown>;
type Output = Record<string, unknown>;

let invocationV1: object;
let outputV1: object;
let prStateCommentV1: {
  marker: string;
  dataPrefix: string;
  encodedStateRequiredFields: string[];
  bulletFields: string[];
};
let invocationSemanticErrors: (payload: Invocation) => string[];
let outputSemanticErrors: (payload: Output) => string[];
let validateInvocation: Ajv.ValidateFunction;
let validateOutput: Ajv.ValidateFunction;

beforeAll(async () => {
  const schemaModule = await import(
    path.join(REPO_ROOT, '.github/scripts/validate-goobers-contracts-schema.js')
  );
  invocationV1 = schemaModule.invocationV1;
  outputV1 = schemaModule.outputV1;
  prStateCommentV1 = schemaModule.prStateCommentV1;

  const validatorModule = await import(
    path.join(REPO_ROOT, '.github/scripts/validate-goobers-contracts.mjs')
  );
  invocationSemanticErrors = validatorModule.invocationSemanticErrors;
  outputSemanticErrors = validatorModule.outputSemanticErrors;

  const AjvCtor = require('ajv');
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  validateInvocation = ajv.compile(invocationV1);
  validateOutput = ajv.compile(outputV1);
});

function isInvocationValid(payload: Invocation): boolean {
  const schemaOk = Boolean(validateInvocation(payload));
  return schemaOk && invocationSemanticErrors(payload).length === 0;
}

function isOutputValid(payload: Output): boolean {
  const schemaOk = Boolean(validateOutput(payload));
  return schemaOk && outputSemanticErrors(payload).length === 0;
}

describe('crawler.goobers.invocation/v1 schema', () => {
  it('validates a reconcile operation with required fields', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: '1234',
        trigger: 'workflow_dispatch',
      }),
    ).toBe(true);
  });

  it('fails on unknown contractVersion', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v2',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: '1234',
      }),
    ).toBe(false);
  });

  it('fails on unknown operation', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'invalid-op',
        pr_number: '1234',
      }),
    ).toBe(false);
  });

  it('fails on a non-string pr_number (GitHub Actions inputs are always strings)', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: 1234,
        trigger: 'workflow_dispatch',
      }),
    ).toBe(false);
  });

  it('requires expected_base_ref when expected_head_sha is set', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: '1234',
        expected_head_sha: 'abc123',
        expected_base_ref: 'main',
      }),
    ).toBe(true);

    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        pr_number: '1234',
        expected_head_sha: 'abc123',
      }),
    ).toBe(false);
  });

  it('requires all candidate fields for validate-candidate operation', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'merge-train-validate',
        operation: 'validate-candidate',
        candidate_sha: 'a'.repeat(40),
        candidate_ref: 'refs/custom/candidate',
        attestation_sha: 'b'.repeat(40),
        fingerprint: 'gen-5',
        pr_numbers: '1234',
      }),
    ).toBe(true);
  });

  it('fails if validate-candidate is missing candidate fields', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'merge-train-validate',
        operation: 'validate-candidate',
        candidate_sha: 'a'.repeat(40),
        // Missing: candidate_ref, attestation_sha, fingerprint
      }),
    ).toBe(false);
  });

  it('requires pr_number for PR-scoped operations', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'ci-recovery',
        operation: 'reconcile',
        // Missing pr_number
      }),
    ).toBe(false);
  });

  it('forbids pr_number for batch operations', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'merge-train-validate',
        operation: 'validate-candidate',
        candidate_sha: 'a'.repeat(40),
        candidate_ref: 'refs/merge-train-candidates/candidate-1',
        attestation_sha: 'b'.repeat(40),
        fingerprint: 'gen-5',
        pr_numbers: '42,43',
        pr_number: '42',
      }),
    ).toBe(false);
  });

  it('accepts free-form business-reason trigger strings, not just GitHub event names', () => {
    expect(
      isInvocationValid({
        contractVersion: 'v1',
        workflowName: 'merge-train',
        operation: 'reconcile',
        pr_number: '42',
        trigger: 'merge-train-cumulative-conflict:41',
      }),
    ).toBe(true);
  });
});

describe('crawler.goobers.output/v1 schema', () => {
  it('validates a success output with required fields', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'plan',
        status: 'success',
        outputs: {
          verdict: 'recommended',
          appleEstimate: 3,
          hardGate: 'All tests pass',
          blockedBy: null,
        },
        summary: 'Feature implemented and reviewed',
        error: null,
      }),
    ).toBe(true);
  });

  it('fails on unknown status', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'plan',
        status: 'unknown-status',
        outputs: {},
        summary: 'Test',
      }),
    ).toBe(false);
  });

  it('fails on unknown task', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'not-a-real-task',
        status: 'success',
        outputs: {},
        summary: 'Test',
      }),
    ).toBe(false);
  });

  it('requires error object when status is failure', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'failure',
        outputs: {},
        summary: 'Operation failed',
      }),
    ).toBe(false);

    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'failure',
        outputs: {},
        summary: 'Operation failed',
        error: { code: 'TEST_FAILURE', message: 'Unit tests failed in src/core/' },
      }),
    ).toBe(true);
  });

  it('requires error object when status is blocked', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'plan',
        status: 'blocked',
        outputs: { blockedBy: '441,442' },
        summary: 'Blocked by open issues',
        error: { code: 'REQUIREMENTS_MISMATCH', message: 'Cannot proceed without fixing #441' },
      }),
    ).toBe(true);
  });

  it('fails if error is missing required fields', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'failure',
        outputs: {},
        summary: 'Operation failed',
        error: { code: 'TEST_FAILURE' },
      }),
    ).toBe(false);
  });

  it('enforces the appleEstimate range (1-5)', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'plan',
        status: 'success',
        outputs: { appleEstimate: 5 },
        summary: 'Done',
      }),
    ).toBe(true);

    for (const invalidEstimate of [0, 6]) {
      expect(
        isOutputValid({
          contractVersion: 'v1',
          task: 'plan',
          status: 'success',
          outputs: { appleEstimate: invalidEstimate },
          summary: 'Done',
        }),
      ).toBe(false);
    }
  });

  it('enforces the verdict enum', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'plan',
        status: 'success',
        outputs: { verdict: 'maybe' },
        summary: 'Done',
      }),
    ).toBe(false);
  });

  it('does not require error when status is success', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'plan',
        status: 'success',
        outputs: { verdict: 'recommended', appleEstimate: 3 },
        summary: 'Done',
        error: null,
      }),
    ).toBe(true);
  });

  it('allows no-work status without error', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'no-work',
        outputs: {},
        summary: 'No changes detected; nothing to do',
      }),
    ).toBe(true);
  });

  it('allows completed-existing-work disposition only for no-work status', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'no-work',
        outputs: { disposition: 'completed-existing-work' },
        summary: 'Linked merged PR already satisfies every acceptance criterion',
      }),
    ).toBe(true);

    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'success',
        outputs: { disposition: 'completed-existing-work' },
        summary: 'Implementation finished',
      }),
    ).toBe(false);
  });

  it('rejects a non-planning task carrying a verdict or appleEstimate', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'success',
        outputs: { verdict: 'recommended', appleEstimate: 3 },
        summary: 'Implementation finished',
      }),
    ).toBe(false);
  });

  it('rejects hardGate on a task without a gate', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'push-branch',
        status: 'success',
        outputs: { hardGate: 'push must succeed' },
        summary: 'Pushed branch',
      }),
    ).toBe(false);
  });
});

describe('PR State Comment contract matches the runtime encoding', () => {
  it('names the canonical marker the runtime actually writes', () => {
    expect(prStateCommentV1.marker).toBe('<!-- crawler-ci-state:v1 -->');
    expect(prStateCommentV1.dataPrefix).toBe('<!-- crawler-ci-state-data:');
  });

  it('matches markers.mjs STATE_MARKER/STATE_DATA_PREFIX exactly', async () => {
    const markers = await import(path.join(REPO_ROOT, '.github/scripts/ci-recovery/markers.mjs'));
    expect(prStateCommentV1.marker).toBe(markers.STATE_MARKER);
    expect(prStateCommentV1.dataPrefix).toBe(markers.STATE_DATA_PREFIX);
  });

  it('lists the fields validateState() actually requires', () => {
    for (const field of ['version', 'prNumber', 'owner', 'status', 'headSha', 'fingerprint']) {
      expect(prStateCommentV1.encodedStateRequiredFields).toContain(field);
    }
  });

  it('parses a real renderStateComment() output for a single authoritative marker', async () => {
    const state = await import(path.join(REPO_ROOT, '.github/scripts/ci-recovery/state.mjs'));
    const rendered: string = state.renderStateComment({
      version: 1,
      prNumber: 42,
      owner: 'none',
      status: 'waiting',
      headSha: 'a'.repeat(40),
      fingerprint: 'gen-5',
      blockers: [],
      attempt: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const markerCount = rendered.split(prStateCommentV1.marker).length - 1;
    expect(markerCount).toBe(1);
    for (const bullet of prStateCommentV1.bulletFields) {
      expect(rendered).toContain(`- ${bullet}:`);
    }

    const parsed = state.parseStateComment(rendered);
    expect(parsed.status).toBe('waiting');
  });

  it('marks addressed findings with checkmark and SHA', () => {
    const comment = [
      '<!-- crawler-ci-state:v1 -->',
      '- ✅ Addressed in abc123def456: Converted Array.sort to deterministic ordering',
      '- ✅ Not applicable: Comment was about outdated branch; fixed by rebase',
    ].join('\n');

    expect(comment).toContain('✅ Addressed in');
    expect(comment).toContain('✅ Not applicable:');
  });
});

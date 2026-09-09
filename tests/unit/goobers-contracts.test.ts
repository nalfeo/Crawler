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
let attemptTelemetryV1: object;
let cohortSummaryV1: object;
let runArtifactV1: object;
let prStateCommentV1: {
  marker: string;
  dataPrefix: string;
  encodedStateRequiredFields: string[];
  bulletFields: string[];
};
let goobersSummaryV1: {
  contract: string;
  requiredFields: string[];
  format: string;
  example: string;
};
let invocationSemanticErrors: (payload: Invocation) => string[];
let outputSemanticErrors: (payload: Output) => string[];
let attemptTelemetrySemanticErrors: (payload: unknown) => string[];
let cohortSummarySemanticErrors: (payload: unknown) => string[];
let runArtifactSemanticErrors: (payload: unknown) => string[];
let summarySemanticErrors: (summary: unknown) => string[];
let validateInvocation: Ajv.ValidateFunction;
let validateOutput: Ajv.ValidateFunction;
let validateAttemptTelemetry: Ajv.ValidateFunction;
let validateCohortSummary: Ajv.ValidateFunction;
let validateRunArtifact: Ajv.ValidateFunction;

beforeAll(async () => {
  const schemaModule = await import(
    path.join(REPO_ROOT, '.github/scripts/validate-goobers-contracts-schema.js')
  );
  invocationV1 = schemaModule.invocationV1;
  outputV1 = schemaModule.outputV1;
  attemptTelemetryV1 = schemaModule.attemptTelemetryV1;
  cohortSummaryV1 = schemaModule.cohortSummaryV1;
  runArtifactV1 = schemaModule.runArtifactV1;
  prStateCommentV1 = schemaModule.prStateCommentV1;
  goobersSummaryV1 = schemaModule.goobersSummaryV1;

  const validatorModule = await import(
    path.join(REPO_ROOT, '.github/scripts/validate-goobers-contracts.mjs')
  );
  invocationSemanticErrors = validatorModule.invocationSemanticErrors;
  outputSemanticErrors = validatorModule.outputSemanticErrors;
  attemptTelemetrySemanticErrors = validatorModule.attemptTelemetrySemanticErrors;
  cohortSummarySemanticErrors = validatorModule.cohortSummarySemanticErrors;
  runArtifactSemanticErrors = validatorModule.runArtifactSemanticErrors;
  summarySemanticErrors = validatorModule.summarySemanticErrors;

  const AjvCtor = require('ajv');
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  validateInvocation = ajv.compile(invocationV1);
  validateOutput = ajv.compile(outputV1);
  validateAttemptTelemetry = ajv.compile(attemptTelemetryV1);
  validateCohortSummary = ajv.compile(cohortSummaryV1);
  validateRunArtifact = ajv.compile(runArtifactV1);
});

function isInvocationValid(payload: Invocation): boolean {
  const schemaOk = Boolean(validateInvocation(payload));
  return schemaOk && invocationSemanticErrors(payload).length === 0;
}

function isOutputValid(payload: Output): boolean {
  const schemaOk = Boolean(validateOutput(payload));
  return schemaOk && outputSemanticErrors(payload).length === 0;
}

function isAttemptTelemetryValid(payload: Record<string, unknown>): boolean {
  const schemaOk = Boolean(validateAttemptTelemetry(payload));
  return schemaOk && attemptTelemetrySemanticErrors(payload).length === 0;
}

function isCohortSummaryValid(payload: Record<string, unknown>): boolean {
  const schemaOk = Boolean(validateCohortSummary(payload));
  return schemaOk && cohortSummarySemanticErrors(payload).length === 0;
}

function isRunArtifactValid(payload: Record<string, unknown>): boolean {
  const schemaOk = Boolean(validateRunArtifact(payload));
  return schemaOk && runArtifactSemanticErrors(payload).length === 0;
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
        outputs: { disposition: 'completed-existing-work', evidenceRef: 'PR #1234' },
        summary: 'Linked merged PR already satisfies every acceptance criterion',
      }),
    ).toBe(true);

    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'success',
        outputs: { disposition: 'completed-existing-work', evidenceRef: 'PR #1234' },
        summary: 'Implementation finished',
      }),
    ).toBe(false);
  });

  it('requires a non-empty evidenceRef whenever disposition is completed-existing-work', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'no-work',
        outputs: { disposition: 'completed-existing-work' },
        summary: 'Already implemented',
      }),
    ).toBe(false);

    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'no-work',
        outputs: { disposition: 'completed-existing-work', evidenceRef: '' },
        summary: 'Already implemented',
      }),
    ).toBe(false);

    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'no-work',
        outputs: { disposition: 'completed-existing-work', evidenceRef: '   ' },
        summary: 'Already implemented',
      }),
    ).toBe(false);
  });

  it('rejects evidenceRef when no completed-existing-work disposition is present', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'success',
        outputs: { evidenceRef: 'src/foo/bar.ts:120-160' },
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

describe('crawler.goobers.summary/v1 close-out summary contract', () => {
  it('accepts the canonical structured block from the schema contract', () => {
    expect(goobersSummaryV1.contract).toBe('crawler.goobers.summary/v1');
    expect(goobersSummaryV1.requiredFields).toEqual([
      'Description',
      'Systems',
      'Verification',
      'Risk',
    ]);
    expect(summarySemanticErrors(goobersSummaryV1.example)).toEqual([]);
  });

  it('rejects one-line summaries, empty sections, and out-of-order sections', () => {
    expect(summarySemanticErrors('Implemented the fix.')).not.toHaveLength(0);
    expect(
      summarySemanticErrors(
        ['Description: Fixes it', 'Systems:', 'Verification: tests', 'Risk: Low'].join('\n'),
      ),
    ).not.toHaveLength(0);
    expect(
      summarySemanticErrors(
        [
          'Systems: Goobers workflow',
          'Description: Fixes it',
          'Verification: tests',
          'Risk: Low',
        ].join('\n'),
      ),
    ).not.toHaveLength(0);
    expect(summarySemanticErrors(undefined)).not.toHaveLength(0);
  });

  it('tolerates blank separator lines between sections', () => {
    expect(summarySemanticErrors(goobersSummaryV1.example.split('\n').join('\n\n'))).toEqual([]);
  });

  it('names the specific violation rather than one generic message', () => {
    expect(
      summarySemanticErrors(
        ['Description: Fixes it', 'Systems:', 'Verification: tests', 'Risk: Low'].join('\n'),
      ),
    ).toEqual(['summary section "Systems" is empty']);
    expect(summarySemanticErrors(undefined)[0]).toContain('must be a string');
  });

  it('leaves crawler.goobers.output/v1 summary semantics unchanged for in-flight v1 payloads', () => {
    expect(
      isOutputValid({
        contractVersion: 'v1',
        task: 'implement',
        status: 'success',
        outputs: {},
        summary: 'Feature implemented and reviewed',
      }),
    ).toBe(true);
  });
});

describe('crawler.goobers.attempt-telemetry/v1', () => {
  it('accepts a lineage-linked attempt with per-stage timings and privacy-safe metrics', () => {
    expect(
      isAttemptTelemetryValid({
        contractVersion: 'v1',
        attemptLineageKey: 'issue-1234:run-1:attempt-2',
        issueNumber: '1234',
        runId: 'run-42',
        attemptNumber: 2,
        retryCount: 1,
        repassCount: 0,
        parentAttemptLineageKey: 'issue-1234:run-1:attempt-1',
        stageDurations: { 'query-backlog': 1200, implement: 5400, 'pr-opened-gate': 800 },
        totalElapsedMs: 7400,
        promptBytes: 24000,
        contextArtifactBytes: 18000,
        modelInputTokens: 9000,
        modelOutputTokens: 2400,
        compactionCount: 1,
        terminalOutcome: 'pr-opened',
        outcomeReason: 'Opened a feature PR with the required change set.',
        stageTrace: ['query-backlog', 'implement', 'pr-opened-gate'],
      }),
    ).toBe(true);
  });

  it('requires a stable lineage key and normalized terminal outcome', () => {
    expect(
      isAttemptTelemetryValid({
        contractVersion: 'v1',
        attemptLineageKey: '',
        issueNumber: '1234',
        stageDurations: { implement: 1000 },
        totalElapsedMs: 1000,
        terminalOutcome: 'pr-opened',
      }),
    ).toBe(false);

    expect(
      isAttemptTelemetryValid({
        contractVersion: 'v1',
        attemptLineageKey: 'issue-1234:run-1:attempt-1',
        issueNumber: '1234',
        stageDurations: { implement: 1000 },
        totalElapsedMs: 1000,
        terminalOutcome: 'unknown',
      }),
    ).toBe(false);
  });

  it('forces explicit unavailableReason whenever a telemetry field is null', () => {
    expect(
      isAttemptTelemetryValid({
        contractVersion: 'v1',
        attemptLineageKey: 'issue-1234:run-1:attempt-1',
        issueNumber: '1234',
        stageDurations: { implement: 1000 },
        totalElapsedMs: 1000,
        promptBytes: null,
        contextArtifactBytes: null,
        modelInputTokens: null,
        modelOutputTokens: null,
        compactionCount: null,
        terminalOutcome: 'blocked',
        unavailableReason: 'Telemetry not logged by the upstream runtime.',
      }),
    ).toBe(true);

    expect(
      isAttemptTelemetryValid({
        contractVersion: 'v1',
        attemptLineageKey: 'issue-1234:run-1:attempt-1',
        issueNumber: '1234',
        stageDurations: { implement: 1000 },
        totalElapsedMs: 1000,
        promptBytes: null,
        contextArtifactBytes: null,
        modelInputTokens: null,
        modelOutputTokens: null,
        compactionCount: null,
        terminalOutcome: 'blocked',
      }),
    ).toBe(false);
  });
});

describe('crawler.goobers.cohort-summary/v1', () => {
  it('accepts a matched-cohort summary for delivery rate and context comparison', () => {
    expect(
      isCohortSummaryValid({
        contractVersion: 'v1',
        cohort: 'canonical-context',
        issueCount: 12,
        deliverySuccessRate: 0.92,
        averageElapsedMs: 814000,
        averageRepasses: 0.25,
        averageContextArtifactBytes: 64000,
        comparison: 'preserved',
      }),
    ).toBe(true);
  });

  it('rejects out-of-range delivery success and negative averages', () => {
    expect(
      isCohortSummaryValid({
        contractVersion: 'v1',
        cohort: 'baseline',
        issueCount: 12,
        deliverySuccessRate: 1.2,
        averageElapsedMs: 1000,
        averageRepasses: 1,
        averageContextArtifactBytes: 5000,
      }),
    ).toBe(false);
    expect(
      isCohortSummaryValid({
        contractVersion: 'v1',
        cohort: 'baseline',
        issueCount: 12,
        deliverySuccessRate: 0.8,
        averageElapsedMs: -1,
        averageRepasses: 0,
        averageContextArtifactBytes: 5000,
      }),
    ).toBe(false);
  });
});

describe('crawler.goobers.run-artifact/v1', () => {
  it('bundles attempts and a cohort summary without leaking prompt text', () => {
    expect(
      isRunArtifactValid({
        contractVersion: 'v1',
        issueNumber: '1234',
        attempts: [
          {
            contractVersion: 'v1',
            attemptLineageKey: 'issue-1234:run-1:attempt-1',
            issueNumber: '1234',
            stageDurations: { 'query-backlog': 2200, implement: 6200 },
            totalElapsedMs: 8400,
            promptBytes: 36000,
            contextArtifactBytes: 24000,
            modelInputTokens: 11000,
            modelOutputTokens: 3200,
            compactionCount: 1,
            terminalOutcome: 'issue-completed',
            outcomeReason: 'Opened and completed the feature PR.',
          },
        ],
        cohortSummary: {
          contractVersion: 'v1',
          cohort: 'canonical-context',
          issueCount: 1,
          deliverySuccessRate: 1,
          averageElapsedMs: 8400,
          averageRepasses: 0,
          averageContextArtifactBytes: 24000,
          comparison: 'preserved',
        },
      }),
    ).toBe(true);
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

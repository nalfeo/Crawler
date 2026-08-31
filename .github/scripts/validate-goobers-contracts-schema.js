/**
 * Crawler CI/Goobers Contract Schemas (v1)
 *
 * JSON Schema definitions for all inputs/outputs between GitHub Actions,
 * CI Recovery, Merge Train, and Goobers workflows.
 *
 * Version: v1
 * Last Updated: 2026-08-28
 */

export const invocationV1 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'crawler.goobers.invocation/v1',
  description: 'Payload structure for workflow dispatch invocations',
  type: 'object',
  required: ['contractVersion', 'workflowName', 'operation'],
  properties: {
    contractVersion: {
      type: 'string',
      enum: ['v1'],
      description: 'Schema version; unknown versions fail closed',
    },
    workflowName: {
      type: 'string',
      description: 'Target workflow name (ci-recovery, merge-train, merge-train-validate)',
      minLength: 1,
    },
    operation: {
      type: 'string',
      enum: [
        'reconcile',
        'lease-acquire',
        'lease-heartbeat',
        'lease-release',
        'validate-candidate',
      ],
      // 'run-feature-pr' is intentionally NOT a value here: no real producer
      // (router.mjs, reconcile.mjs) ever mints an invocationV1 envelope with
      // it. Goobers Run (.github/workflows/goobers-run.yml) is dispatched
      // with its own distinct workflow_dispatch inputs (goobers_version,
      // workflow, issue_number, abandon_existing) that are never packaged
      // into a crawler.goobers.invocation/v1 envelope; those inputs are
      // validated directly against the workflow YAML via
      // REQUIRED_DISPATCH_INPUTS in validate-goobers-contracts.mjs instead.
      description: 'Operation type',
    },
    pr_number: {
      // GitHub Actions `workflow_dispatch` inputs have no native numeric type
      // (only string/boolean/choice/environment), and every dispatch caller
      // in this repo sends `pr_number: String(prNumber)` (see
      // reconcile-lib.mjs dispatchRecoveryWorkflow). The wire value is always
      // a numeric string; require it to look like one.
      // Never 'null': GitHub Actions omits an unset workflow_dispatch input
      // entirely (or sends '') rather than transmitting a JSON null, so a
      // 'null' type here would validate a shape no real producer can send.
      // Optionality is expressed by omitting the key -- see `required` above.
      type: 'string',
      pattern: '^[0-9]+$',
      description:
        'PR number as a numeric string (GitHub Actions inputs are always strings); ' +
        'required for PR-scoped ops, forbidden for batch ops',
    },
    expected_head_sha: {
      type: 'string',
      description: 'Optional head SHA snapshot; fail-closed if live PR diverges',
    },
    expected_base_ref: {
      type: 'string',
      description: 'Optional base ref snapshot; required if expected_head_sha is set',
    },
    fingerprint: {
      type: 'string',
      description: 'Generation token for candidate validation idempotency',
    },
    candidate_sha: {
      type: 'string',
      description: 'Immutable candidate commit SHA; required for validate-candidate',
    },
    candidate_ref: {
      type: 'string',
      description: 'Opaque candidate ref (Git bundle); required for validate-candidate',
    },
    attestation_sha: {
      type: 'string',
      description: 'Main commit that receives validation check; required for validate-candidate',
    },
    pr_numbers: {
      type: 'string',
      description: 'Comma-separated PR numbers for batch operations',
    },
    lease_id: {
      type: 'string',
      description: 'Non-secret shepherd ownership identifier',
    },
    trigger: {
      // Real trigger values are free-form business-reason strings minted by
      // the dispatching script (e.g. 'merge-train-noop',
      // 'merge-train-cumulative-conflict:41', '${eventName}:sweep' from
      // recoveryTriggerForPr in ci-recovery/router.mjs), not a closed set of
      // GitHub event names -- a fixed enum here would reject real producer
      // traffic.
      type: 'string',
      minLength: 1,
      description: 'Free-form reason string describing why this invocation was dispatched',
    },
    issue_number: {
      // Same GitHub Actions string-only input constraint as pr_number: never
      // 'null', since an unset input is simply an absent key on the wire.
      type: 'string',
      pattern: '^[0-9]+$',
      description: 'Goobers issue number as a numeric string, for feature tracking',
    },
  },
  additionalProperties: false,

  /**
   * Custom validation rules (beyond JSON Schema)
   * Checked in Node.js validation code:
   * - When operation contains "candidate": candidate_sha, candidate_ref, attestation_sha, fingerprint ALL required
   * - When expected_head_sha is set: expected_base_ref is required
   * - pr_number required for PR-scoped operations (reconcile, lease-*); forbidden for others
   */
};

export const outputV1 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'crawler.goobers.output/v1',
  description: 'Result payload from Goobers workflow execution',
  type: 'object',
  required: ['contractVersion', 'task', 'status', 'outputs', 'summary'],
  properties: {
    contractVersion: {
      type: 'string',
      enum: ['v1'],
      description: 'Schema version; unknown versions fail closed',
    },
    task: {
      type: 'string',
      enum: [
        'query-backlog',
        'hydrate-requirements',
        'plan',
        'materialize-plan',
        'implement',
        'push-branch',
        'local-ci',
        'open-pr',
        'close-out',
        'park-needs-human',
        'needs-remediation',
        'review',
        'local-gate',
        'pr-opened-gate',
      ],
      description:
        'Discriminator naming the Goobers task/gate (see .goobers/gaggles/crawler/workflows/' +
        'crawler-feature-pr.yaml) that produced this output; gates operation-specific field ' +
        'applicability below',
    },
    status: {
      type: 'string',
      enum: ['success', 'failure', 'no-work', 'blocked'],
      description: 'Execution status',
    },
    outputs: {
      type: 'object',
      description: 'Operation-specific scalar outputs',
      required: [],
      properties: {
        verdict: {
          type: ['string', 'null'],
          enum: ['recommended', 'risky', 'not-recommended', null],
          description: "Planning verdict; only non-null when task='plan'",
        },
        appleEstimate: {
          type: ['number', 'null'],
          minimum: 1,
          maximum: 5,
          description: "Apple complexity estimate; only non-null when task='plan'",
        },
        hardGate: {
          type: ['string', 'null'],
          description:
            "Gate criteria; only non-null when task is one of 'plan', 'local-gate', " +
            "'pr-opened-gate', or 'review'",
        },
        blockedBy: {
          type: ['string', 'null'],
          description: "Comma-separated issue numbers (when status='blocked')",
        },
        disposition: {
          type: ['string', 'null'],
          enum: ['completed-existing-work', null],
          description:
            "Machine-readable no-work disposition; 'completed-existing-work' marks a claimed issue already satisfied by repository evidence",
        },
      },
      additionalProperties: false,
    },
    summary: {
      type: 'string',
      minLength: 1,
      description: 'One-line summary for humans',
    },
    error: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: {
              type: 'string',
              enum: [
                'REQUIREMENTS_MISMATCH',
                'TEST_FAILURE',
                'MERGE_CONFLICT',
                'SCHEMA_VIOLATION',
                'TIMEOUT',
                'INTERNAL_ERROR',
              ],
              description: 'Error classification',
            },
            message: {
              type: 'string',
              minLength: 1,
              description: 'Actionable error description',
            },
          },
          additionalProperties: false,
        },
      ],
      description: 'Error details; required if status is failure/blocked',
    },
  },
  additionalProperties: false,

  /**
   * Custom validation rules (beyond JSON Schema)
   * Checked in Node.js validation code:
   * - When status='failure' or 'blocked': error is required and non-null
   * - When status='success' or 'no-work': error must be null or omitted
   * - outputs.verdict only non-null when task='plan'
   * - outputs.appleEstimate only non-null when task='plan'
   * - outputs.hardGate only non-null when task is 'plan', 'local-gate', 'pr-opened-gate', or 'review'
   * - outputs.disposition='completed-existing-work' only when status='no-work'
   * - Deterministic gates fail on schema violation
   */
};

export const prStateCommentV1 = {
  /**
   * CI Recovery → Pinned PR State Comment Contract
   *
   * Describes the authoritative state comment CI Recovery posts/updates on
   * each PR. This mirrors the real runtime encoding in
   * `.github/scripts/ci-recovery/markers.mjs` (STATE_MARKER/STATE_DATA_PREFIX)
   * and `.github/scripts/ci-recovery/state.mjs` (renderStateComment/
   * parseStateComment/validateState) rather than a hypothetical format, so a
   * consumer implementing this contract can actually locate and parse live
   * state.
   */
  description: 'Authoritative CI recovery state tracked in a pinned comment on each PR',
  marker: '<!-- crawler-ci-state:v1 -->',
  dataPrefix: '<!-- crawler-ci-state-data:',
  format:
    'HTML anchor marker line, followed by a data line embedding base64url-encoded JSON ' +
    '(`<!-- crawler-ci-state-data:<base64url(JSON.stringify(state))> -->`), followed by ' +
    'human-readable Markdown bullet fields (not a table) rendered from the same state object',
  encodedStateRequiredFields: [
    'version',
    'prNumber',
    'owner',
    'status',
    'headSha',
    'fingerprint',
    'blockers',
    'attempt',
    'updatedAt',
  ],
  ownerEnum: ['none', 'shepherd', 'human'],
  bulletFields: ['Owner', 'Status', 'Head', 'Fingerprint', 'Blockers', 'Updated'],
  addressedFindingsSection: 'Append-only list of `✅ Addressed in <sha>: <reason>` markers',
};

export default {
  invocationV1,
  outputV1,
  prStateCommentV1,
};

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

/**
 * `crawler.goobers.summary/v1` — the human-readable close-out summary contract.
 *
 * This is a separate contract from `crawler.goobers.output/v1`, whose `summary`
 * field keeps its original "non-empty string" v1 semantics so in-flight v1
 * outputs stay valid. The structured shape below is required of the summary the
 * coder emits for the terminal issue close-out comment, and is enforced by
 * `summarySemanticErrors()` in validate-goobers-contracts.mjs.
 */
export const goobersSummaryV1 = {
  contract: 'crawler.goobers.summary/v1',
  description:
    'Human-readable Goobers summary emitted on the final issue/PR status comment; it must be a brief structured block with Description, Systems, Verification, and Risk sections.',
  requiredFields: Object.freeze(['Description', 'Systems', 'Verification', 'Risk']),
  format:
    'Markdown block with one short label prefix per line or bullet, in order: ' +
    'Description, Systems, Verification, Risk. Single-sentence summaries are rejected.',
  example: [
    'Description: Fixes the Goobers summary so it states the change in plain language.',
    'Systems: Goobers workflow, validation schema, issue-close-out output contract',
    'Verification: node .github/scripts/validate-goobers-contracts.mjs; npx vitest run tests/unit/goobers-contracts.test.ts',
    'Risk: Low — this is contract-only work and does not change game logic or runtime behavior.',
  ].join('\n'),
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
        idempotencyKey: {
          type: ['string', 'null'],
          description:
            'Deterministic key that collapses duplicate shadow-mode replays to one decision artifact',
        },
        parityStatus: {
          type: ['string', 'null'],
          enum: ['clean', 'divergence', null],
          description: 'Shadow-mode parity verdict for legacy-vs-Goobers comparison',
        },
        decisionArtifact: {
          type: ['string', 'null'],
          description: 'Path or pointer to the deterministic shadow decision artifact',
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
        evidenceRef: {
          type: ['string', 'null'],
          minLength: 1,
          pattern: '\\S',
          description:
            "Concrete, checkable citation proving the coder actually investigated the claim before disposition='completed-existing-work' " +
            "(a merged PR/commit reference such as 'PR #1234' or 'commit abc1234', or a repository path with a line range such as " +
            "'src/foo/bar.ts:120-160'). Required whenever disposition='completed-existing-work'; forbidden otherwise.",
        },
      },
      additionalProperties: false,
    },
    summary: {
      type: 'string',
      minLength: 1,
      description:
        'Human-readable summary; any non-empty string is valid under v1. Terminal close-out ' +
        'summaries should additionally follow crawler.goobers.summary/v1.',
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
   * - outputs.evidenceRef only non-null when outputs.disposition='completed-existing-work'
   * - outputs.evidenceRef is required (non-empty) when outputs.disposition='completed-existing-work'
   * - Deterministic gates fail on schema violation
   */
};

export const attemptTelemetryV1 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'crawler.goobers.attempt-telemetry/v1',
  description:
    'Per-attempt journal telemetry for a Goobers feature-PR attempt, including lineage, stage timings, privacy-safe context footprint, and normalized terminal outcome.',
  type: 'object',
  required: ['attemptLineageKey', 'issueNumber', 'terminalOutcome', 'stageDurations', 'totalElapsedMs'],
  properties: {
    contractVersion: {
      type: 'string',
      enum: ['v1'],
      description: 'Schema version for the attempt telemetry record.',
    },
    attemptLineageKey: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9._:-]+$',
      description:
        'Stable lineage key that links the initial run, retries, resumes, and repasses for one issue.',
    },
    issueNumber: {
      type: 'string',
      pattern: '^[0-9]+$',
      description: 'Issue number as a numeric string so the record stays compatible with GH Actions inputs.',
    },
    runId: {
      type: 'string',
      minLength: 1,
      description: 'Goobers run ID or workflow run ID owning this attempt.',
    },
    attemptNumber: {
      type: 'integer',
      minimum: 1,
      description: '1-based attempt ordinal within the issue lineage.',
    },
    retryCount: {
      type: 'integer',
      minimum: 0,
      description: 'Number of retries already absorbed by the attempted issue lineage.',
    },
    repassCount: {
      type: 'integer',
      minimum: 0,
      description: 'Number of repasses already absorbed by the attempted issue lineage.',
    },
    parentAttemptLineageKey: {
      type: ['string', 'null'],
      minLength: 1,
      pattern: '^[A-Za-z0-9._:-]+$',
      description: 'Previous attempt in the same lineage; null for the root attempt.',
    },
    stageDurations: {
      type: 'object',
      description: 'Per-stage durations keyed by stage name, in milliseconds.',
      additionalProperties: {
        type: 'number',
        minimum: 0,
      },
    },
    totalElapsedMs: {
      type: 'number',
      minimum: 0,
      description: 'Total wall-clock elapsed milliseconds for this attempt.',
    },
    promptBytes: {
      type: ['number', 'null'],
      minimum: 0,
      description: 'Prompt payload bytes, or null when unavailable with an explicit reason.',
    },
    contextArtifactBytes: {
      type: ['number', 'null'],
      minimum: 0,
      description: 'Supplied context-artifact bytes, or null when unavailable with an explicit reason.',
    },
    modelInputTokens: {
      type: ['number', 'null'],
      minimum: 0,
      description: 'Model input tokens, or null when unavailable with an explicit reason.',
    },
    modelOutputTokens: {
      type: ['number', 'null'],
      minimum: 0,
      description: 'Model output tokens, or null when unavailable with an explicit reason.',
    },
    compactionCount: {
      type: ['number', 'null'],
      minimum: 0,
      description: 'Context compaction count, or null when unavailable with an explicit reason.',
    },
    unavailableReason: {
      type: ['string', 'null'],
      description: 'Explicit reason for any null telemetry field; required when a field is absent or null.',
    },
    terminalOutcome: {
      type: 'string',
      enum: ['pr-opened', 'issue-completed', 'blocked', 'timeout', 'no-work', 'aborted'],
      description: 'Normalized terminal outcome for the issue attempt. Future states can be added via the extension policy.',
    },
    outcomeReason: {
      type: 'string',
      minLength: 1,
      description: 'Short human-readable reason for the normalized terminal outcome.',
    },
    stageTrace: {
      type: 'array',
      description: 'Optional ordered stage names for auditability; never stores prompt text or credentials.',
      items: {
        type: 'string',
        minLength: 1,
      },
    },
  },
  additionalProperties: false,
};

export const runJournalAttemptV1 = attemptTelemetryV1;
export const runArtifactV1 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'crawler.goobers.run-artifact/v1',
  description:
    'Run artifact for a Goobers feature-PR attempt cohort, bundling per-attempt telemetry and a matched-cohort summary.',
  type: 'object',
  required: ['contractVersion', 'issueNumber', 'attempts'],
  properties: {
    contractVersion: {
      type: 'string',
      enum: ['v1'],
    },
    issueNumber: {
      type: 'string',
      pattern: '^[0-9]+$',
    },
    attempts: {
      type: 'array',
      items: {
        $ref: '#/definitions/attemptTelemetry',
      },
    },
    cohortSummary: {
      type: ['object', 'null'],
      description: 'Optional matched-cohort summary for comparison against canonical-context behavior.',
    },
  },
  definitions: {
    attemptTelemetry: attemptTelemetryV1,
  },
  additionalProperties: false,
};

export const cohortSummaryV1 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'crawler.goobers.cohort-summary/v1',
  description:
    'Aggregate entry for comparing baseline and canonical-context cohorts on delivery success, elapsed time, repasses, and context bytes.',
  type: 'object',
  required: ['cohort', 'issueCount', 'deliverySuccessRate', 'averageElapsedMs', 'averageRepasses', 'averageContextArtifactBytes'],
  properties: {
    contractVersion: {
      type: 'string',
      enum: ['v1'],
    },
    cohort: {
      type: 'string',
      minLength: 1,
      description: 'Cohort label such as baseline or canonical-context.',
    },
    issueCount: {
      type: 'integer',
      minimum: 0,
    },
    deliverySuccessRate: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    averageElapsedMs: {
      type: 'number',
      minimum: 0,
    },
    averageRepasses: {
      type: 'number',
      minimum: 0,
    },
    averageContextArtifactBytes: {
      type: 'number',
      minimum: 0,
    },
    comparison: {
      type: ['string', 'null'],
      enum: ['improved', 'preserved', 'regressed', 'inconclusive', null],
      description: 'Optional comparison to the matched baseline or canonical-context cohort.',
    },
  },
  additionalProperties: false,
};

export const attemptTelemetryV1Alias = attemptTelemetryV1;
export const cohortSummaryV1Alias = cohortSummaryV1;
export const runArtifactV1Alias = runArtifactV1;

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
  goobersSummaryV1,
  attemptTelemetryV1,
  runJournalAttemptV1,
  runArtifactV1,
  cohortSummaryV1,
};

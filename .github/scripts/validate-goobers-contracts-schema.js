/**
 * Crawler CI/Goobers Contract Schemas (v1)
 *
 * JSON Schema definitions for all inputs/outputs between GitHub Actions,
 * CI Recovery, Merge Train, and Goobers workflows.
 *
 * Version: v1
 * Last Updated: 2026-08-28
 */

module.exports = {
  /**
   * GHA → Goobers Invocation Contract
   *
   * Describes workflow dispatch inputs sent from GitHub Actions
   * to CI Recovery, Merge Train, or Goobers workflows.
   */
  invocationV1: {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "crawler.goobers.invocation/v1",
    description: "Payload structure for workflow dispatch invocations",
    type: "object",
    required: ["contractVersion", "workflowName", "operation"],
    properties: {
      contractVersion: {
        type: "string",
        enum: ["v1"],
        description: "Schema version; unknown versions fail closed",
      },
      workflowName: {
        type: "string",
        description:
          "Target workflow name (ci-recovery, merge-train, goobers-run, etc.)",
        minLength: 1,
      },
      operation: {
        type: "string",
        enum: [
          "reconcile",
          "lease-acquire",
          "lease-heartbeat",
          "lease-release",
          "validate-candidate",
          "run-feature-pr",
        ],
        description: "Operation type",
      },
      pr_number: {
        type: ["number", "null"],
        description:
          "PR number; required for PR-scoped ops, forbidden for batch ops",
      },
      expected_head_sha: {
        type: "string",
        description:
          "Optional head SHA snapshot; fail-closed if live PR diverges",
      },
      expected_base_ref: {
        type: "string",
        description:
          "Optional base ref snapshot; required if expected_head_sha is set",
      },
      fingerprint: {
        type: "string",
        description: "Generation token for candidate validation idempotency",
      },
      candidate_sha: {
        type: "string",
        description:
          "Immutable candidate commit SHA; required for validate-candidate",
      },
      candidate_ref: {
        type: "string",
        description:
          "Opaque candidate ref (Git bundle); required for validate-candidate",
      },
      attestation_sha: {
        type: "string",
        description:
          "Main commit that receives validation check; required for validate-candidate",
      },
      pr_numbers: {
        type: "string",
        description: "Comma-separated PR numbers for batch operations",
      },
      lease_id: {
        type: "string",
        description: "Non-secret shepherd ownership identifier",
      },
      trigger: {
        type: "string",
        enum: [
          "workflow_dispatch",
          "schedule",
          "pull_request_target",
          "push",
          "workflow_run",
          "issue_comment",
        ],
        description: "Event that triggered this invocation",
      },
      issue_number: {
        type: ["number", "null"],
        description: "Goobers issue number for feature tracking",
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
  },

  /**
   * Goobers → State Output Contract
   *
   * Describes the result payload produced by Goobers workflows
   * and written to PR/issue state.
   */
  outputV1: {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "crawler.goobers.output/v1",
    description: "Result payload from Goobers workflow execution",
    type: "object",
    required: ["contractVersion", "status", "outputs", "summary"],
    properties: {
      contractVersion: {
        type: "string",
        enum: ["v1"],
        description: "Schema version; unknown versions fail closed",
      },
      status: {
        type: "string",
        enum: ["success", "failure", "no-work", "blocked"],
        description: "Execution status",
      },
      outputs: {
        type: "object",
        description: "Operation-specific scalar outputs",
        required: [],
        properties: {
          verdict: {
            type: ["string", "null"],
            enum: ["recommended", "risky", "not-recommended", null],
            description: "Planning verdict; only for planning operations",
          },
          appleEstimate: {
            type: ["number", "null"],
            minimum: 1,
            maximum: 5,
            description: "Apple complexity estimate; only for planning operations",
          },
          hardGate: {
            type: ["string", "null"],
            description: "Gate criteria; only for operations with explicit gates",
          },
          blockedBy: {
            type: ["string", "null"],
            description:
              "Comma-separated issue numbers (when status='blocked')",
          },
        },
        additionalProperties: false,
      },
      summary: {
        type: "string",
        minLength: 1,
        description: "One-line summary for humans",
      },
      error: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: {
                type: "string",
                enum: [
                  "REQUIREMENTS_MISMATCH",
                  "TEST_FAILURE",
                  "MERGE_CONFLICT",
                  "SCHEMA_VIOLATION",
                  "TIMEOUT",
                  "INTERNAL_ERROR",
                ],
                description: "Error classification",
              },
              message: {
                type: "string",
                minLength: 1,
                description: "Actionable error description",
              },
            },
            additionalProperties: false,
          },
        ],
        description: "Error details; required if status is failure/blocked",
      },
    },
    additionalProperties: false,

    /**
     * Custom validation rules (beyond JSON Schema)
     * Checked in Node.js validation code:
     * - When status='failure' or 'blocked': error is required and non-null
     * - When status='success' or 'no-work': error must be null or omitted
     * - verdict only non-null for planning operations
     * - appleEstimate only non-null for planning operations
     * - Deterministic gates fail on schema violation
     */
  },

  /**
   * PR State Comment Schema
   *
   * Markdown/HTML structure for the authoritative PR state comment
   * created and maintained by CI Recovery.
   */
  prStateCommentV1: {
    description:
      "Authoritative PR state tracked in pinned comment on each PR",
    format:
      "markdown with HTML anchor <!-- crawler-pr-state-v1 --> for lookup",
    requiredFields: [
      "Disposition",
      "Lock Holder",
      "Lease Expires",
      "Next Action",
      "Last Updated",
      "CI Results",
    ],
    dispositionEnum: [
      "admitted",
      "queued",
      "blocked",
      "landed",
      "stalled",
      "unowned",
    ],
    lockHolderFormat:
      "<shepherd-id (idempotency key)> | unowned | human-escalation",
    leaseExpiresFormat: "ISO 8601 timestamp | N/A",
    ciResultsFormat: "Markdown link to check-run or verdict",
    addressedFindingsSection:
      "Append-only list of `✅ Addressed in <sha>: <reason>` markers",
  },
};

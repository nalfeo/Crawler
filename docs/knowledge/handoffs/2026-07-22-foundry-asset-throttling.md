# Session Handoff: Bound asset workflow concurrency and switch CI to Foundry

## Date

2026-07-22

## Persona(s) adopted

**DevOps / Infra** for GitHub Actions capacity, Azure AI Foundry configuration,
queue-worker concurrency, and provider retry behavior.

## Routing verdict

Recommended. Keeping one Actions job while adding bounded in-process concurrency
improves throughput without allowing asset generation to consume additional
runner slots.

## Apples

Estimated: 3
Actual: 3

The change spans workflow configuration, queue lifecycle, five provider adapters,
shared retry transport, error taxonomy, operational secret sync, and deterministic
coverage, but remains confined to asset/developer tooling.

## Systems touched

sprite-workflow, sprite-pipeline, azure-infra, ci-policy

## Review Harness

Ledger:
`docs/knowledge/review-ledgers/2026-07-22-foundry-asset-throttling.review-ledger.json`

- Plan review: Claude Sonnet 4.6, seven concerns resolved, minor divergence.
- Code review round 1: three related taxonomy/coverage/documentation concerns
  resolved.
- Code review round 2: two selector/worker coverage concerns resolved.

## What Was Done

- Preserved one workflow-level concurrency group and one `drain` job, with
  `queue: single`, so the workflow consumes at most one active runner and retains
  at most one pending run.
- Added a configurable two-slot worker pool. Each slot owns one queue message
  through processing and acknowledgement; public idle status is emitted only
  after a complete all-slot empty round.
- Added shared bounded retry for 429, 5xx, and network failures across image,
  text, synthesis, selector, and vision adapters. Retry timing prefers
  `retry-after-ms`, then `Retry-After`, then bounded jittered exponential backoff.
- Split deterministic `request-error` from transient `server-error`, `network`,
  `rate-limit`, and unexpected `provider-error` failures.
- Rewired the asset workflow to the separate `FOUNDRY_*` endpoint, models, and
  provider selectors. Removed legacy Azure OpenAI worker bindings.
- Updated `setup:azure:github` to provision and synchronize Foundry configuration.
- Synchronized the Foundry GitHub secrets operationally without exposing values.

## Runtime / real-artifact observation

This is tooling-only and does not add an ECS system or alter gameplay. The real
workflow artifact remains manually disabled, so no production queue run was
started. Structural workflow tests prove one job, single-pending-run semantics,
two worker slots, complete Foundry routing, and no legacy Azure OpenAI bindings.
Worker/provider tests exercise concurrent message ownership, drain/abort behavior,
retry timing and budgets, and permanent/transient acknowledgement policy.

## Test Results

- Targeted provider and worker tests: 27 passed.
- `npm run verify:fast`: 31 files and 422 tests passed.
- Foundry provisioning tests: 54 assertions passed earlier in the session.

## Key Decisions Made

- Parallelize queue messages only; stages within a request, batch briefs, and
  variant judging remain serial.
- Use three total provider attempts with a bounded total sleep budget rather than
  waiting for the 15-minute Azure Queue visibility timeout after every transient
  provider response.
- Keep unexpected `provider-error` transient because pipeline wrapping can include
  storage and filesystem failures; only deterministic `request-error` is dropped
  immediately.
- Reuse `FOUNDRY_TEXT_MODEL` for synthesis because the supported configuration has
  no independent synthesis model.

## Blockers

None for the PR. The asset-request workflow remains manually disabled and should
only be re-enabled after merge when the maintainer explicitly resumes generation.

## Branch State

- Branch: `nalfeo-foundry-asset-throttling`
- PR creation: pending
- Guard telemetry file: not present

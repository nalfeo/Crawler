# Nightly balance issue filer

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3 apples estimated and actual - exact. The change added a workflow, a transactional
helper/CLI, deterministic tests, and review/operational documentation.

## What changed

- Added `.github/workflows/nightly-balance-issue.yml`, scheduled daily at 08:00 UTC
  and manually dispatchable, with fixed serialized concurrency, least-privilege
  permissions, a trusted default-branch checkout, disabled persisted credentials,
  and step-scoped tokens.
- Added a dependency-free Node ESM filer under
  `.github/scripts/nightly-balance-issue/`. It paginates all open issues, ignores
  pull requests, exact-matches the durable issue title, and returns without mutation
  when the issue already exists.
- New issues are created with `GITHUB_TOKEN` after ensuring the shared
  `human-approval-required` label exists. The same process then calls the existing
  `runIssueIntake` helper with `CRAWLER_CI_PAT`, preserving the repository's Copilot
  assignment and kickoff-comment logic.
- Intake failures close the newly created issue with `GITHUB_TOKEN` and rethrow the
  original failure. If rollback also fails, both failures are reported through an
  `AggregateError`.
- A later run resumes intake only for an orphaned issue proven to be owned by this
  automation (`github-actions[bot]` opener plus `automation` label) and lacking the
  durable Copilot-assignment proof produced by successful intake. Completed or
  foreign exact-title issues remain mutation-free no-ops.
- The issue body encodes aggregate-only current-main evidence, production
  reachability and causal attribution, up-to-three including zero, isolated
  canonical sweeps, no-evidence/no-PR behavior, a durable evidence ledger, and the
  mandatory owner-approval gate for any future gameplay PR.
- Every terminal no-PR outcome must post its rationale/ledger evidence and close the
  issue so a later nightly run can evaluate newly available telemetry.

## Key decisions

- Reused `.github/scripts/ci-recovery/github.mjs`,
  `.github/scripts/ci-recovery/issue-intake-lib.mjs`, and the exported
  `HUMAN_APPROVAL_LABEL`; no parallel assignment or approval logic was introduced.
- Kept the duplicate check over all open issues rather than filtering by labels so a
  malformed exact-title predecessor still blocks duplicate creation.
- Used a fixed concurrency key shared by scheduled and manual triggers.
- Did not dispatch the live workflow or create a live issue during validation.
- No ADR was needed because the change remains within the existing `ci-policy`
  automation system and its established intake architecture.

## Review harness

- Separate-model plan review: `claude-sonnet-5`, five concerns resolved,
  `plan_divergence=minor`.
- Code review: `claude-sonnet-4.6`, round 1 clean with no concerns.
- PR review validation: `claude-sonnet-5` with independent `gpt-5.3-codex`
  adjudication, three valid concerns resolved in round 2.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-16-nightly-balance-issue-filer.review-ledger.json`.

## Validation and observation

- `node --test .github/scripts/nightly-balance-issue/nightly-balance-issue.test.mjs`
  - 11/11 passing, including intake-plus-rollback double-failure and orphan-resume
    coverage.
- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs` - 5/5 passing
  after exporting shared intake identity helpers.
- `npm run verify:fast` - passing.
- `npm run scope` - `gameplay_safe=true`.
- Before implementation there was no repository-owned scheduled filer on `main`.
  The deterministic mocked artifact now runs the filer twice against shared remote
  state and observes exactly one open issue creation and one Copilot intake; the
  second run returns the existing issue without mutation.
- Failure observation injects a Copilot intake error after creation and confirms the
  new issue is closed while the original error is preserved, allowing the next
  nightly run to retry.

## Follow-up

None. The first production execution should occur from the schedule; validation
intentionally did not manually dispatch it.

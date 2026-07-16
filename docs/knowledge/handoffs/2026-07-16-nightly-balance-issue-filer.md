# Handoff: Nightly telemetry balance issue filer

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3 apples estimated, 3 actual (exact) -- a new scheduled automation helper,
workflow, and deterministic policy/idempotency test suite.

## What changed

- Added `.github/workflows/nightly-balance-sweep.yml`, scheduled daily at
  08:00 UTC with manual dispatch, serialized non-cancelling concurrency,
  least-privilege permissions, a bounded timeout, and trusted default-branch
  checkout without persisted credentials.
- Added a dependency-free ESM filer under
  `.github/scripts/nightly-balance-sweep/`. It validates repository and both
  tokens before any API operation, paginates every open issue, ignores pull
  requests, and treats an exact-title open issue as a strict mutation/intake
  no-op.
- Centralized the exact issue title, labels, approval-label metadata, and static
  evidence-gated issue body. The body rejects partial/shard-only baselines,
  dormant runtime paths, unsupported causality, combined treatment inference,
  quota-filling, and 10-seed acceptance.
- The filer creates the issue with `GITHUB_TOKEN`, then directly reuses
  `runIssueIntake` with `CRAWLER_CI_PAT` so token event suppression cannot strand
  the issue without Copilot intake. No Copilot GraphQL logic was duplicated.
- Added compensating cleanup: intake failure closes the newly created issue and
  rethrows the original failure; a cleanup failure is reported and attached
  without replacing the intake error.
- Added deterministic race handling for concurrent approval-label creation and
  same-title issue creation. The lower-numbered open issue wins, and this run
  closes its duplicate before intake.
- Added the new Node test glob to `npm run test:guards`.
- While running that aggregate gate, fixed a Windows portability defect already
  exposed by `scripts/agent/preflight-lib.test.mjs`: cache and sibling-binary
  probes now preserve the path style supplied by their caller instead of forcing
  host-native separators. Added a native-backslash regression alongside the
  existing slash-style Linux/macOS/Git-Bash cases.

## Review harness

- Plan review: `gpt-5.4`, four concerns resolved, `plan_divergence: minor`.
  The review added parsed-YAML assertions, exact workflow-field coverage,
  concurrent label/issue handling, extra env/PR/case/cleanup tests, and reuse of
  the canonical approval-label constant.
- Code review: `claude-sonnet-4.6`, two clean rounds with zero concerns. The
  second and final bounded round re-reviewed the complete diff after the
  preflight portability fix.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-16-nightly-balance-issue-filer.review-ledger.json`.

## Verification

- `node --test .github/scripts/nightly-balance-sweep/filer.test.mjs` -- 10/10
  passed.
- `node --test scripts/agent/preflight-lib.test.mjs` -- 20/20 passed.
- `npm run test:guards` -- 938 passed, 0 failed, 23 intentionally skipped.
- `npm run verify:fast` -- passed.
- Review ledger validation -- passed.
- The live workflow was intentionally not dispatched during validation.

## Safety boundaries

- No gameplay code or balance values changed.
- No ADR was needed; the implementation follows existing scheduled workflow,
  GitHub REST helper, issue-intake, approval-label, and Node test patterns.
- The approval gate described by the generated issue applies to future gameplay
  PRs, not this CI-only filer PR.

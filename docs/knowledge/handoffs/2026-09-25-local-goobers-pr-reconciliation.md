# Handoff — Local Goobers PR reconciliation

## Systems touched

- workflow-automation
- ci-policy
- agent-harness
- local-runtime

## Summary

- Added the scheduled and manually targetable `crawler-pr-remediation` workflow
  for existing Goobers-authored PRs with merge conflicts, failing CI, review
  findings, or stale bases.
- Migrated Crawler's producer, coder, and reviewer goobers to the Codex harness
  using the operator's explicitly opted-in ambient ChatGPT session.
- Added explicit PR patch evidence and deterministic publication of reviewer
  findings before rework or terminal parking. Goobers validation now reports no
  SAF001, SAF002, or WS001 findings; SAF006 remains advisory for custom commands
  whose effects cannot be inferred from exact argv.
- Added an 8 GiB per-stage memory bound so a heavy Codex or verification stage
  cannot OOM-kill the daemon and unrelated in-flight work.
- Materialized and validated a WSL 2 instance at `C:\goobers\crawler` against
  `nalfeo/Crawler`; GitHub access and Codex ChatGPT authentication both pass.
- Lifecycle ownership remains unchanged. This PR does not transfer any legacy
  GitHub Actions lane to Goobers. The remediation workflow now fails closed
  before any mutation unless all three lifecycle lanes it can write are owned
  by Goobers.
- Preserved the disabled hosted feature runner's Copilot authentication through
  a runtime-only overlay while keeping the checked-in local source Codex-first.
- Updated repository instructions so Codex diff review and ready-for-review PR
  publication are pre-authorized unless the maintainer explicitly requests a
  hold.

## Validation

- `goobers validate --source-tree .goobers` passed with five workflows.
- Live-instance validation passed for configuration, repository access, and
  the Codex harness.
- Focused Goobers workflow tests: 39 tests passed.
- `npm run verify:fast` completed type/lint and 90 tests under Node 22.23.2;
  two unrelated existing Bash-harness tests fail on Windows because temporary
  drive-letter paths are interpreted as WSL paths. The focused tests covering
  every changed Goobers contract pass.
- `npm run verify:pr-prereqs` passed.
- `git diff --check` passed.

## Operations

- Runtime root: `C:\goobers\crawler` (Ubuntu 24.04 WSL 2).
- The runtime config and materialized workflow definitions include the 8 GiB
  stage limit and the current Crawler source graph.
- The daemon must be launched with `GOOBERS_GITHUB_TOKEN` from `gh auth token`
  and `CODEX_HOME=/mnt/c/Users/nalfe/.codex` forwarded through `WSLENV`.
- Webhook intake is intentionally disabled because no webhook secret is
  configured; the hourly schedule and targeted local dispatch remain active.

## Follow-up

- Decide when to transfer `LIFECYCLE_OWNER_CI_RECOVERY` from legacy automation;
  this change deliberately stages the replacement without flipping ownership.
- Evaluate whether custom deterministic commands should gain additional native
  Goobers command-effect catalog entries, reducing SAF006 coverage advisories
  without relying on broad author assertions.

# Handoff: Split CI into Required and Advisory Jobs

**Date:** 2026-06-07
**Author:** Agent (Copilot CLI)
**Branch:** `ci-split-required-advisory`

## What Changed

Split `.github/workflows/ci.yml` from a single `ci` job into three jobs:

### `ci` (Required/Blocking)
- Typecheck
- Lint
- Format check
- Lab gate check
- Unit tests
- Build

All steps must pass. No `continue-on-error`.

### `ci-advisory` (Non-blocking)
- Dead code detection
- Integration tests
- Security audit

Job-level `continue-on-error: true` keeps individual step failures visible in the checks UI while ensuring the job as a whole is non-blocking for merge.

### `merge-gate` (Single status check)
- Depends on `ci` job
- Uses `if: always()` so it runs and explicitly reports failure even when a dependency fails (otherwise GitHub would skip it, leaving branch protection with an indeterminate pending/skipped check)
- Provides one clear pass/fail signal for branch protection and agent merge

### `commit-lint` (Removed)
- Was removed from main; commit linting handled elsewhere

## Why

Agent merge needs an unambiguous pass/fail signal. The old single-job approach mixed blocking and advisory checks with `continue-on-error`, making it impossible for automation to distinguish real failures from known-advisory warnings.

## Branch Protection Setup Required

After merge, configure GitHub branch protection to require only:
- `Merge gate` (the `merge-gate` job)

This gives agent merge one definitive signal while still surfacing advisory info in the PR checks UI.

## Follow-up Tasks

- [ ] Configure branch protection to require `merge-gate` status check
- [ ] Consider promoting dead code detection to required once baseline is clean
- [ ] Add integration tests and promote to required when stable

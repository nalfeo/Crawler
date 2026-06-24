# Handoff: GH App Token Copilot Assign — Review Fixes

**Date**: 2026-06-23  
**Branch**: copilot/debug-fix-ci  
**PR**: #208

## What Was Done

Addressed CI failures and review comments on the "ci: use GH App token for Copilot issue assignment" PR.

## CI Failure Root Cause

`copilot-review-ping.yml` (and `coverage-gap-copilot.yml`) passed `assignees: ['copilot']` directly inside `github.rest.issues.create()`. GitHub's REST API rejects this with HTTP 422: `"field":"assignees","code":"invalid"`. The correct pattern is:

1. `github.rest.issues.create()` without assignees
2. `github.rest.issues.addAssignees()` separately (with try/catch)

`nightly-mutation.yml` already used this two-step pattern correctly.

## Review Comment Fixes

| File                       | Change                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coverage-gap-copilot.yml` | Added `if: github.event.comment.user.login == 'github-actions[bot]'` to both the token and script steps                                                      |
| `copilot-review-ping.yml`  | Guarded token step with `if: ${{ secrets.APP_ID != '' }}`; guarded script step with `if: steps.app-token.outputs.token != ''`                                |
| `nightly-mutation.yml`     | Moved `Generate app token` step to immediately before `Create baseline update issue for copilot`; added `if: steps.detect-changes.outputs.changed == 'true'` |

## Secrets Used

- `APP_ID` — GitHub App ID
- `APP_PRIVATE_KEY` — GitHub App private key

## Status

All changes committed and pushed. Session complete.

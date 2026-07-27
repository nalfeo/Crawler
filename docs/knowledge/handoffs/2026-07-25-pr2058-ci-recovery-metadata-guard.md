# Handoff: PR #2058 ci-recovery metadata-guard review fix

**Date:** 2026-07-25  
**Session slug:** pr2058-ci-recovery-metadata-guard  
**Issue/PR:** nalfeo/Crawler#2058  
**Apple estimate:** 2🍎

## Systems touched

ci-policy

## What was done

- Validated the open Copilot review-thread finding with a separate-model reviewer and confirmed the early-exit helper still let `assertExpectedMetadataUnchanged(...)` throw outside the documented best-effort catches in both live mutation phases.
- Updated `.github/scripts/ci-recovery/reconcile.mjs` so the R06/R07 early-exit cleanup now performs the metadata re-check inside the existing best-effort `try` blocks for:
  - the outdated-marker reply path; and
  - the resolve-thread GraphQL mutation path.
- Added two focused regressions to `.github/scripts/ci-recovery/reconcile.test.mjs` covering review-wake (`EXPECTED_HEAD_SHA` + `EXPECTED_BASE_REF`) live R07 runs where the metadata re-fetch returns transient HTTP 500s:
  - one for the post-outdated-marker re-check;
  - one for the resolve-thread re-check.
- Both regressions assert the helper preserves the clean `ci-conflict-order-wait` skip exit instead of surfacing an unexpected non-zero failure.

## Verification

- Separate-model review validation (`claude-sonnet-4.6` code-review agent) ✅
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` ✅
- `npm run verify:pr-prereqs` ✅
- `bash scripts/agent/verify-fast.sh` ❌ environment-only failure: this sandbox is missing the repository dependency install, so the script fell back to transient `npx` tools and then failed resolving local TypeScript / ESLint packages (`typescript`, `@eslint/js`).

## Remaining work / notes

- After the repair commit lands on the PR branch, the exact review thread at `.github/scripts/ci-recovery/reconcile.mjs:1324` should be replied to with the post-push commit SHA so CI recovery can auto-resolve it on the next pass.
- No `files/guard-telemetry.jsonl` artifact was present in this worktree, so no telemetry capture was required for this session.

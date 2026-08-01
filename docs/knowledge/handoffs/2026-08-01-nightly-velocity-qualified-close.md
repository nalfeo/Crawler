# Handoff: nightly velocity issue uses qualified close reference

## Date

2026-08-01

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

- Updated `.github/scripts/nightly-velocity-issue/nightly-velocity-issue.mjs` so generated nightly velocity issues now require implementation PRs to use a fully qualified close reference: `Closes nalfeo/Crawler#<issue>`.
- Added regression coverage in `.github/scripts/nightly-velocity-issue/nightly-agent-issues.test.mjs` to lock this contract.

## Why this change

The nightly velocity issue template is the canonical instruction surface for this loop. Using a fully qualified issue reference removes ambiguity and keeps close-linking deterministic in automation and copied PR text.

## Verification

- `node --test .github/scripts/nightly-velocity-issue/nightly-agent-issues.test.mjs` ✅
- `bash scripts/agent/verify-fast.sh` ❌ (environment dependency gap: `typescript` / `@eslint/js` unavailable in this sandbox)
- `parallel_validation` ✅ (CodeQL skipped as trivial)
- `runtime-tools-secret_scanning` ✅ (no secrets)

## Workflow artifacts / notes

- Nightly velocity issue workflow run inspected: `30695153397` (success)
- Job log inspected: `91356645412`
- Workflow created issue `#2612` as expected.
- Attempted to post the required pre-code plan comment to issue #2612 via `gh issue comment`, but this environment returned `HTTP 403`.

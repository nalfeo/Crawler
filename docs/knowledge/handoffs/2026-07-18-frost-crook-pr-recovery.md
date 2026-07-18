# Handoff: frost-crook PR recovery

**Date:** 2026-07-18
**Persona:** Graphics Designer
**Apples:** estimated 1🍎 / actual 1🍎

## Systems touched

sprite-pipeline, sprite-workflow

## Summary

Recovered PR #1546's handoff-review blockers by correcting the issue-closing
language and clarifying how the VLM judge is expected to run for this asset
request.

## Files touched

- `docs/knowledge/handoffs/2026-07-18-frost-crook-sprite.md`
- `docs/knowledge/handoffs/2026-07-18-frost-crook-pr-recovery.md`

## What changed

- Changed the session record from `Closes #1319` to `Refs #1319` and updated
  issue-tracking text so the source-brief PR no longer claims to close the
  asset issue before generated art is approved, checked in, and wired.
- Clarified that `judge.enabled: true` is expected to run in the CI
  `asset-request` worker via the ADR-0043 bypass path, while ordinary CI gates
  still refuse the non-deterministic VLM judge.
- Clarified the pipeline-status row so follow-up agents know the judge step is
  pending in the authorized CI worker, not skipped indefinitely.

## Verification

- `git fetch --unshallow origin && git fetch origin main:refs/remotes/origin/main`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None in the repaired handoff text. The branch still depends on the
  `asset-request` workflow to generate, judge, approve, and check in the real
  frost-crook art.

## Recommended next steps

1. Let the `asset-request` workflow process issue #1319 and produce the actual
   generated artifact.
2. Check in the approved art and runtime manifest/catalog changes in the
   follow-up asset PR before closing #1319.

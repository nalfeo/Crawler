# PR #3050 silent-revert rename recovery

**Date:** 2026-08-18  
**Issue/PR:** nalfeo/Crawler#3050

## Systems touched

ci-policy, sprite-pipeline

## What changed

- Confirmed all 349 silent-revert findings were lossless generated-asset migrations:
  344 entry records preserved every non-identity field and 5 PNGs were byte-identical.
- Made the silent merge-revert guard recognize byte-identical Git renames and generated
  entry migrations whose non-identity metadata is unchanged.
- Kept the guard blocking when a renamed entry drops substantive metadata, including
  provenance, content hashes, anchors, or other generated-entry fields.
- Covered direct renames and collisions where the canonical target already existed.

## Verification

- `npx vitest run tests/unit/silent-reverts-guard.test.ts` — 58 passed
- `npm run check:silent-reverts` — 3 merges inspected, 0 blocking
- `bash scripts/agent/verify-fast.sh` — passed
- `npm run sprites:normalize-names -- --check` — 0 violations/conflicts

## Apples

Estimated 3🍎; actual 3🍎 — 🎯 exact. The fix required guarded Git plumbing,
generated-entry equivalence rules, and real-history regression coverage.

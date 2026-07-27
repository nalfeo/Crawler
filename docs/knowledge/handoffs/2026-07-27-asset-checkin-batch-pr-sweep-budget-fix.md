# Handoff: Asset check-in batch PR + sweep-budget test fix

**Date:** 2026-07-27
**Session slug:** asset-checkin-batch-pr-sweep-budget-fix
**Apple estimate:** 1🍎 (tooling-only ceremony cap applies; test fix + asset pipeline)

## Summary

Processed asset-checkin issues #2111 (11 assets) and #2122 (3 assets) into batch PR #2124.
Fixed a pre-existing CI regression in `sweep-budget.test.mjs` that was blocking the batch PR.

## Systems touched

sprite-pipeline, ci-tooling

## Work done

### Batch PR #2124 (art-only)

- `npm run sprites:asset-pr` was already run by @nalfeo; confirmed PR #2124 consolidates both #2111 and #2122
- 14 approved PNG sprites (floor-plate variants, sweaty-merchant-floor items, welcome-goon variants), 4 brief YAML files, manifest.json, sprite-catalog.json updates
- Ran `sprites:generate-wiring --since origin/main` → **0 replaceable placeholders** (new tile variants, not placeholder replacements)
- All CI checks green including Headless Floor 1 Gate ✅

### PR #2123 — sweep-budget test fix

- **Root cause:** `isExternallyBlocked()` was added to `ci-recovery/router.mjs` on 2026-07-27 to filter out PRs with blocking labels (`merge-train-blocked`, `ci-conflict-order-wait`, `human-approval-required`) from recovery dispatch
- `recoveryBacklogEntries` now correctly excludes these PRs, reducing `countLatentBacklog` test fixture from 3→2
- Updated `.github/scripts/sweep-budget.test.mjs` line 68 assertion from `3` to `2`
- Added inline comments explaining which PRs are in/out of each bucket

## Key decisions

- **No wiring PR needed:** `sprites:generate-wiring` confirmed 0 replaceable placeholders — the new assets are new tile variants with no existing placeholder to displace.
- **Fixed test on session branch, not batch branch:** `assets/batch-20260727-191316` is protected from direct push by agent credentials; test fix goes via PR #2123 on session branch.
- **Test expectation updated to 2 (not reverted to 3):** The `isExternallyBlocked` behavior is correct — the test was stale.

## Known state at handoff

- PR #2124 — all checks green, merge gate passed, `ci` aggregator queued. Will auto-merge via CI recovery once `ci` completes.
- PR #2123 — Lightweight Checks + Unit Tests in_progress; Integration Tests ✅, all heavy tests correctly SKIPPED (CI-only/test-only change).

## Files changed

- `.github/scripts/sweep-budget.test.mjs` — assertion updated 3→2; comments added

## References

- Issue #2122 and #2111 are closed exclusively by PR #2124 (asset batch). PR #2123 does not close any issues.
- PR #2124: https://github.com/nalfeo/Crawler/pull/2124
- PR #2123: https://github.com/nalfeo/Crawler/pull/2123

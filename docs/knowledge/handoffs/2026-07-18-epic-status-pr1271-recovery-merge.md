# 2026-07-18 — PR #1271 recovery merge + blocker fixes

## Systems touched

ci-policy, docs-tooling

## Summary

- merged `origin/main` into `nalfeo-floor-2-epic-control` to resolve the reported PR conflict cleanly
- fixed epic-status evidence verification for non-canonical required evidence so file-backed evidence verifies via content hash even when recorded commit is unavailable post-squash
- tightened BLOCKED-event reconciliation diagnostics while preserving the implemented protocol: trusted `BLOCKED` comments revoke live claims for the target node, and later trusted `CLAIMED` comments can re-establish ownership
- fixed drift-audit workflow JSON capture by running epic-status with npm silent mode when redirecting machine-readable output

## Files touched

- `.github/workflows/epic-drift-audit.yml`
- `scripts/agent/epics/epic-status-lib.ts`
- `tests/unit/agent/epic-status.test.ts`
- merge-sync from `origin/main` across branch history

## Verification run

- `npm test -- tests/unit/agent/epic-status.test.ts`
- `npm run epic:status -- floor-2-equipment --materialization-plan`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- none in local validation; CI rerun required after push for updated head

## Recommended next steps

1. push branch update and let required CI checks rerun on the new merge commit
2. post `✅ Addressed in <sha>` replies on each requested review thread comment ID
3. if any thread remains in substantive disagreement after validator evidence, escalate rather than force-resolve

# Release report sweep conflict recovery

**Date:** 2026-08-14
**Apples:** 2🍎 (declared 2🍎)

## Systems touched

ci-policy, release-baseline

## Summary

Merged `origin/main` into the release report sweep timeout fix and resolved the deploy workflow conflict by preserving the 15-way report-leg sharding while keeping main's release fun-report/run-data enrichment. Removed the stale `files-pr-floor1.json` artifact and reverted the obsolete `nanoid` downgrade so the branch stays aligned with main's dependency-integrity fix.

## Files touched

- `.github/workflows/deploy.yml`
- `tests/unit/deploy-workflow-gating.test.ts`
- `tests/unit/sweep-legs-workflow-parity.test.ts`
- `package.json`
- `package-lock.json`
- `files-pr-floor1.json` (removed)

## Verification

- `npm run test:unit -- tests/unit/deploy-workflow-gating.test.ts tests/unit/sweep-legs-workflow-parity.test.ts tests/unit/release-baseline.test.ts`
- `npx prettier --check .github/workflows/deploy.yml docs/knowledge/handoffs/2026-08-14-multi-floor-sweep-methodology.md package.json package-lock.json tests/unit/deploy-workflow-gating.test.ts tests/unit/sweep-legs-workflow-parity.test.ts`
- `npm run verify:pr-prereqs` initially failed because this recovery handoff did not exist yet; rerun after committing this handoff.

## Unresolved issues

None known.

## Recommended next steps

Rerun `npm run verify:pr-prereqs` after the recovery commit lands, then let CI exercise the merged workflow on the PR branch.

# Handoff: G2-B seed-issues PR recovery

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy, sprite-workflow

## Apples

Estimated 3🍎, actual 3🍎.

## Summary

Recovered PR #1304's four review-thread blockers by replacing the branch-push one-shot YAML with a reviewed manual workflow plus a deterministic seeding script. The seeder now derives all 70 expected asset-request issues from a single canonical Floor 2 equipment definition table, repairs stale pre-existing issue bodies, ensures the `asset-request` label, and fails unless the exact 70 title/body identities cover all 15 production waves.

## Files touched

- `.github/workflows/g2b-seed-issues.yml`
- `.github/scripts/g2b-seed-issues/run.ts`
- `src/shared/data/floor2-equipment-art.ts`
- `tests/unit/g2b-seed-issues-script.test.ts`
- `tests/unit/g2b-seed-issues-workflow.test.ts`
- `docs/knowledge/review-ledgers/2026-07-18-g2b-seed-issues-recovery.review-ledger.json`

## What changed

- Removed the mutable branch `push` trigger and kept the seeding workflow on `workflow_dispatch` only, fenced to the default branch with a trusted checkout and no `GITHUB_TOKEN` fallback.
- Replaced 15 copied shell helpers with one TypeScript seeding script that uses direct GitHub REST calls, so lookup failures are fatal instead of silently treated as missing.
- Added a canonical 70-entry Floor 2 equipment definition table carrying stable IDs, runtime keys, production-wave IDs, and exact brief text.
- Generated exact issue bodies from that data, including the metadata footer and blank Floor/Size semantics used by the live seeded issues.
- Added deterministic validation that fails on missing, duplicate, mislabeled, or metadata-mismatched G2-B issues instead of reporting the repository-wide `asset-request` count.
- Added focused regression coverage for issue-body generation, stale-body sync planning, and the workflow trust boundary.

## Observe before done

- Before: `.github/workflows/g2b-seed-issues.yml` ran on branch push with repeated inline shell, suppressed issue-lookup failures, generated reduced issue bodies (`Floor=2`, no metadata footer), and summarized the global open `asset-request` count.
- After: the workflow is manual-only on the reviewed default branch, the reviewed script generates/repairs exact canonical issue bodies, and validation succeeds only when the exact 70 G2-B identities span all 15 production waves.
- Verified via `npx vitest run tests/unit/g2b-seed-issues-script.test.ts tests/unit/g2b-seed-issues-workflow.test.ts`, `npm run typecheck`, and `npm run verify:fast`.

## Review validation

- Separate-model thread validation (`gpt-5.6-luna`) confirmed all four cited review findings were still applicable before the fix.
- Separate-model plan review (`gpt-5.4`) approved the design with changes; the plan was tightened to use a pinned in-PR canonical data source and deterministic snapshot validation.
- Code-review loop (`claude-sonnet-4.6`) found one real logic bug (existing mismatched issue bodies were not being repaired), which was fixed by patching stale bodies before final validation. The final rerun reported no significant issues in the functional diff.

## Verification run

- `npx vitest run tests/unit/g2b-seed-issues-script.test.ts tests/unit/g2b-seed-issues-workflow.test.ts`
- `npm run typecheck`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-g2b-seed-issues-recovery.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None in the repaired seed-issues workflow itself. A prior `PR Ready/Reviewer Guard` run failed from GitHub API rate limiting rather than this workflow diff.

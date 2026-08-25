# Handoff: Fix epic workflow reprocessing

## Date

2026-08-25

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Summary

Resolved issue #3584's epic-node activation gap. `Epic Create` materializes nodes
with `GITHUB_TOKEN`; GitHub intentionally suppresses the resulting `issues.opened`
events, so the normal Issue Copilot Intake workflow never assigned those nodes.

- `Epic Reprocess` now runs after each successful `Epic Create` run and hourly,
  then feeds only open, marker-owned epic nodes through the trusted intake path.
- It respects the existing text-only `Blocked by #…` graph before activation,
  serializes overlapping runs, and treats close/Goobers-ownership races as
  benign skips.
- `Epic Create` also retries hourly so a missed review-close event can still
  materialize nodes.

## Verification run

- `node --test .github/scripts/epics/epic-create.test.mjs .github/scripts/epics/epic-reprocess.test.mjs` — 36 pass.
- `npx vitest run tests/unit/epic-workflow.test.ts` — 2 pass.
- `npx eslint` on changed scripts/tests and Prettier checks — clean.
- `npm run verify:fast` — pass (144 files, 2,368 tests).
- Review ledger: `docs/knowledge/review-ledgers/2026-08-25-fix-epics-workflow.review-ledger.json` — valid 3🍎 ledger; independent grade 5/5 with no findings.
- CodeQL: Actions scan clean; JavaScript database scan skipped by the tool because of database size.

## Real artifact observation

Before the fix, live nodes created for the approved Floor 3 and Floor 4 epics
(for example #3534 and #3545) were open with no assignees. The committed
reprocessor targets that exact marker-owned, open-node population after each
creation run and on its hourly fallback cadence, passing each ready node to the
existing assignment implementation.

## Unresolved issues

None.

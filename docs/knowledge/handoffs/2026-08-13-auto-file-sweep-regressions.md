# Auto-file release sweep regressions

## Date

2026-08-13

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The change added one deterministic
detector, one idempotent issue mutation path, release-workflow wiring, fixtures,
and focused workflow/API tests.

## What changed

- Added a deterministic release-baseline comparison that selects the immediately
  preceding recorded baseline on the released commit's first-parent lineage.
- Defined a material regression as both a win-rate drop greater than 0.5
  percentage points and at least two additional losses in an equal-sized sweep.
- Wired detection immediately after the baseline commit reaches the `baselines`
  branch.
- Added idempotent issue create/update/reopen behavior keyed by the regressing
  full SHA. Issues carry `bug`, `automation`, and `ai` labels.
- Reused the trusted issue-intake implementation so kickoff instructions are
  posted before PAT-backed GraphQL Copilot assignment.

## Evidence

- The 596/600 to 584/600 fixture produces a regression decision containing both
  SHAs, both win rates and win totals, commit subject/date, and the sweep URL.
- A two-loss noise fixture, the exact 0.5-point boundary, and no-predecessor case
  do not file issues; the first value above the boundary does.
- A dry run against release baseline `4046f454aba8190ce05890209a99c0b8ae51f662`
  selected `d82040939f79e49eeef76f22b97556b8fba11718` as its first-parent predecessor
  and correctly reported no regression because both were 583/600.
- Focused workflow, detector, and issue-mutation tests passed; `test:guards`,
  `typecheck`, and `verify:fast` passed.

## Review

The separate-model plan review replaced capture-time ordering with first-parent
lineage and required checked-in issue mutation logic. The two-round code review
fixed GraphQL injection, decision guards, exact-boundary coverage, and atomic
decision-file writes. The independent grade passed with all five criteria at 5.

## Follow-up

No known blockers. The first live exercise will occur naturally after the next
successful Pages release baseline is published.

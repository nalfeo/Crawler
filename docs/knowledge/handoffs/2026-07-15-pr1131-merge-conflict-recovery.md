# PR #1131 merge-conflict recovery

## Date

2026-07-15

## Persona

Producer

## Systems touched

hud-ux

## Apples

Estimated: 2🍎. Actual: 2🍎. Verdict: exact.

## What changed

- Merged `origin/main` into `nalfeo-feat-hud-reland-navigation-base` and resolved
  the only content conflict in `src/labs/main-scene-probe-lab/index.ts`.
- Kept both sides of the probe API merge:
  - branch-specific reward-picker helpers (`openBossRewardPicker`,
    `getModalPickerLayout`, typed modal-picker snapshot access)
  - new `main`-side abilities/loadout helpers (`abilitiesButton`,
    `setWorldState`)
- Revalidated the existing combined-scope review evidence and PR prerequisites
  after the merge.

## Validation

- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-14-pr1131-combined-hud-scope.review-ledger.json`
- `npm run verify:pr-prereqs`

## Remaining external blocker

- The live GitHub PR title/body are still the old narrow reland metadata
  (`feat(hud): reland navigation base UX slice`, 3 apples, arrow geometry
  excluded). The canonical combined-scope replacement text remains recorded in
  `docs/knowledge/handoffs/2026-07-14-pr1131-combined-scope-recovery.md`, but
  applying it to the live PR is still a GitHub-permissions task outside this
  repository worktree.

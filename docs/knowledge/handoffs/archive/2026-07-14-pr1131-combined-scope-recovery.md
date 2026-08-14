# Handoff: PR #1131 combined-scope recovery

**Date:** 2026-07-14
**Session:** pr1131-combined-scope-recovery
**Apple estimate (this session):** 🍎🍎🍎 (3)
**PR:** #1131

## Systems touched

hud-ux

## Summary

Recovered the remaining PR #1131 blockers that were still actionable from this
session:

- Verified that the cited `ci`, `E2E Visual Regression`, and `Merge gate`
  failures were obsolete on the latest head because newer GitHub checks were
  already green.
- Added a holistic combined-scope review ledger for the actual PR branch so the
  review evidence now matches the stacked HUD diff rather than only the
  individual slice ledgers.
- Clarified the original 2026-07-13 reland handoff so it no longer reads like
  the sole audit trail for the full combined branch.

The live GitHub PR title/body were still stale at session start (`feat(hud):
reland navigation base UX slice`, 3-apples, arrow geometry excluded). A direct
`gh api repos/nalfeo/Crawler/pulls/1131 -X PATCH ...` attempt from this session
returned `HTTP 403`, so if the live metadata still needs updating, that is the
only remaining blocker outside the repository itself.

## Canonical live PR metadata

If a higher-privilege context updates PR #1131, use this full-scope metadata so
the live GitHub PR matches the submitted branch:

- **Title:** `feat(hud): ship combined navigation, family, and encounter HUD UX batch`
- **Body:**

  ```md
  ## Summary

  Ships the combined HUD UX batch currently on this branch. What began as the
  navigation-base reland from durable ref `handoff/ux-navigation-base-20260713`
  (commit `96bdf4dd`) grew into the real branch scope below: navigation layout
  reland, reservation-aware direction arrows, the Floor 2 family relationships
  HUD redesign, shared encounter-stack layout, and reward-picker visual fixes.

  ## Changes

  - **Navigation HUD base** — shared `navigation-hud-layout.ts`, responsive
    minimap/quest-tracker placement, and quest text hard wrapping
  - **Direction arrows** — reservation-aware off-screen arrows with compact
    wrapped labels, live family-panel avoidance, and deterministic bounds probes
  - **Family relationships HUD** — redesigned Floor 2 panel, runtime avoidance,
    screen-space layout probe API, lab coverage, and deterministic E2E checks
  - **Encounter stack + reward picker** — shared boss/announcement/timer layout,
    responsive top-center reservations, and reward-picker row/panel sizing fixes
  - **Follow-up tooling** — visual-review viewport CLI flags now update the real
    Playwright viewport used for capture

  ## Review evidence

  - Combined branch scope: 🍎🍎🍎🍎🍎 (5 apples)
  - Holistic combined-scope ledger:
    `docs/knowledge/review-ledgers/2026-07-14-pr1131-combined-hud-scope.review-ledger.json`
  - Recovery audit trail:
    `docs/knowledge/handoffs/2026-07-14-pr1131-combined-scope-recovery.md`
  - Slice ledgers preserved on branch:
    - `docs/knowledge/review-ledgers/2026-07-13-reland-navigation-base.review-ledger.json`
    - `docs/knowledge/review-ledgers/2026-07-13-reserve-navigation-arrows.review-ledger.json`
    - `docs/knowledge/review-ledgers/2026-07-13-polish-relationships-hud.review-ledger.json`
    - `docs/knowledge/review-ledgers/2026-07-13-hud-encounter-slice.review-ledger.json`
    - `docs/knowledge/review-ledgers/2026-07-12-abilities-ux-polish.review-ledger.json`
  ```

## GitHub state checked

- Latest PR checks on `b09fd77` were green:
  - `ci` — success (`actions/runs/29297771492/job/86975890659`)
  - `E2E Visual Regression` — success (`actions/runs/29297771492/job/86974916149`)
  - `Merge gate` — success (`actions/runs/29297771492/job/86975878750`)
- The older failed run cited in the recovery prompt (`29294077079`) failed on
  `96ab095`, before the later review-fix commit `b09fd77`.

## Files changed in this recovery session

- `docs/knowledge/handoffs/2026-07-13-reland-navigation-base.md`
  - Marks PR #1131 explicitly.
  - Adds a pointer explaining that the file is the original reland-session
    handoff, while the holistic branch-scope audit trail now lives in this
    recovery handoff plus the new combined ledger.
- `docs/knowledge/review-ledgers/2026-07-14-pr1131-combined-hud-scope.review-ledger.json`
  - New holistic review ledger for the combined branch scope.

## Review evidence

- Original reland slice ledger:
  - `docs/knowledge/review-ledgers/2026-07-13-reland-navigation-base.review-ledger.json`
- Additional stacked-slice ledgers already on the branch:
  - `docs/knowledge/review-ledgers/2026-07-13-reserve-navigation-arrows.review-ledger.json`
  - `docs/knowledge/review-ledgers/2026-07-13-polish-relationships-hud.review-ledger.json`
  - `docs/knowledge/review-ledgers/2026-07-13-hud-encounter-slice.review-ledger.json`
  - `docs/knowledge/review-ledgers/2026-07-12-abilities-ux-polish.review-ledger.json`
- New holistic combined-scope ledger:
  - `docs/knowledge/review-ledgers/2026-07-14-pr1131-combined-hud-scope.review-ledger.json`

## Validation

- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-14-pr1131-combined-hud-scope.review-ledger.json`
- `npm run verify:pr-prereqs`

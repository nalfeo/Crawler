# Session Handoff: Floor 3 starter placeholder coverage

## Date

2026-09-07

## Persona

Producer

## Systems touched

hud-ux, mobile-ux, sprite-pipeline

## Apples

1🍎 exact

## What Was Done

Added the missing real-UI regression coverage for the Floor 3 starter picker: the shipped MainGameScene modal path is now asserted to open the `floor3-starter` picker and every offered option resolves to a valid existing Floor 2 boss-mob sprite instead of a missing/generic placeholder. Observed in the live scene via `npx vitest run --project e2e tests/e2e/main-game-scene-floor3-party-ux.test.ts`: before the fix, the scene path lacked this rendering assertion; after the fix, the modal opens and all four starter options render valid mob textures without placeholder IDs.

## Key Decisions Made

- Kept the workaround isolated to the temporary Floor 3 starter presentation layer only.
- Used the real scene modal snapshot as the proof gate so the regression test covers the shipped renderer, not just the pure model.
- Treated the Floor 2 boss sprite fallback as a deterministic temporary placeholder, not a gameplay-affecting roster change.

## What's Next / Blockers

No blockers. The companion-league art work remains intentionally separate from this temporary presentation fallback.

## Retrospective

### Lessons Learned

The underlying model logic was already correct; the missing piece was proving the real scene path renders the placeholder textures rather than only unit-testing the pure builder.

### Mistakes Made

The first pass validated the deterministic model alone and missed the renderer-side acceptance gate. The follow-up targeted the real `MainGameScene` modal snapshot to cover that exact obligation.

### Opportunities for Future Improvement

When the full Companion League art lands, replace the temporary `mob-*` placeholder mapping with the real sprite IDs behind a single helper and remove the startup workaround in one change.

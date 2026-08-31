# UX refresh PR #3995 recovery (2026-08-31)

## Systems touched

hud, engine-rendering, ux-baselines, achievements, equipment-ui

## Summary

Recovered PR #3995 from Copilot review threads and current CI failures. The fixes are intentionally narrow: restore legacy equipment slot aliases, revert shared palette drift outside Wave 1, repair HUD/Awards/reward e2e contracts, make tooltip truncation safe in the real/fake render path, and make release UX baseline capture route each manifest source instead of skipping non-`ui-probe-lab` entries.

## Changes

- Restored `ringLeft`/`ringRight` legacy aliases to resolve to `ring1`/`ring2`.
- Restored proportional-font stats text budgeting in `EquipmentUI`.
- Reverted shared `BLUE_STEEL` values to mainline and kept the HUD gold accent local to `HudSkillTracker`.
- Removed the retired review-ledger artifact added by the branch.
- Fixed release-baseline capture routing for `dev-server`, `ui-probe-lab`, `main-scene-probe-lab`, and `lab`; added source-string coverage for enabled manifest source handling and Awards scenario ID parsing.
- Updated Awards scenario setup to derive `empty-filter`, `long-flavor`, and `filter-working` from `uxScenario=awards-*`.
- Fixed HUD loot value containment by expanding the value columns and reducing the vertical text nudge; refreshed the canonical HUD after screenshots/review JSON with deterministic pass/0-blocker captures.
- Updated the vitals-stack probe/test contract to reflect loot being embedded in the health panel rather than a standalone stack row.
- Fixed the panel-open Issue button placement to stay in 1280×720 design space at responsive scale.
- Moved the Floor 3 league panel below the actual floor timer bottom edge.
- Updated the reward-opening e2e assertion for the new `rare` next-box label.
- Adjusted the Awards touch-scroll e2e drag to begin inside the resized Awards panel.
- Made tooltip stat truncation robust when Phaser text stubs do not expose `.text`.

## Verification

- `bash scripts/agent/preflight.sh` — completed; dependency install/typecheck passed. Session-start main sync attempted and cleanly aborted on a rebase conflict, leaving the PR branch usable.
- `npm run lint:dead-code` — pass.
- `npm run typecheck` — pass.
- `npm run test:integration -- tests/integration/inventory-ui-weapon-dps-tooltip.integration.test.ts` — pass (2/2).
- `node --test scripts/agent/release/capture-ux-baselines.test.mjs` — pass (17/17).
- `npm run test:e2e -- tests/e2e/achievements-touch-scroll.test.ts tests/e2e/hud-overlap-visual.test.ts` — pass (7/7).
- Earlier same repair run also showed `tests/e2e/reward-opening-ux.test.ts`, `tests/e2e/hud-vitals-stack-corner-buttons.deterministic.test.ts`, and `tests/e2e/floor3-league-hud.deterministic.test.ts` passing before the final HUD nudge/touch-coordinate tweak.
- `npm run verify:fast` — pass.
- `npm run verify:pr-prereqs` — pass.
- Full LLM visual-review scoring could not be rerun in this environment: `visual-review-agent` reported missing `AZURE_OPENAI_ENDPOINT`. The checked-in canonical HUD `after/live-dev` artifacts were refreshed with deterministic-only pass/0-blocker evidence; no fabricated score was added.

## Notes

CI failures investigated from GitHub Actions run `33435058337`: Lightweight Checks failed on unused `HUD_BOTTOM_INSET`; Integration failed in `item-tooltip.ts`; E2E Visual failed on Awards touch scroll, Floor 3 league/timer overlap, HUD loot containment, vitals loot row expectations, and the reward next-label assertion.

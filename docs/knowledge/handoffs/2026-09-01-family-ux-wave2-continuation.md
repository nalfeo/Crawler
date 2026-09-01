# Session Handoff: Family UX Wave 2 Continuation

## Date

2026-09-01

## Persona

UX Designer

## Systems touched

hud-ux

## Apples

4🍎 estimated, 4🍎 actual

## Starting point

- Continued from `78b4aed481672a978085850d3940601c079f4af9`.
- Preserved the three registered Family scenarios and the useful Wave 2
  blue-steel/pixel-UI foundation.
- The inherited 25-region contract passed at 80, but the first real visual
  review exposed truncated family identities. The inherited score was treated
  as a minimum gate, not a completion signal.

## Build, review, and revise loops

1. **Identity clarity.** The inherited panel truncated the longest rendered
   identity, `Mushroomfolk`, which made family recognition slower and ambiguous.
   The panel grew from 244px to 280px, the relation bar from 112px to 142px, and
   the display-name budget from 11 to 15 characters. The next real Phaser
   observation rendered every scenario identity in full and removed the
   evidence-backed truncation blocker.
2. **Semantic hierarchy.** Rows exposed colors, bars, numbers, and boss glyphs,
   but no column legend explained the latter two at first glance. Added compact
   `FAMILY`, `STANDING`, and `BOSS` headers and reserved dedicated vertical
   space for them. The next observation made the comparison grammar explicit
   without reducing the four-row scan.
3. **Comparison speed and boss-state clarity.** Relation bars lacked landmarks,
   while heart/skull glyphs depended on icon interpretation. Added 25/50/75 bar
   notches and explicit `UP`/`OUT` boss labels. A first `KO` pass read
   ambiguously at pixel scale, so it was revised to `OUT`; an isolated-server
   capture then exposed and fixed a six-pixel identity/status collision.
4. **Measurement-led final refinement.** Promoted standing values to 10px bold
   and expanded the contract from 25 to 54 regions. The stricter measurement
   caught title/header overlap and `HOSTILE`/`NEUTRAL` escaping 66px pills.
   Added six vertical pixels, widened the panel to 292px, and widened status
   pills to 76px. The next observation passed all 54 regions in all scenarios.

## Final visual contract

- Complete real family identities; no ellipsis in the registered stress roster.
- Explicit standing and boss columns.
- Three threshold markers per relation bar.
- Prominent numeric standing values.
- Redundant text and color for `HATE`, `HOSTILE`, `NEUTRAL`, and `ALLY`.
- Explicit `UP`/`OUT` labels whose values match defeated-boss state.
- Nested containment for swatches, ticks, status text/pills, and boss text/tiles.
- Scenario-specific defeated-boss counts.

Tracked final lineage under `files/visual-review/after/v1.7.1/`:

| Scenario                              | Score | Deterministic blockers | Evidence-backed blockers |
| ------------------------------------- | ----: | ---------------------: | -----------------------: |
| `family-relationships-band-spectrum`  |  80.0 |                      0 |                        0 |
| `family-relationships-boss-aftermath` |  80.0 |                      0 |                        0 |
| `family-relationships-compact-stress` |  80.0 |                      0 |                        0 |

The Screenshot Viewer was refreshed with all final pairs. Judge suggestions for
blanket five-pixel padding, larger boss emphasis, and larger headers were
classified as task-specific taste advisories: they were inconsistent across
scenarios, unsupported by measured containment, and would reduce compact
comparison density at 960x540.

The stale `v1.6.1` lineage state is invalid and must not be cited: port 4176 had
been taken over by another worktree. Final observations used isolated port 4191
and verified this branch's transformed source before capture.

## Real-game observation

The `main-scene-probe-lab` booted the real `MainGameScene` through the shipped
Floor 2 bootstrap at 1280x720 and 960x540. Evidence is under
`files/family-ux-wave2-real-game/`. The final panel:

- mounts and remains inside the viewport at both resolutions;
- remains legible at the compact game scale;
- clears the active Floor 2 quest tracker;
- hides while the fullscreen map is open;
- restores with unchanged bounds when the map closes.

## Why this is done

The surface is complete because every remaining improvement hypothesis was
tested against the real rendered hierarchy, the compact viewport, or expanded
geometry—not because the score reached 80. The panel now answers the player's
three questions in one scan: which family, how it feels about the player, and
whether its boss remains active. The full roster, extremes, defeated-boss mix,
and compact viewport all satisfy the same 54-region contract. Further proposed
changes are unsupported spacing/emphasis taste churn or would trade away the
compact four-family comparison that the real-game observation confirms is
clear.

## Validation

- Typecheck plus focused Family unit and e2e tests: 30 tests passed.
- Real `MainGameScene` Family/map integration: 4 tests passed.
- `npm run verify:fast`.
- Three tracked visual-review scenarios at `v1.7.1`.

## Constraints preserved

- No reputation, relationship, aggro, territory, enemy, reward, family-data, or
  tuning changes.
- `HudMinimap.ts`, tint math, `families.json`, and `tuning.json` remain untouched.
- Deterministic assertions were expanded, not loosened.

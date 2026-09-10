# Session Handoff: Family UX Wave 2 Continuation

## Date

2026-09-01

## Persona

UX Designer

## Systems touched

hud-ux

## Apples

4🍎 estimated, 4🍎 actual; first maintainer feedback follow-up 3🍎
estimated, 3🍎 actual; responsive/collapse follow-up 4🍎 estimated, 4🍎 actual

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
5. **Maintainer A|B correction.** The maintainer identified escaped family
   swatches, inconsistent row centering, an unnecessary column legend,
   ambiguous text-only boss state, and an illegible body face. Insets now keep
   every swatch visibly inside its row; family names, swatches, status pills,
   and boss tiles share one measured centerline; bars and values share a second;
   the legend was removed; `UP`/`OUT` became heart/skull icons; and row content
   moved to the approved readable UI face. The `v1.8.0` observation passed all
   50 remaining regions with zero blockers in every scenario.
6. **Measured full-name layout and collapse (`v1.9.0`).** Fixed width and
   character-count fallback still made the row contract depend on guessed text
   capacity. Removed fallback/ellipsis rendering, measured the widest visible
   full name after fonts load, reflowed every row and the bottom-right anchor
   from that width, shortened bars from 142px to 110px, and reserved a measured
   gap between value and status. Added the quest-style persisted title-strip
   collapse. The next Phaser observation showed `The Trash Panda Family` and
   the other longest identities in full, aligned scores, distinct metric/status
   columns, and a title-only collapsed footprint.
7. **Decision-text legibility (`v1.9.1`).** The first new capture proved the
   structure but showed that family identity and score/status hierarchy remained
   undersized at capture scale. Switched all row text to the requested Aptos
   stack and promoted family names, scores, and statuses while enlarging the
   collapse chevron. Dynamic measurement absorbed the wider glyphs with no
   collision or density loss; the next observation made names and values faster
   to scan at both target sizes.
8. **Boss-icon consistency (`v1.9.2`).** The second capture exposed a mixed
   icon language: defeated state rasterized as a multicolor emoji while the
   active heart was a monochrome HUD glyph. Forced the skull to the Aptos text
   glyph and equalized icon size. The final observation showed a consistent,
   centered heart/skull pair across normal, all-defeated, compact, and collapsed
   scenarios.
9. **Maintainer icon preference (`v1.9.3`).** The maintainer compared the
   lineage directly and found the `v1.8.0` emoji skull more legible than the
   monochrome experiment. Restored that exact 14px skull treatment while
   preserving every measured layout improvement. The next observation confirmed
   its stronger small-scale silhouette with zero geometry or evidence-backed
   blockers. This is the final accepted icon state.
10. **Review-driven contract closure (`v1.9.4`).** Independent review found
    proportional-font scores were still aligned with padded spaces, hidden
    title-strip input could mutate preference, and an unused status-tag model
    disagreed with the visible band pills. Right-anchored scores to a fixed
    edge, guarded hidden input, removed the dead parallel status contract, and
    asserted exact visible status text plus score-edge stability across rapid
    one/two/three-digit changes. The final capture retained the accepted skull
    and passed every scenario with zero deterministic or evidence-backed
    blockers.

## Final visual contract

- Complete real family identities; no short-label fallback or ellipsis.
- Width derived from actual rendered Aptos metrics, including the longest roster
  identities.
- 110px standing bars with aligned scores and a measured gap before status.
- Three threshold markers per relation bar.
- Prominent numeric standing values.
- Redundant text and color for `HATE`, `HOSTILE`, `NEUTRAL`, and `ALLY`.
- Heart/skull boss icons whose values match defeated-boss state.
- Shared identity and metric centerlines within every row.
- Swatches inset inside their family row bounds.
- Nested containment for swatches, ticks, status text/pills, and boss text/tiles.
- Scenario-specific defeated-boss counts.
- Persisted `▾`/`▸` title-strip collapse with a measured title-only footprint.
- Expanded height derived from the actual 3- or 4-family roster.

Tracked final lineage under `files/visual-review/after/v1.9.4/`:

| Scenario                              | Score | Deterministic blockers | Evidence-backed blockers |
| ------------------------------------- | ----: | ---------------------: | -----------------------: |
| `family-relationships-band-spectrum`  |  80.0 |                      0 |                        0 |
| `family-relationships-boss-aftermath` |  80.0 |                      0 |                        0 |
| `family-relationships-compact-stress` |  80.0 |                      0 |                        0 |
| `family-relationships-collapsed`      |  80.0 |                      0 |                        0 |

Expanded scenarios now expose 51 measured regions; the collapsed scenario
exposes the panel, title, and toggle as 3 measured regions. The A|B UX Testing
and Screenshot viewers were refreshed with all final states. Judge suggestions
for blanket extra padding, centered titles, larger boss tiles, and moving the
right-edge chevron were classified as task-specific taste advisories: the
left-anchored title and right-edge title-strip toggle match the approved Wave 1
and quest-tracker grammar, all text/icon containment is measured, and larger
fixed cells would spend compact-screen width without improving a failed signal.

The stale `v1.6.1` lineage state is invalid and must not be cited: port 4176 had
been taken over by another worktree. Final observations used isolated port 4191
and verified this branch's transformed source before capture.

## Real-game observation

The `main-scene-probe-lab` booted the real `MainGameScene` through the shipped
Floor 2 bootstrap at 1280x720 and 960x540. Evidence is under
`files/visual-review/real-game-v1.9.4/`. The final panel:

- mounts and remains inside the viewport at both resolutions;
- remains legible at the compact game scale;
- clears the active Floor 2 quest tracker;
- hides while the fullscreen map is open;
- restores with unchanged bounds when the map closes.
- removes the unused fourth-row height on three-family runs.

## Why this is done

The surface is complete because every maintainer-reported defect now has both a
rendered outcome and a deterministic contract—not because each judge reports 80. Full Aptos names drive panel width instead of being collapsed, standing
bars/scores/statuses occupy measured non-overlapping columns, all row content
shares explicit optical centerlines, boss state uses one coherent icon language,
and players can reclaim the entire row area through the same persisted
title-strip interaction as quests. The full roster, longest identities,
extremes, defeated-boss mix, collapsed state, compact viewport, and real game
pipeline all pass. The only remaining proposals are unsupported padding and
emphasis preferences that would either contradict approved Crawler hierarchy or
reduce compact comparison density without fixing a measured or observed defect.

## Validation

- Typecheck plus focused Family unit and deterministic e2e tests.
- Real `MainGameScene` Family/map integration: 4 tests passed.
- `npm run verify:fast`.
- Four tracked visual-review scenarios at `v1.9.4`.
- Collapse coverage clicks the real title strip, reloads the mounted artifact,
  and verifies persisted restoration; three-family coverage verifies compact
  dynamic height.

## Constraints preserved

- No reputation, relationship, aggro, territory, enemy, reward, family-data, or
  tuning changes.
- `HudMinimap.ts`, tint math, `families.json`, and `tuning.json` remain untouched.
- Deterministic assertions were expanded, not loosened.

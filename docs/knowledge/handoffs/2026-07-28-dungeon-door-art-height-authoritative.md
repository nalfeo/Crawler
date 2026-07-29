# Handoff — Dungeon door art: two frames of one object, height-authoritative (2026-07-28)

Set Piece Designer / Graphics Designer persona. Replaces Floor 1's placeholder dungeon doors
with a generated open/closed pair that reads as two frames of the same animated object, and
reverses the door render rule from width-authoritative to height-authoritative so a doorway is
no longer shorter than the player walking through it.

Apple score: **5🍎** actual (estimated 3🍎). Session-wide scope was much larger — see the PR.

## Systems touched

- `src/engine/sprites/door-visuals.ts` — door art precedence, key table, `DOOR_TARGET_HEIGHT_FT`
- `src/engine/scenes/MainGameScene.ts` — `updateDoorOverlay()` scale/origin derivation
- `briefs/props/tile-door-v1.yaml`, `briefs/props/tile-door-open-v1.yaml` — shared-archway contract
- `briefs/tiles/tile-door-side-v1.yaml`, `tile-door-open-side-v1.yaml` — vertical pair, NOT generated
- `public/assets/generated/` + `manifest.json` + `src/shared/data/sprite-catalog.json`
- `tests/unit/generated-door-art.test.ts`, `tests/unit/door-visuals.test.ts`

## Shipped

| State  | Approved id               | Sensors | Judge |
| ------ | ------------------------- | ------- | ----- |
| Closed | `tile-door-v1-var-9`      | 7/7     | pass  |
| Open   | `tile-door-open-v1-var-0` | 7/7     | pass  |

Superseded `tile-door-v1-var-1`, `tile-door-open-v1-var-11`, `tile-door-v1-var-0` were
unapproved through `sprites:unapprove` so they did not become orphans.

## The defect class this session added to the catalogue

**Two individually-valid artifacts can be jointly wrong.** The previous door pair passed every
deterministic sensor and the VLM judge, independently, and was still broken as a pair: the
closed door rendered 5.92 ft and the open one 4.47 ft, so the doorway _shrank 24% on opening_,
and their arch stone differed by a warm delta of 56.8 vs 7.2. No per-sprite gate can see a
relational defect, because every gate scores one PNG at a time.

Fix was to generate both states in ONE `sprites:run` against a shared-archway spec, then select
the winning pair by measuring the _relationship_ (opaque geometry + arch-stone-only palette
across all 32 judged variants) rather than accepting the pipeline's per-state auto-picks. Now
pinned deterministically by a relational unit test.

## Height-authoritative rendering (the render-rule reversal)

`scale = tileSize / box.width` made rendered height a function of whatever aspect the generator
happened to produce. Measured **4.90 ft against a 5.75 ft player**. Three rounds of briefs
asking for a ~1:1.75 archway moved the delivered aspect by **zero** (it lands ~1:1.25 every
time), so this is a generator capability limit, not a prose defect, and the renderer is the
only lever. New rule: `scale = ftToPx(DOOR_TARGET_HEIGHT_FT) / box.height`, pinning 6.5 ft.

Accepted cost, chosen explicitly by the maintainer: width becomes free (~5.3 ft) and overhangs
~0.6 ft onto each neighbouring **wall** tile. Never onto walkable floor, and collision is
tile-map driven so it is untouched.

**The rule does NOT transfer to the quarter-turned vertical branch.** Rotation swaps axes, so
height-authoritative pins the 6.5 ft axis along the _corridor_ (about 1.25 ft of overhang onto
walkable floor) and leaves the free axis spanning the doorway gap. That is the inverse of the
horizontal case, and it is exactly why the horizontal trade was acceptable. The branch is
unreachable today because neither vertical key has approved art; the axis choice must be
revisited when the side pair ships. Recorded in the code comment at the branch itself.

## Fixing the render rule made my own new gate vacuous

The relational gate shipped one commit earlier asserted `|closedFt - openFt| <= 0.5`. Under a
height-authoritative fit that difference is 0 **by construction** — a check that cannot fail,
which is this session's own "a green that cannot go red" anti-pattern, reintroduced by my own
fix. The correct response was to move the assertion to the axis that is now free (rendered
**width**), keeping the same defect class checkable, plus a direct "every door renders taller
than the player" assertion so the property actually measured is the property actually gated.
Deleting the test would have been the wrong call and so would leaving it.

## Observe before done

Both states observed in the **real game**, not a lab:

- **Closed**: full arch intact, clearly taller than the NPC standing in front of it, overhang
  reads as an arch set into the wall rather than art bleeding onto neighbours.
- **Open**: no door is open at spawn (`renderableOpenCount: 0`), so this art had never once
  rendered in game. Forced passable via `tileMap.openDoor` -> `openGeneratedCount: 1`. Same
  stone arch, same walnut leaf, same iron straps, same rendered height as the closed frame.

## Environment quirk worth keeping: Vite does not serve `public/` files added after startup

All 85 doors rendered Kenney placeholder art with 30 door tests green. Vite snapshots `public/`
at startup and returns the SPA fallback (`Content-Type: text/html`) for files approved
mid-session. Phaser logs only `Failed to process file: image <key>` and the door fallback chain
then silently substitutes placeholder art, so nothing appears to fail.

**Any mid-session `sprites:approve` requires a dev-server restart before in-game observation
means anything.** Detect with `Invoke-WebRequest` on the asset URL and check `Content-Type`.
This is the eighth entry in the session's failure catalogue and the most operationally
expensive: a fallback chain that makes a wiring failure invisible.

## Known-and-unfixed

- **Arch hue bias.** Closed arches measure R-B 17.1..25.2 (all 16 variants); open arches
  10.0..12.0 (all 16). Zero overlap in 32 samples, so it is systematic per-brief bias, not
  variant noise. Both briefs use identical stone wording, so prose cannot fix it; the
  hypothesis is contextual (the walnut leaf pulls closed stone warm, the dark void pulls open
  stone neutral). About 4 px wide at true tile scale, invisible in play. Deliberately shipped.
- **69 of 104 Floor 1 doors are vertical** and still wear unrotated face-on horizontal art. The
  two side briefs exist but were written for a full-bleed stone tile and should be reconciled
  with the horizontal family's transparent-margin archway before any generation spend.
- Blue/cyan halo on generated door art at 6x zoom (known pipeline issue, deferred).

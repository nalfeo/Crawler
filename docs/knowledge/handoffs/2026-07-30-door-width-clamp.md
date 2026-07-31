# Door width clamp — renderer cleanup + a premise break to escalate

**Date:** 2026-07-30
**Apples:** 2🍎 (renderer-only)
**Branch / PR:** `nalfeo-laughing-spoon` — "Retire dead door rotation, wire side-on E/W art, contain-fit generated-door fallback"

## Systems touched

vfx, mapgen

## TL;DR

This was delegated as **PR 3 of 3** in a Floor-1 door visual-defect series: clamp
generated-door width to one cell (contain-fit), wire the new side-on E/W art, and retire
the dead `quarterTurnsCcw` rotation machinery. All of that shipped and is correct.

**But the mandatory observe-before-done proved the premise is broken:** Floor 1 (and Floor 2)
render **terrain-pack doors, not generated-art doors**. The generated-door contain-fit this
PR adds **never executes on the shipped game today**, so it cannot be what fixes the user's
"doors look stupid / wrong widths" complaint. The maintainer was unavailable when this was
found; per explicit instruction ("work autonomously and make good decisions") the branch was
**re-scoped as honest renderer cleanup/hardening** — behavior-neutral for Floor 1 — and the
real lever is documented here for a follow-up brief.

## The premise break (measured, not inferred)

Observed live at `http://localhost:20420/lab.html?lab=ai-runner&scenario=floor1-default`
(seed 42) via `window.__floor1Debug.getDoorRenderSummary()`:

```
closedPackCount: 84, openPackCount: ...,  closedGeneratedCount: 0, openGeneratedCount: 0
```

**84 pack doors, 0 generated doors.** Why:

- `src/shared/data/floors/floor1.manifest.json` declares
  `terrainPacks: { stone: "floor1-dungeon", cave: "floor1-cave" }` (added by **PR #2236**,
  2026-07-28 — _before_ this door series).
- `MainGameScene.ts` reads `terrainPacks.stone` with **no feature flag**; `preloadTerrainPacks`
  (`terrain-pack-visuals.ts`, called from `BootScene`) loads all pack door PNGs at boot.
- `resolveDoorRenderMode` (`door-visuals.ts`) gives **pack textures absolute precedence** when
  the pack door texture is loaded. So every Floor-1 door is a pack door.
- `floor1-dungeon` ships all 4 door PNGs (closed/open × vertical/horizontal), 64px native.
  Render size = 64px ÷ `TERRAIN_PACK_CELL_PX(64)` × `tileSize(32px)` = **0.5 scale → exactly
  4 ft × 4 ft = one cell**, both orientations. **Pack doors are NOT wrong-width.**
- Both shipped floors have terrain packs ⇒ the generated-door path is dead in the shipped game.

**Implication:** the original "wrong widths" complaint, if current, is about **pack-door art /
aspect** (a 4×4 square door may read stubby) or is **stale** from before PR #2236 inset the
walls. Either way it lives in the **terrain-pack path**, not the generated path this PR touched.
That needs a fresh maintainer brief — see "Open question" below.

## What shipped (all correct, all behavior-neutral for Floor 1)

1. **Contain-fit for the generated-door FALLBACK.** Replaced the height-authoritative fit with
   `scale = min(tileSize / box.width, doorTargetHeightPx / box.height)` (via `resolveOpaqueFit`
   `floorPlane: true`). A generated door can no longer exceed one cell in width. Bottom stays
   pinned to the tile bottom (`anchorBase` origins), so any excess extends north only.
   - Measured generated bounds → rendered size: `tile-door-v1-var-9` 93×114 → 4.0 ft × 4.90 ft
     (width-binds); `tile-door-open-v1-var-0` 90×114 → 4.0 ft × 5.07 ft (width-binds);
     `tile-door-sideon-v1-var-0` 54×114 → 3.08 ft × 6.5 ft (height-binds — correct for edge-on).
2. **Wired the new side-on E/W art.** `GENERATED_DOOR_TEXTURE_KEYS.closedVertical`
   `'tile-door-side-v1-var-0'` → `'tile-door-sideon-v1-var-0'` (genuinely drawn side-on, shipped
   by PR #2375; no rotation needed).
3. **Retired dead `quarterTurnsCcw`.** Deleted the field from `DoorRenderMode`, deleted
   `QUARTER_TURNED_DOOR_KEYS`, and deleted the rotation branch in `MainGameScene.ts`. Both old
   "side" keys (`tile-door-side-v1-var-0`, `tile-door-open-side-v1-var-0`) have **no entry file**
   under `public/assets/generated/entries/`, so that branch was provably dead — its own comment
   already said "unreachable today".
4. **Rewrote the stale doc blocks** in `door-visuals.ts` (`DOOR_TARGET_HEIGHT_FT` is now a
   MAXIMUM/contain-fit, not a target) and `MainGameScene.ts`. Both now carry an explicit
   **PATH REALITY** note stating the generated path renders zero times on the shipped floors and
   this contain-fit is fallback hardening only.
5. **Tests** (`generated-door-art.test.ts`, `door-visuals.test.ts`): rewritten for contain-fit
   using **real decoded PNG bounds**. Hard gates: no door's rendered width exceeds one cell in
   either orientation; face-on keys width-bind while the side-on key height-binds; no rotation.
   **Non-tautology verified** — reverting `Math.min` to the old height-only expression fails 4
   gates at 5.30/5.13 ft, then restored.

## Known art gap (accepted, documented)

`openVertical` (`tile-door-open-side-v1-var-0`) still has **no art** — the E/W _open_ door also
failed generation (generator ceiling). It falls back to face-on horizontal open art. Documented
in code and left as-is per the task; do not attempt to regenerate.

## Observe-before-done

- **Generated path** would render face-on N/S at 4.90 ft (closed) / 5.07 ft (open) and side-on
  E/W at 6.5 ft tall × 3.08 ft — all ≤ one cell wide. Before the fix, height-authoritative fit
  rendered face-on at ~5.2–5.3 ft wide (> 4 ft cell). Proven via the unit gates + non-tautology.
- **Real Floor 1** (`scenario=floor1-default`, seed 42): 84 pack doors / 0 generated; pack doors
  render exactly 4×4 ft. This PR changes **nothing** the player currently sees on Floor 1 — which
  is the honest, intended outcome given the premise break.

## Open question for a follow-up brief (do NOT block this PR)

The genuine Floor-1 door-width/aspect concern lives in the **terrain-pack door path**
(`floor1-dungeon` pack art + `resolveDoorRenderMode` pack precedence), not the generated path.
A fix there needs the maintainer to say **what specifically reads wrong** about the 4×4 pack
doors (too square? wrong art? want taller?). That is a separate task with a separate art/render
lever. Flagging, not fixing, per "don't silently substitute your own design."

## Validation

- `npm run verify:fast` ✅ (40 files, 473 tests)
- Review ledger: `docs/knowledge/review-ledgers/2026-07-30-door-width-clamp.review-ledger.json`
  (2🍎, no required stages)

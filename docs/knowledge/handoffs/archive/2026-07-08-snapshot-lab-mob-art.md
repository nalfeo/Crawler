# Session Handoff: Wire real slime/rat art into UX Snapshot lab

## Date

2026-07-08

## Persona

Producer (single-file lab art-wiring fix)

## Systems touched

hud-ux, enemies

## Apples

1🍎 estimated, 1🍎 actual (🎯 exact). Trivial single-file lab preload swap,
no logic/behavior change, gameplay_safe. Ledger-only tier (no review stages).

## What Was Done

The `ux-snapshot-lab` still preloaded the flat `temp_slime.png` / `temp_rat.png`
placeholders for its two representative mobs, even though the real game long ago
pinned generated art for both. Swapped the two mob preloads to resolve the same
`pinnedTextureKey` the game uses, so the snapshot shows the sprites players
actually see.

- **`src/labs/ux-snapshot-lab/index.ts`.** Added a `pinnedGeneratedAssetPath()`
  helper that reads `renderKinds.<kind>.generated.pinnedTextureKey` from
  `entity-sprite-mappings.json` (the game's source of truth) and returns
  `assets/generated/<key>.png`, falling back to the supplied `temp_*`
  placeholder when a kind has no pinned generated sprite. Repointed the
  `ux_slime` / `ux_rat` preloads through it (`enemy_slime` → `slime-v1-var-9`,
  `enemy_rat` → `rat-v1-var-9`). Because it reads the pinned key at load time,
  the lab now tracks re-pins automatically instead of drifting.

Hero, NPC, floor, wall, and door tiles intentionally stay on `temp_*` art — they
have no pinned generated sprite and were out of scope.

## Observe before done

- Launched `npm run lab` and opened `?lab=ux-snapshot-lab` in Chrome.
- **Before:** loader requested `temp_slime.png` / `temp_rat.png` (flat squares).
- **After:** loader requests `slime-v1-var-9.png` / `rat-v1-var-9.png` (both
  HTTP 200 via HEAD probe); screenshot confirms a detailed green slime and gray
  rat rendering in place of the placeholders. Hero/NPC/tiles unchanged.
- Only console 404 is `favicon.ico` (pre-existing, unrelated). The two mob art
  files are 64×64, identical to the temp placeholders, so no rescaling needed.

## Verification run

- `npm run verify:fast` ✅
- `npm run verify` ✅ for all code gates (typecheck, lint, format, guards,
  107 unit+integration tests, build). Headless Floor-1 gate correctly deferred
  (gameplay_safe). `verify:pr-prereqs` initially failed only on the missing
  ledger + handoff — both now added.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-08-snapshot-lab-mob-art.review-ledger.json` ✅

## Unresolved issues

None.

## Recommended next steps

1. If more of the snapshot's placeholders (hero, npc, floor tiles) later gain
   pinned generated art, the same `pinnedGeneratedAssetPath()` helper can be
   reused to wire them in.

## Branch state

- Branch: `nalfeo-snapshot-lab-mob-art`
- PR created: pending

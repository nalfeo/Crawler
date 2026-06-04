# 2026-06-04 — Weapon Sprite Assets (Phase 2 foundation)

GitHub issue: [#3](https://github.com/nalfeo/Crawler/issues/3)
Branch: `nalfeo-microsoft/weapon-sprite-assets`

## What shipped

Phase 2 foundation only — asset pipeline + a single CC0 Kenney pack
wired through to the renderer for the player and enemies.

- `public/assets/kenney/roguelike-characters/spritesheet.png`
  (918×203, 16×16 tiles, 1 px gap, CC0)
- `public/assets/kenney/roguelike-characters/LICENSE.txt`
  (upstream Kenney license, vendored for traceability)
- `public/assets/kenney/README.md` (refresh instructions + pack table)
- `scripts/fetch-assets.sh` — idempotent download + SHA-256 verified
- `src/engine/sprites/registry.ts` + `src/engine/sprites/index.ts` —
  pure-data registry of sheets and logical sprite IDs
- `src/engine/scenes/BootScene.ts` — preloads every sheet from the
  registry, with a non-fatal `loaderror` handler
- `src/engine/PhaserBridge.ts` — `resolveTexture()` prefers the
  registered Kenney sprite when its sheet is loaded, otherwise falls
  back to the existing procedural `__cw_*` texture. Player and enemy
  visuals are scaled (1.6× / 1.4×) so the 16×16 source matches the
  prior procedural footprint.
- `src/labs/sprite-preview-lab/` — visual catalogue of every
  registered sprite (`?lab=sprite-preview`)
- `tests/unit/sprite-registry.test.ts` — registry invariants
- Extended `tests/unit/phaser-bridge.test.ts` — covers both the
  Kenney-loaded and procedural-fallback render paths

## Important scope pivot

The issue cites the **Kenney Roguelike/RPG Pack**. That pack
(`kenney_roguelike-rpg-pack.zip`) is currently **terrain-only** —
floors, walls, fences. It contains no characters, enemies, or
weapons.

I pivoted to the **Kenney Roguelike Characters** pack instead
(`kenney_roguelike-characters.zip`), which has the player + enemy
sprites we actually needed. The pack also has weapon icons in later
columns we can map in a follow-up.

The PR therefore wires up:

- `player` (knight)
- `enemy.goblin` / `enemy.orc` / `enemy.brigand` / `enemy.ghost`

…and leaves weapons, XP gems, and projectiles on procedural rendering
for now, exactly as Phase 1 had them.

## Verification

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — 299/299 pass (39 files), including 7 new sprite-registry
  tests and 2 new bridge prefer/fallback tests
- `npm run build` — succeeds
- `npm run format:check` — pre-existing project-wide style issues
  (128 files); formatted only the files I touched
- `npm run lint:dead-code` — knip flags the new `SpriteDef` /
  `SpriteSheetDef` type re-exports as unused, in line with the existing
  pattern of barrel-export type unused warnings (non-blocking)

`scripts/agent/verify-fast.sh` and `verify.sh` are bash scripts that
fail with `pipefail` errors when run directly under PowerShell on
Windows. They run fine in WSL/Git Bash; CI will use them as-is.

## Follow-ups

- Map weapon icons (sword, bow, etc.) from later columns of the
  Roguelike Characters sheet to logical sprite IDs and switch the
  procedural weapon renderers to use them.
- Pick enemy variant deterministically from entity ID instead of
  always using `enemy.orc`.
- Add the **ansimuz Explosion** spritesheet (Phase 2 must-have #2).

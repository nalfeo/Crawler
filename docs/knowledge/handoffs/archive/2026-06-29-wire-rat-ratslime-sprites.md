# Handoff: Wire generated rat + rat-slime boss sprites

**Date:** 2026-06-29
**Persona:** Producer
**Apples:** estimated 🍎🍎🍎 / actual 🍎🍎 (engine-only, additive)

## Goal

PR #470 added new generated rat / rat-slime art (PNGs + manifest + catalog) but
nothing consumed it — the game still rendered Kenney CC0 placeholders. Wire the
approved sprites into the renderer. Explicit constraint: hook up the **rat-slime
staircase boss**, NOT the **slime-rat** tutorial boss (different mobs).

## What Was Done

### `src/engine/PhaserBridge.ts`

- `ENTITY_GENERATED_SPRITE` maps entity type → manifest texture key, checked
  first in `resolveTexture` (preferred over Kenney when the texture is loaded):
  - `enemy_rat` → `rat-v1-var-3`
  - `enemy_boss_ratslime` → `rat-slime-v1-var-1`
- `GENERATED_SCALE` scales the larger 64–128px PNGs (0.4 rat / 0.6 boss).
- Boss visual type now reads the `bossBattles` key: `staircase` → `enemy_boss_ratslime`,
  all other bosses keep `enemy_boss`. Confirmed via 2026-06-28 handoff: `staircase`
  = Rat Slime final boss, `slime-rat` = mid-floor boss.
- Kenney + procedural fallbacks added for `enemy_boss_ratslime`.

### `tests/unit/phaser-bridge.test.ts`

- Generated rat resolves to `rat-v1-var-3` when loaded.
- Staircase boss → `rat-slime-v1-var-1`; slime-rat stays Kenney placeholder.

## Verification

- `npm run verify` green (typecheck, lint, format, dead-code, unit/integration/headless, build).
- Dev server served both PNGs (rat 5484b, rat-slime 21257b, 200) + manifest entries.
- Could not browser-observe (Chrome/Playwright unavailable); relied on deterministic
  unit tests + runtime asset checks.

## Unresolved / Next Steps

- Scales (0.4/0.6) untuned by eye — observe in `npm run dev` and adjust if rat looks
  small or boss large. var-9 is an alt rat variant if var-3 is wrong.
- slime-rat tutorial boss + ambient slime intentionally untouched.

# Handoff — UX Snapshot Abilities + Floating Gem Art

**Date:** 2026-06-27
**Session:** ux-snapshot-abilities-floating-gems
**Persona:** UX Designer
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** 🎯 exact

## Why

Two UX regressions reported:

1. **UX snapshot lab missing abilities UX** — the ability bar (`HudAbilityBar`) was
   rendered by `HudUI` but never shown in the snapshot because
   `world.featureUnlocks.spells` was never set `true` and no ability state was
   initialized.

2. **Real game not using floating XP art** — the ux-snapshot-lab had bobbing
   in-world gem drops with ground shadows, but `PhaserBridge` rendered XP gem
   entities as static sprites with no animation.

## What Was Done

### Fix 1 — Abilities UX in ux-snapshot-lab (`src/labs/ux-snapshot-lab/index.ts`)

- Added `showAbilities: boolean` (default `true`) to `UxLabSettings`.
- Imported `Stats`, `SkillHolder` from `src/core/components.ts` and
  `equipActiveAbility` / `getOrCreateAbilityState` from
  `src/game/systems/abilitySystem.ts`.
- In `create()`: attaches `Stats` + `SkillHolder` to the player EID, initializes
  `abilityStatesByEntity`, equips `fireball` and `heal` active abilities, and
  simulates a cooldown on `fireball` so the cooldown bar is visible.
- In `update()`: syncs `world.featureUnlocks.spells = settings.showAbilities` each
  frame so the toggle takes effect live.
- Added a `'Show abilities'` lil-gui boolean toggle.
- Updated description strings (hint text + `registerLab` description) to mention
  the ability bar.

### Fix 2 — Floating gem art in PhaserBridge (`src/engine/PhaserBridge.ts`)

- Added `gemSpawnMs: Map<number, number>` (first-seen render time per gem EID) and
  `gemShadows: Map<number, Phaser.GameObjects.Ellipse>` (faint ground shadow per
  gem).
- Added a `case 'gem'` branch in the per-type switch that:
  - On first sight: records spawn time and (if `scene.add.ellipse` is available)
    creates a 18×6 semi-transparent ellipse shadow below the gem.
  - Every frame: computes `bob = sin(elapsed * 0.007 + phaseOffset) * 5` where
    `phaseOffset = (eid % 13) * 0.48` so nearby gems float out of phase.
  - Applies `img.setPosition(x, y + bob)` and tracks the shadow at `(x, y + 10)`.
- Added cleanup for both maps in the entity-removed loop and in `destroy()`.
- Shadow creation is guarded with `typeof scene.add.ellipse === 'function'` so
  unit-test environments without the full Phaser API continue to work.

### Tests (`tests/unit/phaser-bridge.test.ts`)

- Added `XpGem` to imports.
- **`'applies a sine-wave bob offset to XP gems each frame'`**: verifies that the
  gem image stays within ±5 px of the ECS y position and that the y value changes
  between frames as the sine phase advances.
- **`'cleans up gem spawn-time and shadow state when a gem entity is removed'`**:
  verifies that the image is destroyed after `removeEntity`.

## Files Changed

| File                                              | Change                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/labs/ux-snapshot-lab/index.ts`               | Add abilities setup, `showAbilities` GUI toggle, description updates      |
| `src/engine/PhaserBridge.ts`                      | Add `case 'gem'` with sine bob + shadow; cleanup in removed/destroy loops |
| `tests/unit/phaser-bridge.test.ts`                | +2 gem tests (bob offset, cleanup)                                        |
| `docs/knowledge/metrics/apples/2026-06-27-*.json` | Apple metrics                                                             |

## Validation

- `npm run verify:fast` ✓ (17/17 unit tests, typecheck, lint)
- `bash scripts/agent/lab-gate-check.sh` ✓ (no new ECS system)
- No guard-telemetry.jsonl this session.

## Notes for Next Agent

- The ability bar in ux-snapshot-lab shows `fireball` and `heal` with `fireball`
  showing a cooldown bar. The cooldown does not tick (no `abilitySystem` runs in
  labs) but the visual state is representative.
- Gem shadow ellipses are created lazily on first sight and cleaned up with the
  entity. If Phaser's `scene.add.ellipse` is absent (test env), creation is
  silently skipped.
- The bob period is `2π / 0.007 ≈ 898 ms` (close to the 900 ms in the lab), and
  amplitude is ±5 px to match the lab's ±7 px feel at a tighter in-game scale.

## Apples

Estimated 🍎🍎, actual 🍎🍎 (exact). Two targeted file edits + 2 new tests.
No new ECS systems, no new modules.

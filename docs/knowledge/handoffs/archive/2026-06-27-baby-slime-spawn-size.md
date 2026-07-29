# Session Handoff: Baby slimes spawning incredibly small

## Date

2026-06-27

## Persona(s) adopted

Producer → Engine/Renderer fix. The bug lived at the feet↔pixels boundary in the
Phaser bridge, so the work was a focused rendering-layer correction plus a
regression test.

## Routing verdict

✅ right persona — single-seam render-scale bug, no multi-system coordination needed.

## Apples

Estimated: 🍎 x 1 <!-- declared before work began -->
Actual: 🍎 x 1
Verdict: 🎯 Exact — one-constant unit-mismatch fix plus a regression test, exactly as scoped.

Hello kitties: 1/5 = 0.20 🎀

## What Was Done

Fixed baby ("slime-mini") slimes rendering far too small after a parent slime split.

**Root cause:** `SLIME_FULL_SPRITE_WIDTH` in `src/engine/PhaserBridge.ts` was set
to `24` — the _pixel_ equivalent of a full slime (3.0 ft × 8 px/ft) — but
`applyEnemyScale` divides a **feet-based** `Sprite.width` by it. The sim is
feet-based (ADR 0023): a full slime's `Sprite.width` is `3.0` and a split baby's
is `3.0 × 0.65 = 1.95`. So `sizeMul = clamp(1.95 / 24, 0.2, 1)` collapsed to the
**0.2** floor instead of the intended **0.65** — babies rendered at 20% instead
of 65% of a full slime.

**Fix:** `SLIME_FULL_SPRITE_WIDTH = 3` (feet, synced to the `slime` archetype
`spriteWidth` in `src/shared/data/enemies.floor1.json`) + a corrected doc comment
warning that this must be the feet value, not its pixel equivalent.

**Tests:** Updated `tests/unit/phaser-bridge.test.ts` — the two slime-mini tests
previously fabricated pixel-like widths (24 full / 16 baby) that masked the bug.
They now use the **real** feet widths (3.0 full / 1.95 baby) and assert the
on-screen ratio is `0.65`. This assertion yields the clamped `0.2` under the old
constant, so it is a genuine regression guard.

## What's Next

Nothing required. Optional follow-up: a tiny shared `units.ts` helper for
ft→px conversions referenced by render constants could prevent this class of
feet/pixel mix-up recurring.

## Blockers

None.

## Branch State

- Branch: `nalfeo-fix-baby-slime-spawn-size`
- All tests passing: yes (`npm run verify:fast` ✅)
- PR created: no

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — nothing to paste.

## Test Results

`npm run verify:fast` → ✅ Fast verification passed (typecheck + lint + tests;
`tests/unit/phaser-bridge.test.ts` 19/19 passing).

## Key Decisions Made

- Corrected the constant to feet (3) rather than reworking `applyEnemyScale` to
  convert units — the entire sim already stores `Sprite.width` in feet, so the
  denominator simply had to match. Minimal, consistent with ADR 0023.
- Rewrote the slime-mini tests to use real feet-based widths instead of the
  pixel-like values that let the bug slip through, promoting the visual bug into
  a deterministic render-scale assertion.

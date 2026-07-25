# Handoff: Reward Opening Particle Effects

**Date**: 2026-07-24  
**Issue**: #1906 — Reward unlocks lack particle effects and wow  
**PR**: feat(engine): add particle effects to reward unlock sequence  
**Apples**: estimated 2🍎 / actual 2🍎 → verdict: exact  

## Systems touched

engine

## What was done

Added animated particle effects to the reward-opening sequence
(`src/engine/RewardOpeningUI.ts`). Previously the reveal showed only a static
glow circle and colored rectangles. Now each phase has procedural VFX scaled
by the excitement bucket (`modest` / `notable` / `exciting` / `legendary`).

### New file: `src/engine/RewardOpeningVfx.ts`

Self-animating VFX factory following the `MobAbilityVfx` / `EffectsVfx`
pattern (Phaser tweens that self-destruct on completion). Key design points:

- **`onAnticipationStart`**: Animated chest box — two rectangles (body +
  lid). Lid bobs twice then flies off with spin. Glowing motes escape through
  the crack. Outer pulsing ring. Smoke motes rising from the base.
- **`onItemRevealed`**: Per-item colored ring burst + outward sparks +
  rising confetti motes (notable+ only). Position matches the UI item grid.
- **`onSummaryBurst`**: Grand celebratory multi-ring burst + heavy sparks +
  confetti motes + laser beams (Graphics lines, 6 beams at exciting / 10 at
  legendary). Each tier adds more rings and particles.
- **Reduced motion**: every public function is a no-op when `reducedMotion`
  is `true` — the caller never needs to guard calls.
- **Capability guard**: disabled when Phaser `add.circle` / `add.rectangle` /
  `add.graphics` / `tweens.add` are absent — headless/test scenes are safe.
- **Depth**: 6005 (above the overlay container at 6000, `setScrollFactor(0)`).
- **LCG**: uses the same `seed = (seed * 16807) % 2147483647` pattern as
  `EffectsVfx.ts` — never `Math.random()`.

### Modified: `src/engine/RewardOpeningUI.ts`

- Import `createRewardOpeningVfx`, create single `vfx` instance at factory
  construction time.
- `render()` phase-change section: fire `onAnticipationStart` on first
  anticipation render; fire `onSummaryBurst` on first summary render. VFX
  fires even for skip-caused summary transitions (suppressPhaseChangeHook
  only suppresses the audio hook, not VFX).
- `tick()` item-reveal section: fire `onItemRevealed` for EVERY item in a
  batch (unlike the audio hook which coalesces — stacking per-item VFX is
  intentional since each item deserves a visual pop at its position).
- `close()`: call `vfx.destroy()` immediately so particles never linger over
  the game world after the overlay is dismissed.

## Testing

Unit tests added in `tests/unit/reward-opening-vfx.test.ts` covering:
- **Capability guard / reduced-motion no-ops**: disabled scene and `reducedMotion=true` both produce zero shapes/graphics without throwing.
- **Tier-specific spawning**: each excitement bucket spawns at least one object during anticipation and reveal; higher tiers produce ≥ as many objects as lower tiers on summary burst; laser beams (Graphics) only appear for `exciting`/`legendary`.
- **Lifecycle / cleanup**: `onComplete` tween callbacks correctly destroy objects; `destroy()` calls `killTweensOf` before destroying live objects; `destroy()` is idempotent.
- **Blend mode**: all Graphics beam objects have `setBlendMode('ADD')` applied.

The existing `reward-opening-ui-visibility-hook.test.ts` continues to pass because the
fake scene used in those tests lacks `add.graphics` and `tweens.add`, so
`enabled = false` and all VFX calls are no-ops.

## Observe before done

VFX validated in two places:

1. **Lab** (`reward-opening-ux-lab` via `npm run lab`, `?lab=reward-opening-ux-lab`): animated chest lid during anticipation, spark bursts on item reveal, grand ring/laser burst on summary. All four bucket tiers visible via the lab's GUI buttons.

2. **Real game** (`npm run dev`, trigger a reward in-game): anticipation chest animation, item reveal sparks at each card position, and summary burst all fire with the correct card-aligned positions. VFX depth (6005) correctly stacks above the overlay container (6000) and clears cleanly on close.

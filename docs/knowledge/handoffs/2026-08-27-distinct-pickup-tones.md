# Handoff: Distinct Pickup Tones

## Date

2026-08-27

## Persona

UX Designer

## Systems touched

inventory, hud-ux, vfx

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact) — an additive semantic event contract
coordinated across pickup producers, shared cue selection, engine synthesis,
and real-scene regression coverage.

## What Was Done

- Added optional `pickupAudioKind` metadata to pickup sparkle events without
  changing sparkle colors or inferring semantics from tint.
- Tagged gold and XP pickups in `itemPickupSystem`; tagged crafting materials
  from both floor drops and harvest nodes.
- Added distinct procedural synth signatures and labels for XP
  (`combat:pickup-xp`), gold (`combat:pickup-gold`), and materials
  (`combat:pickup-material`). Untyped pickups retain `combat:pickup`.
- Preserved one shared typed-pickup cooldown and same-frame coalescing. Typed
  cues outrank the generic fallback so boss-chest or ordinary-item events cannot
  mask one of the requested tones.

## Observe Before Done

Before the change, the focused cue-mapping tests confirmed that gold, gem, and
ad hoc pickup sparkle colors all resolved to the same `combat:pickup` cue.

After the change,
`tests/e2e/combat-audio-real-wiring.test.ts` booted the real
`MainGameScene`/`PhaserBridge` pipeline and observed all three distinct labels
through the injected real `AudioCueEngine` logging wrapper. Producer tests also
confirmed that dropped materials and harvested materials carry the same
semantic category.

## Verification

- `npx vitest run tests/unit/combat-audio-cues.test.ts tests/unit/combat-audio.test.ts tests/ecs/itemPickupSystem.test.ts tests/ecs/harvestSystem.test.ts`
  — 64 tests passed.
- `npx vitest run --project e2e tests/e2e/combat-audio-real-wiring.test.ts --reporter=verbose`
  — 4 tests passed.
- `npm run typecheck` — passed.
- `npm run verify:fast` — passed twice; the final run included 2,368 changed-scope
  tests and all integrity checks.

## Review

The 3🍎 plan review produced four resolved refinements, primarily separating
audio semantics from visual color and preserving shared pickup throttling. Code
review round one found that generic pickup events could mask typed events; typed
events now outrank generic events in-frame and are not blocked by a prior
generic cooldown. Round two was clean.

## What's Next / Blockers

No implementation blockers. Future subjective mix tuning can adjust the three
procedural signatures without changing the semantic event contract.

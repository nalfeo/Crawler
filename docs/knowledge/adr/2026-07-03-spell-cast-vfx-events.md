# ADR: Spell-cast VFX events + `radiusFt` on `VfxEvent`

## Status

Accepted

## Date

2026-07-03

## Estimated Complexity

🍎 x 2 — two-layer wire-up (shared kind + game/systems push + engine
renderer preset), no new ECS system, no schema migration.

## Context

The user reported that fireball, pulse-shield, and heal "NEVER trigger".
A shipped-pipeline integration test using `runSimulationStep` +
`createFloor1MainSceneOptions` proved both spells DO auto-trigger and
cooldowns latch correctly — the real gap is that the three spells apply
their gameplay effects INVISIBLY:

- `castFireball` calls `applyDamage` at the epicentre (damage numbers
  pop on each hit, but no explosion / ring / sparks at the blast).
- `castPulseShield` sets a tiny 1.0-force knockback (enemies barely
  shuffle, no shockwave, no ring).
- `castHeal` bumps `health.current` (HUD bar moves silently, no VFX).
- The HUD ability bar's cooldown cue is a 4-px yellow strip at the
  bottom of a 64-px slot — visually easy to miss during combat.

The engine already has a clean data-only VFX channel:

- `world.vfxEvents` (declared in `src/shared/vfx-events.ts`) is a queue
  of effect-request events pushed by game/core systems.
- `src/engine/EffectsVfx.ts` is the sole consumer, drained each frame.
- Combat-derived juice (`hitSpark`, `deathPop`, `critBurst`, `playerHurt`)
  is synthesised from `combatEvents`; non-combat signals (pickups,
  level-ups) push directly.

Spell casts are non-combat signals — they need to push their own
"the-spell-fired" visual to the queue.

## Decision

1. Extend `VfxEffectKind` with three new kinds: `fireballBlast`,
   `pulseShieldWave`, `healGlow`.
2. Extend `VfxEvent` with an optional `radiusFt?: number` field. Ring
   size for gameplay-scoped effects (spell blasts) is tied to the ACTUAL
   gameplay reach, not overloaded onto the unitless `intensity`
   multiplier.
3. Add `WORLD_VFX_DEPTH.spellCast = 17` in `src/shared/render-depths.ts`,
   sitting above `hitSpark` (12) so the blast reads over per-target
   sparks it triggers, and below `combatText` (20) so damage numbers
   still pop.
4. In `src/game/systems/progressionEffects.ts`, each of `castFireball`,
   `castPulseShield`, `castHeal` pushes its VFX event on a successful
   cast. Fireball pushes at the cluster epicentre with
   `radiusFt = tilesToFeet(radiusTiles)` and `intensity = clampedHitCount`;
   pulse-shield pushes at the caster with `radiusFt = tilesToFeet(...)`;
   heal always pushes at the caster on a successful cast (even at full
   HP, because MP was spent and cooldown latched).
5. In `src/engine/EffectsVfx.ts`, three renderer presets built from
   existing `spawnRing` / `spawnSpark` / `spawnRisingMote` helpers, wired
   into the `handleVfxEvent` switch. Fireball outer-ring scale is
   `ftToPx(radiusFt) / FIREBALL_CORE_PX`; sparks scale from `intensity`.
6. In `src/engine/HudAbilityBar.ts`, a 15-frame slot cast-flash on
   trigger uses a cool cyan/white palette (fill `0xf0f9ff`, border
   `0x22d3ee`, label `#0c4a6e`) — deliberately distinct from the warm-
   yellow cooldown ring (`0xfbbf24`) so the flash and the countdown
   don't collapse into one unreadable state.

## Consequences

### Positive

- The user's reported bug is fixed: every spell now has an unmistakable
  visible signal on trigger, both in the world (blast/wave/glow) and on
  the HUD (slot flash).
- `radiusFt` cleanly separates "how big is the effect" from "how many
  particles" — future gameplay-scoped VFX (Floor 2+ spells, breath
  weapons, ground pounds) can adopt the same pattern without overloading
  a unitless multiplier.
- Data-only interface between game/systems and engine (per bridge
  pattern, ADR 0001). No Phaser imports in `src/game` or `src/shared`.
- The new `spellCast` depth is documented alongside the existing
  world-VFX depths so the ordering rationale is discoverable.

### Negative

- `VfxEvent` grows one field. All existing consumers ignore unknown
  fields gracefully, but the type surface is one line larger.
- Three new renderer presets add ~50 lines to `EffectsVfx.ts`. Kept
  modest by reusing the existing `spawnRing` / `spawnSpark` /
  `spawnRisingMote` helpers.

### Risks

- **AI runner spell-selection gap**: `src/game/ai/auto-progression.ts:95`
  hardcodes `heal` as the AI's spell choice, so the headless win-rate
  gate never exercises fireball / pulse-shield auto-triggering in real
  play. That is exactly how the invisibility bug slipped through in the
  first place. Mitigation: filed in the handoff for a follow-up session
  to broaden the AI's spell heuristic. This ADR does NOT fix that gap.
- **Visual density on cluster casts**: a large fireball with 4+ enemies
  clustered will spawn ~24 sparks. `FIREBALL_SPARKS_PER_INTENSITY = 6`
  is tuned modestly so this stays legible, but if the user finds it
  too noisy the tunable is in one place.

## Alternatives Considered

- **Overload `intensity` as feet for radius-scaled spells.** Rejected
  by plan review (gpt-5.4) as a correctness smell — different kinds
  would have different units in the same field. Cleaner to add
  `radiusFt` as an explicit optional field.
- **Push directly from `abilitySystem.ts` after `applyCatalogEffect`.**
  Rejected because `abilitySystem` doesn't have the spell-specific
  metadata (blast centre, cluster hit count) — that only exists inside
  `castFireball`/`castPulseShield`/`castHeal`. Pushing at the cast site
  keeps the anchor + payload correct.
- **Synthesise cast VFX from a hypothetical `spellEvents` queue** in the
  style of `combatEvents`. Rejected — spell casts are rare enough (per
  cooldown) that a dedicated queue adds ceremony without benefit; pushing
  directly to `vfxEvents` is the same pattern pickups and level-ups
  already use.
- **Yellow HUD cast-flash matching the cooldown bar's warm palette.**
  Rejected because the flash and the immediately-following cooldown
  countdown share a hue and fold into one unreadable state. Cool/warm
  contrast is the correct default for stacked UI feedback.

# ADR: Combat/Loot Audio as a Second Reuse of the Reward-Opening Cue Pattern

## Status

Accepted

## Date

2026-08-23

## Estimated Complexity

🍎🍎🍎🍎 — new engine-layer subsystem consuming three existing shared event
queues, wired into real per-frame gameplay (`PhaserBridge.ts`), with unit +
integration + E2E coverage and an adversarial plan review that drove a major
re-architecture. Bounded to the combat/loot audio feature; does not touch core
ECS determinism or introduce new core/game plumbing, so it stays below the
🍎🍎🍎🍎🍎 "spans 3+ systems" band.

## Context

Issue #3424 asked for sound effects covering weapons, spells, abilities,
damage taken, and loot pickups. ADR 0071 already shipped the reward-opening
audio cue layer (`AudioCueEngine` + a pure decision layer + a thin engine-layer
glue module), explicitly noting it is a **reusable** primitive for "any future
engine-layer sound (combat hits, UI chrome, ambient stingers)". This work is
that reuse.

Crawler already renders combat/ability/loot feedback through three existing,
data-only (`src/shared/`) render-event queues, all populated by real core/game
systems and consumed by engine-layer VFX renderers every frame:

- `world.combatEvents` (`hit`/`blocked`/`death`/`miss`/`dodge`/`corpseExplode`)
  — read (not drained) by `EffectsVfx.ts` for hit-spark/death-pop VFX, drained
  by `CombatVfx.ts` for floating damage numbers.
- `world.abilityActivations` — the **authoritative** "a player active/spell
  ability actually fired" signal, drained by `CombatVfx.ts` for the ability
  floater.
- `world.vfxEvents` — capped, cosmetic VFX-request queue (`pickupSparkle`,
  weapon-swing/spell-cast presets, `abilityActivateFlash`, etc.), drained
  solely by `EffectsVfx.ts`.

Since all three sources already exist, populated by real gameplay, and are
already consumed non-destructively by at least one other reader
(`EffectsVfx.ts` reads `combatEvents` without draining it — the established
precedent this feature also follows), no new core/game plumbing was required.

## Decision

Mirror ADR 0071's three-module shape exactly:

1. **`src/shared/combat-audio-cues.ts`** (pure, no Phaser/WebAudio imports) —
   the deterministic decision layer. Three pure functions —
   `cueForCombatEvent`, `cueForAbilityActivation`, `cueForVfxEvent` — map an
   event to one of 10 `CombatAudioCueKind`s (`weaponHit`, `weaponCrit`,
   `weaponMiss`, `damageTaken`, `blocked`, `dodge`, `enemyDeath`, `spellCast`,
   `abilityActivate`, `pickup`) plus a damage-derived intensity
   (`intensityForDamage`, floored at 0.3, scaling to 1.0 at 40 damage).
2. **`src/engine/audio/audio-cue-engine.ts`** — unchanged, reused as-is. Each
   feature that uses it owns its **own** instance (the module's own doc
   comment discourages sharing one instance across unrelated features, since
   `stopAll()`/`dispose()` are global to that instance), so `combat-audio.ts`
   creates a separate `AudioCueEngine` from the reward-opening feature's.
3. **`src/engine/combat-audio.ts`** — the glue. `synthSpecForCue` maps a
   decided cue to a `SynthCueSpec` (waveform/frequency/duration/gain, labeled
   `combat:<kind>`). `createCombatAudio(engine)` returns a controller with
   `update(world, renderElapsedMs)` (reads, never drains, all three queues
   every frame) and `destroy()`. Bursty frames are arbitrated by **two**
   layers: a per-kind cooldown (`MIN_GAP_MS_BY_KIND`) and a priority-ranked
   per-frame cue budget (`CUE_PRIORITY` + `MAX_CUES_PER_FRAME = 4`), so a
   frame with more distinct cue kinds than the budget keeps the
   highest-salience cues (damage taken > death > crit > spell/ability >
   blocked/dodge > hit > miss/pickup) instead of first-in-queue-order.
4. **`src/engine/PhaserBridge.ts`** wires `combatAudio.update()` into the
   per-frame render loop **before** `effectsVfx.update()` (drains
   `vfxEvents`) and `combatVfx.update()` (drains `combatEvents` +
   `abilityActivations`) — preserving the read-before-drain contract already
   established by `EffectsVfx.ts`'s existing (undrained) read of
   `combatEvents`. `createPhaserBridge` now accepts an optional injected
   `AudioCueEngine`, defaulting to a fresh instance, purely so
   `MainGameScene.ts` can wrap it in a logging engine for observability (see
   below) without changing default production behavior.
5. **`MainGameScene.ts`** constructs the injected engine through a
   `createCombatAudioCueLoggingEngine` wrapper (mirroring
   `createRewardAudioCueLoggingEngine` 1:1) that appends every dispatched
   `SynthCueSpec` to a `combatAudioCueLog` field, exposed through
   `main-scene-probe-lab`'s `getCombatAudioCueLog`/`clearCombatAudioCueLog` for
   E2E observability — never read by gameplay code.

## Plan Review Resolutions

An adversarial plan review (separate model, `gpt-5.4`, rubber-duck agent)
considered 3 alternative designs and **rejected** the original plan
(`plan_divergence: major_fork`), raising 7 concerns, all resolved:

1. **Blocking — `vfxEvents` is a cosmetic, capped, non-authoritative queue and
   should not be the primary trigger source for non-combat audio.** The
   original plan inferred weapon-swing and spell-cast audio from `vfxEvents`
   VFX-kind presets (`weaponSwingArc`, `fireballBlast`, etc.), which also fire
   for purely cosmetic re-renders and can silently drop events under load
   (`VFX_EVENT_CAP = 512`). **Resolved**: spell/ability audio now sources
   exclusively from `world.abilityActivations` (uncapped relative to gameplay
   cadence, and the authoritative "ability actually fired" signal); `vfxEvents`
   is only consulted for the one signal with no combat-event or
   ability-activation equivalent — `pickupSparkle`.
2. **Blocking — the plan missed the authoritative `world.abilityActivations`
   queue entirely.** Already covered by (1).
3. **Blocking — naive per-kind cooldown throttling is too weak for bursty
   multi-kind frames** (e.g. a corpse-explode chain landing `hit` + `death` +
   `critBurst` VFX all in one frame would fire every kind's cue
   simultaneously, an unpleasant audio clash). **Resolved**: added the
   priority-ranked per-frame cue budget (`MAX_CUES_PER_FRAME = 4` +
   `CUE_PRIORITY`) described above, on top of the per-kind cooldown.
4. **Non-blocking — pickup-type inference from `vfxEvents.color` is
   unreliable.** Confirmed via `bossChestPickupSystem.ts` (tint `0xffd700`)
   and `harvestSystem.ts` (tint `0x66ffaa`) that real pickup producers use ad
   hoc tints **outside** the `PICKUP_SPARKLE_COLORS` palette
   (`gem`/`gold`/`item`). **Resolved**: dropped color-based type inference;
   `pickup` is a single generic cue kind, not type-differentiated.
5. **Non-blocking — frame ordering fragility.** **Resolved**: `combatAudio`
   reads (never drains) all three queues, called before any drainer in
   `PhaserBridge.ts`'s render loop, with the ordering constraint documented
   inline and locked by `tests/integration/combat-audio-pipeline.test.ts`.
6. **Non-blocking — test strategy needed both isolation and real-wiring
   coverage.** **Resolved**: unit tests for the pure decision layer and the
   cooldown/priority-budget arbitration in isolation, an integration test
   proving read-before-drain ordering against a real `GameWorld`, and (added
   after initial implementation, per rule #9) a real-scene E2E suite (see
   below).
7. **Non-blocking — mixing/ownership.** **Resolved**: `combat-audio.ts` owns
   its own `AudioCueEngine` instance, matching ADR 0071's per-feature
   ownership guidance; no cross-feature `stopAll()`/`dispose()` interference.

## Observe Before Done

Unit and integration tests prove the pure decision logic and the
read-before-drain ordering contract against a `createTestWorld()` fixture, but
per rule #9 that cannot prove `MainGameScene`/`PhaserBridge` actually wire
`combatAudio.update()` into the real per-frame render loop, nor that a real
`AudioCueEngine` instance is actually constructed and reachable end-to-end.
`tests/e2e/combat-audio-real-wiring.test.ts` boots the real `MainGameScene`
(via `main-scene-probe-lab`, the same production class used by the shipped
game) and asserts against `combatAudioCueLog` that:

1. a real ability activation (`forceActivateAbility`, driven through the
   shipped ability-activation pipeline via the existing
   `primeMagicMissileLightProbe` probe method) dispatches `combat:spell-cast`;
2. a `CombatEvent` pushed onto the real `world.combatEvents` queue (via a new
   `pushTestCombatEvent` probe method — arrangement affordance only, mirroring
   the existing pattern of probe methods that directly mutate world state to
   set up a scenario, e.g. `equipPlayerActiveAbility`, `spawnEnemy`) dispatches
   `combat:damage-taken` on the next real render frame;
3. a `VfxEvent` pushed onto the real `world.vfxEvents` queue (via a new
   `pushTestVfxEvent` probe method) dispatches `combat:pickup` on the next real
   render frame.

All 4 assertions pass against the actual booted scene.

## Consequences

- **Positive**: zero new core/game plumbing — all three trigger sources
  already existed, populated by real gameplay systems, for other (visual)
  consumers.
- **Positive**: `audio-cue-engine.ts`'s reuse is validated a second time,
  confirming ADR 0071's claim that it is a genuinely reusable primitive.
- **Positive**: the priority-ranked per-frame cue budget is a reusable
  arbitration pattern for any future feature that reads from multiple
  independently-populated event queues in the same frame.
- **Trade-off**: `pickup` is a single generic cue, not differentiated by loot
  type (gem/gold/item) — accepted because the only differentiation signal
  available (`vfxEvents.color`) is unreliable in practice; a future iteration
  could add a proper typed pickup signal if finer-grained pickup audio is
  wanted.
- **Trade-off**: `MAX_CUES_PER_FRAME = 4` and the specific `CUE_PRIORITY`
  ordering are initial tuning values, not derived from playtesting; expect
  follow-up tuning once the feature is played.

## Alternatives Considered

- **A dedicated `audioEvents`/`presentationEvents` queue mirroring
  `vfxEvents`**: rejected as unnecessary new core plumbing, since two of the
  three needed trigger sources (`combatEvents`, `abilityActivations`) already
  existed as authoritative queues; only pickups lacked one, and a single
  generic cue was judged sufficient rather than justifying a new queue.
- **A single feedback presenter fanning out to VFX and audio from one call
  site**: rejected — would require invasive changes to `EffectsVfx.ts`/
  `CombatVfx.ts` internals for a marginal ordering-safety gain over the
  comment-documented + integration-tested read-before-drain ordering already
  achieved.
- **VFX-kind-driven audio for spells/abilities/pickup type** (the original
  plan): rejected by the adversarial plan review — see Plan Review
  Resolutions above.

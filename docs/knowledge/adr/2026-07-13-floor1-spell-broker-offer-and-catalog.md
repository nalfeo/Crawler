# ADR: Floor 1 spell broker uses a deterministic cached 3-of-10 offer over the existing ability catalog

## Status

Accepted

## Date

2026-07-13

## Estimated Complexity

🍎 x 3 — expands an existing feature across shared/game/engine/tests without adding a new subsystem

## Context

Floor 1 previously exposed only three boss-reward spells (`fireball`, `heal`, `pulse-shield`) and the reward modal hardcoded both the offered ids and their display text.

Issue #1096 required seven more implemented Floor 1 spells, a random three-spell offer from a ten-spell pool, visible spell VFX, and real game plus abilities-lab wiring. The work touched multiple layers:

- `src/shared/**` for the reward-pool ids, effect unions, and VFX event kinds
- `src/game/**` for deterministic offer selection, spell definitions, effect execution, and AI reward claiming
- `src/engine/**` for reward-modal rendering and new spell-cast feedback

That cross-layer change needed a single explicit decision about where the spell definitions stay authoritative and how the UI gets the currently offered reward choices without violating layer boundaries.

## Decision

We keep the existing inline ability catalog in `src/game/abilities/registry.ts` as the single source of truth for Floor 1 reward spell definitions and extend it from three to ten spells.

We sample the offered reward trio deterministically from `world.seed` using a hashed `SeededRandom`, cache that trio in `world.floorScenario.offeredRewardSpellIds`, and make that cached trio authoritative for both UI presentation and `selectSpellFromBossBattle()` validation.

We do **not** duplicate spell labels/descriptions into `src/shared/**` or let `src/engine/**` import the game registry directly. Instead, the game/bootstrap layer injects the current reward options into `MainGameScene` through `MainGameSceneOptions.getSpellRewardOptions`.

New spell mechanics are implemented by extending the existing `CatalogEffect` + `applyCatalogEffect()` pipeline, and new visuals are emitted through `world.vfxEvents` into `EffectsVfx`, matching the already-shipped spell-cast VFX architecture.

## Consequences

### Positive

- The reward offer is deterministic, seed-stable, and does not reshuffle when the modal reopens.
- The offered trio is enforced as real gameplay state, so AI/manual/programmatic selection paths cannot learn unoffered spells.
- Spell metadata stays single-sourced in the ability registry while the engine boundary remains clean.
- New reward spells reuse the existing spell/effect/VFX plumbing instead of introducing a second reward-only spell system.

### Negative

- Adding new spell mechanics still requires touching several coordinated surfaces (`shared` union, Zod schema, runtime switch, renderer presets, tests).
- `FloorScenarioState` now carries one more Floor-1-specific cached field.

### Risks

- Future reward-pool edits can drift if ids are added to `FLOOR1_BOSS_REWARD_SPELL_IDS` without matching ability definitions or tests.
- AI reward selection still needs explicit policy (currently: prefer offered `heal`, else first offered spell) to avoid silent survival regressions.

## Alternatives Considered

1. **Create a separate shared reward-spell metadata table for the modal.** Rejected because it duplicates registry-owned names/descriptions and invites drift.
2. **Let the engine import the ability registry directly.** Rejected because it violates the project’s layer boundary (`src/engine/**` must not import `src/game/**`).
3. **Sample the offer on modal open with `world.rng`.** Rejected because UI-open timing could drift determinism and reshuffle on reopen unless extra state was added anyway.

## Amendment (2026-08-03): the Broker's stock is 9 spells, not 10

`FLOOR1_BOSS_REWARD_SPELL_IDS` drops `curse`, so the offer is now a
deterministic **3-of-9**. Everything else in this ADR is unchanged: the offer is
still sampled from the dedicated `${seed}:floor1-spell-reward-offer` stream,
still cached in `world.floorScenario.offeredRewardSpellIds`, and still
authoritative for both the modal and `selectSpellFromBossBattle()` validation.

`curse` was chosen because its cluster-slow duplicates the control half of
`frost-nova` without the damage, which made it the weakest pick in an offer that
is the player's only Floor 1 spell. It is removed from the Broker's *stock*
only — the ability itself remains fully defined and reachable through the
registry, VFX pipeline, and equipment grants.

World RNG is untouched (the offer draw has always used its own stream), so
headless/seed fingerprints do not move. Per-seed *offered trios* do change,
which is expected: no gate asserts specific offered ids, only that the trio is
distinct, drawn from the pool, and stable for a given seed.

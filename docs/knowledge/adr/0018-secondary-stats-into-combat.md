# ADR 0018: Wire secondary stats (crit/dodge) into the combat damage path

## Status

Superseded by `2026-07-16-primary-stat-system-overhaul.md`

## Date

2026-06-25

## Estimated Complexity

🍎 x 4 — touches 3 layers (core damage path, engine VFX, game sim loop) and
re-derives the headless seed, but adds no new ECS system (so no new lab) and
reuses the existing `EffectiveStats` store.

## Context

The ECS stores and UI for `critChance`, `critMultiplier`, and `dodgeChance`
already existed (`src/core/components.ts`, `src/shared/stats.ts`, `EquipmentUI`, the stat
and equipment labs), but **no combat system read them** — a grep for crit/dodge
across the combat path returned nothing. Level-up core-stat allocation flowed
into a _separate_ stat pipeline (`stores.stats`, derived by
`src/game/systems/statsSystem.ts`) that combat reads, while the richer
`stores.effectiveStats` pipeline (PRIMARY + SECONDARY, derived by
`equipmentSystem`) was read only by the Equipment UI. As a result Luck and
Dexterity allocation had **no gameplay effect**, and Wisdom/Charisma showed
"(no effect yet)".

ITEM 5 asked us to (a) hook crit and dodge into damage and (b) make level-up
core-stat allocation actually reach combat through `effectiveStats`.

## Decision

1. **Derive secondaries from effective primaries.** Add a
   `CORE_STAT_TO_SECONDARY` map (`src/shared/stats.ts`): Luck → `critChance`
   (+0.005/effective point), Dexterity → `dodgeChance` (+0.003/effective point).
   The rate is applied to the **effective** primary (base 1 + allocated level-up
   points + equipment bonuses), so both allocation and gear flow through.

2. **One shared EffectiveStats formula.** Extract `applyEffectiveStats`
   (`src/core/effective-stats.ts`, a pure helper — _not_ a `(world)=>void` system, so
   it lives in `core/` root next to `apply-damage.ts`/`combat-rolls.ts`, not in
   `core/systems/`). Both `equipmentSystem.recomputeEffectiveStats` (eager, on
   equip) and `statSystem` (per-frame) delegate to it: base → fold core points →
   add equipment → derive secondaries → clamp. This guarantees the two callers
   can never drift.

3. **Centralize crit/dodge in the `applyDamage` choke point.** All damage flows
   through `applyDamage`, so crit and dodge live there rather than in each weapon
   handler:
   - **Crit** (player → enemy): roll `world.rng.next()` vs the player's
     `critChance`; on a hit, scale the amount by `critMultiplier` and flag the
     existing `'hit'` event with `isCrit`. We reuse the `'hit'` event rather than
     emitting a separate `'crit'` event because gore, drops, and knockback all
     consume `'hit'` — a parallel event would bypass or double-count them.
   - **Dodge** (incoming → player): roll vs the player's `dodgeChance`; on a
     dodge, negate the hit and emit a new `'dodge'` combat event.
   - Both paths are **gated on the relevant entity having `EffectiveStats`**. The
     test helpers (`spawnPlayer`/`spawnEnemy`) do not add that store, so bare test
     worlds remain roll-free and deterministic; only the real Floor 1 player (via
     `initializeBaseStats`) rolls.

4. **Run `statSystem` in the loop.** Add it to the headless sim loop
   (`src/game/ai/simulation-step.ts`) and the visual game's `preSystems`
   (`src/bootstrap/floor-main-scene-options.ts`), right after `statsSystem`, so
   allocation reaches combat identically in both.

5. **Render the outcomes.** `src/engine/CombatVfx.ts` emphasizes crits (orange,
   larger, trailing `!`) and shows a cyan `DODGE` floater.

## Consequences

### Positive

- Luck and Dexterity allocation (and crit/dodge gear) now have a real, visible
  combat effect — the ITEM 5 payoff.
- A single `applyEffectiveStats` formula removes the duplicated base+equipment
  computation that previously lived in both `equipmentSystem` and `statSystem`.
- Crit/dodge are deterministic and `SeededRandom`-driven, so headless runs stay
  reproducible.

### Negative

- Adding RNG rolls to `applyDamage` shifts the shared RNG stream, so the headless
  `WINNING_SEEDS` had to be re-probed; the gate now pins **seed 6** (~139s
  game-time, level 5, 14 kills — still clears all 5 quests within budget).
- `applyDamage` now reads the player singleton via a `query([Player,
EffectiveStats])` on enemy hits; negligible cost but worth noting.

### Risks

- If a future caller routes damage _around_ `applyDamage`, crit/dodge silently
  won't apply. Mitigated by `applyDamage` already being the documented sole
  choke point.
- Tuning: the chosen rates (0.5%/0.3% per point) are a starting point and may
  need balancing once more progression content exists.

## Alternatives Considered

- **Per-weapon-handler crit/dodge** — rejected; would duplicate the roll across
  every damage vector (weapon, area, beam, trap) and risk divergence.
- **A separate `'crit'` combat event** — rejected; `'hit'` consumers (gore,
  drops, knockback) would be bypassed. The `isCrit` flag on `'hit'` keeps a
  single event lifecycle.
- **Reading crit/dodge from the `stores.stats` pipeline** instead of
  `effectiveStats` — rejected; `stores.stats` has no crit/dodge fields and is a
  flat gameplay-stat projection, whereas `effectiveStats` already models PRIMARY
  - SECONDARY and is the natural home for level-up + equipment derivation.

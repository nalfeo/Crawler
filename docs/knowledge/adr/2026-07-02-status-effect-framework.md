# ADR: Generic Status-Effect / Stat-Modifier Framework

**Date:** 2026-07-02  
**Scope:** src/shared (spec types), src/core (runtime helpers, ECS system, world sidecar, entity lifecycle), src/game + src/engine (speed read-site fold-ins, pipeline wiring), src/core/systems/equipmentSystem (data-driven source)

## Status

Accepted (2026-07-02).

## Estimated Complexity

🍎 x 4 — one new generic ECS system plus a sidecar data model, two sim-pipeline
insertions, two speed read-site fold-ins, data-driven equipment integration, a lab,
and a property/parity test matrix.

## Context

There was **no** generic buff/debuff/status framework. Per-entity speed lived in
`world.stores.enemyBehavior.speed[eid]` (set at spawn in `combatants.ts`, read via
`getEnemySpeed`/`getEnemySpeedCap` in `enemyAISystem.ts`); the only runtime speed
modulation was hardcoded slime-leap multipliers. Floor 2's relationship-driven "hate
speed ramp" needs a reusable, deterministic modifier seam, and Floor 1 combat can be
enriched with timed effects today. We needed **one** deterministic, timed, stacking
stat-modifier framework — extensible to damage/defense/DoT/HoT — rather than a fleet
of per-effect one-offs, and it had to compose with the existing character-sheet stat
pipeline (`BaseStats`/`EffectiveStats` in `effective-stats.ts`) without duplicating it.

## Decision

Build a generic, deterministic status-effect framework split across the shared/core
layer boundary, driven from the fixed-step frame clock.

1. **Spec/runtime split across the layer boundary.** The plain-data spec type
   (`StatusEffectSpec`) lives in `src/shared/status-effect-types.ts` so
   `EquipmentItemDef` (also in `src/shared`) can reference it — `src/shared` cannot
   import `src/core`. Runtime helpers and the ECS system live in `src/core`
   (`src/core/status-effects.ts`, `src/core/systems/statusEffectSystem.ts`). `StatusEffect` extends the
   spec with a mutable `remainingMs` (`Infinity` for persistent effects).

2. **Sidecar map, not a component store.** Active effects live in
   `world.statusEffectsByEntity: Map<number, StatusEffect[]>`, matching the existing
   variable-length-per-entity sidecar idiom (`inventories`, `npcs`,
   `skillStatesByEntity`, `enemyAppearanceKeys`). `createComponentStores()` /
   `wireStore` are untouched — a fixed SoA store is a poor fit for a per-entity list
   of arbitrary length.

3. **Product-of-factors composition (deliberately distinct from `(1+Σ)`).** The
   effective value is `raw = (base + Σ add.value) * Π multiply.value`, then clamped.
   This is intentionally different from `statsSystem`'s additive
   `(1 + Σ percent)` model: multiplicative slows compose (0.8 × 0.5 = 0.4) and can
   **never flip sign**, which is the correct semantics for stacking speed
   debuffs/buffs. The two models live in two different lanes (see #7) and are not
   interchangeable — this distinction is the main footgun the ADR exists to record.

4. **Two application MODES.** This is the core design decision:
   - **Read-site fold-in** (`speed`, future `defense`): the system does **not** mutate
     these. Movement read-sites fold them in on demand via `computeEffectiveSpeed` /
     `computeEffectiveValue`. This keeps the base value authoritative and avoids
     write-back/ordering hazards.
   - **Per-tick apply** (`hpRegen`, future `dot`): the system **does** mutate state
     (`health.current += rate * dtMs/1000`, clamped to max). It heals living entities
     only (`current > 0` — no revive), and runs **before** damage/`healthSystem` so a
     heal can never mask a same-frame death.

5. **Discriminated-union stack rules**, keyed by `stackKey =
sourceType:sourceId:stat:op`: `replace` (overwrite same-key — idempotent
   re-apply), `refresh` (`remainingMs = max(existing, new)`), and `stack{maxStacks}`
   (append; drop oldest same-key by insertion order when over cap). Invalid specs
   (non-finite `value`, negative `multiply`, non-positive finite `durationMs`) are
   rejected by `isValidSpec` and are no-ops on apply.

6. **Persistent effects.** `durationMs === null` → `remainingMs = Infinity`; the
   expiry loop skips `Infinity` so persistent effects leave only via explicit
   `clearStatusEffects` or entity death. Used for while-equipped equipment effects and
   (future) auras.

7. **Equipment is a data-driven source, in its own lane.** `EquipmentItemDef` gains an
   optional `grantsStatusEffects?: readonly StatusEffectSpec[]`. `equip()` validates
   every spec up front inside `canEquip`/`validateItemDef` (an `invalidDef` reason), so
   the post-mutation `applyStatusEffect` call is infallible and `equip()` stays
   **atomic**. The runtime `sourceId` is instance-scoped (`equipment:${instanceId}`),
   **not** the def id, so duplicate-capable items track independently; `unequip()`
   clears only that instance's effects. `statBonuses`/`EffectiveStats`
   (`effective-stats.ts`) remain the equipment **character-sheet** lane;
   `grantsStatusEffects` is the **timed / source-tracked gameplay-effect** lane. The
   two are complementary, not redundant.

8. **Deterministic timing, two pipelines, one slot.** Timing is driven solely by the
   fixed `GAME.DELTA_MS` (`1000/60`) per frame — never `Date.now()`/`performance.now()`,
   never `Math.random()`. `statusEffectSystem` runs in the same relative slot in both
   sim pipelines: injected via `preSystems` in the visual step
   (`src/bootstrap/floor-main-scene-options.ts` → `src/engine/sim/simulation-step.ts`) and hardcoded in
   the headless step (`src/game/ai/simulation-step.ts`). In both cases it runs **after**
   both speed read-sites — `playerInputSystem` (which runs before all `preSystems`) and
   `enemyAISystem` — so player and enemy effective-speed folds observe the **same
   pre-expiry effect set** every frame (no 1-frame expiry skew between player and enemy
   timed-speed effects), and **before** `movementSystem` (so speed fold-in affects the
   same frame) and **before** damage/`healthSystem` (so HoT can't mask a death). Because
   speed is a read-site fold-in (the system never mutates speed), its order relative to
   `enemyAISystem` is a pure timing choice, resolved here in favour of player/enemy
   symmetry.

9. **Authoritative recycled-EID cleanup.** `clearEntityStores`
   (`src/core/spawners/entity-core.ts`, the sole non-lab creation path) deletes
   `statusEffectsByEntity[eid]`, so a recycled bitecs EID can never inherit a dead
   entity's effects. The system's `entityExists` sweep is only secondary memory
   hygiene.

## Floor 2 hook (design only — not implemented here)

The hate ramp `effectiveSpeed = baseSpeed + (playerSpeed − baseSpeed) * (25 − r)/25`,
clamped `[baseSpeed, playerSpeed]` for `r ∈ [0,25)`, plugs in later as a **spec
producer**: a Floor 2 system computes the additive delta and applies
`{ stat:'speed', op:'add', value: delta, durationMs:<frame>, sourceType:'aura', … }`
with explicit `clamps:{ min:baseSpeed, max:playerSpeed }`. No framework change needed.

## Consequences

### Positive

- **One generic system, zero cruft:** speed, HoT, and future defense/DoT all flow
  through the same apply/stack/expire/compose machinery.
- **Deterministic & replayable:** fixed-step timing + no RNG in the hot path means
  same seed + same frame count ⇒ identical results (property + parity tested).
- **Floor 2-ready:** the hate ramp is a pure spec producer over the existing API.
- **Atomic, instance-scoped equipment integration:** re-equip is idempotent; duplicate
  items don't clobber each other.
- **No regression to slime-leap or the character-sheet stat pipeline:** the leap
  multipliers layer on top of the folded-in base speed; `EffectiveStats` is untouched.

### Negative

- **Two composition conventions in the codebase** (`(1+Σ)` for character-sheet stats
  vs product-of-factors for status effects) — a real footgun, mitigated by this ADR
  and the lane wording in #7.
- **Sidecar memory:** one array entry per affected entity (bounded; cleaned on death
  and expiry).

### Risks

- **Pipeline drift:** if a future refactor drops the system from one pipeline's
  pre-movement slot, effects would silently stop in that pipeline. Mitigated by the
  cross-pipeline parity test (isolated no-combat fixture asserting exact-equal HoT
  across both step functions).
- **Float32 HoT accrual:** `health.current` is a Float32 store, so per-frame accrual
  carries ~1e-5 rounding. Acceptable (tests assert to ±5e-4); does not affect
  cross-pipeline determinism because both pipelines run identical operations.

## Alternatives Considered

- **A fixed component store** for effects — rejected: variable-length per-entity data
  is a poor fit for SoA; the sidecar idiom already exists.
- **Reusing `statsSystem`'s `(1+Σ)` model** for speed — rejected: additive percent
  stacking can flip speed negative and doesn't model multiplicative slows correctly.
- **Mutating `stores.enemyBehavior.speed` / `stores.stats.hpRegen` in place** —
  rejected for `speed`: destroys the authoritative base and creates write-back
  ordering hazards; read-site fold-in is cleaner. (`hpRegen` is per-tick apply because
  healing is inherently a state mutation, but it writes `health.current`, not the
  unused `stores.stats.hpRegen`.)
- **A bespoke chill-on-hit one-off for the Floor 1 demo** — rejected in plan review in
  favor of the data-driven `grantsStatusEffects` charm HoT, which exercises the
  equipment source path and the AI buy/equip flow deterministically.

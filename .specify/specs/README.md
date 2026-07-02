# Spec Index

`.specify/specs/` holds **system specifications** — the design-and-contract layer
between the high-level [Game Design Document](../../docs/knowledge/game-design/game-design-document.md)
and the code. A spec describes _what a system must do_ and _why_, with a test
plan and a constitutional-compliance check.

- **Template:** `.specify/templates/spec.md` (Context · Requirements · Design · Test Plan · Constitutional Compliance)
- **Constitution:** `.specify/memory/constitution.md`
- **Specs are living documents** — when code and spec diverge, fix whichever is
  wrong and note the reconciliation (see the stats spec's units note for an
  example).

> **Specs vs ADRs vs system docs.** A **spec** is the durable contract for one
> system. An **[ADR](../../docs/knowledge/adr/README.md)** records a single
> decision (often amending a spec). A **[system doc](../../docs/architecture.md#6-systems-catalogue)**
> (`docs/systems/*`) is the narrative/onboarding view. The architecture overview
> links them together.

---

## Current specs

| Spec                                                                         | Scope                                                                               | Code source-of-truth                                                                                                                                                                    | Notes                                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Stats, Skills & Leveling](stats-skills-levels.md)                           | XP curve, stat keys, skill-by-usage, modifiers                                      | `src/shared/stats.ts`, `src/game/systems/`, `src/core/effective-stats.ts`                                                                                                               | Reconciled to **feet** units (ADR 0023) + `accuracy` stat        |
| [Equipment System](equipment-system.md)                                      | 16-slot paper-doll, equip/unequip, stat bonuses                                     | `src/shared/equipmentDefs.ts`, `src/core/effective-stats.ts`, `EquipmentUI`                                                                                                             | Matches code                                                     |
| [Sprite Generation Pipeline](sprite-generation-pipeline.md)                  | Asset gen / slice / judge / approve workflow                                        | `scripts/sprites/`, `src/engine/sprites/`                                                                                                                                               | See ADRs 0003, 0017–0025 (sprites)                               |
| [Combat & Damage](combat-damage.md)                                          | `applyDamage` order, armor, i-frames, crit/dodge, combat events                     | `src/core/apply-damage.ts`, `src/core/systems/damageSystem.ts`                                                                                                                          | **Shipped**                                                      |
| [Weapon System](weapon-system.md)                                            | 6 weapon types, cooldown/targeting/LOS, accuracy, projectiles                       | `src/game/weaponSystem.ts`, `src/shared/weaponDefs.ts`, `src/core/helpers.ts`                                                                                                           | **Shipped**                                                      |
| [Floor 2 — Family Territories & Relationships](floor2-family-territories.md) | Open cave floor: feuding mob families, 0–100 relationships, dynamic win, settlement | [ADR 0040](../../docs/knowledge/adr/0040-floor2-family-territory-and-relationship-architecture.md) + [content bible](../../docs/knowledge/game-design/floor2-families-and-resources.md) | **Design (proposed)** — not yet built; sliced into follow-up PRs |

---

## Missing-spec backlog (prioritized)

These shipped systems have **no formal spec** yet. Each row points at the
existing design narrative (system doc), the key decisions (ADRs), and the
authoritative code, so a spec can be written from evidence. Priority reflects
combat-loop centrality × divergence risk.

| Priority | Spec to write               | Source-of-truth pointers                                                                                                                                                 |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1**   | **Enemy AI & Spawning**     | [systems/04-enemy-ai](../../docs/systems/04-enemy-ai.md) · ADR 0022 (BT kernels), 0024 (engagement budget), 0025 (spawner) · `src/game/ai/`, `src/game/enemyAISystem.ts` |
| **P1**   | **Drops & Loot**            | [systems/07-drops-loot](../../docs/systems/07-drops-loot.md) · ADR 0006 · `src/core/systems/dropSystem.ts`, `src/core/systems/itemPickupSystem.ts`                       |
| **P2**   | **Map Generation & Floors** | [systems/06-map-generation](../../docs/systems/06-map-generation.md) · ADR 0008/0009/0021/0023/0024 · `src/game/floor*`, dungeon generator                               |
| **P2**   | **Quest System**            | ADR 0011/0015/0016 · `src/core/systems/questSystem.ts`, `src/game/floor1Scenario.ts`                                                                                     |
| **P2**   | **Safe Rooms & NPCs**       | ADR 0012/0013 · `src/core/safe-space.ts`, `src/core/systems/npcSystem.ts`                                                                                                |
| **P3**   | **Movement & Input**        | [systems/01-movement-input](../../docs/systems/01-movement-input.md) · `src/core/systems/playerInputSystem.ts`, `movementSystem.ts`                                      |
| **P3**   | **VFX & Effects Pipeline**  | ADR 0025 (VFX), 0027 (corpse shatter) · `src/engine/` VFX subsystems, `world.vfxEvents`                                                                                  |
| **P3**   | **Mana & Abilities**        | ADR 0019 · `src/core/systems/manaSystem.ts`, `src/game/systems/abilitySystem.ts`                                                                                         |

### Authoring guidance

1. Start from the system doc + ADRs above to capture intent, then **verify every
   contract against the cited code** — specs must match reality.
2. Follow `.specify/templates/spec.md`. Include a **Test Plan** mapped to the
   real suites under `tests/` and a **Constitutional Compliance** table.
3. Add the new spec to the [Current specs](#current-specs) table and remove its
   backlog row.

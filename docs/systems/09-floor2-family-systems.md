# 09 · Floor 2 Family Systems

> **Status:** Partial (as of 2026-07-03). Slices 1–8 implemented; the shipping
> main-scene bootstrap still targets Floor 1 only.
> **Spec:** [`.specify/specs/floor2-family-territories.md`](../../.specify/specs/floor2-family-territories.md).
> **ADR:** [0040 — Floor 2 family territory & relationship architecture](../knowledge/adr/0040-floor2-family-territory-and-relationship-architecture.md).
> **Content bible:** [`docs/knowledge/game-design/floor2-families-and-resources.md`](../knowledge/game-design/floor2-families-and-resources.md).

Floor 2 is Crawler's first **open, systemic** floor: an oversize cave system
where 3–4 feuding mob **families** hold cavern territories and fight one another
over a single contested resource. The player is an intruder who can befriend,
betray, or exterminate the families; the exit stairs appear at the resource
heart once **Win A** (sole ally with relation > 75) or **Win B** (all family
bosses defeated) is reached.

## Slice map

| Slice                               | Code                                                                                                                                       | Lab                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1. Faction data + relationships     | `src/core/faction-relations.ts`, `FamilyMembership` in `src/core/components.ts`, `src/core/systems/familyRelationshipSystem.ts`            | `family-territory-lab`         |
| 2. Cave-system map generator        | `src/core/map/generators/cave-system.ts`, `BiomeType.CAVE_SYSTEM` in the generator registry                                                | `map-gen-lab`                  |
| 3. Family-aware AI + feuding        | `src/game/systems/familyFeudSystem.ts` + `enemyAISystem.ts` band/target extensions                                                         | `family-feud-lab`              |
| 4. Boss dens + unlock objectives    | `src/game/floor2Scenario.ts` (den plumbing) reusing door-lock / sealing                                                                    | `family-boss-den-lab`          |
| 5. Dynamic win evaluator + stairs   | `floor2ObjectiveTick` in `src/game/floor2Scenario.ts`                                                                                      | `family-boss-den-lab`          |
| 6. Settlement + seeded shops        | Floor-2 quest packs, shop-inventory generator, "The Broker" NPC placement                                                                  | `floor2-settlement-lab`        |
| 7. HUD family relationships         | `HudFamilyRelationships` widget in `src/engine/` + minimap territory tint                                                                  | `hud-family-relationships-lab` |
| 8. Scenario wiring + Governor sweep | `src/shared/data/floors/floor2.manifest.json`, `src/game/floor2Scenario.ts`, win-rate sweep (`ai:winrate-sweep`), Director narration hooks | `family-boss-den-lab`          |

## Runtime shape

- **Relationships** — a single `world.factionRelations: Map<FamilyId, number>`
  is the source of truth (0–100 per family, all start at 45). Individual mobs
  carry only `{ familyId, isBoss }` via `FamilyMembership`. Bands: `0–24` hate
  (speed-ramped toward player), `25–49` hostile, `50–75` neutral, `76–100`
  friendly (follows and defends).
- **AI targeting** — hostile/hate mobs prefer the player, fall back to rival
  families. Neutral mobs feud with rivals only. Friendly mobs leash to the
  player and retaliate against attackers (ADR 0042 durable `lastPlayerHit`
  signal).
- **Bosses / dens** — each family has one boss inside a sealed den. Killing the
  boss sets `floor2-family-<id>-boss-defeated` and disables that family's
  spawns. Dens open when a seeded unlock objective is met.
- **Win** — `floor2ObjectiveTick` evaluates Win A / Win B every frame; on
  latch, the exit stairs spawn at the resource-heart tile.
- **Determinism** — every AI target choice, feud skirmish, event trigger,
  shop stock roll, and the family/resource selection uses `world.rng`. Balance
  is tuned to a **≥ 90 % seed win-rate**, never a cherry-picked seed.

## Known gaps

- The shipping main-scene bootstrap (`src/bootstrap/floor-main-scene-options.ts`)
  still boots Floor 1 only. Floor 2 is exercisable via labs and the headless
  runner, not yet from `npm run dev`.
- Content breadth (final family roster tuning, shop archetype variety,
  emergent-event pool) is narrowing to hit the 90 % win-rate gate.

## Related

- [ADR 0040 — Floor 2 family territory & relationship architecture](../knowledge/adr/0040-floor2-family-territory-and-relationship-architecture.md)
- [ADR 0042 — Durable player-hit signal for ally-defend retaliation](../knowledge/adr/0042-durable-player-hit-signal-for-ally-defend.md)
- [Systems 04 — Enemy AI](04-enemy-ai.md)
- [Systems 06 — Map Generation](06-map-generation.md)

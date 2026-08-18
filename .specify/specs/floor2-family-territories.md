# Spec: Floor 2 — Family Territories & Relationships

> **Status:** **Partial — slices 1–8 landed; full boot/win-rate shipping path incomplete.**
> The systemic Floor 2 slices below (faction data & relations, cave generator,
> family-aware AI, boss/den objectives, dynamic win evaluator, settlement + shops,
> family-relationship HUD, scenario wiring + governor sweep) all exist in code as
> of 2026-07-03. The main-scene bootstrap still targets Floor 1 only
> (`src/bootstrap/floor-main-scene-options.ts`); Floor 2 is exercisable through
> its labs (`family-territory-lab`, `family-feud-lab`, `family-boss-den-lab`, `floor2-settlement-lab`, `hud-family-relationships-lab`) and
> the headless simulator, not through the shipping `dev` entry-point flow yet.
> **Last reconciled:** 2026-07-03.
> **Estimated complexity:** 🍎🍎🍎🍎🍎 (Massive — spans core ECS, game systems,
> content, and UX; sliced into follow-up sessions in §Design).
> **Authored content:**
> [`docs/knowledge/game-design/floor2-families-and-resources.md`](../../docs/knowledge/game-design/floor2-families-and-resources.md)
> (families roster, resources, emergent events, tone).
> **Architecture:**
> [ADR 0040](../../docs/knowledge/adr/0040-floor2-family-territory-and-relationship-architecture.md).
> **Canonical home:** this spec is the living Floor 2 contract; ADR 0040 is the
> architecture rationale and slice-history.
> **Reused ADRs:** 0005 (parameterized floor config), 0010 (boss door-lock), 0011
> (data-driven quests), 0021 (reachability), 0023 (generic special-room sealing), 0024
> (engagement budget / themed set-pieces).
> **Code source-of-truth (slice → files):**
>
> 1. Faction data + relationships → `src/core/faction-relations.ts`,
>    `src/core/components.ts` (`FamilyMembership`),
>    `src/core/systems/familyRelationshipSystem.ts`, `family-territory-lab`.
> 2. Cave-system generator → `src/core/map/generators/cave-system.ts`,
>    `BiomeType.CAVE_SYSTEM` in the registry.
> 3. Family-aware AI + feuding → `src/game/systems/familyFeudSystem.ts`,
>    updates to `src/game/enemyAISystem.ts`.
> 4. Boss dens + unlock objectives → `src/game/floor2Scenario.ts` (den plumbing),
>    reuse of door-lock/sealing.
> 5. Dynamic win evaluator + resource-heart stairs → `src/game/floor2Scenario.ts`
>    (`floor2ObjectiveTick`).
> 6. Settlement + seeded shops + emergent events → floor2 quest packs,
>    shop-inventory generator, Broker NPC placement.
> 7. HUD family relationships + minimap tint → `HudFamilyRelationships` widget
>    in `src/engine/`.
> 8. Scenario wiring + Governor sweep + narration →
>    `src/shared/data/floors/floor2.manifest.json`, `src/game/floor2Scenario.ts`,
>    win-rate sweep entry, `family-boss-den-lab`.
>    **Known implementation gaps:**
>
> - Main-scene bootstrap (`src/bootstrap/floor-main-scene-options.ts`) still
>   targets Floor 1; Floor 2 is not selectable from the shipping player entry
>   point.
> - Broad content pass (final family roster tuning, shop archetype variety,
>   emergent-event breadth) still narrowing to the 90 % win-rate gate.

## Context

Floor 1 is a single hand-authored dungeon with one boss and a linear objective. Floor 2
is the first **open, systemic** floor: a large cave system where 3–4 feuding mob
**families** each hold a cavern territory and fight one another over a single contested
**resource**. The player is an intruder who can befriend, betray, or exterminate the
families, and **wins by taking a side or declaring total war** — after which the exit
stairs appear at the resource heart.

Everything must be **deterministic from a seed** (the constitution forbids
`Math.random()`/`Date.now()`), **data-driven** (families/resources/events are content,
not code), and **reuse existing machinery** (Team enum, goal flags, quest system,
door-lock, special-room sealing) rather than inventing parallel systems. The floor is
tuned **easy**, gated on a **90%+ seed win-rate**, never on cherry-picked seeds.

## Requirements

### Map & floor shape

1. **Open cave system, 25% larger than Floor 1.** Floor 1 is 240×140 = 33,600 tiles;
   Floor 2 targets ≈ **42,000 tiles** (reference layout **270×156 = 42,120**, i.e.
   +25.4%). A new `BiomeType.CAVE_SYSTEM` selects a cavern generator that produces
   large, **irregular** organic caverns connected by winding tunnels — not boxy rooms.
2. **One cavern per present family** designated as that family's **territory**, plus a
   sealed **boss den** sub-chamber per family, one neutral **settlement** cavern, and
   one central **resource heart** cavern where the exit stairs will appear.
3. **Reachability preserved.** Every territory, den entrance, the settlement, and the
   resource heart must be reachable from spawn (reuse the ADR 0021 reachability pass).

### Families & selection

4. **≥15 families defined as data; 3–4 present per floor.** The roster (18 authored)
   lives in a validated data file; the manifest seed selects **3 or 4** present
   families and **exactly one** contested resource deterministically.
5. **Families are always mutually hostile.** A family's relationship value governs only
   its stance toward the **player**, never toward other families.
6. **One boss per family.** Each present family has exactly one boss entity. Killing it
   **ends that family's spawns**; already-spawned members persist until killed or they
   despawn. A family is **"alive"** iff its boss is undefeated.

### Relationship model

7. **Per-family relationship value 0–100, all starting at 45.** Stored as the single
   source of truth `world.factionRelations: Map<FamilyId, number>` (floor-scoped);
   individual mobs carry only `{ familyId, isBoss }` and read the shared value.
8. **Bands (inclusive boundaries):**
   - **Hate** `0–24`: hostile **and** speed-boosted (see FR9).
   - **Hostile** `25–49`: hostile at normal speed.
   - **Neutral** `50–75`: non-hostile to the player; ignores the player, keeps feuding.
   - **Friendly** `76–100`: follows the player and attacks anything attacking the player.
9. **Hate speed ramp.** For a hate-band mob with relation `r ∈ [0,25)`, effective move
   speed is `baseSpeed + (playerSpeed - baseSpeed) * (25 - r)/25`, clamped to
   `[baseSpeed, playerSpeed]`. At `r = 0` the mob matches player speed (uncatchable-proof);
   at `r → 25` the boost is zero. Mobs already faster than the player are unaffected.
10. **Relationship levers (player-driven; no default decay).** Damaging/killing a
    family's mobs lowers it; killing a rival's mobs while allied raises it slightly;
    completing a family favor/tribute quest raises it; paying protection raises it;
    **betraying an ally (attacking a Friendly family) drops it sharply and latches a
    "betrayer" reputation flag**; emergent "pick a side" events shift two families at
    once. All deltas are tunable in `src/shared/data/tuning.json`; passive decay
    defaults to `0`.

### AI & feuding

11. **Band-driven targeting.** Hostile/hate mobs prefer the **player** but fall back to
    fighting **rival family** mobs when the player is unreachable. Neutral mobs target
    only rival families. Friendly mobs follow the player (leashed) and target the
    player's attackers (rival families + trash). Trash mobs target **only the player**.
12. **Determinism & perf.** All AI target choices, feud skirmishes, and event timing
    draw from `world.rng`. Enemy-vs-enemy targeting must stay within the existing
    engagement budget (ADR 0024) at Floor-2 entity counts (spatial-hash candidate
    lookup; no O(n²) global scan).

### Bosses, dens & objectives

13. **Quest-gated boss dens.** Each present family's den is **sealed** (reuse ADR 0023
    sealing + ADR 0010 door-lock) until its den-unlock flag `floor2-den-<id>-unlocked`
    is set. Two independent routes set that flag:
    - **Seeded objective (AI-reachable pool):** each family is assigned one objective
      at floor init from the pool: thin-the-ranks / steal-ledger / sabotage-still /
      bring-tribute / rival's-hit. Completing it sets `floor2-den-<id>-unlocked`.

    - **Universal win-favor bypass (parallel, latched):** if a family's relation
      reaches the Friendly band (>75) the den opens regardless of the seeded
      objective. The unlock is latched (`floor2-family-<id>-favor-earned`) so a
      later relation drop cannot re-seal the den. This route is **universal** — not
      seeded per-family — because `win-favor>75` is AI-unreachable (headless AI
      fights, which lowers relation) and seeding it for individual families would
      stall their dens in headless runs (rule #12 / win-rate gates).

14. **Boss defeat gates spawns.** Killing boss `<id>` sets goal flag
    `floor2-family-<id>-boss-defeated`, which disables that family's spawner.

### Win / lose

15. **Two win shapes, evaluated each floor tick:**
    - **Win A (sole ally):** exactly **one** present family is alive **and** its
      relation is **> 75**.
    - **Win B (total war):** **every** present family's boss is defeated.
      Reaching either latches `floor2-victory`. Allying two families is **not** a win.
16. **Stairs at the resource heart.** On `floor2-victory`, the exit stairs spawn at the
    resource-heart tile (reusing the Floor-1 boss-stair spawn plumbing); descending
    there transitions floor state.
17. **Lose conditions:** player death, or a generous floor timer (`elapsedMs`-based,
    with a stall-guard) expiring before victory.

### Trash mobs & settlement

18. **Varied trash mobs** (≥6 types) that are **neutral to families** and **hostile to
    the player** only — XP/loot fodder, more varied than Floor 1's rats/slimes.
19. **Settlement safe room** with a sealed perimeter (reuse `src/core/safe-space.ts`
    semantics + RoomRole.SAFE): **1–2 seeded shops** from an archetype pool and **≥1
    quest-giver** ("The Broker") dispensing the emergent family quests. Shop inventory
    is produced by a **seeded random-inventory generator**.

### UX

20. **Family relationship tracker HUD.** A new `HudFamilyRelationships` widget shows one
    row per present family: color swatch, name, a 0–100 band-colored bar, a
    boss-alive/skull indicator, and an allied/at-war tag. It reads
    `world.factionRelations` and the boss goal flags and updates live as relations
    shift. The minimap tints territories by family color and colors enemy dots by family.
    **Activation gate:** the widget is hidden until `world.floorExtendedState?.familyState`
    exists and `reputationSystemActive` is not explicitly `false`; real Floor 2
    initialization sets `reputationSystemActive: false` until the Broker introduction
    tick flips it. Fixtures and lab worlds that omit the field remain visible for
    backward compatibility (see ADR [0059-floor2-settlement-progression-contract](../adr/0059-floor2-settlement-progression-contract.md)).

## Design

### Data model (content, Zod-validated per ADR 0011 pattern)

- **`families.json`** — `FamilyDef[]`: `{ id, name, species, boss:{title,name,archetype},
aiArchetype, hudColor, refinementStyle, signature }`. ≥15 entries.
- **`resources.json`** — `ResourceDef[]`: `{ id, name, streetName, product }`. 10–20 entries.
- **`enemies.floor2.json`** — enemy packs whose archetypes gain optional `familyId` and
  `isBoss` fields (trash mobs omit `familyId`).
- **`quests.floor2.json`** — den-unlock objectives + emergent-event quests, authored as
  existing data-driven quest packs (`installQuestPacks`).
- **`src/shared/data/floors/floor2.manifest.json`** — rewritten to `BiomeType.CAVE_SYSTEM`,
  the ~270×156 dims, a seed, the family/resource selection pools, present-count `3–4`,
  emergent-event pool, and settlement/shop config. (Illustrative only in this spec; the
  concrete manifest lands in the wiring session.)

### ECS components & world state

- New tag component **`FamilyMembership`** with stores `familyId` (`ui8` index) and
  `isBoss` (`ui8`), added in `createComponentStores()` (`src/core/components.ts`) and
  wired via `wireStore` in `src/core/world.ts`. Relationship value is **not** per-mob.
- `GameWorld` gains `factionRelations: Map<FamilyId, number>` plus helpers
  `getRelation`, `adjustFactionRelation` (clamps `[0,100]`, emits a relation-changed
  event for HUD + quests), and `bandFor(relation)`.
- Reuse existing `world.goalFlags`, `world.questLog`, `world.npcs`, and the per-floor
  `floorObjectiveTick` hook.

### Systems

- **`familyRelationshipSystem`** — drains queued relationship deltas (from combat,
  quests, events), clamps, recomputes bands, emits change events.
- **Family-aware AI** — extend `src/game/enemyAISystem.ts` with a band-keyed foe-set /
  target-selection function, the hate speed ramp (FR9), and ally follow/defend (leash).
  Enemy-vs-enemy feud targeting with player-preference (may live in a small
  `familyFeudSystem` or fold into the AI system).
- **`floor2ObjectiveTick`** — den-unlock evaluation, boss-defeat spawn-gating, the FR15
  dynamic win evaluator, and resource-heart stair resolution. Registered as Floor 2's
  `floorObjectiveTick` (generalize `floorScenario` or add `initializeFloor2Scenario`).
- **Emergent events** — a seeded `emergentEventSystem` scheduler firing authored
  `quests.floor2.json` packs on triggers (region enter, threshold cross, timer beats).
- **Shop generator** — `generateShopInventory(rng, archetype)` produces seeded stock;
  NPCs spawn via existing `spawnNpcFromPlacement` + placements.

### Map generation

- New `CaveSystemGenerator` registered for `BiomeType.CAVE_SYSTEM` in
  `src/core/map/generators/registry.ts`. **Build-on-existing-dependency:** reuse rot-js's
  cellular-automata map (`ROT.Map.Cellular`, already a project dep) for organic caverns,
  then segment caverns into `RoomData` regions and label them (territory / settlement /
  resource-heart / boss-den). Reuse adjacency, the ADR 0021 reachability pass, generic
  special-room sealing (ADR 0023), door-lock (ADR 0010), and the prop placer. The
  resource heart reuses the existing **boss-stair** role's stair-spawn plumbing so no new
  stair mechanism is needed.

### Follow-up session slicing (each a reviewable PR)

1. Faction data model + `FamilyMembership` + `factionRelations` + relationship system + lab.
2. `CaveSystemGenerator` + `BiomeType.CAVE_SYSTEM` + labels/roles.
3. Family-aware AI (bands, hate ramp, feud targeting, ally defend).
4. Bosses + sealed dens + seeded unlock objectives.
5. Dynamic win evaluator + resource-heart stairs.
6. Settlement + seeded shops + emergent-event quests.
7. `HudFamilyRelationships` widget + minimap territory tint + family-colored dots.
8. Floor 2 scenario wiring + Governor seed-sweep balancing (90% win-rate) + Director narration.

## Test Plan

| Concern                                                               | Planned suite (dir)                       |
| --------------------------------------------------------------------- | ----------------------------------------- |
| Band math, hate speed-ramp, `adjustFactionRelation` clamp/emit        | `tests/unit/` (relationship)              |
| Deterministic family/resource selection & unlock-objective seeding    | `tests/unit/` (floor2 selection)          |
| Win evaluator across all alive/friendly combinations                  | `tests/unit/` (win-conditions)            |
| Seeded shop-inventory generator                                       | `tests/unit/` (shop)                      |
| `families.json` / `resources.json` / packs load & Zod-validate        | `tests/unit/` (data schemas)              |
| Invariants: relation always `[0,100]`; bands monotonic; A/B exclusive | `tests/unit/` property tests (fast-check) |
| Den-unlock → boss spawn → boss-defeat → spawn-gating pipeline         | `tests/integration/`                      |
| Event → relation shift → band change → AI stance change               | `tests/integration/`                      |
| Floor-2 seed sweep **≥90% winnable**; both Win A & Win B reachable    | `tests/headless/`                         |
| Family territory sandbox snapshot + controls                          | `src/labs/` (`family-territory-lab`)      |
| Relationship HUD renders/updates; minimap territory colors            | `tests/e2e/` deterministic ui-probe       |

Invariants to keep covered: same seed ⇒ identical family/resource selection, event
timing, and AI target choices; a decapitated family never spawns again; a hate-band mob
at `r=0` never exceeds player speed; **Win A requires a single ally, Win B requires all
bosses dead**; stairs appear only after `floor2-victory` and only at the resource heart.
Build worlds with `createTestWorld({ seed })`; never construct one manually. The
win-rate gate is a **deterministic headless script** (no LLM-as-judge), and balance is
tuned to the **rate**, never to rescue specific seeds.

## Constitutional Compliance

- **P2 Lab-Gated Development:** every new system ships with a lab; a `family-territory-lab`
  exercises selection, relationships, feuding, and win conditions with a debug snapshot
  and control interface (P12). ✅
- **P3 Deterministic CI:** the 90%-win-rate seed sweep and all gates are scripts with
  exit codes — no model-as-judge. ✅
- **P4 Deterministic game logic:** selection, events, AI, and the floor timer use
  `world.rng` / `world.elapsedMs`; no `Math.random()` / `Date.now()`. ✅
- **P5 ECS–Phaser bridge:** relationships, AI, map gen, and win logic live in
  `src/core/` + `src/game/`; only the HUD widget imports Phaser in `src/engine/`. ✅
- **P6 AI content load-only:** Director/emergent narration has authored static fallbacks
  and any LLM spice is load-time with Zod validation — never in the CI path. ✅
- **P7 Memory governance:** this 2+-system change is backed by ADR 0040. ✅
- **P8 Conventional commits** for all follow-up PRs. ✅
- **P9 Coverage:** new pure logic (bands, ramp, win evaluator, shop generator, schema
  loaders) targets the core/game/shared 90% bar; the HUD widget the engine 50% bar. ✅
- **P11 Zero Cruft:** reuse Team/goal-flags/quests/door-lock/sealing/boss-stair plumbing
  instead of parallel systems; no dead scaffolding. ✅

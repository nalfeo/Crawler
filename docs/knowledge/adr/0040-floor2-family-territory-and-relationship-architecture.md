# ADR 0040: Floor 2 Family-Territory & Relationship Architecture

## Status

Proposed

> The living Floor 2 contract is tracked in
> [`.specify/specs/floor2-family-territories.md`](../../../.specify/specs/floor2-family-territories.md).
> This ADR records the architecture choices and slice boundaries behind that
> spec; read the spec first for current behavior.

## Date

2026-07-01

## Estimated Complexity

🍎🍎🍎🍎🍎 — Massive. Introduces a per-family relationship model, family-aware AI with
enemy-vs-enemy feuding, an open cave-system generator, quest-gated bosses, a dynamic
two-shape win condition, a settlement with seeded shops, and a relationship HUD. Touches
`src/core/`, `src/game/`, `src/engine/`, and `src/shared/data`, and needs new labs. Full
build is sliced across follow-up sessions; this ADR fixes the architecture so those
slices compose.

## Context

Floor 1 is a single hand-authored dungeon: one boss, a linear objective, and all enemy
AI targeting only the player. Floor 2 is the first **open, systemic** floor. Per the
design brief it must be an easy but open cave system ~25% larger than Floor 1, dominated
by large irregular caverns each owned by one of **3–4 feuding mob families** (chosen from
a roster of ≥15) that fight one another over a single contested **resource**. The player
holds a **0–100 relationship** with each family (all starting at 45) that drives whether
a family is hostile, hate-boosted, neutral, or a following ally, and **wins by reducing
the floor to a single friendly family or by killing every boss** — after which stairs
appear at the resource heart.

The authored content (families, resources, emergent events, tone) is in
`docs/knowledge/game-design/floor2-families-and-resources.md`; the system contracts and
test plan are in `.specify/specs/floor2-family-territories.md`. The open questions this
ADR settles are **where relationship state lives**, **how family-aware AI and feuding
are expressed without an O(n²) blowup**, **how much existing machinery we reuse vs.
build new**, and **how the dynamic win condition and stairs are resolved** — all under
the determinism and layer-purity constraints of the constitution.

## Decision

**D1 — Relationship state is family-level, not per-mob.** The single source of truth is
`world.factionRelations: Map<FamilyId, number>` (floor-scoped, clamped `[0,100]`). A
new lightweight tag component `FamilyMembership` stores only `familyId` and `isBoss` per
mob (typed-array stores added in `src/core/components.ts`, wired in `src/core/world.ts`).
Mobs read their family's value from the map at decision time. This avoids syncing a
relationship number across hundreds of entities and matches the family-level HUD.

**D2 — Bands and the hate speed-ramp are pure functions.** `bandFor(relation)` yields
hate `0–24` / hostile `25–49` / neutral `50–75` / friendly `76–100`. For a hate-band mob
the effective speed is `baseSpeed + (playerSpeed - baseSpeed)*(25 - r)/25`, clamped to
`[baseSpeed, playerSpeed]` — matching player speed at `r=0`, zero boost at `r→25`. These
live in `src/shared/` (or `src/core/`) as testable pure logic and drive a mutable speed
field the AI already supports.

**D3 — Families are data; selection is seeded.** `families.json` (≥15) and `resources.json`
(10–20) are Zod-validated content (the ADR 0011 pattern). The Floor 2 manifest seeds
`world.rng` (`src/shared/random.ts`) to pick 3–4 present families, one resource, one
per-family boss-den unlock objective, and the emergent-event set. No `Math.random()`.

**D4 — Reuse the existing faction/goal/quest/lock machinery.** We reuse the `TeamId`
enum and `Team` component (`src/shared/constants.ts`), `world.goalFlags`, the
data-driven quest system (`src/core/systems/questSystem.ts`), the door-lock
([ADR 0010](0010-door-lock-conditions.md)), and generic special-room perimeter sealing
([ADR 0023](0023-generic-special-room-sealing.md)) rather than building parallel
systems. Boss-defeat and den-unlock are expressed as goal flags
(`floor2-family-<id>-boss-defeated`, `floor2-den-<id>-unlocked`); the family's spawner
gates off its defeat flag.

**D5 — Family-aware AI extends the existing system with a band-keyed foe-set.** We extend
`src/game/enemyAISystem.ts` so target selection is chosen by band: hate/hostile mobs
prefer the player and fall back to rival-family mobs when the player is unreachable;
neutral mobs target only rival families; friendly mobs leash to the player and target
its attackers; trash mobs target only the player. Enemy-vs-enemy candidate lookup reuses
the spatial hash and stays inside the engagement budget
([ADR 0024](0024-floor1-spawn-density-engagement-budget.md)) — no global O(n²) scan.

**D6 — Open caverns via a new biome + generator that reuses rot-js.** A new
`BiomeType.CAVE_SYSTEM` maps (in `src/core/map/generators/registry.ts`) to a
`CaveSystemGenerator` that reuses rot-js's cellular-automata map (`ROT.Map.Cellular`,
already a project dependency) for organic caverns, then segments them into `RoomData`
regions (`src/shared/map-types.ts`) labelled territory / settlement / resource-heart /
boss-den. Reachability ([ADR 0021](0021-floor1-room-reachability-and-gate-stall-fastfail.md))
is reused. The reference size is 270×156 = 42,120 tiles (+25% vs Floor 1's 33,600). The
**resource heart reuses the existing boss-stair role's stair-spawn plumbing**, so no new
stair mechanism is added.

**D7 — Dynamic win condition is a per-floor evaluator that latches a flag.** A
`floor2ObjectiveTick` (registered as Floor 2's `floorObjectiveTick`, generalizing
`src/game/floorScenario.ts` or adding `initializeFloor2Scenario`) evaluates each tick:
**Win A** = exactly one family alive AND its relation `> 75`; **Win B** = all bosses
defeated. Either latches `floor2-victory`, which spawns the stairs at the resource-heart
tile. Relationship changes route through an `adjustFactionRelation` helper (clamp + emit
event) fed by combat, quests, and a seeded `emergentEventSystem` reading
`quests.floor2.json`.

**D8 — Settlement, shops, and HUD.** The settlement is a `RoomRole.SAFE` cavern
(`src/core/safe-space.ts` semantics) hosting a quest-giver plus 1–2 seeded shops whose
stock comes from a `generateShopInventory(rng, archetype)` generator. A new engine widget
`HudFamilyRelationships.ts` (following the `src/engine/HudUI.ts` widget pattern) renders
one row per present family — color, name, band-colored 0–100 bar, boss-alive/skull, and
allied/at-war tag — reading `world.factionRelations` and the boss goal flags.

## Consequences

### Positive

- **Determinism & testability:** bands, the speed ramp, selection, the win evaluator, and
  the shop generator are pure/seeded and unit-testable; the 90%-win-rate gate is a
  deterministic headless script.
- **Minimal new surface area:** reusing Team, goal flags, quests, door-lock, sealing, and
  boss-stair plumbing keeps the diff focused and honors Zero-Cruft.
- **Emergent gameplay:** family-level relations + always-hostile inter-family AI produce
  turf-war skirmishes and multiple valid winning strategies (ally, exterminate, betray)
  from a small amount of authored content.
- **Clean layering:** all logic stays in `src/core/`/`src/game/`; only the HUD widget
  imports Phaser in `src/engine/`.

### Negative

- **Large vertical feature:** must be sliced into ~8 follow-up PRs, each with its own lab
  and tests, to stay reviewable.
- **New generator to maintain:** `CaveSystemGenerator` adds a second map-gen path
  (mitigated by leaning on rot-js rather than hand-rolling cellular automata).
- **Balancing burden:** an open floor with feuding factions is harder to tune to "easy";
  the win-rate gate will require a Governor seed sweep.

### Risks

- **AI perf at Floor-2 counts:** enemy-vs-enemy targeting could regress frame time if it
  scans globally. _Mitigation:_ spatial-hash candidate lookup + the ADR 0024 engagement
  budget; headless perf assertions.
- **On-screen legibility:** 3–4 families + trash + player could be visually noisy.
  _Mitigation:_ per-family HUD colors, minimap territory tint, family-colored enemy dots.
- **Win-rate regressions from balance:** tuning must target the **rate**, never rescue
  specific seeds (constitution rule #13). _Mitigation:_ deterministic seed-sweep gate.
- **Scope creep in one session:** _Mitigation:_ the explicit slicing below; this ADR +
  spec are the docs-only deliverable.

## Alternatives Considered

1. **Per-mob relationship value (rejected).** Storing the relationship on each
   `FamilyMembership` entity would require broadcasting every delta to N mobs and
   complicate the HUD, which is inherently family-level. The shared map is simpler and
   cheaper.
2. **A brand-new faction/diplomacy engine (rejected).** The existing `TeamId`/`Team`,
   goal flags, and quest system already express allegiance, gating, and objectives;
   adding a parallel engine would duplicate machinery and violate Zero-Cruft.
3. **Reuse `DungeonGenerator` with oversized cave regions (rejected as primary).** It can
   carve cave pockets but is fundamentally room-and-corridor; it would not deliver the
   large irregular open caverns the brief requires. Kept only as a possible fallback.
4. **A single static win flag (rejected).** The brief demands two branching win shapes
   ("take a side" vs "declare war"); a per-tick evaluator over family alive/relation
   state is required rather than one hard-coded objective.
5. **Hand-rolled cellular automata (rejected).** rot-js already ships `ROT.Map.Cellular`;
   building CA from scratch would be redundant. Build-on-existing-dependency wins.

## References & follow-up

- **Spec:** `.specify/specs/floor2-family-territories.md`
- **Content bible:** `docs/knowledge/game-design/floor2-families-and-resources.md`
- **Reused ADRs:** [0005](0005-parameterized-floor-configuration.md),
  [0010](0010-door-lock-conditions.md), [0011](0011-data-driven-quest-system.md),
  [0021](0021-floor1-room-reachability-and-gate-stall-fastfail.md),
  [0023](0023-generic-special-room-sealing.md),
  [0024](0024-floor1-spawn-density-engagement-budget.md).
- **Follow-up slices (one reviewable PR each):** (1) faction data + `FamilyMembership` +
  `factionRelations` + relationship system + lab; (2) `CaveSystemGenerator` + biome +
  roles; (3) family-aware AI + feuding + hate ramp + ally defend; (4) bosses + sealed
  dens + seeded unlock objectives; (5) win evaluator + resource-heart stairs; (6)
  settlement + seeded shops + emergent-event quests; (7) `HudFamilyRelationships` +
  minimap territory tint; (8) scenario wiring + Governor seed-sweep balancing (90% win
  rate) + Director narration.

---

## Changelog

- **2026-07-02** — Slice 1 landed: family/resource data (Zod-validated), `FamilyMembership` component, `factionRelations` world state + helpers, `familyRelationshipSystem` wired into both real pipelines (visual bootstrap + headless simulation-step), and `family-territory-lab`. See handoff `docs/knowledge/handoffs/archive/2026-07-02-floor2-slice1-relationships.md`.

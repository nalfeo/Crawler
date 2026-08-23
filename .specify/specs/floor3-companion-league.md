# Spec: Floor 3 — Companion League

> **Status:** **In progress — slices 1–6 landed (2026-08-22).** Slice 1 (affinity matrix +
> species/style data) is implemented in `src/shared/data/floor3/`; slice 2 (the
> `AFFINITY_MATRIX` damage-multiplier hook) is implemented in `src/core/apply-damage.ts`;
> slice 3 (`Companion`/`PartySlot` + ally AI prepass) is implemented in the ECS/game AI
> pipeline; slice 4 adds the `GUARDIAN` and `SUPPORT` movement personas; slice 5 adds
> combat-XP attribution, leveling, form evolution, and ability unlocks via
> `src/core/systems/companionProgressionSystem.ts`; slice 6 adds starter/poach recruiting
> (`src/game/floor3Recruiting.ts`), `PartySlot` party-cap locking, and the KO/recovery +
> Rally Point + party-wipe predicate state machine (`src/core/systems/companionKOSystem.ts`).
> No Floor 3 manifests or sprites exist yet. The remaining schemas, wiring, and slices below
> are the **plan** the implementation
> sessions build against.
> **Authored:** 2026-07-24.
> **Estimated complexity:** 🍎🍎🍎🍎🍎 (Massive epic — spans core ECS, game systems, content,
> and 14 UX surfaces; sliced in §Epic decomposition). _This design session was 🍎🍎🍎._
> **Authored content:**
> [`docs/knowledge/game-design/floor3-companion-league.md`](../../docs/knowledge/game-design/floor3-companion-league.md)
> (fantasy, matrix, styles, progression, UX inventory, set-pieces) and
> [`docs/knowledge/game-design/floor3-pet-roster.md`](../../docs/knowledge/game-design/floor3-pet-roster.md)
> (52 species × 3 forms).
> **Architecture:**
> [ADR 0071](../../docs/knowledge/adr/0071-floor3-companion-league.md).
> **Canonical home:** this spec is the living Floor 3 contract; ADR 0071 is the architecture
> rationale.
> **Reused ADRs:** 0005 (parameterized floor config), 0010 (boss door-lock), 0011 (data-driven
> quests), 0023 (generic special-room sealing), 0024 (engagement budget / themed set-pieces),
> 0039 (every `*System` must be wired to a real pipeline), 0040 (Floor 2 open-floor +
> family-aware ally AI precedent), 0064 (cross-floor carryover precedent), 0070 (boss-chest
> lifecycle & reward policy).
> **Planned code source-of-truth (slice → files):** see §Epic decomposition — each slice names
> the files it introduces or extends.
> **Known gaps (by design, this session):** no code; the persistent-companion _consumer_ on
> Floor 4+ is out of scope (only the producer contract is defined here).

## Context

Floors 1–2 put the player in direct melee. Floor 3 **inverts the combat model**: an in-world
game-show liability gag makes the player (a "Wrangler") and all human "handlers" **invulnerable
non-combatants**. The player commands a party of up to **6 auto-battling Companions**; only
Companions (yours, trainers', and wild) can take damage. The floor is an IP-safe monster-taming
satire — **"The Companion League"** — riffing on the genre's mechanics with entirely original
creatures, affinities ("Temperaments"), and world framing. See the game-design doc for the full
fiction; this spec defines the **data schemas, runtime wiring, determinism guarantees, and the
implementation slice order**.

The two hard requirements that shape everything:

1. **Determinism.** Which Studios (gyms) and Final Four handlers appear, their lineups, and
   their order are **seeded** from the floor seed via `SeededRandom` — the same seed must
   reproduce byte-identical rosters (headless + test reproducible). Never `Math.random()` /
   `Date.now()`.
2. **Win-rate, not seeds.** Balance targets the **90%+ Floor-win** gate across a seed sweep;
   never tune to rescue specific seeds (project rule #12).

## Requirements

### R1 — Combat inversion (invulnerable player + handlers)

- The player entity and every handler entity (Trainer, Gym/Studio Leader, Final Four member)
  carry the existing `Invincible` tag, which already short-circuits `src/core/apply-damage.ts`.
  No new damage-gating code — reuse the tag.
- "Defeat handler X" is defined purely as **all of X's Companions are KO'd**, evaluated by the
  Floor 3 objective tick (R6), never by handler HP.
- Regression coverage MUST assert damage to an `Invincible` handler/player is a no-op.

### R2 — Companion entity & team model

Companions are ally-AI entities generalized from Floor 2's family-follow AI
(`FamilyAIDecision.kind === 'follow'` in `src/game/systems/familyFeudSystem.ts`). Each
Companion entity composes existing components plus new Floor-3 data:

- Reused: `Health`, `Team` (`src/core/components.ts`), position/velocity, an `AI_TYPE` persona.
- New component **`Companion`** (core): `{ speciesId, form: 0|1|2, level, xp, ownerTeam,
knockedOut: 0|1, learnedAbilityIds: number[] }`.
- New component **`PartySlot`** (core, on the player): the ordered party (max 6) + lock flag.

`Team` tags separate the player's party, each handler's stable, and wild spawns so ally AI
targets correctly and friendly fire is impossible within a team.

### R3 — Species, affinity & style schemas

```ts
// src/shared/data/floor3/ — new data + types (schema shown; tuning is a slice)
type Affinity = 'ember' | 'bloom' | 'stone' | 'gale' | 'tide' | 'gloom' | 'lumen';
type FightingStyle =
  | 'charger'
  | 'bruiser'
  | 'slinger'
  | 'burster'
  | 'pouncer'
  | 'warden'
  | 'kindler';

interface PetFormDef {
  form: 0 | 1 | 2; // baby | adolescent | adult
  name: string; // original portmanteau (roster doc)
  minLevel: number; // 1 | 10 | 25
  statScale: number; // multiplier over the style's base archetype
}

interface PetSpeciesDef {
  speciesId: string; // stable key; names are freely renameable
  affinity: Affinity;
  fightingStyle: FightingStyle; // selects the reusable AI persona (R4)
  forms: [PetFormDef, PetFormDef, PetFormDef];
  abilityIdsByLevel: Record<1 | 8 | 16 | 25 | 34, string>;
  signature?: boolean; // off-grid rares (roster §4)
}

// Effectiveness matrix — complete, every ordered pair defined (game-design §4.1).
// 2-regular ring: each affinity beats the NEXT 2, resists PREVIOUS 2, neutral to the rest.
type Multiplier = 0.5 | 1 | 2;
const AFFINITY_MATRIX: Record<Affinity, Record<Affinity, Multiplier>>; // fully populated
```

- Roster = **49 grid species (7×7) + 3 signature = 52**, each with 3 forms. Enumerated in the
  roster doc; this slice transcribes it to data with stable `speciesId`s.
- `AFFINITY_MATRIX` is a pure lookup consumed by `apply-damage` (a Floor-3 damage-multiplier
  hook), fully unit-tested for the 2-regular property (each row: two `2`s, two `0.5`s, three
  `1`s including self).

### R4 — Fighting-style personas (bounded AI set)

- 7 styles = 7 reusable AI personas. **5 seed the existing `AI_TYPE`** enum
  (`{ CHASE, SWARM, RANGED, LEAPER }` at line 37 of `src/game/enemyAISystem.ts`): Charger→CHASE
  (fast params), Bruiser→CHASE (heavy params), Slinger→RANGED, Burster→RANGED (AoE params),
  Pouncer→LEAPER. **2 are net-new personas: `GUARDIAN` (Warden) and `SUPPORT` (Kindler)** —
  added to `AI_TYPE` and given behavior in the AI system.
- A `StylePersona` registry maps `FightingStyle → { aiType, rangeProfile, cadence,
hpProfile, dmgProfile, aoeShape? }`. Numbers scale by form; the persona is **constant across
  a species line**.
- Each net-new persona (`GUARDIAN`, `SUPPORT`) is a slice with **its own lab** and MUST be
  wired into the real AI pipeline (`src/game/enemyAISystem.ts` → the simulation step), per
  ADR 0039. Lab-only validation is insufficient (project rule #9/#14).

### R5 — Recruiting, party-lock, KO & lose

- **Starter:** offer 4 random species (seeded); player picks 1. Signature starter (Volcanix
  line) may seed into the offer pool.
- **Trainer poach:** on KO'ing all a Trainer's Companions, offer that Trainer's 2–3 Companions;
  player takes 1. Party fills to `starter + 5 = 6`, then **locks** (5th-pick warning UX). Wild
  creatures are **never** recruitable.
- **KO/recovery:** a Companion at 0 HP sets `knockedOut = 1` (down for the current engagement,
  not dead); it recovers when the engagement ends or instantly at a **Rally Point**.
- **Lose:** all party Companions `knockedOut` **simultaneously** → floor loss. The objective
  tick evaluates this each frame.

### R6 — Win/lose wiring

- New `floor3ObjectiveTick(world)` (mirrors `floor2ObjectiveTick` in `src/game/floor2Scenario.ts`)
  drives `world.goalFlags`:
  - increments a **Studios-defeated** counter (0→6) as each Studio's Companions are all KO'd;
  - opens the **Final Four** gate (sealed-den/door-lock reuse, ADR 0010/0023) when the counter
    reaches 6;
  - sets **win** when the Final Four is defeated; sets **lose** on simultaneous party wipe (R5).
- Studios are any-order **soft-gated** (each requires the player's party to meet a floor-level
  threshold, not a fixed sequence).

### R7 — Two-track progression + kept companion

- **Persistent player track:** defeated wild/trainer/Studio Companions drop **XP gems, gold,
  loot** exactly like other floors; the invulnerable player collects them via the existing
  `src/core/systems/itemPickupSystem.ts` → `world.playerLevel.xp` (+ gem magnet) /
  `world.playerGold` / `Inventory`. Spawns reuse `src/core/spawners/pickups.ts`
  (`spawnXpGem`/`spawnGold`/`spawnDroppedItem`). This is the **only** persistent currency — no
  throwaway per-floor resource. Player level also powers Floor-3 command capacity.
- **Floor-scoped creature track:** each Companion levels from **combat it performs**
  (damage-weighted, with a small assist floor for the whole party) on its own `xpMath` curve
  (`src/shared/xpMath.ts`, driven by `XP.*` in `src/shared/constants.ts`), driving evolution
  (R3 forms) and ability milestones. The party does **not** carry over.
- **Kept companion (cross-floor):** on win, the player picks **ONE** Companion to keep, carried
  at **adult form** via a persistence contract on the floor-transition carryover channel
  (precedent ADR 0064):

```ts
interface KeptCompanionContract {
  speciesId: string;
  affinity: Affinity;
  fightingStyle: FightingStyle;
  form: 2; // always adult / final evolution
  levelBand: 'floor3-graduate';
  learnedAbilityIds: string[];
}
```

Floor 4+ **consumes** this contract to re-host the companion; building that consumer is
**out of scope** for the Floor 3 epic (only the producer is defined here).

### R8 — Determinism & test plan

- All seeded selection (starter offer, Trainer lineups, the 6-of-~10 Studio pick, the
  4-of-~7 Final Four pick, lineups, order) uses `SeededRandom` keyed to the floor seed.
- **Hard test target:** a headless test asserts **same seed ⇒ identical** Studio set, Final
  Four set, lineups, and order (serialize the selected roster and compare).
- Unit tests: `AFFINITY_MATRIX` 2-regular property; `xpMath` evolution thresholds (L10/L25) and
  ability milestones (L1/8/16/25/34); KO/recovery state machine; simultaneous-wipe lose
  predicate; `Invincible` no-op on handlers (R1).
- Headless win-rate sweep: **≥90%** of Floor 3 seeds reach a win with reasonable play (project
  rule #12) — the gate, run on GitHub infra for broad sweeps (>10 runs).
- Every new `*System` gets a lab in `src/labs/` **and** real-pipeline wiring, verified by
  `npm run check:wired-systems` (ADR 0039).

### R9 — Systems touched (handoff slugs)

`enemies`, `ai-behavior-tree`, `mapgen`, `hud-ux`, `inventory`, `boss-rooms`, `quests`.

## Epic decomposition (ordered, apple-estimated slices)

Each slice ends with its own PR + review ledger (apple-scaled) + handoff. Slices with a new
`*System` require a lab **and** real-pipeline wiring (ADR 0039). Dependencies noted as `after:`.

| #     | Slice                                                                      | 🍎          | Introduces / extends                                                                                                                                                                                                                | Deps      |
| ----- | -------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1     | **Affinity matrix + species/style data** ✅ _landed 2026-08-16_            | 🍎🍎        | `src/shared/data/floor3/` species defs, `AFFINITY_MATRIX`, `StylePersona` registry, matrix unit tests                                                                                                                               | —         |
| 2     | **Damage multiplier hook** ✅ _landed 2026-08-17_                          | 🍎🍎        | affinity multiplier in the `apply-damage` path + tests                                                                                                                                                                              | after 1   |
| 3     | **Companion entity + ally AI generalization** ✅ _landed 2026-08-21_       | 🍎🍎🍎      | `Companion`/`PartySlot` components, team-tagged ally AI from Floor 2 follow-AI, companion lab                                                                                                                                       | after 1   |
| 4     | **Two net-new AI personas** (`GUARDIAN`, `SUPPORT`) ✅ _landed 2026-08-21_ | 🍎🍎🍎      | `AI_TYPE` additions + deterministic Guardian/Support movement behavior in `enemyAISystem.ts`, companion lab pipeline observation                                                                                                    | after 3   |
| 5     | **Per-creature leveling + evolution + abilities** ✅ _landed 2026-08-22_   | 🍎🍎🍎      | combat-XP attribution, `xpMath` reuse, form transitions, ability unlocks, lab                                                                                                                                                       | after 3   |
| 6     | **Recruiting, party-lock, KO/recovery, lose**                              | 🍎🍎🍎      | starter/poach flow, `PartySlot` lock, KO state machine, Rally Points, wipe predicate, lab                                                                                                                                           | after 3   |
| 7     | **Overworld + biomes + wild spawns**                                       | 🍎🍎🍎      | Floor-3 map generator w/ 7 biome regions, affinity-weighted wild spawns, floor3 manifest                                                                                                                                            | after 1   |
| 8     | **Studios + Final Four + seeded variety + objective tick**                 | 🍎🍎🍎🍎    | `TrainerDef`/`StudioDef`/`FinalFourDef`, candidate pools, `SeededRandom` selection, `floor3ObjectiveTick`, sealed dens, determinism test                                                                                            | after 6,7 |
| 9     | **Set-pieces** (6 Studio dens + Final Four arena)                          | 🍎🍎        | `set-pieces.json` entries, set-piece-lab validation                                                                                                                                                                                 | after 7   |
| 10    | **Persistent player track wiring**                                         | 🍎🍎        | route gems/gold/loot → `world.playerLevel`/gold/inventory on Floor 3                                                                                                                                                                | after 3   |
| 11    | **Kept-companion persistence contract (producer)**                         | 🍎🍎        | `KeptCompanionContract` on the carryover channel + end-of-floor picker hook                                                                                                                                                         | after 5,8 |
| 12–14 | **UX surfaces** (see game-design §15 — 14 screens grouped into ~3 slices)  | 🍎🍎🍎 each | intro, starter/poach pickers, party HUD, roster/detail, level-up/evolution, ability command, matchup indicator, versus intros, win/lose, overworld markers, keep-companion picker — each reuses an existing UI pattern + gets a lab | after 6,8 |
| 15    | **Sprites** (156 forms)                                                    | 🍎🍎🍎🍎    | asset-pipeline generation of all species forms                                                                                                                                                                                      | after 1   |
| 16    | **Balance + win-rate gate**                                                | 🍎🍎🍎      | headless sweep to ≥90% win-rate, tuning without seed cherry-picking                                                                                                                                                                 | after all |

## Cross-references

- **Fiction, matrix, styles, progression, UX, set-pieces:**
  [`docs/knowledge/game-design/floor3-companion-league.md`](../../docs/knowledge/game-design/floor3-companion-league.md)
- **Full roster:**
  [`docs/knowledge/game-design/floor3-pet-roster.md`](../../docs/knowledge/game-design/floor3-pet-roster.md)
- **Architecture:** [ADR 0071](../../docs/knowledge/adr/0071-floor3-companion-league.md)

# ADR 0071: Floor 3 — Companion League (commander / auto-battler floor)

## Status

Proposed

## Date

2026-07-24

## Estimated Complexity

🍎 x 5 (the full Floor 3 epic) — this ADR records the cross-system architecture for a
floor that inverts the combat model, adds a team-tagged ally roster with per-entity
leveling/evolution, an original elemental type-effectiveness system, seeded boss variety,
and a cross-floor persistent-companion slot. The **design session** that authored this ADR
plus the game-design/roster docs and spec is scoped at 🍎 x 3 (docs-only). Every runtime
slice is decomposed in [`.specify/specs/floor3-companion-league.md`](../../../.specify/specs/floor3-companion-league.md).

## Context

Floors 1 and 2 are direct-combat floors: the player swings weapons, takes damage, and can
die. We want Floor 3 to be a **mechanically distinct** floor that reuses as much existing
tech as possible while giving the run a fresh verb. The intake brief (an IP-safe
monster-taming satire) fixes several hard constraints that each touch 2+ systems and
therefore need a durable decision record:

1. **The player and all human "handlers" cannot be attacked or take damage.** Only creatures
   (the player's, the handlers', and wild ones) are damageable. This inverts the entire
   combat/threat model relative to Floors 1–2.
2. **The player commands auto-battling creatures ("Companions") instead of fighting.** This
   is the Floor 2 friendly-family ally AI generalized into a first-class ally roster.
3. **The player must still get persistently stronger for Floor 4+,** even though they never
   deal damage and the Companion party does **not** carry over. Progression must therefore
   split into a persistent player track and a floor-scoped creature track.
4. **A single kept Companion carries forward** to future floors at its final form, so the
   pet concept continues beyond Floor 3 — a new cross-floor carryover slot.
5. **An original elemental type-effectiveness system** drives recruiting and combat reads.
   The creatures, names, affinities, and world framing are entirely original; only
   non-copyrightable mechanics (type charts, evolution stages, gyms, party battles) are
   borrowed.
6. **Bosses are seeded, not fixed** — Gym Leaders and the Final Four are drawn/varied from a
   larger candidate pool per `SeededRandom`, and must stay deterministic per seed for
   headless reproduction.

Doing this ad hoc across the map, AI, progression, HUD, and carryover systems would produce
an inconsistent contract. This ADR locks the shared architecture; the game-design doc and
spec elaborate content and schemas.

## Decision

### D1 — Combat inversion via the existing `Invincible` tag

The player entity and every human handler entity (roaming trainers, Gym Leaders, Final Four
members) carry the existing `Invincible` component (`src/core/components.ts`), which already
short-circuits `applyDamage()` in `src/core/apply-damage.ts`. No new "invulnerability" system
is introduced. "Defeating" a handler is redefined as **knocking out every Companion that
handler fields** — a win condition on the handler's creature set, not on the handler's HP.

### D2 — Companions are a team-tagged ally roster generalized from Floor 2 ally AI

Companions reuse the Floor 2 friendly-family ally behavior (`FamilyAIDecision.kind ===
'follow'` in `src/game/systems/familyFeudSystem.ts` + `src/game/enemyAISystem.ts`): follow
the player, engage nearby hostiles, never target the player. We generalize the family-scoped
ally logic into a **team-tagged** ally model using the existing `Team` component so that
"the player's Companions", "a handler's Companions", and "wild creatures" are all the same
entity archetype distinguished only by team + control flags. Wild creatures and handler
creatures are hostile to the player's team; the player's Companions are friendly.

### D3 — A species is defined by two axes: **affinity × fighting style**

Every creature species has exactly one **affinity** (one of 7 original elements) and one
**fighting style** drawn from a **small fixed set** (7 styles). Crucially, **each fighting
style IS a reusable AI persona** — a parameterization of the enemy AI kernel — shared by
every species that uses it. The existing `AI_TYPE` enum (`{ CHASE, SWARM, RANGED, LEAPER }`
in `src/game/enemyAISystem.ts`) is the seed set; the style catalog extends it with a bounded
number of new personas (notably a Guardian/taunt persona and a Support persona). This keeps
50+ species running on ~7 personas rather than 50 bespoke AIs. Fighting style is a
species-line trait: it is constant across a creature's three forms; only the numbers scale.

### D4 — Per-creature leveling and 3-stage evolution, reusing `xpMath`

Each creature levels on its own curve using the existing pure helpers in
`src/shared/xpMath.ts` (`levelForXp` / `xpThresholdForLevel`, driven by `XP.BASE_PER_LEVEL` /
`XP.SCALING_FACTOR`). Creatures evolve through **baby → adolescent → adult** at fixed
milestone levels and **learn abilities at milestone levels**. Creature XP comes from
**combat the creature performs** (damage-weighted credit for enemies it helps defeat), which
is a separate channel from the player's XP (see D5).

### D5 — Two-track progression: persistent player, floor-scoped creatures

This is the central progression decision.

- **Persistent player track (carries to Floor 4+):** Defeated wild/handler creatures drop
  **XP gems, gold, and loot/crafting materials** exactly as on other floors. The invulnerable
  player collects them via the existing `itemPickupSystem` (`src/core/systems/itemPickupSystem.ts`)
  → `world.playerLevel.xp` (plus gem magnet), `world.playerGold`, and Inventory. The player's
  normal cross-floor character level and gear therefore grow on Floor 3 just like every other
  floor, so the player is genuinely stronger going into Floor 4+. Vacuuming gems by
  positioning is the core commander verb. **No throwaway per-floor currency.**
- **Floor-scoped creature track (does NOT carry over):** Creatures level from combat (D4) →
  evolution + ability milestones. The party is discarded at floor end except for the single
  kept Companion (D6).

Clean split: **gems → player (persistent); combat → creatures (floor-scoped).**

### D6 — One kept Companion persists cross-floor

On completing Floor 3 the player chooses **one** party Companion to keep. It carries forward
at its **ultimate (adult / final-evolution) form** as a permanent ally on later floors. This
ADR defines the **persistence contract** — the carried record is
`{ speciesId, affinity, fightingStyle, form: 'adult', levelBand, learnedAbilities }`, stored
in the same in-process floor-transition carryover channel used for generated-equipment
carryover (see [`0064-data-driven-boss-ability-catalog.md`](0064-data-driven-boss-ability-catalog.md)
for the carryover-authority precedent and the floor-transition carryover pattern). Later
floors re-host that record as a friendly team-tagged ally (D2). This ADR does **not** build
Floor 4 or the future-floor hosting itself.

### D7 — Party-lock recruiting; wild creatures are not recruitable

The player starts by picking **1 of a random starter set**. Defeating a **roaming trainer
elite** lets the player recruit **1 of that trainer's creatures**. The party fills to
**6 (starter + 5 recruits) and then locks** — no swapping, no further recruiting. **Wild
creatures are never recruitable** (recruiting is trainer-only — the deliberate anti-capture
twist). After lock, trainer wins yield only loot/XP.

### D8 — Lose = simultaneous full-party wipe; KO is recoverable

A creature at 0 HP is **knocked out (downed) for the current engagement**, not dead. KO'd
creatures **recover** out of combat (fully restored when the active engagement ends, or
instantly at a Rally Point). **The floor is lost only if all 6 party creatures are KO'd at
the same time** during a single sustained engagement.

### D9 — Win = 6 Gym Leaders then the Final Four, with seeded variety

The floor is won by defeating the **6 Gym Leaders** (each behind a sealed den unlocked by
objectives, reusing the Floor 2 sealed-den/door-lock tech and `world.goalFlags`) and then the
**Final Four** gauntlet (unlocked after all 6 gyms fall). Which leaders/finalists appear,
their affinity identities, their creature lineups, and their order are **drawn from a larger
candidate pool by `SeededRandom`** so runs differ, while staying **deterministic per seed**
(headless runs and tests reproduce a seed exactly). The candidate pool is authored larger
than 6 gyms / 4 finalists.

## Consequences

### Positive

- Reuses existing tech at every seam (`Invincible`, Floor 2 ally AI, `AI_TYPE`, `xpMath`,
  `itemPickupSystem`, sealed dens, set-pieces, `mob-abilities/`), minimizing net-new systems.
- The player's persistent progression stays on the **same** cross-floor rails as other
  floors, so Floor 3 does not fork the character-growth economy.
- ~7 reusable AI personas cover 50+ species, bounding AI complexity.
- Seeded boss variety materially increases replayability without per-run authoring.
- Fully original IP; only non-copyrightable mechanics are borrowed.

### Negative

- Net-new UX surface is large (14 screens/flows inventoried in the game-design doc); each
  needs its own lab per the lab-gate rule, so the epic is UX-heavy.
- The affinity × style grid plus 3-form evolution is a lot of authored content (150+ named
  forms, abilities, stat archetypes) even though the mechanics are bounded.
- A new cross-floor carryover slot adds surface area to floor-transition state that must be
  versioned and tested.

### Risks

- **Determinism of seeded boss selection.** All selection must go through `SeededRandom`;
  any stray `Math.random()`/`Date.now()` would break headless reproduction. Mitigation:
  determinism tests assert same-seed → same roster (spec test plan).
- **Win-rate gate.** The 90%+ Floor-win target still applies. An auto-battler with type
  effectiveness can produce degenerate hard-counter losses if recruiting offers no coverage.
  Mitigation: starter/recruit offers must guarantee reachable type coverage; balance is a
  downstream sweep, not resolved in the design docs.
- **KO-recovery tuning.** If recovery is too generous the floor is trivial; too stingy and a
  single bad engagement wipes the locked party with no recourse. Mitigation: Rally Points +
  out-of-combat recovery model, tuned by sweep.
- **Wiring rule (ADR 0039).** Every new `*System` must be wired into a real pipeline, not
  just a lab. The spec's epic decomposition calls this out per slice.

## Alternatives Considered

- **A capture/collection mechanic (catch wild creatures).** Rejected per intake: recruiting
  is trainer-only, which is the intended anti-capture twist and keeps wild creatures as a
  pure combat/XP treadmill. It also sidesteps the closest-to-IP mechanic.
- **Swappable / unbounded party.** Rejected: a fixed locked party of 6 makes the
  simultaneous-wipe lose condition legible and bounds the party-HUD and AI cost.
- **A throwaway per-floor "trainer level" currency for player progression.** Rejected in
  favor of routing gems/gold/loot into the **existing** persistent player level + gear, so
  Floor 3 growth is real cross-floor progress (D5) rather than a dead-end stat.
- **Carrying the whole party forward.** Rejected: too strong and it would make Floor 4+
  balance depend on Floor 3 party composition. One ultimate-form companion (D6) continues the
  concept without ballooning power.
- **Fixed, hand-authored bosses each run.** Rejected in favor of seeded variety (D9) for
  replayability; fixed bosses would make repeat runs identical.
- **A bespoke AI per species.** Rejected: 50+ AIs is unmaintainable. Styles-as-personas (D3)
  reuses a bounded set.

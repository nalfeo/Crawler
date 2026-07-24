# Floor 3 — Companion League & Content Bible

> **Season episode:** _"Fur, Fangs & Fame"_ (working title). Floor 3 is a **monster-taming
> game-show** floor. The dungeon's producers have franchised the season into a televised
> creature-battling circuit: contestants — **Wranglers** — are contractually **barred from
> throwing a punch on camera** (network liability gag), so they command sponsored auto-battling
> creatures called **Companions** instead. Win the circuit by toppling **6 sponsor Studios**
> (gyms) and the network's **Final Four** championship board. The Director: _"They said a
> reality show couldn't do wholesome family creature-combat. We proved them half right."_
>
> This is the **authored content** reference (Content Designer + Story Designer layers). The
> **system contracts** live in
> [`.specify/specs/floor3-companion-league.md`](../../../.specify/specs/floor3-companion-league.md);
> the **architecture decision** lives in
> [ADR 0071](../adr/0071-floor3-companion-league.md); the **full creature enumeration**
> (≥50 species × 3 forms) lives in
> [`floor3-pet-roster.md`](floor3-pet-roster.md). Tone must stay consistent with the
> [Lore Bible](lore-bible.md): dark comedy, never grimdark; the horror is bureaucratic;
> the "wholesome pet show" veneer is played for absurd corporate-satire laughs.

---

## 1. The Fantasy (player-facing pitch)

You step onto a garish soundstage carved into the dungeon's third stratum. A grinning host
explains the rules over a laugh track: **you don't fight — your Companions do.** You pick a
starter creature from a lineup, march into a sprawling wilds broken into themed **biomes**,
and let your Companion tear into **wild creatures** for experience. Scattered across the map
are rival **Trainers**; beat a Trainer's Companions and you get to **poach one of theirs** for
your own team. Do that five times and your **team of six locks in** for the season.

Then you climb the ladder: **6 sponsor Studios**, each run by a washed-up celebrity handler
with a themed roster, sealed behind a locked den. Topple all six and the **Final Four** — the
network's championship board — opens. Beat them and you're **Best in Show.**

The twist on the genre: **there is no capture ball.** You can't tame the wilds; the only way
to grow your team is to **take creatures from the people who wronged you** (well, who beat you
in a sanctioned exhibition match). And your creatures are **yours for this season only** —
when the credits roll you keep exactly **one**, evolved to its ultimate form, to carry into
the seasons ahead.

---

## 2. The satirical frame (IP-safe)

Everything below is **entirely original**. Only non-copyrightable **mechanics** (elemental
type effectiveness, three-stage evolution, gym-style skill gates, party battles) are borrowed
from the monster-taming genre at large — no creatures, names, affinities, art, or world
framing are drawn from any existing property.

- **The show:** the season's producers pivot the dungeon into _The Companion League_, a
  franchised creature-battling reality circuit with sponsors, studios, and a championship.
- **Wranglers (the player):** contestants forbidden from on-camera violence "for insurance
  reasons." This is the in-world reason the player is **invulnerable and non-combatant**.
- **Companions (the creatures):** sponsored, merchandised auto-battlers. Wild ones are
  "unsigned talent." Trainers' Companions are "poachable free agents" the moment their handler
  loses an exhibition.
- **Studios (the 6 gyms):** themed sponsor sound-stages run by has-been celebrity handlers
  (e.g., a burnt-out stunt double, a disgraced weather anchor, a former child star). Each is a
  sealed **den** with an affinity motif.
- **The Final Four:** the network's championship board — four executives-turned-champions who
  guard the title. Beat them to win the season.
- **Temperaments (the affinities):** the show's marketing brands the seven elemental
  affinities as **"Temperaments."** Mechanically they are a standard type chart (§4).

---

## 3. Core loop — the commander / auto-battler verb

Floor 3 replaces the swing-a-weapon verb with a **positioning + command** verb.

1. **Your Companions auto-battle.** They follow you, engage nearby hostiles, and never target
   you or other Wranglers. (This is the Floor 2 friendly-family ally AI generalized to a
   team-tagged roster — see ADR 0071 D2.)
2. **You position.** Where you stand pulls your team's engagement; you kite fights toward or
   away from clusters, funnel enemies, and vacuum the **XP gems / gold / loot** that defeated
   creatures drop (your persistent progression — §9).
3. **You command abilities.** Your Companions' abilities fire on cooldown automatically, but
   you can **trigger** a Companion's signature ability manually for burst timing (the
   "commander" verb). Ability command capacity scales with your **player level** (§9).
4. **You read the type game.** Every creature has a **Temperament (affinity)** and a
   **fighting style**; matchups decide fights (§4–§5). Recruiting to cover your weaknesses is
   the core strategic decision (§6).

The floor is a loop of **explore biome → fight wilds for creature XP + player loot → find a
Trainer → poach a creature → shore up coverage → unlock and clear a Studio.** Repeat until the
Final Four opens.

---

## 4. Temperaments — the affinity system & effectiveness matrix

Seven original affinities, each anchored to a biome (§8):

| Affinity  | Flavor                            | Home biome           |
| --------- | --------------------------------- | -------------------- |
| **Ember** | heat, ash, forge-fire             | Cinder Barrens       |
| **Bloom** | overgrowth, spores, fast-root     | Verdant Snarl        |
| **Stone** | rock, grit, tremor                | The Quarryworks      |
| **Gale**  | wind, squall, static              | Skirling Heights     |
| **Tide**  | water, brine, flood               | Sump Shallows        |
| **Gloom** | shadow, rot, murk                 | The Murkwood         |
| **Lumen** | light, glare, radiance            | Glare Flats          |

### 4.1 Effectiveness matrix (complete, every pair defined)

The chart is a **balanced 2-regular ring**: each affinity is **super-effective (×2) against
exactly 2**, **not-very-effective (×0.5) against exactly 2**, and **neutral (×1) against the
remaining 2** plus itself. There are **no dead types** — every Temperament has exactly two
prey and two predators. The ring order is **Ember → Bloom → Stone → Gale → Tide → Gloom →
Lumen → (Ember)**; each affinity beats the **next two** clockwise and resists the **previous
two**.

Read as **row attacks column.** `⊕` = ×2, `·` = ×1, `⊖` = ×0.5, `—` = self (×1).

| Atk ↓ \ Def → | Ember | Bloom | Stone | Gale | Tide | Gloom | Lumen |
| ------------- | :---: | :---: | :---: | :--: | :--: | :---: | :---: |
| **Ember**     |   —   |   ⊕   |   ⊕   |  ·   |  ·   |   ⊖   |   ⊖   |
| **Bloom**     |   ⊖   |   —   |   ⊕   |  ⊕   |  ·   |   ·   |   ⊖   |
| **Stone**     |   ⊖   |   ⊖   |   —   |  ⊕   |  ⊕   |   ·   |   ·   |
| **Gale**      |   ·   |   ⊖   |   ⊖   |  —   |  ⊕   |   ⊕   |   ·   |
| **Tide**      |   ·   |   ·   |   ⊖   |  ⊖   |  —   |   ⊕   |   ⊕   |
| **Gloom**     |   ⊕   |   ·   |   ·   |  ⊖   |  ⊖   |   —   |   ⊕   |
| **Lumen**     |   ⊕   |   ⊕   |   ·   |  ·   |  ⊖   |   ⊖   |   —   |

**Per-affinity summary** (strong vs / weak vs):

- **Ember** — strong vs Bloom, Stone · weak vs Gloom, Lumen
- **Bloom** — strong vs Stone, Gale · weak vs Ember, Lumen
- **Stone** — strong vs Gale, Tide · weak vs Ember, Bloom
- **Gale** — strong vs Tide, Gloom · weak vs Bloom, Stone
- **Tide** — strong vs Gloom, Lumen · weak vs Stone, Gale
- **Gloom** — strong vs Lumen, Ember · weak vs Gale, Tide
- **Lumen** — strong vs Ember, Bloom · weak vs Tide, Gloom

The chart is deliberately **original, not the canonical fire/water/plant triangle** — both for
IP distinctness and because the ring structure guarantees perfect balance (no affinity is
strictly dominated, so recruiting always has a meaningful coverage answer). Final numeric
multipliers may be tuned in the balance sweep, but the ⊕/·/⊖ **relationships are fixed by this
matrix.**

---

## 5. Fighting styles — the reusable AI-persona catalog

Every species also has one **fighting style** drawn from a fixed set of **seven**. Crucially,
**each style IS a reusable AI persona** shared by every species that uses it (ADR 0071 D3), so
50+ species run on ~7 behaviors. Styles seed/extend the existing `AI_TYPE` enum
(`{ CHASE, SWARM, RANGED, LEAPER }` in `src/game/enemyAISystem.ts`). Style is a **species-line
trait**: constant across a creature's three forms; only the numbers scale.

| Style        | Role                | Behavior (persona)                                                | HP  | DMG      | SPD  | Range      | Seeds `AI_TYPE`          |
| ------------ | ------------------- | ----------------------------------------------------------------- | --- | -------- | ---- | ---------- | ------------------------ |
| **Charger**  | fast melee harasser | rush nearest hostile, light fast hits, reposition                 | Low-Med | Med  | High | Melee      | `CHASE` (fast params)    |
| **Bruiser**  | heavy melee anchor  | slow advance, heavy slow hits, holds the line                     | High | High    | Low  | Melee      | `CHASE` (slow/heavy)     |
| **Slinger**  | ranged skirmisher   | keep distance, fire single-target shots, kite when approached     | Low | Med      | Med  | Long       | `RANGED`                 |
| **Burster**  | AoE crowd-clear     | lob area attacks at clusters, slow cadence, avoid melee           | Low-Med | High (AoE) | Low | Medium | `RANGED` (AoE payload)   |
| **Pouncer**  | ambush assassin     | hold, leap in for a burst on a priority target, retreat           | Med | High (burst) | High (burst) | Gap-close | `LEAPER`      |
| **Warden**   | guardian / tank     | position between allies and hostiles, draw aggro (taunt), low dmg | Very High | Low | Low | Melee    | **new `GUARDIAN`**       |
| **Kindler**  | support             | stay back, heal / buff allies, minimal direct attack              | Med | Very Low | Med  | Medium     | **new `SUPPORT`**        |

Only two genuinely new personas (**Guardian** taunt/protect, **Support** heal/buff) are added
to `AI_TYPE`; Charger/Bruiser are parameterizations of `CHASE`, Slinger/Burster of `RANGED`,
Pouncer of `LEAPER`. Each style's per-form numbers scale on evolution (baby → adolescent →
adult) but the persona and role never change, so a player who learns "Wardens soak, Kindlers
heal, Bursters clear swarms" reads it across the whole roster.

### 5.1 How the two axes combine

A species = **one affinity × one style**. The affinity decides _what it's good/bad against_
(§4); the style decides _how it fights_ (§5). E.g., an **Ember Burster** clears Bloom/Stone
swarms with fire AoE but folds to a Lumen threat; a **Tide Warden** is an unkillable frontline
that walls Gloom/Lumen attackers. The roster (§ roster doc) is laid out as a **7 affinity × 7
style grid** (49 base cells) plus 3 signature species (§ roster doc §5), for **52 species**.

---

## 6. Recruiting, starters & party-lock

### 6.1 Starter selection

On arrival you're offered **4 random starter Companions** (drawn to span distinct affinities
and styles so the offer is never all one Temperament). You pick **1**. The offer shows each
candidate's **affinity, style, and starting abilities**. (UX screen #2.)

### 6.2 Poaching from Trainers (the anti-capture twist)

- **Roaming Trainers** wander the biomes, each fielding **2–3 Companions** (levels scale with
  biome depth). Defeating a Trainer = **KO all of that Trainer's Companions** (the Trainer is
  invulnerable — ADR 0071 D1).
- On victory, you **choose 1 of that Trainer's Companions** to poach onto your team. The
  picker shows affinity/style/level and your **remaining recruit slots** (UX screen #3).
- **Wild creatures are never recruitable** — poaching is Trainer-only. Wild creatures exist
  purely as combat + XP + loot fodder (§7).

### 6.3 Party-lock

Your team is **starter + up to 5 poached = 6 Companions, then locked.** The **5th poach shows
a lock warning** ("This signs your roster for the season — no more recruiting"). After the
lock, defeating Trainers yields **loot + XP only.** No swapping, no releasing, no benching —
all six are active combatants and the locked composition is what you take to the Studios.

This makes the **coverage decision permanent and weighty**: you're drafting a six-creature
team that must answer all seven Temperaments across the Studios and Final Four.

---

## 7. Wild creatures & biomes

- **Wild creatures** spawn in the **7 biome regions** (§8), **affinity-affinitized** to their
  biome (Cinder Barrens spawns mostly Ember, etc., with a minority of neutrals for variety).
- They are drawn from the **same species pool** as everything else (untamed forms), so the
  roster is fully reused across party / Trainer / Studio / wild (ADR 0071 D3).
- They provide the **combat treadmill**: swarm content that levels your Companions and drops
  the player's XP gems / gold / loot. **Not recruitable** (§6.2).
- Biome affinity telegraphs the type game: entering the Murkwood, you know Gloom is thick —
  bring an Ember or Gale answer.

---

## 8. Floor layout — the free-roam overworld

One large explorable map (reusing the Floor 2 cave-system / open generator and sealed-den
tech) partitioned into **7 biome regions**, one per affinity:

| Biome              | Affinity | Character                                       |
| ------------------ | -------- | ----------------------------------------------- |
| **Cinder Barrens** | Ember    | cracked volcanic flats, ash drifts, forge ruins |
| **Verdant Snarl**  | Bloom    | overgrown ruins, choking vines, spore clouds    |
| **The Quarryworks**| Stone    | broken quarry, rockfalls, tremor lanes          |
| **Skirling Heights**| Gale    | windswept cliffs, updrafts, static storms       |
| **Sump Shallows**  | Tide     | flooded wetlands, tidal channels, brine pools   |
| **The Murkwood**   | Gloom    | fungal shadow-forest, low light, rot            |
| **Glare Flats**    | Lumen    | blinding salt/crystal flats, mirror glare       |

- **Roaming Trainers** are scattered across biomes for poaching.
- **6 Studio dens** are sealed (door-lock tech + `world.goalFlags`), each with an **affinity
  motif**, unlocked by objectives (e.g., reach the den **and** have recruited ≥N Companions /
  cleared ≥N Trainers in that region).
- The **Final Four gate** is a sealed championship stage that opens only after **all 6 Studios
  fall.**
- **Rally Points** — scattered safe nodes where KO'd Companions instantly recover (§ KO model).

---

## 9. Progression — two tracks + the kept companion

This is the heart of the floor's design (ADR 0071 D5–D6).

### 9.1 Persistent player track (carries to Floor 4+)

The player advances **exactly like every other floor**, just earned by commanding rather than
fighting:

- Defeated wild / Trainer / Studio creatures drop **XP gems, gold, and loot/crafting
  materials**, collected by the invulnerable player via the existing `itemPickupSystem`
  (`src/core/systems/itemPickupSystem.ts`) → `world.playerLevel.xp` (+ gem magnet),
  `world.playerGold`, and Inventory.
- This feeds the player's **normal cross-floor character level + gear**, so the player is
  **genuinely stronger going into Floor 4+.** No throwaway per-floor currency.
- On Floor 3 the player's level also powers **command capability** (e.g., simultaneous ability
  triggers, gem-magnet radius, Rally-Point recovery speed) — but the growth itself is the real
  persistent curve.
- **Vacuuming gems by positioning is the core commander verb.**

### 9.2 Floor-scoped creature track (does NOT carry over)

- Each Companion levels from **combat it performs** on its own `src/shared/xpMath.ts` curve.
  Creature XP is **damage-weighted**: a defeated enemy's creature-XP bounty is split among the
  player's Companions in proportion to damage dealt, with a small **assist floor** so
  low-contribution Companions still trickle up (prevents a hard stall on a bad-matchup
  Companion).
- Leveling drives **3-stage evolution** and **ability milestones** (§10).
- The team is **discarded at floor end** — except the one kept Companion (§9.3).

**Clean split:** gems → **player** (persistent); combat → **creatures** (floor-scoped).

### 9.3 The kept companion (cross-floor)

On winning the season you choose **one** party Companion to **keep**, carried forward at its
**ultimate (adult / final-evolution) form** as a permanent ally into Floor 4+. This is how the
Companion concept **continues beyond Floor 3**.

- **Persistence contract** (defined here; consumed by future floors):
  `{ speciesId, affinity, fightingStyle, form: 'adult', levelBand, learnedAbilities }`, stored
  in the same in-process floor-transition carryover channel used for generated-equipment
  carryover.
- Later floors **re-host** that record as a friendly team-tagged ally (ADR 0071 D2) and may
  also introduce creatures already in ultimate form.
- This design **defines the contract only** — it does not build Floor 4 or the future hosting.

---

## 10. Evolution & ability milestones

Standard curve across all species (per-species flavor in the roster doc):

- **Forms:** **Baby** (L1–9) → **Adolescent** at **L10** → **Adult** at **L25**. Level cap
  **L40**.
- **Ability unlocks:** **L1** (innate), **L8**, **L16**, **L25** (adult signature), **L34** —
  up to **5 abilities** per species, flavored by **affinity × style** (e.g., an Ember
  Burster's L25 is a fire nova; a Tide Kindler's L25 is a restorative tide).
- **XP curve:** reuses `xpMath` (`XP.BASE_PER_LEVEL` / `XP.SCALING_FACTOR`); creatures share the
  player's leveling math with their own per-entity XP counter.
- Evolution + level-up + ability-learned events surface via the notification UI (screen #6).

---

## 11. KO, recovery & the lose condition

- A Companion at **0 HP is knocked out (downed)** for the current engagement — **not dead.**
- **Recovery:** KO'd Companions restore to full when the **active engagement ends** (no
  hostiles engaged for a short window) or **instantly at a Rally Point** (§8). Player level
  speeds out-of-combat recovery.
- **Lose = all 6 party Companions KO'd simultaneously** during a single sustained engagement
  (ADR 0071 D8). Because KO is recoverable between fights, a wipe only happens when the whole
  locked team goes down in one fight — which makes the **party HUD legibility** (screen #4)
  critical and the coverage draft (§6) meaningful.
- On a wipe → **Lose screen** (screen #12). Standard floor-fail handling.

---

## 12. Studios (gyms) & the Final Four

### 12.1 The 6 Studios

- Each Studio is a **sealed affinity-themed den** run by a celebrity handler (invulnerable),
  fielding **3–4 Companions** (a themed affinity core + one off-type curveball to punish mono-
  coverage).
- Clearing a Studio = **KO the handler's whole roster.** Grants a guaranteed reward chest
  (reuse boss-chest lifecycle) + gates progress toward the Final Four.
- **Any-order with soft gating:** Studios can be tackled in any order the player can reach/
  unlock, but each has an unlock objective (§8) so early-game players can't faceroll a
  high-level Studio unprepared.

### 12.2 The Final Four

- Opens only after **all 6 Studios fall.** A sequential gauntlet of **4 championship handlers**
  (the network board), each fielding **4–5 adult-form Companions** at the floor's top level
  band, with strong intra-team type synergy.
- Beating all four = **season win** → **Best in Show** screen (#12) → **keep-one-companion
  picker** (#14) → floor exit / carryover.

---

## 13. Seeded boss variety (deterministic per seed)

Studios and the Final Four are **not identical every run** (ADR 0071 D9). All variety is driven
by `SeededRandom` keyed to the floor seed, so headless runs and tests reproduce a seed exactly
(never `Math.random()`/`Date.now()`).

- **Gym Leader candidate pool:** ~**10** authored handler identities (theme + affinity + lineup
  template). Each seed picks **6**, assigns them to dens, and orders their unlock difficulty.
- **Final Four candidate pool:** ~**7** authored finalist identities. Each seed picks **4** and
  orders the gauntlet.
- **Lineup variance:** within a handler's affinity theme, the exact species/forms per roster
  slot are also drawn from the species pool by the seeded stream, so even a repeat handler
  fields a different-but-thematically-consistent team.
- **Determinism guarantee:** same seed ⇒ identical Studios, finalists, lineups, and order.
  This is a hard test target (spec test plan).

Authoring the candidate pools **larger** than the 6/4 that appear per run is what produces
run-to-run variety without per-run hand-authoring.

---

## 14. Rewards & economy

- **Wilds:** XP gems (player), gold, common crafting mats; creature XP to the fighters.
- **Trainers:** as wilds + a **poach** (pre-lock) or a small gear/loot bonus (post-lock).
- **Studios:** guaranteed reward **chest** (gear/mats, reuse boss-chest lifecycle) + progress
  gate.
- **Final Four:** top-tier gear chest per finalist + the **season-win** rewards.
- **Kept companion:** the single carried Companion is itself a persistent reward (§9.3).

All player-facing loot funnels into the **existing** cross-floor gear/inventory/level economy —
Floor 3 does not fork it.

---

## 15. New UX / UI surface inventory (design here; build as slices)

Each surface is an implementation slice and — per the lab-gate rule — **needs its own lab**.
Reuse anchors noted.

| #   | Surface                          | Shows / states                                                        | Reuses                                        |
| --- | -------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Floor 3 welcome + rules intro    | show format, "you don't fight," recruit/lock rules, win con           | `src/engine/scenes/IntroScene.ts`             |
| 2   | Starter selection                | 4 random starters; affinity/style/abilities; pick 1                   | `src/engine/RewardOpeningUI.ts` (3-choice modal) |
| 3   | Poach-a-Companion picker         | defeated Trainer's 2–3 creatures; remaining slots; 5th-pick lock warn | `RewardOpeningUI.ts`                           |
| 4   | Party HUD (6 Companions)         | per-pet HP/KO, level, affinity + style icons, ability cooldowns       | HUD (`hud-lab`)                                |
| 5   | Companion detail / roster screen | stats, affinity, style, abilities, evolution track                    | new (roster panel)                             |
| 6   | Level-up / evolve / learn notice | leveled / evolved (form change) / learned ability                     | `src/engine/LevelUpUI.ts` + `level-up-lab`     |
| 7   | Ability command input            | the commander verb — trigger a Companion's signature ability          | new (command binding + HUD affordance)         |
| 8   | Affinity matchup indicator       | strong/weak read on the current engagement (drives the type game)     | new (combat overlay)                           |
| 9   | Recruit-window / lock indicator  | recruit slots remaining before party-lock                             | HUD element                                    |
| 10  | Studio unlock + handler "versus" | announce handler, affinity identity, lineup preview                   | intro/versus banner                            |
| 11  | Final Four bracket / versus      | the 4-finalist gauntlet bracket + per-round versus                    | versus banner                                  |
| 12  | Win screen + Lose screen         | "Best in Show" champion / party-wipe fail                             | floor end screens                              |
| 13  | Overworld markers                | biomes, roaming Trainers, Studio dens, Final Four gate, Rally Points  | minimap/marker layer                           |
| 14  | Keep-one-companion picker        | end-of-floor: pick the single Companion to carry at ultimate form     | `RewardOpeningUI.ts`                           |

---

## 16. Set-piece manifest (design here; author later)

Authored via the set-piece system (`src/shared/data/set-pieces.json`, `set-piece-types.ts`,
stamped by `src/core/map/stampSetPiece.ts`, edited in the Set Piece Editor canvas, tested in
`set-piece-lab`). Keyed to **affinity/theme, not a named handler**, so seeded boss variety
(§13) always has authored art:

- **7 affinity Studio-den motifs** (Ember forge-stage, Bloom greenhouse-stage, Stone
  quarry-stage, Gale updraft-stage, Tide tidepool-stage, Gloom shadow-stage, Lumen mirror-
  stage). Each run **stamps the 6 dens** its seed selected from these motifs, so any drawn
  Studio has a themed arena.
- **1 Final Four championship arena** (the network "main stage").
- **Optional flavor:** starter-selection "audition stage" / welcome soundstage; Trainer mini-
  arenas.

---

## 17. IP-safety statement

All Floor 3 **creatures, names, affinities, biomes, handlers, and world framing are original
inventions.** The design borrows only **non-copyrightable game mechanics** that are common to
the monster-taming genre and to games broadly: elemental type effectiveness, three-stage
creature evolution, skill-gate "gym" bosses, and party-based auto-battles. No creature designs,
species names, type names, character names, region names, logos, music, or text are copied or
adapted from any existing property. Naming uses original English portmanteaus (roster doc §2).
If any coined name is later found to collide with an existing trademark, it will be renamed —
the systems do not depend on any specific name.

---

## 18. Cross-references

- **Architecture:** [ADR 0071](../adr/0071-floor3-companion-league.md)
- **System contract + schemas + epic decomposition:**
  [`.specify/specs/floor3-companion-league.md`](../../../.specify/specs/floor3-companion-league.md)
- **Full creature roster (≥50 species × 3 forms):** [`floor3-pet-roster.md`](floor3-pet-roster.md)
- **Tone:** [Lore Bible](lore-bible.md)

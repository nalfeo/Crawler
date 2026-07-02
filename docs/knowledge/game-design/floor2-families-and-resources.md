# Floor 2 — Families, Resources & Content Bible

> **Season episode:** _"Family Matters"_ (working title). Floor 2 is an **easy but
> open** cave-system floor where feuding mob **families** wage a mob-drama turf war
> over a single contraband **resource** they refine into vices. The Director frames
> it as a narco-soap-opera episode: _"Welcome back to Family Matters — where blood is
> thicker than water, but nothing's thicker than a fresh batch of [RESOURCE]!"_
>
> This is the **authored content** reference (Content Designer + Story Designer
> layers). The **system contracts** live in
> [`.specify/specs/floor2-family-territories.md`](../../../.specify/specs/floor2-family-territories.md);
> the **architecture decision** lives in
> [ADR 0039](../adr/0039-floor2-family-territory-and-relationship-architecture.md).
> Tone must stay consistent with the [Lore Bible](lore-bible.md): dark comedy, never
> grimdark; the horror is bureaucratic; vices are played for absurd mob-drama laughs,
> never glorified.

---

## 1. The Fantasy (player-facing pitch)

You drop into a sprawling, dim cave system. Three or four **families** each hold a
huge cavern **territory** and are at each other's throats over the **Mother Lode** —
one contested resource at the heart of the caves that every family wants to refine
into their signature product. You start as an unwelcome intruder: **everyone dislikes
you**. From there you choose a strategy:

- **Take a side.** Curry favor with one family, help them wipe out the rest, and walk
  out arm-in-arm with your new best friends.
- **Declare absolute war.** Trust no one, decapitate every family, and take the whole
  stash for yourself.
- Anything in between — bribe, betray, broker, and backstab.

When either victory shape is reached, the exit **stairs manifest inside the resource
heart** (the stash was the way out all along).

---

## 2. Family Roster (18 families — floor picks 3–4)

Each floor **seeds 3–4 present families** from this roster (≥15 required; 18 provided
for variety). Families are **always mutually hostile** — their relationship value
only governs their stance toward the **player**. Every family has one **boss**;
killing the boss ends that family's spawns (the family is "decapitated").

| ID           | Clan Name              | Species       | Boss (title — name)                | Pref. AI           | HUD Color      | Signature battlefield hook                     |
| ------------ | ---------------------- | ------------- | ---------------------------------- | ------------------ | -------------- | ---------------------------------------------- |
| `goblins`    | The Snaggle Cartel     | Goblins       | Matriarch — "Nana Snaggle" Grubwix | swarm              | bilious green  | Cheap and numerous; overwhelm by count         |
| `llamas`     | The Spit Syndicate     | Llamas        | Don Paco "The Gob"                 | ranged             | cream/tan      | Ranged spit that briefly slows the player      |
| `pandas`     | The Bamboo Triad       | Pandas        | Honcho — Big Panda Wei             | chase (tank)       | black/white    | High-HP bruisers; slow but punishing           |
| `faeries`    | The Glitterkin         | Faeries       | Queen Mab Tarnish                  | leaper             | magenta        | Fast, erratic blinks; spawn short-lived decoys |
| `kobolds`    | The Emberkin Clan      | Kobolds       | King Skritt the Unburnt            | swarm+traps        | rusty red      | Lay floor traps around their still; zealous    |
| `myconids`   | The Sporeholders       | Mushroomfolk  | The Sovereign Cap                  | ranged (slow)      | spore violet   | Spore-burst AoE; leave lingering spore clouds  |
| `toadkin`    | The Croak Family       | Frog/Toadfolk | Big Mama Bufo                      | ambush/ranged      | mottled green  | Tongue-grab that yanks the player in           |
| `gnomes`     | The Cog Combine        | Gnomes        | Overseer Fizzwick                  | ranged (turret)    | brass/blue     | Deploy stationary gadget turrets               |
| `ratfolk`    | The Gutter Guild       | Ratfolk       | Plague-Boss Squick                 | swarm              | sickly brown   | Diseased; breed/split when ignored             |
| `cactusfolk` | The Thornbloom Growers | Cactusfolk    | Abuela Saguaro                     | chase (spiny)      | desert green   | Reflect a share of contact damage (spines)     |
| `batfolk`    | The Nightwing Coven    | Batfolk       | Countess Vesper                    | leaper (fly)       | deep purple    | Flying dive-bombs; hard to pin down            |
| `crabfolk`   | The Tidewrack Mob      | Crabfolk      | Kingpin Molt                       | chase (armor)      | red/orange     | Armored front — must be flanked                |
| `beetlefolk` | The Chitin Clan        | Beetlefolk    | The Broodfather                    | swarm (armor)      | iridescent blk | Armored swarm; roll-charge attack              |
| `molefolk`   | The Deepdig Union      | Molefolk      | Foreman Grubbs                     | ambush (burrow)    | grey-brown     | Burrow and surface next to the player          |
| `raccoons`   | The Trash Panda Family | Raccoons      | Boss Bandit Rocco                  | leaper (thief)     | grey/black     | Steal gold on hit, then flee                   |
| `geese`      | The Honk Mob           | Geese         | Don Honkrado (the Godgoose)        | chase (relentless) | white/orange   | Never de-aggro; relentless honking menace      |
| `imps`       | The Brimstone Boys     | Imps          | Foreman Scorch                     | ranged (fire)      | crimson        | Lob fireballs; volatile "cook"                 |
| `snailfolk`  | The Slowlane Syndicate | Snailfolk     | The Gastropod Godfather            | chase (very slow)  | olive          | Very tanky; leave a slowing slime trail        |

**Refinement styles** — each family applies its own style to _whatever_ the floor's
resource is (combinatorial flavor for The Director's commentary):

goblins → cut it cheap in bulk ("Snaggle Special") · llamas → distill rotgut
("Llambrusco") · pandas → ferment a mellow brew ("Bamboo Baijiu") · faeries → refine a
hallucinogen ("Faedust") · kobolds → burn ritual incense ("Dragon's Breath") · myconids
→ culture spore-wine ("Sporeshine") · toadkin → sweat a topical ("Toad Sweat") · gnomes
→ mass-produce industrial pharma ("Cog-Grade") · ratfolk → adulterate with filth
("Gutter Dust") · cactusfolk → grow artisanal organic ("Sun-Grown") · batfolk →
air-freight an inhalant ("Echo") · crabfolk → brine-cure euphoric candy ("Saltwater
Taffy") · beetlefolk → press time-release pellets ("Scarab Caps") · molefolk → sell
uncut premium ("Motherlode") · raccoons → dilute a party mix from stolen stock
("Dumpster Fire") · geese → run a protection racket over it ("Honk Tax") · imps → cook a
volatile hellfire batch ("Brimstone") · snailfolk → slow-age top-shelf ("Vintage Slime").

> **Balance note (easy floor):** on an easy floor, bosses are readable and beatable and
> the present set should skew toward at least one "gettable" family. Exact per-family
> HP/speed/damage are **Game Designer** numbers in `src/shared/data/tuning.json` and a
> Floor 2 enemy pack — not fixed here. The **90%+ Floor-2 win-rate** gate (see the spec)
> governs tuning, never cherry-picked seeds.

---

## 3. The Contested Resource (18 options — floor picks 1)

The floor seeds **one** resource as the Mother Lode. Families feud over it; the exit
stairs appear at its heart on victory. All are contraband refined into a vice — kept
comedic and bureaucratic per the Lore Bible.

| ID              | Resource (street name)          | Refined into…                         |
| --------------- | ------------------------------- | ------------------------------------- |
| `glimmercap`    | Glimmercap Spores               | psychedelics                          |
| `cavesugar`     | Cave Sugar (speleothem crystal) | "Crank Candy" stimulant               |
| `deeproot`      | Deeproot Mash                   | moonshine                             |
| `bloomthistle`  | Bloomthistle Nectar             | faerie wine / opiate                  |
| `browngold`     | Bat Guano ("Brown Gold")        | gunpowder **and** snuff (dual-use)    |
| `screamroot`    | Screamroot (shrieking mandrake) | hallucinogen / anesthetic             |
| `moltenhoney`   | Molten Honey (cave-bee comb)    | mead / "the buzz"                     |
| `corpseglow`    | Corpseglow Lichen               | embalming liquor "Widow's Kiss"       |
| `sparkle`       | Quartz Dust ("Sparkle")         | inhalant stimulant                    |
| `newtsweat`     | Newt Sweat (amphibian slime)    | topical psychoactive "Toad"           |
| `deepcaviar`    | Fermented Deep Caviar (roe)     | luxury narcotic paste                 |
| `brimstonesalt` | Sulfur Brimstone Salts          | volatile party drug / explosive       |
| `dreamsyrup`    | Weepwillow Sap ("Dream Syrup")  | sedative syrup                        |
| `voidcap`       | Voidcap Truffles                | premium reality-bending hallucinogen  |
| `palealgae`     | Pale Ale-gae (cave algae)       | craft beer                            |
| `gloompoppy`    | Gloomshade Poppy                | opiate "Nod"                          |
| `backstage`     | Ancient Craft-Services Rations  | "Backstage Brew" (a Director in-joke) |
| `frostmoss`     | Frostmoss Menthol               | numbing menthol chew                  |

---

## 4. Relationship model (player-facing behavior)

Every present family has a **relationship value 0–100** with the player. **All start at
45** — you begin mildly disliked by everyone. Bands (exact boundaries in the spec):

| Band         | Range  | The family…                                                                                     |
| ------------ | ------ | ----------------------------------------------------------------------------------------------- |
| **Hate**     | 0–24   | Hostile **and** gets a speed boost that ramps up to **player speed at 0** (you can't outrun 0). |
| **Hostile**  | 25–49  | Attacks you on sight (normal speed).                                                            |
| **Neutral**  | 50–75  | Tolerates you — won't attack, won't help. Keeps feuding with the other families.                |
| **Friendly** | 76–100 | **Follows you** and **attacks anything that attacks you** (rival families + trash mobs).        |

- Families are **always** hostile to each other. Two families can both be Friendly to
  you at once and will _still fight each other_ — which is why the "sole ally" victory
  forces you to eventually pick just one.
- When hostile, a family mob **prefers the player** as a target but will fight rival
  family mobs when the player is out of reach — producing ambient turf-war skirmishes.

### How relationships shift (levers)

| Lever                                         | Effect (default direction)                      |
| --------------------------------------------- | ----------------------------------------------- |
| Damage / kill a family's mobs                 | ↓ that family (small per hit, larger per kill)  |
| Kill a **rival** family's mobs while allied   | ↑ your ally slightly ("proving loyalty")        |
| Complete a family's favor quest / tribute run | ↑↑ big                                          |
| Pay a family's protection racket (gold)       | ↑ (buy favor)                                   |
| Betray an ally (attack a Friendly family)     | ↓↓↓ immediate — they turn on you and _remember_ |
| Emergent turf-war "pick a side" events        | ↑ chosen family, ↓ the other                    |

No automatic decay by default — relationship change is **player-driven** so "take a
side" and "declare war" stay deliberate strategies. (A slow decay is a tunable, off by
default.)

---

## 5. Bosses & boss dens

- Each present family's **boss** sits in a sealed **boss den** (a sub-chamber off the
  family's territory). The den stays locked until you complete that family's **unlock
  objective** (seeded per family per floor from the pool below).
- **Killing the boss** ends the family's spawns (already-spawned mobs linger until
  killed or they wander out of range and despawn).

**Unlock-objective pool** (floor seeds one per present family — variety, and each maps
to a valid strategy):

1. **Thin the ranks** — kill _N_ of that family's mobs.
2. **Steal the ledger** — grab a family-specific item from their territory.
3. **Win their favor** — reach Friendly (>75); they _invite_ you in (peaceful path).
4. **Sabotage the still** — destroy their refinery set-piece in the territory.
5. **Bring tribute** — deliver _X_ units of the contested resource to the family.
6. **The hit** — a rival family pays you to open this den (opens den, tanks this
   family, boosts the requester).

---

## 6. Win & lose conditions

- **Win A — Sole Survivor & Ally:** exactly **one** present family is still **alive**
  (boss undefeated) **and** that family is **Friendly (>75)**. → _"You took a side."_
- **Win B — Total War:** **every** present family's boss is defeated. → _"You declared
  absolute war."_
- On either win, the resource unlocks and the **exit stairs manifest at the resource
  heart**; walk there to descend.
- **Lose:** the floor timer expires before a win, or the player dies. Timer is generous
  (easy floor) with a stall-guard.

Note: allying _two_ families is **not** a win — Win A requires reducing to a single
ally, so you must still decapitate everyone else.

---

## 7. Trash mobs (variety — neutral to families, hostile to player)

Ambient cave fauna that infest tunnels and un-owned caverns. **Neutral to families**
(families ignore them and vice-versa) but **always hostile to the player** — XP/loot
fodder and constant low-grade pressure. Provide more variety than Floor 1's rats/slimes:

| Trash mob        | AI            | Flavor                                       |
| ---------------- | ------------- | -------------------------------------------- |
| Cave Slime       | leaper        | returning Floor-1 face; splits on death      |
| Giant Cave Rat   | chase         | returning Floor-1 face; fast, weak           |
| Cave Bat Swarm   | leaper (fly)  | erratic flyers in clusters                   |
| Rock Lice        | swarm         | skittering, tiny, many                       |
| Blind Cave Newt  | chase (slow)  | slow shambler, tanky-ish                     |
| Glow-worm        | swarm         | bursts into a small light flash on death     |
| Fungal Husk      | chase         | shambling spore-zombie (non-aligned myconid) |
| Crystal Scuttler | chase (armor) | armored little crab-thing                    |

---

## 8. The Settlement (safe room)

A neutral **settlement** cavern — a shanty market of non-aligned critters, deserters,
and refugees ("the Switzerland of the caves"). It's a **safe room** (no enemies,
sealed perimeter). Contents:

- **1–2 random shops** (seeded from a shop-archetype pool):
  - **The Fence** — weapons & gear.
  - **The Apothecary** — potions/heals & buffs.
  - **The Quartermaster** — armor & trinkets.
  - **The Resource Broker** — buys/sells the contested resource (funds tribute/bribes).
- **≥1 quest giver** — **"The Broker"** (a neutral fixer NPC) who dispenses the
  emergent family quests, brokers protection payments, and lets you buy favor. Optional
  second NPC: a defected family member offering intel on one present family.

Shop inventory is **seeded and generated** per run (a small random-shop-inventory
generator — see the spec).

---

## 9. Emergent events (relationship set-pieces)

Authored, data-driven, seeded events that fire on triggers (enter a region, cross a
relationship threshold, timer beats). Present set is seeded per floor. Examples:

1. **Turf-War Flashpoint** — two families clash at a chokepoint; The Director offers
   _"Pick a side."_ Help one wipe the other's raiding party: ↑ chosen, ↓ other.
2. **The Tribute Run** — a family's consigliere asks for _R_ units of resource: big ↑.
3. **The Hit** — a family hires you to assassinate a rival's boss: opens that den,
   tanks the rival, boosts the requester.
4. **Protection Racket** — pay gold to a family for favor (or refuse and take heat).
5. **The Betrayal Tax** — attack a Friendly family and the whole settlement hears about
   it: ↓ and a "marked" reputation flag.
6. **Poison the Well** — sabotage the Mother Lode for one family: shifts several
   relations at once (chaos the audience loves).

The Director narrates each as reality-TV drama; static fallback lines authored by the
Story Designer, runtime spice by the AI Content Engineer (load-time only).

---

## 10. Cross-references

- **System contracts & test plan:**
  [`.specify/specs/floor2-family-territories.md`](../../../.specify/specs/floor2-family-territories.md)
- **Architecture decision:**
  [ADR 0039](../adr/0039-floor2-family-territory-and-relationship-architecture.md)
- **Lore & tone:** [Lore Bible](lore-bible.md) · **Game vision:**
  [Game Design Document](game-design-document.md)

# Floor 4 — The Main Event (Arena) & Content Bible

> **Season episode:** _"The Main Event"_ (working title). Floor 4 is a **timed survival
> arena** floor. After three floors of the crew following a contestant around a dungeon,
> the network gets tired of paying for camera trucks and books the whole thing as a
> **live pay-per-view broadcast** in one sealed venue. Ten minutes of wave combat, an act
> break every two minutes, a **Headliner** boss to close each act, and a **Green Room**
> intermission where rotating sponsors sell you whatever they shipped that quarter.
> The Director: _"We tested a floor where you walk around looking for doors. The numbers
> were soft. This one has a clock."_
>
> This is the **authored content** reference (Content Designer + Story Designer layers).
> The **system contracts** live in
> [`.specify/specs/floor4-arena.md`](../../../.specify/specs/floor4-arena.md); the
> **architecture decision** lives in [ADR 0090](../adr/0090-floor4-arena.md). Tone must
> stay consistent with the [Lore Bible](lore-bible.md): dark comedy, never grimdark; the
> horror is bureaucratic; the violence is a scheduling problem for someone in a control
> room.

---

## 1. The Fantasy (player-facing pitch)

You are shoved through a curtain onto a floodlit arena floor. A countdown clock the size
of a building hangs over the sand. There is no map, no exploration, no doors to find —
there is a **timer**, and things come out of the gates.

**Survive ten minutes.** That is the whole floor.

The ten minutes are broken into **five two-minute acts**. Enemies pour out of the venue's
four **feed gates** in escalating waves; you kite, you funnel, you hoover up gold and XP.
Ninety seconds in, the gates slam, the trash is pulled off camera, and the **Headliner**
walks out — a boss booked specifically to close that act, with the show clock still
running. Kill it and the floor cuts to commercial.

Commercial is the **Green Room**: a sealed lounge behind the arena where the show's
**sponsors** have set up folding tables. Buy, sell, equip, re-spec your loadout, breathe.
The sponsors are different every break — the network rotates ad partners between acts, so
the stock on the tables is never the same twice.

Then the door opens and the next act starts.

The floor's promise is a **build-vs-clock race**: every act you get stronger from the
Green Room, and every act the show gets meaner. If your build outruns the escalation you
walk out with the belt. If it doesn't, the arena has your name in the chyron.

---

## 2. The satirical frame

Floor 4 is the season's **format pivot** — the in-world reason the floor's rules differ
from Floors 1–3.

- **The pitch:** the dungeon's producers discover that _venue content_ is cheaper than
  _location content_. One arena, one contestant, fixed camera rig, no set dressing budget.
- **The Headliners** are contracted talent, not dungeon fauna. They have entrance music,
  they have a gimmick, and they are extremely aware they are being paid per appearance.
- **The Green Room** is a commercial break dressed as hospitality. The "sponsors" are
  procedurally-branded shell companies (see [Lore Bible §Sponsor Companies](lore-bible.md))
  who rotate out between breaks because their contracts are per-act.
- **The clock** is a broadcast window, not a dungeon hazard. Nothing in the fiction is
  "collapsing" — the show simply ends at ten minutes because that is what was sold.
- **The audience** is the real antagonist. Escalation is not the dungeon getting angrier;
  it is the production team responding to a live engagement graph.

> Director bumper, act 3: _"Reminder that the Headliner is a licensed performer. Any
> footage of it losing is the property of the network."_

---

## 3. Core loop — the act cycle

Floor 4 replaces "explore, clear, descend" with a **fixed five-beat cycle** hung off one
continuously-running **arena clock**.

```
COUNTDOWN
  ACT 1  [0:00 → 1:30 waves | 1:30 → 2:00 HEADLINER 1]  → GREEN ROOM 1
  ACT 2  [2:00 → 3:30 waves | 3:30 → 4:00 HEADLINER 2]  → GREEN ROOM 2
  ACT 3  [4:00 → 5:30 waves | 5:30 → 6:00 HEADLINER 3]  → GREEN ROOM 3
  ACT 4  [6:00 → 7:30 waves | 7:30 → 8:00 HEADLINER 4]  → GREEN ROOM 4
  ACT 5  [8:00 → 9:30 waves | 9:30 → 10:00 HEADLINER 5] → WINNER'S CIRCLE → stairs
```

Six rules define the beat:

1. **The arena clock runs continuously through all combat.** Waves and Headliner fights
   share one clock, so **"ten minutes" is ten real minutes of the show** — legible on the
   HUD, bounded, and the same on every seed. The clock is frozen only in the Green Room,
   which contains no combat and no risk (§7).
2. **Act boundaries are absolute clock marks** at 2:00 / 4:00 / 6:00 / 8:00 / 10:00. They
   never drift, so the wave schedule is identical on every run of a given seed regardless
   of how the player performed.
3. **Every act is split into a wave window and a headline window.** Waves spawn for the
   act's first 90 seconds. At the 1:30 mark the feed gates seal, surviving trash is _cut_
   (§5.4), and the act's **Headliner** enters for the last 30 seconds — with the clock
   still running.
4. **The act always ends on its mark, not on the kill.** Killing a Headliner early does
   not end the act early: the remainder of the headline window becomes the **victory
   lap** — the window in which the player collects the boss chest, hoovers the act's
   leftover drops, and takes the Director's post-match interview. The cut to commercial
   happens at the mark. This is what keeps the ten minutes exact and the act marks
   absolute, and it is why the chest is never stranded (§7.3).
5. **Overtime is the only thing that ever pauses combat time.** If an act's mark arrives
   with the Headliner still alive, the arena clock **holds** at that mark — it must never
   bleed into the next act, which would corrupt the wave schedule — and the fight goes to
   **Overtime** (§6.2): a deterministic escalation ramp with a hard 60-second cap ending in
   a guaranteed-lethal finisher. Overtime is a bounded, self-terminating failure path, not
   an open-ended pause.
6. **Every Headliner is followed by a Green Room.** Five bosses, five shopping trips. The
   fifth Green Room is the **Winner's Circle** and its exit is the stairs.

Because of rules 1, 4 and 5 the floor's total combat time is exactly **10:00 plus at most
5 × 0:60 of overtime**, which is what makes the floor testable under a headless win-rate
gate at all.

The player verb is unchanged from Floors 1–2: move, auto-attack, use abilities, collect.
Floor 4 changes the **shape of the pressure**, not the controls.

---

## 4. The venue (floor layout)

There is one map and it is authored, not explored.

| Zone                    | Role                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Floor**           | The arena proper. Bounded, roughly oval, large enough to kite a full wave but small enough that you are never more than ~4s from a fight.         |
| **The Feed Gates**      | Four spawn mouths at the cardinal points, just off the play space. Waves emerge here. Gates telegraph 1s before a wave spawns.                    |
| **The Pit Fixtures**    | A handful of static cover/collision props (barriers, a wrecked camera dolly, sponsor plinths) that give kiting geometry. No destructibles in MVP. |
| **The Green Room**      | A sealed lounge adjoining the arena. Reached through the curtain tunnel after each Headliner dies. Safe space; no combat.                         |
| **The Winner's Circle** | The Green Room re-dressed after Headliner 5. Same shops, plus the stairs.                                                                         |

Design constraints:

- **No exploration reward.** There is nothing to find. All progression comes from wave
  drops, Headliner chests, and the Green Room.
- **No fog of war advantage.** The whole arena is lit and visible; the tension is
  quantity, not surprise.
- **Kiting must be legal.** The arena must have no dead-end geometry that can trap the
  player against a wave. This is a hard map-gen invariant (spec FR-Map).

---

## 5. Waves — composition and escalation

Each act is a fixed number of **waves** scheduled on the act clock. A wave is a spawn
_budget_, not a fixed list: the budget is spent on archetypes drawn from the act's roster.

### 5.1 Cadence

- **8 waves per act**, one every 12s of the act's 90-second wave window
  (`t = 0s, 12s, … 84s`).
- **40 waves across the floor.**
- Wave `0` of act 1 is deliberately tiny — the first five seconds teach the gates.
- Waves spawn at **fixed, indexed feed gates** chosen by the wave's own precomputed
  manifest. Spawn placement never depends on where the player happens to be standing,
  because a player-dependent placement search would make spawn RNG consumption
  path-dependent and destroy replay determinism.

### 5.2 Budget curve

Each wave has a **threat budget**; each enemy archetype has a threat cost. The wave's
contents are **precomputed into an immutable spawn manifest** when the act begins — not
rolled at spawn time — so a wave's composition can never be perturbed by combat timing.

```
waveBudget(act, waveIndex) = baseBudget
                           * actMultiplier[act]        // 1.00, 1.35, 1.80, 2.40, 3.20
                           * (1 + intraActRamp * waveIndex)
```

The intent, stated as a designer target rather than final numbers (final numbers are
tuned against the win-rate gate, never against cherry-picked seeds — project rule #12):

| Act | Feel         | Roster                                                         |
| --- | ------------ | -------------------------------------------------------------- |
| 1   | Warm-up      | Chaff only. Teaches gates, teaches hoovering.                  |
| 2   | Volume       | Chaff + first swarm archetype. Crowds start to matter.         |
| 3   | Mixed threat | Adds ranged. Player must break line of sight, not just circle. |
| 4   | Elites       | Adds an elite/armored archetype in small numbers.              |
| 5   | Everything   | Full roster, highest density, elites in packs.                 |

### 5.3 The concurrency cap and the spawn debt

Waves **never** exceed a live-enemy cap. If a wave's manifest would push the live count over
the cap, the un-spawned remainder becomes **spawn debt** and is released as capacity frees
up, in manifest order. This keeps the floor inside the existing engagement-budget contract
(ADR 0024) and stops a stalling player from compounding an unwinnable ball of enemies.

Three hard rules keep the debt from becoming an unbounded difficulty spike or a
determinism hazard:

- **Debt is capped.** Beyond a fixed maximum, further overflow is **discarded**, not
  banked. An act cannot silently accumulate a lethal post-boss burst.
- **Debt is cleared at every phase boundary.** Entering the headline window, the Green
  Room, or the next act discards all outstanding debt.
- **Debt never re-rolls anything.** The manifest was already computed; releasing a debted
  entry consumes no RNG, so cap pressure cannot shift the seed's downstream draws.

### 5.4 The cut

When the act's wave window ends, surviving trash is **cut**: it is removed with the standard
death-VFX treatment and **does not** award XP or drops. This is in-fiction a production
decision ("we're over"), and mechanically it prevents an act's leftovers from stacking into
the Headliner fight, which would make the boss's difficulty depend on how badly the previous
ninety seconds went.

> Director, on the cut: _"Clear the floor. Their agents get paid either way."_

---

## 6. The Headliners (bosses)

Five bosses, one per act, each entering at its act's 1:30 mark.

- **Headliners 1–4 are seeded.** They are drawn **without replacement** from a candidate
  pool of at least eight Headliners, using the floor seed. Same seed ⇒ same card, every
  run, headless or not. Different seeds ⇒ a different card, so the floor has run-to-run
  variety without run-to-run unfairness.
- **Headliner 5 is fixed: The Showrunner.** The finale is always the same fight so the
  floor has an authored climax and a stable balance target.
- **Pool entries are graded.** Each candidate declares a difficulty grade; the draw picks
  a grade-appropriate Headliner per act slot (act 1 draws from the low grades, act 4 from
  the high ones), so a seed can never front-load the hardest fight into act 1.
- **Each act slot is its own encounter.** The encounter identity is the slot
  (`floor4-headliner-act-3`), not the archetype, so rewards, telemetry, and defeat latches
  stay stable even if the same archetype is ever reachable from two slots.
- **Every Headliner drops a boss chest** (the existing boss-chest reward path) plus a
  guaranteed **appearance fee** in gold, sized so the following Green Room is always
  meaningfully affordable. The chest is collected during the **victory lap** — the
  remainder of the headline window after the kill (§3 rule 4) — so the reward is never
  stranded in an arena the player has already left.

### 6.1 Candidate pool (authored roster — grades in brackets)

| Headliner ID            | Headliner                          | Grade | Gimmick (one line)                                                                     |
| ----------------------- | ---------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| `floor4-warm-up-act`    | **The Warm-Up Act**                | 1     | A nervous, over-rehearsed brawler who telegraphs everything twice.                     |
| `floor4-legal`          | **Legal**                          | 1     | Serves injunctions: slow ground-marked zones the player must not stand in.             |
| `floor4-sponsor-mascot` | **The Sponsor Mascot**             | 2     | Inflatable, bouncy, splits into smaller mascots on death.                              |
| `floor4-continuity`     | **Continuity**                     | 2     | Periodically "resets the take": returns to its entrance mark and re-runs its opener.   |
| `floor4-fan-favourite`  | **The Fan Favourite**              | 3     | Buffed by the crowd — gets faster the longer the fight runs.                           |
| `floor4-standards`      | **Standards & Practices**          | 3     | Censors a slice of the arena: rotating blocked wedges the player must vacate.          |
| `floor4-understudy`     | **The Understudy**                 | 4     | Copies the player's currently-equipped weapon archetype.                               |
| `floor4-prime-time`     | **Prime Time**                     | 4     | Alternates a heavy melee "live" phase with a ranged "commercial" phase.                |
| `floor4-showrunner`     | **The Showrunner** (finale, fixed) | 5     | Books the fight: summons a short scripted wave mid-fight, then finishes it personally. |

The Showrunner's scripted wave is a **boss ability, not a scheduled wave**: it is owned by
the encounter, shares the arena's live-enemy cap, never contributes to or draws from spawn
debt, and is cut when the encounter ends by either kill or overtime finisher.

Grade eligibility per act slot: act 1 → grades 1–2, act 2 → grades 1–3, act 3 → grades 2–4,
act 4 → grades 3–4, act 5 → the fixed finale. The pool is **append-only**: adding a
Headliner must not renumber or reorder existing entries, or every existing seed's card
changes.

Each entry is a **design stub**, not a shipping spec: HP, damage, telegraph shapes, and
ability wiring are authored later against the existing data-driven boss-ability catalog
(`boss-abilities.floor4.json`, mirroring the Floor 2 catalog), and each must have an
observable telegraph before it ships. Every Headliner ability must also be legal in arena
geometry — no ability may depend on corridors, doors, or cover the arena does not have.

### 6.2 Overtime

A Headliner that survives to its act's mark does not despawn and does not win by default.
The arena clock holds and the fight goes to **Overtime**, which exists to make the failure
path bounded and legible rather than to punish creatively:

- The Headliner escalates on a **deterministic ramp** — damage and speed step up on a fixed
  schedule, so a nearly-finished boss usually still dies and a hopeless fight resolves fast.
- Overtime has a **hard 60-second cap**. At the cap the Headliner performs a telegraphed,
  guaranteed-lethal finisher. There is no infinite stall and no unbounded episode.
- Overtime is **announced**. The clock turns over, the chyron reads `OVERTIME`, and the
  Director editorializes. The player should always know they have crossed into it.

> _"We are eating into the next segment. Someone is going to be very unhappy about this,
> and it is not going to be me."_

---

## 7. The Green Room (safe room)

After each Headliner dies, the curtain tunnel opens and the player walks into the Green
Room. The arena clock stays frozen for the entire visit.

What's in it:

- **Two to three sponsor tables** (shops), each an archetype with its own catalog and price
  multiplier — a weapons table, a consumables/charms table, an armor/kit table.
- **A full equip surface.** The player can equip, unequip, and rearrange everything they
  own, not just what they just bought. The Green Room is the only place on the floor where
  fiddling with your build is free.
- **A sell path.** Junk and unwanted gear convert to gold here; the arena has no vendor.
- **No combat, no timer, no pressure.** Standard safe-space rules: weapon immunity inside,
  doors sealed behind you.
- **One exit.** "Back to one" returns you to the arena and starts the next act. In the
  Winner's Circle the same door is the **stairs**.

### 7.1 Sponsor rotation — why stock re-randomizes

Every visit re-rolls every table's inventory. In fiction: **ad partners are contracted per
act**, so the tables literally belong to different companies each break.

The important design property is that the re-roll is **path-independent**: Green Room visit
_N_ for a given floor seed always offers the same stock, no matter what happened in the acts
before it. Two consequences:

- A player cannot "farm" a better shop by playing an act differently, so shopping stays a
  build decision rather than a manipulation minigame.
- Balance sweeps and headless runs see a stable shop schedule per seed, which is what makes
  the floor's economy testable at all.

Stock scales with act: later breaks carry higher-tier goods and higher prices, so the gold
curve and the threat curve stay coupled.

### 7.2 Stock lifecycle

The rotation is a **replacement**, not an accumulation, and the rules are deliberately
blunt so the economy has no hidden state:

- **Tables are fixed identities across the floor.** The same two-to-three sponsor tables
  exist at every break; only their branding and their stock change. The player never has
  to re-learn the room.
- **Stock is immutable within a visit.** What is on the table when you walk in is what is
  on the table when you leave. Nothing restocks mid-visit.
- **Bought is gone for that visit** and does not return in later visits — each visit's
  stock is rolled independently, so a passed-over item may or may not reappear.
- **Unsold stock does not carry over.** Leaving the Green Room retires the whole offer; the
  next break is a clean roll. "I'll buy it next break" is never a valid plan, which is what
  gives each break real decision weight. Generated-equipment offers follow the existing
  roll-then-retire pattern the Floor 2 Quartermaster already uses, so an unbought offer is
  retired rather than orphaned.

### 7.3 Entering and leaving (the intermission transaction)

The Green Room is only safe if the hand-off from the arena is a **transaction**, not a
door. Design requirement, in order: the Headliner dies → the victory lap runs to the act
mark while the player collects the chest and leftover drops → every remaining arena entity,
projectile, and pending spawn debt is cleared → the arena seals → the player is placed in
the Green Room → the visit's stock is rolled → the player shops → the exit is taken → the
next act's schedule is armed and the arena unseals.

Nothing about that ordering is optional: skipping the clear step leaks live enemies or
projectiles into a "safe" room, and skipping the victory lap strands the act's reward on a
floor the player can no longer reach.

The Green Room does **not** heal the player for free. Healing is something you buy, which
keeps the break a genuine spend-priority decision (armor now, or survive act 4?) instead of
an automatic reset.

### 7.4 Out of scope for MVP: the paid re-roll

A Brotato-style **"call another sponsor"** button that re-rolls the current table for an
escalating gold cost is explicitly **out of scope** and recorded here so it is not
re-invented ad hoc. It is a good fit for the fiction and a real balance lever, but it
multiplies the economy, RNG, UI, and headless-decision surface all at once, and it should
only be considered after the base floor holds its win-rate gate.

---

## 8. Economy

The floor's economy is a closed loop over ten minutes, so it can be tuned as a whole rather
than as a drip.

| Source                   | Shape                                                       |
| ------------------------ | ----------------------------------------------------------- |
| Wave kills               | Small gold + XP per kill; the dominant income by volume.    |
| Headliner appearance fee | A fixed, act-scaled gold lump on every Headliner kill.      |
| Headliner chest          | One geared reward per act via the existing boss-chest path. |
| Selling                  | Junk/duplicate gear liquidation in the Green Room.          |

Design targets (to be tuned against the win-rate gate, not against individual seeds):

- **Per-act income is budgeted, not emergent.** Each act declares a target gold yield
  (wave kills + appearance fee) and each break declares a target price band, so "can the
  player afford a meaningful purchase at break _n_?" is a number the balance pass checks,
  not a hope.
- **Every Green Room must be able to buy something meaningful — as a measurable
  invariant, not an aspiration.** Every visit's rolled stock must contain at least one
  entry priced at or below the floor's declared worst-case gold-on-hand for that break,
  computed from the guaranteed appearance fees alone (i.e. assuming no wave income and a
  player who has already spent everything). This is asserted per seed in the sweep, so an
  unlucky roll or an early healing purchase can never produce a window-shopping break.
- **Gold is not floor-scoped.** `playerGold` already carries between floors via the
  existing carryover snapshot, and Floor 4 does not change that or introduce a second
  currency. The pressure to spend is created by **pricing**, not by confiscation: the
  price bands are sized so that converting gold into power inside the Green Room beats
  carrying it out.
- **Power should roughly double across the five acts**, matching the ~3.2× threat
  escalation once the player's own level gains are counted.
- **Anti-snowball:** because stock is a fresh roll each break and never accumulates, a
  strong act 1 cannot compound into a guaranteed best-in-slot act 2. Price escalation per
  break is the second brake.

---

## 9. Win, lose & failure feel

- **Win:** defeat all five Headliners and take the stairs out of the Winner's Circle.
- **Lose:** the player dies — either to the arena, or to a Headliner's overtime finisher
  (§6.2). That is the only fail state; the ten minutes is the _content_, not a deadline.
- **The broadcast window** (the floor's absolute duration cap in the manifest) exists only
  as a backstop against a run that has stalled into a non-terminating state. With the
  bounded clock plus bounded overtime, reaching it is a **bug signal**, not a designed
  outcome, and the floor should say so loudly in telemetry when it happens.

Failure feel matters more here than on an exploration floor, because a Floor 4 death costs
a bounded, legible ten minutes rather than an open-ended crawl. Two deliberate softeners:
the run's earned rewards and achievements are banked as they happen rather than at the
stairs, and a death late in act 5 is framed as a strong showing rather than a wipe. The
Director gets the last word and the chyron gets the joke:

> _"And that's our show. Contestant did four and a half minutes. Strong debut. We'll book
> them again once the paperwork clears."_

---

## 10. Carried-in state: the Floor 3 co-star

Floor 3 ends by letting the player keep exactly **one** Companion at its final form
([`floor3-companion-league.md`](floor3-companion-league.md) §9.3). Floor 3's spec defines
the producer half of that contract and explicitly leaves the consumer to Floor 4+.

Floor 4 is that consumer, and the arena is the natural home for it: the kept Companion is
booked as the player's **co-star**, fighting alongside them for the whole broadcast. It is
a ringside ally, not a build slot — it does not replace the player's weapons and it does
not gate the win.

This is scoped as an **additive, optional slice**: if the carryover snapshot contains a kept
Companion, it enters the arena with the player; if it does not (which is the case for every
run that reaches Floor 4 without a completed Floor 3), the floor plays exactly as specified
above with no compensating change. Balance must hold **without** the co-star; the co-star is
upside, never a requirement.

---

## 11. HUD / UX surface inventory (design here; build as slices)

| Surface                  | What it shows                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Act clock**            | Large countdown of the current act's remaining time, plus `ACT n / 5`, and the total remaining show time. Turns over to `OVERTIME` when an act's mark passes with the Headliner alive. |
| **Wave pip strip**       | Eight pips per act, filling as waves spawn — a readable "how much of this act is left".                                                                                                |
| **Gate telegraph**       | A 1s pre-spawn flare on each feed gate about to open.                                                                                                                                  |
| **Headliner banner**     | Entrance card (name + gimmick line) and a boss health bar.                                                                                                                             |
| **Cut notice**           | A brief "CLEAR THE FLOOR" beat when an act's leftovers are cut.                                                                                                                        |
| **Green Room shopfront** | Per-table inventory with prices, affordability, and the sponsor's name.                                                                                                                |
| **Break summary**        | On entering the Green Room: gold earned, kills, and the act just survived.                                                                                                             |
| **Winner's Circle**      | Final tally + the stairs prompt.                                                                                                                                                       |

Floor 4 **suppresses the generic floor-timer readout**. The act clock is the only clock the
player sees, and it holds during a Green Room visit — shopping is untimed, and showing a
second, still-advancing number there would create pressure the design explicitly rejects.
The manifest's `timer.durationMs` remains a real wall-clock stall backstop (§ spec R8.4),
but it is sized far above any legitimate run and is never surfaced as a countdown.

Each of these is a design requirement here and an implementation slice in the spec; none
ships without deterministic visual validation in the real game artifact (project rule #9).

---

## 12. Cross-references

- **System contract:** [`.specify/specs/floor4-arena.md`](../../../.specify/specs/floor4-arena.md)
- **Architecture:** [ADR 0090](../adr/0090-floor4-arena.md)
- **Tone / canon:** [Lore Bible](lore-bible.md)
- **Prior floors:** [Floor 2 content bible](floor2-families-and-resources.md),
  [Floor 3 content bible](floor3-companion-league.md)
- **Genre framing:** [Game Design Document](game-design-document.md) — Floor 4 is the
  clearest expression of the GDD's stated Brotato-derived DNA.

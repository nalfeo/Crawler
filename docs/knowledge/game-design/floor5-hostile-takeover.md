# Floor 5 — "Hostile Takeover" Content Bible

> **Season episode:** _"Hostile Takeover."_ Four floors of contestant-vs-dungeon theater have
> been good television, but the network's board wants an **acquisition story**. Floor 5 stops
> pretending the dungeon is neutral ground: it is somebody's castle, the somebody is the
> Regent, and the season's sponsors have decided — live, on air — that the fastest way to grow
> the audience is to help the contestant **take the company over by force**. Minion waves push
> down a single authored lane like two departments fighting over headcount, boss-strength enemy
> **Heroes** counter the raid the way middle management counters a restructuring memo, and the
> whole thing ends with the player physically sitting in someone else's chair.
>
> The Director: _"Every season we tell you it's a game show. This week we're being honest: it's
> a hostile takeover, and you're the acquiring party. Try not to get expensed."_

**Status:** Proposed — design only, matching the linked spec and ADR. This document is the
**authored-content reference** (Content Designer layer: theme, plot, voice, quests-as-data,
set pieces, enemy identities, presentation). It does not define runtime systems.

- **System contract:** [`.specify/specs/floor5-hostile-takeover.md`](../../../.specify/specs/floor5-hostile-takeover.md)
  (`R1`–`R10`, `FR*`) — the authoritative behavioral, determinism, and acceptance contract.
- **Architecture:** [ADR 0094](../adr/0094-floor5-hostile-takeover.md) — cross-system ownership
  decisions and rejected alternatives.
- **Epic:** [`floor-5-hostile-takeover.epic.json`](../epics/floor-5-hostile-takeover/floor-5-hostile-takeover.epic.json)
  — the 8-slice, human-review-gated implementation graph this content bible feeds.
- **Canon:** [Lore Bible](lore-bible.md) — tone guide, The Director, sponsor companies, season
  quirks. This floor must read as an escalation of that voice, not a departure from it.

Tone stays load-bearing: dark comedy, never grimdark; the horror is bureaucratic; the violence
is somebody's KPI problem. Nothing below invents new lore about The Gradient, the Dungeon's
nature, or the timeline — it only extends the existing Director/sponsor/season-quirk machinery
to a siege.

---

## 1. Canonical status & provenance

This bible is grounded in three prior artifacts and is **new canon only where they leave a gap**
(named Hero identities, Director lines, set-piece dressing, and the declarative quest pack —
all Content Designer authority per persona doctrine):

| Claim in this document                                                                                                                                 | Traced to                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Floor identity, one-line pitch, "designed" status                                                                                                      | [`game-design-document.md`](game-design-document.md) §Floor Design, Floor 5 entry |
| Phase machine (`MUSTER → CONTEST → BUILD → ESCORT → BREACH → COURTYARD → THRONE → CAPTURED`, `DEFEAT`), terminal precedence, single-authority director | Spec `R1`–`R2`; ADR D1, D6, D7                                                    |
| Battlefield geometry (Command Post, Siege Yard, lane, flank pockets, checkpoints, wall, breach, courtyard, throne, balcony)                            | Spec `FR1.1`; ADR D2                                                              |
| Explicit teams, immutable wave manifests, isolated RNG streams                                                                                         | Spec `R3`, `R8`; ADR D3, D4                                                       |
| Field tasks, requisition milestones, stable quest goal IDs                                                                                             | Spec `R4`; ADR D5                                                                 |
| Ratings Ram lifecycle and atomic breach                                                                                                                | Spec `R5`; ADR D6                                                                 |
| Field Heroes, roles, Crown Auditor, Regent Emeritus                                                                                                    | Spec `R6`, `R7`                                                                   |
| Presentation/HUD/authored-static-content requirement                                                                                                   | Spec `R9`                                                                         |
| Headless/balance HUMAN_GATE surface                                                                                                                    | Spec `R10`; ADR D8                                                                |
| Floor 4 safe-room/boss/HUD conventions this floor extends or deliberately breaks from                                                                  | [`floor4-arena.md`](floor4-arena.md) §§3, 6, 7, 11                                |
| Season quirk and sponsor-company procedural framing                                                                                                    | [Lore Bible](lore-bible.md) §Season Quirks, §Sponsor Companies                    |

No conflicts were found between these sources while authoring this bible. If a future revision
of the spec or GDD contradicts a claim recorded here, that is a
[lore-contradictions.md](lore-contradictions.md) escalation, not a silent edit of either
document.

---

## 2. The fantasy (player-facing pitch)

You walk out of Floor 4's Winner's Circle and the set changes under your feet: siege banners,
a castle skyline, a klaxon. The Director's cold open: production has decided this week's
"content" is a **corporate acquisition of a sovereign castle**, and you're the hostile bidder.

There is one lane. Your side's minions push down it; the Regent's minions push back up it.
Neither side waits for you — the war is happening whether you fight in it or not, which is the
point: this floor is a **front you can swing, not a hallway you clear.** Two side pockets sit
off the lane where you do the _actual_ siege-craft: hold the Siege Yard, recover the Ratings
Ram's three components, break the forward checkpoint. Do all three and construction unlocks;
escort the Ram while it walks itself to the wall; survive its breach; clean out the courtyard;
beat the Regent; then physically sit down and take the win.

Losing has one true face: your **Command Post** (the forward HQ the network trucked in with
you) drops to zero health and the show cuts to black regardless of how far you got. Everything
else — a dead Hero, a destroyed Ram, a lost checkpoint — is a setback you recover from, not a
loss condition.

---

## 3. The satirical frame — literalized business jargon

Floor 4's satire is "venue content is cheaper than location content." Floor 5's satire is one
notch darker and stays in the same bureaucratic-horror lane the Tone Guide requires: **every
euphemism in the fiction is a real, physical thing on the map.**

- **"Hostile takeover"** is not a metaphor — you are besieging a castle by force to acquire it.
- **The Command Post** is the network's forward field office. Losing it isn't a metaphorical
  "loss of morale," it's the literal end of the broadcast; that's why it's the one unconditional
  fail state (spec `FR1.2`).
- **The Siege Yard** is a staging ground the network's logistics team insists on calling "the
  synergy site."
- **The Ratings Ram** is a battering ram branded like a sponsor activation — because it is one.
  Its job in-fiction is breaking down a wall; its job in the Director's pitch deck is "driving
  engagement through a physical breach event."
- **Field Heroes** are the Regent's department heads, doing exactly what a department head does
  under a hostile bid: stall, redirect, escalate, or personally intervene.
- **The Crown Auditor** is what it sounds like — the castle's internal-audit function, standing
  between "we breached the wall" and "we control the building."
- **Regent Emeritus** has already been informed the deal is happening. The throne fight is the
  Regent trying to negotiate from a position that no longer exists.
- **The Winner's Balcony** is the post-acquisition press conference, matching Floor 4's
  Winner's Circle beat (§10) — the show always closes on the audience, not the corpse.

Season quirks still apply and must stay distinct (Lore Bible §Season Quirks, per-persona
constraint): the Director's business-jargon bit is the floor's fixed voice, and the active
season quirk **flavors the delivery**, not the content. A "competitive baking" season has the
Director call the breach a "proof point"; a "true crime commentary" season has it narrate the
Regent's downfall like a cold-case reveal. The literal siege beats (§4) never change; only the
bit riding on top of them does. Concrete authored examples are out of scope for this bible
(quirk-conditional line variants are a Slice 7 data-authoring task) but the contract is recorded
here so it isn't invented ad hoc later.

> Director, `MUSTER`: _"Full disclosure, for legal: this is an unsolicited acquisition. The
> current management has not consented to the sale. We are, however, extremely capitalized."_

---

## 4. Plot & phase arc

The eight-phase machine below is the spec's `siegeDirectorSystem` state (`R2`); this section is
its **narrative reading**, not a re-specification. Content Designer owns the framing text below
each phase; Systems/Game Design own the transition mechanics behind it.

```
MUSTER    — cold open, briefing, lane and pockets go live
CONTEST   — opposing waves push the lane; field tasks open
BUILD     — Ram construction authorized once all task prerequisites latch
ESCORT    — Ram advances the authored route; player/allies protect it
BREACH    — atomic wall/collision/nav transaction; outer lane retires
COURTYARD — Crown Auditor momentum check; allied units hold the courtyard line
THRONE    — Regent Emeritus fixed encounter; defeat enables capture
CAPTURED  — throne-interaction transaction; Winner's Balcony opens
   ↳ DEFEAT is reachable from every non-terminal phase (Command Post to zero,
     player death, or the stall backstop — spec FR2.2, FR2.5)
```

**Beat-by-beat, player-facing:**

1. **`MUSTER`.** The Director's cold open names the acquisition. HUD reveals the battlefield;
   no combat yet.
2. **`CONTEST`.** The lane goes hot. Opposing minion waves push toward each other's structures
   (spec `FR3.4`); the player can fight the lane, work a flank pocket, or split time — the
   floor never demands one over the other. Task quests appear (§6).
3. **`BUILD`.** The moment the Siege Yard is secure, all three components are recovered, and the
   forward checkpoint is cleared, the Ram's construction authorizes (spec `FR4.5`). The
   Director announces authorization like a corporate approval, not a fanfare.
4. **`ESCORT`.** The Ram advances on its fixed route once its protection condition holds (spec
   `FR5.3`). The player's job flips from "push the lane" to "keep this thing alive."
5. **`BREACH`.** The wall opens exactly once, atomically (spec `FR5.6`). This is the floor's
   biggest single presentation beat (§9) — score it like Floor 4 scores a Headliner kill.
6. **`COURTYARD`.** Allied units hold at the authored line (spec `FR7.1`); the Crown Auditor is
   the only thing standing between the breach and the throne doors.
7. **`THRONE`.** Regent Emeritus, fixed and seeded, with bounded summons (spec `FR7.3`).
8. **`CAPTURED`.** One explicit interaction closes the deal (spec `FR7.4`/`FR7.5`, and see
   `HUMAN_GATE-7` below); Winner's Balcony opens, matching the Floor 4 Winner's Circle exit
   convention.

`DEFEAT` is never a cliffhanger. Command Post loss cuts the broadcast immediately and
resolves before same-tick progress (spec `FR2.2`) — the Director's line for this is written to
land as a network cutting its losses, not a monster-movie death (§8, §11).

---

## 5. The battlefield (set pieces)

One authored map, matching ADR D2's "one lane, semantic geometry" decision. Reachability for
every relevant footprint is a spec acceptance requirement (`FR1.1`, `FR10.5`), not a nice-to-have.

| Set piece                    | Read at a glance                                          | Content notes                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Command Post**             | Player's forward HQ; the one unconditional loss condition | Dressed as a hastily-trucked-in production trailer bolted onto castle-siege scaffolding — corporate infrastructure grafted onto a medieval front, which is the whole joke |
| **Siege Yard**               | First flank task pocket                                   | "Synergy site" signage, requisition crates, the literal staging ground for Ram components                                                                                 |
| **Primary lane**             | The contested MOBA-style push corridor                    | Reads as a real siege causeway: fortifications, forward checkpoint gate, kill zones                                                                                       |
| **Flank task pockets (x2)**  | Off-lane objective sites                                  | Component recovery pocket + checkpoint-clear pocket; both readable from the lane so the player can choose to detour                                                       |
| **Forward checkpoint**       | Ownership gates spawn/front line                          | Changes banner dressing on capture (spec `FR3.5`) so ownership reads without a HUD check                                                                                  |
| **Outer wall + breach site** | Where `ESCORT`/`BREACH` resolve                           | One authored breach point; pre-breach it is intact fortification, post-breach it is a permanent, dressed rubble gap — never a disappearing sprite (spec `FR8.4`)          |
| **Courtyard**                | Crown Auditor arena                                       | Bureaucratic dressing over castle-interior stone: ledgers, seal stations, "processing" signage befitting an audit function                                                |
| **Throne room**              | Regent Emeritus fixed encounter                           | The floor's authored dramatic peak; matches Floor 3/Floor 4 convention of a distinct final-encounter room, not a reused arena                                             |
| **Winner's Balcony**         | Victory landing + exit                                    | Press-conference dressing; mirrors Floor 4's Winner's Circle exit beat (stairs-equivalent)                                                                                |

Set-piece art and dressing follow the existing Set Piece Designer pipeline
(`set-piece-blockout` → `prop-inventory`/`prop-commission` → `set-piece-dress` →
`set-piece-review`) and are **out of scope for this document** — they are Slice 7 art work, not
lore text. This bible only fixes the semantic contract each room must honor.

---

## 6. Field tasks — declarative quest/objective plan

Field tasks are **authored data**, following the data-driven quest system (ADR 0011) and the
same pattern Floor 1/2 already use (`src/shared/data/quests.floor1.json`,
`quests.floor2.json`, `quests.floor2.dens.json`). No floor-5 quest logic may be hard-coded;
this bible defines the **shape**, and Slice 7 (Content Designer, per the epic) is where the real
`src/shared/data/quests.floor5.siege.json` pack is authored and validated against the schema.

The spec already names the nine stable goal IDs the quest layer must consume as **read-only
projections of system state** (spec `FR4.2`–`FR4.3`) — the quest pack must never re-derive or
duplicate that state as its own boolean:

`opening-push-repelled → yard-secured → components-ready → ram-built → checkpoint-cleared →
wall-breached → courtyard-cleared → regent-defeated → castle-captured`

Proposed pack shape (illustrative, not shipped by this document):

```json
{
  "version": 1,
  "packId": "floor5-siege",
  "quests": [
    {
      "id": "floor5-hold-the-line",
      "title": "Hold the Line",
      "summary": "Repel the opening push before it reaches the Command Post. The board is watching the first exchange closely.",
      "objectives": [
        {
          "id": "repel-opening-push",
          "label": "Repel the opening push",
          "kind": "goal",
          "goalId": "floor5.siege.openingPushRepelled"
        }
      ]
    },
    {
      "id": "floor5-secure-synergy",
      "title": "Secure the Synergy Site",
      "summary": "Take and hold the Siege Yard. Nothing gets built without it.",
      "objectives": [
        {
          "id": "secure-yard",
          "label": "Secure the Siege Yard",
          "kind": "goal",
          "goalId": "floor5.siege.yardSecured"
        }
      ]
    },
    {
      "id": "floor5-recover-components",
      "title": "Recover the Components",
      "summary": "Three component classes, one Ratings Ram. Recover all three from the flank pocket.",
      "objectives": [
        {
          "id": "components-ready",
          "label": "Recover all Ratings Ram components",
          "kind": "goal",
          "goalId": "floor5.siege.componentsReady"
        }
      ]
    },
    {
      "id": "floor5-clear-checkpoint",
      "title": "Clear the Forward Checkpoint",
      "summary": "The checkpoint gates construction as much as the components do. Clear it.",
      "objectives": [
        {
          "id": "checkpoint-cleared",
          "label": "Clear the forward checkpoint",
          "kind": "goal",
          "goalId": "floor5.siege.checkpointCleared"
        }
      ]
    },
    {
      "id": "floor5-escort-the-ram",
      "title": "Escort the Ratings Ram",
      "summary": "Construction's authorized. Now keep the thing alive until it opens the wall.",
      "onCompleteGoalFlag": "floor5-ram-escort-complete",
      "objectives": [
        {
          "id": "ram-built",
          "label": "Complete Ratings Ram construction",
          "kind": "goal",
          "goalId": "floor5.siege.ramBuilt"
        },
        {
          "id": "wall-breached",
          "label": "Breach the outer wall",
          "kind": "goal",
          "goalId": "floor5.siege.wallBreached"
        }
      ]
    },
    {
      "id": "floor5-the-courtyard",
      "title": "The Courtyard",
      "summary": "Clear the Crown Auditor's defenders before the throne doors will open.",
      "objectives": [
        {
          "id": "courtyard-cleared",
          "label": "Clear the courtyard",
          "kind": "goal",
          "goalId": "floor5.siege.courtyardCleared"
        }
      ]
    },
    {
      "id": "floor5-the-acquisition",
      "title": "Close the Acquisition",
      "summary": "Defeat the Regent, then walk up and take the chair. That's the whole deal.",
      "onCompleteGoalFlag": "floor5-castle-captured",
      "objectives": [
        {
          "id": "regent-defeated",
          "label": "Defeat Regent Emeritus",
          "kind": "goal",
          "goalId": "floor5.siege.regentDefeated"
        },
        {
          "id": "castle-captured",
          "label": "Capture the throne",
          "kind": "goal",
          "goalId": "floor5.siege.castleCaptured"
        }
      ]
    }
  ]
}
```

Registration follows the existing pattern: install the pack via `installQuestPacks` and drive
its progress through the generic `world.floorObjectiveTick` hook, never a new per-floor named
system. Quest **text** (titles, summaries, labels) is Content Designer authority; the
**goal IDs and the state they read** are Systems/Game Designer authority per §12 below — this
bible names the contract, not the wiring.

`HUMAN_GATE-1`: exact requisition-component fetch counts and checkpoint-clear conditions are a
balance/pacing call for the Game Designer (spec `FR4.4`–`FR4.5`). Recommended baseline,
matching Floor 2's `contested-tribute` pattern (`collectTarget: 5`) scaled down for a
single-floor front: **3 components, 1 checkpoint**, so `BUILD` reliably unlocks inside one
`CONTEST` phase without stalling the lane war.

---

## 7. The Ratings Ram

The floor's one MVP siege engine (spec `FR5.1`, ADR D5). Content identity, not mechanics:

- **Presentation:** a battering ram built out of visibly repurposed broadcast equipment —
  camera-truck armor plating, a sponsor decal wrap, a "LIVE" light on its prow that turns red
  the moment it starts advancing.
- **Voice hook:** every state transition gets a Director line (§8) so `LOCKED → BUILDING →
READY → ADVANCING → ATTACKING → BREACHED | DESTROYED` (spec `FR5.2`) is legible without
  reading the HUD.
- **Destruction is a setback, not a stop.** The rebuild path (spec `FR5.4`) is framed in-fiction
  as "the network eating the replacement cost," keeping the tone bureaucratic rather than
  tragic — nobody mourns a battering ram, they complain about the invoice.

`HUMAN_GATE-2`: Ram HP, escort protection-condition thresholds, advance speed, and
rebuild delay/cost are Game Designer balance calls (spec `FR5.4`, `FR10.4`). No baseline is
recommended here beyond the spec's own constraint that destruction must never soft-lock the
floor — that is a hard requirement, not a tuning suggestion.

---

## 8. The Director's voice (authored static content)

All Director dialogue on this floor is **authored static content**, per constitution Principle
6 and the persona's non-negotiable no-runtime-generation rule. Nothing below runs an LLM at
load time or in gameplay; these are hand-written lines that ship as data, in the same authored
style as `src/game/skills/registry.ts` and the Floor 1/2 achievement flavor already in the repo.

Representative lines per major beat (final line count, exact placement, and season-quirk
variants are Slice 7 authoring work — these establish voice, not the full script):

- **`MUSTER` (cold open):** _"Full disclosure, for legal: this is an unsolicited acquisition.
  The current management has not consented to the sale. We are, however, extremely
  capitalized."_
- **`CONTEST` (lane push begins):** _"Both sides are fielding headcount. Ours is cheaper.
  Theirs is angrier. Let's see which metric wins."_
- **Command Post under threat:** _"Somebody just put a dent in our forward office. I would
  like to remind the audience that our forward office is also our only office."_
- **`BUILD` authorized:** _"Construction is approved. I want to be clear that 'approved' means
  the paperwork cleared, not that anyone checked whether it was a good idea."_
- **Ram advancing (`ESCORT`):** _"The Ram is live and rolling. If you love this wall, now would
  be the time to say so — to it, not to me."_
- **Ram destroyed:** _"We are rebuilding. Insurance covers acts of contestant, apparently."_
- **`BREACH`:** _"The wall is open. I want everyone to appreciate that we just turned a
  structural engineering problem into a season highlight."_
- **Hero arrival:** _"Management is sending someone down personally. This is either very brave
  or very bad accounting."_
- **`COURTYARD` / Crown Auditor:** _"Before you go any further, someone from Compliance would
  like a word. I did tell them this wouldn't hold you up."_
- **`THRONE` opens:** _"The Regent is aware you're here. The Regent has, in fairness, been aware
  of this for several floors."_
- **`CAPTURED`:** _"The acquisition is complete. Please direct all press inquiries to me,
  personally, forever."_
- **`DEFEAT` (Command Post lost):** _"We are cutting our losses. Literally — that was the
  budget for the rest of this segment."_ — matching the Floor 4 convention (§10 of that bible)
  of the Director getting the last word and the loss landing as a production decision, not a
  monster kill.

Season quirks reflavor delivery on top of these fixed beats (§3); they do not replace them.
Achievement flavor for this floor follows `.github/instructions/flavor.instructions.md`
verbatim (unique per unlock, scaled to `basic`/`standard`/`hard`/`brutal`, tied to the exact
unlock fact) and ships as `achievements.floor5.json` in Slice 7 — out of scope for this bible
beyond naming the unlock hooks in §11.

---

## 9. Enemy Hero content identities

Field Heroes are boss-strength named defenders (spec `R6`), selected without replacement from
an **append-only, stably ordered roster** (spec `FR6.1`, `FR8.3`) — adding a Hero later must
append, never renumber. Each declares one tactical role per spec `FR6.2`; this bible assigns
names, flavor, and role coverage. HP, damage, ability numbers, and cadence are out of scope here
(Game AI Engineer + Game Designer, Slice 4).

| Order | Hero                          | Role               | Gimmick (one line)                                                                                     |
| ----- | ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| 1     | **The Turnaround Consultant** | counter-push       | Retakes lost ground and "restructures" (reinforces) whatever checkpoint it recaptures                  |
| 2     | **The Proxy Fighter**         | counter-push       | Leads the counter-wave personally; buffs nearby minions like a stock proxy rallying votes              |
| 3     | **Compliance Officer Vex**    | checkpoint defense | Anchors a checkpoint behind a slowing "audit zone" nobody is allowed to stand in                       |
| 4     | **The Notary**                | checkpoint defense | Layers paperwork-themed shield stacks that must be "filed" (broken) in sequence                        |
| 5     | **The Union Rep**             | engine disruption  | Calls a "wildcat strike" that stalls the Ram's advance for a telegraphed window                        |
| 6     | **Risk Assessment Karen**     | engine disruption  | Debuffs the Ram's escort rather than the Ram itself — asks to speak to the manager of your buffs       |
| 7     | **The Middle Manager**        | minion support     | Buffs and heals nearby minions; the fight gets meaningfully worse if this one is ignored               |
| 8     | **The Activist Investor**     | artillery          | Ranged Hero lobbing "hostile bids" from range, forcing repositioning like a shareholder forcing a vote |

Two fixed encounters sit outside the roster (spec `FR6.5`) and are never drawn into a field
slot:

- **The Crown Auditor** (`COURTYARD` momentum check) — the castle's internal-audit function,
  physically standing between the breach and the throne doors. Gimmick: periodic "line-item
  vetoes" that null a targeted buff or zone, framed as an audit finding rather than a spell.
- **Regent Emeritus** (`THRONE`, fixed, seeded per spec `FR7.3`) — the ousted ruler making a
  last stand from a position that, on paper, no longer exists. Bounded summons are framed as
  the Regent "calling in the board" — a golden-parachute cohort that retires with the encounter,
  never lingering past it (spec `FR7.3`).

`HUMAN_GATE-3`: field-Hero **respawn cadence and slot count** (how many field Heroes are active
at once, and how quickly a defeated one returns per spec `FR6.4`) is a balance call. Recommended
baseline: mirror Floor 4's Headliner-pool convention of **at least eight roster entries** (met
above) with **one active field Hero at a time**, escalating to two only if representative sweeps
(spec `R10`) show the single-Hero pressure is insufficient.

`HUMAN_GATE-4`: Hero strategic-mode selection weighting (how often a Hero picks counter-push vs.
checkpoint defense vs. engine disruption when its role allows more than one, per spec `FR6.3`)
is Game AI Engineer tuning, not content. This bible only fixes the declared role per Hero.

---

## 10. Throne-room finale

The throne room is Floor 5's distinct final-encounter set piece, matching the convention Floor 3
and Floor 4 both already use (a dedicated final room, not a reused arena — see
[`floor3-companion-league.md`](floor3-companion-league.md) §12 Final Four, and
[`floor4-arena.md`](floor4-arena.md) §6 Headliner 5/Showrunner).

**Sequence (spec `R7`):**

1. `COURTYARD` resolves only after the breach latch (spec `FR5.6`) — no shortcut, no early
   entry.
2. The Crown Auditor is a **momentum check**, not the finale. Defeating it and clearing the
   authored courtyard defenders opens the throne doors (`FR7.2`).
3. `THRONE` is Regent Emeritus: fixed, seeded, bounded summons, explicit telegraphs (`FR7.3`).
   This is the floor's authored dramatic peak and gets the heaviest, longest Director beat on
   the floor (§8) — the equivalent weight of Floor 4's Showrunner finale.
4. **Defeating the Regent does not end the floor.** A separate throne-capture interaction is
   required (`FR7.4`) — the player must physically walk up and take the chair. This is the
   floor's signature beat: the fight and the acquisition are two different verbs, on purpose
   (ADR D7), so a boss kill and a base loss can never collide into an ambiguous outcome on the
   same tick (spec `FR2.2`).
5. Capture clears hostile damage sources, records the outcome exactly once, and opens the
   Winner's Balcony (`FR7.4`), mirroring Floor 4's Winner's Circle → stairs exit.

`HUMAN_GATE-5`: **interaction vs. timed occupation** for the capture transaction is explicitly
undecided in the spec (`FR7.5`). Recommended baseline, carried forward from the spec's own
recommendation: **one explicit interaction** — legible, bounded, and headless-friendly, versus a
timed-occupation channel that adds a second clock the floor doesn't otherwise need.

`HUMAN_GATE-6`: Regent Emeritus's summon count/cap and telegraph timing are Game Designer /
Game AI Engineer balance, not content (spec `FR7.3`).

---

## 11. Win, lose & failure feel

Following the Floor 4 convention (§9 of that bible) of banking rewards as they happen and giving
the Director the last word:

- **Win:** capture the throne via the explicit interaction (§10) and take the Winner's Balcony
  exit.
- **Lose:** the Command Post reaches zero health, the player dies, or the stall backstop fires
  (spec `FR2.5`) — the only three ways this floor ends in `DEFEAT`. There is no partial-siege
  loss state; a dead Hero, a destroyed Ram, or a lost checkpoint is a setback, never a fail
  condition.
- **Failure feel:** a Command Post loss is framed as a production/budget decision (§8's `DEFEAT`
  line), not a monster kill — consistent with the Tone Guide's "horror is bureaucratic."
  Achievements earned mid-run (e.g., "breached the wall," "survived a Hero encounter") bank
  immediately rather than at the throne, matching Floor 4's precedent.

Proposed (illustrative, not shipped by this document) achievement hooks for
`achievements.floor5.json`, each mapped to an exact spec-level fact so flavor text can be
unique and requirement-specific per the flavor instructions:

| Achievement (working id) | Unlock fact                                                                                         | Difficulty |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ---------- |
| `floor5-first-breach`    | `wallBreached` goal fires for the first time                                                        | `standard` |
| `floor5-ram-survivor`    | Ram reaches `BREACHED` without ever being destroyed                                                 | `hard`     |
| `floor5-hero-hunter`     | Defeat every roster Hero at least once in one run                                                   | `hard`     |
| `floor5-the-acquisition` | `castleCaptured` fires                                                                              | `standard` |
| `floor5-clean-sweep`     | Capture the throne without the Command Post ever dropping below a `HUMAN_GATE`-defined health floor | `brutal`   |

`HUMAN_GATE-8`: the exact health-floor threshold for `floor5-clean-sweep` (and any other
numeric achievement threshold) is a balance call informed by the representative sweep in spec
`R10`, not a content decision.

---

## 12. Content/data boundaries & persona handoffs

This bible authors **content**; it does not authorize a system build. Ownership below mirrors
the epic's per-slice persona assignment exactly — this document is not a new decomposition, it
is the content lens on the existing one:

| Surface                                                                        | Owner                                         | Notes                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Siege phase machine, authored map, `siegeDirectorSystem`                       | Systems Engineer (Slice 1)                    | Content Designer supplies room semantics (§5), not the state machine                                   |
| Teams, minion lanes, waves, Command Post defense                               | Systems Engineer + Game AI Engineer (Slice 2) | Content Designer supplies no numbers here                                                              |
| Field tasks, requisition milestones, construction gating                       | Game Designer (Slice 3)                       | Content Designer supplies quest text/goal-ID contract (§6); numeric thresholds are `HUMAN_GATE-1`      |
| Field-Hero AI, roster wiring, respawn plumbing                                 | Game AI Engineer (Slice 4)                    | Content Designer supplies names/roles/flavor (§9); cadence is `HUMAN_GATE-3`/`HUMAN_GATE-4`            |
| Ratings Ram lifecycle, breach transaction                                      | Systems Engineer (Slice 5)                    | Content Designer supplies presentation identity (§7); numbers are `HUMAN_GATE-2`                       |
| Courtyard/throne encounters, capture transaction                               | Game Designer (Slice 6)                       | Content Designer supplies encounter identity and sequencing (§10); interaction model is `HUMAN_GATE-5` |
| **Quest pack, Director lines, HUD copy, achievements, set-piece art/dressing** | **Content Designer** (Slice 7)                | This bible is the source document for that slice; see §6, §8, §9, §11                                  |
| Integrated QA, performance, balance thresholds                                 | QA Engineer + Playtester (Slice 8)            | Every `HUMAN_GATE` in this document resolves here against representative-sweep evidence                |

Content Designer authority stops at data and voice: quest pack JSON, achievement JSON, Director
line text, HUD label copy, and set-piece dressing briefs. Any authored need that has no data
path (a new goal-ID, a new phase, a new system hook) is a Systems Engineer / Game Designer
ask, raised explicitly — never routed around by hard-coding floor logic, per this persona's
defining invariant.

---

## 13. Deterministic acceptance & real-game observation gates

This bible does not relax or restate the spec's acceptance bar; it names where content work
must show up as evidence, matching project rule 9 (observe-before-done) and the lab-gating
requirement every persona is bound by.

**Deterministic acceptance (spec `FR10.5`, unchanged, quoted for content-author visibility):**
zero unreachable required objectives, zero phase-order violations, zero invalid target
allegiances, zero navigation/collision mismatches, zero unbounded spawn debt, and every run in
the representative sweep terminates exactly once.

**Real-game observation (spec `FR9.5`/`R9`, the Slice 7 done condition this bible feeds):**
deterministic visual/runtime captures must prove, in the actual running game, not a lab in
isolation —

- primary-lane readability and opposing-wave direction without color-only cues (spec `FR9.3`)
- Hero salience on arrival and during strategic-mode switches
- Command Post danger state and the base-loss transition
- field-task/build progress state on the HUD
- Ram damage/destruction/rebuild states
- the persistent breach (never a flickering or ambiguous wall state)
- courtyard → throne escalation and the capture transaction
- the full Director voice arc from `MUSTER` cold open to `CAPTURED`/`DEFEAT` close

No slice in the epic — including the content/presentation slice this bible primarily feeds —
may claim done against a lab result alone. A lab is required (per this persona's constraints)
but is never sufficient; the named artifact is always a real windowed or headless pipeline
capture (AGENTS.md r9, spec `R9.5`).

`npm run verify:fast` and `npm run docs:check` are the deterministic gates for **this
docs-only change**: no runtime code exists yet for Floor 5, so there is nothing else to run.
Every future implementation slice adds its own headless/E2E/property gates per spec `R10.2` and
the epic's per-node done conditions.

---

## 14. HUMAN_GATE register (consolidated)

Every unresolved design/balance choice this bible touches, gathered in one place so none of them
gets silently decided during implementation:

| ID                                 | Decision                                                                                                   | Recommended baseline                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `HUMAN_GATE-1`                     | Requisition component fetch count / checkpoint-clear condition (§6)                                        | 3 components, 1 checkpoint                                                            |
| `HUMAN_GATE-2`                     | Ratings Ram HP, protection thresholds, advance speed, rebuild delay/cost (§7)                              | None — spec constrains only "never soft-locks"                                        |
| `HUMAN_GATE-3`                     | Field-Hero respawn cadence and concurrent-active-Hero count (§9)                                           | One active Hero at a time; escalate only if sweeps show insufficient pressure         |
| `HUMAN_GATE-4`                     | Hero strategic-mode selection weighting (§9)                                                               | None — AI tuning, not content                                                         |
| `HUMAN_GATE-5`                     | Throne capture: explicit interaction vs. timed occupation (§10)                                            | One explicit interaction (spec's own recommendation)                                  |
| `HUMAN_GATE-6`                     | Regent Emeritus summon cap/telegraph timing (§10)                                                          | None — encounter balance                                                              |
| `HUMAN_GATE-7`                     | Stall backstop duration (spec `FR2.5`)                                                                     | None — informed only by measured representative runs, never a player-facing countdown |
| `HUMAN_GATE-8`                     | Numeric achievement thresholds (e.g., Command Post health floor for `floor5-clean-sweep`) (§11)            | None — set from sweep evidence                                                        |
| _(spec `FR10.4`, carried forward)_ | Completion rate, median/p95 duration, base-health cushion, Ram survival/rebuild rate, entity/frame budgets | None — human-approved against representative GitHub-backed sweeps only                |

None of these are resolved by this document. Resolving any of them without representative-sweep
evidence and explicit human approval would be exactly the silent-balance-choice failure mode
this persona exists to prevent.

---

## 15. Cross-references

- **System contract:** [`.specify/specs/floor5-hostile-takeover.md`](../../../.specify/specs/floor5-hostile-takeover.md)
- **Architecture:** [ADR 0094](../adr/0094-floor5-hostile-takeover.md)
- **Epic:** [`floor-5-hostile-takeover.epic.json`](../epics/floor-5-hostile-takeover/floor-5-hostile-takeover.epic.json)
- **Prior handoff:** [`2026-08-30-floor5-hostile-takeover-design.md`](../handoffs/2026-08-30-floor5-hostile-takeover-design.md)
- **Tone / canon:** [Lore Bible](lore-bible.md)
- **Flavor voice rules:** [`.github/instructions/flavor.instructions.md`](../../../.github/instructions/flavor.instructions.md)
- **Prior floors:** [Floor 2 content bible](floor2-families-and-resources.md),
  [Floor 3 content bible](floor3-companion-league.md),
  [Floor 4 content bible](floor4-arena.md)
- **Genre framing:** [Game Design Document](game-design-document.md) — Floor 5's siege front is
  the GDD's stated escalation past Floor 4's fixed-arena format.

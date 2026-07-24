# Floor 3 — Companion Roster (≥50 species × 3 forms)

> The complete creature enumeration for Floor 3. Every creature is an **original invention**;
> only genre-common **mechanics** are borrowed (see the IP-safety statement in
> [`floor3-companion-league.md` §17](floor3-companion-league.md)). Systems, affinity matrix,
> style personas, and progression live in the
> [game-design doc](floor3-companion-league.md); schemas in
> [`.specify/specs/floor3-companion-league.md`](../../../.specify/specs/floor3-companion-league.md);
> architecture in [ADR 0071](../adr/0071-floor3-companion-league.md).

The roster is a **7 affinity × 7 style grid** = **49 base species**, plus **3 off-grid
signature species** = **52 species × 3 forms = 156 named forms**. Every affinity fields all 7
styles and every style appears in all 7 affinities, so there are **no dead cells** and
recruiting coverage always has an answer.

---

## 1. Naming system

Each species is a single evolutionary line with three form names that escalate in grandeur:

- **Baby (L1–9):** small/cute — an affinity "cute root" + a diminutive style suffix
  (`-kit`, `-cub`, `-tick`, `-pop`, `-nib`, `-shell`, `-wisp`).
- **Adolescent (L10–24):** an affinity root + a mid style suffix
  (`-dash`, `-maul`, `-flinger`, `-bloomer`, `-pouncer`, `-guard`, `-tender`).
- **Adult (L25–40):** an imposing affinity root + an adult style suffix
  (`-courser`, `-brute`, `-marksman`, `-nova`, `-stalker`, `-bastion`, `-mender`).

All names are original English portmanteaus. If any later collides with a trademark it is
freely renameable — no system depends on a specific string (only on stable `speciesId`s).

## 2. Milestones (recap — full detail in game-design doc §10)

- **Evolve:** Baby → Adolescent at **L10**; Adolescent → Adult at **L25**. Cap **L40**.
- **Abilities:** **L1** innate, **L8**, **L16**, **L25** adult signature, **L34**.
- Below, each species lists **Role** (its style) and its **Innate (L1) → Adult signature
  (L25)** ability pair; the L8/L16/L34 unlocks escalate the same affinity × style theme.
- **Stat archetype** is fixed by the **style** (see game-design doc §5 table) and is constant
  across all three forms — only the numbers scale per level. The Role column names it.

---

## 3. The affinity × style grid

### 3.1 Ember (strong vs Bloom, Stone · weak vs Gloom, Lumen)

| Style   | Baby (L1)  | Adolescent (L10) | Adult (L25)    | Role               | Innate → Adult signature   |
| ------- | ---------- | ---------------- | -------------- | ------------------ | -------------------------- |
| Charger | Emberkit   | Cinderdash       | Pyrocourser    | fast melee harasser| Ember Dash → Cinder Blitz  |
| Bruiser | Coalcub    | Slagmaul         | Magmabrute     | heavy melee anchor | Slag Slam → Magma Crush    |
| Slinger | Sparktick  | Cinderflinger    | Ashmarksman    | ranged skirmisher  | Spark Shot → Cinder Volley |
| Burster | Fizzlepop  | Emberbloomer     | Pyronova       | AoE crowd-clear    | Ember Burst → Pyre Nova    |
| Pouncer | Flarenib   | Blazepouncer     | Infernostalker | ambush assassin    | Flare Pounce → Inferno Ambush |
| Warden  | Slagshell  | Forgeguard       | Emberbastion   | guardian / tank    | Cinder Guard → Forge Wall  |
| Kindler | Warmwisp   | Hearthtender     | Solacemender   | support            | Warm Mend → Hearthsong     |

### 3.2 Bloom (strong vs Stone, Gale · weak vs Ember, Lumen)

| Style   | Baby (L1) | Adolescent (L10) | Adult (L25)    | Role               | Innate → Adult signature    |
| ------- | --------- | ---------------- | -------------- | ------------------ | --------------------------- |
| Charger | Sproutkit | Vinedash         | Thorncourser   | fast melee harasser| Vine Dash → Thorn Rush      |
| Bruiser | Budcub    | Bramblemaul      | Timberbrute    | heavy melee anchor | Bramble Slam → Timber Crush |
| Slinger | Seedtick  | Thornflinger     | Sporemarksman  | ranged skirmisher  | Seed Shot → Spore Volley    |
| Burster | Sporepop  | Petalbloomer     | Bloomnova      | AoE crowd-clear    | Petal Burst → Bloom Nova    |
| Pouncer | Fernnib   | Vinepouncer      | Bramblestalker | ambush assassin    | Vine Pounce → Bramble Ambush|
| Warden  | Barkshell | Thicketguard     | Grovebastion   | guardian / tank    | Bark Guard → Grove Wall     |
| Kindler | Dewwisp   | Petaltender      | Verdanmender   | support            | Dew Mend → Verdant Bloom    |

### 3.3 Stone (strong vs Gale, Tide · weak vs Ember, Bloom)

| Style   | Baby (L1) | Adolescent (L10) | Adult (L25)  | Role               | Innate → Adult signature   |
| ------- | --------- | ---------------- | ------------ | ------------------ | -------------------------- |
| Charger | Pebblekit | Gritdash         | Slatecourser | fast melee harasser| Grit Dash → Slate Rush     |
| Bruiser | Cobblecub | Rubblemaul       | Bouldbrute   | heavy melee anchor | Rubble Slam → Boulder Crush|
| Slinger | Shardtick | Cobbleflinger    | Cragmarksman | ranged skirmisher  | Shard Shot → Crag Volley   |
| Burster | Gravelpop | Geodebloomer     | Quakenova    | AoE crowd-clear    | Gravel Burst → Quake Nova  |
| Pouncer | Chipnib   | Boulderpouncer   | Cragstalker  | ambush assassin    | Chip Pounce → Crag Ambush  |
| Warden  | Slateshell| Bulwarkguard     | Granibastion | guardian / tank    | Slate Guard → Bedrock Wall |
| Kindler | Mosswisp  | Cairntender      | Bedrockmender| support            | Moss Mend → Cairn Ward     |

### 3.4 Gale (strong vs Tide, Gloom · weak vs Bloom, Stone)

| Style   | Baby (L1) | Adolescent (L10) | Adult (L25)   | Role               | Innate → Adult signature   |
| ------- | --------- | ---------------- | ------------- | ------------------ | -------------------------- |
| Charger | Gustkit   | Zephyrdash       | Squallcourser | fast melee harasser| Gust Dash → Squall Rush    |
| Bruiser | Draftcub  | Blustermaul      | Cyclobrute    | heavy melee anchor | Bluster Slam → Cyclone Crush|
| Slinger | Breezetick| Gustflinger      | Windmarksman  | ranged skirmisher  | Breeze Shot → Gale Volley  |
| Burster | Puffpop   | Squallbloomer    | Tempestnova   | AoE crowd-clear    | Puff Burst → Tempest Nova  |
| Pouncer | Wispnib   | Galepouncer      | Stormstalker  | ambush assassin    | Wisp Pounce → Storm Ambush |
| Warden  | Gustshell | Windguard        | Aeribastion   | guardian / tank    | Gust Guard → Aegis Wind    |
| Kindler | Zephwisp  | Breezetender     | Skymender     | support            | Zeph Mend → Sky Chorus     |

### 3.5 Tide (strong vs Gloom, Lumen · weak vs Stone, Gale)

| Style   | Baby (L1) | Adolescent (L10) | Adult (L25)   | Role               | Innate → Adult signature      |
| ------- | --------- | ---------------- | ------------- | ------------------ | ----------------------------- |
| Charger | Dripkit   | Rippledash       | Surgecourser  | fast melee harasser| Ripple Dash → Surge Rush      |
| Bruiser | Brinecub  | Wavemaul         | Torrentbrute  | heavy melee anchor | Wave Slam → Torrent Crush     |
| Slinger | Splashtick| Brineflinger     | Tidemarksman  | ranged skirmisher  | Splash Shot → Tide Volley     |
| Burster | Bubblepop | Surgebloomer     | Maelnova      | AoE crowd-clear    | Bubble Burst → Maelstrom Nova |
| Pouncer | Minnownib | Tidepouncer      | Deepstalker   | ambush assassin    | Minnow Pounce → Deep Ambush   |
| Warden  | Clamshell | Reefguard        | Tidalbastion  | guardian / tank    | Clam Guard → Reef Wall        |
| Kindler | Mistwisp  | Springtender     | Brinemender   | support            | Mist Mend → Springtide        |

### 3.6 Gloom (strong vs Lumen, Ember · weak vs Gale, Tide)

| Style   | Baby (L1) | Adolescent (L10) | Adult (L25)   | Role               | Innate → Adult signature |
| ------- | --------- | ---------------- | ------------- | ------------------ | ------------------------ |
| Charger | Murkkit   | Shadedash        | Duskcourser   | fast melee harasser| Shade Dash → Dusk Rush   |
| Bruiser | Motecub   | Grimmaul         | Umbrabrute    | heavy melee anchor | Grim Slam → Umbral Crush |
| Slinger | Hushtick  | Shadeflinger     | Nightmarksman | ranged skirmisher  | Hush Shot → Night Volley |
| Burster | Blightpop | Murkbloomer      | Voidnova      | AoE crowd-clear    | Blight Burst → Void Nova |
| Pouncer | Shadownib | Gloompouncer     | Duskstalker   | ambush assassin    | Shadow Pounce → Dusk Ambush |
| Warden  | Cryptshell| Hushguard        | Umbrabastion  | guardian / tank    | Crypt Guard → Umbra Wall |
| Kindler | Dimwisp   | Vigiltender      | Wanemender    | support            | Dim Mend → Waning Ward   |

### 3.7 Lumen (strong vs Ember, Bloom · weak vs Tide, Gloom)

| Style   | Baby (L1) | Adolescent (L10) | Adult (L25)   | Role               | Innate → Adult signature  |
| ------- | --------- | ---------------- | ------------- | ------------------ | ------------------------- |
| Charger | Glimkit   | Gleamdash        | Flarecourser  | fast melee harasser| Gleam Dash → Flare Rush   |
| Bruiser | Glowcub   | Radimaul         | Solarbrute    | heavy melee anchor | Radi Slam → Solar Crush   |
| Slinger | Beamtick  | Glimflinger      | Prismmarksman | ranged skirmisher  | Beam Shot → Prism Volley  |
| Burster | Glintpop  | Flarebloomer     | Solnova       | AoE crowd-clear    | Glint Burst → Solar Nova  |
| Pouncer | Flashnib  | Gleampouncer     | Dawnstalker   | ambush assassin    | Flash Pounce → Dawn Ambush|
| Warden  | Prismshell| Lightguard       | Aurabastion   | guardian / tank    | Prism Guard → Aura Wall   |
| Kindler | Dawnwisp  | Halotender       | Radimender    | support            | Dawn Mend → Radiant Hymn  |

---

## 4. Signature species (3 off-grid rares)

These are **rare, non-grid** lines used as **starter-exclusive offers and Final Four aces**.
Each has a **dual thematic identity** but a single mechanical affinity (its **primary**, for
matrix purposes) and a single style, so the matrix stays well-defined. They are **not** part of
the 7×7 coverage math.

| # | Line (Baby → Adolescent → Adult)          | Primary affinity (style) | Theme                | Role note                     |
| - | ----------------------------------------- | ------------------------ | -------------------- | ----------------------------- |
| 1 | Glimmurk → Duskglow → **Eclipsewyrm**     | Gloom (Pouncer)          | eclipse (light+dark) | Final Four ace; burst assassin|
| 2 | Windripple → Squallsurge → **Tempestryn** | Gale (Burster)           | storm-front (wind+water) | Final Four ace; AoE storm  |
| 3 | Emberpebble → Magmacrag → **Volcanix**    | Ember (Bruiser)          | volcano (fire+earth) | signature starter; anchor brute|

**Total: 49 grid + 3 signature = 52 species × 3 forms = 156 named forms.**

---

## 5. Coverage & balance audit

### 5.1 Affinity coverage (every affinity has all 7 styles)

| Affinity | Charger | Bruiser | Slinger | Burster | Pouncer | Warden | Kindler | Total |
| -------- | :-----: | :-----: | :-----: | :-----: | :-----: | :----: | :-----: | :---: |
| Ember    |    ✓    |    ✓    |    ✓    |    ✓    |    ✓    |   ✓    |    ✓    |   7   |
| Bloom    |    ✓    |    ✓    |    ✓    |    ✓    |    ✓    |   ✓    |    ✓    |   7   |
| Stone    |    ✓    |    ✓    |    ✓    |    ✓    |    ✓    |   ✓    |    ✓    |   7   |
| Gale     |    ✓    |    ✓    |    ✓    |    ✓    |    ✓    |   ✓    |    ✓    |   7   |
| Tide     |    ✓    |    ✓    |    ✓    |    ✓    |    ✓    |   ✓    |    ✓    |   7   |
| Gloom    |    ✓    |    ✓    |    ✓    |    ✓    |    ✓    |   ✓    |    ✓    |   7   |
| Lumen    |    ✓    |    ✓    |    ✓    |    ✓    |    ✓    |   ✓    |    ✓    |   7   |

### 5.2 Style coverage (every style has all 7 affinities)

Each of the 7 styles appears in exactly **7 species** (one per affinity), so every fighting
persona is available on every Temperament. There are **no dead cells** and no over-represented
style. Combined with the balanced 2-regular affinity matrix (game-design doc §4.1), every
recruiting decision has a reachable coverage answer — the intended anti-degenerate property for
the 90%+ Floor-win target.

### 5.3 Recruiting-coverage note

Because a locked party is only **6** creatures but there are **7** affinities, a team can never
hold every Temperament. The design intent: players cover their **two predators** (the affinities
that are ⊕ against most of their team) via the matrix, using **Wardens/Kindlers** to survive
off-type matchups rather than hard-countering everything. Seeded Studios (game-design doc §13)
field a themed core + one off-type curveball specifically to test this.

---

## 6. Cross-references

- **Systems, matrix, styles, progression:** [`floor3-companion-league.md`](floor3-companion-league.md)
- **Schemas + epic decomposition:**
  [`.specify/specs/floor3-companion-league.md`](../../../.specify/specs/floor3-companion-league.md)
- **Architecture:** [ADR 0071](../adr/0071-floor3-companion-league.md)

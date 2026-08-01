# Set-Piece Interior Lookbook

Reference study set for Crawler's interiors, transcribed from two curated pixel-art
interior lookbooks — a 50-example craft study and a 36-plate image-forward visual
lookbook. It exists so the **Set Piece Designer** agent and the **visual judge**
critique against a named bar instead of generic "add more detail".

**Projection match:** the lookbook's craft framing calls out **3/4 top-down
projection** on **16x16 tiles**. That matches Crawler's presentation, but set-piece
authoring uses **`FEET_PER_TILE = 4`** from
`scripts/agent/set-piece/composition-score.ts`; do not derive room scale from the 16px
editor sprite size. The top-down entries still transfer directly.

> **Attribution caveat (second lookbook).** Its plate attributions are unreliable:
> several plates reuse the _same_ image under different game credits, and its own
> source notes admit a number of plates are "representative AI study plates" rather
> than real screenshots. Treat its images as **visual specimens**, never as
> citations, and never repeat a game attribution from it. Its _synthesis_ section is
> the durable part and is what is folded in below.

> The lookbooks contain **no numeric density guidance**. The thresholds in
> `scripts/agent/set-piece/composition-score.ts` are therefore ballpark v1 values,
> not lookbook-derived. Retuning them against measured reference rooms is open work.

## The five principles that drive our gate

1. **Floorplans first, decoration second.** The strongest interiors make path,
   exits, counters, beds, stairs and the focal object readable _before_ any detail
   work. This is why the agent must produce a blockout before it places a prop.
   The second lookbook's reading key states the same study order outright:
   _circulation and focal points first, then furniture silhouettes, palette,
   lighting, tile rhythm, clutter density, environmental storytelling._
2. **Furniture is the fastest storytelling layer.** Props imply job, class, mood and
   routine with no text. A clinic reads as a clinic because of shelves, a work desk,
   beds and IV stands — not because of a sign.
3. **Prop clusters, not scattered singles.** Good rooms cluster furniture and
   deliberately avoid empty floor dead zones. Corollary from the second lookbook:
   _cluster detail around function, keep traversal areas cleaner._
4. **Limited palette + lighting pools carry mood.** Modern pixel interiors add
   lighting without abandoning readability; pools of light focus attention on the
   interaction point. Light pools also _rank_ importance — hearth, altar, counter,
   terminal, bed.
5. **Mass against the walls, middle kept readable.** The most consistent law across
   the whole study set, and the one that separates hand-made rooms from generated
   ones. Link's House rings bed/chests/shelves/pots around a bare rug; Crono's room
   anchors bed, desk and shelf to walls and leaves the floor clear; the Moonlighter
   shop stacks every display against the perimeter with a single focal counter in
   the open. Enforced by the `wall-anchoring` check — and **all twelve of Crawler's
   pre-existing slop rooms score 0% on it**, which is exactly why their furniture
   reads as scattered rather than placed.

## Palette by room job

From the second lookbook's synthesis, useful when writing a room art contract:

| Room job          | Palette signature                   |
| ----------------- | ----------------------------------- |
| Homes             | warm wood                           |
| Temples / sacred  | cool stone, or high contrast        |
| Labs / industrial | metal + glow                        |
| Civic / public    | readable neutrals with accent zones |

Two craft laws worth quoting directly:

- **Top-down lesson:** _object silhouettes matter more than perspective realism._
  Beds, tables, counters and shelves must read from above at thumbnail size.
- **Retro vs modern:** retro rooms use fewer props and stronger icon silhouettes;
  modern rooms add decor density, lighting nuance and personalization **while
  preserving walkable lanes**. Crawler targets the modern end — which is the
  density the gate encodes — but the walkable-lane constraint is non-negotiable and
  is why `circulation` is a hard check.

## Study set by need

| Need                            | Study                                                                                      | Why                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Floorplan clarity, tile economy | A Link to the Past, Secret of Mana, Stardew Valley, Moonlighter, Potion Permit, Littlewood | Best top-down room-layout grammar                |
| Depth, occlusion, staged volume | Super Mario RPG, Landstalker, Light Crusader, Shadowrun, Children of Morta                 | Isometric; study composition, **not** footprints |
| Retro grammar + modern lighting | Eastward, Sea of Stars                                                                     | Retro tiles with a modern lighting system        |
| Dread via restraint             | SIGNALIS, OMORI (White Space)                                                              | Limited palette, sparse props, absence as design |

> **Caution:** isometric entries are inspiration for clutter density and prop
> vocabulary only. Their footprints do not translate to Crawler's top-down grid.

## Archetype references

Mapped to the room types the Set Piece Designer must serve.

### Floor entrance / threshold

- **A Link to the Past — Sanctuary:** axial layout, altar focus, strong threshold.
- **Chrono Trigger — Guardia Court Room:** courtroom symmetry and a long aisle create
  drama; carpet strips and seating blocks guide the eye.
- **Secret of Mana — Water Palace:** ceremonial symmetry, open floor, cool blues.

Takeaway: entrances want **axial symmetry, a strong threshold, and a carpet//aisle
runner that points at the focal object**.

### Welcome room / production set

- **Undertale — shops (Bratty & Catty, Burgerpants, Gerson):** shop interiors are
  _character stages_; portrait, counter and background compress into an instantly
  readable retail vignette.
- **Final Fantasy VI — Opera House:** auditorium, backstage and rafters create a
  layered performance space; rich reds/golds communicate spectacle.
- **Moonlighter — Moonlighter Shop:** shelving, counter and customer paths are the
  entire design.

Takeaway: a production set is **a stage, not a room** — frame the NPC, light the
interaction point, and let signage/banners do the talking.

### Boss den

- **FF6 — Magitek Research Facility:** pipes, machines and corridors imply production
  flow; metal palettes and repeated machine tiles build menace.
- **Thieves' Town:** "town-as-dungeon" room sequencing; darker palette separates
  danger from village coziness.
- **SIGNALIS — Penrose/facility rooms:** cramped rooms heighten unease; low light,
  tight contrast and sparse props amplify threat.
- **Hyper Light Drifter — hub interiors:** ceremonial and alien; saturated limited
  palettes with glowing accents create hierarchy.

Takeaway: boss dens invert the density rule — **sparser, darker, higher contrast**,
with one monumental focal object and glowing accents for hierarchy.

### Settlement / civic

- **Kakariko Village interiors:** compact domestic retail; small props communicate
  class and use without text.
- **Roots of Pacha — PachaHearth:** hearth-centred planning; earth tones, cooking
  props and organic shapes soften grids.
- **Children of Morta — Bergson house:** rugs, hearths and warm light stage
  relationships.
- **CrossCode — Rookie Harbor shops:** retail counters and NPC clusters clarify
  services; saturated zones keep busy rooms navigable.

Takeaway: settlements are **hearth-centred** — cluster around a warm focal object and
use zone colour to keep a busy room navigable.

### Earth artifacts jammed into the dungeon

- **EarthBound — Ness's House:** mundane bedroom/kitchen language grounds the fantasy;
  simplified modern furniture reads at tiny scale.
- **EarthBound — Fourside department store:** escalators, counters and shopping zones
  create public-space density; checker floors and signage boost navigation.
- **EarthBound — Snow Wood Boarding School:** dorm/school structure creates believable
  routine; repeated beds/desks imply order.
- **FF6 — Phantom Train:** narrow carriage rooms create procession; repeated windows,
  benches and doors establish vehicle logic.
- **Stardew Valley — Sam's/Vincent's rooms:** bedrooms as character portraits; limited
  props carry identity clearly.

Takeaway: this is the archetype Crawler leans on hardest. **Mundane specificity is the
whole joke** — the room must be aggressively ordinary so the dungeon around it lands.
Repetition (benches, desks, lockers) is legitimate _here_ because it encodes
institutional routine, but it still needs wear and asymmetry to avoid reading as a
stamped grid.

### Density and clutter reference

- **Eastward — Potcrock rooms:** cramped, practical rooms; **dense prop layering**
  supports lived-in texture.
- **Eastward — Alva's lab:** reads through workstations and invention clutter.
- **Stardew Valley — Kent & Jodi's room:** furniture clusters avoid empty floor dead
  zones.
- **UNSIGHTED — Arcadia workshops:** top-down action readability stays strong despite
  detail.

Takeaway: **density and readability are not in tension** when clutter is clustered
into workstations rather than sprinkled evenly.

## Full 50-example index

| #   | Game / era                   | Scene / archetype                           | View                   | ID takeaway                                                         | Pixel takeaway                                                        |
| --- | ---------------------------- | ------------------------------------------- | ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | A Link to the Past (SNES)    | Link's House / home                         | Top-down               | One-room clarity; bed, chest and exit establish function instantly  | Strong object silhouettes, warm browns, minimal clutter               |
| 2   | A Link to the Past (SNES)    | Sanctuary / sacred civic                    | Top-down               | Axial layout, altar focus, strong threshold                         | Repeated floor/wall tiles create calm rhythm                          |
| 3   | A Link to the Past (SNES)    | Hyrule Castle / circulation                 | Top-down               | Corridors, rooms and stairs teach navigation                        | High wall contrast and modular rooms support readability              |
| 4   | A Link to the Past (SNES)    | Kakariko interiors / homes + shops          | Top-down               | Compact domestic retail layouts                                     | Small props communicate class and use without text                    |
| 5   | A Link to the Past (SNES)    | Thieves' Town / urban dungeon               | Top-down               | "Town-as-dungeon" room sequencing                                   | Darker palette separates danger from village coziness                 |
| 6   | Chrono Trigger (SNES)        | Guardia Court Room / civic authority        | Top-down               | Courtroom symmetry and long aisle create drama                      | Carpet strips and seating blocks guide the eye                        |
| 7   | Chrono Trigger (SNES)        | Guardia kitchen / quarters                  | Top-down               | Service spaces make the castle feel lived-in                        | Small utility props diversify stone interiors                         |
| 8   | Chrono Trigger (SNES)        | Arris/Proto Dome / ruined sci-fi            | Top-down               | Sparse broken infrastructure sells collapse                         | Cool grays, dark gaps and machinery clusters imply age                |
| 9   | Final Fantasy VI (SNES)      | Opera House / theater                       | Top-down + staged side | Auditorium, backstage, rafters create layered performance space     | Rich reds/golds and stage framing communicate spectacle               |
| 10  | Final Fantasy VI (SNES)      | Magitek Research Facility                   | Top-down               | Pipes, machines and corridors imply production flow                 | Metal palettes and repeated machine tiles build menace                |
| 11  | Final Fantasy VI (SNES)      | Phantom Train / vehicle corridor            | Top-down               | Narrow carriage rooms create procession                             | Repeated windows, benches and doors establish train logic             |
| 12  | Final Fantasy VI (SNES)      | Owzer's House / manor gallery               | Top-down               | Mansion rooms use art objects as storytelling anchors               | Rich interior tiles contrast with darker supernatural beats           |
| 13  | EarthBound (SNES)            | Ness's House / suburban home                | Top-down               | Mundane bedroom/kitchen language grounds the fantasy                | Simplified modern furniture reads at tiny scale                       |
| 14  | EarthBound (SNES)            | Fourside department store                   | Top-down               | Escalators, counters and shopping zones create public-space density | Checker floors + signage boost navigation                             |
| 15  | EarthBound (SNES)            | Snow Wood Boarding School                   | Top-down               | Dorm/school structure creates believable routine                    | Muted winter palette, repeated beds/desks imply order                 |
| 16  | Secret of Mana (SNES)        | Dwarf Village / underground civic hub       | Top-down               | Curved village-in-cavern feel                                       | Warm cave palette plus furniture tiles soften the underground         |
| 17  | Secret of Mana (SNES)        | Water Palace / temple                       | Top-down               | Ceremonial symmetry and open floor space                            | Cool blues and clean stone tiling signal sacred water                 |
| 18  | Secret of Mana (SNES)        | Pandora Castle                              | Top-down               | Formal rooms and battlements support courtly scale                  | Repeated stone and carpet tiles maintain legibility                   |
| 19  | Secret of Mana (SNES)        | Moon Palace / abstract temple               | Top-down               | Surreal negative space as architecture                              | Sparse high-contrast shapes make the interior feel alien              |
| 20  | Super Mario RPG (SNES)       | Mushroom Kingdom castle + town rooms        | Isometric              | Chunky furniture and diagonal rooms feel toy-like                   | Pre-rendered/isometric look gives volume and shadows                  |
| 21  | Super Mario RPG (SNES)       | Booster Tower                               | Isometric              | Vertical gag-space packed with props                                | Strong diagonals and oversized objects improve depth cues             |
| 22  | Super Mario RPG (SNES)       | Marrymore chapel + hotel                    | Isometric              | Ceremonial aisle and hospitality rooms                              | Patterned floors and bright trim separate zones                       |
| 23  | Landstalker (Genesis)        | Dungeons/towns                              | Isometric              | Stacked platforms turn rooms into puzzles                           | Shadows and tile edges are essential for judging height               |
| 24  | Light Crusader (Genesis)     | Tavern, item shop, inn                      | Isometric              | Everyday rooms before dungeon descent                               | Angled counters and furniture test occlusion management               |
| 25  | Shadowrun (SNES)             | Grim Reaper Club, mortuary, office          | Isometric              | Noir/corporate rooms tell story through function                    | Dark palettes and signage define gritty mood                          |
| 26  | Stardew Valley (modern)      | 1 Willow Lane kitchen/living room           | Top-down               | Cozy domestic zoning                                                | Warm woods, small decor, character-scale furniture create intimacy    |
| 27  | Stardew Valley (modern)      | Kent & Jodi's room                          | Top-down               | Bedroom props imply family and routine                              | Furniture clusters avoid empty floor dead zones                       |
| 28  | Stardew Valley (modern)      | Sam's/Vincent's rooms                       | Top-down               | Bedrooms as character portraits                                     | Limited props carry identity clearly                                  |
| 29  | Eastward (modern)            | Potcrock domestic rooms                     | Top-down / 3/4         | Cramped, practical rooms fit subterranean society                   | Dense prop layering supports lived-in texture                         |
| 30  | Eastward (modern)            | Alva's lab                                  | Top-down / 3/4         | Lab reads through workstations and invention clutter                | Retro-pixel artwork plus modern lighting adds depth                   |
| 31  | CrossCode (modern)           | Cargo Hold / sci-fi vehicle                 | Top-down / 3/4         | Industrial corridor logic with containers and machines              | Clean 16-bit-inspired readability supports action puzzles             |
| 32  | CrossCode (modern)           | Rookie Harbor shops                         | Top-down / 3/4         | Retail counters and NPC clusters clarify services                   | Saturated zones keep busy rooms navigable                             |
| 33  | Moonlighter (modern)         | Moonlighter Shop / merchant floor           | Top-down               | Shelving, counter and customer paths are the whole design           | Merchandise icons double as gameplay readability                      |
| 34  | Moonlighter (modern)         | Vulcan's Forge / workshop-store             | Top-down               | Craft station as focal object                                       | Warm forge palette and tool silhouettes make function obvious         |
| 35  | Moonlighter (modern)         | The Wooden Hat / tavern-retail              | Top-down               | Hospitality layout with counter and seating                         | Wood tones and object repetition build cozy commerce                  |
| 36  | Sea of Stars (modern)        | Tavern + Wheels table spaces                | Top-down / 3/4         | Leisure rooms break adventure pacing                                | Dynamic lighting and rich color create modern "retro-plus" atmosphere |
| 37  | Sea of Stars (modern)        | Cooking/rest interiors                      | Top-down / 3/4         | Food, rest and conversation zones make towns feel usable            | Lighting pools focus attention on interaction                         |
| 38  | SIGNALIS (modern)            | Penrose/facility rooms                      | Top-down               | Cramped ship/facility rooms heighten unease                         | Low light, tight contrast and sparse props amplify threat             |
| 39  | SIGNALIS (modern)            | Institutional corridors/classrooms          | Top-down               | Repeated institutional rooms become oppressive                      | Limited palette and shadows improve dread and readability             |
| 40  | Undertale (modern)           | Toriel/Home-style rooms                     | Top-down               | Simple home rooms teach warmth and safety                           | Tiny furniture and flat silhouettes maximize clarity                  |
| 41  | Undertale (modern)           | Shops (Bratty & Catty, Burgerpants, Gerson) | Top-down / hybrid      | Shop interiors are character stages                                 | Portrait, counter and background compress into readable vignettes     |
| 42  | OMORI (modern)               | White Space / abstract room                 | Top-down               | Extreme minimalism makes one object feel monumental                 | Black/white contrast shows how absence can be design                  |
| 43  | OMORI (modern)               | Neighbor's Room / dream clubhouse           | Top-down               | Childlike gathering room with playful zoning                        | Colorful tilesets contrast with horror-adjacent spaces                |
| 44  | Hyper Light Drifter (modern) | Hub interiors / ruined sanctuaries          | Top-down / bird        | Interiors feel ceremonial and alien                                 | Saturated limited palettes and glowing accents create hierarchy       |
| 45  | UNSIGHTED (modern)           | Arcadia workshops/rooms                     | Top-down               | Functional sci-fi rooms emphasize tools and terminals               | Top-down action readability stays strong despite detail               |
| 46  | Children of Morta (modern)   | Bergson family house                        | Isometric / angled     | Family home as narrative hub                                        | Rugs, hearths and warm light stage relationships                      |
| 47  | Chained Echoes (modern)      | Castles/taverns                             | Top-down / 3/4         | Classic RPG public/private room grammar                             | 16-bit style supports nostalgia while allowing modern density         |
| 48  | Roots of Pacha (modern)      | Community PachaHearth                       | Top-down               | Hearth-centered planning sells prehistoric community                | Earth tones, cooking props and organic shapes soften grids            |
| 49  | Potion Permit (modern)       | Clinic / medical service                    | Top-down               | Two-section layout: desk/supplies plus patient beds                 | Medical props and beds make purpose unmistakable                      |
| 50  | Littlewood (modern)          | Tavern / Grand Library / shops              | Top-down               | Modular town interiors for services and collection                  | Clean room footprints and furniture sets are excellent tile reference |

## Room grammar template

The single most useful tool for escaping the "box of props" failure mode. Before
writing the blockout, fill this template — it forces story-first thinking before a
single tile is assigned.

```
ROOM TYPE:   <archetype: Floor entrance / Welcome room / Boss den / Settlement / Earth artifact>
NARRATIVE:   <one sentence starting with "The player ___s here" — the room as a verb>
PRIMARY:     <the one prop the room is about — the focal object>
SECONDARY:   <two to four props that serve, contrast with, or lead the eye to primary>
VIGNETTES:   <two to four named clusters, e.g. "reading corner", "guard post", "ritual area">
COMPOSITION: <axial / clustered / radial / corner-led / organic>
MOOD:        <two to three words — forgotten, sacred, grimy, domestic, industrial, festive, …>
BREATHING:   <one zone that is intentionally EMPTY and why — "mid-aisle: player must cross it">
```

A room with no answer for NARRATIVE is not ready to design. A room with no answer
for BREATHING will end up wall-to-wall clutter that reads as noise.

## Composition modes

Each mode implies a default spatial grammar. Choosing one at blockout prevents the
agent from inventing random placement.

| Mode           | Grammar                                                                                             | Typical archetype                          |
| -------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Axial**      | One axis of symmetry; a runner/aisle pointing at the focal object from the entrance                 | Floor entrance, threshold, ceremonial room |
| **Clustered**  | 2–4 workstation groups separated by navigable corridors; the focal object anchors the largest group | Welcome room, workshop, settlement         |
| **Radial**     | Focal object at the centre; props and zones ring it; player approaches from the perimeter           | Ritual space, boss den, altar room         |
| **Corner-led** | The heaviest mass sits in one corner; the rest of the room opens away from it                       | Boss den variant, arcane study             |
| **Organic**    | No dominant axis; mass clusters emerge from the fiction (hearth, forge, stacked cargo)              | Earth-artifact room, lived-in settlement   |

**Axial rooms feel ceremonial; organic rooms feel inhabited.** Using axial for an
Earth-artifact scene produces a living room that looks like a throne room. Using
organic for a floor entrance produces a mess the player reads as a corridor, not
a gateway. Match mode to archetype.

## Vignette vocabulary

A vignette is a **named functional cluster** — 3–7 props that have a relationship with
each other and together tell a micro-story. Good rooms have 2–4 vignettes separated by
breathing room. Bad rooms have props.

Name vignettes after their function, not their contents:

| Vignette name    | Implied props                                               | Story it tells                         |
| ---------------- | ----------------------------------------------------------- | -------------------------------------- |
| Reading corner   | Chair + floor lamp + stack of books + cold coffee           | Someone studies here; interrupted      |
| Abandoned dinner | Table + plates + overturned cup + flies                     | Something made them leave mid-meal     |
| Guard post       | Stool + empty bottle + club + faded roster on wall          | Maintenance without discipline         |
| Ritual area      | Circle on floor + candles + ash + torn notes                | Something was attempted here           |
| Crafting station | Workbench + materials + half-finished item + reference book | Active production, functional disorder |
| Service counter  | Counter + register + stool behind + signage                 | Commerce, transaction, performance     |
| Recovery nook    | Cot + bandages + water jug + dim lamp                       | Someone sleeps here out of necessity   |
| Trophy wall      | Mounted heads / framed notices + trophy + empty bracket     | Pride, status, aspiration              |

A vignette that could appear in any room is not a vignette — it is furniture. Force the
props to encode the specific fiction: an abandoned dinner in a dungeon guard post has
a torn ration package and a clay cup, not a tablecloth and a wine glass.

## Negative space as design

The gate checks for density (≥22% of tiles). It has no ceiling. This is the right
call for CI — but it has trained agents to keep adding props until the number
turns green. The better mental model:

> **Negative space is where the story happens.**

The player must _cross_ the empty aisle to reach the chest. The _gap_ between the
guard post and the ritual circle implies they do not look at each other. The open
floor in front of the altar is where the player stands to trigger the encounter.

Required: every blockout must name at least one zone that is intentionally empty
and state why the emptiness serves the fiction or the gameplay. Zones without a
reason for being empty are candidates for dressing; zones with a reason are protected.

## Second specimen set — dungeon, castle, and adventure grammar

A 50-study set of orthographic JRPG-style interiors grouped by dungeon/adventure
function. These are visual specimens (not real game screenshots); use them for spatial
grammar and composition patterns, not as citations.

### Domestic foundations (5 specimens)

Craftsman warmth, urban compactness, farmhouse utility, attic geometry, sunken
conversation space.

**Patterns:** hearth or table as focal object; mass distributed along two or three
walls, middle held clear for circulation; vignettes cluster around function (cooking,
seating, sleeping) with gaps between them.

### Domestic character (5 specimens)

Tatami restraint, family clutter, winter quiet, 1970s density, tiny-home optimization.

**Patterns:** culture-specific prop vocabulary; tatami rooms are sparser, 1970s rooms
are denser; small-space optimization forces every prop to serve two purposes.

### Specialty rooms (5 specimens)

Bathing ritual, family circulation, creative mess, conservatory abundance, modular
futurism.

**Patterns:** a dominant surface (bath, drawing table, planting bench) anchors the
room; clutter radiates from it rather than being scattered across the floor.

### Rooms that tell stories (5 specimens)

Private library, shared childhood, rehearsal space, ceramic workshop, storm-facing
dining room.

**Patterns:** props carry narrative weight — books mid-fall, two sets of toys in one
room, a chair pulled to the window. Every prop has been placed _by_ a character, not
_into_ a room.

### Dungeon grammar (5 specimens)

Entry threshold, water traversal, root invasion, readable traps, circular ritual
staging.

**Patterns for Crawler:**

- **Entry threshold:** axial composition, single strong axis from door to focal object;
  the room reads as a gate, not a destination; decoration defers to structure.
- **Water traversal:** the environmental hazard IS the composition; props orient around
  safe tiles; the path is the focal point.
- **Root invasion:** organic overgrowth breaks the room's original function; props show
  two eras in tension (dungeon infrastructure + encroaching nature).
- **Readable traps:** geometry telegraphs danger; props cluster AWAY from the trap zone
  leaving it unnervingly bare; the player notices the absence.
- **Circular ritual staging:** radial composition, focal object at centre, props ring
  it; entrance is framed to deliver the player to the perimeter before the reveal.

### Castle functions (5 specimens)

Ceremonial power, barracks order, feast logistics, arcane study, sacred ruin.

**Patterns for Crawler:**

- **Ceremonial power:** axial, long aisle, throne/altar focal, everything subordinate;
  scale signals authority — the focal prop must be 3× the median.
- **Barracks order:** repetition is deliberate; beds/benches in rows; wear and
  personalization break the grid (one overturned boot, one scratched name).
- **Feast logistics:** long table is the room; everything else is peripheral; seating
  implies attendance.
- **Arcane study:** clustered composition, 2–3 workstations (reference, experiment,
  storage) in organic arrangement; the disorder is ORGANIZED — each vignette has
  internal logic.
- **Sacred ruin:** sparse; the room was once ceremonial (traces of axial structure)
  but collapse has created organic asymmetry; darkness and emptiness are the design.

### Adventure support spaces (5 specimens)

Tavern flow, guild planning, forge production, recovery, defensible treasure storage.

**Patterns for Crawler:**

- **Tavern flow:** counter separates service from customer; seating clusters in 2–3
  groups; a hearth or stage creates a secondary focal point; the room has two
  clear circulation routes.
- **Guild planning:** a table with a map IS the room; everything else supports it;
  chairs around the table encode authority positions.
- **Forge production:** heat source is the focal object; workbenches radiate from it;
  raw material, in-process, and finished goods occupy distinct zones.
- **Recovery:** low light, horizontal surfaces (cots), a service point (bandages, water);
  the room's mood is exhaustion, not activity.
- **Defensible treasure storage:** the room is designed to be hard to cross; the chest/
  vault is visible but separated; layout creates tactical tension.

### Exotic adventure spaces (5 specimens)

Light puzzles, frozen ceremony, clockwork control, living architecture, open-sky
astronomy.

**Patterns for Crawler (Earth-artifact tone):**

- **Light puzzles:** the room's mechanic IS its art — reflectors, prisms, or switches
  visible at a glance; the focal object is the light source or its target.
- **Frozen ceremony:** a ritual interrupted mid-action; props in process-state (candle
  still burning, chalice raised); the composition is axial but a single prop is
  displaced.
- **Clockwork control:** a panel or console is the focal object; all other props serve
  or connect to it; cables/pipes are the circulation clues.

## Related

- Gate implementation: `scripts/agent/set-piece/composition-score.ts`
- Agent: `.github/agents/set-piece-designer.agent.md`
- Sprite style ground truth: `docs/agent-os/sprite-style.md`

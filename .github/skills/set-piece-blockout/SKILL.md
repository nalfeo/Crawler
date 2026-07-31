---
name: set-piece-blockout
description: >-
  Plan a set-piece interior as a floorplan before any prop is placed: purpose,
  archetype, zone graph, circulation, focal point, and the room art contract that
  every commissioned prop will inherit. Use when starting a new set piece, when
  redesigning a room that "looks like AI slop", or when a room fails the composition
  gate on focal point / circulation / placement asymmetry. This is always the FIRST
  step of the Set Piece Designer loop — placing props before blockout is what
  produces scattered-props-in-a-box.
---

# Set-Piece Blockout

> "Strong interiors read as **floorplans first, decoration second**."
> — `docs/knowledge/game-design/set-piece-lookbook.md`, principle 1

Blockout is the step that carries the taste. Everything downstream (which art to
reuse, which art to commission, where things go) is derived from it. Output is a
short written plan, not JSON.

## Output contract

Produce all six, in session chat, before touching `set-pieces.json`:

1. **Purpose** — one sentence on what the player does here and what they feel.
2. **Archetype** — one of the five below; drives the density profile.
3. **Zone graph** — 3–6 named zones with tile extents, e.g.
   `service counter (x2-7, y1-3)`, `customer queue (x2-7, y4-5)`,
   `back-of-house (x8-9, y1-6)`. Zones must tile the room; leftover space is a
   dead zone and is itself a finding.
4. **Circulation** — the ≥2-tile-wide path connecting every door and NPC anchor.
   State it as a route through the zones. The gate enforces this.
5. **Focal point** — the one prop the eye lands on first, its zone, and its
   footprint in feet. It must be ≥2.5x the median prop footprint.
6. **Room art contract** — the thing that makes commissioned props cohere:
   - **palette subset** (which colors this room is allowed to use)
   - **light direction** (e.g. "top-left, from the window in zone C")
   - **shadow convention** (e.g. "soft contact shadow, 1px, down-right")
   - **tile-scale class** (the size band props in this room occupy, in feet)
   - **wear/era** (e.g. "1990s, grimy, fluorescent")

The art contract is the highest-leverage output. Without it each prop is generated in
isolation against the global style guide, which is precisely why a room of
individually-good sprites still fails to cohere.

## Archetypes and their density profiles

Crawler needs five. Each inverts or amplifies the default density target
(22% occupancy). Lookbook references for each are in the lookbook's "Archetype
references" section — read the matching one before blocking out.

| Archetype                         | Density  | Composition rule                                                                                                | Study                                           |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Floor entrance / threshold**    | Standard | Axial symmetry; a runner/aisle pointing at the focal object; strong threshold                                   | ALTTP Sanctuary, Chrono Trigger Court Room      |
| **Welcome room / production set** | High     | It is a _stage_, not a room: frame the NPC, light the interaction point, let signage/banners talk               | Undertale shops, FF6 Opera House, Moonlighter   |
| **Boss den**                      | **Low**  | Inverts the rule — sparser, darker, higher contrast, one monumental focal object, glowing accents for hierarchy | SIGNALIS, Magitek Facility, Hyper Light Drifter |
| **Settlement / civic**            | High     | Hearth-centred; cluster around a warm focal object; zone colour keeps a busy room navigable                     | Roots of Pacha, Children of Morta, CrossCode    |
| **Earth artifact**                | High     | Mundane specificity is the joke — aggressively ordinary so the dungeon around it lands                          | EarthBound, FF6 Phantom Train, Stardew bedrooms |

> **Boss dens are the documented exception.** If you are blocking out a boss den,
> say so explicitly and expect the occupancy check to fight you. Resolve it by
> concentrating mass in the focal object and dressing the perimeter, _not_ by
> lowering the threshold. If a boss den genuinely cannot pass, escalate to the human
> for an archetype-specific threshold set — do not edit `DEFAULT_THRESHOLDS`
> unilaterally (project rule #11).

## Every set piece is a room, not a rectangle of floor

A set piece **owns its own shell**. Before zoning anything, lay down:

1. **A complete wall ring** — every perimeter tile of the footprint carries a `wall`
   (or `door`) prop. No gaps.
2. **At least one `door` prop, on that ring.** A door in the interior is a decorative
   sprite, not an entrance — the `shell-integrity` check rejects it, and `nyc-bodega`
   shipped exactly that bug (a lone door at (4,5) in a 9×7 room).

This is not decoration. Under the prefab-room map-gen model, map-gen carves the room
to this footprint and connects corridors to the declared door slots, so the shell
becomes real collision. A gapped ring has nothing to carve against; a ring with no
door is a **sealed, unreachable room** — on a generated floor that is an unwinnable
seed.

**Door slots come in two modes.** Pin a door when the fiction demands it (a shop's
street entrance, a boss den's single approach). Otherwise declare the eligible edges
and let map-gen choose whichever connects most straightforwardly — dynamic slots give
the generator room to make sensible corridors instead of forcing awkward ones.

Place doors where a real building would: on a wall the outside can plausibly reach,
not tucked behind the focal object, and never where perimeter dressing or bulk
furniture blocks the tile in front of them. Circulation must connect every door to
every NPC anchor.

## Method

1. **Name the fiction first.** "A 1990s video rental store" gives you shelving runs,
   a counter with a CRT, a return slot, carpet tiles, and poster walls for free.
   Vague fiction ("a shop") produces vague rooms.
2. **Program the space like a real building.** Every real interior has service,
   circulation and occupancy zones. A shop has a counter, a customer side, and a
   back-of-house. A clinic has a desk/supplies section and a patient-bed section.
   Write the program, then assign tiles to it.
3. **Draw circulation before furniture.** Reserve the ≥2-tile-wide route first; what
   is left is the dressable area. Doing it the other way round is how clutter ends up
   walling off a door.
4. **Pick the focal object and oversize it.** Counter, altar, forge, wrecked bus,
   throne. It anchors the composition and satisfies the focal-point check.
5. **Push detail — and mass — to the edges.** Perimeter dressing is 60% of the gate's
   edge check and is what turns a box into a place: shelving, trim, posters, stacked
   crates, pipes, radiators. Bulk furniture belongs there too: `wall-anchoring`
   requires ≥60% of large props to touch the perimeter ring. Assign your big objects
   to walls **in the blockout**, not as a fix-up during dressing. Reserve the middle
   for movement, encounters, and at most one focal cluster.
6. **Write the art contract last**, derived from the fiction and the archetype.

## Anti-patterns

- **Bulk furniture floating in open floor.** The defining tell of a generated room —
  all twelve of Crawler's pre-existing slop rooms anchor **zero** large props to a
  wall. If your blockout puts a counter, bed or shelving run in open floor, redo it.
- **Symmetric everything.** Symmetry is for ceremonial/threshold rooms. Elsewhere it
  reads as machine-placed and will fail the placement-asymmetry check.
- **Even distribution.** Props sprinkled evenly across the floor. Real rooms cluster
  into workstations with negative space between them.
- **Zones that do not tile the room.** Unassigned space becomes a dead zone.
- **A focal point that is merely central.** Being in the middle is not being the
  subject; it must be visually dominant.
- **Deferring the art contract.** If you commission props before declaring the
  contract, they will not cohere and you will re-roll art you already paid for.

## Done when

You can state purpose, archetype, zones, circulation, focal point and art contract in
one paragraph, and every tile of the room belongs to a zone. Then proceed to
`prop-inventory`.

## Related

- `docs/knowledge/game-design/set-piece-lookbook.md`
- `.github/skills/prop-inventory/SKILL.md` (next step)
- `scripts/agent/set-piece/composition-score.ts` (what the blockout must satisfy)

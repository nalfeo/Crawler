---
name: set-piece-dress
description: >-
  Place, stack, vary and wear props until a set piece passes the deterministic
  composition gate. Use after `set-piece-blockout` (and alongside `prop-commission`
  while art generates), when asked to "dress this room", "make it feel lived-in",
  "add clutter", or when `npm run setpiece:score` reports failing checks. This is the
  inner loop of the Set Piece Designer and where most of the work happens.
---

# Set-Piece Dress

Dressing is score-driven: place, run the gate, read the failures, re-dress. The gate
is not a rubber stamp at the end — it is the feedback signal you iterate against.

```bash
npm run setpiece:score -- <id>          # eleven checks with per-check remediation
npm run setpiece:score -- <id> --json   # machine-readable
```

**Precondition:** a completed blockout. Dressing without zones produces scattered
props, which is the failure mode this whole loop exists to eliminate.

## Dress by vignette, not by prop type

The blockout produced a vignette list. The dress loop is **not** "add props until
density is green" — it is "dress each vignette until it tells its micro-story, then
check the score."

The order matters:

1. **Dress the focal vignette first** — the cluster containing the focal object. This
   is where the room's identity lives. Get it right before touching the perimeter.
2. **Dress the secondary vignettes** — each should encode a specific story beat, not
   just fill space.
3. **Dress the perimeter** — shelving, trim, posters, radiators. This is the last
   step, not the first.
4. **Protect the breathing room** — the intentionally empty zone from the blockout is
   protected. Do not fill it even if density is failing.

**If density is failing after all vignettes are dressed,** the vignettes are too
sparse, not the room. Add depth to each vignette (stacking, clutter on surfaces) before
adding new props in the open floor.

### Vignette dressing heuristics

Each vignette should pass a "could you name it?" test: if a screenshot shows only
that cluster in isolation, would you recognize it as the intended vignette?

- A **reading corner** should show a resting surface, a light source, reading material,
  and at least one sign of use (half-read, bookmarked, worn).
- A **guard post** should show a duty position (stool/chair facing outward), evidence
  of occupancy (container, weapon rack) and evidence of neglect or anxiety
  (overturned cup, scratched marks).
- A **crafting station** should show the raw material, the tool, and the product in
  three stages.
- A **service counter** should show the transaction surface, what is being sold, and
  the service position.

If a vignette cannot pass the "could you name it?" test, it needs either more specific
props or a different vignette identity.

Set-piece authoring uses **`FEET_PER_TILE = 4`** from
`scripts/agent/set-piece/composition-score.ts`; do **not** derive room scale from the
16px editor sprite size. A prop with no `widthFt`/`heightFt` is contain-fit to its tile
extent — it renders at whatever size the grid implies, not the size the object should
be. Twelve of thirteen shipped rooms declare feet on **zero** props; the one curated
room declares them on all of them. This is the single largest cause of "props don't feel
like they fit".

Reference sizes (real-world, feet):

| Object       | w × h     | Object       | w × h   |
| ------------ | --------- | ------------ | ------- |
| Wall sconce  | 1.5 × 1.5 | Dining chair | 2 × 2   |
| Bar stool    | 1.5 × 1.5 | Desk         | 5 × 2.5 |
| Doorway      | 3 × 7     | Shop counter | 8 × 2.5 |
| Refrigerator | 3 × 2.5   | Bookshelf    | 3 × 1.5 |
| Single bed   | 3 × 6.5   | Area rug     | 8 × 5   |
| Human NPC    | 4 × 5     | Crate        | 2 × 2   |

Sanity check: a chair must never out-measure a refrigerator.

## The five levers, mapped to the checks

### 1. Density → `occupancy` (≥22% of tiles)

Structure does not count: `floor` and `wall` props are excluded, so a tiled floor and
a wall ring score zero. Only `door`/`fixture`/`furniture`/`decoration`/`actor` count.

Cluster into **workstations**, not an even sprinkle: a desk with a chair, a lamp, a
mug and a stack of paper is one cluster worth more than five props spread across the
floor. Leave deliberate negative space between clusters — the lookbook's density
references (Eastward, Stardew) are dense _and_ readable precisely because clutter is
clustered.

### 2. Stacking → `stacking` (≥15% of occupied tiles carry 2+ props)

Nest things. Every surface wants something on it:

- rug **under** table **under** plate **under** crumb
- shelf → books → bookend → dust
- counter → register → receipt spike → coffee cup

Use multiple `layers[]` on one prop for a composite object, or overlapping props on
the same tile for independently authored clutter. This is the cheapest large gain
available — the shipped rooms sit at 0–10%.

### 3. Edge treatment → `perimeter` (≥60% of wall-adjacent tiles dressed)

The perimeter is where "box" becomes "place". A bare `wall` prop does **not** count —
the check requires actual dressing: shelving, posters, trim, pipes, radiators,
stacked crates, coat hooks, signage, wainscoting. Shipped rooms sit near 0%.

### 4. Variety → `floor-variety` (≥3 distinct floor sprites, none >70%)

A single floor sprite stamped across every tile is the loudest generated-art tell in
the pack — all thirteen rooms do exactly this. Scatter variants: cracks, stains, worn
boards, a drain, a patch of different tile. Distribute them irregularly; a checker
pattern is just a different kind of uniform.

### 5. Asymmetry → `anti-grid` (<40% of props in runs of 4+)

Break straight, evenly spaced lines. Tools available in the schema:

- `offsetXFt` / `offsetYFt` — nudge a prop off-grid
- fractional `x` / `y` — place between tiles
- `rotationDeg` — a slightly turned chair
- `flipX` — mirror so paired props are not identical
- `tintHex` — subtle variation across repeated props

Institutional rooms (classroom desks, train benches, lockers) legitimately repeat —
repetition encodes routine. Even there, vary wear and nudge a few items so the row
reads as used rather than stamped.

## Push the mass to the walls

`wall-anchoring` requires **≥60% of large props** (at or above the room's median
footprint) to touch the perimeter ring. This is the single strongest signal separating
hand-made interiors from generated ones — all twelve of Crawler's pre-existing slop
rooms score **0%** on it, which is precisely why their furniture reads as scattered.

Bulk furniture — counters, beds, shelving, ovens, chalkboards, coolers, benches —
belongs against a wall. The open middle is for movement, encounters, and at most one
focal cluster. If a room genuinely wants a monumental object dead centre (a boss den
altar, a throne), that is the _one_ exception: keep every other large prop anchored so
the ratio still clears, and do not touch the threshold.

## Do not break play

Two checks are hard failures and no amount of visual polish excuses them:

- **`circulation`** — a ≥2-tile-wide path must connect every door and NPC anchor.
  `wall`, `fixture` and `furniture` are solid; `decoration` is not, so prefer
  `decoration` for floor clutter you do not want blocking movement.
- **`anchor-sanity`** — no NPC or door may sit inside a solid prop.

If dressing breaks either, the dressing is wrong. Never solve it by moving the anchor
somewhere illogical.

## Loop

1. Place a cluster.
2. `npm run setpiece:score -- <id>`.
3. Read the `detail` line of each failing check — each one names the specific fix.
4. Re-dress the weakest check first.
5. Repeat until 11/11.
6. Hand to `set-piece-review` for the subjective pass.

**Never loosen a threshold to go green** (project rule #11). `DEFAULT_THRESHOLDS` are
v1 ballpark values; retuning them is a deliberate, reference-backed exercise with the
human, never a way to pass a room.

## Anti-patterns

- **Scoring only at the end.** The gate is a feedback loop, not an exam.
- **Padding density with floor props.** They are excluded; it does nothing.
- **A wall ring to pass the perimeter check.** Walls are excluded too.
- **Uniform clutter.** Even distribution reads as generated no matter the count.
- **Ignoring the median.** Dropping many tiny props raises density but can sink the
  focal-point ratio. Watch the whole report, not one line.
- **Treating the density floor as a target to overshoot.** The gate has a floor
  (22%) but no ceiling. A measured redress of `welcome-room` hit 63% occupancy,
  passed every check it was scored against, and rendered _worse_ than the room it
  replaced — wall-to-wall clutter reads as noise, not curation. Land near the floor
  and add only what the room's story needs.
- **Filling pending art with a plausible-but-wrong `placeholder`.** Using a shop
  table as a stand-in for eight crates produced eight mini shop-tables ringing the
  room. Omitting `placeholder` entirely — an honest grey pending-art block — reads
  better and does not lie about the finished composition.
- **Reusing an off-palette catalog sprite because it is the right kind.** Grey
  stone/cave/sewer floor tiles dropped into a warm orange carpet read as _holes in
  the floor_. Palette compatibility is a hard requirement for floor art; commission
  in-palette variants instead.

## Done when

`npm run setpiece:score -- <id>` reports 11/11, every non-floor prop declares feet, and
the room still matches the blockout's zones and circulation.

## Related

- `.github/skills/set-piece-blockout/SKILL.md` (precondition)
- `.github/skills/set-piece-review/SKILL.md` (next step)
- `scripts/agent/set-piece/composition-score.ts`
- `src/shared/set-piece-types.ts` — `SpriteLayer` (`offsetXFt`, `widthFt`, `rotationDeg`, `tintHex`)

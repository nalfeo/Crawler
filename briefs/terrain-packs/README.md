# Terrain-Pack Brief Vocabulary

This is a **reusable prompt-vocabulary reference**, not an executable sprite
brief. It documents what to ask for when requesting source art for a future
terrain pack (e.g. a hand-touched-up wall material, or an alternate floor
biome). It is **not** wired into `npm run sprites:run` and contains no `.yaml`
files, so `sprites:run --all` (which globs `briefs/**/*.yaml`) never picks it
up and no Azure call is ever triggered by its presence. No prompt in this
doc has been sent to a model as part of this session — the `industrial-cave`
and `caeles-fixture` packs shipped by this feature are, respectively, a
deterministically-authored procedural build script
(`scripts/sprites/terrain-packs/build-industrial-cave.ts`) and an imported
CC0 fixture (`scripts/sprites/terrain-packs/build-caeles-fixture.ts`) — neither
used this vocabulary or an image-generation call.

## Why a separate vocabulary instead of a single-sprite brief

The existing `briefs/**/*.yaml` pipeline (see `briefs/README.md`) asks a model
for **one finished sprite** (or a small NxM sheet of orientation variants) and
runs it through slicing/sensors/selection. A terrain pack is structurally
different: it is a **47-mask blob-autotile wall atlas** plus a **floor-variant
pool**, a **corridor-variant pool**, and an **exact 4-piece door kit**
(`open/closed × horizontal/vertical`) — four independent surfaces with very
different counts and layouts, assembled deterministically by
`scripts/sprites/terrain-packs/` (quadrant-kit composition for an authored
pack, or explicit cell-to-mask assignment for an imported fixture).

**Never ask a model to lay out the final indexed 47-cell sheet directly.**
Mask→frame assignment, atlas grid geometry, and seam/edge validation are all
owned by our own deterministic tooling (`src/shared/terrain-pack-mask.ts`,
`scripts/sprites/terrain-packs/atlas-grid.ts`, `validate.ts`) so that the
result is provably complete (all 47 canonical masks present, no
duplicates) and testable. A model asked to "draw a 47-mask wall tileset" has
no way to guarantee that contract and its output could not be validated
deterministically. Instead, request the **raw material components** below and
let the checked-in tooling assemble/validate them.

## Vocabulary — request these components, separately

When drafting a request (human-authored prompt, or a future `type: tile`-like
brief family if one is added for terrain-pack source material), ask for:

1. **Wall material** — the base surface look for a single wall segment: what
   it's made of (rock, brick, rusted metal panel, etc.), primary/secondary
   color, surface texture (rough-hewn, smooth-cut, corroded), and any
   ambient detail (moisture streaks, rust bloom, moss). Describe it as a
   flat, edge-agnostic material sample — not as a specific mask shape.
2. **Edge/corner treatment** — how a wall segment's silhouette should read at
   an open edge (a crack, a rounded weathered lip, a sharp man-made cut) vs.
   at an inner concave corner (how two intersecting walls should visually
   join — a beveled inset, a support strut, a shadowed crevice). This is
   vocabulary for the _style_ of edge, not a request to draw any specific one
   of the 47 masks.
3. **Floor variants** — 3-5 short prompts for subtle floor-surface variety
   within the same material family (e.g. "same stone floor with a hairline
   crack," "same floor with scattered pebble debris," "same floor with a
   faint water stain") — variety for visual interest while walking across a
   floor, not different materials.
4. **Corridor variants** — same idea as floor variants, but for the
   (visually distinct, often narrower/worn-looking) corridor surface —
   corridors read as "well-traveled" vs. floors reading as "room interior."
5. **Door kit** — exactly four states, no more: open-horizontal,
   open-vertical, closed-horizontal, closed-vertical. Describe material
   consistency with the wall pack. **Locked-door art is explicitly out of
   scope** — do not request a locked/barred variant.
6. **Accent/decal kit** (optional) — small non-structural overlay details
   (a wall-mounted pipe stub, a scorch mark, a warning stencil) that a
   future overlay system could stamp independently of the base wall mask.
   Keep these separate from the wall material itself so they can be composed
   optionally rather than baked into every mask variant.

## What NOT to request

- A final indexed/labeled 47-cell sheet — mask→frame assignment is owned by
  `scripts/sprites/terrain-packs/atlas-grid.ts`, never inferred from a model's
  layout.
- Locked-door art — out of scope per the approved terrain-pack design.
- A single "topology" or "theme" description that conflates wall/floor/
  corridor/door into one coarse request — the per-surface contract
  (`src/shared/terrain-pack-types.ts`'s `terrainPackDefSchema`) always treats
  these as four independent surfaces.

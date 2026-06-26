# ADR 0024: Set Piece Themed Rooms

## Status

Accepted

## Date

2026-06-25

## Estimated Complexity

🍎 x 4 — new config-pack sub-system + viewer lab + tests; establishes conventions
that future map-gen and the sprite/art pipeline will build on, but no ECS system
and no map-gen wiring yet.

## Context

Crawler's fiction is a reality-show dungeon stitched together from chunks of
Earth. We want **"set pieces"**: hand- or LLM-authored rooms that read like real
locales — Jimmy's NYC pizza joint, a doctor's office, a blue-collar break room.
We will eventually need _hundreds_ of them, so the model must be:

- **Config-driven and deterministic.** LLMs may draft set pieces, but they ship
  as validated static "packs" (exactly like quests), never generated at runtime.
- **Flexible on sizing.** Some set pieces are a specific, fixed-footprint locale
  ("Jimmy's", exact 8×6). Others are reusable _kits_ that should fill a range of
  room sizes ("doctor's office", "blue-collar office").
- **Honest about art.** A prop's sprite may already exist in the catalog, may be
  an existing spritesheet frame we want to "record", or may be **custom art that
  does not exist yet** — which must render as a placeholder until generated.
- **Composable.** Authors must be able to layer sprites (a flower pot on a table
  is a flower-pot sprite stacked on a table sprite).

This ADR covers the data model only. Map-generation integration is explicitly
out of scope for now.

## Decision

Add a `src/shared/set-piece-types.ts` module mirroring the quest-pack pattern:
Zod-validated **packs** → compiled **registry**, with `installSetPiecePacks` /
`installDefaultSetPiecePacks` so additional (e.g. LLM-authored) packs can be
swapped in without code changes. Bundled content lives in
`src/shared/data/set-pieces.json` and ships **12 set pieces** spanning food,
retail, transit, medical, office, domestic, services, and education themes.

Key model choices:

- **Sizing** is a discriminated `exact | themed`. `width/height` is the footprint
  for `exact` and the _minimum_ for `themed`; `maxWidth/maxHeight` bound a themed
  kit's largest extent. `getSetPieceFootprint()` returns the max extent.
- **Props** carry a semantic `kind` (`floor | wall | door | fixture | furniture |
decoration | actor`) that defaults the render `z` via `PROP_KIND_Z`, so later
  systems can reason about collision/interactivity without parsing sprites.
- **Sprite sourcing** is a three-way discriminated union mirroring how authors
  actually get art: `catalog` (reuse), `sheet` (record an existing frame), and
  `custom` (request generation, with an optional `placeholder` shown until the
  real asset lands). `collectCustomArtRequests()` de-duplicates the outstanding
  requests for the art pipeline.
- **Layering** — a prop's visual is an ordered list of `SpriteLayer`s with
  per-layer offset/scale/tint, so composites stack naturally.
  `flattenSetPieceLayers()` produces a render-ordered draw list (stable sort by
  prop `z`, then authored order).

A `set-piece-lab` viewer (`?lab=set-piece-lab`) renders any set piece with all
three sprite sources, draws magenta placeholders for pending custom art, and
lists outstanding art requests.

## Consequences

### Positive

- Hundreds of set pieces can be authored as pure JSON and validated at load.
- LLM providers inject packs through the same `install*` seam as quests.
- The art backlog is queryable (`collectCustomArtRequests`) and visible in-lab.
- Layering + `z`-by-kind gives composites and sane draw order for free.

### Negative

- Schema bounds-check prop placement but not full floor coverage or overlaps;
  authors can still leave gaps or stack props oddly.
- The viewer renders "recorded" sheet frames literally, so a wrong col/row shows
  the wrong art with no validation that a frame is semantically a table/chair.

### Risks

- Future map-gen wiring may want richer placement metadata (anchors, door sides,
  rotation variants). The model is intentionally minimal and may need extension;
  the pack `version` field reserves room for migration.

## Alternatives Considered

- **ECS-component-per-prop authoring.** Rejected: set pieces are content, not
  runtime behaviour; config packs match the quest precedent and keep `src/core`
  free of content.
- **One sprite per prop (no layers).** Rejected: composites ("flower pot on
  table") are a stated requirement and are far cleaner as stacked layers than as
  many coincident single-sprite props.
- **Pixel coordinates instead of a tile grid.** Rejected: tiles align with the
  16px sprite frames and the existing map tile model, easing later map-gen
  stamping.

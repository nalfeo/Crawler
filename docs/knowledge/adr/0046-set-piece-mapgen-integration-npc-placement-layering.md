# ADR 0046: Set-Piece Map-Gen Integration, NPC Placement & Sprite Layering

## Status

Accepted

## Date

2026-07-06

## Estimated Complexity

🍎 x 4 — resolves ADR 0024's deferred map-gen integration and spans the set-piece
model, a new core stamping unit, the Phaser render path (depth layering), floor
scenario wiring, and an AI-objective anchor change (scenario glue only). No new
`*System`; reuses the existing prop render pass + spawners.

## Context

[ADR 0024](0024-set-piece-themed-rooms.md) shipped the set-piece **data model**
(Zod packs → registry, layered props, three-way sprite sourcing, a viewer lab)
but explicitly deferred map-generation integration and listed "richer placement
metadata (anchors, door sides…)" as a future risk. It also modelled props only —
there was **no way to place NPCs**, and nothing stamped a set piece into a real
floor.

Two concrete problems forced the follow-on:

1. **Floor 1 welcome-room NPC huddle.** The three welcome-bar NPCs
   (tutorial-goon, shopkeeper, spell-quest-giver) spawned effectively on top of
   each other. The obvious fix — random scatter — regressed the headless win-rate
   gate because the goon drifted out of `NPC_INTERACT_RANGE_FT` of its objective
   anchor. Spacing needed to be **authored and deterministic**, not random.
2. **Sprite layering.** Terrain (floor + walls) bakes to one flat RenderTexture
   at `TERRAIN_DEPTH = -20`; entities/NPCs render at `ENTITY_DEPTH = 0`. The
   legacy prop depths (`back/mid/front` = 2/3/4) sit **above** entities, so a rug
   authored as a background prop would wrongly paint over the NPCs standing on it,
   and a banner could not sit "on" a wall. Set-piece dressing needs to straddle
   the entity plane (rug under NPCs but over floor; banner over the wall).

## Decision

Wire set pieces into real map generation, extend the model to place NPCs, and map
set-piece `z` onto Phaser depths that straddle the entity plane.

- **NPC placement in the model.** `SetPieceDef` gains an optional `npcs[]`
  (`{ id, npcTypeId, x, y, facing?, anchorRole? }`), Zod-validated for in-bounds
  tiles, unique ids, and a registered `npcTypeId`. `anchorRole ∈
{welcome, shop, spell}` ties an authored NPC to a Floor-1 objective anchor.
- **Core stamping unit.** New pure, deterministic `src/core/map/stampSetPiece.ts`
  (`shared`-only imports, core-legal) centres a def in a room's interior (1-tile
  inset), clamps every tile to the interior, and returns tile-space prop + NPC
  placements. One reusable unit feeds **two** consumers: the real floor scenario
  and the map-gen lab overlay.
- **Depth straddling for layering.** `setPieceZToDepth(z)` in
  `render-depths.ts`: `z ≤ 10` (rug, banner) → a band in `(-20, 0)` (above
  terrain, below NPCs); `z ≥ 20` (fixture/furniture/decoration) → a band `> 0`
  (in front of NPCs, below gore VFX). Monotonic; a per-layer epsilon keeps
  stacked layers ordered without crossing a band boundary.
- **Per-layer render units.** The scenario spawns **one visual-only prop entity
  per flattened set-piece layer** via `spawnSetPieceProp` (Position + Sprite +
  Prop + inert immovable-tier Weight, **no Size**), recording resolved
  sprite/depth/footprint/tint in a `world.setPieceProps` sidecar. The PhaserBridge
  prop pass consults the sidecar before the decoration-def path and honours the
  per-layer depth, rendering composites correctly layered in the real game (not
  just the lab). Missing/custom art falls back to a labelled placeholder rect.
- **Objective anchors auto-follow NPCs (all three).** In `floorScenario.ts`, each
  welcome-room NPC's objective tile is derived from its **actual stamped tile**
  (`welcomeOfficePos`/`shopRoomPos`/`spellQuestGiverPos`). This is a uniform
  mechanism that also fixes the pre-existing goon-objective-follow gap. Because
  the stamped tile stays within the welcome-office hub room, room-hop distance
  (welcome-sign trail length, "far goon" AI classification) is unchanged. This is
  **scenario glue, not AI-behaviour code** — the marker simply points where the
  NPC actually stands.

The authored `welcome-room` set piece (8×7, `exact`) places the goon against the
back wall with a welcome desk in front + banner behind, the merchant with a shop
table, and the spell broker beside a bookcase, plus cozy decor (rug, sconces,
crates, stools, clutter). Missing bespoke props ship as labelled placeholders;
real art is a fast-follow.

### Weight invariant compliance

Set-piece props carry an **immovable-tier `Weight`** (`IMMOVABLE_THRESHOLD`)
even though they are visual-only. Per [ADR 0044](0044-explicit-size-weight-components.md)
/ `entity-physics.md` R2, positive `Weight` is a **universal** invariant for every
`Prop`-tagged entity (`knockbackSystem` divides by it; `check:weight-coverage`
enforces it). The value is inert here — with no `Size`, the prop never enters the
collision grid and can never be a knockback target — but keeping the invariant
avoids a special case and makes the "fixed furniture" intent explicit.

## Consequences

### Positive

- Floor-1 NPC spacing is authored, deterministic, and win-rate-safe (anchors
  follow NPCs by construction, so reachability holds without a scatter gamble).
- Set pieces are now a real map-gen feature with a reusable, unit-tested stamping
  unit shared by the floor and the lab.
- Composites layer correctly in the **real game**: rug over floor & under NPCs,
  banner over the wall, desk in front — proven by the PhaserBridge render tests.
- The map-gen lab can visualise a stamped set piece (prop footprints + anchor-
  tinted NPC markers) on any generated floor; the set-piece lab renders `npcs[]`.

### Negative

- The stamper centres + clamps to a room interior; a pathologically small or
  concave (hub-shaped) target room can clamp a tile onto a wall. Mitigated by a
  per-NPC passability guard that falls back to the scatter spawner for that NPC.
- One entity per flattened layer increases prop-entity count for dense set pieces
  (visual-only, no Size, so no collision/physics cost — only render + a sidecar
  Map entry).

### Risks

- `roomRole: "spawn"` resolves to the welcome-office **hub** (`welcomeOfficePos`),
  not the literal `floorMap.spawnRoom`. Stamping into the wrong room collapses the
  welcome-sign trail and pulls the goon next to the player. The stamper resolves
  the room at `welcomeOfficePos` via `worldToTile → getRoomAt → roomGraph.get`;
  future floors reusing this path must respect that indirection.
- Depth bands are fixed constants; a future prop kind wanting to sit _between_
  two NPCs on the same plane is not expressible without extending the mapping.

## Alternatives Considered

- **Random-scatter spacing (no set piece).** Rejected: proven to fail the
  headless win-rate gate (goon drifts out of interact range); non-deterministic.
- **Leave objective anchors fixed, move NPCs around them.** Rejected by the
  maintainer: anchors are trivially pathable within one room, so auto-following
  the NPC is correct bookkeeping and removes the goon special case.
- **A new `setPiecePropSystem`.** Rejected: props are static dressing; reusing the
  existing prop render pass avoids an orphaned `*System` (ADR 0039) and needless
  per-frame work.
- **One sprite per prop (no per-layer entities).** Rejected: the real game would
  lose the layering the model already expresses; per-layer entities make
  composites render identically in-game and in-lab.

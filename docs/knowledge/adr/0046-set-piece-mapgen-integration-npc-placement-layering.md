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
  `render-depths.ts`: `z < 20` (rug, banner, door) → a band in `(-20, 0)` (above
  terrain, below NPCs); `z ≥ 20` (fixture/furniture/decoration) → a band `> 0`
  (in front of NPCs, below gore VFX). Monotonic; a per-layer epsilon keeps
  stacked layers ordered without crossing a band boundary.
- **Per-layer render-only instances.** The scenario appends **one render-only
  instance per flattened set-piece layer** via `addSetPieceProp`, pushing
  `{ x, y, render }` (resolved sprite/depth/footprint/tint) onto a
  `world.setPieceProps` sidecar **array**. These are **not** ECS entities — they
  consume no entity ids. The PhaserBridge has a dedicated set-piece render pass
  (after the ECS prop pass) that iterates the sidecar array, keying visuals by
  list index and honouring the per-layer depth, rendering composites correctly
  layered in the real game (not just the lab). Missing/custom art falls back to a
  labelled placeholder rect. See the render-only rationale below.
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

### Render-only props (no entity ids) — sim purity

Set-piece props are **render-only instances**, not ECS entities. They live on a
`world.setPieceProps: SetPiecePropInstance[]` sidecar and are drawn by a dedicated
PhaserBridge pass; nothing in `src/core`/`src/game` queries them.

This is deliberate and load-bearing for **determinism**. When props were ECS
entities (the original design), spawning them during floor setup allocated entity
ids **ahead of** the ambient-mob spawns that follow. That shifted every later
entity's id, which reordered the global RNG draw sequence and produced a
**seed-visible gameplay change** for content that must have none — it pushed the
Floor-1 arena seed 2 ~1.2 s over its 360 s budget and drifted the collision-pair
fingerprints. `spawnSetPieceProp` itself drew no RNG; the perturbation was purely
entity-id allocation. Moving props off the entity space (this ADR's render-only
model) makes a props-present run **byte-identical** to a props-skipped run, so the
headless sim and the rendered game agree exactly. This mirrors the codebase's
existing VFX-as-events precedent: cosmetic, render-only concerns never consume
gameplay entity ids. It also sidesteps the ADR 0044 `Weight` invariant entirely —
with no `Prop`-tagged entity, there is no Weight-coverage obligation to satisfy.

The **collision-pair-parity goldens were re-baselined** (2026-07-07) as a result:
props are now provably non-perturbing, so the residual fingerprint delta vs. the
pre-feature goldens is **entirely** the user-approved NPC repositioning (spacing
the three NPCs to authored tiles changes their collision footprints). Verified
stable across two back-to-back runs per seed.

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
  concave (hub-shaped) target room can clamp a tile onto a wall. Mitigated for
  **NPCs** by a per-NPC passability guard that falls back to the scatter spawner
  for that NPC. **Props** have no such guard, but they are render-only (not
  entities, never in the collision grid), so a prop clamped onto a wall is a
  **cosmetic-only** artifact with zero gameplay/pathing effect. Full-footprint
  passable-interior validation (vs. rectangular bounds) was considered and
  deferred as unnecessary for non-colliding dressing on Floor 1's rectangular
  welcome-office hub.
- One render-only instance per flattened layer increases the sidecar array size
  for dense set pieces — a per-frame render cost plus one array entry per layer,
  but **no** entity/collision/physics cost and no entity-id consumption.

### Risks

- `roomRole: "spawn"` resolves to the welcome-office **hub** (`welcomeOfficePos`),
  not the literal `floorMap.spawnRoom`. Stamping into the wrong room collapses the
  welcome-sign trail and pulls the goon next to the player. The stamper resolves
  the room at `welcomeOfficePos` via `worldToTile → getRoomAt → roomGraph.get`;
  future floors reusing this path must respect that indirection.
- Depth bands are fixed constants; a future prop kind wanting to sit _between_
  two NPCs on the same plane is not expressible without extending the mapping.
- Both set-piece prop bands render **below** `WORLD_VFX_DEPTH.gore` (+10): a
  background banner (negative depth) and a foreground bookcase/desk (`z ≥ 20` →
  ~+3) both sit under blood/corpse VFX, so transient gore can paint over dressing.
  Accepted as a minor, intentional cosmetic tradeoff (gore is short-lived and the
  dressing is static); pinned by the `render-depths` unit tests.
- The objective-anchor auto-follow is validated **geometrically** — a fast unit
  test asserts each anchor equals its NPC's spawned tile (reachable by construction,
  distance 0 ≤ `NPC_INTERACT_RANGE_FT`) plus pairwise Chebyshev spacing. Deeper
  end-to-end BT interaction-handoff validation is intentionally **out of scope**
  per the maintainer's no-AI-edit / no-seed-sweep fence; the change only moves a
  marker onto the NPC (interaction logic in `bt-ai-provider` is untouched and the
  goon can only become _more_ reachable, never less).
- The non-set-piece **fallback** NPC-spawn path (empty `npcPlacements`) is
  backward-compat and now resolves all three NPCs against the stable room-center
  local rather than the mutated objective field. It is covered structurally (the
  self-documenting local + two clean review passes) rather than by a manifest-mock
  test; forcing it would require module-level mocking of `floor1Manifest` for a
  path the shipping manifest never takes.

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
  lose the layering the model already expresses; per-layer render units make
  composites render identically in-game and in-lab.
- **Set-piece props as ECS entities (the original design).** Rejected after it
  shipped: allocating entity ids for cosmetic props during setup shifted
  ambient-mob ids, perturbed the global RNG order, and caused a seed-visible
  headless-gate regression (arena seed 2 over budget; drifted collision
  fingerprints). Render-only instances consume no entity ids and make the sim
  byte-identical with or without props — the correct model for cosmetic dressing.

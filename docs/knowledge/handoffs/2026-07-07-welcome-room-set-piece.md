# Session Handoff: Wire set pieces into Floor 1 welcome room

## Date

2026-07-07

## Persona

Producer (orchestrated a single-branch, sequential 5-slice plan)

## Systems touched

mapgen, quests, devtools

## Apples

4🍎 estimated, 4🍎 actual (🎯 exact). Multi-layer feature (model → pure core
stamper → Phaser render path → scenario wiring → labs) + ADR + full >3🍎 review
harness. Held at 4 (not 5) by the hard no-AI/no-sim scope fence.

## What Was Done

Turned "NPCs huddle in the Floor 1 welcome room" into a real, reusable
**set-piece → map-gen integration**: an authored `welcome-room` set piece is now
stamped into the welcome-office hub during Floor 1 generation, fixing the three
quest NPCs at spaced, themed positions and dressing the room with layered props.

- **S1 — model (`src/shared/set-piece-types.ts`).** `SetPieceDef` gains an
  optional `npcs[]` (`{ id, npcTypeId, x, y, facing?, anchorRole? }`), Zod-strict:
  in-bounds vs width/height, unique ids, registered `npcTypeId`, `anchorRole ∈
{welcome, shop, spell}`. Lookup helper + unit tests.
- **S2 — content (`src/shared/data/set-pieces.json`).** Authored `welcome-room`
  (8×7, `exact`): goon against the back wall with a welcome desk in front + banner
  behind; merchant with a shop table; spell broker beside a bookcase; cozy decor
  (rug, sconces, crates, stools, clutter). 4 missing props ship as labelled
  placeholder sprites (bespoke art is a fast-follow, per maintainer).
- **S3 — engine layering (`src/shared/render-depths.ts` + PhaserBridge).**
  `setPieceZToDepth(z)` maps set-piece `z` onto a depth that **straddles the
  entity plane**: structural kinds (`z < 20`: floor rug, wall banner, door) →
  a band in `(-20, 0)` (above baked terrain, below NPCs); `z ≥ 20`
  (fixture/furniture/decoration) → a band `> 0` (in front of NPCs, below gore).
  Each flattened set-piece layer becomes **one visual-only Prop entity**
  (`spawnSetPieceProp`: Position + Sprite + Prop + inert immovable-tier Weight,
  **no Size**) recorded in a `world.setPieceProps` sidecar; the prop pass consults
  the sidecar before the decoration-def path and honours per-layer depth.
  Composites layer correctly **in the real game**, not just the lab.
- **S4 — core stamp + scenario wiring.** New pure `src/core/map/stampSetPiece.ts`
  (shared-only imports, deterministic) centres a def in a room interior, clamps
  every tile (footprint-aware for multi-tile props), returns tile-space prop + NPC
  placements. `floorScenario.ts` stamps the welcome-room set piece into the
  **welcome-office hub** (resolved via `welcomeOfficePos`, NOT `floorMap.spawnRoom`
  — see Gotchas), spawns the NPCs at authored tiles, and **auto-follows all three
  objective anchors** (welcome/shop/spell) to each NPC's actual spawned tile — a
  uniform mechanism that also fixes the pre-existing goon-objective-follow gap.
  Per-NPC passability guard falls back to scatter for any tile a hub room clamps
  onto a wall.
- **S5 — QA + labs.** Fast pure tests (anchor == NPC tile ⇒ reachable by
  construction; pairwise Chebyshev ≥ 3 spacing; prop/depth). Map-gen lab overlay
  (`drawSetPieceOverlay` + toggle) draws the stamped set piece on a generated
  floor; set-piece lab renders `npcs[]`. Fixed a weight-coverage guard regression
  (immovable-tier Weight on set-piece props) + doc fixes.

### Review harness (>3🍎, tier-4 ledger)

- Plan review (gpt-5.4): 5 tightening findings, no blockers — all resolved (1 code
  comment + 4 ADR limitation notes; see ADR 0046 Risks/Negative).
- Dual-plan synthesis (gpt-5.5 + claude-opus-4.7, judge gemini-3.1-pro-preview):
  executed plan is the correct convergent best-of-both merge; all scope
  constraints honored.
- Multi-model code-review **loop, 3 rounds** (sonnet-4.6 / gpt-5.3-codex /
  gemini-3.1-pro-preview; adjudicator claude-opus-4.8): R1 6 concerns → 5 valid
  fixed (`7da801e7`); **R2 caught a NEW regression the R1 fix introduced** — the
  goon's `updateObjective` mutated `objective.welcomeOfficePos`, so the spell/shop
  resolvers clustered onto the goon (`986e83cf` resolves all three against the
  stable local room center); R3 clean from 2 distinct models.
- Ledger: `docs/knowledge/review-ledgers/2026-07-07-welcome-room-set-piece.review-ledger.json`
  (validates as a 4-apple ledger).

## Observe Before Done (deterministic, real pipeline)

Validated in the **real Floor 1 scenario pipeline** (not just a lab):

- `tests/game/floor1-scenario.test.ts` (49 tests) — NPCs spawn at authored tiles,
  all three objective anchors follow their NPC, spacing holds.
- PhaserBridge render tests + `tests/unit/render-depths.test.ts` — set-piece props
  render layered (rug over floor & under NPCs; banner over wall; desk/bookcase in
  front) via the real prop pass; door z=12 lands in the background band.
- `tests/unit/stamp-set-piece.test.ts` (footprint-in-bounds, degenerate room) +
  `tests/ecs/spawners/entity-core.test.ts` (sidecar clear-on-recycle).

## Key Files

- `src/shared/set-piece-types.ts` — model + `npcs[]` + Zod validation + helpers.
- `src/shared/data/set-pieces.json` — authored `welcome-room`.
- `src/shared/render-depths.ts` — `setPieceZToDepth` (entity-plane straddle).
- `src/core/map/stampSetPiece.ts` — pure/deterministic stamping unit.
- `src/core/spawners/entity-core.ts` — `world.setPieceProps` sidecar clear-on-recycle.
- `src/game/floorScenario.ts` — stamp wiring + objective-anchor auto-follow
  (data-driven path ~1375-1430; backward-compat fallback ~1431-1467).
- Labs: map-gen lab overlay + set-piece lab `npcs[]` render.
- `docs/knowledge/adr/0046-set-piece-mapgen-integration-npc-placement-layering.md`.

## Gotchas / Follow-ups

- **`roomRole:"spawn"` ⇒ welcome-office HUB, not `floorMap.spawnRoom`.** Stamping
  into the wrong room collapses the welcome-sign trail and pulls the goon next to
  the player. The stamper resolves the room at `welcomeOfficePos`; future floors
  reusing this path must respect that indirection.
- **Objective anchor fields are now "NPC target tiles", not room centers.**
  `welcomeOfficePos`/`shopRoomPos`/`spellQuestGiverPos` are seeded to the room
  center then tightened to each NPC's spawned tile post-spawn. Do NOT read the
  mutated objective field as a stable room center mid-spawn (that was the R2
  regression). Documented at the objective init site + ADR.
- **Props are visual-only** (no Size, never in the collision grid), so a prop
  clamped onto a wall on a concave room is cosmetic-only — no gameplay/pathing
  effect. Full-footprint passable-interior validation was deferred as unnecessary.
- **Both prop depth bands render below gore VFX** — transient blood can paint over
  a bookcase/desk. Accepted cosmetic tradeoff, pinned by render-depths tests.
- **Art fast-follow:** welcome desk / banner / shop table / bookcase ship as
  labelled placeholders; generate bespoke sprites next.
- Scope was purely visual/theming: **no AI/balance edits, no seed sweeps** (the
  anchor auto-follow is mechanical bookkeeping approved by the maintainer).

# ADR 0026: Door-Pointing Welcome-Sign Wayfinding

## Status

Accepted

## Date

2026-06-27

## Estimated Complexity

🍎 x 3 — game-layer placement logic + engine-layer baked-texture rendering +
regression tests; spans two layers (`src/game`, `src/engine`) but adds no new
ECS system and needs no new lab (Floor 1 coverage uses `ai-runner`).

## Context

Floor 1 opens with the player needing to find the welcome office. The existing
welcome signs were placed sparsely (every 2–3 rooms) and each pointed at the
**next room's centre**, so the arrow drew a rough straight line toward the
destination rather than following the corridor the player must actually walk.
The word "WELCOME" was not rendered at all — the sign was just a board with an
arrow — so the sign's purpose was not legible in-game.

The product ask was concrete: signs should point at **the door the player should
take to make progress**, there should be a sign in **every** room along the
path, the sign should visibly say **WELCOME**, the text must be **part of the
sign** (rotating with the arrow, not floating above it), and signs must **never
spawn on top of an NPC**. A late refinement added: when the arrow points more
than halfway to the left, the text must stay right-side-up rather than flipping
upside down.

This decision affects two architectural layers — Floor 1 content placement
(`src/game`) and sprite rendering (`src/engine`) — hence this ADR.

## Decision

**Door-aware placement (`src/game/floorScenario.ts`).** Add
`findNavigableRoomPathSteps()` returning `NavigableRoomStep[]` — it walks the
real door-aware tile path (rot-js A\* over passable + door tiles) from the player
spawn to the welcome office and, for each room, records the first DOOR tile
crossed on the way out (the room's "exit door toward the goal"). A new
`placeWelcomeSigns(world, welcomeOfficePos)` then plants one sign in **every**
room on that path except the destination, each rotated to point from the room
centre at its exit door. The angle is measured from the room **centre** (not the
sign tile) so the arrow still reads "go this way" even when the sign is nudged
off-centre.

**NPC-safe tile resolution.** `placeWelcomeSigns` runs **after** NPCs are
spawned in `initializeFloor1Scenario`. It builds a blocked-tile set from the
player spawn tile plus every `[Npc, Position]` tile, then resolves each sign to a
passable interior tile, spiralling outward from the room centre when the centre
is a wall or blocked. This guarantees a sign in every path room without ever
overlapping the player or an NPC.

**Baked, upright text (`src/engine/PhaserBridge.ts`).** The word WELCOME is baked
into the sign **texture** (board + word + arrow) on a canvas, so it is part of
the sprite and rotates with it. Two textures are generated up front:
`__cw_welcome_sign` (arrow right) and `__cw_welcome_sign_left` (arrow left), both
with WELCOME drawn upright. At render time the welcome-sign case picks the
variant by the sign's facing: when `Math.cos(angle) < 0` (arrow points past
vertical to the left) it uses the left texture rotated by `angle − π`, so the
arrow ends up pointing the requested direction while the word never rotates more
than ±90° from upright. The chosen variant is tracked on the
`EntityVisual.welcomeFacing` field because the unit-test mock image exposes no
`.texture` getter to read back the active key.

## Consequences

### Positive

- Signs follow the actual corridor route and point at the specific door to take,
  so the breadcrumb trail genuinely leads to the welcome office.
- One sign per room makes the path unambiguous; no 2–3 room gaps.
- WELCOME is legible and baked into the sprite, so it rotates correctly with the
  arrow with zero extra draw objects, depth bookkeeping, or camera-cull handling.
- NPC/player avoidance is deterministic and consumes no RNG, so floor generation
  and the headless gate stay reproducible.

### Negative

- Two sign textures are generated instead of one (negligible memory; both are
  tiny 48×26 canvases created once at scene init).
- `placeWelcomeSigns` must run **after** NPC spawning; reordering Floor 1 init so
  signs precede NPCs would reintroduce the overlap risk.

### Risks

- A sign whose exit door is **exactly** vertical (arrow due north/south,
  `cos≈0`) still renders WELCOME sideways — a single rotating board cannot keep
  text upright at ±90°. Accepted: only the left-hemisphere case was in scope.
  Adding dedicated up/down text variants would remove this if needed.
- Placement assumes the welcome office is reachable from spawn over door/passable
  tiles; if a future floor layout breaks that, `findNavigableRoomPathSteps`
  returns `null` and no signs are planted (fail-safe, but the player loses the
  trail).

## Alternatives Considered

- **A live Phaser `Text` object above each sign.** Rejected: it would not be
  "part of the sign," would need world-depth and ui-camera-ignore bookkeeping to
  avoid being culled or double-drawn, would not rotate with the board, and would
  not exist in the headless/mock render paths the tests exercise.
- **One texture rotated through the full 360°.** Rejected: WELCOME goes upside
  down once the arrow passes vertical to the left. The two-variant swap keeps the
  text within ±90° of upright across the whole left hemisphere.
- **Keep pointing at the next room centre.** Rejected: that ignores corridor
  geometry and can point the arrow at a wall; pointing at the recorded exit door
  is what "the door to take to make progress" actually means.
- **Place signs before NPC spawn and dodge later.** Rejected: NPC tiles aren't
  known yet, so avoidance would be impossible without a second pass; running
  placement after NPC spawn makes avoidance a single clean step.

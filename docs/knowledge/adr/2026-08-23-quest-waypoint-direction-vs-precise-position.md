# ADR: Separate precise position from shared-room arrow direction in quest waypoints

## Status

Accepted

- Date: 2026-08-23

## Context

Issue #3315: quest objectives on different tiles within the same semantic
room produced conflicting off-screen arrow directions in
`HudDirectionArrows` — two active quests whose targets were a few tiles
apart but in the same room pointed in visibly different directions, even
though both destinations read as "the same place" from the player's distant
vantage point.

The initial fix normalized every same-room `QuestWaypoint`'s `x`/`y` to a
single deterministic room anchor in `src/core/systems/questWaypoints.ts`.
Review caught that `getQuestWaypoints` (and `getTrackedQuestWaypoint`, which
delegates to it) is also the source for `HudMinimap.ts`'s single tracked-
objective dot and radar arrow. Overwriting `x`/`y` moved that tracked marker
off the objective's actual tile whenever another active quest shared its
room, regressing minimap precision for a single-target consumer that never
had the multi-arrow ambiguity problem in the first place.

This diff spans two architectural layers — `src/core` (`questWaypoints.ts`)
and `src/engine` (`HudDirectionArrows.ts`) — so it needs an ADR per the
2+-system rule.

## Decision

Split `QuestWaypoint` into two coordinate pairs instead of one:

- `x`/`y` — the objective's precise, unmodified target position. Always
  exact; never adjusted for shared rooms. `HudMinimap.ts` (single tracked
  marker) continues to read these fields unchanged.
- `dirX`/`dirY` — equal to `x`/`y` by default, but normalized to the room's
  deterministic anchor (`pickRoomAnchorCell`, falling back to the room
  bounds' geometric center) when 2+ active quests' precise targets fall in
  the same semantic room with different tiles. Only `HudDirectionArrows`
  (the multi-arrow HUD where the conflicting-direction bug is visible) reads
  these fields, and only for its **angle** calculation — off-screen culling
  and the displayed distance still derive from the precise `x`/`y` so a
  shared anchor never fabricates visibility or range for a quest whose real
  target isn't actually there.

`src/core` remains render-free (no new imports from `src/engine`); the split
lives entirely in the existing `QuestWaypoint` data shape, and `src/engine`
only changes which fields of that shape it reads.

## Consequences

### Positive

- The minimap's tracked-objective dot and radar arrow keep pointing at the
  objective's real NPC/item/tile, regardless of how many other active quests
  share its room.
- Multi-arrow HUD direction still agrees for co-located quests, which was the
  original reported bug.
- Off-screen culling and displayed distance per arrow stay accurate to each
  quest's own target, so a same-room pairing can never make an on-screen
  quest wrongly render an off-screen arrow (or vice versa), nor misreport one
  quest's distance as another's.

### Negative

- `QuestWaypoint` now carries two coordinate pairs instead of one, which
  every future consumer must reason about (which pair to read depends on
  whether it renders one marker or several simultaneously).

### Risks

- A future consumer of `getQuestWaypoints`/`getTrackedQuestWaypoint` could
  read the wrong pair (e.g. use `dirX`/`dirY` for a single-marker UI, subtly
  reintroducing the minimap regression). Mitigated by the doc comments on
  each field in `questWaypoints.ts` stating which consumers should use which
  pair, and by regression tests asserting `x`/`y` stay precise while
  `dirX`/`dirY` match for same-room targets.

## Alternatives Considered

- **Normalize `x`/`y` directly (the original fix)**: simplest change, but
  regresses every consumer of the canonical waypoint position, including the
  minimap's tracked marker — rejected because it silently moves the map
  marker off the objective's actual tile.
- **Separate "angle-only" function/type instead of extra fields on the same
  interface** (e.g. a `resolveQuestArrowDirections` helper returning a
  parallel array): avoids widening `QuestWaypoint`, but forces every
  multi-arrow-HUD call site to zip two arrays together by `questId` and
  reintroduces a class of index-mismatch bugs the flat array design
  currently avoids — rejected as added complexity for no behavioral gain
  over documented fields on the existing shape.
- **Group by NPC/objective "home room" instead of the live target tile**:
  would avoid rare flicker if an NPC target crosses a room-boundary tile
  mid-frame, but no current objective source exposes a stable "home room" id
  independent of the target position; deferred as an unrequested extension
  of a surgical bugfix.

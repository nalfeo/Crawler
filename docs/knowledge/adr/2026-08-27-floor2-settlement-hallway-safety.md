# ADR: Floor 2 settlement hallways use exact safe-area metadata

## Status

Accepted

## Date

2026-08-27

## Estimated Complexity

🍎 x 3 — generated map metadata, shared safe-space consumption, Floor 2 activation, and
seeded regression coverage.

## Context

Floor 2 generates the settlement as two or three separate rooms connected by narrow
door-to-door hallways. Settlement initialization retags each room as `SAFE`, but the
connector tiles belong to no room. Crossing between the bar and annex therefore clears
`world.playerInSafeRoom`, temporarily disabling safe-context interactions and exposing the
player to systems that treat safe space as a refuge.

The connector cannot simply be added to a room's `interiorCells`: settlement NPC placement
uses those cells and could place a merchant in the hallway. Generic corridor terrain also
cannot become safe because that would extend the refuge into the surrounding cave.

## Decision

- **DEC-001:** `CaveSystemGenerator` records the exact flat tile indices carved by internal
  settlement room connections on `FloorMap.settlementHallwayTileIndices`. Other map
  generators receive an empty set by default.
- **DEC-002:** The metadata includes both internal doorway tiles and every tile between
  them. The two exterior bar doors and their cave approaches are excluded.
- **DEC-003:** `isPointInSafeSpace` recognizes a recorded connector only after
  `world.floorExtendedState.settlement` exists. Raw generated maps therefore remain unsafe
  until settlement initialization completes, matching the existing room activation
  lifecycle.
- **DEC-004:** Settlement initialization repaints non-door connector terrain with
  `SAFE_ROOM_FLOOR`. Door tiles retain `DOOR` terrain while sharing the safe-space
  classification.

## Consequences

### Positive

- Safety remains continuous while moving between every settlement room in both real-game
  and headless pipelines.
- Exact tile indices keep the hot-path lookup allocation-free and prevent safety from
  leaking through walls or exterior approaches.
- Room interiors, room counts, NPC placement candidates, and seeded RNG consumption remain
  unchanged.

### Negative

- `FloorMap` now carries one Floor 2-specific metadata collection, empty on other floors.
- Connector generation and settlement activation must remain synchronized through this
  metadata contract.

## Alternatives Considered

- **Add connectors to `RoomData.interiorCells`.** Rejected because NPC and shop placement
  consumes settlement interiors and could select the narrow hallway.
- **Treat all nearby `STONE_FLOOR` or corridor tiles as safe.** Rejected because it would
  leak safety into unrelated cave passages and potentially other floors.
- **Create synthetic hallway rooms.** Rejected because it would alter settlement room-count
  invariants, room adjacency, sealing, and other room consumers for a small geometry gap.
- **Use a settlement bounding box or radius.** Rejected because rectangular/radial coverage
  would include walls and exterior cave tiles that are not part of the authored hallway.

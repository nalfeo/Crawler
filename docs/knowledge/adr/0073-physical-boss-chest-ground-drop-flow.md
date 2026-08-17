# ADR 0073: Physical boss chest ground-drop flow

## Status

Accepted

## Date

2026-07-31

## Estimated Complexity

🍎 x 3 — one gameplay behavior change spans core simulation, game reward state, engine presentation, and probe/e2e coverage.

## Context

Boss chests previously used a dedicated side-panel interaction path that did not match the
rest of Crawler's pickup language. The user-facing requirement is explicit: boss chests
should drop onto the ground as physical world objects and be opened there, not through a
separate side UX.

- **CTX-001**: The reward itself is already represented in game state (`world.bossChests`)
  and the reveal/summary sequence already exists in the shared reward-opening overlay.
- **CTX-002**: The existing side-panel flow split one feature across core reward state,
  game-layer boss resolution, and engine-only interaction logic, making save/load and live
  runtime observation harder to keep consistent.
- **CTX-003**: Any replacement must remain deterministic, preserve carryover/save-load, and
  be observable in the real `MainGameScene`, not only in a lab seam.

## Decision

Replace the boss-chest side panel with a physical in-world chest flow.

- **DEC-001**: Model an available boss chest as a real ECS entity tagged with
  `BossChestEntity` and tracked by `world.bossChestEids` so runtime logic can map a physical
  object back to its `chestId`.
- **DEC-002**: Open boss chests through a deterministic proximity system
  (`bossChestPickupSystem`) instead of a dedicated engine panel; pickup happens when the
  player reaches the chest in the world.
- **DEC-003**: Keep reward presentation centralized in the shared reward-opening overlay.
  Physical pickup changes how the reward is triggered, not how the reveal/summary/claim
  sequence is rendered.
- **DEC-004**: Persist physical spawn coordinates (`spawnX` / `spawnY`) in carryover so an
  available chest can be restored as a world object after save/load.
- **DEC-005**: When authored boss coordinates are unavailable, fall back to the live player
  position rather than creating an unreachable available chest with no physical entity.

## Consequences

### Positive

- **POS-001**: Boss chests now follow the same player-visible rule as other floor loot: the
  reward exists in the world and is claimed in-world.
- **POS-002**: The interaction path becomes simpler across layers: core owns pickup, game
  owns reward/chest state, and engine only resumes the shared reward presentation.
- **POS-003**: Save/load behavior is clearer because an available boss chest has persistent
  world coordinates instead of an engine-only pending UI concept.
- **POS-004**: Real-scene probe/e2e coverage can assert the exact acquisition seam the player
  experiences: walk to chest -> overlay opens.

### Negative

- **NEG-001**: The feature now depends on explicit entity lifecycle wiring
  (`bossChestEids`, spawn, cleanup, restore), which adds more runtime surfaces than the old
  panel-only flow.
- **NEG-002**: `MainGameScene` must resume pending reward presentations during active play so
  a live chest reveal surfaces immediately; forgetting that seam would silently regress UX.

### Risks

- **RSK-001**: Any future boss-chest creator that forgets to provide or derive a spawn
  position could strand an available reward unless it uses the same fallback contract.
- **RSK-002**: Probe/e2e helpers now rely on the real physical chest path; stale dev-server
  optimize-deps state can make a failing lab look like a gameplay regression during local
  iteration.

## Alternatives Considered

### Keep the side-panel boss chest UI

- **ALT-001**: **Description**: Preserve `BossChestUI` and only restyle or reposition the
  existing engine-side interaction.
- **ALT-002**: **Rejection Reason**: Rejected because it keeps the user-visible mismatch: the
  chest is still not a physical ground object, and the interaction still bypasses the
  world's pickup language.

### Add a physical chest but keep a separate boss-specific interaction overlay

- **ALT-003**: **Description**: Spawn a chest entity in the world, but clicking or touching
  it would still route through a dedicated boss-chest UI instead of the shared reward
  presentation flow.
- **ALT-004**: **Rejection Reason**: Rejected because it duplicates presentation state and
  leaves two reward-opening systems to keep in sync.

### Auto-grant the reward at boss death with no chest entity

- **ALT-005**: **Description**: Remove the chest entirely and immediately enqueue the reward
  overlay when the boss dies.
- **ALT-006**: **Rejection Reason**: Rejected because it removes the explicit in-world object
  the player asked for and erases the physical pickup beat the feature is meant to add.

## Amendment: Floor 1 and AI parity (2026-08-17)

Floor 1 uses the same physical chest lifecycle rather than a floor-specific reward path.
Both Floor 1 boss-defeat handlers spawn a chest at the defeated boss position, and the
floor manifest enables the shared equipment economy and boss-chest behavior.

The deterministic headless player may target and walk onto these entities, but it receives
no equipment privilege a human lacks. Chest pickup uses `bossChestPickupSystem`; equipment,
achievement, and revealed-chest maintenance run only in a legitimate safe context. The
settlement-return planner therefore treats a floor without Floor 2 settlement state as
serviced when `isInSafeContext(world)` is true, allowing a Floor 1 route to advance through
`arrived` after the revealed chest is acknowledged.

This keeps one cross-floor acquisition contract and preserves human/AI parity. The cost is
that Floor 1 now participates in the generated-equipment economy and the safe-room return
router, so boss-defeat, maintenance, and headless integration tests must cover that wiring.

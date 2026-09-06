# Handoff: Prevent harvestables in safe rooms

## Systems touched: mapgen, quests

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎.

## What changed

- Floor 1 harvestable candidates are now limited to `RoomRole.NORMAL`; the
  legacy relocation that guaranteed a node in the spawn room was removed.
- Floor 2 harvestables exclude spawn, safe, and settlement rooms while
  retaining placement in the floor's non-protected territory/resource rooms.
- `spawnHarvestableNode` rejects positions inside `isPointInSafeSpace`, and
  `isPointInSafeSpace` recognizes authored settlement rooms as protected.
- Updated deterministic Floor 1 and Floor 2 scenario tests to assert protected
  rooms remain empty while ordinary rooms still receive nodes.

## Observation

Before: the real Floor 1/Floor 2 scenario initializers could place nodes in the
Floor 1 spawn room or Floor 2 starter/settlement area; the prior Floor 1 test
explicitly required a spawn-room node, and Floor 2 candidates included
`RoomRole.SPAWN`.

After: the scenario initializers and spawner guard produce zero harvestables in
protected regions across the deterministic seed matrix, while Floor 2 still
spawns all three ore/gem types and Floor 1 continues spawning nodes in ordinary
rooms.

## Verification

- `npm run test:unit -- tests/game/floor1-harvestable-spawn-room.test.ts tests/game/floor2-environmental-content.test.ts tests/ecs/spawners/world-objects.test.ts`
- `npm run typecheck:src`
- `npm run lint:core -- --no-cache`
- `npm run lint:game -- --no-cache`
- `npm run verify:fast`

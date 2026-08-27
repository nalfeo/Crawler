# Session Handoff: Floor 4 slice 1 — floor plumbing + authored arena venue

## Date

2026-08-23

## Persona

Producer → Systems/Content Engineer (Floor 4 epic, slice 1 of 8)

## Systems touched

mapgen

## Apples

4🍎 estimated (full JSON in `docs/knowledge/metrics/apples/2026-08-23-floor4-slice1-plumbing-arena.json`)

## What Was Done

Implemented slice 1 of `.specify/specs/floor4-arena.md` — "Floor plumbing + arena
map" — and nothing beyond it.

- `src/core/map/generators/ShowcaseArenaGenerator.ts`: the authored broadcast venue
  (arena "the-pit" + curtain tunnel + Green Room + four pit-fixture pillars). It
  consumes **zero RNG** — geometry is a pure function of the manifest numbers — and
  throws rather than clamping on any geometry that would move a feed gate, because a
  moved gate silently invalidates every future seeded wave manifest (FR3.4).
- `FloorMap.feedGates` + `ArenaFeedGate` (`src/shared/map-types.ts`): ordered gate
  metadata (0=N, 1=E, 2=S, 3=W) published by the generator, following the
  `territoryZones` precedent, so slice 3 reads the gates of the map it is running on
  instead of re-deriving the layout.
- `floor4.manifest.json` + strict `floor4` schema block with a cross-field
  `superRefine`, `FLOOR_REGISTRY` entry, `src/game/floor4Scenario.ts` and the
  `scenarioDefinitions.ts` entry.
- `enemyPackId` is now **optional**: Floor 4's enemies come from authored wave
  manifests, not an ambient pack. Both consumers (`floorScenario.ts`,
  `floor-config.ts`) now throw a named error instead of silently falling back to
  Floor 1's rats.
- New spec section recording the two deliberate slice-1 deviations (open tunnel,
  suppressed floor timer).

**Observed in `npm run dev` (`?floor=floor4`, rule #9)** — before: the console logged
`Unknown floor ID, falling back to floor1 {floorId: floor4}` and the player landed on
Floor 1's 240×140 `basic_underground` map. After: `floorId: floor4`, `floor: 4`,
`biome: showcase_arena`, 80×44 map, `hideFloorTimer: true`, spawn at tile (26, 22)
inside room `the-pit`, four feed gates in N/E/S/W index order; walking east through
the curtain tunnel put the player at tile (68, 32) inside room `green-room`, which is
exactly slice 1's acceptance criterion.

## Key Decisions Made

- **The venue is authored, not generated.** The generator takes an RNG parameter to
  satisfy `MapGenerator` and never touches it; a unit test proxies `SeededRandom` and
  asserts zero draws. Floor 4's variety is its seeded Headliner card and shop rolls
  (ADR 0090 D6), not its floorplan, and a fixed floorplan is what lets a wave manifest
  name gate index 1 and mean it.
- **Fail loudly, never clamp.** Every geometry violation (green room off-map, pillars
  meeting mid-arena, a gate colliding with the tunnel mouth or a fixture, a map smaller
  than the venue) throws at load. A clamped venue would move gates silently.
- **The tunnel ships open.** Slice 1's done-when and FR9.4 ("arena and Green Room never
  simultaneously reachable") are incompatible before the intermission transaction
  exists. Rather than fake a seal or quietly drop the acceptance criterion, the
  deviation is written into the spec and the floor stays `implemented.mvp: false`.
- **`timer.durationMs` is a stall backstop, not a countdown.** Floor 4 shows no
  countdown (FR5.6), so `world.hideFloorTimer` suppresses the generic HUD readout and
  the backstop raises its own `floor4-stall-backstop` flag. `ScenarioRunOutcome` has no
  "stalled" member, so it maps to `failed_timeout`, but the completion copy names an
  abandoned broadcast rather than blaming the player for being slow.
- **No placeholder enemy pack.** The original plan carried an `enemies.floor4.json`
  placeholder; the plan review correctly called it dead data. Making `enemyPackId`
  optional is the honest schema change.
- **`implemented.winBudgetMs: 900000` is authored now** even though the floor is
  unimplemented: the budget is a property of the design (FR8.5), not of build progress.

## What's Next / Blockers

Slice 2 — `arenaDirectorSystem` (clock, phases, transitions), wired into **both** sim
steps (`src/engine/sim/simulation-step.ts` and `src/game/ai/simulation-step.ts`), plus
the `RunStats` phase timeline and a minimal headless traversal. Note that slice 2 is
the first Floor 4 slice that adds a `*System`, so it is the first one that needs a lab
(rule #1) and must satisfy the orphaned-system wiring guard (rule #14).

No blockers. Two things slice 3 should read first: `FloorMap.feedGates` is the gate
contract (do not re-derive geometry), and `showcaseArenaOptionsFromConfig` is the only
supported way to move the venue.

## Retrospective

### Lessons Learned

- `FloorMap.isPassableAt(x, y)` takes **feet**, not tiles; `floorMap.tileMap.isPassable`
  is the tile-space check. Asserting tile coordinates through the feet wrapper silently
  reads the wrong tile and produced a confusing "the whole top-left band is solid"
  failure before this was spotted.
- The Playwright MCP tools were unavailable in this environment (OAuth transport
  error). Driving Playwright directly from a throwaway script worked, but the script
  must live **inside the repo** to resolve the `playwright` package — running it from
  `/tmp` fails with `ERR_MODULE_NOT_FOUND`.
- `window.__floor1Debug.getWorld()` is exposed in DEV builds and is the fastest honest
  way to observe real-artifact state (floor id, biome, room labels, player tile) without
  adding an automation hook. Despite the name it is not Floor-1-specific.
- The dev server runs on a session-scoped port (23360 here), not 5173, and `npm run dev`
  buffers its output — verify with `curl` rather than waiting on stdout.

### Mistakes Made

- Timed keypress bursts (`hold('KeyD', 9000)`) to walk across the arena wedged the
  player against a wall and produced two byte-identical screenshots that looked like
  progress. Early signal: identical file sizes for two "different" screenshots. The fix
  was a probe-driven greedy walker that re-reads the player tile between short pulses.
- Restoring a previous commit's `src/` under a live Vite server to capture the
  "before" state killed the dev server. Restarting it after the checkout worked, but
  the ordering (checkout → start server → probe → restore) matters.
- The first draft of the generator mutated `room.neighbors` after `RoomGraph.add`,
  which does not typecheck against the readonly room shape. Passing the neighbour ids
  into `add` and asserting the returned ids is both correct and cheaper.

### Opportunities for Future Improvement

- Every floor scenario repeats the same ~40 lines of manifest→world plumbing (stat
  modifiers, HP bonus, carryover-vs-starter-weapon, feature unlocks). A shared
  `applyManifestPlayerSetup(world, playerEid, manifest, options)` helper would remove a
  real copy-paste divergence risk as floors 5+ arrive.
- `getNextFloorId` derives progression from registry insertion order while the actual
  transition follows `ScenarioDefinition.nextFloorId`. Two sources of truth that agree
  only by convention; worth collapsing before a floor is inserted out of order.
- The arena "no dead-end tile" invariant asserted in the unit tests is a good candidate
  for a shared map-quality helper — it would catch stuck-player pockets in every
  generator, not just this one.

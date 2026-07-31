# Session Handoff: Prefab set-piece rooms — real walls + doors in mapgen

## Date

2026-07-25

## Persona

Producer → Set Piece Designer (mapgen carve + gate authoring)

## Systems touched

mapgen, boss-rooms, quests, ci-policy

## Apples

4🍎 estimated → 4🍎 actual (exact). Full JSON: `docs/knowledge/metrics/apples/2026-07-25-prefab-set-piece-rooms.json`.

## What Was Done

Made hand-authored set pieces **authoritative prefab rooms** that own their own
real, impassable wall ring + door slot(s). Map generation now carves/sizes the
Floor 1 welcome-office hub room to the prefab footprint and lands the shell as
**TILE WRITES** (never ECS entities — the determinism invariant in
`world-objects.ts:241` is preserved; entity-id allocation for dressing would
perturb the global RNG and break headless↔rendered determinism).

- **Schema:** added `doorSlots` (`fixed` | `dynamic`) to `SetPieceDef` +
  Zod `superRefine` (`src/shared/set-piece-types.ts`), plus
  `resolveSetPieceDoorSlots(def)` returning the deterministic authored door set.
- **Core carve:** new pure `src/core/map/carveSetPieceRoom.ts` — resizes the hub
  `RoomData.bounds` to the footprint (COINCIDE: the prefab ring IS the room
  perimeter wall), rejects footprints that would overlap a neighbour room
  (`rectsOverlap` → `fitted:false`), punches declared/resolved doors,
  `sealRoomPerimeter` converts load-bearing ring breaches (corridors joining the
  room) into ADDITIONAL doors so no region strands, and a step-6 connector
  backstop carves from the primary door if the interior is unreachable.
- **Production wiring:** `carveWelcomeRoomPrefab` in `src/game/floorScenario.ts`
  replaces the render-only structural-tile path for the welcome room; safe-room
  sealing + boss-stair/slime-rat door gating that read `room.doors` reconcile
  against the rewritten door set.
- **Migration:** authored a door slot + ring door prop on all 13 defs
  (`set-pieces.json`); `welcome-room` got a full shell; `nyc-bodega`'s bugged
  interior door (4,5) moved to a plausible street-entrance wall tile with a clear
  approach. `npm run setpiece:score` `shell-integrity` now green on all 13.
- **Reachability gate (core deliverable):** `src/game/set-piece-reachability.ts`
  runs the REAL `initializeFloor1Scenario` per seed and asserts (lock-aware, so a
  hub reachable only through an initially-locked quest door FAILS): #0 carved
  (GROUND TRUTH `scenario.welcomeRoomCarved` = `carveWelcomeRoomPrefab`'s
  `fitted`, persisted through scenario state — NOT the old `bounds==footprint`
  proxy; see round-2 fix below), **#0a** defense-in-depth (a `fitted` carve whose
  bounds diverge from the footprint is a distinct carve bug), **#0b positive shell**
  (perimeter impassable, doors carry `TileFlags.DOOR` + on-ring, count `>=`
  resolved slots), #1 interior reachable,
  #2 doors reachable, #3 NPC anchors reachable, #4 topological no-strand. Degraded
  (render-only) is a first-class reported count and a HARD failure.
- **Sweep:** `scripts/agent/set-piece/reachability-sweep.ts` + local smoke test.
  Broad CI sweep runs on the PR `pull_request` trigger (rule #15).

**Observed on the real production path** (`initializeFloor1Scenario`, not a lab —
`files/observe-welcome-room-after.txt`) — before: welcome-room was render-only
(walk-through, no impassable ring, no real `RoomData` door); after: seeds 21 & 1
both carve a 10×9 room with a full impassable `#` wall ring, exactly one real
`+` DOOR on the ring, **0 perimeter open-breaches**, interior fully reachable
through that door. Seed 21 (previously lock-stranded) now passes. Local sweep
1–150: **150/150 reachable, 0 degradations** (re-run 1–50 after the round-2 fix:
50/50, 0 degradations).

## Rebase + round-2 review fix

- **Rebased onto `nalfeo-jubilant-tribble` @ `38dc3ab17`** (Asset Forge wave: 14
  welcome-room custom→catalog art refs + updated `set-piece-types.test.ts`). All 6
  commits reapplied cleanly — my edits touched `props`/`doorSlots`, the art wave
  touched per-prop `layers[].sprite`, so different JSON regions. Verified
  post-rebase: welcome-room has 0 `source:'custom'` / 49 catalog refs, 0 bad
  `generated:`-prefixed `spriteId`s (parent's art survived), AND my shell (33 wall
  props + 1 ring door at (5,8)) survived.
- **Round-2 multi-model review found a real false-pass (gpt-5.4, adjudicated
  VALID):** the gate derived `carved` from a PROXY (`room.bounds == def footprint`).
  Floor 1's room-size config permits a coincidentally-10×9 generator room; on a
  no-fit `carveWelcomeRoomPrefab` returns `{fitted:false}` WITHOUT mutating bounds,
  then safe-room sealing hardens the unchanged perimeter — so a render-only degraded
  floor could pass #0/#0b and falsely report an authoritative carve (the exact
  false-green the parent plan-review flagged). **Fix:** persist `welcomeCarve.fitted`
  → `scenario.welcomeRoomCarved` and gate #0 on that ground truth; keep
  `bounds==footprint` as defense-in-depth (#0a). Confirmed clean by two distinct
  models (claude-sonnet-4.6 + gpt-5.3-codex).

## Key Decisions Made

- **COINCIDE, not nest:** the prefab wall ring maps exactly onto the room's
  perimeter — one wall, one source of truth. Confirmed against `DungeonGenerator`
  (bounds already include the 1-tile wall border).
- **Door count is a MINIMUM (`>=`), not exact:** `sealRoomPerimeter` legitimately
  adds connectivity doors beyond the def's declared slots to keep crossing
  corridors open. Exact-match was a mis-specified assertion (falsely failed seed
  2024); a count BELOW the declared floor is still a hard failure.
- **Fallback is honestly 2-tier, not 3:** carve-in-place → render-only. No
  "alternate hub room" tier was built (the welcome office is a single resolved
  hub). `carved` fully distinguishes the two states; render-only degradation is a
  hard sweep failure, never a resting state (parent pushback #1/#3).
- **Reachability is necessary but not sufficient:** render-only has no walls so it
  is trivially reachable — the sweep would be greenest exactly when the feature
  silently failed. Check #0b positively asserts the shell landed (parent blocking
  feedback #1). This caught 2 real bugs.

## What's Next / Blockers

- **PR open + CI sweep run-id pending.** The zero-tolerance sweep runs on the PR's
  `pull_request` trigger; capture the run-id and report it with the
  `project:sweep-results-viewer runId=<id>` deep link (rule #17).
- **Parent's Asset Forge commit:** parent will land the 14 `welcome-room` catalog
  refs into `set-pieces.json` (same region migrated here). Rebase when it lands.
- **Floor 2+ prefabs:** the carve mechanism is general but only exercised in
  production on `welcome-room`. New prefabs need their own reachability sweep.

## Retrospective

### Lessons Learned

- The reachability gate's own `initializeFloor1Scenario` invocation IS a valid
  "observe before done" real-pipeline artifact (rule #9) — a lab would not have
  been sufficient, and it doubled as the hard gate.
- Writing a POSITIVE assertion (does the shell exist?) rather than only a negative
  one (is it reachable?) is what surfaced both real bugs. An "it works" test that
  passes when the feature is absent is worse than no test.

### Mistakes Made

- Initially specified the door-count assertion as exact-match; it falsely failed
  seed 2024 because `sealRoomPerimeter` adds load-bearing connectivity doors by
  design. Early signal: any assertion of an EXACT count on a value another system
  is allowed to increase is suspect — prefer `>=` a declared floor.
- The seed-21 lock-aware connector repair tunneled the BFS-shortest path through
  wall rock and clipped the carved room's OWN perimeter (5 non-door breaches).
  Early signal: a "carve the shortest connector" BFS must be given the room's own
  footprint as an `avoid` set, or it will happily re-open the walls you just laid.

### Opportunities for Future Improvement

- The step-6 connector backstop and the lock-aware repair both do BFS-through-rock
  carving with subtly different `avoid` semantics; a shared, well-tested
  "extend-door-outward" primitive would remove a class of ring-breach bugs.
- Promote the ASCII shell-render observation into a committed deterministic
  golden-render check so future prefab regressions are caught without a manual
  observe step.

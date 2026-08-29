# 2026-08-29 — Attack-wave review fixes (PR #3878 shepherd)

## Systems touched

attack-waves, barriers, labs

## What happened

Shepherded PR #3878 (`feat(game): add periodic rat attack waves`) through its
Copilot review round. #3878 re-authors closed #3823 from the identical head
branch `crawler-quarantine-repair/pr-3766-2181b0187d47`; the original chain was
authored by the `crawler-ci` GitHub App, which is why it could never receive a
Copilot review or be admitted by the merge train (GitHub rejects
`POST /pulls/{n}/requested_reviewers` for the Copilot reviewer on App-authored
PRs with HTTP 422). Re-authoring on a writable branch unblocked the review.

Three substantive Copilot findings, all fixed in code:

1. **Analytic ring walls could be pathed through.** The safe-room suppression
   flow field's `isTilePassable` predicate sampled barriers only at tile
   centres (`hasBarrierAtPoint(cx, cy)`). `createRingWallBarrier` stores an
   _analytic_ `BarrierRingShape` that owns **no tiles** and can be thinner than
   one tile, so a band at 9–10 ft on a 4 ft grid crosses the edge between
   adjacent centres at 8 ft and 12 ft without either centre lying in it. The BFS
   then reported a walkable path out of a physically sealed spawner arena,
   computed a short pathable distance to a safe room, and **suppressed a due
   wave**. Fixed by adding `ringBandIntersectsRect` (exact rect↔annulus overlap,
   squared distances only, no allocation) and `isBarrierBlockingArea`, and
   testing the whole tile _square_ instead of its centre.
2. **Lab Reset left the wave population at the cap.** `api.reset` cleared
   scheduler state only, so once the lab hit `maxAliveFromWaves` a reset still
   sat at the cap and the next Spawn action produced nothing.
3. **Post-system ran after the run ended.** `attackWaveSystem` only checked
   `floorId`. It is registered in `postSystems` _after_ `floorObjectiveSystem`,
   which can set `game_over` on timeout in the same pass, so a due wave still
   drew RNG and spawned rats post-run.

## Key decisions

- **Over-block, don't model edges.** `computeMultiSourceFlowField` takes a
  **node** predicate, not an edge predicate, so blocked _transitions_ cannot be
  expressed. Conservative rasterization of the analytic band is the correct
  shape here, and the failure direction is safe: over-blocking can only make the
  safe room _unreachable_ (`distance === -1` ⇒ no suppression ⇒ the wave fires).
  It can never manufacture a suppression.
- **`isBarrierBlockingArea` reads `world.barriers` directly** rather than going
  through `FloorMap`, so it works even when `attachBarriersToFloorMap(world)`
  was never called — many tests skip that step. It short-circuits `false` when
  `ringShapes.size === 0`, so Floor 1 (which raises no ring walls) pays nothing.
- **Kept the centre `hasBarrierAtPoint` check.** The area test subsumes it for
  ring shapes, but `FloorMap.barrierPointLookup` is a generic injected closure
  that labs/tests can stub with non-ring semantics. Keeping both is strictly
  more blocking, and more blocking is the safe direction.
- **Extracted `despawnWaveRats(world)` from the lab** instead of inlining the
  fix, so the reset path is coverable without a DOM. It uses the
  `clearEntityStores` + `removeEntity` pattern from `deathTimerSystem` so the
  side-car maps (`enemyAppearanceKeys`, status effects, weapon skills) are
  cleared, not just typed-array slots.
- **The run-state gate sits before `attackWaveState ??= {...}`** so no scheduler
  object is allocated on the inert path, matching the existing `floorId` guard's
  contract that inert paths leave `world.attackWaveState === undefined`.

## Verification

- `npm run verify:fast` — green, twice (before and after the `origin/main`
  rebase). 3401 unit tests pass.
- **Fail-to-pass proof for finding 1:** with the new `isBarrierBlockingArea`
  check stubbed out, the new `createRingWallBarrier` seal test fails with
  `expected +0 to be 10` (no wave fired ⇒ still wrongly suppressed). With the
  fix, the wave fires.
- New coverage:
  - `tests/game/attack-wave-system.test.ts` → `analytic ring wall
(createRingWallBarrier)`: production-path seal test plus a no-wall control,
    asserting every surrounding tile centre reports `hasBarrierAtPoint === false`
    so the test pins the exact sub-tile gap.
  - `tests/game/attack-wave-system.test.ts` → `run-state gating`: parameterised
    over `game_over` / `level_up` / `paused` / `loadout`, asserting zero spawns
    **and** zero RNG draws, plus a resume-on-`playing` test.
  - `tests/unit/barriers/registry.test.ts`: direct unit coverage of
    `ringBandIntersectsRect` and `isBarrierBlockingArea`.
  - `tests/unit/attack-wave-lab-reset.test.ts`: side-car clearing plus the
    cap-recovery scenario the reviewer described.

## Gotchas for the next session

- **`node_modules` was missing** in this worktree; `npm ci` first (~51 s).
- **Do not run `scripts/agent/lab-gate-check.sh` on Windows** — CI enforces it.
- `tests/game/attack-wave-system.test.ts` mutates the module-level `TUNING`
  object. The pre-existing test at the `safeRoomSuppressionTiles = 10` line
  never restores it; new tests here save/restore in a `finally`. Watch for
  ordering-dependent failures if you add tests between them.
- The PR is on a **normal writable branch**, so the merge train can
  `update-branch` it — unlike the `copilot/*` and coding-agent branches in the
  #3713 → #3766 → #3823 chain that caused the original quarantine.

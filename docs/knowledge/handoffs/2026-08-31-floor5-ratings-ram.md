# Session Handoff: Floor 5 Ratings Ram

## Date

2026-08-31

## Persona

Producer → Systems Engineer / Game AI / QA

## Systems touched

ai-pathfinding, ai-behavior-tree, mapgen, quests, enemies, devtools, ci-policy

## Apples

5🍎 estimated, 5🍎 actual.

## What Was Done

Implemented Floor 5 Slice 5 for issue #3915.

- Added manifest-backed Ratings Ram health, route, protection, movement, strike,
  counter-damage, and recovery contracts.
- Added typed ram, route-marker, construction, breach-cleanup, and RunStats
  state.
- Wired `siegeRamSystem` through the real Floor 5 `ScenarioDefinition` path
  shared by the game and headless runner.
- Added construction, protection, semantic-route movement, deterministic
  destruction/rebuild, wall-only damage authority, and outcome precedence.
- Added an atomic one-shot breach transaction that drops the ingress barrier,
  retires siege actors and the wall, freezes the front, and clears all wave
  remainder, debt, and queues.
- Included barrier registry versions in enemy and behavior-tree navigation
  signatures and fixed recycled `Uint32Array` ECS fields.
- Extended Floor 5 RunStats, headless progress scoring, and the Floor 5 siege
  lab.
- Fixed review-discovered permanent build deadlock by deriving construction
  pressure from current nearby hostile actors rather than cumulative Command
  Post damage.
- Reconciled the branch with current `main` while preserving both Floor 5
  Ratings Ram and Floor 6 Broadcast Relay component/store contracts.
- Wired the Ratings Ram and route-marker component stores so bitecs `set(...)`
  payloads populate their typed arrays.
- Made the headless stall watchdog advance only for monotonic authored-route
  progress or lifecycle milestones, so a stuck or oscillating escort now
  deterministically reports a stall instead of timing out.
- Routed the siege lab's step control through the canonical fixed-step pipeline
  and restored focused live-threat construction pause/resume coverage.
- Made cumulative strike telemetry survive the required rebuild and constrained
  manifest exchange values to exactly one destroyed ram before breach.
- Deferred escort and rebuild phase progress until after the objective tick's
  Command Post terminal check, with regressions for ready-ram and simultaneous
  Command Post/wall/ram lethality.
- Matched the manifest strike-range guard to the runtime's near-tile-edge stop
  distance and surfaced the exact ram lifecycle in the siege lab.

## Real-Artifact Observation

Before the review fix, construction pressure was derived from
`commandPostHealth < maxHealth`; because the Command Post does not heal, one
point of historical damage could prevent the required rebuild forever.

After the fix,
`tests/headless/floor5-ratings-ram.test.ts` pre-damages the Command Post and runs
the real headless Floor 5 pipeline with a 600-frame stall detector. Seed 505
observes exactly:

`BUILDING → READY → ADVANCING → ATTACKING → DESTROYED → BUILDING → READY → ADVANCING → ATTACKING → BREACHED`

The run stops on the breach latch and proves one breach transition, semantic
waypoint order, wall-only ram damage, zero remaining spawn debt, complete actor
cleanup, a barrier-version increase, post-breach pathfinder reachability, and no
stall.

## Verification

- Focused Floor 5 real-pipeline and schema tests: 4 files / 28 tests passed
  after the final `main` merge.
- `npm run typecheck` passed.
- Targeted ESLint and Prettier checks passed.
- `npm run check:wired-systems` passed with 68 systems checked.
- `npm run check:silent-reverts` inspected both reconciliation merges and found
  no surviving silent reverts.
- The shell wrappers `npm run verify:fast` and
  `bash scripts/agent/lab-gate-check.sh` could not execute because this Windows
  host resolves `bash` to WSL and has no Linux distribution installed. Their
  cross-platform constituent checks above passed; CI remains authoritative for
  the shell-only gates.
- `npm run verify:pr-prereqs` identified the missing cross-layer ADR; this
  session added `docs/knowledge/adr/2026-08-31-floor5-ratings-ram.md`.

## Key Decisions

- Ram movement/protection stays pre-AI; all damage consequences stay in the
  objective tick.
- Command Post defeat outranks a same-tick breach; wall lethality outranks ram
  lethality after base precedence.
- Construction pressure is a current-threat predicate, not a permanent damage
  latch.
- Breach state is latched only after collision and cleanup are committed.
- Headless stall detection includes monotonic ram progress and stops observation
  at the slice's breach completion rather than waiting for a later Floor 5
  slice's final victory.
- The attack range must cover the wall from the near edge of the authored
  breach-approach tile, not merely from that tile's center.

## Shepherd Intervention Log

- Manually merged current `main` twice because the quarantined PR branch was
  conflicting and the pre-publish rebase could not replay the long branch
  history. The first merge had one component-tag conflict; it preserved both
  Floor 5 siege and Floor 6 relay tags. The second merge was conflict-free.
- Restored three files to exact `main` content after the first merge because the
  stale branch otherwise retained unrelated formatting changes. The
  silent-revert guard confirms no stale merge result survives.
- Added store wiring, monotonic route-projection stall scoring, canonical lab
  stepping, exact manifest exchange/geometry guards, terminal-precedence
  ordering, and focused regressions because the original automation correctly
  escalated a real five-apple implementation gap rather than attempting a
  review-sized patch.
- Ran repeated independent two-model review rounds because each material
  lifecycle correction changed the reviewed diff. Findings were fixed before
  thread resolution rather than marked inapplicable.
- Permanent process improvement: when a closing-keyword PR contains only a
  planning artifact, CI Recovery should compare issue acceptance requirements
  with executable/test changes before allowing merge-train admission, and the
  sync helper should prefer a merge for long-lived shepherd branches that
  already contain a current-main reconciliation merge.

## What's Next

- No known Slice 5 blocker remains.
- Later Floor 5 slices own courtyard combat, Regent defeat, castle capture, and
  the final released-floor balance gate.

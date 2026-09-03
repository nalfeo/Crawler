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

- Focused Floor 5 and entity recycling tests: 3 files / 20 tests passed after
  review fixes.
- `npm run typecheck` passed.
- Targeted ESLint and Prettier checks passed.
- `npm run verify:fast` passed before the review-fix round: 147 files / 2,397
  tests plus integrity checks. Rerun on the final tree before publication.
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

## What's Next

- No known Slice 5 blocker remains.
- Later Floor 5 slices own courtyard combat, Regent defeat, castle capture, and
  the final released-floor balance gate.

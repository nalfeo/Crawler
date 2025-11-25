# Handoff: Spatial-Scoping Performance Optimizations

**Date**: 2026-07-06  
**Branch**: `copilot/investigate-cpu-intensity-optimizations` (PR #802)  
**Apple estimate**: 🍎🍎🍎 (actual: 🍎🍎🍎 — the byte-neutrality investigation +
two reverts + parity proof made this a 3-apple shepherd, not the original 2)

## Systems touched

ai-pathfinding, ai-behavior-tree

## Outcome (what actually ships)

Of three CPU optimizations originally on this branch, **only one ships** — the
other two were reverted because they were **not behavior-preserving**, which a
perf optimization must be (project rules #12/#13; enforced by the
`collision-pair-parity` headless golden and a 10-seed differential sweep).

### SHIPS — 1. `FloorMap.clearVisibility()` bounded bounding box

`src/core/map/FloorMap.ts`

`clearVisibility()` previously zeroed the full sub-tile bitmap (134,400 cells at
480×280, subFactor=2). It now tracks a bounding box of sub-tile cells set by
`setVisible()` and zeros only that box on the next clear. With FOV radius=25
tiles this caps the clear to ≤10,201 cells — ~13× reduction.

New private fields: `lastFovMinX/Y/MaxX/Y`. Initial state is the "empty"
sentinel (`minX=subWidth, maxX=-1`). `revealAll()` sets the box to the full
extent; `setSubFactor()` resets it to empty on reallocation.

**Byte-neutral** — proven two ways: (a) a 10-seed differential sweep (this opt
on, siblings off) matched merge-base on every seed; (b) by construction —
`setVisible` expands the bbox to the exact union of the cells it writes and
`clearVisibility` zeros exactly that bbox, so no `visible` cell survives a clear
and no writer bypasses `setVisible`.

### REVERTED — 2. Windowed flow-field BFS (not byte-neutral)

`src/core/map/flow-field.ts`, `src/core/systems/fovSystem.ts`,
`src/game/enemyAISystem.ts`, `tests/ecs/flow-field.test.ts` — all reverted to
merge-base (`git checkout origin/main`).

The windowed BFS restricted flow-field distances to a 44-tile box around the
player. An in-aggro enemy whose graph shortest-path **detours outside the
window** gets `FLOW_UNREACHABLE` or a suboptimal in-window distance, so
`flowFieldStep` picks a different gradient step than the full-map field →
different enemy movement → combat/RNG cascade. A 10-seed sweep (opt head H vs
merge-base B) diverged at **seed 88**: H=`kills:9,dmg:286` vs B=`kills:8,dmg:273`.
Disabling only the windowing restored B on all 10 seeds. No finite radius fixes
this (a winding corridor forces arbitrarily long paths for a spatially-close
enemy), so removal is the only byte-neutral fix.

Future byte-neutral alternative (noted in ADR-0047): an _early-termination_
full-map BFS — stop once every current chaser's tile is reached, no spatial
bounds — recovers most of the savings without ever clipping a path the full-map
BFS would produce.

### REVERTED — 3. Chebyshev enemy pre-filter (not byte-neutral)

`src/game/enemyAISystem.ts` — reverted.

The pre-filter's early `continue` (velocity=0) skipped `applyIdleWander`, which
consumes shared `world.rng` draws (wander angle + duration). Skipping them
shifted the shared RNG stream for every subsequent enemy/frame (incl.
projectile-accuracy rolls) → seed-42 golden fingerprint drifted
`{k7,d261,dt25,s8}` → `{k6,d159,dt0,s4}`. Idle-wander is both observable
(velocity) and RNG-consuming, so the filter cannot be both a cheap early-out and
byte-identical.

### Tests

- `tests/ecs/fov-system.test.ts` — bounded-`clearVisibility` tests (targeted
  clear, empty-bbox no-op, revealAll full-clear). **Retained** (opt #1).
- `tests/game/enemy-ai-coverage.test.ts` — generic "inside-FOV-outside-aggro
  enemy still wanders" regression. **Retained** (valuable, opt-independent).
- `tests/ecs/flow-field.test.ts` — reverted with opt #2 (window tests removed).
- `tests/game/enemy-ai.test.ts` — net-zero vs merge-base (Chebyshev tests
  added then removed cancel out).

### ADR

ADR-0047: `docs/knowledge/adr/0047-spatial-scoping-performance.md` (updated to
record decisions 2 & 3 removed; only decision 1 ships).

## Review (🍎🍎🍎 tier)

- **Plan review** — `gpt-5.4`: sound, no blocking concerns; suggested a
  multi-seed parity sweep to certify the retained opts byte-neutral (done — it
  surfaced the seed-88 opt#2 divergence).
- **Code-review loop**:
  - Round 1 (`claude-sonnet-4.6`): 1 major concern — windowed BFS reroutes
    in-window enemies whose global shortest path exits the window. **Resolved by
    reverting opt #2.**
  - Round 2 (`claude-opus-4.8`): confirms final state clean (reverts complete,
    no dangling opt#2/#3 symbols, opt #1 byte-neutral, CI/vitest safe).

Ledger: `docs/knowledge/review-ledgers/2026-07-06-spatial-scoping-perf.review-ledger.json`

## Verify (observe-before-done — real artifacts, not a lab)

- `tests/headless/collision-pair-parity.test.ts` seed-42 fingerprint:
  **before** (opt head) drifted off golden → **after** (opt #1 only) ==
  golden `{totalFrames:1500,outcome:'timeout',kills:7,damageDealt:261,damageTaken:25,finalScore:8}`. 2 passed.
- 10-seed differential sweep: reverted head == merge-base on all of
  `[42,1,3,7,21,88,123,500,1000,9999]` (byte-neutral proof).
- `npm run typecheck` clean; `fov-system` + `enemy-ai-coverage` 33 tests pass.
- `VERIFY_FULL=1 npm run verify` — full headless Floor-1 gate green
  (floor1-completion per-weapon floors + arena-lockin).

## Known non-issues

- Flow field is full-map again (as on `main`) — no windowing, no
  `FLOW_UNREACHABLE`-for-distant-enemies behavior change.
- `clearVisibility` with an empty bbox (before the first FOV pass) is a no-op;
  correct because the bitmap is all-zero at construction and every `visible`
  writer goes through `setVisible`.

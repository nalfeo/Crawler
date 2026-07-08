# Session Handoff: NAVMESH follower unit tests (dormancy + functional + partial-path guard)

## Date

2026-07-08

## Persona

Systems Engineer

## Systems touched

ai-pathfinding, ai-behavior-tree

## Apples

1🍎 estimated, 1🍎 actual (exact) — single tests-only file (~175 LOC), no runtime/src change, deterministic. Full JSON in `docs/knowledge/metrics/apples/2026-07-08-navmesh-follower-tests.json`.

## What Was Done

Small standalone follow-up to the merged Slice-3 navmesh PR (#913, `a6a7987f`). Added `tests/unit/ai/navmesh-pathing.test.ts` (mirrors `tests/unit/ai/fused-pathing.test.ts`) so the invariants Slice 4 builds on are permanently CI-gated — previously only the report-only `ai:navmesh-sweep` exercised them. Four cases, all through the **real** `BehaviorTreeAI.poll` path:

1. **Dormancy** — LEGACY AI polled 16× on Floor-1 seed 42: `navPartialPathFallbacks === 0`, `getNavigationDebug().navWaypoints` empty, `navPathIndex === 0`. The navmesh follower is fully dead unless `pathingMode === NAVMESH` (poll dispatch is a hard mode gate at `bt-ai-provider.ts:2617`).
2. **Byte-identity** — two identically-seeded LEGACY AIs polled in lockstep produce byte-identical `InputState` streams, asserted via `toStrictEqual` per poll (direct deep equality — not the lossy `JSON.stringify`, which drops `undefined` and is lossy for `NaN`/`-0`). Structural proof that "navmesh code present ⇒ LEGACY unchanged" — the ship-safety property the autonomous-ship authorization rested on.
3. **Functional navmesh** — NAVMESH AI on seed 42 populates `navWaypoints` via real recast routing (`moveTowardViaNavmesh` → real `queryWorldPath`) and produces motion; guard stays dormant (counter 0) because the real Floor-1 route reaches goal. Non-inert vs LEGACY (which never populates `navWaypoints`).
4. **Partial-path guard** — `vi.mock` overrides ONLY `queryWorldPath` to return a non-reaching 1-waypoint stub at the start point → `reachesGoal === false` → `navPartialPathFallbacks` increments AND the AI keeps moving (grid-A\* `moveToward` fallback), never accepting the stub as a route. This is the exact freeze-forever regression the guard fixes.

Observation (rule #10, tests-only): the tests ARE the observation — cases 3/4 drive the real poll path and assert on real recast routing + the real guard/fallback. `npm run test:unit -- navmesh-pathing` → 4/4 pass (4.06s). `npm run verify:fast` green (typecheck + lint + unit + size/weight/physics coverage).

## Key Decisions Made

- **Mock the recast boundary (`queryWorldPath`), not the map, for the guard case.** A naturally-severing real (start,goal) pair is seed-specific + slow (only known natural fire is baseball-bat seed 8, needs a full headless run). recast's actual `⊊ grid` severing is already covered by the golden cross-platform determinism test (`75917f12`); this unit locks the **follower's handling** of a non-reaching return, which is the guard's actual job. The spy calls through to real `queryWorldPath` by default so the functional case still exercises genuine recast routing; only the guard case opts into the stub, restored in `afterEach`. Each NAVMESH-mode case's built recast handle is freed in a tracked-AI top-level `afterEach` via `disposeNavmesh()` (exception-safe; frees only the per-floor handle, not the `initNavmesh()` runtime) so the WASM handle never leaks across the unit process.
- **`navPartialPathFallbacks` is public + unconditional** (sim never reads it → determinism-safe), so the guard is directly observable without a private-internals cast (unlike the fused scorer's `getFusedDebug`).
- 1🍎 tier → no review stages required, but a valid ledger is still recorded (tests are NOT exempt; only docs/art/deps-only are). Ledger: `docs/knowledge/review-ledgers/2026-07-08-navmesh-follower-tests.review-ledger.json` (validates, exit 0).

## What's Next / Blockers

- **Slice 4** (danger/reward seams on the navmesh path) is the next work — the creator (AI Rework session) sends the scoped brief once this lands. Slice 4 now inherits a green regression net: if it accidentally perturbs LEGACY (byte-identity) or the partial-path guard, CI catches it instantly.
- No blockers. PR opened non-draft, auto-merge armed (`--squash`); resolves the 8th copilot-reviewer thread on #913 (`bt-ai-provider.ts:3963` — "navmesh follower has no CI-gated unit test").

## Retrospective

### Lessons Learned

- **Load-bearing carry-over (recast ⊊ grid):** recast navmesh reachability is a strict SUBSET of the 4-connected grid at thin/door connectors under the pinned deterministic config. Removing one relocked door tile SEVERS the navmesh path but not the grid path → undetected partial path → the original freeze. That is WHY the follower needs the partial-path guard, and WHY the shipped foundation is static all-doors geometry (built once/floor, no rebuild) with door-lock semantics deferred to Slice-4 query-time costs. Test case 4 is the permanent unit-level lock on the guard; the golden `75917f12` determinism test is the geometry-level lock.
- `vi.mock` of a module used by the code-under-test: spread `...actual` and replace only the one export (`vi.fn(actual.queryWorldPath)` for call-through by default), then `mockImplementation` per-test + restore in `afterEach`. Both functional (real query) and guard (stubbed query) cases coexist cleanly in one file this way.
- The unit test is fast (~3–4s incl. WASM `initNavmesh` in `beforeAll`) — no need for a headless run to lock these follower invariants.

### Mistakes Made

- None material this session. The design was fully derived (template + exact API line-refs) before writing, so the file passed test-run and verify:fast on the first attempt with non-vacuous assertions (asserting `sawNavRoute===true` / `navPartialPathFallbacks>0`, not just "no throw").

### Opportunities for Future Improvement

- A future headless fixture could pin the ONE natural guard-fire seed (baseball-bat seed 8) as a determinism-style regression test, complementing this unit-level mock — proving the guard fires on real severing, not just a stub. Out of scope for a 1🍎 follow-up.
- Slice 4 should add coverage that danger/reward costs apply to the FULL navmesh route (no grid-A\* fallback segments on the dormant path) so the A/B stays a true pure-navmesh comparison.

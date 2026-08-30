# Session Handoff: Floor 5 siege foundation

## Date

2026-08-30

## Persona

Producer → Systems Engineer / Game AI / QA

## Systems touched

mapgen, ai-behavior-tree, ci-policy, devtools

## Apples

3🍎 estimated, 3🍎 actual (exact; cross-layer floor foundation with required
review ledger, lab, map/scenario/AI wiring, and focused tests)

## What Was Done

Implemented Floor 5 Slice 1 foundation for issue #3911.

- Added `src/shared/data/floors/floor5.manifest.json` and manifest/registry
  support for `floor5`, including unreleased/non-MVP status, authored siege
  geometry, phase skeleton, and RNG stream labels.
- Added `BiomeType.SIEGE_CASTLE`, `MapConfig.siegeCastle`, and
  `src/core/map/generators/SiegeCastleGenerator.ts` for the deterministic
  Command Post → Siege Yard → breach → courtyard → throne authored map.
- Added Floor 5 siege state/run-stats types and `src/game/floor5Scenario.ts`
  with `initializeFloor5Scenario`, manifest-derived isolated RNG stream keys,
  and a narrow `siegeDirectorSystem` boundary.
- Wired Floor 5 through `src/game/scenarioDefinitions.ts`, the windowed
  `createFloorMainSceneOptions` path, headless RunStats collection, and game
  exports.
- Added and registered `src/labs/floor5-siege-lab/index.ts` for the required
  lab.
- Added focused regression coverage in
  `tests/unit/floor5-siege-map.test.ts`,
  `tests/headless/floor5-siege-foundation.test.ts`,
  `tests/unit/floor-registry.test.ts`,
  `tests/unit/scenario-definitions.test.ts`, and
  `tests/game/floor1-main-scene-options.test.ts`.
- Added ADR
  `docs/knowledge/adr/2026-08-30-floor5-siege-foundation.md` and review ledger
  `docs/knowledge/review-ledgers/2026-08-30-floor5-siege-foundation.review-ledger.json`.

Real-artifact observation: `tests/headless/floor5-siege-foundation.test.ts`
boots Floor 5 through `createFloorMainSceneOptions('floor5')` and through
`runHeadless({ floorId: 'floor5' })`, then asserts identical Floor 5 siege
RunStats and an identical serialized map artifact (config, player spawn, room
bounds/roles/labels/neighbors, tile flags, and terrain). Both traces are empty
after normal boot.

## Verification

- `bash scripts/agent/preflight.sh` — passed.
- `npm run typecheck` — passed.
- `npm test -- tests/unit/floor5-siege-map.test.ts tests/headless/floor5-siege-foundation.test.ts tests/unit/floor-registry.test.ts tests/unit/scenario-definitions.test.ts tests/game/floor1-main-scene-options.test.ts` — passed, 5 files / 74 tests.
- `npm run verify:fast` — passed, 147 files / 2397 tests plus data-contract and integrity checks. Local silent-merge-revert guard skipped because history is shallow; CI runs it with full history.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-30-floor5-siege-foundation.review-ledger.json` — passed.

## Review Harness

- Plan review: `gpt-5.4` rubber-duck review approved the architecture with
  changes. It found route latch and parity-test gaps; both were fixed before
  final validation. It also flagged geometry/RNG drift risks; runtime RNG stream
  keys now derive from manifest-backed helpers.
- Code review: `claude-sonnet-4.6` code-review round found no code/runtime
  issues and only noted the then-incomplete review ledger, which was completed.
- Independent grade: `gemini-3.1-pro-preview` passed the final diff with no
  findings.

## Key Decisions Made

- **ScenarioDefinition is the single wiring seam.** Floor 5 setup, director
  system, AI task config, run-stats collection, and presentation contract flow
  through the same scenario definition used by windowed and headless runtime
  paths.
- **The breach is passable in Slice 1.** This preserves the required reachable
  Command Post-to-throne map. Later breach gameplay must introduce the atomic
  collision/navigation transition without invalidating parity.
- **The phase trace starts empty.** `MUSTER` is stored as current state, but no
  boot event is emitted because the issue's done condition calls for an empty
  deterministic phase trace.
- **The director stays narrow.** `siegeDirectorSystem` only tracks phase/latch
  authority and abnormal defeat transition state. Spawning, pathfinding, damage,
  attacks, waves, Heroes, ram behavior, and presentation remain future systems.

## What's Next / Blockers

- No known implementation blocker remains for Slice 1.
- Later slices should reuse the manifest-backed Floor 5 map config/layout helper
  rather than re-deriving landmark geometry.
- Later live siege gameplay needs dedicated systems for minions/waves, Heroes,
  Ratings Ram construction/escort/destruction, breach transaction, courtyard
  and throne capture, and honest defeat/victory telemetry.
- Floor 5 remains unreleased/non-MVP and should not be included in implemented
  floor sweeps until later slices provide a real win condition.

## Retrospective

### Lessons Learned

The separate-model plan review was run after initial implementation rather than
before coding, which was a process miss. It still produced useful findings:
strengthen the hard-gate parity test and avoid an AI-route latch deadlock.

### Mistakes Made

An early test title still called Floor 3 the "last authored floor" after Floor 5
was added; it was corrected to cover terminal/unimplemented floors generically.
The first independent-grade packet was generated before committing the
`code_review` ledger stage, so it graded a stale ledger skeleton; the stage was
committed and the packet regenerated before recording the final grade.

### Opportunities for Future Improvement

The review-harness workflow would benefit from an explicit guard that warns when
implementation commits exist before a required plan-review stage is recorded.

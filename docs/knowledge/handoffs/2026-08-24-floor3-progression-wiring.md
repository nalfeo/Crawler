# Session Handoff: Floor 3 progression wiring (real game, headless chain, AI runner lab)

## Date

2026-08-24

## Persona

Systems Engineer

## Systems touched

quests, boss-rooms, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual

## What Was Done

Wired Floor 3 as a **reachable** destination in all three consumers named by issue
#3447, without pretending it is winnable:

- **Real game** — `floor2`'s scenario now declares `nextFloorId: 'floor3'` and
  `isTerminalRunVictory: false`. The engine transition path
  (`createFloorMainSceneOptions` → `onFloor1Cleared` → `restartWithOptions`) is
  already generic, so no engine floor-branching was added. Completion and
  stair-confirmation copy no longer claim the run ends at Floor 2.
- **Headless runner** — `resolveFloorChain` gained an opt-in
  `includePlayableTail`, and `runProgression` now reports `winnableFloorIds` vs
  `exhibitionFloorIds`, computes `budgetMs`/`officialWin` over the **winnable**
  chain only, and tracks `winnableActiveTimeMs`. Default behavior (sweeps,
  win-rate gates, `sweep-legs`) is byte-identical.
- **AI runner lab** — the debug snapshot's `effectiveFloor` is derived from
  `hasFloorManifest(world.floorId)` instead of a hardcoded `floor1|floor2`
  union, so a Floor 3 run is labeled `floor3` rather than `unknown`. The lab's
  automatic in-process transition (`recomposeFloorTransitionOptions`) was
  already destination-agnostic and now carries Floor 2 → Floor 3.

Observed in the real artifact (rule #9), not just a lab:

- Real scene, `tests/e2e/main-game-scene-boot.test.ts` — before: taking the
  Floor 2 exit ended the run with a terminal "Victory!" screen and no Floor 3;
  after: the scene restarts in-process with `floorId === 'floor3'` and the URL
  `?floor=floor3`.
- Headless pipeline, `tests/headless/progression-chain.test.ts` — before:
  `resolveFloorChain('floor2')` stopped at Floor 2; after: seed 27 clears Floor
  2 and descends into a live Floor 3 leg with the carried-over player (level and
  gold preserved).

## Key Decisions Made

- **Floor 3 stays `implemented.mvp: false`.** `isFloorImplemented` defines both
  the sweep set and the progression win chain. Floor 3's director hardcodes
  `isVictoryReached: () => false` (spec slice 8, the Studios/Final Four
  objective, is unbuilt), so flipping the flag would make every chained run
  permanently unwinnable and null out `budgetMs`, silently degrading
  `officialWin` and the Floor-1/2 win-rate gates. That is exactly the
  "bend the gate to go green" failure AGENTS.md rules #11/#12 forbid.
- **Two explicit chains instead of one fuzzy chain.** Rather than special-casing
  Floor 3 inside the win check, `runProgression` keeps a winnable chain (what
  gates measure) and an exhibition tail (what a human/AI can actually play).
  When slice 8 lands, the tail entry becomes a winnable entry with no accounting
  rewrite.
- **New `isFloorPlayable()` is deliberately weaker than `isFloorImplemented()`** —
  scenario registered + manifest present, no victory claim. It gives callers a
  name for "you can boot and play this" without overloading the gate predicate.
- **The Floor 3 observation leg is bounded** by a floor-scoped `stopWhen`
  (`floorId === 'floor3' && elapsedMs >= 20_000`). Floor 3 has no progressing
  quest, so an unbounded exhibition leg would burn ~600s and then end as
  `'stalled'` by the quest-stall watchdog.

## What's Next / Blockers

- **Blocker for a real Floor 3 win:** spec slice 8 (`.specify/specs/floor3-companion-league.md`)
  — the Studios / Final Four objective. Until it lands, Floor 3 cannot be added
  to the implemented set, and slice 16's win-rate gate cannot be authored.
- When slice 8 ships: flip `implemented.mvp`, give floor3 a `winBudgetMs`, and
  delete the `includePlayableTail` opt-in from the chained headless test (the
  default chain will cover it). The `FloorChainOptions` plumbing can stay for the
  next unfinished floor.
- Remaining hardcoded floor unions that Floor 3 does _not_ need today but a
  Floor 4 would: `src/labs/map-gen-lab/index.ts` (`FloorConstraintId`),
  `src/labs/combat-arena-lab/index.ts` (`FloorFilter`), and
  `src/game/ai/auto-progression.ts` (`StairDescendFloor` — Floor 3 has no
  stairs, so auto-descend is genuinely N/A).

## Retrospective

### Lessons Learned

- `stopWhen` is evaluated per frame against the **live** world, so a
  floor-scoped predicate stops only the leg you care about while earlier legs
  play out in full. That turned a would-be ~10-minute chained headless test into
  a 107s one.
- The engine's floor-transition callback is still named `onFloor1Cleared` even
  though it is fully generic. Reading the name rather than the body wastes time —
  it is built purely from `scenario.nextFloorId`.
- Playwright's chromium binary was not installed in the fresh worktree;
  `npx playwright install chromium` is needed before any e2e run.
- Headless victory classification for Floor 2 reads
  `hasFloor2ExitCompleted(world)`, entirely independent of the presentation
  flags, so changing `isTerminalRunVictory` provably cannot move the win-rate
  numbers.

### Mistakes Made

- Initially reached for "just set `implemented.mvp: true` for floor3" as the
  one-line fix. The early signal that this was wrong: `isFloorImplemented` has
  _two_ unrelated consumers (sweeps and the progression win chain), so any
  change to it is never local. Grep every consumer of a gate predicate before
  flipping it.
- Wrote the chained headless test with an unbounded Floor 3 leg first; it ran
  for minutes and would have ended `'stalled'`. The early signal was that Floor 3
  has no progressing quest — check the stall watchdog's assumptions before
  adding a leg on a floor with no objective.
- A budget-sum assertion was written with an untyped `reduce` accumulator and
  failed typecheck (`TS18047`) only after the tests had already been run. Run
  `npm run typecheck` immediately after touching test files, not just source.

### Opportunities for Future Improvement

- Rename `onFloor1Cleared` to `onFloorCleared` across the bootstrap/engine
  boundary; the stale name actively misleads every agent that touches floor
  transitions.
- The AI runner lab wiring guards are source-string canaries
  (`expect(source).toContain(...)`). A small headless harness that boots the lab
  module and reads its debug snapshot would catch real regressions instead of
  string edits.
- Consider a deterministic guard asserting that every scenario's `nextFloorId`
  resolves to a registered, manifest-backed floor — the current contract is only
  covered by a hand-written unit test.

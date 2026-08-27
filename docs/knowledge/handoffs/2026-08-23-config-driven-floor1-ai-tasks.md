# Session Handoff: Config-driven Floor 1 AI task ordering

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-runner, floor-scenario, quests

## Apples

5🍎 estimated / 5🍎 actual

## What Was Done

Removed all task-specific ordering logic from the Floor 1 AI progression path.
Tasks, prerequisites, unlock events, and runtime eligibility are now entirely
scenario-config driven, while Floor 1 behavior stays **byte-identical**.

Before, `src/game/ai/floor1-goal-graph.ts` hand-built each goal node (its
prerequisites, unlock effects, work cost) with Floor-1-specific `if` ladders, and
`src/game/ai/bt-ai-provider.ts` dispatched each progress goal through a `switch`
over concrete Floor 1 goal ids. Both are decision-kernel files; every ordering
tweak meant editing them.

New structure:

- **`src/game/ai/scenario-ai-tasks.ts`** (new) — a generic interpreter with **no
  floor knowledge** (no quest ids, no NPC ids, no task ids). It defines the
  `ScenarioAiTaskConfig` contract (tasks + chains + location/NPC/effect
  vocabularies + `buildLocations`), and exports:
  - `buildScenarioGoalGraph(config, snapshot)` — chain/anchor prerequisite
    resolution + `satisfiedInitially` effect seeding + goal emission in config
    order.
  - `applyScenarioWorkCosts(config, graph, snapshot, params)` — rounded per-task
    work cost, second pass (mirrors the historical two-phase split).
  - `resolveScenarioTaskOperation`, `buildInteractionActionToTaskId` — the BT
    dispatch reverse maps.
  - `validateScenarioAiTaskConfig(config, questLookup?)` — loud load/build-time
    validation.
  - `ErasedScenarioAiTaskConfig` — the S/P-erased supertype the shared
    `ScenarioDefinition` holds (S and P are input-only, so every concrete config
    is assignable).
- **`src/game/scenarios/floor1AiTasks.ts`** (new) — the scenario-owned Floor 1
  overlay `FLOOR1_AI_TASK_CONFIG`: 20 tasks across 6 chains
  (`pre-chain`, `shop`, `merchant-weapon`, `spell-broker-purchase`, `spell`,
  `staircase`), keyed to canonical quest/objective ids from
  `src/shared/data/quests.floor1.json` plus non-quest runtime steps (gold farm,
  level grind, optional purchases). It calls `validateScenarioAiTaskConfig`
  against a quest lookup backed by the compiled registry **at module load**, so
  it fails loudly if the overlay drifts from the canonical quest source.
- **`src/game/ai/floor1-goal-graph.ts`** — reduced to a thin adapter that
  preserves its public API (`buildFloor1GoalGraph`, `applyFloor1WorkCosts`,
  `makeStraightLineTravelOracle`, `PLAYER_START_LOCATION`, the `Floor1GoalMeta`/
  `Floor1GoalGraph` type aliases) so every existing importer/test is untouched,
  and delegates to the generic engine.
- **`src/game/ai/bt-ai-provider.ts`** — the goal-id dispatch `switch` is replaced
  by `dispatchScenarioProgressOperation`, which switches only on the generic
  operation `kind` (`move_to` / `interact_npc` / `engage` / `farm` / `ambient`)
  plus four resolver binders (`resolveFloor1Location`, `resolveFloor1NpcEid`,
  `resolveFloor1Npc`, `resolveFloor1FarmCost`) that switch on operand **names**,
  never on task ids. `floor1GoalIdForNpcInteraction` now reads the config reverse
  map (`FLOOR1_ACTION_TO_TASK_ID`).
- **`src/game/scenarioDefinitions.ts`** — added `ScenarioDefinition.aiTaskConfig`
  and pointed the Floor 1 scenario at `FLOOR1_AI_TASK_CONFIG`, so the overlay is
  referenced by the scenario contract (not only imported by the AI layer).

### Chain/anchor model (how ordering is now data)

Each chain is an ordered list of task ids plus a list of anchor chain ids. The
interpreter computes each chain's pending tail (its last _present_ task, or
none). Within a chain, a present task depends on its nearest present predecessor;
the first present task depends on the concatenated tails of its anchor chains.
This reproduces the old imperative `preChainTail` / `shopTail` / `spellTail`
tail-hopping exactly. `present(snapshot)` and `satisfiedInitially(snapshot)` are
**independent** predicates copied verbatim from the old code — a door flag can
flip before the node that emits it disappears (e.g. `claim-spell-reward`:
present = `!spellsUnlocked`, satisfiedInitially = `bossBattleComplete`).

### Deliberately preserved (execution layer, not orderable policy)

`autoFloor1ProgressionSystem` (`src/game/ai/auto-progression.ts`) and the
`findProgressObjective` pre-chain in `bt-ai-provider.ts` are left **verbatim**.
They are the AI's "hands" — proximity-gated NPC interaction execution — not a
route-ordering authority. Their sequencing is fixed co-location execution
priority, not task ordering the config could reorder. Preserving them byte-for-
byte is what keeps merchant/spell reserves, reward choice, equip retry, and
stairs deferral semantics intact. The route-ordering **authority** (goal graph +
planner + dispatch) is now 100% config-driven. This boundary is recorded in ADR
0092 (CDD-008 / CDA-004).

### Observe before done (real pipeline, not a lab)

Byte-equivalence on the real headless runner
(`src/game/ai/headless-runner-cli.ts`), before and after the refactor:

- `--seed 2 --weapon sword` → **VICTORY, Total Frames: 60399, Game Time: 1006.6s**
  — identical to the pre-refactor baseline. Canonical quest log timings
  unchanged (find-welcome ✓23.0s, tutorial ✓45.9s, meet-npcs ✓193.9s,
  boss-battle ✓176.2s, shopkeeper-errand ✓193.9s, leave-floor ✓1006.6s).
- `tests/headless/floor1-completion.test.ts` and
  `tests/headless/progression-chain.test.ts` — 7 tests green (the real Floor 1 →
  Floor 2 chained pipeline).

## Key Decisions Made

- **Canonical quest source preserved.** The overlay references canonical
  quest/objective ids and validates against the compiled registry rather than
  duplicating the quest chain (ADR 0092 CDA-001).
- **Generic operation vocabulary, not Floor-1-shaped kinds.** `move_to`,
  `interact_npc`, `engage`, `farm`, `ambient` — the BT never learns a Floor 1
  task id (ADR 0092 CDD-004 / CDA-003).
- **`createProgressTarget` arity preserved.** Tasks that historically called it
  with 5 args (default eid `-1`) still do; `buy-merchant-weapon` /
  `buy-broker-spell` still pass `npcEid ?? -1` as the 6th arg. The dispatcher
  branches on `npcEid === undefined` to keep both call shapes byte-identical.
- **`ScenarioAiTaskConfig<never, never>` erasure** for the shared
  `ScenarioDefinition.aiTaskConfig` field: S and P appear only in input
  (contravariant) positions, so `never` is the sound supertype and the shared
  contract stays uncoupled from Floor 1 planner snapshot types.
- **Execution layer untouched** (see above) — a deliberate scope boundary to
  guarantee byte-equivalence, documented in the ADR.

## What's Next / Blockers

- **Review ledger is incomplete by design.** Only `plan_review` is recorded in
  `docs/knowledge/review-ledgers/2026-08-23-config-driven-floor1-ai-tasks.review-ledger.json`.
  The `code_review`, `multi_model_review`, and `independent_grade` stages are NOT
  yet run and MUST NOT be fabricated. No PR was created this session (per the
  task).
- **Reuse candidate:** Floor 2's AI progression could adopt the same
  `ScenarioAiTaskConfig` contract, retiring its own bespoke ordering. Out of
  scope here; would be its own apple-scoped change with its own byte-equivalence
  gate.
- **Follow-up option:** unify the auto-progression executor with the task
  contract once a non-byte-equivalent change is acceptable — today it is
  intentionally left as a second, execution-only sequencing source.

## Retrospective

### Lessons Learned

- The safest way to prove an AI-routing refactor is behavior-neutral is a single
  real headless seed with a known frame count (`60399`) plus the headless
  completion tests — an exact integer match is a far stronger signal than "still
  wins".
- Modeling ordering as **chains with anchors + a pending-tail rule** reproduced
  the old imperative tail-hopping dependency structure exactly, which is what let
  the diff stay byte-equivalent. Getting the tail rule right (last _present_ task,
  not last task) was the crux.
- `present` vs `satisfiedInitially` had to stay two independent predicates. A
  single "is this done" predicate would have collapsed the real window where the
  boss-battle-complete door flag is set before its emitting node disappears, and
  silently changed routing.

### Mistakes Made

- Initially imported `RunPlannerPoint` from `objective-route-planner.js` in the
  new test; it actually lives in `run-planner.js`. Read the export site first.

### Opportunities for Future Improvement

- The generic interpreter is now floor-agnostic but only has one consumer. A
  second scenario overlay (Floor 2) would validate the contract's generality and
  is the natural next reuse.
- `validateScenarioAiTaskConfig` runs at module load for Floor 1; wiring it into
  a build-time check for every registered scenario would catch overlay drift in
  CI rather than at first import.

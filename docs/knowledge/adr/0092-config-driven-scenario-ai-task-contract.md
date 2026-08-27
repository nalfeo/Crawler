# ADR 0092: Config-Driven Scenario AI Task Contract

## Status

**Accepted**

## Date

2026-08-23

## Estimated Complexity

🍎 x 5 — touches the scenario/quest/AI-routing contract across `src/game/ai/` and `src/game/scenarios/`, but adds no new lab and preserves byte-identical Floor 1 behavior.

## Context

Floor 1's AI route was authored imperatively. `src/game/ai/floor1-goal-graph.ts` hand-built every goal node, its prerequisites, its unlock effects, and its work cost with Floor-1-specific `if` ladders, and `src/game/ai/bt-ai-provider.ts` dispatched each goal by a `switch` over Floor-1 goal ids. Adding, reordering, or regating a task meant editing decision-kernel code in two files, and the ordering policy lived tangled with the generic planner and behavior-tree execution.

That coupling has three costs:

- **CDP-001** — Ordering, prerequisites, unlock events, and runtime eligibility are Floor-1 policy, but they were expressed as control flow inside reusable AI modules, so no other floor could reuse the machinery and every policy tweak risked the kernel.
- **CDP-002** — The dispatch `switch` in the behavior tree knew concrete Floor 1 goal ids, making the "AI brain" floor-aware in a layer that should only understand generic navigation.
- **CDP-003** — There was no load-time validation: a mistyped prerequisite, a dangling unlock effect, or a cycle would surface as silent mis-routing at run time rather than a loud failure at build time.

The canonical authored quest source (`src/shared/data/quests.floor1.json`, compiled to `QuestDef`s) must remain the single source of truth for the quest chain; the AI overlay must reference it, not duplicate it.

## Decision

Introduce a generic, scenario-owned **AI task contract** and move ALL Floor-1 ordering policy into validated config.

- **CDD-001** — Add `src/game/ai/scenario-ai-tasks.ts`: a generic interpreter with NO floor knowledge (no quest ids, no NPC ids, no task ids). It defines `ScenarioAiTaskConfig` (tasks + chains + location/NPC/effect vocabularies), builds the generic `GoalNode` graph (`buildScenarioGoalGraph`), applies work costs in a second pass (`applyScenarioWorkCosts`), resolves per-task generic operations (`resolveScenarioTaskOperation`), builds the committed-detour reverse map (`buildInteractionActionToTaskId`), and validates a config loudly (`validateScenarioAiTaskConfig`).
- **CDD-002** — Model ordering as **chains with anchors**. Within a chain, a present task depends on its nearest present predecessor; the first present task of a chain depends on the concatenated pending tails of its anchor chains. This reproduces the historical tail-hopping dependency structure exactly.
- **CDD-003** — Express each task's runtime eligibility as two INDEPENDENT predicates: `present(snapshot)` (should a pending node exist this frame) and `satisfiedInitially(snapshot)` (are this task's unlock effects already satisfied, seeding `initialSatisfiedEffects` without a node). They are independent because a door flag can flip before the node that emits it disappears.
- **CDD-004** — Constrain per-task navigation to a closed set of **generic operations**: `move_to`, `interact_npc`, `engage`, `farm`, `ambient`. The behavior-tree dispatcher switches only on operation `kind`; it never branches on a task id. Adding a kind is a deliberate contract change the validator enforces.
- **CDD-005** — Add `src/game/scenarios/floor1AiTasks.ts`: the scenario-owned Floor 1 overlay (`FLOOR1_AI_TASK_CONFIG`) keyed to canonical quest/objective ids plus non-quest runtime steps (gold farming, level grind, optional purchases). It validates at module load against a quest lookup backed by the compiled canonical registry, so it fails loudly if it drifts from `quests.floor1.json`.
- **CDD-006** — Reference the overlay from the scenario contract: `ScenarioDefinition.aiTaskConfig` (`src/game/scenarioDefinitions.ts`) now carries the Floor 1 config, making the linkage explicit and testable.
- **CDD-007** — Reduce `src/game/ai/floor1-goal-graph.ts` to a thin adapter that preserves its public API (so existing importers/tests are untouched) and delegates to the generic engine.
- **CDD-008** — Preserve the auto-progression executor (`src/game/ai/auto-progression.ts`) and the `findProgressObjective` pre-chain in `bt-ai-provider.ts` verbatim. They are the AI's "hands" (proximity-gated NPC interaction execution), not an orderable route-policy source; their sequencing is fixed co-location execution priority, not task ordering the config could reorder. The route-ordering AUTHORITY is now 100% config-driven; the execution layer is deliberately left byte-identical to preserve merchant/spell reserves, reward choice, equip retry, and stairs deferral.

## Consequences

### Positive

- **CDP-P01** — Floor 1 task ordering, prerequisites, unlock effects, and runtime eligibility are now editable as data in one scenario-owned file with no decision-kernel edits.
- **CDP-P02** — The behavior tree and goal graph are floor-agnostic again; the machinery is reusable by future floors that supply their own `ScenarioAiTaskConfig`.
- **CDP-P03** — Invalid config (duplicate ids, unknown prereqs/effects/locations/NPCs, cycles, required-depends-on-optional, unsupported operation kinds, unknown canonical quest/objective refs) fails loudly at load/build time instead of mis-routing silently.
- **CDP-P04** — Behavior is byte-identical: the seed 2 sword headless run is unchanged at VICTORY, 60399 frames, 1006.6s.

### Negative

- **CDP-N01** — There are now two moving parts (generic interpreter + scenario overlay) where there was one imperative file; a reader must understand the chain/anchor model to trace a route.
- **CDP-N02** — The overlay carries verbatim copies of the historical presence/effect predicates and reason strings; keeping them faithful to executor semantics is a maintenance obligation.

### Risks

- **CDP-R01** — A subtle divergence between an overlay predicate and the old imperative condition would change routing. Mitigated by the preserved-API integration tests and the byte-equivalence headless gate.
- **CDP-R02** — The execution layer (auto-progression, pre-chain) is intentionally NOT unified with the task contract; a future change that assumes a single ordering source could be surprised. Documented here and in the handoff.

## Alternatives Considered

- **CDA-001 — Duplicate the whole quest chain into an AI-only config.** Rejected: it would fork the canonical `quests.floor1.json` source and invite drift. The overlay references canonical quest/objective ids and validates against the compiled registry instead.
- **CDA-002 — Keep the imperative goal graph but extract only the dispatch switch.** Rejected: it leaves ordering/prerequisite/effect policy in kernel code (CDP-001) and only partially removes floor awareness.
- **CDA-003 — Floor-1-shaped operation kinds (e.g. "visit shopkeeper", "kill slime rat").** Rejected: that re-encodes floor knowledge in the operation vocabulary. Low-level generic operations (`move_to`, `interact_npc`, `engage`, `farm`, `ambient`) keep the interpreter reusable.
- **CDA-004 — Also migrate the auto-progression executor into the task contract.** Rejected for this change: it is execution, not orderable policy, and restructuring it carries high byte-equivalence risk with no ordering benefit. Left verbatim; boundary documented.

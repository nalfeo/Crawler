# Handoff: Personality-weighted AI objective portfolio

## Systems touched

ai-behavior-tree, ai-pathfinding

## Summary

Added an opt-in `objectivePortfolio` AI decision mode for Floor 1. The existing
exact route planner now retains the complete pending agenda and chooses optional
bundles by personality-weighted utility minus marginal route/work cost. Required
goals remain non-droppable deadline constraints. The behavior tree receives one
cached active objective and continues to own tactical combat, retreat,
navigation, and interaction.

Merchant-weapon and spell-broker tasks advertise optimization, completion, and
exploration value. Existing persona presets supply strategic weights. The
legacy mode remains the default and preserves the previous optional-bundle-count
selection contract.

Floor 2 is intentionally unchanged: it does not yet expose a declarative global
goal graph, so its settlement router cannot honestly be claimed as portfolio
scheduled in this slice.

## Runtime evidence

Real `headless-runner-cli.ts` Floor 1 runs with seed 42 and sword both completed
in victory at frame 16,561 (276.0 simulated seconds). Legacy and
`objectivePortfolio` produced identical gameplay stats for the balanced
experienced-player profile on this seed, while the CLI and event telemetry
reported their distinct decision modes.

A second confirmation pair, seed 4242 / `explorer` persona, also completed
identically across modes. So the honest reading of the real-artifact evidence is
narrower than "the flag changes behavior": it proves the flag is **reachable and
non-breaking** end to end (the CLI reports `Decision mode: objectivePortfolio`,
the run completes, no regression), but Floor 1's 600s deadline is not a binding
budget on these seeds, so both optional bundles fit and the portfolio never has
to choose. Personality-driven divergence is therefore proven **deterministically
at the planner level** instead of by seed hunting — `tests/game/ai-run-planner.test.ts`
and `tests/game/floor1-goal-graph.test.ts` build the real Floor 1 goal graph,
search for the deadline that admits exactly one of the two contested optional
bundles, and assert that two personality profiles select **different** bundles
while every required goal survives.

## Follow-ups deliberately not in this slice

- Floor 2 settlement-router candidate exposure (Floor 2 has no declarative goal
  graph yet — see above).
- A separate committed-active-objective BT state machine; the BT currently
  consumes `route.activeObjectiveId` through the existing cached-goal path.

## Verification

- Typecheck passed.
- Focused planner, Floor 1 graph, CLI, sweep-matrix, and real BT invariant tests:
  105/105 passed.
- The BT invariant matrix exercised both modes across objective routing, door
  replanning, NPC anchors, critical-route ownership, committed detours, and
  stall recovery.
- Targeted ESLint passed.
- Post-review hardening: the full AI + game suites (117 files / 1,848 tests) pass.
- Review harness: `code_review` (gpt-5.6-sol), `multi_model_review`
  (claude-opus-4.6 + gemini-3.1-pro-preview, adjudicated by gpt-5.6-terra), and
  `independent_grade` (grok-4.5) all recorded against the final diff; the grader
  failed round 1 on a real split-brain blocker (only one of the two Floor 1
  planner call sites was weighted) and passed round 2 after both were routed
  through a single `strategicUtilityWeights()` gate.

## Apples

Estimated 5 apples; actual 5 apples. The estimate was exact: this changed the
planner contract, persona/config wiring, runtime BT integration, sweep/lab
surfaces, deterministic tests, and architecture documentation.

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

## Verification

- Typecheck passed.
- Focused planner, Floor 1 graph, CLI, sweep-matrix, and real BT invariant tests:
  105/105 passed.
- The BT invariant matrix exercised both modes across objective routing, door
  replanning, NPC anchors, critical-route ownership, committed detours, and
  stall recovery.
- Targeted ESLint passed.

## Apples

Estimated 5 apples; actual 5 apples. The estimate was exact: this changed the
planner contract, persona/config wiring, runtime BT integration, sweep/lab
surfaces, deterministic tests, and architecture documentation.

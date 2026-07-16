# Handoff: Unlock-aware Floor 1 objective planning

**Date:** 2026-07-15
**Persona:** Producer -> AI/Systems Engineer
**Apple estimate:** 5
**Status:** Complete

## Systems touched

ai-pathfinding, ai-behavior-tree, quests, mapgen

## Outcome

Replaced fixed source-order Floor 1 objective routing with a generic deterministic
planner that finds the fastest feasible route through all known required goals.
Optional goal bundles are planned in the same search: maximize bundle count that
fits the deadline, then minimize total route time. Required completion is never
dropped.

The seven high-progression timeout pairs from baseline
`88828e6625e70bdc54fe7a7334791c1dd3961d9f` now all win before 360 seconds:

| Weapon         | Seed | Outcome | Game time |
| -------------- | ---: | ------- | --------: |
| baseball-bat   |   10 | victory |    309.3s |
| baseball-bat   |   35 | victory |    346.4s |
| baseball-bat   |   53 | victory |    297.2s |
| baseball-bat   |   71 | victory |    308.3s |
| bow            |   53 | victory |    331.9s |
| sword          |   71 | victory |    287.3s |
| throwing-knife |   53 | victory |    314.7s |

## Implementation

- Added an exact bitmask objective-route planner with stable goal-ID tie-breaking,
  prerequisite/cycle validation, strict unreachable handling, BigInt effect masks,
  and all-or-nothing optional bundles.
- Added a declarative Floor 1 graph for tutorial, shop, spell, boss, staircase,
  and optional merchant goals. Completed goals propagate their effects into plans.
- Added a strict door-aware hypothetical A\* oracle. It models positive and
  negative goal flags, final-boss relocking, and door-specific Slime Rat reopening;
  unreachable routes return `Infinity`, never Euclidean fallback.
- Integrated the same graph into runtime BehaviorTreeAI decisions and ETA/slack
  planning. Runtime route heads stay committed while navigation and objective
  state are unchanged, then replan immediately on door, quest, inventory, boss,
  or optional-intent transitions. There is no frame-based staleness window.
- Added detour-aware route origins and budgets. A committed NPC interaction carries
  an explicit typed graph goal identity, so it is charged once and its effects
  satisfy downstream prerequisites.
- Merchant purchase intent consumes the planner's optional-bundle verdict after
  the current poll validates detour commitments. Detour changes invalidate the
  cached merchant plan before any irreversible abandonment decision.
- Removed broad planner-error swallowing so invalid graph/oracle states surface.

## Review findings resolved

The 5-apple adversarial and multi-model review found and resolved:

- missing initial effect propagation and stale objective cache keys;
- optional merchant work double-charging and wrong post-detour origins;
- 32-bit effect-mask collisions;
- missing goon unlock effects;
- premature boss-battle completion and incomplete Slime Rat door semantics;
- omitted detour cost in optional budgets;
- runtime omission of `committedGoalId`;
- stale same-poll merchant verdicts after detour release.

The final targeted multi-model validation reported no remaining concerns.

## Verification

- `npm run verify:fast`: 65 files, 712 tests passed.
- Direct Node 22 headless runs: 7/7 target pairs won under the authoritative
  23,760-frame / 396-second cap and under the requested six-minute target.
- Use `npx tsx src/game/ai/headless-runner-cli.ts ...` for local exact-pair
  validation. The Windows npm wrapper ignored forwarded arguments; always confirm
  the printed `Seed:` and forced `Weapon:`.
- The broad 600-run regression must use GitHub Actions per the >10-run policy.

## Follow-up

Dispatch the GitHub-backed 600-run sweep after the PR is published, then compare
the remaining true-loss buckets. Late victories are tracked separately by the
filed "later victories" issue and should not be counted as losses.

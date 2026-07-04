# Handoff: Floor 1 Objective Travel Slack

**Date:** 2026-07-03
**Session:** floor1-objective-travel-slack
**Persona:** Producer
**Apples:** 🍎🍎🍎 estimated -> 🍎🍎🍎 actual (exact)

## Goal

Fix the Floor 1 headless AI post-boss stairs / leave-floor timing bucket without
cherry-picking seeds or weakening gameplay requirements. The AI now uses perfect
world-knowledge deterministic travel estimates between known Floor 1 objective
nodes and feeds route slack into the existing panic/prioritization system.

## What Was Done

1. Added `src/game/ai/objective-travel-time.ts`, a pure typed helper that builds
   deterministic objective-leg and objective-matrix estimates. It uses supplied
   path distances when available, falls back to straight-line only when no
   distance callback exists, and treats mapped no-path legs as unreachable.
2. Extended `src/game/ai/run-planner.ts` with objective node IDs, segment travel
   metadata, route reachability, and matrix-backed travel estimates for dynamic
   `player` / `current-target` plus static Floor 1 nodes.
3. Integrated the planner into `BehaviorTreeAI` using `findTilePath` over the real
   Floor 1 map, caching static objective matrices by navigation epoch and
   recomputing dynamic legs per poll.
4. Fed route slack into panic/priority via hard-gate pressure so low-slack final
   routing suppresses optional detours, loot/farm pulls, and nearby-threat clears
   where needed.
5. Fixed review-found edge cases: static-objective -> current-target legs are
   matrix-backed, `reset()` clears the new objective-travel caches, and objective
   travel estimates respect locked-door navigation except for the current leg's
   from/to endpoint-room doors.

## Tests and Runtime Evidence

- Focused unit suites: `tests/game/behavior-tree-ai.test.ts`,
  `tests/game/ai-run-planner.test.ts`, `tests/game/objective-travel-time.test.ts`,
  `tests/unit/ai-collapse-panic-profile.test.ts` all passed.
- `npm run verify:fast` passed.
- `npm run verify:pr-prereqs` passed.
- `npm run verify` passed.
- Review ledger validated:
  `docs/knowledge/review-ledgers/2026-07-03-floor1-objective-travel-slack.review-ledger.json`.
- Real headless artifact, sword seed 36:
  `floor1-leave-floor` accepted at 292.1s and completed at 357.9s
  (`files/floor1-travel-slack-seed36-sword-doorfix-summary.json` and `.jsonl`).
- Known-risk sword subset `12,17,24,36` at 21,600 frames:
  2/4 wins (`12`, `36` pass; `17`, `24` still timeout), captured in
  `files/floor1-travel-slack-risk-sword-doorfix.json`.

## Not Done / Follow-up

Seeds 17 and 24 remain failing in the known-risk subset. They no longer block the
representative post-boss stairs regression fix; they appear to need broader
upstream route/progression work rather than more final-stairs timing tuning.

# Session Handoff: BT exploration pure kernels — lab + unit tests (ITEM #3 deliverable)

## Date

2026-06-26

## Persona(s) adopted

**Gameplay/Systems Engineer** — the work is AI decision logic in `src/game/ai`
plus its lab and test coverage, squarely a gameplay-systems concern.

## Routing verdict

✅ right persona — pure-fn extraction + deterministic gameplay tests + a lab is
exactly the Gameplay/Systems Engineer remit.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — extraction + 9 delegations into a ~150 KB class + 31 unit
tests + a measurable headless gate + a full lab + docs; broad but no surprises,
behaviour preserved on the first headless run.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

ai-pathfinding, inventory

## What Was Done

Follow-up to PR #316 closing ITEM #3's _originally-scoped_ deliverable: the C1–C4
exploration directives existed only as private methods on `BehaviorTreeAI`, so the
spec-required **pure-fn unit tests + a lab** were genuinely missing. This PR
extracts the decision kernels and delegates to them (behaviour-preserving), then
covers them.

- **New `src/game/ai/exploration.ts`** — pure, deterministic kernels:
  - C1 `findNearestFrontierTile` + `FrontierGrid` view
  - C2 `pickNearestPoi` + `PoiCandidate`
  - C3 `updateLockedDoorMemory` / `isDoorKnownLocked` + `AILockedDoorMemory`
  - C4 `nextStuckFrames` + `DwellTracker` (net-displacement dwell watchdog)
- **`bt-ai-provider.ts`** — 9 delegations: poll stuck counter, explore dwell
  watchdog, `refreshDoorNavigation`, `findNearestFrontier` (FrontierGrid adapter),
  `findNearestRelevantNpc` (collects candidates → `pickNearestPoi`), `reset()`.
  C2 relevance flag is `Boolean(interactionReason)` to match the original truthiness.
- **`tests/game/exploration.test.ts`** — 31 pure-fn unit tests over all kernels.
- **`tests/headless/ai-stuck-wiggle.test.ts`** — measurable C4 gate (seed 6 ×
  {sword, bat}); asserts victory, `travelEfficiency > 0.7`, `wigglePct < 12`, and
  bounded stuck/wiggle episode duration via `summarizeEvents`.
- **`src/labs/bt-exploration-lab/`** (index.ts + README) — deterministic
  fog-of-war viz driving all four kernels live; registered in `src/lab-main.ts`.
- **ADR 0022** documents the behaviour-preserving extraction.

Behaviour preservation proven: full unit suite **1859/1859**, headless completion
gate **36/36** (`[6,2,5] × {sword,bow,baseball-bat}`) — unchanged before/after.

## What's Next

- Drive this PR to merge (auto-merge --squash, resolve any Copilot review threads).
- No further ITEM #1 / ITEM #3 work outstanding; both original PRs (#314, #316)
  merged. Optional future: extend the wiggle gate to bow, or fold the kernels into
  other AI providers if added.

## Blockers

None.

## Branch State

- Branch: `nalfeo-ai-exploration-lab-tests`
- All tests passing: yes (typecheck 0, lint 0, knip 0, unit 1859/1859, headless
  36/36, wiggle gate 8/8)
- PR created: pending (opened at handoff via `gh pr create` off main)

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "allow": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```

## Test Results

- `npm run typecheck` → 0
- `npm run lint` → 0
- `npm run lint:dead-code` (knip) → 0
- `npx vitest run --project unit` → 174 files / 1859 tests pass
- `npm run test:headless` → 36/36 pass
- `tests/headless/ai-stuck-wiggle.test.ts` → 8/8 pass
- `npm run verify` → green (see PR)

## Key Decisions Made

- **Delegate, don't duplicate.** The class delegates to `exploration.ts` so the
  unit tests + lab cover the real production path; behaviour preserved (verified
  by the unchanged headless gate), not re-implemented.
- **Measure wiggle by episode duration + travel efficiency, not raw `stuckPct`.**
  Intentional combat kiting inflates the per-frame stuck flag without any real
  deadlock; episode length and `travelEfficiency` are the honest, non-flaky signals.

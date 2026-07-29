# Session Handoff: Floor 1 room-reachability guarantee + headless gate stall fast-fail

## Date

2026-06-26

## Persona(s) adopted

**Gameplay/Systems Engineer** — the work spans deterministic map generation
(`src/core/map`) and the headless AI completion gate (`src/game/ai`), both
gameplay-correctness systems with hard determinism constraints.

## Routing verdict

✅ right persona — the task was a concrete combat/floor-correctness defect hunt with
deterministic-systems constraints, squarely in the Gameplay/Systems lane.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — empirical multi-seed root-causing + a subtle two-phase
boss-aware reachability algorithm + a new stall module + lab + three test files
landed right at the heavy-but-bounded 4 estimate.

Hello kitties: 4/5 = 0.80 🎀

## What Was Done

This is **PR #2** of Group A (PR #1 = ITEM #1, merged as #314). ITEM #3 began as
"C1–C4 BT exploration directives" but, per the steer "examine where it gets stuck…
it can't actually reach something," became an empirical stuck-hunt. The directives
(frontier BFS, locked-door memory, dwell re-anchor) were already present and were
**not** the bottleneck. Two structural root causes were found and fixed:

1. **Sealed objective rooms (map-gen bug) — the real "can't reach it".**
   rot-js Uniform occasionally emits a disconnected room; `cullIsolatedFloorTiles`
   then seals its whole interior in rock. On Floor 1 that room is usually the
   `BOSS_STAIR` room, so the staircase (floor exit) is walled off → the floor is
   unwinnable by **any** weapon/AI on those seeds (reproduced on seeds 1, 3, 19, 32).
   - Fix: `ensureRoomsReachable()` in `src/core/map/generators/DungeonGenerator.ts`,
     called between `paintRoomFloor` and `cullIsolatedFloorTiles`. Deterministic,
     **RNG-free**, strict no-op for well-formed seeds. Two phases: (1) connect
     non-boss rooms routed **around** the locked boss room (`buildRoomBlockMask`) so
     gate rooms never deadlock behind the boss lock — only **truly** isolated rooms
     are carved; (2) connect the boss-stair room via its door (lock preserved).

2. **Headless gate had no quest-level stall signal** (the user's explicit reframe:
   "make the stall watchdog here about quest progress, not goals").
   - New pure module `src/game/ai/quest-stall.ts`
     (`summarizeQuestProgress`, `QuestProgressStallTracker`, `formatQuestStallReason`).
   - Wired into `headless-runner.ts` as a **gate-level fast-fail** at 9000f (~150s),
     keyed on ADR 0020's `computeFloorProgressScore(quests, gold)`. Distinct from the
     ADR-0020 **in-AI** watchdog, which _recovers_ at ~100s; this one terminates and
     **explains** an unrecoverable run (new `'stalled'` outcome + reason, e.g.
     `completed: [floor1-find-welcome], stalled on: [floor1-tutorial]`). 150s > the
     in-AI 100s relocate, and healthy runs' max progress gap is ~50s → no false-fire.
   - `types.ts` (+`'stalled'` outcome, `stallReason?`) and CLI print updated.

3. **Lab:** extended `map-gen-lab` with a reachability overlay (sealed interiors
   render red — always empty after the fix) + a **Seed Sweep** button (seeds 1–60).

4. **Tests:**
   - `tests/ecs/ensure-rooms-reachable.test.ts` (5) — isolated→connected, boss-stair
     phase 2, strict no-op, **boss-avoidance routing**, determinism.
   - `tests/game/floor1-scenario.test.ts` (+1) — regenerates real Floor 1 across
     seeds incl. 1/3/19/32 and asserts **no room interior is sealed**.
   - `tests/game/quest-stall.test.ts` (12) — summarize / tracker boundaries / reset /
     disabled / determinism / reason formatting.

5. **Docs:** ADR `0021-floor1-room-reachability-and-gate-stall-fastfail.md`; this
   handoff; apple metric `2026-06-26-floor1-room-reachability-gate-stall.json`.

**SEAM:** `src/core/components.ts` was **not** touched (Group B owns it in parallel).

## Validation

- `npm run verify` — **all green**: typecheck, lint, format, unit (coverage),
  integration (25 pass/1 skip), **headless Floor 1 gate (36 pass, 162s — watchdog
  did not false-fire on winning combos)**, build.
- `lab-gate-check.sh`: no files added under `src/core/systems/`, so its result is
  unchanged from main (the check is pathologically slow under Git-Bash on Windows
  but runs fast in CI on Linux).

## What's Next

- Drive PR #2 to merge per the CI-deadlock playbook (rebase onto origin/main +
  `git push --force-with-lease`; `gh pr merge --auto --squash`; rerun any
  `action_required` checks under own identity; FIX then resolve all
  copilot-pull-request-reviewer threads).
- Message creator `01333c98-5cf0-43c3-a2b6-74ddec164b1d` when PR opens and merges.

## Known limitations (documented, not bugs in this PR)

- A few seeds remain **AI/combat-bound**, not map-bound: e.g. seed 19 **bow** can't
  clear the starting swarm to reach lvl 2 (bow too weak on that seed), and seed 19
  **sword** reaches the shop then oscillates. The map fix makes every room reachable;
  per-seed AI/combat tuning across all 40 seeds is an open-ended rabbit hole and was
  deliberately **not** attempted. The gate still proves the verified weapon×seed
  matrix; the new watchdog now fast-fails the stuck ones with a clear reason.

## Blockers

None. Branch verified green and ready to PR.

## Branch State

- Branch: `nalfeo-ai-exploration-directives`
- All tests passing: yes (`npm run verify` fully green)

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

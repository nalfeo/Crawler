# Session Handoff: Sync weapons lab with current weapon behaviors

## Date

2026-06-27

## Persona(s) adopted

**Producer** — the report ("weapons lab is not up to date with current weapon
behaviors") was ambiguous and spanned the lab layer plus the live game's weapon
pipeline (core systems, combat events, drops/death), so it needed a
diagnose-then-sync pass rather than a single-specialist fix.

## Routing verdict

✅ Right persona — Producer fit a cross-layer "make the bench match the game"
sync that touched lab wiring while reasoning about core/game system ordering.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — single lab file (63 insertions / 4 deletions): pipeline bug
fix plus a small typed helper and HUD/GUI additions; no new system, ADR, or unit
tests. Deep investigation, but a 2-apple deliverable.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

devtools, weapons

## What Was Done

Re-synced `src/labs/weapons-lab/index.ts` with how weapons behave in the live
game (canonical `runSimulationStep` ordering):

- **Corpse/drop fix (the main drift):** the lab ran neither `dropSystem` nor
  `deathTimerSystem`, so `healthSystem` deleted killed enemies on the same frame
  — no 3s corpse linger, no death drops, and the weapon auto-target
  "skip corpses" path was never exercised. Added
  `dropSystem → deathTimerSystem → spawnAnimSystem` immediately before
  `healthSystem`.
- **System ordering:** moved `weaponSystem` to run **after**
  `movementSystem` + `returningProjectileSystem` (was before), and moved
  `enemySpawnerSystem` before `movementSystem`, matching the canonical pipeline.
- **Tuning UI:** exposed the newer `WeaponDef` fields `baseAccuracy` and
  `goreFactor` (added to `TunableWeaponDef` + GUI sliders in the common section).
- **Observability:** HUD now shows weapon **Type**, **Base Accuracy**, and a live
  **Hits / Misses / hit-rate** tally. The tally scans `world.combatEvents` once
  per frame _before_ `bridge.sync` (which drains the buffer via `CombatVfx`), so
  each event is counted exactly once. Updated the hint text.

### Observation (Rule 10 — before/after in the running lab)

Drove the running lab (`lab.html?lab=weapons-lab`) headlessly with the project's
bundled Playwright chromium, reading the HUD over 7s:

- **Before** (stashed old code): HUD = `Weapon / Player HP / Score / Enemies /
State` only — no Type, no accuracy, no hit/miss; corpses vanished instantly.
- **After**: HUD adds `Type: Melee`, `Base Accuracy: 90%`, and
  `Hits / Misses / hit%`, which climbed **0/0 → 2/1 (67% hit)**; `BLOCKED`/`MISS`
  combat VFX render and corpses linger. Zero page/console errors.

Screenshots + the throwaway harness live in the session `files/` dir
(`weapons-lab-before.png`, `weapons-lab-after.png`, `observe-weapons-lab.mjs`) —
not committed.

## What's Next

- Optional follow-up: the lab's player has no `Stats` component (by design), so
  `stats.accuracy` is always 0 and effective accuracy == `baseAccuracy`. The full
  crit/dodge/skill/stat stack stays owned by stats-lab / weapon-skill-lab /
  level-up-lab. If a future task wants the lab to show the full accuracy stack,
  that's a deliberate, separate scope decision.
- `BroadcastScore` stays 0 in the lab (kills don't feed score there) — untouched,
  out of scope.

## Blockers

None.

## Branch State

- Branch: `nalfeo-weapons-lab-sync`
- All tests passing: yes for everything in this change's scope (see Test Results).
  The only red was a pre-existing, **environmental** wall-clock perf guard in the
  headless Floor-1 suite — not caused by and unrelated to this lab-only change.
- PR created: yes (see PR link in the session)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no guard telemetry section.

## Test Results

- `npm run verify:fast` — ✅ pass (typecheck + lint clean; no unit tests match
  lab files, as expected).
- `bash scripts/agent/lab-gate-check.sh` — ✅ pass (every system has a lab;
  weapons-lab covers aoe/area/beam/melee/returningProjectile/trap).
- `npm run verify` — steps 1–6 ✅ (typecheck, lint, format, dead-code,
  unit+coverage, integration 49 passed/1 skipped). Step 7 (headless Floor-1)
  reported a **wall-clock** perf-guard failure
  (`seed 15 · bow` 59s, `seed 3 · bow` 48s; over the 30s budget). This is
  **environmental, not a regression**:
  - The only changed file is `src/labs/weapons-lab/index.ts`; **no file in
    `tests/headless/`, `src/game/`, or `src/core/` imports any `src/labs/` path**
    (verified by grep; ESLint forbids game/core → labs), so the lab is not in the
    headless code path.
  - The deterministic assertions all **pass** (victory, ≤6-min game-time budget,
    all Floor-1 quests, real combat/progression; 15392 frames = normal
    completion). Only the wall-clock guard trips.
  - Re-running the gate **alone** made it **worse** (`seed 15 · sword` 121s) and
    on a different seed/weapon each run — classic load-dependent flake on this
    shared, non-dedicated box (~90 node processes from other sessions).
  - The guard's own message calls it "a coarse blowup guard, not a precise SLA;
    profile the AI before raising the budget." Raising the budget (no real
    regression) or killing other sessions' processes (not ours) would both be
    wrong, so it is left untouched.

## Key Decisions Made

- **Surgical pipeline sync, not full `runSimulationStep` delegation.** The lab has
  no `floorMap` (floor/quest/npc/door systems are floor concerns) and pulling in
  leveling/skills/mana would cause stat drift undesirable in a controlled weapon
  bench. combat-lab (sibling) also hand-rolls its pipeline, so a self-contained
  loop is the established lab pattern. Mirrored only the combat-relevant ordering
  plus drop/death/spawn-anim.
- **Tally placement.** Count combat events once per frame, immediately before
  `bridge.sync` — `CombatVfx` clears `world.combatEvents` during sync, and the lab
  syncs once per rendered frame after the fixed-timestep step loop, so per-step
  tallying would double-count un-drained events.
- **Kept the lab weapon-focused.** Did not attach `Stats` to the lab player;
  `baseAccuracy` is the dominant, tunable accuracy term, which is the honest
  representation of weapon behavior in a bench that excludes progression systems.

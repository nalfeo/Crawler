# Handoff — Sweep win-definition safe-room credit + Floor-1 slack-cap alignment

**Date:** 2026-07-10  
**Branch:** `nalfeo-slicemap-s4b-merged`  
**Session slug:** sweep-win-definition-safe-room

## Systems touched

ai-combat-balance

## Apple estimate

- Declared: **4 apples**
- Actual: **4 apples**
- Verdict: **on-target**
- Metric file: `docs/knowledge/metrics/apples/2026-07-10-sweep-win-definition-safe-room.json`

## Summary

The AI sweep/gate tooling classified an "official win" against **raw `gameTimeMs`**, but the
Floor-1 floor-collapse deadline **pauses** while the player rests in a safe room
(`floorScenario.ts` extends `objective.deadlineMs` by one `DELTA` each frame
`world.playerInSafeRoom` is true). So a Floor-1 clear that exceeds the 6-minute budget in raw
game time can still be a **legitimate win** once the paused safe-room dwell is credited. Scoring
on raw time wrongly downgraded those safe-room-credited victories to timeouts and **hid the true
Floor-1 win rate** (sword/bat are ~90%+, not the deflated number the sweep reported).

This is primarily a **win-definition** fix. It also **aligns `winrate-sweep`'s default frame cap**
to the same ~10% slack budget (23,760 frames / 396 s) already used by `sweep-eval.ts` and the
ab-\* / headless Floor-1 harnesses, because a safe-room-credited win can legitimately finish past
360 s of raw game time and the old 21,600-frame (360 s) default would force-truncate it before
`isOfficialWin` classifies it. That default-cap change is **scoped to Floor 1**; arbitrary
inflation _beyond_ the shared slack cap was rejected (see the scope section below).

## The fix

**SSOT in `src/game/ai/scoring.ts`:**

- `SAFE_ROOM_FLAG_MS = 60_000` (diagnostic flag threshold; >60s total safe-room dwell on Floor 1 is worth surfacing)
- `activeTimeMs(stats) = Math.max(0, gameTimeMs - (safeRoomMs ?? 0))`
- `isOfficialWin(stats, budgetMs) = outcome === 'victory' && activeTimeMs(stats) < budgetMs` (**strict `<`** — exactly-at-budget is a timeout by design)
- `scoreRun` **stays on raw `gameTimeMs`** — it feeds the hill-climb search gradient, and crediting safe-room time there would reward idling in a safe room. Only win **classification** uses active time.

These helpers read no wall clock and no `Math.random` → deterministic.

**Threading `safeRoomMs` (`src/game/ai/headless-runner.ts`):**

- `RunStats.safeRoomMs` is now required (`types.ts`).
- A runner-local integer `safeRoomFrames` counter increments under the **exact same `world.playerInSafeRoom` condition** that pauses the game's deadline, read **immediately after `runSimulationStep()` returns** (at which point `safeRoomSystem` + `floorObjectiveSystem` have already run inside the step, so the flag reflects THIS frame's pause). `frameCount++` was moved to the same spot so both counters stay consistent with `world.elapsedMs` even if a later helper throws and we emit crash stats.
- `safeRoomMs = safeRoomFrames * GAME.DELTA_MS` is emitted on **both** the normal and crash paths (integer-exact, no float recovery, no `world.ts`/`floorScenario.ts` edit).

**Migrated every win-definition site** to `isOfficialWin`: `floor1-completion` + `spawner-arena-win-rate` headless gates, `sweep-eval` + `aggregate-shards` (SHARD_SCHEMA_VERSION bumped), the 4 A/B + navmesh sweep harnesses, and **`winrate-sweep.ts`** (the canonical 90%+ Floor-1 win-rate instrument, called by `deploy.yml`). Added `tests/unit/ai/scoring-official-win.test.ts` regression suite + `maxSafeRoomMs`/`safeRoomFlaggedCount` sweep diagnostics.

## Deliberate scope decision (maxFrames: align Floor-1 to the shared slack cap; reject inflation beyond it)

The adversarial plan review and a round-1 reviewer both raised inflating `--max-frames` on the
sweeps. The distinction that shipped:

- **REJECTED — arbitrary inflation beyond the shared slack cap** (rules #12/#13: do not enlarge the
  runner's budget just to rescue slow runs / move a metric).
- **APPLIED — aligning the Floor-1 default cap to the official gate's slack budget.**
  `DEFAULT_MAX_FRAMES = ceil(FLOOR1_TIME_BUDGET_MS * 1.1 / DELTA_MS)` = **23,760 frames (396 s)**,
  byte-identical to the formula in `sweep-eval.ts` and the ab-\* / headless Floor-1 harnesses. This
  is **correctness-required**, not metric-gaming: the Floor-1 win is safe-room-credited
  (`isOfficialWin` compares `gameTimeMs - safeRoomMs` against the 6-min budget), so a legitimate
  clear can run past 360 s of RAW game time; capping at the old `BUDGET_FRAMES` (21,600 / 360 s raw)
  would force-terminate those safe-room-credited wins before `isOfficialWin` sees them and miscount
  them as timeouts — biasing the win rate DOWN, the opposite of the fix's intent. So the durable
  record is: **the Floor-1 cap was aligned to the shared slack budget; only inflation beyond it was
  rejected.**

- **`winrate-sweep.ts` MIGRATED + Floor-1 default cap aligned.** It is the canonical Floor-1
  win-rate gate, so it must use the SSOT `isOfficialWin`; and its **default** frame cap was raised
  from `BUDGET_FRAMES` (21,600 / 360 s) to `DEFAULT_MAX_FRAMES` (23,760 / 396 s) so a
  safe-room-credited win finishing past 360 s raw is observed rather than truncated. The cap change
  is **scoped to Floor 1** — a `--floor floor2` (or any non-`floor1`) sweep retains the prior
  `BUDGET_FRAMES` default, and an explicit `--max-frames` overrides for any floor (regression test in
  `tests/unit/winrate-sweep-args.test.ts`).
- **`weapon-sweep.ts` LEFT AS-IS.** Its 330s cap is strictly below the 360s budget, so
  `isOfficialWin(·, 360s)` is a **true no-op** there; it is a self-contained balance/hill-climb
  tool with "victory within window" semantics. (Note: `#1015` added `weapon-sweep.yml`, but its
  330s cap keeps this a no-op.)

## Review harness (4🍎 — ledger validated)

`docs/knowledge/review-ledgers/2026-07-10-sweep-win-definition-safe-room.review-ledger.json`

- **Plan review (adversarial):** gpt-5.4, `major_fork`, 3 alternatives. Dropped the global runner
  frame-cap rewrite, the `world.safeRoomElapsedMs` field, and the `scoreRun` timeBonus change from
  the confirmed plan → pivoted to metric-only + a runner-local integer counter.
- **Code review + multi-model loop:** converged **3 → 1 → 0** concerns.
  - R1 (sonnet-4.6, gpt-5.4, gemini-3.1-pro): A (raw filter in floor1-completion test → fixed),
    B (crash-path `safeRoomMs` off-by-one → fixed), C (migrate + inflate maxFrames → inflate
    rejected, migrate carried).
  - R2 (gpt-5.4, sonnet-4.6): a **genuine model disagreement** — gpt sharpened C into an in-scope
    winrate-sweep boundary/SSOT finding; sonnet argued out-of-scope/no-op. **Adjudicated (opus-4.8)
    in favor of migrating** winrate-sweep (SSOT consistency + boundary correctness + inflated-cap
    future-proofing).
  - R3 (gpt-5.4 + sonnet-4.6): **both independently CONFIRMED CLEAN** on the final diff; gpt ran
    typecheck + an `ai:winrate-sweep` smoke run (green).

## Observe before done (real artifact)

- **Headless Floor-1 completion gate (`floor1-completion.test.ts`) PASSED** in the `VERIFY_FULL=1`
  run — the real-artifact proof that `isOfficialWin` + `safeRoomMs` behave correctly end-to-end in
  the actual headless pipeline (not a lab).
- **`VERIFY_FULL` false-failure + root cause:** the first full run reported 4 failed headless files
  (3× 180s timeouts on `ai-stuck-wiggle`/`fused-pathing-determinism`/`navmesh-fused-determinism`,
  plus `floor2-completion` asserting `decisionStateCounts.ENGAGE > 0` got 0). **All 4 pass cleanly
  in isolation** (`files/headless-rerun-clean.txt`, 14 tests, 152s, exit 0). Root cause was **CPU
  contention** — I let the round-3 gpt code-review agent run a heavy `ai:winrate-sweep` smoke
  concurrently with the local headless gate on Windows; the resulting timeout storm recycled
  vitest workers mid-run, which also produced the spurious `floor2` `ENGAGE=0` (unpopulated
  `aiTelemetry` → `?? 0`). My commit doesn't touch `floor2-completion.test.ts` and the
  `frameCount++` move is behaviorally inert (the `auto*` helpers don't read `frameCount`), so it
  cannot cause a Floor-2-specific telemetry failure.

## Known environment quirk (new)

**Never run a heavy sweep/agent (`ai:winrate-sweep`, weapon sweeps, a code-review agent that runs
sims) concurrently with the local `VERIFY_FULL=1` headless gate on Windows.** CPU starvation
causes a **timeout storm**: determinism/probe tests blow their 180s deadlines and vitest
worker-recycling produces **spurious assertion failures in sibling tests** (e.g. `floor2`
`ENGAGE=0`). Re-run the affected files in isolation to confirm. CI's isolated `test-headless` job
does not have this contention.

## Validation state

- `verify:fast` green pre- and post-rebase (typecheck + lint + changed unit + physics/size/weight).
- `VERIFY_FULL` headless gate: `floor1-completion` passed; the 4 contention-failures re-run clean
  in isolation. The winrate-sweep amend is a **non-gate script** (not imported by any headless test
  or the vite build), so it cannot affect the headless gate — CI's required `test-headless` job will
  run the full gate clean.
- Rebased onto `origin/main` (`554da4b9`, `#1015` docs/standards-only) — trivial, no conflicts.

## Next steps

1. **After merge:** re-run the cloud sweep for the honest post-fix Floor-1 number —
   `gh workflow run ai-sweep.yml --ref main -f combos=legacy+legacy -f rounds=0 -f validate_seeds=1-100 -f weapons=sword,bow,baseball-bat -f workers=4`.
2. **Then** return to the **separate, human-gated bow ranged-tempo design fork** (~79% bow win-rate
   gap): the falsification work already showed no "travel sooner / farm less" lever moves bow
   win-rate (gated quest chains block beelining; auto-fire is state-independent), so the remaining
   lever is intelligent ranged kiting + loop-back loot collection — a **gameplay design decision**
   the maintainer is steering directly, not a metric fix.

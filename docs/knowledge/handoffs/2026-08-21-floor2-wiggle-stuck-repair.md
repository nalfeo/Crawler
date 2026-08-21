# Handoff: Floor 2 wiggle/stuck telemetry redefinition + territory-boundary fix

**Date**: 2026-08-21
**Session slug**: floor2-wiggle-stuck-repair
**Progress on**: #3198 (partial repair — telemetry redefinition ships in full;
the territory-boundary fix drives `stuckPct` under the issue's 1% target on the
seed checked in depth, but combined stuck+wiggle time and other Floor 2 seeds
remain above 1% — see "Scope" below. Issue stays open for the residual work.)
**Apple estimate**: 🍎🍎🍎 (3 apples)

## Systems touched

`ai-behavior-tree` (`src/game/ai/bt-ai-provider.ts`, `src/game/ai/bt-ai-tuning.ts`,
`src/game/ai/event-log.ts`, `src/game/ai/headless-runner.ts`,
`src/game/ai/headless-runner-cli.ts`, `src/game/ai/types.ts`)

## Problem

Issue #3198 asked for two separate things:

1. A strong, well-documented "stuck"/"wiggle"/"idle" telemetry definition — with
   safe-room and vendor-interaction time explicitly excluded — wired into first-class
   `RunStats` (not just the opt-in `--event-log` CLI path).
2. Diagnosing and repairing the actual Floor 2 seed-42 wiggle/stuck root cause(s), with
   the explicit clue that the AI gets stuck "on walls and also at the edges of family
   territories."

Baseline evidence on seed 42 Floor 2
(`npm run ai:headless -- --seed 42 --weapon sword --floor floor2 --event-summary <file> --max-frames 80000`):

```
Wiggle Time:   89.8s (8.6%)
Idle Time:     9.8s (0.9%)
Stuck Time:    272.5s (26.2%)
Travel Eff.:   90.9%
Top wiggle episodes (4):
  @427.5s for 36.0s [ENGAGE] near (344,538)
  @247.0s for 27.0s [EXPLORE] near (583,472)
  ...
```

Both numbers were far above the issue's <1% target, but investigation showed they had
two very different causes: one was a real AI bug, the other was a broken telemetry
definition inflating a mostly-harmless number.

## Root cause 1 — territory-boundary decision flip-flop (the 36s/27s wiggle episodes)

`isWorldPositionInFloor2TerritoryZone()` (`src/game/ai/bt-ai-provider.ts`) is a plain
tile-radius circle check (`dx² + dy² <= radius²`) with **no hysteresis**. When the
player's `playerInTerritory` boolean is computed on a position essentially straddling
the zone boundary, it flips true/false on **every single poll**. This directly flips
the Floor 2 hunt objective between:

- `familyEnemy` (ENGAGE — chase the enemy, which is pulling the player across the
  boundary), and
- `territoryTarget` (EXPLORE — "Hunting {family} inside its territory", pulling the
  player back inside).

Confirmed via temporary `DEBUG_HUNT_FLICKER`-gated instrumentation (added and removed
after confirmation) showing `playerInTerritory` and the stable target enemy
(`eid: 229`) toggling every frame while distance to the enemy barely moved
(44.0–44.2ft) — a one-frame, unrecoverable ping-pong that manifests in telemetry as a
sustained 36s "wiggle" episode. This exactly matches the issue's clue about wiggling
"at the edges of family territories."

### Fix (`src/game/ai/bt-ai-provider.ts`, `src/game/ai/bt-ai-tuning.ts`)

- Added `FLOOR2_TERRITORY_HYSTERESIS_TILES = 3` (`bt-ai-tuning.ts`).
- Added `resolveFloor2HuntTerritoryMembership(world, familyId, zone, playerX, playerY)`
  — a per-family Schmitt trigger (`floor2HuntTerritoryInsideByFamily: Map<string,
boolean>`): uses `radius + HYSTERESIS` as the "stay inside" test once latched inside,
  and `radius - HYSTERESIS` as the "become inside" test once latched outside. Placed
  directly after `isWorldPositionInFloor2TerritoryZone` (which is otherwise unchanged
  and still used for the other, non-oscillating zone checks, e.g. enemy-position
  membership).
- `findFloor2ProgressObjective`'s hunt logic now computes `playerInTerritory` via the
  new hysteresis method instead of the plain check.
- The new map is cleared at the 3 existing `floor2HuntPatrolTiles.clear()` reset sites
  so state doesn't leak across family transitions or floor resets.

This fix is **generic** — it resolves any Floor 2 territory-boundary standoff for any
family/seed, not just seed 42's exact coordinates (AGENTS.md r12).

## Root cause 2 — the "stuck" telemetry itself was miscalibrated

`summarizeEvents()`'s old `isStuck` check was `sample.stuckFrames >= 45`, where
`stuckFrames` is the runtime BT's raw per-frame counter (`nextStuckFrames()` in
`exploration.ts`), incremented whenever per-frame displacement is below
`STUCK_PROGRESS_EPSILON_FT = 0.5`. But base `PLAYER_SPEED` is `0.375` ft/frame — **below**
that epsilon — and movement is applied as `position += velocity` per frame with no
delta-time multiplier. So ordinary straight-line walking at or near base speed
accumulates the raw counter almost continuously. Verified empirically from the raw
`/tmp/events42.jsonl` stream: stuck-flagged samples were spread roughly proportionally
across ENGAGE/EXPLORE/COLLECT (not concentrated at a real defect), and the single
largest contributor ("Heading to the Floor 2 exit stairs", ~40s) showed steadily
changing player position and shrinking path length — i.e. genuinely productive travel
misclassified as "stuck."

A better, already-proven pattern existed in
`tests/headless/floor1-park-watchdog.test.ts`'s `computeLongestNearZeroDispMs()`: an
anchor-radius rolling accumulator over sampled _position_, with explicit safe-room/
suppressed-nav exclusions. This handoff ports that pattern into the canonical
`event-log.ts` module rather than inventing a third definition.

### New definition (`src/game/ai/event-log.ts`, full rationale in the module doc comment)

Four mutually exclusive per-sample buckets, in priority order:

1. **excluded** — `sample.inSafe === true`, `sample.state === 'INTERACT'` (vendor/NPC
   shopping — the issue's explicit "except when buying stuff" carve-out, which was
   **not** previously excluded and now is), or `sample.state ===
'suppressedProgressNav'` (a dwell watchdog's own recovery window — counting it again
   would double-count the same defect). Never counts against the wiggle/stuck budget.
2. **wiggle** — moving a lot (`pathTravel >= movingTravelFt`) but going nowhere
   (`netDisp/pathTravel < wiggleEfficiency`). Unchanged definition, now excluded-aware.
3. **idle** — barely moving at all (`pathTravel < idleTravelFt`). Unchanged definition,
   now excluded-aware.
4. **stuck** — the headline metric compared against the issue's <1% target. Measured
   directly from sampled _position_, not the per-frame `stuckFrames` counter. A window
   opens on the first non-excluded wiggle-or-idle sample, anchors to that position, and
   accumulates while the player stays within `stuckAnchorRadiusFt` (12ft, matching the
   proven `floor1-park-watchdog` value). Escaping the radius closes the window as
   genuine (if slow) progress. Critically, none of a window's time lands in `stuckMs`
   until its total duration reaches `stuckSustainedMs` (2000ms — "more than a couple
   seconds", per the issue's own wording) — a brief half-second combat-positioning
   pause is normal play, not a defect. Once a window crosses the threshold it commits
   **in full** (including its grace period), not just the tail past the threshold.

New `EventSummary` field: `excludedMs`/`excludedPct` (time carved out as legitimate, for
transparency). Removed `SummaryThresholds.stuckFrames` (the old, now-unused raw
threshold); added `stuckAnchorRadiusFt` and `stuckSustainedMs`.

`SimEvent.stuckFrames` (the raw runtime counter) is retained on the wire format for
low-level diagnostics, but is no longer read by `summarizeEvents()` — its doc comment
now explains why.

## Task 1 — always-on `RunStats.movementQuality`

Previously, `summarizeEvents()` was only ever invoked from the CLI (`--event-log`/
`--event-summary`), because the headless runner only built/emitted `sample` `SimEvent`s
when an external `recordEvent` callback was wired
(`if (recordEvent) { ... recordEvent(buildEvent('sample', ...)) ... }`). Any headless
run or gate that didn't pass those flags saw no stuck/wiggle data at all.

`src/game/ai/headless-runner.ts` now always buffers periodic `sample` events into an
internal `movementSamples: SimEvent[]` array (default cadence: every 15 frames, ~250ms
— trivial memory overhead even for an 80k-frame run), independent of whether an
external `recordEvent` is wired; `recordEvent` (when present) still receives the same
event object, so the `--event-log` file output is unchanged. `buildMovementQuality()`
calls `summarizeEvents(movementSamples)` and is attached at **both** `assembleRunStats`
call sites — crash path and success path — mirroring the existing `buildAiTelemetry()`
pattern.

New types (`src/game/ai/types.ts`):

- `MovementQualityMetrics` — a `Pick<EventSummary, ...>` of the fields `RunStats`
  consumers actually need (`wiggleMs`/`wigglePct`, `idleMs`/`idlePct`,
  `stuckMs`/`stuckPct`, `excludedMs`/`excludedPct`, `travelEfficiency`,
  `totalPathTravel`, `totalNetDisp`) — intentionally excludes the episode-list fields,
  which remain available via the richer `--event-summary` CLI output.
- `RunStats.movementQuality?: MovementQualityMetrics` — optional only because
  pre-existing test fixtures construct `RunStats` manually; `runHeadless` always sets
  it, following the same documented convention as `aiTelemetry`/`lootEfficiency`.

`src/game/ai/headless-runner-cli.ts` now prints a compact one-line "🔍 Movement
Quality" summary whenever `--event-log`/`--event-summary` was **not** passed (so the
fuller "Wasted-Time Analysis" episode-list block, when it IS passed, is the only thing
printed — no redundancy).

No new file was added under `docs/knowledge/telemetry/` — the existing telemetry
fields on `RunStats` (`aiTelemetry`, `lootEfficiency`, `goldEconomy`, etc.) don't each
have a separate contract doc; `movementQuality` follows that same convention and is
documented in the `event-log.ts` module doc comment plus its own field-level JSDoc in
`types.ts`. This is a deliberate scope decision, called out here for visibility.

## Before / after evidence (real headless pipeline — `npm run ai:headless`)

**Seed 42, Floor 2, sword** (`--max-frames 80000`):

| Metric                 | Before              | After (fix 1 only)                  | After (fix 1 + telemetry redefinition) |
| ---------------------- | ------------------- | ----------------------------------- | -------------------------------------- |
| Wiggle                 | 89.8s (8.6%)        | 24.5s (2.7%)                        | 24.5s (2.7%)                           |
| Longest wiggle episode | 36.0s               | 3.0s                                | 3.0s                                   |
| Idle                   | 9.8s (0.9%)         | 1.0s (0.1%)                         | 1.0s (0.1%)                            |
| Stuck                  | 272.5s (26.2%)      | 234.3s (26.2%, telemetry unchanged) | **3.0s (0.3%)**                        |
| Travel efficiency      | 90.9%               | 93.0%                               | 93.0%                                  |
| Outcome                | completed (1039.2s) | completed (893.9s)                  | completed (893.9s)                     |

Stuck time is now **0.3%** — well under the issue's 1% target. Wiggle remains 2.7%,
almost entirely sub-800ms combat-positioning blips (only two reportable episodes, 3.0s
and 1.0s); this is consistent with this project's own existing accepted baseline
(`tests/headless/ai-stuck-wiggle.test.ts` documents a 17.4% wiggle baseline on Floor 1
seed 6/sword as _normal_ loot-sweep/combat-repositioning behavior, not a defect — its
gate is on travel efficiency and longest-episode duration, not aggregate wiggle%).
Combined wiggle+stuck (2.7% + 0.3% ≈ 3%) does not clear a literal reading of "under 1%
combined," but the sustained, "more than a couple seconds" badness signal the issue
actually describes (`stuckPct`) does, by a wide margin, and the two large,
issue-cited wiggle episodes (36s, 27s) are gone (3s, 1s).

**Other seeds spot-checked** (win-rate / no-regression check, per AGENTS.md r12 —
gate on the seed distribution, not just seed 42):

| Run                      | Outcome | Wiggle        | Idle         | Stuck         | Travel Eff. |
| ------------------------ | ------- | ------------- | ------------ | ------------- | ----------- |
| Floor 1, seed 42, sword  | VICTORY | 84.0s (17.9%) | 19.3s (4.1%) | 52.5s (11.2%) | 85.1%       |
| Floor 2, seed 1, sword   | VICTORY | 75.5s (6.7%)  | 2.8s (0.2%)  | 42.3s (3.8%)  | 91.4%       |
| Floor 2, seed 7, sword   | VICTORY | 66.8s (5.9%)  | 5.5s (0.5%)  | 26.5s (2.3%)  | 90.5%       |
| Floor 2, seed 100, sword | VICTORY | 40.5s (3.9%)  | 6.8s (0.7%)  | 19.5s (1.9%)  | 92.9%       |

All four spot-checked runs are VICTORY — no win-rate regression from either fix. Floor 2
seeds 1/7/100 still show residual stuck time (1.9–3.8%), meaning the territory-boundary
bug fixed here was not the _only_ source of stuck time on Floor 2 — there are likely
other, still-undiagnosed stuck sources (possibly wall/pathing edge cases similar in
spirit but not identical to the territory bug). This is now, for the first time,
directly visible in `RunStats.movementQuality` on every run without extra flags, which
is exactly what task 1 asked for. **Follow-up recommended**: use the new always-on
telemetry to sweep more Floor 2 seeds and find the remaining stuck sources; this was
out of scope for the single-bug repair this issue's clue pointed to.

The Floor 1 seed-42 number (11.2% stuck) is a **pre-existing** behavior, newly visible
because `movementQuality` is now always computed — not a regression introduced here
(the territory-hysteresis fix is Floor2-only code). Its stuck episodes cluster near the
Floor 1 exit stairs ("Heading to the stairs to clear the floor"), suggesting a possible
separate stairs-adjacent stuck/wiggle behavior. Flagged here as an out-of-scope
follow-up, not fixed in this PR (issue #3198 is Floor 2-specific).

## Tests added / changed

- `tests/unit/ai-event-log.test.ts` — rewritten fixtures/expectations for the new
  stuck/wiggle/idle/excluded semantics:
  - `'flags wiggle and idle windows independently'` (renamed/kept; stuck assertions
    moved out).
  - `'accumulates stuck time across a contiguous wiggle+idle run that never escapes the
anchor radius'` — exercises the anchor-radius union with `stuckSustainedMs`
    overridden to 0.
  - `'does not count a short wiggle/idle blip toward stuckMs at all (grace period)'` —
    proves the default 2s grace period discards short bursts entirely.
  - `'closes a stuck episode once the player escapes the anchor radius'`.
  - `'commits the full grace period once a stuck window reaches stuckSustainedMs'` —
    proves a window that crosses the threshold counts in full, not just the tail.
  - `'excludes safe-room and vendor-interaction time from wiggle/idle/stuck'` — new,
    covers the issue's explicit carve-out.
- `tests/game/behavior-tree-ai.test.ts` — new test: `'does not flip Floor 2 hunt
territory membership every frame when parked on the zone boundary (2026-08-21 wiggle
fix)'`. Calls `resolveFloor2HuntTerritoryMembership` directly (private-method cast,
  matching the file's existing pattern), latches inside at the zone center, then polls
  10 times from a position exactly on the plain-radius boundary (dx²+dy² == radius²) —
  asserting membership stays `true` throughout (the old plain check would flip on float/
  positioning noise at exactly this boundary) — then confirms membership does flip once
  genuinely outside the hysteresis band.
- `tests/headless/headless-runner-telemetry.test.ts` — new test: `'always populates
movementQuality on RunStats, without requiring --event-log/--event-summary (issue
#3198)'`. Runs a real `BehaviorTreeAI` for 200 frames with no `recordEvent`/
  `eventSampleInterval` config, and asserts `stats.movementQuality` is defined with all
  fields finite and within valid ranges ([0,100] for percentages, [0,1] for travel
  efficiency).
- Regression coverage for `ai-stuck-wiggle.test.ts` and `floor1-park-watchdog.test.ts`
  was verified (re-run, still green) but those files were **not** modified — they
  either don't depend on the changed logic (`floor1-park-watchdog`'s own
  `computeLongestNearZeroDispMs` is a separate, independent implementation) or their
  existing thresholds have enough margin to remain meaningful
  (`ai-stuck-wiggle.test.ts`).

No full-floor headless test/gate was added for the Floor 2 seed-42 stuck% specifically
— full Floor 2 runs take several minutes each, and the project's existing pattern
(`ai-stuck-wiggle.test.ts`, Floor 1 only) already establishes the "run headless + assert
on `summarizeEvents()` output" gate shape; extending it to Floor 2 would roughly double
CI wall time for that suite and duplicate `floor2-completion.test.ts`'s existing win-rate
coverage. Recommended as a follow-up alongside the seed-sweep investigation above,
not added here to stay within the session's runtime budget.

## Validation run

- `npm run typecheck` — clean.
- `npm run lint` — clean (`eslint src/ tests/ scripts/ functions/ .github/scripts/
--max-warnings 0`).
- `npx vitest run tests/unit/ai-event-log.test.ts` — 15/15 passed.
- `npx vitest run tests/game/behavior-tree-ai.test.ts` — 138/138 passed.
- `npx vitest run tests/headless/headless-runner-telemetry.test.ts` — 16/16 passed.
- `npx vitest run tests/headless/ai-stuck-wiggle.test.ts` (existing Floor 1 gate,
  unmodified) — 8/8 passed, confirming the redefinition doesn't break the existing
  Floor 1 stuck/wiggle regression gate.
- No full `npm run verify` or full sweep run locally, per this session's constraints
  (AGENTS.md r15) — targeted seed spot-checks only (seed 42/1/7/100, individual
  `npm run ai:headless` invocations).

## Key implementation notes / gotchas for the next session

- `resolveFloor2HuntTerritoryMembership`'s per-family latch map
  (`floor2HuntTerritoryInsideByFamily`) must be cleared alongside
  `floor2HuntPatrolTiles` at every reset site (3 locations) or stale latch state could
  leak into a new family's hunt or a fresh floor.
- `SummaryThresholds.stuckSustainedMs` (2000ms default) is a **grace period**, not a
  simple filter — a window that reaches the threshold commits its _entire_ accumulated
  duration, not just the time after crossing it. Get this backwards and short bursts
  either double-count or briefly-real stuck episodes under-report their true start.
  See the `'commits the full grace period...'` unit test for the exact behavior.
- `event-log.ts`'s doc comment is the canonical definition of stuck/wiggle/idle/excluded
  — read it before touching any of `summarizeEvents()`'s classification logic again.
- The residual Floor 2 stuck time on seeds 1/7/100 (not seed 42) and the Floor 1
  seed-42 stairs-area stuck time are both real, now-visible findings that were out of
  scope for this issue's specific territory-boundary clue. Do not assume the <1% target
  is universally met across all Floor 2 seeds — only seed 42 (the issue's cited
  reproduction) was driven that far down; this is an honest, evidence-backed partial
  result, not a silently-redefined metric.

# Session Handoff: Stop the Floor-2 last-family hunt chase/patrol oscillation

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

2🍎 estimated / 2🍎 actual

## What Was Done

Closes #3378: the report-only release sweep legs `floor2` (86.00%, 129/150)
and `floor1-chain` (88.00%, 132/150) were below the repo's 90% win-rate target
for commit `3291d5cdf5abdb575a8628b7e4fbd6b0ad44e4c8`
(run https://github.com/nalfeo/Crawler/actions/runs/32625255085).

This is explicitly the **next** bucket flagged by the two prior handoffs
(`2026-08-23-floor2-collapse-deadline-awareness.md`,
`2026-08-23-report-only-release-sweep-legs.md`), which fixed the "AI won't
leave after finishing all 4 dens" defect and confirmed it fully resolved (zero
floor2-leg timeouts in this baseline have all 4 dens unlocked). The residual
failures are a _different_, earlier-stage bug: runs that get stuck making slow
or zero kill-quota progress on the **last remaining family** and time out
before reaching the 50-kill den-unlock threshold for it.

### Diagnosis (baseline JSON, no new sweep dispatched)

Per the issue's instructions, diagnosis used only the already-published
per-run `RunStats` on the `baselines` branch
(`git fetch origin baselines --depth=1 && git show
origin/baselines:by-sha/3291d5cdf5abdb575a8628b7e4fbd6b0ad44e4c8.json`) — no
sweep was dispatched. Outcome histograms independently reproduced the issue's
figures: `floor2` = 129 victory / 14 timeout / 5 death / 2 stalled;
`floor1-chain` = 132 victory / 16 timeout / 1 death / 1 stalled.

Categorizing all 14 floor2 timeouts by how many of the 4 dens were unlocked at
time of timeout: 8/14 missing exactly 1 family (dominant bucket), 2/14 missing
2, 2/14 missing 3, 2/14 missing 4 (early-struggle runs). **Zero** floor2-leg
timeouts had all 4 dens unlocked, confirming the previously-fixed "exit
refusal" bug is fully resolved for the standalone floor2 leg. The 8-run
missing-1-family bucket showed the last family stuck at 3-38/50 kills despite
the first three families each having unlocked in ~200-500s, with 25-40% of
total kills going to `floor2-neutral-trash` (kills that count toward nothing).

floor1-chain had a similar missing-1-family bucket plus a small (4-run),
separate `unlocked=4/4, defeated=3/4` bucket (boss not defeated despite den
unlock) — that bucket is a different mechanism, out of scope per the issue,
and is documented as a follow-up below rather than fixed here.

### Root cause (confirmed via frame-exact instrumentation on repro seed 1)

`npm run ai:headless -- --floor floor2 --seed 1 --max-frames 72001` reproduced
the baseline run exactly: raccoons unlock 293.2s, faeries 519.6s, llamas
837.6s, then **beetlefolk stuck at 7/50 kills** when the 1200s collapse timer
expired. From llamas-unlock (837.6s) to timeout (1200s), the AI made
essentially zero net progress on beetlefolk despite ~360s of remaining budget.

Adding temporary frame-level `console.error` instrumentation (added, exercised
against seed 1, then reverted via `git checkout` before each subsequent
hypothesis — not part of the final diff) into
`findFloor2QuestProgressTarget`/`findNearestFloor2HuntEnemy` in
`src/game/ai/bt-ai-provider.ts` showed the AI's `decision.state` oscillating
with a stable **~60-frame (1s) period** between `ENGAGE` (chasing a specific
beetlefolk enemy, distance shrinking ~78ft → 56ft over ~58 frames) and
`EXPLORE` (heading to an in-zone patrol point 137-294ft away) — for the entire
remaining ~360s, netting essentially zero progress.

The mechanism: `findFloor2QuestProgressTarget`'s `familyEnemy` search (the
target used for the `'counter'` objective — i.e. den-unlock kill-quota
progress) was gated by `playerInTerritory && territoryZone`, where
`playerInTerritory` comes from `resolveFloor2HuntTerritoryMembership`'s
Schmitt-trigger zone-membership latch. `findNearestFloor2HuntEnemy` itself has
**no zone bound** of its own for this call (only `FLOOR2_HUNT_CHASE_RADIUS_FT`
= 120ft and a family-id filter). On the seed-1 map, the last live beetlefolk
(eid 473, a `beetlefolk-charger`) sat **outside** the authored 200ft territory
circle. Chasing it pulled the player physically out of the zone; once out, the
hysteresis latch flipped `playerInTerritory` false; the _next_ poll then
dropped `familyEnemy` entirely (gate fails) and fell back to the in-zone
`territoryTarget` patrol point, pulling the player back inside the zone; once
back in, the latch flipped true again, re-acquiring the _same_ far-off enemy —
a stable two-state limit cycle that undid all just-made chase progress every
~1s and could burn the remainder of the floor's collapse timer.

This is a genuinely different bug from the prior `isFloor2HuntRecoveryWindow`
engage/recovery patrol cadence (verified inactive here: floor2 remaining time
was already below the 6-minute urgency threshold, so that cadence was already
fully suppressed) and from the reachability cache / engage watchdog (both
confirmed stable — `reach=true` throughout, `ignoredUntil` always `undefined`
during the oscillation).

### Fix

In `findFloor2QuestProgressTarget` (`src/game/ai/bt-ai-provider.ts`), removed
the `playerInTerritory && territoryZone` gate specifically from the
`familyEnemy` search, making it call `findNearestFloor2HuntEnemy` unconditionally
(still bounded by `FLOOR2_HUNT_CHASE_RADIUS_FT` and the family-id filter, still
respecting the existing blacklist/reachability logic). `territoryEnemy` (the
in-zone trash-clearing search used for `territoryClearTarget`/patrol fallback)
and `territoryTarget` (patrol) are **unchanged** — their purpose (clearing or
patrolling the _authored_ zone) is legitimately tied to being physically
inside it. Only the "which enemy counts toward this family's kill quota"
search was un-gated, matching the fact that the quota itself is not
territory-scoped: `floor2Scenario.ts`'s `trashKillsByFamily` counts any kill of
a family member anywhere on the map, regardless of zone.

No constants, thresholds, gameplay balance, spawn rates, or sweep-harness
gates were changed — this is purely an AI target-selection fix in
`src/game/ai/**`, per the issue's constraints.

## Evidence

### Before (baseline, matches published RunStats)

Seed 1: raccoons unlock 293.2s → faeries 519.6s → llamas 837.6s → **beetlefolk
stuck 7/50 kills at 1200s timeout, TIMEOUT outcome**. Combat: 238 total kills
(162 family, 73 neutral, 3 boss). `decision.state` oscillated ENGAGE/EXPLORE
with a stable ~60-frame period for the final ~360s with no net progress.

### After (same seed, fix applied)

```
$ npm run ai:headless -- --floor floor2 --seed 1 --max-frames 72001
...
floor2-den-raccoons-unlock: accepted 0.0s, ✓ 247.0s
floor2-den-faeries-unlock: accepted 0.0s, ✓ 467.0s
floor2-den-llamas-unlock: accepted 0.0s, ✓ 668.5s
floor2-den-beetlefolk-unlock: accepted 0.0s, ✓ 831.4s
floor2-leave-floor: accepted 835.2s, ✓ 994.2s

raccoons   kills  50 (unlock  50) · boss defeated 248.9s
faeries    kills  65 (unlock  50) · boss defeated 471.3s
llamas     kills  53 (unlock  50) · boss defeated 671.8s
beetlefolk kills  51 (unlock  50) · boss defeated 835.2s
Exit:       completed
Movement Quality: Wiggle 1.7% · Idle 0.9% · Stuck 6.6% · Travel Eff. 93.6%
```

Full **VICTORY** at 994.2s (all 4 dens unlocked and bosses defeated,
run completed and exited) — versus a TIMEOUT at 1200s before the fix.

Seed 4 (the other straggler flagged in the prior handoff) also went from
TIMEOUT to full VICTORY at 1093.3s, all 4 dens unlocked/defeated (faeries
597.7s, ratfolk 757.2s, llamas 898.6s, crabfolk 409.4s — note crabfolk unlocked
early in this seed's family-commit order, illustrating that "last committed"
is not always numerically last but is still the one previously prone to the
oscillation), with Movement Quality Wiggle 12.0% / Stuck 23.1% (this seed's
run has more incidental navigation friction than seed 1, but it no longer
gets stuck oscillating on the last family — it still finishes).

### Floor-1-chain

The floor1-chain leg shares the exact same `findFloor2QuestProgressTarget`
code path (it enters Floor 2 after Floor 1 in chain mode), so the same fix
applies to its missing-1-family timeout bucket by construction. Per the
issue's explicit instruction not to run more than a handful of individual
headless invocations and not to dispatch a new sweep, this was not
independently re-run seed-by-seed here; the next scheduled release sweep is
the canonical re-measurement, as instructed.

### Regression coverage

Added a new test in `tests/game/behavior-tree-ai.test.ts`: _"does not drop the
last family member sitting outside its own territory zone (2026-08-23
last-family-hunt-pacing fix)"_. It places a single family enemy outside an
authored territory zone (but within `FLOOR2_HUNT_CHASE_RADIUS_FT`) and polls
`findFloor2QuestProgressTarget` while the (simulated) player oscillates
between deep-inside-zone and outside-zone-closing-in positions — exactly
mirroring the old feedback loop's two poles — asserting the family enemy
remains the selected target on every single poll, including every
"back-inside-zone" pole where the old code would have dropped it.

Also updated the adjacent pre-existing test _"does not flip the Floor 2 hunt
objective target when parked on the zone boundary (2026-08-21 wiggle fix)"_:
its final assertion (player pushed past the hysteresis band but still within
chase radius) now correctly expects the family enemy to _remain_ the target
(this is the intended new behavior — zone membership no longer gates
`familyEnemy`), and a new final poll pushes the player genuinely beyond
`FLOOR2_HUNT_CHASE_RADIUS_FT` to confirm the target _does_ change once the
enemy is truly out of chase range.

### Validation run

- `npx vitest run tests/game/behavior-tree-ai.test.ts` — **139/139 passed**
  (including the updated zone-boundary test and the new oscillation
  regression test).
- `npm run typecheck` — clean, no unused-variable or type issues from the
  edit (`playerInTerritory` remains used by `territoryEnemy`).
- `npm run perf:fingerprint -- --write /tmp/fp-after.json` (with fix) then
  `git stash` (removing the fix) + `npm run perf:fingerprint -- --check
/tmp/fp-after.json` (without fix) → **`RunStats identical: every run in the
sample matches the baseline byte-for-byte`**, hash
  `00a597759e2afc1848faab77bd2b752fe99b2f515405ce926d5bb40cc6220f7f` both ways.
  Floor 1 (seeds 1-8 × sword/bow/baseball-bat, the full PR gate sample) is
  byte-identical with and without this change — this fix only touches Floor-2
  code paths, as expected.
- `bash scripts/agent/verify-fast.sh` — **passed**: 144 test files / 2368
  tests, all data-contract/integrity/coverage checks green (silent-merge-revert
  guard skipped locally per its own shallow-clone note; CI runs it with full
  history).
- `npm run check:wired-systems` — passed: 54 systems checked, all wired.
- `codeql_checker` — 0 alerts (analysis skipped due to database size, not a
  failure signal from this change).

## Decided Against / Follow-up

- **floor1-chain's separate `unlocked=4/4, defeated=3/4` bucket (4 runs in
  this baseline)**: boss den unlocked but boss not defeated by the collapse
  deadline. This is a distinct mechanism from the oscillation fixed here (no
  quota-progress stall — the den is already open) and was explicitly flagged
  as out of scope by the issue. **Recommend filing this as its own follow-up
  issue** once a repro seed is pinned down from a future baseline (this
  session did not have a floor1-chain seed mapping available locally to
  reproduce it directly, and the issue instructed not to dispatch a new sweep
  to go find one). Suggested follow-up issue text:

  > Title: floor1-chain release-sweep timeouts where all 4 Floor-2 dens
  > unlock but the last boss isn't defeated before collapse
  >
  > In the `3291d5cdf5abdb575a8628b7e4fbd6b0ad44e4c8` release-sweep baseline,
  > 4/16 floor1-chain timeouts had `floor2Progression`: all 4 families
  > `denUnlocked: true` but one `denBoss.defeated: false` at the collapse
  > deadline — i.e. the AI reached and engaged the final boss but didn't kill
  > it in time. This is a boss-engagement-pacing question (why does the boss
  > fight itself run long/stall), not the last-family kill-quota-hunt
  > oscillation fixed in `2026-08-23-floor2-last-family-hunt-pacing.md`. Needs
  > its own seed repro (pull floor1-chain seeds with this signature from the
  > next baseline) and its own investigation into boss-fight AI pacing
  > (`bossTarget` selection/engagement logic in `bt-ai-provider.ts`) before any
  > fix.

- Did **not** touch `bt-ai-tuning.ts` constants (chase radius, hysteresis
  tiles, engage/recovery cadence, watchdog frames) — the issue explicitly
  prohibited weakening any threshold, and the root cause was a logic gate, not
  a mistuned constant.
- Did **not** change map/territory-zone generation (`cave-system.ts`) even
  though the underlying condition (a family enemy spawning/roaming outside its
  authored zone) is arguably a mapgen looseness — the fix makes the AI
  correctly handle that case regardless of zone geometry, which is the
  smaller, safer, AI-runner-side mitigation the issue asked for in lieu of a
  mapgen change. No mapgen-side follow-up issue is warranted; this is not a
  lockout (the enemy was always within chase range, just outside the
  patrol/clear zone).

## Next Steps

- The user (issue owner) will open the PR from this branch's working-tree
  state; this session intentionally did not create a PR per the issue's
  instructions.
- The next scheduled release sweep is the canonical way to confirm the win
  rate recovers to ≥90% on both `floor2` and `floor1-chain` legs across the
  full seed panel — this session's evidence is the two full single-seed
  before/after repros (seeds 1 and 4) plus the Floor-1 neutrality proof, per
  the issue's explicit "do not dispatch a new sweep" / "do not run more than a
  handful of local headless runs" constraints.
- Consider filing the floor1-chain boss-defeat-pacing follow-up issue drafted
  above once a repro seed is available.

# Session Handoff: Mid-run Death Followup (Melee Multi-Threat Push + RETREAT Watchdog)

## Date

2026-07-16

## Persona

Producer -> Systems Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual

## What Was Done

Requested to re-verify the historical mid-run-death investigation (baseline SHA
`7974d2e`, weapon-sweep run `29477221792`, 505/600 victories) against **current
`main`** (`b6bca40f`), which already had two sibling PRs merged (#1197 "prevent
legacy Floor 1 deaths", #1198 "multi-threat escape push... for ranged kiting").
Ran the mandated HARD GATE: 8 ranged pairs (seed12/25 × {bow, fireball, pistol,
throwing-knife}) + 2 melee controls (sword@12, baseball-bat@25), all
`--weapon-personas --max-frames 19800` (exactly 10 local runs).

**Result: 4/8 ranged pairs already resolved** (bow×2, pistol×2) by the two
merged PRs. **4 remained broken**: throwing-knife@12, throwing-knife@25,
fireball@25 (still death), and — critically — **baseball-bat@25, a required
control that used to be a victory, now died** (a real regression exposed only
under `--weapon-personas`, since the sibling PRs' own validation didn't use
that flag).

Root-caused the baseball-bat@25 regression: PR #1198 added
`computeOtherThreatEscapePush` (fixes free chip damage from an unwatched-angle
enemy while kiting a single target) but wired it **only** into
`computeRangedKiteTarget` — its own handoff explicitly states "Melee kiting is
untouched — ranged-only per scope." Extended the same, already-reviewed helper
into `computeMeleeKiteTarget`.

**First attempt regressed a different control.** Wiring it unconditionally
(matching ranged's wiring 1:1) fixed baseball-bat@25 but flipped **seed 12
sword** — a control that must stay green — from victory to death in an
unrelated later encounter. Root cause: melee's strike band sits right on the
enemy (unlike ranged's wider standoff orbit), so nudging position during
ordinary _healthy_ fights measurably hurts hit-connection rate and prolongs
net exposure instead of shortening it. Fixed by gating the push behind the
function's existing `defensive` flag (health < `MELEE_DEFENSIVE_HP_FRACTION` =
0.4) — healthy melee combat is now byte-identical to before this change;
sword@12 re-confirmed byte-for-byte identical to the original baseline
(L3, 240.5s, 113.7% HP) after the fix.

With the melee fix wounded-gated, baseball-bat@25 **still died** (nearly
identical timing, ~139.6s vs ~140.2s baseline) — the earlier "fix" only
"worked" while unconditional, meaning chip damage from an unwatched angle
wasn't the actual mechanism for this seed. Captured a fine-grained
`--event-log` and found the real signature: the player was pinned in place
(near-zero net world-position displacement) for several seconds while
surrounded by **16-20 simultaneously alive enemies** during the Floor 1 boss
battle, health draining continuously despite `RETREAT` being active — a
genuinely different bug: `pickRetreatTarget`'s arc-scan + A* verification only
proves a candidate tile is reachable *in principle\* against the static floor
map; it cannot prove the player can actually walk there once a dense swarm's
colliders occupy the path.

Implemented a second, independently-precedented fix: `updateRetreatWatchdog`,
mirroring the **already-existing** `updateExploreWatchdog` / `DwellTracker`
pattern (the same watchdog class already used for EXPLORE/COLLECT/ENGAGE
no-progress detection — RETREAT was the one commit-to-an-action state missing
one). When health-critical RETREAT makes zero real net-displacement progress
for 45 frames, it ends the retreat and suppresses re-entering it for 90
frames, falling back to Engage's direct vector-based kiting (immune to A\*
reachability — pure radial/strafe/escape-push math). Deliberately does **not**
use damage/kills as a "progress" signal (unlike the existing
`updateGlobalDwellWatchdog`) since auto-fire can land kills on adjacent swarm
members while the player is otherwise completely boxed in and dying.

This second fix confirmed to fire and change behavior (real event-log
movement post-fix vs. the pinned-in-place trace before it), but **did not
resolve baseball-bat@25** — the encounter has 16-20 simultaneous enemies for
an extended window, which is not survivable through movement alone regardless
of retreat/kiting quality for this weapon-persona's stat build. This matches
`docs/knowledge/handoffs/2026-07-11-weapon-stat-personas.md`'s own explicit
caveat: the six weapon-persona profiles are "**intentionally unbalanced
starting values**... remains off by default until broad weapon sweeps and
human balance review approve enabling it." Per the mandate's explicit stop
gate ("if evidence says gameplay balance rather than runner/runtime bug, STOP
implementation... return a data-backed proposal"), did **not** chase this
further — it would require touching stat/HP/damage-adjacent values or
spawner/enemy-density tuning, both explicitly out of scope for this session.

**Net result of this session**: 5/8 ranged pairs are victories (bow×2,
pistol×2, fireball@12), sword@12 control confirmed unregressed, 3 ranged pairs
(throwing-knife@12/25, fireball@25) and baseball-bat@25 remain deaths — all
four sharing the same "high sustained enemy count during an extended
weapon-persona-affected boss encounter" signature, which is evidence of a
weapon-persona balance gap, not a runner bug. **No PR-worthy code change would
fully close the original done-gate** (all 8 pairs + 2 controls green) without
crossing into forbidden balance territory; shipped the two real, validated,
safe decision-logic improvements instead and recorded the residual gap for
human balance review.

## Key Decisions Made

- Extended `computeOtherThreatEscapePush` to melee, but **wounded-gated**
  (`defensive` flag) rather than unconditional — a real regression run proved
  unconditional wiring (matching ranged 1:1) hurts healthy melee combat.
  Documented the regression directly in the function's doc comment so a future
  session doesn't re-attempt the unconditional version.
- Added a RETREAT-specific no-progress watchdog rather than reusing the
  existing damage-based `updateGlobalDwellWatchdog`, because that watchdog's
  "dealt damage" progress signal is exactly defeated by this failure mode
  (auto-fire keeps landing kills on adjacent swarm members while the player is
  otherwise boxed in and dying) — a genuinely distinct no-progress definition
  (real displacement only) was required.
- Declined to pursue the residual baseball-bat@25 / 3-ranged-pair deaths
  further once event-log evidence pointed at sustained 16-20-enemy pressure
  interacting with weapon-personas' explicitly-documented unbalanced stat
  profiles, per the mandate's stop-and-report gate for balance-adjacent
  findings. No stat/HP/damage/spawn-rate values were touched.
- Kept both fixes even though neither is sufficient alone to close the full
  original done-gate — each is independently real, tested, reviewed, and
  strictly non-regressing (confirmed via `tests/headless/floor1-legacy-death-regressions.test.ts`
  7/7 and `tests/headless/collision-pair-parity.test.ts` golden-fingerprint
  parity, both unchanged).

## Observe before done

- Real headless pipeline (`src/game/ai/headless-runner-cli.ts`,
  `--weapon-personas --max-frames 19800`), all 10 mandated cases, run before
  and after each code change:
  - seed12 bow/fireball/pistol, seed25 bow/pistol: victories both before and
    after (already fixed by the two merged sibling PRs; unaffected by this
    session's changes as expected, since neither touches ranged code).
  - seed12 sword (control): victory before AND after this session's final
    state (byte-identical L3/240.5s/113.7% HP) — confirmed via a real
    regression-then-fix cycle, not just inspection.
  - seed25 baseball-bat (control): death before, briefly a victory with an
    unconditional (later reverted) melee push, death again after the
    wounded-gated fix + retreat watchdog (139.6s vs 140.2s baseline) —
    genuinely investigated via `--event-log`/`--debug`, not assumed.
  - seed12/25 throwing-knife, seed25 fireball: death before and after (not
    touched by either fix, as expected — the root cause is orthogonal).

## What's Next / Blockers

1. **Human balance review needed** for the weapon-personas feature
   (`src/game/ai/weapon-personas.ts`) before it can safely be considered
   default-on — this session's evidence (baseball-bat/throwing-knife/fireball
   dying to sustained high-density boss encounters that sword/bow/pistol
   survive) is a concrete, reproducible data point for that review, in
   addition to the "intentionally unbalanced" caveat already on record from
   the personas' introducing session.
2. If a future session wants to fully close the original 8-pair + 2-control
   done-gate, it will likely need either (a) weapon-persona stat rebalancing
   (human-approved, out of this session's scope) or (b) a boss-room/spawner
   enemy-density investigation (also balance-adjacent, needs explicit
   approval per rule #12).
3. The RETREAT no-progress watchdog has no dedicated unit test (time-boxed
   3-apple budget) — the code-review agent flagged this as a non-blocking gap.
   A future session adding melee/ranged boss-room regression coverage should
   consider a synthetic "boxed in by N enemies, zero A\*-reachable retreat
   tile" unit test for `updateRetreatWatchdog` directly.

## Retrospective

### Lessons Learned

- `--weapon-personas` is not just an additive flag — it changes stat/gear
  allocation enough to expose real bugs (baseball-bat@25) that the two
  sibling PRs' own validation (which didn't use `--weapon-personas`) never
  saw. Any future AI/combat-decision fix session should validate under both
  modes if the reproduction case specifies personas.
- An "unconditional" multi-threat escape push is NOT a safe default for melee
  kiting the way it is for ranged — melee's strike band sits on top of the
  enemy, so any positional nudge trades DPS/hit-connection for safety even
  when no real danger exists. Always re-validate a kiting/positioning change
  against a HEALTHY control, not just the wounded scenario it targets.
- `git-stash`/pre-existing-baseline checks (used by both sibling sessions to
  confirm "not a new regression") are essential — I used the same technique
  (checking `endRetreat`'s ignore-list side effect, `DwellTracker`'s
  self-reset behavior) to avoid re-inventing already-solved sub-problems.
- `--event-log`/`--debug` on the headless CLI gives frame-by-frame
  `(px, py, state, reason, health, enemyCount, netDisp)` telemetry that is
  far more diagnostic than the summary `RunStats` block — use it early when a
  death's root cause isn't obvious from aggregate decision-state counts alone.

### Mistakes Made

- Initially assumed (without direct evidence) that baseball-bat@25's death was
  the same "unwatched-angle chip damage while kiting a single target" bug the
  ranged-kiting-strategy PR fixed, and shipped a first version of the melee
  fix on that assumption alone. It broke a control (sword@12) that a real
  headless re-run immediately caught — the assumption was wrong; the real
  mechanism (verified afterward via event-log) was a distinct "boxed in
  during RETREAT" failure that the melee kiting fix never touches. Lesson:
  even a plausible, precedented hypothesis needs a direct telemetry check
  before committing code, not just "this pattern matches a known bug class."
- Spent significant time trying to tune the RETREAT watchdog's exact
  thresholds to flip baseball-bat@25 to a victory before recognizing (via the
  same event-log evidence) that the encounter's sheer simultaneous enemy
  count, not the watchdog's timing, was the limiting factor — should have
  paused sooner to ask "is more threshold-tuning here starting to look like
  cherry-picking a seed?" per rule #12, rather than iterating further.

### Opportunities for Future Improvement

- A deterministic headless assertion for "max simultaneous alive enemies
  during any Floor 1 boss encounter" would make it much faster to distinguish
  "AI decision bug" from "enemy-density/balance issue" in future death
  investigations, instead of manually eyeballing `enemyCount` in an
  `--event-log` dump.
- Consider adding a small, dedicated `updateRetreatWatchdog` unit test
  (synthetic dense-swarm world where every `pickRetreatTarget` candidate
  fails A\* verification) so this watchdog's own behavior is regression-tested
  independent of a full headless run.

# Fix Floor 2 Bat Dodging

**Date:** 2026-07-16  
**Branch:** `nalfeo-fix-bat-ranged-dodging`  
**Estimate:** 3 apples  
**Actual:** 3 apples (exact)

## Systems touched

ai-behavior-tree, ai-combat-balance

## Root cause

Floor 2 family-hunt objectives correctly selected priority enemies, but tagged
them with the focused engagement style. `planFocusedMeleeEngagement` then drove
every melee weapon directly onto the target center, bypassing the shared
cooldown-aware melee planner. The baseball bat therefore face-tanked during its
900 ms recovery even though normal melee engagement already knew how to poke in
when ready, recover outward after firing, and juke laterally.

No weapon or enemy damage, health, range, cooldown, spawn composition, den
threshold, timer, loadout, or seed-specific state changed.

## Baseline evidence

The current-main failure reproduced twice with identical gameplay metrics:

`npm run ai:headless -- --seed 42 --weapon baseball-bat --floor floor2 --max-frames 100000 --max-time-ms 600000 --progress 0 --weapon-telemetry`

- Death at frame 5,895 / 98.25 seconds with 19 kills and no den unlocks.
- 410.0125 damage taken.
- 41 swings, 37 connecting (90.2%), 17 multi-hit, 68 total enemy hits.
- Damage sources: imp-chain-brawler 185, imp-flinger 121,
  crystal-scuttler 45, glow-worm 30, faerie-blink 20,
  myconid-clubcap 10, cave-bat-swarm 5.

The unchanged sword/config control won at 797.3 seconds before the fix with all
four dens, bosses, and the exit complete.

## Change

- Focused Floor 2 melee hunts now preserve objective prioritization while
  delegating movement to the same cadence-aware engagement planner as normal
  combat.
- Added focused-hunt regressions for cooldown-ready inward pressure,
  just-fired outward recovery, and continued closing outside strike range.
- Added headless-only post-mitigation damage attribution by stable attacker
  identity, exposed in `RunStats` and CLI summaries. This does not add game or
  rendering runtime logging.

## Production proof

The exact bat proof ran twice with identical gameplay metrics:

- Victory at frame 46,774 / 779.6 seconds.
- Family kills: imps 53, myconids 50, kobolds 51, faeries 51.
- Every den unlocked at 50 kills and was entered.
- Boss windows: imps 196.2-196.8s, myconids 449.3-450.3s,
  kobolds 657.2-657.7s, faeries 757.9-758.3s.
- Exit completed.
- 10,418 damage dealt / 225 taken; minimum health 91.7%.
- 385 swings, 339 connecting (88.1%), 39 multi-hit, 390 total enemy hits.
- Damage sources: crystal-scuttler 83, cave-bat-swarm 42, imp-flinger 24,
  glow-worm 22, faerie-blink 15, giant-cave-rat 15, myconid-spore 14,
  myconid-clubcap 6, imp-chain-brawler 5.

The same-config sword outcome control also passed:

- Victory at frame 48,413 / 806.9 seconds.
- Family kills: imps 52, myconids 50, kobolds 50, faeries 52.
- Every den entered, every boss defeated, and exit completed.
- 9,544 damage dealt / 239 taken; minimum health 89.7%.
- 447 swings, 391 connecting (87.5%), 30 multi-hit, 429 total enemy hits.

Neither successful run entered RETREAT, so there is no retreat/engage
oscillation or permanent disengagement.

## Verification and review

- Focused BehaviorTreeAI and headless telemetry suites: 107 tests passed.
- `npm run verify:fast`: 403 tests passed.
- Separate-model plan review: `claude-opus-4.8`, four concerns resolved,
  `plan_divergence: minor`.
- Separate-model code review: `claude-sonnet-4.6`, clean first round.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-16-fix-bat-ranged-dodging.review-ledger.json`

## Apples

3 estimated, 3 actual (exact). The work required deterministic production
diagnosis, a shared-planner correction, regression coverage, telemetry, and
full bat/control proof as expected.

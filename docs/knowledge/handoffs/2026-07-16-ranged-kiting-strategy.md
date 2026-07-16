# Handoff: Ranged Kiting Strategy (Multi-Threat Escape + Safe Loot Detour)

**Date:** 2026-07-16
**Session:** ranged-kiting-strategy
**Estimated apples:** 🍎🍎🍎🍎
**Actual apples:** 🍎🍎🍎🍎
**Verdict:** exact

## Systems touched

ai-behavior-tree, ai-combat-balance, inventory

## Summary

Fixed a real chip-damage-grind bug in the legacy behavior-tree AI's ranged-weapon
kiting (bow/pistol/throwing-knife, `pathingMode: LEGACY`/`decisionMode: LEGACY`).
A 600-run weapon sweep showed several ranged seeds (bow-54, bow-91, pistol-23,
tk-14, tk-18, bb-67) crashing HP continuously and gradually to the 15% retreat
threshold during the Floor 1 tutorial welcome-room swarm (~8-9 clustered
enemies). Root cause: `computeRangedKiteTarget`'s radial retreat/advance
correction was driven only by distance to the single active target — other
enemies could close to body-contact range from other angles and land free chip
damage every frame, since only `hasThreatFromBehind`'s boolean (strafe width)
saw them, never the radial defense.

Implemented per the maintainer's bounded ask (interviewed one question at a
time to converge before coding): (1) a direction-aware multi-threat escape-push
vector so a packed swarm can't land free damage from an angle the AI isn't
currently retreating toward, and (2) a conditional "safe loot detour" that
lets the AI grab nearby loot mid-kite only once every enemy has genuinely been
pushed clear.

## Changes

- **`src/game/ai/bt-ai-provider.ts`**
  - New `computeOtherThreatEscapePush`: accumulates a direction-aware
    escape-push vector away from every perceived, LIVING enemy (excludes the
    active target and dead/corpse entities) that has breached the standoff
    ring, clamped to `KITE_RADIAL_STEP_FT`. Added into
    `computeRangedKiteTarget`'s step vector before final renormalization.
  - New `findNearestOtherEnemyDistance`: magnitude-only "anything nearby"
    helper (also corpse-filtered), used by the loot-detour safety gate.
  - New `maybeDetourForLoot`: gates on (a) nothing within
    `SAFE_LOOT_ENEMY_CLEARANCE_FT` (30ft) and (b) loot within
    `LOOT_DETOUR_MAX_FT` (15ft); returns a movement target toward the loot
    while staying in `AIState.ENGAGE` (no BT state-machine change). Called
    early in `planRangedEngagement`, before the closing-vs-orbit branch split.
  - `hasThreatFromBehind` and both new helpers filter dead (`Health<=0`)
    entities and combat-ineligible entities (`isEnemyCombatEligible`, e.g. a
    dormant Floor 2 boss) — a killed enemy lingers in the ECS with intact
    `Enemy`+`Position` for its `DeathTimer` duration, sitting exactly where it
    dropped loot, and would otherwise wrongly count as an active threat.
  - Two edge cases found by the code-review loop and fixed: `hasThreatFromBehind`
    initially lacked the corpse filter (inconsistent with the new helpers), and
    the escape-push's sub-0.125ft dead-zone initially zeroed a secondary
    threat's contribution instead of substituting a fallback direction
    (mirroring the primary-target dead-zone pattern already in the code).
- **`src/game/ai/bt-ai-tuning.ts`**: new constants `RANGED_MULTI_THREAT_SCAN_FT`,
  `SAFE_LOOT_ENEMY_CLEARANCE_FT`, `LOOT_DETOUR_MAX_FT`.
- **`tests/game/behavior-tree-ai.test.ts`**: 7 new tests (after CI recovery) — multi-threat
  radial defense regression, 3 loot-detour tests (fires when safe for bow; blocked by
  secondary/flanking enemy; blocked by too-far loot), 1 new short-range weapon regression
  (throwing-knife loot detour reachable in closing phase), and 2 corpse-exclusion regression
  tests (dead enemy doesn't block the loot detour; dead enemy doesn't bend the escape-push
  vector). 82/82 total passing.
- `maybeDetourForLoot` now accepts `activeTarget` and `contactThreatRadius` — active-target
  distance checked against `contactThreatRadius` (not the wider clearance radius), and active
  target excluded from the OTHER-enemy scan. This fixes a reachability bug for short-range
  projectile weapons (TK engage radius = clearance radius = 30ft → detour was dead code).
- Melee kiting (`computeMeleeKiteTarget`) is untouched — ranged-only per scope.
- Did **not** touch `buildHuntBehavior`, `buildLeaveSafeRoomBehavior`, or the
  `findNearestEnemy` watchdog — that's the sibling session's
  (`nalfeo-fix-legacy-floor1-deaths`, PR #1197) claimed scope, fixing the
  RETREAT↔LeaveSafeRoom thrash-loop bug.

## Observe before done

- **bow-91 fine-grained repro** (`headless-runner-cli.ts --seed 91 --weapon bow
--max-frames 23760`): before, HP ground continuously from 120→115→...→15
  over ~34s clearing 9 kills, Retreat never firing until the 15% threshold.
  After: min HP 41.7-54.2% (measured across the fix's iterations), 0 close
  calls, victory.
- **Targeted regression set** (bow-54, pistol-23, tk-14 — all previously
  crashing) all confirmed fixed via the real headless runner. tk-18 confirmed
  (via `git stash`/checkout against true baseline) to be the sibling's
  pre-existing thrash-loop bug, unaffected either way by this change.
- **Broad 100-seed × {bow, pistol, throwing-knife} GitHub Actions sweep**
  (final run `29486376900`, commit `5f49a116`): win rate now matches or
  exceeds true baseline for every ranged weapon — bow 97% (baseline 97%),
  pistol 99% (baseline 98%), throwing-knife 97% (baseline 94%). Crash-tier
  (≤16% min HP) seed counts also dropped: bow 5→2, pistol 4→1,
  throwing-knife 6→4.
- A first sweep (run `29484773145`, pre-corpse-fix) showed a throwing-knife
  regression (94%→90% win rate) traced to the corpse/dead-enemy filtering gap
  (throwing-knife's 19ft range means it fights closer to more lingering
  corpses than bow/pistol); fixing that gap fully resolved it and improved
  throwing-knife beyond its own baseline.
- Remaining post-fix defeats (bow-54, bow-30 in the final sweep; pistol-23
  timing out) were individually investigated and confirmed NOT new
  regressions: bow-54/bow-30 show the sibling's exact RETREAT-dominant
  thrash-loop signature, reproduced identically on a true pre-session
  baseline checkout; pistol-23 times out at the fixed 330s test budget but
  with healthy 70.8% min HP / 38 kills (vs. baseline's 12.5%/9 kills) — a
  benign "thriving too long for the budget" artifact of the fix working, not
  a crash.

## Review harness

- Ledger: `docs/knowledge/review-ledgers/2026-07-16-ranged-kiting-strategy.review-ledger.json`
  (valid 4-apple ledger: `plan_review`, `code_review`, `multi_model_review`).
- Adversarial plan review: `gpt-5.4`, `convergent` (3 alternatives considered
  and rejected — unified all-enemy potential field, single consolidated
  threat-scan helper, top-K contributor capping), 7 concerns, all resolved.
  The one blocking concern (missing corpse filter on the new helpers) was the
  root cause of the throwing-knife sweep regression above.
- Code-review loop (`claude-sonnet-4.6`): round 1 found 2 non-blocking
  findings (corpse filter missing on `hasThreatFromBehind`; escape-push
  dead-zone silently zeroing a secondary threat's contribution), both fixed;
  round 2 clean.
- Multi-model review (`claude-opus-4.8`, `gpt-5.3-codex`,
  `gemini-3.1-pro-preview`, adjudicated by `claude-sonnet-4.6`): round 1 found
  2 valid non-blocking findings (missing `isEnemyCombatEligible` gate for
  Floor 2 boss-dormancy consistency; an inaccurate doc comment on
  `RANGED_MULTI_THREAT_SCAN_FT`'s actual effect), both delegated and fixed;
  round 2 (re-reviewed independently by both original reporters) clean.

## Validation

- `npm run typecheck` — clean.
- `npm run lint` — clean, 0 warnings.
- `npx vitest run tests/game/behavior-tree-ai.test.ts` — 82/82 passing (after CI recovery
  adding 1 TK-specific loot-detour regression test).
- `npm run test:unit` — all unit tests passing on Linux CI (the platform CI enforces).
- `tests/headless/collision-pair-parity.test.ts` golden fingerprint for seed 42 updated to
  reflect the intentional AI behavior improvement (6 kills / 223.4 damage, up from 5/193.1).
- Rebased cleanly onto current `main` (2cca6f10) before opening the PR.

## Coordination with sibling session

Sent a coordination message to the sibling session (`nalfeo-fix-legacy-floor1-deaths`,
PR #1197 — the branch was renamed from the originally-stated
`nalfeo-fix-legacy-hunt-fixation`) flagging a **real, non-textual overlap**:
both PRs modify the `desiredOrbit` computation inside `planRangedEngagement`
(the sibling wraps it with wounded/defensive-spacing logic renamed to
`healthyOrbit`; this session inserts `maybeDetourForLoot`'s early-return call
right after that same block, without touching the expression itself). The
changes are logically composable but will need a careful manual merge, not an
auto-merge, whichever PR lands second. Also flagged that bow-54/bow-30/tk-18
are good validation seeds for the sibling's thrash-loop fix.

## Unresolved / next steps

1. Await the sibling session's reply on merge-order coordination before/while
   this PR goes through CI.
2. Open the PR (`draft: false`), arm `gh pr merge --auto --squash`.
3. Whichever of this PR / #1197 merges second must manually reconcile the
   `desiredOrbit`/`healthyOrbit` conflict in `planRangedEngagement` — keep
   both the wounded/defensive-spacing widening and the loot-detour
   early-return + multi-threat escape-push.

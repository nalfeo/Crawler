# Handoff — Shared safe/boss door permanent-seal fix (door-state migration)

**Date:** 2026-07-10
**Branch:** `nalfeo-slicemap-s4b-merged` (2 commits ahead of `origin/main` = ad9a1458)
**Session:** shared-safe-boss-door-fix

## Systems touched

boss-rooms, ai-pathfinding, mapgen

## Summary

Fixed a permanent "unlocked-but-physically-closed" door that stalled the AI on
Floor-1 seeds 64 & 80 (bow timed out, floor boss never spawned). Root cause was
an edge-vs-level authority conflict on a **dual-role door**: on those seeds the
generator places `bossStairRoom` adjacent to `safeRoom` sharing ONE connector
door entity. The old `doorSystem` reconcile clobbered the door's open field to 0
(leaving `isLocked=0`) the same frame the one-shot safe-room unlock edge fired.
That edge needs `wasLocked=true` to re-fire, so it never re-fired → the tile
stayed closed forever → the floor boss (Rat Slime) never spawned → timeout.

Maintainer directed the **RIGHT structural fix, no engine hacks**: a full
field-rename migration that decouples a door's logical latch from physical tile
truth (chosen over 4 narrower alternatives in an adversarial plan review;
`plan_divergence = major_fork`).

## The fix model

- `doorState.isOpen` (bitecs SoA field) → **`logicalOpen`** = intended-open
  LATCH, written only by lock/unlock and floor/encounter authorities (door-lock
  evaluator, floor objective / boss transitions, spawner arenas) — never the seal.
- New stored **`effectiveOpen: Uint8Array`** = physical tile truth, DERIVED every
  frame by `doorSystem` reconcile as `logicalOpen && !isLocked && !isForcedClosed`;
  the tile is driven from `effectiveOpen`.
- Force-close (safe-room seal) now closes only the **tile** for that frame; it
  never clobbers the latch. So a force-closed shared door keeps `logicalOpen=1`,
  and when the seal lifts `effectiveOpen` recomputes true → the door reopens.
- `getDoorRevision()` (enemyAISystem path-memo hash) hashes the **live physical
  tile passability** `tileMap.isPassable(tx,ty)` — not the stored `effectiveOpen`
  mirror and not the latch. This closes a one-frame memo lag a reviewer found
  (`effectiveOpen` is reconciled in `doorSystem`; the floor objective authority
  `floor1ObjectiveTick`/`floorObjectiveSystem` runs AFTER `doorSystem` and opens
  tiles on boss/mini-boss defeat, so the mirror is stale until the next frame's
  `doorSystem` — one AI tick late). Hashing the live tile matches pre-migration
  `isOpen` timing exactly.

## Verification (real artifacts, not a lab)

- **Real headless runner** (bow · RISK_REWARD_FUSED pathing · legacy decision):
  seeds 64 & 80 both flip **timeout → VICTORY** (261s / 324s) with
  `objective.bossBattles.get('staircase').started === true` (floor boss spawned =
  the shared door opened). Pre-fix both timed out with the boss never spawning.
  Control seed 18 (no shared door) unchanged timeout = pre-existing bow slow-clear,
  out of scope.
- **Byte-identity arbiter:** `collision-pair-parity` golden 5/5 pass — the
  `isPassable` memo hash does NOT drift the deterministic fingerprints, confirming
  behavior is unchanged on non-bug seeds.
- typecheck ✓; 152 door + AI unit tests ✓ (`door-system`, `door-system-safe-room`,
  `shared-safe-boss-door`, `door-lock-system`, `door-navigation`, `unit/ai`).
- NEW regression `tests/ecs/shared-safe-boss-door.test.ts` (+125): RED pre-fix,
  GREEN post-fix; deterministic/seeded.

## Diff shape / apples

- +253/−65 across 22 files, but substantive logic ≈ 50 lines (`doorSystem`
  reconcile rewrite + one stored component field + one memo line). The rest is a
  mechanical `isOpen`→`logicalOpen` rename (13 files) + the +125 regression test.
- Estimated **5🍎**, shipped **3🍎** (maintainer flagged the diff is smaller than
  the migration framing implied — correct). Review rigor kept at the 5-apple tier.
  See `docs/knowledge/metrics/apples/2026-07-10-shared-safe-boss-door-fix.json`.

## Review harness

Ledger: `docs/knowledge/review-ledgers/2026-07-10-shared-safe-boss-door-fix.review-ledger.json`

- **plan_review** (adversarial, gpt-5.4): 4 alternatives red-teamed; maintainer
  overrode "Strengthened-F4" to the full migration (`major_fork`); 2 blocking
  mechanics bugs found in a second plan-review pass, both resolved pre-code.
- **code_review + multi_model_review**: distinct models gemini-3.1-pro-preview
  (clean) + gpt-5.4 (found the memo-lag concern → fixed with gpt's own prescribed
  remedy, validated by the golden + real headless) + a claude-sonnet-4.6
  confirming round.

## Follow-ups / flags (non-blocking)

- **Bow balance is a SEPARATE problem** and out of scope for this door PR: even
  with the door open, bow may still time out on other seeds due to watchdog-fling
  - slow-clear issues. Do not gate the door fix on bow reaching 90% win rate
    (rule #13 applies to broad win-rate, not this structural bug).
- **Latent Floor-2+ arena-door-reopen gap** in `spawnerArenaSystem` was kept out
  of scope (the unlock edge there is a no-op because config clears in the same
  call). Ask the maintainer whether they want a follow-up issue.

## Next

PR is being submitted (base = main); then hand off to the PR shepherd to drive
through CI (the headless Floor-1 gate + collision-parity golden run there) to a
squash-merge.

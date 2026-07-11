# Handoff: Bow Ranged Tempo Fix

**Date:** 2026-07-11  
**Session:** bow-ranged-tempo-fix  
**Estimated apples:** 🍎🍎🍎🍎  
**Actual apples:** 🍎🍎🍎🍎  
**Verdict:** exact

## Systems touched

ai-behavior-tree, ai-combat-balance, quests

## Summary

Fixed the Floor-1 bow NPC-approach livelock tracked by issue #453 at the behavior-state seam.
Projectile weapons now keep quest-progress travel steering toward an NPC while the existing
state-independent weapon system auto-fires at nearby enemies. Melee, trap, and unarmed behavior
still clear immediate threats first, but a deterministic per-NPC no-progress valve prevents enemy
rotation from starving the NPC objective indefinitely.

The adversarial plan review produced a major fork. The original plan would have added goal drift
inside generic ranged ENGAGE kiting, but review showed that existing ENGAGE pursuit overrides could
erase that drift and that the change would unnecessarily affect every projectile caller. The
shipped design instead fixes the proven NPC gate and leaves generic ranged kite math unchanged.

## Changes

- Extracted the existing projectile weapon classification used by engagement dispatch and reused it
  at the NPC-approach threat gate.
- Kept `RANGED`, `MAGIC`, `THROWN`, and `BEAM` weapons in Progress/EXPLORE while approaching NPCs,
  retaining travel steering and auto-fire.
- Added a 180-poll, best-distance-based NPC threat-clear valve that survives per-enemy target
  rotation and remains bypassed until the gate exits.
- Reset NPC threat-clear state on objective change/absence, arrival, gate exit, projectile path,
  and provider reset.
- Added deterministic regressions for all four projectile families, preserved melee threat clearing,
  proved the NPC valve spans the existing 120-frame per-enemy watchdog, and proved gate-exit/reset
  behavior from a genuinely latched bypass.

## Observe before done

The pre-fix seed-57 bow trace showed a 167-second stationary ENGAGE orbit that never reached the
quest NPC. The real headless runner after the fix completed seed 57 with a victory at 247.0s:

- `floor1-tutorial` completed at 34.6s.
- `floor1-meet-npcs` completed at 196.6s.
- 158 kills, level 6, 97 XP, 306 gold.
- 13.7s safe-room time, below the 60s diagnostic threshold.
- Persistent artifacts:
  `files/trace/bow-57-after-npc-gate.jsonl` and
  `files/trace/bow-57-after-npc-gate-summary.json` in session artifacts.

Three additional diagnosed bow seeds also won in the real runner:

| Seed | Outcome | Raw game time | Safe-room time | Kills | Level | XP  | Gold |
| ---- | ------- | ------------- | -------------- | ----- | ----- | --- | ---- |
| 2    | victory | 263.5s        | 10.9s          | 169   | 5     | 78  | 111  |
| 18   | victory | 309.1s        | 6.1s           | 230   | 7     | 124 | 138  |
| 26   | victory | 298.3s        | 7.5s           | 207   | 8     | 148 | 261  |
| 57   | victory | 247.0s        | 13.7s          | 158   | 6     | 97  | 306  |

## Review harness

- Ledger:
  `docs/knowledge/review-ledgers/2026-07-11-bow-ranged-tempo-fix.review-ledger.json`
- Adversarial plan review: `gpt-5.4`, `major_fork`, four alternatives.
- Code review: one clean round (`claude-sonnet-5`).
- Multi-model review: round 1 found three valid deduplicated test concerns; delegated fixes were
  followed by a clean round 2 from `gpt-5.3-codex` and `gemini-3.1-pro-preview`.
- The review adjudicator unexpectedly rewrote `bt-ai-provider.ts` to `HEAD` and created a scratch
  `test-runner.ts`; timestamps and reflog isolated the mutation. The approved diff was restored,
  the scratch file removed, and a session-only patch snapshot protected round 2.

## Validation

- `npx vitest run tests/game/behavior-tree-ai.test.ts --reporter=dot` — 56/56 passed.
- `npm run verify:fast` — passed, 211/211 changed-scope unit tests.
- `VERIFY_FULL=1 npm run verify` — all substantive gates passed:
  - regular tests: 62/62;
  - sprite tests: 1154 passed, 1 skipped;
  - headless suite: 20 files, 88/88 tests.
  - The command stopped only at PR preflight because this handoff and telemetry record did not yet
    exist.
- Review ledger validation — valid 4-apple ledger.
- Canonical cloud sweep run `29143378604` completed successfully on commit `be30a9a2`:

  | Weapon       | Pre-fix wins | Post-fix wins | Change |
  | ------------ | ------------ | ------------- | ------ |
  | sword        | 91/100       | 91/100        | —      |
  | bow          | 78/100       | 94/100        | +16pp  |
  | baseball-bat | 88/100       | 89/100        | +1pp   |

  The bow cleared the 90% target without regressing either comparison weapon. The contiguous gated
  prefix also improved to 8/8 bow wins. Each weapon had one run above the 60-second safe-room
  diagnostic threshold, so the sweep showed no bow-specific safe-room anomaly.

- Tightened the deterministic eight-seed bow gate from 50% to 87.5%, the closest representable
  threshold below the 90% broad target. The measured post-fix prefix is 100%.

## Unresolved / next steps

1. Commit and push the cloud evidence and tightened bow gate.
2. Open the PR and begin shepherding.

# 2026-09-06 — Floor 1 achievement gold rebalance

## Systems touched

src/shared/achievements.ts, src/shared/data/achievements.floor1.json, tests/unit/achievements.test.ts

## Ask

Issue #4284: rebalance Floor 1 achievement gold so the first Spell Broker decision remains an actual choice instead of a free three-spell bundle.

## What changed

- Reduced Floor 1 loot-box gold values to keep the pre-broker achievement stack below the three-offer broker rack total.
- Added a canonical economy guard that computes the pre-broker cap from the reward table and compares it to the broker price curve.
- Added deterministic unit coverage asserting the cap stays below the canonical three-offer broker total.

## Evidence

- `tests/unit/achievements.test.ts` now asserts the canonical pre-broker cap is less than the broker rack total derived from `FLOOR1_SPELL_BROKER_COST` and `FLOOR1_SPELL_BROKER_REPEAT_COST_MULTIPLIER`.
- `bash scripts/agent/verify-fast.sh` passed after the change.

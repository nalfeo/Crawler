# Handoff: Balance telemetry-driven nightly improvement sweep

**Date**: 2026-07-16  
**Branch**: `copilot/balance-telemetry-driven-improvement-sweep`  
**Commit**: 522b4d020c1d07ef9975d87e517ddbe6ea303277  
**PR**: #1190 closes  
**Apple estimate**: 3🍎 (actual: 3🍎)  
**Review ledger**: `docs/knowledge/review-ledgers/2026-07-16-balance-telemetry-sweep.review-ledger.json`  
**Balance ledger**: `docs/knowledge/balance/2026-07-16-balance-telemetry-sweep-ledger.json`

## Systems touched

balance, ai, spawners, damage

## Summary

Executed the telemetry-driven balance improvement sweep requested in issue #1190. Analyzed the most recent canonical weapon sweep (run 29477221792, 2026-07-16, main@2cca6f10, weapon_personas=true, 100 seeds × 6 weapons) and identified 3 ranked improvements targeting the ranged-weapon win-rate gap (bow/pistol at 72%, throwing-knife at 76% — all below the 90% target).

## Changes made

### Idea 1: Raise ranged weapon persona constitution minimums (weapon-personas.ts)

- Bow: `minimumTargets.constitution` 5→7
- Pistol: `minimumTargets.constitution` 5→7
- Throwing-knife: `minimumTargets.constitution` 6→7
- Effect: AI allocates constitution first to a higher floor, increasing survivability HP. Also biases gear scoring toward constitution items (auto-progression.ts line 342 uses minimumTargets for gear scores) — treated as intentional combined persona treatment.

### Idea 2: Increase player invincibility frames 250ms→350ms (damageSystem.ts)

- Changed `PLAYER_INVINCIBILITY_MS` constant from 250→350
- Updated damage-lab default (`src/labs/damage-lab/index.ts`) to match
- Updated test comment and test advance time in `tests/game/enemy-ranged-shooting.test.ts` (elapsedMs 400→500 to advance past the new 350ms window)
- Updated comment in `tests/ecs/damage-system.test.ts`

### Idea 3: Reduce Rat Brute contact damage 10→7 (registry.ts)

- `RAT_BRUTE.contactDamage` in `src/game/spawners/registry.ts` reduced from 10→7
- Rat Brutes appear 15% of passive spawns and 40% of defensive spawns in RATS_NEST
- The `DEFAULT_CONTACT_DAMAGE = 5` fallback in damageSystem.ts was NOT changed (it's only a fallback for enemies without explicit Damage components — not relevant to real Floor 1 mobs)

## Plan review findings (resolved)

The gpt-5.4 plan reviewer returned "rejected" with 6 concerns:

1. **Ideas 2/3 were no-ops in tuning.json** — Fixed: changed the actual hardcoded constants (damageSystem.ts) and real mob data (registry.ts) instead
2. **Idea 3 targeted wrong lever** — Fixed: changed per-mob contactDamage in registry, not the global fallback
3. **Idea 1 affects gear scoring** — Documented as intentional combined persona treatment
4. **Constitution 8 too aggressive** — Revised to 7 (more conservative; player has 3 pts/level)
5. **Global changes in experimental mode** — Acknowledged; Idea 2 benefits all modes
6. **Success criteria too coarse** — Adopted: also comparing AvgMinHP survivability metric

## Sweep results

**Baseline** (canonical 100-seed sweep, shard-level data):

- Bow: 72% win rate, AvgMinHP 46.4%
- Pistol: 72% win rate, AvgMinHP 46.8%
- Throwing-knife: 76% win rate, AvgMinHP 45.3%
- Fireball: 88% win rate, AvgMinHP 57.4%
- Sword: 100% win rate, AvgMinHP 75.0%
- Baseball-bat: 92% win rate, AvgMinHP 71.1%

**Post-change** (10-seed indicative local sweep, seeds 1-10, all 3 ideas applied):

- Bow: 100% win rate (+28pp), AvgMinHP 69.7% (+23pp)
- Pistol: 90% win rate (+18pp), AvgMinHP 67.5% (+21pp)
- Throwing-knife: 80% win rate (+4pp), AvgMinHP 51.1% (+6pp)
- Fireball: 90% win rate (+2pp), AvgMinHP 63.4% (+6pp)
- Sword: 100% win rate (unchanged), AvgMinHP 76.2% (+1pp)
- Baseball-bat: 100% win rate (+8pp), AvgMinHP 80.7% (+9.6pp)

**Verdict**: All 3 ideas provisionally accepted. Strong positive signal — ranged weapons dramatically improved. Throwing-knife at 80% (10-seed) is borderline; full 100-seed canonical sweep needed to confirm above 90%.

## Pending: Full canonical sweep

The full 100-seed canonical sweep via GitHub Actions could not be dispatched from the sandbox environment (API calls are blocked). @nalfeo needs to dispatch it manually:

```bash
gh workflow run weapon-sweep.yml \
  --ref copilot/balance-telemetry-driven-improvement-sweep \
  -f weapon_personas=true \
  -f seed_count=100
```

Or use the GitHub Actions UI: https://github.com/nalfeo/Crawler/actions/workflows/weapon-sweep.yml

## Human approval gate

This PR requires **explicit approval** from @nalfeo before merge:

- PR has `merge-train-blocked` label
- No `merge-train` label
- No auto-merge armed
- Only an explicit comment `APPROVED FOR CHECK-IN` by @nalfeo unlocks merge

## Test changes

- `tests/game/enemy-ranged-shooting.test.ts`: Updated test advance time 400→500ms (was testing past the old 250ms window; now correctly tests past the new 350ms window)
- `tests/ecs/damage-system.test.ts`: Updated comment "less than 250ms" → "less than 350ms" (logic unchanged, still advances by 100ms)

## Files changed

- `src/game/ai/weapon-personas.ts` — constitution minimums for bow, pistol, throwing-knife
- `src/core/systems/damageSystem.ts` — PLAYER_INVINCIBILITY_MS 250→350
- `src/game/spawners/registry.ts` — RAT_BRUTE contactDamage 10→7
- `src/labs/damage-lab/index.ts` — invincibilityMs default 250→350 (lab stays in sync with production)
- `tests/game/enemy-ranged-shooting.test.ts` — test fix for new 350ms window
- `tests/ecs/damage-system.test.ts` — comment update
- `docs/knowledge/balance/2026-07-16-balance-telemetry-sweep-ledger.json` — balance ledger (new)
- `docs/knowledge/review-ledgers/2026-07-16-balance-telemetry-sweep.review-ledger.json` — review ledger (new)

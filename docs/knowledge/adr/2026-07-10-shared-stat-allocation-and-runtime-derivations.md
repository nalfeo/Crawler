# ADR: Shared stat-allocation policy and runtime-derived damage/cooldown bonuses

## Status

Superseded by `2026-07-16-primary-stat-system-overhaul.md`

## Date

2026-07-10

## Estimated Complexity

🍎🍎 — touches shared/core/game/engine wiring but preserves existing contracts for flat gear stats.

## Context

PR #1009 introduced `weight` as a placeholder primary stat and added strength/wisdom-derived secondary bonuses. Review found three blocking issues:

1. `damageBonus` was treated as a percentage in new strength scaling, but existing gear uses `damageBonus` as flat additive points.
2. `cooldownReduction` was derived but not consumed by ability or weapon cooldown gates.
3. Non-allocatable stat policy lived only in `LevelUpUI`, while shared reducers and `spendPoints` still accepted placeholder stats.

## Decision

1. Keep `damageBonus` as flat additive to preserve existing equipment semantics, and add a separate secondary stat `damagePercent` for multiplicative damage scaling.
2. Apply both flat (`damageBonus`) and multiplicative (`damagePercent`) bonuses in the player-sourced damage choke point (`applyDamage`) before crit resolution.
3. Consume `cooldownReduction` in both runtime cooldown paths:
   - ability activation gating (`abilitySystem`)
   - weapon readiness/firing gates (`weaponSystem`)
4. Move allocatable-primary policy into shared stat metadata (`isAllocatablePrimaryStat`) and enforce it in:
   - level-up reducer (`incrementStat`)
   - runtime spend API (`spendPoints`)
   - UI gating (consume shared policy, no local-only allow/deny list)

## Consequences

### Positive

- Resolves contract mismatch between percentage scaling and existing flat gear.
- Makes wisdom-derived cooldown bonuses and strength-derived percent bonuses observable in real runtime behavior.
- Prevents headless/lab/direct callers from spending points on placeholder/non-allocatable stats.
- Centralizes allocation policy so UI and shared logic cannot drift.

### Negative

- Adds a new secondary stat surface (`damagePercent`) to stores and tests.
- Slightly changes damage/cooldown timing behavior where EffectiveStats are present.

### Risks

- Broad gameplay tests can regress if they implicitly assume base cooldown timing.
- Future stat additions can still drift unless they follow the same shared-policy pattern.

## Alternatives Considered

1. **Reinterpret `damageBonus` as percentage globally**: rejected because it would break existing gear values (e.g., `2` => `+200%`).
2. **Keep UI-only allocation denylist**: rejected because non-UI callers would continue to bypass policy.
3. **Derive cooldown reduction but leave runtime gates unchanged**: rejected because it keeps a dead stat with no gameplay effect.

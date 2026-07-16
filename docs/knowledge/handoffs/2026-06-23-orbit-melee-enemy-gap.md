# Handoff: Orbit Behaviour / Melee Distance / Enemy Gap-Closing

**Date:** 2026-06-23  
**PR:** #253  
**Apple estimate declared:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** on-target

## Systems touched

enemies, weapons

## What changed

### bt-ai-provider.ts

| Constant                     | Before  | After                      | Why                                                             |
| ---------------------------- | ------- | -------------------------- | --------------------------------------------------------------- |
| `MELEE_HOLD_FRACTION`        | 0.75    | 0.5                        | Closer preferred distance → hits land deeper in the strike band |
| `KITE_RADIAL_STEP_PX`        | 16      | 28 (= KITE_STEP_PX)        | Radial correction now fully competes with tangential component  |
| `KITE_STRAFE_PX`             | — (new) | 7 (≈ 25 % of KITE_STEP_PX) | Normal strafe component; small juke rather than full orbit      |
| `KITE_BACK_THREAT_RADIUS_PX` | — (new) | 160                        | Radius to scan for back-threats                                 |

**`hasThreatFromBehind(world, playerX, playerY, primaryTarget)`** — new private method.  
Queries `[Enemy, Position]`, skips the primary target, checks if any other enemy is within 160 px AND dot-product with toward-target direction < 0 (behind the player). Returns `true` → full orbit; `false` → radial-priority step.

Both `computeMeleeKiteTarget` and `computeRangedKiteTarget` now pass `strafePx = backThreat ? KITE_STEP_PX : KITE_STRAFE_PX` into their `buildStep` closure.

### enemyAISystem.ts

- `tryFallbackChaseNavigation`: removed `persona === PATH_PERSONA.FLANKER` from the early-return guard. Flankers now fall back to direct chase when no path target is found. RANGED guard unchanged.
- `applyPathDrivenBehavior`: added `else if (behaviorType !== AI_TYPE.RANGED && distanceToPlayer > MIN_MOB_PLAYER_DISTANCE)` block that fires when velocity is zero (path exhausted) for any non-NAVIGATOR non-RANGED enemy, driving them toward the player so they never freeze mid-pursuit.

## Testing

115 unit tests pass. CodeQL: 0 alerts.

## Follow-up ideas

- The `KITE_FLIP_FRAMES = 132` juke timer could be shortened slightly now that the primary motion is radial; periodic strafe flips matter less for hit landing but still help with wall-grinding avoidance.
- `KITE_BACK_THREAT_RADIUS_PX` (160 px ≈ 20 ft) could be tuned per weapon type or exposed in `AIConfig`.

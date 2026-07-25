# ADR 0073: Big Wei Berserk uses one runtime-owned self-buff authority

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 5 — touches core runtime plus game/engine/lab seams and deterministic test evidence.

## Context

Issue #1957 requires implementing Big Panda Wei's `big-panda-wei-bamboo-fed-berserk` using the typed mob-ability runtime with a fixed 10s cadence, planted telegraph, and a 4s non-stacking self-buff affecting movement speed, melee damage, and knockback resistance. The default normal game must still record zero casts while Floor 2 production enable remains off.

The implementation crosses multiple seams (core runtime state, combat/movement consumption, and VFX presentation), which needs an explicit decision on where authority for the temporary modifiers lives.

## Decision

Store Berserk as a single runtime-owned active self-buff state keyed by caster entity in `world.mobAbilities.activeBuffsByEntity`, activated only from the typed Big Wei resolve handler.

- Runtime owns cadence/timing, non-stacking guard, exact 4s expiry, and cleanup on death/despawn/encounter disable.
- Gameplay systems consume read-only multipliers through runtime accessors:
  - enemy movement speed (`enemyAISystem`)
  - enemy melee/contact damage (`damageSystem`)
  - knockback resistance (`knockbackSystem`)
- Telegraph remains self-targeting/follows-caster without player target acquisition.
- Telegraph planting explicitly suppresses both velocity and knockback displacement during wind-up.
- Production enable remains off in default runtime wiring; canonical combat arena preset `f2-big-panda-wei` is the verification surface.

## Consequences

### Positive

- One authoritative state controls all three Berserk modifiers, preventing stack/extension drift across systems.
- Expiry and cleanup are deterministic because runtime timers own lifecycle in fixed-step cadence.
- Cross-layer wiring stays typed and explicit instead of ad-hoc boss switches in AI.

### Negative

- Introduces a dedicated runtime buff map that is separate from general status effects.
- Engine VFX needs dedicated reads from mob-ability aura state for presentation sync.

### Risks

- Future simultaneous self-buffs on one caster would need map-shape extension beyond single active buff per entity.
- If runtime accessors are bypassed by future systems, modifier behavior could diverge.

## Alternatives Considered

1. Encode Berserk entirely as status effects.
   - Rejected: current status-effect channel does not natively represent this exact three-modifier self-buff contract without broad schema changes.
2. Add a boss-specific branch in enemy AI/combat systems.
   - Rejected: violates typed mob-ability architecture and scales poorly for future bosses.
3. Interpret arbitrary catalog `designValues` at runtime.
   - Rejected: weakens type safety and deterministic contract enforcement.

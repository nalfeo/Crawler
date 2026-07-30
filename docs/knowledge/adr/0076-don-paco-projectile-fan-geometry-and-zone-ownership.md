# ADR 0076: Don Paco projectile-fan geometry and zone ownership

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 4 — new ability lifecycle contract spanning core runtime, engine VFX, game AI, and arena lab.

## Context

Issue #1952 requires implementing Don Paco's THE BIG GOB: a five-projectile fan cast
that resolves into persistent slick zones, with the full geometry contract shared across
telegraph rendering, AI avoidance, projectile travel, impact damage, and slow application.

This crosses four systems (core mob-ability runtime, engine VFX, game AI, arena lab) and
introduces a new `projectile-fan` geometry kind alongside persistent owned zones. Decisions
are needed for:

1. Where committed five-path geometry lives and who controls it.
2. How projectile-travel state and persistent zone state are owned and cleaned up.
3. How caster death interacts with in-flight projectiles and active zones.
4. How AI avoidance consumes zone occupancy geometry when travel steering is active.

## Decision

### DEC-001: Single committed geometry contract at cast-time

The `projectile-fan` geometry is committed once at telegraph-lock and stored in
`MobAbilityInstanceState.committedGeometry`. Core runtime, engine VFX, and AI all read
the same committed paths — there is no separate per-consumer geometry computation.

### DEC-002: Runtime owns projectile and zone lifecycle via `activeProjectiles` / `activeZones`

In-flight projectiles and persistent slick zones are stored directly in
`MobAbilityRuntime.activeProjectiles` and `MobAbilityRuntime.activeZones`.
These arrays are the single source of truth for travel state (elapsedMs) and zone
occupancy (remainingMs / circle). Caster registration (`byEntity`) is separate from
in-flight state so that the runtime can track casts that outlive telegraph cleanup.

### DEC-003: Validate casters before ticking projectiles and zones (death-ordering contract)

`mobAbilitySystem` validates and clears invalid casters BEFORE calling
`tickActiveProjectiles` and `tickActiveZones`. `clearMobAbility` removes the caster's
projectiles and zones atomically, so a boss killed in frame N cannot fire `onImpact`
or apply zone effects in frame N+1.

### DEC-004: AI zone dodge vector is preserved while the player is inside an active zone

The `preserveMobAbilityDodge` predicate in the travel-steering block is extended to
include active zone occupancy. When the player is inside any active zone's circle, the
dodge vector set by the zone-avoidance branch is NOT cleared before the Track-B blend,
so the AI exits slick zones rather than walking through them.

### DEC-005: MobAbilityVfx renders shared geometry for telegraph, travel, impact, and slick

`MobAbilityVfx` is the sole renderer for all Don Paco visual states. It reads committed
geometry from runtime cues (telegraph, travel frame), pending bursts (impact), and active
zones (persistent slick). This keeps core and game layers free of Phaser imports while
centralising all Don Paco VFX in the existing engine bridge.

## Consequences

### Positive

- One geometry commit propagates to all consumers with no desync risk.
- Death-ordering contract prevents post-mortem damage from in-flight projectiles.
- Zone-occupancy dodge preservation closes the slick walk-through bug introduced when
  travel steering was extended to non-engage states.
- All VFX states are rendered from the same runtime arrays read by gameplay systems.

### Negative

- `activeProjectiles` and `activeZones` grow the mob-ability runtime; large simultaneous
  cast counts would need pruning policy (not yet needed for Floor 2 boss count).
- The extended `preserveMobAbilityDodge` check iterates active zones each poll; this is
  bounded by the zone count (typically ≤ 5 for a Don Paco cast) and acceptable.

### Risks

- Future abilities that add many simultaneous zones may need a spatial index instead of
  a linear zone scan for the occupancy check.
- If the pre-tick caster validation is removed or reordered, the death-ordering contract
  breaks silently; it must remain first in `mobAbilitySystem`.

## Alternatives Considered

### General reusable compound hazard model (Alt A)

A fully general public-geometry system would allow any ability to declare arbitrary
multi-phase hazards with pluggable zone contracts. Rejected because the issue requires
exactly a five-path fan with slicks, and general-purpose infrastructure would be
speculative over-engineering at this stage.

### Hand travel/zones to unrelated projectile/surface subsystems (Alt B)

Scheduling the cast via the mob-ability runtime but delegating travel and zone management
to the existing physics-projectile and surface-status subsystems was considered. Rejected
because it would break the unified committed geometry contract: the renderer and AI
avoidance both need to read the same five locked paths, which those subsystems do not own.

### Per-projectile caster validity check in `tickActiveProjectiles` (Alt C)

Checking `isCasterValid` inside `tickActiveProjectiles` for each projectile (instead of
a pre-tick pass over `byEntity`) was considered. Rejected because it requires duplicating
the validation logic and would not cover zones; the pre-tick pass over `byEntity` is
minimal (one boss entity) and handles both projectiles and zones atomically.

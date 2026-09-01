# ADR 0101: Floor 6 Authored-Site Tower Contracts

## Status

Accepted

## Date

2026-09-01

## Estimated Complexity

🍎 x 5 — adds a Floor 6 runtime tower subsystem spanning validated data, ECS tags, scenario state, real headless wiring, and deterministic tests.

## Context

- **CTX-001**: Floor 6 Slice 5 requires starter towers that can only be constructed on authored build sites, with no route-topology mutation and no UI-owned authority.
- **CTX-002**: Slice 3 already owns immutable Floor 6 route/wave geometry and route-following raiders; Slice 4 already owns run-scoped build currency and upgrade offers.
- **CTX-003**: Tower targeting, attacks, upgrades, and cleanup must replay identically for the same seed and transaction decisions in both visual and headless pipelines.
- **CTX-004**: New tower behavior crosses `src/core`, `src/shared`, `src/game`, and `tests`, so the architectural seam must be documented before implementation.

## Decision

Floor 6 towers are implemented as Floor-6-scoped, data-driven runtime contracts owned by `floor6Scenario`.

- **DEC-001**: Starter tower definitions live in the validated Floor 6 manifest and are projected into immutable runtime tower manifests at setup.
- **DEC-002**: Build/upgrade/sell operations are scenario transaction helpers that atomically mutate Floor 6 extended state and ECS tower entities; presentation code may request them but never owns state.
- **DEC-003**: Tower entities use compact ECS tags/stores for occupancy, cooldown, upgrade level, and stable target telemetry while all durable semantic state remains in `Floor6DefenseState`.
- **DEC-004**: Tower attacks choose legal raiders by deterministic ordering after range and `FloorMap.hasLineOfSight` filtering, then call the existing `applyDamage` primitive for combat effects.
- **DEC-005**: Visual/projectile-like tower effects are bounded floor-scoped entities with lifetimes and terminal teardown; they are telemetry/effect carriers, not a separate collision-damage authority.

## Consequences

### Positive

- **POS-001**: Authored build sites remain the only legal construction targets, so tower placement cannot accidentally rewrite route topology.
- **POS-002**: The same Floor 6 scenario systems run in visual and headless pipelines through existing scenario-definition slots.
- **POS-003**: Existing combat damage accounting remains authoritative because tower hits reuse `applyDamage`.
- **POS-004**: Atomic transactions make illegal, duplicate, unaffordable, and repeated upgrade attempts deterministic no-ops.

### Negative

- **NEG-001**: Tower behavior is intentionally Floor-6-scoped rather than a reusable all-floors tower-defense framework.
- **NEG-002**: Direct deterministic tower hits provide less generic projectile reuse than full collision-driven projectile towers.

### Risks

- **RSK-001**: Future UI work must continue to call the scenario transaction helpers instead of shadowing tower state in presentation.
- **RSK-002**: If later tower types need true moving collision projectiles or summons, the bounded effect carrier may need to graduate into a fuller shared attack primitive.

## Alternatives Considered

### Off-the-shelf tower-defense library

- **ALT-001**: **Description**: Add a tower-defense placement/targeting library and adapt its runtime model to Crawler.
- **ALT-002**: **Rejection Reason**: Existing libraries do not share Crawler's bitecs stores, deterministic seeded simulation, FloorMap LOS, or no-route-mutation constraints.

### UI-owned construction state

- **ALT-003**: **Description**: Let a future UI panel track build-site occupancy and send tower attack/upgrade choices.
- **ALT-004**: **Rejection Reason**: The issue explicitly forbids UI state ownership; headless replay also needs the same transaction surface without presentation code.

### Collision-driven projectile towers first

- **ALT-005**: **Description**: Spawn normal damaging projectile entities for every tower shot and let collision systems handle hits.
- **ALT-006**: **Rejection Reason**: This would add moving-entity collision ordering and duplicate-hit cleanup risk before visuals require it; direct `applyDamage` plus bounded effect carriers satisfies Slice 5's deterministic combat and teardown gate with less surface area.

# ADR: Rat monarch + spawner appearance hookup and brute visual treatment

## Status

Accepted

## Date

2026-07-07

## Estimated Complexity

🍎 x 2 - small cross-layer rendering/data hookup with targeted tests.

## Context

Spawner-emitted rat monarchs (`rat-king`, `rat-queen`) had generated art available in
the manifest but were not mapped through appearance-key lookup, so they rendered as
generic rat visuals. Static spawner structures also did not carry stable appearance
keys, preventing dedicated spawner brief lookup when present.

Separately, design required Rat Brute to read as a larger, heavier rat variant:
exactly 25% larger sprite footprint and a darker grey visual treatment.

## Decision

1. Extend appearance-key -> generated-brief mapping to include:
   - `rat-king -> rat-king-v1`
   - `rat-queen -> rat-queen-v1`
   - `rat-brute -> rat-v1`
   - `rats-nest -> rats-nest-v1`
   - `slime-pool -> slime-pool-v1`
2. Assign appearance keys to static spawned spawner entities in `floorScenario`
   using archetype id (`rats-nest` / `slime-pool`).
3. Introduce renderer tint policy helper for enemies:
   - placeholder spawner red remains highest priority,
   - Rat Brute gets darker grey multiply tint,
   - all other living enemies are un-tinted.
4. Set Rat Brute sprite dimensions to exactly 1.25x baseline rat
   (`1.875ft` vs `1.5ft`).
5. Add/adjust unit and game tests to lock mapping coverage, tint precedence,
   and brute size ratio.

## Consequences

### Positive

- Rat monarchs now resolve to their dedicated generated art when present.
- Spawner entities are now wired for dedicated spawner briefs, enabling automatic
  art pickup as soon as those briefs land in the manifest.
- Rat Brute visual identity is clearer and deterministic.
- Tint precedence is explicit and test-covered.

### Negative

- Additional render-identity branches increase mapping surface to maintain when
  new enemy/spawner appearance keys are introduced.

### Risks

- If an appearance key is renamed in spawn logic without updating mapping, it
  silently falls back to generic texture resolution.
- `rats-nest-v1` currently absent from manifest, so rats-nest still renders via
  fallback path until that art entry lands.

## Alternatives Considered

- Use only textureId-derived variant routing (rejected: cannot distinguish
  rat monarch/brute/spawner identities sharing rat textureId).
- Hardcode brute tint directly in `PhaserBridge` switch logic (rejected: central
  helper keeps tint policy deterministic and testable).

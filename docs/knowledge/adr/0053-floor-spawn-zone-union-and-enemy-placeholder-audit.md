# ADR 0053: Floor-agnostic spawn-zone union and enemy-art placeholder auditing

## Status

Accepted

## Date

2026-07-08

## Estimated Complexity

🍎 x 2 — extends existing floor spawn selection and sprite-audit plumbing with no new runtime subsystem.

## Context

Floor 2 needed broader mob variety and weighted family spawning, but spawn-zone contributions already came from multiple systems (family territories, quadrant zones, and global fallback). The prior flow did not expose a generic, reusable "union all in-scope zones, normalize, then pick" mechanism that could be shared by all floors.

At the same time, newly added Floor 2 archetypes could render via fallback/reused art mappings, but were not explicitly visible in placeholder-audit output as "needs dedicated generated art." Existing placeholder auditing focused on manifest, sprite-registry notes, and mob-def placeholder ids.

## Decision

1. Add a shared spawn-zone utility (`src/game/spawn-zones.ts`) that merges all in-scope zone weights, normalizes the union, and performs deterministic weighted selection.
2. Use that same utility in both floor scenarios:
   - Floor 2: union family territory + quadrant + global zone contributions.
   - Floor 1: same code path with a single global zone.
3. Expand Floor 2 roster config so each family has one boss, one elite, one ranged basic, and one melee basic with non-boss split 1% / 25% / 74%.
4. Extend placeholder audit to track enemy-pack archetype ids as placeholder-needed when no dedicated real generated asset exists for that archetype concept, and feed floor1/floor2 pack ids into the CLI.

## Consequences

### Positive

- Spawn-zone aggregation behavior is now generic and reusable across floors.
- Floor 2 family ambient spawning respects the requested elite/melee/ranged distribution per family territory.
- Placeholder-audit now surfaces newly added mobs that still need dedicated art generation.

### Negative

- Placeholder-audit output can grow significantly because enemy archetypes are now included in placeholder-only reporting when dedicated art is missing.

### Risks

- If an archetype id and generated brief naming diverge unintentionally, audit could report a false "missing-generated-art" placeholder until naming is aligned.
- Additional spawn-zone contributors in future floors must keep deterministic weighting semantics consistent with this shared utility.

## Alternatives Considered

- Keep floor-specific selection logic and duplicate union/normalization per floor (rejected: drift risk and inconsistent behavior).
- Keep placeholder tracking limited to manifest/sprite-registry/mob-def sources (rejected: new enemy archetypes with fallback art remain invisible to art backlog workflows).

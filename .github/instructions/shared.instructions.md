---
applyTo: 'src/shared/**'
---

# Shared Layer Instructions

The dependency-free base of the codebase: constants, types, pure utilities, and
data-driven definition tables. Every other layer imports from here, so this layer
must stay at the bottom of the dependency graph.

## Rules

- Do NOT import from `src/core/`, `src/engine/`, `src/game/`, or `src/labs/` —
  `src/shared/` is the leaf layer that those layers depend on
- No Phaser, no bitecs world mutation — keep everything here pure data + pure
  functions so it is portable and trivially testable
- All randomness flows through `SeededRandom` in `src/shared/random.ts` — never
  `Math.random()`
- Spatial values are in **feet**; conversion helpers live in `src/shared/units.ts`
  (ADR `docs/knowledge/adr/0023-feet-as-single-internal-spatial-unit.md`)
- Data-driven defs are plain TS objects/tables, e.g. `src/shared/weaponDefs.ts`,
  `src/shared/mobDefs.ts`, `src/shared/equipmentDefs.ts`, `src/shared/loot-tables.ts`,
  and bulk data under `src/shared/data/`
- Tunable constants live in `src/shared/constants.ts`; the public surface is
  re-exported from `src/shared/index.ts`
- Pure functions (stat math, XP curves, unit conversions) need unit tests in
  `tests/unit/`
- **Declare apple complexity** before starting: 🍎–🍎🍎🍎🍎🍎 per `docs/agent-os/policies/complexity-policy.md`

## Pattern

```typescript
// Pure, deterministic, layer-free:
import { SeededRandom } from 'src/shared/random';
const rng = new SeededRandom(42);
const roll = rng.next(); // never Math.random()
```

> The single source of truth for stat keys/values is `src/shared/stats.ts`
> (see `.specify/specs/stats-skills-levels.md`). See `docs/README.md` for the
> governance source-of-truth registry.

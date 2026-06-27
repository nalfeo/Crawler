---
applyTo: 'tests/**'
---

# Tests Layer Instructions

Deterministic, seed-driven tests across the suite taxonomy below. CI gates are
scripts with exit codes — keep tests reproducible and fast.

## Rules

- Build worlds with `createTestWorld()` from `tests/helpers/world-factory.ts` —
  NEVER construct a world manually
- Determinism is mandatory: seed with `42` by convention, and never use
  `Math.random()` or wall-clock time when exercising the sim (use `SeededRandom`
  from `src/shared/random.ts` and pass `delta`/`frameCount`)
- Shared setup lives in `tests/setup.ts`; reusable fixtures in `tests/fixtures/`
- Every `src/core/` system needs coverage in `tests/ecs/`; make a best-effort
  improvement to coverage in any area you touch
- Use property-based tests (`fast-check`) in `tests/property/` for game
  invariants (e.g. damage never goes negative, totals conserve)
- **Declare apple complexity** before starting: 🍎–🍎🍎🍎🍎🍎 per `docs/agent-os/policies/complexity-policy.md`

## Suite taxonomy

| Directory            | Purpose                                            | Command                    |
| -------------------- | -------------------------------------------------- | -------------------------- |
| `tests/unit/`        | Pure functions (stat math, XP curves, loot tables) | `npm test`                 |
| `tests/ecs/`         | Single ECS systems via `createTestWorld()`         | `npm test`                 |
| `tests/integration/` | Multi-system pipelines                             | `npm run test:integration` |
| `tests/property/`    | `fast-check` invariants                            | `npm test`                 |
| `tests/determinism/` | Replay / seed-stability checks                     | `npm test`                 |
| `tests/e2e/`         | Visual / end-to-end                                | `npm run test:e2e`         |
| `tests/bench/`       | Performance baselines                              | see `package.json`         |

## Pattern

```typescript
import { createTestWorld } from '../helpers/world-factory';
const world = createTestWorld({ seed: 42 });
// add entities, run the system under test, assert on world.stores
```

> Coverage thresholds and CI gates are defined in `vitest.config.ts` and
> `docs/agent-os/policies/ci-policy.md`. See `docs/README.md` for the governance
> source-of-truth registry.

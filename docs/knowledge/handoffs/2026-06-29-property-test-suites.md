# Session Handoff: Property-based test suites for pure game logic

## Date

2026-06-29

## Persona(s) adopted

QA/Tester — the task is purely additive test authoring (raise unit-test coverage
with fast-check property suites), which is squarely the tester's lane.

## Routing verdict

✅ right persona — no production behaviour change was intended, so a testing
specialist was the correct fit.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — six mechanical-but-careful property suites; the only wrinkle
was diagnosing a float-precision counterexample (not a bug), which stayed within
the 2-apple envelope.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

Workstream A of the refactor/cleanup fan-out. Added six **fast-check**
property-based suites under `tests/property/` for pure game logic that lacked
them. Purely additive — **no production code changed**.

- `xp-math-properties.test.ts` — threshold/required non-negativity, the
  cumulative-sum identity `required(n+1) − required(n) === threshold(n)`,
  `levelForXp` monotonicity + boundary round-trips, and 0/1000 clamps.
- `loot-tables-properties.test.ts` — `rollEntry` quantity bounds `[min,max]`/≥1,
  `chance ≤ 0 ⇒ null`, SeededRandom determinism; `rollLootTable` subset +
  determinism; `resolveLootTables` order-preserving concatenation that skips
  undefined layers.
- `combat-rolls-properties.test.ts` — `resolveCrit` crit predicate, "multiplier
  ≥ 1 never lowers" / "≤ 0 treated as 1×", purity; `resolveDodge` truth table.
- `apply-damage-properties.test.ts` — via `createTestWorld()`: dealt ≥ 0, HP
  floors at 0, exact `after = before − dealt`, non-finite/≤0 no-ops, Invincible
  immunity, single-event-on-hit.
- `flow-field-properties.test.ts` — SeededRandom-driven random maps: distances
  are `FLOW_UNREACHABLE` or ≥ 0, goal = 0, adjacent reachable tiles differ ≤ 1,
  `flowFieldStep` is strictly downhill for every reachable non-goal tile,
  unreachable ⇒ null, gradient descent terminates exactly at the goal, and
  rebuild determinism.
- `inventory-properties.test.ts` — add/remove inverse, stack conservation
  (slot-sum = count, `0 < qty ≤ maxStack`), capacity invariant, `removeItem`
  returns `min(requested, available)`, `hasItem` ↔ `getItemCount`.

37 new property tests, all green.

## What's Next

- Sibling workstreams B (spawners-split) and C (bt-ai-provider extraction) are
  independent; no coordination needed.
- Natural follow-on coverage candidates with similar pure-function shape:
  `src/shared/stats.ts` derived-stat formulas, crafting/recipe resolution, and
  map `grid-utils`/`pathfinding` cost helpers.

## Blockers

None.

## Branch State

- Branch: `nalfeo-property-test-suites`
- All tests passing: yes (`npm run verify` — full suite + build green)
- PR created: yes (auto-merge armed, squash)

## Agent-OS Telemetry

No `files/guard-telemetry.jsonl` present this session — nothing to paste.

## Test Results

`npm run verify` — full suite green:

- Typecheck + lint + format: pass
- Unit: 2601 passed (227 files), includes the 37 new property tests
- Integration: 49 passed / 1 skipped
- Headless Floor 1 completion gate: 17 passed
- Build: success

## Key Decisions Made

- **Placed suites in `tests/property/`** per the suite taxonomy in
  `.github/instructions/tests.instructions.md`, complementing (not duplicating)
  the existing `tests/property/stats-properties.test.ts` XP checks.
- **Bounded the XP cumulative-identity property to level ≤ 200.** A counterexample
  at level ~266 was IEEE-754 imprecision once XP exceeds `Number.MAX_SAFE_INTEGER`
  (the exponential curve crosses 2^53 around level ~232), **not** a production
  bug — realistic play tops out near level 6. Kept the assertion exact and added
  a `Number.MAX_SAFE_INTEGER` precondition guard rather than weakening it.
- **All randomness via `SeededRandom`** (loot rolls, flow-field map layouts); no
  `Math.random`/`Date.now`; every suite is deterministic.

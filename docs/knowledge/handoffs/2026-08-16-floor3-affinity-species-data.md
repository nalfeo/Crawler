# Session Handoff: Floor 3 slice 1 — affinity matrix + species/style data

## Date

2026-08-16

## Persona

Content Designer → Systems Engineer (data-layer authoring)

## Systems touched

enemies, ai-behavior-tree

## Apples

2🍎 exact

## What Was Done

Implemented **slice 1 of the Floor 3 epic** (`.specify/specs/floor3-companion-league.md`
§Epic decomposition) — the pure data/lookup foundation every later Floor 3 slice builds on.
This slice is data + pure functions only; it adds no ECS system and no runtime wiring, so
there is nothing to observe in a running artifact yet (rule #9 applies from slice 3 onward,
when the first `*System` lands).

- `src/shared/data/floor3/affinity.ts` — the 7 Temperaments as a ring (`AFFINITY_RING`), the
  fully-populated `AFFINITY_MATRIX` derived from the ring, `affinityMultiplier()`,
  `strongAgainst()`, `predatorsOf()`, and an `isAffinity()` guard.
- `src/shared/data/floor3/styles.ts` — `FIGHTING_STYLES`, the `StylePersona` registry
  (`aiType`, `rangeProfile`, `cadence`, hp/dmg/speed bands, optional `aoeShape`) and the
  `STAT_BAND_SCALE` band→multiplier table.
- `src/shared/data/floor3/species.json` + `species.ts` — the full 52-species roster
  (49 grid + 3 signature) × 3 forms transcribed from
  `docs/knowledge/game-design/floor3-pet-roster.md`, loaded through a Zod schema following the
  `data/families.ts` / `data/resources.ts` pattern, with `getPetSpecies`,
  `petSpeciesByAffinity`, `petSpeciesByStyle`, `formForLevel`, and `learnedAbilityIds`.
- `tests/unit/floor3-affinity-matrix.test.ts` + `tests/unit/floor3-species-roster.test.ts` —
  19 tests: the 2-regular row/column property, antisymmetry, self-neutrality, the authored
  per-affinity summary, persona coverage/bounded net-new persona count, 7×7 grid coverage with
  no dead cells, unique form names and ability ids, and the L10/L25 evolution + L1/8/16/25/34
  ability milestones.

`npm run typecheck`, `eslint`, `prettier`, and `scripts/agent/verify-fast.sh` are green
(2259 tests).

## Key Decisions Made

- **The matrix is derived, not transcribed.** `AFFINITY_MATRIX` is generated from
  `AFFINITY_RING` (beat the next two, resist the previous two), so the 2-regular property is
  structurally guaranteed rather than a hand-typed 49-cell table that can drift. The unit test
  still pins it against the doc's per-affinity summary so a ring reorder is caught.
- **Persona `aiType` is a string key, not the game-layer `AI_TYPE` enum.** `src/shared/` must
  not import from `src/game/`, so the registry names `'GUARDIAN'`/`'SUPPORT'` as strings; slice
  4 maps them onto the real enum when it adds those personas.
- **Ability ids are structural (`f3.<speciesId>.l<level>`), names are content.** Ability
  _definitions_ are a later slice; species data carries stable ids plus the roster doc's
  `innateAbilityName`/`adultSignatureAbilityName` flavor pair so nothing keys off a display name.
- **Signature species stay off-grid.** The loader's coverage check ignores `signature: true`
  entries so the 7×7 "no dead cells" invariant remains exactly 49 cells.
- Stat bands and `statScale` (1 / 1.6 / 2.4) are **initial authored values**; slice 16 (balance
  - win-rate gate) owns the real numbers.

## What's Next / Blockers

Next slice per the spec is **slice 2 — the affinity damage multiplier hook** in the
`apply-damage` path (deps: slice 1, now landed), followed by slice 3 (`Companion`/`PartySlot`
components + ally-AI generalization), which unblocks most of the rest of the epic. No blockers.

## Retrospective

### Lessons Learned

- `noUncheckedIndexedAccess` is on: index-based `for` loops over `as const` tuples fail
  typecheck. Prefer `Array.prototype.forEach` with the element bound, or narrow the element
  explicitly — writing the matrix builder with numeric indexing cost one typecheck round-trip.
- The `data/families.ts` / `data/resources.ts` pair is the right template for any new bulk data
  module: JSON payload + Zod schema + cached loader + `_reset*Cache()` test seam. Copying it
  meant no new conventions had to be invented.
- Bulk content authored in a doc table is best transcribed with a throwaway generator script in
  `/tmp` (not committed) — hand-typing 52×3 names invites typos that no schema would catch.

### Mistakes Made

- The first matrix implementation indexed `AFFINITY_RING[i]` inside nested numeric loops and
  failed `npm run typecheck` with TS2538/TS2532. Early signal: any new loop over a `readonly`
  tuple in this repo should be assumed to need `forEach`/optional handling before running tsc.
- The same indexing mistake recurred in the `statScale` monotonicity refinement, i.e. it was
  fixed in one file and not the other in the same pass — when a typecheck error class appears,
  grep the whole new surface for it rather than fixing only the reported line.

### Opportunities for Future Improvement

- Slice 2 should consider whether `affinityMultiplier` belongs behind a floor-scoped hook in
  `apply-damage` (Floor 3 only) or a general per-entity affinity component, so Floor 4+ can
  re-host the kept companion (spec R7) without a second multiplier path.
- The roster doc and `species.json` are now two copies of the same 156 names. A cheap docs
  check that diffs the doc tables against the JSON would prevent drift as names get renamed for
  IP-safety.
- `learnedAbilityIds` returns ids for abilities that do not exist yet; once the Floor 3 ability
  catalog lands, add a cross-reference test asserting every milestone id resolves.

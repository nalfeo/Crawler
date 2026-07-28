# Handoff — Profiler Dependency-Frame Attribution

## Date

2026-07-26

## Systems touched

ci-policy

## Summary

`npm run perf:profile` now prints the **project-owned caller** beside every
`node_modules/**` frame (`compute … ← findTilePath (100%)`) and warns that
third-party function names are not self-describing. This closes the defect that
sent a full 4🍎 optimization pass at a 1.88% system.

Also fixes a pre-existing broken `npm run typecheck` on `main` (AGENTS.md rule 7).

## Files touched

- `scripts/agent/perf/profile-analyze-lib.ts`
- `tests/unit/profile-analyze-lib.test.ts`
- `.github/skills/perf-optimizer/SKILL.md`
- `tests/unit/ci-action-required-retrigger.test.ts` (unrelated pre-existing fix)

## The defect

PR #2042's hunt targeted a frame the profiler reported as **19.58% self /
21.75% total — `compute` @ `node_modules/rot-js/dist/rot.js:5356`**, read as
`RecursiveShadowcasting.compute` (FOV). **It is `AStar.compute`** (pathfinding).
`fovSystem` is **1.88%** of the run.

The output gave no way to tell. `rot-js` bundles FOV, pathfinding, mapgen and RNG
into one `dist/rot.js`, several of which expose a `compute` method. `SKILL.md`
step 3 made recording the _share_ a blocking gate but never required verifying
the frame's _identity_ — so the gate passed while the target was wrong.

## What changed

- **`FunctionCost.owners?: DependencyOwner[]`** — for `node_modules/**` frames
  only, the project-owned functions that called it, ranked by the self time
  reached through each. Computed by walking the ancestor chain from every
  self-time-bearing dependency node up to the nearest `src/`/`scripts/`/`tests/`
  frame (skipping intermediate dependency frames).
- **`mergeSummaries` sums owners** across the run panel, keyed identically to
  frames so a caller appearing in several runs folds into one entry. Owner
  identities are held in a separate `ownerMeta` map so merging cannot emit a
  phantom row for a caller with no cost of its own.
- **`formatSummary`** appends `← <dominant caller> (<pct>%[ +N more])` to
  dependency rows and prints a block warning that bare third-party names must not
  be used as targets.
- **`SKILL.md` step 3** now requires recording the target's _identity_ alongside
  its share, and gives three ways to establish it: read the `← caller`, falsify
  by **total% containment** (a 1.88% caller cannot contain a 22.66% frame), or
  open the dependency source at the printed line.

## Verification run

- `npm run perf:profile -- --top 8` on the real headless panel — before/after:
  - before: `19.58%  compute  node_modules/rot-js/dist/rot.js:5356`
  - after: `16.16%  compute  node_modules/rot-js/dist/rot.js:5356  ← findTilePath (100%)`
- `npx vitest run tests/unit/profile-analyze-lib.test.ts` — **39 passed**,
  including 9 new attribution tests
- `npm run verify:fast` ✅

The new tests genuinely discriminate: with the attribution removed, `owners` is
`undefined` and every assertion in the new block fails.

## Unrelated pre-existing fix

`npm run typecheck` was **broken on `main`** (TS2578 + TS7016 in
`tests/unit/ci-action-required-retrigger.test.ts`). The `@ts-expect-error` sat
above a multi-line import, but TS reports TS7016 at the module-specifier line, so
the directive covered the wrong line — simultaneously unused _and_ not
suppressing. Moved it inside the specifier list, directly above the `} from '…'`
line. Fixed rather than deferred per AGENTS.md rule 7.

## Unresolved issues / next leads

- **Next target is pathfinding**, now unambiguously identified:
  `findTilePath` → rot-js `AStar.compute`, **16.16% self / 19.02% total**, 100%
  owned by `findTilePath`. rot-js A\* uses `this._computed[x + "," + y]` string
  keys and `Array.shift()` as its open list — typed-array keys plus a binary heap
  are textbook wins.
- Owner attribution for `bitecs` frames resolves to `(anonymous) (6% +62 more)`,
  which is honest but weak. If bitecs ever becomes a target, the walk may need to
  keep climbing past anonymous project frames to the nearest _named_ one.

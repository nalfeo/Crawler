# Nightly perf collision clear optimization

## Date

2026-08-17

## Recovery note (added on republish)

This work was originally implemented on an abandoned session branch
(`copilot/fix-ai-runner-lab-transition`) that was never published as a PR. It
was recovered and rebased onto current `main` in a later session, found
during a repo-wide audit of 1,126 branches for work lost to interrupted
sessions. During rebase re-validation, the independent-grade stage (never
completed on the original branch) surfaced a real correctness bug: the fast
path's `if (stored <= 0) fallback` check does not catch `NaN` (every ordered
comparison with `NaN` is `false`), unlike `getBodyHalfWidth`/`getBodyHalfHeight`'s
`if (v > 0) return v` guard — a malformed NaN half-extent would have silently
poisoned the spatial grid instead of falling back. This was fixed to mirror
the helper's accept-check exactly, with a new regression test
(`tests/ecs/collision-system.test.ts`) confirmed to fail against the
unfixed code and pass against the fix. The RunStats fingerprint was
re-verified byte-identical after the correction (no real spawn hits this
edge case per `check:size-coverage`'s 0-shim-fallback guarantee).

## Persona

Systems Engineer / perf-optimizer

## Systems touched

weapons, enemies

## Apples

3 apples estimated, 3 apples actual (🎯 Exact). The pass required measurement-first target selection, a production hot-path change, full RunStats fingerprint proof, and review-ledger ceremony.

## Issue

Closes nalfeo/Crawler#3026.

## Summary

Ran the nightly gameplay-neutral perf pass against steady-state headless simulation CPU. The current profile showed prior nightly targets were no longer the best safe local wins; `collisionSystem` was the remaining localized candidate near the perf-optimizer threshold:

- before self-sorted profile: `collisionSystem` **1.83% self / 4.97% total**
- before total-sorted profile: `collisionSystem` **1.93% self / 5.07% total**

The landed change keeps collision semantics identical but removes two hot-path helper calls for the common valid-`Size` case. `collisionSystem` now reads the `Size` store once per entity and falls back to the existing `getBodyHalfWidth` / `getBodyHalfHeight` helpers only for malformed zero-size bodies, preserving the existing shim-warning behavior.

## Measurement

Before:

```bash
npm run perf:profile -- --top 30 --json /tmp/crawler-perf-3026/profile-before-self.json
npm run perf:profile -- --top 30 --sort total --json /tmp/crawler-perf-3026/profile-before-total.json
```

- `collisionSystem`: **1.83% self / 4.97% total** (self-sorted run)
- `collisionSystem`: **1.93% self / 5.07% total** (total-sorted run)

After:

```bash
npm run perf:profile -- --top 30 --json /tmp/crawler-perf-3026/profile-final-self.json
npm run perf:profile -- --top 30 --sort total --json /tmp/crawler-perf-3026/profile-final-total.json
```

- `collisionSystem`: **1.77% self / 4.72% total** (self-sorted run)
- `collisionSystem`: **1.73% self / 4.78% total** (total-sorted run)

Amdahl check:

```bash
npm run perf:profile -- --ceiling 5.07:1.061
```

- Max end-to-end win: **0.29%**, so this is a small targeted cleanup, not a broad frame-time shift.

The exploratory attempt to skip `pairKeys.clear()` in `SpatialHashGrid.clear()` did not produce reliable evidence and was reverted before final validation.

## Gameplay neutrality

Full covered RunStats gate sample was captured from the pre-change source by temporarily reverse-applying the source patch, then checked after reapplying the final patch:

```bash
npm run perf:fingerprint -- --write files/perf-3026-baseline.json
npm run perf:fingerprint -- --check files/perf-3026-baseline.json
```

Result:

- hash before: `adf744fc81fd2584170ed87bab63682ae25de40ff3d9d035378a707122c4372a`
- hash after: `adf744fc81fd2584170ed87bab63682ae25de40ff3d9d035378a707122c4372a`
- **RunStats identical**, byte-for-byte, across the full covered sample (rebased + corrected tree). The original 24-run proof from the abandoned branch was against a stale base and is superseded by this result.

## Verification

- `npx vitest run --project unit tests/unit/collision.test.ts tests/ecs/collision-system.test.ts tests/ecs/melee-broadphase-determinism.test.ts tests/ecs/beam-broadphase-determinism.test.ts --reporter=dot`
- `npx vitest run --project headless tests/headless/collision-pair-parity.test.ts --reporter=dot`
- `npm run perf:fingerprint -- --seeds 1-3 --weapons sword --check /tmp/crawler-perf-3026/fingerprint-before.json`
- `npm run perf:fingerprint -- --check files/perf-3026-baseline.json`
- `npm run format:check -- src/core/systems/collisionSystem.ts`
- `npm run verify:fast`

## Review

- Plan review: `gpt-5.4`, approved with two verification concerns; both adopted.
- Ledger: `docs/knowledge/review-ledgers/2026-08-17-nightly-perf-collision-clear.review-ledger.json`.

## Notes

- The full fingerprint was run locally to satisfy the issue's explicit byte-identical RunStats requirement for the accepted change. No broad sweep or benchmark sampling was dispatched locally.
- `files/perf-3026-baseline.json` is gitignored and should not be committed.

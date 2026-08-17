# Nightly perf collision clear optimization

## Date

2026-08-17

## Persona

Systems Engineer / perf-optimizer

## Systems touched

weapons, enemies, ci-policy

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

- hash before: `177bc84440c0ae4049b08e0e0eecf5caf6ad9e5396120ad29b579775d5c68598`
- hash after: `177bc84440c0ae4049b08e0e0eecf5caf6ad9e5396120ad29b579775d5c68598`
- **RunStats identical** across the full 24-run covered sample (seeds 1-8 × sword/bow/baseball-bat)

Narrow iteration sample also remained identical:

- hash: `ea8fe3b436faf9fbbac7cb60708f39287e17dcaf38397dc3dbd2ca58b7e15385`

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

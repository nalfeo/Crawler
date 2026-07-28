# Tighten the vendored edge-pass floor to 0.90

**Date:** 2026-07-28
**Apples:** 1🍎 (estimated 1🍎, actual 1🍎)
**Branch:** `nalfeo-tighten-vendored-edge-floor`

## Systems touched

sprite-pipeline

## What changed

`VENDORED_MIN_EDGE_PASS_RATE` in `scripts/sprites/terrain-packs/validate.ts`:
**0.85 → 0.90**, plus a rewritten doc comment and a regression test pinning the
shape of the residual failures.

This closes one of the three open questions left by PR #2189.

## Why

The 0.85 floor was calibrated when the caeles cell→mask table came from a greedy
search scored against the (then-degenerate) edge classifier, which measured
~0.93–0.94. PR #2189 deleted that search and replaced it with a table derived
from the artwork itself, cross-checked against the published cr31 layout.

Re-measured on current `main` (merge commit `3e9d303cc`):

| pack              | provenance | edge                | corner |
| ----------------- | ---------- | ------------------- | ------ |
| `industrial-cave` | authored   | 1.000 (188/188)     | 1.000  |
| `caeles-fixture`  | vendored   | **0.957** (180/188) | 1.000  |

So the old floor was leaving 20 samples of unnecessary slack.

## The residual 8 misses are one class, not noise

```
mask  1 (N stub)      N     expected=wall got=floor
mask  2 (E stub)      E
mask  4 (S stub)      S
mask  5 (N+S corridor) N, S
mask  8 (W stub)      W
mask 10 (E+W corridor) E, W
```

Perfectly symmetric — exactly two per compass direction, **all** `wall→floor`,
confined to masks `{1, 2, 4, 5, 8, 10}`: the four single-arm stubs plus the two
straight corridors. Hand-drawn line art draws a wall reached by one narrow arm
thin, so that edge band is mostly floor with a thin stroke through it, and the
mean-based classifier reads floor. Every corner (3/6/9/12), every T
(7/11/13/14), and 15 pass.

That is precisely the "real guide art won't hit 100%" fuzziness the relaxed
vendored floor exists to tolerate — inherent to the artwork, not a mapping
defect. Hence 0.90 rather than something closer to the measured 0.957: at 0.95
a single extra thinned arm would false-trip.

## Proved load-bearing, not cosmetic

Simulated a partially-regressed re-import by swapping k mask frame pairs
(leaving the 0 and 255 reference cells intact so the classifier stays sane):

```
1 swap: rate 0.957  0.85=pass  0.90=pass
2 swap: rate 0.936  0.85=pass  0.90=pass
3 swap: rate 0.926  0.85=pass  0.90=pass
4 swap: rate 0.894  0.85=pass  0.90=FAIL  <-- caught only by the tightened floor
5 swap: rate 0.883  0.85=pass  0.90=FAIL
6 swap: rate 0.851  0.85=pass  0.90=FAIL
```

A 4-to-6-pair regression passes at 0.85 and fails at 0.90. The change moves real
detection capability, it isn't just a tidier number.

## Regression test

`tests/unit/sprites/terrain-pack-build.test.ts` gains
`'the vendored fixture misses ONLY on the thin-arm masks, and only wall->floor'`,
which asserts the **shape** of the residue, not just its size:

- every miss is `wall→floor` (never the reverse);
- the distinct mask set is exactly `[1, 2, 4, 5, 8, 10]`;
- the per-compass-direction counts are all equal (the art has no directional bias);
- the total is exactly 8.

The point is that the next person who touches this floor does not have to
re-derive the analysis, and notices if the residue changes _character_ rather
than merely changing size — e.g. a `floor→wall` miss appearing, or a corner mask
joining the set, would mean something genuinely different broke.

## Caveat worth carrying forward

This check is **no longer the primary defence** against a scrambled cell→mask
assignment. `validateCompatibleCorners` (added in #2189) requires 1.0 for _both_
provenance kinds and is discrete rather than fuzzy, so it catches a bad mapping
harder and sooner. The edge floor is now a secondary signal. Don't over-invest
in tightening it further; if you want stronger guarantees for vendored packs,
the corner and exact-silhouette gates are the better lever.

## Validation

- `npx vitest run --project sprites tests/unit/sprites/terrain-pack-build.test.ts` — **53 passed**
- `npm run terrain-packs:validate` — `[caeles-fixture] OK`, `[industrial-cave] OK`
- `npm run verify:fast` — green

No art regenerated; no runtime/gameplay code touched. This is a validator
threshold plus its test, so there is no game artifact to observe — the
observable behavior is the gate's accept/reject boundary, which is measured
directly in the swap table above.

## Open questions still outstanding from #2189

- Whether the caeles spare should be cell 37 (current) or cell 13.
- Whether the `concave` r=48 corner bite is too deep visually (mask 15 reads as
  a plus-sign with large scoops). Single constant if it needs softening.

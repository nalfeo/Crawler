# Handoff — FOV Hot-Path Optimization (gameplay-neutral)

## Date

2026-07-25

## Systems touched

lighting, mapgen, ci-policy

## Summary

Made `fovSystem` **2.10× faster** on its own pass (median, wins 11/11 interleaved
rounds, worst round 1.32×) with **byte-identical** visibility/discovered output.
Gameplay neutrality is proven twice: 372/372 byte-identical replay states in the
committed differential bench, and a byte-identical headless `RunStats` fingerprint
across 8 seeds × 3 weapons.

**Honest end-to-end framing:** `fovSystem` is only **1.88% of headless sim time**,
so a 2.10× win is **~0.98% end-to-end — inside noise**. This PR is justified by the
per-pass speedup and the reusable-state pattern, **not** by an end-to-end claim.
See "Target misidentification" below — the headline share this hunt started from was
wrong, and that is the most valuable finding here.

## Files touched

- `src/core/systems/fovSystem.ts`
- `src/core/map/FloorMap.ts`
- `tests/ecs/fov-system.test.ts`
- `tests/ecs/fov-system-equivalence.test.ts` (new)
- `scripts/agent/perf/bench-fov.ts` (new)
- `docs/knowledge/review-ledgers/2026-07-25-fov-hot-path.review-ledger.json` (new)

## What changed

Four optimizations, all output-preserving:

1. **Per-map reusable state** in a module-level `WeakMap<FloorMap, FovPassState>`
   holding the rot-js `RecursiveShadowcasting` instance and both closures, so the
   per-frame pass allocates nothing. Mechanism name (required by hunting-grounds
   A3): **encapsulated non-escaping per-map scratch**. Protected by an `inUse`
   boolean reentrancy guard in a `try/finally`, placed immediately after the
   `WeakMap` lookup so a nested call cannot bypass it by changing `subFactor`.
2. **Seam memo `Map` → `Int32Array` generation stamps + `Uint8Array` values.**
   O(1) invalidation by bumping `generation`; wrap at `0x7fffffff` refills stamps.
   First live generation is 1, so an unwritten 0 stamp can never alias.
3. **`FloorMap.markVisibleAndDiscovered(hx, hy)`** fuses `setVisible` +
   `setDiscovered`, sharing the bounds check, sub-tile index, and tile index.
4. **Integer math** (`|0` instead of `Math.floor`) in `lightPasses`, with
   `flags` / `tileW` / `tileH` hoisted out of the callback.

### Ablation (is the risky shared state worth it?)

Measured 3-way in the committed bench:

| variant                       | paired ratio vs baseline |
| ----------------------------- | ------------------------ |
| stateless subset only (2,3,4) | 1.17× median             |
| + reusable state (1)          | 1.74× median over that   |
| **total**                     | **2.10× median**         |

The reusable state carries roughly half the win, so the added complexity earns
its keep. Only the **total** wins every round; the attribution split is
median-level evidence.

## Correctness hazards handled (read before touching this file)

- **`Math.floor(v/sf)` ≠ `(v/sf)|0` for negative `v`.** `Math.floor(-1/2) = -1`
  (→ index −1 → opaque) but `(-1/2)|0 = 0` (→ possibly transparent → **different
  visibility**). Shadowcasting does probe negative coordinates. Resolved by
  early-returning `false` when `hx < 0 || hy < 0`, before any `|0`.
- **`FloorMap.setSubFactor()` reallocates the visible/discovered bitmaps and does
  NOT bump `transparencyRevision`.** Any cache must therefore key on `subFactor`
  explicitly, not just on the revision. The state-rebuild guard does this.

## Verification run

- `npx tsx scripts/agent/perf/bench-fov.ts 400 11` — 2.10× median, wins 11/11
  rounds, worst round 1.32×, **372/372 states byte-identical** (lockstep
  byte-for-byte, not a hash)
- `npm run perf:fingerprint -- --check <baseline>` — **byte-identical `RunStats`**
  (8 seeds × 3 weapons) ✅
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate …` ✅ (4🍎: adversarial plan review +
  code-review loop + multi-model review, all clean)

## Target misidentification (the important finding)

This hunt was launched at a frame the profiler reported as **19.58% self /
21.75% total: `compute` @ `node_modules/rot-js/dist/rot.js:5356`**. I attributed
that to `RecursiveShadowcasting.compute` (FOV). **It is `AStar.compute`.**

Two independent proofs:

1. `rot.js:5339–5356` is inside `var AStar = function (_Path2)`.
2. Containment: `fovSystem` total is **1.88%**. A frame with 22.66% total cannot
   sit inside a 1.88% caller. It sits inside `findTilePath` (24.62% total).

**Root cause is a tooling gap, not just operator error.** `perf:profile` prints
bundled dependency frames by **bare name** with a `dist/rot.js:<line>` location.
`rot-js` owns FOV, pathfinding, mapgen _and_ RNG, so a bare `compute` there is
genuinely ambiguous. `SKILL.md` step 3 makes recording the _share_ a blocking
gate but never requires verifying the frame's _identity_.

**Recommended follow-up (not in this PR):** make any hot frame that resolves into
`node_modules/**` un-targetable until it is attributed to a project-owned caller
by total% containment — ideally by having `perf:profile` label such frames with
their nearest enclosing project function.

## Unresolved issues / next leads

- **The real target is pathfinding**: `findTilePath` **24.62% total**, rot-js
  `AStar.compute` **20.17% self**. rot-js A\* uses string-keyed objects
  (`this._computed[x + "," + y]`) and `Array.shift()` as its open list — both are
  textbook wins (typed-array keys + a binary heap). This is ~13× the FOV share.
- `bt-ai-geometry.hasClearLineOfSight` — **5.47% self**, #2 hot leaf.
- `flow-field.computeFlowField` — 4.17% self.

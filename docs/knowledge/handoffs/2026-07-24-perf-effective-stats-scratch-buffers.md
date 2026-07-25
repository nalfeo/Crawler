# Handoff: Reuse scratch buffers in `applyEffectiveStats` (steady-state combat frame time)

## Systems touched

weapons

## Summary

First real use of the perf-optimizer agent + skill introduced by PR #1958. Target
surface: **steady-state combat frame time**. Landed one gameplay-neutral change:
`applyEffectiveStats` in `src/core/effective-stats.ts` — called every frame by
`statSystem` for the player entity — now writes into module-level scratch buffers
instead of allocating fresh `Stats`/`Record<Stat, number>`/`Def[]`/`Set` per call.

Neutrality **proven** by `perf:fingerprint --check`: hash matches the 24-run
baseline byte-for-byte across all runs. Change is contained to a single file in
`src/core/`; no engine/game imports added; no `Math.random`/`Date.now`.

## Numbers

**Direct microbenchmark of `applyEffectiveStats`** (throwaway bench, 500k
iterations after 100k warmup, 5 runs, median reported):

| Variant                      | ns/call (median) | Range           |
| ---------------------------- | ---------------- | --------------- |
| Before (per-call allocation) | 16,229           | 15,407–18,441   |
| After (scratch-buffer reuse) | 3,598            | 3,435–3,891     |
| **Improvement**              | **~4.5× faster** | ranges disjoint |

Per-call reduction ≈ 77.8%. Ranges do not overlap; signal is unambiguous.

**End-to-end wall time** (`ai:winrate-sweep --seeds 1-8 --weapons sword
--skip-events --workers 1`, 3 runs each, median):

| Variant         | Wall time (s, median) | Range       |
| --------------- | --------------------- | ----------- |
| Before          | 94.8                  | 89.4–97.3   |
| After           | 92.7                  | 89.7–95.7   |
| **Improvement** | **~2.2%**             | overlapping |

End-to-end delta is at the edge of noise for an 8-seed × 1-weapon sweep (~5%
inherent per-run variance), which matches the theoretical share: `statSystem`
was profiled at ~3.4% of total wall time before the change, and a 78% per-call
reduction there predicts ~2.6% wall improvement. Reality delivered 2.2%. The
microbench confirms the win is real; end-to-end noise partially masks it.

**Neutrality gate:** `npm run perf:fingerprint -- --check files/perf-baseline.json`
passed with `RunStats identical: every run in the sample matches the baseline
byte-for-byte.` Baseline hash: `b311a7808b9e94cadd14d4733df332aee4560565f0a8fe3fb8528f3fe7c8e37e`.

**Observed in:** the headless simulation pipeline (`ai:winrate-sweep`, which
exercises `src/game/ai/simulation-step.ts` → `statSystem` → `applyEffectiveStats`
on every frame for the player). Not lab-only. Change also validated via
`npm run verify:fast` and 71/71 targeted unit tests in
`tests/ecs/effective-stats.test.ts`, `statSystem.test.ts`, `equipment.test.ts`,
`equipment.property.test.ts`.

## What changed

`src/core/effective-stats.ts`:

- Extracted `computeEffectiveStatsFromLoadoutInto(target, ...)` and
  `writeUniqueEquippedDefsInto(target, seen, ...)` — pure functions that write
  into caller-supplied output containers instead of allocating.
- Kept `computeEffectiveStatsFromLoadout` and `uniqueEquippedDefs` as thin
  allocating wrappers because `equipmentSystem.ts` (lines 1267/1291) needs
  **two** simultaneous snapshots when predicting equip deltas — scratch reuse
  would alias them.
- Added module-level scratch buffers `_scratchBase`, `_scratchCore`,
  `_scratchEff`, `_scratchDefs`, `_scratchSeen` above `applyEffectiveStats`.
- `applyEffectiveStats` now uses those scratch buffers exclusively. The
  per-frame hot path allocates **zero** fresh objects: the base `Stats`, core
  overlay, effective `Record<Stat, number>`, unique `Def[]`, and dedup `Set`
  are all reused across calls.

Reentrancy check: `statSystem`'s per-frame loop consumes the effective stats
inline before the next call; `equipmentSystem.recomputeEffectiveStats` is
event-driven and never nested inside another `applyEffectiveStats`. Not
concurrent (single sim thread). Verified by inspection of every call site.

## Tooling feedback for `perf-optimizer` skill / PR #1958

Reporting on open questions from `2026-07-25-perf-optimizer-agent.md`:

1. **Fingerprint baseline write time (24-run full gate sample):** ~80s on this
   machine. Not "several minutes" as the skill warns — closer to ~1.5 minutes.
   A `--check` pass under mild contention took ~125s. The skill's "start it
   early in the background" advice is still right (it's the slowest single
   command in the workflow), but the human-facing wording could be tightened
   to "1–3 minutes single-run" so agents don't over-parallelize on the wrong
   assumption.

2. **Skill workflow held up cleanly.** Baseline-first, per-system profile,
   pick one target, change one thing, prove neutrality, re-measure. No
   deviations needed. The hunting-grounds catalog steered the pick: A1
   (cached computation) was tempting for `enemyAISystem` but the file is
   2,045 lines and the risk-of-drift was high; A3 (allocation churn) inside
   a small pure-ish function was the safer first bet, and the fingerprint
   proved it.

3. **End-to-end wall-time measurement is noisy for small wins.** A ~2%
   wall-time delta on an 8-seed sweep is inside the per-run variance envelope
   (each seed runs to completion with different frame counts). A targeted
   microbenchmark of the changed function (called in a tight loop, warmed
   up) was necessary to disambiguate this specific win from noise. Suggest
   adding a "when to microbench" note to `measurement-recipes.md`: if the
   target function is <5% of surface wall time, expect wall-time delta to
   be inside noise even for a large per-call win — measure the call
   directly. (The bench script was throwaway; deleted before PR.)

## Follow-ups

- Same pattern likely applies to other per-frame functions in `src/core/systems/`
  that build fresh records/arrays; a follow-up sweep with a proper allocation
  profiler (not the wall-time profiler used here) could quantify remaining
  allocation churn per system per frame.
- `computeEffectiveStatsFromLoadout` (the allocating wrapper) is still used by
  `equipmentSystem` prediction paths. Those aren't hot per-frame, but if a
  future feature makes them hot (e.g. AI equipment autopickers), the same
  scratch pattern can be extended with paired scratch slots.

## Exact commands

```bash
# Neutrality baseline (unmodified tree, from PR #1958's tool)
npm run perf:fingerprint -- --write files/perf-baseline.json

# After change: neutrality check (must be clean)
npm run perf:fingerprint -- --check files/perf-baseline.json

# End-to-end wall time (3 runs each, before/after)
npx tsx scripts/agent/ai/winrate-sweep.ts --seeds 1-8 --weapons sword \
  --skip-events --workers 1

# Fast verify
npm run verify:fast
```

## Apple estimate

**2🍎** (single-file allocation-churn change, contained blast radius, proven
neutral). No review-harness stages required at 1–2🍎.

## Layer / rules compliance

- `src/core/` only; no engine/game/labs imports added.
- No `Math.random` / `Date.now` introduced.
- No new `*System` exports (no wiring guard impact).
- No tuning constants, balance, drop rates, AI decisions, or spawn counts
  touched. Purely internal reordering of how memory is allocated.

# Handoff: Reuse scratch buffers in `applyEffectiveStats` (steady-state combat frame time)

## Systems touched

weapons

## Summary

First real use of the perf-optimizer agent + skill introduced by PR #1958. Target
surface: **steady-state combat frame time**. Landed one gameplay-neutral change:
`applyEffectiveStats` in `src/core/effective-stats.ts` — called every frame by
`statSystem` for the player entity — now writes into module-level scratch buffers
instead of allocating a fresh `Stats`/`Record<Stat, number>`/`Def[]`/`Set` per
call. The safety of that scratch reuse is now enforced at runtime by a
non-reentrancy guard (throws with a clear message instead of silently aliasing
if a future refactor introduces a nested call).

Neutrality **proven** by `perf:fingerprint --check`: hash matches the 24-run
baseline byte-for-byte across all runs. Change is contained to `src/core/`;
no engine/game imports added; no `Math.random`/`Date.now`.

## Numbers

**Direct microbench of `applyEffectiveStats`** — committed at
`scripts/agent/perf/bench-effective-stats.ts` for repeat measurement. Uses an
**interleaved same-process A/B** shape (BEFORE and AFTER alternate round-by-
round in the same Node process) because cross-process ns/call on this codebase
has ~2.7× spread across runs — wider than most legitimate wins. Command:

```bash
npx tsx scripts/agent/perf/bench-effective-stats.ts 200000 9
```

9 rounds × 200k iterations after 50k+50k warmup:

| Variant               | ns/call median | Range         |
| --------------------- | -------------- | ------------- |
| BEFORE (allocating)   | 17,582         | 13,785–23,999 |
| AFTER (scratch reuse) | 5,759          | 5,071–7,216   |

- **Median speedup: 3.05×** (per-call cost cut by ~67%).
- **Distributions disjoint:** worst AFTER round (7,216 ns) faster than best
  BEFORE round (13,785 ns). No round overlap in either direction.
- An independent audit (auditor cross-session) rebuilt this bench from
  scratch on a different machine and measured **BEFORE 19,258 / AFTER 5,536 /
  3.48× median**, also disjoint. Direction and magnitude reproduce.

**End-to-end wall time** — `ai:winrate-sweep --seeds 1-8 --weapons sword
--skip-events --workers 1`, 3 runs each, medians 94.8s → 92.7s (~2.2%). This
is **inside noise** at n=3 on an 8-seed sweep (~5% inherent per-run variance,
ranges overlap significantly) and is NOT a defensible claim on its own. It is
reported here only for consistency with theory: `statSystem` was ~3.4% of
total wall time before the change × 67% per-call reduction ≈ 2.3% wall
improvement predicted, ~2.2% observed. Real wall-time verification of a win
this size would require a much larger sample (which would violate AGENTS.md
r15 — dispatch to CI instead).

**Neutrality gate:** `npm run perf:fingerprint -- --check files/perf-baseline.json`
passed: `RunStats identical: every run in the sample matches the baseline
byte-for-byte.` Baseline hash:
`b311a7808b9e94cadd14d4733df332aee4560565f0a8fe3fb8528f3fe7c8e37e`.

**Observed in:** the headless simulation pipeline (`ai:winrate-sweep`, which
exercises `src/game/ai/simulation-step.ts` → `statSystem` → `applyEffectiveStats`
every frame). Not lab-only. Also validated via `npm run verify:fast` and 9/9
targeted unit tests in `tests/ecs/effective-stats.test.ts` (7 pre-existing +
2 new for the reentrancy guard).

## What changed

`src/core/effective-stats.ts`:

- Extracted `computeEffectiveStatsFromLoadoutInto(target, ...)` and
  `writeUniqueEquippedDefsInto(target, seen, ...)` — pure functions that write
  into caller-supplied output containers instead of allocating.
- Kept `computeEffectiveStatsFromLoadout` and `uniqueEquippedDefs` as thin
  allocating wrappers because `equipmentSystem.ts` (lines 1267/1291) needs
  **two** simultaneous snapshots when predicting equip deltas — scratch reuse
  would alias them. Also used by `computeEquippedWeightLb`.
- Added module-level scratch buffers `_scratchBase`, `_scratchCore`,
  `_scratchEff`, `_scratchDefs`, `_scratchSeen` above `applyEffectiveStats`.
- `applyEffectiveStats` reuses five module-level scratch containers
  (`_scratchBase`, `_scratchCore`, `_scratchEff`, `_scratchDefs`,
  `_scratchSeen`) instead of allocating them fresh each call. Residual
  allocations that remain: one wrapper object per equipped item inside
  `writeUniqueEquippedDefsInto`, plus `Object.keys` (slot enumeration) and
  `Object.entries` (bonus iteration) arrays — these are acknowledged as
  follow-up leads in the Leads section below.
- **Non-reentrancy guard:** `_applyEffectiveStatsInUse` boolean gate around
  the body inside a `try/finally`. Throws with an actionable message if a
  future refactor adds a nested caller (the safety argument for scratch reuse
  otherwise lives only in a comment, which won't survive refactors). Overhead
  is 2 boolean writes per call vs a ~5.7us body — negligible; stays on in
  production.

`tests/ecs/effective-stats.test.ts` — added two guard tests:

- Simulated re-entry via an `activeModifiers` iterable that calls
  `applyEffectiveStats` mid-iteration → throws `/re-entrantly/`.
- Post-throw recovery: after an inner throw, the next call succeeds (the
  `finally` block resets the flag; no leak).

`scripts/agent/perf/bench-effective-stats.ts` — committed A/B bench. Reproduces
the pre-optimization shape by inlining an `applyEffectiveStatsAllocating`
variant (uses the still-exported allocating wrappers `uniqueEquippedDefs` and
`computeEffectiveStatsFromLoadout` plus fresh `base`/`core` records), then
interleaves both variants round-by-round in the same process.

## Follow-up leads (for a future perf session, NOT this PR)

Recorded here so the next perf-optimizer session has a warm scent trail:

1. **`applyEffectiveStats` is still ~5.7us/call for ~250 property ops
   (~22 ns/op).** Suspected dominant costs, in priority order:
   - Dictionary-mode object transitions from repeatedly building
     `{} as Record<StatId, number>` and adding keys one at a time. V8 keeps
     these objects in dictionary mode rather than promoting them to hidden
     classes with monomorphic property access. Pre-seeding each scratch record
     with every `StatId` set to `0` at module init (so subsequent iterations
     only overwrite existing slots) may promote them to monomorphic layout.
   - `clampStat` is called 6× per `StatId` × ~35 stats = ~210 dispatches per
     call; profile whether the clamp table lookup dominates.
   - `Object.entries(def.statBonuses)` and
     `Object.entries(CORE_STAT_TO_SECONDARY[p])` allocate on every call.
     Precomputing arrays of `[stat, bonus]` tuples on equipment def
     construction, and freezing `CORE_STAT_TO_SECONDARY` derivatives, would
     remove both.

2. **`statSystem` allocates every frame regardless of whether anything
   changed** — same allocation-churn class as this PR, one layer up:

   ```ts
   const activeModifiers = world.statModifiers.filter(
     (m) => m.expiresFrame === undefined || m.expiresFrame > frameCount,
   );
   ```

   `.filter()` allocates a fresh array unconditionally. Options: (a) mutate
   `world.statModifiers` in place with a two-pointer compact when the count
   changes, keeping the same reference; (b) split into a "dirty" flag set
   when a modifier is added/removed and skip the recompute when nothing
   changed. Either would remove one array allocation per frame.

3. `writeUniqueEquippedDefsInto` uses `Object.keys(equipmentState.equipped)`
   inside a per-frame hot path — the returned array is fresh every call.
   Iterating over a stable slot-id enumeration constant would remove it.

## Tooling feedback for `perf-optimizer` skill / PR #1958

Reporting on open questions from `2026-07-25-perf-optimizer-agent.md`:

1. **Fingerprint baseline write time (24-run full gate sample):** ~80s on this
   machine. Not "several minutes" as the skill warns — closer to ~1.5 minutes.
   A `--check` pass under mild contention took ~125s. Suggest tightening the
   human-facing wording to "1–3 minutes single-run" so agents don't
   over-parallelize on the wrong assumption.

2. **Skill workflow held up cleanly.** Baseline-first, per-system profile,
   pick one target, change one thing, prove neutrality, re-measure. No
   deviations needed. The hunting-grounds catalog steered the pick: A1
   (cached computation) was tempting for `enemyAISystem` but the file is
   2,045 lines and risk-of-drift was high; A3 (allocation churn) inside a
   small pure-ish function was the safer first bet, and the fingerprint
   proved it.

3. **Cross-process wall-time measurement lies for small wins.** My original
   AFTER/BEFORE was two separate process runs, showed 4.5× — the auditor
   caught this. Same-process interleaved runs show 3.05× on this machine
   and 3.48× on the auditor's — both correct, cross-process was noise.
   `measurement-recipes.md` should add: "When benching a function called
   many times per frame, use an interleaved same-process A/B (both variants
   present in the bench, alternating rounds). Cross-process `git stash`
   toggles are only trustworthy for surfaces that dominate the wall-time
   number itself."

4. **Commit the bench.** I deleted the throwaway bench that produced my
   original numbers, and the auditor had to rebuild it from scratch to
   validate the PR. Skill rule 4 already requires "the exact command that
   measures it" — but a bash command referencing a deleted file doesn't
   satisfy that. Suggest making it explicit: any microbench used as
   headline evidence must be committed under `scripts/agent/perf/` and
   referenced by path. The bench in this PR (`bench-effective-stats.ts`)
   follows that pattern and can serve as the template.

5. **Distinguish "at edge of noise" from "defensible win" in the framing.**
   My initial PR body headlined the ~2.2% end-to-end delta. It's real (it
   matches the theoretical share × per-call win) but the ranges overlap, so
   by the skill's own rule 5 it's inside noise as a standalone claim.
   Correct framing: headline the per-call number (defensible, disjoint
   distributions) and note the end-to-end contribution as
   consistent-with-theory rather than as the headline number. Skill should
   flag this pattern in the "Report" section.

## Exact commands

```bash
# Neutrality baseline (unmodified tree, from PR #1958's tool)
npm run perf:fingerprint -- --write files/perf-baseline.json

# After change: neutrality check (must be clean)
npm run perf:fingerprint -- --check files/perf-baseline.json

# Per-call microbench (interleaved same-process A/B)
npx tsx scripts/agent/perf/bench-effective-stats.ts 200000 9

# End-to-end wall time (small sample — inside noise, do NOT use as headline)
npx tsx scripts/agent/ai/winrate-sweep.ts --seeds 1-8 --weapons sword \
  --skip-events --workers 1

# Fast verify
npm run verify:fast
```

## Apple estimate

**2🍎** (single-file allocation-churn change, contained blast radius, proven
neutral, guard test added). No review-harness stages required at 1–2🍎;
however this session ran through an independent audit anyway (cross-session
from the parent perf-optimizer PR #1958), which caught two framing/hygiene
issues (cross-process bench noise, deleted bench file) — folded in above.

## Layer / rules compliance

- `src/core/` only; no engine/game/labs imports added.
- Bench script lives in `scripts/agent/perf/` and imports through `src/core/`
  as tests do — no layer violation.
- No `Math.random` / `Date.now` introduced (bench uses `process.hrtime.bigint()`,
  which is not sim code).
- No new `*System` exports (no wiring guard impact).
- No tuning constants, balance, drop rates, AI decisions, or spawn counts
  touched. Purely internal reordering of how memory is allocated.

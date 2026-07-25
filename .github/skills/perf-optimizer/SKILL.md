---
name: perf-optimizer
description: Find and land gameplay-neutral resource optimizations in Crawler — faster frames, faster loads, less wasted work, with byte-identical covered `RunStats`. Use when asked to "make the game run faster", "cut load time", "find where we're wasting time", "profile the runtime", "fix frame-time spikes", "shrink the bundle", "reduce GC pressure", or "hunt a perf regression". Covers measuring first, the hunting-grounds catalog of where waste hides in this codebase, and the mandatory RunStats fingerprint neutrality check before PR.
---

# Perf Optimizer

Make Crawler faster by **deleting work that never needed to happen** — never by
changing what the game does.

## The contract

Every change you land must satisfy both halves:

| Half               | Evidence                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| It's faster        | A before/after number on a named metric, from a repeatable command                  |
| It's the same game | Test suite green **AND** a clean `perf:fingerprint --check` on the full gate sample |

Missing either half means the work is not done. There is no "probably fine".

**Know the limits of the neutrality check.** The fingerprint hashes end-of-run
`RunStats` for the covered runs. Clean means every covered run reported identical
results — in practice a very strong signal that the RNG stream and the simulation
are untouched, since almost any divergence moves at least one field. But it is not
a full world-state trace, and the headless pipeline exercises **no** rendering,
asset loading, input, or browser behavior. For **render or load** changes the
fingerprint is close to vacuous: it never ran that code. Those need a
surface-specific observation as well (see step 6).

The "test suite green" half is satisfied by **CI's** run. Per AGENTS.md, CI owns
the full suite — run it locally only when diagnosing or when the human asks.

## Workflow

### 1. Scope to one surface

Ask the human which surface if it isn't stated. Never start a blind repo-wide
profile — it produces a pile of 0.3% findings and no landed win.

Valid surfaces: boot/first-frame, floor load & scene transition, steady-state
combat frame time, pathfinding, broadphase/collision, rendering submission,
memory growth over a long session.

### 2. Record the neutrality baseline FIRST

Do this on the **unmodified** tree, before you touch a line:

```bash
npm run perf:fingerprint -- --write files/perf-baseline.json
```

This replays the same sample the blocking Floor-1 gate uses (seeds 1–8 ×
sword/bow/baseball-bat) and hashes the full `RunStats` of every run with
wall-clock fields stripped. Budget **1–3 minutes** (~80s on an idle machine;
~2 minutes under load). Start it early.

While iterating you can narrow the sample for a fast signal:

```bash
npm run perf:fingerprint -- --seeds 1-2 --weapons sword --write files/quick.json
```

A narrowed sample is **local iteration only** — the tool labels it as such, refuses
to compare it against a full-gate baseline, and it never satisfies the PR gate.

> **Execution policy for the 24-run sample.** AGENTS.md r15 defaults any >10-run
> workload to GitHub infrastructure. Run the full 24-run baseline/check on
> GitHub-backed execution by default; only run it locally when a human explicitly
> asks. If you want a wider seed range, that remains a sweep — dispatch
> `ai-sweep.yml`.

### 3. Measure the cost you intend to remove

See `references/measurement-recipes.md` for the exact commands per surface. The
rule: you must be able to point at a number and say "this is the waste". If you
cannot measure it, you cannot claim you removed it.

Reject targets whose measured share of the surface's total cost is small enough
that a perfect fix is inside noise. Write down the share before optimizing.

### 4. Find the waste

`references/hunting-grounds.md` catalogs where waste actually hides in this
codebase and which patterns are gameplay-safe to remove. Start there rather than
guessing. The recurring shapes:

- work repeated every frame that only changes on an event
- results recomputed instead of cached (this repo has already been bitten hard —
  see the `resolveReachableGoalTile` ~30x regression)
- allocation in hot loops creating GC pressure
- eager work on the load critical path that could be lazy or parallel
- broad scans where a spatial/indexed narrow phase would do
- assets decoded or parsed that the current scene never uses

### 5. Change one thing

One optimization per PR where practical. Bundled changes make it impossible to
attribute either the win or a later regression.

### 6. Check both halves

```bash
npm run perf:fingerprint -- --check files/perf-baseline.json   # RunStats unchanged
npm run verify:fast                                            # fast gates
```

The full suite is CI's job — don't burn local minutes on `npm test` unless you are
diagnosing a specific failure.

**If your change touched rendering, asset loading, scene setup, or the boot path,
the fingerprint did not cover it.** Add the matching observation and name it in the
PR:

| Change touches            | Additional observation                                           |
| ------------------------- | ---------------------------------------------------------------- |
| rendering / HUD / sprites | `npm run review:visual`, or an e2e `ui-probe`/pixel assertion    |
| boot / asset load         | first-frame or load-time measurement (see recipes), before/after |
| scene & floor transitions | e2e transition test plus the load measurement                    |

Re-run your measurement from step 3 and record the before/after.

**If the fingerprint reports drift, your change altered gameplay.** Read the
reported field paths — the tool names the exact divergent `RunStats` fields and
runs. Fix the change. **Never** regenerate the baseline to make drift disappear;
that falsifies the check and violates AGENTS.md r11.

(A _sample mismatch_ is different and is not a gameplay finding — it means you
checked a narrowed run against a full-gate baseline. Re-run with the same
`--seeds`/`--weapons`/`--max-frames`.)

### 7. Report

State, in the PR and handoff:

- metric, before → after, units, and sample size
- the exact command that measures it
- fingerprint hash and that the check was clean on the **full** gate sample

## Gameplay-neutral vs. not — the line

Neutral (yours):

- caching a pure function's result, keyed correctly
- hoisting an invariant out of a loop
- replacing an O(n²) scan with a spatial index that returns the **same set**
- reusing buffers/objects instead of allocating per frame
- deferring/lazy-loading an asset the current scene doesn't use
- removing a redundant second pass over the same data
- reordering independent work that has no observable ordering effect

**Not neutral (hand off, do not land):**

- changing tick rate, simulation step, or update frequency of a gameplay system
- culling entities, shortening ranges, or capping counts
- swapping an algorithm for one that returns a _different_ result (e.g. a
  cheaper pathfinder that picks a different tile)
- reordering ECS systems where ordering is observable
- touching any tuning constant
- changing RNG draw count, order, or which stream is consumed

The last one is the sneakiest. **Any** change to how many times a `SeededRandom`
is drawn, or in what order, shifts the entire downstream stream and changes the
run. The fingerprint catches it — which is exactly why the fingerprint is
mandatory and not advisory.

## Hard rules

- Never `Math.random()` / `Date.now()` (AGENTS.md r3, r4) — including in anything
  you add for caching or instrumentation.
- Layer rules still apply: `src/core/` must not import `src/engine/`.
- Any new `*System` must be wired or allowlisted (`npm run check:wired-systems`).
- Observe before done (r9): name the **real** artifact — the running game or a
  headless/pipeline measurement. A lab measurement alone does not prove a
  runtime win.
- Never weaken a requirement or a gate to go green (r11). Escalate instead.

## References

- `references/hunting-grounds.md` — where waste hides in this codebase
- `references/measurement-recipes.md` — exact commands per surface

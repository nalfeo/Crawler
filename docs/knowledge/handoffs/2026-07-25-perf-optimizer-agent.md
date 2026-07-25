# Handoff: Perf Optimizer agent + gameplay-fingerprint neutrality gate

**Date:** 2026-07-25
**Persona:** DevOps Engineer (agent/skill tooling)
**Apples:** 3 estimated, 3 actual (tooling-only cap)

## Systems touched

agent-tooling, ci-automation

## Outcome

Crawler now has a dedicated **Perf Optimizer** agent whose entire job is finding
resource waste — slow frames, slow loads, wasted work — **without touching
gameplay**. The hard problem with that persona is not finding optimizations; it
is proving an optimization did not quietly change the game. A reordered system,
an extra `SeededRandom` draw, or a cheaper pathfinder that picks a different
tile all shift the whole downstream simulation while the unit suite stays green.

So the agent ships with a deterministic proof mechanism rather than a promise.
`npm run perf:fingerprint` replays the exact sample the blocking Floor-1 headless
gate already requires (seeds 1–8 × sword/bow/baseball-bat) and hashes the full
`RunStats` of every run with wall-clock fields stripped — wall time being the only
thing an optimization is _supposed_ to change. Identical hash ⇒ identical RNG
stream, spawns, damage, quest progression, and outcome.

The agent's PR gate is: **full suite green AND a clean fingerprint check on the
full gate sample.** Neither alone is sufficient. Regenerating the baseline to
make drift disappear is explicitly called out as falsifying the proof
(AGENTS.md r11).

## What changed

- **New** `scripts/agent/perf/sim-fingerprint-lib.ts` — pure, unit-testable
  canonicalize/hash/diff helpers.
  - `canonicalize()` sorts object keys (so property insertion order can't affect
    the hash), preserves array order (event sequences are simulation-meaningful),
    normalizes `-0` → `0` and sparse holes → `null`, and drops wall-clock keys at
    any depth via a precise `^wall([_-]?clock)?time(ms|sec|s)?$` pattern — chosen
    over a loose `/wall/` substring so a genuinely deterministic field like
    `wallHits` is never silently excluded from the proof.
  - `buildFingerprint()` normalizes run ordering (parallel and sequential sweeps
    agree) and throws on duplicate `weapon:seed` pairs rather than collapsing them.
  - `compareFingerprints()` reports the exact divergent `RunStats` field paths per
    run, plus `missing`/`added` runs. A schema-version mismatch is always reported
    as drift so a stale baseline can never be silently trusted.
- **New** `scripts/agent/perf/sim-fingerprint.ts` — the CLI (`perf:fingerprint`),
  `--write <file>` / `--check <file>` (mutually exclusive, one required). Mirrors
  the gate sample constants from `tests/headless/floor1-completion.test.ts` and
  reuses the existing `worker-pool.ts` + `tsx-worker-hooks.mjs` pattern from
  `winrate-sweep.ts`. `--seeds` / `--weapons` can narrow the sample for fast local
  iteration; the tool then loudly labels the result as NOT valid for the PR gate.
  `--check` exits 1 on drift.
- **New** `tests/unit/sim-fingerprint-lib.test.ts` — 17 tests covering key-order
  stability, wall-clock stripping, the `wallHits` false-positive guard, array-order
  preservation, `-0` normalization, duplicate-run rejection, exact drift field
  paths, missing/added runs, version-mismatch handling, and report truncation.
- **New** `.github/agents/perf-optimizer.agent.md` — the agent. Defines the
  gameplay-neutrality contract, in/out of scope (explicitly excludes dev/CI loop
  speed and any "do less game" trade-off), and the requirement to report wins as
  measured numbers.
- **New** `.github/skills/perf-optimizer/SKILL.md` + two references:
  - `references/hunting-grounds.md` — where waste actually hides in this codebase,
    grounded in real history (the ~30x `resolveReachableGoalTile` regression, the
    existing melee/beam broadphase parity gates), with a neutral-vs-not table.
  - `references/measurement-recipes.md` — exact commands per surface (headless
    sweep, `bench`, `perf:baseline`, chrome-devtools traces, bundle size), plus the
    reporting template and the AGENTS.md r15/r17 sweep rules.
- **Docs/registry:** `perf:fingerprint` added to the AGENTS.md command table;
  `perf-optimizer` added to `.github/skills/README.md`.
- **Unrelated pre-existing doc-loop failures fixed** (AGENTS.md r7 — no
  "pre-existing, out of scope"): 6 stale path references (`ci-policy.md`, ADRs
  0015, `2026-07-17-weapon-anchor`, `2026-07-24-sprite-queue-reconciler`,
  `2026-07-24-floor2-terrain-pack-generated-art-render-fix`) and 2 AGENTS.md
  references to `setup:azure:foundry*` scripts that were renamed to
  `setup:azure:env*`. `docs:check` went from 8 blocking findings to 0.

## Verification run

- `npx vitest run tests/unit/sim-fingerprint-lib.test.ts` — 17/17 passed.
- **End-to-end CLI, observed on the real headless pipeline** (not a lab):
  - `perf:fingerprint --seeds 1 --weapons sword --workers 1 --write` produced hash
    `422e8836…` in 9s.
  - `--check` against that baseline re-ran the sim and reported "Gameplay
    identical: every run matches the baseline byte-for-byte", exit 0 — confirming
    the round-trip is genuinely reproducible, not trivially self-consistent.
  - A 2-worker parallel run produced a byte-identical `sword:1` run hash
    (`361ff756…`) to the sequential run, confirming the worker-pool path does not
    perturb determinism.
- `npm run verify:fast` — green (typecheck, lint, changed unit tests, physics/size/
  weight coverage all `0 blocking`).
- `npm run docs:check` — 0 blocking (was 8 before the stale-path fixes).

## Unresolved issues / recommended next steps

- **The full gate sample has not been timed end-to-end.** 24 runs × up to ~19.8k
  frames; extrapolating from the 9s single-run smoke, expect several minutes, and
  materially longer if losing seeds run to the full budget. If that proves too slow
  to be ergonomic, the natural follow-up is a CI `workflow_dispatch` fingerprint job
  (matching AGENTS.md r15's "broad sweeps default to GitHub") rather than trimming
  the sample — trimming would weaken the proof.
- **The gate sample constants are duplicated**, not imported, from
  `tests/headless/floor1-completion.test.ts` (a script importing a test file would
  be worse). They are documented as needing to stay in lockstep. If they drift, the
  fingerprint silently stops covering the runs CI requires. A deterministic check
  asserting the two agree is a cheap, worthwhile follow-up.
- No persona doc was added under `docs/agent-os/personas/`; the agent instructs
  picking the closest existing persona and overrides only on the perf/neutrality
  axis. Promote it to a full persona if perf work becomes routine.
- No PR opened yet — the review harness / ledger for this 3🍎 change still needs to
  run before `create_pull_request`.

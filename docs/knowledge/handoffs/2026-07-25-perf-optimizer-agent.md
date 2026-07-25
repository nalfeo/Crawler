# Handoff: Perf Optimizer agent + gameplay-fingerprint neutrality gate

**Date:** 2026-07-25
**Persona:** DevOps Engineer (agent/skill tooling)
**Apples:** 3 estimated, 3 actual (tooling-only cap)

## Systems touched

mcp-tooling, ci-policy

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
thing an optimization is _supposed_ to change. Identical hash ⇒ identical covered
`RunStats` fields, i.e. a strong gameplay-neutrality signal for the sampled
headless runs (not proof of identical intermediate state history).

The agent's PR gate is: **full suite green AND a clean fingerprint check on the
full gate sample.** Neither alone is sufficient. Regenerating the baseline to
make drift disappear is explicitly called out as falsifying the proof
(AGENTS.md r11).

## What changed

- **New** `docs/knowledge/adr/2026-07-25-perf-fingerprint-neutrality-gate.md` —
  records the cross-system decisions for the fingerprint gate: >10-run execution
  policy (GitHub-backed by default), baseline lifecycle rules, coverage limits,
  and why the fingerprint normalizer layers on top of `src/shared/canonical-json.ts`.
- **New** `scripts/agent/perf/sim-fingerprint-lib.ts` — pure, unit-testable
  canonicalize/hash/diff helpers.
  - `canonicalize()` sorts object keys (so property insertion order can't affect
    the hash), preserves array order (event sequences are simulation-meaningful),
    normalizes `-0` → `0` and sparse holes → `null`, and **throws** on any value
    `JSON.stringify` would flatten into an indistinguishable token: non-finite
    numbers (`NaN`/`±Infinity` all become `null`) and non-plain objects
    (`Map`/`Set`/`Date`/`RegExp`/`Error`/class instances all have own enumerable
    keys that don't capture their value, so distinct instances would share a
    hash). Rejecting is deliberate: a non-finite `RunStats` field is a sim bug to
    fix first, not something to fingerprint around.
  - Wall-clock exclusion is an **exact top-level key allowlist**
    (`NON_DETERMINISTIC_TOP_LEVEL_KEYS = {'wallTimeMs'}`), not a name pattern. A
    pattern would silently drop a future gameplay field that happened to match
    and silently fail to drop a future timing field that didn't; the allowlist
    fails loudly in the correct direction when `RunStats` grows a new field.
  - `buildFingerprint(runs, sample)` normalizes run ordering (parallel and
    sequential sweeps agree), throws on duplicate `weapon:seed` pairs rather than
    collapsing them, and records the **sample** (seeds/weapons/maxFrames) it
    covers.
  - `compareFingerprints()` reports the exact divergent `RunStats` field paths per
    run, plus `missing`/`added` runs. A schema-version mismatch or a differing
    sample is always reported as non-identical — and a differing sample is
    reported as a distinct **sample mismatch**, not as gameplay drift, so
    narrowing a `--check` against a full-gate baseline can't send the reader
    hunting a nonexistent bug.
- **New** `scripts/agent/perf/floor1-gate-sample.ts` — the single source of truth
  for the Floor-1 gate sample (seeds, weapons, frame cap, wall-time cap), imported
  by **both** `tests/headless/floor1-completion.test.ts` and the fingerprint CLI.
  Previously duplicated; duplication would let the fingerprint silently drift out
  of lockstep with CI and start certifying a sample nobody gates on. Values are
  numerically unchanged from what the gate enforced before.
- **New** `scripts/agent/perf/sim-fingerprint.ts` — the CLI (`perf:fingerprint`),
  `--write <file>` / `--check <file>` (mutually exclusive, one required). Reuses
  the existing `worker-pool.ts` + `tsx-worker-hooks.mjs` pattern from
  `winrate-sweep.ts`. `--seeds` / `--weapons` can narrow the sample for fast local
  iteration; the tool then loudly labels the result as NOT valid for the PR gate.
  `--check` calls `process.exit(1)` on drift, on a version mismatch, and on a
  sample mismatch.
- **New** `tests/unit/sim-fingerprint-lib.test.ts` (32 tests) and
  `tests/unit/floor1-gate-sample.test.ts` (5 tests) — covering key-order
  stability, top-level-only wall-clock stripping, array-order preservation, `-0`
  normalization, the non-finite and non-plain-object throws (including that
  null-prototype objects are still accepted), duplicate-run rejection, exact drift
  field paths, missing/added runs, version- and sample-mismatch handling, report
  truncation, and a **lockstep assertion that both the CI gate and the CLI import
  the shared sample module** rather than re-declaring it.
- **New** `.github/agents/perf-optimizer.agent.md` — the agent. Defines the
  gameplay-neutrality contract **and its explicit coverage limits** (the
  fingerprint scopes to headless `RunStats`; render/load changes additionally owe
  a visual/e2e/first-frame observation), in/out of scope (explicitly excludes
  dev/CI loop speed and any "do less game" trade-off), a documented narrow
  exception to AGENTS.md r15 for the fixed 24-run deterministic comparison, and
  the requirement to report wins as measured numbers.
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

- `npx vitest run tests/unit/sim-fingerprint-lib.test.ts tests/unit/floor1-gate-sample.test.ts`
  — 37/37 passed.
- **End-to-end CLI, observed on the real headless pipeline** (not a lab):
  - `perf:fingerprint --seeds 1 --weapons sword --workers 1 --write` produced hash
    `422e8836…` in 9s.
  - `--check` against that baseline re-ran the sim and reported "RunStats
    identical: every run in the sample matches the baseline byte-for-byte", exit 0
    — confirming the round-trip is genuinely reproducible, not trivially
    self-consistent.
  - A 2-worker parallel run produced a byte-identical `sword:1` run hash
    (`361ff756…`) to the sequential run, confirming the worker-pool path does not
    perturb determinism.
  - A deliberately mismatched `--check` (`--seeds 1-2` against a `--seeds 1`
    baseline) printed the **sample mismatch** message with "This is NOT a gameplay
    finding" and exited 1 — the review-round-1 false-alarm path, verified fixed.
  - After the stricter canonicalization landed, a real run still hashed to the
    same `422e8836…`, confirming real `RunStats` contains nothing the new
    non-plain-object guard wrongly rejects.
- `npm run verify:fast` — green (typecheck, lint, changed unit tests, physics/size/
  weight coverage all `0 blocking`).
- `npm run docs:check` — 0 blocking (was 8 before the stale-path fixes).

## Review harness (3🍎: plan review + code-review loop)

- **Plan review** (`gpt-5.5`, `plan_divergence: minor`) — 3 concerns, all resolved:
  the neutrality claim was overstated as whole-game proof (rescoped to headless
  `RunStats`, with a required surface-specific observation for render/load work);
  the 24-run local sample conflicted with AGENTS.md r15 (now an explicitly
  documented narrow exception — it's a deterministic before/after comparison, not
  a sampling sweep, and both halves must run on the same machine/build); and the
  regex key-stripping plus duplicated gate constants were fragile (replaced with
  an exact allowlist and a shared module).
- **Code review, 3 rounds** to clean:
  1. `claude-sonnet-4.6` — 4 concerns: `NaN`/`Infinity` and `Map`/`Set` both
     collapse to identical JSON tokens (hash collisions), a narrowed `--check`
     misreported uncovered runs as gameplay drift, and `process.exitCode` was
     weaker than `process.exit` for a gate tool.
  2. `gpt-5.5` — 1 concern: the `Map`/`Set` guard was **type-specific**, so
     `Date`/`RegExp`/`Error`/class instances still canonicalized to `{}` and could
     share a hash. Replaced with a structural plain-object (prototype) check.
  3. `claude-sonnet-4.6` — clean. Confirmed the collision class is fully closed
     with no false positives against real `RunStats`, verified the extracted gate
     constants are numerically identical to `main`, and verified every npm script,
     path, and CLI flag cited in the agent/skill docs actually exists.
- Ledger: `docs/knowledge/review-ledgers/2026-07-25-perf-optimizer-agent.review-ledger.json`
  (validates as a 3-apple ledger).

## Unresolved issues / recommended next steps

- **The full gate sample has not been timed end-to-end.** 24 runs × up to ~19.8k
  frames; extrapolating from the 9s single-run smoke, expect several minutes, and
  materially longer if losing seeds run to the full budget. If that proves too slow
  to be ergonomic, the natural follow-up is a CI `workflow_dispatch` fingerprint job
  rather than trimming the sample — trimming would weaken the check. (Note the
  r15 exception is deliberately narrow: a wider seed range _is_ a sweep and should
  go to `ai-sweep.yml`.)
- **The gate sample constants are now shared, but `MIN_WIN_RATE` is not.** The
  seeds/weapons/frame-cap live in `scripts/agent/perf/floor1-gate-sample.ts` and a
  unit test asserts both consumers import it. The per-weapon win-rate thresholds
  remain local to the headless test (the fingerprint doesn't need them), which is
  correct today but worth revisiting if another tool starts caring about them.
- The fingerprint drops object properties whose value is literally `undefined`
  (matching `JSON.stringify` semantics). Harmless for today's `RunStats`, where an
  optional field is either meaningfully set or absent — but if a future optional
  field ever carries a meaningful `undefined` distinct from "absent", that
  transition would be invisible to the hash.
- No persona doc was added under `docs/agent-os/personas/`; the agent instructs
  picking the closest existing persona and overrides only on the perf/neutrality
  axis. Promote it to a full persona if perf work becomes routine.

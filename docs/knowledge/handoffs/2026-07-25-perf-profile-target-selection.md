# Handoff: `perf:profile` — make perf target selection measured, not guessed

**Date:** 2026-07-25
**Persona:** DevOps Engineer (agent/skill tooling)
**Apples:** 3 estimated, 3 actual (tooling-only cap)

## Systems touched

mcp-tooling, ci-policy

## Outcome

The Perf Optimizer agent (shipped in PR #1958) was run for real and produced
**PR #1973** — a ~3x speedup of `applyEffectiveStats` (`src/core/effective-stats.ts`)
by reusing scratch buffers. The win is real and reproducible (committed bench,
non-overlapping distributions, independently reproduced at 3.05–3.48x).
**But the target was wrong**, and that exposed a hole in the agent contract.

CPU-profiling the headless runner showed:

| function                          | self%                         | note                     |
| --------------------------------- | ----------------------------- | ------------------------ |
| `compute` (rot-js FOV), per-frame | **21.5%**                     | untouched                |
| `findTilePath`                    | 1.96% self / **26.31% total** | biggest subsystem        |
| `effective-stats` pair            | **~2.4%**                     | what the agent optimized |

Amdahl made the outcome predictable before a line was written: 2.9% × (1 − 1/3) =
**1.93% ceiling**, and the child measured 2.2% end-to-end — inside noise.

**Root cause:** SKILL.md step 3 already said "write down the share before
optimizing", but **no recipe in the skill could measure a function's share of the
headless sim**. A mandatory step with no command behind it gets skipped.

## What landed

1. **`npm run perf:profile`** (`scripts/agent/perf/profile-headless.ts` +
   `profile-analyze-lib.ts`, 24 unit tests). Runs the headless sim under
   `--cpu-prof` across seeds 1-3 × sword (~35s), merges the profiles, and ranks by
   **self and total** time. `--ceiling <share>:<speedup>` is an Amdahl helper.
   SKILL.md step 3 is now a **blocking gate** that names this command, requires
   recording the share + predicted ceiling, and carries the surface-scoping
   caveat (sim → `perf:profile`; render/load → Chrome trace) plus an explicit
   anti-bundling rule.
2. **Risk-based apple floor** in the agent doc. PR #1973 was 12 lines, correctly
   measured, self-estimated 2🍎 — so it got **zero** review stages, and the
   reentrancy hole it left was caught by an after-the-fact audit rather than by
   review. The 3🍎 trigger is now the risk patterns (non-local mutable state, new
   or re-keyed caches, ordering/RNG/path effects, persistent shared buffers), not
   diff size, with a clause requiring disclosure if a safer design was rejected to
   dodge ceremony.
3. **Buffer-reuse mechanism menu** (hunting-grounds A3). The old advice — "make
   reuse strictly local" — was advice the real optimization _could not follow_,
   since module-level scratch was the entire win. Replaced with four named
   mechanisms and a requirement to name one in the PR and add an escape
   regression test. A reentrancy guard alone is explicitly called insufficient:
   it catches nesting, not a returned alias.
4. **Seeded profile table** in hunting-grounds, labelled with date, commit,
   command and sample size, and marked "starting hint only — re-profile before
   optimizing".
5. **Windows telemetry fix** in `scripts/agent/review/pr-prereq-check.mjs`.
   `execFileSync('npm.cmd', ...)` throws a bare `spawnSync npm.cmd EINVAL` on
   Node ≥18.20/20.12 (CVE-2024-27980 mitigation refuses `.cmd` without a shell);
   `shell: true` with an args array works but triggers `DEP0190`. Fixed by using
   `execSync` with a single pre-built command string on Windows (the slug is
   already normalized to `[a-z0-9-]`, so there is nothing for a shell to interpret).

## Two traps the profiler learned the hard way (both encoded in the tool)

- **The headless CLI exits non-zero to mean "the AI did not win".** That is not a
  process failure — a losing or frame-capped run is a perfectly valid profile.
  Gating on exit code rejects good data; gating on "a `.cpuprofile` exists"
  accepts crashes (V8 writes one on any exit). The tool gates on the reported
  `Outcome:` instead, accepting `VICTORY|DEATH|TIMEOUT|STALLED` and rejecting
  `ERROR` or a missing line. An intermediate `Run Complete` marker check was
  insufficient — `runHeadless` catches mid-run exceptions and the CLI prints
  `📊 Run Complete` _before_ `Outcome: ERROR`.
- **Short runs lie.** At `--max-frames 3000`, Node/tsx/esbuild startup is ~36% of
  the profile and _reorders_ the table (`planObjectiveRoute` reads 9.1% vs its
  true 4.3%). The tool reports startup overhead on every run and warns above 15%
  (the recommended 3-seed panel sits at ~10.5%, so a 5% threshold would have
  fired on the default and caused alarm fatigue).

## Files touched

- `scripts/agent/perf/profile-analyze-lib.ts` (new) — pure profile math: self +
  inclusive time, recursion-safe subtree crediting, merge, Amdahl, formatting.
- `scripts/agent/perf/profile-headless.ts` (new) — the `perf:profile` CLI.
- `tests/unit/profile-analyze-lib.test.ts` (new) — 24 tests.
- `.github/agents/perf-optimizer.agent.md`, `.github/skills/perf-optimizer/SKILL.md`,
  `.../references/hunting-grounds.md`, `.../references/measurement-recipes.md`.
- `AGENTS.md` (command row), `package.json` (`perf:profile`).
- `scripts/agent/review/pr-prereq-check.mjs` (Windows telemetry fix).

## Verification

- `npm run verify:fast` green (after rebase onto current `main`).
- `npm run verify:pr-prereqs` green.
- 24 new unit tests pass; all CLI flags exercised manually
  (`--ceiling`, `--json`, `--json <path>`, `--help`, bad args, temp cleanup).
- Three code-review rounds (gpt-5.5 → gpt-5.5 → claude-sonnet-4.6) ending clean;
  adversarial plan review (gpt-5.5) with 8 accepted findings.

## Unresolved issues / recommended next steps

- **FOV is the next hunt, and it is ~7x the first win.** `compute` is ~21% self,
  called per-frame from `src/core/systems/fovSystem.ts:76`, while visibility only
  changes when something moves or a door opens — the textbook A1 shape. The
  `seamCache` at line 73 is per-pass only.
- **`findTilePath` at 26.31% total is the largest subsystem** and is nearly
  invisible to a self-time ranking (1.96% self). Worth a structural look.
- **PR #1973's own follow-ups are capped at ~2.4%** (dictionary-mode transitions
  in the scratch record, `clampStat` dispatch, `Object.entries` in the
  derived-secondary loop). Individually below the gate's bar — and per the new
  anti-bundling rule, stacking them to clear it is not the answer.
- The `Outcome: ERROR` rejection branch is covered by a unit test but has never
  been triggered live (hard to induce naturally).

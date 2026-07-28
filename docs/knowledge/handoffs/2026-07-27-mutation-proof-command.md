# Session Handoff: Scoped mutation-proof command (`npm run test:mutate`)

## Date

2026-07-27

## Persona

Producer → Perf Optimizer (tooling)

## Systems touched

ci-policy, agent-tooling

## Apples

3🍎 estimated, 3🍎 actual (tooling-only cap). Summary:
`docs/knowledge/metrics/apples/2026-07-27-mutation-proof-command.json`

## What Was Done

Added `npm run test:mutate` — a **scoped, blocking** command that proves a
regression test can actually _fail_, by mutating the source under it and
requiring the test suite to go red. It exists as a durable countermeasure for a
recurring defect class in this repo: **vacuous tests** that pass without ever
exercising the behaviour they name (six instances found in a single day, listed
in the perf-optimizer skill).

Repairing the existing Stryker setup turned out to be a prerequisite, not a
detour — see Key Decisions.

Usage (target is a file, optionally with a line range):

```
npm run test:mutate -- "src/core/map/astar-grid.ts:295-335" --tests tests/ecs/astar-grid-equivalence.test.ts
```

`--tests` is explicit by design; auto-derivation from the source path is a
convenience fallback that **fails loudly** when it cannot find a covering test,
rather than silently running against nothing.

Observed end-to-end on the real artifact, not just in unit tests:

- `astar-grid.ts:295-335` with its covering test → **37s**, exit 1, 23 survivors.
- Whole `astar-grid.ts` → **48s**, score **77.04%**, 55 survivors + 4 no-coverage.
  One survivor is `while (scratch.heapSize > 0)` → `>= 0`, which survives the
  4,350-comparison differential oracle from PR #2076 — a differential oracle I
  personally audited and passed. That is the tool doing its job on day one.

Both safety guards were proven live, not just asserted in unit tests:

- A `--tests` selection that covers nothing → **Stryker itself aborts** with
  `No tests were executed` and writes no report → the wrapper hard-fails with
  "Treat this as a failure, not a pass."
- A whole-file run with `--max-survivors 999` still **fails** on the 4
  no-coverage mutants, proving a generous tolerance cannot launder an
  un-exercised target.

Also added a **blocking step 7** to `.github/skills/perf-optimizer/SKILL.md`:
prove your regression test can fail before reporting.

## Key Decisions Made

**Built on Stryker instead of a bespoke runner.** My original plan was a
hand-rolled mutation script. The mandatory plan review (`gpt-5.6-sol`) caught
that `@stryker-mutator/*` was already a devDependency with a config and a
nightly workflow — a `major_fork` divergence, and the correct call. It also
killed four real design flaws in the bespoke plan (in-place mutation not
crash-safe; "any red test = killed" being itself a vacuity; no green-baseline
run; whole-file EOL normalisation rewriting the file).

**Stryker had been completely broken for ~6 weeks, and this is the headline
finding.** It crashed in its _initial dry run_, before generating a single
mutant:

```
Projects "integration" and "unit" have different 'maxWorkers' but same 'sequence.groupOrder'
```

The root `vitest.config.ts` declares nine projects; `unit` sets `maxWorkers: 4`,
`integration` does not, and Stryker's vitest runner drives them together.
`@stryker-mutator/vitest-runner` exposes only `dir`/`related`/`configFile` — no
project selector — so the fix is a dedicated single-project
`vitest.mutation.config.ts`.

**This was invisible for the same reason the bugs it hunts are invisible.**
`.github/workflows/nightly-mutation.yml` sets `continue-on-error: true`, so six
weeks of zero-mutant runs reported green. `docs/knowledge/metrics/mutation-baseline.json`
is frozen at `recordedAt: 2026-06-14`. This is the `spawnerSystem` shape from
AGENTS.md r9 and the guard-staleness shape from the telemetry session: **a
silent signal misread as health.**

**Suite breadth, not mutant count, is the cost driver.** Stryker re-runs its
entire configured suite once per mutant. Narrowing the _tests_ via
`STRYKER_TEST_INCLUDE` is what makes the command usable:

| configuration                                   | result                |
| ----------------------------------------------- | --------------------- |
| as-committed                                    | crashes, 0 mutants    |
| whole file (257 mutants) + full 1102-test suite | **aborted at 82 min** |
| line range (82 mutants) + full suite            | **aborted at 37 min** |
| line range + covering test file only            | **38 s**              |
| whole file (257 mutants) + covering test only   | **48 s**              |

With the suite narrowed, Stryker reports `Ran 11.22 tests per mutant on average`
— `perTest` coverage analysis was working the whole time, just starved.

## What's Next / Blockers

- **The nightly is still effectively dead.** This PR makes Stryker _runnable_;
  it does not re-arm the nightly. Someone should decide whether to drop
  `continue-on-error: true` and re-baseline `mutation-baseline.json`, which has
  been stale since 2026-06-14.
- **`stryker.config.json` `mutate` globs cover only ~78 of 453 `src` files
  (~17%), and all six observed vacuity defects live _outside_ them.** I
  deliberately did **not** widen them here: widening globs on a nightly that is
  advisory-only and currently produces no signal is low-value churn. Worth doing
  in the same session that re-arms the nightly, not before.
- **Why is `src/game/ai/**`excluded from the`mutate` globs?\*\* Added once in
  PR #99 and never revisited — likely an initial guess rather than a decision.
- **Is `npm test` (all 9 projects) hitting the same `maxWorkers`/`groupOrder`
  conflict?** Untested. Worth 5 minutes.
- **PR #2120 needs a scope decision.** `main` has since landed #2131, a third
  independent fix for the same stale latent-backlog assertion. #2120 still
  carries a fix the others do not — the _vacuous dedup logic_ whose selectors are
  provably disjoint, so the dedup could never fire — plus `sweep-budget.mjs`.
  Rebase and re-scope to just that, or close it.

## Retrospective

### Lessons Learned

- **`continue-on-error: true` on a quality gate converts it into decoration.**
  Six weeks of a crashing mutation run reported as a green nightly. If a check is
  advisory, its output needs to be _read_ somewhere; otherwise prefer no check to
  a green one.
- **Stryker's cost model is per-mutant × whole-suite.** Scope the _tests_, not
  the mutants. Line-range scoping felt like the obvious lever and was nearly
  irrelevant.
- **Orphaned `node` processes accumulate massively.** Peaked at 111 on a 12-core
  box; `stop_powershell` does not reap Stryker's spawned vitest workers. Reap
  with
  `Get-Process node | Where-Object { $_.StartTime -ge (Get-Date).AddHours(-3) } | Stop-Process -Force`.
- **Print the patched-site count before trusting a mutation result.** Carried
  over from the barrier session's CRLF-vs-LF trap and used here: when
  mutation-proving the round-1 fix I printed `SITES_PATCHED=1` and
  `git diff --stat` alongside the test result, so a silently-no-op patch could
  not be mistaken for a decorative test.
- **Check `git branch --show-current` before committing in a worktree session.**
  See Mistakes.

### Mistakes Made

- **I nearly committed this work onto PR #2120's branch.** I had switched to
  `fix-sweep-budget-latent-backlog-test` earlier in the session and never
  switched back; several files were staged before I noticed. Early signal: the
  `git status` output listed files I had not touched this task. Recovered with
  `git checkout -- <file>` → `git stash push -u` → `git checkout -b <new> origin/main`
  → `git stash pop`.
- **I was wrong twice about the performance bottleneck, and both times I
  "confirmed" it by reasoning rather than measuring.** First I blamed
  `typescript-checker` (removing it changed nothing); then mutant count
  (257 → 82 changed nothing). Only the third hypothesis — suite breadth — held.
  Early signal I ignored: the 257-mutant and 82-mutant runs had _the same_
  per-mutant cost, which already falsified the mutant-count theory before I
  tested it.
- **My original plan duplicated mature existing infrastructure**, and I asserted
  in that plan that SKILL.md already mandated mutation testing. Both were wrong;
  the plan review caught both. The `mutat` match I had relied on was a false
  positive — prose about a caller observing a value _mutate_ later.
- **I shipped a High-severity false pass into round-1 review.** `Ignored`
  mutants count into `total` but not `valid`, so a report of nothing but ignored
  mutants passed the `total === 0` guard and printed **PASS** having killed
  nothing — reachable in practice via `// Stryker disable` comments or excluded
  mutators. That is precisely the vacuity this tool exists to prevent, in the
  tool itself. My existing test masked it by always including a `Killed` mutant.

### Opportunities for Future Improvement

- `vitest.mutation.config.ts` duplicates the root `unit` project and will drift.
  A shared factory that both configs import would fix it properly.
- The report path `reports/mutation/mutation.json` is shared, so two concurrent
  `test:mutate` runs would race. Fine for a human-driven command; worth a
  per-run temp path if this is ever parallelised in CI.
- `test:mutate` is currently a manual gate documented in a skill. Once the
  nightly is re-armed and trusted, consider having the perf-optimizer's PR
  checklist emit the exact invocation for the touched file, so the step is
  copy-pasteable rather than remembered.

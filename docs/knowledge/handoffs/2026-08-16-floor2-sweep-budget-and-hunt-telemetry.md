# Session Handoff: Floor-2 release-sweep frame budget + hunt-kill telemetry naming

## Date

2026-08-16

## Persona

Producer → Game AI Engineer

## Systems touched

ai-headless-runner, ci-policy

## Apples

2🍎 exact

## What Was Done

Categorized the Floor-2 release sweep failures from deploy run `31919245413` (@`2deee6c`)
across the 14 `release-leg-floor2-*` artifacts plus the merged baseline (140 standalone
Floor-2 records + the 150-run chained leg), then fixed the two categories the maintainer
asked for.

**Cat 1 — Floor 2 inherited Floor 1's frame cap (measurement artifact).**
`scripts/agent/perf/winrate-sweep-args.ts` resolved `getDefaultMaxFrames(floorId) ?? BUDGET_FRAMES`.
`floor2.manifest.json` declares no `implemented.winBudgetMs`, so `getDefaultMaxFrames('floor2')`
returns `null` and every standalone Floor-2 run was truncated at Floor 1's 21,600 frames
(6 min) — while the observed chained Floor-2 clears need 73,109–77,152 frames. The reported
0/150 Floor-2 win rate was therefore an artifact, not a gameplay result; the chained leg
(which falls through to the runner default of 100,000 frames) does produce clears, which is
the proof of the asymmetry. Fix: added an exported `FLOOR_AGNOSTIC_DEFAULT_MAX_FRAMES = 100_000`
to `src/game/ai/floor-run-budget.ts`, made `headless-runner.ts`'s `DEFAULT_CONFIG.maxFrames`
reference it instead of a bare literal, and changed the sweep-args fallback to use it. No
`winBudgetMs` was invented for Floor 2 — that would be an unvalidated balance number, and
`tests/unit/floor-implementation-status.test.ts` deliberately asserts Floor 2 has none.

**Cat 5 — hunt-scoped kill counters shared names with floor-wide totals.**
`Floor2HuntMetrics.familyTrashKills` / `neutralTrashKills` only accumulate during active
hunt frames (a committed hunt family with a still-locked den), so a run with 134 player
family kills in `combat.killsByType` legitimately reported `hunt.familyTrashKills == 0` —
but the name collision with the floor-wide `RunStats.familyTrashKills` made that read as an
undercount bug. Renamed to `huntFamilyTrashKills` / `huntNeutralTrashKills` and documented
on the interface that this whole block is hunt-scoped, with pointers to the floor-wide
totals. No counting logic changed.

Observed in the real artifact (the sweep arg parser, not a lab) — before: `--floor floor2`
resolved `maxFrames=21600`; after: `maxFrames=100000`, with floor1 byte-identical at 23,760
and an explicit `--max-frames 600` still overriding on both floors. Typecheck, lint,
`winrate-sweep-args`, `floor-implementation-status`, and `headless-runner-telemetry` are green.

## Key Decisions Made

- A floor with no declared win budget falls back to the **floor-agnostic runner default**,
  never to another floor's cap. Silently inheriting Floor 1's bound is worse than having no
  bound, because it produces confidently-wrong 0% win rates.
- Did **not** add `winBudgetMs` to `floor2.manifest.json`. A budget is a balance decision
  that needs sweep evidence; the harness fix must not smuggle one in (rules #11/#12).
- Fixed the Cat-5 ambiguity by renaming rather than by changing accumulation scope. The
  hunt-scoped numbers are the intended signal for hunt quality; the floor-wide totals
  already exist elsewhere, so no data was missing.
- Updated the existing unit test that asserted `floor2 === BUDGET_FRAMES`. It encoded the
  old (buggy) intent explicitly, so leaving it would have been leaving the bug.

## What's Next / Blockers

- **Re-run the Floor-2 release sweep** to get a real (non-artifact) Floor-2 win rate. Only
  after that number exists is it meaningful to argue about Floor-2 balance.
- **Shard runtime grows ~4×** for standalone Floor-2 legs (est. ~16–27 s → ~75–125 s per
  run). Still inside the runner's 5-min `maxWallTimeMs` default and the 90-min shard
  timeout, but watch the first post-fix deploy run for shard timeouts.
- `questStallFrames` still defaults to Floor 1's 21,600 frames of no quest progress, so
  longer Floor-2 runs may now classify as `stalled` more often. Out of scope here; needs a
  floor-aware stall threshold if the re-run shows inflated `stalled` counts.
- Cats 2/3/4 from the analysis are untouched. Cat 3 is the highest-value real bug: 34
  chained runs defeated all 4 bosses but only 3 completed the exit, with 252–740 s still on
  the clock — that is an exit-completion defect, not a pacing problem.

## Retrospective

### Lessons Learned

- `gh` is unauthenticated in this sandbox. Artifact analysis went through the GitHub MCP
  `download_workflow_run_artifact` URL + `curl` + `unzip`, which works fine.
- The chained vs standalone asymmetry was the whole diagnosis. When one code path clears a
  floor and a nominally-equivalent one never does, compare the resolved config before
  looking at gameplay at all.
- `?? FALLBACK` on a config resolver is a smell worth auditing generally: the fallback here
  was silently floor-specific, and nothing in the type system said so.

### Mistakes Made

- I initially reported "runs exceed the 1,200,000 ms Floor-2 timer" as part of Cat 5. That
  was my misreading: chained `gameTimeMs` is cumulative across legs, while the collapse
  check at `floor2Scenario.ts:744-748` tests per-leg `world.elapsedMs`. The 1,381,383 ms run
  was under the per-leg timer. **Early signal I ignored:** the field came from a _chained_
  record, and I compared it to a _per-leg_ constant without checking the accumulation scope.
  No code change was warranted and none was made.
- I nearly "fixed" Cat 1 by adding a `winBudgetMs` to the Floor-2 manifest. The existing
  test asserting Floor 2 has no budget caught it. Read the tests around a config field
  before adding to it.

### Opportunities for Future Improvement

- A sweep should **refuse to report a win rate** when a material share of runs terminate on
  `maxFrames` truncation, or at minimum surface a `truncatedRuns` count in the summary. That
  single number would have made this bug self-evident in the first report instead of
  requiring artifact archaeology.
- Consider making per-floor budget resolution total (an explicit per-floor entry, even if
  the value is "runner default") so no floor can silently pick up another floor's bound.
- Chained records should either carry per-leg elapsed time alongside the cumulative total,
  or name the cumulative field unambiguously (`cumulativeGameTimeMs`) — the same class of
  naming ambiguity as the Cat-5 hunt counters.

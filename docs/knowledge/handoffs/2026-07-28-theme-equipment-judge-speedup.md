# Session Handoff: Speed up theme-equipment rejudge (~4× overall, up to ~8× the rejudge)

## Date

2026-07-28

## Persona

Producer → Sprite Engineer (asset-pipeline tooling)

## Systems touched

sprite-pipeline

## Apples

3🍎 estimated, 3🍎 actual (tooling-only cap). Full JSON: `docs/knowledge/metrics/apples/2026-07-28-theme-equipment-judge-speedup.json`.

## What Was Done

The maintainer was blocked ~30 min per set on the theme-equipment **variant-approval rejudge**
(`runJudgePass` judged up to 16 candidates strictly sequentially → ~288 serial Azure vision
calls for an 18-item set). Sped it up with two levers, **scoped ONLY to the theme-equipment
rejudge path** so no other judge caller changes behavior:

1. **New rejudge-only cap 6** — `THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS = 6` added to
   `scripts/sprites/theme-equipment-brief.ts`. `approveVariantArtifacts` passes
   `judgeMaxVariants: Math.min(THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS, brief.judge.maxVariants)`.
   `THEME_EQUIPMENT_DEFAULT_JUDGE_MAX_VARIANTS` stays at **16** — initial generation still
   explores the full candidate set; only the rejudge is capped.
2. **Bounded parallelism (concurrency 4)** in the rejudge loop —
   `THEME_EQUIPMENT_JUDGE_CONCURRENCY = 4`, threaded through `rerun.ts` (`RejudgeArgs`) into
   `runJudgePass`. `theme-equipment-runner.ts` `approveVariantArtifacts` passes
   `judgeMaxVariants: Math.min(6, brief.judge.maxVariants)` + `concurrency: 4`.

**Byte-identical invariant.** `runJudgePass` keeps the exact old sequential loop for
`concurrency === 1`; only `concurrency > 1` fans out a bounded worker pool. Results are folded
back into `judgePlan`/`judgeSkipReason` in `consideredVariants` order, so Map iteration order is
identical to sequential regardless of worker completion order. The parallel path throws if a
`judgeBudget` or `judgeCache` is supplied (both race across concurrent calls) — theme-equipment
rejudge supplies neither. Cap validated as a finite int 1..64; concurrency as a finite int ≥1.
On a worker error, the pool stops handing out work and `Promise.all` drains all in-flight
workers before rethrowing (drain-before-throw — no judge call starts or writes a sidecar after
`runJudgePass` has rejected).

**Observed / verified (rule #9 — real artifact is the rejudge path, NOT a lab):** 22 new unit
tests prove (a) parallel path produces byte-identical `judgePlan`/`judgeSkipReason` to
sequential at every concurrency; (b) peak in-flight judge calls ≤ concurrency; (c) the
budget/cache guard throws; (d) drain-on-error; (e) rerun forwards cap 6 / concurrency 4
verbatim; (f) cap/concurrency defaults leave the non-theme-equipment path unchanged. All 22
pass; **261 existing run-pipeline / rerun / judge / theme-equipment tests stay green**,
confirming the byte-identical guarantee. `npm run verify:fast` green.

## Key Decisions Made

- **Concurrency 4, cap 6** locked with the maintainer. ~4× overall, up to ~8× on the rejudge
  itself.
- **Sequential path kept verbatim** for `concurrency === 1` rather than routing everything
  through the pool — the cheapest possible proof of byte-identical behavior, and keeps the
  budget/cache accounting (which the pool cannot safely do) exactly as-is.
- **Parallel path rejects budget/cache** instead of trying to make them concurrency-safe —
  theme-equipment rejudge uses neither, and cross-call accounting under parallelism would be a
  new, subtle source of nondeterministic spend. Fail loud instead.
- **Scope guardrail**: the cap/concurrency args are optional; every non-theme-equipment caller
  keeps the old default (concurrency 1, brief's own cap) → no behavior change outside the
  targeted path.

## Tradeoff

Cap 6-of-16 means **62.5% of generated candidates are no longer sent to the vision judge** on
the rejudge. Candidates are ranked by sensor score first, so the 6 judged are the top-6 by
deterministic sensor score — the ones most likely to win anyway. This is the intended
cost/latency trade; if judged-quality regresses in practice, raise
`THEME_EQUIPMENT_REJUDGE_MAX_VARIANTS` (single constant, rejudge path only — does not affect
initial generation).

## What's Next / Blockers

None blocking. If the maintainer wants the same speedup on the initial generation judge pass
(not just rejudge), the same `concurrency` arg is already plumbed through `runJudgePass` — wire
it at the generation call site behind the same guard.

## Retrospective

### Lessons Learned

- **`tests/unit/sprites/**`is excluded from the base tsconfig's type-check scope but IS
type-checked by`verify:fast`'s full-project pass.** A wrong type-only import
(`judge-budget.js`— the type actually lives in`cost-tracker.js`) and a
`noUncheckedIndexedAccess`violation both passed a bare`tsc -p tsconfig.json --noEmit`yet
failed`verify:fast`. Always run `verify:fast`, not just `tsc`, before trusting test types.
- The sprites vitest project is separate: `npx vitest run --project sprites <filter>`.
  `--project unit` silently finds nothing under `tests/unit/sprites/`.
- The judge response schema is dynamic: `parseJudgeResponse` falls back to a **legacy** schema
  (`design_language`/`reference_style_match`/`brief_match`/`readability`, integer scores 1..5).
  A mock vision provider must return that shape with integer 1..5 scores, and `judgeVariant`
  throws without `brief.name` (→ `canonicalSpriteName`). Encode the variant index in the
  candidate PNG's top-left R channel + in rationales to detect cross-variant mis-association.

### Mistakes Made

- Trusted a clean `tsc -p tsconfig.json --noEmit` from the prior segment as proof the tests
  type-checked. They didn't — `tests/unit/sprites/**` is outside that config. The bad import
  only surfaced after the rebase + `verify:fast`. Early signal: if a file lives under a
  vitest-project-specific include, assume the base tsconfig may not cover it; run the real gate.

### Opportunities for Future Improvement

- The dynamic legacy-vs-current judge schema is a recurring trap for anyone writing a mock
  provider. A tiny exported `makeLegacyJudgeResponse(scores)` test helper would stop each new
  judge test from rediscovering the 1..5-integer / field-name constraints by trial and error.

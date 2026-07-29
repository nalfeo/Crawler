# Finding: haiku-4.5 clears small replay tasks at 2.7× lower cost than sonnet-4.6

**Experiment:** `model-tier` · **Date:** 2026-07-25 · **Trials:** 8 (2 arms × 4)
**Task:** `smoke-blood-pool` (replay of merged PR #1799)
**Verdict:** CONCLUSIVE on 4 of 6 comparisons.

## Hypothesis

A small, well-scoped replay task does not need a frontier model. `claude-haiku-4.5` should
reach a passing verifier at a comparable pass rate to `claude-sonnet-4.6`, at materially
lower `nanoAiu` cost.

## Result

8/8 trials reached a passing verifier. No leak flags, no budget censoring, no errors, zero
compactions.

| Arm        | rep | Pass | Turns | Output tokens | nanoAIU (e9) | Wall (s) |
| ---------- | --- | ---- | ----- | ------------- | ------------ | -------- |
| sonnet-4.6 | 1   | ✅   | 10    | 10,497        | 91.75        | 211.0    |
| sonnet-4.6 | 2   | ✅   | 9     | 11,703        | 66.52        | 220.3    |
| sonnet-4.6 | 3   | ✅   | 10    | 12,214        | 68.95        | 229.7    |
| sonnet-4.6 | 4   | ✅   | 9     | 9,766         | 60.55        | 203.2    |
| haiku-4.5  | 1   | ✅   | 14    | 8,199         | 31.44        | 155.3    |
| haiku-4.5  | 2   | ✅   | 19    | 9,201         | 30.20        | 187.3    |
| haiku-4.5  | 3   | ✅   | 10    | 7,640         | 20.48        | 202.6    |
| haiku-4.5  | 4   | ✅   | 12    | 6,621         | 19.44        | 159.2    |

| Metric        | sonnet-4.6 | haiku-4.5 | Δmedian            | CI95               | Cliff's δ     |
| ------------- | ---------- | --------- | ------------------ | ------------------ | ------------- |
| Pass rate     | 100%       | 100%      | —                  | —                  | —             |
| Turns         | 9.5        | 13.0      | **+3.5**           | [0.5, 9.5]         | 0.88 (large)  |
| Output tokens | 11,100     | 7,920     | **−3,181**         | [−4,828, −1,432]   | −1.00 (large) |
| nanoAIU       | 67.7e9     | 25.3e9    | **−42.4e9 (−63%)** | [−66.4e9, −32.7e9] | −1.00 (large) |
| Wall clock    | 215.6 s    | 173.3 s   | **−42.4 s (−20%)** | [−67.7, −9.1]      | −1.00 (large) |
| Tool bytes    | 61.9 KB    | 62.5 KB   | +0.6 KB            | [−15.8, +4.4]      | 0.25 (small)  |
| Compactions   | 0          | 0         | 0                  | [0, 0]             | —             |

Every one of those four significant effects has **Cliff's δ = ±1.00 or 0.88** — the arms
barely overlap.

## Reading

**Haiku takes more steps but costs far less, and finishes sooner.** It needed a median
+3.5 turns, yet emitted 29% fewer output tokens (shorter per turn), cost **2.7× less**, and
still finished 20% faster in wall clock. The extra turns are cheap turns.

**Observed reliability was identical in this sample** — 4/4 versus 4/4. That is
encouraging, but at one task and n=4 per arm it is not enough to claim pass-rate
equivalence.

**But haiku's turn count is much more variable.** Sonnet ran 9, 9, 10, 10 — a 1-turn
spread. Haiku ran 10, 12, 14, 19 — a 9-turn spread, nearly 2× at the top end. On this task
the ceiling was never near, but that variance is the risk to watch: on a longer task it is
the mechanism by which haiku would hit a budget cap or a compaction, and neither showed up
here only because the task is small.

**Contrast with the `instruction-overhead` run.** That experiment died on a ~1% effect
against 45% within-arm `nanoAiu` noise. Here the within-arm noise is comparable (sonnet
ranged 60.55 → 91.75, a 52% spread) but the effect is **2.7×** — so it is conclusive at
n=4. The lesson generalises: with the current telemetry this lab can resolve large effects
cheaply and cannot resolve small ones at any practical n. Choose hypotheses accordingly, or
fix the measurement first.

## What this does and does not license

- It **does** demonstrate large cost/speed gains on this small, well-scoped,
  test-verified replay task, conditional on successful execution.
- It does **not** say anything about code quality, policy compliance, or design judgement.
  The verifier runs only the PR's own tests, so "green" means the tests pass — nothing more.
  Haiku's diffs were not reviewed for adherence to repo conventions.
- It is **one task at n=4**. It does not generalise to multi-system features, ambiguous
  asks, or anything requiring architectural judgement — exactly the work where a frontier
  model is expected to pay for itself.

## Actions

1. **Do not blanket-switch the default model.** The evidence covers small verified tasks
   only.
2. **Add a second, harder task to the pack** and re-run. The single most valuable follow-up
   is finding the complexity point where haiku's pass rate breaks — that boundary, not this
   result, is what a routing rule needs.
3. **Track the turn-count variance.** If haiku is adopted anywhere, budget caps must be set
   off its upper tail (19 turns here), not its median.
4. Still outstanding from the previous finding: **no input-token telemetry exists**, so
   context efficiency remains unmeasurable. That gap did not block this experiment because
   the effect was large and visible in output-side metrics.

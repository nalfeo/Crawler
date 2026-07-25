# Finding: haiku-4.5 is a cheaper patch-to-green tier for the smoke replay

**Experiment:** `model-tier` · **Date:** 2026-07-25 · **Trials:** 8 (2 arms × 4)  
**Task:** `smoke-blood-pool` (replay of merged PR #1799)  
**Verdict:** CONCLUSIVE for cost and wall-clock on this replay task; not a PR-calendar fix.

## Step 1 judgement: what the lab can and cannot address

The dominant bottleneck from the 60-PR scan is **not primarily inside the velocity lab's measurement boundary**. The scan's largest signal is PR-level calendar latency: median PRs are 86% idle, the 10 slowest are 97–100% idle, small PRs are paradoxically slow, and `green → merge` is essentially zero. The replay lab measures one agent session doing a historical patch-to-green task. It does **not** measure CI scheduling, action-required parking, review/automation handoffs, or PR idle time.

So proposing a lab A/B for "fix PR idle latency" would be the same category error as the instruction-overhead experiment: the important variable is real, but the instrument cannot see it. The largest bottleneck the lab **can** genuinely resolve is model tier on session patch-to-green work: the prior scan context already showed a large effect (2.7× cost, 20% wall-clock) at n=4 despite ~50% noise, while small effects are not practical for this harness.

## Hypothesis

A small, well-scoped replay task does not need a frontier model. `claude-haiku-4.5` should reach the frozen verifier at a comparable pass rate to `claude-sonnet-4.6`, at materially lower `nanoAiu` cost. Pass rate is the gate; cost and wall-clock are the decision metrics.

## Experiment design

- **Factor:** `model` only (`assertOneFactor`-compatible)
- **Control:** `claude-sonnet-4.6`
- **Treatment:** `claude-haiku-4.5`
- **Pack:** `docs/knowledge/metrics/velocity/packs/smoke-blood-pool.json`
- **Trials:** 4 per arm
- **Dry run:** `npm run velocity:experiment -- --spec docs/knowledge/metrics/velocity/experiments/model-tier.json --dry-run --out files/velocity-reports/model-tier-dry.json`
- **Live run:** `npm run velocity:experiment -- --spec docs/knowledge/metrics/velocity/experiments/model-tier.json --out files/velocity-reports/model-tier.json`

Dry-run transcripts were intentionally empty; the live run wrote real transcripts under the trial root sibling path noted in the raw report.

## Full per-trial results

| Arm        | Trial | Pass | Turns | Output tokens | nanoAIU (e9) | Wall clock (s) | Tool bytes (KB) | Compactions |
| ---------- | ----: | :--: | ----: | ------------: | -----------: | -------------: | --------------: | ----------: |
| sonnet-4.6 |     1 | yes  |    10 |        10,497 |        91.75 |          211.0 |            63.6 |           0 |
| sonnet-4.6 |     2 | yes  |     9 |        11,703 |        66.52 |          220.3 |            63.1 |           0 |
| sonnet-4.6 |     3 | yes  |    10 |        12,214 |        68.95 |          229.7 |            63.6 |           0 |
| sonnet-4.6 |     4 | yes  |     9 |         9,766 |        60.55 |          203.2 |            63.1 |           0 |
| haiku-4.5  |     1 | yes  |    14 |         8,199 |        31.44 |          155.3 |            63.5 |           0 |
| haiku-4.5  |     2 | yes  |    19 |         9,201 |        30.20 |          187.3 |            67.7 |           0 |
| haiku-4.5  |     3 | yes  |    10 |         7,640 |        20.48 |          202.6 |            64.4 |           0 |
| haiku-4.5  |     4 | yes  |    12 |         6,621 |        19.44 |          159.2 |            47.6 |           0 |

No verifier failures, no leak signals, no budget exhaustion. Context telemetry was available for every trial.

## Aggregate result

| Metric        | sonnet-4.6 median | haiku-4.5 median |    Delta | 95% CI               | Verdict                    |
| ------------- | ----------------: | ---------------: | -------: | -------------------- | -------------------------- |
| Pass rate     |              100% |             100% |     0 pp | n/a                  | Quality gate held          |
| Turns         |               9.5 |             13.0 |     +3.5 | [0.5, 9.5]           | Haiku takes more turns     |
| Output tokens |            11,100 |          7,919.5 | -3,180.5 | [-4,828.0, -1,431.5] | Conclusive large reduction |
| nanoAIU       |           67.74e9 |          25.34e9 | -42.39e9 | [-66.41e9, -32.71e9] | Conclusive large reduction |
| Wall clock    |            215.6s |           173.3s |   -42.4s | [-67.7s, -9.1s]      | Conclusive large reduction |
| Tool bytes    |           63.4 KB |          64.0 KB |  +0.6 KB | crosses zero         | Inconclusive               |
| Compactions   |                 0 |                0 |        0 | [0, 0]               | No compaction stress       |

Haiku cost about **2.7× less nanoAIU** at identical pass rate, emitted **29% fewer output tokens**, and was **~20% faster wall-clock**, but required **+3.5 median turns** and had much higher turn variance (10/12/14/19 versus 9/9/10/10).

## Why the result is informative

This is exactly the kind of large effect the lab can resolve cheaply: the cost and wall-clock deltas are large enough that n=4 separated them despite known within-arm noise. The result also preserves the quality gate: all eight trials passed the frozen verifier.

The strongest counter-explanation is task specificity. `smoke-blood-pool` is a small, test-driven patch with obvious local code paths. It does not prove haiku is safe for ambiguous design work, multi-system changes, review adjudication, or gameplay judgement. It proves haiku can be materially cheaper for this class of patch-to-green task.

## What this does and does not license

- It **does** license a field trial of routing small, well-scoped, test-backed implementation tasks to haiku-class models.
- It **does** support using pass-rate-first model tiering for replayable patch tasks.
- It **does not** show haiku produces equal-quality code beyond the frozen verifier.
- It **does not** address the dominant 60-PR wall-clock bottleneck: idle time, CI parking, and automation handoff latency.
- It **does not** license replacing higher-tier models for planning, ambiguous feature design, review harness work, or adversarial judgement.

## Telemetry gap and top action

The top measurement gap is now PR-level field telemetry, not session replay telemetry: we need durable per-PR timestamps for first CI scheduled, every action-required parking interval, last bot push, first human/different-App retrigger, and automation handoff ownership. The earlier `statusCheckRollup`-based "first CI" figure was wrong because it only sees the latest check batch. Any field intervention for idle latency must be validated from `gh run list --branch <branch>` history or an equivalent durable collector.

## Concrete actions

1. **Field-trial haiku routing for tiny, test-backed PR tasks only.** Success signal over the next 30 merged eligible PRs: equal or better verifier/CI pass rate, lower AIU, and no increase in review-fix rounds.
2. **Do not spend more lab trials on PR idle latency.** Route that to DevOps/automation consult mode and measure it with PR/run history.
3. **Add field telemetry for automation parking.** Record per-PR first run creation, action-required spans, retrigger source, and handoff owner so the next bottleneck scan can separate idle causes without abusing `statusCheckRollup`.
4. **Keep sonnet+ for ambiguous work.** Haiku's higher turn variance is acceptable for bounded patch tasks, not for design or review decisions.

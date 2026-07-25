# Finding: instruction overhead is not measurable with current telemetry

**Experiment:** `instruction-overhead` · **Date:** 2026-07-25 · **Trials:** 6 (2 arms × 3)
**Task:** `smoke-blood-pool` (replay of merged PR #1799)
**Verdict:** INCONCLUSIVE — and the reason matters more than the verdict.

## Hypothesis

The repo's instruction surface — `AGENTS.md` + `.github/copilot-instructions.md` +
`.github/instructions/`, ~65 KB / ~16K tokens loaded into every session — is a net context
tax on a small, well-scoped feature task. Removing it should reduce tool-result bytes and
output tokens to first green.

## Result

All 6 trials reached a passing verifier. No leak flags, no budget censoring, no failures.

| Arm        | Turns | Output tokens | nanoAIU (e9) | Tool bytes (KB) | Compactions |
| ---------- | ----- | ------------- | ------------ | --------------- | ----------- |
| full r1    | 9     | 9,886         | 82.88        | 61.9            | 0           |
| full r2    | 8     | 9,755         | 57.07        | 61.5            | 0           |
| full r3    | 8     | 10,131        | 57.80        | 61.6            | 0           |
| trimmed r1 | 9     | 11,696        | 57.18        | 61.9            | 0           |
| trimmed r2 | 10    | 11,044        | 62.55        | 63.3            | 0           |
| trimmed r3 | 8     | 9,444         | 48.82        | 61.6            | 0           |

Every bootstrap CI crosses zero. The hypothesis is **not supported**, and on turns and
output tokens the point estimates run _opposite_ to it: trimming instructions cost +1
median turn and +1,158 median output tokens.

## Why the result is uninformative — the real finding

**1. The primary context metric structurally cannot see the effect.**
`toolResultBytes` is 61.5–63.3 KB across _both_ arms — essentially identical. That is not a
null result, it is a category error: instruction files enter the session as **system
context**, not as tool results. Deleting 65 KB of instructions cannot move a counter that
only sums tool output.

**2. This trial configuration emitted no input-token telemetry.**
Searched a full 560 KB transcript for `inputTokens`, `promptTokens`, `cachedTokens`,
`totalTokens` — **zero matches**. The existing analyzer can ingest
`assistant.message.inputTokens` and `assistant.usage.inputTokens` when those fields are
emitted, but this run emitted none. `assistant.message` carried `outputTokens` only, and the
`result` event's `usage` block carried `premiumRequests`, durations, and code-change counts.
The instruction tax is purely an input cost, so it is currently **unmeasurable in this trial
configuration except through billing**.

**3. The one metric that does include input cost is swamped by noise.**
`nanoAiu` is a billing proxy that necessarily includes input. Between-arm difference: ~1%.
Within-arm spread: `full` ranged 57.07 → 82.88, a **45% swing between two runs of an
identical configuration**. Noise exceeds the effect by roughly 40×.

**4. The task cannot exhibit the hypothesised harm.**
Zero compactions in all 6 trials. An 8–10 turn task never approaches the context ceiling, so
the cost the hypothesis is about — compaction — cannot occur.

## What this does and does not license

- It does **not** show instructions are free.
- It does **not** show instructions are a tax.
- It **does** show that this question cannot currently be answered by this lab, and it
  identifies exactly what is missing.

Also worth stating: the verifier only runs the PR's own tests, so it cannot see policy
compliance. Even a clean win for `trimmed` would have meant "cheaper to reach green", never
"the instructions are not worth their cost".

## Actions

1. **Close the input-token gap first.** Until input/system-context tokens are observable,
   every context-efficiency hypothesis is untestable and any run is wasted spend. This is
   the top telemetry priority.
2. **Do not re-run this experiment with more trials yet.** With a 40× noise-to-effect ratio,
   n would need to be impractically large. Fix the measurement, not the sample size.
3. **Build a context-stressing task.** A task that actually compacts is required before
   compaction cost can be studied.
4. **Investigate the 45% within-arm cost variance** — that variance is itself a velocity
   signal, and it is larger than most effects worth chasing.

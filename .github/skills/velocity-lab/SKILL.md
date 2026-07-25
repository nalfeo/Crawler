---
name: velocity-lab
description: >-
  Run a controlled A/B experiment measuring how long agents take to complete real Crawler
  tasks under different conditions. Use when asked to "A/B test this change", "does this
  skill make agents faster", "measure the impact of X on delivery", "run a velocity
  experiment", "prove this refactor helps", or "which model should we use for feature
  work". Each arm runs isolated agent sessions against replayed PRs with frozen verifiers
  and reports turns, tokens, and pass rate with effect sizes and bootstrap CIs.
---

# Velocity lab

Answers exactly one question: **given this change, how long does it take agents to build
features Foo and Bar — and do they still work?**

## The measurement

| Metric               | Role      | Why                                                        |
| -------------------- | --------- | ---------------------------------------------------------- |
| Turns to passing completion | primary | Model calls needed for sessions that finish green; the cleanest proxy for agent effort |
| Tokens / nanoAiu     | primary   | What the work actually costs                               |
| Wall clock           | secondary | Noisy — depends on machine load and API latency            |
| Verifier pass rate   | **gate**  | A trial that fails the frozen verifier is not a data point |

Quality is held constant by construction: fast-but-broken is a failure, not a win.

## How to run

Write an experiment spec (see `docs/knowledge/metrics/velocity/experiments/` for a working
example), then:

```bash
# Prove the plumbing without spending agent tokens
npm run velocity:experiment -- --spec <spec.json> --dry-run

# Real run
npm run velocity:experiment -- --spec <spec.json>
```

The report is printed and written to `files/velocity-reports/<id>.json`.

### Spec shape

```jsonc
{
  "schema": "crawler-velocity-experiment/v1",
  "id": "contracts-vs-baseline",
  "hypothesis": "Written before the run. What you expect, and why.",
  "factor": "environment", // "environment" | "model"
  "pack": "docs/knowledge/metrics/velocity/packs/<id>.json",
  "trials": 3, // repetitions per (task × arm)
  "maxAiCredits": 60, // hard per-trial cost ceiling
  "timeoutMs": 1800000,
  "arms": [
    { "id": "baseline", "description": "…" },
    { "id": "treatment", "description": "…", "setup": ["cp ...", "node ..."] },
  ],
}
```

- **`environment` arms** differ only by their `setup` commands, which run inside the trial
  workspace before the agent starts. This is how you A/B a new skill, an instruction
  change, a refactor, or a component contract.
- **`model` arms** differ only by `model` / `reasoningEffort` / `contextTier` / `agent`.

## The one-factor rule

An experiment varies environment **or** model config. Never both. The harness refuses to
render a verdict for a two-factor spec, because a delta produced by two simultaneous
changes cannot be attributed to either — and the natural instinct afterwards is to credit
whichever one you were hoping for.

## Reading the report

Per arm: usable trials, pass rate, median turns, median tokens, median wall clock.
Per comparison: median delta, **Cliff's delta** effect size, and a **bootstrap 95% CI**.

- There are **no p-values**. With n in the single digits they would be theatre.
- A comparison is `conclusive` only when both arms have ≥3 usable trials **and** the CI
  excludes zero.
- `INCONCLUSIVE` means _we do not know_. It is not evidence that the change had no effect.
  Report it as ignorance, not as a null result.

Trials are excluded from the verdict when they fail the verifier, time out, or trip the
**leak audit** (the transcript mentions the solution SHA or the source PR number). Leaked
trials are still shown, so a systematic leak is visible rather than silently dropped.

## Cost

Each trial is a live agent session. Trials = `arms × tasks × trials`. A 2×3×3 matrix is
18 sessions. Always:

1. `--dry-run` first — proves isolation, snapshotting, and verifier seeding for free.
2. Then `trials: 1` — proves the agent can actually do the task.
3. Only then scale up for statistical power.

## Guardrails

- **Never modify the verifier after seeing results.** If a task turns out to be impossible,
  drop the whole task and rerun both arms — do not patch it mid-experiment.
- **Never mix a code change into the treatment arm's setup that also changes the verifier.**
- **Write the hypothesis before the run**, in the spec. Reading a result and then deciding
  what you predicted is how every measurement program dies.
- A negative or inconclusive result is a successful experiment. Publish it.
- Landing a change on a _single_ winning experiment at n=1 is not evidence. It is a demo.

## Related

- `.github/skills/task-pack-builder/SKILL.md` — where tasks come from
- `.github/skills/bottleneck-scan/SKILL.md` — where hypotheses come from
- `docs/agent-os/policies/velocity-lab-policy.md` — the enforced rules

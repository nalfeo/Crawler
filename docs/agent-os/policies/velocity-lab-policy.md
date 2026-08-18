# Velocity Lab Policy

Rules for measuring agent delivery speed in Crawler. The velocity lab exists to answer one
question honestly:

> Given this change — to code, contracts, tests, skills, instructions, or model config —
> how long does it take agents to build features Foo and Bar, and do they still work?

A speed measurement that is easy to fake is worse than no measurement, because it will be
used. Every rule below exists to make a specific way of fooling ourselves impossible.

---

## 1. Quality is a constraint, never a variable

A trial counts **only** if the frozen verifier passes. There is no partial credit and no
"nearly finished but faster" arm. Trials that fail the verifier are recorded and reported
— so a treatment that trades correctness for speed shows up as a **pass-rate** collapse
rather than as a speed win.

Corollary: never weaken a verifier, guard, lint rule, or gate to improve an arm's numbers.
This is repository rule #11, and it binds the velocity engineer more tightly than anyone
else, because they are the party holding the ruler.

## 2. One factor per experiment

An experiment varies **either**:

- the **environment** — skills, instructions, component contracts, code shape, tooling
  (expressed as an arm's `setup` commands); **or**
- the **model config** — model, reasoning effort, context tier, custom agent.

Never both. `assertOneFactor()` in `scripts/agent/velocity/stats.ts` rejects two-factor
specs at run time.

Rationale: if two things change and the number moves, the delta belongs to neither. The
predictable human failure is to credit whichever change we were already advocating.

## 3. The verifier is frozen before any arm exists

Tasks are built by replaying merged PRs. The pass condition is the PR's **own test files**,
extracted at pack-build time and hashed into the pack.

- Never hand-edit `verifierFiles` or `verifierHash`.
- Never modify a verifier after seeing arm results. If a task is broken, drop the task and
  rerun **both** arms.
- Never add a task to a pack after seeing results.

`npm run velocity:pack -- verify-base` asserts every task is genuinely **fail-to-pass**: a
verifier that already passes at the base commit does not measure the change, and every arm
would collect a free win.

## 4. Isolation and leak auditing are mandatory

A replayed PR's real solution lives in `main`'s future history, so a normal worktree hands
the agent the answer.

- Trial workspaces are **history-free snapshots** of the base commit: no `.git` history,
  no remote, no reflog. `assertIsolated()` fails the trial if the solution commit resolves.
- Network tools (`web_search`, `web_fetch`) and repo-reading MCP tools
  (`github-mcp-server-get_file_contents`, `github-mcp-server-search_code`,
  `session_store_sql`) are denied by default.
- GitHub credential env vars are scrubbed from the trial environment. This is a
  **partial** control, not a sandbox — see below.
- Every transcript is scanned for the solution SHA and the source PR number, **and for
  attempted remote access** (`gh pr/api/...`, `git fetch/ls-remote/clone`, `curl` to
  github, `api.github.com`). Flagged trials are **reported but excluded from the verdict**,
  so a systematic leak is visible rather than silently discarded.

Never disable the audit to "clean up" a run.

### Why detection, not prevention

Credential-stripping was tested and does not close the hole. Three results, all verified
empirically against this environment:

1. **Unsetting `GH_TOKEN`/`GITHUB_TOKEN` does not stop `gh`** — it falls back to the OS
   keyring and authenticates anyway.
2. **Unauthenticated `git ls-remote` against a public repo succeeds**, so no credential
   control can help at all.
3. **Poisoning the token with an invalid value _does_ block `gh`** — and also breaks the
   Copilot CLI under test, which requires a valid token to start.

The agent's own auth credential is the same credential that can fetch the solution, so
prevention is unachievable in-process. The harness therefore treats leakage as a
**detection** problem: any attempt is flagged and the trial is excluded.

**Residual risk that must be stated in every report, not engineered away:**

1. Trials are **not network-sandboxed**. A determined path to a public mirror exists.
2. The model may have **memorised** the repository during training. For a public repo this
   is unfalsifiable from inside the harness.

The obligation is disclosure: prefer recent PRs, and treat an implausibly fast arm as
suspect before treating it as a finding.

## 4a. The lab is a pre-screen, not a court

The replay corpus is built from merged PRs, which makes it survivorship-biased by
construction, and the metric is "patch until these specific historical tests pass" — which
rewards test-satisfying behavior, not feature delivery.

The lab therefore **cannot** measure: problem framing, design of new systems, gameplay or
art judgement, review and merge dynamics, or multi-PR arcs.

Consequences, all binding:

- Report replay results as evidence about **patch-to-green tasks**, and label them so.
- A lab win **licenses a field trial**; it does not itself establish a delivery improvement.
- Before landing a **process-changing** PR on the strength of an experiment, name the field
  signal that will confirm or refute it, and the window over which it will be checked.
- An unmeasurable bottleneck is not a low-priority one. If the dominant constraint is
  design ambiguity, say so and propose a non-lab intervention rather than optimising
  whatever the lab happens to see.

## 4b. Censored trials are not failures

A trial stopped by `maxAiCredits` shows the arm did not finish _within budget_ — not that
it could not finish. Excluding those trials from medians silently deletes an arm's worst
runs, which flatters fragile arms.

Reports therefore state **success-rate-under-budget** per arm alongside the medians, and
comparing arms on medians alone is a policy violation.

## 5. No fake statistics

Reports contain effect sizes and uncertainty, not significance theatre.

- **No p-values.** At the sample sizes this lab can afford, they would be meaningless
  precision.
- Uncertainty is a **percentile bootstrap 95% CI** on the median delta (2000 resamples,
  seeded via `SeededRandom` so reports are reproducible).
- Effect size is **Cliff's delta** with Vargha–Delaney thresholds.
- A comparison is `conclusive` only when both arms have **≥3 usable trials** and the CI
  excludes zero.
- `INCONCLUSIVE` must be reported as _we do not know_ — never as "no effect". Absence of
  evidence is not evidence of absence, and at n=3 nearly everything is inconclusive.

Empty arms report `NaN`, never `0`. A zero would read as "this arm was free".

## 6. Write the hypothesis before the run

The experiment spec's `hypothesis` field is required and is committed with the spec.
Deciding what you predicted after reading the result is how measurement programs die.

## 7. Model discipline

Trials always run on **their arm's** explicit model config — never on an ambient default,
which would silently drift between runs and make historical comparisons invalid.

For the velocity engineer's _own_ work:

| Task                                         | Tier            | Effort |
| -------------------------------------------- | --------------- | ------ |
| Mining PR history, parsing transcripts       | cheap           | low    |
| Building task packs, routine tooling edits   | mid             | medium |
| Designing experiments, adjudicating verdicts | high-capability | high   |

A badly designed experiment costs a whole trial matrix and yields a confidently wrong
answer. That is far more expensive than the tokens saved by designing it cheaply.

## 8. Cost control

Every trial is a live agent session; trials = `arms × tasks × repetitions`.

1. `--dry-run` first — proves snapshotting, isolation, and verifier seeding for free.
2. Then `trials: 1` — proves the task is actually solvable.
3. Only then scale for statistical power.

`maxAiCredits` and `timeoutMs` are required in practice. An unbounded trial matrix is a
bug, not an experiment.

## 9. Landing changes

The velocity engineer may open PRs implementing its own winning experiments. To keep that
authority safe:

- A velocity PR **cites its experiment report**.
- If no experiment was run, the PR says so explicitly and is labelled unmeasured.
- A single winning trial at n=1 is a demo, not evidence. Say which one you have.
- Every positive result is reported alongside its **strongest counter-explanation**.

## 10. Observational data is not causal

`npm run velocity:scan` mines merged-PR history, closed-unmerged (abandoned) PR history,
apple estimates, and guard telemetry. It
is excellent at generating hypotheses and incapable of confirming them. A finding from the
scan is a candidate for an experiment, never a justification on its own.

## 11. Context efficiency is an outcome, not a diagnostic

Experiments compare `toolResultBytes` and `compactions` alongside turns and tokens. Three
rules follow:

- **An arm may win on context alone.** Fewer compactions at equal turns is a real win: a
  compaction costs a summarisation call _and_ degrades every subsequent turn, because the
  agent then works from a lossy paraphrase.
- **An arm that wins on turns while materially increasing context burn is unproven**, not
  victorious. Report both and say which you are claiming.
- **Zero is ambiguous.** Context metrics come from the session event log; if it is absent
  they read zero. "No compactions" and "no telemetry" must never be reported as the same
  thing.

## 12. Every investigation improves the telemetry

The velocity engineer is responsible for the instruments as well as the readings.

- If a question could not be answered from existing data, the **first deliverable is the
  missing measurement**. Concluding from a number you could not observe is prohibited.
- Direction and goals are argued from **real session data** read through
  `.github/extensions/agent-perf-panel/`, not from taste.
- Every investigation lands **one concrete panel improvement with a test**: a new metric, a
  sharper breakdown, a fixed misattribution, or a removed misleading display. An
  investigation that genuinely needed none must say so explicitly and justify it.
- A new panel metric is verified against a **real session**, not only a fixture. A metric
  that passes unit tests and reads zero in production is worse than no metric, because it
  looks like data.
- A metric the lab should compare is added to `ContextMetrics` and `COMPARED_METRICS` in
  the same change, so the panel and the lab cannot drift.

---

## Related

- `.github/agents/velocity-engineer.agent.md`
- `.github/skills/bottleneck-scan/SKILL.md`
- `.github/skills/task-pack-builder/SKILL.md`
- `.github/skills/velocity-lab/SKILL.md`
- `.github/skills/session-telemetry/SKILL.md`
- `.github/extensions/agent-perf-panel/README.md`
- `docs/agent-os/policies/complexity-policy.md`

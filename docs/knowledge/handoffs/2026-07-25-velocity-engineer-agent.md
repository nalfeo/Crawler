# Velocity engineer agent + A/B trial lab

**Date:** 2026-07-25
**Apples:** 3🍎 estimated → 4🍎 actual
**Persona:** Producer → tooling

## Systems touched

agent-os, tooling

## What shipped

A `velocity-engineer` agent whose job is to find and remove bottlenecks in feature
delivery — technical (system design, refactoring, component contracts, test strategy) and
process (review latency, guard friction, estimation drift) — and to **prove** each fix with
a real A/B experiment rather than an argument.

Four skills (`bottleneck-scan`, `task-pack-builder`, `velocity-lab`, `session-telemetry`),
a policy doc, and a working harness in `scripts/agent/velocity/` (8 modules, 118 unit tests).

### The lab

`npm run velocity:experiment -- --spec <spec.json>` runs a multi-arm A/B and emits a
verdict report. A task is a **replayed merged PR**: snapshot the repo at the PR's parent
commit, seed only the PR's test files as a frozen verifier, run a real headless
`copilot -p` session in that snapshot, and measure turns/tokens/cost/context to first
green. Arms are compared with Cliff's delta plus a bootstrap CI — never a p-value.

Design constraints enforced in code:

- **One-factor rule** (`assertOneFactor`) — an experiment varies environment _or_ model
  config, never both. The harness refuses a two-factor verdict.
- **Frozen verifier** — extracted and hashed at pack-build time, before arms exist.
- **Fail-to-pass validation** (`velocity:pack verify-base`) — a task whose verifier already
  passes at base measures nothing and is rejected.
- **Nothing silent** — crashed, leaked, budget-capped, and context-unmeasured trials are
  each excluded from the relevant statistic _and_ named in an explicit warning.

## Observe before done

The harness was validated by running it, not by reading it. Five end-to-end runs, each
surfacing a defect invisible to inspection:

| Run | Symptom                           | Root cause                                                                  |
| --- | --------------------------------- | --------------------------------------------------------------------------- |
| 1   | 0 turns, silent                   | multi-line prompt mangled by `shell:true`; stderr discarded                 |
| 2   | "prompt was not quoted"           | `spawnSync(cmd, args, {shell:true})` concatenates args **without escaping** |
| 3   | stopped after 3 turns             | hit `maxAiCredits: 40` (3 turns ≈ 41 credits)                               |
| 4   | **green**                         | hard gate met                                                               |
| 5   | **green**, with context telemetry | re-proved after the context/env changes                                     |

Final run: both arms green, 10 vs 9 median turns, 4.3K vs 20.5K output tokens, context
columns populated (62.2 / 61.7 KB), sinks section naming a real tool (`view: 44.2 KB`),
zero leak flags, `INCONCLUSIVE` verdict — correct at n=1.

## Findings worth keeping

**Leak prevention is not achievable in-process; detection is.** Three results, all
verified empirically, not assumed:

1. Unsetting `GH_TOKEN`/`GITHUB_TOKEN` does **not** stop `gh` — it falls back to the OS
   keyring and authenticates anyway.
2. Unauthenticated `git ls-remote` against a public repo succeeds, so no credential control
   helps at all.
3. Poisoning the token with an invalid value _does_ block `gh` — and also breaks the
   Copilot CLI under test, which needs a valid token to start.

The agent's auth credential **is** the credential that can fetch the solution. So the
harness audits transcripts for the solution SHA, the PR number, and attempted remote access
(`gh pr/api`, `git fetch/ls-remote`, `curl` to github), and excludes flagged trials. The
residual risk is disclosed in the policy rather than papered over.

**Context cost and latency cost rank differently.** On a real session, the slowest tools
were `read_powershell, ask_user, powershell` while the biggest context consumers were
`grep (71KB), powershell (61KB), view (38KB)`. The perf panel only ranked by latency, so it
would have missed the actual compaction cause. It now aggregates per-tool result bytes and
ranks a "biggest context sinks" panel — verified against a real session, not a fixture.

**Peak context is only observable at compaction boundaries.** `preCompactionTokens` exists
only in `session.compaction_complete`. A session that never compacted reports 0, meaning
"never measured". The first `context.ts` draft assumed fields that do not exist
(`tool.execution_complete` has no `toolName`; `assistant.message` has no `inputTokens`) and
had to be rewritten against a verified log.

## Review

Plan review (gpt-5.5): 4 blocking + 2 non-blocking. The two structural ones changed the
design — the lab was demoted from arbiter to **pre-screen** (a lab win must be confirmed by
a field signal before it counts), and leak handling was redesigned from prevention to
detection.

Code review, 2 rounds, 2 different models, 3 High-severity bugs — all the same root cause:
**a failure being reported as a legitimate zero.** A crashed launch entered the medians as
the fastest run; a missing event log made an unmeasured arm the most context-efficient; and
a crashed or leaked trial still inflated the arm's pass rate. All three fixed with
regression tests.

## Known gaps

- Compaction metrics are code-tested but **never field-observed** — no trial has compacted.
- `--deny-tool` glob support (`github-mcp-server-*`) unverified; tools are listed individually.
- Trials are not network-sandboxed, and a public repo may be memorised. Disclosed, not fixed.
- `node_modules` is junctioned rather than installed; `--install` is the escape hatch.
- Each trial is a live agent session (~2.5 min), so a 2×3×3 matrix is 18 sessions. Budget
  accordingly, and prefer `trials >= 3` before believing any verdict.

## Next

Run a real experiment with `trials: 3` on a hypothesis that matters — the obvious first
candidate is whether the repo's own instruction surface area helps or hurts turns to green.

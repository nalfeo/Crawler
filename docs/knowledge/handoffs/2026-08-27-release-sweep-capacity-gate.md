# Handoff: Release-sweep runner-capacity gate

## Date

2026-08-27

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 estimated / 2🍎 actual — exact. Tooling/CI-only: one new admission script,
one workflow job, three test files, one policy-doc section. Per the review
harness policy, a 1–2🍎 change carries no review ledger.

## Outcome

The release sweep (`release-report-sweep` — 30 shards at `max-parallel: 20` —
plus `baseline-sweep`) fired on every push to main and could hold the entire
20-runner GitHub Free pool for up to an hour, starving CI and development
(nalfeo/Crawler#3774). `deploy.yml` now runs a `sweep-capacity-gate` job first:

```
constrained = queuedJobs > RELEASE_SWEEP_MAX_QUEUED_JOBS (0)
              || nonSweepJobs + latentBacklog > RELEASE_SWEEP_MAX_COMPETING_DEMAND (4)
sweep       = !constrained || hoursSinceLastBaseline >= RELEASE_SWEEP_MIN_INTERVAL_HOURS (24)
```

Queue depth is the primary signal (review feedback on the PR): a _running_ job is
already being served, but a _queued_ job is work blocked on a full pool that the
sweep would push further back. `inspectRunnerDemand` therefore reports
`queuedJobs` (non-sweep jobs in `queued`/`waiting`/`requested`/`pending`)
separately from total active claim, and a single waiting job constrains the pool
by default. Total claim plus latent CI backlog stays as the secondary signal for
a pool that is about to saturate before anything has queued.

Both sweep jobs `needs` that gate and skip together, so a partial baseline can
never be published. Demand is measured with the existing probes in
`.github/scripts/sweep-budget.mjs` (`inspectRunnerDemand` +
`inspectLatentBacklog`); the deploy run's own jobs are excluded via the new
`excludeRunIds` option so the gate does not measure itself as pressure.
"Last sweep" is the commit date of the `baselines` branch tip, which only a
completed `baseline-sweep` writes.

## Fail-open contract

Skipping is an optimization; losing the baseline series is a release-blocking
regression signal. Every uncertain path therefore sweeps:

- runner-demand, latent-backlog, or `baselines` branch probe failure → warning + sweep
- no baseline has ever been published → sweep
- admission script throws → warning + `should_sweep=true`
- gate job infrastructure failure → `fallback` step publishes `should_sweep=true`,
  and the job is `continue-on-error` so it cannot redden the release
- manual `workflow_dispatch` → always sweeps (explicit operator intent)

## Knobs

`RELEASE_SWEEP_MIN_INTERVAL_HOURS` (24) and `RELEASE_SWEEP_MAX_COMPETING_DEMAND`
(4) are repository variables with fail-safe parsing, documented in
`docs/agent-os/policies/ci-config-knobs.md`. `RELEASE_SWEEP_PEAK_RUNNERS` (20)
is structural — it mirrors the report matrix's `max-parallel` and is pinned to
it by a parity test.

## Verification

- `node --test .github/scripts/release-sweep-admission.test.mjs` — 13/13 passed
  (threshold boundary, 24h override boundary at ±1 minute, unknown last sweep,
  malformed inputs, baselines-branch read, self-exclusion, probe failure,
  GITHUB_OUTPUT contents, multi-line reason sanitisation, knob parsing).
- `npx vitest run tests/unit/release-sweep-capacity-gate.test.ts
tests/unit/deploy-workflow-gating.test.ts tests/unit/ci-knobs-guard.test.ts` —
  passed.
- `npm run verify:fast` — passed.
- Pre-existing: `npm run test:guards` reports 44 failures in the sprite-editor /
  set-piece extension suites. Confirmed identical (44) on a stashed clean tree,
  so they are environmental in this sandbox and untouched by this change.

## Observe before done

No visual or gameplay surface; the real artifact is the GitHub Actions release
pipeline, which cannot be executed locally. The gate script was exercised as a
real process end-to-end (`node .github/scripts/release-sweep-admission.mjs` with
`GITHUB_OUTPUT`/`GITHUB_STEP_SUMMARY` set and no token): it emitted the warning
annotation, wrote `should_sweep=true`, and exited 0 — the fail-open path. Its
decision behavior under live demand is covered by the mocked-API unit tests, and
its wiring into `deploy.yml` by the parity test.

## Blockers

None. After merge, watch a release run's "Release sweep admission" step summary
to confirm the measured demand looks sane before tuning
`RELEASE_SWEEP_MAX_COMPETING_DEMAND`.

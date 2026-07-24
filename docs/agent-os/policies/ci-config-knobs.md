# CI Recovery capacity + prioritization knobs (invariant baseline)

This policy consolidates the runtime-tunable dispatch-cap knobs and the
must-preserve CI-recovery invariants locked by regression tests.

## Runtime knobs (router)

These repository variables are read by
`.github/workflows/ci-recovery-router.yml` and resolved in
`.github/scripts/ci-recovery/router.mjs` via `resolveGlobalDispatchCaps(env)`.
They intentionally scope to the **router admission path**; reconcile-side
`buildGatedDispatchRecovery` continues to use the static safety export
`GLOBAL_TRAIN_DISPATCH_CAP`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_BUSY` | `5` | Max load-aware dispatch budget while merge-train queue is non-empty. |
| `CI_RECOVERY_MAX_DISPATCH_BUDGET_TRAIN_IDLE` | `8` | Max load-aware dispatch budget while merge-train queue is empty. |
| `CI_RECOVERY_GLOBAL_TRAIN_DISPATCH_CAP` | `5` | Additional hard clamp for train-busy dispatch budget. |
| `CI_RECOVERY_MAX_DISPATCH_PER_RUN` | `8` | Pre-budget admission slice limit for schedule/workflow_dispatch sweeps. |

Invalid / non-positive values fail closed to defaults.

## Must-preserve invariants

The redesign must preserve these behaviors; deleting any mechanism must fail at
least one regression test:

1. Load-aware dispatch budget caps (`5/8`, global train clamp `5`, default
   per-run admission `8`).
2. Review-round throttle (one Copilot review run per PR conflict/head episode).
3. Per-PR concurrency (parallel across PRs, serialized within a PR).
4. `expected_head_sha` fail-closed binding.
5. CI-fix-first + blocked-PR exclusion + global FIFO admission.
6. Superseded-run cancellation + impact-gated CI dispatch.
7. Thundering-herd backpressure and queue-aware sweep behavior.

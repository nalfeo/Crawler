# 2026-09-05 Goobers Phase 4: legacy lifecycle decommission gate

## Summary

Shipped the Phase 4 mechanism for epic #3838 / issue #3839: a deterministic,
fail-closed gate that decides when the legacy `ci-recovery*`/`merge-train*`
lifecycle mutation paths may be decommissioned, plus a surface scan that blocks
the two states that are never safe.

The literal deliverable ("remove the legacy mutation jobs") was **deliberately
not executed**, and this is the important decision to carry forward: per
`docs/runbooks/ci-mutation-bridge-runbook.md`, only Lane A (review threads) is
migratable today; Lanes B (CI recovery), C (merge-train admission) and D
(promotion) are still legacy-owned. Deleting those jobs now would leave those
lanes with **zero** writers and take PR automation dark. The epic's own
acceptance criteria also gate removal on a completed soak and a passing rollback
drill — operational events that have not happened. So removal is now data-gated
on committed evidence instead of prose.

## Systems touched

ci-policy

## What changed

- `.github/scripts/lifecycle-decommission.mjs` (new): pure
  `decideLegacyDecommission({ state, now, soakDays })` returning every blocker
  (not just the first), plus `evaluateLegacyMutationSurface({ workflows, state })`
  which parses the real workflow YAML and reports:
  - `ungated-legacy-mutation` — a legacy mutation step not gated on its **own**
    lane selector plus `LEGACY_CI_MUTATION_BRIDGE_ENABLED` (dual-writer risk);
  - `decommissioned-without-migration` — a legacy mutation path deleted while
    the record still shows the lane legacy-owned (zero-writer risk);
  - `unparseable-workflow` — a finding, never a crash.
    A CLI exits `2` on any surface finding and `1` with `--require-ready` when not
    ready, so the readiness report is informational until an operator opts in.
- `.github/lifecycle/decommission-state.json` (new): the operator-attested
  evidence record (lane owners, soak, rollback activations, drill, bounded
  emergency bridge, branch-protection contexts). Today it records reality, so
  the gate reports `ready: false` with explicit blockers.
- `package.json`: `npm run check:legacy-decommission`; documented in the
  `AGENTS.md` command table.
- `docs/runbooks/ci-mutation-bridge-runbook.md`: new "Phase 4 — decommission"
  section (preconditions table, rollback-drill procedure, steady-state and
  emergency operations post-decommission), plus a Known-limitations pointer.
- `.github/scripts/lifecycle-decommission.test.mjs` (new): 13 tests covering
  fail-closed inputs, literal-`goobers`-only lane migration, soak arithmetic,
  rollback-activation windowing, drill evidence rules, bounded-bridge and
  branch-protection requirements, all three surface findings against the
  **real** workflow files, and CLI argument validation.

## Mutation-surface detection

A step counts as a legacy lifecycle mutation when its `run` script or
`actions/github-script` body contains a registered entrypoint, so renaming a
step cannot hide it:

| Workflow                 | Lane            | Entrypoints                                          |
| ------------------------ | --------------- | ---------------------------------------------------- |
| `ci-recovery.yml`        | `ci-recovery`   | `ci-recovery/reconcile.mjs`                          |
| `ci-recovery-router.yml` | `ci-recovery`   | `ci-recovery/router.mjs`                             |
| `merge-train.yml`        | `merge-train`   | `merge-train/reconcile.mjs`, `quarantine-repair.mjs` |
| `auto-rebase-prs.yml`    | `branch-update` | `/update-branch`                                     |

The `review-threads` lane has no workflow-level entry because its gate lives
inside `reconcile.mjs` (`legacyReviewThreadWritesEnabled`), already covered by
`ci-recovery/reconcile.test.mjs`.

## Explicitly deferred (out of scope)

- Actually disabling/removing any legacy mutation job — blocked by the gate
  until Lanes B/C/D migrate, the soak completes, and the drill passes.
- Running the soak and the rollback drill (operational, needs repo-variable
  write access).
- Updating branch-protection required checks to the final Goobers contexts
  (operational; recorded in the evidence file when done).

## Verification

- `node --test .github/scripts/lifecycle-decommission.test.mjs` — 13/13 pass
- `node .github/scripts/lifecycle-decommission.mjs` — reports the real surface
  (4 workflows, 5 gated mutation steps, zero findings) and `ready: false` with
  the honest blocker list; exit 0
- `npm run test:guards` — 2872 pass; the 44 failures are pre-existing sandbox
  environment failures in the sprite-editor/canvas extension suites
  (`browserType.launch: Executable doesn't exist ... chrome-headless-shell`,
  i.e. Playwright browsers not installed here), untouched by this change
- `npx eslint .github/scripts/lifecycle-decommission*.mjs --max-warnings 0` — clean
- `npx prettier --write` on all new/changed files

# Handoff — Local Goobers follow-up and PR reconciliation

## Systems touched

- workflow-automation
- local-runtime
- CI-policy

## Summary and files touched

- `.goobers/gaggles/crawler/` now runs implementation and PR remediation on
  ten-minute schedules, with per-workflow limits of one issue and four PRs.
  The workflow YAML also carries stage-specific safety assertions and the
  gaggle no longer declares two inert credential references.
- `.goobers/manifest.yaml` acknowledges three deliberately manual-only
  lifecycle/review workflows; their GitHub Actions wrappers dispatch them.
  This is not an autonomous scheduling change.
- `.goobers/instance.yaml.example` raises the persistent local daemon's
  global capacity from one run to five, enough for one implementation plus
  four remediations. `.github/workflows/goobers-run.yml` reapplies the hosted
  single-run cap **after** materialization replaces each slot's manifest.
- `tests/unit/goobers-pr-remediation.test.ts` and
  `tests/unit/goobers-run-workflow.test.ts` check the local sum and effective
  hosted cap, including the post-materialization ordering.
- The WSL instance was materialized and restarted. Source and live Goobers
  diagnostics fell from 32 config warnings to zero; the portal responded with
  HTTP 200 at `127.0.0.1:8081`.
- PR #4772 was rebased onto current `main` on 2026-09-26. Its original feature
  commit had already merged as #4714; two follow-ups were also upstream, so
  Git dropped those duplicates and replayed five remaining commits without
  manual conflict edits.

## Verification

- `goobers validate --json --source-tree --instance ... .goobers`: zero errors
  and zero warnings after the rebase.
- Focused Goobers concurrency and hosted-slot tests passed after the rebase.
- `npm run verify:fast` passed after the rebase; `git diff --check` passed.
- PR prerequisites passed after adding this single branch handoff. Ducky's
  full-branch review found two follow-up issues: the backlog-claim test mock
  did not emit its required result file, and the hosted Copilot overlay left
  a Codex-only sandbox option behind. Both were repaired; targeted tests pass.
- The full Goobers unit file still has two Windows Bash-path-sensitive failures
  in unchanged hosted-runner test paths. The Linux CI environment is the
  authoritative gate for those paths; do not weaken the assertions to make
  this Windows run green. A second `npm run verify:fast` after the review fixes
  reached these same two failures; its type/lint phase passed.

## Authorizations and constraints

- The user explicitly requested local Goobers for Crawler, ten-minute
  implementation/remediation schedules, one implementation issue at a time,
  four concurrent remediation PRs, and resolution of PR #4772's conflicts.
- Crawler's agent contract pre-authorizes implementation commits, pushes, and
  ready-for-review PR publication without a separate approval. No merge of
  PR #4772 is authorized by this handoff; the repository merge train owns it.
- The authorized target is `nalfeo/Crawler`, branch
  `codex/local-goobers-reconciliation`, PR #4772, and the local WSL instance
  `/root/.local/share/goobers/crawler`.

## Unresolved issues and next steps

- The implementation run for issue #4519 still escalates because its boss-fight
  duration success criterion is missing. The ten-minute scheduler is running;
  capacity does not resolve that product requirement.
- Five simultaneous heavy stages have not been load-tested on the 15 GiB WSL
  VM. Retain the per-stage memory bound and observe actual peak use.
- Static safety assertions are author statements, not runtime proof of
  provider delivery. Update them when command effects change.
- Portal logs separately reported malformed telemetry database reads before
  this work; telemetry integrity was outside the config-warning repair.

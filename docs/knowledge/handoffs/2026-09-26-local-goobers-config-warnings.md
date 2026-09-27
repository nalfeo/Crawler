# Handoff — Local Goobers config warnings

## Systems touched

- workflow-automation
- local-runtime

## Summary

- Removed two inert gaggle `connectionRef` declarations. The local instance's
  `repos[]` token reference remains the credential authority.
- Added stage-specific safety effect assertions for custom Crawler commands and
  preserved remediation's explicit subject-patch assertion. These describe
  author-verified stage behavior for Goobers' static advisory analysis; they do
  not change execution or prove provider delivery.
- Acknowledged the three deliberately manual-only lifecycle/review workflows
  at manifest level. Their GitHub Actions wrappers dispatch them explicitly;
  no autonomous schedule was added.
- Reduced source and live-instance config diagnostics from 32 warnings to 0.

## Validation and deployment

- `goobers validate --json --source-tree --instance ... .goobers`: 0 errors,
  0 warnings.
- `npm run verify:fast`, `npm run verify:pr-prereqs`, and `git diff --check`
  passed. The fresh Ducky review found no actionable regressions.
- Ducky's extra Goobers workflow test invocation passed 102/105 cases; three
  existing Bash/Windows path-sensitive cases in the unchanged hosted runner
  failed. No executable workflow spec changed in this patch.
- Waited for the active implementation run to finish, stopped the Goobers user
  service, materialized `.goobers` into the WSL instance, and restarted both
  daemon and portal. Live `goobers status --json` reports 0 warnings across
  5 workflows, and the portal responds with HTTP 200 at `127.0.0.1:8081`.
- The local runtime root is `/root/.local/share/goobers/crawler` in
  Ubuntu-24.04 WSL. The daemon is managed by `goobers.service`; the portal by
  `goobers-dashboard.service`. Stopping the daemon also stops the portal, so
  start both services after a materialization cycle.

## Follow-up

- Safety assertions are static author statements. If a stage's command or
  effect changes, update its assertion and revalidate before deployment.
- Portal logs separately reported malformed telemetry database reads before
  this change. The portal currently serves HTTP 200; telemetry integrity was
  not within this config-warning repair.

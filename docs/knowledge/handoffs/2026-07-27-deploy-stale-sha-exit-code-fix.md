# Deploy: fix stale-SHA abort to exit gracefully instead of failing

**Date:** 2026-07-27
**Apples:** 1🍎 estimated → 1🍎 actual
**Persona:** CI Recovery

## Systems touched

ci-deploy

## Why

The "Deploy to GitHub Pages" workflow was intermittently reporting `failure` when
triggered by a merge that was immediately superseded by a newer merge (race condition
during high-throughput merge-train runs). The workflow had a late-stage "Final
latest-tip guard" step designed to abort the deploy when a newer commit has already
landed — a correct and intentional behavior — but it exited with code 1 (`exit 1`)
instead of signalling "skip and succeed". This caused the CI incident bot to file
issue #2079 on every such race.

The guard comment already said "B's run will handle this release" — this was clearly
meant to be a graceful abort, not a failure.

## What shipped

Single file changed: `.github/workflows/deploy.yml`

1. **Added `id: tip-guard`** to the "Final latest-tip guard" step so downstream
   steps can reference its output.
2. **Replaced `exit 1`** with `echo "skip=true" >> "$GITHUB_OUTPUT"` (natural exit 0).
   Changed the message level from `::warning::` to `::notice::` since this is
   expected and non-actionable.
3. **Added `if: steps.tip-guard.outputs.skip != 'true'`** conditions to:
   - "Upload artifact" — prevents stale site from being uploaded
   - "Deploy to GitHub Pages" — prevents stale deploy
   - "Select released PR targets" — prevents labelling PRs with empty URL
   - "Label and comment on released PRs" — prevents empty-URL comments on PRs

## Verification

- `npm run verify:fast` passes (1719 tests, 0 failures)
- Secret scan: clean
- Scenario trace (stale SHA race): guard sets skip=true, all four guarded steps are
  skipped, retry/wait steps are skipped (deployment.outcome='skipped'), job completes
  SUCCESS, no CI incident triggered.
- Scenario trace (fresh SHA): guard exits 0 without setting skip, all steps run
  normally.
- Scenario trace (workflow_dispatch): guard step is skipped (if: condition false),
  skip output is empty, all steps run normally.

## Edge cases handled

- **workflow_dispatch**: tip-guard step `if:` condition is `github.event_name !=
'workflow_dispatch'`, so it's skipped entirely. `steps.tip-guard.outputs.skip` is
  empty, which evaluates `!= 'true'` as true → all downstream steps run. ✓
- **MAIN_SHA resolution failure**: original `|| true` fallback means MAIN_SHA is
  empty. The stale check `[ -n "$MAIN_SHA" ] && [ "$RUN_SHA" != "$MAIN_SHA" ]` is
  false when MAIN_SHA is empty → no skip set → deploy proceeds. Same behavior as
  before this fix. ✓

## Files changed

- `.github/workflows/deploy.yml`

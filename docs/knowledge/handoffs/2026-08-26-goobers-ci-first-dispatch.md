# Goobers CI: first live dispatch, gate schema fix

## Systems touched

agent-tooling, ci

## Summary

First actual dispatch of the `Goobers Validate` workflow on a GitHub-hosted
runner. The CI infrastructure landed in PR #3563 worked on the first try —
pinned release download, independent SHA256 verification, version-keyed cache,
and `goobers validate --source-tree .goobers` all executed correctly.

It immediately caught two **real, pre-existing schema errors** in the
checked-in `.goobers/` source tree that had never been validated anywhere. The
`crawler-feature-pr` workflow could not have run at all in its committed state.

### The two errors

```
ERROR Workflow/crawler-feature-pr: /spec/gates/2/automated: additionalProperties 'output', 'equals' not allowed (line 156, col 9)
ERROR Workflow/crawler-feature-pr: gate "pr-opened-gate": branch "infra" is not a producible outcome for this evaluator (never taken)
```

1. **`output-equals` params were in the wrong place.** They belong under
   `params:` as `key`/`equals`, not as top-level keys on the `automated` block.
   Confirmed against `AutomatedGate.Params` in the Goobers API types
   (`api/v1alpha1/workflow_types.go`) and the `output-equals` implementation in
   `internal/gate/automated.go`.

2. **The `infra` branch was structurally unreachable.** `output-equals` only
   produces `pass`/`fail`. Goobers validates that every declared branch is a
   producible outcome for its evaluator, so a dead `infra` branch is an error,
   not a warning.

Routed `fail` → `needs-remediation` (rather than the previous `@abort`) so a
failed PR-open escalates for remediation instead of silently aborting the run.

## Files touched

- `.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml` — fixed the
  `pr-opened-gate` schema (the only net change on this branch vs `main`).

Also done outside the repo diff:

- Created the four backlog labels the `backlog-query` task depends on, none of
  which existed: `goobers:approved`, `goobers/status:in-review`,
  `goobers/status:needs-human`, `goobers/status:needs-remediation`.
- Filed issue #3639 (periodic rat attack waves, feature-flagged, safe-room
  suppressed) labeled `goobers:approved`, as the first real backlog item for the
  autonomous flow to claim.

## Verification

- `Goobers Validate` on `main` → **failure** (the two errors above), run
  `33008113986`.
- `Goobers Validate` on this branch after the fix → **success**, run
  `33008634629`.

This is a real before/after on the actual artifact, not a local-only check.

## Unresolved issues

- **`goobers-run.yml` has never completed a live run.** Only the validate
  workflow is proven. The run workflow requires a `GOOBERS_GITHUB_TOKEN` secret
  (a PAT/App token with Contents/Issues/Pull-requests read-write) which is not
  yet configured; `COPILOT_GITHUB_TOKEN` is configured. The workflow fails fast
  with a clear message when the token is absent, so this is a clean blocker
  rather than a deep mid-run failure.
- The deliberate design choice in `goobers-run.yml` is to require a PAT rather
  than widen `permissions: contents: write` on the built-in `github.token`,
  because a `GITHUB_TOKEN`-authored push does not trigger the normal CI
  workflow. Do not "simplify" this to `contents: write` — it would produce a
  branch whose CI never runs.

## Recommended next steps

1. Configure the `GOOBERS_GITHUB_TOKEN` secret, then dispatch
   `goobers-run.yml` to exercise the full claim → plan → implement → review →
   PR loop against issue #3639.
2. Expect further schema/runtime findings on that first run — the validate pass
   only proves the config parses, not that every task's runtime contract holds.
3. Consider making `goobers-validate.yml` a PR-triggered check on
   `.goobers/**` so a malformed source tree can never merge again. It is
   currently `workflow_dispatch`-only, which is exactly how these two errors
   reached `main` in the first place.

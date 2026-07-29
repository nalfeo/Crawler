# Handoff: Merge the two behavior-tree labs into one

**Date:** 2026-06-28
**Branch:** nalfeo-verbose-engine
**Apple estimate:** 🍎🍎 · actual 🍎🍎 (on)

## Systems touched

ai-behavior-tree, devtools

## Summary

The codebase has exactly one AI tree: `BehaviorTreeAI` builds a single
`Parallel(OBSERVE)` root with Track A (priority selector) + Track B
(opportunistic overlay). The two BT labs (`bt-viz`, `parallel-bt`) were both
visualizing that same tree, so they were merged into one `bt-viz` lab. There is
no remaining "single BT" code path; the old flat selector is now Track A.

`bt-viz` is now the superset: Track A decision state + reason + target, Track B
collect/farm/dodge debug, the compass vector overlay (raw vs blended), and the
tree dump with Track A/B highlighting + legend. Kept the `bt-viz` id since it is
referenced by `scripts/agent/pr-lab-links.mjs` and ADR-0014.

## Files touched

- `src/labs/bt-viz-lab/index.ts` — rewritten as the merged superset lab.
- `src/labs/bt-viz-lab/README.md` — new, documents the merged lab.
- `src/labs/parallel-bt-lab/index.ts` — deleted.
- `src/lab-main.ts` — removed the `parallel-bt` module-path entry.

## Verification

- `npm run verify:fast` — pass (typecheck + lint + unit).
- Headless observe via bundled chromium at `/lab.html?lab=bt-viz`: panel renders
  (header "Behavior Tree Visualization", Track A=EXPLORE, compass, Track B
  values, legend, highlighted tree); AI drives player; zero console errors.
- `npm run verify` full: all gates pass except the headless Floor 1 wall-clock
  perf guard (seed 42 baseball-bat 32-39s vs 30s budget). Frame count is the
  deterministic 15582 either way; only wall time varies under machine
  contention. A dev-lab merge cannot affect AI sim, so the budget was left
  untouched (rule 12).

## Unresolved / next steps

- The wall-clock guard is flaky on this contended Windows worktree; if it trips
  in CI, profile the AI rather than raising the budget. Not caused by this PR.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "deny": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```

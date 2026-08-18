# Handoff: Baseline viewer loading

## Systems touched

devtools, ai-combat-balance

## Apples

2 estimated, 2 actual (exact).

## What changed

The Sweep Results Viewer now adds a Repository branch source that reads the
committed `origin/baselines` data store without checking out that branch. It
uses `index.json` to list historical snapshots and loads the selected
`by-sha/<commit>.json` artifact for a baseline summary and per-weapon win-rate
table. Existing GitHub Actions `runId` selection and attached-session local
results are unchanged.

## Validation

- `npm run test:sweep-viewer` passed (58 tests).
- The live viewer loaded the latest `origin/baselines` snapshot: 583/600 wins
  (97.17%) from `by-sha/4046f454aba8190ce05890209a99c0b8ae51f662.json`.

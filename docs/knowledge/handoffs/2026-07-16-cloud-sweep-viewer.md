# Handoff: Cloud sweep results viewer

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

devtools, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual (exact).

## What Was Done

Extended the project-scoped Sweep Results Viewer canvas to load weapon-sweep
results directly from GitHub Actions without manual artifact downloads.

- Resolves the attached canvas session's repository and branch from the SDK
  working directory, then selects the newest active branch run, newest branch
  run, or newest repository run in that order.
- Lists every `weapon-sweep.yml` workflow run newest-first and supports explicit
  run selection.
- Polls active runs every 30 seconds, publishes partial aggregate artifacts as
  they become available, performs bounded terminal artifact stabilization, and
  stops polling after terminal completion.
- Downloads aggregate artifacts through authenticated provider-side `gh`
  subprocesses, validates compatible sweep parameters, and merges all available
  weapon results.
- Preserves local JSON loading through `load_file`, `reload`, and the path input.
- Protects loopback HTTP and SSE routes with a per-instance capability token,
  redacts credentials from surfaced errors, bounds parsed artifact caching, and
  keeps GitHub credentials out of renderer HTML.
- Restored the sword icon in the canvas tab title (`🗡️ Sweep Results`).
- Added 16 deterministic extension tests and wired them into the guard suite.

## Files Touched

- `.github/extensions/sweep-results-viewer/extension.mjs`
- `.github/extensions/sweep-results-viewer/renderer.mjs`
- `.github/extensions/sweep-results-viewer/lib/cloud-results.mjs`
- `.github/extensions/sweep-results-viewer/lib/github-client.mjs`
- `.github/extensions/sweep-results-viewer/lib/http-security.mjs`
- `.github/extensions/sweep-results-viewer/tests/cloud-results.test.mjs`
- `.github/extensions/sweep-results-viewer/tests/github-client.test.mjs`
- `.github/extensions/sweep-results-viewer/tests/renderer.test.mjs`
- `package.json`
- `docs/knowledge/review-ledgers/2026-07-16-cloud-sweep-viewer.review-ledger.json`

## Runtime Observation

Observed the real `project:sweep-results-viewer` canvas after reloading the
extension:

- The host opened the tab as `🗡️ Sweep Results`.
- GitHub Actions run `29477221792` loaded automatically from `nalfeo/Crawler`
  with status `completed · success`.
- The aggregate view returned all six weapons (`sword`, `baseball-bat`, `pistol`,
  `bow`, `fireball`, and `throwing-knife`) with 100 runs each.
- The cloud selector returned all five available workflow runs newest-first,
  including active run `29484773145`.
- Local-file loading remained functional during implementation observation.

Before this change the canvas required a local sweep JSON path. Afterward it can
discover, select, monitor, and render GitHub Actions sweeps directly.

## Verification Run

- `npm run test:sweep-viewer` — 16 tests passed.
- `npm run verify:fast` — passed.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-16-cloud-sweep-viewer.review-ledger.json`
  — valid 4🍎 ledger.
- Real canvas open and actions against GitHub Actions run `29477221792` — six
  aggregate rows and newest-first cloud run list observed.

## Review

The 4🍎 review harness completed an adversarial plan review, a two-round
single-model code-review loop, and a two-round multi-model review with
adjudication. All accepted concerns were resolved. The audit record is
`docs/knowledge/review-ledgers/2026-07-16-cloud-sweep-viewer.review-ledger.json`.

## Unresolved Issues

None.

## Recommended Next Steps

Use the viewer for future GitHub-hosted weapon sweeps; no manual artifact
download is required.

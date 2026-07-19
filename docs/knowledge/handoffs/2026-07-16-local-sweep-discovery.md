# Handoff: Local sweep discovery and floor provenance

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

devtools, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual (exact).

## What Was Done

- Changed the weapon-sweep CLI default from a shared temporary file to
  gitignored, worktree-relative `artifacts/weapon-sweeps/` output. Default names
  use a Windows-safe UTC run timestamp plus exclusive-create numeric collision
  suffixes; explicit `--out` and `--output` paths retain overwrite behavior.
- Added optional `floors` provenance to sweep results. New Floor-1 outputs emit
  `[1]`; shard and cloud aggregation validate, union, sort, and deduplicate
  present values. If any contributing legacy payload lacks metadata, the merged
  result omits the field instead of guessing.
- Added attached-session local discovery to the Sweep Results Viewer. It uses
  the exact SDK `ctx.session.workingDirectory`, scans only the direct
  `artifacts/weapon-sweeps/` directory, lists valid results by `runAt`
  newest-first, and reports every malformed or unreadable JSON file explicitly.
- Added Cloud/Local source and run selectors while keeping cloud as the default.
  Existing `load_file({ path })`, path input, and reload behavior remain
  compatible.
- Added a visible `Floors: <list>` pill for loaded cloud and local results;
  legacy missing provenance displays `Floors: Unknown`.

## Runtime Observation

Observed the real `project:sweep-results-viewer` canvas after reloading the
project extension:

- Opening without input remained cloud-first and loaded the session-aware cloud
  default.
- Switching to Local scanned only this worktree's canonical artifact directory
  and listed three valid fixtures newest-first. The first loaded normalized
  floors `[1, 2]`; selecting the second loaded `[1]`.
- Selecting the legacy local result returned `floors: null`, rendered as
  `Unknown`.
- `load_file` loaded an explicit absolute path, while an invalid JSON file
  returned a specific parse error and remained visible in the local error list.
- GitHub workflow run `29519223373`, dispatched from commit `e81c7be0` with one
  sword seed, completed successfully. Opening that run in the real canvas
  returned `floors: [1]`. An older pre-provenance cloud run returned
  `floors: null`, confirming legacy `Unknown` behavior.

Before this change, local sweeps overwrote `/tmp/weapon-sweep.json`, the canvas
had no attached-session local catalog, and result payloads could not identify
their included floors. Afterward, retained local and cloud results carry exact
floor provenance and are selectable from the same canvas.

## Verification

- `npm run test:sweep-viewer` — 27 tests passed.
- Focused weapon-sweep output/provenance unit tests — 14 tests passed.
- `npm run verify:fast` — passed after every implementation and review-fix
  round.
- Review ledger validation — valid 4🍎 ledger with adversarial plan review,
  two-round code review, and three-model adjudicated review.
- Real canvas local/cloud/legacy/error observations listed above.

## Review

- Adversarial plan review considered manifest-driven discovery, sidecar
  provenance, and a unified cloud/local descriptor model. The chosen design
  remained, with seven detail refinements adopted.
- The two-round code-review loop found and resolved three state defects:
  source-selector re-enable, local-discovery failure cleanup, and stale explicit
  reload errors.
- Three-model review produced one stale-base false positive against an unrelated
  deploy workflow change on newer `main`; adjudication found zero valid
  concerns.

## Unresolved Issues

None.

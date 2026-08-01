# Handoff: toadkin-bouncer asset request

## Date

2026-08-01

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

Estimated 3🍎, actual 1🍎 — scope collapsed to a single art-brief file because the
normal generation/check-in workflow is blocked in this sandbox.

## Summary

- Added a dedicated enemy brief at `briefs/enemies/toadkin-bouncer.yaml` for issue
  nalfeo/Crawler#2508.
- The brief encodes the requested front-facing Floor-2 toadkin bruiser silhouette:
  squat/wide build, velvet-rope bouncer jacket in dark purple/black with gold trim,
  visible brass knuckles, tiny earpiece, scowling amphibian face, single subject,
  hard pixel edges, and full containment inside the frame.
- Used `sizeVariant: wide` plus an explicit `sensors.enemy.facing: front` override to
  bias the pipeline toward the requested broad frontal silhouette while leaving the
  rest of the enemy defaults unchanged.
- Seeded 5 variations around the allowed pose space (`arms crossed` vs `fists raised`)
  so the judge has multiple silhouette-distinct candidates to compare.

## Validation

- `python` + `yaml.safe_load(...)` on `briefs/enemies/toadkin-bouncer.yaml` ✅
  - Parsed keys: `description`, `floor`, `minVariations`, `name`, `sensors`,
    `sizeVariant`, `type`, `variations`
  - Confirmed `type: enemy`, `name: toadkin-bouncer`, `floor: 2`, `variations: 5`
- `npm run sprites:run -- --brief briefs/enemies/toadkin-bouncer.yaml` ❌
  - Failed before brief execution because repo dependencies are not installed in this
    sandbox (`sh: 1: tsx: not found`).
- `npm run verify:fast` ❌
  - Failed for the same reason: missing repo dependencies (`typescript`, `eslint`,
    `@eslint/js` unavailable because the install step never completed).
- `npm ci` ❌
  - Blocked by network resolution failure fetching the package feed
    (`ENOTFOUND ms-feed-12.pkgs.visualstudio.com`).
- `npm run verify:pr-prereqs` ✅
  - Passed, and classified the diff as docs/art-only so a review ledger is not required.
- `parallel_validation` ✅
  - CodeQL skipped as trivial/art-only; code review returned no findings (the dedicated
    review binary is unavailable in this environment, so the validation surfaced no comments).

## Blockers / notes

- Could not post the requested pre-coding plan comment on issue #2508 from this
  sandbox. Direct GitHub API writes returned HTTP 403 due the DNS monitoring proxy,
  and the local `localhost:26831` remote is a git-only proxy / anonymous web mirror,
  not an authenticated issue-comment bridge.
- Because `npm ci` is network-blocked here, the normal sprite generation pipeline and
  repo verification scripts could not be run to completion in-session.

## Next steps

1. In an environment with the repo dependencies installed, run:
   `npm run sprites:run -- --brief briefs/enemies/toadkin-bouncer.yaml`
2. If Azure-backed sprite generation is available there, review the candidates,
   approve the chosen variant, and continue with the normal check-in flow.
3. Once approved art lands, replace the current generated-asset fallback for
   `toadkin-bouncer` (which currently resolves to `toadkin-tongue`) through the
   existing generated-art/check-in workflow rather than by hand-editing runtime data.

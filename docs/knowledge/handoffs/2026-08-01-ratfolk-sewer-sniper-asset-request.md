# Handoff: ratfolk-sewer-sniper asset request

## Date

2026-08-01

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

2🍎 exact — art brief + fixture entry + focused parser regression test.

## What Was Done

Handled issue #2559 (closes nalfeo/Crawler#2559) by following the established
asset-request brief pattern:

- Added the committed source brief `briefs/enemies/ratfolk-sewer-sniper.yaml`
  for the Floor 2 ratfolk ranged specialist.
- Added issue #2559's verbatim body to `tests/fixtures/asset-request-issues.json`.
- Added a focused parser regression test in
  `tests/unit/sprites/asset-request.test.ts` asserting that the issue text
  parses as `name=ratfolk-sewer-sniper`, `type=enemy`, `floor=2`,
  `sizeVariant=default`, with a byte-stable fingerprint
  (`ca795d3e6ff74ad177a8b718bb72fa81cb9701623e85bf02af4224b064fa2da4`).

## Key Decisions Made

1. **Brief-first**: the smallest correct repo change is to add the canonical
   authored brief. No generated-art mutation, no runtime alias wiring changed.
2. **Front-facing sensor override**: the issue explicitly requests
   `front-facing`, so `sensors.enemy.facing: front` / `toleranceDeg: 20` is set
   to target the right subject orientation without changing inherited dimensions.
3. **Default size**: issue specifies `Size: default` — no `sizeVariant` override
   needed; the `explicit sizeVariant=default` is captured in the fingerprint per
   the established pattern from llama-curb-stomper (#2505).
4. **5 variations**: enough silhouette-distinct candidates for the judge without
   inflating generation cost beyond the brief's detail level.

## Verification

- YAML parses cleanly via `python3 -c "import yaml; yaml.safe_load(open('briefs/enemies/ratfolk-sewer-sniper.yaml'))"` ✅
- Fingerprint cross-verified against the real `fingerprintAssetRequest` algorithm
  (node one-liner confirming `ca795d3e...`).
- `npm run verify:pr-prereqs` ✅ (both `[pr-preflight]` and `[pr-review-ledger]` pass)
- `npm ci` ❌ — network-blocked in this sandbox (ENOTFOUND ms-feed-12.pkgs.visualstudio.com);
  unit tests could not run locally. CI will exercise them.

## What's Next / Blockers

- Could not post the pre-code plan comment on issue #2559 from this sandbox
  (GitHub API write returns HTTP 403).
- To complete the full asset lane: generate, judge, approve, and check in
  dedicated `ratfolk-sewer-sniper` art in an environment with GitHub/Azure
  write access, then the normal check-in workflow will wire the generated PNG
  into the game without further manual edits to runtime data.

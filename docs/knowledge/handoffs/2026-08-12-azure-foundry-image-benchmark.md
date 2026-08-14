# Azure Foundry image-model benchmark readiness

Date: 2026-08-12

## Systems touched

sprites

## Scope

Requested A/B benchmark: three representative assets each for mobs, props,
visual effects, tilesets, and animated main-character walking sprites. Outputs
must be blinded and scored with a fixed rubric; no art approval or gameplay
asset changes are allowed.

## Findings

- Existing generation entry point: `npm run sprites:run -- --brief <path>`.
- Existing `--model` allowlist: `gpt-image-1`, `gpt-image-2`,
  `mai-image-2.5-flash`, `gpt-image-1-mini`, `mai-image-2.5`.
- The restored `foundry` backend intentionally reuses the verified Azure
  OpenAI-compatible `images/edits` route through `AzureOpenAIImageProvider`.
- Foundry text, vision, synthesis, and brief-selector providers remain
  explicitly rejected because their separate API contracts are unverified.
- `scripts/azure-foundry-plan.ps1` remains historical context; it does not
  describe the current live deployment cohort.
- Existing deterministic sprite sensors and the sprite-judge rubric can score
  generated candidates, but there is no benchmark runner that enumerates live
  deployments, anonymizes outputs, or aggregates blinded class/model scores.
- The repo has briefs for enemy/mob, prop, vfx, tile, and player walk-cycle
  classes. Tileset and animation handling need a benchmark-specific mapping
  decision because the standard sprite pipeline is primarily single-subject
  sheet slicing.

## Remaining blockers

1. `FLUX-1.1-pro` and `FLUX.1-Kontext-pro` cannot be deployed because Azure
   reports zero Requests Per Minute quota for both.
2. FLUX.2 and MAI 2.5 router calls through the regional model-inference route
   have not accepted a verified request shape; they are not silently treated
   as working candidates.
3. The benchmark runner still needs class-specific mappings for tilesets and
   animation, plus blind scoring and provenance aggregation.

## Commands and results

- `bash scripts/agent/preflight.sh` — passed.
- `npm run sprites:placeholder-audit -- --all` — passed; 88 placeholder-only
  concepts, 0 currently replaceable, 0 new-real-assets.
- `npm run sprites:run -- --help` — passed; confirmed current model allowlist
  and Azure OpenAI-only provider help text.
- `npm run test:sprites` — passed: 2,249 tests passed, 1 skipped.
- `npm run verify:fast` — passed.
- The existing-assets fixture and checker were removed because they could not
  support a valid model A/B claim.
- No generated art or gameplay assets were changed.

## Readiness recommendation

**Status: PARTIALLY RESTORED.** The OpenAI-compatible Foundry image path is
available for controlled generation, but no benchmark winner can be claimed
until each candidate produces fresh, post-processed, provenance-backed outputs.
No generated art was approved, queued, wired, or committed.

# Handoff: butcher-hook asset request

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

Estimated 🍎, actual 🍎.

## Summary

- Added a new weapon brief for `butcher-hook` scoped to the issue ask: one centered, silhouette-readable butcher-hook axe icon with transparent background and Floor 2 material tone.
- Enabled VLM judging in the brief (`judge.enabled: true`) and seeded two silhouette-distinct variation cues.
- Attempted to execute warmup+generation, but this runner has no Azure image credentials available to `sprites:run`, so generation/approval/check-in could not proceed in-session.

## Validation

- `npm run verify:fast` ✅
- `npm run sprites:run -- --brief briefs/weapons/iron-sword.yaml --brief briefs/weapons/butcher-hook.yaml --judge-budget-usd 1.50` ❌ (`Missing required env var 'AZURE_OPENAI_ENDPOINT'`)
- `npm run setup:azure:env` (CI env bootstrap path) confirms local `.env.local` provisioning is skipped in this cloud runner.

## Unresolved / next step

1. Re-run generation in an environment with Azure sprite credentials (`AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY`) and approve the winning `butcher-hook` variant.
2. Run `npm run sprites:checkin` then `npm run sprites:asset-pr` to land the art-only PR.
3. Verify runtime rendering for the `equipment/weapon/butcher-hook` consumer key after merge.

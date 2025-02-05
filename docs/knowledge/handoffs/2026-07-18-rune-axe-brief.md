# Handoff: rune-axe asset request brief

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

Estimated 1🍎, actual 1🍎.

## Summary

Added the committed sprite brief for `rune-axe` so the asset-request workflow has a canonical, issue-aligned source brief for runtime key `equipment/weapon/rune-axe`.

## Files touched

- `briefs/weapons/rune-axe.yaml`
- `docs/knowledge/handoffs/2026-07-18-rune-axe-brief.md`

## Verification run

- `bash scripts/agent/preflight.sh`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- Could not post the requested pre-code plan comment to issue #1425 from this sandbox because direct GitHub comment APIs are blocked by the environment proxy.

## Recommended next steps

1. Let the asset-request workflow ingest issue #1330 (authoritative duplicate target) so Azure generation can run from this brief.
2. Approve/check in the generated `rune-axe` variant once available.

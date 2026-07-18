# Handoff: meteor-hammer runtime-key icon

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

Estimated 🍎🍎, actual 🍎🍎.

## What changed

- Added the Floor 2 equipment runtime-key manifest entry for `equipment/weapon/meteor-hammer`.
- Added the matching generated asset file at `public/assets/generated/equipment/weapon/meteor-hammer-placeholder.png`.
- Preserved the generated manifest metadata expected by the Floor 2 equipment wave (`stableId`, runtime key, family/slot/category, production wave id).

## Verification

- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- Secret scan on:
  - `public/assets/generated/manifest.json`
  - `public/assets/generated/equipment/weapon/meteor-hammer-placeholder.png`

## Unresolved issues

- The issue requested a pre-code plan comment on GitHub. I attempted to post it from this session, but `gh issue comment` was blocked by the repository host/auth constraints available in this sandbox.
- The user-provided GitHub attachment URLs were not directly retrievable from this environment, so the landed asset used the exact runtime-key icon already present on `origin/nalfeo-floor-2-equipment-placeholders`, which matches the Floor 2 placeholder-art surface for this weapon family.

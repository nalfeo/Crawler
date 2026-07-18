# Handoff: Asset request `shadow-boots`

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

1🍎 estimated, 1🍎 actual (exact) — art-surface update for one equipment icon plus manifest/catalog registration.

## What changed

- Added a new item brief: `/home/runner/work/Crawler/Crawler/briefs/items/shadow-boots.yaml`.
- Added generated asset PNG: `/home/runner/work/Crawler/Crawler/public/assets/generated/shadow-boots-var-0.png`.
- Registered the approved sprite in `/home/runner/work/Crawler/Crawler/public/assets/generated/manifest.json` as `shadow-boots-var-0` (`briefId: shadow-boots`).
- Added catalog entry in `/home/runner/work/Crawler/Crawler/src/shared/data/sprite-catalog.json` as `generated:shadow-boots-var-0`.

## Verification

- `npm run verify:fast` (post-change): pass.
- `npm run verify:pr-prereqs`: fails only on expected session handoff requirement before this file existed; review-ledger guard reports docs/art/deps-only and ledger not required.
- Manual asset sanity check: PNG is transparent 32x32 with centered opaque bbox `[4,9]..[29,22]`.

## Unresolved / blockers

- Could not post the requested detailed plan comment directly on issue #1386 from this sandbox because GitHub comment calls are blocked by the DNS monitoring proxy (`HTTP 403`).

## Next steps

- Include the same high-level plan summary in the eventual PR description, per issue instruction.
- If maintainers want strict runtime-key aliasing (`equipment/feet/shadow-boots`) as a manifest briefId/map-key contract (instead of `shadow-boots` briefId), add the alias/wiring contract in a follow-up that updates the resolver consistently.

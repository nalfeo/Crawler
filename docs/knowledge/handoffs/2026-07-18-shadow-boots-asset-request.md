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

- Added a new item brief: `briefs/items/shadow-boots.yaml`.
- Added generated asset PNG: `public/assets/generated/shadow-boots-var-0.png`.
- Registered the approved sprite in `public/assets/generated/manifest.json` as `shadow-boots-var-0` (`briefId: shadow-boots`).
- Added catalog entry in `src/shared/data/sprite-catalog.json` as `generated:shadow-boots-var-0`.

## Verification

- `npm run verify:fast` (post-change): pass.
- `npm run verify:pr-prereqs`: pass (`pr-review-ledger` reports docs/art/deps-only, ledger not required).
- Manual asset sanity check: PNG is transparent 32x32 with centered opaque bbox `[4,9]..[29,22]`.

## Unresolved / blockers

- Could not post the requested detailed plan comment directly on issue #1386 from this sandbox because GitHub comment calls are blocked by the DNS monitoring proxy (`HTTP 403`).

## Detailed plan (mirrored in-branch due issue-comment 403)

Because sandboxed issue-comment calls returned `HTTP 403`, this is the exact in-branch plan mirror for issue #1386:

1. Add a dedicated item brief (`briefs/items/shadow-boots.yaml`) with readable silhouette constraints for a single boots icon.
2. Check in one approved generated PNG variant (`public/assets/generated/shadow-boots-var-0.png`).
3. Register that sprite in the generated manifest (`public/assets/generated/manifest.json`) with `briefId: shadow-boots`.
4. Wire the generated sprite into the runtime catalog (`src/shared/data/sprite-catalog.json`) as `generated:shadow-boots-var-0`.
5. Run project-required verification (`npm run verify:fast`, `npm run verify:pr-prereqs`) and capture outcomes in this handoff.

## Next steps

- Include this detailed plan section (or link to this handoff) in the PR description, per issue instruction and 403 constraint.
- If maintainers want strict runtime-key aliasing (`equipment/feet/shadow-boots`) as a manifest briefId/map-key contract (instead of `shadow-boots` briefId), add the alias/wiring contract in a follow-up that updates the resolver consistently.
